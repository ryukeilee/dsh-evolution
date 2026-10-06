# Changelog

Versions here are development artifacts of the standalone `dsh-evolution`
bundle. They are not npm releases. The supported DSH versions are exact
alternatives in `peerDependencies`, and a version is only added there after it
passes the full install/boot/upgrade acceptance: read the entry for the version
you install before upgrading DSH.

## 0.2.0-rc.1 — release candidate

Supported hosts: DSH `0.2.0-rc.2` and `0.2.1-alpha.1` (exact alternatives),
Node `^22.19.0 || >=24.0.0`. Not published to npm.

This candidate contains **no runtime change**: the shipped `lib/` is exactly
`0.2.0-dev.6`, re-verified end to end on both hosts. It adds the release and
verification layer that turns that state into a reviewable artifact.

### Added

- **Reproducible, verified packaging.** `npm run release:pack` builds
  `dist/dsh-evolution-<version>.tgz` and `SHA256SUMS` (a committed copy at the
  repository root plus one next to the artifact), after proving the tree packs
  byte-identically twice, that the archive contains only the entries declared
  by `package.json#files`, and that the shipped text carries no local home path
  or credential-shaped material.
- **`npm run pack:check`** replaces the bare `npm pack --dry-run`: it also
  fails on `package-lock.json`/`package.json` drift, on a version that is not a
  pre-release, on a README that still documents a superseded version, on a
  missing CHANGELOG entry, on missing install/doctor/upgrade/rollback/
  uninstall instructions, and on a committed `SHA256SUMS` or `docs/evidence/`
  file that does not describe the tarball this tree actually produces.
- **A committed host-acceptance harness**
  (`scripts/acceptance/run-host-acceptance.mjs`). It installs the requested
  official DSH release into a throwaway runtime, installs the packed tarball
  through the official plugin CLI into a fresh `$DSH_HOME`, and drives the real
  host through the CLI doctor, the core
  `inspect→propose→trial→measure→revert` flow (requiring proven runtime
  recovery), the official pluginManager disable/enable semantics, CLI
  uninstall/reinstall with data retention, the README upgrade and rollback
  flows (a re-versioned build of the same tree, then the current tarball), real
  promotion with a second confirmation gate, startup-canary commit across a
  restart, and a canary rollback that removes only the new candidate. It writes
  portable evidence with local scratch paths redacted.
- **Committed acceptance evidence** for both supported hosts:
  `docs/evidence/dsh-0.2.0-rc.2.json` and
  `docs/evidence/dsh-0.2.1-alpha.1.json`.
- **GitHub CI** (`.github/workflows/ci.yml`): unit tests on Node `22.19.0` and
  `24.x`, a packaging job (reproducibility, allow-list, canonical modes,
  checksum, and a doctor start with no host packages present), and a per-host
  acceptance job. `test/workflows.test.mjs` parses both workflow files, pins
  the CI job set and the accepted host matrix to the declaration, and fails if
  the release workflow could publish anything other than a draft or reach npm.
- **Tag-triggered release workflow** (`.github/workflows/release.yml`) that
  attaches the verified artifacts to a **draft** GitHub release; nothing is
  published automatically.
- **`RELEASE.md`** with the artifact list, the reproduction steps, and the
  remaining release risks, including the ones this candidate does not remove.

### Fixed

- **The tarball used to depend on the checkout's umask.** `npm pack` records the
  on-disk mode, so three files that happened to be `0600` in the development
  tree produced a different hash than the same commit in a fresh `git clone`
  (`0644`), while git tracked no such difference. Packaging now copies exactly
  the declared entries into a staging directory and normalises modes to
  `0644`/`0755`, so the artifact is a function of the tracked content and the
  tracked executable bit only. `npm run pack:check` asserts both that two packs
  in the same tree are byte-identical and that every shipped entry has a
  canonical mode.

### Notes

- The doctor still reports `degraded` immediately after a fresh install
  (`data.root` is created on first run); the post-boot diagnosis is `healthy`.
- Nothing was added to `peerDependencies`: `0.2.1-alpha.1` remains supported
  only because the full acceptance passes on it.

