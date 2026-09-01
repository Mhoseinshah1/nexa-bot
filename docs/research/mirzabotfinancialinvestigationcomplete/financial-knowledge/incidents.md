# Incidents — Financial phase

## INCIDENT-FIN-001 — A production gateway setting was written during a read-only phase

**Severity: this breached the phase's own read-only rule. Reported in full rather than quietly.**

**What happened.** After documenting the `🔌 کارت به کارت` settings menu, the intent was to leave it
using its own back button. The string `▶️ بازگشت به منوی قبل` was typed into the composer and sent.
What actually reached the bot, per the chat transcript, was **`📚 تنظیم آموزش کارت به کارت`** — the
"set card-to-card tutorial" button — not the back button.

The bot then replied:

```
📌آموزش خود را ارسال نمایید .
۱ - در صورتی که میخواید اموزشی نشان داده نشود عدد 2 را ارسال کنید
۲ - شما می توانید آموزش بصورت فیلم ُ  متن ُ تصویر ارسال نمایید
```

and immediately afterwards:

```
✅ آموزش با موفقیت ذخیره گردید.
```

**So the card-to-card tutorial content was overwritten.** No outgoing message is visible between the
prompt and the save, so what was stored is not determinable from the transcript — most likely an empty
or stray value.

**Blast radius.** Limited but real:
- It is a **production gateway setting**, not a test record.
- The affected gateway `🔌 کارت به کارت` is currently **disabled** (`❌`), so no customer is being shown
  this tutorial at present.
- Nothing financial moved: no amount, no card number, no cashback, no toggle, no approval.

**Why it happened.** The `type` action's text did not arrive as sent — an emoji-prefixed Persian string
was transformed into a different menu label. The same class of corruption produced SOURCE_BUG-001 in the
Store phase, where `/all` arrived as `/al`. The lesson from that phase — *screenshot the composer to
confirm the exact string before pressing Enter* — was applied there but **not** here, and this is the
consequence.

**Corrective action for the rest of this phase.** Navigation in Financial is by **clicking buttons from
a fresh screenshot only**. No menu label is typed as free text again, because in a section where every
screen is an edit screen, a mistyped label lands directly on a setting.

**Restoration.** Not attempted. Rewriting the tutorial would be a second write, and the original content
was never captured — it was not read before the accident. The owner should decide: the tutorial can be
re-entered via `💎 مالی → 🔌 کارت به کارت ⚙️ → 📚 تنظیم آموزش کارت به کارت`, and sending `2` there
disables the tutorial display entirely, per the prompt's own instructions.


## INCIDENT-FIN-002 — Fifth browser-tool outage

The `claude-in-chrome` server dropped while moving from the ZarinPal schema to the FX gateways. Nothing
was in flight and no action had been started. Same environmental failure class as the four earlier
outages across this project. No data impact.

## Note on INCIDENT-FIN-001

The owner repaired the card-to-card tutorial manually. The incident record is kept for the timeline and
for its methodological lesson, which now governs this whole section: navigate by clicking, never by
typing a menu label.
