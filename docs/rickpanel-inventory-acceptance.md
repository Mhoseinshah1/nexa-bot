# C1 — real RickPanel inventory verification (runbook)

**Status: NOT RUN. External / manual acceptance.** This environment has no RickPanel
credentials, and C1 is not closed by a fake. The procedure below is code, not prose, so the
run is one command once credentials exist.

What it proves: that Migration P5's read-only inventory (`docs/rickpanel-inventory.md`)
walks a real RickPanel completely, stably, and without writing — and it settles
`OQ-P5-01` (the list route and page shape) and `OQ-P5-02` (stable order).

## Safety

- **Read-only, twice over.** The inventory holds only `RickpanelReadOnlyHttp` (three fixed
  reads). Underneath it, `readGuard` refuses — without sending — anything that is not a
  `GET` or the token exchange, and the run FAILS if it refused anything.
- Requests made by C1: one token exchange per walk/lookup, `GET /api/users?offset=&limit=`
  per page (one pair of walks per attempt, then `listAll`'s own two), `GET /api/user/{name}`
  twice. No create, modify, revoke, delete, files read or subscription fetch. The report
  counts what was sent by kind (`requestsByKind`), and a check fails if anything else was.
- The same command also runs the C3 step (`docs/c3-subscription-ref-rickpanel.md`), which
  reads ONE account twice and fetches that account's own subscription link ONCE by GET.
  To run C1 alone: `pnpm test:acceptance:inventory real-rickpanel-inventory`.
- **Aggregate-only output.** The printed report contains counts, page shapes and a state
  histogram. No username (not even the known one you supply), no subscription link, no
  token, no Telegram id. Do not add any.
- It uses its OWN variables, not `NEXA_ACCEPTANCE_RICKPANEL_*`. That suite creates and
  deletes accounts and must only see a disposable panel; never point it at this one.

## Run

On a machine that can reach the panel, from a checkout of this branch:

```bash
pnpm install --frozen-lockfile
NEXA_INVENTORY_RICKPANEL_URL='https://<panel-address>' \
NEXA_INVENTORY_RICKPANEL_USERNAME='<admin>' \
NEXA_INVENTORY_RICKPANEL_PASSWORD='<password>' \
NEXA_INVENTORY_KNOWN_USERNAME='<an account on this panel, spelled exactly as the panel spells it>' \
NEXA_INVENTORY_PAGE_SIZE=50 \
NEXA_INVENTORY_DRIFT_TOLERANCE=0 \
pnpm test:acceptance:inventory
```

(`maxAttempts` — how many pairs of walks to try after drift — is 3; it is a harness
input, not a variable, because raising it only hides a panel that never settles.)

Use read-only shell hygiene: put the password in the environment from a secret store, not
in shell history. `NEXA_INVENTORY_DRIFT_TOLERANCE` is how many accounts may appear or
disappear between the two walks (the panel is live); start at 0 and raise it only with a
reason recorded beside the result.

Without the variables the suite **fails**; it never skips.

## What it does (C1 §12 steps)

| §12 step                                                                                      | where                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. a known production-like panel                                                              | the variables                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2. read-only inventory calls only                                                             | `readOnlyRickpanelHttp` + `readGuard`                                                                                                                                                                                                                                                                                                                                                                                                             |
| 3. provider total vs fetched rows vs distinct usernames; pagination coverage; first/last page | `first.reportedTotal`, `rowsFetched`, `distinctUsernames`, `duplicateRows`, `pages`, `firstPageRows`, `lastPageRows`; checks "distinct usernames equal the reported total", "no duplicate rows", "pagination covered the whole list"                                                                                                                                                                                                              |
| 4. re-run, stable set/count within drift                                                      | second walk; `countDrift`, `setDrift`; checks "count/set stable within tolerance", "two consecutive walks identical (indexable)" (EXACT provider-spelling sets, tolerance never relaxes it), "provider total reported and identical on both walks" (a missing total FAILS — the program requires the provider total); after drift a fresh pair is walked (up to 3 attempts, every attempt's drift in `attempts`) and only the last pair is judged |
| 4b. the matcher's own entry point                                                             | `listAll` run after the pair → `matcherInventory`; checks "the matcher's listAll reports a complete inventory", "listAll returns exactly the walked set"                                                                                                                                                                                                                                                                                          |
| 5. exact known username lookup                                                                | `findAccount(known)` (sent as spelled) → `FOUND`, and the EXACT provider spelling present in both walks (a lowercase fold no longer counts)                                                                                                                                                                                                                                                                                                       |
| 6. missing username → clean not-found                                                         | a random `nexa-c1-absent-<hex>` → `NOT_FOUND`                                                                                                                                                                                                                                                                                                                                                                                                     |
| 7. aggregate evidence only                                                                    | the printed `C1 evidence {...}`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 8. every request read-only                                                                    | `readGuard` refuses non-reads (`refusedWrites`); `requestsByKind` counts login / list page / user read; checks "no write was attempted", "every request sent was the login exchange, a list page or a user read"                                                                                                                                                                                                                                  |

The same procedure runs against the fake panel in
`tests/unit/rickpanel-inventory-acceptance.test.ts`, which proves the mechanics (every check
can fail, the guard refuses writes, the report carries no username or secret) and is **not**
evidence about RickPanel.

## Reading the result

- **All checks pass** — record the printed aggregate JSON (it is safe to paste) and the
  panel's version from the panel page in this file under "Results", mark C1 closed and
  `OQ-P5-01`/`OQ-P5-02` answered.
- **`NOT_A_PAGE` on the first page** — the list route or shape differs from the Marzban
  v0.8.4 inference (`OQ-P5-01`). Capture the status and the top-level KEYS of one page (not
  its rows) by hand, correct `rickpanel-inventory.ts` and `tests/support/fake-rickpanel.ts`
  in one commit, re-run.
- **`PAGE_TOO_LONG` / `NO_PROGRESS`** — the panel ignores `limit` / `offset`. Same remedy.
- **"provider total reported…" and "distinct usernames equal the reported total" failing
  with `reportedTotal: null`** — the panel's page carries no `total`. The walk can still
  end on an empty page, but that is not the provider's own count, and C1 is not accepted
  on it: capture the top-level KEYS of one page by hand, find the panel's count (another
  field or route), correct `rickpanel-inventory.ts` and the fake in one commit, re-run.
- **A walk not consistent (`TOTAL_CHANGED` / `COUNT_MISMATCH`), or "two consecutive walks
  identical" failing** — the list moved during or between the walks, or the unsorted order
  is not stable (`OQ-P5-02`). The matcher requires two identical walks (`listAll`). Re-run at a quiet hour; if it
  persists, the walk needs an explicit `sort` the panel accepts.
- **`AUTHENTICATION_FAILED`** — credentials; nothing was read.

## Program 4, Item 2 — the harness against the program, rule by rule (2026-10-04)

| Program requirement                                      | Harness                                                                                                                                                             | Test against the fake (mechanics, not evidence)                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| two consecutive complete walks                           | a pair of `walk`s, each must be consistent (total unchanged, distinct = total, ends on an empty page or the total)                                                  | `rickpanel-inventory-acceptance.test.ts` "passes every check…"                            |
| exact account/username set comparison                    | `setDrift` over EXACT provider spellings; "two consecutive walks identical" requires 0, whatever the tolerance; `listAll` must agree                                | "fails the stability check…", "exercises the matcher's own listAll…"                      |
| provider total                                           | `reportedTotal` on both walks, REQUIRED non-null; "distinct usernames equal the reported total" (both walks), "provider total reported and identical on both walks" | "passes every check…"                                                                     |
| fetched / distinct counts                                | `rowsFetched`, `distinctUsernames`, `duplicateRows`, `pages`, first/last page rows                                                                                  | "passes every check…"                                                                     |
| known lookup                                             | `findAccount` exactly as spelled → FOUND, and present by exact spelling in both walks                                                                               | "matches the known account by its EXACT provider spelling…", "fails the lookup check…"    |
| missing lookup                                           | random `nexa-c1-absent-<hex>` → NOT_FOUND                                                                                                                           | "passes every check…"                                                                     |
| every request read-only                                  | `readGuard` refuses, counts by kind; the fake panel's own request log is the independent observer                                                                   | "every request the panel itself saw was a read…", "the guard refuses…"                    |
| drift ⇒ retry/document, never claim completeness falsely | up to 3 pairs, each attempt's drift reported; a differing pair never passes                                                                                         | "walks a fresh pair after drift…", "never calls a panel complete while it keeps drifting" |

Gaps closed in this pass, each by a test written first and failing: no retry after
drift, `listAll` (what the matcher indexes) never exercised, the known name matched by a
lowercase fold instead of its exact spelling, and no per-kind request evidence.

## G6 — the list-shape probe (read-only, bounded, on staging)

**Status: NOT RUN against a real panel.** Tested against the fake list only
(`tests/unit/rickpanel-g6-probe.test.ts`), which proves the mechanics and the classification —
not RickPanel.

The per-name resolution (`docs/rickpanel-inventory.md` §Per-name resolution) rests on four
facts inferred from Marzban v0.8.4: the list's `{users, total}` shape and its `total`, a page
cap, `created_at` on every row in insertion order, and one order that no offset or limit
changes. When a dry run leaves every needed name unresolved, its diagnostics say which walk
condition failed; G6 answers whether the PANEL can meet them at all, without a dry run.

**Why a CLI and not the C1 harness.** G6 runs where the panel and its stored credential already
are — the staging installation — from the runtime image (`node dist/rickpanel-probe.cli.js`,
checked by `pnpm check:runtime`), with no checkout, no devDependencies and no password in a
shell. It reads the panel's STORED credential through the importer's own protected read
(`RickpanelInventorySource.withReadSession`), so it inherits every load rule a dry run has.

### Safety

- **Read-only.** It sends the token exchange and `GET api/users?offset=&limit=` and nothing
  else — no user lookup, no subscription fetch, no write. The read-only guard refuses anything
  else before sending; the report counts what reached the wire by kind (`wire`), and the exit
  code is 4 if anything but those two was sent or attempted.
- **Paced and gated like a dry run.** One request in flight, at least
  `RICKPANEL_INVENTORY_REQUEST_INTERVAL_MS` apart (default 1 s; production refuses < 250 ms),
  longer after a slow answer; one login; the bounded retry budget; and the installation-wide
  panel read gate — it waits behind a dry run's read of the same panel, and a dry run waits
  behind it.
- **Bounded.** Hard caps on list pages (`--max-pages`, default 400, at most 5 000) and wall time
  (`--max-minutes`, default 20, at most 90), checked before every request. A probe stopped by a
  cap says so (`budget.stoppedBy`) and is `INCONCLUSIVE`, never a pass.
- **No sales stop needed.** Selling during the probe is measured (`CHURN`, per minute), not a
  failure. Use a read-only admin on the panel if RickPanel has one.
- **Aggregate-only output.** One line of JSON: counts, milliseconds and closed codes. No name,
  row, `created_at` value, token or address (tested).

### Run

On the staging server, inside the api container (the panel must already be a NEXA panel of the
tenant, with its credential saved):

```bash
C='sudo docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml'
$C exec -T api node dist/rickpanel-probe.cli.js --panel <panel-id> > g6.json; echo "exit=$?"
# options: --tenant <slug> --page-size <n> --walks 2|3 --max-pages <n> --max-minutes <n>
```

(`<panel-id>` is the NEXA panel's id from «پنل‌ها»; the same compose invocation as
`docs/backup.md`.)

From a development checkout: `pnpm rickpanel-probe:dev --panel <panel-id>`.

Cost at the defaults (page size 100, overlap 10, 1 s): 1 login + 3 sample pages + 3 walks of
⌈N / 90⌉ pages — 10 000 accounts ≈ 337 requests ≈ 6 min; 33 000 ≈ 1 104 requests, which the
default `--max-pages 400` refuses: raise it to `--max-pages 1200 --max-minutes 25`, or use
`--walks 2` (≈ 740 requests, ≈ 13 min).

### What it reports

`verdict` (`G6_HOLDS` / `G6_FAILS` / `INCONCLUSIVE`) and `findings`, a closed set:
`NOT_A_PAGE`, `NO_TOTAL`, `TOTAL_INCONSISTENT`, `PAGE_CAP` (informational), `CREATED_AT_MISSING`,
`CREATED_AT_UNPARSABLE`, `CREATED_AT_EPOCH`, `CREATED_AT_OUT_OF_ORDER`,
`ORDER_UNSTABLE_SAME_OFFSET` (offset 0 fetched twice, other order), `ROWS_CHANGED_SAME_OFFSET`
(informational: the list moved between the two requests),
`ORDER_UNSTABLE_OTHER_LIMIT` (an overlapping page asked with another `limit` put a shared row
elsewhere; shared rows all moved by one offset are churn, reported `SHIFTED`, not a finding), `CHURN` (informational), `NO_GAP_FREE_WALK`, `WALKS_ORDER_DIFFERS`,
`NO_DECISIVE_WALK`. Beside them: `shape` (list shape, rows of the first page, learned cap),
`total` (pages with and without one, first, last, largest change), `createdAt` on the sample page,
`order`, each walk's full gap-free breakdown (the dry run's own per-walk diagnostics), `churn`
(duration, total change, accounts added and removed per minute), `budget`, `wire`, `load`.

`G6_HOLDS` needs what settles a dry run — a decisive walk with a later one, and the last walk
decisive — and no finding but the informational ones. A `NOT_A_PAGE` list is `G6_FAILS`. Exit:
0 holds · 1 fails · 2 usage · 3 inconclusive (a failure, a cap, no such panel or credential) ·
4 not read-only (a defect).

### Reading the result

- **`CREATED_AT_*` or `NO_TOTAL`** — the per-name resolution cannot prove completeness on this
  panel; no retry mends it. Record the JSON here and decide the remedy (a sort the panel
  accepts, another field, a stopped-sales window) as an owner decision — do not relax the rule.
- **`ORDER_UNSTABLE_*` / `WALKS_ORDER_DIFFERS`** — the list has no stable order; same.
- **`NO_DECISIVE_WALK` with only `CHURN`** — the panel churned harder than the overlap absorbs
  (look at `chainBreaks`: `NO_COMMON_ROW` is a deletion burst); run again at a quieter hour.
- **`G6_HOLDS`** — record the JSON and the panel version below; the four inferred facts hold on
  this panel at this size.

## Results

_None yet. MANUAL ACCEPTANCE, NOT RUN — no RickPanel credentials in this environment._
