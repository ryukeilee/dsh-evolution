#!/usr/bin/env node
/**
 * Attribution probes for scripts/benchmarks/acp-startup-latency.mjs.
 *
 * Each mode runs in a fresh process because the numbers it reports are
 * parse/instantiate and first-open costs. Nothing here writes to the pristine
 * home; every root passed in is a scratch copy owned by the caller.
 *
 *   module-load <bundleLib> <csv-of-validated-entry-files> import the ACP/Web entry set
 *   shared-experience <bundleLib> <root> open the shared SQLite cold then hot
 *   shared-index <bundleLib> <dataRoot> <expectedCount> read + evaluate index
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const importFile = (file) => import(pathToFileURL(file).href);

async function moduleLoad(libRoot, filesCsv) {
  const files = filesCsv.split(',').filter(Boolean);
  assert.ok(files.length > 0, 'no validated entry files supplied');
  const realRoot = realpathSync.native(libRoot);
  const seen = new Set();
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!seen.has(url)) seen.add(url);
      return result;
    },
  });
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  for (const file of files) {
    // Every entry is re-resolved with native (kernel) semantics and confined
    // to the validated lib copy before ESM sees it.
    const resolved = realpathSync.native(file);
    assert.ok(resolved.startsWith(realRoot + path.sep), `entry ${file} resolves outside the validated lib root: ${resolved}`);
    const module = await importFile(resolved);
    assert.equal(typeof module.apply, 'function', `${path.basename(file)} has no apply() export`);
  }
  const ms = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const prefix = realRoot + path.sep;
  let libBytes = 0;
  for (const url of seen) {
    if (!url.startsWith('file:')) continue;
    try {
      const file = fileURLToPath(url);
      const stat = await fs.stat(file);
      if (stat.isFile() && file.startsWith(prefix)) libBytes += stat.size;
    } catch { /* loader URLs are not always regular files */ }
  }
  return { entries: files.map((file) => path.basename(file, '.js')), ms, cpuMs: (cpu.user + cpu.system) / 1000, modules: seen.size, libBytes };
}

async function sharedExperience(libRoot, root) {
  const { openSharedExperience } = await importFile(path.join(libRoot, 'shared-experience.js'));
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const coldStart = performance.now();
  let store = openSharedExperience(root);
  const coldMs = performance.now() - coldStart;
  const coldStats = store.stats();
  assert.equal(typeof store.close, 'function', 'shared experience store has no close()');
  store.close();
  const hotStart = performance.now();
  store = openSharedExperience(root);
  const hotMs = performance.now() - hotStart;
  const hotStats = store.stats();
  store.close();
  return {
    coldMs, hotMs,
    coldSchemaVersion: coldStats?.schemaVersion ?? null,
    hotSchemaVersion: hotStats?.schemaVersion ?? null,
    note: 'measures openSharedExperience() only (schema create/PRAGMA/read); not collector subscribe, tool registration or host composition',
  };
}

async function sharedIndex(libRoot, dataRoot, expectedCount) {
  const sharing = await importFile(path.join(libRoot, 'promoted-sharing.js'));
  const paths = { dataRoot, pluginRoot: path.join(dataRoot, 'promoted') };
  const readStart = performance.now();
  const index = await sharing.readSharedIndex(paths);
  const readIndexMs = performance.now() - readStart;
  assert.equal(index.status, 'ok', `published index is ${index.status}: ${JSON.stringify(index.invalid)}`);
  assert.equal(index.invalid.length, 0, 'seeded index has invalid records');
  assert.equal(index.records.length, expectedCount, 'seeded index record count differs');
  const evaluateStart = performance.now();
  const decisions = [];
  for (const record of index.records) {
    const decision = await sharing.evaluateSharedRecord({
      paths,
      record,
      profile: 'acp',
      host: record.host,
      capabilities: { fiberLifecycle: true, fiberAwait: true, include: true, toolsRegistry: true },
      services: { has: () => true, memberPresent: () => true },
      mountedModuleUrls: [],
      kernelEnabled: false,
      disableState: { status: 'absent', entries: [] },
      previousState: null,
    });
    decisions.push(`${decision.status}:${decision.reason ?? 'null'}`);
  }
  const evaluateTotalMs = performance.now() - evaluateStart;
  assert.ok(decisions.every((row) => row.startsWith('eligible:')), `record did not reach source validation: ${JSON.stringify(decisions)}`);
  return {
    records: expectedCount,
    readIndexMs,
    evaluateTotalMs,
    eligible: decisions.filter((row) => row.startsWith('eligible:')).length,
    note: 'measures index JSON parse + validateSharedRecord + readPromotedPlugin (source/manifest read and SHA-256) + host/capability decisions; not Include mount, plugin apply or ACP startup',
  };
}

const [mode, libRoot, extra, extra2] = process.argv.slice(2);
try {
  let result;
  if (mode === 'module-load') result = await moduleLoad(libRoot, extra);
  else if (mode === 'shared-experience') result = await sharedExperience(libRoot, extra);
  else if (mode === 'shared-index') result = await sharedIndex(libRoot, extra, Number(extra2));
  else throw new Error(`unknown probe mode: ${mode}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
}
