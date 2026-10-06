# Changelog

Versions here are development artifacts of the standalone `dsh-evolution`
bundle. They are not npm releases, and the supported DSH version is an exact
`peerDependencies` contract: read the entry for the version you install before
upgrading DSH.

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
