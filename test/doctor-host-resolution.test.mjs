// doctor host resolution: static wrapper/ASAR analysis, bounded probes, and
// fail-closed reporting. Every fixture is a temporary directory; no test
// depends on a CLI installed on the developer machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('a one-line case that only assigns a variable does not hide a direct exec target', (t) => {
  const dir = tmp(t, 'host-res-inline-assignment-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
profile=''
for argument in "$@"; do
  case "$argument" in --profile=*) profile=\${argument#--profile=} ;; esac
done
exec ${process.execPath} "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected?.version, '0.2.2-rc.1');
  assert.equal(result.candidates[0].error, undefined);
});

test('a one-line assignment case accepts the POSIX optional opening parenthesis', (t) => {
  const dir = tmp(t, 'host-res-inline-assignment-paren-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$1" in (--profile=*) profile=\${1#--profile=} ;; esac
exec ${process.execPath} "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected?.version, '0.2.2-rc.1');
  assert.equal(result.candidates[0].error, undefined);
});

test('a one-line assignment case accepts in( without whitespace', (t) => {
  const dir = tmp(t, 'host-res-inline-assignment-in-paren-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$1" in(--profile=*) profile=\${1#--profile=} ;; esac
exec ${process.execPath} "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected?.version, '0.2.2-rc.1');
  assert.equal(result.candidates[0].error, undefined);
});

test('a one-line assignment case cannot smuggle a command substitution', (t) => {
  const dir = tmp(t, 'host-res-inline-assignment-command-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const marker = path.join(dir, 'marker');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$argument" in --profile=*) profile=\$(touch "${marker}") ;; esac
exec ${process.execPath} "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null);
  assert.equal(result.candidates[0].error, 'NO_EXEC_TARGET');
  assert.equal(fs.existsSync(marker), false, 'static resolution must not execute the wrapper');
});

test('a conditional inline assignment invalidates a previously known launch path', (t) => {
  const dir = tmp(t, 'host-res-inline-assignment-stale-path-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
here=$0
case "$argument" in --profile=*) here=/unattributable ;; esac
exec ${process.execPath} "$here" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null, 'the pre-case $0 value must not attribute a conditional replacement');
  assert.equal(result.candidates[0].error, 'UNRESOLVED_EXEC_TARGET');
  assert.equal(result.candidates[0].unresolvedBranches[0].path, process.execPath);
  assert.equal(result.candidates[0].unresolvedBranches[0].wrapperPath, wrapper);
  assert.equal(result.candidates[0].unresolvedBranches[0].line, 4);
  assert.match(result.candidates[0].unresolvedBranches[0].detail, /script entry/);
});

test('an unresolved launch branch suppresses later explicit version probes', (t) => {
  const dir = tmp(t, 'host-res-no-probe-after-unresolved-');
  const marker = path.join(dir, 'marker');
  const dsh = makeDshPackage(path.join(dir, 'host'), null, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = 'web' ]; then
  exec \$(which dsh) "$@"
fi
exec ${process.execPath} "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null);
  assert.equal(result.candidates[0].error, 'UNRESOLVED_EXEC_TARGET');
  assert.equal(fs.existsSync(marker), false, 'a wrapper already known to be unattributable must not execute a later branch');
});

test('repeated shell targets in sibling branches are not mistaken for a wrapper cycle', (t) => {
  const dir = tmp(t, 'host-res-shared-shell-target-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const inner = path.join(dir, 'inner-dsh');
  pointerWrapper(inner, dsh.bin);
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = 'web' ]; then
  exec "${inner}" "$@"
fi
exec "${inner}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected?.version, '0.2.2-rc.1');
  assert.deepEqual(result.candidates.filter((candidate) => candidate.isDsh).map((candidate) => candidate.version), ['0.2.2-rc.1', '0.2.2-rc.1']);
});

test('an assignment case plus an unattributable branch reports that branch instead of NO_EXEC_TARGET', (t) => {
  const dir = tmp(t, 'host-res-inline-assignment-branches-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const desktop = path.join(dir, 'desktop', 'dsh');
  fs.mkdirSync(path.dirname(desktop), { recursive: true });
  fs.writeFileSync(desktop, `#!/bin/sh
case "$target" in
  /*) launcher=$target ;;
esac
`);
  fs.chmodSync(desktop, 0o755);
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
profile=''
for argument in "$@"; do
  case "$argument" in --profile=*) profile=\${argument#--profile=} ;; esac
done
if [ "$profile" = 'acp' ]; then
  exec "${desktop}" "$@"
fi
exec ${process.execPath} "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null, 'one unresolved branch must still fail the whole wrapper closed');
  assert.equal(result.candidates[0].error, 'UNRESOLVED_EXEC_TARGET');
  assert.deepEqual(result.candidates[0].unresolvedBranches, [{
    path: desktop,
    error: 'NO_EXEC_TARGET',
    detail: 'no exec target is attributable under the supported static grammar; unsupported control flow is fail-closed',
  }]);
});

test('a case pattern may have whitespace before its closing parenthesis', (t) => {
  const dir = tmp(t, 'host-res-inline-assignment-pattern-space-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$1" in foo ) profile=hello ;; esac
exec ${process.execPath} "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(spawnSync('/bin/sh', ['-n', wrapper]).status, 0, 'the fixture is valid POSIX shell');

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected?.version, '0.2.2-rc.1');
  assert.equal(result.candidates[0].error, undefined);
});

test('an unclosed quote in the case selector cannot turn quoted text into a launch branch', (t) => {
  const dir = tmp(t, 'host-res-case-selector-quote-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$x in *) profile=x ;; esac
exec ${process.execPath} "${dsh.bin}" "$@"
x" in *) : ;; esac
`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(spawnSync('/bin/sh', ['-n', wrapper]).status, 0, 'the fixture is valid POSIX shell');

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null, 'exec text inside a multi-line case selector is data, not a launch branch');
  assert.equal(result.candidates[0].error, 'NO_EXEC_TARGET');
});

test('an escaped quote in the case selector cannot turn quoted text into a launch branch', (t) => {
  const dir = tmp(t, 'host-res-case-selector-escaped-quote-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "x\\" in *) profile=x ;; esac
exec ${process.execPath} "${dsh.bin}" "$@"
x" in *) : ;; esac
`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(spawnSync('/bin/sh', ['-n', wrapper]).status, 0, 'the fixture is valid POSIX shell');

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null, 'exec text inside a multi-line escaped selector is data');
  assert.equal(result.candidates[0].error, 'NO_EXEC_TARGET');
});

test('a parameter expansion in the case selector cannot turn its body into a launch branch', (t) => {
  const dir = tmp(t, 'host-res-case-selector-parameter-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "\${1:-" in *) profile=x ;; esac
exec ${process.execPath} "${dsh.bin}" "$@"
"}" in *) : ;; esac
`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(spawnSync('/bin/sh', ['-n', wrapper]).status, 0, 'the fixture is valid POSIX shell');

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null, 'exec text inside a multi-line selector expansion is data');
  assert.equal(result.candidates[0].error, 'NO_EXEC_TARGET');
});

test('a single-quoted backtick in the case selector stays literal', (t) => {
  const dir = tmp(t, 'host-res-case-selector-literal-backtick-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case '\`test\`' in *) profile=x ;; esac
exec ${process.execPath} "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(spawnSync('/bin/sh', ['-n', wrapper]).status, 0, 'the fixture is valid POSIX shell');

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected?.version, '0.2.2-rc.1');
});

test('an unclosed parameter expansion cannot turn its body into a launch branch', (t) => {
  const dir = tmp(t, 'host-res-inline-assignment-parameter-expansion-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$1" in *) profile=\${1:-;; esac
exec ${process.execPath} "${dsh.bin}" "$@"
} ;; esac
`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(spawnSync('/bin/sh', ['-n', wrapper]).status, 0, 'the fixture is valid POSIX shell');

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null, 'exec text inside a multi-line parameter expansion is data, not a launch branch');
  assert.equal(result.candidates[0].error, 'NO_EXEC_TARGET');
});

test('a double-quoted parameter expansion cannot hide a multi-line launch-looking value', (t) => {
  const dir = tmp(t, 'host-res-inline-assignment-quoted-parameter-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$1" in *) profile="\${1:-" ;; esac
exec ${process.execPath} "${dsh.bin}" "$@"
"}" ;; esac
`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(spawnSync('/bin/sh', ['-n', wrapper]).status, 0, 'the fixture is valid POSIX shell');

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null, 'exec text inside a multi-line double-quoted parameter expansion is data');
  assert.equal(result.candidates[0].error, 'NO_EXEC_TARGET');
});

test('a nested quoted parameter expansion cannot hide a multi-line launch-looking value', (t) => {
  const dir = tmp(t, 'host-res-inline-assignment-nested-parameter-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$1" in *) profile="\${1:-"\${2:-"}" ;; esac
exec ${process.execPath} "${dsh.bin}" "$@"
}"}" ;; esac
`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(spawnSync('/bin/sh', ['-n', wrapper]).status, 0, 'the fixture is valid POSIX shell');

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null, 'exec text inside a nested multi-line parameter expansion is data');
  assert.equal(result.candidates[0].error, 'NO_EXEC_TARGET');
});

test('a single-quoted parameter-expansion prefix stays a literal assignment value', (t) => {
  const dir = tmp(t, 'host-res-inline-assignment-literal-expansion-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$1" in *) profile='\${' ;; esac
exec ${process.execPath} "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(spawnSync('/bin/sh', ['-n', wrapper]).status, 0, 'the fixture is valid POSIX shell');

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected?.version, '0.2.2-rc.1');
  assert.equal(result.candidates[0].error, undefined);
});

test('a quoted case assignment keeps quoted separators inside the value', (t) => {
  const dir = tmp(t, 'host-res-inline-assignment-quoted-separators-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$1" in --profile=*) profile=';; esac' ;; esac
exec ${process.execPath} "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(spawnSync('/bin/sh', ['-n', wrapper]).status, 0, 'the fixture is valid POSIX shell');

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected?.version, '0.2.2-rc.1');
  assert.equal(result.candidates[0].error, undefined);
});

test('a one-line assignment case accepts a trailing comment after esac', (t) => {
  const dir = tmp(t, 'host-res-inline-assignment-comment-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$1" in *) profile=value ;; esac # \`profile\`
exec ${process.execPath} "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(spawnSync('/bin/sh', ['-n', wrapper]).status, 0, 'the fixture is valid POSIX shell');

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected?.version, '0.2.2-rc.1');
  assert.equal(result.candidates[0].error, undefined);
});

test('an unclosed quote in a one-line case cannot turn quoted exec text into a host branch', (t) => {
  const dir = tmp(t, 'host-res-inline-assignment-unclosed-quote-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$1" in --profile=*) profile=' ;; esac
exec ${process.execPath} "${dsh.bin}" "$@"
' ;; esac
`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(spawnSync('/bin/sh', ['-n', wrapper]).status, 0, 'the fixture is valid POSIX shell');

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null, 'exec text inside the multi-line assignment must not become a launch branch');
  assert.equal(result.candidates[0].error, 'NO_EXEC_TARGET');
});

test('a branch pattern containing -in cannot hide an earlier launch branch', (t) => {
  const dir = tmp(t, 'host-res-case-pattern-in-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$1" in web) exec /bin/false "$@" ;; foo-in) profile=x ;; esac
exec ${process.execPath} "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null, 'the unsupported multi-branch one-line case must fail closed');
  assert.equal(result.candidates[0].error, 'NO_EXEC_TARGET');
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
  fs.writeFileSync(wrapper, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec /mock/Electron --expose-internals "${entry}" "$@"\n`);
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
  fs.writeFileSync(wrapper, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec /mock/Electron "${entry}" "$@"\n`);
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
  assert.deepEqual(result.candidates, []);
  assert.equal(result.candidates.some((candidate) => candidate.source === 'plugin-node-modules'), false);

  const dshHome = doctorHome(t);
  const report = await withPathAsync('', () => collectDiagnostics({ dshHome, probe: { skipComposition: true } }));
  const cli = report.checks.find((check) => check.id === 'host.cli');
  assert.equal(cli.level, 'not-evaluated');
  assert.equal(cli.evidence.reason, 'no-cli-candidate');
  assert.deepEqual(cli.evidence.candidates, []);
  assert.match(cli.summary, /No DSH CLI candidate was found/);
  assert.match(cli.remediation, /--dsh-cli/);
  assert.match(cli.remediation, /make `dsh` available on PATH/);
  for (const id of ['host.version', 'host.modules', 'host.composition']) {
    const check = report.checks.find((entry) => entry.id === id);
    assert.equal(check?.level, 'not-evaluated', `${id} must be explicit when the CLI is absent`);
    assert.equal(check.evidence.reason, 'no-cli-candidate');
  }
  assert.equal(JSON.stringify(cli.evidence).includes('plugin-node-modules'), false);
});

test('an existing PATH wrapper with an unresolved branch names the branch in every skipped host check', async (t) => {
  const dir = tmp(t, 'host-res-unattributed-report-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const unsupported = path.join(dir, 'desktop', 'dsh');
  const otherUnsupported = path.join(dir, 'other', 'dsh');
  for (const file of [unsupported, otherUnsupported]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\ncase "$target" in\n  /*) launcher=$target ;;\nesac\n');
    fs.chmodSync(file, 0o755);
  }
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const wrapper = path.join(bin, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
case "$argument" in --profile=*) profile=\${argument#--profile=} ;; esac
if [ "$profile" = 'acp' ]; then
  exec "${unsupported}" "$@"
fi
if [ "$profile" = 'desktop' ]; then
  exec "${otherUnsupported}" "$@"
fi
exec ${process.execPath} "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const dshHome = doctorHome(t);
  const report = await withPathAsync(bin, () => collectDiagnostics({ dshHome, profile: 'web', probe: { skipComposition: true } }));
  for (const id of ['host.cli', 'host.version', 'host.modules', 'host.composition']) {
    const check = report.checks.find((entry) => entry.id === id);
    assert.equal(check?.level, 'not-evaluated', `${id} must be explicit when no branch is attributable`);
    assert.equal(check.evidence.reason, 'cli-candidate-unresolved');
    assert.deepEqual(check.evidence.candidates[0].unresolvedBranches.map((branch) => branch.path), [unsupported, otherUnsupported]);
    assert.match(check.summary, new RegExp(unsupported.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(check.summary, new RegExp(otherUnsupported.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(check.summary, /NO_EXEC_TARGET/);
    assert.equal(check.evidence.candidates[0].source, 'PATH');
    assert.doesNotMatch(check.remediation, /make `dsh` available on PATH/);
    assert.match(check.remediation, /--dsh-cli/);
  }
});

test('an unresolved dynamic launch command is reported by wrapper location without its shell text', async (t) => {
  const dir = tmp(t, 'host-res-dynamic-launch-report-');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
exec "$(find-cli --token TEST_DUMMY_ONLY)" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null);
  assert.deepEqual(result.candidates[0].unresolvedBranches, [{
    wrapperPath: wrapper,
    line: 2,
    error: 'UNRESOLVED_EXEC_TARGET',
    detail: 'the launch command contains a dynamic shell expression that is not statically attributable on this line',
  }]);

  const dshHome = doctorHome(t);
  const report = await withPathAsync('', () => collectDiagnostics({ dshHome, cliPath: wrapper, probe: { skipComposition: true } }));
  const cli = report.checks.find((check) => check.id === 'host.cli');
  assert.equal(cli.level, 'not-evaluated');
  assert.match(cli.summary, new RegExp(`${wrapper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:2`));
  assert.doesNotMatch(JSON.stringify(cli.evidence), /find-cli|TEST_DUMMY_ONLY/);
  assert.doesNotMatch(cli.summary, /find-cli|TEST_DUMMY_ONLY/);
});

test('dynamic absolute launch and script paths are not copied into branch evidence', async (t) => {
  const dir = tmp(t, 'host-res-dynamic-absolute-report-');
  const dshHome = doctorHome(t);
  const wrappers = [
    'exec "/tmp/$(lookup --token TEST_DUMMY_ONLY)" "$@"',
    `exec "${process.execPath}" "/tmp/\${CLI:-TEST_DUMMY_ONLY}.js" "$@"`,
  ];
  for (const [index, body] of wrappers.entries()) {
    const wrapper = path.join(dir, `dsh-${index}`);
    fs.writeFileSync(wrapper, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(wrapper, 0o755);
    const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
    assert.equal(result.selected, null);
    assert.equal(result.candidates[0].error, 'UNRESOLVED_EXEC_TARGET');
    assert.equal(result.candidates[0].unresolvedBranches[0].wrapperPath, wrapper);
    assert.equal(result.candidates[0].unresolvedBranches[0].line, 2);
    assert.equal(result.candidates[0].unresolvedBranches[0].path, index === 0 ? undefined : process.execPath);
    assert.doesNotMatch(JSON.stringify(result.candidates[0].unresolvedBranches), /lookup|TEST_DUMMY_ONLY|CLI/);

    const report = await withPathAsync('', () => collectDiagnostics({ dshHome, cliPath: wrapper, probe: { skipComposition: true } }));
    const cli = report.checks.find((check) => check.id === 'host.cli');
    assert.equal(cli.level, 'not-evaluated');
    assert.doesNotMatch(JSON.stringify(cli.evidence), /lookup|TEST_DUMMY_ONLY|CLI/);
    assert.doesNotMatch(cli.summary, /lookup|TEST_DUMMY_ONLY/);
  }
});

test('an unquoted command substitution is not split into reportable path tokens', async (t) => {
  const dir = tmp(t, 'host-res-unquoted-substitution-');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" $(printf %s /tmp/TEST_DUMMY_ONLY.js x) "$@"\n`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null);
  assert.equal(result.candidates[0].error, 'UNRESOLVED_EXEC_TARGET');
  assert.equal(result.candidates[0].unresolvedBranches[0].wrapperPath, wrapper);
  assert.equal(result.candidates[0].unresolvedBranches[0].line, 2);
  assert.doesNotMatch(JSON.stringify(result.candidates[0].unresolvedBranches), /printf|TEST_DUMMY_ONLY/);

  const report = await withPathAsync('', () => collectDiagnostics({ dshHome: doctorHome(t), cliPath: wrapper, probe: { skipComposition: true } }));
  const cli = report.checks.find((check) => check.id === 'host.cli');
  assert.equal(cli.level, 'not-evaluated');
  assert.doesNotMatch(JSON.stringify(cli.evidence), /printf|TEST_DUMMY_ONLY/);
  assert.doesNotMatch(cli.summary, /printf|TEST_DUMMY_ONLY/);
});

test('a multi-line command substitution stops wrapper scanning without leaking its body', async (t) => {
  const dir = tmp(t, 'host-res-multiline-substitution-');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
exec "$(
exec /tmp/TEST_DUMMY_ONLY_DSH_DOCTOR
)"
`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(spawnSync('/bin/sh', ['-n', wrapper]).status, 0, 'the fixture is valid POSIX shell');

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null);
  assert.deepEqual(result.candidates[0].unresolvedBranches, [{
    wrapperPath: wrapper,
    line: 2,
    error: 'UNRESOLVED_EXEC_TARGET',
    detail: 'the launch command contains a dynamic shell expression that is not statically attributable on this line',
  }]);

  const report = await withPathAsync('', () => collectDiagnostics({ dshHome: doctorHome(t), cliPath: wrapper, probe: { skipComposition: true } }));
  const cli = report.checks.find((check) => check.id === 'host.cli');
  assert.equal(cli.level, 'not-evaluated');
  assert.doesNotMatch(JSON.stringify(cli.evidence), /TEST_DUMMY_ONLY_DSH_DOCTOR/);
  assert.doesNotMatch(cli.summary, /TEST_DUMMY_ONLY_DSH_DOCTOR/);
});

test('an unrecognized multi-line command substitution stops scanning without leaking its body', async (t) => {
  const dir = tmp(t, 'host-res-unrecognized-multiline-substitution-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
ignored=$(
exec /tmp/TEST_DUMMY_ONLY_DSH_DOCTOR
)
exec "${process.execPath}" "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(spawnSync('/bin/sh', ['-n', wrapper]).status, 0, 'the fixture is valid POSIX shell');

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null);
  assert.deepEqual(result.candidates[0].unresolvedBranches, [{
    wrapperPath: wrapper,
    line: 2,
    error: 'UNRESOLVED_EXEC_TARGET',
    detail: 'the launch command contains a dynamic shell expression that is not statically attributable on this line',
  }]);

  const report = await withPathAsync('', () => collectDiagnostics({ dshHome: doctorHome(t), cliPath: wrapper, probe: { skipComposition: true } }));
  const cli = report.checks.find((check) => check.id === 'host.cli');
  assert.equal(cli.level, 'not-evaluated');
  assert.doesNotMatch(JSON.stringify(cli.evidence), /TEST_DUMMY_ONLY_DSH_DOCTOR/);
  assert.doesNotMatch(cli.summary, /TEST_DUMMY_ONLY_DSH_DOCTOR/);
});

test('an unrecognized backslash continuation cannot turn its next line into an exec branch', async (t) => {
  const dir = tmp(t, 'host-res-unrecognized-continuation-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
printf '%s\\n' \\
exec /tmp/TEST_DUMMY_ONLY_DSH_DOCTOR
exec "${process.execPath}" "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(spawnSync('/bin/sh', ['-n', wrapper]).status, 0, 'the fixture is valid POSIX shell');

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null);
  assert.deepEqual(result.candidates[0].unresolvedBranches, [{
    wrapperPath: wrapper,
    line: 2,
    error: 'UNRESOLVED_EXEC_TARGET',
    detail: 'the launch command contains a dynamic shell expression that is not statically attributable on this line',
  }]);

  const report = await withPathAsync('', () => collectDiagnostics({ dshHome: doctorHome(t), cliPath: wrapper, probe: { skipComposition: true } }));
  const cli = report.checks.find((check) => check.id === 'host.cli');
  assert.equal(cli.level, 'not-evaluated');
  assert.doesNotMatch(JSON.stringify(cli.evidence), /TEST_DUMMY_ONLY_DSH_DOCTOR/);
  assert.doesNotMatch(cli.summary, /TEST_DUMMY_ONLY_DSH_DOCTOR/);
});

test('an escaped space before # cannot hide a backslash continuation from the scanner', async (t) => {
  const dir = tmp(t, 'host-res-escaped-comment-boundary-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
printf '%s\\n' foo\\ #literal \\
exec /tmp/TEST_DUMMY_ONLY_DSH_DOCTOR
exec "${process.execPath}" "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(spawnSync('/bin/sh', ['-n', wrapper]).status, 0, 'the fixture is valid POSIX shell');

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null);
  assert.deepEqual(result.candidates[0].unresolvedBranches, [{
    wrapperPath: wrapper,
    line: 2,
    error: 'UNRESOLVED_EXEC_TARGET',
    detail: 'the launch command contains a dynamic shell expression that is not statically attributable on this line',
  }]);

  const report = await withPathAsync('', () => collectDiagnostics({ dshHome: doctorHome(t), cliPath: wrapper, probe: { skipComposition: true } }));
  const cli = report.checks.find((check) => check.id === 'host.cli');
  assert.equal(cli.level, 'not-evaluated');
  assert.doesNotMatch(JSON.stringify(cli.evidence), /TEST_DUMMY_ONLY_DSH_DOCTOR/);
  assert.doesNotMatch(cli.summary, /TEST_DUMMY_ONLY_DSH_DOCTOR/);
});

test('a non-POSIX whitespace before # cannot hide a backslash continuation from the scanner', async (t) => {
  const dir = tmp(t, 'host-res-non-posix-comment-boundary-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
printf '%s\\n' foo\u00a0#literal \\
exec /tmp/TEST_DUMMY_ONLY_DSH_DOCTOR
exec "${process.execPath}" "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(spawnSync('/bin/sh', ['-n', wrapper]).status, 0, 'the fixture is valid POSIX shell');

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null);
  assert.deepEqual(result.candidates[0].unresolvedBranches, [{
    wrapperPath: wrapper,
    line: 2,
    error: 'UNRESOLVED_EXEC_TARGET',
    detail: 'the launch command contains a dynamic shell expression that is not statically attributable on this line',
  }]);
  assert.doesNotMatch(JSON.stringify(result.candidates[0].unresolvedBranches), /TEST_DUMMY_ONLY_DSH_DOCTOR/);
});

test('a dynamic script position cannot be replaced by a later DSH entry', (t) => {
  const dir = tmp(t, 'host-res-dynamic-script-position-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "/tmp/\${CLI:-TEST_DUMMY_ONLY}.js" "${dsh.bin}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null, 'the first non-option Node argument is the script; a later .js is only an argument');
  assert.equal(result.candidates[0].error, 'UNRESOLVED_EXEC_TARGET');
  assert.doesNotMatch(JSON.stringify(result.candidates[0].unresolvedBranches), /TEST_DUMMY_ONLY/);
});

test('an option value is not mistaken for the Node script entry', (t) => {
  const dir = tmp(t, 'host-res-node-option-value-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const actual = path.join(dir, 'actual.js');
  fs.writeFileSync(actual, 'console.log("actual");\n');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" --icu-data-dir "${dsh.bin}" "${actual}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null, 'an option with a separate value makes the script position ambiguous');
  assert.equal(result.candidates[0].error, 'UNRESOLVED_EXEC_TARGET');
});

test('Node no-script options with attached values do not expose a following script entry', (t) => {
  const dir = tmp(t, 'host-res-node-no-script-option-value-');
  const pkg = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' }));
  // The shell wrapper is itself a .js path inside the package. If an unknown
  // attached option is skipped, the parser promotes it to a false entry.
  const wrapper = path.join(pkg, 'lib', 'bin.mjs');
  for (const [attachedOption, plainOption] of [
    ['--version=true', '--version'],
    ['--run=missing', '--run missing'],
    ['--input-type=module', '--input-type module'],
  ]) {
    fs.writeFileSync(wrapper, `#!/bin/sh\ndshBin=$0\nexec "${process.execPath}" ${attachedOption} "$dshBin"\n`);
    fs.chmodSync(wrapper, 0o755);

    const attached = withPath('', () => resolveHostCli({ cliPath: wrapper }));
    assert.equal(attached.selected, null, `${attachedOption} must not expose a script entry`);
    assert.equal(attached.candidates[0].error, 'UNRESOLVED_EXEC_TARGET');
    assert.equal(attached.candidates[0].unresolvedBranches[0].path, process.execPath);
    assert.match(attached.candidates[0].unresolvedBranches[0].detail, /script entry/);

    fs.writeFileSync(wrapper, `#!/bin/sh\ndshBin=$0\nexec "${process.execPath}" ${plainOption} "$dshBin"\n`);
    const plain = withPath('', () => resolveHostCli({ cliPath: wrapper }));
    assert.equal(plain.selected, null);
    assert.deepEqual(attached.candidates[0].unresolvedBranches, plain.candidates[0].unresolvedBranches,
      `${attachedOption} must have the same no-script behavior as ${plainOption}`);
  }
});

test('a known attached Node option still permits a static script entry', (t) => {
  const dir = tmp(t, 'host-res-node-known-attached-option-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" --max-old-space-size=128 "${dsh.bin}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected?.version, '0.2.2-rc.1');
  assert.equal(result.selected?.entryPath, dsh.bin);
});

test('a quoted literal bracket in a host path remains attributable', (t) => {
  const dir = tmp(t, 'host-res-literal-bracket-path-');
  const dsh = makeDshPackage(path.join(dir, '[literal]'), '0.2.2-rc.1');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${dsh.bin}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected?.version, '0.2.2-rc.1');
  assert.equal(result.selected?.entryPath, dsh.bin);
});

test('a non-special backslash in double quotes is not removed from a host path', (t) => {
  const dir = tmp(t, 'host-res-double-quote-backslash-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.1');
  const missing = dsh.bin.replace('/bin.js', '/b\\in.js');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${missing}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(spawnSync('/bin/sh', ['-n', wrapper]).status, 0, 'the fixture is valid POSIX shell');
  assert.notEqual(spawnSync(wrapper, [], { encoding: 'utf8' }).status, 0, 'the shell preserves the backslash and cannot run bin.js');

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null, 'the static path must retain the non-special backslash');
  assert.equal(result.candidates[0].error, 'UNRESOLVED_EXEC_TARGET');
});

test('an Electron launch without a static entry reports the missing entry', (t) => {
  const dir = tmp(t, 'host-res-electron-no-entry-');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null);
  assert.deepEqual(result.candidates[0].unresolvedBranches, [{
    wrapperPath: wrapper,
    line: 2,
    path: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    error: 'UNRESOLVED_EXEC_TARGET',
    detail: 'the Electron launch command has no statically attributable JS or ASAR entry',
  }]);
});

