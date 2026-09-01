# MASTER — Global test-account creation limit — AUTHORITATIVE

## PHASE_STATUS
**COMPLETE.** The section is small, fully mapped, and the single authorised mutation was performed
once and verified as far as the product allows.

## Scope
`👨‍💼 پنل مدیریت` → `⚙️ تنظیمات عمومی` → `➕ محدودیت ساخت اکانت تست برای همه`.

## MUTATION PERFORMED
**One, authorised:** the global test-account limit was **set to `1`** at 1 Sep 2026, 04:04.
Bot response: `محدودیت ساخت اکانت برای تمام کاربران تنظیم شد`.
Nothing else was changed. Performed once.

## HEADLINE FINDINGS

1. **It is a SETTER, not a reset.** The prompt asks for a `تعداد` (count) and the bot answers
   `تنظیم شد` ("was set"). Nothing in the flow clears or zeroes anything. Sending `1` assigns an
   allowance of 1; it restores a consumed entitlement **only if** the stored field is a remaining
   balance rather than a fixed cap — which is the phase's key open question (UNK-GTL-002).

2. **It is the global twin of a User Management field.** The per-user control
   `➕ محدودیت اکانت تست` uses an almost identical prompt for the same integer field. This screen
   writes that field on **every** user row — silently overwriting any per-customer exception an
   admin had deliberately set.

3. **Scope is explicitly the whole user base** — `برای تمام کاربران`, confirmed by the bot. No tier,
   panel, date or activity filter is offered. That is ~197,000 user rows on this deployment.

4. **No confirmation, no current value, no feedback.** Pressing the button arms an immediate write;
   the next ordinary message commits it. The screen shows nothing before or after, so the setting is
   unauditable from its own surface and a mistyped `10` would be invisible.

5. **History is NOT cleared — VERIFIED.** The all-time statistic
   `🧪 اکانت‌های تست ساخته‌شده` still read **40,665** four minutes after the write. Eligibility and
   historical records are separate concerns.

6. **Test accounts are governed by four independent layers** on three different screens: whether a
   trial is offered (per-panel `نمایش تست`), how many a user may take (this field), what the trial
   contains (per-panel hours + megabytes), and what happens at expiry (`🔓 کرون تست` + its text).
   Setting an allowance does nothing if no panel offers the trial.

## VERIFICATION CLASSIFICATION
```
RESET_COMMAND_ACCEPTED      = VERIFIED   (explicit success message)
RESET_EFFECT_UI_VERIFIED    = NO         (the section exposes no state; the one readable user
                                          record held the same value before and after)
RESET_RUNTIME_EFFECT_VERIFIED = NOT_TESTED (would require creating a test account)
```

## UNKNOWN
8 items in `unknowns.md`. P1: whether the number is a cap or a remaining balance (UNK-GTL-002), and
what `0` means (UNK-GTL-006 — **do not probe on production**).

## NOT_EXPOSED
The current limit · the previous limit · any confirmation · any warning · unit or range guidance ·
`0` semantics · per-tier or per-panel scoping · any audit of what the write overwrote.

## INCIDENTS
**NONE.**

## AUTHORITATIVE_FILES
`menu-tree.md` · `baseline.md` · `reset-flow.md` · `behavior.md` · `crossmap.md` ·
`business-rules.md` (GTL-BR-001..007) · `unknowns.md` · `incidents.md` · `evidence-index.md` ·
`progress.md`
