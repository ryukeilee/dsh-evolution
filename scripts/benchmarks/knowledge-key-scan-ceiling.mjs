// Diagnostic only: bound the remaining cold-key scan cost on archive-miss
// workloads. --indexed instead tests a parse-bound reverse index. Both are
// temporary experiments. The oracle is invalid for cold hits; never ship it.
// The existing real-store driver checks output and durable-tree equivalence.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '../..');
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};
const sizes = option('sizes', '1000,10000,40000').split(',').map(Number);
const rounds = option('rounds', '5');
const samples = option('samples', '20');
const output = option('out', null);
const compact = process.argv.includes('--compact');
const indexed = compact || process.argv.includes('--indexed');
const temp = mkdtempSync(join(tmpdir(), 'dsh-key-scan-ceiling-'));
try {
  const baseline = join(temp, 'baseline');
  const oracle = join(temp, 'oracle');
  for (const directory of [baseline, oracle]) {
    cpSync(join(root, 'lib'), join(directory, 'lib'), { recursive: true });
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  }
  const memoryFile = join(oracle, 'lib/dockyard-domain/memory.js');
  const before = readFileSync(memoryFile, 'utf8');
  let source = before;
  for (const [start, end] of [['  #knowledgeEntryFor(event)', '  async #upsertKnowledgeUnlocked'], ['  #sourceMatches(collection, event)', '  #shouldRetainSource']]) {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    const body = source.slice(from, to);
    assert.equal(body.split('    if (state) {').length, 2);
    source = source.slice(0, from) + body.replace('    if (state) {', '    if (false && state) { // diagnostic oracle: fixture has no cold matches') + source.slice(to);
  }
  if (indexed) {
    source = before;
    for (const [start, end, collection] of [['  #knowledgeEntryFor(event)', '  async #upsertKnowledgeUnlocked', '"knowledge"'], ['  #sourceMatches(collection, event)', '  #shouldRetainSource', 'collection']]) {
      const from = source.indexOf(start), to = source.indexOf(end, from);
      const body = source.slice(from, to);
      const loop = 'for (let position = 0; position < state.keys.length; position += 1)';
      assert.equal(body.split(loop).length, 2);
      source = source.slice(0, from) + body.replace(loop, `for (const position of this.#indexedKnowledgePositions(state, key, hotById, ${collection}))`) + source.slice(to);
    }
    source = source.replace('  #knowledgeEntryFor(event)', `  // Experimental candidate, not production code. Rebuild after parse extension.
  #indexedKnowledgePositions(state, key, hotById, collection) {
    let lookup = state.experimentalKnowledgeLookup;
    if (!lookup || lookup.keys !== state.keys) {
      const byKey = new Map(), anonymous = [];
      const add = (key, position) => {
        if (typeof key !== "string") return;
        let positions = byKey.get(key);
        if (!positions) byKey.set(key, positions = []);
        if (positions.at(-1) !== position) positions.push(position);
      };
      for (let position = 0; position < state.keys.length; position += 1) {
        const rowKey = state.keys[position];
        if (!rowKey.startsWith("id:")) { anonymous.push(position); continue; }
        add(state.storedKeys[position], position);
        if (collection === "knowledge") add(rowKey.slice(3), position);
        else add(state.derivedKeys[position], position);
      }
      lookup = { keys: state.keys, byKey, anonymous };
      state.experimentalKnowledgeLookup = lookup;
    }
    const positions = new Set(lookup.byKey.get(key) ?? []);
    for (const id of hotById.keys()) {
      const position = state.positions.get("id:" + id);
      if (position !== undefined) positions.add(position);
    }
    for (const position of lookup.anonymous) positions.add(position);
    return [...positions].sort((a, b) => a - b);
  }

  #knowledgeEntryFor(event)`);
  }
  if (compact) {
    const start = source.indexOf('    let lookup = state.experimentalKnowledgeLookup;');
    const end = source.indexOf('    const positions = new Set(lookup.byKey.get(key) ?? []);', start);
    assert.ok(start > 0 && end > start);
    source = source.slice(0, start) + `    let lookup = state.experimentalKnowledgeLookup;
    if (!lookup || lookup.keys !== state.keys) {
      const stored = [], derived = [], anonymous = [];
      for (let position = 0; position < state.keys.length; position += 1) {
        if (!state.keys[position].startsWith("id:")) { anonymous.push(position); continue; }
        if (typeof state.storedKeys[position] === "string") stored.push(position);
        if (collection !== "knowledge" && typeof state.derivedKeys[position] === "string"
          && state.derivedKeys[position] !== state.storedKeys[position]) derived.push(position);
      }
      const sorted = (positions, keys) => Uint32Array.from(positions).sort((a, b) => keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : a - b);
      lookup = { keys: state.keys, stored: sorted(stored, state.storedKeys), derived: sorted(derived, state.derivedKeys), anonymous };
      state.experimentalKnowledgeLookup = lookup;
    }
    const positions = new Set();
    const collect = (sorted, keys) => {
      let low = 0, high = sorted.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (keys[sorted[mid]] < key) low = mid + 1;
        else high = mid;
      }
      for (; low < sorted.length && keys[sorted[low]] === key; low += 1) positions.add(sorted[low]);
    };
    collect(lookup.stored, state.storedKeys);
    collect(lookup.derived, state.derivedKeys);
    if (collection === "knowledge") {
      const position = state.positions.get("id:" + key);
      if (position !== undefined) positions.add(position);
    }
` + source.slice(end + '    const positions = new Set(lookup.byKey.get(key) ?? []);'.length);
  }
  writeFileSync(memoryFile, source);
  const report = {
    experiment: compact ? 'sorted-position index' : indexed ? 'parse-bound reverse index' : 'zero-scan oracle',
    baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    memorySha256: createHash('sha256').update(before).digest('hex'),
    protocol: 'baseline and candidate are identical current sources (A/A); variant1 is the experiment named above. Rotating order, real official storage, frozen clock, per-round returned records and durable tree equality. Oracle is not generally correct; equivalence covers only these fixtures.',
    runs: [],
  };
  for (const rows of sizes) for (const workload of ['repeat', 'evict']) {
    const args = ['--max-old-space-size=4096', '--expose-gc', join(root, 'scripts/benchmarks/observe-cold-archive.mjs'),
      '--baseline', join(baseline, 'lib'), '--variant', join(oracle, 'lib'), '--rows', String(rows), '--knowledge-rows', String(rows),
      '--rounds', rounds, '--samples', samples, '--warmup', workload === 'evict' ? '51' : '3', '--workload', workload, '--retained', '--json'];
    const run = JSON.parse(execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    report.runs.push(run);
    process.stderr.write(`${rows} ${workload}: AA ${run.delta.wallPct.toFixed(2)}%, ${report.experiment} ${run.variantResults[0].wallPct.toFixed(2)}%\n`);
    if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
  if (!output) console.log(JSON.stringify(report, null, 2));
} finally { rmSync(temp, { recursive: true, force: true }); }
