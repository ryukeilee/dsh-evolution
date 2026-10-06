import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

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
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const stage = `${destination}.migration-${crypto.randomUUID()}`;
  await fs.mkdir(stage, { mode: 0o700 });
  for (const [target, value] of files) {
    const output = path.join(stage, target);
    await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    await fs.writeFile(output, value.bytes, { flag: 'wx', mode: 0o600 });
    if (hash(await fs.readFile(output)) !== value.sha256 || hash(await fs.readFile(value.source)) !== value.sha256) throw new Error(`Import changed or failed verification: ${target}; staging preserved at ${stage}`);
  }
  await fs.writeFile(path.join(stage, 'migration-manifest.json'), JSON.stringify({ schema: 1, importId, importedAt: new Date().toISOString(), files: manifestFiles,
    boundaries: ['No legacy journal/ownership activation', 'No legacy promoted code execution', 'No old environment writes', 'Dockyard data preserved, engine integration pending'] }, null, 2), { flag: 'wx', mode: 0o600 });
  // Serialize publication; a competing importer cannot replace a completed root.
  const lockPath = `${destination}.migration.lock`;
  const lock = await fs.open(lockPath, 'wx', 0o600);
  try {
    try { await fs.lstat(destination); throw new Error('Destination appeared during import; staged evidence preserved'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(stage, destination);
  } finally { await lock.close(); await fs.unlink(lockPath); }
  return { status: 'imported', importId, files: manifestFiles.length, memoryEntries: memory.entries.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [presetSnapshot, destination, dockyardSnapshot] = process.argv.slice(2);
  if (!presetSnapshot || !destination) throw new Error('Usage: node import-evolution-data.mjs <preset-snapshot> <destination> [dockyard-snapshot]');
  console.log(JSON.stringify(await importEvolutionData({ presetSnapshot, destination, dockyardSnapshot })));
}
