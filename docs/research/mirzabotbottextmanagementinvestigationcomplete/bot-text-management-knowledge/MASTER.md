# MASTER — Bot Text Management (`📝 تنظیم متن ربات`) — AUTHORITATIVE

## PHASE_STATUS
**COMPLETE.** All 36 exposed items inventoried byte-exact and **all 36 edit flows opened and
captured** (100% coverage); final safety verification passed.

## Scope
`👨‍💼 پنل مدیریت` → `⚙️ تنظیمات عمومی` → `📝 تنظیم متن ربات`. **Read-only.**

## SAFETY RESULT
**NO TEXT WAS MODIFIED. NO RESET EXECUTED. NO DEFAULT RESTORED. NO PRODUCTION COPY CHANGED.**
Not one character was ever sent to the bot. See `incidents.md`.

## HEADLINE FINDINGS

1. **36 texts, one flat list, no groups.** No pagination, no search, no keys, no counters, no
   "customised" badges — and, notably, **no reset or restore-default control anywhere**.

2. **One edit component for all 36.** Pressing an item immediately prints
   `متن جدید خود راارسال کنید.` plus the **complete current value**, optionally followed by a
   placeholder-help message, and waits. There is no Save button — the next message is the save.

3. **The current value is always shown — but RENDERED, not raw.** Owner-confirmed: the `?` in the
   start text's echo is the auditing account's own Telegram display name, i.e. `{first_name}` is
   resolved live. Service-scoped tokens still echo raw. So the screen silently mixes rendered and raw
   text, and **copy-editing what is displayed would replace `{first_name}` with a literal name for all
   ~13,700 customers** (TBR-TXT-013, SOURCE_UX-RISK-TEXT-012).

4. **About a third of the "texts" are customer keyboard captions, not messages.** `🛍 سرویس های من`,
   `☎️ پشتیبانی`, `👨‍💻 درخواست نمایندگی` are all editable here — so the customer menu is renameable
   configuration, and captions share one namespace with message bodies.

5. **Placeholders are `{token}`, plain substitution, and template-scoped.** `{time}` means "current
   time" in the start text and "service duration" in the renewal invoice. The vocabulary is not
   normalised (`{Volume}`/`{volume}`, `{balance}`/`{userBalance}`).

6. **Units are hard-coded in the copy, not in the variables** — and the two card-to-card templates
   disagree: one says **تومان**, the other **ریال**, for the same `{price}`.

7. **Trigger, timing and body live in three different menus.** The low-balance message is a complete
   example: capability flag (OFF) in Bot Capabilities, threshold in General Settings, body here.

8. **Seven of the eight crons have no editable body in Telegram** — expiry warning, on-hold chase,
   volume warning, both deletion crons and inactivity outreach all message customers with text that
   cannot be changed from the phone.

9. **Telegram exposes 36 texts; the Web panel exposes over 1000 in 40 groups.** Almost certainly a
   curated subset, but no shared key was observed, so the mapping is INFERRED.

10. **47 message families that MirzaBot sends have no editable template here** — 7 of the 8 cron
   bodies, every error string, discount/wallet/refund/gateway copy, extra volume and time, paid
   location change, tickets, verification, block, all admin and report-group copy, and the entire
   mini-app catalogue. The rebuild must author or harvest them: **`non-editable-texts.md`**.

11. **`{password}` exists only in the IBSng delivery template** (23 tokens total), and
   `دکمه اکانت تست` contains a literal `{تست}` that is **not** a placeholder — a naive substitution
   engine would blank it.

## UNKNOWN
See `unknowns.md` — 12 items, one now **RESOLVED** (UNK-TXT-001, the `?`). Remaining P1: HTML support
(UNK-TXT-002), where the other cron bodies live (UNK-TXT-004), the Telegram↔Web key mapping
(UNK-TXT-005), and save-on-send semantics (UNK-TXT-007, intentionally untested).

## NOT_EXPOSED
Groups · pagination · search · filter · internal keys · character limit · "customised" badge ·
preview · diff · confirmation · **reset / restore-default** · media of any kind · admin-facing or
report-group templates.

## INCIDENTS
**NONE.**

## AUTHORITATIVE_FILES
`menu-tree.md` · `text-items.md` · `edit-flow.md` · `placeholders.md` · `formatting.md` ·
`media-support.md` · `customer-texts.md` · `cross-surface-map.md` · `text-template-model.md` ·
`business-rules.md` (TBR-TXT-001..014) · `non-editable-texts.md` · `contradictions.md` · `unknowns.md` · `incidents.md` ·
`evidence-index.md` · `progress.md`
