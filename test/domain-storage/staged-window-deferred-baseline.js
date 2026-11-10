// Reverse the staged-replay deferred marker-window round before older
// pinned baselines.
//
// That round lets the private replay working copy grow one bridge marker
// window in place, reports each append with its exact length and tail, and
// publishes the bounded last-4,096 window through `snapshot()`. The older
// reconstruction tables were written against the frozen-successor form, so
// this round has to be undone before the first of them; each anchor must
// occur exactly once, and the reversed sources are pinned to the commit the
// round started from.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const PINS = {
  "lib/domain-storage.js": "523b7b05ae65d3bf289ea704254520f739693aae0fc0f2abcb85e476625d2adc",
  "lib/dockyard-domain/memory.js": "99e0870a3a0f5e68f067d4e75e040c541c033c0d332339e7eb55e9f57f03d44e",
};

const HUNKS = [
  {
    file: "lib/domain-storage.js",
    post:
      "    // The bridge markers this transaction's saves reuse verdicts for; it lives\n" +
      "    // exactly as long as this working store (see `assertStagedTransactionSave`).\n" +
      "    const markerVerdicts = new WeakMap();\n" +
      "    const windowChecks = archiveWriteGuard === null ? null : createStagedWindowChecks({ elementChecks: elementSaveChecks, deferredWindows: elementSaveChecks });\n" +
      "    // `inlineSerialization` is honest here: `update` captures the bytes of the\n" +
      "    // payload it is handed with the synchronous `JSON.stringify` below, before\n" +
      "    // it returns, so the caller's live shallow view cannot change what is\n" +
      "",
    pre:
      "    // The bridge markers this transaction's saves reuse verdicts for; it lives\n" +
      "    // exactly as long as this working store (see `assertStagedTransactionSave`).\n" +
      "    const markerVerdicts = new WeakMap();\n" +
      "    const windowChecks = archiveWriteGuard === null ? null : createStagedWindowChecks({ elementChecks: elementSaveChecks });\n" +
      "    // `inlineSerialization` is honest here: `update` captures the bytes of the\n" +
      "    // payload it is handed with the synchronous `JSON.stringify` below, before\n" +
      "    // it returns, so the caller's live shallow view cannot change what is\n" +
      "",
  },
  {
    file: "lib/domain-storage.js",
    post:
      "        assertStagedTransactionSave(next, markerVerdicts, windowChecks?.windows, windowChecks?.elements);\n" +
      "        aggregate = next;\n" +
      "      } };\n" +
      "    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update, bridgeWindowChanged: windowChecks?.changed }, mutationAuthority: authority, archiveWriteGuard, deferLoadArchiveWrites, archiveReadCache, coalesceMeasurementMarkerPersist: archiveWriteGuard !== null, deferArchiveIndexWrites: archiveWriteGuard !== null, deferBridgeWindowRebuild: elementSaveChecks === true });\n" +
      "    // The load's own work is required (state restore, archive index\n" +
      "    // reconciliation, eviction and archival); the hot projection it would\n" +
      "    // return is not: no caller of this factory reads it.\n" +
      "",
    pre:
      "        assertStagedTransactionSave(next, markerVerdicts, windowChecks?.windows, windowChecks?.elements);\n" +
      "        aggregate = next;\n" +
      "      } };\n" +
      "    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update, bridgeWindowChanged: windowChecks?.changed }, mutationAuthority: authority, archiveWriteGuard, deferLoadArchiveWrites, archiveReadCache, coalesceMeasurementMarkerPersist: archiveWriteGuard !== null, deferArchiveIndexWrites: archiveWriteGuard !== null });\n" +
      "    // The load's own work is required (state restore, archive index\n" +
      "    // reconciliation, eviction and archival); the hot projection it would\n" +
      "    // return is not: no caller of this factory reads it.\n" +
      "",
  },
  {
    file: "lib/domain-storage.js",
    post:
      " * calls it.\n" +
      " */\n" +
      "// Only the port's private working memory calls changed(): it reports native,\n" +
      "// dense arrays it owns. The default form is a frozen successor derived by\n" +
      "// appending one marker to its prior immutable window; `deferredWindows` is the\n" +
      "// same working copy saving once per absorbed record, which grows one native\n" +
      "// array in place and reports each append's exact length and tail marker, so the\n" +
      "// save judges the added marker without rebuilding that window. It never reports\n" +
      "// a caller-owned array. Verdicts are still computed at save time, after the\n" +
      "// document's own serialization.\n" +
      "//\n" +
      "// `elementChecks` additionally enables the collection-array element memo below.\n" +
      "// Both are requested only by the replay that absorbs a batch of logged events,\n" +
      "// whose working copy is the one store that saves once per record; every other\n" +
      "// transaction keeps the released check byte for byte.\n" +
      "export function createStagedWindowChecks({ elementChecks = false, deferredWindows = false } = {}) {\n" +
      "  const windows = new WeakMap();\n" +
      "  return { windows, elements: elementChecks ? new WeakMap() : null, deferred: deferredWindows, changed(previous, next, marker) {\n" +
      "    if (!Array.isArray(next) || Object.getPrototypeOf(next) !== Array.prototype\n" +
      "      || Object.getOwnPropertyDescriptor(next, 'toJSON') !== undefined) return;\n" +
      "    if (!deferredWindows || Object.isFrozen(next)) {\n" +
      "      if (!Object.isFrozen(next)) return;\n" +
      "      windows.set(next, { verified: false, inherited: previous !== null && windows.get(previous)?.verified === true, marker });\n" +
      "      return;\n" +
      "    }\n" +
      "    const prior = previous === null ? undefined : windows.get(previous);\n" +
      "    // An append that follows a save which never ran keeps its predecessor's\n" +
      "    // unjudged markers; the next save judges them together. A new array (the\n" +
      "    // periodic reduction) cannot inherit them by identity, so it is walked in\n" +
      "    // full instead of dropping one.\n" +
      "    const continues = prior !== undefined && prior.verified !== true && prior.applied === next;\n" +
      "    windows.set(next, {\n" +
      "      deferred: true, applied: next, length: next.length,\n" +
      "      // The exact tail the hook was told about. `length` alone would miss an\n" +
      "      // in-place replacement of the last entry (the seed report has no added\n" +
      "      // marker to compare, so this is recorded for every report).\n" +
      "      tail: next.length === 0 ? null : next[next.length - 1], marker,\n" +
      "      pending: continues ? [...prior.pending, ...(marker === null ? [] : [marker])] : (marker === null ? [] : [marker]),\n" +
      "      inherited: prior !== undefined && prior.verified === true,\n" +
      "      verified: false,\n" +
      "    });\n" +
      "  } };\n" +
      "}\n" +
      "export function assertStagedTransactionSave(payload, verdicts, windows = null, elements = null) {\n" +
      "",
    pre:
      " * calls it.\n" +
      " */\n" +
      "// Only the port's private working memory calls changed(): it reports native,\n" +
      "// dense arrays it just froze, derived by appending one marker to its prior\n" +
      "// immutable window. It never reports a caller-owned mutable window. Verdicts\n" +
      "// are still computed at save time, after the document's own serialization.\n" +
      "//\n" +
      "// `elementChecks` additionally enables the collection-array element memo below.\n" +
      "// It is requested only by the replay that absorbs a batch of logged events,\n" +
      "// whose working copy is the one store that saves once per record; every other\n" +
      "// transaction keeps the released check byte for byte.\n" +
      "export function createStagedWindowChecks({ elementChecks = false } = {}) {\n" +
      "  const windows = new WeakMap();\n" +
      "  return { windows, elements: elementChecks ? new WeakMap() : null, changed(previous, next, marker) {\n" +
      "    if (!Object.isFrozen(next)) return;\n" +
      "    windows.set(next, { verified: false, inherited: previous !== null && windows.get(previous)?.verified === true, marker });\n" +
      "  } };\n" +
      "}\n" +
      "export function assertStagedTransactionSave(payload, verdicts, windows = null, elements = null) {\n" +
      "",
  },
  {
    file: "lib/domain-storage.js",
    post:
      "  // the recursive copy it triggers is what can overflow, and it has to see the\n" +
      "  // whole document. Nothing the window adds can change that verdict.\n" +
      "  if (text.includes(`\"${PROTO_KEY}\"`)) return whole();\n" +
      "  const judgeMarkers = (markers) => {\n" +
      "    for (const marker of markers) {\n" +
      "      let verdict = verdicts.get(marker);\n" +
      "      if (verdict === undefined) {\n" +
      "        if (!memoizableMarker(marker)) return false;\n" +
      "        const markerText = JSON.stringify(marker);\n" +
      "        // `JSON.stringify` answers `undefined` for a value whose own `toJSON`\n" +
      "        // returns it; in an array that element is written as `null`.\n" +
      "        // `memoizableMarker()` already refuses a visible `toJSON`, so this is the\n" +
      "        // bottom of the ladder rather than a reachable state.\n" +
      "        if (markerText === undefined) return false;\n" +
      "        verdict = markerText.includes(`\"${PROTO_KEY}\"`);\n" +
      "        verdicts.set(marker, verdict);\n" +
      "      }\n" +
      "      if (verdict) return false;\n" +
      "    }\n" +
      "    return true;\n" +
      "  };\n" +
      "  // A certificate describes immutable membership, not merely an array identity.\n" +
      "  // The private memory reports every successor; only its one added marker is\n" +
      "  // unjudged when its predecessor was verified. Mutable/unreported windows keep\n" +
      "  // the original complete walk, including its serialization failures.\n" +
      "  const windowCheck = windows ? windows.get(window) : undefined;\n" +
      "  if (windowCheck?.deferred === true) {\n" +
      "    // The replay working copy reports every in-place append with the exact\n" +
      "    // length and tail marker it produced. A window that is not that value was\n" +
      "    // not reported through this certificate (or changed after reporting), so it\n" +
      "    // keeps the released walk.\n" +
      "    if (window.length !== windowCheck.length\n" +
      "      || window[window.length - 1] !== windowCheck.tail) {\n" +
      "      // The value on hand is not the one the hook described. Drop the record so\n" +
      "      // no later save can inherit it, and let the released check decide.\n" +
      "      windows.delete(window);\n" +
      "      return whole();\n" +
      "    }\n" +
      "    if (windowCheck.verified === true) return;\n" +
      "    // `pending` holds exactly the markers appended since the last successful\n" +
      "    // save; when the predecessor was not verified the retained window is walked\n" +
      "    // as well, which is the conservative released behaviour.\n" +
      "    const markers = windowCheck.inherited === true ? windowCheck.pending : [...window, ...windowCheck.pending];\n" +
      "    if (!judgeMarkers(markers)) return whole();\n" +
      "    windowCheck.verified = true;\n" +
      "    windowCheck.pending = [];\n" +
      "    return;\n" +
      "  }\n" +
      "  if (windowCheck?.verified === true) return;\n" +
      "  const markers = windowCheck?.inherited === true ? [windowCheck.marker] : window;\n" +
      "  if (!judgeMarkers(markers)) return whole();\n" +
      "  if (windowCheck) windowCheck.verified = true;\n" +
      "}\n" +
      "export function projectObservation(input = {}) {\n" +
      "",
    pre:
      "  // the recursive copy it triggers is what can overflow, and it has to see the\n" +
      "  // whole document. Nothing the window adds can change that verdict.\n" +
      "  if (text.includes(`\"${PROTO_KEY}\"`)) return whole();\n" +
      "  // A certificate describes immutable membership, not merely an array identity.\n" +
      "  // The private memory reports every successor; only its one added marker is\n" +
      "  // unjudged when its predecessor was verified. Mutable/unreported windows keep\n" +
      "  // the original complete walk, including its serialization failures.\n" +
      "  const windowCheck = windows && Object.isFrozen(window) ? windows.get(window) : undefined;\n" +
      "  if (windowCheck?.verified === true) return;\n" +
      "  const markers = windowCheck?.inherited === true ? [windowCheck.marker] : window;\n" +
      "  for (const marker of markers) {\n" +
      "    let verdict = verdicts.get(marker);\n" +
      "    if (verdict === undefined) {\n" +
      "      if (!memoizableMarker(marker)) return whole();\n" +
      "      const markerText = JSON.stringify(marker);\n" +
      "      // `JSON.stringify` answers `undefined` for a value whose own `toJSON`\n" +
      "      // returns it; in an array that element is written as `null`.\n" +
      "      // `memoizableMarker()` already refuses a visible `toJSON`, so this is the\n" +
      "      // bottom of the ladder rather than a reachable state.\n" +
      "      if (markerText === undefined) return whole();\n" +
      "      verdict = markerText.includes(`\"${PROTO_KEY}\"`);\n" +
      "      verdicts.set(marker, verdict);\n" +
      "    }\n" +
      "    if (verdict) return whole();\n" +
      "  }\n" +
      "  if (windowCheck) windowCheck.verified = true;\n" +
      "}\n" +
      "export function projectObservation(input = {}) {\n" +
      "",
  },
  {
    file: "lib/dockyard-domain/memory.js",
    post:
      "  return typeof descriptor.value === \"string\" ? descriptor.value : null;\n" +
      "}\n" +
      "\n" +
      "/** The bridge marker window answers set membership over its last 4096 entries. */\n" +
      "const BRIDGE_MARKER_WINDOW = 4096;\n" +
      "\n" +
      "/** Durable, redacted memory for proposals, experiments, failures, and promotions. */\n" +
      "export class EvolutionMemory {\n" +
      "  #data;\n" +
      "",
    pre:
      "  return typeof descriptor.value === \"string\" ? descriptor.value : null;\n" +
      "}\n" +
      "\n" +
      "/** Durable, redacted memory for proposals, experiments, failures, and promotions. */\n" +
      "export class EvolutionMemory {\n" +
      "  #data;\n" +
      "",
  },
  {
    file: "lib/dockyard-domain/memory.js",
    post:
      "  // Cache for `#bridgeApplied()`: the window array it describes and the marker\n" +
      "  // ids in it (`null` when this window cannot be indexed). See `#bridgeApplied`.\n" +
      "  #bridgeWindow;\n" +
      "  // The growable native array the private replay working copy appends bridge\n" +
      "  // markers to when it opted out of rebuilding a frozen successor per record;\n" +
      "  // `null` everywhere else. See `#markBridgeApplied()` and `snapshot()`.\n" +
      "  #bridgeDeferredWindow = null;\n" +
      "  // Whether this instance has appended to `#bridgeDeferredWindow` since load.\n" +
      "  #bridgeDeferredAppended = false;\n" +
      "  // The scan facts an append can continue from, per collection: the identity\n" +
      "  // of the active file the facts describe and the number of records they\n" +
      "  // parsed. Set by `#reconcileActiveArchive()` (fresh scan or memo hit) and by\n" +
      "",
    pre:
      "  // Cache for `#bridgeApplied()`: the window array it describes and the marker\n" +
      "  // ids in it (`null` when this window cannot be indexed). See `#bridgeApplied`.\n" +
      "  #bridgeWindow;\n" +
      "  // The scan facts an append can continue from, per collection: the identity\n" +
      "  // of the active file the facts describe and the number of records they\n" +
      "  // parsed. Set by `#reconcileActiveArchive()` (fresh scan or memo hit) and by\n" +
      "",
  },
  {
    file: "lib/dockyard-domain/memory.js",
    post:
      "  #archiveScanSeeds = new Map();\n" +
      "  #replayArchiveBatch = null;\n" +
      "\n" +
      "  constructor({ stateStore = null, key = \"evolution\", clock = () => new Date(), maxEntries = 1000, hotCycles = 50, hotEntries = 50, archiveMaxBytes = DEFAULT_ARCHIVE_TARGET_BYTES, absoluteMaxSegmentBytes = DEFAULT_ARCHIVE_HARD_CEILING_BYTES, compactionTriggerBytes = 48 * 1024 * 1024, compactionMinIntervalMs = 10 * 60_000, eventBridgePath = null, transaction = null, mutationAuthority = null, archiveWriteGuard = null, deferLoadArchiveWrites = false, archiveReadCache = null, coalesceMeasurementMarkerPersist = false, deferArchiveIndexWrites = false, deferBridgeWindowRebuild = false } = {}) {\n" +
      "    if (transaction !== null && typeof transaction.persist !== \"function\") throw new TypeError(\"transaction.persist must be a function\");\n" +
      "    if (archiveWriteGuard !== null && typeof archiveWriteGuard !== \"function\") throw new TypeError(\"archiveWriteGuard must be a function\");\n" +
      "    if (stateStore && (typeof stateStore.load !== \"function\" || !(typeof stateStore.update === \"function\" || typeof stateStore.save === \"function\"))) throw new TypeError(\"stateStore requires load and update or save\");\n" +
      "",
    pre:
      "  #archiveScanSeeds = new Map();\n" +
      "  #replayArchiveBatch = null;\n" +
      "\n" +
      "  constructor({ stateStore = null, key = \"evolution\", clock = () => new Date(), maxEntries = 1000, hotCycles = 50, hotEntries = 50, archiveMaxBytes = DEFAULT_ARCHIVE_TARGET_BYTES, absoluteMaxSegmentBytes = DEFAULT_ARCHIVE_HARD_CEILING_BYTES, compactionTriggerBytes = 48 * 1024 * 1024, compactionMinIntervalMs = 10 * 60_000, eventBridgePath = null, transaction = null, mutationAuthority = null, archiveWriteGuard = null, deferLoadArchiveWrites = false, archiveReadCache = null, coalesceMeasurementMarkerPersist = false, deferArchiveIndexWrites = false } = {}) {\n" +
      "    if (transaction !== null && typeof transaction.persist !== \"function\") throw new TypeError(\"transaction.persist must be a function\");\n" +
      "    if (archiveWriteGuard !== null && typeof archiveWriteGuard !== \"function\") throw new TypeError(\"archiveWriteGuard must be a function\");\n" +
      "    if (stateStore && (typeof stateStore.load !== \"function\" || !(typeof stateStore.update === \"function\" || typeof stateStore.save === \"function\"))) throw new TypeError(\"stateStore requires load and update or save\");\n" +
      "",
  },
  {
    file: "lib/dockyard-domain/memory.js",
    post:
      "    // Only the same working copy opts into deferring its archive index document.\n" +
      "    // See `flushDeferredArchiveIndex()` for why that is safe there and only there.\n" +
      "    this.deferArchiveIndexWrites = deferArchiveIndexWrites === true;\n" +
      "    // Only the same working copy opts into growing the bridge marker window in\n" +
      "    // place instead of rebuilding a frozen successor for every absorbed record.\n" +
      "    // See `#markBridgeApplied()` for the save-time certificate that carries it.\n" +
      "    this.deferBridgeWindowRebuild = deferBridgeWindowRebuild === true;\n" +
      "    // Host hook: a file-backed store that stages the archive elsewhere needs\n" +
      "    // the chance to hand this instance a private copy before an in-place write\n" +
      "    // so the live tree is never modified before the transaction commits.\n" +
      "",
    pre:
      "    // Only the same working copy opts into deferring its archive index document.\n" +
      "    // See `flushDeferredArchiveIndex()` for why that is safe there and only there.\n" +
      "    this.deferArchiveIndexWrites = deferArchiveIndexWrites === true;\n" +
      "    // Host hook: a file-backed store that stages the archive elsewhere needs\n" +
      "    // the chance to hand this instance a private copy before an in-place write\n" +
      "    // so the live tree is never modified before the transaction commits.\n" +
      "",
  },
  {
    file: "lib/dockyard-domain/memory.js",
    post:
      "   * judging any other window in full on every save.\n" +
      "   *\n" +
      "   * The private port hook also freezes the owned array's membership, so a save\n" +
      "   * certificate can cover its already-judged markers. The staged replay working\n" +
      "   * copy instead keeps a growable array and reports each append; see\n" +
      "   * `#markBridgeApplied()`. Ordinary stores keep the same mutable arrays. Only\n" +
      "   * `load()` calls this. A window installed by `restore()` or `reconcile()`\n" +
      "   * keeps its markers as they are, which costs the store nothing but the\n" +
      "   * re-serialization it did before (that window cannot be memoized) and cannot\n" +
      "   * make it accept something the whole-document check would reject.\n" +
      "",
    pre:
      "   * judging any other window in full on every save.\n" +
      "   *\n" +
      "   * The private port hook also freezes the owned array's membership, so a save\n" +
      "   * certificate can cover its already-judged markers. Ordinary stores keep the\n" +
      "   * same mutable arrays. Only `load()` calls this. A window installed by `restore()` or `reconcile()`\n" +
      "   * keeps its markers as they are, which costs the store nothing but the\n" +
      "   * re-serialization it did before (that window cannot be memoized) and cannot\n" +
      "   * make it accept something the whole-document check would reject.\n" +
      "",
  },
  {
    file: "lib/dockyard-domain/memory.js",
    post:
      "      if (!marker || typeof marker !== \"object\" || Array.isArray(marker) || Object.isFrozen(marker)) continue;\n" +
      "      Object.freeze(marker);\n" +
      "    }\n" +
      "    const changed = this.transaction?.bridgeWindowChanged;\n" +
      "    if (typeof changed !== \"function\") return;\n" +
      "    if (this.deferBridgeWindowRebuild && Object.getPrototypeOf(window) === Array.prototype\n" +
      "      && Object.getOwnPropertyDescriptor(window, \"toJSON\") === undefined) {\n" +
      "      // The replay working copy saves once per absorbed record and appends one\n" +
      "      // marker for each of them. Rebuilding a frozen 4,096-entry successor for\n" +
      "      // every record is the cost this mode removes: it keeps a growable native\n" +
      "      // array, reports each append (with its exact length and tail marker)\n" +
      "      // through the port hook before the save, and reduces the window to its\n" +
      "      // bounded form once, in `snapshot()`. The markers above are still frozen,\n" +
      "      // so the save certificate judges each one once; membership is not claimed\n" +
      "      // immutable, and `assertStagedTransactionSave()` re-verifies the reported\n" +
      "      // length and tail marker on every save.\n" +
      "      const growable = window.slice();\n" +
      "      this.#data.eventBridge = { schema: 1, applied: growable };\n" +
      "      this.#bridgeDeferredWindow = growable;\n" +
      "      this.#bridgeDeferredAppended = false;\n" +
      "      changed(null, growable, null);\n" +
      "      return;\n" +
      "    }\n" +
      "    Object.freeze(window);\n" +
      "    changed(null, window, null);\n" +
      "  }\n" +
      "\n" +
      "  #collections() {\n" +
      "",
    pre:
      "      if (!marker || typeof marker !== \"object\" || Array.isArray(marker) || Object.isFrozen(marker)) continue;\n" +
      "      Object.freeze(marker);\n" +
      "    }\n" +
      "    if (typeof this.transaction?.bridgeWindowChanged === \"function\") {\n" +
      "      Object.freeze(window);\n" +
      "      this.transaction.bridgeWindowChanged(null, window, null);\n" +
      "    }\n" +
      "  }\n" +
      "\n" +
      "  #collections() {\n" +
      "",
  },
  {
    file: "lib/dockyard-domain/memory.js",
    post:
      "   * Hot projection used by decision paths. It never reads cold files.\n" +
      "   * The historical public runtime snapshot calls fullSnapshot() below.\n" +
      "   */\n" +
      "  snapshot() {\n" +
      "    // The staged replay working copy grows its window in place (see\n" +
      "    // `#markBridgeApplied()`); the published window is always the bounded last\n" +
      "    // 4096 markers, in event order.\n" +
      "    if (this.#bridgeDeferredWindow !== null && this.#bridgeDeferredWindow === this.#data.eventBridge?.applied\n" +
      "      && this.#bridgeDeferredWindow.length > BRIDGE_MARKER_WINDOW) {\n" +
      "      return clone({ ...this.#data,\n" +
      "        eventBridge: { ...this.#data.eventBridge, applied: this.#bridgeDeferredWindow.slice(-BRIDGE_MARKER_WINDOW) } });\n" +
      "    }\n" +
      "    return clone(this.#data);\n" +
      "  }\n" +
      "\n" +
      "  /** Complete durable projection, materialising cold records only on demand. */\n" +
      "  fullSnapshot() {\n" +
      "",
    pre:
      "   * Hot projection used by decision paths. It never reads cold files.\n" +
      "   * The historical public runtime snapshot calls fullSnapshot() below.\n" +
      "   */\n" +
      "  snapshot() { return clone(this.#data); }\n" +
      "\n" +
      "  /** Complete durable projection, materialising cold records only on demand. */\n" +
      "  fullSnapshot() {\n" +
      "",
  },
  {
    file: "lib/dockyard-domain/memory.js",
    post:
      "    // second copy of every hot record during each public snapshot build.\n" +
      "    const output = {\n" +
      "      ...this.#data,\n" +
      "      ...(this.#bridgeDeferredWindow !== null && this.#bridgeDeferredWindow === this.#data.eventBridge?.applied\n" +
      "        && this.#bridgeDeferredWindow.length > BRIDGE_MARKER_WINDOW\n" +
      "        ? { eventBridge: { ...this.#data.eventBridge, applied: this.#bridgeDeferredWindow.slice(-BRIDGE_MARKER_WINDOW) } }\n" +
      "        : {}),\n" +
      "      coldArchives: clone(this.#data.coldArchives),\n" +
      "      autonomous: clone(this.#data.autonomous),\n" +
      "    };\n" +
      "",
    pre:
      "    // second copy of every hot record during each public snapshot build.\n" +
      "    const output = {\n" +
      "      ...this.#data,\n" +
      "      coldArchives: clone(this.#data.coldArchives),\n" +
      "      autonomous: clone(this.#data.autonomous),\n" +
      "    };\n" +
      "",
  },
  {
    file: "lib/dockyard-domain/memory.js",
    post:
      "    const applied = this.#data.eventBridge?.applied ?? [];\n" +
      "    if (!Array.isArray(applied)) return applied.some((entry) => String(entry?.eventId ?? entry) === eventId);\n" +
      "    const state = this.#bridgeWindowFor(applied);\n" +
      "    // A window this instance grows in place may hold markers that have already\n" +
      "    // scrolled out of the logical window; the scan keeps answering over the\n" +
      "    // same last-4096 set the map describes.\n" +
      "    if (state.ids === null) {\n" +
      "      const start = this.#bridgeWindowStart(applied);\n" +
      "      for (let index = start; index < applied.length; index += 1) {\n" +
      "        if (String(applied[index]?.eventId ?? applied[index]) === eventId) return true;\n" +
      "      }\n" +
      "      return false;\n" +
      "    }\n" +
      "    return state.ids.has(eventId);\n" +
      "  }\n" +
      "\n" +
      "  /** First array index the logical bridge window covers. */\n" +
      "  #bridgeWindowStart(applied) {\n" +
      "    return this.#bridgeDeferredAppended && this.#bridgeDeferredWindow === applied\n" +
      "      ? Math.max(0, applied.length - BRIDGE_MARKER_WINDOW) : 0;\n" +
      "  }\n" +
      "\n" +
      "  /** The cached index for exactly this window array, rebuilt when it is another one. */\n" +
      "",
    pre:
      "    const applied = this.#data.eventBridge?.applied ?? [];\n" +
      "    if (!Array.isArray(applied)) return applied.some((entry) => String(entry?.eventId ?? entry) === eventId);\n" +
      "    const state = this.#bridgeWindowFor(applied);\n" +
      "    if (state.ids === null) return applied.some((entry) => String(entry?.eventId ?? entry) === eventId);\n" +
      "    return state.ids.has(eventId);\n" +
      "  }\n" +
      "\n" +
      "  /** The cached index for exactly this window array, rebuilt when it is another one. */\n" +
      "",
  },
  {
    file: "lib/dockyard-domain/memory.js",
    post:
      "  /** The cached index for exactly this window array, rebuilt when it is another one. */\n" +
      "  #bridgeWindowFor(applied) {\n" +
      "    const cached = this.#bridgeWindow;\n" +
      "    if (cached !== undefined && cached.applied === applied && cached.length === applied.length) return cached;\n" +
      "    const start = this.#bridgeWindowStart(applied);\n" +
      "    let ids = new Map();\n" +
      "    for (let index = start; index < applied.length; index += 1) {\n" +
      "      const id = bridgeWindowId(applied[index]);\n" +
      "      if (id === null) { ids = null; break; }\n" +
      "      ids.set(id, (ids.get(id) ?? 0) + 1);\n" +
      "    }\n" +
      "    const state = { applied, length: applied.length, ids };\n" +
      "    this.#bridgeWindow = state;\n" +
      "    return state;\n" +
      "  }\n" +
      "\n" +
      "  /**\n" +
      "   * Carry the index across one in-place append to the growable replay window.\n" +
      "   * The pushed marker is the only new id; once the window holds more than its\n" +
      "   * bound, the entry this append scrolls past is the only one it removes.\n" +
      "   */\n" +
      "  #bridgeWindowPushed(previous, pushed, marker, firstAppend = false) {\n" +
      "    const ids = previous.ids;\n" +
      "    if (ids === null || previous.applied !== pushed) { this.#bridgeWindow = { applied: pushed, length: pushed.length, ids: null }; return; }\n" +
      "    if (firstAppend && previous.length > BRIDGE_MARKER_WINDOW) {\n" +
      "      // A loaded window longer than the bound was indexed in full; this append is\n" +
      "      // the first one that reduces membership to the last 4,096 entries, so the\n" +
      "      // index is rebuilt from them instead of dropping a single head.\n" +
      "      let rebuilt = new Map();\n" +
      "      for (let index = pushed.length - BRIDGE_MARKER_WINDOW; index < pushed.length; index += 1) {\n" +
      "        const id = bridgeWindowId(pushed[index]);\n" +
      "        if (id === null) { rebuilt = null; break; }\n" +
      "        rebuilt.set(id, (rebuilt.get(id) ?? 0) + 1);\n" +
      "      }\n" +
      "      this.#bridgeWindow = { applied: pushed, length: pushed.length, ids: rebuilt };\n" +
      "      return;\n" +
      "    }\n" +
      "    if (pushed.length > BRIDGE_MARKER_WINDOW) {\n" +
      "      const dropped = bridgeWindowId(pushed[pushed.length - BRIDGE_MARKER_WINDOW - 1]);\n" +
      "      if (dropped === null) { this.#bridgeWindow = { applied: pushed, length: pushed.length, ids: null }; return; }\n" +
      "      const remaining = (ids.get(dropped) ?? 0) - 1;\n" +
      "      if (remaining > 0) ids.set(dropped, remaining);\n" +
      "      else ids.delete(dropped);\n" +
      "    }\n" +
      "    const added = bridgeWindowId(marker);\n" +
      "    if (added === null) { this.#bridgeWindow = { applied: pushed, length: pushed.length, ids: null }; return; }\n" +
      "    ids.set(added, (ids.get(added) ?? 0) + 1);\n" +
      "    this.#bridgeWindow = { applied: pushed, length: pushed.length, ids };\n" +
      "  }\n" +
      "\n" +
      "  /**\n" +
      "",
    pre:
      "  /** The cached index for exactly this window array, rebuilt when it is another one. */\n" +
      "  #bridgeWindowFor(applied) {\n" +
      "    const cached = this.#bridgeWindow;\n" +
      "    if (cached !== undefined && cached.applied === applied) return cached;\n" +
      "    let ids = new Map();\n" +
      "    for (const entry of applied) {\n" +
      "      const id = bridgeWindowId(entry);\n" +
      "      if (id === null) { ids = null; break; }\n" +
      "      ids.set(id, (ids.get(id) ?? 0) + 1);\n" +
      "    }\n" +
      "    const state = { applied, ids };\n" +
      "    this.#bridgeWindow = state;\n" +
      "    return state;\n" +
      "  }\n" +
      "\n" +
      "  /**\n" +
      "",
  },
  {
    file: "lib/dockyard-domain/memory.js",
    post:
      "  #bridgeWindowShifted(previous, pushed, trimmed, appended = 0) {\n" +
      "    const dropped = pushed.length + appended - trimmed.length;\n" +
      "    const ids = previous.ids;\n" +
      "    if (ids === null || previous.applied !== pushed) { this.#bridgeWindow = { applied: trimmed, length: trimmed.length, ids: null }; return; }\n" +
      "    for (let index = 0; index < dropped; index += 1) {\n" +
      "      const id = bridgeWindowId(pushed[index]);\n" +
      "      if (id === null) { this.#bridgeWindow = { applied: trimmed, length: trimmed.length, ids: null }; return; }\n" +
      "      const remaining = (ids.get(id) ?? 0) - 1;\n" +
      "      if (remaining > 0) ids.set(id, remaining);\n" +
      "      else ids.delete(id);\n" +
      "",
    pre:
      "  #bridgeWindowShifted(previous, pushed, trimmed, appended = 0) {\n" +
      "    const dropped = pushed.length + appended - trimmed.length;\n" +
      "    const ids = previous.ids;\n" +
      "    if (ids === null || previous.applied !== pushed) { this.#bridgeWindow = { applied: trimmed, ids: null }; return; }\n" +
      "    for (let index = 0; index < dropped; index += 1) {\n" +
      "      const id = bridgeWindowId(pushed[index]);\n" +
      "      if (id === null) { this.#bridgeWindow = { applied: trimmed, ids: null }; return; }\n" +
      "      const remaining = (ids.get(id) ?? 0) - 1;\n" +
      "      if (remaining > 0) ids.set(id, remaining);\n" +
      "      else ids.delete(id);\n" +
      "",
  },
  {
    file: "lib/dockyard-domain/memory.js",
    post:
      "      else ids.delete(id);\n" +
      "    }\n" +
      "    const added = bridgeWindowId(trimmed[trimmed.length - 1]);\n" +
      "    if (added === null) { this.#bridgeWindow = { applied: trimmed, length: trimmed.length, ids: null }; return; }\n" +
      "    ids.set(added, (ids.get(added) ?? 0) + 1);\n" +
      "    this.#bridgeWindow = { applied: trimmed, length: trimmed.length, ids };\n" +
      "  }\n" +
      "\n" +
      "  async #markBridgeApplied(event) {\n" +
      "",
    pre:
      "      else ids.delete(id);\n" +
      "    }\n" +
      "    const added = bridgeWindowId(trimmed[trimmed.length - 1]);\n" +
      "    if (added === null) { this.#bridgeWindow = { applied: trimmed, ids: null }; return; }\n" +
      "    ids.set(added, (ids.get(added) ?? 0) + 1);\n" +
      "    this.#bridgeWindow = { applied: trimmed, ids };\n" +
      "  }\n" +
      "\n" +
      "  async #markBridgeApplied(event) {\n" +
      "",
  },
  {
    file: "lib/dockyard-domain/memory.js",
    post:
      "    // window this instance did not build is indexed first, once, rather than\n" +
      "    // left unindexed for every later lookup.\n" +
      "    const previous = this.#bridgeWindowFor(applied);\n" +
      "    // A marker is written once and never edited afterwards. Freezing it states\n" +
      "    // that as a property of the value instead of a convention, which is what\n" +
      "    // lets the port's transaction store judge a marker once instead of\n" +
      "    // re-serializing the whole window on every save\n" +
      "    // (`assertStagedTransactionSave` in `domain-storage.js`). The staged replay\n" +
      "    // working copy additionally reports each append through its hook; every\n" +
      "    // other store retains the released window handling below.\n" +
      "    const changed = this.transaction?.bridgeWindowChanged;\n" +
      "    const marker = Object.freeze({\n" +
      "      eventId: event.eventId,\n" +
      "      eventType: event.eventType,\n" +
      "      experimentId: event.experimentId,\n" +
      "      appliedAt: timestamp(this.clock),\n" +
      "    });\n" +
      "    const deferred = typeof changed === \"function\"\n" +
      "      && this.#bridgeDeferredWindow === applied\n" +
      "      && previous.ids !== null;\n" +
      "    if (deferred) {\n" +
      "      // The private replay working copy grows its window in place. The append\n" +
      "      // is still reported to the port before the save, with the exact length and\n" +
      "      // tail marker it produced, so the save judges this one marker and nothing\n" +
      "      // it already judged. The window is reduced to its bounded form once every\n" +
      "      // 4,096 appends (a copy of the retained entries only), and `snapshot()`\n" +
      "      // reduces it once at the end; no save rebuilds the frozen successor.\n" +
      "      const firstAppend = this.#bridgeDeferredAppended === false;\n" +
      "      applied.push(marker);\n" +
      "      this.#bridgeDeferredAppended = true;\n" +
      "      this.#bridgeWindowPushed(previous, applied, marker, firstAppend);\n" +
      "      if (applied.length > BRIDGE_MARKER_WINDOW * 2) {\n" +
      "        const next = applied.slice(-BRIDGE_MARKER_WINDOW);\n" +
      "        this.#data.eventBridge = { schema: 1, applied: next };\n" +
      "        this.#bridgeDeferredWindow = next;\n" +
      "        this.#bridgeWindow = { applied: next, length: next.length, ids: this.#bridgeWindow.ids };\n" +
      "        changed(applied, next, marker);\n" +
      "      } else {\n" +
      "        changed(applied, applied, marker);\n" +
      "      }\n" +
      "    } else if (typeof changed === \"function\" && Object.isFrozen(applied)) {\n" +
      "      // This port-owned window has immutable membership. A successor retains\n" +
      "      // at most 4095 old markers and adds exactly this one; its save certificate\n" +
      "      // can therefore inherit the old verdict without rewalking the window.\n" +
      "      this.#bridgeDeferredWindow = null;\n" +
      "      this.#bridgeDeferredAppended = false;\n" +
      "      const start = Math.max(0, applied.length - (BRIDGE_MARKER_WINDOW - 1));\n" +
      "      const next = new Array(applied.length - start + 1);\n" +
      "      for (let index = start; index < applied.length; index += 1) next[index - start] = applied[index];\n" +
      "      next[next.length - 1] = marker;\n" +
      "",
    pre:
      "    // window this instance did not build is indexed first, once, rather than\n" +
      "    // left unindexed for every later lookup.\n" +
      "    const previous = this.#bridgeWindowFor(applied);\n" +
      "    // A marker is written once and never edited afterwards: the window only\n" +
      "    // drops its head and appends a new marker. Freezing it states that as a\n" +
      "    // property of the value instead of a convention, which is what lets the\n" +
      "    // port's transaction store judge a marker once instead of re-serializing the\n" +
      "    // whole window on every save (`assertStagedTransactionSave` in\n" +
      "    // `domain-storage.js`). Ordinary stores retain mutable window arrays; the\n" +
      "    // private staged store opts into immutable membership through its hook.\n" +
      "    const changed = this.transaction?.bridgeWindowChanged;\n" +
      "    if (typeof changed === \"function\" && Object.isFrozen(applied)) {\n" +
      "      // This port-owned window has immutable membership. A successor retains\n" +
      "      // at most 4095 old markers and adds exactly this one; its save certificate\n" +
      "      // can therefore inherit the old verdict without rewalking the window.\n" +
      "      const marker = Object.freeze({\n" +
      "        eventId: event.eventId,\n" +
      "        eventType: event.eventType,\n" +
      "        experimentId: event.experimentId,\n" +
      "        appliedAt: timestamp(this.clock),\n" +
      "      });\n" +
      "      const start = Math.max(0, applied.length - 4095);\n" +
      "      const next = new Array(applied.length - start + 1);\n" +
      "      for (let index = start; index < applied.length; index += 1) next[index - start] = applied[index];\n" +
      "      next[next.length - 1] = marker;\n" +
      "",
  },
  {
    file: "lib/dockyard-domain/memory.js",
    post:
      "      this.#bridgeWindowShifted(previous, applied, next, 1);\n" +
      "      changed(applied, next, marker);\n" +
      "    } else {\n" +
      "      this.#bridgeDeferredWindow = null;\n" +
      "      this.#bridgeDeferredAppended = false;\n" +
      "      applied.push(marker);\n" +
      "      this.#data.eventBridge = { schema: 1, applied: applied.slice(-BRIDGE_MARKER_WINDOW) };\n" +
      "      this.#bridgeWindowShifted(previous, applied, this.#data.eventBridge.applied);\n" +
      "    }\n" +
      "    // In the staged domain transaction, a measurement's first save has already\n" +
      "",
    pre:
      "      this.#bridgeWindowShifted(previous, applied, next, 1);\n" +
      "      changed(applied, next, marker);\n" +
      "    } else {\n" +
      "      applied.push(Object.freeze({\n" +
      "        eventId: event.eventId,\n" +
      "        eventType: event.eventType,\n" +
      "        experimentId: event.experimentId,\n" +
      "        appliedAt: timestamp(this.clock),\n" +
      "      }));\n" +
      "      this.#data.eventBridge = { schema: 1, applied: applied.slice(-4096) };\n" +
      "      this.#bridgeWindowShifted(previous, applied, this.#data.eventBridge.applied);\n" +
      "    }\n" +
      "    // In the staged domain transaction, a measurement's first save has already\n" +
      "",
  },
  {
    file: "lib/dockyard-domain/memory.js",
    post:
      "      canonicalKnowledge: this.#data.knowledge.length,\n" +
      "      canonical: this.#data.canonical.length,\n" +
      "      tombstones: this.#data.tombstones.length,\n" +
      "      bridgeEventsApplied: this.#bridgeDeferredAppended && this.#bridgeDeferredWindow === this.#data.eventBridge?.applied\n" +
      "        ? Math.min(BRIDGE_MARKER_WINDOW, this.#data.eventBridge.applied.length)\n" +
      "        : this.#data.eventBridge?.applied?.length ?? 0,\n" +
      "      provenance: clone(this.#data.provenance),\n" +
      "      successfulStrategies: this.#data.strategies.filter((strategy) => [\"promoted\", \"validated\", \"success\"].includes(strategy.status)).length,\n" +
      "      successfulExperiments: experiments.filter((experiment) => [\"validated\", \"promoted\"].includes(experiment.status)).length,\n" +
      "",
    pre:
      "      canonicalKnowledge: this.#data.knowledge.length,\n" +
      "      canonical: this.#data.canonical.length,\n" +
      "      tombstones: this.#data.tombstones.length,\n" +
      "      bridgeEventsApplied: this.#data.eventBridge?.applied?.length ?? 0,\n" +
      "      provenance: clone(this.#data.provenance),\n" +
      "      successfulStrategies: this.#data.strategies.filter((strategy) => [\"promoted\", \"validated\", \"success\"].includes(strategy.status)).length,\n" +
      "      successfulExperiments: experiments.filter((experiment) => [\"validated\", \"promoted\"].includes(experiment.status)).length,\n" +
      "",
  },
];

/**
 * Reverse this round, then hand the result to the older chain.
 *
 * The caller runs this before every older reversal, so the hunks below always
 * see the working tree's post-change shape. The reversed bytes are pinned to
 * the commit this round started from: a hunk that silently stopped covering
 * part of this round fails here instead of reconstructing a third tree that
 * merely looks plausible.
 */
export function reverseStagedWindowDeferredRound(file, source) {
  if (PINS[file] === undefined) return source;
  for (const { file: target, post, pre } of HUNKS) {
    if (target !== file) continue;
    assert.equal(source.split(post).length - 1, 1, `${file}: deferred marker-window reversal anchor must occur exactly once`);
    source = source.replace(post, pre);
  }
  assert.equal(createHash("sha256").update(source).digest("hex"), PINS[file], `${file}: reversed source must equal 20e2cf0`);
  return source;
}
