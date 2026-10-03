# Broadcast V2 (program §19, Phase E1)

Broadcast V2 **extends** the round N broadcast lane (`docs/round-n-broadcast-audit.md`,
`docs/round-n-close-audit.md`); it does not replace it. Most of §19 already held when this
phase began. This record maps each requirement to the code that holds it, and says what
this phase added.

## Requirement map

| §19 requirement                                | Holds by                                                                                                                                                                                                                                        | Added here                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| draft                                          | `DRAFT` state, versioned composer (`broadcast.service.ts`)                                                                                                                                                                                      | —                                                                             |
| preview                                        | the rendered preview, and the REAL test send to the operator's own chat (`POST /broadcasts/:id/test`)                                                                                                                                           | —                                                                             |
| audience estimate                              | counted preview: count, reachable, fingerprint, sample                                                                                                                                                                                          | the opted-out **estimate** for a MARKETING broadcast (below)                  |
| schedule                                       | `SCHEDULED` + `scheduledAt`, started by the dispatcher's `startDue`                                                                                                                                                                             | —                                                                             |
| send                                           | the dispatcher: claim, stamp, send, record                                                                                                                                                                                                      | —                                                                             |
| pause / cancel when safe                       | conditional transitions. Cancel moves only `PENDING` recipients, and the stamp refuses a recipient whose broadcast is no longer `SENDING`                                                                                                       | —                                                                             |
| completed / failed                             | `COMPLETED` state                                                                                                                                                                                                                               | `broadcastOutcome`: DELIVERED / PARTIAL / FAILED, **derived** from the counts |
| segmentation: tags                             | —                                                                                                                                                                                                                                               | `tags.anyOf` / `tags.noneOf` (program §8 tags, by id)                         |
| segmentation: user group                       | `segment`: ordinary customers and each reseller tier                                                                                                                                                                                            | —                                                                             |
| segmentation: reseller / customer              | `segment` (an ACTIVE reseller row; a SUSPENDED reseller counts as ordinary)                                                                                                                                                                     | —                                                                             |
| segmentation: has / no active service          | the `service` block could say "has", never "has none"                                                                                                                                                                                           | `activeService`: ANY / HAS / NONE                                             |
| marketing opt-out policy, never bypassed       | #143: the SEND's stamp decides, under the customer's row lock, against the `customer_marketing_opt_out` switch in force then                                                                                                                    | untouched. The estimate reads it and never narrows anything                   |
| transactional stays separate                   | the customer notification lane (ADR-0030) never reads the opt-out. `SERVICE_ANNOUNCEMENT` broadcasts are not marketing                                                                                                                          | —                                                                             |
| content types                                  | TEXT, PHOTO, VIDEO, DOCUMENT, FORWARD, COPY. URL buttons. The tenant's `bot.broadcast.message` template wraps the text                                                                                                                          | —                                                                             |
| background batches                             | per-bot claims of the bot's per-second budget                                                                                                                                                                                                   | —                                                                             |
| snapshot or dynamic semantics                  | **frozen**: recipients are materialised at launch from the same builder the preview counted, and bound by hash, count and fingerprint. Live re-checks: an operator block and the marketing opt-out                                              | —                                                                             |
| progress, success / failure counts             | `counts`, `progressPercent`                                                                                                                                                                                                                     | —                                                                             |
| retry failed safely                            | `retryFailed` re-queues `FAILED` (Telegram's refusals) only. `UNCONFIRMED` (may have arrived), `UNREACHABLE` and `SKIPPED` are never re-sent                                                                                                    | regression test                                                               |
| rate-limit handling                            | a 429 re-queues the recipient at the later of `retry_after` and a 5 s floor, spends no attempt, and holds the bot for every replica                                                                                                             | regression test                                                               |
| no duplicate sends from worker races           | the claim takes the pacing row lock first, then `FOR UPDATE SKIP LOCKED` with a lease. The stamp names that lease, requires `PENDING`, and commits before the request. The reaper resolves a stranded stamp `UNCONFIRMED` and never re-sends it | two-replica regression                                                        |
| report: creator, audience, start / end, counts | `createdBy` / `launchedBy`, `describeAudience`, the launched / started / completed / cancelled times, `counts`                                                                                                                                  | —                                                                             |
| report: failures by reason                     | the per-recipient error code                                                                                                                                                                                                                    | `GET /broadcasts/:id/failures`: grouped by state and transport code           |

## Decisions

**Tags as an audience dimension.**

- Tags are named by id, never by label, so a rename changes no audience.
- `anyOf` means the customer carries at least one of the tags. `noneOf` means they carry none. A tag may not appear in both lists.
- An archived tag still selects the customers who carry it, as it still filters the customer list.
- The predicate is an `EXISTS` over the tenant-led primary key of `customer_tag_assignments`.
- A tag id from another tenant selects nobody.
- Because this lives in the ONE audience builder, mass actions and campaigns gain the dimension too.

**Active service.**

- A service counts as active when its state is `ACTIVE` and its expiry is open or still after `asOf`.
- A service the expiry sweep has not reached yet does NOT count as active. This matches how the `expired` service criterion already reads it.
- `NONE` is the plain negation, so it includes a customer who never had a service.

**Canonical-form compatibility.**

- The two new keys are appended to the canonical definition only when they narrow anything.
- So every definition the previous release could write keeps its exact JSON and sha256. Drafts and frozen audiences saved before the upgrade still match the hash they were confirmed under.
- A golden test pins this.
- A previous release refuses a definition that uses the new keys, because its schema is strict. A rollback therefore cannot silently ignore a tag filter.

**The opted-out estimate.**

- For a MARKETING broadcast, while the installation honours the opt-out, the preview says how many selected customers are opted out right now.
- It is an estimate. It is not subtracted from the count and it binds nothing.
- Since #143 the send alone decides, so a customer may opt in or out before the send, or the switch may change.
- The estimate is null for a service announcement, when the policy is off, and for a frozen audience.

**Outcome, not a FAILED state.**

- A stored `FAILED` state would have to be left again by "retry failed", which re-opens a `COMPLETED` broadcast. It would also be a second record of facts the recipient rows already hold.
- `broadcastOutcome` therefore derives the outcome from `COMPLETED` plus the counts:
  - `SKIPPED` and `CANCELLED` are decisions, not delivery failures, and count toward neither side;
  - `UNCONFIRMED` counts as not delivered, because the report never claims a delivery it cannot see.

**Failures by reason.**

- One row per recipient state and transport code, over FAILED, UNREACHABLE, UNCONFIRMED and SKIPPED.
- The rows are counted from the recipient rows, so each state's rows sum to that state's count.
- Codes are the transport's own (`telegram.rejected.403`). Telegram's free text never appears, because it can quote a chat id.
- Charged `broadcasts.view`.

## Tests

- `tests/integration/broadcast-v2.test.ts`:
  - each new dimension alone and combined with the reseller/customer segment;
  - tenant isolation of tag ids;
  - the builder's tag options;
  - the opt-out policy ON, OFF, and switched between launch and send on a tag audience;
  - two dispatcher replicas never delivering twice. Claims sum to the audience; the test was killed by dropping the claim's lease filter;
  - retry-failed re-sending refusals only, never an UNKNOWN outcome;
  - a 429 held, and never reported as a failure;
  - failure reasons summing to the counts;
  - the report's permission and tenant boundary.
  - Mutations that fail it: dropping the `NOT` of `noneOf`, and dropping the expiry check of `activeService`.
- `tests/unit/audience-definition.test.ts`: the golden canonical JSON and hash, the appended keys, the refusals, and `broadcastOutcome`.
- `tests/web/broadcast-v2.test.tsx`: the builder's tag and active-service controls, the estimate, the outcome badge and the failures table.

## Manual acceptance

- A MARKETING broadcast to a tag audience on a real bot, at realistic volume, to watch the 429 back-off.
- The builder at 390 px with a tenant holding many tags.
