# Panel health dashboard and drain (Phase C2)

The Web Admin page `/panel-health` shows every live panel with what it is doing
and what has gone wrong with it. An operator can test a panel's connection, open
its services, and drain it or undrain it. Every number on the page is a
measurement this installation already records. Nothing on it is estimated, and
nothing implies a history that is not kept.

## What the page shows, and where each value comes from

| Shown                                                      | Source                                                                                                  | Notes                                                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health: online / degraded / offline / disabled / unchecked | `panel_health.state`, through `readHealth` (`DISABLED` and `UNCHECKED` are projected, ADR-0023)         | Online is `HEALTHY`. Degraded is `DEGRADED`: credentials were accepted but the status read failed. Offline is `UNREACHABLE` or `AUTH_FAILED`.                        |
| Latency                                                    | `panel_health.latency_ms` of the latest probe                                                           | Latest probe only. `panel_health` stores only the latest state, so there is no trend to show.                                                                        |
| Last check / last success                                  | `checked_at`, `last_healthy_at`                                                                         | `stale` uses `PANEL_HEALTH_FRESH_FOR_MS`, the same constant as everywhere else.                                                                                      |
| Failure streak                                             | `panel_health.unusable_streak`                                                                          | The stored count, not one re-derived from history. The sales gate compares this same number with `PANEL_UNHEALTHY_AFTER_FAILURES`.                                   |
| Services                                                   | `services` grouped by state, excluding TERMINATED                                                       | Uses the same index and predicate as the capacity count.                                                                                                             |
| Capacity                                                   | `PanelCapacityRepository` (Phase 6B reservation rows and the operator's cap)                            | The same `capacity` object the panel list returns.                                                                                                                   |
| Sellable / reason                                          | `decideEligibility`, the one evaluator                                                                  | Includes the new `DRAINING` reason.                                                                                                                                  |
| Provisioning failures                                      | `provisioning_operations` with state FAILED, `completed_at` in `[now − 24h, now)`                       | Window is `PANEL_HEALTH_FAILURE_WINDOW_MS`. Also shows the newest failure's kind. Served by the online index `provisioning_operations_failed_recent_idx`.            |
| Unknown outcomes                                           | `provisioning_operations` with state UNKNOWN                                                            | Each one waits for a READ. None is retried, and none is refunded.                                                                                                    |
| Open conditions                                            | `operational_events`, unresolved, looked up by the exact dedupe keys `panelConditionKey(code, panelId)` | `PANEL_CONDITION_CODES` is derived from the monitor's `conditionOf` and the capacity alert codes, so a new code appears automatically. No code was renamed or added. |
| Drain                                                      | `panels.drained_at` and `drain_reason`                                                                  | Who drained it is in the `panel.drain` audit row.                                                                                                                    |

Usage-sync failures are not stored separately per panel. A failed `SYNC_USAGE`
operation already counts in the provisioning-failure figures above. The page does
not invent a separate "sync health" number.

## Drain

Drain means **no new allocations on this panel**. Nothing else changes.

- **It is not a status.** `DISABLED` stops the monitor probing the panel and
  stops every operation against it. A drained panel stays `ACTIVE` and monitored.
  Every existing service on it keeps renewing, suspending, resuming, syncing and
  terminating, because `decideOperability` never reads drain. Its schedule row is
  not touched.
- **It is enforced in one place:** `decideEligibility`, reason `DRAINING`. That
  reason comes right after `ARCHIVED` and `DISABLED`, because it is a decision
  and not a measurement. The evaluator's existing callers get it with no new
  check anywhere else:
  - **Catalogue** (`evaluate`, `evaluateMany`, `eligiblePanelIds`): the product
    is hidden.
  - **Confirmation** (`acquire`, under the panel lock): the order is refused with
    `PANEL_NOT_ELIGIBLE` / `DRAINING`, and no slot is taken.
  - **Settlement** (`consume`): refused only if the order's capacity hold is
    gone. An order confirmed before the drain whose hold is still there already
    has its slot, so it settles. Refunding it would penalise the customer for a
    decision made after they paid. If the hold lapsed, settling would be a new
    allocation, so it is refused, and the money goes back through the ordinary
    undeliverable-refund path.
  - **Release**: unaffected. Giving a slot back is never refused.
- **Serialisation:** the drain write takes the same panel row lock that
  confirmation takes. So either a sale takes its slot first (and later settles),
  or the sale sees the drain and is refused.
- **Nothing is migrated, terminated or deleted** by draining.
- **Write path:** permission `panels.drain` (HIGH), seeded on owner and
  technical, and backfilled by migration 0172. Then zod validation (a reason is
  required for both drain and undrain), the idempotency key, and scope activity
  checked inside the transaction. The write itself is a conditional state change
  under the lock, with a `panel.drain` audit row holding before and after values
  (the undrain reason is stored only in the audit row). A request for the state
  the panel is already in records nothing. Archived panels are refused.

## Manual probe

The page's "Test connection" button calls the existing `POST /panels/:id/test`,
which is `PanelService.testConnection`. That goes through `attemptProbe` in
`probe-core.ts`, the single probe implementation. It shares the cooldown and the
tenant budget with the monitor.

## Hook for the Notification Center (B3)

This page reads failures; it does not record them. Panel failures are already
written to `operational_events` by the monitor, inside the probe's transaction.
Each has a dedupe key and an explicit recovery event, and capacity alerts work
the same way. B3 should subscribe to those rows (the codes in
`PANEL_CONDITION_CODES`, keyed `panelConditionKey(code, panelId)`), not to this
page. Then a panel going down is announced whether or not anyone has the page
open. Drain is an operator decision recorded in the audit log (`panel.drain`),
not a failure, so it opens no condition.

## What C3 (automatic balancing) can reuse

- **`decideEligibility`** with `DRAINING` is already the "may this panel take
  new accounts" question a balancer must ask. A balancer should pick among the
  panels `PanelSalesGate.eligiblePanelIds` returns, and never build a second
  predicate.
- **Drain** is the operator's "stop placing here" signal, and it lets existing
  services finish. Rebalancing is a separate, explicit act, never a side effect
  of draining.
- **`PanelCapacity`** (`used`, `available`, reservations) is the load figure to
  balance on. `PanelFleetStatsReader` adds services by state and recent failure
  counts per panel in one grouped query per page.
- **`PANEL_CONDITION_CODES` with `openConditionDetails`** answers "is anything
  open on this panel" without a second health model.
