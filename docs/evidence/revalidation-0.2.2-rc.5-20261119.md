# Stable plugin revalidation on DSH 0.2.2-rc.5

Source: a clonefile copy of the formal `~/.dsh` data root. The formal home was
not written. The clone received the candidate `dsh-evolution` 0.2.12 build in
its `acp` and `web` profiles; the three published stable records were still
host-verified on `0.2.2-rc.3`.

Because the clone preserves absolute promoted `moduleUrl` values from the
formal home, the clone's publication index was rewritten to point at its own
`promoted/` files before adoption. That rewrite is a property of copying the
data root, not of the product: a real upgrade keeps the index inside its own
home and needs no rewrite.

Observed sequence:

1. In the ACP baseline boot all three records were
   `pending-revalidation` / `host-version-mismatch`. In the Web baseline boot
   only `evolution-promoted-af973a3eea01` was approved for that profile; the
   other two were `skipped-unapproved` / `profile-not-approved`, not
   pending.
2. In the throw-away clone the three ACP-approved records became `active`
   with their source digests unchanged. ACP executed `readonly_git_file` for
   `evolution-promoted-af973a3eea01` and `run_code_diagnose` for
   `evolution-promoted-e82a216992bb`; `evolution-promoted-2794ab16d2b3`
   had mount evidence but no planned tool call. On Web only
   `evolution-promoted-af973a3eea01` was approved and active, and it executed
   `readonly_git_file`.
3. `dsh-evolution-shared revalidate --evidence` adopted the evidence for all
   three records (`acp` + `web` for `evolution-promoted-af973a3eea01`,
   `acp` for the other two).
4. A post-adoption restart of both entries mounted them `active` without any
   eligibility rewrite: ACP had all three active and executed the same two
   planned tool calls, Web had `evolution-promoted-af973a3eea01` active and
   executed `readonly_git_file`. The evolution tree digest, shared-experience
   event/knowledge counts and every promoted source digest were unchanged.

Evidence: `revalidation-0.2.2-rc.5-20261119.json` and its adoption report
`revalidation-0.2.2-rc.5-20261119.report.json`.
