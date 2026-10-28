// Read-only production-source audit; all runtime fixtures are created under /tmp.
// Usage: node --max-old-space-size=4096 scripts/benchmarks/axis-token-audit.mjs > /tmp/axis-token-audit.json
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { apply, EVOLUTION_TOOLS } from '../../lib/registration.js';
import { collectDiagnostics, resolveEvolutionPaths } from '../../lib/diagnostics.js';
import { context, config as inspectConfig, populate } from '../../test/fixtures/runtime-inspect.mjs';
import { openFixture, emit } from '../../test/retention-boundary-worker.mjs';

const root = fs.mkdtempSync('/tmp/axis-token-');
const repo = fileURLToPath(new URL('../../', import.meta.url));
const bytes = value => Buffer.byteLength(value, 'utf8');
const estimate = n => Number((n / 3.6).toFixed(2));
const stats = value => {
  let objectKeys = 0, arrays = 0, objects = 0, maxDepth = 0, stringsWithNewlines = 0, jsonStrings = 0;
  const walk = (v, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    if (typeof v === 'string') {
      if (v.includes('\n')) stringsWithNewlines++;
      try { if (JSON.parse(v) && typeof JSON.parse(v) === 'object') jsonStrings++; } catch {}
    }
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) arrays++; else { objects++; objectKeys += Object.keys(v).length; }
      for (const item of Object.values(v)) walk(item, depth + 1);
    }
  };
  walk(value, 0);
  return { objectKeys, objects, arrays, maxDepth, stringsWithNewlines, jsonStrings };
};
const samples = [];
function sample(name, value, definition, provenance) {
  // `output.render` is now the compact projection; `pretty` is the frozen
  // pre-change text it replaced, kept so the audit still measures the delta.
  const compact = definition.output.render({}, value)[0].text;
  assert.equal(compact, JSON.stringify(value));
  const pretty = JSON.stringify(value, null, 2);
  assert.deepEqual(JSON.parse(pretty), JSON.parse(compact));
  // Re-serialize parsed pretty JSON compactly: string escapes/newlines remain data.
  assert.equal(JSON.stringify(JSON.parse(compact)), compact);
  const p = bytes(pretty), c = bytes(compact);
  samples.push({ name, provenance, prettyBytes: p, compactBytes: c, savedBytes: p-c,
    reductionPercent: Number(((p-c)/p*100).toFixed(2)),
    prettyTokensEstimated: estimate(p), compactTokensEstimated: estimate(c),
    equivalentParsedJson: true, ...stats(value), value });
}
let domain;
const previousPath = process.env.PATH, previousCli = process.env.DSH_CLI;
try {
  // Prevent doctor from searching the user's PATH/DSH_CLI. No CLI is executed.
  process.env.PATH = root;
  delete process.env.DSH_CLI;
  const domainRoot = path.join(root, 'domain'); fs.mkdirSync(domainRoot);
  domain = await openFixture(domainRoot);
  const ctx = context();
  let system;
  ctx.systemPrompt.section = section => { system = section; };
  const paths = resolveEvolutionPaths({ dshHome: path.join(root, 'home') });
  fs.mkdirSync(paths.dataRoot, { recursive: true });
  const diagnose = options => collectDiagnostics({ ...options, paths, dshHome: paths.dshHome,
    home: true, profileCandidates: [], probe: { skipComposition: true }, repair: false });
  const core = apply(ctx, { ...inspectConfig, ...paths, domainStorage: domain.port, diagnose });
  assert.deepEqual([...ctx.definitions.keys()].sort(), [...EVOLUTION_TOOLS].sort());
  const exec = { agent: { id: 'axis-token-owner' }, signal: new AbortController().signal };
  const call = (tool, args = {}) => ctx.definitions.get(tool).execute(args, exec);
  const add = async (label, tool, args, provenance) => sample(label, await call(tool, args), ctx.definitions.get(tool), provenance);
  const tools = [...ctx.definitions.values()].map(({name, description, parameters}) => ({
    name, description, parameters, nameBytes: bytes(name), descriptionBytes: bytes(description),
    parametersJsonBytes: bytes(JSON.stringify(parameters)),
    descriptionTokensEstimated: estimate(bytes(description)), parametersTokensEstimated: estimate(bytes(JSON.stringify(parameters))),
  }));
  const wire = tools.map(({name, description, parameters}) => ({name, description, parameters}));
  const payloadBytes = bytes(system.text) + tools.reduce((n,t) => n+t.nameBytes+t.descriptionBytes+t.parametersJsonBytes, 0);
  const normalizedBytes = bytes(system.text) + bytes(JSON.stringify(wire));
  const fixed = { systemText: system.text, systemBytes: bytes(system.text), systemTokensEstimated: estimate(bytes(system.text)), tools,
    payloadBytes, normalizedToolsArrayBytes: bytes(JSON.stringify(wire)), normalizedBytes,
    normalizedTokensEstimated: estimate(normalizedBytes),
    note: 'UTF-8 measured; tokens estimated as bytes/3.6, not tokenizer counts. Normalized compact array is a declared accounting envelope, not captured provider wire format.',
    sessions: [50, 200].map(requests => ({ requests, bytes: normalizedBytes*requests, tokensEstimated: estimate(normalizedBytes*requests) })) };
  for (const count of [0, 10, 100]) {
    if (count) populate(core, count);
    await add(`inspect-candidates-${count}`, 'evolution_runtime_inspect', {}, 'test/runtime-inspect.test.mjs + test/fixtures/runtime-inspect.mjs; real registered execute, synthetic registries');
  }
  await add('history-empty-default', 'evolution_history', {}, 'real official DomainFacility/JSON backend via test/retention-boundary-worker.mjs');
  for (let i=0; i<12; i++) emit(domainRoot, `axis-${i}`);
  await domain.port.flush();
  await add('history-default-seeded', 'evolution_history', {}, '12 signed synthetic measurement-completed events replayed into real domain port');
  for (let i=0; i<12; i++) await domain.port.observe({ type: 'tool/error', code: `AXIS_ERROR_${String.fromCharCode(65+i)}`,
    target: 'plugin:axis-latency', message: 'synthetic latency regression', severity: 'error' });
  await add('history-observations-10', 'evolution_history', { collection: 'observations', limit: 10 }, 'same real domain port, metadata-only observation query');
  await add('history-query', 'evolution_history', { query: 'synthetic latency regression', target: 'plugin:axis-latency', limit: 5 }, 'real bounded recall over knowledge generated by 12 synthetic tool/error observations');
  await add('doctor-empty-home', 'evolution_doctor', { composition: false }, 'real collectDiagnostics; empty /tmp home; no host installation/CLI invocation, repair=false');
  const proposalArgs = { why: 'Reduce measured runtime latency', target: 'plugin:axis-latency', impactScope: ['runtime'], successMetrics: ['p95 latency'], risk: 'low' };
  const proposal = await call('evolution_propose', proposalArgs);
  sample('propose', proposal, ctx.definitions.get('evolution_propose'), 'real registered propose with bounded recall and runtime signature');
  // Match the successful fake runner used in test/trial-recovery-boundary.test.mjs.
  ctx.dynamicCordisRunner.define = () => ({ pluginId: 'candidate', packageId: 'package' });
  ctx.dynamicCordisRunner.run = async () => ({ ok: true, status: 'active' });
  await call('evolution_trial', { experimentId: proposal.experimentId,
    composition: { name: 'axis fixture', purpose: 'measurement shape', code: { host: 'return {};' } } });
  const observation = { solvesProblem: true, sideEffects: [], orphanResources: [], performanceChange: { latencyMs: { before: 100, after: 80 } },
    errorChange: 'unchanged', beforeMetrics: { latencyMs: 100 }, afterMetrics: { latencyMs: 80 },
    sampleCount: 30, observationWindow: '2026-10-29T00:00:00Z/2026-10-29T00:05:00Z',
    benefitEvidence: '30 synthetic samples: p95 latency 100ms -> 80ms', repeatable: true, regressionPassed: true,
    reversible: true, cleanupEvidence: 'Disposal proof will be collected after the observation window.' };
  await add('measure', 'evolution_measure', { experimentId: proposal.experimentId, observation }, 'real propose -> trial (fake runner) -> measure; no production promotion');
  const p2 = await call('evolution_propose', { ...proposalArgs, target: 'plugin:axis-evidence' });
  await call('evolution_trial', { experimentId: p2.experimentId,
    composition: { name: 'evidence fixture', purpose: 'JSON-string evidence shape', code: { host: 'return {};' } } });
  await add('measure-json-string-evidence', 'evolution_measure', { experimentId: p2.experimentId,
    observation: { ...observation, benefitEvidence: JSON.stringify({ samples: Array.from({length: 6}, (_,i) => ({index:i, before:100, after:80})), note:'line one\nline two' }, null, 2),
      cleanupEvidence: 'line one\nline two\nNo actual cleanup assertion in this synthetic fixture.' } }, 'real measure with pretty-JSON string benefitEvidence and newline cleanupEvidence; projected under existing bounds');
  const source = fs.readFileSync(path.join(repo, 'lib/registration.js'), 'utf8');
  const lineOf = offset => source.slice(0,offset).split('\n').length;
  // Maximal exact common substrings of >=24 characters; no fuzzy-match byte claims.
  const exact = [];
  for (const tool of tools) {
    const a = system.text, b = tool.description;
    for (let i=0;i<a.length;i++) for(let j=0;j<b.length;j++) {
      if(a[i]!==b[j] || (i>0 && j>0 && a[i-1]===b[j-1])) continue;
      let k=0; while(i+k<a.length && j+k<b.length && a[i+k]===b[j+k]) k++;
      if(k>=24) {
        const text = a.slice(i,i+k);
        const start = source.indexOf('const systemText = `')+'const systemText = `'.length+i;
        const descStart = source.indexOf(tool.description);
        exact.push({tool:tool.name,text,bytes:bytes(text),systemLines:[lineOf(start),lineOf(start+k-1)],descriptionLines:[lineOf(descStart+j),lineOf(descStart+j+k-1)]});
      }
    }
  }
  const semanticPairs = [['lifecycle','Use the lifecycle exactly in this order:', 'Cordis owns Component'],
    ['recall','Durable experience is already recorded', '\nevolution_maintain'],
    ['maintain','evolution_maintain is the only capacity operation', '\n`;']].map(([topic,start,end]) => {
      const from=source.indexOf(start), to=source.indexOf(end,from);
      const text=source.slice(from,to).trimEnd();
      return {topic,systemLines:[lineOf(from),lineOf(from+text.length-1)],systemBytes:bytes(text),text};
    });
  const report = { node:process.version, repoHead: fs.readFileSync(path.join(repo,'.git/HEAD'),'utf8').trim(),
    tokenEstimator:'UTF-8 bytes / 3.6; assumption only; not billing or tokenizer measurement',
    fixed, exactDescriptionOverlaps:exact, semanticSystemBlocks:semanticPairs, samples };
  console.log(JSON.stringify(report,null,2));
} finally {
  await domain?.close();
  if(previousPath===undefined) delete process.env.PATH; else process.env.PATH=previousPath;
  if(previousCli===undefined) delete process.env.DSH_CLI; else process.env.DSH_CLI=previousCli;
  fs.rmSync(root,{recursive:true,force:true});
}
