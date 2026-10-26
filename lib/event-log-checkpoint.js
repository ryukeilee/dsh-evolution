import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyEventBridgeEnvelope } from './orchestrator.js';

/**
 * Durable replay checkpoint for the append-only Evolution event bridge log.
 *
 * The domain replay path authenticates every record it consumes. History that
 * has already been authenticated *and* absorbed into the committed domain
 * marker map does not need its records parsed, canonicalized and HMAC-verified
 * one by one on every later step: what it needs is proof that the consumed
 * bytes are still exactly the bytes that were authenticated. This module
 * stores that proof - the consumed length, the record count in it, a keyed
 * digest over those exact bytes, a digest of the complete applied map, a MAC
 * over all checkpoint fields, and witnesses (first and last record) for the
 * committed domain markers the prefix was absorbed into - so that later passes
 * verify consumed history in one keyed pass and do per-record work only for
 * records that are new.
 *
 * Security properties:
 *   - The digest is keyed with the same bridge key as the record MACs, so a
 *     checkpoint metadata has its own domain-separated MAC and cannot be forged, and a writer that cannot read the key
 *     cannot produce bytes whose prefix digest matches a stored one. A record
 *     is only ever absorbed after full per-record MAC verification; a
 *     checkpoint can only skip work for records already absorbed under this
 *     key.
 *   - The checkpoint is bound to the file identity (device + inode), to the
 *     trusted writer, and to the first and last absorbed record's MAC. A
 *     replaced, truncated or rewritten log, and a marker map that was rolled
 *     back or changed anywhere (checked via the full applied digest), fail validation and fall back
 *     to full per-record verification.
 *   - Any byte change anywhere in the consumed prefix changes the digest, so
 *     tampering with already-consumed records is still detected, and fails the
 *     same way it does today through the full verification fallback.
 *   - The prefix only advances to a length whose last byte is a line feed, so
 *     it covers exactly the records that were processed. A torn trailing line
 *     is never covered and is re-processed by the next pass.
 *
 * Schema 3 binds the checkpoint to the durable retention floor as well as to the
 * marker map (`digestApplied(applied, retention)`), so a reclaim that legitimately
 * discards an absorbed prefix and prunes its markers keeps the remaining history
 * trusted, while a marker that disappears without a floor covering it still
 * invalidates the checkpoint. A schema-2 checkpoint is ignored, which degrades
 * exactly once to full verification.
 */

export const EVENT_LOG_CHECKPOINT_SCHEMA = 3;
const CHECKPOINT_FILE_NAME = 'event-log.checkpoint.json';
const DIGEST_ALGORITHM = 'sha256';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const LINE_FEED = 0x0a;
// Consumed history is re-authenticated by reading it once and keyed-hashing
// it. The read is chunked so a long-running process does not allocate the
// whole log per step; only the bytes after the checkpoint are retained for the
// per-record pass.
const READ_CHUNK_BYTES = 1 << 20;

export function eventLogCheckpointPath(presetDir) {
  return path.join(presetDir, CHECKPOINT_FILE_NAME);
}

export function digestEventLogPrefix(key, buffer, length) {
  return crypto.createHmac(DIGEST_ALGORITHM, key).update(buffer.subarray(0, length)).digest('hex');
}

/**
 * Read and structurally validate a stored checkpoint. A checkpoint that is
 * missing, unreadable, or shaped differently than this module writes (an older
 * or corrupted file) is reported as absent; every unknown shape degrades to
 * full verification instead of being partially trusted.
 */
export function readEventLogCheckpoint(file) {
  let document;
  try { document = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!document || typeof document !== 'object' || document.schema !== EVENT_LOG_CHECKPOINT_SCHEMA) return null;
  if (!Number.isSafeInteger(document.bytes) || document.bytes < 0) return null;
  if (!Number.isSafeInteger(document.records) || document.records < 0) return null;
  if (typeof document.digest !== 'string' || !DIGEST_PATTERN.test(document.digest)) return null;
  if (typeof document.writer !== 'string') return null;
  if (!DIGEST_PATTERN.test(document.appliedDigest || '') || !DIGEST_PATTERN.test(document.mac || '')) return null;
  const logFile = document.file;
  if (!logFile || typeof logFile.dev !== 'string' || typeof logFile.ino !== 'string') return null;
  const first = document.first ?? null;
  const last = document.last ?? null;
  for (const witness of [first, last]) {
    if (witness !== null && (typeof witness !== 'object' || typeof witness.id !== 'string' || typeof witness.mac !== 'string')) return null;
  }
  return { schema: EVENT_LOG_CHECKPOINT_SCHEMA, bytes: document.bytes, records: document.records,
    digest: document.digest, appliedDigest: document.appliedDigest, mac: document.mac, writer: document.writer, file: { dev: logFile.dev, ino: logFile.ino }, first, last };
}

