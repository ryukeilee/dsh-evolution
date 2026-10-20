# Compatibility and blocking dependencies

This repository is the sole development home of the `dsh-evolution` DSH bundle.
It is designed to run only through the official DSH plugin mechanism. This file
records every external dependency, legacy adapter, and unresolved blocker so
none of them is hidden behind an implicit patch.

## Supported versions

| Component | Range |
| --- | --- |
| DSH | `0.2.0-rc.2`, `0.2.1-alpha.1` or `0.2.1-rc.2` (exact alternatives, enforced by `peerDependencies`) |
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
node scripts/acceptance/run-host-acceptance.mjs --host 0.2.1-rc.2
```

Evidence: `docs/evidence/dsh-0.2.0-rc.2.json`,
`docs/evidence/dsh-0.2.1-alpha.1.json` and
`docs/evidence/dsh-0.2.1-rc.2.json` (host scratch paths redacted). Each file
records the `contentSha256` of the package it installed and the `sha256` of the
bytes it installed; both are checked against the committed pin in
`release/manifest.json` by `npm run pack:check` and
`test/release-pin.test.mjs`. The harness is self-contained: it installs the
official host release itself, so a fresh checkout can re-derive every file. CI
runs the same command per host (`ci.yml` on `ubuntu-latest`).

### Verified compatibility matrix

| Host | `@deepseek-ai/cordis` | `cordis-plugin-include` | `cordis-plugin-loader` | Verified |
| --- | --- | --- | --- | --- |
| `0.2.0-rc.2` | `4.0.5` | `1.0.10` | `1.0.6` | yes — `docs/evidence/dsh-0.2.0-rc.2.json` (full acceptance, 21/21 steps) |
| `0.2.1-alpha.1` | `4.0.5` | `1.0.10` | `1.0.6` | yes — `docs/evidence/dsh-0.2.1-alpha.1.json` (full acceptance, 21/21 steps) |
| `0.2.1-rc.2` | `4.0.5` | `1.0.10` | `1.0.6` | yes — `docs/evidence/dsh-0.2.1-rc.2.json` (full acceptance, 21/21 steps) |

The unit suite is not run per host: `ci.yml` runs it in a separate job on Node
`22.19.0` and `24.x`, against the module versions locked in `package-lock.json`
(`4.0.4` / `1.0.9` / `1.0.5`, from the devDependency baseline pinned to the
`0.2.0-rc.2` host), not against the versions a host resolves today.

The whole acceptance is re-run per host against a fresh `$DSH_HOME`: official
`dsh plugin add` of the packed tarball, first boot, all 9 tool registrations,
core `inspect→propose→trial→measure→revert` with proven runtime recovery,
read-only CLI doctor over the official composition, restart recovery, real
promotion to `canary-observing` through a second confirmation gate, stable
commit at the startup barrier across a restart, canary rollback that removes
only the new candidate, disable/enable, uninstall/reinstall with data
retention, and a final doctor.

The committed `docs/evidence/` files are produced by the harness and cover
install, boot, all 9 tools, CLI doctor, the core flow, the official
pluginManager lifecycle, CLI uninstall/reinstall with data retention, the
README upgrade and rollback flows, real promotion, startup-canary commit across
a restart, canary rollback, and the final doctor. The unit suite covers
unsupported-host blocking, event-bridge fault injection and idempotent repair,
and restart recovery, and parses the CI workflows themselves;
`RELEASE.md` section 4 documents what this harness runs, and section 6 lists the
paths it does not cover.

At verification time npm's `alpha` tag pointed at `0.2.1-alpha.1` while
`latest`/`next` pointed at `0.2.0-rc.2`; both were accepted only after the run
above passed. Those tag values are a read-only observation of the registry made
for that date, not an input to the harness, which installs exact version
numbers.

The module versions above are the ones the three hosts resolve **now**. They
were observed by re-running the whole harness for all three hosts on
2026-10-17 (each run's `startedAt` and `hostModules` record; those runs are not
the committed `docs/evidence/` files). All three hosts resolved
`@deepseek-ai/cordis` `4.0.5`, `cordis-plugin-include` `1.0.10`,
`cordis-plugin-loader` `1.0.6` and `js-yaml` `4.3.2` — including
`0.2.1-alpha.1`, whose committed acceptance had recorded the `alpha.2` patch
level. The cause is the hosts' own ranges, which are tilde ranges over a patch
line (`0.2.0-rc.2` declares `~4.0.4` / `~1.0.9` / `~1.0.5`; `0.2.1-alpha.1`
declares `~4.0.5-alpha.1` / `~1.0.10-alpha.1`): a stable `4.0.5` is a higher
version than `4.0.5-alpha.2` and is still inside `~4.0.4`, so once the stable
patch releases were published npm resolved them. This package's own
`peerDependencies` accept every one of those versions (`^4.0.1` covers `4.0.5`,
the include alternatives list `1.0.10`, `^4.2.0` covers `4.3.2`) and the doctor
reports them in range. Every re-pin regenerates the committed
`docs/evidence/dsh-<host>.json` files, so what they record moves with the pin:
for the `0.2.0-rc.16` pin all three record `4.0.5` / `1.0.10` / `1.0.6` / `4.3.2`
themselves, the same values the doctor reports above. A statement about what
they record therefore only holds for the pin it names.

`0.2.1-rc.2` is likewise an exact declared version. The date here is the
`startedAt` of the 2026-10-17 run described above, not of a committed evidence
file (each re-pin rewrites those); the tag values are
**not** part of any evidence file — the acceptance harness never queries
dist-tags — but a separate read-only observation of the npm registry made for
that date. On that date npm's dist-tags were `latest: 0.2.0-rc.2`,
`next: 0.2.1-rc.2`, `alpha: 0.2.1-alpha.5`;
there is no `rc` tag, so `0.2.1-rc.2` was resolved by exact version number and
the acceptance below is the only thing that accepted it. It depends on the
**stable** `@deepseek-ai/cordis` `4.0.5`,
`@deepseek-ai/cordis-plugin-include` `1.0.10` and
`@deepseek-ai/cordis-plugin-loader` `1.0.6`. The already-declared cordis range
`^4.0.1` covers `4.0.5`, and `1.0.10` was added as an explicit alternative
because `1.0.9` is an exact match that does not cover `1.0.10`.

### Interface changes between the verified hosts

Measured by unpacking both releases from the registry and diffing the shipped
sources and type declarations, not by inference:

| Package | `0.2.0-rc.2` -> `0.2.1-alpha.1` | Effect on this bundle |
| --- | --- | --- |
| `@deepseek-ai/cordis` | `4.0.4` -> `4.0.5-alpha.1`: **zero source diff** | none |
| `@deepseek-ai/cordis-plugin-include` | `1.0.9` -> `1.0.10-alpha.1`: **zero source diff** | none |
| `@deepseek-ai/cordis` | `4.0.5-alpha.1` -> `4.0.5-alpha.2`: only `package.json` changed (its version and its own dependency ranges); every shipped source file is byte-identical | none |
| `@deepseek-ai/cordis-plugin-include` | `1.0.10-alpha.1` -> `1.0.10-alpha.2`: only `package.json` changed (its version and its own dependency ranges); every shipped source file is byte-identical | none |
| `@deepseek-ai/cordis-plugin-loader` | `1.0.6-alpha.1` -> `1.0.6-alpha.2`: only `package.json` changed (its version and its own dependency ranges); every shipped source file is byte-identical | none |
| `@deepseek-ai/cordis-plugin-loader` | `1.0.5` -> `1.0.6-alpha.1`: adds `Entry.moduleNamespace` (the raw import result, retained for HMR); `Entry`/`EntryGroup`/`EntryTree` members this bundle reads are unchanged | none |
| `@deepseek-ai/dsh-tools` | `lib/types/index.d.ts` identical | none |
| `@deepseek-ai/dsh-cordis-host-runner` | `lib/index.js` identical; `lib/typert.host.js` only registers new LLM-retry event types | none |
| `@deepseek-ai/dsh-storage-domain` | one JSDoc sentence changed | none |

| Package | `0.2.1-alpha.1` -> `0.2.1-rc.2` | Effect on this bundle |
| --- | --- | --- |
| `@deepseek-ai/cordis` | `4.0.5-alpha.2` -> `4.0.5`: **zero source diff**; only `package.json` changed (its own version and its peer ranges `include ~1.0.10`, `loader ~1.0.6`, `cosmokit ~1.8.6`) | none |
| `@deepseek-ai/cordis-plugin-include` | `1.0.10-alpha.2` -> `1.0.10`: `src/index.ts` and `lib/index.js` are byte-identical to the previous release; only `package.json` changed | none |
| `@deepseek-ai/dsh-storage-domain` | `0.2.0-rc.2` -> `0.2.1-rc.2`: one JSDoc sentence changed in each of `lib/index.js` and `types/index.d.ts` | none |
| `@deepseek-ai/dsh-storage-json` | `0.2.0-rc.2` -> `0.2.1-rc.2`: `lib/` is byte-identical | none |
| `@deepseek-ai/dsh-cordis-host-runner` | internal brand helpers renamed (`CordisDynamicPluginId` -> `brandCordisDynamicPluginId` and siblings); exported names and signatures are unchanged | none |
| `@deepseek-ai/dsh-tools` | removed `lib/invariant.js`, added `lib/ptc-calls.js`, and `PtcDispatchEventData` gained an optional `meta?: JsonValue`; `ToolsService.schemas()` / `get()` are unchanged | none |
| `@deepseek-ai/dsh` (the host itself) | `profile-boot` semantics changed: `initializeProfileFromDefault` now **replaces** an existing profile (staging directory + atomic rename) instead of only initializing a missing one, and `prepareProfile`'s `fromDefaultProfile` became a pre-start replacement | none on the surfaces this bundle reads; the acceptance runs the ordinary CLI install/upgrade/rollback paths (it never passes `--from-default-profile`), so the upstream profile-replacement branch itself is **not** covered by this repository's acceptance and is not on this bundle's dependency surface |

No compatibility adapter was added for the `0.2.1-alpha.1` -> `0.2.1-rc.2`
delta either, and the claim is narrower than "the whole table is additive":
**every surface this bundle actually reads** is unchanged by it (zero source
diff, purely additive, or comment-level only), so every interface listed at the
top of this file still exists with the same shape on `0.2.1-rc.2`. The two
remaining rows of that table are not on this bundle's dependency surface, so
they need no adapter for the same reason: `@deepseek-ai/dsh-tools` removed its
own `lib/invariant.js` (this bundle never imports it), and the host's
`--from-default-profile` replacement semantics are never exercised by the CLI
install/upgrade/rollback paths the acceptance runs.

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

**The working tree that follows rc.14 adds no new host interface dependency.** The promotion rollback path changed *how* these surfaces are used, not which ones: the new waiting in `lib/promotion-include.js`'s `refresh()` uses the same members classified above — `tree.root.data` (the live row list), `EntryTree.resolve(rowId)`, `Entry.fiber`, and `fiberIsActive()` from `cordis-compat.js` (the documented `Fiber` lifecycle fields). The one surface worth spelling out is `Fiber.await()`: it is a documented method of the exported `Fiber` class ("Wait for current lifecycle work and rethrow startup errors", `lib/types/fiber.d.ts`) and `verify()` already used it, so it is not a new dependency — and `SURFACES` in `lib/cordis-compat.js` now probes it too (`typeof ctx.fiber.await === 'function`), classified `required: false`: a host that dropped `Fiber.await()` is listed in `runtime.internal-api`'s `advisoryUnavailable` evidence instead of being absent from the report, and because it is optional it never turns that check `degraded`. That path now fails closed instead: `refresh()` throws when a started entry exposes no awaitable fiber and when a disposal rejects, so a rollback never declares itself finished while a disposal outcome is unknown.

