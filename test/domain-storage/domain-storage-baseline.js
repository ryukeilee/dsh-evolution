import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RELEASE_DIR, readTarEntries } from "../../scripts/release/release-lib.mjs";

const WORKING_SOURCE = fileURLToPath(new URL("../../lib/domain-storage.js", import.meta.url));

// The merged write-path variant under test landed after this artifact was
// pinned, so the artifact is the frozen pre-change source for it. The manifest
// pin moves on with every candidate, so the anchor is named explicitly instead
// of following it.
const PRE_CHANGE_ARTIFACT = "dsh-evolution-0.2.0-rc.8.tgz";
const SOURCE_PATH = "lib/domain-storage.js";

// [post-change text, pre-change text]. Reversing the change must reproduce the
// pinned artifact byte for byte; an exact single-occurrence guard fails on any
// shape drift instead of silently rebuilding something else.
//
// The three reversed pieces are the whole retained variant, and each one
// removes work that is provably redundant rather than any check that can still
// reject:
//
// 1. `installPending` closed a committed recovery by re-parsing the document it
//    had already parsed one step earlier. `pending.aggregate` and
//    `pending.applied` come straight out of that `schema.parse` result, and the
//    remaining fields are the literals `schema: 1` and `pending: null`, so the
//    closing document is provably accepted before the second walk starts. The
//    validation that must stay - the full document check that runs before any
//    staged file is installed - is untouched.
// 2. The state store's `update` cloned the incoming aggregate before handing it
//    to the updater, and then projected the result through
//    `aggregateSchema.parse`, which is itself a fresh deep value
//    (`JSON.parse(JSON.stringify(...))`). The clone could only be copied again.
//    Both updaters this store receives are pure spreads that never mutate their
//    argument.
// 3. The same store did not declare `inlineSerialization`, so `EvolutionMemory`
//    deep-cloned the live partition (`snapshot()`) before persisting it. The
//    bytes are captured synchronously by the JSON projection inside `update`,
//    so the shallow live view is equivalent and the clone is the third copy of
//    the same value in that call.
//
// A fourth candidate - dropping the `EvolutionObservationStore` that `hydrate()`
// loads and never reads - was measured with these three and then withdrawn: its
// `load()` is not inert, because `snapshot()` reads `memory.hasColdHistory`,
// which coerces every `coldArchives` entry with `Number(count)`. Dropping the
// call let the first commit after a durable aggregate with a non-coercible
// entry succeed where the released implementation refuses it. See
// `docs/performance/domain-write-path.md` section 4.
//
// The commit-shape round landed last and is reversed first: a transaction whose
// change list is empty has nothing to sequence before its aggregate (the pending
// record exists so recovery can replay staged bytes first, and there are none), so
// it publishes the closing document in one write and removes the stage. The pinned
// source instead always published a pending record and cleared it with a second
// whole-document write. Nothing about the persisted shape changes: the document at
// rest is the one the pinned source converged to, which is what the byte comparison
// in `domain-storage-write-path-equivalence.test.js` checks.
//
// A later round added a fourth reversed piece: both load calls that discard the
// projection they used to build now ask for it not to be built (`load({ snapshot:
// false })`). Loading is unchanged apart from the skipped clone, and the
// cold-history read the withdrawn candidate depended on is performed explicitly
// by the observation store's own `load()`.
//
// The write-path variant is not the only change after the anchor: on-demand
// experience recall added a read-only `recall` method to the same port, and a
// read that never writes cannot change the persisted bytes this file's
// benchmark compares. It is still reversed below so the reconstruction keeps
// reproducing the pinned pre-change source byte for byte instead of silently
// dropping the anchor. A later round stopped copying the rows that method reads
// (`memory.historyView`, the read-only view) because the collector projects
// every field it keeps into its own record; that is the same insertion, so the
// same piece reverses it.
//
// The last round after the anchor added the durable commit token and the
// pre-publication compare: `createHash` for the aggregate digest, one block of
// helpers (deterministic serialization, digest, ledger comparison, refusal
// message, token read/replace/advance), the token path beside the archive lock,
// the committed-state snapshot `mutate()` captures, the compare that refuses to
// publish, and the token advances in `installPending()` and the authorized seed.
// None of it changes the persisted aggregate the benchmark compares; it is
// reversed here for the same reason as the pieces above - the reconstruction
// reproduces the pinned artifact, not an approximation of it. Two of those
// pieces sit inside fragments an earlier round already own (the `installPending()`
// closing write and the pending publication), so they are folded into those
// fragments rather than given anchors of their own.
//
// Every piece below is applied in the order written, and each one names text the
// other direction can also find: no piece deletes text another piece is anchored
// on, and no piece is anchored on an empty string.
const reversals = [
  // Undo the retention reliability closure before the historical reversals.
  ["// anchor has to stay byte-identical.\nimport { createEventBridgeEvidenceIndex, withEventBridgeAppendLock } from './orchestrator.js';\nimport { warnRedacted } from './registration.js';\nimport { advanceRetention, completeEventLogTruncation, DEFAULT_LOG_RETAIN_RECORDS, inspectEventLogFloor,\n  eventLogCheckpointDocument, eventLogCheckpointPath, planEventLogReplay, planLogPrune, planRetainedCoverage,\n  readEventLogCheckpoint, RETENTION_SCHEMA, verifyLogFloorTail, writeEventLogCheckpoint } from './event-log-checkpoint.js';\nimport { assertLiveTreeUnchanged, changedArchiveFiles, copyArchives, installArchiveFiles, mirrorArchives,\n  privatizeArchiveFile, stageDirectory, syncFile, syncStage, syncTree, writeStageManifest } from './archive-stage.js';\n\n", "// anchor has to stay byte-identical.\nimport { createEventBridgeEvidenceIndex, withEventBridgeAppendLock } from './orchestrator.js';\nimport { warnRedacted } from './registration.js';\nimport { advanceRetention, completeEventLogTruncation, DEFAULT_LOG_RETAIN_RECORDS,\n  eventLogCheckpointDocument, eventLogCheckpointPath, planEventLogReplay, planLogPrune, planRetainedCoverage,\n  readEventLogCheckpoint, RETENTION_SCHEMA, writeEventLogCheckpoint } from './event-log-checkpoint.js';\nimport { assertLiveTreeUnchanged, changedArchiveFiles, copyArchives, installArchiveFiles, mirrorArchives,\n  privatizeArchiveFile, stageDirectory, syncFile, syncStage, syncTree, writeStageManifest } from './archive-stage.js';\n\n"],
  ["   * records both the bytes it was computed from and the bytes that stay, so the\n   * state \"committed but not yet truncated\" is provable instead of a refusal.\n   */\n  function requireReclaimContinuation(source, retention, { dryRun = false } = {}) {\n    if (!retention?.log) return 'ready';\n    const floor = retention.log;\n    if (source.status === 'readable' && verifyLogFloorTail({ buffer: source.bytes, floor, key: config.eventBridgeKey })) return 'ready';\n    if (dryRun && source.status === 'readable'\n      && inspectEventLogFloor({ file: source.file, key: config.eventBridgeKey, floor: retention }).status === 'deferred') return 'pending-truncation';\n    const error = new Error('E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH: reclaim requires the committed retention tail; restore its retained bytes or start a new data root');\n    error.code = 'E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH';\n    throw error;\n  }\n  function finishReclaimTruncation(retention) {\n    if (!retention?.log) return;\n    try {\n      completeEventLogTruncation({ file: config.eventBridgePath, key: config.eventBridgeKey,\n        floor: retention, withAppendLock: withEventBridgeAppendLock });\n    } catch (cause) {\n      const error = new Error('E_DOMAIN_EVENT_LOG_BUSY: the previous committed truncation could not run; retry once the writer releases the log');\n      error.code = 'E_DOMAIN_EVENT_LOG_BUSY';\n      error.cause = cause;\n      throw error;\n    }\n  }\n  async function reclaimLog({ recovered, committedRetention, retainRecords, decision }) {\n    // Finish the previous committed transaction before deriving another floor.\n    // Otherwise blank bytes ahead of pruned markers can advance a new plan.\n    finishReclaimTruncation(committedRetention);\n    const source = readEventLogBytes();\n    requireReclaimContinuation(source, committedRetention);\n    if (source.status !== 'readable') return { status: source.status };\n    const writer = eventBridgeWriterName();\n    const key = config.eventBridgeKey;\n", "   * records both the bytes it was computed from and the bytes that stay, so the\n   * state \"committed but not yet truncated\" is provable instead of a refusal.\n   */\n  async function reclaimLog({ recovered, committedRetention, retainRecords, decision }) {\n    const source = readEventLogBytes();\n    if (source.status !== 'readable') return { status: source.status };\n    const writer = eventBridgeWriterName();\n    const key = config.eventBridgeKey;\n"],
  ["        if (archives) report.archives = await memory.compact({ dryRun: true });\n        if (log) {\n          const source = readEventLogBytes();\n          const continuation = requireReclaimContinuation(source, domain.global.get().retention, { dryRun: true });\n          if (continuation === 'pending-truncation') report.log = { status: continuation, bytes: source.bytes.length };\n          else if (source.status !== 'readable') report.log = { status: source.status };\n          else {\n            const plan = planLogPrune({ buffer: source.bytes, key: config.eventBridgeKey, writer: eventBridgeWriterName(), applied: domain.global.get().applied, retainRecords });\n            report.log = plan\n", "        if (archives) report.archives = await memory.compact({ dryRun: true });\n        if (log) {\n          const source = readEventLogBytes();\n          if (source.status !== 'readable') report.log = { status: source.status };\n          else {\n            const plan = planLogPrune({ buffer: source.bytes, key: config.eventBridgeKey, writer: eventBridgeWriterName(), applied: domain.global.get().applied, retainRecords });\n            report.log = plan\n"],

  // >>> reclaim-round pairs (generated from the working tree) >>>
  ["import { EvolutionMemory, EvolutionObservationStore, EvolutionEvaluator } from './dockyard-domain/index.js';\nimport { collectKnowledgeExperience } from './experience-recall.js';\nimport { EVENT_BRIDGE_DEFAULT_WRITER, eventBridgeWriterTrusted, verifyEventBridgeEnvelope } from './orchestrator.js';\n// Kept on its own line: `flush-checkpoint-diagnostics.test.js` derives the\n// pre-fix module by substituting the single-line replay import below, and that\n// anchor has to stay byte-identical.\nimport { createEventBridgeEvidenceIndex, withEventBridgeAppendLock } from './orchestrator.js';\nimport { warnRedacted } from './registration.js';\nimport { advanceRetention, completeEventLogTruncation, DEFAULT_LOG_RETAIN_RECORDS,\n  eventLogCheckpointDocument, eventLogCheckpointPath, planEventLogReplay, planLogPrune, planRetainedCoverage,\n  readEventLogCheckpoint, RETENTION_SCHEMA, writeEventLogCheckpoint } from './event-log-checkpoint.js';\nimport { assertLiveTreeUnchanged, changedArchiveFiles, copyArchives, installArchiveFiles, mirrorArchives,\n  privatizeArchiveFile, stageDirectory, syncFile, syncStage, syncTree, writeStageManifest } from './archive-stage.js';\n\n\n// The legacy aggregate can carry `undefined` object fields (e.g. relationRefs).\n// JSON is the durable medium, and the old file backend already dropped those\n",
   "import { EvolutionMemory, EvolutionObservationStore, EvolutionEvaluator } from './dockyard-domain/index.js';\nimport { collectKnowledgeExperience } from './experience-recall.js';\nimport { EVENT_BRIDGE_DEFAULT_WRITER, eventBridgeWriterTrusted, verifyEventBridgeEnvelope } from './orchestrator.js';\nimport { warnRedacted } from './registration.js';\nimport { eventLogCheckpointDocument, eventLogCheckpointPath, planEventLogReplay,\n  readEventLogCheckpoint, writeEventLogCheckpoint } from './event-log-checkpoint.js';\nimport { assertLiveTreeUnchanged, changedArchiveFiles, copyArchives, installArchiveFiles, mirrorArchives,\n  privatizeArchiveFile, stageDirectory, syncFile, syncStage, syncTree, writeStageManifest } from './archive-stage.js';\n\n// The legacy aggregate can carry `undefined` object fields (e.g. relationRefs).\n// JSON is the durable medium, and the old file backend already dropped those\n"],
  ["    })\n    .transform(({ document }) => document));\nconst appliedSchema = z.record(z.string(), z.string());\n/**\n * One entry of the committed change list. A staged file is replaced in the live\n * tree; a `removed` entry is the only form of deletion the protocol has, and it\n * is restricted by `isRemovableArchiveSegment` in `archive-stage.js` to a sealed\n * segment whose records a compaction retired into the aggregate. The old shape\n * (no `removed`) still parses, so a pending record written by an earlier version\n * recovers exactly as before.\n */\nconst archiveFilesSchema = z.array(z.union([\n  z.object({ file: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),\n  z.object({ file: z.string(), removed: z.literal(true), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),\n]));\n/**\n * The durable retention floor (`lib/event-log-checkpoint.js`). Optional on both\n * the committed document and the pending record, so a database written before\n * this version loads unchanged and a reclaim's floor is installed atomically\n * with the ledger it prunes.\n */\nconst retentionSchema = z.object({\n  schema: z.literal(RETENTION_SCHEMA),\n  markers: z.object({ pruned: z.number().int().nonnegative(), chain: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),\n  log: z.object({\n    // Cumulative over every reclaim this root ever ran.\n    bytes: z.number().int().nonnegative(),\n    records: z.number().int().nonnegative(),\n    prior: z.object({ bytes: z.number().int().positive(), digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),\n    tail: z.object({ bytes: z.number().int().positive(), digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),\n  }).strict().nullable(),\n}).strict().superRefine((value, ctx) => {\n  // A floor whose retained tail is not strictly shorter than the file it was\n  // computed from cannot describe a truncation at all.\n  if (value.log && value.log.prior.bytes <= value.log.tail.bytes) {\n    ctx.addIssue({ code: 'custom', path: ['log', 'prior'], message: 'prior.bytes must be greater than tail.bytes' });\n  }\n});\nconst pendingSchema = z.object({ stage: z.string().regex(/^stage-[a-f0-9-]+$/), aggregate: aggregateSchema, applied: appliedSchema,\n  files: archiveFilesSchema.optional(), retention: retentionSchema.optional() }).strict();\nconst schema = z.object({ schema: z.literal(1), aggregate: aggregateSchema, applied: appliedSchema,\n  retention: retentionSchema.nullable().optional(), pending: pendingSchema.nullable() }).strict();\nconst UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;\n/**\n * Mirrors the official `defineDomain` fail-loud checks (dsh-storage-domain/src/spec.ts)\n",
   "    })\n    .transform(({ document }) => document));\nconst appliedSchema = z.record(z.string(), z.string());\nconst archiveFilesSchema = z.array(z.object({ file: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict());\nconst schema = z.object({ schema: z.literal(1), aggregate: aggregateSchema, applied: appliedSchema,\n  pending: z.object({ stage: z.string().regex(/^stage-[a-f0-9-]+$/), aggregate: aggregateSchema, applied: appliedSchema, files: archiveFilesSchema.optional() }).strict().nullable() }).strict();\nconst UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;\n/**\n * Mirrors the official `defineDomain` fail-loud checks (dsh-storage-domain/src/spec.ts)\n"],
  ["    // advances the commit token first: a token that did not move would tell a\n    // concurrent transaction that the document it read is still committed.\n    writeCommitToken(commitToken);\n    // The retention floor a reclaim committed travels with the pending record,\n    // so replaying the transaction cannot install a pruned ledger without the\n    // floor that proves what was pruned. A record written before the floor\n    // existed falls back to the committed one (itself `null` on old data).\n    const floor = current.pending.retention ?? current.retention ?? null;\n    await domain.global.set({ schema: 1, aggregate: current.pending.aggregate, applied: current.pending.applied,\n      ...(floor === null ? {} : { retention: floor }), pending: null });\n    fs.rmSync(source, { recursive: true });\n  }\n  async function createMemory(dir, initial, archiveWriteGuard = null, deferLoadArchiveWrites = false, archiveReadCache = memory?.archiveReadCache) {\n",
   "    // advances the commit token first: a token that did not move would tell a\n    // concurrent transaction that the document it read is still committed.\n    writeCommitToken(commitToken);\n    await domain.global.set({ schema: 1, aggregate: current.pending.aggregate, applied: current.pending.applied, pending: null });\n    fs.rmSync(source, { recursive: true });\n  }\n  async function createMemory(dir, initial, archiveWriteGuard = null, deferLoadArchiveWrites = false, archiveReadCache = memory?.archiveReadCache) {\n"],
  ["    // repaired file durable before a later stage shares its inode.\n    if (fs.existsSync(index) && fs.statSync(index).ino !== before) { syncFile(index); syncFile(root); }\n  }\n  async function mutate(work, applied, details = null) {\n    await installPending();\n    // The ledger has to be read after the recovery above: `installPending()`\n    // installs a committed pending record's ledger, and a snapshot taken before\n",
   "    // repaired file durable before a later stage shares its inode.\n    if (fs.existsSync(index) && fs.statSync(index).ino !== before) { syncFile(index); syncFile(root); }\n  }\n  async function mutate(work, applied) {\n    await installPending();\n    // The ledger has to be read after the recovery above: `installPending()`\n    // installs a committed pending record's ledger, and a snapshot taken before\n"],
  ["    // replaced this port's document, the value is the very object captured here,\n    // so an ordinary commit does not walk its aggregate a second time.\n    const baseline = { applied: { ...recovered }, aggregate: committed.aggregate, token: readCommitToken(commitToken) };\n    // A caller may also hand in a *decision* instead of a ledger table. Only the\n    // reclaim does, because it is the one operation that both removes markers\n    // and advances the retention floor, and both must be derived from the work\n    // it just ran. A table keeps the released merge, and the floor it commits is\n    // the committed one.\n    const committedRetention = committed.retention ?? null;\n    const stage = `stage-${randomUUID()}`;\n    const dir = stageDirectory(staging, stage);\n    // The stage is a hard-link mirror of the live tree: complete and correct\n",
   "    // replaced this port's document, the value is the very object captured here,\n    // so an ordinary commit does not walk its aggregate a second time.\n    const baseline = { applied: { ...recovered }, aggregate: committed.aggregate, token: readCommitToken(commitToken) };\n    const ledger = mergeEventLedger(recovered, applied);\n    const stage = `stage-${randomUUID()}`;\n    const dir = stageDirectory(staging, stage);\n    // The stage is a hard-link mirror of the live tree: complete and correct\n"],
  ["    // did, the stage no longer describes the committed archive and the\n    // transaction fails loudly instead of installing a mixed tree.\n    assertLiveTreeUnchanged(root, snapshot);\n    // The live root is what proves a deletion's bytes: a file the stage no\n    // longer has is removed only after its committed digest is re-read from the\n    // tree the transaction snapshotted.\n    const files = changedArchiveFiles(dir, snapshot, root);\n    const decided = typeof applied === 'function'\n      ? applied(recovered, committedRetention)\n      : { ledger: mergeEventLedger(recovered, applied), retention: committedRetention };\n    const ledger = decided.ledger;\n    const retention = decided.retention ?? null;\n    if (details) {\n      details.changed = files.filter(entry => entry.removed !== true).length;\n      details.removed = files.filter(entry => entry.removed === true).length;\n      details.stagedBytes = files.reduce((sum, entry) => entry.removed === true ? sum : sum + entry.bytes, 0);\n      details.removedBytes = files.reduce((sum, entry) => entry.removed === true ? sum + entry.bytes : sum, 0);\n    }\n    // The stage commits before the aggregate: recovery can always replay the\n    // staged files and then commit, and never recomputes an event whose\n    // marker is already durable. Files the writer did not touch are hard\n",
   "    // did, the stage no longer describes the committed archive and the\n    // transaction fails loudly instead of installing a mixed tree.\n    assertLiveTreeUnchanged(root, snapshot);\n    const files = changedArchiveFiles(dir, snapshot);\n    // The stage commits before the aggregate: recovery can always replay the\n    // staged files and then commit, and never recomputes an event whose\n    // marker is already durable. Files the writer did not touch are hard\n"],
  ["        || aggregateDigest(latest.aggregate) === aggregateDigest(baseline.aggregate));\n    if (!unchanged || !advanceCommitToken(commitToken, baseline.token)) throw new Error(E_COMMIT_OVERWRITTEN);\n    if (staged) {\n      await domain.global.set(schema.parse({ schema: 1, aggregate: latest.aggregate, applied: latest.applied,\n        pending: { stage, aggregate, applied: ledger, files, ...(retention === null ? {} : { retention }) } }));\n      await installPending();\n    } else {\n      // The document the two-write path converges to: the committed aggregate and\n",
   "        || aggregateDigest(latest.aggregate) === aggregateDigest(baseline.aggregate));\n    if (!unchanged || !advanceCommitToken(commitToken, baseline.token)) throw new Error(E_COMMIT_OVERWRITTEN);\n    if (staged) {\n      await domain.global.set(schema.parse({ schema: 1, aggregate: latest.aggregate, applied: latest.applied, pending: { stage, aggregate, applied: ledger, files } }));\n      await installPending();\n    } else {\n      // The document the two-write path converges to: the committed aggregate and\n"],
  ["      // before this write leaves the previous document and an unreferenced stage\n      // directory, which is the same state a crash before the pending record\n      // leaves today.\n      await domain.global.set(schema.parse({ schema: 1, aggregate, applied: ledger, pending: null, ...(retention === null ? {} : { retention }) }));\n      fs.rmSync(dir, { recursive: true });\n    }\n    await hydrate(current.instance.archiveReadCache);\n",
   "      // before this write leaves the previous document and an unreferenced stage\n      // directory, which is the same state a crash before the pending record\n      // leaves today.\n      await domain.global.set(schema.parse({ schema: 1, aggregate, applied: ledger, pending: null }));\n      fs.rmSync(dir, { recursive: true });\n    }\n    await hydrate(current.instance.archiveReadCache);\n"],
  ["    // per-record work. It is only trusted when its keyed digest matches the\n    // bytes on disk now, so any change to consumed history still falls back to\n    // full per-record verification below.\n    const committedDocument = domain.global.get();\n    const committedRetention = committedDocument.retention ?? null;\n    // A committed floor can outlive the rewrite it describes: the commit is the\n    // point of no return and the truncation is its replayable completion, so a\n    // crash between them must not turn into a permanent refusal. Finishing it\n    // first is also what makes the records below actually gone: their markers were\n    // pruned with the floor, so the bytes must leave before anything is planned.\n    // With a floor, a *missing* log is a refusal like any other non-continuation:\n    // the floor says the log had bytes, so its absence is an external destruction\n    // of a durable artifact, not a fresh start.\n    if (committedRetention?.log) {\n      const floorLog = config.eventBridgePath ? (() => {\n        try { return fs.statSync(config.eventBridgePath).size; } catch (error) {\n          if (error?.code !== 'ENOENT') throw error;\n          return null;\n        }\n      })() : null;\n      if (floorLog === null) {\n        const missing = new Error('E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH: a retention floor is committed but the event log is missing; restore its retained bytes or start a new data root');\n        missing.code = 'E_DOMAIN_EVENT_LOG_FLOOR_MISMATCH';\n        throw missing;\n      }\n      let completion;\n      try {\n        completion = completeEventLogTruncation({ file: config.eventBridgePath, key: config.eventBridgeKey,\n          floor: committedRetention, withAppendLock: withEventBridgeAppendLock });\n      } catch (error) {\n        // The committed truncation could not run (a live writer holds the append\n        // lock, or the file cannot be rewritten). The state is consistent and the\n        // next pass retries, but this pass cannot prove anything about the log, so\n        // it reports the real cause instead of a synthesized one.\n        const busy = new Error('E_DOMAIN_EVENT_LOG_BUSY: the committed truncation could not run; retry once the writer releases the log');\n        busy.code = 'E_DOMAIN_EVENT_LOG_BUSY';\n        busy.cause = error;\n        throw busy;\n      }\n      void completion;\n    }\n    const plan = planEventLogReplay({ file: config.eventBridgePath, key: config.eventBridgeKey, writer,\n      checkpoint: readEventLogCheckpoint(checkpointFile), applied: committedDocument.applied, retention: committedRetention });\n    if (!plan) return { applied: 0, duplicates: 0 };\n    let applied = 0, duplicates = plan.trusted ? plan.prefixRecords : 0;\n    let first = null, last = null;\n",
   "    // per-record work. It is only trusted when its keyed digest matches the\n    // bytes on disk now, so any change to consumed history still falls back to\n    // full per-record verification below.\n    const plan = planEventLogReplay({ file: config.eventBridgePath, key: config.eventBridgeKey, writer,\n      checkpoint: readEventLogCheckpoint(checkpointFile), applied: domain.global.get().applied });\n    if (!plan) return { applied: 0, duplicates: 0 };\n    let applied = 0, duplicates = plan.trusted ? plan.prefixRecords : 0;\n    let first = null, last = null;\n"],
  ["    if (refusal) throw refusal;\n    if (plan.advance) {\n      try {\n        const after = domain.global.get();\n        writeEventLogCheckpoint(checkpointFile, eventLogCheckpointDocument({ plan, writer, key: config.eventBridgeKey,\n          applied: after.applied, retention: after.retention ?? null, witnesses: { first, last } }));\n      } catch (error) {\n        // Losing the checkpoint only means the next pass re-verifies history.\n        // The warning is a log line, and a log line is a boundary: it carries\n",
   "    if (refusal) throw refusal;\n    if (plan.advance) {\n      try {\n        writeEventLogCheckpoint(checkpointFile, eventLogCheckpointDocument({ plan, writer, key: config.eventBridgeKey, applied: domain.global.get().applied, witnesses: { first, last } }));\n      } catch (error) {\n        // Losing the checkpoint only means the next pass re-verifies history.\n        // The warning is a log line, and a log line is a boundary: it carries\n"],
  ["    }\n    return { applied, duplicates };\n  }\n  /** Read the bridge log once, or report why it cannot be read. */\n  function readEventLogBytes() {\n    const file = config.eventBridgePath;\n    if (!file) return { status: 'not-configured' };\n    if (typeof config.eventBridgeKey !== 'string' || config.eventBridgeKey.length < 16) return { status: 'no-key' };\n    try { return { status: 'readable', file, bytes: fs.readFileSync(file) }; }\n    catch (error) {\n      if (error?.code === 'ENOENT') return { status: 'absent' };\n      throw error;\n    }\n  }\n  const eventBridgeWriterName = () => config.eventBridgeWriter || EVENT_BRIDGE_DEFAULT_WRITER;\n  /**\n   * The evidence the rows of one prefix carry, per experiment.\n   *\n   * It is the same projection the hydration chain reads (`readEventBridgeEvidence`\n   * via the shared index), applied to the bytes that are about to be discarded.\n   * Only experiments the prefix actually mentions are considered: a record that\n   * another experiment's rows already carry loses nothing when this prefix goes.\n   */\n  function prefixEvidence(prefix, writer) {\n    const index = createEventBridgeEvidenceIndex({ key: config.eventBridgeKey, trustedWriters: [writer] });\n    const mentioned = new Set();\n    for (const line of prefix.toString('utf8').split('\\n')) {\n      const routed = index.consume(line);\n      if (routed) mentioned.add(routed.experimentId);\n    }\n    const entries = [];\n    for (const experimentId of index.experimentIds()) {\n      if (!mentioned.has(experimentId)) continue;\n      const evidence = index.project(experimentId);\n      if (evidence) entries.push({ experimentId, evidence });\n    }\n    return entries;\n  }\n  /**\n   * Discard the absorbed prefix of the bridge log and derive the ledger/floor\n   * that must be committed with it.\n   *\n   * The order is the safety argument. Evidence leaves the log first (the\n   * externalizer writes it durably and throws to abort otherwise), then the\n   * transaction commits the pruned ledger and the floor - and only after that\n   * commit does anything truncate the log. A refused commit therefore leaves the\n   * log untouched, and a truncation that never ran is completed by the first\n   * replay from the committed floor (`completeEventLogTruncation`): the floor\n   * records both the bytes it was computed from and the bytes that stay, so the\n   * state \"committed but not yet truncated\" is provable instead of a refusal.\n   */\n  async function reclaimLog({ recovered, committedRetention, retainRecords, decision }) {\n    const source = readEventLogBytes();\n    if (source.status !== 'readable') return { status: source.status };\n    const writer = eventBridgeWriterName();\n    const key = config.eventBridgeKey;\n    const plan = planLogPrune({ buffer: source.bytes, key, writer, applied: recovered, retainRecords });\n    if (!plan) return { status: 'nothing-absorbed', bytes: source.bytes.length };\n    const evidence = prefixEvidence(source.bytes.subarray(0, plan.prefixBytes), writer);\n    let externalized = null;\n    if (evidence.length > 0) {\n      if (typeof config.externalizeEventEvidence !== 'function') {\n        throw new Error('E_DOMAIN_EVIDENCE_EXTERNALIZER_REQUIRED: the event log prefix carries promotion/measurement evidence and no durable externalizer is configured, so the prefix cannot be discarded');\n      }\n      externalized = await config.externalizeEventEvidence(evidence);\n    }\n    const ledger = { ...recovered };\n    for (const { eventId } of plan.prunable) delete ledger[eventId];\n    const previous = committedRetention ?? null;\n    const log = {\n      bytes: (previous?.log?.bytes ?? 0) + plan.prefixBytes,\n      records: (previous?.log?.records ?? 0) + plan.boundaryRecords,\n      prior: plan.prior,\n      tail: plan.tail,\n    };\n    decision.ledger = ledger;\n    decision.retention = advanceRetention(previous, { prunable: plan.prunable, log, key });\n    decision.plan = plan;\n    return {\n      status: 'discarded',\n      file: source.file,\n      bytes: source.bytes.length,\n      discardedBytes: plan.prefixBytes,\n      discardedRecords: plan.boundaryRecords,\n      retainedBytes: plan.tail.bytes,\n      prunedMarkers: plan.prunable.length,\n      evidenceEntries: evidence.length,\n      evidence: externalized,\n    };\n  }\n  /**\n   * Reclaim capacity from history that is already absorbed.\n   *\n   * Two things are reclaimed, and both are only ever removed on proof:\n   *\n   *   - Archives: the same semantic compaction `EvolutionMemory#compact()` has\n   *     always performed (terminal records retired into aggregate rows), now\n   *     expressed inside the domain transaction. The segments it no longer has\n   *     are published as deletions in the committed change list, so the live\n   *     tree loses them only after the replacement files are installed, and a\n   *     replay installs exactly the same list.\n   *   - The event log: its absorbed prefix is discarded, but only after the\n   *     evidence those rows carry has been written to its durable home, and the\n   *     markers of the discarded records are pruned only after the truncation is\n   *     durable. The floor that records both is committed with the ledger.\n   *\n   * Everything else refuses: a compaction whose archive integrity gate finds\n   * unreadable or conflicting evidence throws before any byte is discarded, and a\n   * log that changed while it was being planned is left exactly as it was.\n   */\n  async function reclaimInternal(options = {}) {\n    const dryRun = options.dryRun === true;\n    const archives = options.archives !== false;\n    const log = options.log !== false;\n    const retainRecords = options.retainRecords === undefined ? DEFAULT_LOG_RETAIN_RECORDS : options.retainRecords;\n    if (dryRun) {\n      return scope.run(token, async () => {\n        const report = { dryRun: true, archives: null, log: null };\n        if (archives) report.archives = await memory.compact({ dryRun: true });\n        if (log) {\n          const source = readEventLogBytes();\n          if (source.status !== 'readable') report.log = { status: source.status };\n          else {\n            const plan = planLogPrune({ buffer: source.bytes, key: config.eventBridgeKey, writer: eventBridgeWriterName(), applied: domain.global.get().applied, retainRecords });\n            report.log = plan\n              ? { status: 'would-discard', bytes: source.bytes.length, discardedBytes: plan.prefixBytes, discardedRecords: plan.boundaryRecords,\n                  retainedBytes: plan.tail.bytes, prunedMarkers: plan.prunable.length,\n                  evidence: prefixEvidence(source.bytes.subarray(0, plan.prefixBytes), eventBridgeWriterName()).length }\n              : { status: 'nothing-absorbed', bytes: source.bytes.length };\n          }\n        }\n        return report;\n      });\n    }\n    const report = { dryRun: false, archives: null, log: null, transaction: null };\n    const decision = { ledger: null, retention: null, coverage: null };\n    const details = {};\n    await mutate(async (instance) => {\n      if (archives) report.archives = await instance.compact();\n      if (log) report.log = await reclaimLog({ recovered: domain.global.get().applied, committedRetention: domain.global.get().retention ?? null, retainRecords, decision });\n      return null;\n    }, (recovered, committedRetention) => (decision.ledger\n      ? { ledger: decision.ledger, retention: decision.retention }\n      : { ledger: recovered, retention: committedRetention }), details);\n    report.transaction = { changedFiles: details.changed, removedSegmentFiles: details.removed,\n      stagedBytes: details.stagedBytes, removedBytes: details.removedBytes };\n    if (report.log?.status === 'discarded') {\n      // The floor is committed; now the bytes may go. This is the same call the\n      // next replay makes, so a failure here is a deferred truncation, not a\n      // lost record - it is reported and completed on the following pass.\n      let completed;\n      try {\n        completed = completeEventLogTruncation({\n          file: report.log.file,\n          key: config.eventBridgeKey,\n          floor: domain.global.get().retention ?? null,\n          withAppendLock: withEventBridgeAppendLock,\n        });\n      } catch (error) {\n        // The floor is committed, so this is a deferred truncation: the next\n        // replay finishes it. Reporting it as a failed reclaim would also poison\n        // the port's recorded failure (and `close()` with it) for a state that is\n        // already consistent.\n        completed = { status: 'deferred', error: error?.code ?? 'E_DOMAIN_EVENT_LOG_DEFERRED' };\n      }\n      report.log.truncated = completed.status;\n      report.log.truncatedBytes = completed.bytes ?? (completed.status === 'already-truncated' ? report.log.retainedBytes : 0);\n      if (completed.error) report.log.truncatedError = completed.error;\n      decision.coverage = completed.status === 'truncated' || completed.status === 'already-truncated'\n        ? planRetainedCoverage({ buffer: fs.readFileSync(report.log.file), key: config.eventBridgeKey,\n            writer: eventBridgeWriterName(), applied: domain.global.get().applied })\n        : null;\n    }\n    if (decision.coverage) {\n      // The truncation replaced every byte the previous checkpoint described, so\n      // publish the one that describes the log as it is now. It is derived state:\n      // losing it only costs the next pass a full verification, and a concurrent\n      // port that writes its own checkpoint writes an equally valid one.\n      try {\n        const file = eventLogCheckpointPath(config.presetDir);\n        const logStat = fs.statSync(report.log.file, { bigint: true });\n        writeEventLogCheckpoint(file, eventLogCheckpointDocument({\n          plan: { identity: { dev: String(logStat.dev), ino: String(logStat.ino) }, next: decision.coverage },\n          writer: eventBridgeWriterName(),\n          key: config.eventBridgeKey,\n          applied: domain.global.get().applied,\n          retention: domain.global.get().retention ?? null,\n          witnesses: { first: decision.coverage.first, last: decision.coverage.last },\n        }));\n      } catch (error) {\n        warnRedacted(ctx, 'reclaim checkpoint not written', error, 'event-log-checkpoint');\n      }\n    }\n    return report;\n  }\n\n  try {\n    domain = await ctx.storageDomain.open(evolutionDomainSpec);\n    // Creating the two roots belongs to the guarded sequence: the storage\n",
   "    }\n    return { applied, duplicates };\n  }\n  try {\n    domain = await ctx.storageDomain.open(evolutionDomainSpec);\n    // Creating the two roots belongs to the guarded sequence: the storage\n"],
  ["        // A seeded document replaces the shared one, so it advances the token\n        // for the same reason a commit does.\n        writeCommitToken(commitToken);\n        // A seed declares this root empty, so it also drops any retention floor:\n        // keeping a floor without the ledger it describes would claim pruned\n        // markers that the emptied ledger cannot prove.\n        await domain.global.set(schema.parse({ schema: 1, aggregate: { evolution: { ...seed.evolution, eventBridge: { schema: 1, applied: [] } } },\n          applied: {}, pending: null }));\n      }\n      await hydrate();\n      // Establish durability once for archives inherited from older versions\n",
   "        // A seeded document replaces the shared one, so it advances the token\n        // for the same reason a commit does.\n        writeCommitToken(commitToken);\n        await domain.global.set(schema.parse({ schema: 1, aggregate: { evolution: { ...seed.evolution, eventBridge: { schema: 1, applied: [] } } }, applied: {}, pending: null }));\n      }\n      await hydrate();\n      // Establish durability once for archives inherited from older versions\n"],
  ["  ctx.effect(() => close);\n  return Object.freeze({\n    replay: () => enqueue(replay),\n    // Explicit, owner-authorized capacity reclaim. It runs on the same queue and\n    // the same staged transaction as every other mutation, so a concurrent writer\n    // can never observe a half-reclaimed archive or a ledger without its floor.\n    // The confirmation is refused *here*, before the operation is queued: a\n    // caller error must not become the port's recorded failure, which `close()`\n    // would otherwise rethrow at shutdown.\n    reclaim: async options => {\n      if (options?.dryRun !== true && options?.confirmation !== true) {\n        throw new Error('E_DOMAIN_RECLAIM_CONFIRMATION: reclaiming retires archive history and prunes authenticated markers; an explicit confirmation: true is required');\n      }\n      return enqueue(() => reclaimInternal(options));\n    },\n    flush: () => enqueue(replay),\n    observe: dto => enqueue(() => mutate((_memory, store) => store.record(projectObservation(dto)))),\n    query: (collection = 'cycles', limit = 10) => {\n",
   "  ctx.effect(() => close);\n  return Object.freeze({\n    replay: () => enqueue(replay),\n    flush: () => enqueue(replay),\n    observe: dto => enqueue(() => mutate((_memory, store) => store.record(projectObservation(dto)))),\n    query: (collection = 'cycles', limit = 10) => {\n"],
  // <<< reclaim-round pairs <<<
  // The archive-lock classifier is a second addition after the pin: the doctor reads the
  // runtime's own rules instead of a new interpretation of the same path. It adds no line to
  // any pinned function, so removing it restores the pinned source byte for byte, and it is
  // reversed first so the lock-fencing piece below again finds the two lock helpers adjacent.
  ["/**\n" +
   " * Read-only classification of the archive lock entry, from the rules the\n" +
   " * acquiring port itself applies (the same `lockIdentity`, `readLockOwner` and\n" +
   " * `LOCK_SETTLE_MS` above), for the doctor.\n" +
   " *\n" +
   " * The doctor must not carry a second interpretation of this path. `inspectLock()`\n" +
   " * in lib/diagnostics.js reads the *promotion* directory lock, a different\n" +
   " * protocol; reading the archive lock through it disagreed with the runtime about\n" +
   " * non-regular entries and about the settle window. Nothing here mutates.\n" +
   " *\n" +
   " * `reclaimable` means the acquire would remove this entry: a named owner that is\n" +
   " * gone, or ownerless/unreadable bytes that are older than `LOCK_SETTLE_MS`. A\n" +
   " * non-regular entry (a link, a directory, a device) is never `reclaimable`,\n" +
   " * because `lockIdentity` refuses it and the acquiring port raises\n" +
   " * `E_DOMAIN_ARCHIVE_LOCK` instead of interpreting it.\n" +
   " */\n" +
   "export function inspectArchiveLock(lockPath) {\n" +
   "  const absent = { present: false, kind: 'absent', pid: null, ownerAlive: false, malformed: false, settling: false, reclaimable: false, ageMs: 0, raw: null };\n" +
   "  let stat;\n" +
   "  try { stat = fs.lstatSync(lockPath); }\n" +
   "  catch (error) {\n" +
   "    if (error?.code === 'ENOENT') return absent;\n" +
   "    // A failed lstat is not proof of absence, and it is not a lock that can be\n" +
   "    // interpreted either.\n" +
   "    return { present: true, kind: 'unknown', pid: null, ownerAlive: false, malformed: true, settling: false, reclaimable: false, ageMs: 0, raw: null, readError: error?.code || 'READ_FAILED' };\n" +
   "  }\n" +
   "  const ageMs = Math.max(0, Date.now() - stat.mtimeMs);\n" +
   "  if (stat.isSymbolicLink() || !stat.isFile()) {\n" +
   "    const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'other';\n" +
   "    return { present: true, kind, pid: null, ownerAlive: false, malformed: true, settling: false, reclaimable: false, ageMs, raw: null };\n" +
   "  }\n" +
   "  let owner;\n" +
   "  try { owner = readLockOwner(lockPath); }\n" +
   "  catch (error) {\n" +
   "    return { present: true, kind: 'unknown', pid: null, ownerAlive: false, malformed: true, settling: false, reclaimable: false, ageMs, raw: null, readError: error?.code || 'READ_FAILED' };\n" +
   "  }\n" +
   "  if (!owner) return absent;\n" +
   "  const alive = owner.pid === null ? false : ownerAlive(owner.pid);\n" +
   "  const malformed = owner.pid === null;\n" +
   "  // The runtime reclaims an ownerless entry only after the settle window; a named\n" +
   "  // owner it can prove gone is reclaimed immediately.\n" +
   "  const settling = malformed && ageMs < LOCK_SETTLE_MS;\n" +
   "  return { present: true, kind: 'file', pid: owner.pid, ownerAlive: alive, malformed, settling, reclaimable: !alive && !settling, ageMs, raw: owner.raw };\n" +
   "}\n",
   ""],
  // The doctor's offline staging repair now takes the same archive lock a port
  // takes, through one exported helper. The helper is an addition after the pin
  // and touches no line the pin wrote, so removing it restores the pinned source
  // byte for byte; every other piece below keeps the anchors it was written
  // against.
  ["\n" +
   "/**\n" +
   " * Run one bounded maintenance step under the archive lock a port takes.\n" +
   " *\n" +
   " * The doctor's offline repairs are the only caller. A staging directory may only\n" +
   " * be removed while no port can sit between staging and publication, and a plan\n" +
   " * read before this lock existed cannot answer that, so the callback re-reads and\n" +
   " * acts under the lock. The callback is not a publication of the shared document\n" +
   " * and proves no ownership of its own. The lock is released only while it is\n" +
   " * still the entry this call wrote; a path this protocol cannot interpret is\n" +
   " * never reclaimed or removed, it is reported as an error to the caller.\n" +
   " */\n" +
   "export async function withArchiveLock(lockPath, operation) {\n" +
   "  const token = await acquireArchiveLock(lockPath);\n" +
   "  try { return await operation(); }\n" +
   "  finally { releaseArchiveLock(lockPath, token); }\n" +
   "}\n",
   ""],
  ["return { instance };", "return { instance, getAggregate: () => structuredClone(aggregate) };"],
  // The port-local parsed archive handoff is independent of the older write-path
  // changes below; remove it first to preserve the byte-exact release anchor.
  ["async function createMemory(dir, initial, archiveWriteGuard = null, deferLoadArchiveWrites = false, archiveReadCache = memory?.archiveReadCache)",
   "async function createMemory(dir, initial, archiveWriteGuard = null, deferLoadArchiveWrites = false)"],
  ["archiveWriteGuard, deferLoadArchiveWrites, archiveReadCache, coalesceMeasurementMarkerPersist: archiveWriteGuard !== null });", "archiveWriteGuard, deferLoadArchiveWrites });"],
  ["async function hydrate(archiveReadCache = memory?.archiveReadCache)", "async function hydrate()"],
  ["createMemory(root, domain.global.get().aggregate, null, true, archiveReadCache)", "createMemory(root, domain.global.get().aggregate, null, true)"],
  ["await hydrate(current.instance.archiveReadCache);", "await hydrate();"],
  // The commit-shape round is independent of the older write-path changes too, and it is
  // reversed first for the same reason: it wraps two lines an older piece below is
  // anchored on (`syncStage()` and the pending publication), so removing it first hands
  // those pieces the text they were written against. Both halves are pure substitutions
  // of the same lines - the staging decision and the alternative closing write add no
  // state, no field and no call the pinned source did not already make.
  ["    writeStageManifest(dir, files);\n" +
   "    // A transaction that changed no archive file has nothing to sequence: the\n" +
   "    // pending record exists so that recovery can replay staged bytes onto the\n" +
   "    // committed tree before the aggregate that describes them is read, and its\n" +
   "    // install list is empty here. Writing that record, installing nothing and\n" +
   "    // clearing it again would replace the whole document twice and fsync a\n" +
   "    // stage no durable record names, so this transaction commits the document\n" +
   "    // it ends at in one write and drops the stage.\n" +
   "    const staged = files.length > 0;\n" +
   "    if (staged) syncStage({ directory: dir, stagingRoot: staging, files });\n",
   "    writeStageManifest(dir, files);\n" +
   "    syncStage({ directory: dir, stagingRoot: staging, files });\n"],
  ["    if (staged) {\n" +
   "      await domain.global.set(schema.parse({ schema: 1, aggregate: latest.aggregate, applied: latest.applied, pending: { stage, aggregate, applied: ledger, files } }));\n" +
   "      await installPending();\n" +
   "    } else {\n" +
   "      // The document the two-write path converges to: the committed aggregate and\n" +
   "      // ledger this transaction computed, with no pending record. `schema.parse`\n" +
   "      // still projects and validates exactly what `installPending()` wrote, and\n" +
   "      // the stage is removed where an install would have removed it. A crash\n" +
   "      // before this write leaves the previous document and an unreferenced stage\n" +
   "      // directory, which is the same state a crash before the pending record\n" +
   "      // leaves today.\n" +
   "      await domain.global.set(schema.parse({ schema: 1, aggregate, applied: ledger, pending: null }));\n" +
   "      fs.rmSync(dir, { recursive: true });\n" +
   "    }\n",
   "    await domain.global.set(schema.parse({ schema: 1, aggregate: latest.aggregate, applied: latest.applied, pending: { stage, aggregate, applied: ledger, files } }));\n" +
   "    await installPending();\n"],
  // The publication compares the committed aggregate by content, so the module imports
  // `createHash` from the same module; both directions stay a single-line substitution.
  ["import { createHash, randomBytes, randomUUID } from 'node:crypto';\n",
   "import { randomUUID } from 'node:crypto';\n"],
  // The lock-fencing round landed after every round below, so it is reversed first.
  // `assertArchiveLockHeld()` re-proves, immediately before each write it guards, that
  // the lock this attempt acquired is still the entry at the lock path: the two guarded
  // points are the install of a staged tree (a commit and `installPending()`'s recovery
  // run the same install) and the publish of the pending record, which is the commit
  // point. It adds no field to the persisted document and moves no existing line, so the
  // three pieces are pure insertions and reversing them restores the pinned source; the
  // writes they precede are untouched. They are reversed in file order: the definition,
  // then its two call sites.
  ["  return removeLockIfUnchanged(lock, token.identity, token.raw) === LOCK_REMOVED;\n" +
   "}\n" +
   "/**\n" +
   " * Prove that the lock this port acquired is still the entry at the lock path.\n" +
   " *\n" +
   " * The lock is a bare pid, so the bytes alone cannot tell two ports of one\n" +
   " * process apart; the identity (device and inode) is what pins the file object\n" +
   " * `acquireArchiveLock` created. The two guarded points are the pending record\n" +
   " * that publishes a commit and the install of staged files into the live tree\n" +
   " * (recovery runs the same install): two ports that both believe they own the\n" +
   " * archive overwrite each other there, so a port that cannot prove ownership\n" +
   " * refuses the write instead. This is a check before the write, not a lease -\n" +
   " * the lock can still be taken between the check and the syscall that follows\n" +
   " * it, which is the window a filesystem without kernel leases leaves open. The\n" +
   " * derived archive index repair and the replay checkpoint are not committed\n" +
   " * archive data and are not gated by this check.\n" +
   " */\n" +
   "function assertArchiveLockHeld(lock, token) {\n" +
   "  // Any failure to prove ownership - replaced, gone, unreadable, not a regular\n" +
   "  // file - is a refusal, never a pass.\n" +
   "  let held;\n" +
   "  try {\n" +
   "    const identity = lockIdentity(lock);\n" +
   "    held = identity.dev === token.identity.dev && identity.ino === token.identity.ino\n" +
   "      && fs.readFileSync(lock, 'utf8') === token.raw;\n" +
   "  } catch { held = false; }\n" +
   "  if (!held) throw new Error('E_DOMAIN_ARCHIVE_LOCK');\n" +
   "}\n",
   "  return removeLockIfUnchanged(lock, token.identity, token.raw) === LOCK_REMOVED;\n" +
   "}\n"],
  // `installPending()` proves ownership before it installs staged files: recovery writes
  // the shared tree in exactly the place a commit does.
  ["    if (!current.pending) return;\n" +
   "    // Recovery installs the live tree exactly where a commit does, so it proves\n" +
   "    // ownership first: a committed stage installed under a lock this port no\n" +
   "    // longer holds would write the shared tree beside the port that holds it.\n" +
   "    assertArchiveLockHeld(lock, lockToken);\n",
   "    if (!current.pending) return;\n"],
  // `mutate()` proves ownership immediately before it publishes the pending record, which
  // is the commit point. The publish line itself belongs to the entry further down.
  ["    syncStage({ directory: dir, stagingRoot: staging, files });\n" +
   "    // Publishing the pending record is the commit point: it makes this\n" +
   "    // transaction the document every later port reads and recovers, and it\n" +
   "    // replaces the aggregate the real lock owner may have just committed. The\n" +
   "    // lock is therefore re-proved immediately before it.\n" +
   "    assertArchiveLockHeld(lock, lockToken);\n",
   "    syncStage({ directory: dir, stagingRoot: staging, files });\n"],
  // The pid reader that the identity pair replaced, plus the reclaim-result
  // constants and the link-unsupported code set the guarded reclaim needs.
  ["/** What a reclaim did with the entry it inspected: removed, already changed, or\n" +
   " *  a path now held by a process this attempt cannot prove anything about. */\n" +
   "const LOCK_REMOVED = 'removed';\n" +
   "const LOCK_CHANGED = 'changed';\n" +
   "const LOCK_HELD = 'held';\n" +
   "/** Error codes that mean \"this filesystem has no hard links\", where the\n" +
   " *  non-overwriting restore falls back to an exclusive copy. */\n" +
   "const LOCK_LINK_UNSUPPORTED = new Set(['EPERM', 'EACCES', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS', 'EMLINK']);\n" +
   "function ownerAlive(pid) {\n",
   "function lockOwnerPid(lock) {\n" +
   "  let raw;\n" +
   "  try { raw = fs.readFileSync(lock, 'utf8').trim(); } catch { return undefined; }\n" +
   "  const pid = Number(raw);\n" +
   "  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;\n" +
   "}\n" +
   "function ownerAlive(pid) {\n"],
  // The lock identity, the owner read that pairs it with the bytes, the removal that
  // verifies the entry before it deletes it, the non-overwriting restore that puts a
  // replaced entry back, and the token release, all replacing `reclaimLock()`.
  // The lock-fencing round replaced `reclaimLock()` with identity-checked helpers; the
  // commit-token block below now sits between `releaseArchiveLock()` and
  // `acquireArchiveLock()`, so this piece is anchored on the `reclaimLock()` it replaces
  // instead of trailing the next function header.
  ["/** The identity of the lock entry: the device and inode pin the file object, so\n" +
   " *  a later comparison distinguishes \"the lock I inspected\" from \"a lock another\n" +
   " *  process wrote into the same path\". A link or a non-regular entry at the lock\n" +
   " *  path is never taken and never removed. */\n" +
   "function lockIdentity(lock) {\n" +
   "  const stat = fs.lstatSync(lock, { bigint: true });\n" +
   "  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('E_DOMAIN_ARCHIVE_LOCK');\n" +
   "  return { dev: String(stat.dev), ino: String(stat.ino) };\n" +
   "}\n" +
   "/**\n" +
   " * Read a lock's recorded owner together with the identity and bytes of the entry\n" +
   " * that carries it. The identity is taken before the content, so a replacement\n" +
   " * that lands in between is remembered by a pair that no single file satisfies\n" +
   " * and the reclaim below refuses to act on it. `null` means the lock is gone.\n" +
   " * `pid: null` means the content is not an owner pid (the writer was killed\n" +
   " * between create and write, or the file is not ours to read).\n" +
   " */\n" +
   "function readLockOwner(lock) {\n" +
   "  let identity;\n" +
   "  try { identity = lockIdentity(lock); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }\n" +
   "  let raw;\n" +
   "  try { raw = fs.readFileSync(lock, 'utf8'); }\n" +
   "  catch (error) {\n" +
   "    if (error?.code === 'ENOENT') return null;\n" +
   "    return { identity, raw: null, pid: null };\n" +
   "  }\n" +
   "  const pid = Number(raw.trim());\n" +
   "  return { identity, raw, pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null };\n" +
   "}\n" +
   "/**\n" +
   " * Remove the lock only while it is still the entry described by `identity` and\n" +
   " * still carries `raw` (an unreadable lock can only be pinned by its identity).\n" +
   " * The entry is renamed to a private name first, so the verification happens on\n" +
   " * a file this process owns: a mismatch means another process replaced the lock\n" +
   " * after it was inspected, and the entry is put back (without replacing whatever\n" +
   " * holds the path now) instead of deleted. Returns what happened to the entry: it\n" +
   " * is gone (`LOCK_REMOVED`), it was already replaced or released\n" +
   " * (`LOCK_CHANGED`), or the path was taken while it was isolated and the reclaim\n" +
   " * therefore failed (`LOCK_HELD`).\n" +
   " */\n" +
   "function removeLockIfUnchanged(lock, identity, raw) {\n" +
   "  // A cheap content check first: once the entry has changed, the lock stays where\n" +
   "  // the other process put it and the path is never made free.\n" +
   "  if (raw !== null) {\n" +
   "    let current;\n" +
   "    try { current = fs.readFileSync(lock, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return LOCK_CHANGED; throw error; }\n" +
   "    if (current !== raw) return LOCK_CHANGED;\n" +
   "  }\n" +
   "  const moved = `${lock}.${randomUUID()}.released`;\n" +
   "  try { fs.renameSync(lock, moved); } catch (error) { if (error?.code === 'ENOENT') return LOCK_CHANGED; throw error; }\n" +
   "  let unchanged = false;\n" +
   "  try {\n" +
   "    const stat = fs.lstatSync(moved, { bigint: true });\n" +
   "    unchanged = String(stat.dev) === identity.dev && String(stat.ino) === identity.ino\n" +
   "      && (raw === null || fs.readFileSync(moved, 'utf8') === raw);\n" +
   "  } catch { unchanged = false; }\n" +
   "  if (!unchanged) return restoreLockEntry(lock, moved);\n" +
   "  try { fs.unlinkSync(moved); } catch (error) { if (error?.code !== 'ENOENT') throw error; }\n" +
   "  return LOCK_REMOVED;\n" +
   "}\n" +
   "/**\n" +
   " * Put an isolated lock entry back without replacing whatever holds the path now.\n" +
   " *\n" +
   " * The isolation exists because check-and-remove cannot be atomic, and it makes\n" +
   " * the path free for as long as the verification lasts, so another process can\n" +
   " * acquire it before this runs. `rename` would silently replace that lock and\n" +
   " * destroy a live owner's claim, so the entry is linked into place instead:\n" +
   " * `link` fails with `EEXIST` when the path is taken, and the private copy is\n" +
   " * unlinked only once the path is provably this entry again. A filesystem without\n" +
   " * hard links falls back to an exclusive copy, which refuses the same way. When\n" +
   " * the path is taken the new owner's lock is left untouched and the isolated\n" +
   " * entry is kept under an `.orphan` name instead of being discarded, and the\n" +
   " * reclaim reports failure so the caller raises the lock error rather than\n" +
   " * retrying against a lock it cannot prove anything about.\n" +
   " */\n" +
   "function restoreLockEntry(lock, moved) {\n" +
   "  try {\n" +
   "    fs.linkSync(moved, lock);\n" +
   "  } catch (error) {\n" +
   "    if (error?.code === 'EEXIST') return orphanLockEntry(lock, moved);\n" +
   "    if (!LOCK_LINK_UNSUPPORTED.has(error?.code)) throw error;\n" +
   "    try { fs.copyFileSync(moved, lock, fs.constants.COPYFILE_EXCL); }\n" +
   "    catch (copyError) { if (copyError?.code === 'EEXIST') return orphanLockEntry(lock, moved); throw copyError; }\n" +
   "  }\n" +
   "  try { fs.unlinkSync(moved); } catch (error) { if (error?.code !== 'ENOENT') throw error; }\n" +
   "  return LOCK_CHANGED;\n" +
   "}\n" +
   "/** Keep an isolated lock entry that lost the path as an auditable orphan: the\n" +
   " *  entry is the only record of the owner whose lock this attempt removed. */\n" +
   "function orphanLockEntry(lock, moved) {\n" +
   "  const orphan = `${lock}.${randomUUID()}.orphan`;\n" +
   "  try { fs.renameSync(moved, orphan); } catch { /* it stays under its private name */ }\n" +
   "  return LOCK_HELD;\n" +
   "}\n" +
   "/** Reclaim one inspected lock entry; a path another process took meanwhile is a\n" +
   " *  failed reclaim, not a successful one, and is reported as the lock error. */\n" +
   "function reclaimArchiveLock(lock, owner) {\n" +
   "  if (removeLockIfUnchanged(lock, owner.identity, owner.raw) === LOCK_HELD) throw new Error('E_DOMAIN_ARCHIVE_LOCK');\n" +
   "}\n" +
   "/** Release exactly the lock this attempt created: both its identity and its\n" +
   " *  content are checked, so a lock another process acquired in the meantime\n" +
   " *  survives this call. */\n" +
   "function releaseArchiveLock(lock, token) {\n" +
   "  if (!token) return false;\n" +
   "  return removeLockIfUnchanged(lock, token.identity, token.raw) === LOCK_REMOVED;\n" +
   "}\n",
   "function reclaimLock(lock) {\n" +
   "  try { fs.unlinkSync(lock); } catch (error) { if (error?.code !== 'ENOENT') throw error; }\n" +
   "}\n"],
  // The commit-token round added one contiguous block between the lock helpers and
  // `acquireArchiveLock()`: the deterministic serialization of a validated aggregate, its
  // digest, the ledger comparison, the refusal message, and the durable commit token the
  // publication advances (read, atomic replace, and the compare-then-advance step). It
  // inserts no line into any existing function - `acquireArchiveLock()` below is the anchor
  // in both directions - so reversing it restores the pinned source exactly.
  ["/**\n" +
   " * Deterministic serialization of a schema-validated aggregate.\n" +
   " *\n" +
   " * `JSON.stringify` keeps the key order of whatever wrote the document last, so\n" +
   " * two documents with the same content but a different key order would hash\n" +
   " * differently. This walk sorts every object's keys, so the digest below depends\n" +
   " * on content alone. Values are already JSON projections (`aggregateSchema`\n" +
   " * normalizes through `JSON.parse(JSON.stringify(...))`), so no `undefined`,\n" +
   " * `NaN` or cyclic value can reach it.\n" +
   " */\n" +
   "function stableJson(value) {\n" +
   "  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;\n" +
   "  if (value && typeof value === 'object') {\n" +
   "    const keys = Object.keys(value).sort();\n" +
   "    return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;\n" +
   "  }\n" +
   "  return JSON.stringify(value) ?? 'null';\n" +
   "}\n" +
   "/** Content digest of one aggregate: the transaction keeps this instead of a\n" +
   " *  second copy of the aggregate it started from. */\n" +
   "const aggregateDigest = aggregate => createHash('sha256').update(stableJson(aggregate)).digest('hex');\n" +
   "/** Key-by-key equality of two validated event ledgers (string MACs). */\n" +
   "const sameEventLedger = (left, right) => {\n" +
   "  const keys = Object.keys(left);\n" +
   "  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key]);\n" +
   "};\n" +
   "/** The refusal a publication raises when the document it was computed from is\n" +
   " *  no longer the committed one. Same code as the lock refusal - the caller's\n" +
   " *  remedy is the same (do not retry against state it did not read) - with a\n" +
   " *  message that names the actual cause. */\n" +
   "const E_COMMIT_OVERWRITTEN = 'E_DOMAIN_ARCHIVE_LOCK: the shared domain document has been changed by another commit since this transaction started, so its pending record was not published';\n" +
   "/**\n" +
   " * The durable commit token: one small file beside the archive lock that every\n" +
   " * write of the shared domain document advances.\n" +
   " *\n" +
   " * It is not a second coordination mechanism; it is the only durable evidence a\n" +
   " * commit leaves behind. The official domain layer keeps the document this port\n" +
   " * read in memory and updates it from this port's own writes only (`global.get()`\n" +
   " * returns the live value, it never re-reads the medium), so a comparison of the\n" +
   " * in-memory document against the transaction's baseline cannot see a commit\n" +
   " * another port published - and the medium (a whole-document replace) offers no\n" +
   " * compare-and-swap. Comparing this token is therefore what separates \"the\n" +
   " * document this transaction was computed from\" from \"the document another port\n" +
   " * published meanwhile\".\n" +
   " *\n" +
   " * The token carries no data and is never interpreted: an absent or empty file\n" +
   " * reads as `null`, and a crash - or a write that fails - may leave it advanced\n" +
   " * without a commit, which costs the next transaction one spurious refusal (it\n" +
   " * reads whatever it finds as its baseline). It is deliberately not fsynced - a\n" +
   " * crash ends every transaction, so only visibility between live ports matters -\n" +
   " * but it is replaced atomically, so no reader sees a torn or empty token.\n" +
   " */\n" +
   "const COMMIT_TOKEN_NAME = 'domain-commit.token';\n" +
   "/** Entropy for the token value and its private temporary name. Deliberately\n" +
   " *  not `crypto.randomUUID()`: the differential harness stubs that function with\n" +
   " *  a deterministic sequence so record ids persist reproducibly, and a token\n" +
   " *  drawn from it would consume ids from the same sequence and shift every later\n" +
   " *  id. The token stays opaque and is only ever compared for equality, so any\n" +
   " *  independent 128-bit random value is enough - but it must differ per commit,\n" +
   " *  because equal tokens are how a port detects that nobody else committed. */\n" +
   "const commitTokenEntropy = () => randomBytes(16).toString('hex');\n" +
   "function readCommitToken(file) {\n" +
   "  try { return fs.readFileSync(file, 'utf8').trim() || null; }\n" +
   "  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }\n" +
   "}\n" +
   "function writeCommitToken(file) {\n" +
   "  const temporary = `${file}.${commitTokenEntropy()}.tmp`;\n" +
   "  fs.writeFileSync(temporary, `${commitTokenEntropy()}\\n`, { mode: 0o600 });\n" +
   "  try { fs.renameSync(temporary, file); }\n" +
   "  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }\n" +
   "}\n" +
   "/** Advance the token only while it still carries `expected`; `false` means\n" +
   " *  another commit advanced it first and this transaction must not publish. The\n" +
   " *  read and the replace are adjacent synchronous steps, so no other port of this\n" +
   " *  process can interleave between them. */\n" +
   "function advanceCommitToken(file, expected) {\n" +
   "  if (readCommitToken(file) !== expected) return false;\n" +
   "  writeCommitToken(file);\n" +
   "  return true;\n" +
   "}\n" +
   "async function acquireArchiveLock(lock) {\n",
   "async function acquireArchiveLock(lock) {\n"],
  // `acquireArchiveLock()` returns the token it wrote (content and identity) and
  // reclaims only the entry its decision was made about.
  ["  const raw = String(process.pid);\n" +
   "  for (;;) {\n" +
   "    // A lock whose bytes never arrived names no owner this process wrote, but\n" +
   "    // `readLockOwner` can only fall back to \"no named owner\" for content that\n" +
   "    // does not parse as a pid: a truncated pid (`\"1\"` of `\"1234\"`) reads as a\n" +
   "    // different, possibly live, pid and would refuse the archive for good. A\n" +
   "    // failed acquisition also returns no token, so no lock anyone holds can be\n" +
   "    // lost by dropping the entry this attempt created. `EEXIST` proves nothing\n" +
   "    // was created and never reaches the cleanup below.\n" +
   "    //\n" +
   "    // The removal is identity-fenced rather than by path: an empty lock is\n" +
   "    // reclaimable after `LOCK_SETTLE_MS`, so a port that stalled between the\n" +
   "    // exclusive open and the failed write can find another port's lock at this\n" +
   "    // path by the time it cleans up. `fstat` pins the inode this call created\n" +
   "    // before the write begins, and `removeLockIfUnchanged` puts back an entry\n" +
   "    // that is not it. Removal is best effort: a cleanup failure must not replace\n" +
   "    // the storage error the caller has to act on.\n" +
   "    let identity = null;\n" +
   "    try {\n" +
   "      const descriptor = fs.openSync(lock, 'wx', 0o600);\n" +
   "      try {\n" +
   "        const stat = fs.fstatSync(descriptor, { bigint: true });\n" +
   "        identity = { dev: String(stat.dev), ino: String(stat.ino) };\n" +
   "      } catch (error) {\n" +
   "        try { fs.closeSync(descriptor); } catch {}\n" +
   "        throw error;\n" +
   "      }\n" +
   "      try {\n" +
   "        fs.writeFileSync(descriptor, raw);\n" +
   "      } catch (error) {\n" +
   "        // The failed write is why the lock is unusable, so it stays the error\n" +
   "        // the caller sees even if closing the descriptor also fails.\n" +
   "        try { fs.closeSync(descriptor); } catch {}\n" +
   "        throw error;\n" +
   "      }\n" +
   "      fs.closeSync(descriptor);\n" +
   "      // The token carries the inode `fstat` read from this call's own descriptor,\n" +
   "      // not the one the path names now. An empty lock is reclaimable after\n" +
   "      // `LOCK_SETTLE_MS`, so a port that stalls between the open and the write\n" +
   "      // writes its pid into an entry another port has already renamed out of the\n" +
   "      // way: the bytes land on a detached inode that no path reaches, and an\n" +
   "      // identity read from the path would hand that port the new owner's inode as\n" +
   "      // its own token - two ports, identical pid bytes, both passing the\n" +
   "      // ownership fence. With this identity the stalled port cannot prove it owns\n" +
   "      // the path and refuses the write (`E_DOMAIN_ARCHIVE_LOCK`) instead of\n" +
   "      // overwriting a live owner.\n" +
   "      return { raw, identity };\n" +
   "    } catch (error) {\n" +
   "      if (identity) { try { removeLockIfUnchanged(lock, identity, null); } catch {} }\n" +
   "      if (error?.code !== 'EEXIST') throw error;\n" +
   "      const owner = readLockOwner(lock);\n" +
   "      if (!owner) continue;\n" +
   "      if (owner.pid === null) {\n" +
   "        let ageMs = 0;\n" +
   "        try { ageMs = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }\n" +
   "        // Reclaim only the entry this decision was made about; a lock that was\n" +
   "        // replaced in the meantime stays where another process put it.\n" +
   "        if (ageMs >= LOCK_SETTLE_MS) { reclaimArchiveLock(lock, owner); continue; }\n" +
   "        if (Date.now() >= deadline) throw new Error('E_DOMAIN_ARCHIVE_LOCK');\n" +
   "        await new Promise(resolve => setTimeout(resolve, 100));\n" +
   "        continue;\n" +
   "      }\n" +
   "      if (owner.pid === process.pid || ownerAlive(owner.pid)) throw new Error('E_DOMAIN_ARCHIVE_LOCK');\n" +
   "      reclaimArchiveLock(lock, owner);\n" ,
   "  for (;;) {\n" +
   "    try {\n" +
   "      fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });\n" +
   "      return;\n" +
   "    } catch (error) {\n" +
   "      if (error?.code !== 'EEXIST') throw error;\n" +
   "      const pid = lockOwnerPid(lock);\n" +
   "      if (pid === null || pid === undefined) {\n" +
   "        let ageMs = 0;\n" +
   "        try { ageMs = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }\n" +
   "        if (ageMs >= LOCK_SETTLE_MS) { reclaimLock(lock); continue; }\n" +
   "        if (Date.now() >= deadline) throw new Error('E_DOMAIN_ARCHIVE_LOCK');\n" +
   "        await new Promise(resolve => setTimeout(resolve, 100));\n" +
   "        continue;\n" +
   "      }\n" +
   "      if (pid === process.pid || ownerAlive(pid)) throw new Error('E_DOMAIN_ARCHIVE_LOCK');\n" +
   "      reclaimLock(lock);\n"],
  // The port resolves the durable commit token beside the archive lock. The declaration is
  // an insertion between two lines that stay in place, so reversing it drops only the one
  // line and leaves both neighbours as the pin wrote them.
  ["  const lock = path.join(config.presetDir, 'domain-archive.lock');\n" +
   "  const commitToken = path.join(config.presetDir, COMMIT_TOKEN_NAME);\n",
   "  const lock = path.join(config.presetDir, 'domain-archive.lock');\n"],
  // Opening the storage medium and creating the two roots moved into the guarded
  // sequence: a failure before it used to leave the domain open and the lock held.
  // The lower half of that move is registered further down, at the `try` it belongs to.
  ["  const lockToken = await acquireArchiveLock(lock);\n" +
   "  let domain;\n" +
   "  const root = path.join(config.presetDir, 'dockyard');\n" +
   "  const staging = path.join(config.presetDir, 'domain-staging');\n" +
   "  const scope = new AsyncLocalStorage();\n",
   "  await acquireArchiveLock(lock);\n" +
   "  let domain;\n" +
   "  try { domain = await ctx.storageDomain.open(evolutionDomainSpec); }\n" +
   "  catch (error) { fs.unlinkSync(lock); throw error; }\n" +
   "  const root = path.join(config.presetDir, 'dockyard');\n" +
   "  const staging = path.join(config.presetDir, 'domain-staging');\n" +
   "  fs.mkdirSync(root, { recursive: true, mode: 0o700 });\n" +
   "  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });\n" +
   "  const scope = new AsyncLocalStorage();\n"],
  // `createMemory()` takes the deferred-write flag.
  ["  async function createMemory(dir, initial, archiveWriteGuard = null, deferLoadArchiveWrites = false) {\n",
   "  async function createMemory(dir, initial, archiveWriteGuard = null) {\n"],
  // Hands it to the memory instance it builds.
  ["    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, archiveWriteGuard, deferLoadArchiveWrites });\n",
   "    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, archiveWriteGuard });\n"],
  // `hydrate()` loads the live tree without writing to it: a load-time eviction would
  // append to a live archive file outside any staged transaction.
  ["    // The live tree is loaded without writing to it: a load-time eviction would\n" +
   "    // append to a live archive file outside any staged transaction, and a crash\n" +
   "    // there leaves a fragment no later append can repair. Over-limit records stay\n" +
   "    // in this instance's hot projection and the next mutation archives them\n" +
   "    // inside its own transaction, which is where archive writes belong.\n" +
   "    const current = await createMemory(root, domain.global.get().aggregate, null, true);\n",
   "    const current = await createMemory(root, domain.global.get().aggregate);\n"],
  // `mutate()` reads the ledger after `installPending()` has recovered one, and merges a
  // caller's markers onto it instead of writing the pre-recovery snapshot back out.
  // `mutate()` reads the ledger after `installPending()` has recovered one, merges a
  // caller's markers onto it instead of writing the pre-recovery snapshot back out, and
  // captures the committed state the transaction was computed from: the ledger, the
  // aggregate object and the durable commit token. The whole head is one block in front of
  // the `stage` line, so reversing it drops the snapshot and restores the pinned signature
  // and default in the same step.
  ["  async function mutate(work, applied) {\n" +
   "    await installPending();\n" +
   "    // The ledger has to be read after the recovery above: `installPending()`\n" +
   "    // installs a committed pending record's ledger, and a snapshot taken before\n" +
   "    // it would write the recovered markers straight back out of the record, so\n" +
   "    // the next replay would apply events whose marker it had just lost. A\n" +
   "    // caller that passes its own ledger (`replay()` adds the event it just\n" +
   "    // verified) is merged onto the recovered one: recovery only ever installs\n" +
   "    // committed markers, and the caller's set is the newer of the two.\n" +
   "    const committed = domain.global.get();\n" +
   "    const recovered = committed.applied;\n" +
   "    // The publication below replaces the whole shared document, so the\n" +
   "    // transaction remembers the committed state it was computed from: the ledger\n" +
   "    // it merges onto, the aggregate it started from, and the durable commit\n" +
   "    // token. The publication refuses to publish when any of the three changed by\n" +
   "    // then. The aggregate is compared by value through the deterministic digest\n" +
   "    // below, but an unchanged reference settles it without hashing: while nothing\n" +
   "    // replaced this port's document, the value is the very object captured here,\n" +
   "    // so an ordinary commit does not walk its aggregate a second time.\n" +
   "    const baseline = { applied: { ...recovered }, aggregate: committed.aggregate, token: readCommitToken(commitToken) };\n" +
   "    const ledger = mergeEventLedger(recovered, applied);\n",
   "  async function mutate(work, applied = domain.global.get().applied) {\n" +
   "    await installPending();\n"],

  // The pending record carries that recovered ledger.
  // The publication refuses to publish when the document it was computed from is no longer
  // the committed one: the fence proves which entry the lock path holds, the document this
  // port knows and the durable commit token say whether another commit landed meanwhile,
  // and the residual window (check and replace are still two steps) is stated in the block
  // itself. The final `set` reads the compared `latest` document instead of calling
  // `domain.global.get()` twice; reversing the block restores that single line exactly.
  ["    // The fence proves which entry the lock path holds; it cannot prove that the\n" +
   "    // document this transaction read is still the committed one, because the\n" +
   "    // check and the write are not one step. Two compares therefore guard the\n" +
   "    // publication: the document this port knows (a same-process writer sharing\n" +
   "    // this handle shows up here), and the durable commit token that every write\n" +
   "    // of that document advances (the only cross-port evidence available - see\n" +
   "    // COMMIT_TOKEN_NAME). Either one failing publishes nothing; the stage stays\n" +
   "    // on disk as the record of the refused transaction.\n" +
   "    //\n" +
   "    // Residual boundary, stated exactly: the compare and the write are still two\n" +
   "    // steps. A commit that lands after the token was advanced and before the\n" +
   "    // medium's atomic replace completes is still overwritten by this write, and\n" +
   "    // this port cannot detect it. That window is one in-flight backend write\n" +
   "    // instead of the whole transaction (stage mirror, work and fsyncs), and\n" +
   "    // closing it entirely needs a compare-and-swap from the medium itself: the\n" +
   "    // official domain handle offers `get`/`set` over the document this process\n" +
   "    // loaded, and the JSON backend replaces the whole unit in one write, so no\n" +
   "    // such primitive exists here. Re-reading the medium by reopening the domain\n" +
   "    // would drop this port's domain handle, which the port's own lifecycle pins.\n" +
   "    const latest = domain.global.get();\n" +
   "    const unchanged = latest.pending === null\n" +
   "      && sameEventLedger(latest.applied, baseline.applied)\n" +
   "      && (latest.aggregate === baseline.aggregate\n" +
   "        || aggregateDigest(latest.aggregate) === aggregateDigest(baseline.aggregate));\n" +
   "    if (!unchanged || !advanceCommitToken(commitToken, baseline.token)) throw new Error(E_COMMIT_OVERWRITTEN);\n" +
   "    await domain.global.set(schema.parse({ schema: 1, aggregate: latest.aggregate, applied: latest.applied, pending: { stage, aggregate, applied: ledger, files } }));\n",
   "    await domain.global.set(schema.parse({ schema: 1, aggregate: domain.global.get().aggregate, applied: domain.global.get().applied, pending: { stage, aggregate, applied, files } }));\n"],

  // The guarded sequence itself: the medium is open before the roots are created, and a
  // failure here is now inside the `catch` below.
  // `try {` alone is not unique (`acquireArchiveLock()` and `restoreLockEntry()`
  // open one too), so the piece carries the `scope.run` line that follows the moved
  // block on both sides: that line is the same in the pinned file and in the
  // working tree, and it pins which `try` this piece is about.
  ["  try {\n" +
   "    domain = await ctx.storageDomain.open(evolutionDomainSpec);\n" +
   "    // Creating the two roots belongs to the guarded sequence: the storage\n" +
   "    // medium is already open here, so a failure at this point used to leave the\n" +
   "    // domain open and the lock held, and a retry in the same process met its own\n" +
   "    // pid and refused itself.\n" +
   "    fs.mkdirSync(root, { recursive: true, mode: 0o700 });\n" +
   "    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });\n" +
   "    await scope.run(token, async () => {\n",
   "  try {\n" +
   "    await scope.run(token, async () => {\n"],
  // A seeded document replaces the shared one, so the seed advances the commit token for the
  // same reason a commit does; the write is inserted immediately before the `set` it guards.
  ["        // A seeded document replaces the shared one, so it advances the token\n" +
   "        // for the same reason a commit does.\n" +
   "        writeCommitToken(commitToken);\n" +
   "        await domain.global.set(schema.parse({ schema: 1, aggregate: { evolution: { ...seed.evolution, eventBridge: { schema: 1, applied: [] } } }, applied: {}, pending: null }));\n",
   "        await domain.global.set(schema.parse({ schema: 1, aggregate: { evolution: { ...seed.evolution, eventBridge: { schema: 1, applied: [] } } }, applied: {}, pending: null }));\n"],
  // A failed attempt closes what it opened and releases only the lock it wrote; a
  // successful close releases the same token. A close that fails keeps the lock
  // and is reported beside the initialization error instead of replacing it, so
  // the pinned single-line `catch` still reconstructs byte for byte.
  ["  } catch (error) {\n" +
   "    // Close what this attempt opened and release only the lock it wrote, so the\n" +
   "    // failed attempt leaves nothing behind that a retry would trip over.\n" +
   "    //\n" +
   "    // A close that fails is the one case where the lock stays, and the failure\n" +
   "    // is reported beside the error that caused it, never instead of it. The\n" +
   "    // release is provably safe only after the medium confirmed it drained: a\n" +
   "    // rejected `Domain.close()` says the medium did not release the unit, and\n" +
   "    // this port then cannot prove it stopped writing the pending record that\n" +
   "    // recovery of this archive reads. The lock is a bare pid, so it is reclaimed\n" +
   "    // once this process is gone; keeping it here refuses a second port for the\n" +
   "    // rest of this process instead of admitting one beside an unproven writer.\n" +
   "    // That costs no recovery path: the domain handle a failed close leaves open\n" +
   "    // keeps its name in the facility, so a same-process retry is refused there\n" +
   "    // anyway.\n" +
   "    let closed = true;\n" +
   "    try { await domain?.close(); } catch (closeError) {\n" +
   "      closed = false;\n" +
   "      // Reported through the one redacted-warning entry point, which contains a\n" +
   "      // logger that throws and one that rejects: a diagnostic about the failed\n" +
   "      // close must never become the error this call throws, and must never leave\n" +
   "      // an unhandled rejection behind.\n" +
   "      warnRedacted(ctx, 'failed initialization kept the archive lock: the storage medium did not confirm its close', closeError, 'domain-close-cleanup');\n" +
   "    }\n" +
   "    if (closed) {\n" +
   "      // The release itself is cleanup too, so a throw here is reported the same\n" +
   "      // way rather than replacing the initialization error.\n" +
   "      try { releaseArchiveLock(lock, lockToken); } catch (releaseError) {\n" +
   "        warnRedacted(ctx, 'failed initialization could not release the archive lock', releaseError, 'lock-release-cleanup');\n" +
   "      }\n" +
   "    }\n" +
   "    throw error;\n" +
   "  }\n" +
   "  const close = () => {\n" +
   "    closing = true;\n" +
   "    // The close runs before the release, never in a `finally`: a rejected\n" +
   "    // `Domain.close()` leaves the medium unproven, so the lock is kept for the\n" +
   "    // reason the failed initialization above keeps it - no second port may open\n" +
   "    // this archive while this process cannot prove it stopped writing it. The\n" +
   "    // lock is a bare pid, so a later process reclaims it once this one is gone.\n" +
   "    return disposal ??= (async () => { await chain; await domain.close(); releaseArchiveLock(lock, lockToken); if (failure) throw failure; })();\n",
   "  } catch (error) { await domain.close(); fs.unlinkSync(lock); throw error; }\n" +
   "  const close = () => {\n" +
   "    closing = true;\n" +
   "    return disposal ??= (async () => { await chain; await domain.close(); fs.unlinkSync(lock); if (failure) throw failure; })();\n"],
  // The redacted-warning entry point moved to `registration.js` after the anchor
  // so the init and flush cleanup paths share it. The port imports it instead of
  // calling the logger itself, which is an addition after the pin and touches no
  // line the pin wrote, so removing the import restores the pinned source.
  ["import { warnRedacted } from './registration.js';\n", ""],
  ["import { EvolutionMemory, EvolutionObservationStore, EvolutionEvaluator } from './dockyard-domain/index.js';\n" +
   "import { collectKnowledgeExperience } from './experience-recall.js';\n",
   "import { EvolutionMemory, EvolutionObservationStore, EvolutionEvaluator } from './dockyard-domain/index.js';\n"],
  ["    // Evaluator is deliberately advisory, never production authority.\n" +
   "    evaluate: evidence => evaluator.evaluate(evidence),\n" +
   "    // On-demand, bounded read of the canonical knowledge rows this store already\n" +
   "    // owns. It is model-free and only called by an explicit owner-triggered\n" +
   "    // action; a failure here is reported to the caller, never cached as\n" +
   "    // \"no history\".\n" +
   "    recall: (input = {}, options = {}) => {\n" +
   "      if (closing) throw new Error('E_DOMAIN_CLOSED');\n" +
   "      // The collector below projects every field it keeps into its own bounded\n" +
   "      // record and never returns or writes an input row, so the read-only view\n" +
   "      // is enough: copying the rows outside its `maxConsidered` window is the\n" +
   "      // whole cost of the detached history read at this size.\n" +
   "      return collectKnowledgeExperience(memory.historyView('knowledge'), input, options);\n" +
   "    },\n" +
   "    close,\n",
   "    // Evaluator is deliberately advisory, never production authority.\n" +
   "    evaluate: evidence => evaluator.evaluate(evidence), close,\n"],
  ["    // The store is not read afterwards, and neither is the projection its\n" +
   "    // `load()` would return, so the load is asked for without it. What\n" +
   "    // `hydrate()` does need from the load is its cold-history read:\n" +
   "    // `memory.hasColdHistory` derives `Number(count)` from every\n" +
   "    // `coldArchives` entry and therefore rejects a durable aggregate whose\n" +
   "    // entry cannot be coerced. Removing this call silently accepted the first\n" +
   "    // commit after such a state was written; keeping it preserves the loud\n" +
   "    // failure the released implementation has, with or without the projection.\n" +
   "    observations = new EvolutionObservationStore({ memory });\n" +
   "    await observations.load({ snapshot: false });\n",
   "    observations = new EvolutionObservationStore({ memory });\n" +
   "    await observations.load();\n"],
  ["    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, archiveWriteGuard });\n" +
   "    // The load's own work is required (state restore, archive index\n" +
   "    // reconciliation, eviction and archival); the hot projection it would\n" +
   "    // return is not: no caller of this factory reads it.\n" +
   "    await instance.load({ snapshot: false });\n",
   "    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, archiveWriteGuard });\n" +
   "    await instance.load();\n"],
  // Closing a committed record replaces the shared document, so `installPending()`
  // advances the commit token immediately before the `set` it guards: a token that did not
  // move would tell a concurrent transaction that the document it read is still committed.
  // The line is an insertion between the existing comment and the `set`, both unchanged.
  ["    // `current` is the output of `schema.parse` above, so `pending.aggregate`\n" +
   "    // and `pending.applied` are already validated projections of this exact\n" +
   "    // durable document; re-parsing them with the same schema can only\n" +
   "    // reproduce them. The two remaining fields are the literals below, which\n" +
   "    // are fixed valid values, so the closing document is provably accepted by\n" +
   "    // `schema` one step earlier and needs no second walk. The full validation\n" +
   "    // still happens before any staged file is installed, which is the boundary\n" +
   "    // that must not move.\n" +
   "    // Installing a committed record replaces the shared document, so it\n" +
   "    // advances the commit token first: a token that did not move would tell a\n" +
   "    // concurrent transaction that the document it read is still committed.\n" +
   "    writeCommitToken(commitToken);\n" +
   "    await domain.global.set({ schema: 1, aggregate: current.pending.aggregate, applied: current.pending.applied, pending: null });\n",
   "    await domain.global.set(schema.parse({ schema: 1, aggregate: current.pending.aggregate, applied: current.pending.applied, pending: null }));\n"],

  // The transaction-store check is a named function so a regression can call it;
  // the pinned artifact had no such check at this position.
  ["const safeIdentifier = value => typeof value === 'string' && /^[a-zA-Z0-9_:./-]{1,160}$/.test(value) ? value : null;\n" +
      "/**\n" +
      " * The check a transaction's working store still performs on every save.\n" +
      " *\n" +
      " * It used to be the preprocess of `aggregateSchema.parse(payload)`, which built\n" +
      " * the whole projection and then dropped it (see `createMemory`). This runs the\n" +
      " * same three steps in the same order and discards what they produce, so a save\n" +
      " * throws exactly where it threw: `JSON.stringify`; the `JSON.parse` of its output,\n" +
      " * which throws only when the stringify returned `undefined`; and the recursive\n" +
      " * own-`__proto__` copy, which runs only when the serialized text carries that\n" +
      " * literal, and would overflow on a document nested deeply enough. The parse is the\n" +
      " * step skipped on the common path, and it is the one that builds the deep copy no\n" +
      " * reader wants; the substring search costs what that preprocess already paid for\n" +
      " * the same decision.\n" +
      " *\n" +
      " * What is no longer reproduced is the schema's *verdict* on the projection, which\n" +
      " * is fixed for the payload this updater produces (see `createMemory`). The check is\n" +
      " * kept as a named function because the throw is a boundary - a save whose payload\n" +
      " * JSON cannot represent aborts the transaction before anything is published - and\n" +
      " * because `transaction-save-validation.test.js` pins it differentially against\n" +
      " * `aggregateSchema`.\n" +
      " */\n" +
      "export function assertTransactionSave(payload) {\n" +
      "  const text = JSON.stringify(payload);\n" +
      "  // `JSON.parse(undefined)` is the error the previous call reached through the\n" +
      "  // same expression; every other unrepresentable value already threw above.\n" +
      "  if (text === undefined) JSON.parse(text);\n" +
      "  else if (text.includes(`\"${PROTO_KEY}\"`)) withoutOwnProtoKeys(JSON.parse(text));\n" +
      "}\n" +
      "export function projectObservation(input = {}) {",
   "const safeIdentifier = value => typeof value === 'string' && /^[a-zA-Z0-9_:./-]{1,160}$/.test(value) ? value : null;\n" +
   "export function projectObservation(input = {}) {"],
  // The transaction's working store no longer keeps the projection it built for
  // every save. Its value was never read (the commit publishes
  // `instance.snapshot()`, and the store's `load()` is only reached by
  // `reconcile()`/`verifyConsistency()`, which no port path calls), and the
  // call's exception behaviour is `JSON.stringify`'s, kept verbatim as
  // `assertTransactionSave()`. The released shape is the projection this
  // store held.
  ["    // `inlineSerialization` is honest here: `update` captures the bytes of the\n" +
      "    // payload it is handed with the synchronous `JSON.stringify` below, before\n" +
      "    // it returns, so the caller's live shallow view cannot change what is\n" +
      "    // checked. It keeps no snapshot of those bytes, and no reader of this store\n" +
      "    // wants one (see below).\n" +
      "    //\n" +
      "    // What that check does not do any more is keep the projection it used to\n" +
      "    // build and store. Two things were true of `aggregateSchema.parse(payload)`\n" +
      "    // at this call site, and only the second one is observable:\n" +
      "    //\n" +
      "    // - The value it returned was never read. The only commit path is\n" +
      "    //   `mutate()`, which publishes the snapshot it takes after `work()`\n" +
      "    //   returns; the next updater keeps only `evolution`, which it replaces\n" +
      "    //   wholesale; and the store's own `load()` has exactly two callers -\n" +
      "    //   `reconcile()` and `verifyConsistency()` - neither of which any port path\n" +
      "    //   reaches (`createMemory` itself loads the instance before a record\n" +
      "    //   exists). So the projection was built and dropped once per save, and a\n" +
      "    //   transaction saves once per appended record plus once for the bridge\n" +
      "    //   marker (`measurement-completed` 2, a rejected/failure pair 3,\n" +
      "    //   `canary-passed` 5-6): a burst projected the whole document once per save\n" +
      "    //   - 2 to 6 times per record, growing with the records the burst has\n" +
      "    //   already appended - and kept none of those projections.\n" +
      "    //\n" +
      "    // - Its exception behaviour is reproduced step for step. The preprocess\n" +
      "    //   (`toJsonProjection`) has three steps that can throw - the stringify, the\n" +
      "    //   parse of its output, and the recursive own-`__proto__` copy - and\n" +
      "    //   `assertTransactionSave` runs the same three in the same order, so a save\n" +
      "    //   still throws exactly where it threw (including the `SyntaxError` of\n" +
      "    //   parsing an `undefined` stringify and the `RangeError` of a copy that\n" +
      "    //   overflows). Only the parse on the common path is skipped, and that is the\n" +
      "    //   step that builds the deep copy nothing reads.\n" +
      "    //\n" +
      "    //   What is not reproduced is the schema's verdict on that projection, and it\n" +
      "    //   is fixed for this payload: its only own top-level key is `evolution`\n" +
      "    //   (every state this store holds is either the initial committed aggregate or\n" +
      "    //   a payload of the same shape, and the durable schema admits nothing else),\n" +
      "    //   and the only field the schema inspects inside it is an integer\n" +
      "    //   `schema >= 4`, which the durable document this port loads guarantees\n" +
      "    //   (`memory.js`'s `schema: Math.max(4, Number(...) || ...)` keeps it at every\n" +
      "    //   load and reconcile; the looser values a direct `restore()` could inject\n" +
      "    //   are outside this store's reach, because no port path calls it). Both\n" +
      "    //   events the port feeds this store are JSON-projected before they reach it\n" +
      "    //   (`projectExecutionEvent`, `safeRecord`, `projectObservation`), so a payload\n" +
      "    //   the verdict could reject is not reachable from here either.\n" +
      "    //\n" +
      "    // Keeping the stringify therefore keeps the only observable effect of the\n" +
      "    // removed call - the throw - on the exact same value, and the durable\n" +
      "    // document is still validated in full by the publication's `schema.parse`.\n" +
      "    const stateStore = { filePath: path.join(dir, 'state.json'), inlineSerialization: true, load: async () => aggregate,\n" +
      "      // `load` hands out the aggregate this factory already cloned from\n" +
      "      // `initial` above; it used to clone it a second time. The only reader of\n" +
      "      // that value is the instance created below, through exactly one\n" +
      "      // `EvolutionMemory.load()` (`loaded` guards any later call), which spreads\n" +
      "      // it into its own state and keeps the collection arrays - it keeps neither\n" +
      "      // the store's object nor a copy of it. The store's own later reader is the\n" +
      "      // `update` spread base below, and that spread replaces the only field the\n" +
      "      // aggregate carries (`evolution`, the one key `aggregateSchema` admits)\n" +
      "      // with the payload before the result is kept, so no reader ever observes\n" +
      "      // the second copy. This is the same shallow-view stance\n" +
      "      // `inlineSerialization: true` already takes for the payload `update` is\n" +
      "      // handed: neither direction keeps a snapshot of values no reader wants.\n" +
      "      // The eager `structuredClone(initial)` above stays, because it is what\n" +
      "      // detaches this transaction from the committed document (and refuses a\n" +
      "      // live value the medium could not store).\n" +
      "      update: async updater => {\n" +
      "        const next = updater(aggregate);\n" +
      "        assertTransactionSave(next);\n" +
      "        aggregate = next;\n" +
      "      } };\n",
   "    const stateStore = { filePath: path.join(dir, 'state.json'), load: async () => structuredClone(aggregate),\n" +
   "      update: async updater => { aggregate = aggregateSchema.parse(updater(structuredClone(aggregate))); } };\n"],
  // The exactly-once fix landed inside the grouped path, after the group itself: a
  // recovered commit installs a group's markers before the next transaction reads
  // the document, and the memory's bridge marker window keeps only the last 4096
  // records, so a longer group must consult the recovered ledger instead of its own
  // markers before it applies anything. Reversing these two insertions first
  // restores the grouped shape the piece below reverses to the released per-record
  // path; the released source has neither.
  ["      const outcome = await mutate(async (instance, store, { recovered }) => {\n" +
   "        let duplicated = 0;\n" +
   "        for (const entry of entries) {\n" +
   "          // A recovered commit installed this record's aggregate effects and its\n" +
   "          // marker before this transaction read the document, so it is already\n" +
   "          // durable and must not be applied again. The memory cannot decide this\n" +
   "          // on its own: it keeps only the last 4096 bridge markers\n" +
   "          // (`#markBridgeApplied`), so re-applying a longer group would re-apply\n" +
   "          // its head - and that append scrolls the window, cascading through the\n" +
   "          // rest of the group. The committed ledger is the authority.\n" +
   "          if (recovered[entry.eventId] === entry.mac) { duplicated += 1; continue; }\n" +
   "          const result = await instance.applyExecutionEvent(entry.event);\n" +
   "          if (result.duplicate) duplicated += 1;\n" +
   "        }\n" +
   "        return { duplicates: duplicated };\n" +
   "      }, ledger);\n",
   "      const outcome = await mutate(async instance => {\n" +
   "        let duplicated = 0;\n" +
   "        for (const entry of entries) {\n" +
   "          const result = await instance.applyExecutionEvent(entry.event);\n" +
   "          if (result.duplicate) duplicated += 1;\n" +
   "        }\n" +
   "        return { duplicates: duplicated };\n" +
   "      }, ledger);\n",],
  ["    // `recovered` is the committed marker map *after* the recovery above, so\n" +
   "    // `work` can tell a record that this transaction still has to apply from one\n" +
   "    // a recovered commit already installed. It is not a cache: the memory's own\n" +
   "    // bridge marker window keeps only the last 4096 records, which is not enough\n" +
   "    // to recognise a long group that this port already applied.\n" +
   "    const result = await work(current.instance, store, { recovered });\n",
   "    const result = await work(current.instance, store);\n",],
  // The replay path now commits every record a pass authenticated in one
  // transaction instead of one per record. Each record still pays its own
  // parse, MAC verification, writer check, marker/conflict check and is applied
  // in file order; only the stage mirror, the two whole-document writes, their
  // fsyncs and the reload are shared. Reversing the block restores the pinned
  // per-record loop; the writer predicate inside it is reversed by the piece
  // below, so this one must stay above it.
  ["    let applied = 0, duplicates = plan.trusted ? plan.prefixRecords : 0;\n" +
   "    let first = null, last = null;\n" +
   "    // Records this pass authenticated but has not committed yet. A step that\n" +
   "    // arrives after a burst of events (one operation emits two or three\n" +
   "    // records, the autonomous observer emits them between steps, or the process\n" +
   "    // was down while another one appended) used to pay one complete durable\n" +
   "    // transaction per record: a stage mirror, an aggregate snapshot, two\n" +
   "    // whole-document writes, their fsyncs and a full reload. The records are\n" +
   "    // independent and already ordered, and each one still pays its own parse,\n" +
   "    // MAC verification, writer check, marker/conflict check and application in\n" +
   "    // file order, so the group is committed by one transaction that replaces\n" +
   "    // the per-record ones. Nothing is skipped, reordered or applied twice; only\n" +
   "    // the transport work between them is shared.\n" +
   "    const batch = [];\n" +
   "    // The marker map is the dedup authority for the pass, so a record this batch\n" +
   "    // owns must stay visible to the marker check of the record after it until\n" +
   "    // the commit publishes it.\n" +
   "    const batchMarks = new Map();\n" +
   "    const absorb = (line, { witnessed }) => {\n" +
   "      const envelope = JSON.parse(line);\n" +
   "      const verified = verifyEventBridgeEnvelope(envelope, config.eventBridgeKey);\n" +
   "      if (!eventBridgeWriterTrusted(verified, writer)) throw new Error('E_DOMAIN_EVENT_AUTH');\n" +
   "      const eventId = safeIdentifier(verified.event.eventId);\n" +
   "      if (witnessed) {\n" +
   "        const witness = { id: String(eventId), mac: envelope.mac };\n" +
   "        first ??= witness;\n" +
   "        last = witness;\n" +
   "      }\n" +
   "      // Authenticate every record the checkpoint does not cover, including\n" +
   "      // duplicates, before consulting the marker. Already committed events need\n" +
   "      // neither a second parse nor a full DTO.\n" +
   "      const marker = domain.global.get().applied[eventId] || batchMarks.get(eventId);\n" +
   "      if (marker) {\n" +
   "        if (marker !== envelope.mac) throw new Error('E_DOMAIN_EVENT_ID_CONFLICT');\n" +
   "        duplicates++; return;\n" +
   "      }\n" +
   "      batchMarks.set(eventId, envelope.mac);\n" +
   "      batch.push({ eventId, mac: envelope.mac, event: projectExecutionEvent(verified.event) });\n" +
   "    };\n" +
   "    /** Commit what this pass authenticated as one transaction. */\n" +
   "    const commit = async () => {\n" +
   "      if (!batch.length) return;\n" +
   "      const entries = batch.splice(0, batch.length);\n" +
   "      batchMarks.clear();\n" +
   "      // The whole committed map is handed to `mutate()` rather than only the\n" +
   "      // records this group adds: the transaction merges the caller's set onto the\n" +
   "      // markers an interrupted commit recovered from disk, and it must keep\n" +
   "      // refusing an eventId the two sides disagree about\n" +
   "      // (`E_DOMAIN_EVENT_ID_CONFLICT`) - a marker only this group knows is not\n" +
   "      // enough to detect that.\n" +
   "      const ledger = { ...domain.global.get().applied };\n" +
   "      for (const entry of entries) ledger[entry.eventId] = entry.mac;\n" +
   "      const outcome = await mutate(async instance => {\n" +
   "        let duplicated = 0;\n" +
   "        for (const entry of entries) {\n" +
   "          const result = await instance.applyExecutionEvent(entry.event);\n" +
   "          if (result.duplicate) duplicated += 1;\n" +
   "        }\n" +
   "        return { duplicates: duplicated };\n" +
   "      }, ledger);\n" +
   "      duplicates += outcome.duplicates;\n" +
   "      applied += entries.length - outcome.duplicates;\n" +
   "    };\n" +
   "    let refusal = null;\n" +
   "    for (const line of plan.lines) {\n" +
   "      if (!line.trim()) continue;\n" +
   "      try { absorb(line, { witnessed: true }); } catch (error) { refusal = error; break; }\n" +
   "    }\n" +
   "    // A torn trailing line is processed exactly as before but stays outside\n" +
   "    // the checkpoint, so a later append re-processes it instead of silently\n" +
   "    // skipping bytes that were never a complete record.\n" +
   "    if (!refusal && plan.remainder.trim()) {\n" +
   "      try { absorb(plan.remainder, { witnessed: false }); } catch (error) { refusal = error; }\n" +
   "    }\n" +
   "    // The per-record path committed every record it had authenticated before the\n" +
   "    // one that was refused, so a refusal must not roll back what this pass has\n" +
   "    // already verified: that progress is committed first and the refusal is then\n" +
   "    // reported exactly as before, without advancing the checkpoint below. A\n" +
   "    // failure inside the group's own transaction aborts the whole group instead:\n" +
   "    // nothing of it is published, and the next pass re-applies it in file order\n" +
   "    // with the same marker map, so no record can be skipped or applied twice. If\n" +
   "    // that commit fails while a refusal is also pending, the commit failure is\n" +
   "    // what the pass reports - the per-record path reached the same commit before\n" +
   "    // it read the refused record.\n" +
   "    await commit();\n" +
   "    if (refusal) throw refusal;\n" +
   "",
"    let applied = 0, duplicates = plan.trusted ? plan.prefixRecords : 0;\n" +
   "    let first = null, last = null;\n" +
   "    const absorb = async (line, { witnessed }) => {\n" +
   "      const envelope = JSON.parse(line);\n" +
   "      const verified = verifyEventBridgeEnvelope(envelope, config.eventBridgeKey);\n" +
   "      if (!eventBridgeWriterTrusted(verified, writer)) throw new Error('E_DOMAIN_EVENT_AUTH');\n" +
   "      const eventId = safeIdentifier(verified.event.eventId);\n" +
   "      if (witnessed) {\n" +
   "        const witness = { id: String(eventId), mac: envelope.mac };\n" +
   "        first ??= witness;\n" +
   "        last = witness;\n" +
   "      }\n" +
   "      // The committed domain marker covers the complete single-event batch.\n" +
   "      // Authenticate every record the checkpoint does not cover, including\n" +
   "      // duplicates, before consulting it. Already committed events need\n" +
   "      // neither a second parse nor a full DTO.\n" +
   "      const marker = domain.global.get().applied[eventId];\n" +
   "      if (marker) {\n" +
   "        if (marker !== envelope.mac) throw new Error('E_DOMAIN_EVENT_ID_CONFLICT');\n" +
   "        duplicates++; return;\n" +
   "      }\n" +
   "      const event = projectExecutionEvent(verified.event);\n" +
   "      const result = await mutate(instance => instance.applyExecutionEvent(event), { ...domain.global.get().applied, [event.eventId]: envelope.mac });\n" +
   "      if (result.duplicate) duplicates++; else applied++;\n" +
   "    };\n" +
   "    for (const line of plan.lines) {\n" +
   "      if (!line.trim()) continue;\n" +
   "      await absorb(line, { witnessed: true });\n" +
   "    }\n" +
   "    // A torn trailing line is processed exactly as before but stays outside\n" +
   "    // the checkpoint, so a later append re-processes it instead of silently\n" +
   "    // skipping bytes that were never a complete record.\n" +
   "    if (plan.remainder.trim()) await absorb(plan.remainder, { witnessed: false });\n" +
   ""],
  // The event-bridge authentication rule was unified after the anchor: the
  // replay path now calls the same exported predicate the doctor uses, and the
  // writer default comes from one exported constant. The rule is unchanged - a
  // record is replayable only when its MAC verifies and it names the trusted
  // writer - so reversing these three lines restores the pinned source instead
  // of dropping the anchor.
  ["import { EVENT_BRIDGE_DEFAULT_WRITER, eventBridgeWriterTrusted, verifyEventBridgeEnvelope } from './orchestrator.js';\n",
   "import { verifyEventBridgeEnvelope } from './orchestrator.js';\n"],
  ["    const writer = config.eventBridgeWriter || EVENT_BRIDGE_DEFAULT_WRITER;\n",
   "    const writer = config.eventBridgeWriter || 'dsh-evolution-orchestrator';\n"],
  ["      if (!eventBridgeWriterTrusted(verified, writer)) throw new Error('E_DOMAIN_EVENT_AUTH');\n",
   "      if (!verified || verified.writer !== writer) throw new Error('E_DOMAIN_EVENT_AUTH');\n"],
  // The archive-lock comment now states what the settle window and the
  // live-owner rule actually guarantee, and it carries the rendezvous rule a
  // reclaim and a release both depend on. Both paragraphs belong to this one
  // comment, so the whole comment is one piece: the later wording and the
  // rendezvous paragraph have no anchor the pinned text also has, so a
  // paragraph-only piece could only be anchored on text this piece rewrites, and
  // an empty anchor cannot be replayed in the other direction.
  ["/**\n * Acquire the cross-process archive lock. A lock whose owner is dead, or whose\n * content was never written (the writer was killed between create and write),\n * must not brick the plugin: a lock that cannot be read or parsed is reclaimed\n * only once the file has not been modified for LOCK_SETTLE_MS, while a lock\n * whose readable content names a live owner is refused, never taken.\n *\n * The path is the only rendezvous point between processes, so a reclaim and a\n * release both prove that the entry they remove is still the exact file they\n * inspected: the content alone cannot, because the path outlives every lock that\n * occupies it.\n */",
   "/**\n * Acquire the cross-process archive lock. A lock whose owner is dead, or whose\n * content was never written (the writer was killed between create and write),\n * must not brick the plugin: an unparsable lock is reclaimed only after it has\n * definitively settled, so an in-flight writer can never be displaced.\n */"],
  // The ledger-merge guard: recovery installs the committed markers it just
  // recovered, and the caller's own set is merged onto them. An eventId both
  // sides know with a different MAC is the same conflict the replay path
  // rejects, so it throws instead of letting either side win.
  ["/**\n" +
   " * Merge the ledger a caller passes onto the one recovery installed.\n" +
   " *\n" +
   " * The caller's set is the newer of the two - `replay()` adds the event it just\n" +
   " * verified - so a marker only the caller knows is added. When both sets know the\n" +
   " * same eventId with a different MAC, they disagree about which envelope was\n" +
   " * committed under that identity, and that is a conflict rather than an update:\n" +
   " * it is the same condition the replay path rejects on the live ledger\n" +
   " * (`E_DOMAIN_EVENT_ID_CONFLICT`). Letting either side win here would silently\n" +
   " * rewrite an event identity that is already committed, so neither does. This\n" +
   " * check runs on the ledger `installPending()` just installed, which is the only\n" +
   " * moment the recovered markers - and therefore the conflict - are visible.\n" +
   " *\n" +
   " * The caller's table is walked with `Object.keys()` and one indexed read per key\n" +
   " * instead of `Object.entries()`, which built a `[eventId, mac]` pair array for\n" +
   " * every marker the table holds (20,000 of them at 20,000 committed events) only\n" +
   " * to read the same two values back out of it. Both forms visit the same own\n" +
   " * enumerable string keys in the same order and read each value exactly once;\n" +
   " * `Object.entries()` only interleaves the descriptor read and the value read per\n" +
   " * key, which is not observable on the table this function is given: its sole\n" +
   " * caller is `replay()`, which builds that table as `{ ...applied }` and then\n" +
   " * assigns one string MAC per new record, so every own property is a data\n" +
   " * property written by the spread or by that assignment. (A table carrying\n" +
   " * accessors would be the one shape where an interleaved read could differ, and\n" +
   " * no port path produces one.) Exported so a differential regression can compare\n" +
   " * it against the `Object.entries()` form it replaces; nothing outside this\n" +
   " * module calls it.\n" +
   " */\n" +
   "export function mergeEventLedger(recovered, applied) {\n" +
   "  if (!applied) return recovered;\n" +
   "  const merged = { ...recovered };\n" +
   "  for (const eventId of Object.keys(applied)) {\n" +
   "    const mac = applied[eventId];\n" +
   "    const known = merged[eventId];\n" +
   "    if (known !== undefined && known !== mac) throw new Error('E_DOMAIN_EVENT_ID_CONFLICT');\n" +
   "    merged[eventId] = mac;\n" +
   "  }\n" +
   "  return merged;\n" +
   "}\n" +
   "const safeIdentifier = value => typeof value === 'string'",
   "const safeIdentifier = value => typeof value === 'string'"],
  // Round 4 routed the checkpoint warning through `safeErrorDto`, because a log
  // line is a boundary like any other. The containment round then routed the same
  // warning through the shared `warnRedacted()` entry point, so a logger that
  // throws or rejects (the real Cordis logger does when a real exporter throws)
  // can no longer fail a pass that committed every record it read; that round also
  // dropped the now-direct `safeErrorDto` import above. Reversing this one piece
  // restores the pinned source instead of dropping the anchor: both directions of
  // the `catch` body are exact single occurrences, and the pinned shape is the
  // raw-message warning it shipped.
  ["        // Losing the checkpoint only means the next pass re-verifies history.\n        // The warning is a log line, and a log line is a boundary: it carries\n        // the safe DTO (redacted summary, category, digest), not the raw message.\n        // It goes through the one redacted-warning entry point so the warning\n        // cannot become the outcome of the pass: a logger that throws, or one\n        // that rejects, stays a diagnostic instead of a failed flush.\n        warnRedacted(ctx, 'event log checkpoint not written', error, 'event-log-checkpoint');\n",
   "        // Losing the checkpoint only means the next pass re-verifies history.\n        ctx.logger?.warn?.(`[evolution] event log checkpoint not written: ${error?.message || error}`);\n"],
  // The whole-document schema no longer validates every value against
  // `z.json()`. `aggregateSchema` preprocesses with `toJsonProjection`, and the
  // output of `JSON.parse(JSON.stringify(...))` can only be JSON - an in-memory
  // `NaN`/`Infinity` became `null` inside the projection, and a value that only
  // parses to `Infinity` (`1e999`) is normalized to `null` the same way - so the
  // recursive walk could never reject a projected document. It only walked the
  // aggregate again on every save of every transaction step. `passthrough()`
  // keeps the unknown evolution fields and the strict document shape, which is
  // the part that can still reject.
  //
  // The walk did transform one thing: it built its result with plain property
  // assignment, so an own `__proto__` key (which `JSON.parse` can create)
  // vanished instead of being kept. The working tree still drops that key from
  // the copy the structural schema judges (that is what keeps the verdict the
  // retired walk made), while the document it returns keeps it, so this piece
  // covers the whole block and not just the schema line.
  ["// The legacy aggregate can carry `undefined` object fields (e.g. relationRefs).\n" +
   "// JSON is the durable medium, and the old file backend already dropped those\n" +
   "// fields through JSON.stringify, so normalize to the exact JSON projection before\n" +
   "// validating: this keeps strict persistence semantics without silently changing\n" +
   "// state.\n" +
   "//\n" +
   "// That projection is also why no per-value JSON schema is needed below. Its\n" +
   "// output can only be `null`, booleans, strings, arrays, plain objects and\n" +
   "// numbers that `JSON.stringify` accepted - an in-memory `NaN` or `Infinity` is\n" +
   "// already `null` by the time anything is validated - so a recursive `z.json()`\n" +
   "// over every value could never reject a projected document; it only walked the\n" +
   "// whole aggregate a second time on every transaction step, and a single\n" +
   "// transaction step saves several times (`#append`, then `#markBridgeApplied`).\n" +
   "// What is left is the strict structural schema below.\n" +
   "const PROTO_KEY = '__proto__';\n" +
   "/**\n" +
   " * A copy of `value` with every own `__proto__` key removed, at every depth.\n" +
   " *\n" +
   " * Only `JSON.parse` (or an explicit define) can create that key: assigning the\n" +
   " * name on an ordinary object sets the prototype instead of an own key, which is\n" +
   " * why the recursive `z.record`-based walk this schema used to do dropped it as a\n" +
   " * side effect of building its result. The copy is what the structural schema\n" +
   " * validates, so the accept/reject decision is the one that walk made\n" +
   " * (`aggregate-schema-equivalence` pins it at every depth); the document that is\n" +
   " * returned and persisted keeps the key, because it is part of a record's\n" +
   " * identity and deleting it would make the in-memory identity drift from the\n" +
   " * reloaded one. Past the validation copy nothing ever assigns that name.\n" +
   " */\n" +
   "function withoutOwnProtoKeys(value) {\n" +
   "  if (Array.isArray(value)) return value.map(withoutOwnProtoKeys);\n" +
   "  if (!value || typeof value !== 'object') return value;\n" +
   "  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== PROTO_KEY).map(([key, item]) => [key, withoutOwnProtoKeys(item)]));\n" +
   "}\n" +
   "/**\n" +
   " * The one projection every durable value goes through. It returns the JSON\n" +
   " * document and, when the serialized text carries the own-`__proto__` literal, a\n" +
   " * key-free copy of it for the structural check to judge.\n" +
   " *\n" +
   " * The literal is only looked for in the text: `JSON.stringify` must spell an own\n" +
   " * key of that name literally, so a document that cannot contain one - every\n" +
   " * document a plugin that never records such a payload writes - pays a substring\n" +
   " * search and shares one object, not a second walk. It is also the gate the\n" +
   " * retired deep walk effectively had, so the depth at which a document overflows\n" +
   " * a recursive walk is the same depth it overflowed before. (A string value that\n" +
   " * happens to read `__proto__` only makes the walk run and find nothing.)\n" +
   " */\n" +
   "const toJsonProjection = value => {\n" +
   "  const text = JSON.stringify(value);\n" +
   "  const document = JSON.parse(text);\n" +
   "  const validation = text.includes(`\"${PROTO_KEY}\"`) ? withoutOwnProtoKeys(document) : document;\n" +
   "  return { document, validation };\n" +
   "};\n" +
   "/**\n" +
   " * The structural requirements of one aggregate document: the only top-level\n" +
   " * member it may carry, that member being an optional object, and the integer\n" +
   " * `schema >= 4` inside it. `passthrough()` keeps the unknown evolution fields\n" +
   " * instead of stripping them (`catchall` would keep validating them). It judges\n" +
   " * the key-free copy this projection hands it, which is the same document the\n" +
   " * retired deep walk judged.\n" +
   " */\n" +
   "const aggregateStructure = z.object({ evolution: z.object({ schema: z.number().int().min(4) }).passthrough().optional() }).strict();\n" +
   "/**\n" +
   " * The document schema every durable aggregate goes through.\n" +
   " *\n" +
   " * The two halves of the old single schema are split here, and only in how the\n" +
   " * verdict is produced: the structural requirements moved into\n" +
   " * `aggregateStructure`, which judges the key-free copy, and this wrapper\n" +
   " * re-reports its issues from the same place - with their own paths - so a\n" +
   " * refusal keeps the exact issue code and path it had when this schema judged the\n" +
   " * document directly (`domain-hotpath-20261024-entry-validation` pins one of\n" +
   " * them). What changed deliberately is the *value*: this returns the JSON\n" +
   " * projection with an own `__proto__` key, because that key is part of a record's\n" +
   " * identity and dropping it made the in-memory identity differ from the reloaded\n" +
   " * one.\n" +
   " */\n" +
   "const aggregateSchema = z.preprocess(toJsonProjection,\n" +
   "  z.object({ document: z.unknown(), validation: z.unknown() }).strict()\n" +
   "    .superRefine(({ validation }, ctx) => {\n" +
   "      const result = aggregateStructure.safeParse(validation);\n" +
   "      if (result.success) return;\n" +
   "      for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: issue.path });\n" +
   "    })\n" +
   "    .transform(({ document }) => document));",
   "const json = z.json();\n" +
   "// The legacy aggregate can carry `undefined` object fields (e.g. relationRefs).\n" +
   "// JSON is the durable medium, and the old file backend already dropped those\n" +
   "// fields through JSON.stringify, so normalize to the exact JSON projection before\n" +
   "// validating: this keeps strict JSON validation without silently changing state.\n" +
   "const toJsonProjection = value => JSON.parse(JSON.stringify(value));\n" +
   "const aggregateSchema = z.preprocess(toJsonProjection,\n" +
   "  z.object({ evolution: z.object({ schema: z.number().int().min(4) }).catchall(json).optional() }).strict());"]
];

