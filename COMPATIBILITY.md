# Compatibility and blocking dependencies

This repository is the sole development home of the `dsh-evolution` DSH bundle.
It is designed to run only through the official DSH plugin mechanism. This file
records every external dependency, legacy adapter, and unresolved blocker so
none of them is hidden behind an implicit patch.

## Supported versions

| Component | Range |
| --- | --- |
| DSH | `0.2.0-rc.2` or `0.2.1-alpha.1` (exact alternatives, enforced by `peerDependencies`) |
| Node | `^22.19.0 || >=24.0.0` |
| Bundle format | `dsh.bundle.patch` + profile `dsh.profile.bundles` |

Every listed DSH version is verified by a real install run, not by widening a
range. `SUPPORTED_DSH_VERSIONS` in `lib/diagnostics.js` is derived from the
declared alternatives, so a version can only appear there after the acceptance
below passes; a host outside the list is reported `blocked` by `host.version`
with `verified: false`, never accepted silently.

The acceptance is executable from this repository and its evidence is committed
alongside it:

```sh
npm run release:pack
node scripts/acceptance/run-host-acceptance.mjs --host 0.2.0-rc.2
node scripts/acceptance/run-host-acceptance.mjs --host 0.2.1-alpha.1
```

Evidence: `docs/evidence/dsh-0.2.0-rc.2.json` and
`docs/evidence/dsh-0.2.1-alpha.1.json` (host scratch paths redacted). Each file
records the `contentSha256` of the package it installed and the `sha256` of the
bytes it installed; both are checked against the committed pin in
`release/manifest.json` by `npm run pack:check` and
`test/release-pin.test.mjs`. The harness is self-contained: it installs the
official host release itself, so a fresh checkout can re-derive both files. CI
runs the same command per host (`ci.yml` on `ubuntu-latest`).

### Verified compatibility matrix

| Host | `@deepseek-ai/cordis` | `cordis-plugin-include` | `cordis-plugin-loader` | Verified |
| --- | --- | --- | --- | --- |
| `0.2.0-rc.2` | `4.0.4` | `1.0.9` | `1.0.5` | yes — `docs/evidence/dsh-0.2.0-rc.2.json` (full acceptance + unit suite) |
| `0.2.1-alpha.1` | `4.0.5-alpha.1` | `1.0.10-alpha.1` | `1.0.6-alpha.1` | yes — `docs/evidence/dsh-0.2.1-alpha.1.json` (full acceptance, same key paths) |

The whole acceptance is re-run per host against a fresh `$DSH_HOME`: official
`dsh plugin add` of the packed tarball, first boot, all 9 tool registrations,
in-session doctor, core `inspect→propose→trial→measure→revert` with proven
runtime recovery, read-only CLI doctor over the official composition,
execution-bridge fault injection with an idempotent repair, restart recovery,
real promotion to `canary-observing` through a second confirmation gate, stable
commit at the startup barrier across a restart, canary rollback that removes
only the new candidate, unsupported-host blocking, disable/enable,
uninstall/reinstall with data retention, and a final doctor.

The committed `docs/evidence/` files are produced by the harness and cover
install, boot, all 9 tools, CLI doctor, the core flow, the official
pluginManager lifecycle, CLI uninstall/reinstall with data retention, the
README upgrade and rollback flows, real promotion, startup-canary commit across
a restart, canary rollback, and the final doctor. The unit suite covers
unsupported-host blocking, execution-bridge fault injection and idempotent
repair, and restart recovery, and parses the CI workflows themselves;
`RELEASE.md` records which parts of the earlier acceptance are not re-executed
by this harness.

At verification time npm's `alpha` tag pointed at `0.2.1-alpha.1` while
`latest`/`next` pointed at `0.2.0-rc.2`; both were accepted only after the run
above passed.

### Interface changes between the verified hosts

Measured by unpacking both releases from the registry and diffing the shipped
sources and type declarations, not by inference:

