# RickPanel read-only inventory (Migration P5)

What legacy-migration discovery needs from a live RickPanel: every account on it, one
account by exact lowercase username, and each account's usage, expiry and state. The
P6 adoption write path and the P7 importer are on HOLD; this is the read side they will
stand on.

Code:

- `apps/api/src/modules/platform/providers/infrastructure/rickpanel-inventory.ts` — the
  read-only client and the inventory reader.
- `apps/api/src/modules/platform/providers/infrastructure/rickpanel-protocol.ts` — the
  token exchange, routes and failure taxonomy, extracted from the adapter so the inventory
  can authenticate without importing it (one implementation, two callers).
- `apps/api/src/modules/platform/legacy-import/application/legacy-service-matching.ts` —
  the pure matching rule.

## Mutation is impossible by construction

The inventory never holds a `ProviderHttpClient` and never imports `RickpanelAdapter`. It
holds a `RickpanelReadOnlyHttp` — a frozen object with exactly three methods, each sending
one fixed request shape:

| method                                 | request                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `exchangeToken(form)`                  | `POST api/admin/token` (form; `effect: READ` — a session, no account change) |
| `listUsersPage(bearer, offset, limit)` | `GET api/users?offset=&limit=`                                               |
| `readUser(bearer, username)`           | `GET api/user/{username}`                                                    |

No caller-supplied method, path or body can make any of them a write.
`tests/unit/rickpanel-inventory.test.ts` asserts it three ways: on the type
(`@ts-expect-error` for `send` and for widening to `ProviderHttpClient`), on the source
(no adapter import, no `PUT`/`DELETE`/`PATCH`, exactly one `POST` and it is the token
exchange), and on the wire (every request the fake panel received is a `GET` or the token
exchange; zero creates, modifies, revokes).

An account never carries a subscription link, a subscription token or a generated proxy
credential — discovery has no use for them (tested). One opt-in exists, for the legacy
importer only: `listAll(…, { subscriptionLinks: true })` returns, BESIDE the accounts, a
map of exact provider spelling → the link `subscriptionFrom` derives from the same list row
(or null). `subscriptionFrom` lives in `rickpanel-protocol.ts`, shared with the adapter
(which re-exports it), so the inventory derives a link exactly as `lookupUser` does without
importing the adapter, and with no request of its own (tested against `lookupUser`).

## Pagination

Offset pagination over `GET api/users` (shape: `OQ-P5-01`).

- `offset` advances by rows **received**, not by `limit`, so a panel that caps page size
  loses nothing.
- The walk ends on an **empty page**, or once `offset` reaches the reported `total` —
  never on a merely short page.
- Bounded: `maxPages` (default 5 000), `NO_PROGRESS` when a non-empty page holds only
  names already seen (a panel ignoring `offset`), `PAGE_TOO_LONG` when a page exceeds
  `limit` (a panel ignoring it), `NOT_A_PAGE` for any body that is not
  `{users: [...], total?: N}`, `TOTAL_INCONSISTENT`, `INVALID_ROW`.
- Rows are keyed by the EXACT provider spelling and a repeated one is counted once
  (`duplicateRows`). `Alice` and `alice` are two accounts, not a duplicate.
- **One walk is never "complete".** `walk()` answers only `consistent: true|false` — the
  reported total held and the distinct names add up to it (else `TOTAL_CHANGED` /
  `COUNT_MISMATCH`). That is not coverage: a deletion before the cursor plus an append
  after it keeps both the total and the count while shifting an unseen row behind the
  cursor (delete A, append K: the page at offset 5 starts at G, F is never returned, and
  the count is still 10 — Codex P1 on #169, reproduced in the tests).
- **`listAll()` is what the matcher may use**: two consecutive walks, `complete: true` only
  when both are consistent AND their exact username sets are identical; otherwise
  `complete: false` with a closed reason (`TOTAL_CHANGED`, `COUNT_MISMATCH`,
  `WALKS_DIFFER`). `inventoryIndex()` accepts only that, so a single walk cannot be indexed
  (by type) and an incomplete inventory makes every dependent decision `UNDECIDABLE` — unless
  the Web Admin importer decides the needed names one by one (§Per-name resolution below).

Tested: first page, multiple pages with a short final page (not omitted), exact multiple
(no wasted request), empty panel, no total (ends on empty page), capped page size, offset
ignored, limit ignored, bare array, page bound, deletion mid-walk, reorder mid-walk,
delete-A/append-K (one walk misses F; `listAll` says `WALKS_DIFFER`), a quiet panel
(complete), and two spellings of one name kept apart.
Mutation-checked: advancing by `limit`, stopping on a short page, removing the
no-progress stop, and dropping the two-walk comparison each fail a named case.

## Load protection (owner requirement, PR #281)

A migration reads EVERY account of a production panel, twice, and a panel serving customers
must not feel it. `RickpanelInventorySource` (the only caller of `listAll` in the importer,
the CLI and the rehearsal walk) puts two things UNDER the reader, at its read-only HTTP
surface — the reader itself, and so every rule above, is unchanged:

- **`PanelReadGate`** — one read of a panel at a time in the whole installation: a session
  advisory lock (`pg_try_advisory_lock`, class `RI`) keyed by the panel's ORIGIN (two panel rows
  can point at one machine), on a connection of its own for the length of the read. A second
  job — another dry run, the CLI, another replica — waits its turn, polling every 2 s, and its
  wait ends on its step signal. A holder that dies loses the lock with its session.
