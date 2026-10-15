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
longer when the panel answers slower than I. The Web Admin's read is TARGETED (§Per-name
resolution): its pages step by `limit − overlap` (≈ 11% more pages at the defaults), it sends NO
exact lookup, and it walks a third time when the first two do not settle every name (a walk
broken by a burst of deletions needs a gap-free walk AND one after it). A synthetic
100 000-account panel with 77 000 needed names, sales, single deletions in every walk and
15-row deletion bursts during the first cost 3 331 requests (1 login, 3 330 pages over three
walks), ≈ 56 min; without the bursts, two walks. With bursts in every walk, three
walks (3 316 pages) and every name unresolved. A non-targeted read (the
CLI, the rehearsal) reads once; one built with `inventoryAttempts` > 1 walks again at most twice more, after 15 s and 45 s.

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
So, when the two walks are not one complete snapshot because the panel MOVED (`TOTAL_CHANGED`,
or two consistent walks that differ, `WALKS_DIFFER`), each username the backup needs on that
panel (canonical, lowercase) is decided on its own — from the walks alone, and only when the
last walk is a proven snapshot. A `COUNT_MISMATCH` with FEWER distinct names than a total that
held still is not churn: the list is withholding rows, and that panel stays incomplete, exactly
as before. (More names than the total is churn — a row read, then deleted, while a sale was
appended — and is decided like any moving panel.)

The names needed are those of live, real (`is_test = 0`) invoices whose owner the plan imports
(`importableLegacyUserIds`, pinned to the plan's own rule by a test), on their mapped panel; a
declared-missing code asks every production panel; an operator's ADOPT asks its panel; an
invoice with an empty `code_panel` and no ADOPT yet asks every production panel too — the holders
found are the panels an operator may be offered for that first ADOPT. An invoice the operator
kept as history asks nothing: the import never acts on it. Each
carries the backup's exact spelling (null when two invoices spell it differently).

**Gap-free walks.** Offset pagination can skip a row only at a page boundary, when rows ahead of
the cursor change between two page requests. The per-name resolution walks with OVERLAPPING
pages — each page starts `INVENTORY_WALK_OVERLAP` (10; at most a quarter of the page, and of a
learned cap) rows before the previous one ended — and calls a walk **gap-free** only when ALL of
these hold, each checked on the rows themselves:

- **One order, verified.** Every row carries `created_at`, and the rows come oldest first: the
  list is the panel's insertion order, which no offset or limit changes. Marzban's list has no
  `ORDER BY`; its natural order is insertion order on SQLite and MySQL/InnoDB — but here it is
  not assumed: a row without `created_at`, or out of order, voids the walk's proof. (Reviewer
  F1: a deterministic order that differs by offset defeated every check short of this.)
- **Every boundary chained.** The next page shares at least one row — the same name AND the same
  creation time, so a row deleted and created again is not mistaken for the one seen — with the
  previous page, in the same relative order. It then starts at or before that row: nothing
  after it was skipped. Up to 9 deletions between two page requests (one second apart) are
  absorbed.
- **No insertion ahead of the cursor missed.** The first shared row moved by (insertions −
  deletions) ahead of it; insertions that landed in this page before it are rows this page
  shows fresh. More movement than that is an inserted row the walk skipped (Codex: a case
  variant created mid-walk) — the chain breaks. In insertion order a new account is appended,
  so selling never trips this; a row withheld from a page shifts every later index and does.
- **Every row accounted for.** No row twice in one page, and a row the walk had already received
  must be one of the previous page's (the overlap). A row returned again anywhere else stands
  in a position another account should hold — the second review's case of a tied `ORDER BY`, or
  a bulk import with one `created_at` for every row, where a variant was replaced by a row
  already seen.
- **No false cap, no short page before the end.** A first page shorter than asked, of a longer
  list, teaches a cap; a later page longer than it breaks the chain (a withheld row, not a cap).
- **Ended at its own total.** The walk ends on a page shorter than the limit whose end is
  exactly the `total` that same response reported — never on a `total` alone, which Marzban
  counts in another statement.

The two walks must also agree on one relative order. A gap-free walk returned every account the
panel held as of its end — a snapshot, taken while the panel kept selling.

