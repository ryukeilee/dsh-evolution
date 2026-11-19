# ACP → Desktop control on DSH 0.2.2-rc.5 (deterministic gate-stop)

This run used the real official Desktop application (Electron 44.7.0 / Node 24.21.0,
DSH `0.2.2-rc.5`), the real ACP transport and the candidate `dsh-evolution` 0.2.12
build. It initialized an isolated `$DSH_HOME`, installed the tarball through the
official installer, launched Desktop once, proved the single-instance host, ran
real ACP model/tool requests through `evolution_desktop`, and executed the
`no-benefit`, `regression` and `insufficient` workload cases.

The runner then stops at `ok: false` / `TASK_BENEFIT_REQUIRED`. That is the
designed boundary of this deterministic runner: its workflow plan claims a
benefit but the fixture transport cannot produce the paired real-session
artifact, so the `taskBenefit` gate refuses promotion. The run proves the gate
and the cleanup (each rejected workload reports `revert.ok: true` and nothing is
published), not a channel failure.

The positive ACP → Desktop path with real model inference, an adopted
`taskBenefit` artifact, owner confirmation, functional canary, fresh ACP
consumer and restart is recorded in
`docs/evidence/task-benefit-0.2.2-rc.5-20261119.json`.
