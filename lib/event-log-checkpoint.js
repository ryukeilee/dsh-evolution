import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
 */

export const EVENT_LOG_CHECKPOINT_SCHEMA = 2;
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
export function planEventLogReplay({ file, key, writer, checkpoint = null, applied = {} }) {
  const candidate = candidateLength(checkpoint);
  const read = readEventLog({ file, key, consumed: candidate });
  if (read === null) return null;
  if (candidate > 0 && !checkpointAuthenticates({ checkpoint, key, writer, read, applied })) {
    // The stored prefix is not the authenticated prefix any more: verify the
    // complete log per record. The second read is deliberate - it never mixes
    // bytes from the rejected prefix into the pass that follows.
    return planEventLogReplay({ file, key, writer, checkpoint: null, applied });
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
export function eventLogCheckpointDocument({ plan, writer, key, applied, witnesses = null }) {
  const document = { schema: EVENT_LOG_CHECKPOINT_SCHEMA, bytes: plan.next.bytes, records: plan.next.records,
    digest: plan.next.digest, writer, file: plan.identity,
    first: witnesses?.first ?? null, last: witnesses?.last ?? null, appliedDigest: digestApplied(applied) };
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
function checkpointAuthenticates({ checkpoint, key, writer, read, applied }) {
  if (checkpoint.schema !== EVENT_LOG_CHECKPOINT_SCHEMA || checkpoint.mac !== checkpointMac(key, checkpoint)) return false;
  if (checkpoint.appliedDigest !== digestApplied(applied)) return false;
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
  return crypto.createHmac('sha256', key).update('evolution-checkpoint-v2\n')
    .update(JSON.stringify({ schema, bytes, records, digest, writer,
      file: { dev: file.dev, ino: file.ino }, first, last, appliedDigest })).digest('hex');
}

/** Digest of the committed marker map, as stored on the checkpoint. Exported so
 * a regression can assert the stored value against the durable map itself. */
export function digestApplied(applied) {
  return crypto.createHash('sha256').update(JSON.stringify(applied)).digest('hex');
}
