/**
 * Capability usage evidence: the one contract between the offline session scan
 * and the read-only self-evolution review.
 *
 * The review (`self-evolution-review.js`) already accepts a bounded `usage`
 * projection and never scans anything itself: an ordinary agent turn, a boot or
 * a background observer must not read transcript-sized session logs. What was
 * missing is the *link*: the operator-run scanner could print a projection, but
 * nothing durable connected that fact to the runtime audit, so every published
 * plugin stayed `usage-unknown` forever.
 *
 * This module supplies both ends of that link without adding a second scanner:
 *
 *   - `summarizeCapabilityUsage()` turns the persisted session logs into a
 *     bounded projection (call counts by published record, never transcript
 *     text, arguments or results);
 *   - `readUsageProjection()` reads the one small persisted projection the
 *     explicit audit may consult, with a size cap and a staleness check;
 *   - `writeUsageProjection()` is used only by the explicit operator CLI.
 *
 * Counting rules (each one exists because the previous rule was wrong):
 *
 *   - Attribution is causal, not session-wide. A published tool call is
 *     verification traffic only while a promotion-lifecycle call is *open* in
 *     the same session — that is exactly where the official probe/canary
 *     pipeline runs the candidate. A normal task that also happened to call
 *     `evolution_probe` earlier is real usage, not verification.
 *   - A call whose enclosing lifecycle call never returned (truncated or
 *     crashed log) cannot be attributed either way. It is counted as
 *     `unattributedInvocations` instead of being guessed into zero, so the
 *     review can never turn a broken log into a disable recommendation.
 *   - The official PTC (`run_code`) route logs its nested model-selected tool
 *     calls as `tool/ptc-dispatch-start` / `tool/ptc-dispatch` instead of
 *     `tool/call`. A completed dispatch of a published name is counted once,
 *     with the same lifecycle rule as a native call; a dispatch whose parent is
 *     a `tool/call` row is workflow, and one the log cannot tie to a model
 *     selection is unattributed. A start with no final dispatch at session
 *     finish is also unattributed, never zero.
 *   - Only the current generation's two encodings are scanned:
 *     `session.v4.jsonl.zstd` and plaintext `session.v4.jsonl` (the minimal SDK
 *     bundle sets `compression: none`). A session directory holding both is an
 *     ambiguous encoding (the log cannot prove which one is live), so neither
 *     is counted and the projection is incomplete. Any other canonical session
 *     log shape (`session.jsonl`, `session.vN.jsonl[.zstd]`) in a directory
 *     without a current file is reported as unscanned and makes the projection
 *     incomplete, rather than looking like a measured zero; older generations
 *     beside a current file are the same session's migrated copies and are not
 *     separate sessions.
 *   - Registered tool names come from the plugin's own `defineTool` /
 *     `registerTool` / `tools.register` definitions. The old rule accepted every
 *     `name: "…"` string in the source, which could turn a schema field into a
 *     fake invocation counter.
 *   - A tool name claimed by two published records is ambiguous: the call is
 *     counted as unattributed for both, never silently assigned to the last one.
 *   - Incompleteness is never rounded down to zero: any unreadable session,
 *     decompression failure, oversized or unparseable log, unreadable plugin
 *     source or ambiguous name makes the affected counts `null`.
 *   - "Cannot be counted" is not "could not be read". A context-policy plugin
 *     (`ctx.on('tools/post-execute', …)`) registers no tool: it changes an
 *     existing tool's result instead of adding a call the model can choose.
 *     Its row is reported as `measurement: "no-tool-surface"` with `null`
 *     counts, and it does not mark the whole projection's per-record knowledge
 *     as incomplete — the scan read every source it was asked to read, there is
 *     simply no call to count. Conflating the two made the only capability
 *     archetype that fixes the "the model never picks the new tool" problem
 *     look like a damaged scan.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

import { readSharedIndex, sharingPaths } from './promoted-sharing.js';

export const CAPABILITY_USAGE_LIMITS = Object.freeze({
  /** The projection is a summary table; anything bigger is not one of ours. */
  maxProjectionBytes: 512 * 1024,
  /** A promoted plugin source is a handful of kilobytes. */
  maxSourceBytes: 1024 * 1024,
  /** Decompressed session bytes; a decompression bomb must fail, not exhaust memory. */
  maxSessionBytes: 256 * 1024 * 1024,
  maxToolNamesPerRecord: 32,
  maxRecords: 200,
  maxScanFailures: 200,
  /** Zero usage older than this no longer supports a retirement recommendation. */
  staleAfterDays: 30,
});

export const USAGE_PROJECTION_KIND = 'dsh-evolution-capability-usage';
export const USAGE_PROJECTION_SCHEMA_VERSION = 1;
/**
 * What a projection actually covered. A projection written before the PTC /
 * plaintext-session scan cannot prove a zero: it would have missed those calls
 * entirely. Readers keep positive counts (they did happen) but treat a zero
 * from a legacy projection as unknown until the operator re-runs the scanner.
 */
export const USAGE_PROJECTION_COVERAGE = 'native+ptc+current-encodings-v1';

