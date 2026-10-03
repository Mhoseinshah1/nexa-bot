# Migration P1 — H5 usage sync and queue protection (Item 4) and Blocker C2 (Item 10)

Status: implemented on `wp3/i4-p1-usage-sync`, re-derived from `main` at `ed039740`.
PR #165 was read as evidence only; nothing was merged or cherry-picked from it (§5).

## 1. The three defects

| #   | Defect on `main`                                                                                                                                                                                                                                                                                  | Where                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | `listUsageSyncDue` required `provider_user_id IS NOT NULL`. RickPanel and Marzban return `providerUserId: null` by contract (and a reconciled 3X-UI service has none), so **no username-keyed service was ever synced in the background** — the whole fleet a legacy migration brings.            | `drizzle-service.repository.ts`   |
| 2   | `claimDue` was oldest-first across every type (`next_attempt_at`, then `created_at`), and `plan` stamps `next_attempt_at = now`. **A scheduled `SYNC_USAGE` planned an hour ago outranked a `PROVISION` paid a second ago**; a backlog of reads put each new order one tick per ten reads behind. | `drizzle-operation.repository.ts` |
| 3   | The provisioner took from the tenant probe bucket at reserve 0 for every type, so **the scheduled sweep could spend the bucket to zero** and the next paid create met `BUDGET_EXHAUSTED`.                                                                                                         | `provisioner.service.ts`          |

Found while fixing them, and fixed with them because each defeats the protection at scale:

- A customer's «refresh» (and an operator's sync) that met an open scheduled read was handed that row
  (`findOpen` → return), so it waited at the back of the backlog at the sweep's floor.
- `planUsageSyncs` planned up to 50 rows every tick and the listing excluded nothing already queued. At
  ~27k services the stalest page outlives its window, the next window derives new ids for the same
  services, and the queue gains duplicate reads.
- A read that failed terminally left the figure stale, so the same services held the top of the
  stalest-first page for the whole window; their window-derived ids conflicted, nothing was planned, and
  the rest of the tenant waited.

## 2. The design (one queue, one bucket)

**Eligibility.** The `provider_user_id` predicate is removed. Every adapter's `readUsage` is addressed by
`providerRefFor` — the stored username, subscription reference and client id, all `NOT NULL` — never by
that column. `ACTIVE` is what says an account exists. No provider id is invented or written. The listing
also skips a service with a `SYNC_USAGE` that is open, or was created within the cadence whatever became of
it (one cadence of back-off for a broken account).

**An explicit lane.** `provisioning_operations.background boolean NOT NULL DEFAULT false` (migration
`0189_usage_sync_background_lane`). Only `planUsageSyncs` writes `true`. The database refuses it on
anything but a `SYNC_USAGE` with no requesting customer (`provisioning_operations_background_check`) and
allows one open scheduled read per service (`provisioning_operations_open_background_sync_key`). The
default is the safe direction: a writer that forgets the column plans at full priority.

**Claim order.** `claimDue` orders by `background ASC` first, then the existing due-time and age. Strict
class priority, decided in the claim statement, so every replica sees one order. The due index now leads
`(tenant_id, background, next_attempt_at NULLS FIRST, created_at) WHERE state = 'PLANNED'`, so a backlog
of thousands is never sorted to find one paid create. Within each class nothing changes, so a retry that
has come due keeps its place among its peers and never jumps a class.

**Budget floor.** A background read calls `takeProbeBudget` with
`reserve = usageSyncBudgetReserveFor(capacity, monitorFloor) = max(ceil(50% × capacity), monitorFloor)`;
everything else (paid creates, commercial writes, reconciles, a customer's or operator's own read) keeps
reserve 0. Same bucket, same atomic conditional write; no second limiter. Resulting order for the last
tokens of a tenant: **paid / interactive (0) → panel monitor (40) → scheduled sweep (50)** at the default
100-token bucket. A refusal is a hold-off (`BUDGET_EXHAUSTED`, attempt refunded), never a failure.

**Promotion.** A customer's or operator's sync that finds a PLANNED scheduled row for the same service
promotes it (`background = false`, `requested_by_customer_id` = the customer or null) — one read, at the
asker's priority, with the card and audit row a new request leaves — instead of waiting behind the backlog
or planning a second read beside it.

**Bounded queue.** The sweep tops the UNTRIED scheduled queue (`PLANNED`, `attempts = 0`) up to
`USAGE_SYNC_PLAN_LIMIT` (50) per tenant. Untried, not open: a read backing off after a failure does not
hold a place, and a read the budget held off is still untried (`holdOff` refunds its attempt), so under
budget pressure the queue stays exactly at the bound.

Unchanged: a read failure is `FAILED` (retryable kinds re-planned with back-off), never `UNKNOWN`; a lost
create is `UNKNOWN` and is resolved by a `RECONCILE` (non-background) read, never retried as a create; no
provider write was added anywhere — a usage read is a GET.

