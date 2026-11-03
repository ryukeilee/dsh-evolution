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
import { reverseAutonomousRound } from './autonomous-round-baseline.js';

const HUNKS = [
  {
    file: "lib/dockyard-domain/memory.js",
    post: "      // Undo exactly the steps this call completed, including an item whose\n      // rename failed before it could be added to `applied`; otherwise a crash\n      // between moving the old path and installing the new layout could strand\n      // the backup. Two directions per item: the new archive file and the new\n      // segment directory this call installed are removed first, then the\n      // originals that were actually moved aside are restored. An item this call\n      // never touched has neither flag, so it keeps its bytes - the pre-fix loop\n      // deleted the path of every staged item, which destroyed the archives of the\n      // collections the transaction had not reached yet.\n      const restoreFailures = [];\n      for (const item of [...staged].reverse()) {\n        if (item.pathInstalled) {\n          await rm(item.path, { force: true }).catch((restoreError) => { restoreFailures.push({ path: item.path, error: String(restoreError?.code ?? restoreError) }); });\n        }\n        if (item.directoryInstalled) {\n          await rm(item.directory, { recursive: true, force: true }).catch((restoreError) => { restoreFailures.push({ path: item.directory, error: String(restoreError?.code ?? restoreError) }); });\n        }\n        if (item.directoryMoved) {\n          await rename(item.directoryBackup, item.directory).catch((restoreError) => { restoreFailures.push({ path: item.directory, error: String(restoreError?.code ?? restoreError) }); });\n        }\n        if (item.pathMoved) {\n          await rename(item.backup, item.path).catch((restoreError) => { restoreFailures.push({ path: item.path, error: String(restoreError?.code ?? restoreError) }); });\n        }\n      }\n      if (restoreFailures.length > 0 && error && (typeof error === \"object\" || typeof error === \"function\")) {\n        // The compaction error stays the one the caller sees; a restore that also\n        // failed is attached instead of being dropped, because it names a backup\n        // an operator has to move back by hand.\n        try { error.restoreFailures = restoreFailures; } catch {}\n      }\n",
    pre: "      // Restore every staged item, including one whose rename failed before\n      // it could be added to `applied`; otherwise a crash between moving the\n      // old path and installing the new layout could strand the backup.\n      for (const item of [...staged].reverse()) {\n        await rm(item.path, { force: true }).catch(() => {});\n        await rm(item.directory, { recursive: true, force: true }).catch(() => {});\n        if (item.hasPath) await rename(item.backup, item.path).catch(() => {});\n        if (item.hasDirectory) await rename(item.directoryBackup, item.directory).catch(() => {});\n      }\n",
    pre: "      // Restore every staged item, including one whose rename failed before\n      // it could be added to `applied`; otherwise a crash between moving the\n      // old path and installing the new layout could strand the backup.\n      for (const item of [...staged].reverse()) {\n        await rm(item.path, { force: true }).catch(() => {});\n        await rm(item.directory, { recursive: true, force: true }).catch(() => {});\n        if (item.hasPath) await rename(item.backup, item.path).catch(() => {});\n        if (item.hasDirectory) await rename(item.directoryBackup, item.directory).catch(() => {});\n      }\n",
  },
  {
    file: "lib/dockyard-domain/memory.js",
    post: "      for (const item of staged) {\n        // Each completed rename is recorded, because the cleanup has to undo\n        // exactly the steps this call performed: a collection whose original was\n        // never moved and whose archive file was never installed must be left\n        // byte-identical, and a *new* segment directory this call installed must\n        // be removed again even though it has no backup to restore.\n        if (item.hasPath) { await rename(item.path, item.backup); item.pathMoved = true; }\n        if (item.hasDirectory) { await rename(item.directory, item.directoryBackup); item.directoryMoved = true; }\n        await rename(item.temporaryDirectory, item.directory);\n        item.directoryInstalled = true;\n        await rename(item.temporary, item.path);\n        item.pathInstalled = true;\n",
    pre: "      for (const item of staged) {\n        if (item.hasPath) await rename(item.path, item.backup);\n        if (item.hasDirectory) await rename(item.directory, item.directoryBackup);\n        await rename(item.temporaryDirectory, item.directory);\n        await rename(item.temporary, item.path);\n",
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
  source = reverseAutonomousRound(file, source);
  if (file !== "lib/dockyard-domain/memory.js") return source;
  for (const { post, pre } of HUNKS) {
    assert.equal(source.split(post).length - 1, 1, `${file}: quality-round reversal anchor must occur exactly once`);
    source = source.replace(post, pre);
  }
  return source;
}
