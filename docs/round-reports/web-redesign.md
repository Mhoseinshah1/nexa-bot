# Web Admin redesign — round report (append per session)

Program: `NEXA-WEB-REDESIGN` (owner brief). One session = at most two PRs.

## Session 1 — PR-0 + PR-1

- **PR-0 #426 — redesign kit** (merge 21eab5262): `PageHead` count chip + freshness + refresh; `QuickFilters`, `SelectionBar`,
  `QuickActionBar`/`QuickAction`, `AttentionStrip`, `KpiRow`, `CardRows`, settings sections/rows + `StickySaveBar`,
  `TimeField24` (Persian 24-hour), `LayoutDnd` (pointer + keyboard layout drag and drop). Codex P2 (focus after a
  keyboard move between rows) fixed in one commit with a test that fails without it. Docs: `docs/web-redesign/kit-v2.md`.
- **PR-1 #427 — customers, users, services, orders** (merge ec81a8d55): customer page (header card, grouped quick-action
  bar, attention strips, KPI row, CardRows, imported wallet history merged into the wallet table), users list, services
  list + detail, orders list + detail. Inventories: `docs/web-redesign/pr1-inventory-{a,b}.md`. Opus reviewed the money
  actions: hook, permission, confirm and reason unchanged. Codex clean. One CI re-run (Deployment smoke: apt failure while
  building the image, not this PR).
- Full `vitest --project web`: 3731 pass. `web:shots` for the six routes clean.

### Decisions taken

- Branches: the session could push `feat/web-redesign-kit` and `feat/web-redesign-customers` directly; PRs were opened one at a time.
- No count chips / chip counts where the API sends no server total (users, services, orders).
- Chip tones already had dark values in `tokens.css`; none added.
- `web:shots` needs a Chromium path: `NEXA_CHROMIUM=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`.
- Packages `@nexa/contracts` and `@nexa/i18n` must be built before tsc in a fresh worktree.

### Not done / open

- Demo's service-list usage column and order-detail cashback/payment-method KPIs: no API field, not drawn.
- Owner check on the test server before session 2: PR-0 and PR-1 pages in both themes and on a phone.

## Session 2 — PR-2 + PR-3

- **PR-2 #429 — overview + payments** (merge 64e76f2c4): dashboard, reports, payments list (queue chips with server counts, merged
  state/method cells, selection bar only when ticked), payment detail (header card, quick-action bar that only jumps to the
  existing receipt/reconcile/late/refund cards under their own permissions, attention strip, KPI row, CardRows), compensations,
  gateways. Opus money review: SAFE (hooks, permissions, confirms, reasons unchanged). Codex clean. Inventory: `pr2-inventory.md`.
- **PR-3 #430 — support group** (merge 60c28cb85): tickets, business chats + thread, support, support AI, knowledge, learning,
  knowledge build, analytics. Thread: own scroll box, 50 newest + «older», day separators, run grouping, inline handoffs, filters,
  search, jump button, composer gated on take-over. Codex P2 (window drops history while polling and scrolled up) fixed in one
  commit with a test that fails without it. Inventory: `pr3-inventory.md`.
- `vitest --project web`: 3738 (PR-2), 3753 (PR-3) pass; `web:shots` clean for all routes.

### Decisions taken

- No count chips where the API sends no server total. Thread paging and search are client-side over what `GET /business-chats/:id` returns.
- AI filter = OWN_ECHO/OFFLINE, operator filter = HUMAN/OTHER_BOT (an operator reply sent via NEXA is stored OWN_ECHO, so it shows under AI).
- Ticket close stays one-press (no confirm exists today). Support AI config form not converted to sticky-save sections (would touch form logic).
- Non-blocking: a gateway absent from the attention response shows queue count 0 (`payments.tsx` ~812, pre-existing).

## Session 3 — PR-4 + PR-5

- **PR-4 #432 — products group** (merge c4301f4d2): products (list + detail with action bar, attention strip, KPI row), categories,
  custom service, extra packages/devices, locations, trials. Row name opens the record; subtitles folded; chips with counts only
  where the list is complete (categories, locations, trial panels). Codex clean. Inventory: `pr4-inventory.md`.
- **PR-5 #433 — marketing group** (merge 02c53f7b0): discounts (tabs rules / cashback / preview), campaigns + detail, broadcasts + detail,
  reminders, referrals, gift cards. Campaign and reminder time inputs now `TimeField24` (same HH:MM value). Opus money review: SAFE
  (hooks, permissions, confirms, reasons unchanged). Codex P2 (reminders refresh re-read only settings, not flags) fixed in one commit
  with a test that fails without it. Inventory: `pr5-inventory.md`.