/** Revert only the retained write-path variant; everything else stays as written. */
export function reconstructPreMerge(source) {
  for (const [after, before] of reversals) {
    assert.equal(source.split(after).length - 1, 1,
      "domain-storage merged-variant post-change shape must occur exactly once before reconstruction");
    source = source.replace(after, before);
  }
  return source;
}

/**
 * The pre-change implementation used by the equivalence test and the benchmark.
 *
 * `release/dsh-evolution-0.2.0-rc.8.tgz` is committed and predates this change,
 * so the reconstruction must reproduce its file byte for byte. That assertion is
 * deliberately unconditional: losing the anchor must be a conscious edit, not a
 * silent downgrade to a reconstruction that only checks its own shape.
 */
export async function domainStorageBaseline() {
  const working = await readFile(new URL("../../lib/domain-storage.js", import.meta.url), "utf8");
  const reconstructed = reconstructPreMerge(working);
  assert.notEqual(reconstructed, working, "the reconstruction must actually change the source");
  const artifact = join(RELEASE_DIR, PRE_CHANGE_ARTIFACT);
  assert.ok(fs.existsSync(artifact),
    `${PRE_CHANGE_ARTIFACT} is the authoritative pre-change source for the merged write-path variant; restore it or move the anchor deliberately`);
  const pinned = readTarEntries(artifact).find((entry) => entry.path === SOURCE_PATH);
  assert.ok(pinned, "the pinned artifact must ship the domain storage implementation");
  const pinnedSource = pinned.bytes.toString("utf8");
  assert.match(pinnedSource, /await domain\.global\.set\(schema\.parse\(\{ schema: 1, aggregate: current\.pending\.aggregate/,
    `${PRE_CHANGE_ARTIFACT} must predate the merged write-path variant`);
  assert.equal(reconstructed, pinnedSource,
    "the reconstruction must be byte-identical to the authoritative pre-change pin");
  return { source: reconstructed, reconstructed, anchor: { artifact: PRE_CHANGE_ARTIFACT, pinnedSource } };
}

/**
 * Materialise one `lib/domain-storage.js` source as an importable module so an
 * A/B run or a differential test can load the pre-change and post-change
 * implementations side by side. Relative specifiers resolve to the tree the
 * source belongs to (the working tree by default), so a whole-tree comparison
 * really loads two trees' siblings; bare specifiers resolve through this
 * process's module map. Only the file under test differs.
 */
/**
 * Rewrite import specifiers only where a specifier can be.
 *
 * The patterns must not match prose that merely reads `from "..."`. A real
 * specifier never spans a line, so the quoted run excludes `\n`, and that is what
 * keeps a wrapped doc comment out - the exact shape that broke this rewrite once
 * (`... from "a lock another ..."` continues on the next line, and rewriting it
 * corrupted the module being copied). A single-line `from "..."` inside a
 * comment or a string is still rewritten, because this is a pattern and not a
 * parser; every source it is given here has single-line specifiers.
 */
export async function materializeDomainStorage(source, home, label, resolveFrom = WORKING_SOURCE) {
  const modulePath = join(home, `${label}.mjs`);
  const rewritten = source
    .replace(/from (["'])(\.\/[^"'\n]+)\1/g,
      (_match, quote, specifier) => `from ${quote}${new URL(specifier, pathToFileURL(resolveFrom)).href}${quote}`)
    .replace(/from (["'])([^."'\n][^"'\n]*)\1/g,
      (_match, quote, specifier) => `from ${quote}${import.meta.resolve(specifier)}${quote}`);
  await writeFile(modulePath, rewritten);
  const module = await import(pathToFileURL(modulePath).href);
  assert.equal(typeof module.openDomainStorage, "function", `${label} must export openDomainStorage`);
  assert.ok(module.evolutionDomainSpec, `${label} must export evolutionDomainSpec`);
  return module;
}
