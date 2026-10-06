# Compatibility and blocking dependencies

This repository is the sole development home of the `dsh-evolution` DSH bundle.
It is designed to run only through the official DSH plugin mechanism. This file
records every external dependency, legacy adapter, and unresolved blocker so
none of them is hidden behind an implicit patch.

## Supported versions

| Component | Range |
| --- | --- |
| DSH | `0.2.0-rc.2` (exact, enforced by `peerDependencies`) |
| Node | `^22.19.0 || >=24.0.0` |
| Bundle format | `dsh.bundle.patch` + profile `dsh.profile.bundles` |

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

`@deepseek-ai/dsh`, `@deepseek-ai/dsh-tools`, and
`@deepseek-ai/dsh-cordis-host-runner` are declared because the bundle consumes
the host services they define (`ctx.tools`, `ctx.dynamicCordisRunner`,
`ctx.storageDomain`, `ctx.agents`, `ctx.permissionPresets`); they are not
imported directly.

## Experimental / internal DSH API dependencies

These are used for real lifecycle health checks and are **not stable public
contracts**. A DSH upgrade must re-verify them:

- `ctx.registry.values()`, `ctx.reflect.props`, `ctx.reflect._getImpl()`
- `ctx.events._hooks`
- Fiber effect metadata
- Official Include internals accessed via public instance state: `root.data`,
  `store`, `Entry.fiber`, `Fiber.state`/`inject`/`ctx`, `ctx.get()`

`runDiagnostics` probes each of these individually (`runtime.internal-api`).
A host that dropped one reports `degraded` with the exact missing probe, so an
upgrade cannot silently turn introspection into partial facts. The doctor also
reads the cross-process `domain-archive.lock`; an ownerless lock (empty file or
dead pid) is reclaimed by the runtime and reported with a `--repair` action,
while a lock held by a live process is never taken.

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

## Data and privacy

- The repository contains no user data, credentials, tokens, logs, sessions, or
  machine-specific paths.
- Tests use synthetic fixtures created in `os.tmpdir()`; no real Evolution
  memory or migration source is read.
- Installed state is created at runtime under the user's own
  `$DSH_HOME/storages/evolution`; a fresh install starts from empty state.
