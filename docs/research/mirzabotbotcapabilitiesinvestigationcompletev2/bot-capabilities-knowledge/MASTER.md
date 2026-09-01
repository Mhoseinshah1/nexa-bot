# MASTER — Bot Capabilities (`⚙️ وضعیت قابلیت ها`) — AUTHORITATIVE (v2)

## PHASE_STATUS
**COMPLETE for everything the UI can answer.** All 31 capabilities identified, baselined and
re-verified (**31/31 MATCH**). **All 12 nested settings screens inspected**, plus all four value
leaves of the referral subsystem and the app-download CRUD list. What remains open cannot be closed
by clicking — it needs a clone bot or the source (see `../bot-capabilities-unknowns.md`).

## Scope
`👨‍💼 پنل مدیریت` → `⚙️ تنظیمات عمومی` → `⚙️ وضعیت قابلیت ها`. Read-only phase.

## CHANGES_MADE
**NONE.** No capability was toggled. No value was submitted. No configuration was changed.
State integrity check: **31/31 MATCH** against the 00:32 baseline.

## CORRECTIONS APPLIED IN v2
1. **The nested-settings count was wrong.** v1 said *ten*; it is **twelve** (2 + 4 + 6 by page).
   Corrected in `capabilities-matrix.md`, `menu-tree.md`, `business-rules.md` (CBR-003),
   `capability-details.md`, `progress.md` and here.
2. **CBR range.** This file previously said `CBR-001..007`; the register actually holds
   **CBR-001..016**.
3. **`📡 وضعیت ربات` is no longer UNKNOWN.** Its meaning is **VERIFIED_BY_OWNER** — it turns the
   whole bot on and off. Removed from the UNKNOWN list here and marked accordingly everywhere.
4. **The location-change claim was overstated.** v1 said this screen "closes UNK-R004" and that the
   flag being OFF "explains" the missing customer UI, treating the statistics as historical. That
   went beyond the evidence. Restated: *two allowances exist* is **VERIFIED_BY_UI**; *beyond the
   free allowance is charged* is **STRONGLY_INFERRED**; the historical-ON claim and the
   sole-cause claim are **withdrawn**. Carried forward as UNK-BC-004.
5. **`bot-capabilities-unknowns.md` was a duplicate of the capability matrix**, not an unknown
   register. Replaced with a real register of 16 open questions with evidence-available /
   evidence-missing / safe-verification / priority columns.
6. **Cron configurability.** CBR-006 said seven crons are configurable; it is **six**
   (`🔓 کرون تست` and `🎛 آپتایم نود` have no settings button).

## COMPLETED
Menu tree · 31-capability matrix with byte-exact Persian labels and baseline states · grouping and
pagination model · state-indicator mechanism · correct identification of the **12** nested settings ·
**all 12 nested screens inspected in full**, including the `🎁 زیرمجموعه` subsystem (8 options, 4 of
them opened) and the `🔗 لینک دانلود برنامه` CRUD list (9 apps) · CBR-001..016 · a real unknown
register · a source-defect register (BC-SB-001..006) · final 31/31 state integrity check.

## DELIBERATELY NOT DONE
Six buttons were left unpressed because pressing them might flip production state or destroy data:
`❌ حذف برنامه` · `🔄 ریست محدودیت کل کاربران` · `🎁 پورسانت بعد از خرید` · `🎁 هدیه استارت` ·
`🎉 پورسانت فقط برای خرید اول` · `🚨 هشدار زیرمجموعه‌گیری مشکوک` — plus every `✅ روشن` / `❌ خاموش`
state cell. These are gaps by design, tracked as UNK-BC-006 and UNK-BC-017, not omissions.

## UNKNOWN
See `../bot-capabilities-unknowns.md` — 16 registered unknowns, four of them P1 and none of them
closable by further clicking on the production bot.

## NOT_EXPOSED
Capability descriptions or help text · refresh, filter or search on the capability screen · dependency
indicators · any record of who changed a flag or when · any current-value echo on most settings screens.

## IMPORTANT_FINDINGS
1. **31 capabilities in 3 groups; 20 ON, 11 OFF.**
2. **The state cell is itself the button** — one tap appears to change a global feature, with no
   confirmation and no Save.
3. **Twelve capabilities carry nested config**, so a capability is a **flag plus a config record**,
   not a boolean.
4. **Eight of the 31 are scheduled jobs (crons)**, listed alongside cosmetic toggles; six of the eight
   are separately configurable.
5. **`📡 وضعیت ربات` — the whole-bot kill switch — is rendered identically to `🎰 نمایش تاس`.**
   Turning the business off is one tap, visually indistinguishable from a dice toggle.
6. **`🛡 شیشه ای بودن دکمه ربات` is a global UI-paradigm switch**: ON converts every button in the
   bot to inline/glassy and removes the bottom reply keyboard entirely. Reply-vs-inline is therefore
   configuration, not design.
7. **Three disjoint capability layers exist** (bot / store / panel) — no name appears in two of them.
8. **The referral system is a nested subsystem of its own**: one master flag with eight sub-settings
   (percentage, per-referral start gift, minimum purchase for commission, banner, plus four probable
   toggles including a suspicious-referral alarm).
9. **Most settings screens do not echo their current value** — the admin cannot read the current
   configuration without changing it. Six of twelve do; the referral percentage, start-gift amount,
   volume threshold, lottery prizes and luck-wheel prize do not.
10. **Settings come in four shapes, not one** (scalar / menu-of-scalars / subsystem / CRUD), so a
   capability cannot be modelled as a boolean. One input is a **photo**, not text.
11. **Two deletion crons, two clocks**: time-expiry counts from expiry (3 days); traffic-exhaustion
   counts from the customer's **last connection** (2 days) and is declared **Marzban-specific**.
12. **Two outreach jobs, opposite states**: chasing customers who never activated
   (`on_hold`, 4 days) is **OFF**; chasing customers who went quiet (3 days) is **ON**.
13. **The referral system is live and its minimum-purchase floor is `0`, i.e. disabled** — while it
   pays both a percentage of each referred purchase and a flat gift per new referral. Whether the
   suspicious-referral alarm is on is unknown. Worth the owner's attention on its own merits.

## AUTHORITATIVE_FILES
`menu-tree.md` · `capabilities-matrix.md` · `capability-details.md` · `nested-settings.md` ·
`dependencies.md` · `business-rules.md` (**CBR-001..016**) · `incidents.md` · `source-bugs.md` ·
`progress.md` ·
plus the root deliverables including `bot-capabilities-unknowns.md` (v2) and
`bot-capabilities-state-integrity-check.md`.
