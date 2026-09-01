# Business rules — pending receipts (PRBR-###)

## PRBR-001 — The section is a stateless one-shot query, not a screen

- **Rule**: `💵 رسید های تایید نشده` posts one message and attaches no keyboard. There is no sub-menu,
  no pagination, no refresh, no filter and no back button; the admin reply keyboard is unchanged.
- **Evidence**: message markup read from the DOM — the reply carries no inline keyboard at all.
- **Result**: the admin fires a query and reads the answer.
- **Confidence**: VERIFIED_BY_UI.

## PRBR-002 — An empty queue does not mean no receipts are arriving

- **Rule**: the queue is fed by card-to-card, which is **disabled** in this deployment. Separately,
  card-to-card's auto-approval settings can approve receipts before they ever reach the queue.
- **Evidence**: the Financial phase's gateway inventory (card-to-card `❌`) and its settings schema.
- **Result**: `❌ هیچ پرداخت تایید نشده ای ندارید.` is consistent with both "no receipts" and "receipts
  auto-approved" — the screen does not distinguish them.
- **Confidence**: VERIFIED_BY_UI for both inputs; INFERRED for the combined conclusion.

## PRBR-003 — Receipt approval can be fully automated, on a timer, with no review

- **Rule**: card-to-card exposes auto-approve, approve-without-review, an auto-approval delay, and a
  per-user exemption from auto-approval.
- **Evidence**: the four control labels read from the gateway settings schema.
- **Result**: money claimed by an uploaded receipt can be credited without any human ever seeing it.
- **Confidence**: VERIFIED_BY_UI (the settings exist); UNKNOWN (their current values).

## PRBR-004 — The reviewed entity is named inconsistently

- **Rule**: the menu calls it a **رسید** (receipt); the response calls it a **پرداخت** (payment).
- **Evidence**: `💵 رسید های تایید نشده` versus `❌ هیچ پرداخت تایید نشده ای ندارید.`
- **Result**: it is not established from this surface whether the reviewed record is a receipt attached
  to a payment, or a payment in an unverified state. That distinction matters for a rebuild.
- **Confidence**: VERIFIED_BY_UI (the wording); UNKNOWN (the underlying model).

## PRBR-005 — Receipt review sits outside `💎 مالی`

- **Rule**: the button is on the **admin root** keyboard, a sibling of `💎 مالی`, not inside it.
- **Evidence**: the 16-button admin keyboard read from the DOM.
- **Result**: MirzaBot treats reviewing money-in as an operational task separate from configuring
  payment routes — consistent with the Financial phase's finding that `💎 مالی` is *only* a gateway
  manager.
- **Confidence**: VERIFIED_BY_UI.
