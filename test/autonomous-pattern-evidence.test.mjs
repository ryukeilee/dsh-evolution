// One pattern's evidence window must survive the *other* faults a session sees.
//
// The durable read (`autonomousObservations`) is a bounded tail of the whole
// observation collection: every failing tool call and every provider error is one
// force-recorded row, whatever pattern it belongs to. The observer used that tail
// as a *replacement* for the session's own per-pattern window, so a pattern's
// committed occurrences were thrown away as soon as unrelated faults filled the
// tail. On the fixture below the loop then answered a fault it had already
// recorded twice with `pattern-observing, occurrences: 1` and never reached
// `patternThreshold` - the strategy, the isolated Trial and the measurement never
// ran at all. The faults this costs most are the rare-but-recurring ones, which
// are exactly the ones worth fixing.
//
// What this must not become is a second source of truth: the durable half still
// carries the cross-session count, an occurrence that both halves know about
// counts once, and the union stays bounded by the existing per-pattern window.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';

import { openDomainStorage } from '../lib/domain-storage.js';
import { apply } from '../lib/registration.js';
import { context } from './fixtures/runtime-inspect.mjs';

// The durable read keeps the newest 200 rows of the collection. Churn has to
// cross that bound while staying under the pattern table's own cap, which is what
// a busy session does: repeats of a few faults write rows faster than they write
// new patterns.
const DURABLE_ROW_WINDOW = 200;
const NOISE_PATTERNS = 120;
const NOISE_REPEATS = 2;
const THRESHOLD = 3;

const MEDIUM = { risk: 'medium', target: 'plugin:rare-fault' };

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-pattern-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return async function session() {
    const backend = new JsonStorageBackend(path.join(root, 'official'));
    const ctx = { ...context(), emit() {}, effect() {}, logger: { warn() {} }, on() {},
      storage: { backend: { get: () => backend } },
      dynamicCordisRunner: { snapshot: () => [], define: () => ({ pluginId: 'p', packageId: 'k' }),
        run: async () => ({ ok: true, status: 'active' }), stop: async () => ({ ok: true }), undefine: async () => ({ ok: true }) },
      tools: { register() {}, schemas: () => [] }, systemPrompt: { section() {} } };
    ctx.storageDomain = new DomainFacility(ctx, { backend: 'json' });
    const config = { presetDir: root, eventBridgePath: path.join(root, 'events.jsonl'), eventBridgeKey: 'e'.repeat(64),
      startupDrift: false, patternThreshold: THRESHOLD, autonomousStrategies: { AGENT_ERROR: MEDIUM } };
    const port = await openDomainStorage(ctx, config);
    const core = apply(ctx, { ...config, domainStorage: port });
    const exec = { agent: { id: 'evidence-owner' }, signal: new AbortController().signal };
    return {
      core,
      port,
      rare: () => core.observeAutonomous({ type: 'agent/error', code: 'AGENT_ERROR', message: 'provider unavailable', target: 'agent' }, exec),
      noise: (index) => core.observeAutonomous({ type: 'tool/error', code: `TOOL_${index}`, message: `noise ${index}`, target: `tool:noise-${index}` }, exec),
      async close() { await port.close(); await backend.close(); },
    };
  };
}

/** Write more unrelated observation rows than the durable tail keeps. */
async function churn(s) {
  for (let index = 0; index < NOISE_PATTERNS; index += 1) {
    for (let repeat = 0; repeat < NOISE_REPEATS; repeat += 1) await s.noise(index);
  }
  assert.ok(NOISE_PATTERNS * NOISE_REPEATS > DURABLE_ROW_WINDOW, 'the churn has to cross the durable row window');
}

/** The rows the durable half alone still answers for one pattern. */
function durableRowsFor(s, patternKey) {
  return s.port.autonomousObservations().filter((row) => row.patternKey === patternKey);
}

test('a fault whose occurrences are separated by unrelated faults still reaches its threshold', async (t) => {
  const session = await fixture(t);
  let s = await session();
  try {
    assert.equal((await s.rare()).phase, 'pattern-observing');
    assert.equal((await s.rare()).phase, 'pattern-observing');
    await churn(s);

    const third = await s.rare();
    const patternKey = third.patternKey;
    assert.equal(durableRowsFor(s, patternKey).length, 1,
      'the durable tail alone has already lost the first two occurrences, which is the condition being fixed');
    assert.equal(third.phase, 'candidate-awaiting-confirmation',
      'the session half keeps the occurrences the durable tail pushed out, so the pattern still matures');
    assert.equal(third.reason, 'confirmation-required');
    assert.equal(third.candidate.observationIds.length, THRESHOLD, 'every occurrence is evidence exactly once');
    assert.equal(new Set(third.candidate.observationIds).size, THRESHOLD);

    // Honest limit of the same change, not a regression: the session half is
    // memory, so after a restart the durable tail is the only cross-session
    // evidence there is. A pattern that fell out of it starts counting again and
    // nothing infers the occurrences back from unrelated rows.
    await s.close();
    s = await session();
    const after = await s.rare();
    assert.equal(after.phase, 'pattern-observing');
    assert.equal(after.occurrences, 2, 'only the occurrence the durable tail still holds is counted again; the two it lost are not reconstructed');
  } finally { await s.close(); }
});

test('an occurrence both halves know about is counted once', async (t) => {
  const session = await fixture(t);
  const s = await session();
  try {
    await s.rare();
    const second = await s.rare();
    assert.equal(second.phase, 'pattern-observing');
    assert.equal(second.occurrences, 2, 'the durable row and the session row for the same occurrence are one occurrence');
    const third = await s.rare();
    assert.equal(third.candidate.observationIds.length, 3);
  } finally { await s.close(); }
});

test('a port that answers a stale tail does not drop the occurrence being observed', async (t) => {
  const session = await fixture(t);
  const s = await session();
  try {
    // Half of the window is a read this call does not control: a port that cannot
    // answer for the row it just committed must not make the call lose its own event.
    s.core.domainStorage = { ...s.port, autonomousObservations: () => [] };
    await s.rare();
    await s.rare();
    const third = await s.rare();
    assert.equal(third.phase, 'candidate-awaiting-confirmation');
    assert.equal(third.candidate.observationIds.length, 3);
  } finally { await s.close(); }
});

test('the durable half alone still answers for a later session', async (t) => {
  const session = await fixture(t);
  let s = await session();
  try {
    await s.rare();
    await s.rare();
    await s.close();
    s = await session();
    const third = await s.rare();
    assert.equal(third.phase, 'candidate-awaiting-confirmation', 'the restarted session counts the durable rows plus its own');
    assert.equal(third.candidate.observationIds.length, 3);
  } finally { await s.close(); }
});
