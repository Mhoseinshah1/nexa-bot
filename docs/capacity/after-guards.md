# Capacity after the guards (phase 6A PR-2)

The same harness, the same parameters and the same sandbox class as `docs/capacity/baseline.md`,
re-run on the capacity-guard branch. **Read the caveats at the end before carrying any number to
the 4 vCPU / 8 GB server.**

## What the guards are

| Guard                                            | Where                                                                                                     | What a bot at its limit sees                                                                                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Customer updates, per bot (`UPDATE_CONCURRENCY`) | `BotTurnGuard` around the webhook's customer turn; a per-bot FIFO queue (`KeyedConcurrencyLimiter`)       | Its update waits in its own bot's queue (at most 200, at most 20 s) and is then processed and answered 2xx. Past either bound it is answered **429, nothing written**, and Telegram delivers it again.       |
| Database share, per bot (`DB_CONNECTIONS`)       | `PoolShare` wraps the API pool's `connect`; re-entrant per turn                                           | At most N of the bot's turns hold a pooled connection at once; the rest wait for the bot's own permits. Other bots and the Web Admin go straight to the pool.                                                |
| Background jobs (`JOB_TURN_WEIGHT`)              | `weightedRoundRobin` in the outbox relay's claim and the operations-notification claim                    | Each round gives every bot with work its turn (the owner's own bot two); one bot's backlog no longer fills every batch.                                                                                      |
| Broadcast (`BROADCAST_PER_SECOND`)               | `BroadcastDispatcher` reads the bot's limit for its pacing row                                            | 10/s hosted, 25/s for the owner's own bot; «نامحدود» is Telegram's 30/s.                                                                                                                                     |
| New customers (`NEW_CUSTOMERS_PER_MINUTE`)       | `NewCustomerGate`, asked inside `resolveFromUpdate`'s transaction only when it would CREATE a customer    | The creation rolls back and the webhook answers 429; Telegram delivers the `/start` again. A returning customer is never counted.                                                                            |
| Heavy jobs                                       | `HeavyJobGate` over `heavy_job_tickets`: one installation-wide queue, 1 (or 2) at a time, the owner first | A scheduled backup keeps its place and starts on a later tick; `backup run` waits (up to 30 min) and says so. Nothing starts while free memory is below the floor (768 MB by default); the owner is told.    |
| Memory                                           | `deploy/compose.yml` `mem_limit` per service from `NEXA_HOST_MEMORY_MB`; postgres `oom_score_adj: -900`   | A runaway role is killed inside its own container; when the host itself runs out the kernel takes an application role, not PostgreSQL.                                                                       |
| Disk, RAM and worker-lag alerts                  | `CapacityMonitor` in the worker, every minute, recorded on the installation tenant                        | The owner's operations group only: disk 80 % and 90 %, free memory below 512 MB, outbox lag above 300 s; two checks in a row before a condition opens, one message per condition, a recovery when it clears. |
| Repeated limit hits                              | `LimitPressureReporter`                                                                                   | 50 hits in 5 minutes → one message to the OWNER (installation group), at most one per bot and limit per 15 minutes per process and per aggregation window across processes.                                  |

The webhook did **not** persist updates before this change: it handled each update inline and
answered 2xx (`webhook.controller.ts`). That is why an update over a bot's limit is held in the
request (queued) and, when it cannot wait, answered with a retryable non-2xx before anything is
written — Telegram keeps an update and redelivers it on any non-2xx, so the update is slower,
never lost, and the idempotency key `(bot, update_id)` makes a redelivery of an update that did
get processed a replay.

Every limit is the owner's, per bot, in `tenant_capacity_limits` (absent row = the tier default),
read and changed through `CapacityLimitsService` and `GET/POST /api/admin/v1/capacity/limits`:
the installation tenant's own administrators with `settings.destructive` only. A hosted bot's own
owner holds `settings.destructive` in their tenant and is refused (`capacity.owner_only`).

## Re-run: the same parameters, main and the guards back to back

Same commands as the baseline (`docs/capacity/baseline.md`; 50 tenants, tenant 0 the installation, a
50 000-recipient broadcast on it and the real `backup run`). Because this sandbox is shared with other
agents' test runs (load average 3 to 4.5 before every run here, against 2 to 4 for the baseline), each
scenario was run on `main` (`eaf41d1e8`, separate worktree and database) and then on this branch,
back to back, so the two numbers of a row share the same noise. Raw output: `load-results/`
(git-ignored), labels `base-*` and `guards-*`.