/**
 * Publish a checkpoint atomically, without making it durable.
 *
 * The replace is atomic (same-directory temporary file, then rename), so a
 * concurrent reader sees either the previous checkpoint or the new one and
 * never a partial file. It is deliberately not fsynced, though: this document
 * is derived state that cannot become authoritative. Every way it can be lost
 * or damaged - a rename the crash dropped, an entry the crash truncated to
 * zeroes, a checkpoint left at an older consumed length - is caught by the
 * reader, which trusts a stored checkpoint only when its keyed digest matches
 * the log bytes on disk *and* its applied digest, witnesses, writer and file
 * identity still describe the committed marker map (`planEventLogReplay`).
 * Anything else degrades to the full per-record verification this checkpoint
 * exists to skip, which is exactly the behavior of a first-ever pass. Paying
 * two fsyncs per advancing pass (file and parent directory) to protect an
 * artifact whose worst-case loss is "verify the consumed prefix again" was
 * pure wait in the write path; the authoritative bytes it describes are
 * fsynced by the domain store before this runs.
 */
export function writeEventLogCheckpoint(file, checkpoint) {
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const descriptor = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeSync(descriptor, `${JSON.stringify(checkpoint)}\n`);
  } finally { fs.closeSync(descriptor); }
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

/**
 * Read the log once and decide how much of it still needs per-record work.
 *
 * The read is split at `checkpoint.bytes` when a checkpoint candidate exists:
 * the consumed prefix is keyed-hashed while the bytes after it are retained
 * for the per-record pass. When that prefix does not authenticate, the plan
 * degrades to a full read and full per-record verification, exactly like a
 * first-ever pass.
 *
 * Returns null when the log does not exist. Otherwise the caller processes
 * `lines` and then `remainder` exactly as it would process the full file, and
 * persists `checkpointDocument()` only after that processing succeeded.
 */
export function planEventLogReplay({ file, key, writer, checkpoint = null, applied = {}, retention = null }) {
  const candidate = candidateLength(checkpoint);
  const read = readEventLog({ file, key, consumed: candidate });
  if (read === null) return null;
  if (candidate > 0 && !checkpointAuthenticates({ checkpoint, key, writer, read, applied, retention })) {
    // The stored prefix is not the authenticated prefix any more: verify the
    // complete log per record. The second read is deliberate - it never mixes
    // bytes from the rejected prefix into the pass that follows.
    return planEventLogReplay({ file, key, writer, checkpoint: null, applied, retention });
  }
  // A committed floor says the log begins with the bytes the reclaim retained.
  // Only the full-read path needs the proof - a validating checkpoint already
  // covers the tail, because the truncation replaced the file identity it names.
  if (candidate === 0 && retention?.log && !verifyLogFloorTail({ buffer: read.tail, floor: retention.log, key })) {
    const error = new Error('E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH: the event log does not begin with the bytes the last reclaim retained; refusing to absorb it because records whose markers were pruned may still be present');
    error.code = 'E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH';
    throw error;
  }
  const trusted = candidate > 0 && read.bytes >= candidate;
  const tail = read.tail;
  const text = tail.toString('utf8');
  const lines = text.split('\n');
  const remainder = lines.pop();
  let completeRecords = 0;
  for (const line of lines) if (line.trim() !== '') completeRecords += 1;
  return {
    trusted,
    identity: read.identity,
    bytes: read.bytes,
    prefixRecords: trusted ? checkpoint.records : 0,
    lines,
    remainder,
    completeRecords,
    // Digest and record count for a checkpoint covering exactly [0, bytes).
    // A steady-state pass reuses the digest it just verified; a pass that read
    // past the candidate uses the digest computed over all bytes read.
    next: {
      bytes: read.bytes,
      digest: trusted && read.bytes === candidate ? read.verifiedDigest : read.boundaryDigest,
      records: (trusted ? checkpoint.records : 0) + completeRecords,
    },
    // The prefix can only advance to a length whose last byte is a line feed,
    // so a torn trailing line stays outside the checkpoint and is re-processed
    // by the next pass instead of being silently skipped.
    advance: read.boundaryDigest !== null && tail.length > 0 && tail[tail.length - 1] === LINE_FEED,
  };
}

/** Build the checkpoint document for a completed pass over `plan`. */
export function eventLogCheckpointDocument({ plan, writer, key, applied, retention = null, witnesses = null }) {
  const document = { schema: EVENT_LOG_CHECKPOINT_SCHEMA, bytes: plan.next.bytes, records: plan.next.records,
    digest: plan.next.digest, writer, file: plan.identity,
    first: witnesses?.first ?? null, last: witnesses?.last ?? null, appliedDigest: digestApplied(applied, retention) };
  return { ...document, mac: checkpointMac(key, document) };
}

