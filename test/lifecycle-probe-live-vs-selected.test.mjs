// The host's live-vs-selected report is a snapshot, not a promise.
//
// `docs/evidence/autonomous-restart-0.2.1-alpha.1-failed.json` records the one
// acceptance run that failed at `lifecycle-disable`:
//
//     disable: application=restart-required but live state violates restart semantics
//
// The host decides both values from `ctx.get('hmr')`, the service that applies a
// profile change to the live tree, and it reads that capability more than once
// per call: `PluginManager.change()` snapshots it into `application` before the
// profile write, `configure()` re-reads it to pick the apply path, and
// `reload()` re-reads it again to decide whether to reconcile the tree. The HMR
// service is only observable once its asynchronous init completes, so a boot in
// which the Evolution entry is already live while `hmr` is still initializing
// makes a single `setBundleEnabled()` call straddle the transition: the report
// is the older snapshot (`restart-required`) and the reload decision is the newer
// one (`applied`). Nothing about the plugin is involved, and the recorded success
// run shows the other side of the same window (`lifecycle-enable` acted before
// `hmr` was observable and reported `restart-required` with the tree unchanged).
//
// The probe therefore derives the expected live tree from the capability the
// reload decision used instead of from the report, requires the report to match
// the capability when it did not change during the call, and still requires the
// switch itself to be atomic. These tests drive the probe through a fake host
// that reproduces the host's three reads; the frozen pre-fix predicate below is
// the differential baseline for the observation the old probe rejected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply as applyLifecycleProbe } from '../scripts/acceptance/probes/lifecycle-probe.mjs';
import { EVOLUTION_TOOLS } from '../lib/registration.js';

const EVOLUTION_TOOL_COUNT = EVOLUTION_TOOLS.length;
const BUNDLE = 'dsh-evolution';

/**
 * The pre-fix live-vs-selected predicate, frozen verbatim (the failing
 * acceptance message included). It is the differential baseline: the same
 * observation must be rejected by it and accepted by the probe.
 */
const PRE_FIX_LIVE_VIOLATION = ({ action, application, expectMountedBefore, expectSelectedAfter, mounted, toolCount }) => {
  const expectLive = application === 'applied' ? expectSelectedAfter : expectMountedBefore;
  if (mounted !== expectLive || toolCount !== (expectLive ? EVOLUTION_TOOL_COUNT : 0)) {
    return `${action}: application=${application} but live state violates restart semantics`;
  }
  return null;
};

/**
 * A fake host with the plugin manager's real decision shape.
 *
 * `capabilityReads` is the scripted answer of `ctx.get('hmr')`, in call order:
 * the probe's pre-call read, then the host's three reads (snapshot, configure,
 * reload), then the probe's post-call read. The last value repeats.
 */function createHost(overrides = {}) {
  const host = {
    /** Whether `ctx.get('evolution')` resolves. */
    service: true,
    /** How many `evolution_` tools are registered right now. */
    tools: EVOLUTION_TOOL_COUNT,
    /** The saved selection `listBundles()` reports. */
    selection: true,
    capabilityReads: [true],
    reads: 0,
    /** Overrides the reported `application`, to emulate a host that lies. */
    application: null,
    /** Replaces the live application of a change, to emulate a broken switch. */
    onLiveEffect: null,
    ...overrides,
  };
  host.capability = () => {
    const index = Math.min(host.reads, host.capabilityReads.length - 1);
    host.reads += 1;
    return host.capabilityReads[index];
  };
  host.setBundleEnabled = async (name, enabled) => {
    assert.equal(name, BUNDLE);
    // PluginManager.change(): the report is a snapshot taken before the write.
    const snapshot = host.capability();
    host.selection = enabled;
    // configure(): the capability only chooses `runExclusive()` or a direct call;
    // the operation body runs either way. Its `reload()` reads the capability
    // again, so both reads always happen.
    host.capability();
    if (host.capability()) {
      if (host.onLiveEffect) host.onLiveEffect(enabled);
      else {
        host.service = enabled;
        host.tools = enabled ? EVOLUTION_TOOL_COUNT : 0;
      }
    }
    return {
      stage: 'enable',
      target: name,
      enabled,
      changed: true,
      application: host.application ?? (snapshot ? 'applied' : 'restart-required'),
      warnings: [],
    };
  };
  return host;
}

function createContext(host) {
  return {
    get(name) {
      if (name === 'evolution') return host.service ? { orchestrator: {} } : undefined;
      if (name === 'hmr') return host.capability() ? { runExclusive: async (work) => work() } : undefined;
      return undefined;
    },
    effect(register) {
      register();
    },
    tools: {
      schemas: () => [
        ...EVOLUTION_TOOLS.slice(0, host.tools).map((name) => ({ name })),
        { name: 'bash' },
      ],
    },
    pluginManager: {
      setBundleEnabled: (name, enabled) => host.setBundleEnabled(name, enabled),
      listBundles: async () => [{ name: BUNDLE, enabled: host.selection }],
    },
  };
}

