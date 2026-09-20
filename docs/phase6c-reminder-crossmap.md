# The reminder crons, crossmapped

What the legacy system this product replaces did with its six cron rows, what
Nexa does instead, and — for the three that are NOT implemented — why the
evidence is recorded rather than acted on.

The legacy behaviour here is EVIDENCE of observed behaviour, not a
specification (`docs/research/README.md`). Where a row is marked deferred, the
absence is a decision with a reason, not an oversight.

## The reminder rows

| Legacy row | What it did | Nexa | Where |
| --- | --- | --- | --- |
| `🕚 کرون زمان` | one configurable threshold, in days, before a service's time expires | TWO thresholds — `reminders.expiry_first_days` (3) and `reminders.expiry_second_days` (1) — plus an expired notice | `service_expiry_reminders`, `service_expired_notice` |
| `🔋 کرون حجم` | one configurable threshold, as a percentage of traffic used | THREE thresholds — `reminders.usage_first_percent` (80), `_second_` (95), `_final_` (100) | `service_usage_reminders` |
| `🕚 کرون اولین اتصال` | chased customers whose service was bought and never activated (`on_hold`), threshold 4 days, OFF | **DEFERRED** — see below | — |
| `🧯 متصل نبودن کاربر` | chased customers with a live service who stopped connecting, threshold 3 days, ON | **DEFERRED** — see below | — |
| `❌ کرون حذف` | DELETED accounts N days after their time expired (3) | **DEFERRED, and deliberately** | — |
| `❌ کرون حذف حجم` | DELETED accounts N days after last connection when traffic ran out (2), Marzban only | **DEFERRED, and deliberately** | — |

Sources: `docs/research/mirzabotbotcapabilitiesinvestigationcompletev2/bot-capabilities-knowledge/business-rules.md`
CBR-003 (twelve capabilities carry nested configuration, six of them crons),
CBR-011 (a capability's settings take one of four shapes, never just a boolean),
CBR-013 (only 6 of 12 settings screens echo their current value),
CBR-014 (two deletion crons, two grace windows, two clocks),
CBR-015 (the two "not connected" jobs address opposite customer states).

## What Nexa does differently, and why

**The thresholds are the tenant's, not the code's.** CBR-003 and CBR-011 record
that every legacy cron carried a configurable scalar. Hard-coding 3, 1, 80, 95
and 100 would have been a regression against a system this product is supposed
to replace, so each is a typed setting in the registry with its own bound, and
the worker reads the tenant's values inside the sweep.

**A family is a flag and its parameters are settings.** `CLAUDE.md` forbids
either registry growing the other's field, so the three master switches are
feature flags (`service_expiry_reminders`, `service_expired_notice`,
`service_usage_reminders`) and the five numbers are settings bound to them by
`configures` / `configuredBy`. Disabling a family leaves its numbers alone, so
re-enabling restores exactly what was configured — which is what an operator
means by turning something off for a week.

**Every screen echoes its value before it is edited.** CBR-013 is the
write-only settings defect measured: an admin could not audit the bot's
configuration through the bot, because reading a value required overwriting it.
Both Nexa surfaces print all eight values first. On Telegram the values are
chosen by tapping one of a bounded list rather than typed, because a prompt that
captures the next message is INCIDENT-FIN-001.

**A threshold combination is refused as a combination.** The first expiry
reminder must fall strictly later than the second, and the three usage
thresholds must ascend without repeating. No per-key schema can express a
relation between keys, so `ReminderThresholdsGuard` runs inside the writing
transaction and refuses the whole write. An invalid pair is never briefly
stored.

## The three deferrals, with their reasons

**First-connection and inactive-user outreach (CBR-015).** Both need a fact this
product does not have: when a customer last connected. Nexa reads usage totals
from a panel (`SYNC_USAGE`); it does not read a last-seen timestamp, and no
adapter exposes one. Implementing either against a fact we do not hold would
mean inferring "has not connected" from "usage did not change", which is false
for a customer whose service is idle and true for one whose panel sync failed.
That is the shape of guess `docs/research/README.md` forbids. Recorded in
`docs/open-questions.md` rather than built.

**The two destructive deletion crons (CBR-014).** Recorded as evidence and
deliberately NOT implemented. Both destroy real customer accounts on a timer,
from two different clocks, and both were switchable from the same list as a dice
toggle. ADR-0010 is this product's answer to that class of operation: a
destructive or bulk action is dry-run → affected count → explicit confirmation →
audited execution → recorded result, and never a fire-on-press switch. A timer
that deletes accounts is the opposite of that, and adding one because the legacy
system had one would be porting a defect. The owner may decide otherwise; this
is not that decision.

## What the reminder lane guarantees

- **A renewal re-arms it.** The reminder row is keyed on the service's basis —
  its expiry deadline and its traffic limit — so a renewal that moves either
  makes a new period, and the reminder is owed again. The notification
  uniqueness rule cannot permanently swallow it.
- **A config edit does not resend.** The row is keyed on the period, not on the
  threshold, so lowering 80 to 70 does not re-send a reminder already delivered
  for that period.
- **Only the highest newly crossed threshold sends.** A jump from 60% to 100%
  produces one message, and the ones below it are recorded as satisfied so they
  cannot fire later.
- **Unlimited is not a threshold.** A service with no expiry gets no expiry
  reminder; one with no traffic limit gets no usage reminder — `usageReached`
  is false for a limit of zero rather than dividing by it.
- **A failed or stale read sends nothing.** The sweep works from stored usage
  that a sync actually wrote, and `services_usage_synced_check` refuses used
  bytes with no sync behind them. A provider read that failed leaves the old
  figures, which cross no new threshold.
- **The figures a customer sees are frozen at the raise.** The reminder row
  carries the service label, the remaining days and the used bytes as they were
  when the threshold was crossed, so a message delayed in the queue cannot
  render numbers from a later state.
