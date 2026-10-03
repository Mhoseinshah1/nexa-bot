# Round T — real-Telegram acceptance checklist (Telegram Button Builder)

Status: **not run.** Written by the clean QA agent at `main` = `67579a83`, corrected after the
Codex review of PR #138 (every correction is cited against the code below). Nothing here can
be proven from the repository: every Round T wire test runs against
`tests/support/fake-telegram-bot-api.ts`, and a fake this repository wrote can only prove it
agrees with the code this repository wrote (`CLAUDE.md`, "learned by running a real panel").
The owner runs this on **staging**, never on production. It consolidates R-ACC-1..9 from
`docs/round-t-button-builder-audit.md` §13/§15 and `docs/round-t-final-review.md` §8, plus
the two QA findings that need a real client (QA-2, QA-3 in `docs/round-t-qa-report.md`).

**Amended 2026-10-02 (owner order).** The builder's button icon («آیکون دکمه») and its
screen slot («آیکون معنایی») are retired (`docs/round-t-button-builder-audit.md` §16). On a
build that contains that change, **R-ACC-2 is replaced by R-ACC-2′** below, R-ACC-3 taps styled
keys only, QA-3 is obsolete, and R-ACC-9 checks the rebuilt drag. R-ACC-2 as written stays
for a staging still on `v0.4.x`.

What counts as evidence here is only what an operator can actually observe: the Telegram
client (screenshots), the Web Admin, the database queries below, and the operator's own
direct Bot API call in R-ACC-2. The application deliberately does **not** log a customer's
message text (`apps/api/src/surfaces/telegram/webhook.controller.ts:375-381`) or Telegram's
refusal description (`telegram-customer-messenger.ts:152-155`, `:1195-1210` store only an
error code); do not add logging of either to make this checklist easier.

## Before you start

**Which release.** Run this on a build of `main` at `67579a83` or later. The published GitHub
release `v0.4.0` points at `f9be46f1` (the merge of PR #135), which is **before** the T4
fixes in PR #137 (F-1 test, F-2 superseded publish-dialog wording, F-3 runbook and banner
text, F-4 shared eligibility predicate, F-6 system scope fails closed). If staging runs
`v0.4.0`, R-ACC-5's wording checks will not match this document.

**What you need.**