### What is still private, and why

- **`ctx.events._hooks`.** Cordis 4.x publishes no listener enumeration:
  `ctx.on`/`ctx.once` only register, and `emit`/`parallel`/`serial`/`bail`/
  `waterfall` only deliver. The alternative would be a second bookkeeping table
  owned by this plugin, i.e. a less accurate second source of truth for a fact
  cordis already owns. It is kept, probed individually, and a host that drops it
  is reported `degraded` with the exact missing probe rather than an empty
  listener set.
- **`ctx.reflect._getImpl()`.** Retained only as the fallback for a host where
  `ctx.reflect.store` is unreachable under the isolate key. Wherever the public
  path works, the live-context diagnostics resolve service implementations
  through `ctx.reflect.store` + `Context.isolate`, so the private method is not
  on the live read path then; it stays in `lib/cordis-compat.js` as the fallback
  probe and is only used when the public read fails.
- **`Fiber.state` numeric values.** `FiberState` is a `const enum`, erased from
  the published runtime. `fiberIsActive()` decides ACTIVE from
  `uid`/`store`/`inertia`, and `test/cordis-compat.test.mjs` restates the erased
  ACTIVE value as `2` and asserts equality with `state === 2` for every lifecycle
  transition it records from the real package, so a renumbering fails the suite
  instead of being accepted.
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
   package. The bundle entry passes `startupDrift: false` (`lib/index.js`), so the
   adapter is off in the plugin path; a standalone caller that omits that flag
   enables it, and it then reads its default state file
   (`~/.local/share/dsh-local/dsh-profiles-state.json`, or a configured
   `driftStatePath`) and imports the external engine only when that state names
   an existing engine.
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
  reclaims a lock whose readable content names a dead pid. A lock it cannot read
  or parse is treated as abandoned once the file has not been modified for 1s;
  until then it retries within a 5s budget and then throws
  `E_DOMAIN_ARCHIVE_LOCK`. A lock whose readable content names a live pid is
  refused, never taken. The previous behaviour threw `E_DOMAIN_ARCHIVE_LOCK`
  forever on an empty lock file left by a killed process.