test('versionless terminal branches keep the wrapper path and name each entryPath', async (t) => {
  const dir = tmp(t, 'host-res-versionless-branches-');
  const one = makeDshPackage(path.join(dir, 'host-one'), null);
  const two = makeDshPackage(path.join(dir, 'host-two'), null);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const wrapper = path.join(bin, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = 'web' ]; then
  exec ${process.execPath} "${one.bin}" "$@"
fi
exec ${process.execPath} "${two.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const dshHome = doctorHome(t);
  const report = await withPathAsync(bin, () => collectDiagnostics({ dshHome, probe: { skipComposition: true } }));
  const cli = report.checks.find((check) => check.id === 'host.cli');
  assert.equal(cli.level, 'not-evaluated');
  assert.equal(cli.evidence.reason, 'cli-candidate-unresolved');
  assert.deepEqual(cli.evidence.candidates.map((candidate) => ({ path: candidate.path, entryPath: candidate.entryPath, error: candidate.error })), [
    { path: wrapper, entryPath: undefined, error: 'UNRESOLVED_EXEC_TARGET' },
  ]);
  assert.deepEqual(cli.evidence.candidates[0].unresolvedBranches, [
    { path: one.bin, error: 'VERSION_UNAVAILABLE', detail: 'the package identifies @deepseek-ai/dsh but does not state a version, so this candidate cannot be ranked or attributed' },
    { path: two.bin, error: 'VERSION_UNAVAILABLE', detail: 'the package identifies @deepseek-ai/dsh but does not state a version, so this candidate cannot be ranked or attributed' },
  ]);
  assert.ok(cli.summary.includes(one.bin));
  assert.ok(cli.summary.includes(two.bin));
});

