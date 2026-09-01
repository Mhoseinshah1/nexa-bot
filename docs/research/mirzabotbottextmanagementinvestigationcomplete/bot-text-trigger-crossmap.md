# Cross-surface map — which text belongs to which capability / setting

This is the payoff of running this phase after the capability and settings phases: several templates
are the **message body** for a switch or threshold documented elsewhere.

| Text item | Paired control (phase) | Control state | Verdict |
|---|---|---|---|
| `متن خاموش بودن ربات` | capability `📡 وضعیت ربات` (Bot Capabilities) | **ON** (bot running) | **VERIFIED pairing** — this is exactly the message a customer gets when the flag is off. The template is live but currently unused |
| `متن هشدار کاهش موجودی کاربر` | capability `⚠️ اعلان کاهش موجودی` **OFF** + threshold `⚠️ مبلغ هشدار موجودی` (General Settings) | flag **OFF** | **VERIFIED three-part set**: flag + threshold + body, all three found in three different sections. The body exists, the threshold exists, the flag is off ⇒ nothing is sent |
| `📝 تنظیم متن توضیحات عضویت اجباری` | `📯 تنظیمات کانال` forced-join (General Settings) | enabled iff ≥1 channel | **VERIFIED pairing.** The text reveals a "check membership" button the settings screen never mentioned |
| `⚖️ متن قانون` | capability `♨️ قوانین` **ON** + per-user field `وضعیت تایید قانون` (User Management) | **ON** | **VERIFIED** across three surfaces |
| `متن کرون تست` | capability `🔓 کرون تست` **ON** (Bot Capabilities) | **ON** | **VERIFIED pairing** — cron settings carry timing, this carries the body |
| `متن هشدار کف خرید ماهانه نمایندگی` | `📊 کف خرید ماهانه نمایندگی` (General Settings) | not inspected | **INFERRED** — same subject, `{days}` matches "days to month end" |
| `متن کارت به کارت` / `تنظیم متن کارت به کارت خودکار` | gateway `🔌 کارت به کارت` (Financial, **disabled**) | gateway **OFF** | **VERIFIED pairing**; two templates for manual vs auto-verified variants |
| `متن بعد از ارسال رسید` | `💵 رسید های تایید نشده` queue (Pending Receipts) | queue empty | **VERIFIED pairing** |
| `متن بعد خرید` → "press the button below" | `🔗 لینک دانلود برنامه`, 9 apps (Bot Capabilities) | **ON** | **VERIFIED** — the delivery message points at the app list |
| `متن انتخاب لوکیشن` | `🌍 محدودیت تغییر لوکیشن` **OFF** (Bot Capabilities) | flag OFF | **INFERRED** — this is the purchase-time location picker, which is a different flow from the paid *change*-location feature. Do not merge |
| `متن دکمه گردونه شانس` | capability `🎲 گردونه شانس` **ON** | **ON** | **VERIFIED pairing** (caption only) |
| `متن دکمه زیرمجموعه گیری` | capability `🎁 زیرمجموعه` **ON** | **ON** | **VERIFIED pairing** (caption only) |
| `متن بعد خرید ibsng` / `... WGDashboard` | panel types (Panel Management) | — | **VERIFIED** that delivery copy is per-panel-type |

## The rule this establishes

**Cron and capability screens carry the *timing and the on/off*; this section carries the *body*.**
Neither is complete without the other, and they are three menus apart. A rebuild should keep the
template beside its trigger.

## Templates that exist for features that are switched OFF

`متن خاموش بودن ربات` (bot is on) · `متن هشدار کاهش موجودی کاربر` (alert flag off) ·
both card-to-card templates (gateway disabled).

**A template's existence proves nothing about whether the feature is enabled.** All three are
maintained, well-written copy for paths nobody is currently walking. This matters for the rebuild:
do not infer an active feature set from the template catalogue.

## Notable gaps — capabilities with no template here

Eight crons exist; only **one** (`کرون تست`) has a template in this section. There is **no** editable
body for: expiry warning (`🕚 کرون زمان`, 3 days), first-connection/on-hold chase
(`🕚 کرون اولین اتصال`, 4 days), volume warning (`🔋 کرون حجم`), the two deletion crons, or
inactivity outreach (`🧯 متصل نبودن کاربر`, 3 days). Those messages reach customers today with text
that **cannot be edited from Telegram**. See UNK-TXT-004 — the Web panel's `cron(11)` group is the
likely home.
