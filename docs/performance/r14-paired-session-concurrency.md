# R14: paired-session concurrency and pilot-isolation preflight

- Task: DSH-EVOLUTION-PERF-R14-01, 2026-11-26
- Repo: `dsh-evolution` 0.2.22 @ `227d873`; work branch `t3/task-benefit-e2e-performance`
- Scope: `scripts/acceptance/` only. `scripts/acceptance/**` is **not** in
  `package.json#files`, so this is an operator / CI feedback-time improvement.
  Installed users see no behaviour change; `lib/`, schemas, gates and
  authorization semantics are untouched.
- Model: `opencode-go/deepseek-v4.1-flash` (thread `modelSelection` variant
  `high`, runtime `full-access`), same for both sides of every run.
- Host: Desktop CLI at `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`
  on a fresh isolated `DSH_HOME` per producer run (never the formal home).

## 1. Change

`produceTaskBenefit()` used to run the six paired sessions strictly serially and
attributed model turns with `bridge.turns.length` before/after slicing on one
shared bridge. The producer is now:

- one model bridge **and** one overlay per session attempt, with every bridge
  record tagged `sessionId`; `selectSessionTurns()` filters by tag
  (`produceTaskBenefit({ pilotRunner })` is the deterministic self-check seam);
- repetitions of one side run concurrently, the candidate and baseline sides
  never overlap, and each repetition keeps its `repetition % 2` side order by
  grouping repetitions by parity;
- default two lanes; `--serial` keeps the historical order exactly;
- a pilot-isolation preflight runs before any paired session. One minimal turn
  asks the pilot for its own shell/read tools; a capability tool that actually
  executed refuses the run with `E_ACP_PILOT_ISOLATION_BYPASS` and writes no
  artifact. A permission-denied attempt (`state.status: "error"`,
  `"Permission denied"`) is not an execution.

Two transport facts were measured while building the preflight and are now
pinned by tests:

1. An `opencode` run outside a repository did not reliably read the project
   `opencode.json`: a file-read prompt received `read`/`shell`/`glob` in 10 of
   10 turns. The deny ruleset is now also passed through
   `OPENCODE_CONFIG_CONTENT` for the pilot process, and every turn runs on a
   private `opencode --standalone` server.
2. opencode still emits a `tool_use` event for a denied `skill` call. Counting
   attempts as bypasses failed sessions that never observed the fixture; only
   executed calls are counted now.

## 2. A/B method

- Fixture: the acceptance loop's `read-three-long-lines` task (three files, one
  long JSON line each, three random sentinels, reads mapped per file), candidate
  body `scripts/acceptance/fixtures/complete-read-line.host`, `runs = 3`.
- Each producer run has its own isolated home and fresh run directory; the
  artifact is validated with the production `validateTaskBenefit(artifact,
  { improvement: "context-policy" })`.
- Serial side: `serial: true` (historical order). Concurrent side: default two
  lanes. Both sides used the same model and fixture; each mode's three runs were
  consecutive, and both batches were taken on the same machine and provider in
  the same session.
- Wall clock includes the preflight and every session, measured around
  `produceTaskBenefit()`.

### Producer wall clock (ms)

| Serial run | Wall | Concurrent run | Wall |
| ---: | ---: | ---: | ---: |
| 1 | 207,982 | 1 | 270,657 |
| 2 | 183,187 | 2 | 131,044 |
| 3 | 238,786 | 3 | 86,997 |
| **median** | **207,982** | **median** | **131,044** |

Ratio of medians: **0.630** (acceptance target ≤ 0.75). The 270,657 ms
concurrent run contains one provider stall (a baseline session took 179 s while
the other five finished normally); the median is used for the comparison.

A second concurrent batch on the same scheduler measured 134,149 / 140,464 /
113,613 ms (median 134,149, ratio 0.645), corroborating the result.

### Per-session wall clock (median of 9 sessions per side, ms)

| Side | Serial | Concurrent | Change |
| --- | ---: | ---: | ---: |
| candidate | 21,697 | 21,132 | −2.6% |
| baseline | 39,689 | 36,244 | −8.7% |

