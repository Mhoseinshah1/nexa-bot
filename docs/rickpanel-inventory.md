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

The inventory also never carries a subscription link, a subscription token or a generated
proxy credential — it has no use for them (tested).

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
- Duplicates are keyed by canonical username and counted once (`duplicateRows`).
- **Completeness is a result, not an assumption.** `complete: true` only when the reported
  total did not move and the distinct names equal it. Otherwise `complete: false` with
  `TOTAL_CHANGED` or `COUNT_MISMATCH` — live-system drift; re-run.

Tested: first page, multiple pages with a short final page (not omitted), exact multiple
(no wasted request), empty panel, no total (ends on empty page), capped page size, offset
ignored, limit ignored, bare array, page bound, deletion mid-walk, reorder mid-walk.
Mutation-checked: advancing by `limit`, stopping on a short page, and removing the
no-progress stop each fail a named case.

## Canonical username

ASCII lowercase (§11: duplicates `(code_panel, lower(username))` = 0, mixed-case = 0 in
the legacy audit). One definition, `canonicalLegacyUsername`, used by both the inventory
and the matcher. A name that is empty, longer than 128 or outside printable ASCII is not
compared. `findAccount` takes only a canonical name and refuses a record that names a
different account.

## Matching

`matchLegacyService(row, policy, inventories)`:

| legacy `code_panel`                           | rule                                                       | outcome                                                        |
| --------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| in the explicit `code_panel → NEXA panel` map | `lower(username)` in THAT panel's complete inventory       | `ELIGIBLE` / `MANUAL_REVIEW PROVIDER_MISSING`                  |
| a declared test panel                         | —                                                          | `SKIPPED TEST_PANEL`                                           |
| null, or declared missing                     | exact lowercase username across every production RickPanel | 1 → `ELIGIBLE`; 0 → `PROVIDER_MISSING`; >1 → `AMBIGUOUS_PANEL` |
| anything else                                 | not searched                                               | `MANUAL_REVIEW PANEL_UNMAPPED`                                 |

A panel the decision depends on without a COMPLETE inventory gives `UNDECIDABLE`, never
`PROVIDER_MISSING` — zero matches in a partial walk is not absence. No inbound id, no fuzzy
or prefix match (tested, including a source assertion). Reason names match Migration P4's
`LEGACY_IMPORT_REASON_CODES`.

## Real-panel acceptance

Not run: no RickPanel credentials exist in this environment. See
`docs/rickpanel-inventory-acceptance.md` (Item C1).
