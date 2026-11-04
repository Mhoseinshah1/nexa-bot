# Capacity baseline: today's code, measured in the build sandbox

Measured with `scripts/load/run.mjs` (README: `scripts/load/README.md`) on commit `68ca6930d`
(`main` after PR #408, the single-tenant release code). Every later phase-6A PR re-runs the same
command and compares against this page. **Read the caveats before comparing anything to the
4 vCPU / 8 GB server: this sandbox is not that server.**

Re-run (one command each; the database name must contain a word starting `load` or `test`; it is reset):

```bash
pnpm build
node scripts/load/run.mjs --database-url postgres://nexa:nexa@127.0.0.1:5432/nexa_test_load --label baseline-steady
node scripts/load/run.mjs --database-url postgres://nexa:nexa@127.0.0.1:5432/nexa_test_load --mode ramp --label baseline-ramp
node scripts/load/run.mjs --database-url postgres://nexa:nexa@127.0.0.1:5432/nexa_test_load --mode ramp --no-backup --audience 0 --label baseline-ramp-webhook-only
```

## Machine and parameters

- Sandbox: 4 vCPUs (Intel Xeon 2.1 GHz, a virtual machine), 16 GB RAM, Linux 6.18, Node 22.23.
  No Docker containers: API, worker, PostgreSQL 16 and Redis are plain processes on one host, so RAM
  and CPU are per process (`/proc`; Postgres as PSS), not per container.
- Everything shares those 4 cores: the API, the worker, Postgres, Redis, the Telegram stub, the load
  generator, and, at times, other agents' test runs in the same sandbox (load average 2 to 4 before
  the runs; the report prints it per run). The numbers are therefore somewhat pessimistic and noisy.
- Scenario: 50 tenants (the installation tenant plus 49 reseller tenants under it), each with its own
  bot instance and webhook secret, product and payment routes; steady run 2 customers per tenant
  (100 concurrent virtual customers), think time 1 s (0.5 to 1.5 x) between taps, warm-up 15 s, then
  120 s measured. Each customer loops `/start`, buy button, category, product, automatic username
  (pre-invoice), main menu, wallet button, main menu: about 8 updates per journey, about 0.6 updates/s
  per customer.
- Background, at the same time: one broadcast of 50 002 recipients on the installation tenant
  (50 000 seeded plus the virtual customers who joined), launched through the admin API 5 s after the
  warm-up, and the real `backup run` (dump, archive, verification restore) started 10 s after it. The
  Telegram stub answers after 40 ms (+/- 20) per call.
- Not representative on purpose or by limitation: `NODE_ENV=development` (production refuses the
  `http://` stub URL), pool size and every other setting at the application default (API pool 10),
  one API process (as deployed), monitor and provisioner roles not started.

## Steady run: 100 concurrent customers, backup and broadcast on

| measure                             | value                                                                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| webhook requests                    | 7 496 in 120 s (62.5/s)                                                                                                                                                                             |
| **p50 / p95 / p99 response time**   | **555 / 1 212 / 1 496 ms** (max 1 876 ms)                                                                                                                                                           |
| **error rate**                      | **0 %** (all 201; no timeout, no pool-checkout timeout, no flow mismatch)                                                                                                                           |
| slowest step                        | pre-invoice tap: p50 906, p95 1 632 ms; `/start` p95 883 ms                                                                                                                                         |
| API process                         | RAM 580 MB (max 589), CPU 105 % of one core (p95 121, max 128)                                                                                                                                      |
| worker process                      | RAM 264 MB (max 282), CPU 11 % (p95 27)                                                                                                                                                             |
| PostgreSQL                          | RAM 296 MB PSS (max 318), CPU 119 % (p95 139, max 178)                                                                                                                                              |
| Redis                               | RAM 5.6 MB, CPU under 1 %                                                                                                                                                                           |
| load generator + stub               | RAM 80 MB, CPU 10 %                                                                                                                                                                                 |
| whole machine                       | CPU 70 % average, 79 % p95, 87 % max of 4 cores; lowest MemAvailable 12.5 GB                                                                                                                        |
| DB sessions                         | 20 average, 22 max; idle in transaction 3 average, 7 max; waiting: nearly none                                                                                                                      |
| top DB wait events (active samples) | IO:WALSync 13, Client:ClientRead 11, LWLock:WALWrite 3: the database is not waiting on locks                                                                                                        |
| API pool (probe inside the process) | max 10; 327 021 acquisitions (about 43 per webhook turn), **92 % had to queue**, acquire mean 14.5 ms, p95 under 50 ms, max 193 ms, up to 287 clients waiting at once                               |
| worker pool                         | 16 102 acquisitions, 1.1 % queued, max 83 ms                                                                                                                                                        |
| worker queue lag                    | outbox oldest unprocessed age 0 s (max under 1 s), depth 0; notifications none                                                                                                                      |
| broadcast                           | launched at +23 s (preview 378 ms, launch 2.0 s for 50 002 rows); 1 440 sent when the window ended, about 12.9 sends/s against the lane's 20/s per-bot cap, so 50 000 would take about an hour here |
| backup                              | `backup run` exit 0 in 10.1 s (dump 2.1 MB, archive 2.1 MB, verified)                                                                                                                               |