const HMAC_BLOCK_BYTES = 64;
/**
 * A keyed SHA-256 digest whose state can be forked at any byte boundary.
 *
 * `crypto.createHmac()` cannot fork its state, and one pass over a log that grew
 * has to produce two digests: the digest of the consumed prefix (which
 * authenticates the checkpoint the pass starts from) and the digest of every byte
 * the log holds now (which authenticates the checkpoint the pass writes). The two
 * ranges are nested - the prefix is the head of the whole file - so the second
 * digest used to re-hash the bytes the first one had just hashed: a whole log file
 * of extra hashing on every pass that advances the checkpoint.
 *
 * HMAC(K, m) is H((K ^ opad) || H((K ^ ipad) || m)), and `crypto.createHash()` does
 * copy its state, so the inner hash forks at the boundary and both digests come out
 * of one read. The values are byte-identical to `crypto.createHmac('sha256', key)`:
 * the padding, the 64-byte block size, the utf8 key encoding and the "a key longer
 * than a block is hashed first" rule are the same three steps OpenSSL runs.
 * `test/domain-storage/checkpoint-keyed-digest.test.js` pins that equality against
 * `crypto.createHmac` for keys and messages on both sides of the block size. The
 * full read below still uses `crypto.createHmac` through `digestEventLogPrefix`, so
 * the two implementations meet wherever a pass switches between them: the first
 * checkpoint is written by one and verified by the other on the next grown pass, and
 * a fallback to a full read verifies whatever the fork wrote last. Between two grown
 * passes both digests come from the fork, and the equality above is held by the
 * tests rather than by that crossing.
 */
export function createEventLogKeyedDigest(key) {
  const raw = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
  if (!raw || typeof raw.length !== 'number') throw new TypeError('event log digest key must be a string or Buffer');
  const sized = raw.length > HMAC_BLOCK_BYTES ? crypto.createHash(DIGEST_ALGORITHM).update(raw).digest() : raw;
  const inner = Buffer.alloc(HMAC_BLOCK_BYTES, 0x36);
  const outer = Buffer.alloc(HMAC_BLOCK_BYTES, 0x5c);
  for (let index = 0; index < sized.length; index += 1) { inner[index] ^= sized[index]; outer[index] ^= sized[index]; }
  return keyedDigestHandle(crypto.createHash(DIGEST_ALGORITHM).update(inner), outer);
}
function keyedDigestHandle(state, outer) {
  return {
    update(bytes) { state.update(bytes); },
    fork() { return keyedDigestHandle(state.copy(), outer); },
    hex() { return crypto.createHash(DIGEST_ALGORITHM).update(outer).update(state.digest()).digest('hex'); },
  };
}

/**
 * Read the log, hashing exactly the consumed prefix for verification and
 * retaining exactly the bytes after it. `consumed` is 0 for a full read.
 */
function readEventLog({ file, key, consumed }) {
  let descriptor;
  try { descriptor = fs.openSync(file, 'r'); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    const identity = { dev: String(stat.dev), ino: String(stat.ino) };
    if (consumed <= 0) {
      const buffer = fs.readFileSync(descriptor);
      const digest = digestEventLogPrefix(key, buffer, buffer.length);
      return { identity, bytes: buffer.length, tail: buffer, verifiedDigest: digest, boundaryDigest: digest };
    }
    // One digest covers everything read; the prefix digest is forked out of it at
    // the consumed boundary, so the consumed bytes are hashed exactly once even
    // when the log grew past it. When the file is still exactly the authenticated
    // length no fork happens and the two values are the same digest; if the file
    // shrank during this pass the fork point is never reached and the digest
    // reported for the prefix covers the bytes that do exist, exactly as the
    // two-instance version did (and `checkpointAuthenticates` rejects it).
    const digest = createEventLogKeyedDigest(key);
    const grown = stat.size !== consumed;
    const chunks = [];
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let offset = 0, retained = 0, consumedHex = null;
    for (;;) {
      const size = fs.readSync(descriptor, chunk, 0, chunk.length, offset);
      if (size <= 0) break;
      const verifiedBytes = Math.min(size, Math.max(0, consumed - offset));
      if (verifiedBytes > 0) digest.update(chunk.subarray(0, verifiedBytes));
      if (consumedHex === null && offset + verifiedBytes >= consumed) consumedHex = digest.fork().hex();
      if (verifiedBytes < size) {
        if (grown) digest.update(chunk.subarray(verifiedBytes, size));
        const tail = Buffer.from(chunk.subarray(verifiedBytes, size));
        chunks.push(tail);
        retained += tail.length;
      }
      offset += size;
    }
    const verifiedDigest = consumedHex ?? digest.fork().hex();
    return { identity, bytes: offset,
      tail: retained > 0 ? Buffer.concat(chunks, retained) : EMPTY,
      verifiedDigest,
      boundaryDigest: grown ? digest.hex() : (offset === consumed ? verifiedDigest : null) };
  } finally { fs.closeSync(descriptor); }
}

/**
 * Returns true only when the consumed prefix is byte-identical to the
 * authenticated prefix, the log is the same file, the trusted writer is
 * unchanged, and the domain still records the witnessed records with the
 * authenticated MAC.
 */
function checkpointAuthenticates({ checkpoint, key, writer, read, applied, retention = null }) {
  if (checkpoint.schema !== EVENT_LOG_CHECKPOINT_SCHEMA || checkpoint.mac !== checkpointMac(key, checkpoint)) return false;
  if (checkpoint.appliedDigest !== digestApplied(applied, retention)) return false;
  if (checkpoint.writer !== writer) return false;
  if (checkpoint.bytes > read.bytes) return false;
  if (checkpoint.file.dev !== read.identity.dev || checkpoint.file.ino !== read.identity.ino) return false;
  // Witnesses are a bounded integrity check of the committed marker map the
  // prefix was absorbed into: the plugin never prunes or rewrites it, so a
  // marker that no longer carries the authenticated MAC means the durable
  // domain state moved backwards and the prefix must be re-verified.
  for (const witness of [checkpoint.first, checkpoint.last]) {
    if (witness !== null && applied[witness.id] !== witness.mac) return false;
  }
  return read.verifiedDigest === checkpoint.digest;
}

