// Frozen signature implementation before sort-key reuse.
const RECOVERY_UNAVAILABLE = new Set([
  "module-registry",
  "service-registry",
  "event-listeners",
  "tool-registry",
  "dynamic-plugin-registry",
  "inspect-provider-registry",
  "recovery-proof-unavailable",
]);

function stableDynamicPlugin(plugin = {}) {
  const packages = (plugin.packages || []).map((pkg) => ({
    name: pkg.name ?? null,
    purpose: pkg.purpose ?? null,
    hasHostHalf: pkg.hasHostHalf === true,
    hasClientHalf: pkg.hasClientHalf === true,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const packageById = new Map((plugin.packages || []).map((pkg) => [String(pkg.packageId), pkg]));
  const packageRef = (packageId) => {
    if (packageId === undefined || packageId === null) return null;
    const pkg = packageById.get(String(packageId));
    return pkg ? {
      name: pkg.name ?? null,
      purpose: pkg.purpose ?? null,
      hasHostHalf: pkg.hasHostHalf === true,
      hasClientHalf: pkg.hasClientHalf === true,
    } : { declared: true };
  };
  return {
    pluginId: plugin.pluginId ?? null,
    packages,
    currentPackage: packageRef(plugin.currentPackageId),
    nextPackage: packageRef(plugin.nextPackageId),
    activeRun: plugin.activeRun ? {
      package: packageRef(plugin.activeRun.packageId),
      handlers: [...(plugin.activeRun.handlers || [])].sort(),
    } : null,
  };
}

function stableRecoveryProof(proof = {}) {
  return {
    // Fiber UIDs, owner UIDs, and process-local active-run IDs are not runtime
    // effects. Keep semantic ownership/state while excluding those volatile
    // handles from the recovery comparison.
    modules: (proof.modules || []).map((module) => ({
      name: module.name ?? null,
      state: module.state ?? null,
      owner: module.owner?.name ?? module.owner ?? null,
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    services: (proof.services || []).map((service) => ({
      name: service.name ?? null,
      active: service.active === true,
      owner: service.owner?.name ?? service.owner ?? null,
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    tools: (proof.tools || []).map((tool) => tool.name ?? null).sort(),
    eventListeners: (proof.eventListeners || []).map((listener) => ({
      event: listener.event ?? null,
      callback: listener.callback ?? null,
      owner: listener.owner?.name ?? listener.owner ?? null,
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    effects: (proof.effects || []).map((effect) => ({
      component: effect.component ?? null,
      label: effect.label ?? null,
      disposer: effect.disposer ?? null,
      children: [...(effect.children || [])].sort(),
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    dynamicPlugins: (proof.dynamicPlugins || []).map(stableDynamicPlugin)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    unknown: [...new Set(proof.unknown || [])].sort(),
  };
}

/** Stable, detached projection used only to prove that Cordis was restored. */
export function legacyRuntimeSignature(runtime) {
  return {
    components: (runtime.components || []).map((component) => ({
      name: component.name,
      state: component.state,
      inject: [...(component.inject || [])].sort(),
      effects: [...(component.effects || [])].sort(),
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    services: (runtime.services || []).map((service) => ({
      name: service.name,
      active: service.active === true,
      owner: service.owner?.name,
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    tools: (runtime.tools || []).map((tool) => tool.name).sort(),
    events: (runtime.events || []).map((event) => ({
      name: event.name,
      listeners: (event.listeners || []).map((listener) => ({
        callback: listener.callback,
        owner: listener.owner?.name,
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    dynamicPlugins: (runtime.dynamicPlugins || []).map(stableDynamicPlugin)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    recoveryProof: stableRecoveryProof(runtime.recoveryProof || { unknown: ["recovery-proof-unavailable"] }),
  };
}

export function legacySignatureEqual(left, right) {
  const leftSignature = legacyRuntimeSignature(left);
  const rightSignature = legacyRuntimeSignature(right);
  // Stable, pre-existing unknown owners are safe only when both sides retain
  // exactly the same unknown set. Registry-unavailable markers remain
  // fail-closed: an unreadable proof can never establish recovery.
  const leftUnknown = leftSignature.recoveryProof?.unknown || [];
  const rightUnknown = rightSignature.recoveryProof?.unknown || [];
  if (leftUnknown.some((value) => RECOVERY_UNAVAILABLE.has(value))
    || rightUnknown.some((value) => RECOVERY_UNAVAILABLE.has(value))) return false;
  if (JSON.stringify(leftUnknown) !== JSON.stringify(rightUnknown)) return false;
  return JSON.stringify(leftSignature) === JSON.stringify(rightSignature);
}


export function signatureFixture(count = 100) {
  let seed = 42;
  const rows = Array.from({ length: count }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return { name: `module-${seed % 997}`, state: i % 2 ? 'active' : 'stopped',
      owner: { name: `owner-${i % 13}`, uid: i }, active: i % 2 === 0,
      inject: ['z', 'a'], effects: ['y', 'b'], callback: `callback-${i}`,
      event: `event-${i % 7}`, component: `component-${i}`, label: 'effect',
      disposer: 'cleanup', children: ['z', 'a'] };
  });
  const plugins = rows.slice(0, Math.ceil(count / 10)).map((row, i) => ({
    pluginId: row.name, packages: rows.slice(0, 5).map((pkg, j) => ({
      packageId: j, name: pkg.name, purpose: 'host', hasHostHalf: true,
    })), currentPackageId: 1, nextPackageId: 2, activeRun: { packageId: 1, handlers: ['z', 'a'] },
  }));
  return { components: rows, services: rows, tools: rows,
    events: rows.slice(0, 10).map(row => ({ name: row.name, listeners: rows.slice(0, 10) })),
    dynamicPlugins: plugins, recoveryProof: { modules: rows, services: rows, tools: rows,
      eventListeners: rows, effects: rows, dynamicPlugins: plugins, unknown: [] } };
}