Neither side reaches the +20% contention threshold (the rule that would make
the change "no benefit"). A three-lane variant was measured earlier and
**rejected**: it finished in 83–117 s, but the candidate side's median session
wall clock rose 25% (21,697 → 27,184 ms). The default is therefore two lanes,
which is also the brief's stated default. Per-session values, by run:

```
serial  candidate 27773 22541 26388 | 21408 21486 20477 | 21697 30781 21428
serial  baseline  50853 39689 35707 | 35785 43369 35386 | 62854 39433 56779
conc.   candidate 18591 25482 23916 | 20791 21319 20408 | 21132 21392 20479
conc.   baseline  29270 37322 179130 | 36244 47155 37124 | 32756 33121 6720
```

### Preflight cost

Successful preflights took **4,168–6,684 ms** (six concurrent runs; serial
4,920–5,702 ms), i.e. roughly a quarter of the shortest session. The injected
fake-bridge refusal test measures ~3 ms and is bounded by one turn and
`E_ACP_PILOT_ISOLATION_BYPASS`; it never reaches a session or writes an
artifact.

## 3. Gate / decision stability

`validateTaskBenefit(..., { improvement: "context-policy" })` on the artifacts:

| Mode | Clean runs | `ok` / `benefit` / verdict |
| --- | --- | --- |
| serial | 2 of 3 | `true` / `true` / `[]` |
| concurrent (default) | 2 of 3 | `true` / `true` / `[]` |

One run per mode contained a session where the model answered without reading
all three files (1-turn baseline or candidate). Those artifacts fail identically
in both modes with `every session on both sides must answer the task
correctly` (and, once turns collapse, the no-improvement verdict). This is model
behaviour that occurs in serial too; **no gate or decision flip is attributable
to concurrency**, and `durationMs` stayed inside the gate's
`max(baseline × 1.25, baseline + 60 s)` budget on every clean run.

## 4. Product equivalence

Real-model runs cannot be byte-identical across repetitions (turn count and
token bill vary). The harness-level equivalence was therefore proven with a
deterministic pilot runner over the **real** isolated host, real ACP and real
host tools (only the model decision is scripted):

- serial 9,076 ms vs concurrent 7,671 ms;
- every row of all six sessions equal in both modes for every field except
  `durationMs` (`rowsEqual.baseline = true`, `rowsEqual.candidate = true`);
- `validateTaskBenefit` identical: `ok: true`, same issues `[]`, same
  `benefit` value.

The unit test `test/task-benefit-concurrency-preflight.test.mjs` pins the
interleaved-turn attribution (a shared-list length slice would give session 1
session 2's turns) and the preflight refusal paths, including the denied
`skill` attempt.

## 5. Reproduction

```sh
# unit coverage
NODE_OPTIONS=--max-old-space-size=4096 node --test \
  test/task-benefit-concurrency-preflight.test.mjs test/model-bridge.test.mjs \
  test/task-benefit-producer.test.mjs test/task-benefit.test.mjs

# serial side / default side (isolated home + the loop fixture)
node scripts/acceptance/task-benefit.mjs --home <isolated-home> \
  --task <task.json> --candidate-host scripts/acceptance/fixtures/complete-read-line.host \
  --runs 3 --serial
node scripts/acceptance/task-benefit.mjs --home <isolated-home> \
  --task <task.json> --candidate-host scripts/acceptance/fixtures/complete-read-line.host \
  --runs 3            # default two lanes; --concurrency 1..5 to widen
```

The full loop exposes the same switch: `run-task-benefit-loop.mjs ... --serial`
or `--concurrency N`.

## 6. Boundaries

- Not distributed: this changes the acceptance producer, not the plugin. Do not
  describe it as a user-facing speedup.
- Real-model session correctness is variable (the pilot occasionally stops
  early). The producer reports it as `correct=false` and the artifact is
  rejected; it is not retried and not turned into a pass.
- `OPENCODE_CONFIG_CONTENT` is an opencode-internal variable. The documented
  project `opencode.json` remains the primary layer; the env layer exists
  because that file was observed to be ignored outside a repository. If a future
  opencode drops the variable, the preflight fails closed instead of silently
  re-enabling the pilot's tools.
- `--standalone` costs one private server per model turn. It is part of the
  measured transport on both sides; sharing the background service was observed
  to let a turn bypass the agent-level deny ruleset.
