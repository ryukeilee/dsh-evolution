// doctor host resolution: static wrapper/ASAR analysis, bounded probes, and
// fail-closed reporting. Every fixture is a temporary directory; no test
// depends on a CLI installed on the developer machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveHostCli, defaultRunDumpConfig, collectDiagnostics, resolveEvolutionPaths, observedHostFacts } from '../lib/diagnostics.js';

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
function makeAsar(file, manifests, { padded = false } = {}) {
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
  // Pickle header: [4, header payload size][4, string length][json][padding].
  // A padded header keeps the file data offset distinct from 16 + jsonLength.
  const padding = padded ? ((4 - (json.length % 4)) % 4) || 4 : 0;
  const headerSize = 8 + json.length + padding;
  const header = Buffer.alloc(16);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(headerSize, 4);
  header.writeUInt32LE(4, 8);
  header.writeUInt32LE(json.length, 12);
  fs.writeFileSync(file, Buffer.concat([header, json, Buffer.alloc(padding), ...chunks]));
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

test('ASAR 4-byte header padding does not shift in-ASAR manifest offsets', (t) => {
  const dir = tmp(t, 'host-res-asar-pad-');
  const asar = path.join(dir, 'app.asar');
  makeAsar(asar, [
    { internalPath: 'dsh/node_modules/@deepseek-ai/dsh/package.json', value: { name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' } },
  ], { padded: true });
  const entry = `${asar}/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`;
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec /mock/binary "${entry}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);

  const selected = withPath('', () => resolveHostCli({ runningEntry: wrapper })).selected;
  assert.equal(selected.version, '0.2.2-rc.5', 'a padded ASAR header still yields the manifest version');
  assert.equal(selected.hostFacts.dsh, '0.2.2-rc.5');
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
  const timeout = makeDshPackage(path.join(dir, 'timeout'), null,
    'process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000)\n');
  const badSemver = makeDshPackage(path.join(dir, 'bad-semver'), null, 'console.log("01.2.3-..")\n');

  assert.equal(withPath('', () => resolveHostCli({ cliPath: ok.bin })).selected.version, '3.4.5');
  assert.equal(withPath('', () => resolveHostCli({ cliPath: invalid.bin })).selected.version, null);
  assert.equal(withPath('', () => resolveHostCli({ cliPath: failed.bin })).selected.version, null);
  assert.equal(withPath('', () => resolveHostCli({ cliPath: badSemver.bin })).selected.version, null,
    'a shape-looking but semantically invalid version stays unknown');
  const started = Date.now();
  assert.equal(withPath('', () => resolveHostCli({ cliPath: timeout.bin })).selected.version, null);
  assert.ok(Date.now() - started < 6500, 'SIGKILL bounds even a SIGTERM-ignoring probe at 5s');
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

test('composition launches the outermost wrapper while identity uses the terminal entry', async (t) => {
  const dir = tmp(t, 'host-res-launch-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.5');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(bin, 'nested'), { recursive: true });
  const inner = path.join(bin, 'nested', 'dsh');
  pointerWrapper(inner, dsh.bin);
  const outer = path.join(bin, 'dsh');
  fs.writeFileSync(outer, `#!/bin/sh\nexec "${inner}" "$@"\n`);
  fs.chmodSync(outer, 0o755);

  const selected = withPath('', () => resolveHostCli({ cliPath: outer })).selected;
  assert.equal(selected.path, outer, 'composition must launch the outermost wrapper');
  assert.equal(selected.entryPath, dsh.bin, 'the terminal entry is only identity evidence');
  assert.equal(selected.version, '0.2.2-rc.5');

  let seen;
  await collectDiagnostics({
    dshHome: doctorHome(t), cliPath: outer, profile: 'web',
    probe: { runDumpConfig: ({ cliPath }) => {
      seen = cliPath;
      return { status: 0, stdout: '', stderr: '' };
    } },
  });
  assert.equal(seen, outer, 'the dump-config probe receives the outermost launch path');
});

test('heredoc bodies are data, not exec branches', (t) => {
  const dir = tmp(t, 'host-res-heredoc-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '9.9.9');
  const hidden = path.join(dir, 'hidden-dsh');
  fs.writeFileSync(hidden, `#!/bin/sh
cat <<'EOF' > /dev/null
exec ${process.execPath} "${dsh.bin}" "$@"
EOF
exec /bin/false "$@"
`);
  fs.chmodSync(hidden, 0o755);
  assert.equal(withPath('', () => resolveHostCli({ cliPath: hidden })).selected, null,
    'an exec inside a heredoc is not a candidate');

  const visible = path.join(dir, 'visible-dsh');
  fs.writeFileSync(visible, `#!/bin/sh
cat <<EOF
exec /bin/false "$@"
EOF
exec ${process.execPath} "${dsh.bin}" "$@"
`);
  fs.chmodSync(visible, 0o755);
  assert.equal(withPath('', () => resolveHostCli({ cliPath: visible })).selected.version, '9.9.9',
    'an exec after the heredoc delimiter is still parsed');
});

test('partial host facts never borrow missing fields from process identity', (t) => {
  const facts = observedHostFacts({ dsh: '0.2.2-rc.5', cordis: '4.1.0', runningEntry: '/some/entry' });
  assert.equal(facts.dsh, '0.2.2-rc.5');
  assert.equal(facts.cordis, '4.1.0');
  assert.equal(facts.include, null, 'a partially described host keeps missing fields null');

  const fallback = observedHostFacts({});
  assert.ok(Object.hasOwn(fallback, 'include'), 'with no facts the process-identity fallback still applies');
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

test('ASAR entry parsing stays linear on long .asar-like paths', (t) => {
  // 20k repeated ".asar/a" fragments ending in an empty ".asar/": the former
  // greedy /(.*\.asar)\/(.+)$/ had to re-split every candidate at the end and
  // backtracked polynomially. A linear lastIndexOf scan must finish in ms.
  const long = `/tmp/host/${'.asar/a'.repeat(20000)}.asar/`;
  const started = Date.now();
  const result = withPath('', () => resolveHostCli({ cliPath: long }));
  const elapsed = Date.now() - started;
  assert.equal(result.selected, null);
  assert.ok(elapsed < 1000, `ASAR path parsing must stay linear, took ${elapsed}ms`);
});

test('the composition probe stays read-only until the profile is fully initialized', async (t) => {
  const dir = tmp(t, 'host-res-composition-readonly-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.5', 'console.log("");\n');
  const marker = path.join(dir, 'marker');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nprintf x > "${marker}"\nexec ${process.execPath} "${dsh.bin}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  const dshHome = doctorHome(t);
  const profileDir = path.join(dshHome, 'profiles', 'acp');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'cordis.yml'), '');
  const countFiles = (root) => fs.readdirSync(root, { withFileTypes: true })
    .reduce((sum, entry) => sum + (entry.isDirectory() ? countFiles(path.join(root, entry.name)) : 1), 0);
  const before = countFiles(profileDir);

  const report = await collectDiagnostics({ dshHome, cliPath: wrapper, profile: 'acp' });
  const composition = report.checks.find((check) => check.id === 'host.composition');
  assert.equal(composition.level, 'not-evaluated');
  assert.match(composition.evidence.reason, /read-only/);
  assert.equal(fs.existsSync(marker), false, 'the doctor must not run a probe that creates profile state');
  assert.equal(countFiles(profileDir), before, 'a partial profile must not gain config files');

  // An injected hermetic probe keeps its existing behavior even on a partial profile.
  let called = false;
  await collectDiagnostics({
    dshHome, cliPath: wrapper, profile: 'acp',
    probe: { runDumpConfig: () => { called = true; return { status: 0, stdout: '', stderr: '' }; } },
  });
  assert.equal(called, true, 'an injected probe still runs');

  // A fully initialized profile allows the real probe to execute the wrapper.
  for (const name of ['cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']) {
    fs.writeFileSync(path.join(profileDir, name), '');
  }
  fs.mkdirSync(path.join(profileDir, 'node_modules'));
  await collectDiagnostics({ dshHome, cliPath: wrapper, profile: 'acp' });
  assert.equal(fs.existsSync(marker), true, 'a complete profile is probed normally');
});

test('ASAR reads bypass the Electron asar patch and restore process.noAsar', (t) => {
  const dir = tmp(t, 'host-res-electron-asar-');
  const asar = path.join(dir, 'app.asar');
  makeAsar(asar, [
    { internalPath: 'dsh/node_modules/@deepseek-ai/dsh/package.json', value: { name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' } },
  ]);
  const entry = `${asar}/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`;
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec /mock/binary "${entry}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);

  const original = fs.openSync;
  const before = process.noAsar;
  fs.openSync = function patched(file, ...args) {
    if (String(file).includes('.asar') && process.noAsar !== true) {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    return original.call(this, file, ...args);
  };
  try {
    const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
    assert.equal(result.selected?.version, '0.2.2-rc.5');
    assert.equal(result.selected.hostFacts.dsh, '0.2.2-rc.5');
    assert.equal(process.noAsar, before, 'the original noAsar value is restored');
  } finally {
    fs.openSync = original;
    process.noAsar = before;
  }
});

test('heredoc comments do not start a heredoc and terminators match exactly', (t) => {
  const dir = tmp(t, 'host-res-heredoc-edge-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '9.9.9');
  const commented = path.join(dir, 'commented-dsh');
  fs.writeFileSync(commented, `#!/bin/sh\n# <<EOF\nexec ${process.execPath} "${dsh.bin}" "$@"\n`);
  fs.chmodSync(commented, 0o755);
  assert.equal(withPath('', () => resolveHostCli({ cliPath: commented })).selected?.version, '9.9.9',
    'a heredoc marker in a comment must not swallow the real exec');

  const spaceIndent = path.join(dir, 'space-indent-dsh');
  fs.writeFileSync(spaceIndent, `#!/bin/sh\ncat <<-EOF\nexec ${process.execPath} "${dsh.bin}" "$@"\n  EOF\nexec /bin/false "$@"\n`);
  fs.chmodSync(spaceIndent, 0o755);
  assert.equal(withPath('', () => resolveHostCli({ cliPath: spaceIndent })).selected, null,
    'space-indented EOF does not terminate a <<- heredoc');

  const tabIndent = path.join(dir, 'tab-indent-dsh');
  fs.writeFileSync(tabIndent, `#!/bin/sh\ncat <<-EOF\nexec /bin/false "$@"\n\tEOF\nexec ${process.execPath} "${dsh.bin}" "$@"\n`);
  fs.chmodSync(tabIndent, 0o755);
  assert.equal(withPath('', () => resolveHostCli({ cliPath: tabIndent })).selected?.version, '9.9.9',
    'a tab-indented EOF terminates a <<- heredoc');
});

test('dump-config runs a suffixless symlink to a JS entry through node', (t) => {
  const dir = tmp(t, 'host-res-symlink-');
  const target = path.join(dir, 'cli.js');
  fs.writeFileSync(target, 'console.log("SYMLINK-MARKER");\n');
  fs.chmodSync(target, 0o644); // deliberately not executable
  const link = path.join(dir, 'dsh');
  fs.symlinkSync(target, link);
  const outcome = defaultRunDumpConfig({ cliPath: link, dshHome: dir, profile: 'acp' });
  assert.equal(outcome.status, 0);
  assert.match(outcome.stdout, /SYMLINK-MARKER/);
});

test('two heredocs on one line fail closed', (t) => {
  const dir = tmp(t, 'host-res-heredoc-multi-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '9.9.9');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
cat <<A <<B
exec ${process.execPath} "${dsh.bin}" "$@"
A
exec ${process.execPath} "${dsh.bin}" "$@"
B
`);
  fs.chmodSync(wrapper, 0o755);
  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null, 'ambiguous heredoc bodies must not expose exec candidates');
});

test('a .js argument to an ordinary binary is not a host entry', (t) => {
  const dir = tmp(t, 'host-res-js-arg-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '9.9.9');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec /bin/echo "${dsh.bin}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null, '/bin/echo is a binary; its .js argument is not a Node entry');
});

test('a direct .js entry is still resolved as a Node host', (t) => {
  const dir = tmp(t, 'host-res-direct-js-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '9.9.9');
  const result = withPath('', () => resolveHostCli({ cliPath: dsh.bin }));
  assert.equal(result.selected?.version, '9.9.9');
});
