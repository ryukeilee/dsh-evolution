# Changelog

Versions here are development artifacts of the standalone `dsh-evolution`
bundle. They are not npm releases. The supported DSH versions are exact
alternatives in `peerDependencies`, and a version is only added there after it
passes the full install/boot/upgrade acceptance: read the entry for the version
you install before upgrading DSH.

## 0.2.0-rc.4 — final local performance candidate

- 收敛领域查询元数据投影、运行时检查投影、签名排序键复用、冷历史诊断、事件桥证据分块恢复五轮优化，保留全部历史基准、失败记录和差分回归。
- 统一源码、固定 tarball、校验和、manifest 与两个官方宿主的完整验收证据；未降低发布验证要求。
- 本候选仅在本地固定，未创建 tag 或进行外部发布。可复现结果与收益边界见 `docs/performance/final-candidate.md`。

## 0.2.0-rc.3 — performance candidate

- 官方领域查询保留完整历史读取、去重和计数，仅深拷贝最多 50 条返回记录；
  三轮同负载 CPU 减少 30–49%，数据和收益边界见 `docs/performance/domain-query.md`。

- 在每个 agent step / 工具结束的事件同步中，移除重复 JSON 解析，并仅为
  未提交事件构造 DTO；全部历史记录仍逐条验证 MAC、writer 和同 ID 冲突。
- 可复现多规模数据与适用范围见 `docs/performance/domain-replay.md`。
- Reuse archive directory lookups within one index load on the official domain
  observation path; retain fresh discovery on every subsequent load.
- Preserve archive reconciliation, checksums, MAC verification, fsync and
  pending/final transaction semantics; no official DSH source changes.
- On the reproducible 256-segment workload: median observation latency -42.61%,
  process CPU time -79.62%, directory enumeration calls -92.49%.
- 历史发布及发布后双宿主验收记录见 `docs/evidence/rc3-release-audit.json`；本轮不修改历史 tag 或公开资产。

## 0.2.0-rc.2 — release candidate

Supported hosts: DSH `0.2.0-rc.2` and `0.2.1-alpha.1` (exact alternatives),
Node `^22.19.0 || >=24.0.0`. Not published to npm.

本候选修复两条 CodeQL high：shell 守卫的多项式回溯，以及指标投影的弱随机兜底 ID。保持核心 Evolution 流程与显式指标身份，重新执行双宿主真实验收。发布链验证 sourceCommit 的实际包内容，确保 tag、源 commit、manifest 与产物内容一致。

### Added

- **A source-commit pin.** `npm run release:publish` now records `sourceCommit`
in `release/manifest.json`, and the release workflow requires it: a new release
cannot be published unless the pin names a commit in the tagged history. The
check is `scripts/release/verify-provenance.mjs`, covered by
`test/release-provenance.test.mjs`.
- **Code scanning.** `.github/workflows/codeql.yml` runs CodeQL for
`javascript-typescript` on `main`, on every pull request and weekly, and uploads
the SARIF results to GitHub code scanning.

### Changed

- **The release workflow can no longer overwrite a published asset.** It refuses
to touch a release that is already published or already has assets, uploads
without `--clobber`, and downloads the assets GitHub ends up serving to re-verify
them against the pin. `workflow_dispatch` gained a `dry_run` input that runs
every check and touches nothing.
- **The release workflow verifies tag, commit, manifest and checksums before
attaching anything.** It checks out full history (so the pinned source commit
can be walked) and fails when the tag does not match the version, the checked-out
commit, the pinned source commit or the pinned content.
- **GitHub Actions now run on Node 24.** `actions/checkout` and
`actions/setup-node` move to `v7`, `actions/upload-artifact` to `v7` and
`pnpm/action-setup` to `v6`, which removes the `Node.js 20 is deprecated`
runner warning the previous releases emitted.
- **`test/workflows.test.mjs`** now locks the release guarantees, the CodeQL job
and the action runtimes instead of only the job names.

### Notes

- `lib/guard.js` 使有序命令/写动词在互不重叠的候选区间内匹配，保留导出的 `RegExp` 接口并消除无界回溯，重定向去掉可重试的数字/空白前缀；保留 deny/allow 决策并增加带子进程硬期限的风险回归。
- 指标兜底身份使用 `crypto.randomUUID()`，同一投影的 `id` 与对应 `taskId` / `goalId` / `agentId` / `sessionId` 一致；调用方身份优先级不变。
- `sourceCommit` 必须来自已提交的包内容，且其 git 对象摘要等于 tag 树与 tarball，祖先关系不再是唯一来源校验。
- 原同名 rc.2 draft/tag 经维护者授权重建；旧记录保留，历史 rc.1 tag 和资产不变。
- The `v0.2.0-rc.1` tag points at a commit whose committed artifact differs from
the bytes that were published under that release. The hardened workflow now
fails on exactly that mismatch. It is recorded in `RELEASE.md` as a known risk of
the historical release; rewriting the tag or the release is out of scope.

