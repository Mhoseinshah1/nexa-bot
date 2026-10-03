# The audit log browser (Phase D1)

Program §16. The Web Admin's `/audit-log` page and its CSV export: a filtered, keyset-paged,
tenant-isolated READER over `audit_logs`, and nothing else.

## What did not change

`audit_logs` is exactly what it was: append-only by trigger (0001), written inside the
business transaction by `DrizzleAuditWriter`, `before`/`after` redacted at write time by
`infrastructure/redaction.ts`. No column, constraint, trigger, state, event or ledger reason
was added. There is no second audit system: the browser reads the one table, and the export
writes its own record through the one writer.

Old rows are shown as they are. A row that recorded no `before`/`after` (or recorded
something that is not an object) shows «بدون جزئیات ثبت‌شده»; nothing is reconstructed from
the entity as it stands today. Deep links are navigation, not recorded facts, and are drawn
only where the server finds the entity in the tenant (below).

## Surface

| Route                                | Permission                    | What                                                |
| ------------------------------------ | ----------------------------- | --------------------------------------------------- |
| `GET /api/admin/v1/audit-log`        | `audit.view`                  | One page, newest first by `(occurred_at, id)` DESC. |
| `GET /api/admin/v1/audit-log/export` | `audit.view` + `audit.export` | The same filters as a CSV.                          |

Both charge their permission in `AuditLogService` before anything is read; the page hiding the
export link protects nothing. The tenant comes from the session, never from a parameter.

`audit.export` is a new permission (HIGH, requires `audit.view`, owner-seeded; migration
`0165_audit_log_export_permission` backfills it to existing owner roles). Reading the trail on
screen and taking it off the installation as a file are different acts — the file outlives the
session — so `finance` and `observer`, who hold `audit.view`, cannot export.

### Filters (all ANDed; `auditLogListQuerySchema`)

- `actor` — an administrator's id, or their CURRENT username (with or without `@`), resolved
  to the id inside the tenant so a renamed administrator's earlier rows are found too. Any
  other text matches the stored `actor_id` exactly, which is how a system job's rows are
  found by clicking the job on a row.
- `actorType`, `result` — the contract enums.
- `customerId` — the rows ABOUT one customer: entity `Customer` or `Wallet` with that id, or
  entity `Order`/`Payment`/`Service` that belongs to that customer now.
- `action` — an exact code (`payment.confirm`) or a family ending in a dot (`payment.`).
  Only `[a-z0-9_.]`; `_` is escaped in the LIKE, so `reseller_tier.` never matches
  `resellerXtier.`.
- `entityType` + `entityId` — an id is refused without its type.
- `security` — `DENIED`, `AUTH` or `CRITICAL` (below).
- `from`/`to` — `occurred_at` as a half-open `[from, to)`. The page sends the operator's local
  midnight of the first day and the midnight AFTER the last day, as `/tickets` does.

A cursor is opaque, minted by the server (`keyset-cursor.ts`), and one this server did not
mint is a 400 — never page one. A cursor replayed in another tenant selects inside that
tenant and finds nothing of the first.

### Security slices (`AUDIT_SECURITY_FILTERS`, `auditSecurityClasses`)

One rule, stated once in the contract and applied in SQL by the reader, so a row's badge and
the filter that found it cannot disagree.

- **DENIED** — `result = 'DENIED'`: refusals a service audited (`recordMutationDenial`). The
  guard's own denials are operational events and stay on `/alerts`.
- **AUTH** — every `auth.*` action, and `admin.password_change`.
- **CRITICAL** — the actions in `AUDIT_CRITICAL_ACTIONS`, each read off the service that
  writes it, with the CRITICAL key that service charges:

| Action(s)                                                                                  | Permission                                                            |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `customer.account_transfer`                                                                | `users.transfer`                                                      |
| `wallet.debit`                                                                             | `users.wallet.debit`                                                  |
| `bulk.create`                                                                              | `users.wallet.mass` / `services.mass.grant` (both CRITICAL)           |
| `payment_account.create/update/set_enabled/set_default`                                    | `payments.accounts.edit`                                              |
| `refund.request/complete/fail`                                                             | `refunds.issue`                                                       |
| `panel.credentials.replace`                                                                | `panels.credentials.rotate`                                           |
| `admin.create/status_change/roles_change/telegram_binding/password_reset/sessions_revoked` | `admins.edit`                                                         |
| `backup.download`, `backup.archive_downloaded`                                             | `backup.download`                                                     |
| `recovery.confirm`, `recovery.confirmed`                                                   | `recovery.restore`                                                    |
| `recovery_kit.exported` / `recovery_kit.imported` / `installation_key.removed`             | `recovery.kit.export` / `recovery.kit.import` / `recovery.key.remove` |

`wallet.credit` is deliberately absent: it is CRITICAL only above the large-amount threshold,
and the row does not say which key was charged. `tests/unit/audit-log-contract.test.ts` holds
every listed permission to `riskLevel === 'CRITICAL'`.

### Deep links

`links` on each entry is decided by the server from the row's own entity: `Customer`/`Wallet`
link to the customer; `Order`/`Payment`/`Service` link to themselves AND their customer, but
only when that entity exists in the session's tenant (one batched read per kind per page). An
id that is not a uuid, or names another tenant's entity, links nowhere.