test('a non-DSH Electron branch names its ASAR entry instead of the shared executable', async (t) => {
  const dir = tmp(t, 'host-res-electron-non-dsh-entry-');
  const asar = path.join(dir, 'app.asar');
  makeAsar(asar, [
    { internalPath: 'dsh/node_modules/@deepseek-ai/other/package.json', value: { name: '@deepseek-ai/other', version: '1.0.0' } },
  ]);
  const entry = `${asar}/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`;
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "/mock/DeepSeek Harness" --expose-internals "${entry}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);

  const dshHome = doctorHome(t);
  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null);
  const report = await withPathAsync('', () => collectDiagnostics({ dshHome, cliPath: wrapper, probe: { skipComposition: true } }));
  const cli = report.checks.find((check) => check.id === 'host.cli');
  assert.equal(cli.level, 'not-evaluated');
  assert.equal(cli.evidence.candidates[0].path, wrapper);
  assert.deepEqual(cli.evidence.candidates[0].unresolvedBranches, [{
    path: entry,
    error: 'TARGET_NOT_DSH',
    detail: 'the launch target did not identify @deepseek-ai/dsh from a package manifest or ASAR host facts',
  }]);
  assert.ok(cli.summary.includes(entry));
});

test('a mixed wrapper keeps non-DSH, versionless and invalid-version branch failures', async (t) => {
  const dir = tmp(t, 'host-res-mixed-terminal-failures-');
  const versionless = makeDshPackage(path.join(dir, 'host-versionless'), null);
  const invalid = makeDshPackage(path.join(dir, 'host-invalid'), { toString: null });
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const wrapper = path.join(bin, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = 'web' ]; then
  exec /bin/false "$@"
fi
if [ "$1" = 'acp' ]; then
  exec ${process.execPath} "${versionless.bin}" "$@"
fi
exec ${process.execPath} "${invalid.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const dshHome = doctorHome(t);
  const report = await withPathAsync(bin, () => collectDiagnostics({ dshHome, probe: { skipComposition: true } }));
  const cli = report.checks.find((check) => check.id === 'host.cli');
  assert.equal(cli.level, 'not-evaluated');
  assert.equal(cli.evidence.candidates[0].path, wrapper);
  assert.deepEqual(cli.evidence.candidates[0].unresolvedBranches, [
    { path: '/bin/false', error: 'TARGET_NOT_DSH', detail: 'the launch target did not identify @deepseek-ai/dsh from a package manifest or ASAR host facts' },
    { path: versionless.bin, error: 'VERSION_UNAVAILABLE', detail: 'the package identifies @deepseek-ai/dsh but does not state a version, so this candidate cannot be ranked or attributed' },
    { path: invalid.bin, error: 'VERSION_INVALID', detail: 'the package states a @deepseek-ai/dsh version that is not valid semver, so this candidate cannot be ranked or attributed' },
  ]);
  assert.ok(cli.summary.includes(versionless.bin));
  assert.ok(cli.summary.includes(invalid.bin));
  for (const id of ['host.cli', 'host.version', 'host.modules', 'host.composition']) {
    const check = report.checks.find((entry) => entry.id === id);
    assert.equal(check?.level, 'not-evaluated', `${id} must still be reported for malformed branch versions`);
    assert.equal(check.evidence.reason, 'cli-candidate-unresolved');
  }
});