## 0.2.0-rc.1 — release candidate

Supported hosts: DSH `0.2.0-rc.2` and `0.2.1-alpha.1` (exact alternatives),
Node `^22.19.0 || >=24.0.0`. Not published to npm.

This candidate contains **no runtime change**: the shipped `lib/` is exactly
`0.2.0-dev.6`, re-verified end to end on both hosts. It adds the release and
verification layer that turns that state into a reviewable artifact.

### Added

- **A release pin: `release/manifest.json` + the released tarball.** The bytes
  that get published are committed and verified rather than rebuilt. Packing is
  only byte-stable within one npm version (see *Fixed*), so one artifact is
  stored: `npm run release:publish` copies the build into `release/`, records
  its `sha256` and its environment-independent `contentSha256`, and
  `npm run release:verify [<tarball>]` checks either one. `--content-only`
  checks a locally rebuilt tarball, whose bytes may legitimately differ.
- **`npm run pack:check`** replaces the bare `npm pack --dry-run`: it fails on
  a pack that is not byte-stable in this environment, on an archive that is not
  exactly `package.json#files`, on a non-canonical file mode, on shipped text
  carrying a local home path or credential-shaped material, on
  `package-lock.json`/`package.json` drift, on a version that is not a
  pre-release, on a README that documents a superseded version, on a missing
  CHANGELOG entry, on missing install/doctor/upgrade/rollback/uninstall
  instructions — and on a `release/`, `docs/evidence/` or working tree that no
  longer describes the pinned artifact.
- **A content digest instead of a byte-only guarantee.** The archive is read
  with Node's `zlib` and a minimal ustar reader (no external `tar`), and
  `contentSha256` covers every entry's path, mode and content. This is what the
  acceptance evidence, the pin and the CI check across platforms.
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
  restart, and a canary rollback that removes only the new candidate. Its
  evidence records both the bytes it installed and the content digest, with
  local scratch paths redacted.
- **Committed acceptance evidence** for both supported hosts:
  `docs/evidence/dsh-0.2.0-rc.2.json` and
  `docs/evidence/dsh-0.2.1-alpha.1.json`.
- **GitHub CI** (`.github/workflows/ci.yml`): unit tests on Node `22.19.0` and
  `24.x`, a packaging job (byte stability, allow-list, canonical modes, the
  committed pin, a `--content-only` check of a locally rebuilt artifact, and a
  doctor start with no host packages present), and a per-host acceptance job
  that also asserts its evidence matches the pinned content.
  `test/workflows.test.mjs` parses both workflow files, pins the CI job set and
  the accepted host matrix to the declaration, and fails if the release
  workflow could publish anything other than a draft, rebuild the released
  bytes, or reach npm. `test/release-pin.test.mjs` checks the pin against the
  committed artifact and the working tree without running `npm pack`.
- **Tag-triggered release workflow** (`.github/workflows/release.yml`) that
  verifies the tag against the version, verifies the pinned artifact, and
  attaches exactly those bytes to a **draft** GitHub release. It deliberately
  does not rebuild: a rebuild on the runner would have different bytes from the
  artifact the acceptance ran against.
- **`RELEASE.md`** with the artifact list, the reproduction steps, what
  "reproducible" does and does not mean here, and the remaining release risks.

### Fixed

- **`npm test` did not run on Node 22 or 24.** `node --test test/` treats the
  argument as a module path on those versions and failed with
  `Cannot find module '.../test'`, so CI could never go green on the declared
  engine range. The suite now uses explicit globs
  (`node --test "test/**/*.test.mjs" "test/**/*.test.js"`), verified on Node
  `22.19.0` and `26.10.0`. As a side effect of the same fix,
  `test/full-cross-session.integration.mjs` — a real integration test that the
  old command silently never ran — is now discovered and passes (renamed to
  `*.integration.test.mjs`).
- **The tarball used to depend on the checkout's umask.** `npm pack` records the
  on-disk mode, so three files that happened to be `0600` in the development
  tree produced a different hash than the same commit in a fresh `git clone`
  (`0644`), while git tracked no such difference. Packaging now copies exactly
  the declared entries into a staging directory and normalises modes to
  `0644`/`0755`.
- **The "reproducible tarball" claim was wrong across npm versions.** The same
  tree packs to different bytes under npm 10 and npm 11 — the compression runs
  through the bundled zlib. Measured: `46f6e4a4…` with npm `10.9.3`, `040e0d9e…`
  with npm `11.19.1`, with byte-identical unpacked files and identical
  uncompressed tar size. The guarantee is now split honestly: byte identity
  within one environment, `contentSha256` everywhere, and one pinned artifact
  for what is actually published.
- **`lib/`-only runtime files no longer ship the release tooling.**
  `package.json#files` now names `scripts/doctor.mjs` and
  `scripts/import-evolution-data.mjs` instead of the whole `scripts/`
  directory, so the acceptance harness and release scripts stay out of the
  user-facing bundle (48 entries instead of 56).

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
