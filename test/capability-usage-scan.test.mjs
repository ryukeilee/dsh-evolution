// The usage projection feeds the disable recommendation, so an incomplete scan
// must never look like "zero calls". This drives the committed script over a
// synthetic DSH home; no real session log is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../docs/audit/replay/capability-usage.mjs', import.meta.url));

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'storages', 'evolution');
  fs.mkdirSync(path.join(dataRoot, 'shared-plugins'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'promoted', 'plugin', 'lib'), { recursive: true });
  const modulePath = path.join(dataRoot, 'promoted', 'plugin', 'lib', 'index.js');
  fs.writeFileSync(modulePath, 'const tool = defineTool({ name: "widget_tool", description: "widget" });\n');
  fs.writeFileSync(path.join(dataRoot, 'shared-plugins', 'published.json'), `${JSON.stringify({
    plugins: [{ id: 'evolution-promoted-aaaaaaaaaaaa', pluginName: 'plugin', moduleUrl: `file://${modulePath}`, entry: 'lib/index.js' }],
  })}\n`);
  return { root, dataRoot };
}

function writeSession(root, name, lines, { corrupt = false } = {}) {
  const dir = path.join(root, 'sessions', name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  if (corrupt) fs.writeFileSync(file, Buffer.from('not a zstd frame'));
  else fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n'))));
  return file;
}

function run(home) {
  const result = spawnSync(process.execPath, [SCRIPT, '--home', home], { encoding: 'utf8' });
  return { status: result.status, projection: JSON.parse(result.stdout) };
}

const record = 'evolution-promoted-aaaaaaaaaaaa';

test('a complete scan reports the real counts', (t) => {
  const { root } = scratch(t);
  writeSession(root, 'one', [
    { type: 'tool/call', data: { callId: 'c1', name: 'widget_tool' } },
    { type: 'tool/call', data: { callId: 'c2', name: 'bash' } },
  ]);
  const { status, projection } = run(root);
  assert.equal(status, 0);
  assert.equal(projection.complete, true);
  assert.deepEqual(projection.records[record], { workflowInvocations: 1, verificationInvocations: 0, capabilityAssessment: 'unknown' });
});

test('verification traffic is separated from usage', (t) => {
  const { root } = scratch(t);
  writeSession(root, 'one', [
    { type: 'tool/call', data: { callId: 'c1', name: 'widget_tool' } },
    { type: 'tool/call', data: { callId: 'c2', name: 'evolution_probe' } },
  ]);
  const { projection } = run(root);
  assert.deepEqual(projection.records[record], { workflowInvocations: 0, verificationInvocations: 1, capabilityAssessment: 'unknown' });
});

test('an unreadable session log makes the counts unknown, not zero', (t) => {
  const { root } = scratch(t);
  writeSession(root, 'one', [{ type: 'tool/call', data: { callId: 'c1', name: 'widget_tool' } }]);
  writeSession(root, 'two', [], { corrupt: true });
  const { status, projection } = run(root);
  assert.equal(status, 3, 'an incomplete scan is reported as incomplete');
  assert.equal(projection.complete, false);
  assert.equal(projection.failures.undecompressableSessions, 1);
  assert.equal(projection.records[record].workflowInvocations, null);
  assert.equal(projection.records[record].verificationInvocations, null);
});

test('an unreadable plugin source invalidates only that record', (t) => {
  const { root, dataRoot } = scratch(t);
  fs.rmSync(path.join(dataRoot, 'promoted', 'plugin', 'lib', 'index.js'));
  writeSession(root, 'one', [{ type: 'tool/call', data: { callId: 'c1', name: 'widget_tool' } }]);
  const { projection } = run(root);
  assert.equal(projection.complete, false);
  assert.deepEqual(projection.failures.unreadableSources, [record]);
  assert.equal(projection.records[record].workflowInvocations, null);
});
