// The Desktop audit resolves dshHome at construction. Its review hand-off must
// keep that home even when the data root is custom, otherwise the copyable
// producer command scans a different home's sessions and measures a false zero.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { EvolutionOrchestrator } from '../lib/orchestrator.js';
import { readUsageProjection } from '../lib/capability-usage.js';
import { resolveEvolutionPaths } from '../lib/diagnostics.js';
import { buildSharedRecord, publishSharedRecord } from '../lib/promoted-sharing.js';
import { context } from './fixtures/runtime-inspect.mjs';

const RECORD_ID = 'evolution-promoted-0000000000dd';
const HOST = Object.freeze({
  profile: 'desktop', dsh: '0.2.2-rc.5', cordis: '4.1.0', include: '2.0.3',
  node: process.version, capturedAt: '2026-01-01T00:00:00.000Z',
});

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-review-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Deliberately separated: a guessed parent of the data root is not the home.
  const home = path.join(root, 'home');
  const dataRoot = path.join(root, 'custom-data');
  const paths = resolveEvolutionPaths({ dshHome: home, dataRoot });

  const sessionDir = path.join(home, 'sessions', 'one');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl'), `${JSON.stringify({
    type: 'tool/call', data: { callId: 'c1', name: 'widget_tool' },
  })}\n`);

  const pluginName = `dsh-${RECORD_ID}`;
  const pluginDir = path.join(paths.pluginRoot, pluginName);
  fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true });
  const modulePath = path.join(pluginDir, 'lib', 'index.js');
  const source = [
    'export const inject = ["tools"];',
    'export function apply(ctx) {',
    '  const tool = harness.defineTool({ name: "widget_tool", description: "widget" });',
    '  harness.registerTool(ctx, tool);',
    '}',
  ].join('\n');
  fs.writeFileSync(modulePath, source);
  fs.writeFileSync(path.join(pluginDir, 'package.json'), `${JSON.stringify({ name: pluginName, version: '1.0.0', type: 'module', main: 'lib/index.js' })}\n`);
  const durable = { pluginName, pluginPath: pluginDir, moduleUrl: pathToFileURL(modulePath).href, rowId: RECORD_ID };
  const record = await buildSharedRecord({
    paths,
    experiment: {
      id: 'exp-review-home', ownerId: 'desktop-owner', state: 'stable',
      stableCommittedAt: '2026-01-01T00:00:00.000Z', shareTargets: ['acp', 'web'],
      canary: {
        promotionTimestamp: '2026-01-01T00:00:00.000Z', healthObservationWindow: 2,
        startupVerified: true, observations: [{ barrierId: 'startup:desktop' }, { barrierId: 'post:desktop' }],
      },
      decision: { version: 1, kind: 'benefit', source: 'canary-passed' },
      durable,
    },
    durable,
    journal: null,
    approvedProfiles: ['acp', 'web'],
    host: HOST,
    capabilities: { fiberLifecycle: true, fiberAwait: true, include: true, toolsRegistry: true },
    source: { stableCommittedAt: '2026-01-01T00:00:00.000Z' },
  });
  assert.equal((await publishSharedRecord(paths, record)).status, 'published');

  const ctx = context();
  ctx.dynamicCordisRunner = { snapshot: () => [] };
  const core = new EvolutionOrchestrator(ctx, {
    dshHome: home,
    presetDir: dataRoot,
    startupDrift: false,
    eventBridge: { emit: () => ({}) },
    eventBridgePath: path.join(dataRoot, 'events.jsonl'),
    eventBridgeKey: 'k'.repeat(32),
    driftStatePath: path.join(root, 'drift.json'),
    memoryPath: path.join(dataRoot, 'memory.json'),
  });
  return { home, dataRoot, core };
}

test('the Desktop audit hand-off keeps the resolved home for a custom data root', async (t) => {
  const env = await fixture(t);
  assert.equal(env.core.paths.dshHome, env.home);
  const reviewed = await env.core.reviewSelfEvolution();
  const action = reviewed.selfEvolution.nextActions.find((row) =>
    typeof row.code === 'string' && row.code.startsWith('usage-projection-'));
  assert.ok(action, JSON.stringify(reviewed.selfEvolution.nextActions));
  assert.ok(action.command.includes(`--home '${env.home}'`), action.command);
  assert.ok(action.command.includes(`--data-root '${env.dataRoot}'`), action.command);
  assert.doesNotMatch(action.command, /\$\{/);

  // Copy-paste both commands exactly, with no DSH_HOME in the shell.
  const bare = { PATH: process.env.PATH };
  const templateRun = spawnSync('sh', ['-c', action.templateCommand], { encoding: 'utf8', env: bare });
  assert.ok(templateRun.status === 0 || templateRun.status === 3, templateRun.stderr);
  const writeRun = spawnSync('sh', ['-c', action.command], { encoding: 'utf8', env: bare });
  assert.ok(writeRun.status === 0 || writeRun.status === 3, writeRun.stderr);

  const loaded = await readUsageProjection({ dataRoot: env.dataRoot });
  assert.equal(loaded.status, 'ok');
  // The real call in the resolved home was counted, never turned into a zero.
  assert.equal(loaded.usage.records[RECORD_ID].workflowInvocations, 1);
});
