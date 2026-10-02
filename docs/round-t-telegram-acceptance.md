# Round T — real-Telegram acceptance checklist (Telegram Button Builder)

Status: **not run.** Written by the clean QA agent at `main` = `67579a83`. Nothing here can be
proven from the repository: every Round T wire test runs against
`tests/support/fake-telegram-bot-api.ts`, and a fake this repository wrote can only prove it
agrees with the code this repository wrote (`CLAUDE.md`, "learned by running a real panel").
The owner runs this on **staging**, never on production. It consolidates R-ACC-1..9 from
`docs/round-t-button-builder-audit.md` §13/§15 and `docs/round-t-final-review.md` §8, plus
the two QA findings that need a real client (QA-2, QA-3 in `docs/round-t-qa-report.md`).

## Before you start

**Which release.** Run this on a build of `main` at `67579a83` or later. The published GitHub
release `v0.4.0` points at `f9be46f1` (the merge of PR #135), which is **before** the T4
fixes in PR #137 (F-1 test, F-2 superseded publish-dialog wording, F-3 runbook and banner
text, F-4 shared eligibility predicate, F-6 system scope fails closed). If staging runs
`v0.4.0`, R-ACC-5's wording checks will not match this document.

**What you need.**

| Item                    | Detail                                                                                                                                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot E (eligible)        | A staging bot whose **Appearance → test** result is `SENT`. Custom-emoji keyboard icons need the bot's owner to hold Telegram Premium or the bot to have been granted custom emoji. Telegram's rule is not fully documented (`OQ-T-API-02`), so the appearance test is what proves eligibility. |
| Bot I (ineligible)      | A second staging bot that is known **not** to be allowed custom emoji (a fresh bot, owner without Premium). Its appearance test must not be `SENT`.                                                                                                                                             |
| One custom emoji id     | A numeric custom emoji id (for example from a sticker set you own), entered on **Appearance** for the `wallet` slot and switched on.                                                                                                                                                            |
| Three clients           | Telegram Desktop, Telegram for Android, Telegram for iOS, all current. Signed in to a customer account, **not** an operator.                                                                                                                                                                    |
| Operator access         | A Web Admin account with `settings.edit` (draft/publish/reset/restore) and `templates.edit` (labels).                                                                                                                                                                                           |
| Database read access    | `psql` against staging for the evidence queries below (read-only queries only, except where R-ACC-2 says otherwise).                                                                                                                                                                            |
| Previous-release digest | For R-ACC-4/5: the digest of the release before Round T (`botctl` addresses releases by digest; `botctl rollback` never restores the database, which is what this test relies on).                                                                                                              |
| A notebook              | Each item lists **Record**. Write it down: date, release digest, client and version, bot username, exact Telegram `description` strings, and a screenshot. The rows marked _fixture_ are what a later release must turn into a regression test.                                                 |

**Evidence queries** (read-only), used throughout:

```sql
-- What the runtime will draw and from which source.
SELECT draft_version, published_revision, projection_setting_version,
       draft_legacy_setting_version FROM main_menu_layouts;
SELECT version, value FROM setting_values WHERE setting_key = 'bot.main_menu';
-- Per-bot icon eligibility (the one truth the builder and the messenger share, OQ-T-4).
SELECT username, custom_emoji_test_outcome, custom_emoji_tested_at FROM bot_instances;
-- Conditions the messenger or the settings resolver raised.
SELECT code, context, first_seen_at, last_seen_at, occurrence_count, resolved_at FROM operational_events
 WHERE code IN ('telegram.appearance_decoration_failed', 'settings.stored_value_invalid',
                'bot_menu.published_unreadable')
 ORDER BY last_seen_at DESC LIMIT 20;
-- The builder's audit trail.
SELECT occurred_at, action, actor_label FROM audit_logs
 WHERE action LIKE 'bot_menu.%' ORDER BY occurred_at DESC LIMIT 20;
```

If a column name differs on your build, `\d <table>` first; do not guess.

**How to roll back any single step.** Every builder action is a draft change or a publish, and
a publish is reversible from the page: **History → Restore into draft** on the revision you
want, then **Publish**. Revisions are append-only, so nothing you do here destroys an earlier
arrangement. To return a tenant to exactly what it had before Round T, restore the revision
whose rows match the legacy keyboard (the draft seeded on first visit is that arrangement), or
**Reset → From the live keyboard** before the first publish. Never edit `main_menu_*` tables
by hand.

---

## R-ACC-1 — styles render and the request is accepted

**Steps.**

1. `/bot-buttons` → arrange one row of three: `catalog` = **Primary (blue)**, `wallet` =
   **Success (green)**, `services` = **Danger (red)**; a second row with `help` = **Default**.
2. **Save draft**. In a client, send `/start` to Bot E. **Expect the OLD keyboard** (a draft
   is never live).
3. **Publish** → the dialog lists the changes and shows "now" and "after" keyboards →
   **Yes, publish**.
4. Send `/start` to Bot E from Desktop, Android and iOS.

