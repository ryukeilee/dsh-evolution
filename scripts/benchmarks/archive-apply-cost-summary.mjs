#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
const readJSON = file => JSON.parse((file.endsWith('.gz') ? gunzipSync(fs.readFileSync(file)) : fs.readFileSync(file)).toString());
const input = path.resolve(process.argv[2]);
const report = JSON.parse(fs.readFileSync(input, 'utf8'));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = n => Number(n.toFixed(3));
const modes = Object.fromEntries(report.modes.map(mode => [mode, report.runs.filter(run => run.mode === mode)]));
const result = { source: path.basename(input), note: 'Nested timers overlap. CPU sample phase alignment uses the locally recorded Profiler.start call time, with startup-boundary uncertainty. Heap sampling includes collected objects and estimates allocation traffic; it is not retained memory.', modes: {}, detail: {}, cpu: [], allocation: [] };
for (const [mode, runs] of Object.entries(modes)) result.modes[mode] = {
  wallMs: round(median(runs.map(run => run.absorption.wallMs))), cpuMs: round(median(runs.map(run => run.absorption.cpuMs))),
  wallRange: [Math.min(...runs.map(run => run.absorption.wallMs)), Math.max(...runs.map(run => run.absorption.wallMs))].map(round),
  gcDurationMs: round(median(runs.map(run => run.audit.gc.reduce((sum, entry) => sum + entry.duration, 0)))),
};
for (const key of new Set((modes.detail ?? []).flatMap(run => Object.keys(run.audit.rows)))) {
  const rows = modes.detail.map(run => run.audit.rows[key]).filter(Boolean);
  result.detail[key] = Object.fromEntries(['calls', 'wallMs', 'bytes', 'cpuMs'].filter(key => rows[0][key] !== undefined).map(key => [key, round(median(rows.map(row => row[key])))]));
}
for (const run of modes.cpu ?? []) {
  const profile = readJSON(path.join(path.dirname(input), run.profileFile));
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const phases = Object.fromEntries(Object.entries(run.audit.rows).filter(([name]) => name.startsWith('phase.')).map(([name, row]) => [name.slice(6), row]));
  const buckets = {}, inclusive = {};
  let elapsed = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const duration = profile.timeDeltas[i] / 1000;
    elapsed += duration;
    const local = run.audit.profilerStart + elapsed;
    const phase = Object.entries(phases).find(([, row]) => local >= row.startTime && local <= row.endTime)?.[0];
    if (!phase) continue;
    const node = nodes.get(profile.samples[i]), f = node.callFrame;
    const key = `${f.functionName || '<anonymous>'} (${f.url.split('/').at(-1)}:${f.lineNumber + 1})`;
    const bucket = buckets[phase] ??= {};
    bucket[key] = (bucket[key] ?? 0) + duration;
    let current = node;
    while (current) {
      const name = current.callFrame.functionName;
      if (['assertStagedTransactionSave', '#archiveEntries', '#save', '#markBridgeApplied'].includes(name)) inclusive[`${phase}.${name}`] = (inclusive[`${phase}.${name}`] ?? 0) + duration;
      current = nodes.get(parent.get(current.id));
    }
  }
  result.cpu.push({ round: run.round, inclusiveMs: Object.fromEntries(Object.entries(inclusive).map(([key, value]) => [key, round(value)])), phases: Object.fromEntries(Object.entries(buckets).map(([phase, bucket]) => [phase, { totalMs: round(Object.values(bucket).reduce((a, b) => a + b, 0)), self: Object.entries(bucket).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([frame, ms]) => ({ frame, ms: round(ms) })) }])) });
}
for (const run of modes.allocation ?? []) {
  const profile = readJSON(path.join(path.dirname(input), run.profileFile));
  const self = {}, grouped = {};
  let total = 0;
  const walk = (node, ancestors) => {
    const f = node.callFrame;
    const key = `${f.functionName || '<anonymous>'} (${f.url.split('/').at(-1)}:${f.lineNumber + 1})`;
    self[key] = (self[key] ?? 0) + node.selfSize; total += node.selfSize;
    const names = ancestors.map(frame => frame.functionName);
    const group = names.includes('#markBridgeApplied') || f.functionName === '#markBridgeApplied' ? 'markBridge'
      : names.includes('assertStagedTransactionSave') || f.functionName === 'assertStagedTransactionSave' ? 'saveCheck'
      : names.includes('canonicalBridgeJson') || f.functionName === 'canonicalBridgeJson' ? 'authenticateCanonicalJSON'
      : 'other';
    grouped[group] = (grouped[group] ?? 0) + node.selfSize;
    for (const child of node.children) walk(child, [...ancestors, f]);
  };
  walk(profile.head, []);
  result.allocation.push({ round: run.round, estimatedMiB: round(total / 1048576), groupedMiB: Object.fromEntries(Object.entries(grouped).map(([key, bytes]) => [key, round(bytes / 1048576)])), self: Object.entries(self).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([frame, bytes]) => ({ frame, estimatedMiB: round(bytes / 1048576) })) });
}
const output = input.replace(/\.json$/, '-summary.json');
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ output, modes: result.modes, detail: result.detail, cpu: result.cpu.map(run => ({round:run.round, inclusiveMs:run.inclusiveMs,apply:run.phases.apply})), allocation:result.allocation.map(run=>({round:run.round,estimatedMiB:run.estimatedMiB,groupedMiB:run.groupedMiB,self:run.self.slice(0,5)})) }, null, 2));
