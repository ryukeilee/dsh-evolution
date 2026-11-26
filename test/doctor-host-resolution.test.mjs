// doctor host resolution: static wrapper/ASAR analysis, bounded probes, and
// fail-closed reporting. Every fixture is a temporary directory; no test
// depends on a CLI installed on the developer machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveHostCli, defaultRunDumpConfig, collectDiagnostics, resolveEvolutionPaths } from '../lib/diagnostics.js';

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run fn with a controlled PATH and no DSH_CLI so only the intended candidates exist. */
function withPath(binDir, fn) {
  const savedPath = process.env.PATH;
  const savedDshCli = process.env.DSH_CLI;
  process.env.PATH = binDir;
  delete process.env.DSH_CLI;
  try { return fn(); } finally {
    process.env.PATH = savedPath;
    if (savedDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = savedDshCli;
  }
}

async function withPathAsync(binDir, fn) {
  const savedPath = process.env.PATH;
  const savedDshCli = process.env.DSH_CLI;
  process.env.PATH = binDir;
  delete process.env.DSH_CLI;
  try { return await fn(); } finally {
    process.env.PATH = savedPath;
    if (savedDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = savedDshCli;
  }
}

function makeDshPackage(root, version, binSource = 'export {};\n') {
  const pkg = path.join(root, 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  const manifest = { name: '@deepseek-ai/dsh' };
  if (version !== null) manifest.version = version;
  fs.writeFileSync(path.join(pkg, 'package.json'), `${JSON.stringify(manifest)}\n`);
  const bin = path.join(pkg, 'lib', 'bin.js');
  fs.writeFileSync(bin, binSource);
  return { pkg, bin };
}

function pointerWrapper(file, targetBin) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\nexec ${process.execPath} "${targetBin}" "$@"\n`);
  fs.chmodSync(file, 0o755);
}

/** A minimal ASAR: 16-byte header with the manifest tree, then manifest bytes. */
function makeAsar(file, manifests) {
  const tree = { files: {} };
  const chunks = [];
  let offset = 0;
  for (const { internalPath, value } of manifests) {
    const bytes = Buffer.from(JSON.stringify(value), 'utf8');
    const parts = internalPath.split('/');
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      node.files ??= {};
      node.files[part] ??= { files: {} };
      node = node.files[part];
    }
    node.files[parts.at(-1)] = { size: String(bytes.length), offset: String(offset) };
    chunks.push(bytes);
    offset += bytes.length;
  }
  const json = Buffer.from(JSON.stringify(tree), 'utf8');
  const header = Buffer.alloc(16);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(16 + json.length, 4);
  header.writeUInt32LE(8 + json.length, 8);
  header.writeUInt32LE(json.length, 12);
  fs.writeFileSync(file, Buffer.concat([header, json, ...chunks]));
}

function doctorHome(t) {
  const home = tmp(t, 'host-res-doctor-');
  const paths = resolveEvolutionPaths({ dshHome: home });
  fs.mkdirSync(paths.dataRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.keyPath, 'd'.repeat(64), { mode: 0o600 });
  return home;
}

test('wrapper exposes both exec branches, nested wrappers, $0/dirname, quotes and spaced paths', (t) => {
  const dir = tmp(t, 'host-res-wrapper-');
  const one = makeDshPackage(path.join(dir, 'host a'), '1.0.0');
  const two = makeDshPackage(path.join(dir, 'host-b'), '2.0.0');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(bin, 'nested'), { recursive: true });
  const nested = path.join(bin, 'nested', 'dsh');
  pointerWrapper(nested, two.bin);
  const outer = path.join(bin, 'dsh');
  fs.writeFileSync(outer, `#!/bin/sh
here=$0
root=$(CDPATH= cd -- "$(dirname -- "$here")/.." && pwd -P)
if [ "$1" = 'a' ]; then
  exec '${process.execPath}' "$root/host a/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"
fi
exec "${nested}" "$@"
`);
  fs.chmodSync(outer, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: outer }));
  assert.equal(result.selected.source, 'argument');
  // The explicit winner is the first statically proven branch (1.0.0), but both
  // branches must be visible so the caller can attribute the other host.
  assert.equal(result.selected.version, '1.0.0');
  assert.deepEqual(result.candidates.filter((candidate) => candidate.isDsh).map((candidate) => candidate.version).sort(), ['1.0.0', '2.0.0']);
});

test('unknown wrapper syntax fails closed instead of guessing an exec target', (t) => {
  const dir = tmp(t, 'host-res-failclosed-');
  const sh = path.join(dir, 'sh-dsh');
  fs.writeFileSync(sh, '#!/bin/sh\nexec $(which dsh) "$@"\n');
  fs.chmodSync(sh, 0o755);
  const perl = path.join(dir, 'perl-dsh');
  fs.writeFileSync(perl, '#!/usr/bin/perl\nprint "x";\n');
  fs.chmodSync(perl, 0o755);
  for (const file of [sh, perl]) {
    const result = withPath('', () => resolveHostCli({ cliPath: file }));
    assert.equal(result.selected, null, `${file} must not resolve to a host`);
  }
});

test('in-ASAR manifests identify a packaged DSH host without executing anything', (t) => {
  const dir = tmp(t, 'host-res-asar-');
  const asar = path.join(dir, 'app.asar');
  makeAsar(asar, [
    { internalPath: 'dsh/node_modules/@deepseek-ai/dsh/package.json', value: { name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' } },
    { internalPath: 'dsh/node_modules/@deepseek-ai/cordis/package.json', value: { name: '@deepseek-ai/cordis', version: '4.1.0' } },
    { internalPath: 'dsh/node_modules/@deepseek-ai/cordis-plugin-include/package.json', value: { name: '@deepseek-ai/cordis-plugin-include', version: '1.1.0' } },
  ]);
  const entry = `${asar}/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`;
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec /mock/binary --expose-internals "${entry}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected.version, '0.2.2-rc.5');
  assert.equal(result.selected.packageRoot, null);
  assert.deepEqual(result.selected.hostFacts, { dsh: '0.2.2-rc.5', cordis: '4.1.0', include: '1.1.0' });
});

test('selection order: explicit > running entry > highest semver; same version keeps candidate order', (t) => {
  const dir = tmp(t, 'host-res-select-');
  const v1 = makeDshPackage(path.join(dir, 'a'), '1.0.0');
  const v2 = makeDshPackage(path.join(dir, 'b'), '2.0.0');
  const v2b = makeDshPackage(path.join(dir, 'b2'), '2.0.0');
  const bin = path.join(dir, 'bin');
  const onPath = path.join(bin, 'dsh');
  pointerWrapper(onPath, v2.bin); // PATH: 2.0.0
  const profileDir = path.join(dir, 'profile');
  const profileBin = path.join(profileDir, 'node_modules', '.bin', 'dsh');
  pointerWrapper(profileBin, v1.bin); // profile: 1.0.0

  const highest = withPath(bin, () => resolveHostCli({ profileDir }));
  assert.equal(highest.selected.version, '2.0.0');
  assert.equal(highest.selected.source, 'PATH');

  const explicit = withPath(bin, () => resolveHostCli({ cliPath: v1.bin, profileDir }));
  assert.equal(explicit.selected.version, '1.0.0');
  assert.equal(explicit.selected.source, 'argument');

  const running = withPath(bin, () => resolveHostCli({ runningEntry: v1.bin }));
  assert.equal(running.selected.version, '1.0.0');
  assert.equal(running.selected.source, 'running-process');

  const both = withPath(bin, () => resolveHostCli({ cliPath: v1.bin, runningEntry: v2.bin }));
  assert.equal(both.selected.source, 'argument');
  assert.equal(both.selected.version, '1.0.0');

  pointerWrapper(profileBin, v2b.bin); // profile and PATH now tie at 2.0.0
  const tie = withPath(bin, () => resolveHostCli({ profileDir }));
  assert.equal(tie.selected.version, '2.0.0');
  assert.equal(tie.selected.source, 'profile-node-modules');
});

test('version probe: explicit only, bounded, semantic output; failures become unknown', (t) => {
  const dir = tmp(t, 'host-res-probe-');
  const ok = makeDshPackage(path.join(dir, 'ok'), null, 'console.log("3.4.5")\n');
  const invalid = makeDshPackage(path.join(dir, 'invalid'), null, 'console.log("not-a-version")\n');
  const failed = makeDshPackage(path.join(dir, 'failed'), null, 'process.exit(1)\n');
  const timeout = makeDshPackage(path.join(dir, 'timeout'), null, 'setInterval(() => {}, 1000)\n');

  assert.equal(withPath('', () => resolveHostCli({ cliPath: ok.bin })).selected.version, '3.4.5');
  assert.equal(withPath('', () => resolveHostCli({ cliPath: invalid.bin })).selected.version, null);
  assert.equal(withPath('', () => resolveHostCli({ cliPath: failed.bin })).selected.version, null);
  const started = Date.now();
  assert.equal(withPath('', () => resolveHostCli({ cliPath: timeout.bin })).selected.version, null);
  assert.ok(Date.now() - started < 8000, 'the probe is bounded by its 5s timeout');
});

test('a PATH candidate that looks like DSH is never executed', (t) => {
  const dir = tmp(t, 'host-res-lookalike-');
  const lookalikeDir = path.join(dir, '@deepseek-ai', 'dsh-9.9.9', 'bin');
  fs.mkdirSync(lookalikeDir, { recursive: true });
  const marker = path.join(dir, 'marker');
  const fake = path.join(lookalikeDir, 'dsh');
  fs.writeFileSync(fake, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\nconsole.log('9.9.9');\n`);
  fs.chmodSync(fake, 0o755);

  const result = withPath(lookalikeDir, () => resolveHostCli({}));
  assert.equal(result.selected, null, 'a path-looking candidate without a manifest is not a host');
  assert.equal(fs.existsSync(marker), false, 'no probe or any other execution touched the PATH candidate');
});

