/** Isolated acceptance only: executes an ACP-supplied task on the Desktop's
 * official tool registry. It never registers another Evolution implementation.
 * Promotion waits for an external, experiment-bound owner approval receipt.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
export const inject = ['evolution', 'agents', 'tools'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function apply(ctx) {
  const requestPath = process.env.EVOLUTION_ACP_TASK;
  if (!requestPath) return;
  const timer = setTimeout(() => {
    void run(ctx, requestPath).catch(async error => {
      await fs.writeFile(`${requestPath}.result.json`, JSON.stringify({ ok: false, error: String(error?.code || error?.message).slice(0, 500) }));
    });
  }, 1500);
  ctx.effect(() => () => clearTimeout(timer));
}

async function run(ctx, requestPath) {
  // Desktop may compose the patch more than once; exactly one driver is allowed.
  let lock;
  try { lock = await fs.open(`${requestPath}.driver`, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  await lock.close();
  if (!process.versions.electron) throw new Error('This probe requires the real Desktop Electron host');
  const request = JSON.parse(await fs.readFile(requestPath, 'utf8'));
  const handle = await ctx.agents.create({ sessionId: `acp-desktop-${request.id}`, meta: { cwd: request.cwd } });
  const agent = handle.agent;
  const steps = [];
  const call = async (name, args) => {
    const tool = ctx.tools.get(name, agent);
    if (!tool) throw new Error(`Desktop tool unavailable: ${name}`);
    const result = await tool.execute(args, { agent, signal: AbortSignal.timeout(30000) });
    if (result?.ok === false && result.phase !== 'awaiting-owner-confirmation') throw new Error(`Desktop tool refused: ${name}`);
    steps.push({ name, phase: result?.phase ?? null, stable: result?.stable ?? null });
    return result;
  };
  // Capture the trial baseline only after the actual Desktop composition settles.
  let prior, stable = 0;
  for (let n = 0; n < 80 && stable < 4; n++) {
    const runtime = await call('evolution_runtime_inspect', {});
    const fingerprint = JSON.stringify({ components: runtime.components, services: runtime.services, events: runtime.events });
    stable = fingerprint === prior ? stable + 1 : 0;
    prior = fingerprint;
    await sleep(250);
  }
  if (stable < 4) throw new Error('Desktop runtime did not settle');
  const absentBefore = !ctx.tools.get(request.toolName, agent);
  if (!absentBefore) throw new Error('Candidate tool already exists before trial');
  const proposed = await call('evolution_propose', {
    why: 'ACP-requested isolated acceptance: add a deterministic read-only text statistics tool',
    target: `plugin:${request.id}`, impactScope: ['isolated-acceptance-only'],
    successMetrics: ['two actual text-statistics calls produce the expected characters and line counts'],
  });
  const experimentId = proposed.experimentId;
  await call('evolution_trial', { experimentId, composition: {
    name: request.id, purpose: 'Read-only text statistics; no filesystem, network or process access', code: { host: request.hostCode },
  } });
  const samples = [];
  for (const text of ['abc', 'a\nb']) {
    const result = await call(request.toolName, { text });
    const expected = { characters: text.length, lines: text.split('\n').length };
    if (JSON.stringify(result) !== JSON.stringify(expected)) throw new Error('Trial output mismatch');
    const rendered = ctx.tools.get(request.toolName, agent).output.render({ text }, result);
    const renderedValue = JSON.parse(rendered.filter(block => block.type === 'text').map(block => block.text).join(''));
    if (JSON.stringify(renderedValue) !== JSON.stringify(expected)) throw new Error('Trial rendered output mismatch');
    samples.push({ input: text, result, renderedValue });
  }
  const measured = await call('evolution_measure', { experimentId, observation: {
    solvesProblem: true, metrics: { errors: 0 }, beforeMetrics: { errors: absentBefore ? 1 : 0 }, afterMetrics: { errors: 0 },
    sampleCount: samples.length, observationWindow: 'two actual deterministic trial tool calls',
    benefitEvidence: 'tool absent before trial, both registered-tool outputs matched expected values',
    repeatable: true, regressionPassed: true, reversible: true,
    cleanupEvidence: 'promotion must dispose the real Trial and prove the captured runtime baseline',
  } });
  const gated = await call('evolution_promote', { experimentId });
  if (gated.phase !== 'awaiting-owner-confirmation') throw new Error('Owner confirmation gate did not hold');
  const sourceSha256 = crypto.createHash('sha256').update(request.hostCode).digest('hex');
  const prepared = { ok: true, phase: 'awaiting-owner-confirmation', experimentId, sourceSha256,
    toolName: request.toolName, targetProfiles: ['acp'], samples, measured: { phase: measured.phase, gates: measured.gates, decision: { kind: measured.decision?.kind, eligible: measured.decision?.eligible, reasons: measured.decision?.reasons } }, steps,
    runtime: { electron: process.versions.electron, node: process.versions.node }, desktopPid: process.pid };
  await fs.writeFile(`${requestPath}.prepared.json`, JSON.stringify(prepared, null, 2));
  let approval;
  for (let n = 0; n < 1800; n++) {
    try { approval = JSON.parse(await fs.readFile(`${requestPath}.approval.json`, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await sleep(1000);
  }
  if (approval?.experimentId !== experimentId || approval?.sourceSha256 !== sourceSha256
    || approval?.confirmation !== true || JSON.stringify(approval.targetProfiles) !== '["acp"]') {
    await call('evolution_revert', { experimentId });
    throw new Error('No matching explicit owner approval; Trial reverted');
  }
  const promoted = await call('evolution_promote', { experimentId, confirmation: true, targetProfiles: ['acp'] });
  if (promoted.phase !== 'canary-observing') throw new Error('Promotion did not reach canary');
  for (let n = 1; n <= 2; n++) {
    const actual = await call(request.toolName, { text: 'a\nb' });
    if (actual.characters !== 3 || actual.lines !== 2) throw new Error('Promoted tool failed at canary barrier');
    const observed = await call('evolution_canary_observe', { experimentId, startupVerified: true,
      componentHealth: 'active', dependenciesPresent: true, metricRegression: false,
      barrier: { id: `${request.id}-${n}`, reached: true }, evidence: { actualToolOutput: actual } });
    if (observed.stable !== (n === 2)) throw new Error('Unexpected canary stable barrier');
  }
  const index = JSON.parse(await fs.readFile(path.join(ctx.evolution.dataRoot, 'shared-plugins', 'published.json'), 'utf8'));
  const record = index.plugins.find(row => row.experimentId === experimentId);
  if (!record || record.publisherProfile !== 'desktop' || !record.stable?.committedAt) throw new Error('Desktop stable publication missing');
  await fs.writeFile(`${requestPath}.result.json`, JSON.stringify({ ok: true, ...prepared, phase: 'stable', record, steps }, null, 2));
}
