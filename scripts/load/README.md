# Load harness

A repeatable load test for the whole request path: the real API and worker processes
(`apps/api/dist`), a real PostgreSQL and Redis, N tenants with M concurrent customers each,
one 50 000-recipient broadcast on the installation tenant and a real `backup run`, all at the
same time. Outbound Telegram calls go to a local stub the harness starts; nothing reaches
Telegram. It is **not** part of `pnpm verify` or CI, and later capacity PRs re-run it to compare
against `docs/capacity/baseline.md`.

```bash
pnpm build        # the harness runs the compiled API, as production does
bash scripts/dev-services.sh   # postgres + redis, if you have no others
psql postgres://nexa:nexa@127.0.0.1:5432/postgres -c 'create database nexa_load'

# one command: a steady run, 50 tenants x 2 customers, 2 minutes measured
node scripts/load/run.mjs --database-url postgres://nexa:nexa@127.0.0.1:5432/nexa_load

# the breaking point: 25 more concurrent customers every 30 s until p95 > 1 s or errors > 1 %
# (the broadcast runs, and the backup repeats back to back, for the whole ramp)
node scripts/load/run.mjs --database-url postgres://nexa:nexa@127.0.0.1:5432/nexa_load --mode ramp
```

`pnpm load <flags>` is the same command. Results land in `load-results/<timestamp>-<label>/`
(git-ignored): `results.md` (read this), `results.json`, `samples.json` (the per-second series),
`api.log`, `worker.log`, `pool-*.json`, `fixture.json`.

## What a run does

