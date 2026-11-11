import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { managedPatch, setupPlan } from '../scripts/setup-experience.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promoted-consumer-packaging-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('bundle patch adds exactly one enabled consumer entry without reordering the existing rows', () => {
  const text = fs.readFileSync(path.join(REPO, 'cordis.patch.yml'), 'utf8');
  const document = yaml.load(text);
  assert.ok(Array.isArray(document), 'bundle patch is an entry list');
  const insert = document.find((patch) => Array.isArray(patch?.insert))?.insert;
  assert.ok(Array.isArray(insert), 'bundle patch keeps the insert list');

  const consumers = insert.filter((row) => row?.id === 'evolution-promoted-consumer');
  assert.equal(consumers.length, 1);
  assert.equal(consumers[0].name, 'dsh-evolution/promoted-consumer');
  // The module itself no-ops outside acp/web, so the bundle row stays enabled.
  assert.equal(consumers[0].disabled, undefined);
  // Existing rows and their order are untouched; the consumer row is appended.
  assert.deepEqual(insert.slice(0, 4).map((row) => row.id), [
    'evolution-experience',
    'evolution-experience-history',
    'evolution-orchestrator',
    'evolution-trust-root-guard',
  ]);
  assert.equal(insert.at(-1).id, 'evolution-promoted-consumer');
});

test('managed profile block enables the consumer only on acp and web', () => {
  const expected = {
    desktop: 'true',
    acp: 'false',
    web: 'false',
  };
  for (const [profile, disabled] of Object.entries(expected)) {
    const block = managedPatch('', profile);
    const rows = yaml.load(block);
    const consumer = rows.find((row) => row.id === 'evolution-promoted-consumer');
    assert.ok(consumer, `${profile} managed block has the consumer row`);
    assert.equal(String(consumer.disabled), disabled, `${profile} consumer disabled flag`);
    // The rest of the managed block is unchanged.
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.equal(String(byId.get('hmr').disabled), 'true');
    assert.equal(String(byId.get('evolution-experience').disabled), 'false');
    assert.equal(String(byId.get('evolution-experience-history').disabled), String(profile === 'desktop'));
    assert.equal(String(byId.get('evolution-orchestrator').disabled), String(profile !== 'desktop'));
    assert.equal(rows.length, 5);
    // Byte-stable block: appending the row is the only change.
    assert.equal(managedPatch(block, profile), block, 'managed block is idempotent');
  }
});

test('setup plan reports the promoted-plugin consumer for acp and web', (t) => {
  const home = temporary(t);
  const tarball = path.join(home, 'candidate.tgz');
  fs.writeFileSync(tarball, 'candidate bytes');
  const plan = setupPlan({ home, tarball, cli: 'dsh' });
  assert.deepEqual(plan.map((item) => item.profile), ['desktop', 'acp', 'web']);
  for (const item of plan) {
    const rows = yaml.load(item.next);
    assert.equal(rows.find((row) => row.id === 'evolution-promoted-consumer').disabled, item.profile === 'desktop');
    if (item.profile === 'desktop') {
      assert.doesNotMatch(item.role, /promoted-plugin consumer/);
    } else {
      assert.match(item.role, /promoted-plugin consumer/);
    }
  }
});
