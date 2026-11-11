# Demo parity: final sweep (PR-5)

Date: 2026-11-11. Branch `chore/parity-final-sweep`, built on PR-4's head (every PR of the round merged: #459 to #464).

**Demo used: the OLDER `reference/approved-demo.html` (fallback).** The owner's `redesign-demo.html` was never delivered, so every tool run below compares the live app (served with the repo `demo-parity` fixture set) to the older hash-routed demo. Those totals are old-demo noise plus data differences and are NOT the fix list; the fix list is the owner's kit report (baseline section 1: 477 differences after KEEP on 44 routes). Section 2 re-checks every one of those items against the CURRENT app. Once `redesign-demo.html` exists, run `pnpm web:demo-diff` again; that run replaces this file.

## 1. Tool runs (fallback demo) against the baseline

| Combination | Before KEEP | Suppressed by KEEP | Remaining | Baseline remaining | Change |
| ----------- | ----------- | ------------------ | --------- | ------------------ | ------ |
| light 1440  | 2491        | 434                | 2057      | 2102               | -45    |
| dark 1440   | 2491        | 434                | 2057      | 2102               | -45    |
| light 390   | 2799        | 436                | 2363      | 2346               | +17    |
| dark 390    | 2799        | 436                | 2363      | 2346               | +17    |

No route failed in any run (failed 0). The 390 totals rose slightly: the pages now carry the demo's boxes, columns and menus, and at 390 the old demo shows fewer of them, so the old-demo comparison is not meaningful as a regression signal in either direction. The totals stay in the thousands because of noise that cannot be fixed against the old demo: the «دادهٔ نمونه» badge in every title, the demo-only «رخداد قطعی پنل…/جزئیات» banner, detail routes the old demo has no URL for, and tab-label digits.

## 2. Owner's kit report re-checked (44 routes, 477 differences)