| Package | `0.2.0-rc.2` -> `0.2.1-alpha.1` | Effect on this bundle |
| --- | --- | --- |
| `@deepseek-ai/cordis` | `4.0.4` -> `4.0.5-alpha.1`: **zero source diff** | none |
| `@deepseek-ai/cordis-plugin-include` | `1.0.9` -> `1.0.10-alpha.1`: **zero source diff** | none |
| `@deepseek-ai/cordis-plugin-loader` | `1.0.5` -> `1.0.6-alpha.1`: adds `Entry.moduleNamespace` (the raw import result, retained for HMR); `Entry`/`EntryGroup`/`EntryTree` members this bundle reads are unchanged | none |
| `@deepseek-ai/dsh-tools` | `lib/types/index.d.ts` identical | none |
| `@deepseek-ai/dsh-cordis-host-runner` | `lib/index.js` identical; `lib/typert.host.js` only registers new LLM-retry event types | none |
| `@deepseek-ai/dsh-storage-domain` | one JSDoc sentence changed | none |

No breaking change was found, so no compatibility adapter was added: this bundle
still modifies no DSH code, keeps no host fork, and hides no downgrade. The
`@deepseek-ai/cordis` `4.0.1` -> `4.0.4` delta that the previous release already
shipped over only changed `Fiber.update()`'s return value and one logger
exporter allocation; every surface in the table above is unchanged by it.

Notable findings from the audit, all fixed in this release:

- `ctx.registry.values()`, `ctx.reflect.props`, `Fiber.getEffects()` and the
  `Fiber` lifecycle fields were documented public members but were listed as
  non-public, which overstated upgrade risk and pointed an upgrade review at the
  wrong targets.
- `ctx.reflect._getImpl()` was the only underscore-private Cordis *method* on the
  live read path and had a documented equivalent; it no longer is.
- `FiberState.ACTIVE === 2` was an unverifiable literal on the promotion gate,
  because `const enum` values are erased from the published runtime.
- The doctor's import graph must not contain a host package: an earlier draft of
  the service-inventory change imported `@deepseek-ai/cordis` there and broke the
  doctor CLI in a real install while the plugin itself still booted.

The loader publishes no independent stability contract, so the layer this
bundle reads (`EntryTree.resolve/await/root`, `Entry.fiber/options/disabled`) is
a transitive constraint of the include peer, re-verified per host and probed by
`runtime.internal-api`.

An unlisted DSH release — including `0.1.5-rc.1` — is reported `blocked` by
`host.version` with `verified: false` and exit code 2, and it never appears in
`SUPPORTED_DSH_VERSIONS`. The bundle itself applies no runtime version gate: a
mounted bundle cannot veto its own host mid-session, so the verdict is a
contract plus a doctor block rather than a hidden downgrade. A version is added
to the list only by passing the same acceptance run.

There is no build step: the package ships runnable ESM under `lib/`.

## Runtime dependencies provided by the DSH host

Declared in `peerDependencies`; the host profile provides them. The bundle
imports only:

- `@deepseek-ai/cordis` (service base class)
- `@deepseek-ai/cordis-plugin-include` (promoted composition lifecycle)
- `js-yaml` (composition and patch file parsing)
- `zod` (declared under `dependencies`, installed with the bundle)

`js-yaml` is declared in `peerDependencies` *and* in `dependencies`. The host
normally provides it, but the doctor CLI (`scripts/doctor.mjs`) runs in a
plugin-only profile where the host's modules are not on the plain Node
resolution path; shipping our own copy keeps that entry working, and the
doctor degrades to an explicit `not-evaluated` YAML check if the parser is
ever missing instead of failing to start.

`lib/cordis-compat.js` follows the same rule in the opposite direction: it
imports **no** host package, because the doctor's import graph includes it. The
isolate-map symbol it needs is the registered `Symbol.for('cordis.isolate')`
that cordis itself builds, and the running bundle hands over the authoritative
`Context.isolate` at boot (`registerIsolateKey`). `test/cordis-compat.test.mjs`
asserts that symbol equals the real `Context.isolate` and copies the bundle
without any `node_modules` to prove the doctor still starts.

`@deepseek-ai/dsh`, `@deepseek-ai/dsh-tools`, and
`@deepseek-ai/dsh-cordis-host-runner` are declared because the bundle consumes
the host services they define (`ctx.tools`, `ctx.dynamicCordisRunner`,
`ctx.storageDomain`, `ctx.agents`, `ctx.permissionPresets`); they are not
imported directly.

## Cordis / official-Include surfaces this bundle reads