- `vitest --project web` 3763 pass (PR-5); `web:shots` clean for all routes of both PRs.
- CI: #432's Deployment update smoke failed on an apt failure building the image; re-run once, green.

### Decisions taken

- No count chips where the API sends no server total (products, extra packages, all marketing lists).
- Broadcast pause/resume/cancel stay in the report card with their own confirms (not moved to a head bar).
- Campaign detail on a finished campaign draws an empty «مدیریت کمپین» group (cosmetic, from `QuickActionBar`; sweep PR-9).

## Session 4 — PR-6 + PR-7

- **PR-6 #435 — resellers + bot group** (merge 2c5520196): resellers / tiers / plans (fold, status chips, name opens the drawer), bots, content, terms,
  client apps (form fields untouched), bot buttons on `LayoutDnd` only (main menu + service layout, max 3 per row, keyboard reorder, no move buttons),
  Appearance QR stage (drag + corner resize, `quietZoneModules` field). Opus money review of the reseller pages: SAFE. Codex P2 (read-only menu
  items must stay keyboard-selectable) fixed with a test. CI fix: falsification rows for the replaced chip drag retired (EXPECTED 2861 → 2854).
- **PR-7 #436 — panels, settings, features, ops group** (merge 15b2387fe): panels list (provider name only, health + error in one cell, no
  sideways scroll), panel detail (action bar, KPI row, RickPanel/custom read-only provider rules), panel health, providers, settings (collapsible
  sections + one sticky save bar over each row's own submit), features (own scroll panel), ops group (`TimeField24`). Opus review of the settings
  save bar and panel activation display: SAFE. Codex clean. Inventories: `pr6-inventory-{a,b}.md`, `pr7-inventory-{a,b}.md`.

### Decisions taken (session 4)

- No `/resellers/:id` route exists: the reseller «detail» is the existing standing drawer (`reseller-edit.tsx`, unchanged).
- Settings: an unchanged value can no longer be re-saved and Enter in a field no longer submits (the bar needs a real edit).
- Docs for sessions 4–6 are committed on the session branch and shipped in one docs PR at the end of session 6.

## Session 5 — PR-8 + PR-9

- **PR-8 #437 — system group** (merge 924429550): menu 6 → 3. «اعلان‌ها و هشدارها» (`/notification-center`; `/alerts` redirects; four chips, red strip,
  one row for an item that is both inbox and alert, bell drawer); «اعلان‌ها» → tab «گزارش ارسال‌ها» on «گروه لاگ»; «گزارش ممیزی» → tab «تاریخچهٔ تغییرات»
  on «سامانه» (permissions kept per tab); incidents open in a side drawer; system, bulk operations; recovery (kit import inside the unreadable-secrets
  card, archive-password label). Opus permission review: one real finding (two `/ops-log` polls without `pollUnlessFinal`), fixed with Codex's P2
  (older page waits for both feeds) in one commit. Inventories `pr8-inventory-{a,b,c}.md`.
- **PR-9 #438 — sweep** (merge 7b033b625): leftover subtitles, ~60 dead CSS classes and unused components removed, empty quick-action group fixed,
  shots over all 74 routes clean (five unfixtured GETs got fixtures), dark theme audited, English phrases translated. Codex: two CSS rules built from
  dynamic class names (avatar tints, sparkline size) restored.

### Decisions taken (session 5)

- **«رخدادها» bug not reproduced.** Every route into an incident loads `GET /incidents/:id` (200 for every listed incident, committed HTTP test
  `incidents-http`); the only API path that says «رخداد پیدا نشد» is a malformed list cursor, which the web never sends. No API change. The incident now
  opens in a drawer by its own id. Needs the owner's exact screen text and entry point if it still happens.
- No regression test exists for Codex's pagination P2 on the unified list (the page shows no rows while the alerts feed loads, so the pager is absent either
  way); the guard (`feedsReady`) is in place without a failing-without-it test.
- «هشدارهای ثبت‌شده» = the whole management history (no «not open» filter on the server).

## Handoff (next: session 6 = PR-10)

- Branches ready (not yet PR): `feat/web-redesign-followups-1` (support AI form), `-2` (business-chat history API, Opus), `-3` (list totals, Opus plan review done).
- Assemble into `feat/web-redesign-followups`, merge main, one PR, Codex, CI, merge.
