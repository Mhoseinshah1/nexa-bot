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

## Handoff (next: session 3 = PR-4 + PR-5)

- Start from latest `main`. PR-4 `feat/web-redesign-products` (products, categories, custom service, extra packages, locations, trials);
  PR-5 `feat/web-redesign-marketing` (discounts, campaigns +detail, broadcasts +detail, reminders, referrals, gift cards).
- Opus diff review needed where a page has a money action (discounts/gift cards if they move money — check).
- Time inputs (reminders, campaigns, trials) must use `TimeField24`.
- Owner check list for PR-2/PR-3 is in the issue #358 comment.
