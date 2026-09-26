# WP16 — Admin & Operations Polish: audit and what was done

Branch `claude/wp16-admin-ops-polish`, from `origin/main` at `4e6fb39`. Independent of
WP12–WP15.

Owner rules for this package:

- No force-success or force-paid control.
- No bypass of a source-of-truth state machine.
- Shared operations-notification infrastructure only if it fits cleanly. Nothing
  TonPays-only.
- The standing decision that there is **no general log page** (`web.planned_reports_no_logs`,
  `system.tsx`) is respected. Anything added is a narrow queue view, not a log browser.

---

## 1. What exists

| Area                        | What is there                                                                                                                                                                                   | Operator visibility before WP16                                                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Outbox**                  | `outbox_messages`: `attempts` and `last_error`, no DLQ by design (ADR-0006). The relay claims oldest first with `FOR UPDATE SKIP LOCKED`, and each message runs under its own savepoint.        | Only readiness's "oldest unpublished N ms". No backlog count, and no failing messages.                                                                                                                                |
| **Process roles**           | worker, monitor, provisioner and recovery write FILE heartbeats after a real check. A stalled worker loop is only logged.                                                                       | Readiness (API-process view) and build info.                                                                                                                                                                          |
| **Provisioning operations** | PLANNED / IN_FLIGHT / SUCCEEDED / FAILED / UNKNOWN / ABANDONED, with attempts, `next_attempt_at`, lease and `announced_at`. Partial indexes exist for due, lease, UNKNOWN and unannounced rows. | Per-service history only (`/services/:id/operations`). No cross-service view of what is stuck.                                                                                                                        |
| **Operational events**      | `operational_events` with dedupe, occurrences and recovery. `GET /ops-log` (`opslog.view`) has scopes ALL, MANAGEMENT and MANAGEMENT_CONDITIONS.                                                | `/alerts` asks for MANAGEMENT or MANAGEMENT_CONDITIONS only. Conditions outside those lists (`provisioning.stalled`, `telegram.customer_send_failed`, …) reach operators through the Telegram ops group, not the web. |
| **Audit log**               | `audit_logs` has a writer only. `audit.view` is seeded and charged by nothing on `main`.                                                                                                        | None. WP14 (PR #78) adds `AuditHistoryReader` and the first entity-history panels.                                                                                                                                    |
| **Bulk operations**         | Only the trial reset (ADR-0010: preview, fingerprint, confirmation, audit, recorded result).                                                                                                    | —                                                                                                                                                                                                                     |
| **Ops notifications**       | Provider-neutral: an operational event goes to `NotifyingOperationalEventRecorder`, then the dispatcher, then Telegram, keyed by code and severity.                                             | `/notifications` lists intents. It has no status filter.                                                                                                                                                              |

## 2. Findings

- **R1 — the relay hot-loops on a poison message (a defect).**
  - The relay rescheduled with a 0 ms delay whenever a batch CLAIMED anything.
  - A message whose consumer always throws is claimed by every batch.
  - So one poison message kept the relay in a zero-delay loop, with a failed
    transaction and an error log line on every spin.
  - The class comment said it "backs off"; it did not.
- **R2 — head-of-line blocking.** If `batchSize` poison messages sit at the head of the
  queue (oldest first, no per-message back-off), everything behind them waits. Fixing
  that needs a `next_attempt_at` column and an index change, which is a migration.
- **V1 — no cross-service view of stuck work.** UNKNOWN outcomes, expired leases,
  retries and unannounced terminal operations are only visible one service at a time.
- **V2 — no view of the outbox beyond one lag number.**
- **C1 — stale copy.** `web.system_logs_destination` said Telegram delivery "is not
  built in this release". The ops-group pipeline exists.

## 3. What this package changes

### D1 — the relay waits after a batch that made no progress (R1)

- `nextRelayDelayMs(result, pollIntervalMs)`: drain at once while a batch PUBLISHED
  something, otherwise wait the poll interval.
- A batch that claimed work and published none made no progress, and the next one would
  make none either until something changed.
- The class comment now says what is true, including that there is no per-message
  back-off (R2 stays open).
- **Test:** `tests/unit/outbox-relay-delay.test.ts`.

### D2 — `GET /system/diagnostics` (read-only, `opslog.view`)

- **Permission:** `opslog.view`, the operations-log audience. No new permission.
- **Provisioning section:** counts and the oldest 20 operations under four derived
  reasons. Each reason uses the predicate of the sweep that owns it:
  - `UNKNOWN_OUTCOME`: `state = 'UNKNOWN'`.
  - `LEASE_EXPIRED`: `IN_FLIGHT` with `lease_until < now`.
  - `RETRYING`: `PLANNED` with `attempts > 0`.
  - `UNANNOUNCED`: the terminal predicate of `dueForAnnouncement`, older than
    `UNANNOUNCED_GRACE_MS` (10 min).
- **Classification:** one `CASE`, so each operation is counted under exactly one reason.
- **Outbox section:** the tenant's pending count, the oldest pending time, the failing
  count and the oldest 20 failing messages.
  - Each message shows event type, aggregate type, attempts, occurred-at and a
    `lastError` that is bounded to 300 characters and has every URL replaced by `[url]`.
    A URL could be a subscription link.
  - No payload and no actor column is selected.
  - Platform messages (null tenant) are not shown to a tenant operator.
- **It changes nothing.** A test snapshots the operation and outbox rows around a read.
- **Tests:**
  - `tests/integration/system-diagnostics.test.ts` (5): real rows from a paid order;
    each reason exactly once; the grace and the announcement exclude a row; URL
    scrubbing; tenant isolation; the permission refusal; read-only.
  - `tests/unit/diagnostics-display.test.ts` (3).

### D3 — Web Admin: System → عیب‌یابی (Diagnostics)

- Two cards: stuck operations (counts per reason with a hint, and rows linking to their
  service) and the event queue.
- **No control changes anything.** A test asserts there is no button in the panel. The
  remedy for a stuck operation is on its service page: reconcile, retry-provision,
  resend. Each of those has its own permission and state machine.
- Asks for nothing without `opslog.view`.
- **Test:** `tests/web/system-diagnostics.test.tsx` (3).

### D4 — copy

- `web.system_logs_destination` now says where the ops stream goes and where it is
  configured.

## 4. Deliberately not done

| Item                                                                                             | Why                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-message outbox back-off (R2)                                                                 | A migration (`next_attempt_at` plus an index). D1 removes the hot loop; head-of-line blocking stays until then.                                                                                                               |
| Adding hidden conditions to the MANAGEMENT scopes                                                | The scope narrowing is deliberate (`alerts.tsx`). Changing which codes are "management" is a contract change with recovery pairs to verify. The Telegram ops group already carries them.                                      |
| A global audit browser                                                                           | The owner decided there is no general log page. Entity-history panels (WP14's `AuditHistoryReader`) are the pattern; extending them to services, payments and panels should follow once PR #78 lands, so there is one reader. |
| Customer-notification failures list, receipt review queue on the web, notification status filter | Each is a new route and schema, and the customer-notification list also needs an online index. Recorded as the next ops-visibility slice.                                                                                     |
| Bulk actions (e.g. "reconcile all UNKNOWN")                                                      | ADR-0010 requires preview, fingerprint, confirmation, audit and a recorded result, and nobody asked for one. Every single-entity action already exists.                                                                       |
| Worker heartbeat table / lane-lag route                                                          | A heartbeat table is a migration and interacts with the recovery quiesce. The diagnostics already show the lag of the two lanes an operator acts on (outbox, provisioning).                                                   |
| New ops-notification kinds                                                                       | Not needed: new stuck conditions belong in the existing provider-neutral operational-event pipeline, and codes are schema (CLAUDE.md), so they are added with their recovery code in one release when a condition is defined. |
| RECONCILE dead end (WP15 G4)                                                                     | Needs a new operational-event code and a bounded re-plan. D2 now makes such services visible as UNKNOWN_OUTCOME.                                                                                                              |

## 5. Evidence

Mutations, each reverted after its run:

| Mutation                                            | Failed                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `nextRelayDelayMs` back to `claimed > 0 ? 0 : poll` | 2 unit cases: the poison-message loop, and an all-skipped batch                        |
| `displayableError` without the URL replacement      | 1 unit case, plus the integration case "shows a failing outbox message … URLs removed" |