Steady, 100 concurrent customers, backup and broadcast on:

| measure                 | main (same hour)  | guards            | baseline page     |
| ----------------------- | ----------------- | ----------------- | ----------------- |
| req/s                   | 63.7              | 62.5              | 62.5              |
| p50 / p95 / p99 ms      | 481 / 1270 / 1788 | 554 / 1208 / 1593 | 555 / 1212 / 1496 |
| errors                  | 0 %               | 0 %               | 0 %               |
| API RAM / CPU           | —                 | 580 MB / 101 %    | 580 MB / 105 %    |
| worker RAM / CPU        | —                 | 295 MB / 13 %     | 264 MB / 11 %     |
| API pool queued         | 90 %              | 93 %              | 92 %              |
| broadcast sends/s       | 13.5              | 17.9 (owner 25/s) | 12.9              |
| outbox lag              | 0 s               | 0 s               | 0 s               |
| "loops stopped" at boot | 1 line            | **0**             | yes, every run    |

A first guards-only steady run on a busier machine gave p95 1 525 ms at 55 req/s; its main twin was not
run in the same minutes, so it is noise, and it is listed here only so it is not hidden.

Ramp (25 more customers every 30 s), p95 ms per stage, broadcast on and backups back to back:

| customers | main  | guards | baseline page |
| --------- | ----- | ------ | ------------- |
| 25        | 186   | 216    | 221           |
| 50        | 299   | 419    | 345           |
| 75        | 723   | 850    | 968           |
| 100       | 1 252 | 1 377  | 1 406         |

Break point 100 on both, last good level 75. The guards' 50 and 75 stages are slower than main's twin.
They ran with a higher load average before the run (4.5 against 3.8), and with the owner's broadcast at
25/s instead of 20/s (more worker and database work during the ramp). The webhook-only ramp below has no
broadcast and is the cleaner comparison of the request path itself.

Webhook only (no broadcast, no backup), p95 ms:

| customers | main  | guards |
| --------- | ----- | ------ |
| 25        | 177   | 168    |
| 50        | 254   | 224    |
| 75        | 390   | 405    |
| 100       | 895   | 908    |
| 125       | 1 339 | 1 308  |

Break point 125 on both (last good 100). **The guards cost nothing measurable on the request path**:
the per-bot queue, the database share and the limit reads (cached for 30 s) are in-process work per turn.
They do not raise the cliff either. In this scenario no bot reached a limit (2 customers per bot, against
8 concurrent turns and 3 database permits), so what they add is isolation: one bot's flood waits behind
itself, and the server's total is unchanged.

## How many bots this server holds (p95 < 1 s)

Measured: the request path saturates ONE Node process at about 60 to 67 webhook updates per second.
p95 stays under 1 s up to about **75 concurrently active customers with a backup and a broadcast
running** (about 53 req/s), and about 100 with neither (about 67 req/s). A customer in the harness journey
sends about 0.6 updates/s while actively tapping. The limit is one API process (100 to 120 % of a core);
PostgreSQL uses 1.2 to 1.7 cores and waits on WAL sync, not locks.

Assumptions for the 4 vCPU / 8 GB target, stated so they can be checked there:

1. Its cores are at least this sandbox's (2.1 GHz shared VM). The single API process then gives the same
   or better ~60 req/s. The load generator and stub, about 10 % of a core here, do not run on it.
2. A bot's peak concurrency is its peak number of customers tapping in the same few seconds, not its
   member count. A small hosted bot (a few hundred active members) peaks at about 1, a medium bot at 3,
   a large one at 10 or more.
3. Memory is not the limit. Measured: API 580 MB, worker 300 to 450 MB, PostgreSQL about 470 MB PSS on
   this small database. On 8 GB the new limits are PostgreSQL 3.2 GB, API 983 MB and worker 819 MB, and
   all of them hold. A production database larger than this fixture will want more of PostgreSQL's share
   for cache, and that is what the 40 % is for.

Within p95 < 1 s with the nightly backup and a broadcast running, the server therefore holds about
**75 concurrently active customers in total**, for example:

