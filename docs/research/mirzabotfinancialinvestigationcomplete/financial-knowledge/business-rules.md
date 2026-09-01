# Financial Business Rules (FBR-###)

## FBR-001 — `💎 مالی` is exclusively a payment-gateway manager

- **Rule**: the section contains 11 gateway rows and 5 global settings, and nothing else. No payment
  list, ledger, refund screen, report or dashboard exists here.
- **Evidence**: full inline markup read from the DOM; the header states the purpose explicitly.
- **Scope**: the whole Financial surface.
- **Confidence**: VERIFIED_BY_UI.

## FBR-002 — Every gateway carries four row-level controls

- **Rule**: each gateway exposes `⚙️` settings, an `✅`/`❌` enable toggle, a customer-facing button
  colour (`⚪🔴🟢🔵`), and `⬆️`/`⬇️` display ordering — all identical across all 11 gateways.
- **Evidence**: read from the markup; the header defines the colour and ordering semantics.
- **Financial effect**: the toggle determines whether customers can pay through that route at all.
- **Confidence**: VERIFIED_BY_UI for the controls; their commit behaviour was deliberately not tested.

## FBR-003 — Gateway button colour reuses the product-button colour concept

- **Rule**: the header says the colour is "مثل محصولات" (like products), i.e. the same Telegram button
  styling idiom documented in the Store phase for `🎨 رنگ محصول`.
- **Confidence**: VERIFIED_BY_UI.

## FBR-004 — Eleven gateways exist; three are enabled

- **Rule**: card-to-card, plisio, nowpayment, offline FX, three FX→Rial slots, آقای پرداخت, زرین پال,
  a custom gateway, and Telegram Stars. Enabled: **nowpayment, درگاه سفارشی, Star Telegram**.
- **Cross-check**: the Web-Admin phase counted "11 configurable gateways" → **MATCH**.
- **Confidence**: VERIFIED_BY_UI.

## FBR-005 — Gateway availability is conditional on a user's payment history and account age

- **Rule**: the card-to-card schema exposes `🔒 فعال‌سازی ... پس از X پرداخت`,
  `🚫 غیرفعال‌سازی ... پس از X پرداخت` and `⏳ فعال‌سازی ... پس از X روز عضویت`.
- **Cross-check**: matches the Web-Admin phase's "min membership days, min successful payments,
  hide-after-N" → **MATCH**, now with verbatim labels.
- **Financial effect**: a customer's available payment methods depend on their own history.
- **Confidence**: VERIFIED_BY_UI.

## FBR-006 — Per-gateway cashback is configured inside the gateway

- **Rule**: `💰 کش بک کارت به کارت` sits in the gateway's own settings, confirming gateway cashback as a
  mechanism distinct from wallet-topup cashback (per user tier, in Store settings) and renewal cashback
  (global, in Store settings).
- **Confidence**: VERIFIED_BY_UI for existence; the value was not read and nothing was changed.

## FBR-007 — Receipt auto-approval is a three-setting risk surface

- **Rule**: card-to-card has `♻️ تایید خودکار رسید` (auto-approve), `🤖 تایید رسید  بدون بررسی`
  (approve with no review) and `⏳ زمان تایید خودکار بدون بررسی` (the delay), plus
  `💳 استثناء کردن کاربر از تایید خودکار` (per-user exemption).
- **Financial effect**: these decide whether money claimed by a receipt is credited without a human
  ever looking at it.
- **Confidence**: VERIFIED_BY_UI.

## FBR-008 — Amount limits exist at two layers

- **Rule**: global `⬆️ حداکثر شارژ موجودی` / `⬇️ حداقل شارژ موجودی` on the Financial root, **and**
  per-gateway `⬆️ حداکثر مبلغ کارت به کارت` / `⬇️ حداقل مبلغ کارت به کارت`.
- **Which takes precedence is UNKNOWN** — deliberately not resolved, as it would require changing a value.
- **Confidence**: VERIFIED_BY_UI for the existence of both layers; UNKNOWN for precedence.

## FBR-009 — All gateways share one 8-control base schema

- **Rule**: every gateway inspected exposes exactly the same eight controls — name, cashback, tutorial,
  min amount, max amount, enable-after-N-payments, disable-after-N-payments, enable-after-N-days —
  differing only in gateway-specific credential/endpoint fields.
- **Evidence**: five gateways opened read-only (card-to-card, nowpayment, custom, ZarinPal, Star).
- **Significance**: gateway configuration is uniform and per-gateway; cashback and amount limits are
  **not** global properties but attributes of each payment route.
- **Confidence**: VERIFIED_BY_UI for the five inspected; INFERRED for the six not opened.

## FBR-010 — No gateway exposes a fee, currency or exchange-rate field

- **Rule**: none of the five inspected schemas contains a gateway fee, a currency selector, a crypto
  network, a confirmation count or a payment-expiry field. `💫Star Telegram` in particular has **no
  conversion-rate setting whatsoever** despite Bot Statistics reporting Stars as its own financial line.
- **Evidence**: full button lists read from the DOM.
- **Consequence**: gateway economics (fees, FX) are either hardcoded or live outside the Telegram admin.
  The three `ارزی ریالی` slots and `ارزی آفلاین` were not reached and may yet carry rate fields — that
  is the main open question of this phase.
- **Confidence**: VERIFIED_BY_UI (absence, for the five inspected); UNKNOWN for the FX gateways.

## FBR-011 — Gateway gating is by payment history and account age, never by user tier

- **Rule**: the three gating controls on every gateway key off the customer's **payment count** and
  **days since joining**. No `f` / `n` / `n2` restriction appears anywhere in gateway settings.
- **Contrast**: product visibility, discount codes and cashback-on-topup all key off the tier. Payment
  routes do not.
- **Confidence**: VERIFIED_BY_UI for the five inspected.

## FBR-012 — The minimum wallet top-up is set per user tier, not globally

- **Rule**: `⬇️ حداقل شارژ موجودی` holds three values — `کاربر عادی` 50,000, `نماینده عادی` 100,000,
  `نماینده پیشرفته` 20,000 تومان.
- **Evidence**: the prompt prints all three current values.
- **Correction**: supersedes the earlier "min top-up = 50,000" reading, which was the `f` value only.
- **Anomaly**: the Normal Reseller minimum is the highest and the Advanced Reseller's the lowest —
  flagged for the owner, cause UNKNOWN.
- **Confidence**: VERIFIED_BY_UI.

## FBR-013 — A Financial value prompt captures the conversation until answered or reset

- **Rule**: while a Financial setting is awaiting a value, clicking another inline button returns
  `⭕️ ورودی نا معتبر` instead of navigating. Only a valid value or `/start` releases it.
- **Safety consequence**: the next ordinary message typed into the chat would be consumed as that
  setting's new value. Always `/start` out of a Financial prompt.
- **Confidence**: VERIFIED_BY_UI (reproduced twice).
