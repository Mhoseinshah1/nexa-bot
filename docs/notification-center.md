# Phase B3 — Web Admin Notification Center

An operator inbox in the Web Admin: a bell with an unread count in the top bar, a list with
detail, read/unread and mark-all, severity and category, timestamps and a deep link to the
affected entity. Program §12.

## 1. Audit: what already exists

| Existing piece                                                               | What it is                                                                                                                                                                                                       | Decision                                                                                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `operational_events` (opslog)                                                | What the system did. Dedupes by `(dedupe_scope, dedupe_key)` into one row with `occurrence_count` / `last_seen_at`; a recovery event sets `resolved_at` on the failure row; append-only guard; codes are schema. | **The source.** Every notification is one of these rows.                                                   |
| Alerts page (`/alerts`, `MANAGEMENT` scope)                                  | An operational history for `opslog.view` holders, ordered by `first_seen_at`.                                                                                                                                    | Kept as is. The inbox is narrower (actionable rules only), per-admin, and permission-filtered by category. |
| Telegram ops group (#142, `OPS_LOG_TOPIC_ROUTES`)                            | The routine operational stream, projected to forum topics by code prefix.                                                                                                                                        | Not touched. The inbox does not mirror it.                                                                 |
| Phase 2 operator notification dispatcher (`notifications`, `/notifications`) | Delivery of operational events to operator CHANNELS (Telegram), with its own outcome enum.                                                                                                                       | Not a second transport: the inbox sends nothing.                                                           |
| Customer notification lane (ADR-0030)                                        | Customer-facing.                                                                                                                                                                                                 | Unrelated.                                                                                                 |

So there is **no notification table** and **no fan-out writer**. A new table that copied events
would be a second ops log with its own dedupe, and the two would disagree. The inbox is a
**projection**: `operational_events` read through `NOTIFICATION_RULES`, plus one small table of
per-administrator read marks.

## 2. Model

- **Which events.** `NOTIFICATION_RULES` (`packages/contracts/src/notification-center.ts`): an
  exact code or a `starts_with` prefix → a category, a link target and a minimum severity.
  Exact rules win over prefixes. A **recovery row** (`recovers_code` set) is never a
  notification: it marks the failure's notification resolved. Not every audit event, and not
  every operational event: `access.permission_denied`, probes and routine sends stay on the
  alerts page and the Telegram group.
- **Dedupe** is the recorder's. The same code and dedupe key while open is one row, so one
  notification, with an occurrence count and a last-seen time.
- **Read state** is `admin_notification_reads (tenant_id, admin_id, event_id, read_through)`.
  `read_through` is the event's `last_seen_at` at the moment it was read. **Unread** means no
  row, `read_through IS NULL` (an explicit "mark unread"), or `last_seen_at > read_through`. So
  a condition that recurs after an administrator read it becomes unread again for that
  administrator only. Mark-all writes the same marks for every unread row in the
  administrator's filter. There is no global cursor, so nothing outside what they could see
  is touched.
- **Window.** A notification is in the inbox while its last occurrence is within
  `NOTIFICATION_WINDOW_DAYS` (30). A recurring condition keeps refreshing itself. Older
  history stays on the alerts page. This bounds the list, the badge and mark-all.
- **Ordering.** `(first_seen_at, id)` descending: the immutable keyset the operations log
  already uses (owner decision; a recurring row must not jump across a cursor). The unread
  filter, which is the inbox's default, and the badge show what recurred. The page cursor is
  `beforeAt` AND `beforeId`; half of one is a 400, never a silent first page.
- **Badge.** The unread count stops at `COUNTER_CAP` ("that many or more"). The capped subset
  is the most severe rows, so `highestUnread` is the maximum over every unread notification,
  not over whichever `cap` rows a scan happened to return first.
- **Permissions.** Each category maps to an existing view key
  (`NOTIFICATION_CATEGORY_PERMISSIONS`): the key of the page the link opens. The service asks
  `PermissionGuard.permissionsOf`, the guard's own resolution, and filters in SQL, so the list,
  the count and mark-all all agree. Marking one notification, or all in a named category,
  also goes through `guard.check`, which records a denial. That check is an early rejection;
  the one that counts is made again INSIDE the write's transaction (`guard.check` on `tx` for
  a mark, the filter re-resolved on `tx` for mark-all), as `runAuthorizedMutation` and
  ADR-0014 require of every write, so a key revoked mid-request writes nothing. A denial
  decided there is recorded after the transaction unwinds. An administrator with no matching
  key has an empty inbox, not an error.
- **Tenancy.** Only the administrator's tenant's rows, never a SYSTEM-scoped (null-tenant)
  row, exactly as the operations log. Read marks are keyed by tenant and administrator.
- **Deep links** are derived on the server from the event's typed subject
  (`OperationalSubject`: `paymentId`, `panelId`, `serviceId`, `orderId`), and only when the
  value is a UUID. Otherwise they fall back to the list page. The raw `context` never leaves
  the API.

### Why read marks are not audited

A read mark is one person's view state. It resolves no condition and changes no event, and
nobody else sees it. Auditing "X read a notification" would put the inbox's own noise into
the log it exists to keep readable. It also has no domain event. Every write is still
authorised (guard), tenant- and admin-scoped, checked against scope activity inside its
transaction, and idempotent by construction: each write sets state, so a double click lands in
the same place.

## 3. Extension point (for B2 Gateway Health, C2 Panel Health, E3 Incidents)

Add a row to `NOTIFICATION_RULES`: an exact `code` or a `prefix`, a `category`, a `link` and a
`minSeverity`. Nothing else changes. The recorder dedupes it, the inbox projects it and the
badge counts it.

- Panel health and drain: `panel.health.*` and `panel.capacity.*` are already admitted by
  prefix (WARN and above). New `panel.*` codes need a rule unless they fall under those
  prefixes.
- Gateway health: add exact codes under `GATEWAYS` (link `PAYMENT_GATEWAYS`).
- Incidents and maintenance: `incident.` and `maintenance.` are already admitted by prefix
  under `INCIDENTS` (link `/alerts`, permission `opslog.view`).
- A new category needs an entry in `NOTIFICATION_CATEGORIES`, a view key in
  `NOTIFICATION_CATEGORY_PERMISSIONS` and a Persian label in the web page.

## 4. Not covered here

- **A receipt waiting for review** is a payment state, not an operational event. Nothing
  records one today, so nothing in the inbox announces it. The payments rules cover what is
  recorded: a gateway review left unresolved, UNKNOWN gateway outcomes, late, mismatched or
  unmatched money, and reviewers not being told. When the Payment Operations work records a
  `payments.receipt_review_*` condition, it becomes a notification with one rule.
- Per-admin, per-category preferences (mute) are not built.
