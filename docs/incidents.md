# Incidents and maintenance (Phase E3)

An incident is the operator's record of something wrong — or, for MAINTENANCE, of a
window planned in advance — with a scope, a timeline, and optionally three consequences:
new sales stop on exactly its targets, every administrator sees a banner, and the
customers on its scope can be told. Program §21.

## What an incident is

`incidents` holds the record: kind (`INCIDENT` | `MAINTENANCE`), severity
(`MINOR` | `MAJOR` | `CRITICAL`), status, title, internal description, customer message,
`stop_sales`, `admin_banner`, the scheduled window and the real one, and a `version` that
every edit and transition compares. `incident_targets` is the scope — panels, service
locations, products and payment gateways, at most 50. `incident_effects` is one row per
thing actually changed, with its state. `incident_events` is the timeline and is
append-only (0175's triggers; the lead renumbers at merge). `incident_communications` / `incident_notices` are the
customer notices.

Status moves only forward, each step a conditional UPDATE naming its `from` state and the
expected version:

```
SCHEDULED ──start (operator or the scheduler)──► ACTIVE ──resolve──► RESOLVED
    └──────────────cancel──────────────► CANCELLED
create with no start ─────────────────► ACTIVE
```

## Stopping sales precisely

With `stop_sales` on an ACTIVE incident, each target is withdrawn from NEW sales through
the module that owns it, by that module's existing write path, as the operator:

| target   | effect               | write path                           | permission it charges    |
| -------- | -------------------- | ------------------------------------ | ------------------------ |
| PANEL    | `PANEL_DRAIN`        | `PanelService.setDrain` (C2)         | `panels.drain`           |
| LOCATION | `LOCATION_DISABLE`   | `ServiceLocationAdminService.update` | `catalog.edit`           |
| PRODUCT  | `PRODUCT_DEACTIVATE` | `ProductService.deactivate`          | the product module's     |
| GATEWAY  | `GATEWAY_DISABLE`    | `PaymentGatewayService.setStatus`    | `payments.gateways.edit` |

So nothing new decides eligibility: a drained panel is refused by `decideEligibility`
(reason `DRAINING`) at catalogue, confirmation and settlement exactly as C2 built it; a
disabled location, inactive product or disabled gateway is refused where each already was.
Every refusal happens **before money moves** — confirmation refuses, no payment is
created. Everything not targeted stays available; the integration suite asserts a second
panel, location and product keep selling throughout.

Each effect is CLAIMED before it is applied (`PENDING`, a conditional upsert that only a
`FAILED`/`REVERTED`/`KEPT` or stale `PENDING` row yields to), so two concurrent
`applyEffects` calls, or an apply racing a resolve, change each subject once. The outcome
is recorded per subject: `APPLIED`, `ALREADY` (it was withdrawn before the incident — and
will be left withdrawn), or `FAILED` with the error code (typically
`platform.permission_denied` when the operator lacks that module's key — shown on the
page, never hidden). Each call to a module carries an idempotency key derived from the
incident, its version and the subject, `incident:<id>:v<version>:<kind>:<subject>:on|off`.

At most one claim is live per SUBJECT across every incident: a claim is taken under a
per-subject advisory lock, and a claim that finds another incident's live `PENDING` /
`REVERTING` on the same subject waits (up to 5 s) and asks again — after that it is
recorded `FAILED` with `incident.effect_contended`, for **Apply effects** to retry. So a
restore, a hand-over or an adoption is decided with nothing moving underneath it.

The apply pass re-reads the incident after settling its claims, and the restore pass works
from that second reading: a resolution that committed while an effect was in flight (it
found the row `PENDING` and could not restore it) is restored by the pass that applied it.

On resolve, only what this incident applied is restored: an `APPLIED` row is claimed
`REVERTING`, and reverted only if the subject is still withdrawn AND, for a panel, its
drain reason is still this incident's marker `incident:<id>`. A drain someone else has
since set, or a product an operator has since re-activated, is `KEPT` as it is.

**Overlapping incidents.** Two ACTIVE stop-sales incidents on one subject: the first
applies it (`APPLIED`), the second finds it withdrawn (`ALREADY`). When the first ends
while the second still wants the subject, it restores nothing: the second's row becomes
`APPLIED` (its `ALREADY` or `FAILED` row is promoted) and the first's `HANDED_OVER`. The
withdrawal lifts only when the last incident that wants it ends. A drain cannot be
re-marked while it holds, so the new owner recognises it by the hand-over: a drain whose
reason is the marker of an incident that `HANDED_OVER` this subject is its own to restore.
An `APPLIED` row whose incident no longer wants the subject (it ended and its restore pass
never ran) is an orphan: the next incident to find the subject withdrawn adopts it, and
restores it at its own end.

## The money rules

Nothing here touches an order that has been paid. A drained panel still delivers what was
paid for (C2 settles a drained panel only on a live hold); provisioning is not paused, and
there is no "paid, waiting for the incident" state. An order stays FULFILLED or REFUNDED,
nothing in between. Stopping sales only refuses new confirmations.

## The scheduler

`IncidentSchedulerLoop` (WORKER, every 60 s, health key `incident-scheduler`) starts
SCHEDULED windows whose start has come, as the system job. The system job holds only
`maintenance.run`; it cannot hold `panels.drain` or `catalog.edit`, and this phase adds
none to it. So a scheduled window with `stop_sales` starts ACTIVE, records
`EFFECTS_PENDING` on its timeline and opens a WARN `…effects_pending` condition in the
operations log (an inbox notification); an operator's **Apply effects** applies them under
their own permissions and closes the condition. This is deliberate: a background process
that could withdraw any product or gateway would be a second, unaudited path to the same
switch.

## Notification Center and the operations log

Every transition records through `OperationalEventRecorder`: `incident.started` /
`maintenance.started` opens one condition per incident (dedupe `incident:<id>`, severity
from the incident's), `.resolved` recovers it, `.scheduled` / `.cancelled` are one-shot
INFO events. `NOTIFICATION_RULES` already routes the `incident.` and `maintenance.`
prefixes to the INCIDENTS category (`incidents.view`) and links to `/incidents/<id>`.
The "effects pending" condition closes only when every effect the incident wants is in
force (`APPLIED` or `ALREADY`): an apply that FAILED leaves it open.

The list pages by a keyset cursor (`?cursor=`, 50 a page, newest first). The admin
banner is every administrator's; its link to the incident is drawn only for
`incidents.view`, which the detail page charges.

## The customer notice

A new closed lane kind, `INCIDENT_NOTICE` (ADR-0030, template `bot.incident.notice`, one
`message` value). The operator previews the count — ACTIVE customers whose bot is ACTIVE and with an
ACTIVE or SUSPENDED service on a targeted panel (directly or through a location), or of a
targeted product; every such customer when there are no targets — and confirms by sending
that count back; a different count is refused (`incident.notice_refused`). The words are
read at send time from the communication row, never stored as a rendered string. A notice
holds only while its incident is SCHEDULED or ACTIVE and is younger than 12 hours: a
cancelled or resolved window's queued notices are superseded unsent — including those
of a customer who stays blocked, whom the dispatcher never claims: the lane's lapsed-subject
sweep names them too.

## Permissions, audit, idempotency

- `incidents.view` (LOW: observer, support, technical, operator, owner) — list, detail,
  inbox category.
- `incidents.manage` (HIGH: technical, operator, owner) — create, edit, start, resolve,
  cancel, apply effects.
- `incidents.notify` (HIGH: operator, owner) — the customer notice.
- The banner (`GET /incidents/banner`) needs only a session: every administrator should
  know.

Every write takes an idempotency key (apply-effects is idempotent by its claims and keyed
per module call), checks scope activity inside its transaction, writes an audit row, an
`IncidentStateChanged` outbox event and a timeline event. A refusal is audited DENIED.

## Limitations

- The scheduler starts windows but does not apply effects (above); a scheduled window with
  `stop_sales` needs an operator to press Apply effects.
- The scheduled END is informational: nothing resolves an incident automatically.
- Gateway targets disable the whole gateway; there is no per-currency or per-amount scope.
- No customer notice is sent automatically on start or resolve; each is an operator act.