## 0.2.0-dev.6 — superseded by 0.2.0-rc.1

Supported hosts: DSH `0.2.0-rc.2` and `0.2.1-alpha.1` (exact alternatives),
Node `^22.19.0 || >=24.0.0`.

### Changed

- **The service inventory no longer depends on a private Cordis method.**
  `ctx.reflect._getImpl()` is replaced by the documented `ctx.reflect.store`
  ("service implementations, keyed by isolation label", with the exported `Impl`
  type) plus the documented `Context.isolate` key. The private method is kept
  only as a fallback for a host where `reflect.store` is unreachable, and the
  doctor records which path answered (`public: ctx.reflect.store +
  Context.isolate` on both verified hosts). Verified equivalent to
  `_getImpl(name, false)` for bound, unbound, isolated and disposed providers.
- **The promotion gate no longer trusts a numeric `FiberState`.** `FiberState`
  is a `const enum`, so it is erased from the published cordis runtime and
  `state !== 2` was an unverifiable literal. `fiberIsActive()` decides ACTIVE
  from the documented `uid`, `store` and `inertia` fields, asserted equal to
  `state === FiberState.ACTIVE` across every lifecycle transition
  (PENDING/LOADING/ACTIVE/FAILED/DISPOSED/UNLOADING) against the real package.
- **The mounted promoted row is resolved through the loader's public API.**
  `EntryTree.store[rowId]` is replaced by `EntryTree.resolve(rowId)`; the
  verify path awaits the row's fiber (`Fiber.await()`) so an in-flight
  transition is settled before the activity decision, and a failed activation is
  reported as inactive with its own cause.
- **`lib/cordis-compat.js` is the single source of truth for host-surface
  dependencies.** The runtime readers and the doctor consume the same classified
  table (public / undocumented / private, owning package, what is read, the
  public replacement, or the recorded reason why none exists).
- **`host.version` now reports whether the found host is one of the versions
  verified by a real acceptance run** (`verified`, `verifiedHosts`), derived from
  the declared alternatives so the answer cannot drift from the declaration.

### Added

- DSH `0.2.1-alpha.1` is a verified supported host. It was accepted only after
  the full acceptance run passed on it, against a fresh `$DSH_HOME`: install,
  boot, all 9 tool registrations, in-session and CLI doctor, core
  `inspect→propose→trial→measure→revert`, execution-bridge fault injection with
  an idempotent repair, restart recovery, promotion to `canary-observing`, stable
  commit, canary rollback, interrupted-promotion recovery, fail-safe on a
  `rollback-failed` journal, unsupported-host blocking, disable/enable,
  uninstall/reinstall with data retention, and a final doctor.
- `test/cordis-compat.test.mjs`: contract tests against the real installed
  cordis / loader / official Include packages — `serviceImpl` equivalence with
  `_getImpl`, the isolate-symbol identity assertion, `fiberIsActive`
  equivalence across all six lifecycle states, the recorded surface
  classification, a real promoted-Include mount with verify/health, and a torn
  composition failing closed.
- A regression test proving the doctor CLI starts with **no host package
  resolvable** (the bundle is copied without any `node_modules`), so a
  reintroduced host import in the doctor's import graph fails in CI instead of
  only in a real install.
- A regression test asserting no `lib/` file decides a fiber state from a
  numeric literal, and one asserting the declared support matrix equals the
  verified host list.

### Fixed

- **The service-inventory change must not put a host import into the doctor's
  import graph.** A first attempt imported `@deepseek-ai/cordis` inside
  `lib/cordis-compat.js`, which broke the doctor CLI in a real install
  (`ERR_MODULE_NOT_FOUND`) while the plugin itself still booted — the same
  constraint that makes `js-yaml` a bundle dependency. The module now imports
  nothing from the host: it takes the authoritative `Context.isolate` from the
  bundle entry at boot, falls back to the registered
  `Symbol.for('cordis.isolate')` key cordis itself builds, and the regression is
  pinned by a test that starts the doctor with no `node_modules` present.