Every surface is classified from the shipped packages and recorded once in
`lib/cordis-compat.js`. The same table drives the runtime readers and the
doctor's `runtime.internal-api` check, so the report can never claim a different
dependency set than the code uses. `public` = an exported member with a
documented contract; `undocumented` = a public runtime property with no
documented contract; `private` = underscore-prefixed and skipped by cordis' own
context-member resolution.

| Surface | Class | What is read | Replacement used |
| --- | --- | --- | --- |
| `ctx.registry.values()` | public - `RegistryService.values()`, "Iterate the registered plugin runtimes" | plugin runtimes and their fibers | none needed |
| `ctx.reflect.props` | public - "Declared context properties (services and accessors), by name" | declared service names | none needed |
| `ctx.reflect.store` + `Context.isolate` | public - `ReflectService.store`, the exported `Impl` type, the documented isolation-map key | bound implementation and its owning fiber | **replaces `ctx.reflect._getImpl()`** |
| `ctx.reflect._getImpl()` | private (underscore) | unused while the row above resolves | fallback only; `runtime.internal-api` records which path was taken |
| `ctx.events._hooks` | private (underscore) | listener inventory | **none exists** - see below |
| `Fiber.getEffects()`, `Fiber.state/uid/inject/store/inertia` | public - documented members of the exported `Fiber` class | lifecycle state, dependencies, effect labels | `FiberState.ACTIVE` is not importable (`const enum`, erased at runtime), so `fiberIsActive()` uses these documented fields instead of the numeric literal |
| official Include instance state: `EntryTree.resolve/await/root`, `Entry.fiber/options/disabled` | undocumented - public members with no published stability contract | the mounted promoted row and its fiber health | `EntryTree.resolve(rowId)` instead of `EntryTree.store[rowId]`; the live root entry list has no public accessor, so the stale-tree check reads `root.data` and fails closed when it cannot |
| `ctx.tools.schemas/get`, `dynamicCordisRunner.snapshot/define/run/stop/undefine`, `ctx.get('cordisInspect').list` | public - host service surfaces | tool surface, dynamic packages, inspect providers | none needed |

### What is still private, and why

- **`ctx.events._hooks`.** Cordis 4.x publishes no listener enumeration:
  `ctx.on`/`ctx.once` only register, and `emit`/`parallel`/`serial`/`bail`/
  `waterfall` only deliver. The alternative would be a second bookkeeping table
  owned by this plugin, i.e. a less accurate second source of truth for a fact
  cordis already owns. It is kept, probed individually, and a host that drops it
  is reported `degraded` with the exact missing probe rather than an empty
  listener set.
- **`ctx.reflect._getImpl()`.** Retained only as the fallback for a host where
  `ctx.reflect.store` is unreachable under the isolate key. On both verified
  hosts the doctor reports `public: ctx.reflect.store + Context.isolate`, so the
  private method is not on the live read path.
- **`Fiber.state` numeric values.** `FiberState` is a `const enum`, erased from
  the published runtime. `fiberIsActive()` decides ACTIVE from
  `uid`/`store`/`inertia`, and `test/cordis-compat.test.mjs` asserts equality
  with `state === FiberState.ACTIVE` across every lifecycle transition against
  the real package, so a renumbering fails the suite instead of being accepted.
- **`Fiber state` naming.** `safeState()` still maps the numeric state to a name
  and always reports the raw number alongside it, so a renumbering shows up as a
  changed state, never as a silently renamed one.

`lib/diagnostics.js` probes every required surface individually and returns
`degraded` with the exact missing probe when one is gone, so an upgrade cannot
silently turn introspection into partial facts. Private surfaces without a
replacement are listed in the check evidence with the recorded reason, so an
upgrade review can see what actually needs re-verification.

The doctor also reads the cross-process `domain-archive.lock`; an ownerless lock
(empty file or dead pid) is reclaimed by the runtime and reported with a
`--repair` action, while a lock held by a live process is never taken.

Evidence and the exact official references used during migration are kept in
the private migration workspace; they are not part of this package. See the
plugin `README.md` for the supported-version contract.

## Legacy compatibility adapters (isolated, off by default)

1. **Startup drift** — `lib/compat/legacy-startup-drift.js`.
   The previous installation imported `scripts/shared/drift-engine.js` from a
   local DSH working tree. That module is external and can never be part of this
   package. The adapter is disabled by default (`startupDrift: false` in
   `lib/index.js`) and only runs if a caller explicitly enables it *and*
   configures a `driftStatePath` pointing at such a tree.
   *Removal condition:* delete once no supported DSH layout publishes a
   `repoRoot` + drift engine state file.

