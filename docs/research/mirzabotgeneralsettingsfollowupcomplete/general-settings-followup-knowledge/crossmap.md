# Cross-checks against earlier phases

Each link is marked **VERIFIED** (both sides observed and they line up), **INFERRED** (strongly
suggested, not proven), or **UNKNOWN**.

## 1. `📣 گزارشات ربات` ↔ Robot Statistics / cron reporting
- **Verdict: NO OVERLAP — VERIFIED.**
- `📊 آمار ربات` is a live statistics viewer on the admin root. `📣 گزارشات ربات` holds a delivery
  address and nothing else. Neither references the other, and no cron in the 8-cron group sends a
  report. The name collision ("گزارشات" / "آمار") is the only connection.
- **Consequence:** the phase brief's hypothesis that this might be report configuration is
  **disproved**. Scheduled reporting does not appear to exist in the product (UNK-GS-012).

## 2. `📣 گزارشات ربات` ↔ admin notification capabilities
- **Verdict: INFERRED.**
- `👤 اعلان کاربر جدید` (new-user notification, **✅ ON**) is an admin-facing notification with no
  destination field of its own. The only destination field in the product is this group id.
- Not proven: nothing in either screen names the other, and the full notification set is UNKNOWN
  (UNK-GS-011).

## 3. `📯 تنظیمات کانال` ↔ per-user channel-membership exemption
- **Verdict: VERIFIED.**
- User Management exposes button #25 `📑 احراز عضویت کانال` on the per-user keyboard, whose audit-log
  verb is `«معاف کردن از کانال»` — "exempted from channel". The web admin panel shows the same as
  `معاف از احراز هویت کانال`.
- An exemption implies a rule to be exempted from. This section is that rule. The two are the same
  mechanism seen from the global and the per-user end.

## 4. `📯 تنظیمات کانال` ↔ the earlier Telegram-side observation
- **Verdict: VERIFIED.**
- `telegram-knowledge/unknowns.md` recorded an unexplained admin-style string seen in chat history:
  `برای فعال کردن قابلیت اجباری عضویت یک کانال اضافه کنید`. That is this screen's prompt, almost
  verbatim. **That open question is now closed** — it was this section, not a stray group-admin
  instruction.

## 5. `📯 تنظیمات کانال` ↔ the 31 bot capabilities
- **Verdict: NO LINK — VERIFIED.**
- The capability list contains gates for rules (`♨️ قوانین`), identity (`🔒 احراز هویت`,
  `🔑 احراز هویت با لینک`) and phone (`☎️ احراز هویت شماره تماس`, `🇮🇷 تایید شماره ایرانی`) — but
  **no channel-membership flag**. Forced-join is switched purely by the presence of channel rows
  (GSR-004), which makes it the only gate in the product without a capability cell.

## 6. `🗑 بهینه سازی ربات` ↔ the deletion crons
- **Verdict: RELATED BUT DISTINCT — VERIFIED (that they differ); UNKNOWN (whether they interact).**
- `❌ کرون حذف` deletes **panel services** 3 days after time expiry; `❌ کرون حذف حجم` deletes them
  2 days after last connection when traffic is exhausted (Marzban).
- Optimization class 6 ("orders whose time or volume ran out") targets the same population, but the
  object is the **bot's order record**, not the panel service.
- Whether optimization respects the crons' grace windows is UNKNOWN (UNK-GS-008).

## 7. `🗑 بهینه سازی ربات` ↔ Financial / receipts
- **Verdict: INFERRED, and this is the sharpest risk found.**
- Class 2 deletes **unpaid orders**. The Pending Receipts phase found a queue of unapproved
  receipts, and the Financial phase established there is **no payment list, no ledger and no
  reporting anywhere in Financial** — per-payment history lives only in User Management and in the
  order records themselves.
- So the records this action destroys are, in several cases, the only surviving evidence of a
  disputed or in-flight payment. Not proven at the database level, but it follows from what both
  phases established about where payment history lives.

## 8. `⚠️ مبلغ هشدار موجودی` ↔ `⚠️ اعلان کاهش موجودی`
- **Verdict: VERIFIED (semantic correspondence); INFERRED (code-level gating).**
- Threshold text and capability label describe the same event — a user's balance falling to a point
  where the user is messaged. The capability is `❌ خاموش`, so the threshold is inert (GSR-008).
- Upgrade note: the previous phase recorded this pairing as INFERRED on the basis of the labels
  alone. Having now read the threshold's own prompt, the *semantic* match is verified; only the
  wiring remains an inference.

## 9. `⚠️ مبلغ هشدار موجودی` ↔ Financial wallet settings
- **Verdict: RELATED — VERIFIED.**
- Same domain (customer wallet, Toman), but a different axis: Financial's `⬇️ حداقل شارژ موجودی`
  governs **top-up minimums** and is **tier-segmented** (`f` 50,000 / `n` 100,000 / `n2` 20,000);
  this warning threshold is a **single global** number (GSR-009).
- **Consequence for a rebuild:** tier-segmentation is a per-setting decision in MirzaBot, not a
  product-wide convention.

## 10. `⚠️ مبلغ هشدار موجودی` ↔ reseller debt (`💎 تسویه بدهی`)
- **Verdict: UNKNOWN / probably unrelated.**
- `💎 تسویه بدهی` (debt settlement, `❌ خاموش`) concerns the Advanced-Reseller negative-balance
  ceiling. Nothing observed connects it to this threshold. Do not merge them.