function candidateLength(checkpoint) {
  return checkpoint && Number.isSafeInteger(checkpoint.bytes) && checkpoint.bytes > 0 ? checkpoint.bytes : 0;
}

const EMPTY = Buffer.alloc(0);

// Bind every field to the bridge key, using a fixed field order. The prefix
// digest alone authenticates bytes, not the claimed count or domain state.
function checkpointMac(key, document) {
  const { schema, bytes, records, digest, writer, file, first, last, appliedDigest } = document;
  return crypto.createHmac('sha256', key).update('evolution-checkpoint-v3\n')
    .update(JSON.stringify({ schema, bytes, records, digest, writer,
      file: { dev: file.dev, ino: file.ino }, first, last, appliedDigest })).digest('hex');
}

/** Digest of the committed marker map, as stored on the checkpoint. Exported so
 * a regression can assert the stored value against the durable map itself.
 *
 * With no retention floor the input and the output are byte-identical to the
 * released implementation, so a database that was never pruned keeps exactly the
 * digest it always had. Once a floor exists the digest also commits to the
 * markers that were pruned out of the ledger and to the log floor, which is what
 * lets a legitimate prune stay trusted while an unrecorded marker loss does not. */
export function digestApplied(applied, retention = null) {
  const projected = retention === null || retention === undefined
    ? applied
    : { retention: { markers: retention.markers, log: retention.log }, applied };
  return crypto.createHash('sha256').update(JSON.stringify(projected)).digest('hex');
}


/**
 * Durable retention floor for the append-only event bridge and its marker map.
 *
 * Two things grow without bound in this plugin: the authenticated event log, and
 * the `eventId -> MAC` ledger the domain keeps for it. Neither can be trimmed by
 * forgetting bytes, because after a forget there is no way to tell an event that
 * was already absorbed from one that must still be absorbed. This module defines
 * the one shape that makes forgetting provable:
 *
 *   - `markers.chain` is a keyed chain over every marker that was removed from
 *     the ledger, in the order the discarded records appeared in the log. The
 *     chain is a genuine commitment: replaying the same discarded prefix with
 *     the same key reproduces it, and a ledger that lost a marker which is not
 *     covered by the chain produces a different value.
 *   - `log.tail` is a keyed digest over the first bytes of the log *after* the
 *     truncation. Every later pass can prove that the file it is reading still
 *     starts with the bytes the floor transported, so a log that was replaced or
 *     restored is refused instead of re-absorbed.
 *
 * The order of operations is what makes a crash harmless: the prefix is
 * truncated first and the floor is committed afterwards. A crash between the two
 * leaves a shorter log whose records all still have markers, so a replay sees
 * duplicates and loses nothing; the opposite order would let a committed floor
 * describe bytes that are still on disk.
 */

export const RETENTION_SCHEMA = 1;
/** The chain of an empty pruned set. A ledger that was never pruned has no
 *  retention document at all, so this value only ever appears inside one. */
export const MARKER_CHAIN_EMPTY = '0'.repeat(64);
export const DEFAULT_LOG_RETAIN_RECORDS = 1024;
export const MIN_LOG_RETAIN_RECORDS = 1;
export const MAX_LOG_RETAIN_RECORDS = 1_000_000;
/** The retained tail is held in memory while it is rewritten, so it is bounded
 *  independently of the record count: 1024 records of a large payload must not
 *  turn into hundreds of megabytes of retained bytes. */
export const MAX_LOG_RETAIN_BYTES = 4 * 1024 * 1024;

/**
 * The committed floor, projected so later work can extend it.
 *
 * This is the *only* reader of the floor that is not the zod schema. It must not
 * be looser than that schema in the direction that matters: a shape it no longer
 * recognizes returns `null`, and `advanceRetention()` treats `null` as "no floor",
 * which resets the pruned-marker chain and the cumulative counters while the
 * document still claims them (two records of the same fact disagreeing). It reads
 * only the fields it needs and ignores extra ones, so a document that adds a
 * field later still projects; a missing or malformed field never does.
 */