test('an explicit multi-branch wrapper keeps invalid versions on the existing blocked gates', async (t) => {
  const dir = tmp(t, 'host-res-explicit-invalid-versions-');
  const one = makeDshPackage(path.join(dir, 'host-one'), 'not-semver');
  const two = makeDshPackage(path.join(dir, 'host-two'), 'not-semver');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const wrapper = path.join(bin, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = 'web' ]; then
  exec ${process.execPath} "${one.bin}" "$@"
fi
exec ${process.execPath} "${two.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const dshHome = doctorHome(t);
  const explicit = await collectDiagnostics({ dshHome, cliPath: wrapper, probe: { skipComposition: true } });
  assert.deepEqual(Object.fromEntries(['host.cli', 'host.version', 'host.modules', 'host.composition'].map((id) => {
    const check = explicit.checks.find((entry) => entry.id === id);
    return [id, check?.level];
  })), {
    'host.cli': 'ok',
    'host.version': 'blocked',
    'host.modules': 'blocked',
    'host.composition': 'not-evaluated',
  });
  assert.equal(explicit.checks.find((check) => check.id === 'host.version').evidence.found, 'not-semver');

  const implicit = await withPathAsync(bin, () => collectDiagnostics({ dshHome, probe: { skipComposition: true } }));
  for (const id of ['host.cli', 'host.version', 'host.modules', 'host.composition']) {
    assert.equal(implicit.checks.find((entry) => entry.id === id)?.level, 'not-evaluated', `${id} stays fail-closed without explicit attribution`);
  }
});

