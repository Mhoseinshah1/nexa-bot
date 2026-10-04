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

| §12 step                                                                                      | where                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. a known production-like panel                                                              | the variables                                                                                                                                                                                                                                                                                                                                                      |
| 2. read-only inventory calls only                                                             | `readOnlyRickpanelHttp` + `readGuard`                                                                                                                                                                                                                                                                                                                              |
| 3. provider total vs fetched rows vs distinct usernames; pagination coverage; first/last page | `first.reportedTotal`, `rowsFetched`, `distinctUsernames`, `duplicateRows`, `pages`, `firstPageRows`, `lastPageRows`; checks "distinct usernames equal the reported total", "no duplicate rows", "pagination covered the whole list"                                                                                                                               |
| 4. re-run, stable set/count within drift                                                      | second walk; `countDrift`, `setDrift`; checks "count/set stable within tolerance", "two consecutive walks identical (indexable)" (EXACT provider-spelling sets, tolerance never relaxes it), "provider total identical on both walks"; after drift a fresh pair is walked (up to 3 attempts, every attempt's drift in `attempts`) and only the last pair is judged |
| 4b. the matcher's own entry point                                                             | `listAll` run after the pair → `matcherInventory`; checks "the matcher's listAll reports a complete inventory", "listAll returns exactly the walked set"                                                                                                                                                                                                           |
| 5. exact known username lookup                                                                | `findAccount(known)` (sent as spelled) → `FOUND`, and the EXACT provider spelling present in both walks (a lowercase fold no longer counts)                                                                                                                                                                                                                        |
| 6. missing username → clean not-found                                                         | a random `nexa-c1-absent-<hex>` → `NOT_FOUND`                                                                                                                                                                                                                                                                                                                      |
| 7. aggregate evidence only                                                                    | the printed `C1 evidence {...}`                                                                                                                                                                                                                                                                                                                                    |
| 8. every request read-only                                                                    | `readGuard` refuses non-reads (`refusedWrites`); `requestsByKind` counts login / list page / user read; checks "no write was attempted", "every request sent was the login exchange, a list page or a user read"                                                                                                                                                   |

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
- **A walk not consistent (`TOTAL_CHANGED` / `COUNT_MISMATCH`), or "two consecutive walks
  identical" failing** — the list moved during or between the walks, or the unsorted order
  is not stable (`OQ-P5-02`). The matcher requires two identical walks (`listAll`). Re-run at a quiet hour; if it
  persists, the walk needs an explicit `sort` the panel accepts.
- **`AUTHENTICATION_FAILED`** — credentials; nothing was read.

## Program 4, Item 2 — the harness against the program, rule by rule (2026-10-04)

| Program requirement                                      | Harness                                                                                                                              | Test against the fake (mechanics, not evidence)                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| two consecutive complete walks                           | a pair of `walk`s, each must be consistent (total unchanged, distinct = total, ends on an empty page or the total)                   | `rickpanel-inventory-acceptance.test.ts` "passes every check…"                            |
| exact account/username set comparison                    | `setDrift` over EXACT provider spellings; "two consecutive walks identical" requires 0, whatever the tolerance; `listAll` must agree | "fails the stability check…", "exercises the matcher's own listAll…"                      |
| provider total                                           | `reportedTotal` on both walks; "distinct usernames equal the reported total", "provider total identical on both walks"               | "passes every check…"                                                                     |
| fetched / distinct counts                                | `rowsFetched`, `distinctUsernames`, `duplicateRows`, `pages`, first/last page rows                                                   | "passes every check…"                                                                     |
| known lookup                                             | `findAccount` exactly as spelled → FOUND, and present by exact spelling in both walks                                                | "matches the known account by its EXACT provider spelling…", "fails the lookup check…"    |
| missing lookup                                           | random `nexa-c1-absent-<hex>` → NOT_FOUND                                                                                            | "passes every check…"                                                                     |
| every request read-only                                  | `readGuard` refuses, counts by kind; the fake panel's own request log is the independent observer                                    | "every request the panel itself saw was a read…", "the guard refuses…"                    |
| drift ⇒ retry/document, never claim completeness falsely | up to 3 pairs, each attempt's drift reported; a differing pair never passes                                                          | "walks a fresh pair after drift…", "never calls a panel complete while it keeps drifting" |

Gaps closed in this pass, each by a test written first and failing: no retry after
drift, `listAll` (what the matcher indexes) never exercised, the known name matched by a
lowercase fold instead of its exact spelling, and no per-kind request evidence.

## Results

_None yet. MANUAL ACCEPTANCE, NOT RUN — no RickPanel credentials in this environment._
