# Contradictions — Telegram Admin vs Web Admin

Both sets of evidence stand. Neither is overwritten.

## C-ADM-001 — Role count: 4 (Telegram) vs 7 (Web)

| Web Admin (prior phase) | Telegram (this phase) |
|---|---|
| مدیر کل | **مدیر کل** ← only shared name |
| مدیر ربات | — |
| مدیر فنی | — |
| مدیر فروش | — |
| مدیر مالی | — |
| مدیر پشتیبانی | — |
| مدیر ناظر | — |
| — | **فروشنده** |
| — | **پشتیبان** |
| — | **تأییدکنندهٔ رسید** |

**Both are VERIFIED_BY_UI on their own surface.** Possible explanations, none yet tested:
(a) two independent role systems for two independent admin surfaces; (b) different MirzaBot versions
— the bot reports `Version Bot : 7.5.10`, and the web panel's version was not recorded; (c) the
Telegram list is a curated subset. **Do not merge the two lists in a rebuild until this is settled.**

## C-ADM-002 — Nearly-matching roles are not actually the same

`فروشنده` (Telegram: receipts + single-user management + balance top-up + statistics) is not the same
scope as `مدیر فروش` (Web: "sales sections + user management"). Likewise `پشتیبان` (users + search +
support replies) vs `مدیر پشتیبانی` ("support sections + user management"). Similar names, different
described powers. Treating them as aliases would silently change the permission model.

## C-ADM-003 — No read-only role in Telegram

The Web panel offers `مدیر ناظر` — a full read-only observer. Telegram has no equivalent; every
Telegram role can mutate something (at minimum, approve a receipt, which moves money).

## C-ADM-004 — Admin identity: numeric id (Telegram) vs username (Web log)

The Telegram admin record is keyed by **numeric Telegram id**. The Web admin log attributes actions to
an **admin username**. The Web `Admin` entity was recorded as having `id, bot username (scope),
username, role` — no numeric Telegram id. So the two surfaces may not even be describing the same
table. Unresolved; see UNK-ADM-004 and UNK-ADM-006.

## C-ADM-005 — Scope column exists in the Web model, not in Telegram

The Web `Admin` entity carries a "bot username (scope)" field, implying admins are scoped per-bot.
The Telegram list shows no scope at all. Whether the five rows seen here are global or bot-scoped is
**UNKNOWN** and matters for the multi-bot rebuild.

## Not a contradiction — one prior finding is reinforced

**TBR-018 (admin privilege ⟂ customer tier)** held in the Web phase with an `f` customer who was a
full admin. This phase adds an `n` customer who is a `تأییدکنندهٔ رسید` admin, and shows the tier is
untouched by the grant. Consistent, and now much better evidenced.
