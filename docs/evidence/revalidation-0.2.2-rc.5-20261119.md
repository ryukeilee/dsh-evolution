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

1. Both consumer entries on `0.2.2-rc.5` classified all three records as
   `pending-revalidation` / `host-version-mismatch` in the ACP baseline boot
   (Web additionally skipped the two records that were never approved for Web).
2. In the throw-away clone, the same records became `active` with their source
   digests unchanged; the real promoted tools were called through the official
   registry / batch executor.
3. `dsh-evolution-shared revalidate --evidence` adopted the evidence for all
   three records (acp/web for the first, acp for the other two).
4. A post-adoption restart of both entries mounted the records as `active`
   without any eligibility rewrite. The evolution tree digest, shared-experience
   event/knowledge counts and every promoted source digest were unchanged.

Evidence: `revalidation-0.2.2-rc.5-20261119.json` and its adoption report
`revalidation-0.2.2-rc.5-20261119.report.json`.
