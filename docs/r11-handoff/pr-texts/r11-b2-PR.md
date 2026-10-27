## R11 B2 — usage chart on the mini app service screen (periodic usage snapshots)

Feature flag `service_usage_chart`, OFF by default, switchable in Web Admin «امکانات».

### What changed

**1. Contract commit (separate, `56c71aba`)**

- Feature flag `service_usage_chart` (LOCAL blast radius, default off) in `packages/contracts/src/features.ts`; the closed list in `tests/unit/registries.test.ts` gains the key.
- `MINIAPP_ROUTES.serviceUsage` = `GET /services/:serviceId/usage?days=7|30`, `miniAppUsageQuerySchema`, `miniAppUsageHistorySchema` (points are `{at, usedBytes}` only; plus the newest point's `totalBytes` / `expiresAt`). No connected-device count anywhere.
- `miniAppServiceDetailSchema.usageChart: boolean` so the page never asks an endpoint that is switched off.
- `USAGE_SNAPSHOT_BUCKET_MINUTES` (60), `USAGE_SNAPSHOT_RETENTION_DAYS` (90), `USAGE_CHART_RANGES_DAYS` ([7, 30]).

**2. Storage, write path, retention, endpoint (`e3129990`)**

- Migration `0294_service_usage_snapshots`: `service_usage_snapshots(tenant_id, service_id, bucket_at, taken_at timestamptz, used_bytes bigint, total_bytes bigint NULL, expires_at timestamptz NULL)`. Primary key `(tenant_id, service_id, bucket_at)` is the "one per service per bucket" unique index; `bucket_at` = `taken_at` floored to the UTC hour; composite FK to `services(tenant_id, id)`; CHECKs (`used_bytes >= 0`, `total_bytes` NULL or > 0 — NULL means unlimited); index `(tenant_id, taken_at)` for the prune. No balance column, all `timestamptz`.
- **No new panel call, no new loop.** A snapshot is recorded inside the transaction of each place that ALREADY writes a panel's usage figure, only when `recordUsage` reported that the ACTIVE row moved, with the figure that read returned and the instant it used (Clock port):
  - `ProvisionerService.finishUsageSync` (the scheduled `SYNC_USAGE`),
  - the renewal / extra-traffic / extra-time path whose panel answer carries usage,
  - `ServiceRefreshService.recordFound` (the card's live check on opening, and the «♻️» tap).
- `UsageSnapshotService` (`provisioning/application/usage-snapshots.ts`): reads the feature flag and `ScopeActivityReader` INSIDE the caller's transaction; no actor (same as `recordUsage`, which it rides on). `DrizzleUsageSnapshotRepository` inserts with `INSERT ... SELECT FROM services WHERE state = 'ACTIVE' ... ON CONFLICT DO NOTHING`, taking allowance (`NULLIF(limit, 0)`) and deadline from the service row.
- **Cadence you get:** the sync's own cadence (`provisioning.usage_sync_minutes`, 240 by default, minimum 15) plus a point whenever a customer opens/refreshes a card (the live check's cache window still applies), thinned to at most one row per service per UTC hour; the first figure of an hour is kept. About six points a day per service at the default. Documented in `docs/migration-p1-usage-sync.md` §8.
- **Retention:** 90 days. The provisioner tick deletes at most 500 expired rows per tick through `(tenant_id, taken_at)`, whatever the flag says (rows stored before it went off still expire). Chosen over the data compaction because that ships in DRY_RUN and has its own settings/allow-list/protected-table machinery; here retention is a rule, not an operator option.
- Endpoint `GET /miniapp/api/v1/services/:serviceId/usage?days=7|30`: same `miniAppCall(gated)` and `ownService` as the detail route (another customer's service is `miniapp.not_found`); reads stored rows only; `404 miniapp.not_found` while the flag is off; any `days` other than 7/30 is a validation error. Detail response carries `usageChart`.

**3. Mini app + Web Admin (`84272291`)**

- `apps/miniapp/src/screens/usage-chart.tsx`: inline SVG (no dependency) line/area of used volume, 7/30 day toggle (`aria-pressed`), states for loading, error + retry, empty range, single point (a dot). Scale = largest stored figure, computed in bigint thousandths; time left-to-right. Drawn only when the detail says `usageChart`. New Persian text `miniapp.usage_*`.
- Web Admin «امکانات»: `service_usage_chart` presentation + Persian title/summary (`web.feature_service_usage_chart_*`). Switch-off asks nothing (nothing is lost; stored points stay).

### Tests

| File                                                | Cases                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/integration/r11-b2-usage-snapshots.test.ts`  | 6: snapshot from the existing sync read with the fake panel's request count identical flag-off vs flag-on (and no non-read request); one-per-hour dedupe (first figure kept, replay inserts nothing, next hour inserts); non-ACTIVE writes nothing; flag off writes nothing; retention on the provisioner tick (flag off, keeps fresh rows, boundary ±2h); prune is a bounded batch (500 of 700) |
| `tests/integration/r11-b2-usage-chart-http.test.ts` | 5: own points for 7 and 30 days, point keys exactly `at`/`usedBytes`; another customer's service is not found and no point leaks; flag off → 404 and detail `usageChart:false`, on → true/200; `days` 5/0/90/abc/-7 → 400; reading makes no panel request                                                                                                                                        |
| `tests/unit/service-live-check.test.ts`             | +3: live check records one snapshot from its one read; none when `recordUsage` did not take; none for a missing account                                                                                                                                                                                                                                                                          |
| `tests/web/miniapp-usage-chart.test.tsx`            | 9: line over 7 days, 7↔30 toggle asks `days=30`, empty range, single point, refusal + retry, bigint plot mapping, drawn when on, neither drawn nor requested when off, no device wording                                                                                                                                                                                                         |
| existing                                            | `registries`, `miniapp-screens-2b`, `control-plane-pages`, `usage-sync-priority`, `miniapp-surface`, `migration-ordering`, `migration-compatibility` all pass                                                                                                                                                                                                                                    |

Local gate: eslint + prettier + `pnpm typecheck` + `check:i18n` clean; `pnpm db:check` ok; integration (6 files, 53 tests) passed; unit+web (5 files, 141 tests) passed. Full integration suite left to CI.

Mutation checks (applied together in one run, each named test went red, all restored; M1 also run alone first):

| Mutation                                   | Red                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| M1 sync stops recording                    | "records a snapshot from the usage read the scheduled sync already makes" |
| M9 one extra panel read per sync           | same test (request-count assertion)                                       |
| M2 `record` ignores the flag               | "writes nothing while the feature flag is off"                            |
| M3 `DO UPDATE` instead of `DO NOTHING`     | "keeps one snapshot per service per hour"                                 |
| M8 drop `state = 'ACTIVE'`                 | "writes nothing for a service that is not ACTIVE"                         |
| M4 tick does not prune                     | "deletes snapshots older than the retention on the provisioner tick"      |
| M5 unbounded prune batch                   | "prunes in bounded batches"                                               |
| M6 history without `ownService`            | "answers another customer's service as not found"                         |
| M7 history ignores the flag                | "does not exist while the flag is off"                                    |
| M10 live check records nothing             | unit "the figure a live check wrote is also kept for the chart"           |
| M11 chart drawn regardless of `usageChart` | web "neither drawn nor requested when the feature is off"                 |
| M12 toggle stuck on 7                      | web "asks the server for 30 days when the toggle moves"                   |

### Decisions

- Reading that moves no money and sends no customer message: a snapshot is a silent bookkeeping row; the first figure after an import is stored too (it is a real reading and nobody is told about it). The import-silence rules for notices are untouched.
- Resolution is the existing reads' (see cadence); no new read was added to make the chart denser. If an owner wants a denser chart they lower `provisioning.usage_sync_minutes` (down to 15), which is already the documented knob and already budgeted.
- Hourly bucket, first-figure-wins, so a burst of live checks cannot grow the table; `bucket_at` is part of the PK instead of a separate unique index.
- Retention is a fixed 90 days (contract constant), not a setting; deleted by the provisioner tick, not by the data compaction.
- Switch-off needs no confirmation in «امکانات» (existing `control-plane-pages` test pins the closed list of flags that ask).
- No `ActorContext` on `record`/`prune`: they are sub-steps of `recordUsage` / the provisioner tick, which take none; the flag and `ScopeActivityReader` are read inside the transaction.

### Migrations

`apps/api/drizzle/0294_service_usage_snapshots.sql` (+ `meta/0294_snapshot.json`, journal entry), generated with drizzle-kit and read; `pnpm db:check` ok. Based on main at `b6f97a50` (last migration 0293). Other R11 PRs may also claim 0294: renumber the one that merges second with `scripts/claude/renumber-migration.sh` (contracts rebuilt first) and confirm byte-identical SQL.

### Open

- The renewal/add-traffic/add-time write site is covered by the same `if (recorded) record(...)` shape and by no dedicated test (it needs a panel that returns usage on modify); the sync and the live check are tested.
- Branch `feat/r11-usage-chart`, head `84272291`.