test('a numeric manifest version is not replaced by an explicit CLI version probe', async (t) => {
  const dir = tmp(t, 'host-res-explicit-numeric-version-');
  const marker = path.join(dir, 'probed');
  const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); console.log('0.2.2-rc.1');\n`;
  const one = makeDshPackage(path.join(dir, 'host-one'), 123, source);
  const two = makeDshPackage(path.join(dir, 'host-two'), 123, source);
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = 'web' ]; then
  exec ${process.execPath} "${one.bin}" "$@"
fi
exec ${process.execPath} "${two.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const dshHome = doctorHome(t);
  const report = await withPathAsync('', () => collectDiagnostics({ dshHome, cliPath: wrapper, probe: { skipComposition: true } }));
  assert.equal(report.checks.find((check) => check.id === 'host.cli').level, 'ok');
  assert.equal(report.checks.find((check) => check.id === 'host.version').level, 'blocked');
  assert.equal(fs.existsSync(marker), false, 'a truthy non-string manifest version keeps the existing no-probe gate');
});

test('a valid explicit branch stays ambiguous beside a numeric manifest version', async (t) => {
  const dir = tmp(t, 'host-res-explicit-mixed-numeric-');
  const valid = makeDshPackage(path.join(dir, 'host-valid'), '0.2.2-rc.1');
  const numeric = makeDshPackage(path.join(dir, 'host-numeric'), 123);
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = 'web' ]; then
  exec ${process.execPath} "${valid.bin}" "$@"
fi
exec ${process.execPath} "${numeric.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const report = await withPathAsync('', () => collectDiagnostics({ dshHome: doctorHome(t), cliPath: wrapper, probe: { skipComposition: true } }));
  assert.equal(report.checks.find((check) => check.id === 'host.cli').level, 'ok');
  assert.equal(report.checks.find((check) => check.id === 'host.cli').evidence.profileHostAmbiguous, true);
  assert.equal(report.checks.find((check) => check.id === 'host.version').level, 'not-evaluated');
  assert.equal(report.checks.find((check) => check.id === 'host.version').evidence.reason, 'profile-host-ambiguous');
});

test('a valid explicit branch stays ambiguous beside a versionless sibling whose probe fails', async (t) => {
  const dir = tmp(t, 'host-res-explicit-valid-and-versionless-');
  const valid = makeDshPackage(path.join(dir, 'host-valid'), '0.2.2-rc.1');
  const versionless = makeDshPackage(path.join(dir, 'host-versionless'), null);
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = 'web' ]; then
  exec ${process.execPath} "${valid.bin}" "$@"
fi
exec ${process.execPath} "${versionless.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const resolution = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(resolution.selected?.version, '0.2.2-rc.1');
  assert.deepEqual(resolution.alternatives.map((candidate) => candidate.entryPath), [versionless.bin],
    'an unknown-version sibling of the same wrapper must remain an alternative');

  const report = await withPathAsync('', () => collectDiagnostics({ dshHome: doctorHome(t), cliPath: wrapper, probe: { skipComposition: true } }));
  const cli = report.checks.find((check) => check.id === 'host.cli');
  assert.equal(cli.level, 'ok');
  assert.equal(cli.evidence.profileHostAmbiguous, true);
  const version = report.checks.find((check) => check.id === 'host.version');
  assert.equal(version.level, 'not-evaluated');
  assert.equal(version.evidence.reason, 'profile-host-ambiguous');
});

test('two unknown-version entries of one explicit wrapper stay profile-host ambiguous', async (t) => {
  const dir = tmp(t, 'host-res-explicit-two-versionless-');
  const one = makeDshPackage(path.join(dir, 'host-one'), null);
  const two = makeDshPackage(path.join(dir, 'host-two'), null);
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = 'web' ]; then
  exec ${process.execPath} "${one.bin}" "$@"
fi
exec ${process.execPath} "${two.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const resolution = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(resolution.selected?.entryPath, one.bin);
  assert.deepEqual(resolution.alternatives.map((candidate) => candidate.entryPath), [two.bin],
    'different unknown-version entries of the same wrapper must remain alternatives');

  const report = await withPathAsync('', () => collectDiagnostics({ dshHome: doctorHome(t), cliPath: wrapper, probe: { skipComposition: true } }));
  const cli = report.checks.find((check) => check.id === 'host.cli');
  assert.equal(cli.level, 'ok');
  assert.equal(cli.evidence.profileHostAmbiguous, true);
  const version = report.checks.find((check) => check.id === 'host.version');
  assert.equal(version.level, 'not-evaluated');
  assert.equal(version.evidence.reason, 'profile-host-ambiguous');
  assert.deepEqual(report.checks.find((check) => check.id === 'host.modules').evidence.candidateVersions, ['<unknown>']);
});

test('a valid branch cannot hide a versionless sibling in a multi-branch wrapper', async (t) => {
  const dir = tmp(t, 'host-res-valid-and-versionless-');
  const valid = makeDshPackage(path.join(dir, 'host-valid'), '0.2.2-rc.1');
  const versionless = makeDshPackage(path.join(dir, 'host-versionless'), null);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const wrapper = path.join(bin, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = 'web' ]; then
  exec ${process.execPath} "${valid.bin}" "$@"
fi
exec ${process.execPath} "${versionless.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath(bin, () => resolveHostCli({}));
  assert.equal(result.selected, null, 'a valid fallback must not win when a sibling version is unknown');
  assert.deepEqual(result.candidates[0].unresolvedBranches, [{
    path: versionless.bin,
    error: 'VERSION_UNAVAILABLE',
    detail: 'the package identifies @deepseek-ai/dsh but does not state a version, so this candidate cannot be ranked or attributed',
  }]);
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
  fs.writeFileSync(wrapper, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec /mock/Electron "${entry}" "$@"\n`);
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