Method: each ONLY-DEMO / ONLY-APP item of the kit report was looked up in the app side of the light 1440 run's `sig.json` (same route and field, digits normalised as the tool does). ONLY-DEMO present in the app, or ONLY-APP gone from it, means FIXED. Because the live side uses fixture data, this proves the element exists, not that the owner's data renders identically. Reasons come from the PR "Not done" lists (#459, #460, #462, #464; #461 and #463 carry no «Not done» list).

Statuses: FIXED = matches the demo now; KEEP = on the owner's KEEP list; NOT DONE = still differs, with its reason; UNVERIFIED = cannot be checked from fixtures.

| Route                  | Kit | FIXED | KEEP | NOT DONE | UNVERIFIED | Reason (KEEP / NOT DONE / UNVERIFIED)                                                                                                                                          |
| ---------------------- | --- | ----- | ---- | -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/bot-buttons`         | 10  | 2     | 0    | 0        | 8          | demo menu-preview buttons carry the owner's menu data; fixture menu differs and preview items are not buttons in the fallback DOM                                              |
| `/bots`                | 3   | 3     | 0    | 0        | 0          |                                                                                                                                                                                |
| `/broadcasts`          | 1   | 1     | 0    | 0        | 0          |                                                                                                                                                                                |
| `/business-chats`      | 12  | 12    | 0    | 0        | 0          |                                                                                                                                                                                |
| `/campaigns`           | 17  | 17    | 0    | 0        | 0          |                                                                                                                                                                                |
| `/content`             | 2   | 1     | 0    | 1        | 0          | one table per template: app keeps its editor list (PR-4)                                                                                                                       |
| `/custom-service`      | 12  | 12    | 0    | 0        | 0          |                                                                                                                                                                                |
| `/discounts`           | 21  | 21    | 0    | 0        | 0          |                                                                                                                                                                                |
| `/extra-devices`       | 6   | 0     | 0    | 6        | 0          | rows open edit from the name button, no «ویرایش» (not handled by any PR)                                                                                                       |
| `/features`            | 29  | 29    | 0    | 0        | 0          |                                                                                                                                                                                |
| `/gift-cards`          | 1   | 1     | 0    | 0        | 0          |                                                                                                                                                                                |
| `/notification-center` | 5   | 4     | 0    | 1        | 0          | demo button is a chip inside the panel (PR-2 expected leftover)                                                                                                                |
| `/orders`              | 21  | 21    | 0    | 0        | 0          |                                                                                                                                                                                |
| `/panels`              | 2   | 2     | 0    | 0        | 0          |                                                                                                                                                                                |
| `/payment-gateways`    | 2   | 2     | 0    | 0        | 0          |                                                                                                                                                                                |
| `/payments`            | 27  | 27    | 0    | 0        | 0          |                                                                                                                                                                                |
| `/product-categories`  | 16  | 16    | 0    | 0        | 0          |                                                                                                                                                                                |
| `/products`            | 5   | 5     | 0    | 0        | 0          |                                                                                                                                                                                |
| `/recovery`            | 3   | 0     | 0    | 3        | 0          | per-invoice result card removed on purpose by owner (f9ec6f869); no API (PR-4)                                                                                                 |
| `/referrals`           | 17  | 17    | 0    | 0        | 0          |                                                                                                                                                                                |
| `/reminders`           | 1   | 1     | 0    | 0        | 0          |                                                                                                                                                                                |
| `/reports`             | 7   | 0     | 7    | 0        | 0          | dashboard range chips (post-demo, owner KEEP list)                                                                                                                             |
| `/reseller-plans`      | 5   | 1     | 0    | 4        | 0          | tier-name buttons still rendered in rows (PR-4 ~14 leftovers)                                                                                                                  |
| `/reseller-tiers`      | 6   | 2     | 0    | 4        | 0          | tier-name buttons still rendered in rows (PR-4 ~14 leftovers)                                                                                                                  |
| `/resellers`           | 21  | 10    | 0    | 11       | 0          | row name button / «صفحهٔ مشتری» kept: only path to the standing drawer (PR-4)                                                                                                  |
| `/service-locations`   | 17  | 17    | 0    | 0        | 0          |                                                                                                                                                                                |
| `/services`            | 17  | 17    | 0    | 0        | 0          |                                                                                                                                                                                |
| `/settings`            | 44  | 42    | 0    | 1        | 1          | app save bar renders only after an edit; fallback run has no edit; extra duplicate section button next to the tab strip                                                        |
| `/support`             | 1   | 1     | 0    | 0        | 0          |                                                                                                                                                                                |
| `/support-knowledge`   | 8   | 8     | 0    | 0        | 0          |                                                                                                                                                                                |
| `/support-learning`    | 3   | 3     | 0    | 0        | 0          |                                                                                                                                                                                |
| `/tickets`             | 28  | 28    | 0    | 0        | 0          |                                                                                                                                                                                |
| `/trials`              | 8   | 8     | 0    | 0        | 0          |                                                                                                                                                                                |
| `/users`               | 12  | 12    | 0    | 0        | 0          |                                                                                                                                                                                |
| `/users/:id`           | 33  | 31    | 0    | 0        | 2          | blocked-customer banner needs a blocked customer; fixture one is not (PR-1 test + mutation check cover it); needs a customer with nothing pending; not checkable with fixtures |
| `/orders/:id`          | 2   | 2     | 0    | 0        | 0          |                                                                                                                                                                                |
| `/payments/:id`        | 5   | 5     | 0    | 0        | 0          |                                                                                                                                                                                |
| `/services/:id`        | 6   | 6     | 0    | 0        | 0          |                                                                                                                                                                                |
| `/products/:id`        | 2   | 2     | 0    | 0        | 0          |                                                                                                                                                                                |
| `/panels/:id`          | 6   | 6     | 0    | 0        | 0          |                                                                                                                                                                                |
| `/broadcasts/:id`      | 19  | 19    | 0    | 0        | 0          |                                                                                                                                                                                |
| `/tickets/:id`         | 1   | 1     | 0    | 0        | 0          |                                                                                                                                                                                |
| `/business-chats/:id`  | 12  | 12    | 0    | 0        | 0          |                                                                                                                                                                                |
| `/incidents/:id`       | 1   | 0     | 0    | 1        | 0          | status/severity chips on the detail head (no PR addressed it)                                                                                                                  |

Totals: 477 items: **FIXED 427, KEEP 7, NOT DONE 32, UNVERIFIED 11.**

Notes on the reasons:

- `/reports` range chips: the dashboard range chips are on the owner's KEEP list in the brief, but not in `demo-diff.keep.json`, which is why the kit report still showed them. Adding a KEEP entry would remove them from the tool's output.
- `/recovery`: the Recovery Kit removal is KEEP, and the owner removed the per-invoice result card on purpose (`f9ec6f869`); it is classed NOT DONE only because no KEEP entry names it.
- `/resellers`, `/reseller-plans`, `/reseller-tiers`: the leftovers are row-level buttons (the reseller name that opens the standing drawer, «صفحهٔ مشتری», tier names). PR-4 expected about 14 leftovers on its routes.
- `/extra-devices`: no PR handled it; rows still open edit from the name button instead of a «ویرایش» button. This is a real gap for the next round.
- `/incidents/:id`: the status and severity chips on the detail head are not in the owner's demo; no PR handled them. Real gap.
- `/users/:id`: the blocked banner is covered by a PR-1 test with a mutation check, but not visible in the fixture run (its customer is not blocked).
- «بیشتر» menus: their contents were restored from the actions each page already had, because the demo HTML was never seen (stated in PRs #460, #462, #464). If the owner's demo shows other entries, that is not visible here.
- No server export of the whole filtered list (no endpoint; none invented): the list «خروجی CSV» exports the visible page. Elements needing missing API data: this one only.

## 3. Real gaps seen in the fallback runs

Only items that point at the app, not at the old demo:

- `/extra-devices` and `/incidents/:id`: see above.
- `/` (dashboard) shows three tables where the old demo has two, plus the heads «صف رسیدگی» and «وضعیت عملیاتی». The dashboard is OK in the owner's kit report, so this is most likely a post-demo addition; it is unverified without the owner's demo.
- `/reports#tab:صورت مالی` rendered the server-rejected state in the fixture run: the fixture set has no answer for that report. A fixture gap, not an app gap; check the tab against real data.
- `/payment-gateways/CARD_TO_CARD` renders «روش پرداخت یافت نشد»: the fixture set has no such method. Check it with the real payment methods page.
- Everything else in the fallback runs (titles with «دادهٔ نمونه», «جزئیات» banner, pagination arrows, digit differences, tab labels) is old-demo noise.

## 4. Side-by-side images

`final-sidebyside/` holds one JPEG per route from the light 1440 run (68 files, 20.7 MB, under the 25 MB limit, tool default quality 80, no re-encoding needed). Demo on the left (the OLD demo), app on the right.
