# Pre-support A9 — falsification record

Item: a QR of the exact link on the My Services link view (audit section 2, "A9"). PO default
applied: after `showLinkOnCard` shows the link on the card, ONE extra photo — the QR of the same
`sentUrl` — captioned with the existing `bot.service.delivered_qr_caption` key. `CARD_TEXT`
panels get no QR. The photo is claimed durably by the tap's Telegram update key before it is
sent, so a redelivered update never sends a second one. No new template key, no contract change.

Driver: `scripts/mutate-a9.py`. Each mutation reverts one rule, runs the named test, and
restores the file byte for byte. A mutant counts as killed only if the named test RAN and
failed. Run on 2026-10-05 against a dedicated integration database (`nexa_test_w1e`). The unit
test decodes the photo with `jsqr` (`tests/support/qr-decode.ts`) from the REAL PNG encoder.

| ID    | Rule reverted                                                        | Test that failed                                                            | Result |
| ----- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------ |
| A9-01 | The link view is followed by a QR photo (call removed)               | sends ONE QR photo that decodes to exactly the link the view shows (unit)   | KILLED |
| A9-02 | The QR encodes the EXACT shown link (one character appended)         | sends ONE QR photo that decodes to exactly the link the view shows (unit)   | KILLED |
| A9-03 | The caption is `bot.service.delivered_qr_caption`                    | sends ONE QR photo that decodes to exactly the link the view shows (unit)   | KILLED |
| A9-04 | A `CARD_TEXT` panel gets no QR (check removed)                       | sends no QR on a CARD_TEXT panel, and claims nothing (unit)                 | KILLED |
| A9-05 | A claimed tap sends nothing (claim answer ignored)                   | sends ONE QR for a replayed tap, and one per distinct tap (unit)            | KILLED |
| A9-06 | Only a view known to be on screen gets a QR (UNKNOWN admitted)       | sends no QR when the link view may not be on the screen (unit)              | KILLED |
| A9-07 | Tenant activity is read inside the claim's transaction (removed)     | sends no QR for a tenant that stopped between the view and the photo (unit) | KILLED |
| A9-08 | The runtime hands the tap's key down (not passed)                    | sends the subscription again when the customer asks … (integration)         | KILLED |
| A9-09 | The claim is the idempotency store's durable insert (always granted) | sends the subscription again when the customer asks … (integration)         | KILLED |
| A9-10 | The claim is per tap, not per service (keyed on the service id)      | sends the subscription again when the customer asks … (integration)         | KILLED |

10 of 10 killed.

## For the PO

The reused caption reads «📷 کد QR لینک اتصال شما. جزئیات سرویس در پیام بعدی آمده است.» —
"the service details are in the NEXT message". That is true for the delivery card's split
fallback it was written for, and not quite true here, where the link is in the message ABOVE
the photo. Changing it needs either a new template key (a contract change) or a copy change that
would also alter the delivery card's fallback, so neither is done in this PR.

A QR that Telegram declines or answers ambiguously is not retried: the claim stands, because a
photo that may already be on the screen must not be sent twice. The customer can tap again.