/**
 * The promotion lifecycle a Trial or canary runs a candidate inside.
 *
 * These are the official `evolution_*` calls that execute a candidate through
 * the pipeline; when one of them is open, any published tool call underneath it
 * is verification traffic.
 *
 * `evolution_desktop` is deliberately absent. Its `audit` / `status` / `confirm`
 * actions are read-only coordination in the ACP client and never run a candidate;
 * `delegate` only forwards the request. The candidate itself runs inside the
 * Desktop process, where the real `evolution_trial` / `evolution_probe` calls
 * mark verification in that session's log. Because tool events carry a name but
 * no action argument, counting `evolution_desktop` here would misclassify any
 * published-tool call overlapping an audit as verification traffic and could
 * unlock a false retirement recommendation.
 */
export const PROMOTION_LIFECYCLE_TOOLS = Object.freeze([
  'evolution_probe',
  'evolution_trial',
  'evolution_measure',
  'evolution_promote',
  'evolution_canary_observe',
]);

const LIFECYCLE = new Set(PROMOTION_LIFECYCLE_TOOLS);
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const REGISTRATION = /\bdefineTool\s*\(|\bregisterTool\s*\(|\btools\s*\.\s*register\s*\(/g;
const REGISTERED_NAME = /\bname\s*:\s*\\?['"]([^'"\\]{1,64})\\?['"]/;

/** The official PTC execution rows, not native `tool/call` / `tool/result`. */
const PTC_START = 'tool/ptc-dispatch-start';
const PTC_DISPATCH = 'tool/ptc-dispatch';

/** Current-generation session logs; the SDK can persist them with either codec. */
const SESSION_V4 = 'session.v4.jsonl';
const SESSION_V4_ZSTD = `${SESSION_V4}.zstd`;
/** Other canonical session shapes are not parsed in this change and must not look like zero use. */
const SESSION_OTHER_GENERATION = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/;

/** How many characters after a registration call are searched for its name. */
const REGISTRATION_WINDOW = 4096;

/**
 * The tool names a promoted record actually registers.
 *
 * Only the definition sites count. A generic `name: "x"` elsewhere in the file
 * (a schema field, a config default) is not an invocation counter.
 */
export function toolNamesFromSource(source) {
  if (typeof source !== 'string' || source === '') return [];
  const names = new Set();
  REGISTRATION.lastIndex = 0;
  for (let match = REGISTRATION.exec(source); match !== null; match = REGISTRATION.exec(source)) {
    const window = source.slice(match.index, match.index + REGISTRATION_WINDOW);
    const name = window.match(REGISTERED_NAME)?.[1] ?? null;
    if (name === null || !TOOL_NAME.test(name)) continue;
    // `evolution_*` is the kernel's own namespace, not a published capability.
    if (name.startsWith('evolution_')) continue;
    names.add(name);
    if (names.size >= CAPABILITY_USAGE_LIMITS.maxToolNamesPerRecord) break;
  }
  return [...names];
}

/** True when a session log row opens or closes an execution. */
function callIdentity(row) {
  const type = row?.type;
  if (type !== 'tool/call' && type !== 'tool/result') return null;
  const data = row.data;
  if (!data || typeof data !== 'object') return null;
  if (type === 'tool/call') {
    const name = typeof data.name === 'string' && data.name !== '' ? data.name : null;
    const callId = typeof data.callId === 'string' && data.callId !== '' ? data.callId : null;
    // The official session envelope gives each call a unique `seq`; a result
    // cites it in `sourceEventSeqs`. Prefer this exact link over callId, which
    // the host reuses across separate execution objects.
    const seq = Number.isSafeInteger(row.seq) ? row.seq : null;
    return { type, name, callId, seq };
  }
  const message = data.message && typeof data.message === 'object' ? data.message : null;
  const callId = typeof data.toolCallId === 'string' && data.toolCallId !== ''
    ? data.toolCallId
    : typeof message?.toolCallId === 'string' && message.toolCallId !== '' ? message.toolCallId : null;
  const sourceSeqs = Array.isArray(row.sourceEventSeqs)
    ? row.sourceEventSeqs.filter((value) => Number.isSafeInteger(value)) : [];
  return { type, name: null, callId, sourceSeqs };
}

function nonEmptyString(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Identity of a PTC dispatch row (`dsh-tools` / `dsh-session`).
 *
 * The official nested execution records carry the tool name and three call ids
 * in `data`. Neither a start nor a dispatch is a native `tool/call`: treating
 * them as one would either miss the call entirely or count it twice.
 */
function ptcIdentity(row) {
  const type = row?.type;
  if (type !== PTC_START && type !== PTC_DISPATCH) return null;
  const data = row.data;
  if (!data || typeof data !== 'object') return null;
  const name = nonEmptyString(data.name);
  if (name === null) return null;
  return {
    type,
    name,
    subCallId: nonEmptyString(data.subCallId),
    parentCallId: nonEmptyString(data.parentCallId),
    rootCallId: nonEmptyString(data.rootCallId),
  };
}

/** Pair a final dispatch with its start; the official rows always carry a subCallId. */
function ptcKey(identity) {
  if (identity.subCallId !== null) return `sub\u0000${identity.subCallId}`;
  if (identity.rootCallId !== null) return `root\u0000${identity.rootCallId}\u0000${identity.name}`;
  if (identity.parentCallId !== null) return `parent\u0000${identity.parentCallId}\u0000${identity.name}`;
  return null;
}

/**
 * Count one session's published-tool calls.
 *
 * `toolNames` is the set of tool names published records register; only those
 * calls are counted. A call made while a lifecycle call is open is resolved at
 * `finish()`: verification when every enclosing lifecycle call returned,
 * unattributed when one did not.
 *
 * callId is NOT a unique execution id: the official host reuses it across
 * separate execution objects (PTC envelopes — see experience-collector.js).
 * Each `tool/call` row is therefore counted independently. A lifecycle call
 * whose callId was already used by another call cannot be closed by callId
 * alone, so it is marked ambiguous: calls made under it stay unattributed
 * instead of being guessed into usage or verification. An exact result link
 * through `sourceEventSeqs` can still close it and clear the ambiguity.
 *
 * PTC rows are a second, nested execution surface. A start only reserves a
 * pending dispatch; the final `tool/ptc-dispatch` is the one counted call. If
 * the final row is absent at `finish()`, the start is counted as unattributed
 * rather than dropped, because the log proves the tool began executing.
 */
export function createSessionCounter(toolNames) {
  const published = toolNames instanceof Set ? toolNames : new Set(toolNames ?? []);
  let nextToken = 0;
  const open = new Map(); // instance token -> { callId, seq }
  const openByCallId = new Map(); // callId -> FIFO of instance tokens
  const openBySeq = new Map(); // official envelope seq -> instance token
  const ambiguous = new Set(); // tokens whose result cannot be proven
  const usedCallIds = new Set();
  const closed = new Set();
  const pending = [];
  const counts = new Map();
  const ptcStarts = new Map(); // ptcKey -> FIFO of published starts awaiting a final dispatch
  const anonymousPtcStarts = []; // starts with no usable correlation id
  const ptcLifecycle = new Map(); // ptcKey -> { token, parentInstance }
  const ptcLifecycleTokens = new Set(); // tokens opened by a PTC lifecycle start
  const openRunCode = new Map(); // native run_code callId -> open execution instances
  const closePtcLifecycles = (instance) => {
    if (!instance) return;
    for (const [key, entry] of [...ptcLifecycle]) {
      if (entry.parentInstance !== instance) continue;
      if (open.has(entry.token)) {
        open.delete(entry.token);
        closed.add(entry.token);
      }
      ptcLifecycleTokens.delete(entry.token);
      ptcLifecycle.delete(key);
    }
  };
  const closeRunCodeInstance = (callId, seqs = []) => {
    if (callId === null) return;
    const instances = openRunCode.get(callId);
    if (!instances || instances.length === 0) return;
    let instance = null;
    if (Array.isArray(seqs) && seqs.length > 0) {
      instance = instances.find((row) => seqs.includes(row.seq)) ?? null;
    } else if (instances.length === 1) {
      instance = instances[0];
    }
    if (!instance) return;
    const rest = instances.filter((row) => row !== instance);
    if (rest.length === 0) openRunCode.delete(callId);
    else openRunCode.set(callId, rest);
    closePtcLifecycles(instance);
  };
  const bucket = (name) => {
    let row = counts.get(name);
    if (!row) { row = { workflow: 0, verification: 0, unattributed: 0 }; counts.set(name, row); }
    return row;
  };
  const enclosing = () => [...open.keys()].slice(0, 8);
  const takeStart = (key, name) => {
    if (key === null) {
      return anonymousPtcStarts[0]?.name === name ? anonymousPtcStarts.shift() : null;
    }
    const waiting = ptcStarts.get(key);
    if (!waiting || waiting[0]?.name !== name) return null;
    const start = waiting.shift();
    if (waiting.length === 0) ptcStarts.delete(key);
    return start;
  };
  const ptcCall = (ptc) => {
    const key = ptcKey(ptc);
    if (ptc.type === PTC_START) {
      // A lifecycle tool can itself be invoked from a run_code program on a
      // PTC preset. Open the same kind of lifecycle token a native call opens,
      // so published calls made under it are not misread as workflow usage.
      if (LIFECYCLE.has(ptc.name)) {
        const token = ++nextToken;
        open.set(token, { callId: null, seq: null });
        ptcLifecycleTokens.add(token);
        // Tie the lifecycle window to one concrete run_code instance. A reused
        // callId with more than one open instance cannot prove which program
        // owns the start, so it is not tied and cannot close another program's
        // window when a result arrives.
        const instances = ptc.parentCallId === null ? [] : (openRunCode.get(ptc.parentCallId) ?? []);
        const parentInstance = instances.length === 1 ? instances[0] : null;
        if (key !== null) ptcLifecycle.set(key, { token, parentInstance });
        return 'ptc-lifecycle-start';
      }
      if (!published.has(ptc.name)) return 'ignored';
      const openTokens = enclosing();
      const native = openTokens.filter((token) => !ptcLifecycleTokens.has(token));
      const record = {
        name: ptc.name,
        enclosing: native,
        // A start that only saw a PTC lifecycle window is not proof of
        // verification; keep that fact even after the lifecycle final closes
        // the token before this call's final row is read.
        ptcEnclosed: native.length !== openTokens.length,
      };
      if (key === null) anonymousPtcStarts.push(record);
      else {
        const waiting = ptcStarts.get(key) ?? [];
        waiting.push(record);
        ptcStarts.set(key, waiting);
      }
      return 'ptc-start';
    }
    if (LIFECYCLE.has(ptc.name)) {
      const entry = key === null ? undefined : ptcLifecycle.get(key);
      if (entry && open.has(entry.token)) {
        open.delete(entry.token);
        closed.add(entry.token);
        ptcLifecycleTokens.delete(entry.token);
      }
      if (key !== null) ptcLifecycle.delete(key);
      return 'ptc-lifecycle-result';
    }
    if (!published.has(ptc.name)) return 'ignored';
    const start = takeStart(key, ptc.name);
    // A native lifecycle call is a real outer execution window: calls made
    // while it is open are verification traffic. A PTC lifecycle start is only
    // a log row; its final row is appended asynchronously, so a later normal
    // call can appear before that final row. That order cannot prove the
    // published call was inside the lifecycle. Treat it as unattributed, never
    // as verification: a false verification would turn a real workflow call
    // into a measured zero and could unlock a retirement recommendation.
    const currentTokens = enclosing();
    const currentNative = currentTokens.filter((token) => !ptcLifecycleTokens.has(token));
    const nativeTokens = [...new Set([...(start?.enclosing ?? []), ...currentNative])].slice(0, 8);
    if (nativeTokens.length > 0) {
      pending.push({ name: ptc.name, enclosing: nativeTokens });
      return 'pending';
    }
    if ((start?.ptcEnclosed ?? false) || currentTokens.length > 0) {
      bucket(ptc.name).unattributed += 1;
      return 'unattributed';
    }
    // The official PTC rows cite the model's `run_code` call as parentCallId.
    // Only exactly one *open* native run_code instance proves a model choice; a
    // historical non-run_code call, a finished run_code, or a reused id with
    // several open instances cannot. Without that proof the host drove the
    // execution and the call is unattributed — never a measured zero.
    const instances = ptc.parentCallId === null ? [] : (openRunCode.get(ptc.parentCallId) ?? []);
    if (instances.length === 1) {
      bucket(ptc.name).workflow += 1;
      return 'workflow';
    }
    bucket(ptc.name).unattributed += 1;
    return 'unattributed';
  };
  return {
    call(row) {
      const ptc = ptcIdentity(row);
      if (ptc !== null) return ptcCall(ptc);
      const identity = callIdentity(row);
      if (identity === null) return 'ignored';
      if (identity.type === 'tool/result') {
        // A finished run_code can no longer be the enclosing model program of a
        // later PTC dispatch. Close the exact instance cited by
        // `sourceEventSeqs`; a reused callId must not let an old result erase a
        // new program's open state, and a missing result must not leave a stale
        // PTC lifecycle window behind.
        closeRunCodeInstance(identity.callId, identity.sourceSeqs);
        let token;
        // The official host cites the originating call's envelope seq in the
        // result. That exact link survives callId reuse and closes the right
        // lifecycle instance; only older rows without it need the conservative
        // callId fallback.
        for (const seq of identity.sourceSeqs) {
          const candidate = openBySeq.get(seq);
          if (candidate !== undefined && open.has(candidate)) { token = candidate; break; }
        }
        if (token !== undefined) {
          const record = open.get(token);
          ambiguous.delete(token);
          open.delete(token);
          closed.add(token);
          if (record.seq !== null) openBySeq.delete(record.seq);
          if (record.callId !== null) {
            const tokens = (openByCallId.get(record.callId) ?? []).filter((row) => row !== token);
            if (tokens.length === 0) openByCallId.delete(record.callId);
            else openByCallId.set(record.callId, tokens);
          }
        } else if (identity.callId !== null) {
          const tokens = openByCallId.get(identity.callId);
          if (tokens && tokens.length > 0 && !tokens.some((row) => ambiguous.has(row))) {
            const fallback = tokens.shift();
            if (tokens.length === 0) openByCallId.delete(identity.callId);
            const record = open.get(fallback);
            if (record?.seq !== null && record?.seq !== undefined) openBySeq.delete(record.seq);
            open.delete(fallback);
            closed.add(fallback);
          }
        }
        return 'result';
      }
      const name = identity.name;
      if (name === null) return 'ignored';
      const reusedCallId = identity.callId !== null && usedCallIds.has(identity.callId);
      if (identity.callId !== null) usedCallIds.add(identity.callId);
      if (name === 'run_code' && identity.callId !== null) {
        const instances = openRunCode.get(identity.callId) ?? [];
        instances.push({ callId: identity.callId, seq: identity.seq });
        openRunCode.set(identity.callId, instances);
      }
      if (LIFECYCLE.has(name)) {
        const token = ++nextToken;
        open.set(token, { callId: identity.callId, seq: identity.seq });
        if (identity.seq !== null) openBySeq.set(identity.seq, token);
        if (identity.callId !== null) {
          const tokens = openByCallId.get(identity.callId) ?? [];
          tokens.push(token);
          openByCallId.set(identity.callId, tokens);
          // A reused id can belong to a different execution; without an exact
          // seq link its result cannot prove that *this* call returned.
          if (reusedCallId) ambiguous.add(token);
        }
        // A lifecycle call without a call id is never closed; published calls
        // made after it are then unattributable, never "usage".
        return 'lifecycle';
      }
      // Any second call with a reused callId — published or not — makes the
      // result of an already-open lifecycle call unprovable. Mark it before
      // filtering by tool name, otherwise an ordinary unpublished tool (read,
      // grep, ...) could close the lifecycle and turn later verification into
      // apparent workflow usage.
      if (reusedCallId && identity.callId !== null) {
        for (const token of openByCallId.get(identity.callId) ?? []) ambiguous.add(token);
      }
      if (!published.has(name)) return 'ignored';
      if (open.size === 0) { bucket(name).workflow += 1; return 'workflow'; }
      pending.push({ name, enclosing: [...open.keys()].slice(0, 8) });
      return 'pending';
    },
    finish() {
      for (const { name, enclosing: tokens } of pending) {
        if (tokens.every((token) => closed.has(token))) bucket(name).verification += 1;
        else bucket(name).unattributed += 1;
      }
      pending.length = 0;
      // A start whose final dispatch never arrived still proves an invocation
      // began; it must not disappear into a zero count.
      for (const waiting of ptcStarts.values()) {
        for (const start of waiting) bucket(start.name).unattributed += 1;
      }
      ptcStarts.clear();
      for (const start of anonymousPtcStarts) bucket(start.name).unattributed += 1;
      anonymousPtcStarts.length = 0;
      return counts;
    },
  };
}

async function* readSessionLines(file, { compressed = true } = {}) {
  // `pipe()` does not forward source errors (a missing or unreadable file) to the
  // downstream stage; `pipeline()` does, so such a log is reported as a failed
  // scan instead of an unhandled 'error' event. Both current-generation codecs
  // share this line splitter and the same bounded-read rule.
  const source = fs.createReadStream(file);
  const output = new PassThrough();
  const stages = compressed ? [source, zlib.createZstdDecompress(), output] : [source, output];
  const done = pipeline(...stages);
  // The consumer may stop early (a thrown size bound); keep that rejection from
  // becoming an unhandled promise, while still awaiting it on the normal path.
  done.catch(() => {});
  let buffer = '';
  let bytes = 0;
  try {
    for await (const chunk of output) {
      bytes += chunk.length;
      if (bytes > CAPABILITY_USAGE_LIMITS.maxSessionBytes) {
        const error = new Error('session log exceeds the decompressed size bound');
        error.code = 'E_USAGE_SESSION_TOO_LARGE';
        throw error;
      }
      buffer += chunk.toString('utf8');
      for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
        yield buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
      }
    }
    await done;
  } finally {
    // Destroy every half so an early return cannot leave a decompressor open.
    for (const stream of stages) {
      if (typeof stream.destroy === 'function') stream.destroy();
    }
  }
  if (buffer !== '') yield buffer;
}

function failureList(map) {
  return [...map.values()].slice(0, CAPABILITY_USAGE_LIMITS.maxScanFailures);
}

function addFailure(map, key) {
  if (!map.has(key)) {
    if (map.size >= CAPABILITY_USAGE_LIMITS.maxScanFailures) return;
    // The session directory name identifies the log to its owner without
    // exporting the operator's absolute paths into the projection.
    map.set(key, { session: path.basename(path.dirname(key)) });
  }
}

function addUnsupportedSession(failures, file, name) {
  const map = failures.unsupportedSessionFormats;
  if (map.has(file) || map.size >= CAPABILITY_USAGE_LIMITS.maxScanFailures) return;
  // Only the directory name and canonical file name leave the scan, never the
  // operator's absolute path or any transcript content.
  map.set(file, { session: path.basename(path.dirname(file)), file: name });
}

function addAmbiguousEncoding(failures, dir, files) {
  const map = failures.ambiguousSessionEncoding;
  if (map.has(dir) || map.size >= CAPABILITY_USAGE_LIMITS.maxScanFailures) return;
  // The session directory name and the two canonical file names identify the
  // scene without exporting the operator's absolute path or any transcript.
  map.set(dir, {
    session: path.basename(dir),
    files: files.map((entry) => path.basename(entry.file)).sort(),
  });
}

function sessionFiles(root, failures) {
  const current = new Map(); // session directory -> current-generation files
  const old = new Map(); // session directory -> other canonical generations
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {
      failures.unreadableDirectories += 1;
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === SESSION_V4_ZSTD) {
        const list = current.get(dir) ?? [];
        list.push({ file: full, compressed: true });
        current.set(dir, list);
      } else if (entry.name === SESSION_V4) {
        const list = current.get(dir) ?? [];
        list.push({ file: full, compressed: false });
        current.set(dir, list);
      } else if (SESSION_OTHER_GENERATION.test(entry.name)) {
        const list = old.get(dir) ?? [];
        list.push({ file: full, name: entry.name });
        old.set(dir, list);
      }
    }
  };
  walk(root);
  const files = [];
  for (const [dir, entries] of current) {
    // A compression change leaves the previous encoding next to the current
    // one. The two files describe the same session and the log cannot prove
    // which is live, so neither may be counted: an ambiguous encoding is
    // unknown, never a duplicate workflow count.
    if (entries.length === 1) files.push(entries[0]);
    else addAmbiguousEncoding(failures, dir, entries);
  }
  for (const [dir, entries] of old) {
    // Historical generations beside a current file are the same session's
    // migrated copies and are not separate sessions. Only a directory with no
    // current generation is a session this scan cannot cover.
    if (current.has(dir)) continue;
    for (const entry of entries) addUnsupportedSession(failures, entry.file, entry.name);
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * The registered tool names of every published record.
 *
 * An unreadable source is a per-record unknown; a shared name is ambiguous and
 * stays ambiguous instead of being assigned to whichever record happened last.
 */
async function publishedToolMap(dataRoot, failures) {
  const index = await readSharedIndex({ dataRoot, pluginRoot: path.join(dataRoot, 'promoted') });
  if (index.status !== 'ok') {
    failures.publicationIndexUnreadable = index.status;
    return { records: [], toolToRecords: new Map() };
  }
  const records = index.records.slice(0, CAPABILITY_USAGE_LIMITS.maxRecords);
  if (index.records.length > records.length) failures.recordsTruncated = index.records.length - records.length;
  const toolToRecords = new Map();
  for (const record of records) {
    let source;
    try {
      const stat = fs.statSync(new URL(record.moduleUrl));
      if (!stat.isFile() || stat.size > CAPABILITY_USAGE_LIMITS.maxSourceBytes) throw new Error('source size bound');
      source = fs.readFileSync(new URL(record.moduleUrl), 'utf8');
    } catch (error) {
      failures.unreadableSources.push({ id: record.id, reason: error?.code ?? 'source-unreadable' });
      continue;
    }
    const names = toolNamesFromSource(source);
    if (names.length === 0) {
      // A context-policy plugin registers no tool: a call count cannot describe
      // its use, so this record stays unknown instead of "zero". It is a
      // property of the capability, not damage to the projection.
      failures.uncountableRecords.push({ id: record.id, reason: 'no-tool-surface' });
      continue;
    }
    for (const name of names) {      const holders = toolToRecords.get(name) ?? new Set();
      holders.add(record.id);
      toolToRecords.set(name, holders);
    }
  }
  for (const [name, holders] of [...toolToRecords]) {
    if (holders.size > 1) failures.ambiguousToolNames.push({ tool: name, records: [...holders].sort() });
  }
  return { records, toolToRecords };
}

/**
 * Scan every persisted session log once and build the usage projection.
 *
 * `sessionsRoot` is the only transcript input; nothing outside it is read and
 * no line content leaves this function except tool names and counts.
 */
export async function summarizeCapabilityUsage({ dataRoot, sessionsRoot, assessments = {}, now = Date.now() } = {}) {
  const failures = {
    publicationIndexUnreadable: false,
    unreadableDirectories: 0,
    recordsTruncated: 0,
    unreadableSources: [],
    uncountableRecords: [],
    ambiguousToolNames: [],
    unreadableSessions: new Map(),
    undecompressableSessions: new Map(),
    oversizedSessions: new Map(),
    unsupportedSessionFormats: new Map(),
    ambiguousSessionEncoding: new Map(),
    invalidLogLines: 0,
  };
  const { records, toolToRecords } = await publishedToolMap(dataRoot, failures);
  const counts = new Map(records.map((record) => [record.id, { workflowInvocations: 0, verificationInvocations: 0, unattributedInvocations: 0 }]));
  let scannedSessions = 0;
  let scannedToolCalls = 0;
  if (typeof sessionsRoot !== 'string' || sessionsRoot === '') {
    failures.unreadableDirectories += 1;
  } else {
    const publishedNames = new Set(toolToRecords.keys());
    for (const { file, compressed } of sessionFiles(sessionsRoot, failures)) {
      const session = createSessionCounter(publishedNames);
      let parsed = false;
      try {
        for await (const line of readSessionLines(file, { compressed })) {
          if (line === '') continue;
          let row;
          try { row = JSON.parse(line); } catch { failures.invalidLogLines += 1; continue; }
          if (row?.type === 'tool/call' || row?.type === 'tool/ptc-dispatch') scannedToolCalls += 1;
          session.call(row);
        }
        parsed = true;
      } catch (error) {
        if (error?.code === 'E_USAGE_SESSION_TOO_LARGE') addFailure(failures.oversizedSessions, file);
        else if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EISDIR') addFailure(failures.unreadableSessions, file);
        else addFailure(failures.undecompressableSessions, file);
      }
      if (!parsed) continue;
      scannedSessions += 1;
      const sessionCounts = session.finish();
      for (const [name, row] of sessionCounts) {
        const holders = toolToRecords.get(name);
        if (!holders) continue;
        for (const id of holders) {
          const bucket = counts.get(id);
          if (!bucket) continue;
          if (holders.size > 1) {
            // Two records publish the same tool name: the call cannot be
            // attributed to one of them, and must not become zero for both.
            bucket.unattributedInvocations += row.workflow + row.verification + row.unattributed;
            continue;
          }
          bucket.workflowInvocations += row.workflow;
          bucket.verificationInvocations += row.verification;
          bucket.unattributedInvocations += row.unattributed;
        }
      }
    }
  }
  const sessionFailure = failures.publicationIndexUnreadable !== false
    || failures.unreadableDirectories > 0
    || failures.recordsTruncated > 0
    || failures.unreadableSessions.size > 0
    || failures.undecompressableSessions.size > 0
    || failures.oversizedSessions.size > 0
    || failures.unsupportedSessionFormats.size > 0
    || failures.ambiguousSessionEncoding.size > 0
    || failures.invalidLogLines > 0;
  const unreadableIds = new Set(failures.unreadableSources.map((row) => row.id));
  const ambiguousIds = new Set(failures.ambiguousToolNames.flatMap((row) => row.records));
  // A record with no tool surface has no call to count; that is not a missing
  // read, so it stays out of both the unreadable and the ambiguous sets.
  const uncountableIds = new Set(failures.uncountableRecords.map((row) => row.id));
  // `complete` is session coverage: a session that could not be read might have
  // called any record. `recordsComplete` adds the per-record knowledge, where a
  // single unreadable source only invalidates its own row.
  const complete = !sessionFailure;
  const recordsComplete = complete && failures.unreadableSources.length === 0 && failures.ambiguousToolNames.length === 0;
  const capturedAt = new Date(now).toISOString();
  return {
    kind: USAGE_PROJECTION_KIND,
    schemaVersion: USAGE_PROJECTION_SCHEMA_VERSION,
    coverage: USAGE_PROJECTION_COVERAGE,
    source: 'session-evidence',
    complete,
    recordsComplete,
    capturedAt,
    ...(failures.uncountableRecords.length > 0 ? { uncountableRecords: [...failures.uncountableRecords] } : {}),
    sessionsRoot: typeof sessionsRoot === 'string' ? sessionsRoot : null,
    scannedSessions,
    scannedToolCalls,
    rule: 'a published-tool call (native or PTC dispatch) is verification traffic only while a promotion-lifecycle call is open in the same session; a PTC dispatch with a native parent call is workflow, other unresolved or ambiguous calls are unattributed, never zero',
    ...(recordsComplete ? {} : {
      failures: {
        ...failures,
        unreadableSessions: failureList(failures.unreadableSessions),
        undecompressableSessions: failureList(failures.undecompressableSessions),
        oversizedSessions: failureList(failures.oversizedSessions),
        unsupportedSessionFormats: failureList(failures.unsupportedSessionFormats),
        ambiguousSessionEncoding: failureList(failures.ambiguousSessionEncoding),
      },
      incompleteReason: 'the scan could not cover every session log or plugin source, so the affected counts are unknown rather than zero',
    }),
    records: Object.fromEntries(records.map((record) => {
      const row = counts.get(record.id) ?? { workflowInvocations: null, verificationInvocations: null, unattributedInvocations: null };
      const uncountable = uncountableIds.has(record.id);
      const unknown = uncountable || !complete || unreadableIds.has(record.id) || ambiguousIds.has(record.id);
      return [record.id, {
        workflowInvocations: unknown ? null : row.workflowInvocations,
        verificationInvocations: unknown ? null : row.verificationInvocations,
        unattributedInvocations: unknown ? null : row.unattributedInvocations,
        ...(uncountable ? { measurement: 'no-tool-surface' } : {}),
        capabilityAssessment: typeof assessments?.[record.id] === 'string' ? assessments[record.id] : 'unknown',
      }];
    })),
  };
}

function boundedCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(1_000_000_000, Math.floor(value)) : null;
}

function countOrNull(value) {
  return value === undefined ? 0 : boundedCount(value);
}

/**
 * Read the persisted projection, or report why there is none.
 *
 * Never throws: a damaged, oversized or stale projection is a fact the audit
 * reports, and the review then treats the affected counts as unknown.
 */
export async function readUsageProjection({ dataRoot, now = Date.now(), maxAgeDays = CAPABILITY_USAGE_LIMITS.staleAfterDays } = {}) {
  let file;
  try { file = sharingPaths({ dataRoot }).usagePath; } catch {
    return { status: 'absent', usage: null, evidence: { status: 'absent' } };
  }
  const absent = { status: 'absent', usage: null, evidence: { status: 'absent' } };
  let stat;
  try { stat = await fsp.stat(file); } catch { return absent; }
  if (!stat.isFile()) return { status: 'invalid', usage: null, evidence: { status: 'invalid', reason: 'not-a-file' } };
  if (stat.size > CAPABILITY_USAGE_LIMITS.maxProjectionBytes) {
    return { status: 'invalid', usage: null, evidence: { status: 'invalid', reason: 'size', bytes: stat.size } };
  }
  let doc;
  let text;
  try { text = await fsp.readFile(file, 'utf8'); } catch {
    return { status: 'invalid', usage: null, evidence: { status: 'invalid', reason: 'unreadable' } };
  }
  if (Buffer.byteLength(text, 'utf8') > CAPABILITY_USAGE_LIMITS.maxProjectionBytes) {
    return { status: 'invalid', usage: null, evidence: { status: 'invalid', reason: 'size' } };
  }
  try { doc = JSON.parse(text); } catch {
    return { status: 'invalid', usage: null, evidence: { status: 'invalid', reason: 'unreadable' } };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { status: 'invalid', usage: null, evidence: { status: 'invalid', reason: 'shape' } };
  }
  if (doc.kind !== undefined && doc.kind !== USAGE_PROJECTION_KIND) {
    return { status: 'invalid', usage: null, evidence: { status: 'invalid', reason: 'kind' } };
  }
  if (doc.schemaVersion !== undefined && doc.schemaVersion !== USAGE_PROJECTION_SCHEMA_VERSION) {
    return { status: 'invalid', usage: null, evidence: { status: 'invalid', reason: 'schema-version' } };
  }
  const raw = doc.records;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'invalid', usage: null, evidence: { status: 'invalid', reason: 'records' } };
  }
  const records = {};
  let invalidRecords = 0;
  for (const [id, row] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || !row || typeof row !== 'object' || Array.isArray(row)) {
      invalidRecords += 1;
      continue;
    }
    const assessment = ['self-contained', 'workflow-relevant', 'unknown'].includes(row.capabilityAssessment)
      ? row.capabilityAssessment : 'unknown';
    // A count that is present but unusable becomes `null` (unknown); it must not
    // be silently dropped, which would look like a zero to the review.
    // A capability with no tool surface has no call to count: its counts are
    // null by construction, not by a failed read, so it must not make the whole
    // projection's per-record knowledge look incomplete.
    const noToolSurface = row.measurement === 'no-tool-surface';
    records[id] = {
      workflowInvocations: boundedCount(row.workflowInvocations),
      verificationInvocations: boundedCount(row.verificationInvocations),
      // An older projection predates the unattributed bucket; its absence means
      // "no unresolved call was recorded", not "unknown".
      unattributedInvocations: countOrNull(row.unattributedInvocations),
      ...(noToolSurface ? { measurement: 'no-tool-surface' } : {}),
      capabilityAssessment: assessment,
      ...(row.productionBenefit && row.productionBenefit.evidenced === true
        ? { productionBenefit: { evidenced: true, summary: typeof row.productionBenefit.summary === 'string' ? row.productionBenefit.summary.slice(0, 240) : null } }
        : {}),
    };
    if (!noToolSurface && (records[id].workflowInvocations === null || records[id].verificationInvocations === null
      || records[id].unattributedInvocations === null)) invalidRecords += 1;
  }
  const capturedAt = typeof doc.capturedAt === 'string' ? doc.capturedAt : null;
  const captured = capturedAt === null ? Number.NaN : Date.parse(capturedAt);
  const ageDays = Number.isFinite(captured) ? (now - captured) / 86_400_000 : null;
  // A projection without a usable capture time, or one older than the bound,
  // cannot support "zero invocations" — a plugin published after the scan is
  // absent from it, and an old snapshot cannot see later daily use.
  const stale = ageDays === null || !Number.isFinite(ageDays) || ageDays > maxAgeDays || ageDays < 0;
  const complete = doc.complete !== false;
  const coverage = doc.coverage === USAGE_PROJECTION_COVERAGE ? USAGE_PROJECTION_COVERAGE : 'legacy';
  return {
    status: 'ok',
    usage: {
      source: typeof doc.source === 'string' && doc.source !== '' ? doc.source.slice(0, 80) : 'session-evidence',
      coverage,
      capturedAt,
      complete,
      recordsComplete: doc.recordsComplete !== false && invalidRecords === 0,
      stale,
      records,
    },
    evidence: {
      status: 'ok',
      coverage,
      capturedAt,
      complete,
      recordsComplete: doc.recordsComplete !== false && invalidRecords === 0,
      stale,
      ageDays: ageDays === null ? null : Math.round(ageDays * 10) / 10,
      recordCount: Object.keys(records).length,
      invalidRecords,
      scannedSessions: boundedCount(doc.scannedSessions),
    },
  };
}

/** Persist one projection for the explicit audit to read. Operator CLI only. */
export async function writeUsageProjection({ dataRoot, projection } = {}) {
  const target = sharingPaths({ dataRoot }).usagePath;
  const body = `${JSON.stringify(projection)}\n`;
  if (Buffer.byteLength(body) > CAPABILITY_USAGE_LIMITS.maxProjectionBytes) {
    throw new Error('usage projection exceeds the persisted size bound');
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(temp, body, { mode: 0o600 });
    await fsp.rename(temp, target);
  } catch (error) {
    try { await fsp.rm(temp, { force: true }); } catch { /* the target was never replaced */ }
    throw error;
  }
  return target;
}