| Item                 | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot E (eligible)     | A staging bot whose **Appearance → test** result is `SENT`. The test sends to the signed-in administrator's bound Telegram account, so that account must have sent `/start` to Bot E first. Custom-emoji icons need what Telegram requires of the bot (`OQ-T-API-02`, not fully documented); the appearance test is what proves eligibility here.                                                                                                                                                                                                                                                                                                     |
| Bot I (ineligible)   | A second staging bot known **not** to be allowed custom emoji (a fresh bot whose owner has no Premium). Its appearance test must not be `SENT`. You need its token for R-ACC-2 part A — kept in a file, never typed on a command line (see there).                                                                                                                                                                                                                                                                                                                                                                                                    |
| One custom emoji id  | A numeric custom emoji id (for example from a sticker set you own), entered on **Appearance** for the `wallet` slot and switched on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Three clients        | Telegram Desktop, Telegram for Android, Telegram for iOS, all current, signed in to a **customer** account (not the operator's), plus the operator's own account for R-ACC-2 part A.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Operator permissions | One Web Admin account holding, verified in the code: `settings.view` + `settings.edit` — read and write the builder (`bot-menu-builder.service.ts:70-71`), the Appearance slots and test (`packages/contracts/src/appearance.ts:324-325`) and the `referrals` feature flag that gates the referral key (`features/application/feature-flags.service.ts:45-46`); `templates.view` + `templates.edit` — see and edit the `bot.menu.*` labels from the page (`apps/web/src/app.tsx:948-949`); `panels.view` + `panels.edit` — read and change a panel's free trial, which gates the trial key (`apps/api/src/surfaces/web/trials.controller.ts:88-107`). |
| Database access      | `psql` against staging. Every query below is **read-only** except the two marked _staging write_ in R-ACC-2 part B.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Release names        | For R-ACC-4/5: the **version name** of the release before Round T (for example `v0.3.6`) and of the Round T build (see "Rollback mechanics").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A notebook           | Each item lists **Record**. Write down: date, `botctl version` output, client and version, bot username, exact Telegram responses from your own probe, and screenshots. Rows marked _fixture_ are what a later release must turn into a regression test. Never paste a bot token or a session cookie into the notebook.                                                                                                                                                                                                                                                                                                                               |

**Rollback mechanics (`deploy/bin/botctl`).** `botctl update VERSION` moves to a named release
(`botctl:966-967`); `botctl rollback` takes **no argument** and returns to the recorded
**previous** release (`botctl:1376-1392`), and refuses when none is recorded or when previous
equals current. A version is letters, digits, dot, dash and underscore only, up to 64
characters (`deploy/bin/nexa-lib.sh:108-111`) — a digest (which contains `:`) is refused.
Neither command restores the database. Before R-ACC-4, run `botctl version` and confirm the
`version` line is the Round T build and the `previous … (rollback target)` line is the
pre-Round-T release you intend; if `previous` is anything else, reach it with
`botctl update <pre-Round-T version>` instead of `rollback`, and record which you used.

**Scope every query to the tenant under test.** The builder, the setting, the bots, the
events and the audit rows are all per tenant. Resolve the installation's tenant once per
`psql` session (an installation has exactly one `PRIMARY` tenant):

```sql
SELECT id AS tid, slug FROM tenants WHERE kind = 'PRIMARY' \gset
\echo :tid :slug
```

**Evidence queries** (read-only), used throughout:

```sql
-- What the runtime will draw and from which source.
SELECT tenant_id, draft_version, published_revision, projection_setting_version,
       draft_legacy_setting_version
  FROM main_menu_layouts WHERE tenant_id = :'tid';
SELECT tenant_id, version, value FROM setting_values
 WHERE tenant_id = :'tid' AND setting_key = 'bot.main_menu';
SELECT tenant_id, revision, restored_from_revision_id IS NOT NULL AS restored, created_at
  FROM main_menu_revisions WHERE tenant_id = :'tid' ORDER BY revision;
-- Per-bot icon eligibility (one truth for the builder and the messenger, OQ-T-4).
SELECT tenant_id, id, username, custom_emoji_tested_at, custom_emoji_test_outcome,
       custom_emoji_test_error_code
  FROM bot_instances WHERE tenant_id = :'tid';
-- Conditions the messenger or the settings resolver raised.
SELECT tenant_id, code, context, first_seen_at, last_seen_at, occurrence_count, resolved_at
  FROM operational_events
 WHERE tenant_id = :'tid'
   AND code IN ('telegram.appearance_decoration_failed', 'telegram.customer_send_failed',
                'settings.stored_value_invalid', 'bot_menu.published_unreadable')
 ORDER BY last_seen_at DESC LIMIT 20;
-- The builder's audit trail.
SELECT tenant_id, occurred_at, action, actor_label FROM audit_logs
 WHERE tenant_id = :'tid' AND action LIKE 'bot_menu.%'
 ORDER BY occurred_at DESC LIMIT 20;
```

The keyboard is attached to the **main-menu answer** (the reply to `/start` and the other
main-menu entries), not to every message (`commerce/messaging/application/ports.ts:151-159`).
"Send `/start`" below means: send it, then look at the keyboard under the chat.

## R-ACC-0 — record the starting point and publish a baseline revision (do this first)

A tenant that has never published has **no** revision to go back to: the first publish
creates revision 1 (`main_menu_revisions` has no row before it), and **Reset → From the live
keyboard** seeds from whatever `bot.main_menu` holds now — after a publish, that is the
projection of the layout you published, not the one you started from. So a baseline must exist
before anything is changed.

**Steps.**

1. Run the evidence queries; record the `bot.main_menu` value and version, and whether a
   `main_menu_layouts` row exists. Screenshot the customer keyboard after `/start` on Bot E.
2. Open `/bot-buttons`. If the source line says the menu is built from a published revision,
   a baseline already exists: record its number and skip to R-ACC-1. If a draft was saved
   earlier but nothing is published, use **Reset → From the live keyboard** (confirm) so the
   draft equals the live arrangement, then **Publish** and continue at step 4.
3. Otherwise the draft is seeded from the live arrangement but not saved, and the page will not
   save it unchanged: Save draft is enabled only for a changed draft and Publish only for a
   saved one (`apps/web/src/pages/bot-buttons/builder.tsx:206`, `:507-523`). Save the seeded
   draft as it is from the browser console on `/bot-buttons`, signed in as the operator (the
   browser sends the session; nothing secret is printed):

   ```js
   const v = await (await fetch('/api/admin/v1/bot-menu/builder')).json();
   const r = await fetch('/api/admin/v1/bot-menu/builder/draft', {
     method: 'PUT',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({
       idempotencyKey: `racc0-${Date.now()}`,
       expectedDraftVersion: v.draft.version, // null: no draft row yet
       legacyBaselineVersion: v.draft.legacyBaselineVersion,
       layout: v.draft.layout,
     }),
   });
   console.log(r.status, v.source, v.draft.version);
   ```

   (`BOT_MENU_BUILDER_ROUTES.draft` and `saveMainMenuDraftRequestSchema`,
   `packages/contracts/src/bot-menu-builder.ts:330`, `:469-480`.) Expect `200 LEGACY null`.
   Reload the page, then **Publish**. In the dialog, compare the "now" and "after" keyboards:
   they must be identical. They can differ only where a gated key (trial, referral) shares a
   row with an ungated key while its gate is closed — the legacy path re-packs the row, the
   explicit layout drops the key and keeps the row (audit §11.3). If they differ, record the
   difference and decide whether to accept it before confirming.

4. `/start` on Bot E again.

**Pass.** Revision 1 exists; the customer keyboard is unchanged (same keys, order and rows as
the screenshot in step 1).

**Record.** The revision number (the **baseline**). Every later "roll back" in this document
means: **History → Restore into draft** on the baseline → **Publish**. Revisions are append-only,
so the baseline survives everything below. Note that once a tenant has published it stays on
the published layout; the only way back to the pre-builder legacy path is the superseding
write an older release makes (R-ACC-5), not a button. Never edit `main_menu_*` tables by hand.

## R-ACC-1 — styles render and the request is accepted

**Steps.**

1. `/bot-buttons` → arrange one row of three: `catalog` = **Primary (blue)**, `wallet` =
   **Success (green)**, `services` = **Danger (red)**; a second row with `help` = **Default**.
2. **Save draft**. `/start` on Bot E. **Expect the baseline keyboard** (a draft is never live).
3. **Publish** → the dialog lists the changes and shows "now" and "after" keyboards →
   **Yes, publish**.
4. `/start` on Bot E from Desktop, Android and iOS.

**Pass.** Every client shows the new rows; three keys visibly styled, `help` unstyled; no
client drops the keyboard or shows an error. The evidence query shows no new
`telegram.customer_send_failed` for this tenant, and the published revision advanced by one.

**Record.** Per client: screenshot, client version, whether each colour matched the builder's
legend. The colour for each style is the client's; note any client that draws none.

**Fail action.** If the keyboard does not arrive and a `telegram.customer_send_failed` opened,
restore the baseline revision and publish it, then reproduce the refusal with your own probe
(R-ACC-2 part A's procedure, with a `style` field instead of an icon) to capture Telegram's
exact response for `OQ-T-API-01`.

## R-ACC-2′ — after the icon's retirement: a layout published WITH an icon draws none

Run this instead of R-ACC-2 on a build containing the 2026-10-02 change.

**Steps.**

1. On `v0.4.x`, with Bot E eligible (Appearance test `SENT`, `wallet` slot configured), publish
   a layout whose `wallet` key carries the wallet icon (R-ACC-2 part B, steps 1–2). `/start` on
   Bot E: the icon is drawn (screenshot).
2. Update staging to the build under test (`botctl update VERSION`). Do not publish anything.
3. `/start` on Bot E from all three clients.
4. `/bot-buttons`: no «آیکون دکمه» and no «آیکون معنایی» anywhere; the editor, the customer
   preview and the live preview draw no icon; the state badge is not «unsaved» or «differs»
   because of the icon alone.
5. `botctl rollback` (no publish in between), `/start` on Bot E.

**Pass.** Step 3: the same rows, labels and styles as step 1, **no** icon, one message per
`/start`, and Bot E's `custom_emoji_test_outcome` still `SENT`. Step 5: the icon is drawn
again (the stored snapshot was never rewritten). Then update again and publish once; after a
second rollback the icon stays gone (the new snapshot carries `iconSlot: null`).

**Record.** Screenshots of steps 1, 3 and 5; the evidence query for Bot E's outcome.

## R-ACC-2 — icons: eligible bot draws; the ineligible bot's refusal, recorded first-hand

_Superseded on builds containing the 2026-10-02 change — see R-ACC-2′. Kept for `v0.4.x`._

### Part A — what Telegram answers an ineligible bot (your own probe, _fixture_)

The application never stores Telegram's refusal sentence, so capture it directly. On your own
workstation (not the server), with Bot I's token in a file only you can read:

1. From your **own** Telegram account, send `/start` to Bot I (a bot cannot message a chat
   that never opened it). Find your numeric Telegram id (the one bound to your Web Admin
   account).
2. Keep the token out of history, `ps` and logs. In a shell:

   ```bash
   set +o history                         # bash: nothing below is written to history
   umask 077
   # bot-i.token: a file containing only Bot I's token, created with an editor, mode 0600.
   cat > /tmp/iconed.json <<'JSON'
   {"chat_id": YOUR_NUMERIC_ID, "text": "R-ACC-2 probe",
    "reply_markup": {"keyboard": [[{"text": "probe", "icon_custom_emoji_id": "YOUR_EMOJI_ID"}]],
                     "resize_keyboard": true}}
   JSON
   printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$(cat bot-i.token)" |
     curl -sS -K - -H 'content-type: application/json' --data-binary @/tmp/iconed.json
   echo
   set -o history
   ```

   `printf` is a shell built-in and `curl -K -` reads the URL from standard input, so the
   token never appears in a process list or in shell history. Do not use `curl -v` (it prints
   the URL).

3. Repeat once with Bot E's token file and the same body.

**Record (_fixture_).** The full JSON response from each bot: `ok`, `error_code` and the exact
`description` (it contains no token; check before pasting, and never paste the URL). Then
say which case applies to Bot I: (a) a 400 whose description names custom emoji; (b) a 400
whose description does not; (c) `ok: true` and the client shows no icon (screenshot); (d)
`ok: true` and the icon is drawn (Bot I is not ineligible after all — pick another bot).
Widen `isCustomEmojiDenial` (`telegram-customer-messenger.ts:185`, over `classifyProbeRefusal` at `:161`) only from case (a)'s
sentence, in its own commit, with that sentence as a test fixture.

### Part B — what the application does with it

**Steps (eligible).**

1. **Appearance** → `wallet` slot → the custom emoji id → enabled → save. Run the
   **Appearance test** from Bot E; confirm `SENT`.
2. `/bot-buttons` → select `wallet` → **Icon** = the wallet slot. The Inspector lists Bot E as
   eligible and Bot I as no icon. Save draft, publish.
3. `/start` on Bot E (all three clients).

**Pass (eligible).** The custom emoji is drawn as the key's icon and the key's text is the
label; Bot E's `custom_emoji_test_outcome` stays `SENT`.

**Steps (ineligible, forced).** The messenger only puts an icon on a bot whose test is `SENT`
(`appearance/application/eligibility.ts`, `isCustomEmojiEligible`), so Bot I must be marked
eligible for one message. The row's three test columns are tied by
`bot_instances_custom_emoji_test_shape_check`: all null, or `tested_at` and `outcome` set with
`(outcome = 'SENT') = (error_code IS NULL)` (`apps/api/src/infrastructure/persistence/schema.ts:579-584`,
migration `0151_premium_ui_appearance.sql:24`). Change and restore all three together.

```sql
-- Record first (read-only):
SELECT id, custom_emoji_tested_at, custom_emoji_test_outcome, custom_emoji_test_error_code
  FROM bot_instances WHERE tenant_id = :'tid' AND username = 'BOT_I_USERNAME';
-- Staging write: mark Bot I eligible.
UPDATE bot_instances
   SET custom_emoji_tested_at = now(), custom_emoji_test_outcome = 'SENT',
       custom_emoji_test_error_code = NULL
 WHERE tenant_id = :'tid' AND username = 'BOT_I_USERNAME';
```

Wait 30 seconds (the decoration reader caches per tenant for
`APPEARANCE_CACHE_TTL_MS = 30_000`, `drizzle-appearance.repository.ts:257`), then `/start` on
Bot I from the customer account.

**Pass (ineligible).** The customer receives **one** message, with the same text and styles and
no icon (or, in Part A's case (c), the icon silently not drawn). Then, by the evidence queries:

- case (a): one `telegram.appearance_decoration_failed` with `eligibilityChanged: true`, and
  Bot I's outcome is no longer `SENT`; the next `/start` from Bot I is answered without an
  icon and opens nothing new;
- case (b): the same event with `eligibilityChanged: false`, Bot I still `SENT`, and every
  iconed message keeps costing one refused request plus one retry (T4 F-10, `OQ-T-API-05`).

In no case may the customer see the same reply twice.

**Restore (staging write).** Put back the three values you recorded:

```sql
UPDATE bot_instances
   SET custom_emoji_tested_at = <recorded or NULL>,
       custom_emoji_test_outcome = <recorded or NULL>,
       custom_emoji_test_error_code = <recorded or NULL>
 WHERE tenant_id = :'tid' AND username = 'BOT_I_USERNAME';
```

(If the recorded triple was all null, set all three to `NULL`.) Then restore the baseline
revision and publish, or remove the icon slot from the button and publish.

**Also check (QA-3).** `bot.menu.wallet` starts with an emoji (`💰 کیف پول`), so Bot E's key may
show two glyphs (icon + emoji); the builder warns (`bb-icon-doubled`). Screenshot what each
client shows; the remedy is a label edit on **Texts**, not a code change.

## R-ACC-3 — a tap on a styled or iconed key routes by its label

_On a build containing the 2026-10-02 change no key carries an icon: tap the styled keys._

**Steps.** With the R-ACC-1/2 layout published, from the customer account tap every placed key
on Bot E: catalog, services, wallet (iconed), help, apps, tickets, and — after opening their
gates (R-ACC-7) — trial and referral. After each tap, send the matching slash command
(`/catalog`, `/wallet`, …).

**Pass.** In the chat, the message the tap sent is exactly the label as written on **Texts**
(no icon glyph prepended), and the bot's answer to it is the same screen as its slash
command's answer.

**Record.** For each key, a screenshot showing the sent bubble and the reply, with the slash
command's reply beside it. Any key answered with the "unknown input" reply, with the client.
(The server does not log what a customer typed — `webhook.controller.ts:375-381` — so the
chat is the evidence.)

## R-ACC-4 — rollback to the release before Round T keeps order and visibility

**Steps.**

1. Publish a layout the old two-per-row packing could not draw (three keys on one row,
   `tickets` switched off, `referral` in the pool). Run the evidence queries; screenshot the
   keyboard after `/start`.
2. `botctl version`: confirm `version` = the Round T build and `previous` = the pre-Round-T
   release (see "Rollback mechanics"). Then `botctl rollback` (or `botctl update <pre-Round-T
version>` if `previous` is something else). The database is not restored; migration 0156
   is expand-only.
3. `botctl version` again: confirm the pre-Round-T version is running. `/start` on Bot E.
   Open the old **دکمه‌های ربات** page and do **not** save.

**Pass.** The keyboard shows the **same keys in the same order with the same ones hidden**,
packed two per row (a wide key alone), no styles, no icons. The evidence query shows **no**
`settings.stored_value_invalid` for this tenant. The old page loads the arrangement without an
error.

**Record.** Both `botctl version` outputs, the screenshot, the `bot.main_menu` value and
version. (QA reproduced the parse locally: both stored projections parse under the `25e717a`
registry schema with the same visible order — `docs/round-t-qa-report.md` §4.)

## R-ACC-5 — a save on the old release, then roll forward: superseded, refuse, reseed, restore

**Steps.**

1. Still on the old release (after R-ACC-4): on its **دکمه‌های ربات** page change the order
   and **save once**.
2. `/start`: the keyboard follows that save.
3. Roll forward: `botctl update <Round T version>`; `botctl version` to confirm. `/start`.
4. Open `/bot-buttons`.
5. Confirm the publish is refused, in two ways:
   - **Page:** Publish is disabled, with the note «منوی زنده تغییر کرده است؛ ابتدا پیش‌نویس را
     از منوی زنده دوباره بسازید.»
   - **API** (the page will not send it): in the same browser tab, signed in as the operator,
     open the developer tools console and run

     ```js
     const v = await (await fetch('/api/admin/v1/bot-menu/builder')).json();
     const r = await fetch('/api/admin/v1/bot-menu/builder/publish', {
       method: 'POST',
       headers: { 'content-type': 'application/json' },
       body: JSON.stringify({
         idempotencyKey: `racc5-${Date.now()}`,
         expectedDraftVersion: v.draft.version,
         expectedPublishedRevision: v.published?.revision ?? null,
       }),
     });
     console.log(r.status, (await r.json()).error?.code, v.superseded);
     ```

     The session cookie is sent by the browser and is never printed; the route and body are
     `BOT_MENU_BUILDER_ROUTES.publish` and `publishMainMenuRequestSchema` (`packages/contracts/src/bot-menu-builder.ts:331`, `:487-491`); the refusal code is `control.version_conflict` (`packages/contracts/src/errors.ts:431`). The two expectations are the
     current ones, so the only reason left to refuse is the superseding write.

6. Click **ساختن دوباره از منوی زنده** (reseed from the live keyboard) → the reset dialog opens
   with **From the live keyboard** selected → confirm.
7. **History** → restore the revision you had published before the rollback → **Publish**.

**Pass.**

- After 3: the keyboard still follows the old release's save (the operator's latest act wins).
- After 4: a warning that the live menu was changed by an older release (with the reseed and
  restore procedure in its text), and a second warning that the live menu changed since the
  draft, with the reseed button; the source line says the legacy arrangement is live.
- After 5: the console prints `409 control.version_conflict true`, and the `bot.main_menu`
  version in the evidence query is unchanged.
- After 7: the publish dialog shows the "customers currently see what an older release wrote"
  warning and **no** "no layout change" sentence (T4 F-2); afterwards the source line names
  the new revision, the superseded warning is gone, and `/start` draws the explicit rows.

**Record.** Screenshots of 4, 5 (page and console line) and 7; the revision number created;
audit rows `bot_menu.reset`, `bot_menu.restored`, `bot_menu.published` for this tenant.

**Roll back.** None needed — step 7 is the recovery.

## R-ACC-6 — extreme shapes: one row of eight, eight rows of one

**Steps.** Open the trial and referral gates (R-ACC-7). Publish a layout with all eight keys on
one row; `/start` on all three clients. Then eight rows of one; `/start` again. Restore the
baseline revision afterwards.

**Pass.** Telegram accepts both (`OQ-T-API-03`: the bound of eight per row is the domain's, not
Telegram's) — the keyboard arrives and no `telegram.customer_send_failed` opens. Record how
legible the one-row keyboard is on a narrow phone; the builder warns about cramped rows but
does not refuse them.

**Record.** Screenshots; if the keyboard does not arrive, capture Telegram's answer with your
own probe (R-ACC-2 part A's procedure, with the same keyboard).

## R-ACC-7 — gates: trial and referral hide and reappear without reflow

**Steps.**

1. Place `trial` and `referral` on one row with an ungated key; publish.
2. Close both gates: no panel offers a free trial (panel → trial settings, `panels.edit`) and
   the `referrals` feature is off (**Features**, `settings.edit`). `/start`.
3. Open both gates. `/start` again.
4. With the gates closed again, type the trial and the referral labels exactly as written on
   **Texts** into the chat.

**Pass.** Closed: both keys absent, their row shortened, the other rows unchanged (no reflow);
the builder shows them «اکنون پنهان». Open: present after the next `/start`. Step 4: each typed
label is answered by its screen (routing does not depend on the key being drawn).

**Record.** Screenshots of 2, 3 and 4.

## R-ACC-8 — inline buttons win over the reply keyboard (not a staging check)

No reply the application sends carries both markups: every reply that attaches the main-menu
keyboard sets `buttons: []` (`apps/api/src/surfaces/telegram/bot-runtime.ts:9763-9765`,
`:9878-9880`, `:10203-10206`), and the port says so (`commerce/messaging/application/ports.ts:151-159`).
There is therefore no staging flow that exercises the precedence rule, and none should be
built for this checklist. It is covered by tests only:

- `tests/unit/telegram-reply-keyboard-wire.test.ts:217` › R-6 lets inline buttons win over the
  reply keyboard (T4 mutation M14 killed by it);
- `tests/unit/telegram-reply-keyboard-wire.test.ts:418` › counts no icon when inline buttons take
  the reply_markup: a refusal is one call, nothing marked (falsification row T2-15,
  `docs/round-t-t2-falsification.md`).

**Record.** Nothing. If a later release adds a reply with both, this item becomes a staging check
again.

## R-ACC-9 — the Web Admin by hand: widths, themes, RTL, keyboard-only, touch

QA took 46 screenshots locally (`docs/round-t-qa-report.md` §3); this is the human pass on a
real device.

**Steps.**

1. Desktop browser at 1440 and 900 wide, light and dark: builder, publish dialog, history
   drawer, superseded banners. Phone (≈390 wide) the same.
2. **Keyboard only** (no pointer): Tab to a key; **Alt+↑/↓** change row; **Alt+→** moves
   earlier and **Alt+←** later (Persian, right to left); **Delete** sends a key to the pool;
   in the pool **Alt+Enter** places it in a new row; Tab to **Save draft** → Enter; Tab to
   **Publish** → Enter; Tab to **Yes, publish** → Enter. A screen reader announces each move.
3. **Touch** on a real Android phone (Chrome) and an iPhone (Safari): drag a **key** by its
   grip (☰ beside the label) into another row and to a new row; drag a **row** by its row
   grip.

Restore the baseline revision afterwards if anything was published.

**Pass.** No horizontal scrolling; every control reachable; every move possible without a
pointer; touch drags work for keys **and** rows.

**Record (QA-2).** In Chromium's touch emulation QA found that a touch on a **key's** grip is
retargeted to the key's own button, so the key drag never starts (a row drag works). Record
whether this reproduces on a real Android Chrome and on iOS Safari. If it does, the Inspector's
move buttons and the keyboard remain the working path, and the defect stands.

**On a build containing the 2026-10-02 drag pass, also check:** the grip is a larger button
(the ☰ beside the label); a tap on it without moving changes nothing; once the finger moves, a
ghost of the key rides above the finger, the target row is outlined and a caret (or, between
rows, a line with «رها کنید تا ردیف تازه‌ای اینجا ساخته شود») shows where it will land, and
nothing on the page shifts while dragging; dropping where the key already is changes nothing;
near the top or bottom of the screen the page scrolls. The CDP probe
`scripts/web-shots/bot-buttons-drag.mjs` passes in headless Chromium but could not reproduce
QA-2 on the old grip, so this real-phone record is still the answer.

---

## Sign-off

| Item     | Result | Date | `botctl version` | Recorded by | Notes                           |
| -------- | ------ | ---- | ---------------- | ----------- | ------------------------------- |
| R-ACC-0  |        |      |                  |             | baseline revision:              |
| R-ACC-1  |        |      |                  |             |                                 |
| R-ACC-2  |        |      |                  |             | Bot I case (a/b/c/d):           |
| R-ACC-2′ |        |      |                  |             | replaces R-ACC-2 after 10-02    |
| R-ACC-3  |        |      |                  |             |                                 |
| R-ACC-4  |        |      |                  |             |                                 |
| R-ACC-5  |        |      |                  |             |                                 |
| R-ACC-6  |        |      |                  |             |                                 |
| R-ACC-7  |        |      |                  |             |                                 |
| R-ACC-8  | n/a    |      |                  |             | tests only (`ports.ts:151-159`) |
| R-ACC-9  |        |      |                  |             |                                 |

Round T is accepted when R-ACC-0..5 pass (T4 §9) and R-ACC-6, 7 and 9 are recorded — with
R-ACC-2′ in place of R-ACC-2 on a build containing the 2026-10-02 change. Any
observed Telegram sentence goes into `docs/open-questions.md` under its `OQ-T-API-*` entry and
into a test fixture in the same commit.