## Ramp: the breaking point

25 more virtual customers every 30 s (spread over the 50 tenants), p95 and error rate judged on the
last 75 % of each stage; broken when p95 > 1 s or errors > 1 %.

With the broadcast running and the backup repeating back to back (`baseline-ramp`):

| virtual customers | req/s | p50 ms | p95 ms    | p99 ms | errors |
| ----------------- | ----- | ------ | --------- | ------ | ------ |
| 25                | 22.2  | 132    | 221       | 285    | 0 %    |
| 50                | 41.8  | 163    | 345       | 448    | 0 %    |
| 75                | 53.3  | 342    | 968       | 1 132  | 0 %    |
| **100**           | 58.1  | 694    | **1 406** | 1 631  | 0 %    |

**Breaking point: 100 concurrent virtual customers (about 58 req/s): p95 1.4 s.** Last good level 75
(p95 968 ms, already at the edge).

Webhook traffic only, no broadcast, no backup (`baseline-ramp-webhook-only`):

| virtual customers | req/s | p50 ms | p95 ms    | p99 ms | errors |
| ----------------- | ----- | ------ | --------- | ------ | ------ |
| 25                | 22.1  | 111    | 183       | 241    | 0 %    |
| 50                | 44.6  | 118    | 184       | 222    | 0 %    |
| 75                | 63.3  | 162    | 366       | 444    | 0 %    |
| **100**           | 58.5  | 606    | **1 317** | 1 587  | 0 %    |

Same breaking point (100); the background work moves the 75-customer stage from p95 366 ms to
968 ms, so it is what a deployment loses before the cliff, not the cliff itself.

## What the numbers say

- The cliff is a **single saturated API process**: at about 60 req/s the API sits at 100 to 130 % of
  one core (one Node event loop) and throughput stops growing (63 req/s at 75 customers, 58 at 100)
  while latency climbs, with zero errors. Postgres uses about 1.2 cores at that point and has headroom
  on wait events.
- A webhook turn costs about 43 pool acquisitions. With a pool of 10, 92 % of them queue at
  100 customers (up to 287 clients waiting). Acquire time stays small (mean 14 ms), so the pool is a
  symptom of the chatty turn, not the primary limit, but it is the first thing to watch if CPU
  headroom is added.
- No errors, no pool-checkout timeouts and no outbox lag appeared at any level tested: the system
  degrades by latency, not by failing, up to at least 100 customers at 50 tenants.
- `backup run` finishes in 10 to 21 s on this small database while the API is loaded (the ramp's
  repeated backups, the first at 21 s). The database here is a few MB; a production database is
  larger, so backup duration and its CPU share are not comparable.
- The worker logs `worker loops have stopped making progress` for `legacy-compaction-executor`,
  `backup-scheduler`, `backup-housekeeping` shortly after its start in every run. It happens at
  boot before those loops have ticked and has not been investigated here.

## What this sandbox can and cannot represent

Cannot:

- **The target server.** 4 vCPU / 8 GB on a real cloud host differs in CPU speed (this is a shared
  2.1 GHz VM), in disk (the WAL sync waits here are a virtual disk's), and in memory pressure: 16 GB
  here, nothing swapped, MemAvailable never below 12.4 GB, so the 8 GB limit and the OOM behaviour of
  the compose stack are untested. Per-container RAM and CPU need `--docker` on a real stack.
- **Isolation.** The load generator, stub, Postgres, Redis, API and worker compete for the same
  4 cores (together 70 % of the machine at the break), and other agents' work added noise. On the
  target server the load generator should run on another host.
- **Real Telegram.** The stub is constant 40 ms and never answers 429 or a timeout; real latency has
  variance and real flood limits, which stretch webhook turns that reply inline.
- **Production data.** The database holds the fixture only (tens of MB with 50 000 customers): no
  years of orders, ledger or audit rows, so index depth, cache misses, backup time and dump size
  are optimistic.
- **Real panels and gateways.** No panel, gateway or provisioning traffic: the journey stops at the
  pre-invoice. Payments, provisioning and the notification fan-out they cause are not measured.
- **Multi-tenant code.** This is today's single-tenant code with 49 reseller tenants as data; later
  phase-6A changes are exactly what a re-run should show.

Can: the shape of the bottleneck (one API process; chatty turns; pool queueing), the relative cost of
the background work, and a before/after comparison of the same scenario on the same machine class.
Compare only runs made on this sandbox with a quiet machine; for decisions about the 4 vCPU / 8 GB
server run the harness there (`scripts/load/README.md`, "On a test server").