export function validRetentionDocument(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value) || value.schema !== RETENTION_SCHEMA) return null;
  const markers = value.markers;
  if (!markers || typeof markers !== 'object' || !Number.isSafeInteger(markers.pruned) || markers.pruned < 0
    || typeof markers.chain !== 'string' || !DIGEST_PATTERN.test(markers.chain)) return null;
  const log = value.log;
  if (log !== null && log !== undefined) {
    if (typeof log !== 'object' || Array.isArray(log)) return null;
    if (!Number.isSafeInteger(log.bytes) || log.bytes < 0) return null;
    if (!Number.isSafeInteger(log.records) || log.records < 0) return null;
    for (const bound of [log.prior, log.tail]) {
      if (!bound || typeof bound !== 'object' || !Number.isSafeInteger(bound.bytes) || bound.bytes < 1
        || typeof bound.digest !== 'string' || !DIGEST_PATTERN.test(bound.digest)) return null;
    }
    if (log.prior.bytes <= log.tail.bytes) return null;
    return { schema: RETENTION_SCHEMA, markers: { pruned: markers.pruned, chain: markers.chain },
      log: { bytes: log.bytes, records: log.records,
        prior: { bytes: log.prior.bytes, digest: log.prior.digest },
        tail: { bytes: log.tail.bytes, digest: log.tail.digest } } };
  }
  return { schema: RETENTION_SCHEMA, markers: { pruned: markers.pruned, chain: markers.chain }, log: null };
}

/** Extend the pruned-marker chain with the markers of one discarded prefix. */
export function extendMarkerChain(key, previous, pairs) {
  let chain = previous;
  for (const { eventId, mac } of pairs) {
    chain = crypto.createHmac('sha256', key).update('evolution-marker-floor-v1\n')
      .update(chain).update('\n').update(eventId).update('\0').update(mac).digest('hex');
  }
  return chain;
}

/** Keyed digest over a byte range, the same construction the replay checkpoint
 *  stores, so the two can be compared without a second implementation. */
export function digestLogBytes(key, buffer) {
  return crypto.createHmac('sha256', key).update(buffer).digest('hex');
}

/**
 * Decide how much of the log a reclaim may discard.
 *
 * A record is discardable only when it authenticates under the bridge key, names
 * the trusted writer, and its `eventId` is committed in the ledger with exactly
 * the MAC on the line. The boundary stops at the first record that fails any of
 * those tests, which keeps three cases out of the discarded prefix by
 * construction: an unverifiable line, an event this domain never absorbed, and a
 * duplicate of an absorbed identity that carries a different MAC (the conflict
 * the replay path refuses). The newest `retainRecords` complete records are
 * always kept, and a torn trailing line is never covered because it is not a
 * complete record.
 */
export function planLogPrune({ buffer, key, writer, applied = {}, retainRecords = DEFAULT_LOG_RETAIN_RECORDS }) {
  const keep = Math.max(MIN_LOG_RETAIN_RECORDS, Math.min(MAX_LOG_RETAIN_RECORDS, Math.trunc(Number(retainRecords) || DEFAULT_LOG_RETAIN_RECORDS)));
  const { ranges } = completeLineRanges(buffer);
  let absorbed = 0;
  for (const range of ranges) {
    const line = buffer.subarray(range.start, range.end - 1).toString('utf8');
    if (!line.trim()) { absorbed += 1; continue; }
    let envelope;
    try { envelope = JSON.parse(line); } catch { break; }
    const verified = verifyEventBridgeEnvelope(envelope, key);
    if (!verified || verified.writer !== writer) break;
    const eventId = verified.event?.eventId;
    if (typeof eventId !== 'string' || !Object.hasOwn(applied, eventId)) break;
    if (applied[eventId] !== envelope.mac) break;
    absorbed += 1;
  }
  const boundary = Math.min(absorbed, Math.max(0, ranges.length - keep));
  if (boundary <= 0) return null;
  const prefixBytes = ranges[boundary - 1].end;
  const pairs = [];
  for (let index = 0; index < boundary; index += 1) {
    const line = buffer.subarray(ranges[index].start, ranges[index].end - 1).toString('utf8');
    if (!line.trim()) continue;
    const envelope = JSON.parse(line);
    pairs.push({ eventId: envelope.event.eventId, mac: envelope.mac });
  }
  const retained = buffer.subarray(prefixBytes);
  if (retained.length > MAX_LOG_RETAIN_BYTES) {
    const error = new Error(`E_DOMAIN_EVENT_LOG_RETAIN_UNBOUNDED: the retained tail is ${retained.length} bytes, above the ${MAX_LOG_RETAIN_BYTES}-byte bound`);
    error.code = 'E_DOMAIN_EVENT_LOG_RETAIN_UNBOUNDED';
    throw error;
  }
  return {
    // A blank line advances the byte boundary but is not a record, so the count
    // reported for the discard matches the number of markers it prunes.
    boundaryRecords: pairs.length,
    prefixBytes,
    prunable: pairs,
    // The floor commits *before* a single byte is discarded, so it has to
    // describe the file it was computed from: `prior` authenticates every byte
    // before the boundary, `tail` the bytes that stay. A truncation that never
    // happened is then provable from the file itself (see
    // `completeEventLogTruncation`), instead of leaving a floor that describes a
    // file nobody can find.
    prior: { bytes: buffer.length, digest: digestLogBytes(key, buffer) },
    tail: { bytes: retained.length, digest: digestLogBytes(key, retained) },
  };
}

/**
 * The complete records of a buffer as byte ranges, with the LF included in
 * `end`. The ranges are found on bytes, never on a decoded string: the log is
 * authenticating *bytes*, and an invalid UTF-8 sequence decodes to a different
 * number of code units, so a text-derived offset would not land on a record
 * boundary and the retained tail would start in the middle of a line.
 */
