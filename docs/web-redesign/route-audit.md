# Web Admin — route-by-route UX audit (roadmap B1, B2, B3, B4, B7)

Workstream B of the parallel roadmap (items 2–7), agent 2a, branch
`roadmap/web-route-polish`, with the shared-kit changes on `roadmap/web-foundation`
(PR #235). This is polish on the existing design system: no page was rewritten, no
route, permission, contract or backend semantic changed.

What this document is:

1. **How every route was audited** (§1), and the legend for the checklist.
2. **Cross-cutting findings and what was done about each** (§2) — the fixes that reach
   every page through the kit, the router or the mutation helpers.
3. **The per-route checklist** (§3) — every route in `ROUTE_PATTERNS`, against the
   fifteen criteria the brief names.
4. **Responsive evidence** (§4) — `pnpm web:responsive`, real Chromium, touch emulated.
5. **Deferred, with the reason** (§5).

Ownership limits stated up front: `/users/:id` (customer 360) and `/` (dashboard) are
agent 2b's; broadcast and campaign pages are agent 3's; payments and reconciliation pages
are agent 5's; `/support-ai` and the support-AI pages are agent 1a's. On those pages this
audit records findings and makes no change (the lead's instruction), except where a
cross-cutting kit fix reaches them by itself.

---

## 1. Method

Each route was audited three ways:

- **Reading the page** against the criteria: which kit states it draws
  (`StateSwitch`/`queryState`, `EmptyState`, `ErrorState`, `PermissionDeniedState`),
  how its writes are built (`useMutation`, `useSubmissionKey`, `isPending`, 409
  handling, toast/banner feedback), whether a form is guarded
  (`useUnsavedChanges`, `useConfirmedClose`, `useDiscardGuard`), whether a destructive
  action asks first (`ConfirmDialog`, a typed phrase, a danger modal), and where its
  filters live (URL via `setQuery`/`setQueries`/`ListSearchBox`, or component state).
- **Measuring it in a real browser**: `pnpm web:responsive` (§4) on a 390×844 phone and
  an 820×1180 tablet with touch emulated, against the production build, the production
  CSP and the committed fixtures.
- **Running its existing web tests**, plus the new ones named in §2.

Legend for §3:

| Mark | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| ✓    | Meets the criterion as built; pinned by an existing test or measured |
| F    | Fixed in this workstream (§2 names the commit and the test)          |
| D    | Deferred (§5 says why)                                               |
| —    | Not applicable (the route has no such thing: no form, no filter, …)  |
| (o)  | Owned by another agent; recorded, not changed here                   |

Columns of §3, in the brief's order:

- **Mob** mobile/narrow and tablet (§4 measurement), **RTL** logical properties and
  technical values LTR;
- **States** loading · empty · error · denied (one mark when all four hold);
- **Act** action hierarchy and destructive clarity; **Save** save state and feedback;
  **Dirty** unsaved-changes protection;
- **Kbd** keyboard and focus (dialogs trap, Escape closes, focus returns);
  **Back** Back/Forward and the breadcrumb;
- **Filt** filter/search persistence (URL); **Fresh** data freshness;
- **Prim** primary-action accessibility (reachable, labelled, ≥44px on touch, disabled
  while pending).

---

## 2. Cross-cutting findings, and what was done

Each row names the commit (on `roadmap/web-foundation` unless marked RP for
`roadmap/web-route-polish`), the test that pins it, and its mutation ids in
`scripts/mutate-web-route-polish.py`.

| #   | Finding                                                                                                                                                                                                                                                              | Fix                                                                                                                                                                                            | Pinned by                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| X1  | **Idempotency key minted inside `mutationFn`** on recovery's «تهیه بکاپ جدید», the restore confirmation, and the recovery-kit import and key removal: the client's automatic 5xx retry re-ran it with a FRESH key, so a lost answer could start a second backup run. | Every page holds its key in `useSubmissionKey` (settle on success, settleOn on error). One named allowance (support-assist: a second press is a second draft by design).                       | `recovery.test.tsx` «the backup run key»; `mutation-consistency.test.tsx`; WRP-01..05 |
| X2  | **Keys minted per click** (backup schedule, knowledge build, knowledge proposal): a re-press after an unanswered failure was a second command.                                                                                                                       | Same: `useSubmissionKey`. Per-row keys on the backup schedule (review N5); a per-File token on the kit import (a different file with the same name/size/date is a new command).                | `recovery.test.tsx`; WRP-23                                                           |
| X3  | **A constant-payload "run now" key held forever** after an unanswered failure: a press an hour later replayed the old run.                                                                                                                                           | `useSubmissionKey({ heldForMs })`, `RUN_KEY_HELD_MS` = 3 min on the backup run and the knowledge build.                                                                                        | `submission-key.test.tsx`; WRP-24                                                     |
| X4  | **409 with no refresh** on the incident action and edit modals: every further press was refused the same way. And, found in review, refreshing the version under an edit form whose FIELDS stayed stale would let the next Save revert another operator's change.    | `settleOn(error, { onConflict })`. The action modal awaits a re-read; the edit form sends the version its fields were based on and, on a 409, is refilled from the fresh incident and says so. | `incidents.test.tsx`; WRP-11..13, 16, 17                                              |
| X5  | **Focus traps answered together**: a dialog opened from a drawer closed both on one Escape; the drawer's trap stole Tab back. A hidden (by `[hidden]`, `inert`, CSS, a closed `<details>`) last control let Tab leave the dialog.                                    | A ranked trap stack (render order), `tabbable()` that skips unreachable controls, Escape already handled by a menu closes nothing else.                                                        | `kit.test.tsx` «focus traps»; WRP-06..10, 21, 22                                      |
| X6  | **Desk-sized controls on touch**: 32px buttons, 26px small buttons and chips, 28px small inputs, 20px switches, 30px rail links, 19px summaries, 22px row links.                                                                                                     | `@media (pointer: coarse) and (hover: none)`: control tokens 44px; kit, shell and own page files raise the rest; a 44px switch target; checkboxes 24px where the label sits apart.             | `web-touch-tokens.test.ts`; §4 measurement                                            |
| X7  | **An input nested in `.input-group` rendered 24px tall** on every width (`flex: 1` in a column).                                                                                                                                                                     | Only a direct child of the group grows.                                                                                                                                                        | §4 measurement (/settings)                                                            |
| X8  | **The breadcrumb back to a list dropped its filters and search.**                                                                                                                                                                                                    | `rememberedHref`: the crumb restores the list's last filters and search (never its cursor; forgotten at sign-in and sign-out).                                                                 | `router.test.tsx`, `shell-recovery.test.tsx`; WRP-14, 15, 18..20                      |
| X9  | **Lists of unknown age**: users, orders, services and tickets neither poll nor refetch on focus, and said nothing about when their rows were read.                                                                                                                   | RP: `ListFreshness` — «خوانده‌شده در …» and a refresh button (disabled while reading) in each list's page head.                                                                                | `list-polish.test.tsx`                                                                |
| X10 | **No one-press reset** on the users, orders and services lists (a search and two or three filters to undo by hand).                                                                                                                                                  | RP: `ClearFiltersButton`, drawn only while a filter is applied; clears every filter key and the cursor in one navigation.                                                                      | `list-polish.test.tsx`                                                                |
| X11 | **Search applied only on Enter** on orders and services, while /users searches as you type.                                                                                                                                                                          | RP: `autoApply` (debounced 400 ms, IME-safe) on both.                                                                                                                                          | `list-polish.test.tsx`                                                                |
| X12 | **An irreversible delete without a question**: «حذف بنر» on /referrals removed the uploaded banner at one click; and its clear shared a key holder with the upload.                                                                                                  | RP: `ConfirmDialog` first; a separate key holder.                                                                                                                                              | `list-polish.test.tsx`                                                                |
| X14 | **Text tokens under WCAG AA**: `--fg-3` read 3.45–4.21 (dark) and 2.78–3.06 (light); light `--ok`/`--warn` 3.26; light `--accent`/`--danger` ~4.2 on the page background; white on the dark solid danger fill 3.11.                                                  | RP: AA values for those tokens and a new `--on-danger`; hierarchy kept. Approved by the lead as a visible palette change.                                                                      | `web-token-contrast.test.ts`; WRP-30..32                                              |
| X13 | **Pause / resume / retry-failed** on a broadcast and **pause / resume / launch** on a campaign are not disabled while their write is pending.                                                                                                                        | Handed to agent 3 by the lead (those pages are being reworked); they will use `useSubmissionKey` / `settleOn`.                                                                                 | — (o)                                                                                 |

Rules confirmed already correct (pinned by existing tests, nothing changed):

- `messageFor`/`errorCopy` never blame the connection for a server answer; a refused query
  hides the toolbar that would re-ask (`mayRequest`).
- Every list is keyset; a cursor trail is keyed by the filter it was minted under
  (users, orders, tickets, products, referrals, trials…), or the cursor is cleared with the
  filter in the same `setQueries` (services, payments).
- Leave guard: `useUnsavedChanges` on every editor that keeps a draft (38 pages), with
  `LeaveGuardHost` asking on in-app navigation and Back/Forward; `useConfirmedClose` on
  drawers and dialogs whose close would drop typing.
- The account page's keyless security writes (`changeOwnPassword`, TOTP) are `retry: false`,
  so the automatic retry cannot re-send a password change that already committed.
- Technical values (ids, usernames, URLs, digests, amounts' digits in code) are `Ltr`;
  quantities keep Persian digits through `Num`/`Quantity` (consistency.md §2).

---

## 3. Per-route checklist

`Mob` is the §4 result on phone and tablet after the fixes. Where a cell is not ✓ the
note says why.

| Route                       | Mob | RTL | States | Act | Save | Dirty | Kbd | Back | Filt | Fresh | Prim | Notes                                                                                      |
| --------------------------- | --- | --- | ------ | --- | ---- | ----- | --- | ---- | ---- | ----- | ---- | ------------------------------------------------------------------------------------------ |
| `/` (o)                     | ✓   | ✓   | ✓      | ✓   | —    | —     | ✓   | ✓    | ✓    | ✓     | ✓    | Agent 2b. Polls; period in URL.                                                            |
| `/account`                  | ✓\* | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    | \*security reads unfixtured in the shots registry. Keyless auth writes are `retry: false`. |
| `/users`                    | ✓   | ✓   | ✓      | ✓   | —    | —     | ✓   | F    | ✓ F  | F     | ✓    | Debounced search; status/tag in URL; X8, X9, X10.                                          |
| `/users/:id` (o)            | D   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | F    | ✓    | —     | ✓    | Agent 2b. Section links 29px on touch (§5).                                                |
| `/trials`                   | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    |                                                                                            |
| `/products`                 | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | ✓    | —     | ✓    | Deactivate is one click: reversible, with the "changes only future sales" note (kept).     |
| `/products/:id`             | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | F    | —    | —     | ✓    |                                                                                            |
| `/product-categories`       | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    |                                                                                            |
| `/extra-devices`            | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    |                                                                                            |
| `/service-locations`        | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    |                                                                                            |
| `/orders`                   | ✓   | ✓   | ✓      | —   | —    | —     | ✓   | F    | ✓ F  | F     | ✓    | X8–X11.                                                                                    |
| `/orders/:id`               | ✓\* | ✓   | ✓      | ✓   | ✓    | —     | ✓   | F    | —    | —     | ✓    | \*placement read unfixtured. Row links 44px on touch (F).                                  |
| `/services`                 | ✓   | ✓   | ✓      | ✓   | ✓    | —     | ✓   | F    | ✓ F  | F     | ✓    | Polls the refund queue; X8–X11.                                                            |
| `/services/:id`             | ✓\* | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | F    | —    | —     | ✓    | \*location targets unfixtured. Delete is a typed-confirmation modal.                       |
| `/broadcasts` (o)           | ✓   | ✓   | ✓      | ✓   | ✓    | —     | ✓   | ✓    | ✓    | ✓     | ✓    | Agent 3. No server-side search exists (§5).                                                |
| `/broadcasts/new` (o)       | D   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | F    | —    | —     | ✓    | Agent 3. Audience segments 38px on touch (§5).                                             |
| `/broadcasts/:id` (o)       | D   | ✓   | ✓      | X13 | ✓    | ✓     | ✓   | F    | —    | ✓     | X13  | Agent 3.                                                                                   |
| `/bulk-operations`          | ✓   | ✓   | ✓      | ✓   | —    | —     | ✓   | ✓    | ✓    | ✓     | ✓    | Polls running operations.                                                                  |
| `/bulk-operations/new`      | D   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | F    | —    | —     | ✓    | Shares the audience builder (§5).                                                          |
| `/bulk-operations/:id`      | ✓   | ✓   | ✓      | ✓   | ✓    | —     | ✓   | F    | —    | ✓     | ✓    |                                                                                            |
| `/tickets`                  | ✓   | ✓   | ✓      | ✓   | —    | —     | ✓   | ✓    | ✓    | F     | ✓    | Already had a one-press clear. X9.                                                         |
| `/tickets/:id`              | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | F    | —    | —     | ✓    |                                                                                            |
| `/business-chats` (+`:id`)  | ✓\* | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | ✓    | ✓     | ✓    | \*reads unfixtured (support-AI area, agent 1a).                                            |
| `/support-ai` (o)           | ✓\* | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    | Agent 1a.                                                                                  |
| `/support-analytics`        | ✓\* | ✓   | ✓      | —   | —    | —     | ✓   | ✓    | ✓    | ✓     | —    | Range in URL.                                                                              |
| `/support-knowledge`        | ✓\* | ✓   | ✓      | ✓   | ✓    | —     | ✓   | ✓    | —    | —     | ✓    | Proposal key fixed (X2).                                                                   |
| `/support-learning`         | ✓\* | ✓   | ✓      | ✓   | ✓    | —     | ✓   | F    | —    | —     | ✓    |                                                                                            |
| `/knowledge-build`          | ✓\* | ✓   | ✓      | ✓   | ✓    | —     | ✓   | F    | —    | —     | ✓    | X2, X3.                                                                                    |
| `/payments` (o)             | ✓\* | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | ✓    | D     | ✓    | Agent 5. Attention counts unfixtured. Freshness left to agent 5 (§5).                      |
| `/payments/:id` (o)         | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | F    | —    | ✓     | ✓    | Agent 5.                                                                                   |
| `/compensations`            | ✓   | ✓   | ✓      | —   | —    | —     | ✓   | ✓    | ✓    | —     | —    | Read-only.                                                                                 |
| `/payment-accounts` (o)     | D   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    | Agent 5. Queue links 22px on touch (§5).                                                   |
| `/payment-gateways` (+`:p`) | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | F    | —    | ✓     | ✓    | Row links 44px on touch (F).                                                               |
| `/bots`                     | ✓   | ✓   | ✓      | ✓   | ✓    | —     | ✓   | ✓    | —    | —     | ✓    |                                                                                            |
| `/discounts`                | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    | Deactivate one click, reversible (kept).                                                   |
| `/campaigns` (o)            | ✓   | ✓   | ✓      | ✓   | ✓    | —     | ✓   | ✓    | ✓    | —     | ✓    | Agent 3. State filter in URL; no server search (§5).                                       |
| `/campaigns/new` (o)        | D   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | F    | —    | —     | ✓    | Agent 3. Audience builder (§5).                                                            |
| `/campaigns/:id` (o)        | ✓   | ✓   | ✓      | X13 | ✓    | ✓     | ✓   | F    | —    | —     | X13  | Agent 3.                                                                                   |
| `/custom-service`           | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    | Switches 44px on touch (F).                                                                |
| `/referrals`                | ✓   | ✓   | ✓      | F   | ✓    | —     | ✓   | ✓    | ✓    | —     | ✓    | X12.                                                                                       |
| `/resellers`                | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | ✓    | —     | ✓    |                                                                                            |
| `/reseller-tiers`           | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    |                                                                                            |
| `/reseller-plans`           | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | ✓    | —     | ✓    |                                                                                            |
| `/reports`                  | ✓   | ✓   | ✓      | —   | —    | —     | ✓   | ✓    | ✓    | ✓     | —    | Table links 44px on touch (F).                                                             |
| `/panels`                   | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | ✓    | ✓     | ✓    | Polls health.                                                                              |
| `/panels/new`               | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | F    | —    | —     | ✓    |                                                                                            |
| `/panels/:id`               | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | F    | —    | ✓     | ✓    | Tabs in `?tab=`; checkboxes 24px on touch (F).                                             |
| `/panel-health`             | ✓\* | ✓   | ✓      | ✓   | ✓    | —     | ✓   | ✓    | —    | ✓     | ✓    | \*read unfixtured.                                                                         |
| `/providers`                | ✓   | ✓   | ✓      | —   | —    | —     | ✓   | ✓    | —    | —     | —    | Read-only.                                                                                 |
| `/settings`                 | F   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    | X7 (24px inputs), section nav 44px on touch.                                               |
| `/support`                  | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    |                                                                                            |
| `/terms`                    | ✓\* | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    | \*read unfixtured.                                                                         |
| `/client-apps`              | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    | One-word «حذف» 44px wide on touch (F).                                                     |
| `/features`                 | ✓   | ✓   | ✓      | ✓   | ✓    | —     | ✓   | ✓    | —    | —     | ✓    | Switches 44px on touch (F); each flip asks.                                                |
| `/reminders`                | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    |                                                                                            |
| `/bot-buttons`              | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    | Chips and drag grips 44px on touch (F).                                                    |
| `/content`                  | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    | Category chips 44px on touch (F).                                                          |
| `/audit-log`                | ✓   | ✓   | ✓      | —   | —    | —     | ✓   | ✓    | ✓    | ✓     | —    | Filters in URL; invalidated after every write.                                             |
| `/alerts`                   | ✓   | ✓   | ✓      | ✓   | ✓    | —     | ✓   | ✓    | ✓    | ✓     | ✓    | Polls.                                                                                     |
| `/notifications`            | ✓   | ✓   | ✓      | ✓   | ✓    | —     | ✓   | ✓    | —    | ✓     | ✓    | Key buttons 44px on touch (F).                                                             |
| `/notification-center`      | ✓   | ✓   | ✓      | ✓   | ✓    | —     | ✓   | ✓    | —    | ✓     | ✓    | Mark-read writes carry no key by contract (idempotent by nature).                          |
| `/incidents` (+`:id`)       | ✓   | ✓   | ✓      | ✓   | F    | —     | ✓   | F    | —    | ✓     | ✓    | X4.                                                                                        |
| `/appearance`               | ✓\* | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    | \*QR preview unfixtured. Switches 44px on touch (F).                                       |
| `/ops-group`                | ✓   | ✓   | ✓      | ✓   | ✓    | —     | ✓   | ✓    | —    | ✓     | ✓    |                                                                                            |
| `/recovery`                 | ✓   | ✓   | ✓      | ✓   | F    | —     | ✓   | ✓    | ✓    | ✓     | ✓    | X1–X3; restore is a typed phrase bound to a checksum.                                      |
| `/system`                   | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | ✓    | ✓     | ✓    |                                                                                            |
| `/roles` (inside `/system`) | ✓   | ✓   | ✓      | ✓   | ✓    | ✓     | ✓   | ✓    | —    | —     | ✓    |                                                                                            |

`✓*` — the route was measured with the shell and its controls, but one or more of its own
reads has no fixture in `tests/web/shots/fixtures/`, so the page body drawn was the kit's
error state. That page's body was therefore audited by reading (and by its web tests), not
measured. §5 lists the fixtures to add.

---

## 4. Responsive evidence (B2)

`pnpm web:responsive` (`scripts/web-shots/responsive.mjs`, policy in
`responsive-policy.mjs`, unit-tested in `tests/unit/web-responsive-policy.test.ts`).

What it does: serves the production build of `apps/web` with the production CSP and the
committed fixtures (the `pnpm web:shots` harness, now `harness.mjs`), opens every route in
`ROUTE_PATTERNS` in headless Chromium at **390×844 (phone)** and **820×1180 (tablet)** with
**touch emulated** — the page sees a coarse pointer that cannot hover, as the device
reports it — and fails a measurement for:

- any sideways scroll of the page;
- any visible control under 44×44 (inline links in running text exempt; a checkbox whose
  label sits apart held to 24px);
- any control cut off at the viewport edge outside a scrolling container;
- in the scenarios, a state not reached, or a dialog that does not fit the viewport or
  hides its actions.

Scenarios clicked as an operator would: the phone navigation drawer; the phone accordion
opening another group; the tablet rail opening as a drawer; the command search dialog; a
modal (customer tags); the account menu; detail-page tabs; a list filter chip; the tablet
ticket filters.

How to reproduce:

```bash
pnpm web:responsive                                 # every route, phone and tablet
pnpm web:responsive /users /orders --device phone  # a subset
pnpm web:responsive --scenarios-only --no-build
```

PNGs and `report.json` go to `.web-shots/responsive/` (git-ignored). Not in `pnpm verify`
or CI: it needs a Chromium binary, like `pnpm web:shots`.

Results on this branch (captured locally; PNGs not committed):

| Run                                                                           | Measurements | Passed | What failed                                                                                                                                          |
| ----------------------------------------------------------------------------- | ------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before (base styles; the first run, on `/users`, `/orders` and the scenarios) | 13           | 0      | Every one: 26–32px controls (topbar, chips, small inputs and buttons), 30px rail links on the tablet, plus unfixtured reads.                         |
| After                                                                         | 147          | 104    | Only unfixtured reads (§5) and the controls on other agents' pages (§5): the audience builder (38px), `/payment-accounts` links, `/users/:id` links. |

Before the touch work, no page overflowed sideways at 390px either (the consistency
pass's own finding); the failures were all target size. After it, every route this agent
owns passes on phone and tablet once its reads are fixtured; the scenarios all reach their
state and every opened dialog fits the viewport with its actions visible.

Visual check of the touch layer: the switch keeps its look (a 44×26 track inside a 44px
target, its focus ring on the track), the topbar search collapses to a 44px square, and the
phone drawer's links were already 44px (the shell had that rule for the drawer only).

---

## 5. Deferred, and why

| Item                                                                                                                                                                                           | Why it is not done here                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Broadcast and campaign double-submit (X13), audience-builder segments 38px on touch                                                                                                            | Agent 3 is reworking those pages; the lead handed the fix to them (`useSubmissionKey` / `settleOn` are on the foundation).                                                                      |
| Search on `/broadcasts` and `/campaigns` (B4)                                                                                                                                                  | The list endpoints accept only a cursor (and a state, for campaigns). A search needs a contract and server change, which this polish workstream does not make; agent 3's scope.                 |
| `/payment-accounts` queue links 22px; a freshness control on `/payments`                                                                                                                       | Agent 5's pages.                                                                                                                                                                                |
| `/users/:id` section links 29px on touch                                                                                                                                                       | Agent 2b's page.                                                                                                                                                                                |
| Fixtures for the reads listed `✓*` in §3 (account security, order placement, service location targets, panel health, terms, incident detail, QR preview, the support-AI reads, business chats) | Each needs a schema-valid body; added only where this agent owns the page and the effort was small (tag catalogue, keys, audit log, incidents, inbox). The rest is a follow-up for each family. |
| `qr-template` save on a 409                                                                                                                                                                    | It sends the draft's own basis and asks the operator to discard to rebase — a deliberate design (the draft is a whole template); a refresh-and-retry here would be the X4 hazard again.         |
| Wide tables scrolling inside their card on a phone                                                                                                                                             | An owner design decision recorded in consistency.md §3; measured as reachable (inside a scroller), not changed.                                                                                 |
| Product / discount deactivate without a question                                                                                                                                               | Reversible in one click and explained in place; a confirmation would be a question with no stake.                                                                                               |
