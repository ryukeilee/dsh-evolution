# Compatibility and blocking dependencies

This repository is the sole development home of the `dsh-evolution` DSH bundle.
It is designed to run only through the official DSH plugin mechanism. This file
records every external dependency, legacy adapter, and unresolved blocker so
none of them is hidden behind an implicit patch.

## Supported versions

### Unified experience development boundary

The development tree adds a runner-independent collector and a dedicated local
SQLite experience adapter, using Node's built-in `node:sqlite`. The pinned 0.2.3
artifact is unchanged. Desktop retains the complete manual Evolution flow;
ACP and Web are configured for collection and shared recall only. CLI/TUI is
outside this task. Profile installation does not prove runtime compatibility.

The existing core domain/archive root remains exclusive to Desktop. The
collector does not open `evolution_domain`, change storage-json routing, or
share journal/claim/canary state. Old free-text knowledge is retained in place;
only allowlisted metadata from authenticated structured Evolution facts can be
additively published on restart. Offline free-text legacy history is not
automatically available from ACP/Web. Shared recall remains advisory.

Current evidence and outstanding entry checks are recorded in
`docs/design/unified-experience.md`. The dedicated ACP acceptance drives real
stdio and the official Agent/tool pipeline with a loopback deterministic model
transport; it does not inject simulated host events. Its synthetic provider
usage is not a billing-token measurement. Desktop UI acceptance is separate
from Web host acceptance and must not be inferred from it.