/** A throwaway `$DSH_HOME` with the Evolution user data the probe hashes. */
function createHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lifecycle-probe-'));
  const dataRoot = path.join(home, 'storages', 'evolution');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'evolution-memory.json'), '{"entries":[]}');
  fs.writeFileSync(path.join(dataRoot, 'event-bridge.key'), 'probe-key');
  return { home, dataRoot };
}

/** Run the probe's `apply()` for one action and settle its single reply. */
async function runProbe(host, action) {
  const { home, dataRoot } = createHome();
  host.home = home;
  host.dataRoot = dataRoot;
  const saved = {
    action: process.env.EVOLUTION_LIFECYCLE_ACTION,
    home: process.env.DSH_HOME,
    send: Object.getOwnPropertyDescriptor(process, 'send'),
  };
  const replies = [];
  const listenersBefore = new Set(process.listeners('message'));
  process.env.EVOLUTION_LIFECYCLE_ACTION = action;
  process.env.DSH_HOME = home;
  process.send = (message) => replies.push(message);
  try {
    applyLifecycleProbe(createContext(host));
    process.emit('message', 'run');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !replies.some((reply) => reply.result || reply.error)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const reply = replies.find((entry) => entry.result || entry.error);
    if (!reply) throw new Error(`the probe did not answer action=${action}`);
    return { result: reply.result, error: reply.error, dataRoot, home };
  } finally {
    if (saved.action === undefined) delete process.env.EVOLUTION_LIFECYCLE_ACTION;
    else process.env.EVOLUTION_LIFECYCLE_ACTION = saved.action;
    if (saved.home === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved.home;
    if (saved.send === undefined) delete process.send;
    else Object.defineProperty(process, 'send', saved.send);
    for (const listener of process.listeners('message')) {
      if (!listenersBefore.has(listener)) process.off('message', listener);
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('a stable capability makes the report authoritative for both actions', async () => {
  const disableHost = createHost({ capabilityReads: [true] });
  const disabled = await runProbe(disableHost, 'disable');
  assert.equal(disabled.error, undefined);
  assert.equal(disabled.result.application, 'applied');
  assert.equal(disabled.result.selected, false);
  assert.equal(disabled.result.mountedAfter, false);
  assert.equal(disabled.result.toolCount, 0);
  assert.equal(disabled.result.memoryUnchanged, true);
  assert.equal(disabled.result.liveApplyBefore, true);
  assert.equal(disabled.result.liveApplyAfter, true);

  const enableHost = createHost({
    capabilityReads: [false],
    service: false,
    tools: 0,
    selection: false,
  });
  const enabled = await runProbe(enableHost, 'enable');
  assert.equal(enabled.error, undefined);
  assert.equal(enabled.result.application, 'restart-required');
  assert.equal(enabled.result.selected, true);
  assert.equal(enabled.result.mountedAfter, false);
  assert.equal(enabled.result.toolCount, 0);
  assert.equal(enabled.result.liveApplyBefore, false);
  assert.equal(enabled.result.liveApplyAfter, false);
});

test('a capability that appears during the call is the host snapshot, not a live violation', async () => {
  // Probe read, snapshot, configure, reload, probe read: `hmr` becomes
  // observable between the report snapshot and the reload decision.
  const host = createHost({ capabilityReads: [false, false, true, true, true] });
  const { result, error } = await runProbe(host, 'disable');
  assert.equal(error, undefined, `the probe must not reject the host's snapshot: ${error}`);
  assert.equal(result.application, 'restart-required');
  assert.equal(result.selected, false);
  // The change was applied live by the reload decision.
  assert.equal(result.mountedAfter, false);
  assert.equal(result.toolCount, 0);
  assert.equal(result.liveApplyBefore, false);
  assert.equal(result.liveApplyAfter, true);

  // Differential: the frozen pre-fix predicate rejects exactly this observation,
  // which is the acceptance failure recorded for 0.2.1-alpha.1.
  assert.equal(
    PRE_FIX_LIVE_VIOLATION({
      action: 'disable',
      application: result.application,
      expectMountedBefore: true,
      expectSelectedAfter: false,
      mounted: result.mountedAfter,
      toolCount: result.toolCount,
    }),
    'disable: application=restart-required but live state violates restart semantics',
  );
});

test('a capability that vanishes during the call is not reported as a live violation either', async () => {
  const host = createHost({ capabilityReads: [true, true, false, false, false] });
  const { result, error } = await runProbe(host, 'disable');
  assert.equal(error, undefined);
  assert.equal(result.application, 'applied');
  // The reload decision saw no capability, so the tree stayed as it was.
  assert.equal(result.mountedAfter, true);
  assert.equal(result.toolCount, EVOLUTION_TOOL_COUNT);
  assert.equal(result.liveApplyBefore, true);
  assert.equal(result.liveApplyAfter, false);
});

test('an `applied` report must reach the live tree even when the capability appeared during the call', async () => {
  // The probe read, then the host's snapshot: the capability appeared between
  // them, so the report is `applied` and the reload decision reads it later
  // still. The only thing that can keep the tree mounted is a failed unmount.
  const broken = createHost({
    capabilityReads: [false, true, true, true, true],
    onLiveEffect: () => {},
  });
  const failed = await runProbe(broken, 'disable');
  assert.match(failed.error, /application=applied but live state is mounted=true, tools=10, expected mounted=false, tools=0/);

  // Same reads with a working unmount: accepted, and the transition recorded.
  const working = createHost({ capabilityReads: [false, true, true, true, true] });
  const { result, error } = await runProbe(working, 'disable');
  assert.equal(error, undefined);
  assert.equal(result.application, 'applied');
  assert.equal(result.mountedAfter, false);
  assert.equal(result.toolCount, 0);
  assert.equal(result.liveApplyBefore, false);
  assert.equal(result.liveApplyAfter, true);
});

test('a capability that appears between the configure read and the reload read', async () => {
  // The realistic startup window: the snapshot and the configure read both miss
  // the capability, the reload read sees it. The report is the older snapshot.
  const host = createHost({ capabilityReads: [false, false, false, true, true] });
  const { result, error } = await runProbe(host, 'disable');
  assert.equal(error, undefined);
  assert.equal(result.application, 'restart-required');
  assert.equal(result.mountedAfter, false);
  assert.equal(result.toolCount, 0);
  assert.equal(result.liveApplyBefore, false);
  assert.equal(result.liveApplyAfter, true);
});

test('a switch that does not reach the live tree is still rejected', async () => {
  const host = createHost({
    capabilityReads: [true],
    // `applied` with an unchanged tree: the unmount never happened.
    onLiveEffect: () => {},
  });
  const { error } = await runProbe(host, 'disable');
  assert.match(error, /application=applied but live state is mounted=true, tools=10, expected mounted=false, tools=0/);
});

test('a partial live tree is rejected', async () => {
  const host = createHost({
    capabilityReads: [true],
    onLiveEffect: () => {
      // The service disappears but the tool registrations stay behind.
      host.service = false;
      host.tools = EVOLUTION_TOOL_COUNT;
    },
  });
  const { error } = await runProbe(host, 'disable');
  assert.match(error, /application=applied but live state is mounted=false, tools=10, expected mounted=false, tools=0/);
});

test('a report that contradicts a stable capability is rejected', async () => {
  const host = createHost({ capabilityReads: [true], application: 'restart-required' });
  const { error } = await runProbe(host, 'disable');
  assert.match(error, /host reported application=restart-required although live apply was available for the whole call/);

  const inverse = createHost({
    capabilityReads: [false],
    service: false,
    tools: 0,
    selection: false,
    application: 'applied',
  });
  const inverted = await runProbe(inverse, 'enable');
  assert.match(inverted.error, /host reported application=applied although live apply was unavailable for the whole call/);
});

test('a mid-call capability change must still leave one consistent live state', async () => {
  const host = createHost({
    capabilityReads: [false, false, true, true, true],
    onLiveEffect: () => {
      host.service = true;
      host.tools = 0;
    },
  });
  const { error } = await runProbe(host, 'disable');
  assert.match(error, /live state is mounted=true, tools=0, neither the pre-call mounted=true, tools=10 nor the selected mounted=false, tools=0 state \(live apply changed during the call: false -> true\)/);
});

test('Evolution user data must stay byte-identical across the switch', async () => {
  const host = createHost({
    capabilityReads: [true],
    onLiveEffect: () => {
      fs.writeFileSync(path.join(host.dataRoot, 'evolution-memory.json'), '{"entries":[{"id":"rewritten"}]}');
      host.service = false;
      host.tools = 0;
    },
  });
  const { error } = await runProbe(host, 'disable');
  assert.match(error, /disable changed Evolution user data/);
});

test('verify keeps asserting the mounted surface', async () => {
  const host = createHost({ capabilityReads: [true] });
  const { result, error } = await runProbe(host, 'verify');
  assert.equal(error, undefined);
  assert.equal(result.action, 'verify');
  assert.equal(result.mountedAfter, true);
  assert.equal(result.toolCount, EVOLUTION_TOOL_COUNT);
});