test('the real composition probe runs on an isolated profile copy', async (t) => {
  const dir = tmp(t, 'host-res-composition-isolated-');
  const dump = [
    '# == dsh-evolution',
    '- id: evolution-experience',
    '  name: dsh-evolution/experience',
    '- id: evolution-orchestrator',
    '  name: dsh-evolution',
    '- id: evolution-trust-root-guard',
    '  name: dsh-evolution/guard',
    '',
  ].join('\n');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.5', `process.stdout.write(${JSON.stringify(dump)});\n`);
  const marker = path.join(dir, 'marker');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$DSH_HOME" > "${marker}"\nexec ${process.execPath} "${dsh.bin}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  const dshHome = doctorHome(t);
  const profileDir = path.join(dshHome, 'profiles', 'acp');
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
  for (const name of ['cordis.yml', 'cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']) {
    fs.writeFileSync(path.join(profileDir, name), `real-${name}\n`);
  }
  const cordisPath = path.join(profileDir, 'cordis.yml');
  const original = fs.readFileSync(cordisPath);
  const originalMtime = fs.statSync(cordisPath).mtimeMs;

  const report = await collectDiagnostics({ dshHome, cliPath: wrapper, profile: 'acp' });
  const composition = report.checks.find((check) => check.id === 'host.composition');
  assert.equal(composition.level, 'ok', JSON.stringify(composition));
  assert.deepEqual(fs.readFileSync(cordisPath), original, 'the real cordis.yml bytes are unchanged');
  assert.equal(fs.statSync(cordisPath).mtimeMs, originalMtime, 'the real cordis.yml mtime is unchanged');
  assert.equal(fs.existsSync(marker), true, 'the wrapper was executed');
  const seenHome = fs.readFileSync(marker, 'utf8').trim();
  assert.notEqual(seenHome, dshHome, 'the wrapper never saw the real DSH_HOME');
  assert.match(seenHome, /dsh-evolution-doctor-/, 'the probe used a throwaway home');
  assert.equal(fs.existsSync(seenHome), false, 'the throwaway home was removed');

  // An injected hermetic probe keeps its existing behavior.
  let called = false;
  await collectDiagnostics({
    dshHome, cliPath: wrapper, profile: 'acp',
    probe: { runDumpConfig: () => { called = true; return { status: 0, stdout: '', stderr: '' }; } },
  });
  assert.equal(called, true, 'an injected probe still runs');
});