**Pass.** Every client shows the new rows; three keys visibly styled in the right colours, the
`help` key unstyled; no client drops the keyboard or shows an error. The staging log shows a
200 from `sendMessage`. Nothing under `operational_events` for this send.

**Record.** Per client: screenshot, client version, whether each colour matched the builder's
legend. Telegram's colour for each style is the client's, not ours; note any client that
renders no colour at all (an older client).

**Fail action.** If Telegram answers 400 for a `style`, capture the exact `description`,
restore the previous revision and publish it (customers are back on the old arrangement in one
message), then file it against `OQ-T-API-01` with the sentence as a fixture.

## R-ACC-2 — icons: eligible bot draws, ineligible bot is classified, never resent blindly

**Steps (eligible).**

1. **Appearance** → `wallet` slot → the custom emoji id → enabled → save. Run the Appearance
   **test** from Bot E; confirm `SENT`.
2. `/bot-buttons` → select `wallet` → **Icon** = the wallet slot. The Inspector lists Bot E as
   **eligible** and Bot I as **no icon**. Save draft, publish.
3. `/start` on Bot E (all three clients).

**Pass (eligible).** The custom emoji is drawn as the key's icon; the key's text is exactly
the label (see R-ACC-3 for the tap). Bot E's `custom_emoji_test_outcome` stays `SENT`.

**Steps (ineligible).** Bot I must be forced to carry the icon once, because the messenger
will not put an icon on an unproven bot's keyboard. On staging only:

```sql
-- Staging only. Note the old values first; put them back afterwards.
UPDATE bot_instances SET custom_emoji_test_outcome = 'SENT', custom_emoji_tested_at = now()
 WHERE username = '<bot I username>';
```

Wait 30 seconds (the decoration reader caches per tenant for 30 s), then `/start` on Bot I.

**Pass (ineligible).** Exactly one of:

- (a) Telegram answers 400 with a description the classifier recognises as a custom-emoji
  denial → one icon-less retry lands (same text, same styles), Bot I's outcome becomes
  `REJECTED`, `telegram.appearance_decoration_failed` has `eligibilityChanged: true`, and
  the **next** `/start` from Bot I is a single request with no icon; or
- (b) Telegram answers 400 with a generic description → one icon-less retry lands, Bot I is
  **not** switched off (`eligibilityChanged: false`), and every iconed message from it keeps
  costing one refused request plus one retry (T4 F-10, `OQ-T-API-05`); or
- (c) Telegram answers 200 and silently draws no icon → nothing in our logs can see this;
  record it.

In no case may the same message be delivered twice, and the text and styles must survive.

**Record (_fixture_).** HTTP status and the **exact** `description` string; which of (a)/(b)/(c)
happened; Bot I's outcome before and after. Widen `isCustomEmojiDenial` only from this
sentence, in its own commit, with the sentence as a test fixture.

**Also check (QA-3).** With the icon on `wallet`, look at the key on each client. The label
template `bot.menu.wallet` already starts with an emoji (`💰 کیف پول`), so the key may show
two glyphs (icon + emoji). The builder warns about this (`bb-icon-doubled`) and its preview
draws both. Record whether the real client shows both; if it does, the operator's remedy is
editing the label on **Texts**, not a code change.

**Roll back.** Put Bot I's two columns back to their recorded values; remove the icon slot
from the button (or restore the previous revision) and publish.

## R-ACC-3 — a tap on a styled or iconed key routes by its label

**Steps.** With the R-ACC-1/2 layout published, tap every placed key on Bot E: catalog,
services, wallet (iconed), help, apps, tickets, and — after opening their gates (R-ACC-7) —
trial and referral. Then type the slash command for each (`/catalog`, `/wallet`, …).

**Pass.** Each tap produces the same reply as its slash command. The bot log shows the
update's `text` equal to the label exactly (no icon character prepended, no colour marker).

**Record.** Any key whose tap produced the "unknown input" answer, with the client.

## R-ACC-4 — rollback to the release before Round T keeps order and visibility

**Steps.**

1. With a layout published (rows that the old two-per-row packing could not draw, e.g. three
   on one row, `tickets` switched off, `referral` in the pool), record the evidence queries.
2. `botctl rollback` to the pre-Round-T digest. (The database is not restored; migration
   0156 is expand-only.)
3. `/start` on Bot E. Open the old **دکمه‌های ربات** page (do not save).

**Pass.** The keyboard shows the **same buttons in the same order with the same ones hidden**,
packed two per row (a wide key alone), no styles, no icons. `operational_events` has **no**
`settings.stored_value_invalid` for `bot.main_menu`. The old page loads the arrangement without
an error.

**Record.** Screenshot, the `bot.main_menu` value and version. (QA reproduced the parse
locally: both stored projections parse under the `25e717a` registry schema, same visible
order — `docs/round-t-qa-report.md` §4.)

## R-ACC-5 — a save on the old release, then roll forward: superseded, refuse, reseed, restore

**Steps.**

