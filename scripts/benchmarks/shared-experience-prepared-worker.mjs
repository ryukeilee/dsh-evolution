#!/usr/bin/env node
// Worker for shared-experience-prepared.mjs. One process per (round, side,
// workload). Every sample uses a fresh isolated root; only the measured call
// window is timed, with open/close reported separately as harness cost.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf('--' + name);
  if (index < 0 || index + 1 >= args.length) throw new Error('missing --' + name);
  return args[index + 1];
};
const moduleFile = option('module');
const workload = option('workload');
const writes = Number(option('writes'));
const samples = Number(option('samples'));
const mod = await import(pathToFileURL(moduleFile).href);

function cpuMs(start) {
  const usage = process.cpuUsage(start);
  return (usage.user + usage.system) / 1000;
}
function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(), 'r12-prepared-')); }
function cleanup(root, store) { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
function recordFailure(store, id, index) {
  store.recordFailure({ id, type: 'tool/error', code: 'ENOENT', target: 'tool:read_file',
    metrics: { attemptsSinceFailure: index + 1, successesSinceFailure: index } });
}

const raw = [];
for (let sample = 0; sample < samples; sample += 1) {
  const root = temporary();
  const openStart = performance.now();
  const store = mod.openSharedExperience(root);
  const openMs = performance.now() - openStart;
  // Warm the JIT and the statement handles without touching measured ids.
  for (let i = 0; i < 8; i += 1) recordFailure(store, mod.experienceEventId('warm', sample, i), i);

  let workWall; let workCpu; let extra = {};
  if (workload === 'writes' || workload === 'duplicates') {
    const setup = workload === 'duplicates';
    const ids = [];
    for (let i = 0; i < writes; i += 1) {
      const id = mod.experienceEventId(workload, sample, i);
      ids.push(id);
      if (setup) recordFailure(store, id, i);
    }
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    for (let i = 0; i < writes; i += 1) recordFailure(store, ids[i], i);
    workWall = performance.now() - wallStart;
    workCpu = cpuMs(cpuStart);
  } else if (workload === 'readcontrol') {
    for (let i = 0; i < writes; i += 1) {
      recordFailure(store, mod.experienceEventId('readctl', sample, i), i);
    }
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    for (let i = 0; i < 3; i += 1) {
      const found = store.findConclusions({ target: 'tool:read_file', strategyFingerprint: 'abcdef12', window: 500 });
      extra = { considered: found.considered, truncated: found.truncated, matches: found.matches.length };
    }
    workWall = performance.now() - wallStart;
    workCpu = cpuMs(cpuStart);
  } else throw new Error('unknown workload ' + workload);

  const dbFile = path.join(root, 'experience.sqlite');
  const dbBytes = fs.statSync(dbFile).size;
  const stats = store.stats();
  const closeStart = performance.now();
  cleanup(root, store);
  const closeMs = performance.now() - closeStart;
  raw.push({ sample, writes, workWallMs: workWall, workCpuMs: workCpu, openMs, closeMs,
    maxRssKb: process.resourceUsage().maxRSS, dbBytes, stats, extra });
}
console.log('RESULT:' + JSON.stringify({ workload, samples, writes, raw }));
