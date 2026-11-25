#!/usr/bin/env node
// One measurement process for scripts/benchmarks/r13-log-prune.mjs.
// Imports planLogPrune() from the tree given by R13_TREE, reads a frozen signed
// log buffer + applied map, warms up, then times R13_ITER planLogPrune calls.
// Emits one JSON line on stdout. All configuration is via env so the runner can
// spawn an identical worker for baseline, candidate and A/A control.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const tree = process.env.R13_TREE;
const logFile = process.env.R13_LOG;
const appliedFile = process.env.R13_APPLIED;
const key = process.env.R13_KEY || 'b'.repeat(64);
const writer = process.env.R13_WRITER || 'dsh-evolution-orchestrator';
const keep = Number(process.env.R13_KEEP || 1);
const iterations = Math.max(1, Number(process.env.R13_ITER || 3));

const { planLogPrune } = await import(pathToFileURL(path.join(tree, 'lib', 'event-log-checkpoint.js')).href);
const buffer = fs.readFileSync(logFile);
const applied = JSON.parse(fs.readFileSync(appliedFile, 'utf8'));
const identity = { dev: '1', ino: '2' };
const call = () => planLogPrune({ buffer, key, writer, applied, retainRecords: keep, identity });

function fingerprint(plan) {
  if (plan === null) return 'null';
  const { prunable, ...rest } = plan;
  return createHash('sha256').update(JSON.stringify({ ...rest, prunable })).digest('hex');
}

for (let index = 0; index < 3; index += 1) call();
const fpBefore = fingerprint(call());
if (global.gc) global.gc();
const cpuStart = process.cpuUsage();
const wallStart = performance.now();
for (let index = 0; index < iterations; index += 1) call();
const cpu = process.cpuUsage(cpuStart);
const wall = performance.now() - wallStart;
// Fingerprinting stringifies the whole pair table, so it is kept outside the
// timed window; the before/after pair still detects any result drift.
const fpAfter = fingerprint(call());
if (fpBefore !== fpAfter) throw new Error('fingerprint drift inside worker');
process.stdout.write(JSON.stringify({
  tree,
  bytes: buffer.length,
  appliedKeys: Object.keys(applied).length,
  keep,
  iterations,
  cpuUserMicros: cpu.user,
  cpuSystemMicros: cpu.system,
  cpuMicros: cpu.user + cpu.system,
  wallMs: wall,
  maxRssKb: process.resourceUsage().maxRSS,
  fingerprint: fpBefore,
}) + '\n');