- the owner's bot at up to about 25 concurrent customers, plus 50 hosted bots averaging 1 concurrent
  customer each (small bots), or
- the owner's bot plus about 15 medium hosted bots at 3 each, or 5 large ones at 10.

Without the backup and broadcast windows, about 100. Fifty hosted bots at 1 concurrent each (50 customers,
p95 about 300 to 420 ms here) fit comfortably. Fifty medium bots (150 concurrent) do not fit: that
needs a second API process (the next PR's question), not a limit.

What the guards change in that picture: one hosted bot can hold at most 8 turns at once and 3 database
connections of the API pool. A flood from a single bot costs that bot latency, not the server. The sum
of 50 bots each within its own limit can still exceed the server: per-bot limits isolate, they do not
add capacity.

## Caveats (this sandbox is not the target)

- 4 shared vCPUs, 16 GB RAM, no Docker: the new `mem_limit`s and `oom_score_adj` were **not** exercised
  under memory pressure here (MemAvailable never fell below 11.8 GB). They are checked by
  `tests/deploy/botctl.test.sh` and `docker compose config`, not by an OOM. Run the harness on the server
  with `--docker` to see per-container figures.
- Other agents' test runs shared the machine during every run (load average 3 to 4.5). Only the
  back-to-back pairs are comparable with each other.
- The scenario never pushes one bot over its limits, so the queueing path (a wait, a 429 and Telegram's
  redelivery) is proven by `tests/integration/capacity-guards.test.ts` and the unit tests, not by this
  load. A scenario with one hot bot needs a harness flag that does not exist yet.
- Real Telegram (variable latency, 429s), real panels and gateways, and a production-sized database are
  absent, as in the baseline.

## Decisions taken (PR-2)

- **"Owner's own bot" is the installation tenant** — the one `PRIMARY` tenant (`tenants_single_primary_key`),
  `container.installationTenantId`; every other tenant is a hosted bot. The tier is decided by identity, so a
  new hosted bot is limited from its first update with nothing written.
- **Limits live in their own table, not in the settings registry.** A per-tenant setting is editable by that
  tenant's own owner (`settings.destructive` is seeded to every tenant's owner role), which is exactly who must
  not raise their own limits. The four installation knobs (heavy-job concurrency, the heavy-job memory floor,
  the two alert thresholds) are rows of the installation tenant in the same table. No permission was added: the
  endpoint takes `settings.destructive` AND the installation tenant's scope.
- **Over a limit is queued or handed back, never dropped**: a bot's update waits in its own in-process queue; a
  queue that is full or a wait that runs out is a 429 before anything is written, so Telegram redelivers it.
  The new-customer rate refuses inside the creating transaction, so the refusal rolls the customer back.
- **Round-robin is applied where the work is already multi-tenant**: the outbox relay and the
  operations-notification dispatcher claim across tenants. The customer-notification lane, the reminder sweeps,
  the broadcast lane and the nightly report are still driven for the installation tenant only (every worker loop
  is today); turning them on for hosted bots would start sending queued customer messages and is not this PR's
  call. The offsets and weights are wired into them, so they take effect per bot when those lanes fan out.
- **Scheduled-work offsets**: a stable SHA-256 of `<purpose>:<tenantId>` into the interval (the nightly report
  within an hour after its time; each reminder sweep within its own interval). The owner's own bot keeps its
  configured time. FX refresh, retention and backup are installation-wide passes today, so they have no per-bot
  time to shift.
- **Support AI and storage caps are stored and shown as `PLANNED`**, not enforced: enforcing a monthly AI cap
  needs a decision on what happens to the jobs it stops (they would trip the assistant's stall watch), and storage
  needs a per-tenant size measure. The contract says so, so a page can say "not enforced yet".
- **The worker's "loops have stopped making progress" at boot** (baseline) was the heartbeat consulting
  `backup-scheduler`, `backup-housekeeping` and `legacy-compaction-executor` before `main.worker.ts` had started
  them (they start after the awaited start-up sweep of killed backup runs, which a loaded database makes slow).
  The worker is now NOT READY but ALIVE until every loop has been started, and reports no stall for a loop that
  has not begun (`workerHealthVerdict`). The guards' runs log no such line.