function completeLineRanges(buffer) {
  const ranges = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== LINE_FEED) continue;
    ranges.push({ start, end: index + 1 });
    start = index + 1;
  }
  return { ranges, tailStart: start };
}

/** Read-only classification shared by recovery and doctor; never takes a lock or writes. */
export function inspectEventLogFloor({ file, key, floor }) {
  if (!floor?.log) return { status: 'no-floor' };
  let descriptor;
  try { descriptor = fs.openSync(file, 'r'); } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'absent' };
    throw error;
  }
  try { return classifyLogFloorDescriptor(descriptor, key, floor.log); }
  finally { fs.closeSync(descriptor); }
}

function classifyLogFloorDescriptor(descriptor, key, log) {
  const size = Number(fs.fstatSync(descriptor, { bigint: true }).size);
  const digestRange = (start, bytes) => {
    const hash = crypto.createHmac(DIGEST_ALGORITHM, key);
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let offset = 0;
    while (offset < bytes) {
      const read = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, bytes - offset), start + offset);
      if (!Number.isInteger(read) || read <= 0) return null;
      hash.update(chunk.subarray(0, read));
      offset += read;
    }
    return hash.digest('hex');
  };
  if (size >= log.tail.bytes && digestRange(0, log.tail.bytes) === log.tail.digest) return { status: 'already-truncated' };
  if (size >= log.prior.bytes && digestRange(0, log.prior.bytes) === log.prior.digest) {
    // A matching prior alone does not prove that its suffix is the claimed tail.
    // Diagnose a contradictory floor before recovery creates a temporary file.
    return digestRange(log.prior.bytes - log.tail.bytes, log.tail.bytes) === log.tail.digest
      ? { status: 'deferred' } : { status: 'unknown' };
  }
  return { status: 'unknown' };
}

/**
 * Finish a committed truncation, or prove there is nothing to finish.
 *
 * The floor is committed before the log is rewritten, so a crash between the two
 * leaves a floor describing bytes that are still on disk. That state is not an
 * error: `prior` authenticates the exact file the plan was computed from, so the
 * rewrite can be replayed from the committed record instead of being guessed.
 * The order matters in both directions - the floor exists before a byte is
 * discarded, and the bytes that remain are the ones the floor calls the tail -
 * which is what a per-round digest alone could not express.
 *
 * The rewrite runs under the append lock, because an appender that opened the old
 * inode would otherwise lose the record it is writing when the rename lands. The
 * caller sees one of: `already-truncated` (the file already starts with the
 * floor's tail), `truncated` (this call rewrote it), `unknown` (the file is
 * neither the prior file nor its retained tail; the replay planner refuses it),
 * `absent` (no log), `no-floor`.
 *
 * "Nothing to finish" is decided before the lock is taken, because it needs no
 * exclusion: the only writer that ever replaces the head of this file is a
 * truncation, and it publishes that head with one rename, so a floor whose
 * truncation already ran stays finished while an appender is mid-record. Taking
 * the lock first made a healthy start-up (and every reclaim) wait for, and then
 * fail against, an unrelated live writer with a retryable `E_DOMAIN_EVENT_LOG_BUSY`.
 * The deferred branch below still runs entirely under the lock and re-classifies
 * there, so the bytes this call rewrites are judged under the lock that keeps
 * them still.
 */
