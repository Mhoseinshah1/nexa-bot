# Bot Capabilities Phase — Investigation Incidents

These are mistakes made by the **investigation**, not defects in MirzaBot.
(Defects in MirzaBot itself go to `source-bugs.md`.)

## Summary of production impact
**None.** No capability was toggled. No value was submitted. No configuration
was changed. Every state read at the start of the phase still matches.

---

## INCIDENT-BC-001 — coordinate/ref drift caused three unintended menu openings
- **When:** 2026-08-31, ~00:55–01:10
- **What happened:** the capability list is a single inline-keyboard message that
  the bot **edits in place** for pagination, and every new bot reply re-flows the
  chat, so DOM coordinates read in one tool call were stale by the next call.
  Three settings screens were opened that were not the intended target:
  1. `🕚 کرون زمان → ⚙️ تنظیمات` opened a second time (harmless duplicate).
  2. A click intended for `🕚 کرون اولین اتصال` opened the **volume-warning**
     prompt instead (recorded as NS-06, attribution flagged for re-confirmation).
  3. The bot answered one of these with `⭕️ ورودی نا معتبر` ("invalid input"),
     i.e. it rejected whatever it received.
- **Impact on production:** none. Opening a settings prompt only puts the bot's
  FSM into "awaiting a value" state; no value was ever sent, and the one input
  the bot did evaluate was rejected as invalid.
- **Root cause:** clicking by screen coordinates / cached element refs against a
  message that is edited in place.
- **Contributing cause found later:** the browser viewport is 1115×701 CSS px but
  the automation coordinate frame is 1254×789 — a factor of ~1.1247. Coordinates
  taken from `getBoundingClientRect()` must be multiplied by that factor before
  being used as click coordinates. Two clicks landed between rows because of this.
- **Second contributing cause, found at the end:** the automation's reported
  coordinate frame **changed between calls** (1254×789 vs 1115×701 for the same
  1115-px viewport). Any click coordinate computed from a *previous* call's frame
  could therefore land a row or two away. The reliable rule that finally worked:
  take a screenshot, read the target's position **in that image**, and divide by
  the screenshot's own scale factor. Never carry a coordinate across calls.
- **Third contributing cause:** the bot answers inline-button presses with
  `⭕️ ورودی نا معتبر` while a value prompt is pending (BC-SB-004), which makes a
  correct press look like a failed one and invited retries.
- **Fix adopted:**
  1. Owner instruction (2026-08-31): «وقتی یه دکمه رو میزنی باید بازگشت رو بزنی و
     بعدش دکمه بعدیو بزنی تا قاطی نشه» — after every button, press
     `▶️ بازگشت به منوی قبل` and re-enter from a fresh menu before pressing the
     next button. Adopted as the standing navigation rule for this phase.
  2. Never reuse coordinates across tool calls; re-read the rect immediately
     before each click and scale it by 1254/innerWidth.
  3. Allow 6–8 s after an inline click before reading the DOM; the in-place edit
     arrives several seconds later and an early read reports the OLD page number.
  4. Owner instruction (2026-08-31): «اینایی که زدی و نامعتبر شدنو اول بازگشت بزن و
     بعد دوباره چکشون کن» — every screen that answered `⭕️ ورودی نا معتبر` was
     re-opened after a clean `▶️ بازگشت به منوی قبل` and re-read. **All five
     affected screens (`🕚 کرون اولین اتصال`, `🔋 کرون حجم`, `❌ کرون حذف`,
     `❌ کرون حذف حجم`, `🧯 متصل نبودن کاربر`) were successfully re-verified this
     way**, so no entry in `nested-settings.md` rests on an ambiguous press.

## Resolution
All twelve nested screens were ultimately inspected cleanly, and the final
state-integrity re-read returned **31/31 MATCH**. INCIDENT-BC-001 cost time; it
cost nothing in production state.

## NOT AN INCIDENT — buttons deliberately not pressed
Recorded here so the gaps are auditable rather than looking like omissions:
- `❌ حذف برنامه` (delete a download app) — destructive.
- `🔄 ریست محدودیت کل کاربران` (reset location-change limits for ALL users) — mass reset.
- `🎁 پورسانت بعد از خرید`, `🎁 هدیه استارت`, `🎉 پورسانت فقط برای خرید اول`,
  `🚨 هشدار زیرمجموعه‌گیری مشکوک` — labels give no evidence that they open a
  prompt rather than flip a flag; per the phase rule "if in doubt, assume it
  toggles", they were left alone.