test('a partial profile is not initialized just to run the real probe', async (t) => {
  const dir = tmp(t, 'host-res-composition-partial-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.5', 'console.log("");\n');
  const marker = path.join(dir, 'marker');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nprintf x > "${marker}"\nexec ${process.execPath} "${dsh.bin}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  const dshHome = doctorHome(t);
  const profileDir = path.join(dshHome, 'profiles', 'acp');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'cordis.yml'), '');
  const before = fs.readdirSync(profileDir);

  const report = await collectDiagnostics({ dshHome, cliPath: wrapper, profile: 'acp' });
  const composition = report.checks.find((check) => check.id === 'host.composition');
  assert.equal(composition.level, 'not-evaluated');
  assert.match(composition.evidence.reason, /incomplete/);
  assert.deepEqual(fs.readdirSync(profileDir), before, 'no config file was created in the real profile');
  assert.equal(fs.existsSync(marker), false, 'the wrapper was not executed');
});

test('an unsafe profile name is refused before any copy or probe', async (t) => {
  const dir = tmp(t, 'host-res-profile-traversal-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.5', 'console.log("");\n');
  const marker = path.join(dir, 'marker');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nprintf x > "${marker}"\nexec ${process.execPath} "${dsh.bin}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  const dshHome = doctorHome(t);
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const outsideFile = path.join(outside, 'cordis.yml');
  fs.writeFileSync(outsideFile, 'OUTSIDE-ORIGINAL\n');
  const before = fs.readdirSync(outside);

  for (const profile of ['../../evil', '..', path.join(dir, 'outside'), '/absolute', 'a/b']) {
    const report = await collectDiagnostics({ dshHome, cliPath: wrapper, profile });
    const composition = report.checks.find((check) => check.id === 'host.composition');
    assert.equal(composition.level, 'not-evaluated', `profile ${JSON.stringify(profile)} must be refused`);
    assert.match(composition.evidence.reason, /safe path component/);
  }
  assert.equal(fs.existsSync(marker), false, 'the wrapper was never executed');
  assert.deepEqual(fs.readdirSync(outside), before, 'nothing was created outside the throwaway home');
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'OUTSIDE-ORIGINAL\n');
});

test('a symlinked cordis.yml cannot write through the isolated copy', async (t) => {
  const dir = tmp(t, 'host-res-composition-symlink-');
  const outside = path.join(dir, 'outside-cordis.yml');
  fs.writeFileSync(outside, 'REAL-CONTENT\n');
  const dump = [
    '# == dsh-evolution',
    '- id: evolution-experience',
    '  name: dsh-evolution/experience',
    '- id: evolution-orchestrator',
    '  name: dsh-evolution',
    '- id: evolution-trust-root-guard',
    '  name: dsh-evolution/guard',
    '',
  ].join('\n');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.5', `process.stdout.write(${JSON.stringify(dump)});\n`);
  const marker = path.join(dir, 'marker');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
if [ -L "$DSH_HOME/profiles/acp/cordis.yml" ]; then printf 'symlink\\n' > "${marker}"; else printf 'regular\\n' > "${marker}"; fi
exec ${process.execPath} "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  const dshHome = doctorHome(t);
  const profileDir = path.join(dshHome, 'profiles', 'acp');
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
  for (const name of ['cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']) {
    fs.writeFileSync(path.join(profileDir, name), 'x\n');
  }
  fs.symlinkSync(outside, path.join(profileDir, 'cordis.yml'));
  const original = fs.readFileSync(outside);
  const originalMtime = fs.statSync(outside).mtimeMs;

  const report = await collectDiagnostics({ dshHome, cliPath: wrapper, profile: 'acp' });
  assert.equal(report.checks.find((check) => check.id === 'host.composition').level, 'ok');
  assert.match(fs.readFileSync(marker, 'utf8'), /regular/, 'the isolated copy dereferenced the config symlink');
  assert.deepEqual(fs.readFileSync(outside), original, 'the symlink target bytes are unchanged');
  assert.equal(fs.statSync(outside).mtimeMs, originalMtime, 'the symlink target mtime is unchanged');
});

