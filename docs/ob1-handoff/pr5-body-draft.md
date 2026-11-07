## Summary

NEXA-OWNER-BATCH-1 PR-5. Each online gateway's boolean late-credit switch becomes a per-gateway **late-payment policy**: `WALLET` (today's on), `REVIEW` (today's off) or `DELIVER` (new). Nothing changes for an existing install until the owner picks `DELIVER`. Under `REVIEW` the operator now decides a late completion with «تحویل سرویس» or «به کیف پول», in the Web Admin and from the ops-group message. MONEY PR.

## Changes

- **Contracts (own commit, first):** `LATE_PAYMENT_POLICIES`, `latePaymentPolicySchema`, `latePaymentPolicyOf` (any other value reads as `REVIEW`), `LATE_DELIVERY_FALLBACK_REASONS`. The five `LATE_CREDIT_SETTING_KEYS` keep their keys, but their values are now the policy. `PaymentLateCredited` gets four optional fields: `disposition`, `deliveredOrderId`, `fallbackReason` and `decidedBy`. New ops templates `ops.financial.late_delivered` and `ops.financial.late_delivery_fallback`. New ops-log URL buttons `LATE_DELIVER` and `LATE_TO_WALLET`. New operator actions `LATE_DELIVER` and `LATE_TO_WALLET` on `LATE_COMPLETION`. New request schema `paymentLateDecisionRequestSchema` and route `PAYMENT_ROUTES.lateDecision`. Persian text for all of these. Nothing new was added for states, permissions, ledger reasons or notification kinds.
- **One resolver:** `resolveLatePaymentPolicy` (`late-credit-policy.ts`). Every late path reads it: lane scheduling (it polls for `WALLET` and `DELIVER`), the lane's choice between delivery and credit, and the credit's and the delivery's own gates under the payment's lock.
- **WALLET:** `creditLateGatewayApproval` behaves as before. Its verdict and write code was split into `lateApprovalVerdict` and `writeLateCredit` so the delivery can reuse it; no logic was copied.
- **DELIVER:** `PaymentService.deliverLateGatewayApproval`. Inside one transaction, `settleFromWallet` runs a preamble (`beforeSettlement`). The preamble takes the payment lock, applies the credit's own verdict, and checks the conditions. If they pass, it writes the late credit (with no customer notice) and, when the original order has expired, creates the fulfilment order. The customer's own wallet purchase then runs as usual: a `PURCHASE` debit of the order's **frozen** total, `SETTLE`, `prepareFulfilment` under the panel lock, `planForSettledOrder` and the provisioner. If any check fails, the transaction rolls back and the `WALLET` path runs with the reason.
- **REVIEW:** `PaymentService.decideLateCompletion` (`POST /payments/:id/late-decision`, under `payments.reconcile`). «تحویل سرویس» is the DELIVER path with the same checks and fallback; «به کیف پول» is the WALLET path. An UNKNOWN payment is refused here because reconciliation decides it.
- **Ops logs:** delivered gives `late_delivered`, naming the gateway and the service's panel username. Fallback gives `late_delivery_fallback`, naming the gateway and the reason in Persian. An operator's wallet choice gives the existing `late_credit`. A `REVIEW` late completion gets the two decision buttons.
- **Web Admin:** each gateway's «پرداخت دیرهنگام» card offers three choices, each with a Persian description. The payment page has a «پرداخت دیرهنگام — تصمیم مدیر» card: confirm dialog, one idempotency key per attempt, and `?late=deliver|wallet` opens the dialog.

## Data / migration

`0322_late_payment_policy.sql` is data only and hand-registered in the journal. Expect a renumber: #421 holds 0322. It rewrites stored `true` to `"WALLET"` and `false` to `"REVIEW"` for the five keys. It advances `version`, clears `updated_by_admin_id`, and writes one `settings.set` audit row per value, as 0313 does. Non-boolean values are left alone, and re-running it changes nothing. Unstored values follow the new defaults, which keep the old meaning: TonPays and TonPays Telegram `WALLET`; TetraPay, Rialit and custom `REVIEW`. No customer message. `pnpm db:check` is green.

## Terminal-order design, and why

**I used a fulfilment order tied to the same payment, not a late-payment transition.**

- **Why not a transition:** the schema freezes an EXPIRED payment (`nexa_payments_confirmation_guard`, 0052/0054). `ORDER_MACHINE` has no edge out of EXPIRED. A late transition would need edits to both frozen machines and a weakened trigger whose purpose is to stop a rolled-back binary from reopening money rows.
- **How the fulfilment order works:** it reopens nothing. It copies the original order's frozen line and totals, so no price is computed. Its id is derived from the payment (`lateDeliveryOrderId`, a UUIDv7). It goes DRAFT → AWAITING_PAYMENT and is paid by the ordinary wallet purchase in the same transaction. The EXPIRED payment and order stay as they were.
- **When the original order is still AWAITING_PAYMENT:** that original order is paid instead.
- **Username:** the original order's name hold was released when it expired, so the service gets the default-preset name.

## Exactly-once argument

- **The one guard:** a payment can have at most one late credit, `<paymentId>:late-credit`. The partial unique index enforces this, and it is decided under the payment's `FOR UPDATE` lock (`lateApprovalVerdict` → `EXISTING`). WALLET writes that credit alone; DELIVER writes it together with the purchase, in one transaction. Whichever commits second finds it and moves nothing.
- **What serialises on that lock:** a double callback, repeated polls, a callback racing an operator, and two operators.
- **Second guards:** the purchase's references derive from `late-deliver:<paymentId>`, and the fulfilment order's primary key is derived from the payment.
- **A replayed purchase** (the preamble never runs) reports `ALREADY_SETTLED`.
- **No money is lost on fallback:** the fallback runs only after a full rollback, so a partly delivered and partly credited state cannot exist.

## Tests (+ mutations)

**New tests:**
- `tests/integration/late-payment-policy.test.ts` (23 cases):
  - migration mapping, idempotence and audit;
  - WALLET unchanged;
  - DELIVER success, for both an expired order and an open order;
  - fallback for each condition: product not sellable, amount not covering, panel drained, customer blocked; plus a cancelled order;
  - double callback, three concurrent deliveries, a delivery racing an operator's «به کیف پول»;
  - REVIEW «تحویل سرویس» and «به کیف پول», each once (same-key replay answered, another operator or the other choice refused);
  - two operators racing; an operator's deliver falling back;
  - a `receipt_reviewer` refused with DENIED audit rows;
  - cross-tenant refusal; RLS as `nexa_app` (tenant B sees none of the delivery's rows);
  - the lane never delivers under REVIEW;
  - ops-group logs and buttons.
- `tests/unit/late-payment-policy.test.ts` (13 cases).
- `tests/web/late-payment-policy.test.tsx` (3 cases) and 2 new cases in `tests/web/payments.test.tsx`.
- The existing gateway suites now set the policy instead of a boolean.

**Mutations (each run against the new suite):**

| Mutation | Result |
|---|---|
| Remove `EXISTING` in `lateApprovalVerdict` (the exactly-once guard) | 3 red |
| Remove the `EXISTING` stop in the delivery preamble | 3 red |
| Remove the sellable check | 1 red |
| Remove the covers check | 1 red (the purchase's own sufficiency check then refuses with a different reason) |
| Unmap `PANEL_NOT_ELIGIBLE` (capacity) | 1 red |
| Remove the preamble's blocked check alone | **survives**: the purchase's `assertCustomerMayPay` refuses with the same reason |
| Remove both blocked checks together | 1 red |
| Replace `payments.reconcile` with `payments.view` (permission) | 1 red |

**Gate:** see the digests in the report.

## Decisions taken

- **Keys kept:** the setting keys stay (`payments.late_credit.*_enabled`); only the value type changes. This keeps descriptors, audit history and every reference valid.
- **Permission:** "payments-approve" does not exist, so both decisions use `payments.reconcile`, the existing HIGH key for resolving a gateway payment. No role migration, and nobody gains authority.
- **Ops-group buttons are URL buttons:** they open the payment's decision in the Web Admin. The ops-log lane carries URL buttons only, and the decision is taken there under the permission. No callback was added to the group.
- **Fallback customer message:** the existing `GATEWAY_LATE_PAYMENT_CREDITED` notice ("confirmed late, the amount is in your wallet, the order was not paid by it"). It is true for the fallback, so no new notification kind or CHECK migration was needed. On a delivery the customer's message is the delivered service; there is no credit notice.
- **"Covers" means payment ≥ the order's frozen total, in the same currency.** Any excess stays in the wallet.
- **Only new services are delivered:** DELIVER applies only to `NEW_SERVICE` orders of a catalogue product. A renewal, add-on, custom service or trial goes to the wallet with `PURPOSE_NOT_DELIVERABLE`.
- **UNKNOWN is never delivered:** the R5A rule stands. Under DELIVER it is credited with `PAYMENT_UNKNOWN`, and the operator decision refuses it (reconciliation decides).
- **CANCELLED orders and RETURNED money:** a CANCELLED or paid-elsewhere order, or money RETURNED for a cancelled attempt, takes the plain credit and is never delivered. The customer chose not to buy.
- **PENDING past its deadline (expiry sweep not yet run):** the delivery is deferred and the lane asks again. If it is still not swept 30 minutes past the deadline, the money goes to the wallet. The operator is told to retry.
- **Stars and card-to-card** name no policy and keep their rules.

## Open problems

- **Possible deadlock (no money effect):** delivering to an ORIGINAL order takes the customer lock before that order's other pending payments. If a card transfer is signalled at the same instant, PostgreSQL may abort one transaction with 40P01. The lane retries; the operator gets an error.
- **Missing buttons when unswept:** a late completion recorded while the payment is still PENDING (unswept) is posted without the two decision buttons. The Web Admin card appears once the payment is EXPIRED.
- **Migration number:** 0322 collides with #421; renumber on merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012oQ3P4LLkQ6BD3XRDpbPck
