#!/usr/bin/env node
// Reuses archive-append-window.mjs's exact fixture/real backend and child workload.
// Production sources are only instrumented in an extracted temporary git tree.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const ref = arg('ref', 'd9de6b2');
const rounds = Number(arg('rounds', '3'));
const records = Number(arg('records', '20000'));
const modes = arg('modes', 'control,detail,cpu,allocation').split(',');
const output = path.resolve(arg('out', 'docs/performance/cold-apply-cost-d9de6b2-20261029.json'));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-apply-audit-tree-'));
const A = 'globalThis.__coldAudit';
function replace(source, from, to) {
  assert.equal(source.split(from).length - 1, 1, `probe anchor must be unique: ${from.slice(0, 100)}`);
  return source.replace(from, to);
}
function instrument(tree, mode) {
  const detail = mode === 'detail';
  let domain = fs.readFileSync(path.join(tree, 'lib/domain-storage.js'), 'utf8');
  const probes = [
    ['    const plan = planEventLogReplay(', `    ${A}.phase('plan');\n    const plan = planEventLogReplay(`],
    ['    if (!plan) return { applied: 0, duplicates: 0 };', `    ${A}.phase('authenticate');\n    if (!plan) return { applied: 0, duplicates: 0 };`],
    ['    const committed = domain.global.get();', `    ${A}.phase('transaction-prepare');\n    const committed = domain.global.get();`],
    ['    const result = await work(current.instance, store, { recovered });', `    ${A}.phase('apply');\n    const result = await work(current.instance, store, { recovered });\n    ${A}.phase('publish');`],
    ['    await hydrate(current.instance.archiveReadCache);', `    await hydrate(current.instance.archiveReadCache);\n    ${A}.phase('checkpoint');`],
    ['        assertStagedTransactionSave(next, markerVerdicts);', `        ${A}.sync('save.check', () => assertStagedTransactionSave(next, markerVerdicts));`],
    ['  const text = JSON.stringify({ ...payload, evolution: { ...state, eventBridge: { ...bridge, applied: EMPTY_WINDOW } } });', `  const text = ${A}.text('save.remainder.stringify', () => JSON.stringify({ ...payload, evolution: { ...state, eventBridge: { ...bridge, applied: EMPTY_WINDOW } } }));`],
    ['  for (const marker of window) {\n    let verdict', `  ${A}.count('save.marker.visits', window.length);\n  const __markerToken = ${A}.begin('save.marker.loop');\n  try { for (const marker of window) {\n    let verdict`],
    ['      const markerText = JSON.stringify(marker);', `      const __markerStringifyToken = ${A}.begin('save.marker.stringify');\n      const markerText = JSON.stringify(marker);\n      ${A}.endText(__markerStringifyToken, markerText);`],
    ['    if (verdict) return whole();\n  }\n}\nexport function projectObservation', `    if (verdict) return whole();\n  } } finally { ${A}.end(__markerToken); }\n}\nexport function projectObservation`],
  ];
  for (const [index, [from, to]] of probes.entries()) { if (detail || index < 5 || (['saveonly', 'savecpu'].includes(mode) && index === 5)) domain = replace(domain, from, to); }
  fs.writeFileSync(path.join(tree, 'lib/domain-storage.js'), domain);
  if (!detail) return;
  let memory = fs.readFileSync(path.join(tree, 'lib/dockyard-domain/memory.js'), 'utf8');
  const memoryProbes = [
    ['  async #save({ skipTransactionPersist = false } = {}) {', `  async #save({ skipTransactionPersist = false } = {}) {\n    const __saveToken = ${A}.begin(skipTransactionPersist ? 'memory.save.skip' : 'memory.save.persist'); try {`],
    ['    await this.saving;\n  }', `    await this.saving;\n    } finally { ${A}.end(__saveToken); }\n  }`],
    ['    try { this.#performHousekeeping(); } catch {}\n    if (!this.stateStore) return;', `    try { ${A}.sync('memory.housekeeping', () => this.#performHousekeeping()); } catch {}\n    if (!this.stateStore) return;`],
    ['  async #archiveEntries(collection, entries, { replaceExisting = false } = {}) {', `  async #archiveEntries(collection, entries, { replaceExisting = false } = {}) {\n    const __archiveToken = ${A}.begin('memory.archive'); try {`],
    ['    return queued;\n  }\n\n\n  #mergeArchived', `    return await queued;\n    } finally { ${A}.end(__archiveToken); }\n  }\n\n\n  #mergeArchived`],
    ['  async #markBridgeApplied(event) {', `  async #markBridgeApplied(event) {\n    const __bridgeToken = ${A}.begin('memory.markBridge'); try {`],
    ['    await this.#save({ skipTransactionPersist });\n  }', `    await this.#save({ skipTransactionPersist });\n    } finally { ${A}.end(__bridgeToken); }\n  }`],
  ];
  for (const [from, to] of memoryProbes) memory = replace(memory, from, to);
  fs.writeFileSync(path.join(tree, 'lib/dockyard-domain/memory.js'), memory);
}
const report = { benchmarkHashes: Object.fromEntries(['archive-append-window.mjs', 'archive-apply-cost-audit.mjs', 'archive-apply-cost-hooks.mjs'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, 'scripts/benchmarks', file))).digest('hex')])), ref, sha: execFileSync('git', ['rev-parse', `${ref}^{commit}`], { cwd: REPO, encoding: 'utf8' }).trim(), node: process.version, platform: `${process.platform}/${process.arch}`, records, rounds, modes, method: 'Alternating control/detail ordering; cold-only profiling; extracted source probes; 4096 MiB heap; synthetic temporary roots', sourceHashes: {}, runs: [] };
try {
  execFileSync('tar', ['-x', '-C', directory], { input: execFileSync('git', ['archive', ref, 'lib', 'package.json', 'package-lock.json'], { cwd: REPO, maxBuffer: 1 << 28 }) });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  const original = {};
  for (const file of ['lib/domain-storage.js', 'lib/dockyard-domain/memory.js']) {
    original[file] = fs.readFileSync(path.join(directory, file));
    report.sourceHashes[file] = crypto.createHash('sha256').update(original[file]).digest('hex');
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 ? [...modes].reverse() : modes;
    for (const mode of order) {
      for (const [file, bytes] of Object.entries(original)) fs.writeFileSync(path.join(directory, file), bytes);
      if (mode !== 'control') instrument(directory, mode);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cold-apply-audit-data-'));
      const profileFile = `${output}.${mode}-${round}.${mode === 'cpu' ? 'cpuprofile' : 'heapprofile'}`;
      try {
        const result = execFileSync(process.execPath, ['--expose-gc', '--max-old-space-size=4096', path.join(REPO, 'scripts/benchmarks/archive-append-window.mjs'), '--child'], {
          cwd: REPO, env: { ...process.env, BENCH_ROOT: root, BENCH_TREE: directory, BENCH_ENVELOPE: REPO, BENCH_RECORDS: String(records), BENCH_OBSERVES: '0', BENCH_FLUSHES: '0', BENCH_AUDIT_MODE: mode, BENCH_AUDIT_MODULE: pathToFileURL(path.join(REPO, 'scripts/benchmarks/archive-apply-cost-hooks.mjs')).href, BENCH_AUDIT_PROFILE: profileFile }, maxBuffer: 1 << 25, timeout: 120000,
        });
        const row = JSON.parse(result.toString());
        if (mode === 'detail') {
          assert.equal(row.audit.rows['save.check'].calls, records);
          assert.equal(row.audit.rows['save.marker.visits'].calls, Array.from({ length: records }, (_, i) => Math.min(i, 4096)).reduce((a, b) => a + b, 0));
          assert.equal(row.audit.rows['save.marker.stringify'].calls, records - 1);
          assert.equal(row.audit.rows['io.apply.appendFile'].calls, Math.max(0, records - 50));
        }
        report.runs.push({ round, mode, ...row, ...(['cpu', 'allocation'].includes(mode) ? { profileFile: path.basename(profileFile) } : {}) });
        console.log(`${mode} round=${round} cold=${row.absorption.wallMs.toFixed(1)}ms cpu=${row.absorption.cpuMs.toFixed(1)}ms`);
        fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  }
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
console.log(`wrote ${output}`);
