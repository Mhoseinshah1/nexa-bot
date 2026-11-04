# v0.9.9 — phone state, charts, server step, customer and payment pages

Round NEXA-FIX-V099: the owner's test findings on v0.9.7. It ran right after the v0.9.8 round
(PR #402, merge `ce734563e`: compaction VACUUM without the 15 s statement timeout).
Five PRs against `Mhoseinshah1/nexa-bot`. All five are merged as merge commits, each with CI green
on the exact head. Per-PR detail is in each PR description.

## PRs (all merged, as merge commits)

| Order | PR   | Branch                                          | Merge       | Codex            |
| ----- | ---- | ----------------------------------------------- | ----------- | ---------------- |
| 1     | #403 | `fix/v099-phone-state-and-chart-draw`           | `39c9de364` | nothing found    |
| 2     | #404 | `fix/v099-iran-only-stores-number`              | `f9cded789` | 1 finding, fixed |
| 3     | #405 | `feat/v099-webadmin-customer-and-payment-pages` | `699770e61` | nothing found    |
| 4     | #406 | `feat/v099-server-step`                         | `79c03b93b` | nothing found    |
| 5     | #407 | `fix/v099-miniapp-layout`                       | `5424458e5` | 1 finding, fixed |

Migration: `0314_customer_phone_not_accepted` (#404 only).

## What changed

### #403 PR-1 — phone state and chart draw

- The account screen shows the real phone state, with icons from the Appearance slots:
  CUSTOMER_VERIFIED «✅ ثبت شده», ADMIN_VERIFIED «✅ تأیید توسط مدیر»,
  NOT_ACCEPTED «⚠️ ثبت شده، مجاز نیست», NONE «🔴 ارسال نشده است».
- Charts draw in. Root causes: `AreaSpark` (`.area-spark`) matched no rule; TrendChart's
  `polyline.trend-line` and `polygon.trend-area` had no rule; the `.dash-stack` rects had no rule;
  the line/spark dash trace finished half drawn, because Chrome measures a dash on a
  `non-scaling-stroke` in screen pixels.
- The fix: a `clip-path: inset()` trace of about 1 s, the area fades in after the line, bars rise in
  0.5 s, donut and stack segments fade in. All of it is inside `prefers-reduced-motion: no-preference`
  and plays once, because charts mount only with data.

### #404 PR-2 — IRAN_ONLY stores a foreign number

- Migration `0314_customer_phone_not_accepted`: a new `customers.phone_not_accepted_at` and a CHECK,
  added NOT VALID and then VALIDATEd.
- A non-+98 share under IRAN_ONLY is stored, not verified, and satisfies no gate.
- The bot gate shows `bot.phone.not_accepted` with no contact button. Nobody is blocked; support and
  /help pass.
- The gateway rule refuses with the same sentence. The code is still `PHONE_VERIFICATION_REQUIRED`
  and no money path changed.
- One predicate, `notAcceptedPhoneCounts` (ALL only), is read at read time by the gate, the route
  rule, the admin overview and the account screen. Switching to ALL makes the number count as
  verified; switching back undoes it.
- Mini app: a new gate kind PHONE_NOT_ACCEPTED and `/me.phoneNotAccepted`.
- Admin API: `phoneNotAccepted {number, masked, sharedAt, countsAsVerified}`.
- The lead wired the account screen's NOT_ACCEPTED (`fa36691c2`).
- Codex finding, fixed in `6abae7f88`: a first share stored as not accepted in mini app
  checkout/top-up returned PENDING. The poll now checks phoneNotAccepted.
- Mutation check: with the guard made to accept IRAN_ONLY, the integration tests went red (5/10) and
  the unit tests went red (2/4).

### #405 PR-5 — Web Admin customer and payment pages

- Payment detail: a summary header, one «وضعیت و اقدام» block (a callout only when `needsAction`), a
  two-column details grid with empty rows hidden, the customer once, receipts only for receipt
  methods or when one exists, and «بخش فنی» folded at the bottom.
- Customer page: a head with chips, a key-facts strip, and tabs «خلاصه», «سرویس‌ها»,
  «پرداخت‌ها و کیف پول», «تأیید و دسترسی», «تاریخچهٔ مدیر».
- «تأیید و دسترسی» is always visible. It holds the phone state, the «تأیید شماره توسط مدیر» switch
  (the existing PHONE_EXEMPT, renamed in the UI only), the channel exemption, and block/unblock.
- The lead's layout review found 3 defects, fixed in `d41f33c82`: at 360 px the sensitive-strip
  buttons overlapped; the refund table's action column was clipped; an empty «نام فایل» row was drawn.
- CI fixes: `71cf6c567` (the layout-review-fixes B6 test allows the action panel only the 760 px
  breakpoint, so the stacking rule moved into it); `265175215` (test-only: a timing race in
  `support-admin-ux` «clusters knowledge gaps». The helper stamped the escalation with the DB's
  now() while the message used the process clock; it now uses the message's own sent_at).

### #406 PR-3 — server step in the store

- The setting `sales.server_selection` is a boolean, default off.
- Servers are ACTIVE panels that are not drained and not archived, are in the eligible-panel view,
  and carry a visible product. The label is the panel's existing `name`. One server or none skips the
  step.
- A category is shown only when it has a plan on that server.
- Bot callbacks `cs:`, `cr:`, `cl:`, each at most 50 bytes.
- Mini app API: `GET /catalogue/servers` returns `{enabled, step, items, page, hasMore}`, and
  categories and products take an optional `serverId`.
- Renewals never ask for a server. Price, pre-invoice, payment and provisioning are unchanged; the
  plan is still `p:<id>`.
- No new wizard step, because that would need a migration.
- Mutation check: with the filter disabled, 6 of the 11 new tests went red.

### #407 PR-4 — mini app layout

- Home: the balance card one step smaller, with the amount on one line at 360 px and two equal
  buttons in their own row.
- Store: step by step, category → plan, or server → category → plan when `step` is true.
- Service cards: a toned status chip, a thicker usage bar, used/total and days left, and an ended
  service muted.
- Codex finding, fixed in `892862a22`: the service-figures row did not wrap, so an expired card's
  «پایان: …» could overflow a narrow phone. The row wraps again, and a layout test pins it.

## Decisions taken

- **One push branch.** The session could push only `claude/elegant-noether-g9v8x9`, because the git
  proxy refused other branch names. Every PR came from that branch, one after another. The local
  branch names follow the prompt.
- **Mirza e2e.** `tests/integration/mirza-one-time-import-e2e.test.ts` (TARGET_ACK_MISMATCH locally)
  passes on main CI: shard 3/10, 8/8, at both `f26cc25fd` and #402. It is a local-environment
  artefact (stale built packages), not a bug, so no PR was opened.
- **Admin vs customer verification.** Nothing on the row tells an operator-recorded number from the
  customer's own, so only an exemption reads «تأیید توسط مدیر».
- **A verified customer keeps their number.** Their foreign share is refused as before and nothing
  is stored.
- **ALL is evaluated at read time.** No data migration, and it is reversible.
- **PR-3's mini app UI was built in PR-4.**
- **Stacking.** PR-4 was built from PR-3's head, and PR-5 from PR-2's head, to keep 2 implementers
  busy. Each merged main before its push.

## Not done / still to test (owner)

- The owner's v0.9.9 checklist, which lives in the #358 comment.
- The four untested items from v0.9.7: a real Stars payment, a late Stars payment, the usage chart /
  remaining, and the AI support handoff with `actions_enabled`.

## Usage

| Item                    | Count | Tier   |
| ----------------------- | ----: | ------ |
| PRs                     |     5 | merged |
| Implementers PR-2, PR-3 |     2 | Opus   |
| Implementers PR-1, 4, 5 |     3 | Sonnet |
| This report             |     1 | Sonnet |
| CI-log lookup           |     1 | Haiku  |

The lead made the small fixes itself: the Codex fix on #404, the CI fixes on #405, and the
NOT_ACCEPTED wiring.