- **Safe repairs are idempotent.** Promotion-journal rollback, event-bridge tail
  trimming, orphan staging removal, migration staging cleanup and stale-lock
  removal are each offered only from an on-disk check in the same run, and the
  event-bridge tail trim re-reads the file and re-establishes its plan
  condition before acting, then re-reads once more before the rename and skips
  without writing anything when the bytes changed while the replacement was
  prepared (an expired plan is `skipped` and writes nothing, and the repair is
  not offered at all when the file holds no complete line to keep). That is not
  concurrency safety: the bridge file's writers hold no lock, so an append that
  lands between the last re-read and the rename can still be dropped — run the
  repair while the host is stopped. All of them are proven no-ops on a second
  run (`test/diagnostics.test.mjs`). Committed-journal
  cleanup is asserted on its first run only: the test checks that it removes the
  promotion state directory while the composition row and the promoted module
  stay in place, and no second-run no-op is asserted for it.
- **Unknown states fail safe.** `rollback-failed`, unparsable or out-of-boundary
  journals (including unsupported record shapes such as `symlink`), unverifiable
  event MACs, event envelopes that name a writer other than the trusted one,
  conflicting event ids, missing pending
  archives and altered immutable migration evidence are reported `blocked`, and
  the doctor offers no repair for any of them and never mutates them; a
  `recoverable` flag in the same report can then only come from a safe repair
  for a different problem.
  Journal diagnostics and recovery share one boundary rule: only `file`/`path`
  records targeting `pluginRoot`, `presetDir` or `archiveDir` are allowed, never
  the promotion state directory; `dataRoot` does not widen these roots. Only
  boundary-valid interrupted/committed journals offer `promotion-journal-recover`
  / `promotion-journal-cleanup`, respectively. The event-bridge verdict and the
  runtime replay call the same `eventBridgeWriterTrusted()` predicate, so a
  record rejected for its MAC or for its writer identity is never reported `ok`
  when both sides use the same expected writer.
