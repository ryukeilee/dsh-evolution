// A/B: the indented vs compact projection of the Evolution tool-result text.
//
// Only `lib/registration.js`'s `output.render` differs between the two sides.
// Every measurement comes from the real registered tool surface of the tree under
// test: `apply()` is given a real `@deepseek-ai/dsh-storage-domain` port for the
// domain tools, and each sample is an actual `definition.output.render(...)` call
// on the value that tool returned.
//
// Both sides run the same scenario in their own process, alternating A/B per
// round. Equivalence is checked *inside* each process - a call cannot be compared
// across processes byte-for-byte because `evolution_propose` mints a random
// experiment id and `doctor`/`inspect` carry timestamps - so the cross-process
// comparison is the reported byte delta plus an exact match of the payload's key
// path set (structure, not values).
//
// Usage:
//   node --max-old-space-size=4096 scripts/benchmarks/tool-result-render-compact.mjs \
//     --baseline 5a728dd --rounds 3 --out docs/performance/tool-result-render-compact.json
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function parseArgs(argv) {
  const options = { rounds: 3, samples: 200, out: null, baseline: null, work: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => { index += 1; if (!argv[index]) throw new Error(`${arg} requires a value`); return argv[index]; };
    if (arg === '--rounds') options.rounds = Number(value());
    else if (arg === '--samples') options.samples = Number(value());
    else if (arg === '--out') options.out = path.resolve(value());
    else if (arg === '--baseline') options.baseline = value();
    else if (arg === '--work') options.work = path.resolve(value());
    else if (arg === '--child') options.child = value();
    else if (arg === '--lib') options.lib = path.resolve(value());
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

/** Every key path in the payload, sorted: the structure a renderer must not change. */
function keyPaths(value, prefix = '', out = []) {
  if (Array.isArray(value)) {
    out.push(`${prefix}[]`);
    for (const item of value) keyPaths(item, `${prefix}[]`, out);
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) keyPaths(value[key], prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.push(`${prefix}:${typeof value}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Child: one side, one round.
// ---------------------------------------------------------------------------
async function child(options) {
  const lib = options.lib;
  const load = (relative) => import(pathToFileURL(path.join(lib, relative)).href);
  const { apply, EVOLUTION_TOOLS } = await load('registration.js');
  const { collectDiagnostics, resolveEvolutionPaths } = await load('diagnostics.js');
  const fixtures = await import(pathToFileURL(path.join(REPO, 'test/fixtures/runtime-inspect.mjs')).href);
  const worker = await import(pathToFileURL(path.join(REPO, 'test/retention-boundary-worker.mjs')).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'render-compact-'));
  const previousPath = process.env.PATH;
  const previousCli = process.env.DSH_CLI;
  let domain;
  const samples = [];
  try {
    // The doctor sample must not search the user's PATH or run the host CLI.
    process.env.PATH = root;
    delete process.env.DSH_CLI;
    const domainRoot = path.join(root, 'domain');
    fs.mkdirSync(domainRoot);
    domain = await worker.openFixture(domainRoot);
    const ctx = fixtures.context();
    ctx.systemPrompt.section = () => {};
    const paths = resolveEvolutionPaths({ dshHome: path.join(root, 'home') });
    fs.mkdirSync(paths.dataRoot, { recursive: true });
    const diagnose = (diagnoseOptions) => collectDiagnostics({ ...diagnoseOptions, paths,
      dshHome: paths.dshHome, home: true, profileCandidates: [], probe: { skipComposition: true }, repair: false });
    const core = apply(ctx, { ...fixtures.config, ...paths, domainStorage: domain.port, diagnose });
    const exec = { agent: { id: 'render-bench-owner' }, signal: new AbortController().signal };
    const call = (tool, args = {}) => ctx.definitions.get(tool).execute(args, exec);

    const record = (name, tool, value) => {
      const definition = ctx.definitions.get(tool);
      const rendered = definition.output.render({}, value)[0].text;
      // Both projections are taken from this one value, in this one process, so
      // the byte delta is a controlled comparison and never mixes two payloads.
      const indented = JSON.stringify(value, null, 2);
      const compact = JSON.stringify(value);
      // Equivalence, in process, on the real value this tool returned.
      const equivalent = JSON.stringify(JSON.parse(rendered)) === JSON.stringify(JSON.parse(indented));
      // Render cost of the projection itself, median of `--samples` calls.
      const timings = [];
      for (let index = 0; index < options.samples; index += 1) {
        const start = process.hrtime.bigint();
        definition.output.render({}, value);
        timings.push(Number(process.hrtime.bigint() - start));
      }
      timings.sort((a, b) => a - b);
      samples.push({ name, tool, equivalent,
        renderedBytes: Buffer.byteLength(rendered, 'utf8'),
        indentedBytes: Buffer.byteLength(indented, 'utf8'),
        compactBytes: Buffer.byteLength(compact, 'utf8'),
        renderMedianNs: timings[Math.floor(timings.length / 2)],
        keyPaths: keyPaths(value),
        renderedDigest: sha256(rendered) });
    };

    for (const count of [0, 10, 100]) {
      if (count) fixtures.populate(core, count);
      record(`inspect-candidates-${count}`, 'evolution_runtime_inspect', core.inspect(exec.agent));
    }
    record('history-empty-default', 'evolution_history', await call('evolution_history'));
    for (let index = 0; index < 12; index += 1) worker.emit(domainRoot, `render-${index}`);
    await domain.port.flush();
    record('history-default-seeded', 'evolution_history', await call('evolution_history'));
    for (let index = 0; index < 12; index += 1) {
      await domain.port.observe({ type: 'tool/error', code: `RENDER_ERROR_${String.fromCharCode(65 + index)}`,
        target: 'plugin:render-latency', message: 'synthetic latency regression', severity: 'error' });
    }
    record('history-observations-10', 'evolution_history',
      await call('evolution_history', { collection: 'observations', limit: 10 }));
    record('history-query', 'evolution_history',
      await call('evolution_history', { query: 'synthetic latency regression', target: 'plugin:render-latency', limit: 5 }));
    record('doctor-empty-home', 'evolution_doctor', await call('evolution_doctor', { composition: false }));
    const proposalArgs = { why: 'Reduce measured runtime latency', target: 'plugin:render-latency',
      impactScope: ['runtime'], successMetrics: ['p95 latency'], risk: 'low' };
    const proposal = await call('evolution_propose', proposalArgs);
    record('propose', 'evolution_propose', proposal);
    ctx.dynamicCordisRunner.define = () => ({ pluginId: 'candidate', packageId: 'package' });
    ctx.dynamicCordisRunner.run = async () => ({ ok: true, status: 'active' });
    await call('evolution_trial', { experimentId: proposal.experimentId,
      composition: { name: 'render fixture', purpose: 'measurement shape', code: { host: 'return {};' } } });
    const observation = { solvesProblem: true, sideEffects: [], orphanResources: [],
      performanceChange: { latencyMs: { before: 100, after: 80 } }, errorChange: 'unchanged',
      beforeMetrics: { latencyMs: 100 }, afterMetrics: { latencyMs: 80 }, sampleCount: 30,
      observationWindow: '2026-10-29T00:00:00Z/2026-10-29T00:05:00Z',
      benefitEvidence: '30 synthetic samples: p95 latency 100ms -> 80ms',
      repeatable: true, regressionPassed: true, reversible: true,
      cleanupEvidence: 'Disposal proof will be collected after the observation window.' };
    record('measure', 'evolution_measure', await call('evolution_measure', { experimentId: proposal.experimentId, observation }));
    const second = await call('evolution_propose', { ...proposalArgs, target: 'plugin:render-evidence' });
    await call('evolution_trial', { experimentId: second.experimentId,
      composition: { name: 'evidence fixture', purpose: 'JSON-string evidence shape', code: { host: 'return {};' } } });
    record('measure-json-string-evidence', 'evolution_measure', await call('evolution_measure', {
      experimentId: second.experimentId,
      observation: { ...observation,
        benefitEvidence: JSON.stringify({ samples: Array.from({ length: 6 }, (_, index) => ({ index, before: 100, after: 80 })), note: 'line one\nline two' }, null, 2),
        cleanupEvidence: 'line one\nline two\nNo actual cleanup assertion in this synthetic fixture.' } }));
    record('revert', 'evolution_revert', await call('evolution_revert', { experimentId: proposal.experimentId }));

    // The shared renderer is one function for the whole surface: verify that the
    // side under test really has one renderer, not a mix.
    const renderers = new Set([...ctx.definitions.values()].map((definition) => definition.output.render));
    process.stdout.write(JSON.stringify({ toolCount: ctx.definitions.size, toolCountDeclared: EVOLUTION_TOOLS.length,
      distinctRenderers: renderers.size, node: process.version, samples }));
  } finally {
    await domain?.close();
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousCli === undefined) delete process.env.DSH_CLI; else process.env.DSH_CLI = previousCli;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Parent
// ---------------------------------------------------------------------------
function prepareTrees(options) {
  const baseline = options.baseline
    || spawnSync('git', ['rev-parse', 'HEAD~1'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  const created = options.work ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'render-compact-trees-'));
  const work = options.work || created;
  const side = (name, source) => {
    const dir = path.join(work, name);
    // Never delete a directory this run did not create: `--work` may point at
    // something the caller already has.
    if (fs.existsSync(dir)) throw new Error(`${dir} already exists; pass an empty --work directory`);
    fs.mkdirSync(dir, { recursive: true });
    const archivePath = path.join(dir, 'tree.tar');
    const archived = spawnSync('git', ['archive', '--format=tar', '-o', archivePath, source, 'lib', 'package.json'], { cwd: REPO, encoding: 'utf8' });
    if (archived.status !== 0) throw new Error(`git archive ${source} failed: ${archived.stderr}`);
    const untar = spawnSync('tar', ['-x', '-f', archivePath, '-C', dir], { encoding: 'utf8' });
    if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
    fs.rmSync(archivePath);
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
    return { dir: path.join(dir, 'lib'), source };
  };
  return { work, created, a: side('a', baseline), b: { dir: path.join(REPO, 'lib'), source: 'working tree' } };
}

function runChild(tree, options) {
  const run = spawnSync(process.execPath, ['--max-old-space-size=4096', fileURLToPath(import.meta.url),
    '--child', 'x', '--lib', tree.dir, '--samples', String(options.samples)],
    { cwd: REPO, encoding: 'utf8', timeout: 300000 });
  if (run.status !== 0) throw new Error(`child failed (${tree.dir}): ${run.stderr || run.stdout}`);
  return JSON.parse(run.stdout);
}

const options = parseArgs(process.argv.slice(2));
if (options.child) {
  await child(options);
} else {
  const trees = prepareTrees(options);
  const libDigest = (dir) => sha256(fs.readFileSync(path.join(dir, 'registration.js')));
  const identity = { a: { source: trees.a.source, registration: libDigest(trees.a.dir) },
    b: { source: trees.b.source, registration: libDigest(trees.b.dir) } };
  if (identity.a.registration === identity.b.registration) throw new Error('the two sides have identical lib/registration.js');
  // The only functional difference between the two trees must be the projection
  // itself. Both modules are loaded here, in the parent, and asked to render the
  // same probe value through the real `apply()` registration path.
  const probe = JSON.parse('{"nested":{"list":[1,{"text":"a\\nb"}]},"__proto__":{"status":"recovered"}}');
  const renderOf = async (dir) => {
    const module = await import(pathToFileURL(path.join(dir, 'registration.js')).href);
    const definitions = new Map();
    module.apply({ tools: { register: (definition) => definitions.set(definition.name, definition) },
      systemPrompt: { section: () => {} }, get: () => ({ list: () => [] }), registry: { values: () => [] },
      reflect: { props: {}, _getImpl: () => undefined }, events: {}, dynamicCordisRunner: { snapshot: () => [] } },
      { startupDrift: false, eventBridge: { emit: () => ({}) } });
    const texts = [...definitions.values()].map((definition) => definition.output.render({}, probe)[0].text);
    return { registrations: definitions.size, distinct: new Set(texts).size, text: texts[0] };
  };
  const renderedA = await renderOf(trees.a.dir);
  const renderedB = await renderOf(trees.b.dir);
  if (renderedA.distinct !== 1 || renderedB.distinct !== 1) throw new Error('one side does not share a single renderer');
  if (renderedB.text !== JSON.stringify(probe)) throw new Error('the working tree is not rendering compact JSON');
  if (renderedA.text !== JSON.stringify(probe, null, 2)) throw new Error('the baseline is not rendering indented JSON');
  if (JSON.stringify(JSON.parse(renderedA.text)) !== JSON.stringify(JSON.parse(renderedB.text))) {
    throw new Error('the two projections do not parse to the same document');
  }
  const onlyDiff = { baselineRender: 'JSON.stringify(value, null, 2)', candidateRender: 'JSON.stringify(value)',
    baselineProbeBytes: Buffer.byteLength(renderedA.text), candidateProbeBytes: Buffer.byteLength(renderedB.text),
    probedRegistrationsPerSide: [renderedA.registrations, renderedB.registrations],
    probedParseEquivalent: true };

  const rounds = [];
  for (let round = 0; round < options.rounds; round += 1) {
    // Alternate which side runs first so a drift in machine load is not one-sided.
    const order = round % 2 === 0 ? [['a', trees.a], ['b', trees.b]] : [['b', trees.b], ['a', trees.a]];
    const result = {};
    for (const [label, tree] of order) result[label] = runChild(tree, options);
    if (result.a.distinctRenderers !== 1 || result.b.distinctRenderers !== 1) throw new Error('a side mixed renderers');
    const merge = (label) => {
      const samples = result[label].samples;
      return Object.fromEntries(samples.map((sample) => [sample.name, sample]));
    };
    const a = merge('a');
    const b = merge('b');
    const perSample = Object.keys(a).map((name) => {
      const left = a[name];
      const right = b[name];
      if (!left.equivalent || !right.equivalent) throw new Error(`${name}: the projection is not parse-equivalent in process`);
      // Each side must render exactly the projection it claims, on every real
      // DTO it produced - not just on the probe.
      if (left.renderedBytes !== left.indentedBytes) throw new Error(`${name}: the baseline did not render indented JSON`);
      if (right.renderedBytes !== right.compactBytes) throw new Error(`${name}: the candidate did not render compact JSON`);
      // A report whose content depends on the environment (doctor) can list a
      // different set of checks in two temp homes, so its two payloads are not
      // the same document. The saving for every sample is therefore taken from
      // one side's own value (below); this flag only says whether the *other*
      // side happened to produce the same structure and can be cross-checked.
      const sameKeyStructure = left.keyPaths.join('\u0000') === right.keyPaths.join('\u0000');
      const savedB = right.indentedBytes - right.compactBytes;
      return { name, indentedBytes: right.indentedBytes, compactBytes: right.compactBytes,
        savedBytes: savedB,
        reductionPercent: Number((savedB / right.indentedBytes * 100).toFixed(2)),
        baselineIndentedBytes: left.indentedBytes, baselineCompactBytes: left.compactBytes,
        baselineSavedBytes: left.indentedBytes - left.compactBytes,
        crossSideSavingsAgree: (left.indentedBytes - left.compactBytes) === savedB,
        indentedRenderMedianNs: left.renderMedianNs, compactRenderMedianNs: right.renderMedianNs,
        equivalent: true, sameKeyStructure };
    });
    rounds.push({ round, toolCountA: result.a.toolCount, toolCountB: result.b.toolCount, samples: perSample });
  }
  const names = rounds[0].samples.map((sample) => sample.name);
  const summary = names.map((name) => {
    const rows = rounds.map((round) => round.samples.find((sample) => sample.name === name));
    const median = (values) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)];
    return { name, indentedBytes: rows[0].indentedBytes, compactBytes: rows[0].compactBytes,
      savedBytes: rows[0].savedBytes, reductionPercent: rows[0].reductionPercent,
      sameKeyStructure: rows[0].sameKeyStructure,
      crossSideSavingsAgree: rows.every((row) => row.crossSideSavingsAgree),
      reductionPercentMedian: Number(median(rows.map((row) => row.reductionPercent)).toFixed(2)),
      indentedRenderMedianNs: median(rows.map((row) => row.indentedRenderMedianNs)),
      compactRenderMedianNs: median(rows.map((row) => row.compactRenderMedianNs)) };
  });
  // A session keeps a tool result in context, so a compacted result is saved
  // again on each later request that still carries it. The retention inside the
  // model is an assumption, not a measurement: there is no captured context
  // trimming, provider caching or request count here.
  const retained = (name, requests) => {
    const row = summary.find((entry) => entry.name === name);
    const bytes = row.savedBytes * requests;
    return { scenario: `${name} retained for ${requests} more requests`, savedBytes: bytes,
      savedTokensEstimated: Number((bytes / 3.6).toFixed(0)) };
  };
  const combined = (names, requests) => {
    const bytes = names.reduce((sum, name) => sum + summary.find((entry) => entry.name === name).savedBytes, 0) * requests;
    return { scenario: `${names.join(' + ')} retained for ${requests} more requests`, savedBytes: bytes,
      savedTokensEstimated: Number((bytes / 3.6).toFixed(0)) };
  };
  const contextModel = [
    retained('inspect-candidates-10', 50),
    retained('inspect-candidates-100', 50),
    combined(['inspect-candidates-10', 'propose', 'measure'], 50),
    combined(['inspect-candidates-10', 'propose', 'measure'], 200),
  ];
  const report = { environment: { node: process.version, platform: process.platform, arch: process.arch,
      cpus: os.cpus().length, samplesPerRender: options.samples, rounds: options.rounds },
    identity, sourcePin: identity, onlyDiff,
    method: 'Each side is its own process and its own tree; both run the same scenario against the real registered tool surface. '
      + 'For every sample both projections are taken from that side\'s own returned value, in that process, so the reported byte '
      + 'delta never compares two different payloads; each side also has to render exactly the projection it claims on every real '
      + 'DTO. crossSideSavingsAgree only says the other side\'s payload happened to have the same structure. Tokens are estimated as '
      + 'bytes/3.6 and are not tokenizer or billing measurements.',
    rounds, summary,
    contextModel,
    contextModelNote: 'Model only: assumes every listed result stays in context and is re-sent on every later request. '
      + 'Real context trimming, provider caching and request counts are not measured.' };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) fs.writeFileSync(options.out, text);
  if (trees.created) fs.rmSync(trees.created, { recursive: true, force: true });
  process.stdout.write(text);
}