1. Still on the old release: on **دکمه‌های ربات** change the order and **save once**.
2. `/start`: the keyboard follows that save.
3. Roll forward to the Round T digest. `/start` again.
4. Open `/bot-buttons`.
5. Try to publish the existing draft.
6. Click **ساختن دوباره از منوی زنده** (reseed from the live keyboard) → the reset dialog
   opens with **From the live keyboard** selected → confirm.
7. **History** → restore the revision you had published before the rollback → **Publish**.

**Pass.**

- After 3: the keyboard still follows the old release's save (the operator's latest act wins).
- After 4: a warning that the live menu was changed by an older release (with the reseed and
  restore procedure in its text), a second warning that the live menu changed since the
  draft, with the reseed button; source line says the legacy arrangement is live.
- After 5: **Publish is disabled** with the note "the live menu changed; reseed first". An
  API publish of the stale draft answers **409 `control.version_conflict`** and writes
  nothing (`setting_values.version` unchanged).
- After 7: the publish dialog shows the "customers currently see what an older release
  wrote" warning and **no** "no layout change" sentence (T4 F-2); after publishing, the source
  line names the new revision, `superseded` is gone, `/start` draws the explicit rows again.

**Record.** Screenshots of 4, 5 and 7; the revision number created; audit rows
`bot_menu.reset` (seed LIVE), `bot_menu.restored`, `bot_menu.published`.

**Roll back.** None needed — step 7 is the recovery.

## R-ACC-6 — extreme shapes: one row of eight, eight rows of one

**Steps.** Publish a layout with all eight buttons on one row (open the trial and referral
gates first); `/start` on all three clients. Then eight rows of one; `/start` again.

**Pass.** Telegram accepts both (`OQ-T-API-03`: the bound of eight per row is the domain's,
not Telegram's). Record how legible the one-row keyboard is on a narrow phone; the builder
warns about cramped rows but does not refuse them.

**Record.** Screenshots; any 400 and its `description`.

## R-ACC-7 — gates: trial and referral hide and reappear without reflow

**Steps.** Place `trial` and `referral` on a row with another key. Close both gates (no panel
offering a trial; referral program off) → `/start`. Open them → send any message, then
`/start`.

**Pass.** Closed: both keys absent, their row shortened, the other rows unchanged (no
reflow). Open: present on the next reply. While closed, typing the trial or referral label
still routes (a keyboard already in the chat keeps working).

**Record.** Both screenshots; the builder's "hidden now" badges matched.

## R-ACC-8 — inline buttons win; an iconed keyboard is not sent with them

**Steps.** With an iconed layout published on Bot E, open a screen that carries inline buttons
(an order or service screen).

**Pass.** That message carries inline markup only; one request; no retry; nothing marked;
no `telegram.appearance_decoration_failed`.

## R-ACC-9 — the Web Admin by hand: widths, themes, RTL, keyboard-only, touch

QA took 46 screenshots locally (`docs/round-t-qa-report.md` §3); this is the human pass on a
real device.

**Steps.**

1. Desktop browser at 1440 and 900 wide, light and dark: builder, publish dialog, history
   drawer, superseded banners. Phone (≈390 wide) the same.
2. **Keyboard only** (no pointer): Tab to a key; **Alt+↑/↓** change row; **Alt+→** moves
   earlier and **Alt+←** later (Persian, right to left); **Delete** sends a key to the pool;
   in the pool **Alt+Enter** places it in a new row; Tab to **Save draft** → Enter; Tab to
   **Publish** → Enter; Tab to **Yes, publish** → Enter. The screen reader's live region
   announces each move.
3. **Touch** on a real Android phone (Chrome) and an iPhone (Safari): drag a **key** by its
   grip (☰ beside the label) into another row and to a new row; drag a **row** by its row
   grip.

**Pass.** No horizontal scrolling; every control reachable; every move possible without a
pointer; touch drags work for keys **and** rows.

**Record (QA-2).** In Chromium's touch emulation QA found that a touch on a **key's** grip is
retargeted to the key's own button, so the key drag never starts (a row drag works). Record
whether this reproduces on a real Android Chrome and on iOS Safari. If it does, the Inspector's
move buttons and the keyboard remain the working path, and the defect stands.

---

## Sign-off

| Item    | Result | Date | Release digest | Recorded by | Notes |
| ------- | ------ | ---- | -------------- | ----------- | ----- |
| R-ACC-1 |        |      |                |             |       |
| R-ACC-2 |        |      |                |             |       |
| R-ACC-3 |        |      |                |             |       |
| R-ACC-4 |        |      |                |             |       |
| R-ACC-5 |        |      |                |             |       |
| R-ACC-6 |        |      |                |             |       |
| R-ACC-7 |        |      |                |             |       |
| R-ACC-8 |        |      |                |             |       |
| R-ACC-9 |        |      |                |             |       |

Round T is accepted when R-ACC-1..5 pass (T4 §9) and R-ACC-6..9 are recorded. Any observed
Telegram sentence goes into `docs/open-questions.md` under its `OQ-T-API-*` entry and into a
test fixture in the same commit.