1. **Guards.** `--database-url` is required and its database name must contain a word starting `load` or `test`.
   The run **resets that database** (the integration harness's `resetDatabase`) and reseeds it, so
   never point it at anything you want to keep. `setup.mts` repeats the check.
2. **Stub.** `telegram-stub.mjs` answers every `POST /bot<token>/<method>` with `{ok:true,...}` after
   `--stub-latency-ms` (default 40 ms, standing in for the round trip to Telegram; the bot answers
   the customer before it answers the webhook, so this is part of the response time). The API and
   worker get `TELEGRAM_API_BASE_URL` pointing at it. It also remembers the last inline and reply
   keyboard each chat was shown, so a virtual customer presses buttons the bot really drew.
3. **Fixture** (`setup.mts`, run through `tsx`, about 15 s for 50 tenants and 50 000 customers): the
   repository's own seed (tenant A is the installation tenant), then `--tenants - 1` reseller
   tenants parented to it, each with its own bot instance (own token), a sellable panel, one
   product, a payment destination and the payment routes; an owner administrator; and
   `--audience` ACTIVE customers on the installation tenant. Each bot's webhook secret is the
   per-bot derived secret (`perBotWebhookSecret`), sent in
   `X-Telegram-Bot-Api-Secret-Token` exactly as Telegram would. Tenant 0 is the installation tenant,
   so its bot carries customer traffic while the broadcast runs on it.
4. **Processes.** `apps/api/dist/main.js` and `main.worker.js`, `NODE_ENV=development` (production
   refuses an `http://` Bot API URL and the harness has no TLS), `LOG_LEVEL=warn`, a throwaway
   keyring. `pool-probe.mjs` is preloaded into both to measure the `pg` pools from the inside.
5. **Load.** Each virtual customer loops this journey, thinking `--think-ms` (default 1 s, 0.5 to
   1.5 x) between steps: `/start`, the buy button, category, product, automatic username (the
   pre-invoice screen), main menu, the wallet button, main menu. Updates carry unique `update_id`s,
   so the webhook's idempotency never turns a request into a no-op.
6. **Background.** `--broadcast-at` seconds after the warm-up one broadcast to the whole audience is
   composed, previewed and launched through the admin API (login, create, preview, launch). At
   `--backup-at` the real `backup run` starts (dump, archive, verification restore into a scratch
   database on the same server). If the CLI fails here and `--backup-cmd auto` (the default), the
   harness runs `pg_dump -Fc` of the same database instead and records that substitution in the
   results. `--backup-cmd pg_dump` forces it; `--no-backup` and `--audience 0` switch the two off.
7. **Sampling**, every second: CPU and RAM of the API, the worker, Postgres (PSS) and Redis from
   `/proc`, and of the harness itself; machine CPU and available memory; `pg_stat_activity`
   (backends, active, idle in transaction, waiting, wait events); pool size, idle and waiting
   clients and acquisition time from inside both processes; queue lag every 2 s: the outbox
   (depth and oldest unprocessed age), pending notifications, and the broadcast recipients by state.
   With `--docker name1,name2` it also runs `docker stats` for those containers.
8. **Report.** p50/p95/p99 webhook response time (overall and per step), error rate (any non-2xx
   answer, a timeout or a connection error), the sampled series, the queues, the backup, the log
   error lines. In ramp mode: one table row per stage and the breaking point.

The broadcast lane sends at most `BROADCAST_SENDS_PER_SECOND` = 20 per bot, so 50 000 recipients on
one bot take about 42 minutes. The run reports progress when the window ends, not completion.
A broadcast of an earlier run is still `SENDING` in a database that is not reseeded and the
new worker would resume it, which is why every run reseeds by default (`--skip-setup` exists
for a fixture you have just built yourself).

## Flags worth knowing

| flag                                           | default       | meaning                                                                                  |
| ---------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| `--tenants` / `--customers`                    | 50 / 4        | tenants, concurrent customers per tenant                                                 |
| `--duration` / `--warmup`                      | 120 / 15      | measured and warm-up seconds (steady)                                                    |
| `--mode ramp` `--ramp-start/-step/-stage/-max` | 25/25/30/1000 | total virtual customers (round-robin over the tenants), step, seconds per stage, ceiling |
| `--p95-limit-ms` / `--error-limit`             | 1000 / 0.01   | what counts as broken                                                                    |
| `--audience`                                   | 50000         | broadcast recipients; 0 disables the broadcast                                           |
| `--pool-max`                                   | app default   | `DATABASE_POOL_MAX` of the spawned processes                                             |
| `--think-ms`, `--stub-latency-ms`              | 1000, 40      | pacing and the simulated Telegram round trip                                             |
| `--label`, `--out-dir`                         |               | name the run / where it writes                                                           |

`node scripts/load/run.mjs` with an unknown flag stops; it never runs a different test than you typed.

## Locally

Four cores are enough for 50 tenants x 1 to 2 customers; the load generator, the stub, the API, the
worker, Postgres and Redis all share them, so a local run measures the code, not a server. Close
other heavy work first: the report prints how busy the machine was before the run started.

## On a test server

Two ways.

**Everything on the server (simplest, recommended).** Clone the release's repository on the server,
`pnpm install && pnpm build`, make a scratch database (`nexa_load`) on the installation's PostgreSQL
or a second one, and run the same command. It spawns its own API and worker on port 13000, so
it does not touch the running stack, but it competes with it for CPU and RAM: quiesce the stack
for a clean measurement (it must not be serving customers), or accept the interference and say so. Use
`--docker nexa-postgres,nexa-redis` (your container names) to get RAM and CPU per container.

**Against the deployed stack.** `--api-url https://host` skips spawning; the harness then needs
the database (`--database-url`, reachable from where you run it; use an SSH tunnel) and the
installation's bot webhook secret and keyring in the environment, because `setup.mts` seals the
fixture's bot tokens with them: export `SECRETS_KEK`/`SECRETS_KEK_ID` (or the keyring variables)
and `TELEGRAM_WEBHOOK_SECRET` to match the stack. The stack's `TELEGRAM_API_BASE_URL` must point
at the stub, and in production that has to be `https://`: run the stub with a certificate the
containers trust (`NODE_EXTRA_CA_CERTS`) behind a reverse proxy, or set the stack to
`NODE_ENV=development` for the test. This mode has not been exercised yet; the local mode has.

Whatever the mode: the harness resets the database it is given. Run it only on a scratch database,
and finish a server session with `sudo botctl roles disable provisioner monitor` like any other
test (the harness does not start those roles; the worker it starts has the backup scheduler off).

## Reading the numbers

- A response time is what Telegram would see: the full turn, including the reply sent to the stub.
- "Queued" pool acquisitions mean a statement waited for one of the pool's connections; a high share
  with a rising acquire time is the pool being the bottleneck, a lock wait or `ClientRead` in the
  wait events is the database.
- `oldest unprocessed age` of the outbox is the worker queue lag; the broadcast is reported by
  state counts.
- The RAM of Postgres is PSS (shared buffers are counted once). CPU is a share of ONE core, so 200 %
  is two cores busy.
