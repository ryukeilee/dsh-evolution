/**
 * Exact host identity, resolved from the process entry and official packages.
 *
 * The rules live here once so the Evolution applicability triple
 * (dsh / cordis / evolution) and the cross-entry host identity
 * (dsh / cordis / include / node) cannot drift. A version is only read from an
 * exact official package manifest; a layout that does not expose one keeps
 * null, which callers report as unknown instead of guessing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh';
const DSH_PACKAGE_PREFIX = '@deepseek-ai/dsh';

/** Read one package manifest, or null when it is absent/unreadable/not a package. */
export function readPackageManifest(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed?.name !== 'string' || typeof parsed?.version !== 'string' || parsed.version.trim() === '') return null;
    return { name: parsed.name, version: parsed.version.trim() };
  } catch {
    return null;
  }
}

export function readPackageVersionFile(file) {
  return readPackageManifest(file)?.version ?? null;
}

/**
 * Resolve the official host package from one candidate entry path.
 *
 * The entry module can live directly under the host package or beside it:
 * Desktop boots `.../app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`,
 * where the real host is the sibling `@deepseek-ai/dsh`. A package whose name
 * merely starts with `@deepseek-ai/dsh` is not the host.
 */
export function hostPackageRootFromEntry(entry) {
  if (typeof entry !== 'string' || !path.isAbsolute(entry)) return null;
  let directory = path.dirname(entry);
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = readPackageManifest(path.join(directory, 'package.json'));
    if (manifest) {
      if (manifest.name === DSH_PACKAGE_NAME) return directory;
      if (manifest.name.startsWith(DSH_PACKAGE_PREFIX)) {
        for (const sibling of [
          path.join(path.dirname(directory), 'dsh'),
          path.join(directory, 'node_modules', '@deepseek-ai', 'dsh'),
        ]) {
          if (readPackageManifest(path.join(sibling, 'package.json'))?.name === DSH_PACKAGE_NAME) return sibling;
        }
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

export function processHostPackageRoot(entries = null) {
  const list = Array.isArray(entries) ? entries : [process.argv[1], ...process.argv.slice(2)];
  const candidates = list.filter((value) => typeof value === 'string' && path.isAbsolute(value) && /\.(?:js|mjs|cjs)$/.test(value));
  for (const entry of candidates) {
    const root = hostPackageRootFromEntry(entry);
    if (root) return root;
  }
  return null;
}

/**
 * Electron fallback for a packaged Desktop whose argv does not expose a module
 * entry: `process.resourcesPath` is Electron's official resource root.
 */
export function resourcesHostPackageRoot(resourcesPath) {
  if (typeof resourcesPath !== 'string' || !path.isAbsolute(resourcesPath)) return null;
  const bases = [
    path.join(resourcesPath, 'app.asar'),
    path.join(resourcesPath, 'app.asar.unpacked'),
    resourcesPath,
  ];
  const relatives = [
    ['dsh', 'node_modules', '@deepseek-ai', 'dsh'],
    ['node_modules', '@deepseek-ai', 'dsh'],
  ];
  for (const base of bases) {
    for (const relative of relatives) {
      const root = path.join(base, ...relative);
      if (readPackageManifest(path.join(root, 'package.json'))?.name === DSH_PACKAGE_NAME) return root;
    }
  }
  return null;
}

/**
 * One official package beside/nested under the resolved host, including the
 * pnpm store layout. The package name is a plain npm name.
 */
export function packageVersionFromHostRoot(root, packageName) {
  if (typeof root !== 'string' || typeof packageName !== 'string' || packageName === '') return null;
  const leaf = packageName.includes('/') ? packageName.slice(packageName.lastIndexOf('/') + 1) : packageName;
  const scope = packageName.includes('/') ? packageName.slice(0, packageName.lastIndexOf('/')) : null;
  const relativeParts = scope ? [scope, leaf] : [leaf];
  let directory = root;
  for (let depth = 0; depth < 6; depth += 1) {
    // The host package itself is `.../<scope>/<leaf>`; its sibling in the same
    // scope directory is `.../<scope>/<siblingLeaf>`, not a duplicated scope.
    const sibling = readPackageVersionFile(path.join(directory, '..', leaf, 'package.json'));
    if (sibling) return sibling;
    const nested = readPackageVersionFile(path.join(directory, 'node_modules', ...relativeParts, 'package.json'));
    if (nested) return nested;
    try {
      const store = path.join(directory, 'node_modules', '.pnpm');
      const prefix = scope ? scope + '+' + leaf + '@' : leaf + '@';
      for (const entry of fs.readdirSync(store)) {
        if (!entry.startsWith(prefix)) continue;
        const version = readPackageVersionFile(path.join(store, entry, 'node_modules', ...relativeParts, 'package.json'));
        if (version) return version;
      }
    } catch {
      // A layout without a store keeps looking one level up.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

export function cordisVersionFromHostRoot(root) {
  return packageVersionFromHostRoot(root, '@deepseek-ai/cordis');
}

let cachedDetectedVersions = null;

/** The dsh / cordis / evolution versions this process can actually prove. */
export function detectRuntimeVersions({ refresh = false, entries = null, resourcesPath = null } = {}) {
  if (!refresh && cachedDetectedVersions) return cachedDetectedVersions;
  let evolution = null;
  try {
    evolution = readPackageVersionFile(fileURLToPath(new URL('../package.json', import.meta.url)));
  } catch {
    evolution = null;
  }
  const electronResources = resourcesPath === null
    ? (typeof process.resourcesPath === 'string' ? process.resourcesPath : null)
    : resourcesPath;
  const hostRoot = processHostPackageRoot(entries) ?? resourcesHostPackageRoot(electronResources);
  const versions = Object.freeze({
    host: hostRoot ? readPackageVersionFile(path.join(hostRoot, 'package.json')) : null,
    cordis: hostRoot ? cordisVersionFromHostRoot(hostRoot) : null,
    evolution,
  });
  if (!refresh) cachedDetectedVersions = versions;
  return versions;
}

/**
 * The complete cross-entry host identity. Unlike the applicability triple, this
 * also names the official Include and the Node major; every value is either
 * exact or null, never guessed.
 */
export function detectHostIdentity({ refresh = false, entries = null, resourcesPath = null } = {}) {
  const versions = detectRuntimeVersions({ refresh, entries, resourcesPath });
  const electronResources = resourcesPath === null
    ? (typeof process.resourcesPath === 'string' ? process.resourcesPath : null)
    : resourcesPath;
  const hostRoot = processHostPackageRoot(entries) ?? resourcesHostPackageRoot(electronResources);
  return {
    profile: null,
    dsh: versions.host,
    cordis: versions.cordis,
    include: hostRoot ? packageVersionFromHostRoot(hostRoot, '@deepseek-ai/cordis-plugin-include') : null,
    node: process.version,
    evolution: versions.evolution,
    capturedAt: new Date().toISOString(),
  };
}
