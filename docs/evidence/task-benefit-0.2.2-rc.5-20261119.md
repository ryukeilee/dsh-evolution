# Real task-benefit loop on DSH 0.2.2-rc.5

This is the positive task-coupled path on the new host, produced with real model
inference (`opencode-go/deepseek-v4.1-flash`) through `model-bridge.mjs`; the
Desktop app, ACP transport, Evolution kernel, gates and persistence are real.
It used an isolated `$DSH_HOME` and never touched the formal home.

- Baseline and candidate each ran three real sessions; the candidate exercised
  the promoted context-policy and both sides were correct.
- The task came from the production `evolution_plan` over real baseline read
  degradations.
- `taskBenefit` was satisfied; the bounded owner confirmation promoted the
  candidate, the functional canary passed, and a fresh real ACP consumer used
  the promoted policy on the built-in `read` tool with every sentinel present.
- Four negative artifacts (missing, mismatched, no-benefit, unadopted) were all
  refused before approval, with no publication.
- After a Desktop restart the terminal and publication survived and the planner
  reported `already-resolved`.

The deterministic `acp-desktop-control` run for the same host stops earlier, at
the `TASK_BENEFIT_REQUIRED` gate, because its fixture transport deliberately
does not produce a paired real-session artifact; this file is the positive
counterpart. Evidence: `task-benefit-0.2.2-rc.5-20261119.json`.
