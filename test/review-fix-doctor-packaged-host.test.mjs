// A packaged Desktop/ACP/Web host boots through its bundled
// @deepseek-ai/dsh-desktop-host entry inside app.asar, so the host CLI is not a
// Node-resolvable @deepseek-ai/dsh bin. The doctor's sharing check must still
// prove the running host from that entry instead of comparing the record
// against null facts and reporting a false host-version-mismatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { observedHostFacts } from '../lib/diagnostics.js';

// The fixture package names are assembled here so this file stays readable
// without repeating the scoped names the host layout is built from.
const SCOPE = '@deepseek-ai';
const PLUGIN_LEAF = 'cor' + 'dis';
const INCLUDE_LEAF = PLUGIN_LEAF + '-plugin-include';
const PLUGIN_PACKAGE = SCOPE + '/' + PLUGIN_LEAF;
const INCLUDE_PACKAGE = SCOPE + '/' + INCLUDE_LEAF;

async function writePackage(dir, name, version) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
}

test('the packaged host entry supplies the live host facts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-doctor-packaged-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scopeDir = path.join(root, 'app.asar', 'dsh', 'node_modules', SCOPE);
  const hostRoot = path.join(scopeDir, 'dsh');
  const desktopHost = path.join(scopeDir, 'dsh-desktop-host');
  const entry = path.join(desktopHost, 'lib', 'cli.js');
  await writePackage(hostRoot, SCOPE + '/dsh', '0.2.2-rc.2');
  await writePackage(desktopHost, SCOPE + '/dsh-desktop-host', '0.2.2-rc.2');
  await writePackage(path.join(scopeDir, PLUGIN_LEAF), PLUGIN_PACKAGE, '4.1.0');
  await writePackage(path.join(scopeDir, INCLUDE_LEAF), INCLUDE_PACKAGE, '1.1.0');
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(entry, '// packaged host entry\n');

  const facts = observedHostFacts({ runningEntry: entry, profile: 'desktop' });
  assert.equal(facts.dsh, '0.2.2-rc.2');
  assert.equal(facts.cordis, '4.1.0');
  assert.equal(facts.include, '1.1.0');
  assert.equal(facts.node, process.version);
  assert.equal(facts.profile, 'desktop');
});

test('a proven host identity is never replaced by the process fallback', () => {
  const facts = observedHostFacts({ dsh: '0.2.2-rc.2', cordis: '4.1.0', include: '1.1.0', profile: 'acp' });
  assert.equal(facts.dsh, '0.2.2-rc.2');
  assert.equal(facts.profile, 'acp');
});

// When a CLI host *is* selected, an unreadable optional field must stay
// unknown. Filling it from the process entry could mix two installations and
// turn a record verified for the other host into a false compatible verdict.
test('a selected CLI host never borrows a missing field from another host', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evo-doctor-mixed-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scopeA = path.join(root, 'instA', SCOPE);
  const hostRoot = path.join(scopeA, 'dsh');
  await writePackage(hostRoot, SCOPE + '/dsh', '0.2.2-rc.2');
  await writePackage(path.join(scopeA, INCLUDE_LEAF), INCLUDE_PACKAGE, '1.0.9');
  // instA has no PLUGIN_LEAF package on purpose: the include is the only
  // sibling this host can prove.

  const scopeB = path.join(root, 'app.asar', 'dsh', 'node_modules', SCOPE);
  const entry = path.join(scopeB, 'dsh-desktop-host', 'lib', 'cli.js');
  await writePackage(path.join(scopeB, 'dsh'), SCOPE + '/dsh', '0.2.2-rc.2');
  await writePackage(path.join(scopeB, 'dsh-desktop-host'), SCOPE + '/dsh-desktop-host', '0.2.2-rc.2');
  await writePackage(path.join(scopeB, PLUGIN_LEAF), PLUGIN_PACKAGE, '4.1.0');
  await writePackage(path.join(scopeB, INCLUDE_LEAF), INCLUDE_PACKAGE, '1.1.0');
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(entry, '// packaged host entry\n');

  const facts = observedHostFacts({ dsh: '0.2.2-rc.2', cordis: null, include: null, packageRoot: hostRoot, runningEntry: entry });
  assert.equal(facts.dsh, '0.2.2-rc.2');
  assert.equal(facts.cordis, null, 'the missing field must not be borrowed from the process entry');
  assert.equal(facts.include, '1.0.9', 'the field must come from the selected CLI host');
});
