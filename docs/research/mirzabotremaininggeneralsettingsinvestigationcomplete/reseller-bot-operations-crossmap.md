# Reseller cross-map — architecture evidence and the relationship between the two bulk actions

## Are the two bulk operations related?

**They are separate, independent actions — VERIFIED at the UI level.**

- Two distinct buttons, two distinct labels, two distinct presses, two distinct responses.
- Each produced its own `❌ رباتی وجود ندارد`, so each independently evaluates the reseller-bot set.
- Neither mentions the other; neither is offered as a step of the other.

**Whether the update also resets webhooks internally is UNKNOWN.** With zero targets, no side effect
could be observed. The fact that MirzaBot ships them as two separate maintenance buttons is itself
weak evidence that they do different things — you would not need a dedicated webhook button if the
update already did it — but that is INFERRED, not proven.

## Reseller-bot architecture — what the evidence actually supports

| Claim | Confidence | Evidence |
|---|---|---|
| Reseller bots are **separate Telegram bots identified by a token** | **STRONGLY_INFERRED** | User Management exposes `🔄 تغییر توکن ربات نماینده` (change the reseller bot's token) and `🤖 فعالسازی ربات فروش` / `❌ حذف ربات فروش`; the Web phase found the bot-text group `users.agentpanel` with keys `changetokenbtn`, `confirmnewtokenbtn` |
| They run on a **shared backend / central codebase** | **STRONGLY_INFERRED** | a single button updates *all* of them at once, and a single button re-registers *all* their webhooks — that is only possible from a central controller that holds every token |
| **Webhook management is centralised** | **STRONGLY_INFERRED** | one admin action re-points every reseller bot's webhook |
| Version synchronisation exists | **INFERRED** | "global update" implies a version the centre pushes; no version string was ever displayed |
| Per-bot routes vs one shared endpoint | **UNKNOWN** | nothing was shown |
| A reseller bot is scoped to its owner's panels | **STRONGLY_INFERRED** | User Management has `❌ مخفی کردن پنل برای ربات نماینده` (hide a panel from the reseller's bot) — so the parent controls which VPN panels the child bot may sell |
| A reseller bot can be **stopped without being deleted** | **VERIFIED** | the monthly-floor screen states demotion stops the sales bot `(حذف نمی شود)` |

## The lifecycle, assembled across phases

```
f  کاربر عادی
   │  pays  💰 مبلغ عضویت نمایندگی   (price of the membership request)
   ▼
n  نماینده عادی
   │  admin may grant a پنل نمایندگی entitlement (token holder)
   │  reseller supplies a bot token → 🤖 فعالسازی ربات فروش
   ▼
   a live RESELLER BOT
   │
   ├── kept in sync by  🔄 آپدیت همگانی ربات های نماینده
   ├── webhooks re-pointed by  🔗 وبهوک مجدد ربات های نماینده
   ├── panel visibility controlled by  ❌ مخفی کردن پنل برای ربات نماینده
   └── STOPPED (not deleted) if the owner falls below 📊 کف خرید ماهانه نمایندگی
```

## The state of this deployment

**Zero reseller bots exist.** Both bulk actions said so, and the Web-Admin phase found the reseller-bot
list empty while two reseller-*panel* records existed.

So the whole reseller-bot subsystem is **provisioned but unused here**: the entitlement records exist,
the maintenance tooling exists, and no reseller has ever stood a bot up. Every architectural claim
above therefore rests on the *control surfaces*, not on observed running bots.
