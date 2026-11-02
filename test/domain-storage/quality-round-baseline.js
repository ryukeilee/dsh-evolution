// Reverse the quality round's cold-archive rollback fix before older pinned
// baselines reconstruct their trees.
//
// This round only changes the failure path of `EvolutionMemory#rewriteArchives()`:
// the cleanup now restores the steps the transaction actually completed instead
// of deleting every staged path (which destroyed the archives of collections the
// transaction had not touched yet). The differential baselines below reconstruct
// older trees by reversing rounds newest-first, so this hunk has to run before
// the first of them, or their anchors and pins no longer describe history.
import assert from 'node:assert/strict';

const HUNKS = [
  {
    file: "lib/dockyard-domain/memory.js",
    post: "      // Restore exactly the steps this call completed, including an item whose\n      // rename failed before it could be added to `applied`: otherwise a crash\n      // between moving the old path and installing the new layout could strand\n      // the backup. An item whose original was never moved has no backup, and\n      // deleting its path (as the pre-fix loop did to every staged item) would\n      // destroy an archive this call had not touched at all - the untouched\n      // collections of a transaction that failed on its first one.\n      const restoreFailures = [];\n      for (const item of [...staged].reverse()) {\n        if (item.hasPath && await exists(item.backup)) {\n          await rm(item.path, { force: true }).catch(() => {});\n          await rename(item.backup, item.path).catch((restoreError) => { restoreFailures.push({ path: item.path, error: String(restoreError?.code ?? restoreError) }); });\n        }\n        if (item.hasDirectory && await exists(item.directoryBackup)) {\n          await rm(item.directory, { recursive: true, force: true }).catch(() => {});\n          await rename(item.directoryBackup, item.directory).catch((restoreError) => { restoreFailures.push({ path: item.directory, error: String(restoreError?.code ?? restoreError) }); });\n        }\n      }\n      if (restoreFailures.length > 0 && error && (typeof error === \"object\" || typeof error === \"function\")) {\n        // The compaction error stays the one the caller sees; a restore that also\n        // failed is attached instead of being dropped, because it names a backup\n        // an operator has to move back by hand.\n        try { error.restoreFailures = restoreFailures; } catch {}\n      }\n",
    pre: "      // Restore every staged item, including one whose rename failed before\n      // it could be added to `applied`; otherwise a crash between moving the\n      // old path and installing the new layout could strand the backup.\n      for (const item of [...staged].reverse()) {\n        await rm(item.path, { force: true }).catch(() => {});\n        await rm(item.directory, { recursive: true, force: true }).catch(() => {});\n        if (item.hasPath) await rename(item.backup, item.path).catch(() => {});\n        if (item.hasDirectory) await rename(item.directoryBackup, item.directory).catch(() => {});\n      }\n",
  },
];

/**
 * No digest pin of its own: the tree this reverses to still carries every later
 * round the older baselines reverse next, so their own pins are what prove the
 * reconstruction landed on history. A pin here would repeat those numbers while
 * pretending to describe a different tree. What this hunk must prove is that it
 * still matches the fix exactly once.
 */
export function reverseQualityRound(file, source) {
  if (file !== "lib/dockyard-domain/memory.js") return source;
  for (const { post, pre } of HUNKS) {
    assert.equal(source.split(post).length - 1, 1, `${file}: quality-round reversal anchor must occur exactly once`);
    source = source.replace(post, pre);
  }
  return source;
}
