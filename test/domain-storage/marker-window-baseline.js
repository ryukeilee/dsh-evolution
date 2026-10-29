// Reverse only the incremental marker-window round before older pinned baselines.
// Exact source anchors and d9de6b2 source hashes prevent a partial reconstruction.
import assert from 'node:assert/strict';
import { reverseTransactionArchiveBatch } from './transaction-archive-batch-baseline.js';
import { createHash } from 'node:crypto';
const HUNKS = [
  {
    "file": "lib/domain-storage.js",
    "post": "    // The bridge markers this transaction's saves reuse verdicts for; it lives\n    // exactly as long as this working store (see `assertStagedTransactionSave`).\n    const markerVerdicts = new WeakMap();\n    const windowChecks = archiveWriteGuard === null ? null : createStagedWindowChecks();\n    // `inlineSerialization` is honest here: `update` captures the bytes of the\n    // payload it is handed with the synchronous `JSON.stringify` below, before\n    // it returns, so the caller's live shallow view cannot change what is\n",
    "pre": "    // The bridge markers this transaction's saves reuse verdicts for; it lives\n    // exactly as long as this working store (see `assertStagedTransactionSave`).\n    const markerVerdicts = new WeakMap();\n    // `inlineSerialization` is honest here: `update` captures the bytes of the\n    // payload it is handed with the synchronous `JSON.stringify` below, before\n    // it returns, so the caller's live shallow view cannot change what is\n"
  },
  {
    "file": "lib/domain-storage.js",
    "post": "      // live value the medium could not store).\n      update: async updater => {\n        const next = updater(aggregate);\n        assertStagedTransactionSave(next, markerVerdicts, windowChecks?.windows);\n        aggregate = next;\n      } };\n    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update, bridgeWindowChanged: windowChecks?.changed }, mutationAuthority: authority, archiveWriteGuard, deferLoadArchiveWrites, archiveReadCache, coalesceMeasurementMarkerPersist: archiveWriteGuard !== null, deferArchiveIndexWrites: archiveWriteGuard !== null });\n    // The load's own work is required (state restore, archive index\n    // reconciliation, eviction and archival); the hot projection it would\n    // return is not: no caller of this factory reads it.\n",
    "pre": "      // live value the medium could not store).\n      update: async updater => {\n        const next = updater(aggregate);\n        assertStagedTransactionSave(next, markerVerdicts);\n        aggregate = next;\n      } };\n    const instance = new EvolutionMemory({ stateStore, transaction: { persist: stateStore.update }, mutationAuthority: authority, archiveWriteGuard, deferLoadArchiveWrites, archiveReadCache, coalesceMeasurementMarkerPersist: archiveWriteGuard !== null, deferArchiveIndexWrites: archiveWriteGuard !== null });\n    // The load's own work is required (state restore, archive index\n    // reconciliation, eviction and archival); the hot projection it would\n    // return is not: no caller of this factory reads it.\n"
  },
  {
    "file": "lib/domain-storage.js",
    "post": " * `assertTransactionSave()` on the same payloads; nothing outside this module\n * calls it.\n */\n// Only the port's private working memory calls changed(): it reports native,\n// dense arrays it just froze, derived by appending one marker to its prior\n// immutable window. It never reports a caller-owned mutable window. Verdicts\n// are still computed at save time, after the document's own serialization.\nexport function createStagedWindowChecks() {\n  const windows = new WeakMap();\n  return { windows, changed(previous, next, marker) {\n    if (!Object.isFrozen(next)) return;\n    windows.set(next, { verified: false, inherited: previous !== null && windows.get(previous)?.verified === true, marker });\n  } };\n}\nexport function assertStagedTransactionSave(payload, verdicts, windows = null) {\n  const whole = () => assertTransactionSave(payload);\n  // The document is rebuilt around the window, so the three members the rebuild\n  // reads and then re-creates must be plain data objects with an own enumerable\n",
    "pre": " * `assertTransactionSave()` on the same payloads; nothing outside this module\n * calls it.\n */\nexport function assertStagedTransactionSave(payload, verdicts) {\n  const whole = () => assertTransactionSave(payload);\n  // The document is rebuilt around the window, so the three members the rebuild\n  // reads and then re-creates must be plain data objects with an own enumerable\n"
  },
  {
    "file": "lib/domain-storage.js",
    "post": "  // the recursive copy it triggers is what can overflow, and it has to see the\n  // whole document. Nothing the window adds can change that verdict.\n  if (text.includes(`\"${PROTO_KEY}\"`)) return whole();\n  // A certificate describes immutable membership, not merely an array identity.\n  // The private memory reports every successor; only its one added marker is\n  // unjudged when its predecessor was verified. Mutable/unreported windows keep\n  // the original complete walk, including its serialization failures.\n  const windowCheck = windows && Object.isFrozen(window) ? windows.get(window) : undefined;\n  if (windowCheck?.verified === true) return;\n  const markers = windowCheck?.inherited === true ? [windowCheck.marker] : window;\n  for (const marker of markers) {\n    let verdict = verdicts.get(marker);\n    if (verdict === undefined) {\n      if (!memoizableMarker(marker)) return whole();\n",
    "pre": "  // the recursive copy it triggers is what can overflow, and it has to see the\n  // whole document. Nothing the window adds can change that verdict.\n  if (text.includes(`\"${PROTO_KEY}\"`)) return whole();\n  for (const marker of window) {\n    let verdict = verdicts.get(marker);\n    if (verdict === undefined) {\n      if (!memoizableMarker(marker)) return whole();\n"
  },
  {
    "file": "lib/domain-storage.js",
    "post": "    }\n    if (verdict) return whole();\n  }\n  if (windowCheck) windowCheck.verified = true;\n}\nexport function projectObservation(input = {}) {\n  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(input.code || '') ? input.code : 'HOST_OPERATION_FAILED';\n",
    "pre": "    }\n    if (verdict) return whole();\n  }\n}\nexport function projectObservation(input = {}) {\n  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(input.code || '') ? input.code : 'HOST_OPERATION_FAILED';\n"
  },
  {
    "file": "lib/dockyard-domain/memory.js",
    "post": "   * the store only reuses a marker whose own fields are all primitive, and keeps\n   * judging any other window in full on every save.\n   *\n   * The private port hook also freezes the owned array's membership, so a save\n   * certificate can cover its already-judged markers. Ordinary stores keep the\n   * same mutable arrays. Only `load()` calls this. A window installed by `restore()` or `reconcile()`\n   * keeps its markers as they are, which costs the store nothing but the\n   * re-serialization it did before (that window cannot be memoized) and cannot\n   * make it accept something the whole-document check would reject.\n",
    "pre": "   * the store only reuses a marker whose own fields are all primitive, and keeps\n   * judging any other window in full on every save.\n   *\n   * Only `load()` calls this. A window installed by `restore()` or `reconcile()`\n   * keeps its markers as they are, which costs the store nothing but the\n   * re-serialization it did before (that window cannot be memoized) and cannot\n   * make it accept something the whole-document check would reject.\n"
  },
  {
    "file": "lib/dockyard-domain/memory.js",
    "post": "    for (const marker of window) {\n      if (!marker || typeof marker !== \"object\" || Array.isArray(marker) || Object.isFrozen(marker)) continue;\n      Object.freeze(marker);\n    }\n    if (typeof this.transaction?.bridgeWindowChanged === \"function\") {\n      Object.freeze(window);\n      this.transaction.bridgeWindowChanged(null, window, null);\n    }\n  }\n\n",
    "pre": "    for (const marker of window) {\n      if (!marker || typeof marker !== \"object\" || Array.isArray(marker) || Object.isFrozen(marker)) continue;\n      Object.freeze(marker);\n    }\n  }\n\n"
  },
  {
    "file": "lib/dockyard-domain/memory.js",
    "post": "   * The map is mutated in place: no reader keeps it past the lookup that reads\n   * it, and re-creating it would cost the scan this exists to avoid.\n   */\n  #bridgeWindowShifted(previous, pushed, trimmed, appended = 0) {\n    const dropped = pushed.length + appended - trimmed.length;\n    const ids = previous.ids;\n    if (ids === null || previous.applied !== pushed) { this.#bridgeWindow = { applied: trimmed, ids: null }; return; }\n    for (let index = 0; index < dropped; index += 1) {\n",
    "pre": "   * The map is mutated in place: no reader keeps it past the lookup that reads\n   * it, and re-creating it would cost the scan this exists to avoid.\n   */\n  #bridgeWindowShifted(previous, pushed, trimmed) {\n    const dropped = pushed.length - trimmed.length;\n    const ids = previous.ids;\n    if (ids === null || previous.applied !== pushed) { this.#bridgeWindow = { applied: trimmed, ids: null }; return; }\n    for (let index = 0; index < dropped; index += 1) {\n"
  },
  {
    "file": "lib/dockyard-domain/memory.js",
    "post": "    // property of the value instead of a convention, which is what lets the\n    // port's transaction store judge a marker once instead of re-serializing the\n    // whole window on every save (`assertStagedTransactionSave` in\n    // `domain-storage.js`). Ordinary stores retain mutable window arrays; the\n    // private staged store opts into immutable membership through its hook.\n    const changed = this.transaction?.bridgeWindowChanged;\n    if (typeof changed === \"function\" && Object.isFrozen(applied)) {\n      // This port-owned window has immutable membership. A successor retains\n      // at most 4095 old markers and adds exactly this one; its save certificate\n      // can therefore inherit the old verdict without rewalking the window.\n      const marker = Object.freeze({\n        eventId: event.eventId,\n        eventType: event.eventType,\n        experimentId: event.experimentId,\n        appliedAt: timestamp(this.clock),\n      });\n      const start = Math.max(0, applied.length - 4095);\n      const next = new Array(applied.length - start + 1);\n      for (let index = start; index < applied.length; index += 1) next[index - start] = applied[index];\n      next[next.length - 1] = marker;\n      Object.freeze(next);\n      this.#data.eventBridge = { schema: 1, applied: next };\n      this.#bridgeWindowShifted(previous, applied, next, 1);\n      changed(applied, next, marker);\n    } else {\n      applied.push(Object.freeze({\n        eventId: event.eventId,\n        eventType: event.eventType,\n        experimentId: event.experimentId,\n        appliedAt: timestamp(this.clock),\n      }));\n      this.#data.eventBridge = { schema: 1, applied: applied.slice(-4096) };\n      this.#bridgeWindowShifted(previous, applied, this.#data.eventBridge.applied);\n    }\n    // In the staged domain transaction, a measurement's first save has already\n    // checked the whole payload before this fixed-shape marker is added, and the\n    // outer mutation publishes the final memory snapshot after apply returns, so\n",
    "pre": "    // property of the value instead of a convention, which is what lets the\n    // port's transaction store judge a marker once instead of re-serializing the\n    // whole window on every save (`assertStagedTransactionSave` in\n    // `domain-storage.js`). The window array itself stays mutable - `#bridgeApplied`\n    // scans it and this method appends to it - and so does the wrapper object.\n    applied.push(Object.freeze({\n      eventId: event.eventId,\n      eventType: event.eventType,\n      experimentId: event.experimentId,\n      appliedAt: timestamp(this.clock),\n    }));\n    this.#data.eventBridge = { schema: 1, applied: applied.slice(-4096) };\n    this.#bridgeWindowShifted(previous, applied, this.#data.eventBridge.applied);\n    // In the staged domain transaction, a measurement's first save has already\n    // checked the whole payload before this fixed-shape marker is added, and the\n    // outer mutation publishes the final memory snapshot after apply returns, so\n"
  }
];
const PINS = {
  "lib/domain-storage.js": "94df08fd2a9efc9c07dc1f498507f1d48024b172be9fac9f8ec006db9c6afaff",
  "lib/dockyard-domain/memory.js": "79cd38f55e662567814379498c3016c3aedbfad4f16d4b10207ae2d32ef5240f"
};
export function reverseMarkerWindowRound(file, source) {
  if (!PINS[file]) return source;
  source = reverseTransactionArchiveBatch(file, source);
  for (const { file: target, post, pre } of HUNKS) {
    if (target !== file) continue;
    assert.equal(source.split(post).length - 1, 1, `${file}: incremental-window reversal anchor must occur exactly once`);
    source = source.replace(post, pre);
  }
  assert.equal(createHash('sha256').update(source).digest('hex'), PINS[file], `${file}: reversed source must equal d9de6b2`);
  return source;
}
