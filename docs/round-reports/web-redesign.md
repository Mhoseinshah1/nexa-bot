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

## Handoff (next: session 2 = PR-2 + PR-3)

- Start from latest `main` (kit and PR-1 merged). Read the brief, `kit-v2.md`, this file.
- PR-2 `feat/web-redesign-overview-payments`, PR-3 `feat/web-redesign-support`. Money pages in PR-2 (payments, payment detail,
  compensations, gateways) need the Opus diff review of hook/permission/confirm/reason before merge.
- Patterns used by PR-1 to copy: `QuickAction` in `QuickActionBar`; a `Disclosure` for the «why disabled» fold (a kit test bans raw `<details>` in pages).
- Wait for the owner's go-ahead before starting (brief §3).
