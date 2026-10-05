# Pre-support A9 — falsification record

Item: a QR of the exact link on the My Services link view (audit section 2, "A9"). PO default
applied: after `showLinkOnCard` shows the link on the card, ONE extra photo — the QR of the same
`sentUrl` — captioned with its own key, `bot.service.link_qr_caption` (added after review: the reused
`delivered_qr_caption` said the details follow in the NEXT message, which is false here). `CARD_TEXT`
panels get no QR. The photo is claimed durably by the tap's Telegram update key before it is
sent, so a redelivered update never sends a second one. One contract change: the new caption
key, in its own commit.

Driver: `scripts/mutate-a9.py`. Each mutation reverts one rule, runs the named test, and
restores the file byte for byte. A mutant counts as killed only if the named test RAN and
failed. Run on 2026-10-05 against a dedicated integration database (`nexa_test_w1e`). The unit
test decodes the photo with `jsqr` (`tests/support/qr-decode.ts`) from the REAL PNG encoder.

| ID    | Rule reverted                                                                                    | Test that failed                                                                        | Result |
| ----- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------ |
| A9-01 | The link view is followed by a QR photo (call removed)                                           | sends ONE QR photo that decodes to exactly the link the view shows (unit)               | KILLED |
| A9-02 | The QR encodes the EXACT shown link (one character appended)                                     | sends ONE QR photo that decodes to exactly the link the view shows (unit)               | KILLED |
| A9-03 | The caption is a QR caption (made `bot.service.delivered`)                                       | sends ONE QR photo that decodes to exactly the link the view shows (unit)               | KILLED |
| A9-04 | A `CARD_TEXT` panel gets no QR (check removed)                                                   | sends no QR on a CARD_TEXT panel, and claims nothing (unit)                             | KILLED |
| A9-05 | A claimed tap sends nothing (claim answer ignored)                                               | sends ONE QR for a replayed tap, and one per distinct tap (unit)                        | KILLED |
| A9-06 | Only a view known to be on screen gets a QR (UNKNOWN admitted)                                   | sends no QR when the link view may not be on the screen (unit)                          | KILLED |
| A9-07 | Tenant activity is read inside the claim's transaction (removed)                                 | sends no QR for a tenant that stopped between the view and the photo (unit)             | KILLED |
| A9-08 | The runtime hands the tap's key down (not passed)                                                | sends the subscription again when the customer asks … (integration)                     | KILLED |
| A9-09 | The claim is the idempotency store's durable insert (always granted)                             | sends the subscription again when the customer asks … (integration)                     | KILLED |
| A9-10 | The claim is per tap, not per service (keyed on the service id)                                  | sends the subscription again when the customer asks … (integration)                     | KILLED |
| A9-11 | The link view's QR has its own caption (made `delivered_qr_caption`)                             | sends ONE QR photo that decodes to exactly the link the view shows (unit)               | KILLED |
| A9-12 | The same, end to end                                                                             | sends the subscription again when the customer asks … (integration)                     | KILLED |
| A9-13 | The delivery card's split fallback keeps `delivered_qr_caption`                                  | falls back to the photo then the card as text … (delivery-card unit)                    | KILLED |
| A9-14 | A claim that throws is swallowed (error escapes)                                                 | sends no QR when the claim cannot be written, and the link view still resolves (unit)   | KILLED |
| A9-15 | The QR follows the VIEW's outcome, not the edit's (edit result returned after the fallback send) | sends exactly one QR when the edit is refused and the view goes as a new message (unit) | KILLED |
| A9-16 | A rate-limited edit gets no QR and spends no claim (QR sent there)                               | sends no QR and claims nothing when the edit is rate limited (unit)                     | KILLED |

16 of 16 killed.

## For the PO

The first round reused `delivered_qr_caption` («… جزئیات سرویس در پیام بعدی آمده است.»), which is
false under the link view. Resolved: the link view now uses `bot.service.link_qr_caption`
(«📷 کد QR لینک اتصال بالا. می‌توانید آن را در برنامهٔ خود اسکن کنید.»), and the delivery card's
split fallback keeps the old key (A9-13).

The QR is a NEW message, so it arrives at the bottom of the chat. For an older card tapped
higher up the conversation it therefore lands away from the link view it belongs to, and every
new tap adds another photo (only a redelivery of the same update is suppressed).

A QR that Telegram declines or answers ambiguously is not retried: the claim stands, because a
photo that may already be on the screen must not be sent twice. The customer can tap again.
