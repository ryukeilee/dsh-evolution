// `recall()` reads only the newest bounded window. When older knowledge exists
// outside that LIMIT it must say so, instead of returning an empty answer that
// looks complete while `discover()` on the same store reports truncation.
import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openSharedExperience } from '../lib/shared-experience.js';

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-window-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('an outer knowledge window truncation is reported by recall', (t) => {
  const store = openSharedExperience(scratch(t));
  t.after(() => store.close());
  // 2050 records: the SQL window covers only the newest 2000, so the oldest
  // `needle` row is outside it.
  for (let index = 0; index < 2050; index += 1) {
    store.recordFailure({ id: crypto.createHash('sha256').update(`outer-${index}`).digest('hex'),
      type: 'tool/error', code: 'HOST_OPERATION_FAILED', target: index === 0 ? 'needle' : `tool:filler-${index}`, metrics: { n: index } });
  }
  const all = store.recall({ problem: 'needle' });
  assert.equal(all.scanned, 2050);
  assert.equal(all.truncated, true);
  assert.ok(all.considered <= 2000);

  const discovered = store.discover({ window: 10 });
  assert.equal(discovered.truncated, true);
  assert.equal(all.truncated, discovered.truncated, 'both bounded read surfaces agree');
});

test('a store inside the window is not reported truncated', (t) => {
  const store = openSharedExperience(scratch(t));
  t.after(() => store.close());
  for (let index = 0; index < 5; index += 1) {
    store.recordFailure({ id: crypto.createHash('sha256').update(`small-${index}`).digest('hex'),
      type: 'tool/error', code: 'HOST_OPERATION_FAILED', target: `tool:small-${index}`, metrics: { n: index } });
  }
  const result = store.recall({});
  assert.equal(result.scanned, 5);
  assert.equal(result.truncated, false);
});
