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
- Requests made: one token exchange per walk/lookup, `GET /api/users?offset=&limit=` per
  page, `GET /api/user/{name}` twice. No create, modify, revoke, delete, files read or
  subscription fetch.
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
NEXA_INVENTORY_KNOWN_USERNAME='<an account you know is on this panel>' \
NEXA_INVENTORY_PAGE_SIZE=50 \
NEXA_INVENTORY_DRIFT_TOLERANCE=0 \
pnpm test:acceptance:inventory
```

Use read-only shell hygiene: put the password in the environment from a secret store, not
in shell history. `NEXA_INVENTORY_DRIFT_TOLERANCE` is how many accounts may appear or
disappear between the two walks (the panel is live); start at 0 and raise it only with a
reason recorded beside the result.

Without the variables the suite **fails**; it never skips.

## What it does (C1 §12 steps)

| §12 step                                                                                      | where                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. a known production-like panel                                                              | the variables                                                                                                                                                                                                                        |
| 2. read-only inventory calls only                                                             | `readOnlyRickpanelHttp` + `readGuard`                                                                                                                                                                                                |
| 3. provider total vs fetched rows vs distinct usernames; pagination coverage; first/last page | `first.reportedTotal`, `rowsFetched`, `distinctUsernames`, `duplicateRows`, `pages`, `firstPageRows`, `lastPageRows`; checks "distinct usernames equal the reported total", "no duplicate rows", "pagination covered the whole list" |
| 4. re-run, stable set/count within drift                                                      | second walk; `countDrift`, `setDrift`; checks "count/set stable within tolerance"                                                                                                                                                    |
| 5. exact known username lookup                                                                | `findAccount(lower(known))` → `FOUND`, and present in the inventory                                                                                                                                                                  |
| 6. missing username → clean not-found                                                         | a random `nexa-c1-absent-<hex>` → `NOT_FOUND`                                                                                                                                                                                        |
| 7. aggregate evidence only                                                                    | the printed `C1 evidence {...}`                                                                                                                                                                                                      |

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
- **`complete: false` (`TOTAL_CHANGED` / `COUNT_MISMATCH`)** — the list moved during the
  walk, or the unsorted order is not stable (`OQ-P5-02`). Re-run at a quiet hour; if it
  persists, the walk needs an explicit `sort` the panel accepts.
- **`AUTHENTICATION_FAILED`** — credentials; nothing was read.

## Results

_None yet._
