# Cross-map — where this control sits among the test-account layers

The phase brief warned against conflating three things. The evidence supports **four** distinct
layers, and this section is exactly one of them.

```
LAYER 1  ── Is a free trial offered at all? ────────────────────────────────
   • Customer menu caption `اشتراک رایگان {تست}`  (editable — Bot Text phase)
   • Per-panel toggle `نمایش تست` (Show test)      (Panel Management, OFF by default)
                          ↓
LAYER 2  ── WHO may create one, and HOW MANY times ─────────────────────────
   • Per-user field  `محدودیت اکانت تست`  = integer   (User Management)
   • Per-user setter `➕ محدودیت اکانت تست`           (User Management)
   • GLOBAL setter   `➕ محدودیت ساخت اکانت تست برای همه`  ← THIS SECTION
                          ↓
LAYER 3  ── WHAT the trial contains (per panel) ────────────────────────────
   • `⏱ زمان سرویس تست`  — duration, in HOURS
   • `💾 حجم اکانت تست`   — volume, in MEGABYTES
                          ↓
LAYER 4  ── What happens afterwards ────────────────────────────────────────
   • Capability `🔓 کرون تست` (ON) + text `متن کرون تست` — expiry message, upsell
   • Panel event hook `اولین اتصال اکانت تست` (first connection, per panel)
```

## Relations, with confidence

| Relation | Confidence | Evidence |
|---|---|---|
| This global setter writes the **same field** as the per-user `➕ محدودیت اکانت تست` | **STRONGLY_INFERRED** | identical prompt wording (`تعداد ساخت اکانت تست`), identical no-confirmation contract, and the per-user field is an integer of exactly this name |
| Scope is **all users**, not a tier or a panel | **VERIFIED** | success message `محدودیت ساخت اکانت برای تمام کاربران تنظیم شد` |
| This is **independent of** the per-panel test duration/volume | **VERIFIED** | those are separate per-panel prompts in Panel Management with their own units (hours / megabytes); this one asks for a count and is bot-wide |
| This is **independent of** the per-panel `نمایش تست` toggle | **VERIFIED (as separate controls)** | different surface, different scope. Whether a limit of 1 has any effect while `نمایش تست` is OFF on every panel is **UNKNOWN** — a quota is meaningless if no panel offers the trial |
| This is **independent of** the `🔓 کرون تست` capability | **VERIFIED** | that capability governs the expiry cron and its message, not eligibility |
| It does **not** clear historical statistics | **VERIFIED** | `اکانت‌های تست ساخته‌شده: 40665` still reads all-time after the write |
| It does **not** touch the user's tier, balance or status | **VERIFIED** | user `[TELEGRAM_USER_ID_REDACTED]` re-read: all fields unchanged |
| Tier (`f`/`n`/`n2`) plays any part | **NO EVIDENCE** | the flow never mentions tiers, and the success message says "all users" without qualification |

## Relation to User Management — the important one

This section is best understood as **a bulk write of a User-Management field**. That has a
consequence worth stating plainly for the rebuild:

> A General Settings screen with no confirmation silently overwrites a per-user field on every user
> row, including any per-user exception an admin had deliberately configured.

If an operator had granted a particular customer 5 test accounts via the per-user control, this
global write sets them back to whatever number is typed here — with no warning that per-user values
are about to be discarded, and no way to see what is being overwritten.

## Relation to Robot Statistics

`🧪 اکانت‌های تست ساخته‌شده` is a **cumulative, all-time count of test accounts created**
(40,665 for this deployment, against 197,386 total users). It is a *reporting* figure derived from
history and is **not** the same number as the per-user allowance this section writes. The reset does
not touch it. Do not model them as one value.