- **The trusted event-bridge writer is resolved per entry point.** The runtime
  binds the bridge to `config.eventBridgeWriter` from the plugin's resolved
  config (undocumented; default `dsh-evolution-orchestrator`, exported as
  `EVENT_BRIDGE_DEFAULT_WRITER`). The doctor resolves the expected writer in
  this order: an explicit in-session `config.eventBridgeWriter` — the same
  resolved config the runtime holds — wins; otherwise the writer the composed
  profile configures on the `evolution-orchestrator` entry
  (`config.eventBridgeWriter` in the `--dump-config` output, read after merging
  the sections a profile patch can split the bundle into); otherwise the bundle
  default. The report records both the value and its source
  (`evidence.trustedWriter` / `evidence.writerSource`: `config` |
  `composition` | `bundle-default`), and a healthy event-bridge check says which
  writer it verified against.
  *Three states, not a guess:* the composition reader states a writer only when
  the dump determines it exactly — one `evolution-orchestrator` entry, a block
  `config:`, the key as a direct child exactly once, and a scalar it can recover
  verbatim (a plain or quoted string; `eventBridgeWriter:` and `""` are YAML
  null / falsy and mean the default). Only direct child keys participate: a
  nested key such as `other.eventBridgeWriter` is a different key and is
  ignored entirely (the direct key is read if there is one; only an entry with
  no direct key at all is *undeclared*, which is what falls back to the bundle
  default). A key spelled equivalently but non-canonically —
  `"eventBridgeWriter"`, `'eventBridgeWriter'`, `eventBridgeWriter :` —
  resolves to the same YAML key at runtime, so it is *unreadable* rather than
  undeclared. An inline `config:` mapping, a YAML tag, anchor, alias, block
  scalar or flow collection, a `${...}` / `{{...}}` template, a
  comment-ambiguous value, a non-string scalar, a repeated key or a repeated
  entry is *unreadable* and is never defaulted: the event-bridge check reports
  `degraded` with `writerSource: 'unknown'`, `trustedWriter: null`,
  `writerExpectationReason` and the `writersSeen` actually in the log, unless a
  MAC-level problem (malformed / unverifiable / conflicts) makes it `blocked`.
  An in-session `config.eventBridgeWriter` is used verbatim, exactly as the
  runtime reads it (`config.eventBridgeWriter || EVENT_BRIDGE_DEFAULT_WRITER`:
  no trimming, no fallback to the composition). When the composition probe is
  skipped (`--no-composition`) or no DSH CLI is resolved, the doctor has no
  profile config and evaluates the log against the bundle default
  (`writerSource: 'bundle-default'`, identifiable in the summary and evidence),
  so an installation that overrides `eventBridgeWriter` in its profile can
  still have its own log reported as untrusted in that call; the same
  installation read through the composition probe, or in session, agrees with
  the runtime.