## 3. Load reasoning (~10 ops per 5 s tick, ~27k services)

The constants that bind, all from `main`:

| Quantity                        | Value                                               | Source                                                              |
| ------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| Provisioner tick                | 5 s                                                 | `PROVISIONER_TICK_MS`                                               |
| Operations per tick per replica | 10                                                  | `DRAIN_LIMIT` (a refusal ends the tick)                             |
| Tenant bucket                   | 100 tokens, refill 100 / 300 s = **0.333 tokens/s** | `PANEL_PROBE_TENANT_LIMIT`, `_WINDOW_MS`                            |
| Monitor floor / sweep floor     | 40 / **50** tokens                                  | `PANEL_MONITOR_BUDGET_RESERVE_PERCENT`, `usageSyncBudgetReserveFor` |
| Cadence                         | 240 min                                             | `provisioning.usage_sync_minutes`                                   |

- **The budget, not the drain limit, binds at the default.** One replica can claim 2 ops/s, but the bucket
  refills 0.333/s. After a one-off burst of 50 reads (the tokens above the floor), the sweep reads at most
  0.333/s — 1.67 per tick — and less whenever the monitor or paid work spends.
- **A 27k fleet cannot be kept at a 4 h cadence on the default bucket**: that needs 27 000 / 14 400 s =
  1.875 reads/s, 5.6× the whole bucket. One full pass at the refill rate is 27 000 / 0.333 ≈ **81 000 s ≈
  22.5 h**. This is the _protection working_ — the sweep only ever gets what nobody else wants — but an
  operator migrating such a fleet should raise the bucket and/or the cadence. For example
  `PANEL_PROBE_TENANT_LIMIT=1000` (per 300 s → 3.33/s) puts the single-replica drain limit (2 ops/s)
  in charge: one pass ≈ 27 000 / 2 ≈ 3.75 h, with paid work still claimed first in every tick and still
  holding 500 tokens of headroom. `provisioning.usage_sync_minutes=720` lowers the need to 0.625/s.
- **Paid work can never be starved by the sweep**: it is claimed before any background row in every tick,
  and the sweep cannot take the bucket below 50 % of capacity, so a burst of up to 50 paid creates (at the
  default) finds tokens immediately.
- **The sweep cannot be starved by paid work** beyond real demand: a background row waits only while an
  interactive row is DUE, and every interactive row is finished, backed off (not due) or retired at
  `OPERATION_MAX_ATTEMPTS`. With a steady paid stream the sweep gets `10 − paid` slots per tick.
- **Cross-tenant**: the claim, the planner and the bucket are all keyed by tenant; one tenant's backlog
  never touches another's queue or tokens.

## 4. Blocker C2 — measured (Item 10)

`tests/integration/usage-sync-load.test.ts`: real PostgreSQL, the production `ProvisionerService` and
`ProvisionerLoop`, the real RickPanel adapter and HTTP client over a socket against a fake RickPanel that
holds every account. Time is simulated (a fixed clock advanced 5 s per tick), so the bucket refills exactly
as in production and the numbers reproduce run to run. Run with `C2_METRICS_OUT=<file>` to get the JSON
lines these figures were copied from (run of 2026-10-03, this branch).

**Case A — default bucket (100 / 5 min), 3 000-read backlog planned an hour earlier, tenant B with an
older 1 000-read backlog, 120 ticks (10 simulated minutes).** Injected: 3 paid orders at ticks 10, 40
and 80; a customer «refresh» at tick 60 on the ~2 900th service in line; five rate-limited reads at tick
30; a create whose answer is lost at tick 90.

| Observation                                           | Value                                                                                                                                                                              |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reads in ticks 1–6 (burst down to the floor)          | 10, 10, 10, 10, 10, 9 → bucket at the floor                                                                                                                                        |
| Steady sweep throughput (ticks 30+, sweep-only ticks) | **1.62 reads per tick** (refill 1.67)                                                                                                                                              |
| Sweep reads in 10 minutes / overall rate              | 229 / **0.38 reads/s** (incl. the 50-token burst)                                                                                                                                  |
| Bucket after any tick in which only the sweep spent   | **≥ 50.0** (never below the floor)                                                                                                                                                 |
| Bucket, sampled every 10 ticks                        | 90, 49.0, 50.3, 51.0, 49.0, 50.3, 51.0, 50.7, 50.3, 51.0, 50.7, 50.3 (below 50 only after a paid spend)                                                                            |
| Paid creates: ticks from planned to claimed           | **0 for all 9** — each first in the tick that first saw it                                                                                                                         |
| Customer refresh: ticks from tap to claimed           | **0** (promoted row, spent below the floor)                                                                                                                                        |
| Lost create                                           | outcome `UNKNOWN`, attempted once; its `RECONCILE` (non-background) claimed first in tick 96 once due (WP15 G3 may later re-plan one create after two absences: 11 creates in all) |
| Rate-limited reads                                    | 5 re-planned with back-off, still background, none `UNKNOWN`                                                                                                                       |
| Tenant B                                              | 1 000 rows untouched (`PLANNED`, 0 attempts), no bucket row                                                                                                                        |
| Panel writes                                          | only `POST /api/user` (the paid creates); every read a GET                                                                                                                         |

