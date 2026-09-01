# Business rules — global test-account limit (GTL-BR-###)

## GTL-BR-001 — The control is a global SETTER for a per-user test-account allowance
- **Rule:** `➕ محدودیت ساخت اکانت تست برای همه` takes one number and applies it as the
  test-account creation allowance for every user of the bot.
- **Scope:** all users. **Precondition:** none. **Action:** send a number.
- **Result:** `محدودیت ساخت اکانت برای تمام کاربران تنظیم شد`.
- **Evidence:** the prompt `تعداد ساخت اکانت تست را وارد نمایید.` and the success message, verbatim.
- **Confidence:** VERIFIED_BY_UI.

## GTL-BR-002 — It is a "set", not a "reset"
- **Rule:** the bot's vocabulary throughout is assignment (`تعداد` = count, `تنظیم شد` = was set).
  Nothing in the flow clears, zeroes or restores anything by that name.
- **Effect:** the owner's mental model — "reset the limitation so users can test again" — is achieved
  *only if* the stored field is a remaining balance. If it is a fixed cap, writing `1` sets the cap
  and restores nothing. That distinction is UNK-GTL-002 and is the single most important open point.
- **Confidence:** VERIFIED_BY_UI (the wording); the effect is UNKNOWN.

## GTL-BR-003 — Scope is the entire user base, unconditionally
- **Rule:** the write applies to `تمام کاربران` — all users — with no tier, panel, date or
  activity qualifier offered or mentioned.
- **Evidence:** the success message; the flow offers no filter of any kind.
- **Security effect:** a single unconfirmed message rewrites a field on ~197,000 user rows.
- **Confidence:** VERIFIED_BY_UI.

## GTL-BR-004 — There is no confirmation and no visible current value
- **Rule:** pressing the button arms an immediate write; the next ordinary message commits it. The
  screen never shows the limit currently in force, before or after.
- **Evidence:** baseline and post-write reads of the section are byte-identical.
- **Effect:** the operation is unauditable from its own screen, and mistyping `10` for `1` is a
  silent, uncorrectable-by-inspection change.
- **Confidence:** VERIFIED_BY_UI.

## GTL-BR-005 — It overwrites per-user exceptions
- **Rule:** the same field is independently settable per user (`➕ محدودیت اکانت تست`,
  User Management). A global write replaces those values without warning.
- **Evidence:** identical prompts and field name across the two surfaces; the global success message
  says "for all users".
- **Effect:** deliberately configured per-customer allowances are destroyed by a routine global set.
- **Confidence:** STRONGLY_INFERRED (the field identity), VERIFIED_BY_UI (both surfaces exist).

## GTL-BR-006 — Historical test-account records are NOT affected
- **Rule:** the write changes future eligibility only. The all-time statistic
  `🧪 اکانت‌های تست ساخته‌شده` still read **40,665** on the "from the beginning until now" window
  immediately after the write.
- **Evidence:** `📊 آمار ربات → آمار کل`, read at 04:07, four minutes after the mutation.
- **Effect:** eligibility and history are separate concerns in MirzaBot. A rebuild should keep them so.
- **Confidence:** VERIFIED (statistics); STRONGLY_INFERRED (the underlying order/service rows, since
  the statistic is derived from them).

## GTL-BR-007 — Test-account eligibility is one of four independent layers
- **Rule:** whether a trial is offered (`نمایش تست`, per panel) · how many a user may create
  (this field) · what the trial contains (`زمان سرویس تست` hours, `حجم اکانت تست` MB, per panel) ·
  and what happens at expiry (`🔓 کرون تست` + `متن کرون تست`) are four separately configured layers
  on three different screens.
- **Evidence:** each control was observed on its own surface across this and earlier phases.
- **Effect:** setting a global allowance does nothing on its own if no panel has `نمایش تست` enabled.
  A rebuild should surface the whole chain in one place.
- **Confidence:** VERIFIED_BY_UI (the controls exist and are separate); their runtime AND-ing is UNKNOWN.
