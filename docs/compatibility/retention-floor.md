# Retention floor compatibility: dsh-evolution 0.2.19 and 0.2.20

## Scope

This is a structural compatibility reference for two releases of the plugin, and nothing else:

- **0.2.19** — commit `50f1a9b` (`v0.2.19`), `package.json` version `0.2.19`.
- **0.2.20** — commit `1d97337` (`v0.2.20`), `package.json` version `0.2.20`.

The durable domain document schema number did **not** change: the global document is `schema: 1` and `RETENTION_SCHEMA = 1` in both commits. The boundary described here is narrower than a schema migration. It concerns the shape of the **retention floor** that an explicit capacity `reclaim()` writes into that document: 0.2.20 accepts two optional fields on `retention.log.prior` that the 0.2.19 validator rejects. This document does not make claims about any other version.

For reference, an *ordinary* floor has `prior = { bytes, digest }`. An *ambiguous* floor additionally has `ambiguousPrefix: true` and `identity: { dev, ino }` (both strings).

## Compatibility matrix

| Written by | Opened by | Floor shape in the data root | Result |
| --- | --- | --- | --- |
| 0.2.19 | 0.2.20 | ordinary | Loads and continues absorbing; a later 0.2.20 event-log reclaim requires a complete event log, and an unverifiable retained partial tail is refused by that event-log reclaim planning with `E_DOMAIN_EVENT_LOG_PARTIAL_TAIL`. |
| 0.2.20 | 0.2.19 | ordinary | Loads; 0.2.19 continues absorbing events and reclaiming. |
| 0.2.20 | 0.2.19 | ambiguous | **Refused during domain open** (see [The refusal](#the-refusal)). |
| 0.2.20 | 0.2.20 | ordinary or ambiguous | Loads. |
| 0.2.19 | 0.2.19 | ordinary | Loads (baseline). |

For the 0.2.19 → 0.2.20 ordinary-floor direction, 0.2.19's `planLogPrune()` has no partial-tail check, so it can commit an ordinary floor whose retained tail contains an unverifiable torn line. That floor passes 0.2.20's tail-digest check on open, but the next 0.2.20 event-log reclaim planning refuses it with `E_DOMAIN_EVENT_LOG_PARTIAL_TAIL`. The 0.2.20 → 0.2.19 ordinary direction remains event-log reclaimable: 0.2.20 does not commit such a tail.

**0.2.19 cannot produce an ambiguous floor.** Byte ambiguity itself is not new: a 0.2.19 data root can also have a retained tail equal to a prefix of the file, but 0.2.19 never writes the marker fields, so its floor is always an ordinary floor. In 0.2.20, `planLogPrune()` writes `ambiguousPrefix: true` and `identity` only when both conditions hold: (a) the retained tail is non-empty and its keyed digest equals the keyed digest of the leading bytes of the file the plan was computed from, for the same byte length; and (b) an identity object was supplied with defined `dev` and `ino`, which are stored as strings. Ordinary floors have exactly the same field shape in both versions.

## The refusal

Opening a 0.2.20 ambiguous floor with 0.2.19 fails with:

- a `DomainError` with `code: invalid-record`, raised during domain open by the official `@deepseek-ai/dsh-storage-domain` validator when it checks the stored global document against its schema;
- its `cause` is a `ZodError`;
- an entry in that `ZodError`'s `issues[]` has `code: unrecognized_keys`, with unknown keys `ambiguousPrefix` and `identity`, and path `[retention, log, prior]` (`retention.log.prior`) for a committed floor or `[pending, retention, log, prior]` (`pending.retention.log.prior`) for a pending floor.

Validation happens before any write to the stored domain document or the event-bridge log. The domain snapshot and the event-bridge log are **byte-for-byte unchanged**. There is no automatic migration or repair of the floor on this path.

## Operator guidance

1. Decide which version will run *after* a reclaim. If the data root must remain readable by 0.2.19, roll back to 0.2.19 **before** running a reclaim, so the floor it writes is an ordinary floor.
2. After a reclaim on 0.2.20 has produced an ambiguous floor, do not downgrade to 0.2.19. Stay on 0.2.20.
3. If such a data root has already been opened with 0.2.19 and the open was refused, either upgrade back to 0.2.20 (the stored domain document and event-bridge log were not modified), or restore a backup taken before the reclaim.
4. Never edit or delete the floor — or the stored document holding it — to force a downgrade.

## Sources of statements

**Measured acceptance facts** (installed-version behavior):

- The 0.2.19 open of a 0.2.20 ambiguous floor is refused with the error shape above; the domain snapshot and event-bridge log stay byte-for-byte unchanged.
- The official `@deepseek-ai/dsh-storage-domain` validator (a host dependency, not part of this repository) produces the observed `DomainError` with `code: invalid-record` by wrapping the zod failure when it checks the stored global document.
- Ordinary floors interoperate in both directions: 0.2.20 loads a 0.2.19 floor because the new fields are optional, and 0.2.19 loads a 0.2.20 ordinary floor and continues absorbing. For a floor written by 0.2.19, a later 0.2.20 event-log reclaim requires a complete event log; an unverifiable retained partial tail is refused by that event-log reclaim planning with `E_DOMAIN_EVENT_LOG_PARTIAL_TAIL`.

**Source-derived facts** (read directly from the two commits):

- Version numbers, commit ids, the unchanged document schema (`schema: 1`) and `RETENTION_SCHEMA = 1` in both commits.
- The floor schema at 0.2.19 is a `.strict()` `prior` object with only required `bytes` and `digest`; at 0.2.20, `ambiguousPrefix` and `identity` are optional and mutually required. See [`../../lib/domain-storage.js`](../../lib/domain-storage.js) (retention schema at lines 123–151 in 0.2.20; `prior` at line 130 in 0.2.19; global document schema at lines 142 and 154 respectively).
- `planLogPrune()` writes the two extra fields only for an ambiguous floor with a supplied file identity. See [`../../lib/event-log-checkpoint.js`](../../lib/event-log-checkpoint.js) (`RETENTION_SCHEMA` at line 371, `planLogPrune()` at lines 447 and 503–527).