export function completeEventLogTruncation({ file, key, floor, withAppendLock, retainCeiling = MAX_LOG_RETAIN_BYTES * 8 }) {
  const log = floor?.log;
  if (!log || !log.prior || !log.tail) return { status: 'no-floor' };
  const prefixBytes = log.prior.bytes - log.tail.bytes;
  if (!Number.isSafeInteger(prefixBytes) || prefixBytes <= 0) return { status: 'unknown' };
  // `absent` returns here without removing a reclaim temporary: a log that is
  // gone beside a temporary holding the retained bytes is the one scene where
  // that file may be the only copy of them. `already-truncated` and `unknown`
  // take the same early return, so cleaning temporaries now happens only on the
  // deferred branch, where the log is still the prior file and the temporary can
  // only be residue of a dead attempt; an orphan left beside a finished floor is
  // removed by the next completion anywhere.
  const inspection = inspectEventLogFloor({ file, key, floor });
  if (inspection.status !== 'deferred') return inspection;
  return withAppendLock(file, () => {
    // A crash between the temporary write and its rename leaves this call's own
    // pattern behind. The append lock is held, so no live writer owns one of
    // them: they are residue of a dead attempt and are removed here, which is the
    // only place that knows the pattern and can prove that much.
    cleanReclaimTemporaries(file);
    let descriptor;
    try { descriptor = fs.openSync(file, 'r'); } catch (error) {
      if (error?.code === 'ENOENT') return { status: 'absent' };
      throw error;
    }
    try {
      const size = Number(fs.fstatSync(descriptor, { bigint: true }).size);
      const classification = classifyLogFloorDescriptor(descriptor, key, log);
      if (classification.status !== 'deferred') return classification;
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const kept = size - prefixBytes;
      if (kept > retainCeiling) {
        const error = new Error(`E_DOMAIN_EVENT_LOG_RETAIN_UNBOUNDED: completing this truncation would keep ${kept} bytes, above the ${retainCeiling}-byte bound`);
        error.code = 'E_DOMAIN_EVENT_LOG_RETAIN_UNBOUNDED';
        throw error;
      }
      const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.reclaim.tmp`;
      let written;
      try {
        written = fs.openSync(temporary, 'w', 0o600);
        // The retained tail is the floor's claim about what stays, and it covers
        // exactly `tail.bytes`. Everything after it is a record that was appended
        // between the commit and this replay; it is copied verbatim and is not
        // part of the claim. Hashing the whole kept region instead would compare
        // appended bytes against a digest that never covered them, which refuses
        // a log that legitimately grew (and would be permanent).
        const hasher = crypto.createHmac(DIGEST_ALGORITHM, key);
        const claimBytes = Math.min(log.tail.bytes, kept);
        let copied = 0;
        while (copied < kept) {
          const length = Math.min(chunk.length, kept - copied);
          const read = fs.readSync(descriptor, chunk, 0, length, prefixBytes + copied);
          if (!Number.isInteger(read) || read <= 0) throw truncationError('E_DOMAIN_EVENT_LOG_TRUNCATION_FAILED: the retained bytes could not be read');
          if (copied < claimBytes) hasher.update(chunk.subarray(0, Math.min(read, claimBytes - copied)));
          let offset = 0;
          while (offset < read) {
            const count = fs.writeSync(written, chunk, offset, read - offset);
            if (!Number.isInteger(count) || count <= 0) throw truncationError('E_DOMAIN_EVENT_LOG_TRUNCATION_FAILED: the retained bytes could not be written');
            offset += count;
          }
          copied += read;
        }
        if (claimBytes !== log.tail.bytes || hasher.digest('hex') !== log.tail.digest) {
          throw truncationError('E_DOMAIN_EVENT_LOG_TRUNCATION_FAILED: the retained bytes do not match the committed floor');
        }
        fs.fsyncSync(written);
      } catch (error) {
        try { fs.unlinkSync(temporary); } catch {}
        throw error;
      } finally { if (written !== undefined) fs.closeSync(written); }
      try { fs.renameSync(temporary, file); } catch (error) {
        try { fs.unlinkSync(temporary); } catch {}
        throw error;
      }
      syncDirectory(path.dirname(file));
      return { status: 'truncated', bytes: kept, prefixBytes };
    } finally { fs.closeSync(descriptor); }
  });
}

/**
 * A failure of the rewrite itself, named like every other refusal of this
 * protocol: `truncationFailure()` in the caller tells the retryable append-lock
 * outcome apart by code, so an error without one would surface as an unnamed
 * failure (and be recorded as "deferred" by the reclaim that only synthesizes a
 * code when it has none).
 */
function truncationError(message) {
  const error = new Error(message);
  error.code = 'E_DOMAIN_EVENT_LOG_TRUNCATION_FAILED';
  return error;
}

/** Remove this module's own abandoned truncation temporaries for one log. */
function cleanReclaimTemporaries(file) {
  const directory = path.dirname(file);
  const prefix = `${path.basename(file)}.`;
  let names;
  try { names = fs.readdirSync(directory); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.reclaim.tmp')) continue;
    if (!/^[0-9a-f]{16}\.reclaim\.tmp$/.test(name.slice(prefix.length))) continue;
    try { fs.unlinkSync(path.join(directory, name)); } catch { /* another attempt will retry */ }
  }
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

/**
 * The replay-side floor check.
 *
 * A floor exists only after a prefix was discarded, and the bytes it discarded
 * are gone. A log that does not start with the retained tail therefore cannot be
 * this log's continuation: re-absorbing it would re-apply events whose markers
 * were pruned. The check is bounded by the retained length, and it is only
 * consulted on the full-verification path - a validating checkpoint already
 * proves the file identity and every byte it covers, which includes the tail.
 */
/**
 * The log must begin with the bytes the last reclaim retained. Nothing else can
 * be its continuation: those records' markers are gone, so a file that does not
 * start with them may contain one, and re-applying it could resurrect a
 * superseded fact. There is deliberately no exception - not for an empty file,
 * not for a file full of high sequence numbers - because neither can prove the
 * absence of a record whose marker was pruned. A missing log is the same
 * statement with nothing in it, so the caller refuses that too: deleting the log
 * after a reclaim is a destructive external action on a durable artifact, and the
 * remedy is to restore its retained bytes (the floor records their digest) or to
 * start a new data root.
 */
export function verifyLogFloorTail({ buffer, floor, key }) {
  if (!floor) return true;
  if (buffer.length < floor.tail.bytes) return false;
  return digestLogBytes(key, buffer.subarray(0, floor.tail.bytes)) === floor.tail.digest;
}

/** Fold one discard into the durable retention document. `log` is the floor
 *  entry the caller computed from the bytes it actually wrote, so this function
 *  never derives a floor it did not observe. */
export function advanceRetention(previous, { prunable = [], log = null, key }) {
  const base = validRetentionDocument(previous)
    ?? { schema: RETENTION_SCHEMA, markers: { pruned: 0, chain: MARKER_CHAIN_EMPTY }, log: null };
  const markers = prunable.length
    ? { pruned: base.markers.pruned + prunable.length, chain: extendMarkerChain(key, base.markers.chain, prunable) }
    : base.markers;
  return { schema: RETENTION_SCHEMA, markers, log: log ?? base.log };
}

/**
 * Report-only continuity findings for the retention documents one data root
 * carries.
 *
 * Every rule here is true by construction of `advanceRetention()`: a pruned
 * marker is covered by exactly one chain link, the cumulative counters only ever
 * grow, and a transaction's pending floor is derived from the committed floor it
 * replaces, so it is never behind it. A document that violates one of them was
 * not written by this module, and saying "the floor is fine" about it would be a
 * false negative: the retained bytes can still look right while the commitment
 * that authorises their removal is already meaningless - the document is not
 * keyed, so the chain is the only evidence that the pruned markers existed.
 *
 * The rules are reported instead of enforced, because they must not decide
 * whether a root loads: `validRetentionDocument()` is deliberately the looser
 * reader, and refusing to load would turn a documentation defect into a refusal
 * to start. Callers pass documents that projection accepted.
 *
 * Never mutates, never repairs, and never returns bytes.
 */
export function inspectRetentionContinuity({ committed = null, pending = null } = {}) {
  const problems = [];
  const report = (scope, code, message) => problems.push({ scope, code, message });
  for (const [scope, document] of [['committed', committed], ['pending', pending]]) {
    if (document === null || document === undefined) continue;
    // A document the projection did not accept is reported as invalid by the
    // caller, never as a continuity finding: this function only answers what a
    // document that exists *claims*.
    if (!document.markers) continue;
    const { pruned, chain } = document.markers;
    if (pruned === 0 && chain !== MARKER_CHAIN_EMPTY) {
      report(scope, 'marker-chain-without-pruned-markers', 'the floor carries a pruned-marker chain but no pruned marker, so the chain covers nothing');
    }
    if (pruned > 0 && chain === MARKER_CHAIN_EMPTY) {
      report(scope, 'pruned-markers-without-chain', `the floor records ${pruned} pruned marker(s) with the empty chain, so nothing covers them`);
    }
    if (document.log) {
      const discarded = document.log.prior.bytes - document.log.tail.bytes;
      if (document.log.bytes < discarded) {
        report(scope, 'cumulative-bytes-below-last-discard', `the floor records ${document.log.bytes} discarded log byte(s) in total, fewer than the ${discarded} its own last plan discarded`);
      }
      if (document.log.prior.digest === document.log.tail.digest) {
        report(scope, 'prior-tail-digest-equal', 'the floor records the same digest for the discarded file and for the retained tail, which no discard can produce');
      }
    }
  }
  // `installPending()` installs the pending record's floor *in place of* the
  // committed one, so a pending floor behind the committed one would un-prove
  // markers and bytes that a completed reclaim already removed.
  if (committed && pending) {
    if (pending.markers.pruned < committed.markers.pruned) {
      report('pending', 'floor-regression-markers', `the pending floor records ${pending.markers.pruned} pruned marker(s), behind the committed ${committed.markers.pruned}`);
    }
    // The claim and the counter are the same loss in two shapes, so the stronger
    // statement is reported once: a pending floor without the committed log claim
    // cannot prove the retained bytes at all, whatever its counter says.
    if (committed.log && !pending.log) {
      report('pending', 'floor-regression-log-claim', 'the pending floor drops the committed log floor, so the retained bytes would no longer be proven');
    } else if ((pending.log?.bytes ?? 0) < (committed.log?.bytes ?? 0)) {
      report('pending', 'floor-regression-log-bytes', `the pending floor records ${pending.log?.bytes ?? 0} discarded log byte(s), behind the committed ${committed.log?.bytes ?? 0}`);
    }
  }
  return problems;
}

/**
 * The longest absorbed prefix of a retained tail: what a replay checkpoint may
 * cover immediately after a truncation without claiming a record the next replay
 * still has to apply. A line that does not verify, names another writer, or has
 * no committed marker ends the coverage, exactly as it ends the discard boundary.
 */
export function planRetainedCoverage({ buffer, key, writer, applied = {} }) {
  if (!buffer || buffer.length === 0) return null;
  const { ranges } = completeLineRanges(buffer);
  let bytes = 0;
  let records = 0;
  let first = null;
  let last = null;
  for (const range of ranges) {
    const line = buffer.subarray(range.start, range.end - 1).toString('utf8');
    let envelope;
    try { envelope = JSON.parse(line); } catch { break; }
    const verified = verifyEventBridgeEnvelope(envelope, key);
    if (!verified || verified.writer !== writer) break;
    const eventId = verified.event?.eventId;
    if (typeof eventId !== 'string' || !Object.hasOwn(applied, eventId) || applied[eventId] !== envelope.mac) break;
    bytes = range.end;
    records += 1;
    const witness = { id: eventId, mac: envelope.mac };
    first ??= witness;
    last = witness;
  }
  if (records === 0) return null;
  return { bytes, records, digest: digestLogBytes(key, buffer.subarray(0, bytes)), first, last };
}
