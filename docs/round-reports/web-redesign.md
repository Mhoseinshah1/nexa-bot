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

## Handoff (next: session 4 = PR-6 + PR-7)

- Start from latest `main`. PR-6 `feat/web-redesign-resellers-bot` (resellers +detail, tiers, plans, bots, bot buttons, appearance, content,
  terms, client apps); PR-7 `feat/web-redesign-panels-settings` (panels +detail, panel health, providers, settings, features, ops group).
- Opus diff review for money actions: reseller credit, tier prices, reseller plans.
- Bot buttons: drag and drop only (`LayoutDnd`), keyboard reorder; Appearance QR drag/resize + `quietZoneModules`; panels/features rules in §2.5.
- Settings pages use the sticky save bar; time inputs `TimeField24`.
- Owner check list for PR-4/PR-5 is in the issue #358 comment.