test('a home-level cordis.patch.yml is carried into the isolated probe', async (t) => {
  const dir = tmp(t, 'host-res-composition-homepatch-');
  const dump = [
    '# == dsh-evolution',
    '- id: evolution-experience',
    '  name: dsh-evolution/experience',
    '- id: evolution-orchestrator',
    '  name: dsh-evolution',
    '- id: evolution-trust-root-guard',
    '  name: dsh-evolution/guard',
    '',
  ].join('\n');
  const dsh = makeDshPackage(path.join(dir, 'host'), '0.2.2-rc.5', `process.stdout.write(${JSON.stringify(dump)});\n`);
  const marker = path.join(dir, 'marker');
  const wrapper = path.join(dir, 'dsh');
  // Stands in for the CLI's home-patch parsing: a patch without the valid
  // marker makes composition fail instead of being silently ignored.
  fs.writeFileSync(wrapper, `#!/bin/sh
if [ ! -f "$DSH_HOME/cordis.patch.yml" ]; then printf 'missing\\n' > "${marker}"; echo 'home patch missing' >&2; exit 1; fi
if ! grep -q 'GOOD-PATCH' "$DSH_HOME/cordis.patch.yml"; then printf 'invalid\\n' > "${marker}"; echo 'invalid home patch' >&2; exit 1; fi
printf 'ok\\n' > "${marker}"
exec ${process.execPath} "${dsh.bin}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  const dshHome = doctorHome(t);
  const profileDir = path.join(dshHome, 'profiles', 'acp');
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
  for (const name of ['cordis.yml', 'cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']) {
    fs.writeFileSync(path.join(profileDir, name), 'x\n');
  }
  const homePatch = path.join(dshHome, 'cordis.patch.yml');

  fs.writeFileSync(homePatch, 'GOOD-PATCH\n');
  const good = await collectDiagnostics({ dshHome, cliPath: wrapper, profile: 'acp' });
  assert.equal(good.checks.find((check) => check.id === 'host.composition').level, 'ok');
  assert.match(fs.readFileSync(marker, 'utf8'), /ok/);

  fs.writeFileSync(homePatch, 'BROKEN-PATCH\n');
  const bad = await collectDiagnostics({ dshHome, cliPath: wrapper, profile: 'acp' });
  assert.notEqual(bad.checks.find((check) => check.id === 'host.composition').level, 'ok');
  assert.match(fs.readFileSync(marker, 'utf8'), /invalid/);
});

test('ASAR reads bypass the Electron asar patch and restore process.noAsar', (t) => {
  const dir = tmp(t, 'host-res-electron-asar-');
  const asar = path.join(dir, 'app.asar');
  makeAsar(asar, [
    { internalPath: 'dsh/node_modules/@deepseek-ai/dsh/package.json', value: { name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' } },
  ]);
  const entry = `${asar}/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`;
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec /mock/Electron "${entry}" "$@"\n`);
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

test('a nested wrapper cycle is an unresolved branch, not a silently omitted target', (t) => {
  const dir = tmp(t, 'host-res-wrapper-cycle-');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${wrapper}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);

  const result = withPath('', () => resolveHostCli({ cliPath: wrapper }));
  assert.equal(result.selected, null);
  assert.equal(result.candidates[0].error, 'UNRESOLVED_EXEC_TARGET');
  assert.deepEqual(result.candidates[0].unresolvedBranches, [{
    path: wrapper,
    error: 'WRAPPER_CYCLE',
    detail: 'the nested shell wrapper chain loops back to a wrapper already being expanded',
  }]);
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

test('a quoted heredoc delimiter with a hyphen still hides its exec lines', (t) => {
  const dir = tmp(t, 'host-res-heredoc-hyphen-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '9.9.9');
  const wrapper = path.join(dir, 'dsh');
  fs.writeFileSync(wrapper, `#!/bin/sh
cat <<'END-HELP'
exec ${process.execPath} "${dsh.bin}" "$@"
END-HELP
exec /bin/false "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  assert.equal(withPath('', () => resolveHostCli({ cliPath: wrapper })).selected, null,
    'an exec inside a hyphenated heredoc is not a candidate');
});

test('node -e never promotes its arguments to a host entry', (t) => {
  const dir = tmp(t, 'host-res-node-eval-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '9.9.9');
  const scripts = [
    `#!/bin/sh\nexec ${process.execPath} -e 'process.exit(0)' "${dsh.bin}" "$@"\n`,
    `#!/bin/sh\nexec ${process.execPath} -e "${dsh.bin}" "$@"\n`,
    `#!/bin/sh\nexec ${process.execPath} --eval="process.exit(0)" "${dsh.bin}" "$@"\n`,
    `#!/bin/sh\nexec ${process.execPath} -p '1+1' "${dsh.bin}" "$@"\n`,
    `#!/bin/sh\nexec ${process.execPath} --print="1+1" "${dsh.bin}" "$@"\n`,
  ];
  for (const [index, script] of scripts.entries()) {
    const wrapper = path.join(dir, `dsh-${index}`);
    fs.writeFileSync(wrapper, script);
    fs.chmodSync(wrapper, 0o755);
    assert.equal(withPath('', () => resolveHostCli({ cliPath: wrapper })).selected, null,
      `node eval invocation #${index} has no script entry`);
  }
});

test('ELECTRON_RUN_AS_NODE alone does not make a binary an Electron host', (t) => {
  const dir = tmp(t, 'host-res-electron-token-');
  const dsh = makeDshPackage(path.join(dir, 'host'), '9.9.9');
  const asar = path.join(dir, 'app.asar');
  makeAsar(asar, [
    { internalPath: 'dsh/node_modules/@deepseek-ai/dsh/package.json', value: { name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' } },
  ]);
  const entry = `${asar}/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`;

  const echo = path.join(dir, 'echo-dsh');
  fs.writeFileSync(echo, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec /bin/echo "${entry}" "$@"\n`);
  fs.chmodSync(echo, 0o755);
  assert.equal(withPath('', () => resolveHostCli({ cliPath: echo })).selected, null,
    '/bin/echo is not an Electron binary');

  const real = path.join(dir, 'electron-dsh');
  fs.writeFileSync(real, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "/mock/DeepSeek Harness" "${entry}" "$@"\n`);
  fs.chmodSync(real, 0o755);
  assert.equal(withPath('', () => resolveHostCli({ cliPath: real })).selected?.version, '0.2.2-rc.5',
    'an Electron binary with the ASAR entry is still resolved');
});