| Component | Range |
| --- | --- |
| DSH | `0.2.0-rc.2`, `0.2.1-alpha.1`, `0.2.1-rc.2` or `0.2.2-rc.1` (exact alternatives, enforced by `peerDependencies`; `0.2.2-rc.1` requires the host `hmr` row disabled, see [The upstream HMR transaction gap](#the-upstream-hmr-transaction-gap-on-022-rc1)) |
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
node scripts/acceptance/run-host-acceptance.mjs --host 0.2.2-rc.1 --no-hmr
```

Evidence: `docs/evidence/dsh-0.2.0-rc.2.json`,
`docs/evidence/dsh-0.2.1-alpha.1.json`,
`docs/evidence/dsh-0.2.1-rc.2.json` and
`docs/evidence/dsh-0.2.2-rc.1.json` (host scratch paths redacted). Each file
records the `contentSha256` of the package it installed and the `sha256` of the
bytes it installed. `npm run pack:check` and `test/release-pin.test.mjs` keep the
two records apart instead of comparing every file to the pin: a host the pin
verified must still describe the pinned artifact (content *and* bytes), while a
host the pin never covered must describe the content this tree builds, because an
older build's record proves nothing about this one. `0.2.4` pins all four
declared hosts, so no host uses the second lane today; it exists for the next
host a development tree adds, before the pin that covers it is cut.
The split is `release/manifest.json#verifiedHosts`, so it moves only when a new
pin is cut, never when the working tree changes. The harness is self-contained: it installs the
official host release itself, so a fresh checkout can re-derive every file. CI
runs the same command per host (`ci.yml` on `ubuntu-latest`).

The `0.2.2-rc.1` run records `hostLiveApply: "disabled"` and passes `--no-hmr`,
which adds the ordinary overlay row `- id: hmr` / `disabled: true` to every boot
and additionally requires each enable/disable to report
`application: "restart-required"` with `restartReason: "no-hmr"`, to observe no
HMR capability during the call, and to apply the saved selection on the next
boot. The reason is the upstream gap documented below, not a workaround of this
bundle's own checks: the same overlay form is what `@deepseek-ai/dsh-hmr`
documents for "disabling or omitting HMR applies changes on restart".

### Cross-entry promoted plugin sharing (development tree)

The development tree adds an opt-in cross-entry feature: a Desktop promotion that the owner explicitly approved
for `acp` / `web` can be mounted by those profiles after it commits stable. It adds no DSH version, no new host
support claim and no new promotion authority. The consumer is a separate lightweight bundle entry
(`dsh-evolution/promoted-consumer`, `lib/promoted-consumer.js`) that is enabled for `acp` / `web` and disabled on
`desktop` by `scripts/setup-experience.mjs`; it never runs the Evolution kernel (no orchestrator, Trial/Canary
state machine, domain storage, tool registration or model call), and it writes only its own per-profile
state and composition. The Desktop kernel is still the only publisher: only a stable canary commit produces a
publication record, and records carry the exact host identity the promotion was verified on. The `0.2.4`
pinned artifact contains this feature. See `docs/shared-plugins.md` and `README.md`.

The isolated host acceptance covers it on `0.2.2-rc.1`: 31/31 steps pass in
`docs/evidence/cross-entry-0.2.2-rc.1.json` (isolated runtime and `$DSH_HOME`, HMR disabled, marker listener
executed exactly once per consumer boot, restart without a duplicate mount, incompatible record skipped,
tampered source skipped as invalid, per-profile revoke/enable, simulated host upgrade to
`pending-revalidation`, real ACP consumer, and preserved promoted sources/archives/experience data). That
acceptance has no Desktop binary, so it publishes from the full Evolution kernel booted on the Web profile
(recorded as `publisherProfile: "web"`) and then proves the Web and ACP consumer entries; the installed
production shape still runs the kernel only on Desktop. It is not a Desktop UI or Desktop-layout acceptance.
Reproduce it with:

```sh
npm run release:pack
node scripts/acceptance/run-host-acceptance.mjs --host 0.2.2-rc.1 --no-hmr --cross-entry \
  --tarball dist/dsh-evolution-0.2.4.tgz --out docs/evidence/cross-entry-0.2.2-rc.1.json
```

### Verified compatibility matrix

| Host | `@deepseek-ai/cordis` | `cordis-plugin-include` | `cordis-plugin-loader` | Verified |
| --- | --- | --- | --- | --- |
| `0.2.0-rc.2` | `4.0.5` | `1.0.10` | `1.0.6` | yes — `docs/evidence/dsh-0.2.0-rc.2.json` (full acceptance, 21/21 steps) |
| `0.2.1-alpha.1` | `4.0.5` | `1.0.10` | `1.0.6` | yes — `docs/evidence/dsh-0.2.1-alpha.1.json` (full acceptance, 21/21 steps) |
| `0.2.1-rc.2` | `4.0.5` | `1.0.10` | `1.0.6` | yes — `docs/evidence/dsh-0.2.1-rc.2.json` (full acceptance, 21/21 steps) |
| `0.2.2-rc.1` | `4.1.0` | `1.1.0` | `1.1.0` | yes — `docs/evidence/dsh-0.2.2-rc.1.json` (full acceptance, 21/21 steps, host `hmr` row disabled); `docs/evidence/experience-evolution-0.2.2-rc.1.json` (experience-driven acceptance, 25/25 steps) |

The `0.2.2-rc.1` host additionally runs the experience-driven acceptance
(`--experience-evolution`, four separate processes over one `$DSH_HOME`): real
tool failures are recorded by the bundled collector, `evolution_plan` discovers
the recurring target from that shared experience, a paired baseline/candidate
probe is executed through the official tool pipeline, `evolution_measure`
derives the before/after metrics itself, a real benefit candidate is promoted
and survives a restart, an ineffective candidate is refused by the promotion
gates and reverted with proven runtime recovery, and a regression candidate is
refused by the regression gate. The acceptance also proves that the structured
conclusion (strategy, decision, measured delta, DSH/Cordis applicability) is
written back to the unified experience store and recalled after a restart, and
that the same strategy under the same applicability is then refused with
`strategy-already-proven-ineffective`. The older declared hosts do not expose
the official batch tool executor, so the harness refuses the flag there.

Probe steps are limited to tools whose official definition opts into the
concurrency-safe contract (`isConcurrencySafe(args) === true`, which forbids
mutating parent-owned state); write/edit/shell/unknown/`run_code`/`evolution_*`
steps are refused before any call, in both phases, as are delegation/background
entry points (`subagent`, `workflow`, `job_*`, `schedule_*`, `send_message`, ...),
network tools, session-transcript readers and profile/UI/permission tools: the
concurrency flag is only a parallel-dispatch contract and does not promise that
the call finishes its work inline (the real `subagent` returns an activation and
keeps working in the background). The Desktop Electron
applicability triple is resolved from exact official package manifests (the
sibling `@deepseek-ai/dsh`, the sibling or nested `@deepseek-ai/cordis`, and
this bundle's own `package.json`), with Electron's official
`process.resourcesPath` as the packaged-layout fallback; anything unprovable
stays `unknown`. A read-only real-Desktop Electron run (Electron 44.7.0, Node
24.21.0) is recorded in
`docs/evidence/desktop-version-detection-0.2.2-rc.1.json`: it resolved DSH
`0.2.2-rc.1`, Cordis `4.1.0`, Evolution `0.2.3`, matching the manifests read
independently from the same install.

The unit suite is not run per host: `ci.yml` runs it in a separate job on Node
`22.19.0` and `24.x`, against the module versions locked in `package-lock.json`
(`4.0.4` / `1.0.9` / `1.0.5`, from the devDependency baseline pinned to the
`0.2.0-rc.2` host), not against the versions a host resolves today.

The whole acceptance is re-run per host against a fresh `$DSH_HOME`: official
`dsh plugin add` of the packed tarball, first boot, every tool registration
(the harness asserts the count `lib/registration.js` declares today),
core `inspect→propose→trial→measure→revert` with proven runtime recovery,
read-only CLI doctor over the official composition, restart recovery, real
promotion to `canary-observing` through a second confirmation gate, stable
commit at the startup barrier across a restart, canary rollback that removes
only the new candidate, disable/enable, uninstall/reinstall with data
retention, and a final doctor.

The committed `docs/evidence/` files describe the **pinned** build (the harness
covered its 9-tool surface); the harness now also asserts the 12-tool surface
this tree registers, and re-running it rewrites those files only as part of a
pin. They cover install, boot, the live tool surface, CLI doctor, the core flow, the official
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
for the current pin all three record `4.0.5` / `1.0.10` / `1.0.6` / `4.3.2`
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

| Package | `0.2.1-rc.2` -> `0.2.2-rc.1` | Effect on this bundle |
| --- | --- | --- |
| `@deepseek-ai/cordis` | `4.0.5` -> `4.1.0`: **breaking lifecycle rename.** A fiber's active-service snapshot is `Fiber.committed` instead of `Fiber.store`, and a bound service implementation reports its owner fiber as `impl.ctx.fiber` instead of `impl.fiber`. `Fiber.getEffects()`, `Fiber.state/uid/inject/inertia`, `ctx.reflect.props/store`, `ctx.reflect._getImpl()` and `ctx.events._hooks` are still present. | adapted in `lib/cordis-compat.js#fiberIsActive` (reads `committed` when the fiber exposes it, `store` otherwise) and `lib/orchestrator.js#inspectServices` (`impl.fiber ?? impl.ctx?.fiber`). A legacy 4.0 fiber that owns an obsolete `store` while exposing `committed: undefined` stays inactive, so a 4.0 value cannot be read as a 4.1 one. `test/cordis-41-compat.test.mjs` pins both shapes and runs the real 4.1 lifecycle (`EVOLUTION_CORDIS_41_MODULE`) |
| `@deepseek-ai/cordis-plugin-include` | `1.0.10` -> `1.1.0`: adds a journal module and `lib/types/journal.d.ts`; `refresh()`, `root.data`, `EntryTree.resolve()/await()`, `Entry.fiber` remain the members this bundle mounts and refreshes through | none; re-verified by the acceptance promotion phases, and reported by `runtime.internal-api` at mount |
| `@deepseek-ai/cordis-plugin-loader` | `1.0.6` -> `1.1.0`: `lib/index.js` changed; `entries()` and `Entry.fiber/options/disabled` remain the layer this bundle reads | none; re-verified by `runtime.internal-api` and the acceptance |
| `@deepseek-ai/dsh-tools` | `0.2.1-rc.2` -> `0.2.2-rc.1`: adds `lib/pipeline.js`, a shared chunk module and `types/batch.d.ts`; `ToolsService.schemas()` and `get()` keep their signatures | none; the acceptance asserts the live 12-tool surface and calls every tool through the registry |
| `@deepseek-ai/dsh-cordis-host-runner` | `0.2.1-rc.2` -> `0.2.2-rc.1`: `lib/index.js` and `lib/typert.host.js` changed; `snapshot()/define()/run()/stop()/undefine()` remain the dynamic runner surface this bundle uses | none; the core acceptance flow starts and reverts a real trial through it |
| `@deepseek-ai/dsh-storage-domain`, `@deepseek-ai/dsh-storage-json` | `0.2.1-rc.2` -> `0.2.2-rc.1`: `lib/` changed in both | none on the ports this bundle opens (`stateStore`, `transaction`, `mutationAuthority`); covered by the full unit suite against the pinned devDependencies and by the host acceptance |
| `@deepseek-ai/dsh` (the host itself) | new `PluginManager` restart semantics without HMR (`application: "restart-required"`, `restartReason: "no-hmr"`) and the upstream startup transaction gap described below | the deployment this release accepts disables the `hmr` row; the gap is documented, not worked around |

The `0.2.1-rc.2` -> `0.2.2-rc.1` delta is the first one that needed an adapter
(two field reads), and it is the only code change in that release. Every other
row above is a surface the bundle already used and still finds live: the
acceptance boots the real host, asserts the 12-tool surface, and the final
doctor's `runtime.internal-api` reports each probed surface on the live fiber
tree. Nothing here is inferred from a type declaration alone.

<a id="the-upstream-hmr-transaction-gap-on-022-rc1"></a>
### The upstream HMR transaction gap on `0.2.2-rc.1`

On this host a profile change started **inside the host's own startup window**
can end as `changed: true` / `application: failed` with
`HMR profile reconciliation must run inside runExclusive`. It is reproducible
with the official base bundle only: no Evolution entry, no Evolution dependency,
no guard change, no patched host. In
`@deepseek-ai/dsh-plugin-manager@0.2.2-rc.1/lib/index.js`:

1. `configure()` (`:3093`) reads HMR once and runs the operation directly when
   the service is not available yet, without entering `runExclusive`;
2. the operation saves the profile asynchronously (`selectBundle()`, `:3048`),
   during which HMR's own asynchronous init can complete and publish the
   service;
3. `reload()` (`:3129`) reads HMR **again**, now sees it, and calls
   `reconcileProfile()` (`@deepseek-ai/dsh-hmr/lib/index.js:1325`), which
   correctly refuses because this instance's `executing.getStore()` is not
   `true`. The selection is already saved, so the caller sees a saved change
   that was not applied.

`docs/evidence/hmr-022/official-control.json` holds the controlled
reproduction: the only instrumentation pauses after the real `selectBundle()`
returns until real HMR init is visible (scheduling only, no service, guard or
source replacement). It fails 3/3 with that diagnostic and succeeds 3/3 when the
same enable is issued after HMR is visible. That is a controlled schedule, not a
measured natural frequency: eight ordinary plugin toggles and ten official
bundle enables did not hit it. `docs/evidence/hmr-022/README.md` records the
source digests and the scope of both groups.

**What this release does instead of waiting for an upstream fix.** The official
documentation for `@deepseek-ai/dsh-hmr` states that "disabling or omitting HMR
applies changes on restart"; the same file documents the row override used here.
With the `hmr` row disabled, `PluginManager.configure()` runs the operation
directly, `reload()` recomposes the saved profile and does not call
`reconcileProfile()` at all, and `change()` reports
`application: "restart-required"` / `restartReason: "no-hmr"` before any
operation runs. Nothing is skipped, delayed or retried, and the guard stays
exactly as the host ships it.

`docs/evidence/hmr-022/hmr-route.json` records three paired boots of the same
enable action under that configuration: every run reports
`restart-required`/`no-hmr` with `changed: true`, observes no HMR capability at
`configure` or `reload`, and the immediately following boot of the same
`$DSH_HOME` mounts the rows the first boot withheld. Reproduce both groups with:

```sh
node --max-old-space-size=4096 scripts/acceptance/reproduce-hmr-startup.mjs \
  <installed-0.2.2-rc.1-runtime> docs/evidence/hmr-022/hmr-route.json
```

Evolution's own operations do not use that path: a promotion writes its own
`promoted.cordis.yml` and applies it through its own official Include
(`lib/promotion-include.js`), so trial, measurement, revert, promotion and
restart recovery behave identically with HMR enabled or disabled. The
difference is only in the host's own profile changes, which is why the accepted
deployment for this host disables HMR and reports every such change as
`restart-required`.

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
| `ctx.tools.schemas/get`, `dynamicCordisRunner.snapshot/define/run/stop/undefine`, `ctx.get('cordisInspect').list` | public - host service surfaces | tool surface, dynamic packages, inspect providers, and the `stop` / `undefine` receipt reasons (`DynamicCordisStopResponse`, `DynamicCordisUndefineReceipt`) that the cleanup proof reads | none needed |
| `ctx.get('pluginPackages').packageOf() (resolved host packages)` | public - `PluginPackages.packageOf(specifier, parentURL)`, "Locate the package named by a specifier without requiring a package export"; owner `@deepseek-ai/dsh-app-boot`; `required: false` | the exact `@deepseek-ai/dsh` / `@deepseek-ai/cordis` / `@deepseek-ai/cordis-plugin-include` versions the booted host resolved, so a publication records the host it was verified on instead of guessing from a version string or a PATH lookup | none needed; advisory, and without it host facts stay unknown so no publication or revalidation is possible (an existing promotion is never changed) |
| `ctx.get('loader').entries() (live loader entries)` | undocumented - `EntryTree.entries()`, "Iterate entries in this tree and any nested subtrees"; a public member of the shipped loader class without a published stability contract; owner `@deepseek-ai/cordis-plugin-loader`; `required: false` | the module URLs already mounted by this profile, so the cross-entry consumer cannot mount a second instance of a row the kernel already owns (duplicate-mount precaution only) | none exists; per-record verification on the consumer-owned Include tree stays the activation authority, so losing the surface only loses the short-circuit |

The two disposer receipts are a closed union and are not idempotent, which is why
the cleanup proof reads the *reason* and not only `ok`: `stop` answers
`not-running` once the run was stopped and `plugin-missing` once the plugin is
gone, and `undefine` answers `plugin-missing` for a plugin that is already
removed. A retry of an unproven cleanup (see AGENTS.md invariant 3) therefore
always sees one of these instead of `ok`, and all three describe the state the
cleanup exists to prove. Any other reason - and every thrown receipt - stays
unproven. Verified against the shipped `0.2.0-rc.2` runner (`lib/index.js`
`stop`/`undefine`, `lib/types/types.d.ts`) and in the real host: the first
`stop` answers `{ ok: true }`, the second `{ ok: false, reason: 'not-running' }`,
the first `undefine` `{ ok: true, wasRunning: false }`, the second
`{ ok: false, reason: 'plugin-missing' }`.

**Cross-entry sharing adds exactly two host surfaces.** The two rows above
(`ctx.get('pluginPackages').packageOf() (resolved host packages)` and
`ctx.get('loader').entries() (live loader entries)`) are the only host surfaces
this change adds; both are recorded in `lib/cordis-compat.js` `SURFACES` so
`runtime.internal-api` probes them like every other surface. Both are
`required: false`: their absence appears in `advisoryUnavailable` instead of
turning the check `degraded`, and each degrades only its own convenience (host
facts stay unknown, or the duplicate-mount short-circuit is unavailable) while
the per-record digest, approval, host, service and capability checks keep
gating every mount. The Include members (`EntryTree.resolve/await/root`,
`Entry.fiber/options/disabled`), `Fiber.await()`, the documented `Fiber`
lifecycle fields and `ctx.tools.schemas()` were already classified above.
`lib/cordis-compat.js` remains the single classification source for the
publisher, the consumer and the doctor.

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

The doctor also reads the cross-process `domain-archive.lock`, but never with a
second interpretation of it: the classification (device + inode + bytes, the 1s
settle window, the refusal to interpret a non-regular entry) comes from the same
module that acquires the lock. An ownerless lock (empty file or dead pid) is
reclaimed by the runtime and reported with a `--repair` action that acquires and
releases through that same fenced protocol instead of unlinking the path, while a
lock held by a live process is never taken and an entry the protocol cannot
interpret is reported and left in place.

Target claims under `ownership/` are reported and never touched by the doctor.
The runtime's only automatic reclaim is its pre-existing rule: a claim on this
host whose integer pid it can prove gone (`ESRCH`), retried once per
acquisition; an owner also removes its own claim when it releases the target. A
claim carries no identity its creator re-proves before use, so an entry whose
bytes never arrived cannot be told apart from an acquisition suspended between
its exclusive open and its write; removing it would let a second experiment take
the same target while the first still believes it owns it. The doctor names each
claim, classifies it, and states what an operator must establish before removing
one by hand.

Evidence and the exact official references used during migration are kept in
the private migration workspace; they are not part of this package. See the
plugin `README.md` for the supported-version contract.

## Cross-entry shared plugin state (development tree)

The cross-entry feature adds one durable tree, all under the existing data root
`$DSH_HOME/storages/evolution/shared-plugins/`. Plugin source is **not**
copied: records reference the bytes still in
`$DSH_HOME/storages/evolution/promoted/dsh-evolution-promoted-<12 hex>/`, and
the source digest is re-hashed before every activation.

| File | Contents and guarantees |
| --- | --- |
| `published.json` | The publication index (`schemaVersion: 1`, `kind: "dsh-evolution-shared-plugins"`). Written atomically (temp file + fsync + rename); absent is a normal Desktop-only install; unreadable or malformed authorizes nothing; a single malformed record is reported but does not discard the valid ones. Each record must be a stable fact (committed time, benefit decision, satisfied canary window), carry a non-empty `approvedProfiles` subset of `acp`/`web`, the source and manifest digests, required services/capabilities and the exact verified host identity. |
| `.publish.lock.sqlite` | The index's cross-process publication lock, a private SQLite database (0600) acquired with `BEGIN IMMEDIATE`; the open write transaction is the ownership, so there is no stale lease to reclaim and no reclaim race, and a crashed holder's transaction is rolled back by the next opener. Acquiring proves the database is writable (a read-only fallback would take no write lock) and fails as `E_SHARED_PUBLISH_LOCK_UNWRITABLE`; acquisition waits at most 2.5 s in total (including the in-process queue) and fails as `E_SHARED_PUBLISH_BUSY` (retryable). Requires a local filesystem with working POSIX file locks; a leftover `.publish.lock` lease file from the previous protocol is ignored and preserved, and old/new versions do not exclude each other. |
| `disabled.json` | Per-profile operator revocations (`kind: "dsh-evolution-shared-plugin-disable"`), one entry per plugin id + consumer profile. It only removes that profile's activation eligibility; the Desktop stable promotion is untouched. |
| `consumers/<profile>.json` | A consumer-owned activation report (`kind: "dsh-evolution-promoted-consumer"`): the host it ran on, `observedIndexUpdatedAt`, the per-record status rows and the disposal proof. It can never become a Desktop promotion fact. |
| `consumers/<profile>.cordis.yml` | The consumer-owned Include composition; derived state, rewritten at every start (first empty, then only eligible rows). The Desktop composition is never reused or modified. |

Refused by design: publishing a non-stable fact; publishing without a non-empty
explicit approval; replacing an existing record with different source bytes (the
publication is a same-id/different-digest conflict, verified bytes are never
silently replaced); paths that are symlinks, escape `promoted/`, disagree with
the record id/plugin name/module URL; records that are not `hostOnly`; consumer
writes to the publication index, promotion journal, canary state, Desktop
composition or domain storage; and any cross-machine use (the contract is one
machine, one OS user, one local filesystem and one `DSH_HOME`).

The doctor reports this tree through the read-only `promotion.sharing` check
(category `promotion`): `ok` with `evidence.status: "absent"` when nothing is
published, `blocked` when the index is unreadable/malformed or a record
disagrees with its on-disk source, and `degraded` for compatibility problems,
failed consumer activations or a publication that needs a restart. It never
activates, revokes, repairs or deletes anything. Operator actions go through
`dsh-evolution-shared` (`scripts/shared-plugins.mjs`): `list`, `disable`,
`enable`, `reset` and `revalidate`; a host upgrade leaves affected records
`pending-revalidation` until real isolated-host evidence is adopted, and no path
auto-deletes the index, consumer state or plugin source. The consumer entry is
host-only and lightweight: it imports the sharing contract and the official
Include helper, and never `lib/orchestrator.js` or `lib/diagnostics.js`; it runs
no Evolution kernel, tools, model call, timer, poller or background work.

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
  not offered at all when the file holds no complete line to keep). Orphan
  staging removal takes the same archive lock the port takes, through that
  module, and re-reads and re-validates the aggregate inside it, so a writer that
  staged a transaction after the plan was read cannot have its stage deleted. A
  staging directory is removed only while the aggregate passes every check the
  diagnostic reports, including the runtime global schema, so an aggregate that
  parses as JSON but does not validate — or one whose validator cannot be loaded
  — offers no repair and removes nothing. The lock handling is that protocol,
  not a second one: a live owner is `skipped`, and so is a lock path this
  protocol cannot interpret as its own lock file (a directory, a symlink or
  another object type), which is reported and left in place; an ownerless
  *regular file* that has not changed for the protocol's 1s settle window is
  reclaimed exactly as startup reclaims it, which is the same condition the
  report also offers `domain-stale-lock` for. `scripts/import-evolution-data.mjs`
  takes its migration lock before it stages anything and re-reads the completion
  state after taking it, so a competing importer either fails with no second copy
  of the import beside the destination or, when it won the race and the winner
  already finished, returns `already-imported` without staging; a later run never
  replaces or removes an existing migration lock, and a run releases only the
  entry it created — a lock replaced while it ran is left where its owner put it
  and reported. All of these are cooperative protocols, not a security sandbox:
  a process that replaces a lock path without honouring them is out of scope.
  They are also not concurrency safety: the bridge file's writers hold no lock, so
  an append that lands between the last re-read and the rename can still be
  dropped — run the repair while the host is stopped. All of them are proven no-ops on a second
  run (`test/diagnostics.test.mjs`). Committed-journal
  cleanup is asserted on its first run only: the test checks that it removes the
  promotion state directory while the composition row and the promoted module
  stay in place, and no second-run no-op is asserted for it.
- **Unknown states fail safe.** `rollback-failed`, unparsable or out-of-boundary
  journals (including unsupported record shapes such as `symlink`), unverifiable
  event MACs, event envelopes that name a writer other than the trusted one,
  conflicting event ids, missing pending
  archives, a domain aggregate that does not validate, and altered immutable
  migration evidence are reported `blocked`, and
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