### Secrets

`before`, `after` and `reason` are redacted AGAIN on the way out, by the same implementation
the writer used (`redactRecord`, `redactSecretText`), because a row is read for years and the
redactor has learned keys since (`subscription`, `passphrase`) that older rows were written
without. The entity-history and Customer 360 readers now do the same. `ip` and `user_agent`
are never selected by any browser statement and appear neither on screen nor in the file.

### Export

The export walks the SAME filter object through the SAME reader, 500 rows per statement, in
the list's order, so the file holds exactly the rows the pages show. Larger than
`AUDIT_LOG_EXPORT_ROW_MAX` (10 000) is REFUSED with a request to narrow the filter, never
cut short. The file is the one CSV format (`textCsv` beside the report writer): UTF-8 BOM,
CRLF, RFC quoting, every cell formula-guarded, Persian headers from `@nexa/i18n`
(`AUDIT_EXPORT_HEADERS_FA`). `attachment`, `nosniff`, `no-store`; the file name is built from
the clock alone.

A successful export is itself recorded: `audit.export` on entity `AuditLog`, `after` holding
the format, the row count and the filter. A refused one is recorded as DENIED.

## Indexes (`ONLINE_INDEXES`, built concurrently)

`audit_logs` had `(tenant_id, occurred_at)` and an `(entity_type, entity_id)` index that does
not lead with the tenant. Five tenant-led indexes were added, all ending `occurred_at, id` so
a filtered page is read in order and the keyset continuation is an index condition:

| Index                                                                                       | Serves                                      |
| ------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `audit_logs_tenant_occurred_page_idx` `(tenant_id, occurred_at, id)`                        | unfiltered pages, the date range            |
| `audit_logs_tenant_actor_page_idx` `(tenant_id, actor_id, occurred_at, id)`                 | one actor                                   |
| `audit_logs_tenant_entity_page_idx` `(tenant_id, entity_type, entity_id, occurred_at, id)`  | one entity; the customer filter's four arms |
| `audit_logs_tenant_action_page_idx` `(tenant_id, action text_pattern_ops, occurred_at, id)` | one action; a family by prefix              |
| `audit_logs_tenant_denied_page_idx` `(tenant_id, occurred_at, id) WHERE result = 'DENIED'`  | the DENIED slice                            |

Concurrently because nearly every business transaction inserts an audit row, and a blocking
build would hold all of them during `botctl update`.

`tests/integration/audit-log-plan.test.ts` EXPLAINs the reader's own statements
(`pageStatement`) on two tenants × 30 000 rows. Measured (PostgreSQL 16, page of 51):

- unfiltered, page 1 and page 2: `Index Scan Backward using audit_logs_tenant_occurred_page_idx`,
  `Index Cond: tenant_id AND ROW(occurred_at, id) < ROW(…)`, no Sort.
- one actor: `audit_logs_tenant_actor_page_idx`, no Sort, nothing filtered.
- one exact action: `audit_logs_tenant_action_page_idx`, no Sort.
- one entity with a short history: the planner may pick the old `audit_logs_entity_idx` plus
  a sort of a handful of rows (it did, at 6 rows); with a long history (20 000 rows on one
  panel) it reads `audit_logs_tenant_entity_page_idx` backwards with no Sort.
- customer: a BitmapOr of four `audit_logs_tenant_entity_page_idx` probes, the owned ids each
  an InitPlan `ARRAY(…)`, then a top-N sort of the customer's own rows.
- DENIED, on a log skewed by 20 000 fresh successes: `audit_logs_tenant_denied_page_idx`,
  nothing filtered (it read 22 548 rows to find 51 before that index existed).
- date range: `audit_logs_tenant_occurred_page_idx` with both bounds in the Index Cond.

## Known limitations

- A family (`payment.`) and the AUTH/CRITICAL slices are SETS of actions. The planner chooses
  by statistics between the action index and walking the time keyset until a page has
  matched; on a realistically spread log both are bounded (≈200–460 rows read for 51 in the
  fixture). A family ABSENT from the recent past is walked back to where it last occurred —
  correlation the statistics cannot see. The answer is the date range, which bounds the walk.
- Rows recorded with no tenant (installation-wide work) are in no tenant's log.
- The customer filter covers the five entity types above. Rows about a customer's tickets,
  refund requests or reseller standing are found by entity type and id, not by the customer.
- The guard's own permission denials are operational events (`/alerts`), not audit rows,
  unless the service also audited them; the DENIED slice shows the audited ones.
- The date inputs are the browser's Gregorian date picker, as on `/tickets`.

## Manual acceptance

- On a real installation: open `/audit-log` as owner, finance and support at 390px and on a
  desktop; confirm support has no menu entry, finance has no export link, owner's export
  downloads a CSV that opens in Excel/LibreOffice with Persian headers right-to-left.
- From a customer's Customer 360 page, «همه رویدادهای این مشتری در گزارش ممیزی» opens the log
  scoped to that customer, and its order/payment/service links open the right pages.
- After `botctl update`, confirm the five `audit_logs_tenant_*_page_idx` indexes exist and are
  valid (`\di audit_logs*`).
