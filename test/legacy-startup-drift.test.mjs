import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectLegacyStartupDrift } from '../lib/compat/legacy-startup-drift.js';

test('legacy startup drift adapter is off by default and never guesses an external path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const missing = await inspectLegacyStartupDrift({ driftStatePath: join(root, 'absent.json') });
  assert.deepEqual(missing, { status: 'baseline-missing' });

  await writeFile(join(root, 'state.json'), JSON.stringify({ repoRoot: root }));
  const unavailable = await inspectLegacyStartupDrift({ driftStatePath: join(root, 'state.json') });
  assert.equal(unavailable.status, 'backup-unavailable');
  assert.equal(unavailable.repoRoot, root);
});
