#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { openSharedExperience, experienceEventId } from '../../lib/shared-experience.js';
import { normalizeKnowledgeEvent, mergeKnowledgeEntry } from '../../lib/dockyard-domain/knowledge.js';

const output = process.argv[2];
if (!output) throw new Error('Provide a JSON output path');
const samples = [];
const count = 200;
for (let round = 0; round < 6; round++) {
  for (const variant of round % 2 ? ['B', 'A'] : ['A', 'B']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-experience-bench-'));
    const store = variant === 'B' ? openSharedExperience(root) : null;
    let knowledge = null;
    const latencies = [];
    for (let n = 0; n < count; n++) {
      const id = experienceEventId(round, n);
      const start = performance.now();
      if (store) store.recordFailure({ id, type: 'tool/error', code: 'ENOENT', target: 'tool:read_file' });
      else knowledge = mergeKnowledgeEntry(knowledge, normalizeKnowledgeEvent({ eventId: id, type: 'tool/error', code: 'ENOENT',
        componentId: 'tool:read_file', severity: 'error', status: 'failed', message: 'Official operation failed (ENOENT)' }, { sourceCollection: 'observations' }));
      latencies.push(performance.now() - start);
    }
    const readStart = performance.now();
    if (store) store.recall({ problem: 'read_file' });
    const recallMs = performance.now() - readStart;
    store?.close();
    const ordered = [...latencies].sort((a, b) => a - b);
    samples.push({ round, variant, count, totalMs: latencies.reduce((a, b) => a + b, 0),
      p50Ms: ordered[Math.floor(count * .5)], p95Ms: ordered[Math.floor(count * .95)],
      maxMs: ordered.at(-1), recallMs, rawMs: latencies });
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const result = { node: process.version, platform: `${process.platform}-${process.arch}`, count,
  method: 'Alternating A/B and B/A. A: in-memory existing canonical algorithm; B: same algorithm plus SQLite durable transaction and permanent dedup. Isolated new root per sample; FULL synchronous WAL. No external model. This measures adapter overhead, not Desktop UI or provider billing tokens.', samples };
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(samples.map(({ rawMs, ...sample }) => sample), null, 2));
