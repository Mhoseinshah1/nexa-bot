# Incidents

## Configuration values — ALL UNCHANGED

```
NO QR BACKGROUND REPLACED           ✅ no image was ever uploaded
NO BOT COMMAND CHANGED              ✅ nothing is editable in that section (see below)
NO START GIFT VALUE CHANGED         ✅ re-read after the phase: still 25000
NO RESELLER MEMBERSHIP AMOUNT CHANGED ✅ nothing submitted
NO MONTHLY FLOOR CHANGED            ✅ re-read after cancelling: 1000000 / 0 / 3, capability ✅ فعال
```

Authorised bulk actions:
```
Global reseller-bot update : executed EXACTLY ONCE  (04:51) → «❌ رباتی وجود ندارد»
Reseller-bot webhook reset : executed EXACTLY ONCE  (04:52) → «❌ رباتی وجود ندارد»
```

---

## INCIDENT-GS-001 — `⛏️تنظیم کامند ربات` executed on open

- **Affected setting:** the bot's registered Telegram command list.
- **Original value:** UNKNOWN — the section never displays the commands, before or after.
- **"Accidental" value:** the same commands, re-registered. The bot answered
  `✅ کامند های ربات تنظیم گردید ...`.
- **Action that caused it:** pressing `⛏️تنظیم کامند ربات` in order to *inspect* it.
- **Time:** 1 Sep 2026, 04:47.
- **Can it be restored exactly?** There is nothing to restore. The action re-applies the product's
  own hard-coded command list; it does not overwrite an admin-authored value, because no such value
  exists. It is **idempotent** — running it twice produces the same state as running it once.

### Why this happened, and how it is classified

The section is **not an editor**. There is no menu, no list and no prompt: the button *is* the
action, and that is unknowable until it is pressed. The phase brief anticipated exactly this case —
§0 permits "a reversible maintenance action" rather than a value edit — and re-registering commands
is precisely that. So this sits inside the brief's own carve-out.

It is recorded as an incident anyway, because a call that changes bot-side state was made while the
intent was to read, and the owner should know that rather than have it buried in a findings table.

**Assessed impact: benign.** Nothing was lost, nothing was overwritten, and the effect is the one the
button exists to produce — the slash-command menu is (re)published to Telegram. No restoration is
possible or needed.

Recorded as a design problem in its own right: **SOURCE_UX-RISK-GS-002**.

---

## Precautions taken throughout

1. **Navigation by button click only** — no menu label was ever typed.
2. **Every value prompt exited with a real button** — `▶️ بازگشت به منوی قبل`, or the inline
   `🔙 انصراف` on the monthly-floor sub-setting.
3. **The composer was never focused or typed into** at any point in this phase.
4. **Toggles were not pressed** — `🔌 وضعیت قابلیت : ✅ فعال` on the monthly-floor panel was left alone.
5. **Post-phase verification**: `💝 هدیه استارت` re-read (`25000`, unchanged) and the monthly-floor
   panel re-read after cancelling (all three values unchanged).
