# Round T — clean QA report (Telegram Button Builder)

Status: **QA record, no source change.** Written by the clean QA agent, which did not build or
review Round T. Every verdict below rests on evidence this agent produced at the SHA below,
in its own worktree (`/home/user/wt-round-t-qa`, branch `round-t/qa`), its own integration
database (`nexa_test_tqa`, Redis db 12) and its own dev database (`nexa_qa_t`). No source
file was edited; the only committed outputs are this file and
`docs/round-t-telegram-acceptance.md`.

| Item               | Value                                                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SHA under test     | **`67579a8388f39d4a66df7ff4db660adf7dd01a81`** (`main`, merge of PR #137)                                                                                                     |
| Base (pre-Round-T) | `25e717a`                                                                                                                                                                     |
| PRs                | #133 T0+T1 (merge `5070a21a`), #134 T3 (merge `9229da43`), #135 T2 (merge `f9be46f1`), #137 T4 fixes (merge `67579a83`)                                                       |
| Inputs             | owner brief (scratch copy), `CLAUDE.md`, `docs/round-t-button-builder-audit.md`, `docs/round-t-final-review.md` (§10), `docs/deployment.md` round T, `docs/open-questions.md` |
| Screenshots        | 46 PNGs, outside the repository: `scratchpad/shots-qa/` (paths below are relative to it)                                                                                      |
| Tag/Release/Deploy | **none by QA.** A release `v0.4.0` exists on `f9be46f1` — see QA-1                                                                                                            |

**Verdict.** The feature does what the brief asks, end to end, in the real app: drag,
keyboard and Inspector moves, styles, icon slot, disable vs remove, draft that customers do
not see, confirmed publish with a diff, history and restore, confirmed reset, the superseded
path with its banner, refusal and reseed, and a wire that is legacy byte-for-byte until
publish and carries styles and per-bot icons after it. **No BLOCKER, no HIGH.** Two MEDIUM
findings: a published release that contradicts the round's "no release" rule and predates the
T4 fixes (QA-1, owner decision), and touch dragging of individual keys that does not start in
Chromium (QA-2). Four LOW and four INFO.

**Counts.** Definition of Done (30 items): **27 PASS, 2 PARTIAL, 1 FAIL** (item 30, by QA-1).
"Do NOT" list (15 items): **14 PASS, 1 FAIL** (DN-12, by QA-1).

## 1. Gate results at `67579a83`

| Gate                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build && pnpm verify`  | **PASS** (exit 0): typecheck, lint, format, boundaries, i18n, citations **2 530**, unit **180 files / 2 861 tests**, web **68 / 1 409**, deploy, build. `check:shell` **skipped locally** (shellcheck not installed; CI runs it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm db:check`              | **PASS** — "schema and migrations agree"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm test:integration`      | **173 / 174 files, 3 569 / 3 570 tests** against `nexa_test_tqa`. The one failure, `web-disaster-recovery.test.ts` › drops the scratch database and removes the plaintext, was this run's OWN scratch `nexa_verify_e56c…` whose `DROP` failed (`backupTools.leaked`) while another worktree's suite (`wt-tonpays-tg`) ran restores on the same PostgreSQL server. Re-run alone (with `backup.test.ts`): `web-disaster-recovery.test.ts` **passed in full**; `backup.test.ts` failed only its cluster-wide "no `nexa_verify_%` database exists" assertion, listing databases the other worktree was creating at that moment (21 / 22 on a second solo run, again only that assertion, with different foreign names). QA dropped its own leaked scratch. Neither file is touched by Round T. See QA-INFO-4 |
| CI on PR heads               | green: #133 `a72daa14`, #134 `bcef4ad5`, #135 `e4602d7b`, #137 `8377c2d2` (push and pull_request runs). Main CI on `67579a83` was **in progress** when checked (run 37001345353).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Nightly exhaustive orderings | **failed** on `f9be46f1` (run 36989342793): a 600 s timeout in "holds every invariant when a send is still in flight", not an invariant violation; outside Round T's files — QA-INFO-1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 2. How the app was exercised

- **Real app.** `pnpm build`; a fresh database `nexa_qa_t` prepared with the compiled CLIs
  from `CLAUDE.md` (`pnpm db:migrate`, `pnpm db:seed`, `pnpm admin:bootstrap` with the password
  on stdin, `pnpm provision` → "already exists; nothing changed"). The API was `apps/api/dist`
  (`createApiApp` + `listen`, i.e. `main.ts` without the signal handlers) with
  `TELEGRAM_API_BASE_URL` pointed at the repository's own fake
  (`tests/support/fake-telegram-bot-api.ts`) and the webhook enabled. The web was the
  production build under `vite preview`. Three seeded bots were bound to fake Telegram bots:
  A1 (tenant A, appearance test `SENT`), A2 (tenant A, untested), B1 (tenant B, `SENT`). The
  `wallet` appearance slot was given a custom emoji id through `POST /appearance/slots/wallet`.
- **Customer side.** Webhook updates (`/start`, labels, slash commands) were posted to
  `/telegram/webhook/<bot>`; what the fake received from `sendMessage` is the evidence.
- **Browser.** Playwright 1.56 driving Chromium from `/opt/pw-browsers`, signed in as the
  bootstrapped owner. Scripts and logs are in the scratchpad (`qa/s1.mts` … `qa/s10.mts`,
  `qa/s1-log.json`, `qa/s2-log.json`, `qa/s3-log.json`); they are QA probes, not committed
  tests, and nothing below claims a test that is not in the repository.
- **Clean-up.** Both servers were stopped before the integration suite ran.

### 2.1 Observed results (selected)

| Step                         | Observed                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First visit                  | state `not_saved`; draft seeded from legacy `[[catalog,services],[wallet,help],[trial,referral],[apps],[tickets]]`; trial/referral badged «اکنون پنهان» (gates closed); A1 eligible, A2 not (`00-initial-1440-light.png`)                                                                                                                                                                       |
| Drag (mouse)                 | key → new row at top; key onto a key (placed before it); whole row → top; key → pool. Each produced exactly the expected rows (`01-after-drags-1440-light.png`)                                                                                                                                                                                                                                 |
| Keyboard only                | focused key: Alt+↑ / Alt+→ (earlier, RTL) / Alt+← (later) / Alt+↓ each did one move; Delete → pool; Alt+Enter in pool → new last row; live region announced «… به ردیف 5، جایگاه 1 رفت.». Tab reached a key from the mode buttons; Save draft, Publish and the dialog's confirm were each reached by Tab and activated by Enter; focus moved into the dialog; revision 8 published this way     |
| Inspector                    | styles primary/danger/success set; icon slot `wallet` → "this slot has a custom emoji"; eligibility "@acme_store_bot eligible / @acme_support_bot no icon"; target `/wallet` read-only; tickets switched off (chip `is-off`); help removed to pool then placed back into row 1 (`02-inspector-wallet-1440-light.png`)                                                                           |
| Customer preview             | `[[help],[wallet:success],[catalog:primary,services:danger],[apps]]` — disabled tickets, gated trial and pooled referral absent (`03-customer-preview-1440-light.png`)                                                                                                                                                                                                                          |
| Save draft                   | state `differs`; API `source: LEGACY`, `published: null`, `draft.version: 1`; **A1's `/start` still carried the legacy keyboard, `{text}` only** (`04-draft-saved-1440-light.png`)                                                                                                                                                                                                              |
| Publish #1                   | dialog: first-publish banner, "now" and "after" keyboards; after confirm: state `published`, source line «… از نسخهٔ منتشرشدهٔ 1 …», API `EXPLICIT`, revision 1 (`10-publish-dialog-first-1440-light.png`)                                                                                                                                                                                      |
| Wire after publish           | A1: `[[help],[wallet success + icon_custom_emoji_id],[catalog primary, services danger],[apps]]`; **A2 (untested) same rows and styles, no icon**; **B1 (other tenant) legacy `{text}` only**                                                                                                                                                                                                   |
| Routing                      | tapping the iconed wallet key (its `text` exactly «💰 کیف پول») answered the same text as `/wallet`; the referral label (unplaced, not drawn) still routed like `/referral`                                                                                                                                                                                                                     |
| Publish #2                   | dialog diff «🛒 خرید اشتراک: رنگ تغییر می‌کند» (`11-publish-dialog-diff-1440-light.png`) → revision 2                                                                                                                                                                                                                                                                                           |
| History / restore            | drawer lists revisions newest first, "current" badge, keyboards per revision (`12-history-drawer-1440-light.png`); restore rev 1 → confirm dialog "nothing goes live until you publish" → banner «این پیش‌نویس از نسخهٔ ۱ بازگردانده شده…», state `differs` (`13-restored-banner-1440-light.png`); publish → revision 3 with `restoredFrom = 1`                                                 |
| Reset                        | dialog with DEFAULT / LIVE radio; Cancel left `draft.version` unchanged (3); confirm → draft = registry default (v4); customers still on revision 3 (`14-reset-dialog-1440-light.png`)                                                                                                                                                                                                          |
| Unsaved guard                | an unsaved style change, then a sidebar link: dialog «تغییرات ذخیره نشده … خروج بدون ذخیره / ماندن و ادامهٔ ویرایش»; "stay" kept `/bot-buttons` (`15-unsaved-guard-1440-light.png`)                                                                                                                                                                                                             |
| Conflict                     | a second session saved first; this session's save → HTTP 409, state `conflict`, banner "nothing was overwritten; reload" (`16-conflict-banner-1440-light.png`)                                                                                                                                                                                                                                  |
| Invalid                      | only gated keys left placed → state `invalid`, Save disabled (`17-invalid-1440-light.png`); the same layout sent to the API → 400                                                                                                                                                                                                                                                               |
| Superseded (older release)   | current settings API `POST /settings/bot.main_menu` → **409** (guard), version unchanged. Then a direct SQL write of a legacy-shaped value with `version + 1` (what the old release's settings service does): A1's `/start` followed the older write at once; builder: `source LEGACY`, `superseded: true`, both warning banners and the reseed button (`20-superseded-banners-1440-light.png`) |
| …refused, reseeded, restored | Publish disabled with «منوی زنده تغییر کرده است؛ ابتدا پیش‌نویس را از منوی زنده دوباره بسازید.»; an API publish of the stale draft → **409**; reseed button → reset dialog with **LIVE pre-selected** → draft = live rows, baseline 4; restore rev 3 → publish dialog showed the superseded warning and no "no change" sentence (T4 F-2) → revision 4, `EXPLICIT`, wire explicit again          |

### 2.2 Wire probes (fake Telegram)

| Probe                                                      | Requests | Result                                                                                                           |
| ---------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| Never-published tenant, eligible bot                       | 1        | every key `{text}` only, `resize_keyboard/is_persistent/one_time_keyboard/selective` as before                   |
| `apply_then_drop` (answer lost after the send took effect) | 1        | no resend                                                                                                        |
| HTTP 500                                                   | 1        | no resend                                                                                                        |
| `apply_then_garble` (unreadable 2xx)                       | 1        | no resend                                                                                                        |
| Connection dropped                                         | 1        | no resend                                                                                                        |
| HTTP 429                                                   | 1        | no immediate resend                                                                                              |
| Definite `CUSTOM_EMOJI_INVALID` 400                        | 2        | second request icon-less, styles and text kept; bot A1 → `REJECTED`; one `telegram.appearance_decoration_failed` |
| Next message from the same bot                             | 1        | no icon, no retry                                                                                                |

### 2.3 Server-side refusals (each body otherwise valid, `legacyBaselineVersion` included)

`url`, `target`, `callback_data` or `label` on a button config → 400; unknown button id → 400;
style `secondary` → 400; unknown icon slot, or a raw emoji id as slot → 400; only gated keys
placed → 400; empty row → 400; a key placed twice → 400; `v: 2` → 400; stale
`expectedDraftVersion` → 409; same idempotency key with a different layout → 409; same key
and body → replayed, identical (compared key-order-insensitively — jsonb reorders keys), no
second effect; reset without `confirm: true` → 400; another tenant's / unknown revision id →
404; publish replay → one revision.

### 2.4 Database evidence (`nexa_qa_t`)

- `main_menu_revisions`: `UPDATE` and `DELETE` both raise "Table main_menu_revisions is
  append-only"; `created_by_admin_id` set on every row; revisions 3→1 and 4→3 carry
  `restored_from_revision_id`.
- `main_menu_layouts.projection_setting_version` equals `setting_values.version` of
  `bot.main_menu` after each publish (3 → 3, 5 → 5).
- `audit_logs`: only `bot_menu.draft_saved`, `bot_menu.published`, `bot_menu.reset`,
  `bot_menu.restored`; dozens of local moves produced no audit row.
- `outbox_messages`: one `SettingChanged` per publish (3 after 3 publishes).
- `operational_events`: no `settings.stored_value_invalid`, no `bot_menu.published_unreadable`.

## 3. Visual QA (screenshots looked at, not only taken)

Matrix at **1440 / 900 / 390 × light / dark** for the builder, the builder with a key
selected, the publish dialog with a diff, the history drawer, and the superseded banners
(`m-*-<width>-<theme>.png`, 30 files) plus the step shots above. Every matrix page reported
**no console error after sign-in and no horizontal overflow** (`scrollWidth − clientWidth = 0`,
page and open dialog). Looked at: 1440 dark builder and dialog, 900 light builder and dark
dialog, 390 light/dark builder, dialog and drawer, 1440 light drawer, 1440 dark and 390 light
superseded banners.

- RTL is correct throughout; the three-column layout (pool, phone, Inspector) at 1440, pool
  above with Inspector beside at 900, a single column at 390.
- Styles read as distinct in both themes (blue/green/red outlines and tints); a switched-off
  key is struck through with «خاموش»; a gated key has a dashed outline and «اکنون پنهان»;
  the icon slot is drawn as the slot's fallback emoji in a dashed box — no fake custom-emoji
  art — with a legend underneath.
- The publish dialog's change list and the "now / after" keyboards fit at 390 (the dialog
  scrolls inside itself).
- T4's 390 observation (a word split at the ZWNJ in «سرویس‌های من») did **not** appear in the
  layouts QA used (two keys per row); it was reported for a three-key row and stays with
  R-ACC-9.
- Findings: QA-3 (doubled glyph), QA-5 (squeezed banner at 390).

## 4. Rollback check (real `25e717a` parser)

Method: `git archive 25e717a packages/contracts` into the scratchpad, `settingDefinition('bot.main_menu').schema`
from that tree's `settings.ts` — the exact call the old `SettingsResolver` makes
(`definition.schema.safeParse(row.value)`, which records `settings.stored_value_invalid` on
failure) — applied to the stored `bot.main_menu` values.

| Stored value                             | Old registry parse | Old visible order (`resolveMainMenuLayout`, enabled) | Ungated enabled |
| ---------------------------------------- | ------------------ | ---------------------------------------------------- | --------------- |
| projection of revision 3 (`setting v3`)  | **OK**             | help, wallet, catalog, services, trial, apps         | 5               |
| projection after the last publish (`v5`) | **OK**             | help, wallet, catalog, services, trial, apps         | 5               |

The published explicit rows were `[[tickets,help],[wallet],[catalog,services],[trial],[apps]]`
with `tickets` off and `referral` unplaced: the old order is the new row-major order of the
shown keys. **No invalid-value event would fire.** This complements T4's 161 616-layout
generator (`docs/round-t-final-review.md` §6), which QA did not re-run.

## 5. Definition of Done

Numbering follows `docs/round-t-final-review.md` §3 (the brief's bullets in order).

| #   | Criterion                                                                                                         | Verdict     | Evidence                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Extends the existing main menu; no parallel engine/registry/labels/router/preview                                 | PASS        | §2.1: the wire after publish is built from the same labels and routes; an unplaced key's label still routes (§2.1 Routing); `/bot-menu` sync and commands cards still render on the page (`00-initial`)                                        |
| 2   | T0 read-only audit                                                                                                | PASS        | `docs/round-t-button-builder-audit.md` §1–§15 present                                                                                                                                                                                          |
| 3   | Main reply keyboard only; `style` / `icon_custom_emoji_id` understood                                             | PASS        | `git diff 25e717a..67579a8 -- apps/api/src/infrastructure/telegram/send-message.ts`: only `keyboard` cells changed; inline markup unchanged                                                                                                    |
| 4   | Drag rows; any practical number per row; reorder rows and buttons                                                 | PASS        | §2.1 Drag: key → new row, key → before key, row → top, key → pool; three-key rows published                                                                                                                                                    |
| 5   | Pool from the declared registry only; no arbitrary callbacks/URLs/commands                                        | PASS        | §2.3: `url`, `target`, `callback_data`, `label`, unknown id all 400                                                                                                                                                                            |
| 6   | Remove (unplaced) ≠ disable; explicit row/column model                                                            | PASS        | tickets disabled stays in its row (`is-off`, absent from preview); help removed → pool and back; projection writes disabled and unplaced both `enabled:false` (§2.4)                                                                           |
| 7   | Legacy layouts produce an identical keyboard until publish                                                        | PASS        | §2.2 row 1; after Save draft A1 unchanged (§2.1); B1 legacy after A's publish; pre-Round-T pins `telegram-customer-turn`, `bot-runtime`, `bot-command-sync` unchanged since `25e717a` (`git diff --stat` empty) and green (§1)                 |
| 8   | Backward/rollback compatibility proven                                                                            | PASS        | §4 against the real `25e717a` registry; superseded flow §2.1                                                                                                                                                                                   |
| 9   | Targets closed, read-only, server-validated                                                                       | PASS        | Inspector shows `/wallet` as a badge, no input; §2.3 `target` 400                                                                                                                                                                              |
| 10  | Labels stay `bot.menu.*`, edited through the template mechanism                                                   | PASS        | 400 on a `label` field (§2.3); Inspector «ویرایش متن» opens the page's existing templates editor (`bot-buttons.tsx` `editLabel` over the `templates` query)                                                                                    |
| 11  | Renamed/default labels route; duplicate warnings; slash labels cannot steal commands                              | PASS        | §2.1 Routing; `routesFor` skips a label starting with `/` (`main-menu.ts:301-303`); `duplicateLabel`/`slashLabel` in the builder read (`bot-menu-builder.service.ts:583-586`); integration R-3 (§1)                                            |
| 12  | Styles closed enum; `default` omitted                                                                             | PASS        | wire: help (default) has no `style`; `secondary` → 400                                                                                                                                                                                         |
| 13  | Icons via Appearance; `iconSlot` documented; eligibility per SENDING bot                                          | PASS        | A1 icon, A2 none, same tenant/message (§2.1); audit §7 decision; Inspector eligibility list matches                                                                                                                                            |
| 14  | Definite rejection → one icon-less retry; uncertain → never resent                                                | PASS        | §2.2                                                                                                                                                                                                                                           |
| 15  | One structured descriptor in the shared transport, no fork                                                        | PASS        | `TelegramReplyKeyboardButton` + `replyKeyboardButtonMarkup` in `send-message.ts`; strings still map to `{text}`                                                                                                                                |
| 16  | Gates backend-authoritative; placed/enabled/hidden-now shown; no fake buttons                                     | PASS        | trial/referral «اکنون پنهان» in the editor, absent from preview and wire with gates closed; only-gated layout 400                                                                                                                              |
| 17  | Durable versioned draft; optimistic concurrency                                                                   | PASS        | draft survived reloads and sessions; stale version 409; two-session conflict banner (§2.1)                                                                                                                                                     |
| 18  | Runtime reads only Published                                                                                      | PASS        | after Save draft, and after Reset, customers kept the published keyboard (§2.1)                                                                                                                                                                |
| 19  | Atomic publish, projection consistent                                                                             | PASS        | `projection_setting_version = setting version` after each publish; one `SettingChanged` per publish; refused superseded publish left the setting version unchanged (§2.4)                                                                      |
| 20  | Revisions append-only (id, tenant, snapshot, actor, timestamp, restoredFrom); retention                           | PASS        | trigger refusals, actor and `restored_from` columns (§2.4); retention = tenant life, `docs/open-questions.md` OQ-T-3                                                                                                                           |
| 21  | Restore → draft → publish = new revision; Reset → draft (confirmed); default from registry                        | PASS        | rev 3 from rev 1, rev 4 from rev 3; reset dialog + Cancel no-op; API reset without `confirm` 400; reset rows = registry default                                                                                                                |
| 22  | `/bot-buttons`: pool, phone canvas DnD, Inspector (label, enabled, style, icon, target, gate, warnings, advanced) | PASS        | `m-builder-selected-*`: all Inspector sections incl. gate note and «پیشرفته» disclosure                                                                                                                                                        |
| 23  | Save/Publish/Reset/History; states Saved/Unsaved/Differs/Publishing/Published/Conflict/Invalid; unsaved guard     | PASS        | observed `not_saved`, `unsaved`, `differs`, `published`, `conflict`, `invalid` (§2.1); guard dialog. `saving`/`publishing` only transiently (not asserted). INFO: right after a restore the badge read `published` for one read before refetch |
| 24  | Non-drag accessible fallback; touch works                                                                         | **PARTIAL** | keyboard and Inspector fallbacks fully work (§2.1). Touch: a **row** drag completes at 390; a **key** drag does not start in Chromium touch emulation — QA-2                                                                                   |
| 25  | Responsive 1440/900/390, light+dark, RTL; no fake emoji art; customer vs editor preview                           | PASS        | §3 (30 matrix shots, 0 overflow, 0 console errors); `03-customer-preview`; three modes edit/customer/live                                                                                                                                      |
| 26  | `settings.view` / `settings.edit`; template edit keeps its permission                                             | PASS        | integration H-2 "lets settings.view read and refuses every write without settings.edit" (§1); not re-driven in the browser (QA had only an owner account)                                                                                      |
| 27  | Audit draft saved / published / reset / restored, not drags                                                       | PASS        | §2.4                                                                                                                                                                                                                                           |
| 28  | Tenant and BotInstance isolation                                                                                  | PASS        | B1 (tenant B) legacy while A published; A2 no icon while A1 iconed (§2.1); foreign revision 404 (§2.3); integration (§1)                                                                                                                       |
| 29  | Mutation/falsification tests for critical invariants                                                              | **PARTIAL** | T1/T2/T3 rows + T4 M01–M22 with F-1/F-4/F-5 closed in §10 (`check:citations` 2 530 resolve). QA did not re-run mutation. Not covered by any test: touch retargeting (QA-2)                                                                     |
| 30  | Process: one Codex review per PR, exact-head CI green, no tag/release/deploy; acceptance checklist                | **FAIL**    | one Codex review each on #133/#134/#135, **none recorded on #137** (QA-INFO-3); PR-head CI green; **release `v0.4.0` published on `f9be46f1`** (QA-1); checklist written: `docs/round-t-telegram-acceptance.md`, not run                       |

Item 25 was PARTIAL in T4 for want of a visual pass; QA's pass makes it PASS, except the touch
part of item 24 and R-ACC-9 on real devices.

## 6. "Do NOT" list

| #     | Do not …                                                                             | Verdict  | Evidence                                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DN-1  | build a parallel engine, registry, labels, router or preview                         | PASS     | DoD 1, 10, 11                                                                                                                                                                          |
| DN-2  | allow arbitrary targets, callbacks, URLs or commands                                 | PASS     | §2.3                                                                                                                                                                                   |
| DN-3  | add Mini App / `web_app` / `login_url` / `request_*` / `switch_inline*` fields       | PASS     | `git diff 25e717a..67579a8` (excluding docs and the drizzle snapshot): zero added lines with these names; one added `callback_data` is a test fixture for inline buttons winning (R-6) |
| DN-4  | duplicate `bot.menu.*` label strings                                                 | PASS     | labels come from the template read; `label` field refused (§2.3)                                                                                                                       |
| DN-5  | keep history in the browser only                                                     | PASS     | `main_menu_revisions`, server-side, append-only (§2.4)                                                                                                                                 |
| DN-6  | remove the old compatibility path (`bot.main_menu`, `GET /bot-menu`, sync, commands) | PASS     | projection written on every publish (§2.4); sync and commands cards render on `/bot-buttons`                                                                                           |
| DN-7  | resend on an uncertain outcome                                                       | PASS     | §2.2                                                                                                                                                                                   |
| DN-8  | break the older binary                                                               | PASS     | §4                                                                                                                                                                                     |
| DN-9  | draw fake buttons or fake premium emoji                                              | PASS     | gated keys hidden in preview and on the wire; icon drawn as fallback in a dashed box with legend (§3)                                                                                  |
| DN-10 | audit drags                                                                          | PASS     | §2.4                                                                                                                                                                                   |
| DN-11 | run a second Codex review on a PR                                                    | PASS     | `get_reviews`: exactly one `chatgpt-codex-connector` review on #133, #134, #135; none on #137                                                                                          |
| DN-12 | tag, release or deploy                                                               | **FAIL** | QA-1                                                                                                                                                                                   |
| DN-13 | touch reseller, AI Support or Virtual Services                                       | PASS     | `git diff --name-only 25e717a..67579a8`: no such path                                                                                                                                  |
| DN-14 | decide gates in the web                                                              | PASS     | the page shows the server's `gateOpen`; preview/wire agree (§2.1)                                                                                                                      |
| DN-15 | send `default` or an undeclared style; send an icon for an unproven bot              | PASS     | §2.1 wire; §2.3                                                                                                                                                                        |

## 7. Defects and findings

**Follow-up status (2026-10-02, owner order — `docs/round-t-button-builder-audit.md` §16.3):**
QA-3 obsolete (the button icon is retired); QA-4, QA-5 and QA-6 fixed with tests; QA-2's grip
rebuilt as a 34 × 44 px button (the fix direction below), its real-phone check still R-ACC-9;
F-8 (the "new" badge) still unreachable, its obligation unchanged under OQ-T-2.

### QA-1 — MEDIUM (process; owner decision) — a release contains Round T before the T4 fixes

- **Evidence.** `git ls-remote --tags origin`: `v0.4.0` → `f9be46f1` (merge of PR #135),
  lightweight tag. GitHub release "v0.4.0 — Campaigns, Web Admin Redesign, FX & Telegram Button
  Builder", published 2026-10-02T06:42:43Z by the owner's account; the `Release` workflow ran
  on that tag and succeeded. `docs/round-t-final-review.md` §3 row 30 says "No tag contains a
  Round T commit"; at `67579a83`, `git tag --contains 5070a21a` prints `v0.4.0`.
- **Why it matters.** The round's rule is "No tag/release/deploy". If the owner cut it
  deliberately, DN-12 is a recorded owner exception; if not, the rule was broken. Either way
  the release lacks PR #137: F-2 (superseded publish-dialog wording), F-3 (banner/runbook
  procedure), F-4 (one eligibility predicate), F-6 (system scope fails closed) and the F-1
  test. A staging or production running `v0.4.0` will not match the acceptance checklist's
  R-ACC-5 wording.
- **Owner.** Owner: confirm or retract the release; if kept, cut the next one from
  `67579a83` or later before R-ACC runs.

### QA-2 — MEDIUM — touch drag of a single key does not start in Chromium

- **Repro.** Chromium 141.0.7390.37 (Playwright 1.56, `/opt/pw-browsers/chromium-1194`), any width,
  context with `hasTouch`. `Input.dispatchTouchEvent` `touchStart` at the centre of
  `[data-chip="<id>"] .bb-grip` (radius 0.5 px), then `touchMove`s. Script:
  `scratchpad/qa/s9.mts`.
- **Observed.** `document.elementsFromPoint` at that point returns the grip's SVG, then
  `.bb-grip`; but the `pointerdown` is delivered to the neighbouring `.bb-chip-main` button
  (`touch:bb-chip-main`), followed by `pointercancel` — Chromium's touch adjustment moves the
  touch to the nearest activatable element. No drag starts, no gap appears, nothing moves.
  The same point with a mouse hits `.bb-grip` and drags. A **row** grip is not retargeted and
  a touch row-drag completed (`s10.mts`: row 3 → top; `30-touch-row-drag-midway-390-light.png`).
- **Impact.** On Android Chrome a key probably cannot be dragged by finger; the Inspector's
  move buttons and the keyboard still work, so nothing is lost, but DoD 24's "touch works" is
  only partly met. Emulation is not a real device: R-ACC-9 records the real-phone answer.
  The web suite cannot see this (it fires synthetic jsdom pointer events,
  `tests/web/bot-buttons-builder.test.tsx:84-90`).
- **Fix direction (T3).** Make the grip a touch target Chromium will not move the touch away
  from — for example a focusable `role="button"` element with its own native `pointerdown`
  listener and a ≥ 32 px hit area — or start a key drag from a long-press on the key itself;
  then add a browser-level check (the web-shots harness already drives Chromium over CDP).

### QA-3 — LOW — icon and label emoji both drawn ("💰💰")

The default `bot.menu.wallet` text starts with 💰; with the `wallet` icon slot the builder's
previews, the publish dialog and the history drawer draw both (`m-publish-dialog-*`). The
Inspector warns (`bb-icon-doubled`) — the designed answer. Whether Telegram shows both is
R-ACC-2's extra check; the remedy is a label edit, not code.

### QA-4 — LOW — history names the publisher by an id prefix

The drawer prints «منتشرکننده: 01a0fc63» (the first 8 hex characters of
`createdByAdminId`, `history.tsx:32-34`) rather than the administrator's name, as the audit
log does. Readable only to someone who can map ids. T3.

### QA-5 — LOW (cosmetic) — the "live menu changed" banner squeezes at 390

With its action button beside it, the banner's text wraps into a column a few words wide
(`m-superseded-banners-390-light.png`). Stack the action under the text at narrow widths. T3.

### QA-6 — LOW (transient) — badge reads "Published" for a moment after a restore

Immediately after the restore request settled, `bb-state` read `published` while the API
already said `differsFromPublished: true`; a moment later it read `differs` and Publish was
enabled. A stale render between the mutation and the refetch; no wrong write is possible
(publish is version-checked). Not reproduced deterministically. T3.

### INFO

- **QA-INFO-1.** Nightly exhaustive orderings failed on `f9be46f1` by a 600 s timeout in the
  in-flight-send scenario (`tests/exhaustive/notification-orderings.test.ts:421`); Round T did
  not touch the notification code. Worth a look by whoever owns the nightly.
- **QA-INFO-2.** `check:shell` is skipped locally (no shellcheck); CI runs it.
- **QA-INFO-4.** Integration on a shared PostgreSQL server: `backup.test.ts` and `web-disaster-recovery.test.ts` assert cluster-wide properties, so they cannot be green while another worktree runs its own restores (CLAUDE.md, "agents that share PostgreSQL are serialised"). The full-run failure was a DROP of this run's own scratch that did not complete under that load; it did not reproduce alone. Worth re-running both files on an idle server before calling the suite green.
- **QA-INFO-3.** PR #137 has no Codex review object; a "no suggestions" 👍 reaction would not
  appear in `get_reviews`, so this is unverified, not a violation.

## 8. What QA did not do

- Real Telegram: impossible from here. `docs/round-t-telegram-acceptance.md` is the checklist.
  It was corrected after the Codex review of PR #138 (nine findings, all confirmed against the
  code): a baseline revision is now published first (R-ACC-0), because a never-published
  tenant has no revision to roll back to (and, found while fixing it, the page cannot save an
  unchanged seeded draft — `builder.tsx:206`, `:507-523` — so that save is a console request); every evidence query is scoped to the tenant; the
  forced-eligibility step changes and restores all three custom-emoji test columns together
  (`bot_instances_custom_emoji_test_shape_check`, reproduced on `nexa_qa_t`); `botctl` is used
  by version name (`update VERSION`, argument-less `rollback`); tap and refusal evidence comes
  from the Telegram client and the operator's own token-safe Bot API probe, since the
  application logs neither a customer's text nor Telegram's refusal sentence; R-ACC-8 is
  tests-only, because no real reply carries both markups; the prerequisites list every
  permission used; and the superseded 409 is checked by an authenticated request from the
  browser console, since the page disables Publish.
- A second administrator with `settings.view` only, in the browser: covered by integration
  H-2, not re-driven.
- Mutation testing: not re-run; T4's table and the committed falsification rows stand.
- T4's 161 616-layout rollback generator: not re-run; §4 parses the values this session stored.