**Gap-free is not survival** (Codex P1). A gap-free walk misses no row, but a row it read early
may be deleted before it ends — and an account deleted mid-read must never be called present.
No check inside one walk sees every such deletion: a deletion behind the cursor is offset by an
account listed at the head, or by a tie of `created_at` reordered between two requests (the
independent review's F1 and F3), and the walk looks exactly like a still panel. (Two walks that
share no row at all prove no common order either.) So survival is
proven only ACROSS walks: a row is confirmed when a LATER walk returns the same row — the same
name AND the same `created_at`, so an account deleted and created again under that name confirms
nothing. Seen again, it existed from its read, past the earlier walk's end, to the later read.

**Decisions, as of the DECISION walk's end.** A decision walk is gap-free, agrees with a
neighbouring walk on one relative order, and has a walk after it. Of those, the one leaving the
fewest names undecided is chosen (the latest on a tie). The read is settled when it leaves none
AND the last walk is decisive too (gap-free and in one order with the walk before it) — so every
spelling that still exists as the read ends was
seen and counts toward a collision. Until then the panel is walked again — at most
`TARGETED_MAX_WALKS` (3) walks; a panel that only sells settles on two. Reaching the cap with
the last walk NOT decisive, no name is present on one spelling, nor absent: a case variant or an account that walk skipped may exist as the read ends (the second review's R3; Codex), so each would-be present or absent name is unresolved. Then:

1. **Two spellings anywhere** — the name folds to two or more exact spellings in the UNION of all
   walks: a collision (`USERNAME_CASE_COLLISION`), never eligible.
2. **One spelling in the decision walk, the same row in a later walk** — present, with that
   spelling (the backup's, or the one account there is, exactly as a complete read decides it),
   unless any walk from the decision walk on returned that spelling with ANOTHER creation time:
   the name was deleted and created again, and the account it now holds is another account,
   possibly another customer's (the second review's R1, R2) — unresolved. A walk records every
   creation time it saw per spelling, not only the first.
3. **No spelling in the decision walk, and none later** — absent (`PROVIDER_MISSING`, manual
   review; never a created account). Likewise a spelling the decision walk read that no later
   walk returned, when a later gap-free walk returned no spelling of it at all: deleted.
4. **Anything else** — no decision walk, a row neither confirmed nor shown gone (a later walk
   returned it with another creation time, or no later walk was gap-free), a name the decision
   walk lacked that a later walk returned, or a name the backup spells two ways —
   **unresolved**. Never adopted, never "missing".

Two walks that are one complete snapshot (the `listAll` rule: both consistent, the same names)
are still read as one, but as of the FIRST walk's end, and only when the second returned every
row unchanged — one `created_at` per row in each walk, the same in both — which is what proves
each row survived that moment. Its runtime facts are the second walk's (fresher), stamped with the first walk's end.

**No exact lookup is sent.** A lookup (`GET api/user/{name}`) happens after a walk — exactly when
a case variant can appear unseen — and a 404 for one spelling says nothing about another. So a
404 is never evidence here, and the decisions do not depend on the panel's case semantics,
which are unverified (Marzban v0.8.4: case-insensitive and unique on SQLite NOCASE; coexisting
variants with exact lookups on MySQL `utf8mb4_bin`; RickPanel's backend is unknown).

Accounts on the panel that are not in the backup are ignored: they decide nothing and are never
indexed. A panel the backup asks nothing of is not read at all (`NOTHING_NEEDED`, never reported
as churn). Runtime facts (usage, state, link) of a present account come from the LATEST walk that returned the same row, so a link rotated between the walks is the current one; they are stamped with the decision walk's end (never later than the facts). Such a
read is reported `complete: true` with a `resolution` (`mode: 'TARGETED'`, the reason, and the
counts `needed`, `present`, `absent`, `collisions`, `unresolved`, `walks`, `gapFree`) — counts
only, never a name — and the index it builds covers ONLY the needed names: any other name asked
of that panel is `UNDECIDABLE`, never "missing" (`PanelInventoryIndex.covered`).

**An unresolved name blocks approval.** Its invoice stays services `INVENTORY_INCOMPLETE`, and
the plan reports that panel `complete: false`, reason `UNRESOLVED` (its partial index still
decides the names it covers) — so every consumer of `complete` reads it as not fully read: the
dry run's `PROVIDER_INVENTORY_INCOMPLETE:UNRESOLVED`, the TARGET precheck, the import's own gate,
reconcile and the final report. `legacyMigrationDryRunInventoryIncomplete` refuses a
production-like approval while any is counted. The dry run reports `PROVIDER_INVENTORY_CHURN`
(informational) and, when non-zero, `PROVIDER_INVENTORY_UNRESOLVED`. The remedy is to run the dry
run again, not to stop selling. A panel whose read FAILED (credentials, unreachable, timeouts)
is still `PROVIDER_INVENTORY_INCOMPLETE`, unchanged.

Residual risks, stated rather than hidden:

- **A row inserted and another deleted ahead of the cursor in the same interval.** The shared
  row's movement nets them out, so the inserted row could go unseen. In insertion order (the
  only order that is gap-free) a new account is appended, never inserted ahead of the cursor; a
  panel that inserted elsewhere would show rows out of `created_at` order. What remains is a
  panel whose rows are in insertion order yet that lists a new one mid-list — not a Marzban
  behaviour.
- **Accounts created in the same second.** `created_at` ties are allowed (non-decreasing); their
  relative order is the panel's. A tie permuted between two requests either repeats a row
  (detected: every row accounted for), or swaps rows inside an overlap (detected: chained order),
  or swaps rows that both stay inside one page (harmless: none is skipped).
- **A deletion of a name the decision walk never read, offset within one walk.** A row is
  skipped only when rows ahead of the cursor shift between two requests; in insertion order with
  no ties that breaks the chain. A tie reordered across the cursor, together with a deletion
  behind it, could still skip a row unseen — then a needed name is called absent (manual
  review), never present, and only if no later walk returns it either.
- **Bursts in two walks.** A gap-free walk needs one after it, so bursts in the first two walks
  leave the third without confirmation: every name of that panel is unresolved (run the dry run
  again).
- **Re-created within the second it was first created.** A row's identity across pages and
  walks is its name and `created_at`; a panel that stamps whole seconds cannot tell an account
  from one deleted and created again under its name in the SAME second as the original. Only an
  account created during the read itself can be re-created that quickly; one the backup names
  predates the read by far.
- **Survival to the end of the read.** A sighting in a later walk proves an account survived the decision walk's end, never that it survived the later walk too: that would need yet another walk, and so on. Like any read, this one is a statement about a past moment; the import's own read is a second, later look, and a changed decision fails it (`DRY_RUN_MISMATCH`, nothing written).
- **After the read.** A variant created after the decision walk ended is outside this read, as it
  is outside a complete read; the import's own read is a second, later look, and a changed
  decision fails it (`DRY_RUN_MISMATCH`, nothing written).
- **Visibility is the admin's.** Every list is scoped to the accounts the credential's admin can
  see. An account owned by another admin is invisible, and is also one this installation could
  never operate.
- **A no-panel invoice's ADOPT.** An invoice with an empty `code_panel` is decided on every
  production panel like any needed name; a panel where it stays unresolved is listed as
  undecided in its evidence and is not offered for an ADOPT. Fail-closed: such an invoice stays
  `NO_PANEL` (manual review) until a dry run decides it there.
- **Liveness depends on the real panel.** If RickPanel's rows carry a `created_at` out of order
  anywhere (a single row stamped before its predecessor by a clock step, a null stamp on an old
  row, epoch numbers), or its list is not in insertion order, no walk is ever gap-free: every
  needed name of a moving panel stays unresolved, and the dry run is approvable only over a
  panel that holds still for two walks. If its rows carry NO `created_at`, not even that: two
  identical walks cannot tell an account from one deleted and created again under its name
  between them (Codex), so the two-walk snapshot needs a creation time on every row too, and
  such a panel's candidates are never decided by the Web Admin's read. Its churn reason is `NO_CREATION_TIME`, not `WALKS_DIFFER`: the panel held still, and no retry mends its stamps. Safe either way. This,
  the list route, `total` and the page-size cap are inferred from Marzban v0.8.4 and must be
  confirmed on a real RickPanel (gate G6).

Scope: the Web Admin `.nxpkg` importer only. The CLI and the rehearsal walk are unchanged: they
read with `listAll()` and treat anything but one complete snapshot as before.

## Real-panel acceptance

Not run: no RickPanel credentials exist in this environment. See
`docs/rickpanel-inventory-acceptance.md` (Item C1).
