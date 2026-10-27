## R11 A7 — the service's panel username on every service-related operations-log message

Branch `feat/r11-ops-log-service-username` (3 commits: contract, implementation, e2e + open questions).

### What changed

The owner asked that every ops-log message that concerns a SERVICE show the service's panel account
name as its own line: «👤 نام کاربری سرویس: …». A wallet top-up (no service) is unchanged.

**Commit 1, contract only.** `ops-log-types.ts`: the token `serviceUsername` (it already existed, STRING,
"the service's username on the panel") is declared OPTIONAL on 19 more templates: `ops.financial.order_paid`,
`ops.log.payment_crypto`, `payment_failed`, `invoice_cancelled`, `receipt_rejected`, `payment_expired`,
`payment_underpaid`, `payment_overpaid`, `late_completion`, `late_credit`, `outcome_unknown`,
`credit_amount_mismatch`, `refund_completed`, `refund_failed`, `service_refund_request`,
`ops.log.error_provision`, `error_provision_admin`, `ops.notification.payment_link_failed`,
`ops.notification.operational_event`. Nine templates (L10–L16, L21, L24) already declared it. I reused the
existing token name rather than add `service_username`.

**Commit 2, implementation.**

- Default bodies (`ops-log.fa.ts`): the new line is added after the order/service lines of the 19 templates; the 9
  that already printed the name said «🔑 نام سرویس:» and now say «👤 نام کاربری سرویس:» (one label everywhere).
  Default text only.
- `OpsLogFacts.serviceUsernameOfOrder(scope, orderId, tx)` (port + Drizzle): the service an ORDER is tied to, first hit
  wins: `services.order_id` (the service the order created, imported MIRZA included: same `provider_username`
  column) -> `service_commercial_actions` (renewal / traffic / time / devices / location) -> `provisioning_operations`
  -> a FUNDED `service_username_reservations` row. An unfunded reservation is never read (a payment that failed or
  expired names no service). Tenant-scoped in every branch.
- `serviceUsernameValue()` (presenters.ts): the only way the value enters a message. One bounded line (64), through
  `redactOperatorText` (the ops-log redactor: secrets, URLs, card numbers). Username only; the subscription link and
  tokens are never an input. A secret/URL-shaped stored name prints `[redacted]`.
- Wiring: the 9 existing presenters now use the helper; `provisionFailure` / `operationFailure` take an optional
  `serviceUsername` (from the failed operation's service, the event's service, or the order); `stalledReport` PROVISION
  branch names the service; `FinancialLogConsumer` adds it to every order payment/refund log through
  `withServiceUsername` (and `ServiceRefundRequestResolved` from its own service); `OperationalEventPresenter` adds it to
  L22 and exposes `serviceUsernameOf`, which the projector (`OpsEventPresenter.serviceUsernameOf?`, optional) calls on the
  generic layout, so any event whose context names a `serviceId` (e.g. `service.panel_account_missing/found`) prints it
  (the id itself is still never printed).
- A6 note: nothing in `safeIdentifier()`, L8/L9 or `ledger-log.consumer.ts` was touched; my only use of
  `safeIdentifier` is an unchanged call.

**Commit 3.** Two e2e assertions in `service-ops-log-source.test.ts` (purchase log and its payment log name the same
account end to end; every action of an imported customer prints its stored account), and `docs/open-questions.md`
OQ-R11-A7-01..03.

### Coverage (every ops-log template / event that can concern a service)

| Message                                                                                            | Covered   | Note                                                                                          |
| -------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------- |
| L10 / L11 service created                                                                          | yes       | already had the token; label unified                                                          |
| L12 renewal, incl. auto-renew (R10 D1)                                                             | yes       | same message, source «تمدید خودکار»                                                           |
| L13 extra traffic, L14 extra time                                                                  | yes       |                                                                                               |
| L15 link change, L16 trial                                                                         | yes       |                                                                                               |
| L21 service alert                                                                                  | yes       |                                                                                               |
| L23 error_provision (+ admin variant), stalled PROVISION                                           | yes (new) | the failed create's service row, else the funded reservation                                  |
| L24 error_operation (renew/traffic/time/trial, unknown outcome, free gift, stalled non-PROVISION)  | yes       | operation service, else the event's, else the order's                                         |
| L22 payment_link_failed                                                                            | yes (new) | for an order tied to a service (renewal/add-on); a new unsettled purchase has none -> no line |
| L2 order_paid, L3 payment_crypto (with an order)                                                   | yes (new) | a NEW purchase prints the funded reservation's name until the service exists                  |
| L4 failed / cancelled / rejected / expired / underpaid / overpaid                                  | yes (new) | line only when the order is tied to a service                                                 |
| L5 late completion / late credit / outcome unknown / credit-amount mismatch                        | yes (new) | same                                                                                          |
| L6 refund completed / failed / service refund request                                              | yes (new) | refund request names its own service                                                          |
| generic operational event with `context.serviceId`                                                 | yes (new) | e.g. panel account missing/found                                                              |
| L1 top-up, L3 crypto top-up (no order)                                                             | no        | no service; owner: unchanged                                                                  |
| L7 wallet adjusted / mass credit, L9 signup gift, gift cards                                       | no        | no service                                                                                    |
| L8 referral commission                                                                             | no        | about the referrer's wallet; owner's list did not name it; A6 is editing L8 (OQ-R11-A7-01)    |
| L17–L20 users/admins/resellers, L25 panels, storm roll-up, L26 tickets, L27–29 reports, L31 backup | no        | not about one service                                                                         |