**Case B — raised bucket (1 000 / min), 2 000-read backlog, a paid order every 5th tick throughout.**

| Observation                                 | Value                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| Ticks to drain 2 000 reads                  | **204** (1 020 simulated s ≈ **1.96 reads/s**, the drain limit)                       |
| Paid orders / ticks from planned to claimed | 40 / **0** for all — first in their tick                                              |
| Background reads per tick                   | 9 (paid ticks) – 10 (others): every tick ran its full drain limit                     |
| Bucket minimum                              | 990 of 1 000 (the drain limit, not the budget, bound)                                 |
| Wall time on the shared 4-CPU test host     | ~0.75–0.82 s per tick (10 provider round trips + all DB work), well inside a 5 s tick |

Extrapolated to ~27k: case A's rate gives one full pass in ~22.5 h at the default bucket (§3); case B's
gives ~3.8 h per replica when the bucket is raised so the drain limit binds. Either way, paid creates and
customer refreshes were claimed in the first tick that saw them under a backlog of thousands.

What was **not** run: real RickPanel at 27k accounts (no credentials in this environment). Manual
acceptance: on staging with a real RickPanel, set `PANEL_PROBE_TENANT_LIMIT` as intended for production,
adopt/seed a large fleet, and watch `provisioning_operations` (`background`, state counts per minute)
and `panel_probe_budgets.tokens` while placing a paid order — it must be claimed in the next tick and the
bucket must not fall below the sweep floor except by paid/interactive spends.

## 5. Relation to PR #165

#165 is superseded in full; close it after this merges. Differences:

|                                                                    | #165                                                                                                                                          | This branch                                                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Eligibility                                                        | drops the `provider_user_id` predicate                                                                                                        | same, plus open/within-cadence exclusion                                      |
| What is background                                                 | inferred: `SYNC_USAGE AND requested_by_customer_id IS NULL` — **demotes an operator's sync**                                                  | explicit `background` column, CHECK-guarded, written only by the sweep        |
| Claim key                                                          | `CASE` expression, not indexed                                                                                                                | indexed column leading the due index                                          |
| Budget floor                                                       | 1 token — the sweep drains the bucket to 1, **below the monitor's 40-token floor** (starving health checks) and leaving paid bursts one token | max(50 %, monitor floor)                                                      |
| Customer refresh with a queued scheduled read                      | returned the scheduled row (waits behind the backlog)                                                                                         | promotes it                                                                   |
| Queue growth / duplicates across windows / broken-account blocking | unchanged                                                                                                                                     | bounded untried queue, one open scheduled read per service, cadence exclusion |
| Evidence                                                           | three cases on the 3X-UI fixture                                                                                                              | 11 priority cases + 2 load cases on the RickPanel adapter, 7 mutations        |

## 6. Mutation

`scripts/mutate-migration-p1.py` reverts one rule at a time against
`tests/integration/usage-sync-priority.test.ts`; every mutation is killed:

| Mutation                                        | Failing cases                                                |
| ----------------------------------------------- | ------------------------------------------------------------ |
| M1 require `provider_user_id` again             | 7                                                            |
| M2 drop the `background` claim key              | 6 (paid create, retry, floor, customer, operator, reconcile) |
| M3 background reserve 0                         | 2 (floor, customer)                                          |
| M4 no promotion (return the open scheduled row) | 2 (customer, operator)                                       |
| M5 no within-cadence exclusion                  | 1 (terminally failed reads)                                  |
| M6 no queue cap (plan 50 every tick)            | 1 (floor case's queue bound)                                 |
| M7 sweep plans `background = false`             | 6                                                            |

## 7. Known limitations

- Rows planned before migration 0189, or by an older replica during the rolling update, carry
  `background = false` and run at interactive priority until drained (at most one sweep page per window).
- A NON-retryable `SYNC_USAGE` failure still records `provisioning.stalled` with the create's sentence ("A
  paid service could not be created on its panel.") — pre-existing, and an operational-event code is
  schema (CLAUDE.md), so it is not changed here. At migration scale, accounts missing on the panel would
  each open one such condition (deduped per service). Flagged for the P5/P6 owner.
- Operability ignores health by design, so reads against a panel that is down still spend tokens (above
  the floor) until they retire.
- One provisioner replica's ceiling is 2 ops/s (`DRAIN_LIMIT` / tick); it is shared by paid and sweep work.