- **`ctx.registry.values()`, `ctx.reflect.props`, `Fiber.getEffects()` and the
  `Fiber` lifecycle fields were misreported as non-public.** They are documented
  members of the exported cordis classes, so they are now classified as public
  and no longer counted as upgrade risk; only `ctx.events._hooks` and the
  `_getImpl` fallback remain private.

### Notes

- `scripts/import-evolution-data.mjs` is unchanged: staged, SHA256-verified,
  atomic, idempotent imports that refuse to merge differing source content.
- Known non-blocking limits are reported by every diagnostics run
  (`degradedCapabilities`): advisory domain evaluator, `continuous/` and
  `governance/` not wired into the live loop, host-only promotion through a
  cooperative (non-sandbox) gate, disabled legacy adapters, and the recorded
  private/undocumented surfaces listed in `COMPATIBILITY.md`.

## 0.2.0-dev.5 — unreleased

Supported host: DSH `0.2.0-rc.2` (exact), Node `^22.19.0 || >=24.0.0`.

### Added

- **Model-free diagnostics.** `lib/diagnostics.js` plus a
  `dsh-evolution-doctor` command (`scripts/doctor.mjs`, also runnable as
  `node <profile>/node_modules/dsh-evolution/scripts/doctor.mjs`). It reports
  `ok` / `degraded` / `blocked` / `not-evaluated` with per-check evidence over
  the installed package, the resolved DSH host and its module versions, the
  composed profile (official `dsh --dump-config`), live Cordis services, tool
  registration, internal-API probes, the Evolution data root, memory, cold
  archives, the signed execution event bridge, the domain aggregate and its
  archive lock, the legacy-import manifest, and promotion
  journal/composition/pointer. Exit codes: `0` healthy, `1` degraded,
  `2` blocked.
- **In-session diagnostics.** The `evolution_doctor` tool and
  `ctx.evolution.diagnose()` return the same report while checking the live
  registry (9 tools) and the mounted promotion Include adapter.
- **Safe, idempotent repairs** (`--repair`): interrupted promotion-journal
  rollback (backup + CAS), committed-journal cleanup, event-bridge
  partial-tail trimming, orphan domain staging removal, migration staging
  cleanup, and stale archive-lock removal. Every repair re-verifies and is a
  no-op on a second run. `rollback-failed`, unparsable or out-of-boundary
  journals, unverifiable event MACs, conflicting event ids, missing pending
  archives and altered immutable migration evidence stay `blocked` with
  `recoverable=false` and are never modified.
- `CHANGELOG.md` and a `bin` entry so the doctor is discoverable by name.

### Fixed

- **Startup was permanently blocked by an interrupted archive-lock write.** An
  empty or unparsable `domain-archive.lock` used to throw
  `E_DOMAIN_ARCHIVE_LOCK` forever. The runtime now reclaims a lock whose owner
  is dead, and waits for an unparsable lock to settle before reclaiming it, so
  an in-flight writer is never displaced. A lock held by a live process is
  still never stolen.
- **The doctor CLI silently did nothing when its path contained a symlink**
  (for example macOS `/tmp` → `/private/tmp`). The entry-point check now
  compares real paths.
- **`js-yaml` was only a peer dependency**, so running the doctor from a
  plugin-only profile failed with `ERR_MODULE_NOT_FOUND`. It is now also a
  bundle dependency, and a missing parser degrades to an explicit
  `not-evaluated` YAML check instead of crashing.
- **In-session host detection could pick an unrelated global `dsh`** from
  `PATH`. The running process entry now wins, and conflicting host versions are
  recorded as evidence.
- **Migrated legacy durable pointers were misreported as stale.** A pointer
  that the migration manifest explicitly keeps inactive
  (`No legacy promoted code execution`) is now reported as intentionally
  unmounted.

### Notes

- `scripts/import-evolution-data.mjs` is unchanged: staged, SHA256-verified,
  atomic, idempotent imports that refuse to merge differing source content.
- Known non-blocking limits are reported by every diagnostics run
  (`degradedCapabilities`): advisory domain evaluator, `continuous/` and
  `governance/` not wired into the live loop, host-only promotion through a
  cooperative (non-sandbox) gate, disabled legacy adapters, and the internal
  Cordis surfaces listed in `COMPATIBILITY.md`.