2. **Preset composition guard** — `lib/guard.js` recognises
   `*/.agent-presets/<id>/agent.cordis.yml` as a managed composition path.
   This protects legacy preset installs; the current bundle writes
   `promoted.cordis.yml` under its own data root instead.

3. **Legacy default paths** — `lib/orchestrator.js` `defaultPaths()` keeps
   `~/.dockyard-dsh/evolution-events.jsonl` and
   `~/.local/share/dsh-local/...` as last-resort defaults. When used as a DSH
   bundle these are always overridden by `lib/index.js` `storageConfig()`
   (`$DSH_HOME/storages/evolution`). They exist only so a standalone caller
   without configuration still fails safely rather than writing to an
   unexpected place.

4. **Data migration** — `scripts/import-evolution-data.mjs` reads the legacy
   preset layout (`knowledge/evolution-memory.json`, `EVOLUTION.md`,
   `knowledge/archive/**`) and an approved Dockyard snapshot. It performs
   staged, SHA256-verified, atomic, idempotent imports and refuses missing or
   changed source data. It never discovers paths on its own.

## Known functional blockers (not repository blockers)

The following capabilities are **not** fully independent of the host and are
recorded rather than worked around:

- **Promotion evaluator is advisory.** `promotionGates` remains the production
  authority. The extracted domain evaluator records its decision and hard-vetoes
  on a detected regression, but host-provided independent production
  baseline/test metrics are not yet wired in.
  *Would be resolved by:* a DSH host surface that supplies independent
  baseline/test metrics for an experiment.
- **`lib/dockyard-domain/continuous/` and `lib/dockyard-domain/governance/`** are
  extracted, side-effect-free domain modules covered by unit tests, but they are
  **not** wired into the orchestrator's live loop. The plugin never starts a
  second engine or scheduler.
- **Host-only promotion.** Client halves are rejected; promoted host code is
  evaluated through a cooperative `Function(hostCode)()` gate, which is not a
  security sandbox.

None of these keeps code in the old DSH repository: the bundle here is complete
and installable, and each blocker is a documented boundary with a stated
resolution path.

## Reliability boundaries added by the diagnostics work

- **Startup is never bricked by a partial lock write.** `openDomainStorage`
  reclaims a lock whose pid is dead, and waits for an unparsable lock to settle
  (1s) before reclaiming it, so an in-flight writer is never displaced. The
  previous behaviour threw `E_DOMAIN_ARCHIVE_LOCK` forever on an empty lock
  file left by a killed process.
- **Safe repairs are idempotent.** Promotion-journal rollback, committed-journal
  cleanup, event-bridge tail trimming, orphan staging removal, migration staging
  cleanup and stale-lock removal all re-verify before acting and are proven
  no-ops on a second run (`test/diagnostics.test.mjs`).
- **Unknown states fail safe.** `rollback-failed`, unparsable or out-of-boundary
  journals, unverifiable event MACs, conflicting event ids, missing pending
  archives and altered immutable migration evidence are reported `blocked` with
  `recoverable=false`; the doctor never mutates them.
- **The doctor CLI is symlink-safe** and resolves the plugin package through
  `realpath`, so a `$DSH_HOME` or install path that contains symlinks still runs
  the diagnostic entry.
- **The doctor's import graph contains no host package.** `lib/cordis-compat.js`
  imports nothing from the host and the doctor entry only reaches
  `lib/diagnostics.js`, `lib/orchestrator.js` and `lib/cordis-compat.js`.
  `test/cordis-compat.test.mjs` copies the bundle without any `node_modules` and
  runs the doctor from it, so a reintroduced host import fails the suite.
- **A promoted row that cannot be observed is never reported as healthy.**
  `mountPromotedInclude` records the loader members it actually found at mount
  time; `runtime.internal-api` reports that evidence, and a missing surface is
  `degraded` with the exact probe rather than an empty row list.

## Data and privacy

- The repository contains no user data, credentials, tokens, logs, sessions, or
  machine-specific paths.
- Tests use synthetic fixtures created in `os.tmpdir()`; no real Evolution
  memory or migration source is read.
- Installed state is created at runtime under the user's own
  `$DSH_HOME/storages/evolution`; a fresh install starts from empty state.
