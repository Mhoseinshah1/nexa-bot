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
  (by type) and an incomplete inventory makes every dependent decision `UNDECIDABLE`.

Tested: first page, multiple pages with a short final page (not omitted), exact multiple
(no wasted request), empty panel, no total (ends on empty page), capped page size, offset
ignored, limit ignored, bare array, page bound, deletion mid-walk, reorder mid-walk,
delete-A/append-K (one walk misses F; `listAll` says `WALKS_DIFFER`), a quiet panel
(complete), and two spellings of one name kept apart.
Mutation-checked: advancing by `limit`, stopping on a short page, removing the
no-progress stop, and dropping the two-walk comparison each fail a named case.

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

## Real-panel acceptance

Not run: no RickPanel credentials exist in this environment. See
`docs/rickpanel-inventory-acceptance.md` (Item C1).