test('unresolved host reports unknown, hints --dsh-cli and never falls back to the bundle peer', async (t) => {
  const result = withPath('', () => resolveHostCli({}));
  assert.equal(result.selected, null);
  assert.equal(result.reason, 'path-cli-unresolved');
  assert.equal(result.candidates.some((candidate) => candidate.source === 'plugin-node-modules'), false);

  const dshHome = doctorHome(t);
  const report = await withPathAsync('', () => collectDiagnostics({ dshHome, probe: { skipComposition: true } }));
  const cli = report.checks.find((check) => check.id === 'host.cli');
  assert.equal(cli.level, 'not-evaluated');
  assert.match(cli.remediation, /--dsh-cli/);
  assert.equal(JSON.stringify(cli.evidence).includes('plugin-node-modules'), false);
});

test('a host without a Node-resolvable package root keeps host.modules not-evaluated with hostFacts', async (t) => {
  const dir = tmp(t, 'host-res-modules-');
  const asar = path.join(dir, 'app.asar');
  makeAsar(asar, [
    { internalPath: 'dsh/node_modules/@deepseek-ai/dsh/package.json', value: { name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' } },
    { internalPath: 'dsh/node_modules/@deepseek-ai/cordis/package.json', value: { name: '@deepseek-ai/cordis', version: '4.1.0' } },
  ]);
  const entry = `${asar}/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`;
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec /mock/binary "${entry}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  const cli = withPath('', () => resolveHostCli({ cliPath: wrapper })).selected;
  assert.equal(cli.version, '0.2.2-rc.5');

  const dshHome = doctorHome(t);
  const report = await collectDiagnostics({ dshHome, cliPath: wrapper, probe: { skipComposition: true } });
  const modules = report.checks.find((check) => check.id === 'host.modules');
  assert.equal(modules.level, 'not-evaluated');
  assert.equal(modules.evidence.reason, 'host-package-root-unavailable');
  assert.equal(modules.evidence.hostFacts.dsh, '0.2.2-rc.5');
  assert.deepEqual(modules.evidence.hostFacts.cordis, '4.1.0');
  assert.equal(modules.evidence.hostFacts.include, undefined);
  assert.doesNotMatch(modules.summary, /packaged ASAR host/);
});

test('defaultRunDumpConfig executes a shell wrapper directly and still uses node for .js', (t) => {
  const dir = tmp(t, 'host-res-dump-');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, '#!/bin/sh\nprintf "%s\\n" "WRAPPER-MARKER"\n');
  fs.chmodSync(wrapper, 0o755);
  const direct = defaultRunDumpConfig({ cliPath: wrapper, dshHome: dir, profile: 'acp' });
  assert.equal(direct.status, 0);
  assert.match(direct.stdout, /WRAPPER-MARKER/);
  assert.doesNotMatch(direct.stderr, /SyntaxError/);

  const script = path.join(dir, 'cli.js');
  fs.writeFileSync(script, 'console.log("NODE-MARKER");\n');
  const viaNode = defaultRunDumpConfig({ cliPath: script, dshHome: dir, profile: 'acp' });
  assert.equal(viaNode.status, 0);
  assert.match(viaNode.stdout, /NODE-MARKER/);
});
