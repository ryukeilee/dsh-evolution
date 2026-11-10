#!/usr/bin/env node
/**
 * Real Desktop Electron version-resolution probe (read-only).
 *
 * Run it with the installed Desktop binary in Node mode so the process really is
 * the packaged Electron runtime, with Electron's asar-aware `fs`:
 *
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     scripts/acceptance/desktop-version-probe.mjs --out /tmp/desktop-versions.json
 *
 * It proves two things without writing anything into the Desktop install or its
 * user data:
 *   1. `detectRuntimeVersions()` resolves the real host through Electron's real
 *      `process.resourcesPath` (app.asar/dsh/node_modules/@deepseek-ai/dsh), not
 *      through the desktop-host entry package whose name only shares a prefix;
 *   2. the resolved triple equals the versions independently read from the
 *      packaged manifests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { detectRuntimeVersions } from '../../lib/orchestrator.js';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args[outIndex + 1] : null;

function packageManifest(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed?.name === 'string' && typeof parsed?.version === 'string'
      ? { name: parsed.name, version: parsed.version }
      : null;
  } catch {
    return null;
  }
}

const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : null;
const appRoot = resourcesPath ? path.join(resourcesPath, 'app.asar') : null;
const dshRoot = appRoot ? path.join(appRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh') : null;
const cordisRoot = appRoot ? path.join(appRoot, 'dsh', 'node_modules', '@deepseek-ai', 'cordis') : null;
const desktopHostRoot = appRoot ? path.join(appRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host') : null;

const independent = {
  dsh: dshRoot ? packageManifest(path.join(dshRoot, 'package.json')) : null,
  cordis: cordisRoot ? packageManifest(path.join(cordisRoot, 'package.json')) : null,
  desktopHost: desktopHostRoot ? packageManifest(path.join(desktopHostRoot, 'package.json')) : null,
};

// No injected paths: use the live Electron resources root exactly as a plugin
// running inside the Desktop main process would.
const versions = detectRuntimeVersions({ refresh: true, entries: [], resourcesPath: null });
const entryCandidates = appRoot
  ? [path.join(appRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')]
  : [];
const entryVersions = entryCandidates.length > 0
  ? detectRuntimeVersions({ refresh: true, entries: entryCandidates, resourcesPath: '' })
  : null;

const redact = (value) => JSON.parse(JSON.stringify(value)
  .split(JSON.stringify(resourcesPath ?? '').slice(1, -1)).join('<electron-resources>')
  .split(JSON.stringify(appRoot ?? '').slice(1, -1)).join('<app-asar>'));
const checks = {
  resourcesRootFound: Boolean(resourcesPath),
  hostMatchesIndependent: Boolean(independent.dsh) && versions.host === independent.dsh.version,
  cordisMatchesIndependent: Boolean(independent.cordis) && versions.cordis === independent.cordis.version,
  evolutionResolved: typeof versions.evolution === 'string' && /^\d+\.\d+\.\d+/.test(versions.evolution),
  // The desktop-host package must never be mistaken for the host package.
  hostIsNotDesktopHost: !independent.desktopHost || versions.host !== independent.desktopHost.version || independent.desktopHost.version === independent.dsh?.version,
  entryBasedMatchesResources: entryVersions ? entryVersions.host === versions.host && entryVersions.cordis === versions.cordis : false,
};
const evidence = redact({
  ok: Object.values(checks).every(Boolean),
  environment: {
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    resourcesPath,
  },
  resolved: versions,
  entryResolved: entryVersions,
  independent: {
    dsh: independent.dsh?.version ?? null,
    cordis: independent.cordis?.version ?? null,
    desktopHost: independent.desktopHost?.version ?? null,
  },
  checks,
  generatedAt: new Date().toISOString(),
});
const text = `${JSON.stringify(evidence, null, 2)}\n`;
if (out) fs.writeFileSync(out, text);
process.stdout.write(text);
if (!evidence.ok) process.exitCode = 1;