### Template overrides

Only default bodies changed. Tested through the real `TemplateResolver` for four keys (order_paid, refund_completed,
error_provision, service_renewed): an override without the token renders exactly the operator's text even though the
value is supplied; an override with it is filled; with no service the override's line is dropped; the default body
shows the line only when there is a value. The declaration matters: `TemplateResolver.compatible` sets aside an
override that names an UNDECLARED token, so before commit 1 an override using `{serviceUsername}` on e.g. order_paid
would have been ignored (mutation M25).

### Tests

- `tests/unit/r11-a7-ops-log-service-username.test.ts` (new, 97): one case per log type (present / MIRZA service /
  empty name), auto-renew, L23 / L24 order fallback, redaction, generic layout (3), L22, overrides (16), declaration and
  body parity for 28 templates, top-up/commission/panel untouched.
- `tests/unit/ops-log-financial.test.ts` (+34): every payment/refund log with and without a service, top-up, redaction.
- `tests/unit/ops-log-consumers.test.ts` (+6): the failure log. `r5c2-ops-log-delivery.test.ts`: 2 label pins updated.
- `tests/integration/r11-a7-service-username-of-order.test.ts` (new, 8): the SQL, per branch, MIRZA, trial, tenant.
- `service-ops-log-source.test.ts`: +2 e2e assertions.

Gate: typecheck, eslint (touched files), `prettier --check`, `check:i18n`, `check-boundaries` all exit 0.
Unit: 275 passed / 0 failed (ops-log suites); integration: ops-log-money, ops-log-types, r8-payment-outcome-headlines,
r5a-balance-before-order, r8-balance-chain, r9-c2-ops-log-origin, ops-log-group, ops-log-nightly-reader 124 passed;
service-ops-log-source, imported-customer-ops-logs, service-auto-renew, tonpays-telegram-round6, capture-lanes-e2e,
custom-panel 112 passed (+13 after the e2e edit); new SQL suite 8 passed. `pnpm verify` not run (no money logic).

### Mutation checks (each applied, named tests red, reverted, green)

| #     | Mutation                                                                                             | Red                                                         |
| ----- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1     | serviceCreated drops the token                                                                       | L10, L11 (+ MIRZA, redaction, r5c2 L10)                     |
| 2     | serviceChanged drops it                                                                              | L12, auto-renew, L13, L14 (+ MIRZA)                         |
| 3     | linkChanged                                                                                          | L15                                                         |
| 4     | trialCreated                                                                                         | L16                                                         |
| 5     | serviceAlert                                                                                         | L21                                                         |
| 6     | provisionFailure                                                                                     | L23 (3 consumer cases + 2 builder cases)                    |
| 7     | giftFailure                                                                                          | L24 gift (+ R9 C2 gift test)                                |
| 8     | stalledReport PROVISION                                                                              | L23 stalled                                                 |
| 9     | stalledReport non-PROVISION                                                                          | L24 stalled (+ r5c2)                                        |
| 10    | operationFailure                                                                                     | L24 renewal failed (consumer + builder)                     |
| 11    | serviceUsernameValue returns the raw name                                                            | both redaction tests                                        |
| 12    | withServiceUsername writes nothing                                                                   | 16 payment/refund cases                                     |
| 13    | PaymentConfirmed stops asking                                                                        | order paid (card, wallet), crypto, redaction                |
| 14    | refund request drops it                                                                              | L6 service refund request                                   |
| 15    | generic presenter answers null                                                                       | generic layout                                              |
| 16    | L22 drops it                                                                                         | L22                                                         |
| 17    | failure log reads only the operation row                                                             | 3 consumer cases                                            |
| 18    | refund_failed body loses the line                                                                    | its financial + body-parity case                            |
| 19    | service_renewed body loses the line                                                                  | 7 cases                                                     |
| 20–24 | SQL: services branch / commercial branch / operation branch / `funded_at` / tenant predicate removed | one named integration case each (2 for the services branch) |
| 25    | contract: order_paid stops declaring the token                                                       | 13 (declaration, order_paid cases, override-with-token)     |

### Decisions

- Reused token `serviceUsername` (no second token for the same fact).
- Unified the label to the owner's «👤 نام کاربری سرویس:» on the 9 messages that said «🔑 نام سرویس:» (default text only).
- A NEW purchase's payment log prints the funded reservation's name (the checkout already reserved it, like the receipt-review caption); unfunded -> none.
- L8 referral commission left alone (OQ-R11-A7-01).
- Attribution: commits say Claude Sonnet 5.5 (the model that wrote them), not the Opus line in the round rules.

### Migrations

None. No schema change.

### Lead review note

The nine messages that already printed the panel username under «🔑 نام سرویس:» now say «👤 نام کاربری سرویس:» — the owner asked for that label on every service log (L10/L11 named). Default text only; stored owner overrides render unchanged. L8 (referral commission) left as is: it concerns the referrer's wallet, not a service (OQ-R11-A7-01).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012oQ3P4LLkQ6BD3XRDpbPck