- **`protectedReadSession`** — inside the read:
  - one request in flight (the reader awaits each), at least `requestIntervalMs` between the
    STARTS of two requests (`RICKPANEL_INVENTORY_REQUEST_INTERVAL_MS`, default 1000; production
    refuses less than 250), the first a full interval after the lock was taken; after an answer
    slower than 2 s, as long again before the next request (≤ 30 s) — a struggling panel is
    asked at most half the time;
  - ONE login per read: a successful token exchange is reused by every later walk and attempt
    of that read, held in that read's closure only. A 401 on a page (the token expired) buys
    one fresh login and the same page again; a refused login is never asked again;
  - a 429 waits the panel's `Retry-After` (delta-seconds or an HTTP date); one asking for more
    than 2 minutes is not asked again. A timeout, an unreachable panel or a 5xx waits 2 / 5 / 15
    / 30 s. Every retry of the read — pages and logins — draws on ONE budget of 4, so retries
    cannot multiply; the source starts another double walk only when the answer was
    INCOMPLETE (the panel moved), never after a failure. A 4xx, a page-shape fault, an
    oversized or malformed answer, a TLS failure or a blocked target is final;
  - the step's signal (a lost lease, a cancelled job) and a lost gate lease stop the read
    before its next request and end every wait.

The page size is `limit` on the one list route there is; no batch endpoint is assumed. The
reader's own bound is 200; the Web Admin asks `RICKPANEL_INVENTORY_PAGE_SIZE` (default 100)
because a page larger than `PANEL_HTTP_MAX_RESPONSE_BYTES` (512 KiB) fails the read and
RickPanel's row size is unmeasured. A panel that caps pages lower loses nothing.

Each read reports `diagnostics.load`: requests, logins, token reuses, token refreshes,
retries, time waited, time queued for the gate, duration, page size and the largest page in
bytes. Counts and milliseconds only — never a token, a credential, a name or a row.

What it costs a panel of N accounts at page size P and interval I (the defaults, P = 100,
I = 1 s): 1 login + 2 × ⌈N / P⌉ pages, one at a time, so ≈ (1 + 2⌈N/P⌉) × I per complete read
— 10 000 accounts: 201 requests, ≈ 3.4 min; 30 000: 601, ≈ 10 min; 50 000: 1 001, ≈ 17 min —
longer when the panel answers slower than I. An incomplete read is walked again at most twice
more (Web Admin only), after 15 s and 45 s.

Tested: `tests/unit/rickpanel-load-protection.test.ts` (a large inventory paged and paced,
one in flight, a slow panel, two concurrent jobs, login reuse and refresh, 429 and the budget,
cancellation while paced and while queued, nothing sensitive reported),
`tests/unit/nxpkg-inventory-completeness.test.ts`, `tests/integration/panel-read-gate.test.ts`
(across sessions, a cancelled waiter, a dead holder) and `tests/integration/nxpkg-importer.test.ts`
(a paced read plans exactly what an unpaced one does).

## Canonical username

ASCII lowercase (§11: duplicates `(code_panel, lower(username))` = 0, mixed-case = 0 in
the legacy audit). One definition, `canonicalLegacyUsername`, used by both the inventory
and the matcher. A name that is empty, longer than 128 or outside printable ASCII is not
compared. The lowercase name is the matching KEY only: every account also keeps
`providerUsername`, the panel's exact spelling, and the index maps each key to every
spelling that folds to it. `findAccount` sends the name exactly as given and refuses a
record whose name folds to a different key.

## Matching

`matchLegacyService(row, policy, inventories)`:

| legacy `code_panel`                                          | rule                                                       | outcome                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------- |
| a declared test panel (checked FIRST, whatever the username) | —                                                          | `SKIPPED TEST_PANEL`                                           |
| in the explicit `code_panel → NEXA panel` map                | `lower(username)` in THAT panel's complete inventory       | `ELIGIBLE` / `MANUAL_REVIEW PROVIDER_MISSING`                  |
| null or empty (owner decision 8, Mirza PR5)                  | **never searched**                                         | `NO_PANEL` (review; adopted only by an explicit approval)      |
| declared missing (the map's `missingPanels`)                 | exact lowercase username across every production RickPanel | 1 → `ELIGIBLE`; 0 → `PROVIDER_MISSING`; >1 → `AMBIGUOUS_PANEL` |
| anything else                                                | not searched                                               | `MANUAL_REVIEW PANEL_UNMAPPED`                                 |

A panel the decision depends on without a COMPLETE inventory gives `UNDECIDABLE`, never
`PROVIDER_MISSING` — zero matches in a partial walk is not absence. A row with NO panel is
never searched since Mirza PR5 (owner decision 8, `docs/legacy-migration/service-review.md`):
an operator's explicit approval naming a mapped panel is the only way it is matched
(`matchOnPanel`, the mapped-code rules on that one panel). For a declared-missing panel the
available inventories are scanned first: two known holders are `AMBIGUOUS_PANEL` whatever an
unavailable panel might add; only while zero or one holder is known does an unavailable
inventory make it `UNDECIDABLE`. A key that folds to two or more spellings on the holding
panel is `MANUAL_REVIEW USERNAME_CASE_COLLISION`, never eligible. `ELIGIBLE` carries
`providerUsername`, the panel's exact spelling, which is what an adoption stores (C3). No inbound id, no fuzzy
or prefix match (tested, including a source assertion). Reason names match Migration P4's
`LEGACY_IMPORT_REASON_CODES`; `USERNAME_CASE_COLLISION` joins that contract set when P4 is
restacked.

## Per-name resolution (a panel that keeps selling)

Owner requirement: a Mirza `.nxpkg` dry run must be approvable while Mirza keeps selling on the
live RickPanel. A production panel serving customers changes between the two walks of `listAll()`
as a matter of course, so `complete: false` (`TOTAL_CHANGED`, `COUNT_MISMATCH`, `WALKS_DIFFER`)
is the normal answer, and it used to leave every backup candidate on that panel
`INVENTORY_INCOMPLETE` and the dry run unapprovable. The question the backup asks is narrower
than "what is on the panel": it is "is each of THESE usernames on it, and how is it spelled".
So, when the two walks are not one complete snapshot, each username the backup needs on that
panel (canonical, lowercase) is decided on its own evidence, in this order:

1. **Two spellings anywhere** — the name folds to two or more exact spellings in the UNION of
   both walks: a collision (`USERNAME_CASE_COLLISION`), never eligible. A union, because a
   spelling seen once was on the panel at some moment.
2. **One spelling in BOTH walks** — present, with that spelling. A name seen in one walk only
   may have been deleted or created mid-read, so it is not decided by the walks.
3. **Anything else** — one exact lookup, `GET api/user/{username}` (`USER_PATH`, the route the
   RickPanel adapter's `lookupUser` already reads), on the same protected read session: one
   request in flight, the same pacing, the same login and the same retry budget as the walks.
   Found (a record whose name folds to the needed key): **present**, with the panel's spelling.
   404: **proven absent** (`PROVIDER_MISSING` is then a fact, not an inference from a partial
   walk). Anything else — a timeout, a 429 past its budget, a 5xx, a malformed body, the read's
   end — **unresolved**. Lookups go in name order, at most `RICKPANEL_INVENTORY_MAX_LOOKUPS`
   per panel read (default 5 000 ≈ 83 min at one a second), and none after the first that
   did not answer — a struggling panel is not asked again thousands of times. A name beyond
   the bound or after that stop is unresolved, never guessed. A name no walk saw is asked by
   its canonical (lowercase) spelling; RickPanel matching it case-sensitively, an account
   spelled otherwise answers 404 and is reported missing — manual review, never created.

Accounts on the panel that are not in the backup are ignored: they decide nothing and are never
looked up. Such a read is reported `complete: true` with a `resolution` (`mode: 'TARGETED'`, the
reason, and the counts `needed`, `presentByWalks`, `presentByLookup`, `absentByLookup`,
`collisions`, `unresolved`, `lookups`) — counts only, never a name — and the index it builds
covers ONLY the needed names: any other name asked of that panel is `UNDECIDABLE`, never
"missing" (`PanelInventoryIndex.covered`).

**An unresolved name blocks approval.** Its invoice stays services `INVENTORY_INCOMPLETE`, and
`legacyMigrationDryRunInventoryIncomplete` refuses a production-like approval while any is
counted. The dry run reports `PROVIDER_INVENTORY_CHURN` (informational) and, when non-zero,
`PROVIDER_INVENTORY_LOOKUPS` and `PROVIDER_INVENTORY_UNRESOLVED`. The remedy is to run the dry
run again, not to stop selling. A panel whose read FAILED (credentials, unreachable, timeouts) is
still `PROVIDER_INVENTORY_INCOMPLETE`, unchanged.

Scope: the Web Admin `.nxpkg` importer only. The CLI and the rehearsal walk are unchanged: they
read with `listAll()` and treat anything but one complete snapshot as before.

Not run against a real panel: `GET api/user/{username}` is exercised by the adapter's
`lookupUser`, but its use by the inventory has no real-panel evidence yet (gate G6 open,
`docs/legacy-migration/readiness-record.md`; runbook `docs/rickpanel-inventory-acceptance.md`).

## Real-panel acceptance

Not run: no RickPanel credentials exist in this environment. See
`docs/rickpanel-inventory-acceptance.md` (Item C1).