- **The doctor CLI is symlink-safe** and resolves the plugin package through
  `realpath`, so a `$DSH_HOME` or install path that contains symlinks still runs
  the diagnostic entry.
- **The doctor's import graph contains no host package.** `lib/cordis-compat.js`
  imports nothing from the host, and the doctor entry reaches only this
  package's own modules: `lib/diagnostics.js`, `lib/orchestrator.js`,
  `lib/cordis-compat.js`, `lib/experience-recall.js` and
  `lib/compat/legacy-startup-drift.js`, plus `lib/domain-storage.js` (which
  brings in `zod`, `lib/archive-stage.js`, `lib/event-log-checkpoint.js` and
  the domain modules) and `js-yaml`, both loaded lazily and guarded.
  `test/cordis-compat.test.mjs` copies the bundle without any `node_modules` and
  runs the doctor from it, so a reintroduced host import fails the suite.
- **A promoted row that cannot be observed is never reported as healthy.**
  `mountPromotedInclude` records the loader members it actually found at mount
  time; `runtime.internal-api` reports that evidence, and a missing surface is
  `degraded` with the exact probe rather than an empty row list.

## Data and privacy

- The shipped package contains no user data, credentials, tokens, logs,
  sessions, or machine-specific paths; `pack:check` rejects shipped text that
  carries a home path or credential material. `docs/evidence/` and
  `docs/performance/` are outside the package.
- Tests use synthetic fixtures created in `os.tmpdir()`; no real Evolution
  memory or migration source is read.
- Installed state is created at runtime under the user's own
  `$DSH_HOME/storages/evolution`; a fresh install starts from empty state.
