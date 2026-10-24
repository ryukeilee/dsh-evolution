import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
/**
 * Release the migration lock only while the path still holds the file this
 * import created.
 *
 * The lock is a cooperative marker (`wx`), not a lease: two cooperating
 * importers never replace each other's entry, so an entry at this path that is
 * not the file `open` returned belongs to whoever wrote it and is left where it
 * is. The identity of the opened file object is what pins "this run's lock"; the
 * content cannot, because the lock carries no owner record. Returns what
 * happened so the caller can report a replacement instead of hiding it.
 */
async function releaseOwnLock(lockPath, identity) {
  let current;
  try { current = await fs.lstat(lockPath, { bigint: true }); }
  catch (error) { if (error?.code === 'ENOENT') return 'missing'; throw error; }
  if (!current.isFile() || String(current.dev) !== identity.dev || String(current.ino) !== identity.ino) return 'replaced';
  await fs.unlink(lockPath);
  return 'released';
}

export async function importEvolutionData({ presetSnapshot, dockyardSnapshot, destination }) {
  presetSnapshot = path.resolve(presetSnapshot);
  destination = path.resolve(destination);
  if (destination === presetSnapshot || destination.startsWith(`${presetSnapshot}${path.sep}`)) throw new Error('Destination must be outside the source snapshot');
  const files = new Map();
  async function add(source, target) {
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) throw new Error(`Source symlink refused: ${source}`);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(source)).sort()) await add(path.join(source, name), path.join(target, name));
    } else if (stat.isFile()) {
      const bytes = await fs.readFile(source);
      if (files.has(target) && !files.get(target).bytes.equals(bytes)) throw new Error(`Import target collision: ${target}`);
      files.set(target, { source, bytes, sha256: hash(bytes) });
    } else throw new Error(`Unsupported source: ${source}`);
  }
  const memory = JSON.parse(await fs.readFile(path.join(presetSnapshot, 'knowledge/evolution-memory.json'), 'utf8'));
  if (memory.schema !== 1 || !Array.isArray(memory.entries)) throw new Error('Unsupported orchestrator memory format');
  try {
    const journal = JSON.parse(await fs.readFile(path.join(presetSnapshot, '.evolution-promotion/journal.json'), 'utf8'));
    if (!['stable-committed', 'committed'].includes(journal.phase)) throw new Error(`Pending legacy promotion requires explicit recovery before import: ${journal.phase}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await add(path.join(presetSnapshot, 'knowledge'), 'legacy-source/preset/knowledge');
  await add(path.join(presetSnapshot, 'EVOLUTION.md'), 'legacy-source/preset/EVOLUTION.md');
  await add(path.join(presetSnapshot, 'knowledge/evolution-memory.json'), 'evolution-memory.json');
  await add(path.join(presetSnapshot, 'EVOLUTION.md'), 'EVOLUTION.md');
  const archiveRoot = path.join(presetSnapshot, 'knowledge/archive');
  for (const year of (await fs.readdir(archiveRoot)).sort()) {
    if (!/^\d{4}$/.test(year)) continue;
    const experiments = path.join(archiveRoot, year, 'experiments');
    try { await add(experiments, 'archive/experiments'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (dockyardSnapshot) {
    const state = JSON.parse(await fs.readFile(path.join(dockyardSnapshot, 'state.json'), 'utf8'));
    if (!state.evolution || !state.desiredState || Object.keys(state).some(k => !['schema', 'evolution', 'desiredState'].includes(k))) throw new Error('Dockyard snapshot must contain only approved Evolution partitions');
    await add(path.resolve(dockyardSnapshot), 'dockyard');
  }
  const manifestFiles = [...files.entries()].map(([target, value]) => ({ target, sha256: value.sha256, bytes: value.bytes.length })).sort((a, b) => a.target.localeCompare(b.target));
  const importId = hash(JSON.stringify(manifestFiles));
  const manifestPath = path.join(destination, 'migration-manifest.json');
  // The completion state of the destination, read as one decision: a matching
  // manifest is `already-imported` evidence, while an existing destination
  // without one is a refusal. `null` means nothing has been published yet.
  async function readCompletion() {
    try {
      const existing = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      if (existing.importId !== importId) throw new Error('Destination was imported from different source content; refusing to merge or overwrite');
      // The active memory may legitimately evolve. Verify immutable source copies,
      // but do not overwrite current runtime data on an idempotent repeat.
      for (const file of existing.files.filter(file => file.target.startsWith('legacy-source/'))) {
        if (hash(await fs.readFile(path.join(destination, file.target))) !== file.sha256) throw new Error(`Immutable import evidence changed: ${file.target}`);
      }
      return { status: 'already-imported', importId, files: existing.files.length };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fs.lstat(destination); throw new Error('Destination already exists without a matching completed import; refusing overwrite'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return null;
  }
  const completed = await readCompletion();
  if (completed) return completed;
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  // Serialize publication, and take the lock before anything is staged: a
  // competing importer that already holds it must fail here with no second copy
  // of the import left beside the destination. `wx` neither replaces nor inspects
  // the entry it finds, so an interrupted import's lock stays where the operator
  // can see it.
  const lockPath = `${destination}.migration.lock`;
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`A migration lock already exists at ${lockPath}; another import owns it or an earlier import was interrupted, so this run staged nothing`);
    throw error;
  }
  // Pin the entry this run created by the file object `open` returned. The entry
  // is opened exclusively, so this identity is available before anything can
  // replace it, and the release below compares the path against it.
  const opened = await lock.stat({ bigint: true });
  const lockIdentity = { dev: String(opened.dev), ino: String(opened.ino) };
  const stage = `${destination}.migration-${crypto.randomUUID()}`;
  let failure = null;
  try {
    // The pre-lock read cannot see an import that finished between it and this
    // acquire: the winning importer's release is what made the path free. Re-read
    // the completion state before staging anything, so this run returns
    // `already-imported` instead of staging a copy the publication must refuse.
    const completedAfterLock = await readCompletion();
    if (completedAfterLock) return completedAfterLock;
    await fs.mkdir(stage, { mode: 0o700 });
    for (const [target, value] of files) {
      const output = path.join(stage, target);
      await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      await fs.writeFile(output, value.bytes, { flag: 'wx', mode: 0o600 });
      if (hash(await fs.readFile(output)) !== value.sha256 || hash(await fs.readFile(value.source)) !== value.sha256) throw new Error(`Import changed or failed verification: ${target}; staging preserved at ${stage}`);
    }
    await fs.writeFile(path.join(stage, 'migration-manifest.json'), JSON.stringify({ schema: 1, importId, importedAt: new Date().toISOString(), files: manifestFiles,
      boundaries: ['No legacy journal/ownership activation', 'No legacy promoted code execution', 'No old environment writes', 'Dockyard data preserved, engine integration pending'] }, null, 2), { flag: 'wx', mode: 0o600 });
    try { await fs.lstat(destination); throw new Error('Destination appeared during import; staged evidence preserved'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(stage, destination);
  } catch (error) { failure = error; throw error; }
  finally {
    await lock.close();
    const release = await releaseOwnLock(lockPath, lockIdentity);
    // A replacement is reported, never removed and never hidden. When this run
    // already failed, its own error is the one the caller needs, so the
    // replacement is surfaced only for a run that otherwise succeeded.
    if (release === 'replaced' && !failure) throw new Error(`The migration lock at ${lockPath} was replaced by another process while this import ran; it was left in place (the import itself completed)`);
  }
  return { status: 'imported', importId, files: manifestFiles.length, memoryEntries: memory.entries.length };
}

// Compared by real path, not by URL spelling, exactly as the release CLIs do.
// Node resolves this module to its real path, so a caller's alias — a symbolic
// link to this script — kept the entry URL distinct from `import.meta.url`. The
// URL comparison then said "not invoked directly", and this importer skipped the
// Usage check as well as the import and exited 0: indistinguishable from a
// completed migration.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return path.resolve(entry) === path.resolve(self);
  }
})();
if (invokedDirectly) {
  const [presetSnapshot, destination, dockyardSnapshot] = process.argv.slice(2);
  if (!presetSnapshot || !destination) throw new Error('Usage: node import-evolution-data.mjs <preset-snapshot> <destination> [dockyard-snapshot]');
  console.log(JSON.stringify(await importEvolutionData({ presetSnapshot, destination, dockyardSnapshot })));
}
