/**
 * Desktop / packaged-runtime version resolution.
 *
 * The applicability triple is only recorded when the process can prove it from
 * the official host package. Desktop boots an Electron process whose argv names
 * `@deepseek-ai/dsh-desktop-host/lib/cli.js`, while the real host package is the
 * sibling `@deepseek-ai/dsh`; a prefix match must never lend the desktop-host or
 * another `@deepseek-ai/dsh*` version to `dsh`. These tests build the same
 * layout from real manifests (plus the Electron resources fallback) and prove
 * that an unprovable runtime stays `unknown` instead of guessing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectRuntimeVersions } from '../lib/orchestrator.js';

const HOST_VERSION = '0.2.2-rc.1';
const CORDIS_VERSION = '4.1.0';

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evo-desktop-versions-'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** One Desktop-shaped packaged runtime: <base>/dsh/node_modules/... */
function packagedRuntime(root, base = 'app.asar') {
  const modules = path.join(root, base, 'dsh', 'node_modules', '@deepseek-ai');
  writeJson(path.join(modules, 'dsh', 'package.json'), { name: '@deepseek-ai/dsh', version: HOST_VERSION });
  writeJson(path.join(modules, 'dsh-desktop-host', 'package.json'), { name: '@deepseek-ai/dsh-desktop-host', version: '9.9.9-desktop-host' });
  writeJson(path.join(modules, 'dsh-tools', 'package.json'), { name: '@deepseek-ai/dsh-tools', version: '9.9.9-tools' });
  writeJson(path.join(modules, 'cordis', 'package.json'), { name: '@deepseek-ai/cordis', version: CORDIS_VERSION });
  const entry = path.join(root, base, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, '// desktop entry\n');
  return { entry, modules };
}

test('a Desktop Electron entry resolves the real host package, not its prefix siblings', () => {
  const root = scratch();
  try {
    const { entry } = packagedRuntime(root);
    const versions = detectRuntimeVersions({ refresh: true, entries: [entry], resourcesPath: '' });
    assert.equal(versions.host, HOST_VERSION, 'dsh must be the exact @deepseek-ai/dsh package, not desktop-host/tools');
    assert.equal(versions.cordis, CORDIS_VERSION);
    assert.match(versions.evolution, /^\d+\.\d+\.\d+/, 'the bundle version comes from this package');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the Electron resources root is a fallback when argv exposes no module entry', () => {
  const root = scratch();
  try {
    const electronRoot = path.join(root, 'resources');
    packagedRuntime(electronRoot);
    // `process.resourcesPath` points at the directory containing app.asar.
    const resolved = detectRuntimeVersions({ refresh: true, entries: [], resourcesPath: electronRoot });
    assert.equal(resolved.host, HOST_VERSION);
    assert.equal(resolved.cordis, CORDIS_VERSION);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unprovable runtime keeps every unknown version unknown', () => {
  const root = scratch();
  try {
    const versions = detectRuntimeVersions({ refresh: true, entries: [], resourcesPath: path.join(root, 'missing') });
    assert.equal(versions.host, null);
    assert.equal(versions.cordis, null);
    assert.match(versions.evolution, /^\d+\.\d+\.\d+/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a prefix-matching package without the exact host sibling does not lend its version', () => {
  const root = scratch();
  try {
    const modules = path.join(root, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
    writeJson(path.join(modules, 'dsh-desktop-host', 'package.json'), { name: '@deepseek-ai/dsh-desktop-host', version: '9.9.9' });
    const entry = path.join(modules, 'dsh-desktop-host', 'lib', 'cli.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// desktop entry\n');
    const versions = detectRuntimeVersions({ refresh: true, entries: [entry], resourcesPath: '' });
    assert.equal(versions.host, null, 'desktop-host is not the DSH host');
    assert.equal(versions.cordis, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a direct host entry still resolves through the official package layout', () => {
  const root = scratch();
  try {
    const modules = path.join(root, 'runtime', 'node_modules', '@deepseek-ai');
    writeJson(path.join(modules, 'dsh', 'package.json'), { name: '@deepseek-ai/dsh', version: HOST_VERSION });
    writeJson(path.join(modules, 'cordis', 'package.json'), { name: '@deepseek-ai/cordis', version: CORDIS_VERSION });
    const entry = path.join(modules, 'dsh', 'lib', 'bin.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// cli entry\n');
    const versions = detectRuntimeVersions({ refresh: true, entries: [entry], resourcesPath: '' });
    assert.equal(versions.host, HOST_VERSION);
    assert.equal(versions.cordis, CORDIS_VERSION);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
