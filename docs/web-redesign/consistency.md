# Web Admin redesign — CONSISTENCY (wave 3)

The pass that runs after the five page families (DASHBOARD, COMMERCE-A,
COMMERCE-B, OPS-A, OPS-B) were merged onto FOUND's kit (`local/integ`,
`5117c54`). Its job is the seams between families: one route inventory that
is proven, one look for the same thing on every page, and a visual pass over
every route rather than a sample. No contract, backend or permission changed.

## 1. Route inventory

**54 routes, 40 navigation entries in 7 groups, 14 detail/creation routes
reached from a list.** Every route resolves to its own page component; none
resolves to `NotFound`.

The table is generated from the code, not written by hand: `ROUTE_PATTERNS`
and `resolve` in `apps/web/src/app.tsx` (component and page gate), and
`NAV` and `GROUP_ORDER` in `apps/web/src/nav.ts` (group, entry and the
permission that draws the link). The family is the owner in
`foundation.md` §8. "Permission" for a navigation entry is what DRAWS the
link (`navPermitted`: any of a list; `reports` also needs the owner role).
For a route with no entry it is the page's own gate. Either way the server
re-checks every call; nothing here is enforcement.

| #   | Route                  | Page component            | Family     | Nav group · entry                                   | Permission                                                                  |
| --- | ---------------------- | ------------------------- | ---------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | `/`                    | `DashboardPage`           | DASHBOARD  | عملیات · `dashboard`                                | session only                                                                |
| 2   | `/users`               | `UsersPage`               | COMMERCE-A | عملیات · `users`                                    | `users.view`                                                                |
| 3   | `/users/:id`           | `UserDetailPage`          | COMMERCE-A | عملیات · under `users` (detail, no entry)           | page gate: `users.view`                                                     |
| 4   | `/trials`              | `TrialsPage`              | COMMERCE-A | فروش · `trials`                                     | any of `users.view`, `settings.destructive`, `settings.view`, `panels.view` |
| 5   | `/products`            | `ProductsPage`            | COMMERCE-B | فروش · `products`                                   | any of `catalog.view`, `catalog.edit`                                       |
| 6   | `/products/:id`        | `ProductDetailPage`       | COMMERCE-B | فروش · under `products` (detail, no entry)          | page gate: `catalog.view`                                                   |
| 7   | `/product-categories`  | `ProductCategoriesPage`   | COMMERCE-B | فروش · `product-categories`                         | any of `catalog.view`, `catalog.edit`                                       |
| 8   | `/extra-devices`       | `ExtraDevicesPage`        | COMMERCE-B | فروش · `extra-devices`                              | any of `catalog.view`, `catalog.edit`                                       |
| 9   | `/service-locations`   | `ServiceLocationsPage`    | COMMERCE-B | فروش · `service-locations`                          | any of `catalog.view`, `catalog.edit`                                       |
| 10  | `/orders`              | `OrdersPage`              | COMMERCE-A | عملیات · `orders`                                   | `orders.view`                                                               |
| 11  | `/orders/:id`          | `OrderDetailPage`         | COMMERCE-A | عملیات · under `orders` (detail, no entry)          | page gate: `orders.view`                                                    |
| 12  | `/services`            | `ServicesPage`            | COMMERCE-A | عملیات · `services`                                 | any of `services.view`, `refunds.view`                                      |
| 13  | `/services/:id`        | `ServiceDetailPage`       | COMMERCE-A | عملیات · under `services` (detail, no entry)        | page gate: `services.view`                                                  |
| 14  | `/broadcasts`          | `BroadcastsPage`          | COMMERCE-B | ارتباط · `broadcasts`                               | `broadcasts.view`                                                           |
| 15  | `/broadcasts/new`      | `BroadcastNewPage`        | COMMERCE-B | ارتباط · under `broadcasts` (detail, no entry)      | page gate: `broadcasts.send` to send                                        |
| 16  | `/broadcasts/:id`      | `BroadcastDetailPage`     | COMMERCE-B | ارتباط · under `broadcasts` (detail, no entry)      | page gate: `broadcasts.view`                                                |
| 17  | `/bulk-operations`     | `BulkOperationsPage`      | COMMERCE-B | عملیات · `bulk-operations`                          | `bulk_operations.view`                                                      |
| 18  | `/bulk-operations/new` | `BulkOperationNewPage`    | COMMERCE-B | عملیات · under `bulk-operations` (detail, no entry) | page gate: `users.wallet.mass` / `services.mass.grant`                      |
| 19  | `/bulk-operations/:id` | `BulkOperationDetailPage` | COMMERCE-B | عملیات · under `bulk-operations` (detail, no entry) | page gate: `bulk_operations.view`                                           |
| 20  | `/tickets`             | `TicketsPage`             | OPS-B      | عملیات · `tickets`                                  | `tickets.view`                                                              |
| 21  | `/tickets/:id`         | `TicketDetailPage`        | OPS-B      | عملیات · under `tickets` (detail, no entry)         | page gate: `tickets.view`                                                   |
| 22  | `/payments`            | `PaymentsPage`            | COMMERCE-A | عملیات · `payments`                                 | `payments.view`                                                             |
| 23  | `/payments/:id`        | `PaymentDetailPage`       | COMMERCE-A | عملیات · under `payments` (detail, no entry)        | page gate: `payments.view`                                                  |
| 24  | `/compensations`       | `CompensationsPage`       | COMMERCE-A | عملیات · `compensations`                            | `payments.view`                                                             |
| 25  | `/payment-accounts`    | `PaymentAccountsPage`     | OPS-A      | زیرساخت · `payment-accounts`                        | `payments.accounts.view`                                                    |
| 26  | `/payment-gateways`    | `PaymentGatewaysPage`     | OPS-A      | زیرساخت · `payment-gateways`                        | `payments.gateways.view`                                                    |
| 27  | `/bots`                | `BotsPage`                | OPS-A      | زیرساخت · `bots`                                    | `settings.view`                                                             |
| 28  | `/discounts`           | `DiscountsPage`           | COMMERCE-B | فروش · `discounts`                                  | `catalog.view`                                                              |
| 29  | `/campaigns`           | `CampaignsPage`           | COMMERCE-B | فروش · `campaigns`                                  | `campaigns.view`                                                            |
| 30  | `/campaigns/new`       | `CampaignNewPage`         | COMMERCE-B | فروش · under `campaigns` (detail, no entry)         | page gate: `campaigns.view`                                                 |
| 31  | `/campaigns/:id`       | `CampaignDetailPage`      | COMMERCE-B | فروش · under `campaigns` (detail, no entry)         | page gate: `campaigns.view`                                                 |
| 32  | `/custom-service`      | `CustomServicePage`       | COMMERCE-B | فروش · `custom-service`                             | `catalog.view`                                                              |
| 33  | `/referrals`           | `ReferralsPage`           | COMMERCE-B | فروش · `referrals`                                  | `referrals.view`                                                            |
| 34  | `/resellers`           | `ResellersPage`           | COMMERCE-B | نمایندگی · `resellers`                              | `resellers.view`                                                            |
| 35  | `/reseller-tiers`      | `ResellerTiersPage`       | COMMERCE-B | نمایندگی · `reseller-tiers`                         | `resellers.view`                                                            |
| 36  | `/reseller-plans`      | `ResellerPlansPage`       | COMMERCE-B | نمایندگی · `reseller-plans`                         | `resellers.view`                                                            |
| 37  | `/reports`             | `ReportsPage`             | COMMERCE-B | فروش · `reports`                                    | `reports.view` + owner role                                                 |
| 38  | `/panels`              | `PanelsPage`              | OPS-A      | زیرساخت · `panels`                                  | any of `panels.view`, `panels.edit`                                         |
| 39  | `/panels/new`          | `NewPanelPage`            | OPS-A      | زیرساخت · under `panels` (detail, no entry)         | page gate: `panels.edit`                                                    |
| 40  | `/panels/:id`          | `PanelDetailPage`         | OPS-A      | زیرساخت · under `panels` (detail, no entry)         | page gate: `panels.view`                                                    |
| 41  | `/providers`           | `ProvidersPage`           | OPS-A      | زیرساخت · `providers`                               | session only                                                                |
| 42  | `/settings`            | `SettingsPage`            | OPS-B      | پیکربندی · `settings`                               | `settings.view`                                                             |
| 43  | `/support`             | `SupportPage`             | OPS-B      | ارتباط · `support`                                  | `settings.view`                                                             |
| 44  | `/client-apps`         | `ClientAppsPage`          | OPS-A      | ارتباط · `client-apps`                              | `client_apps.view`                                                          |
| 45  | `/features`            | `FeaturesPage`            | OPS-B      | پیکربندی · `features`                               | `settings.view`                                                             |
| 46  | `/reminders`           | `RemindersPage`           | OPS-B      | ارتباط · `reminders`                                | `settings.view`                                                             |
| 47  | `/bot-buttons`         | `BotButtonsPage`          | OPS-A      | پیکربندی · `bot-buttons`                            | `settings.view`                                                             |
| 48  | `/content`             | `ContentPage`             | OPS-B      | ارتباط · `content`                                  | `templates.view`                                                            |
| 49  | `/alerts`              | `AlertsPage`              | OPS-B      | سامانه · `alerts`                                   | `opslog.view`                                                               |
| 50  | `/notifications`       | `NotificationsPage`       | OPS-B      | سامانه · `notifications`                            | any of `opslog.view`, `settings.edit`                                       |
| 51  | `/appearance`          | `AppearancePage`          | OPS-A      | پیکربندی · `appearance`                             | `settings.view`                                                             |
| 52  | `/ops-group`           | `OpsGroupPage`            | OPS-B      | سامانه · `ops-group`                                | `settings.view`                                                             |
| 53  | `/recovery`            | `RecoveryPage`            | OPS-B      | سامانه · `recovery`                                 | `backup.view`                                                               |
| 54  | `/system`              | `SystemPage`              | OPS-B      | سامانه · `system`                                   | session only                                                                |

Groups, in drawn order: عملیات (`navgroup_ops`, 8 entries), فروش
(`navgroup_sales`, 10), نمایندگی (`navgroup_resellers`, 3), زیرساخت
(`navgroup_infra`, 5), ارتباط (`navgroup_comms`, 5), پیکربندی
(`navgroup_config`, 4), سامانه (`navgroup_system`, 5).

### How the inventory is proven

`tests/web/route-inventory.test.tsx`, all in `pnpm test:web`:

- _%s resolves to a real page component, not the 404_ — one case per
  pattern, with a sample id for `:id`: the element is a `…Page`
  component, the title is not the not-found title, and there is a crumb.
- _lists exactly the routes resolve serves_ — `ROUTE_PATTERNS` is compared
  with the literals `resolve` itself tests, so a route served and not listed,
  or listed and served nowhere, fails.
- _serves the 404 for what it does not serve_, _has a route for every
  navigation entry_, _includes every detail route the owner named_.
- _puts every entry in exactly one known group, and draws it for an actor
  holding its permission_; _keeps every permission gate: without the
  permission, no link_; _draws each entry once, inside the group it declares,
  in the rendered shell_.
- New in this pass — _opens each entry on its own page for the least actor it
  is drawn for_: the actor holding only the entry's first permission (plus the
  owner role where it is owner-only) resolves to the SAME component the owner
  gets, not the 404 and not a refusal (`denied`). Mutation: gating
  `/orders` on `orders.refund` fails it.
- New in this pass — _lands on each page when its sidebar link is followed_:
  in the rendered shell, clicking every sidebar link moves `location` to its
  path, marks that link `aria-current="page"` and draws no not-found.
  Mutation: dropping the sidebar link's `onClick` fails it.

One limit, stated rather than hidden: for an entry drawn on ANY of several
permissions (`/services`, `/products`, `/panels`, `/trials`,
`/notifications`…) the least-actor test uses the first one. An actor holding
only a later one gets the page with the part they may see — e.g.
`refunds.view` alone draws `/services` with its list refused and the refund
queue shown — which is each family's own tested behaviour, not this test's.

## 2. What this pass changed

Commits on `claude/w-consistency` after `local/integ`, oldest first. Each
behavioural or stylesheet rule named below has a test that fails when the rule
is reverted; the commit message names it.

| Commit    | Change                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `5749292` | Chart x-axis labels never collide: `axisLabelSlots` drops the stepped label before the always-drawn last one (30 days, step 4 drew 28 and 29 on top of each other).                                                                                                                                                                                                                                      |
| `1753700` | A capped sidebar counter reads as a floor («۱۰۰۰+»), and the badge is out of the link's accessible name (still its description).                                                                                                                                                                                                                                                                         |
| `5ba6f73` | A KV takes its container's rhythm (the `<dl>` margin zeroed at zero specificity); `RowActions wrap` replaces OPS-A's page copy. OPS-B's `.ob-flow` wrapper removed.                                                                                                                                                                                                                                      |
| `8a63f46` | One kit `Disclosure` for every closed-until-asked section, replacing seven page `<details>` treatments; no page writes its own.                                                                                                                                                                                                                                                                          |
| `0d66a5f` | `BusinessOverview` removed (nothing mounted it) with its three catalogue keys.                                                                                                                                                                                                                                                                                                                           |
| `b4fa08a` | Quantities take the body's (Persian) digit shapes through `Num`; Latin digits are for identifiers only. Eighteen pages.                                                                                                                                                                                                                                                                                  |
| `cd0422f` | No «فعال» maturity badge on a working page's head (32 call sites; the type now refuses `now`).                                                                                                                                                                                                                                                                                                           |
| `409a498` | Docs: dashboard falsification rows R-01, V5, W11 describe the rules they pin now.                                                                                                                                                                                                                                                                                                                        |
| `0233097` | Page CSS on the tokens and the kit: obsolete rules removed, literal sizes and radii replaced by tokens, one kit `.inset`/`.inset.danger-zone`; hand-drawn error, loading and refusal states replaced by the kit's.                                                                                                                                                                                       |
| `d8f5a50` | Quantity inputs and KPI deltas follow the digit rule (twenty inputs; the signed delta keeps its sign in front).                                                                                                                                                                                                                                                                                          |
| `857dc19` | Kit `Quantity` for a compound figure («۲۱۵ / ۴۰۰», «۴۲ ms») in place of `Ltr` at seven sites.                                                                                                                                                                                                                                                                                                            |
| `f149e35` | Dashboard and report period instants are `Quantity`, not `Ltr`.                                                                                                                                                                                                                                                                                                                                          |
| `46945bf` | Route inventory: every navigation entry is reachable, not merely listed (§1).                                                                                                                                                                                                                                                                                                                            |
| `4eff452` | From the all-routes visual pass (§3): a card head's actions wrap beneath titles that reach `--card-head-titles-min`; a card ending on a toolbar or filter row ends flush, with no empty band; a segmented set wraps under 640px instead of running off the card; a dashboard KPI card narrower than 200px sets its figure at `--fs-kpi-narrow`, so a nine-digit toman figure keeps its unit on its line. |
| `a04e54e` | The reports page's three hand-drawn pagers go through `CursorPager` (new optional `summary`); no page writes a `.pager` of its own.                                                                                                                                                                                                                                                                      |
| `db0c0dc` | The report pager labels are keys `check:i18n` can see (single-quoted), and a kit doc comment no longer quotes Persian.                                                                                                                                                                                                                                                                                   |

## 3. Visual QA across every route

`pnpm web:shots` (foundation.md §7) against the committed fixtures in
`tests/web/shots/fixtures/*.ts`, the clock frozen at `SHOT_NOW`
(`2026-09-06T08:00:00Z`), the production CSP, motion reduced. Detail routes
use the fixture id `01a05e35-c9ad-7e93-bef3-1ed9b55292c8` (every family's
detail fixture matches `:id`).

```bash
ID=01a05e35-c9ad-7e93-bef3-1ed9b55292c8
ROUTES="/ /users /users/$ID /trials /products /products/$ID /product-categories \
  /extra-devices /service-locations /orders /orders/$ID /services /services/$ID \
  /broadcasts /broadcasts/new /broadcasts/$ID /bulk-operations /bulk-operations/new \
  /bulk-operations/$ID /tickets /tickets/$ID /payments /payments/$ID /compensations \
  /payment-accounts /payment-gateways /bots /discounts /campaigns /campaigns/new \
  /campaigns/$ID /custom-service /referrals /resellers /reseller-tiers /reseller-plans \
  /reports /panels /panels/new /panels/$ID /providers /settings /support /client-apps \
  /features /reminders /bot-buttons /content /alerts /notifications /appearance \
  /ops-group /recovery /system"
O=/tmp/claude-0/consistency-shots
pnpm web:shots $ROUTES --out $O/1440                                   # dark + light
pnpm web:shots $ROUTES --no-build --width 900 --out $O/900             # dark + light
pnpm web:shots $ROUTES --no-build --width 390 --height 844 --out $O/390
pnpm web:shots / /users /orders /panels/$ID /settings /system --no-build --collapsed --out $O/collapsed
```

Result on the final head: **336 shots, zero WARN** (54 routes × 2 themes × 3
widths, plus 12 collapsed). PNGs are not committed; they are in
`/tmp/claude-0/consistency-shots/`.

Compared with the reference captures (dark dashboard, users, services,
panels, settings; light dashboard; mobile), the pages read as one system:
one page head, one card, one table density, one badge vocabulary and one
radius set. The four defects the pass found and fixed are in `4eff452`
above; each was visible only at a width or on a page the family sets never
shot together (the referrals card head and the report periods at 390, the
referrals filter band, the dashboard KPI row at 1440).

### Left for the owner to decide

- **Wide tables scroll inside their card at 900 and 390** (payments, orders,
  services, panels…) rather than collapsing into stacked cards. Consistent on
  every list, and nothing is cut off, but it is a design choice the reference
  does not show at phone width.
- **KPI figures are exact** («۱۷۴٬۹۵۶٬۰۰۰ تومان»), where the reference
  abbreviates («۳۱۷ میلیون»). Exactness was kept on purpose (money is shown as
  recorded); abbreviating is a product decision, not a consistency fix.
- **Detail-page head actions are text-only buttons** (service, order and
  panel detail), where the reference pairs each with an icon.
- **Two pager vocabularies remain by meaning**: keyset lists say
  «قدیمی‌تر / تازه‌تر», the offset reports say «قبلی / بعدی». Same
  component and look since `a04e54e`; the words follow the traversal.

## 4. The minimum deterministic visual QA set

The brief's minimum set, reproducible from a clean checkout with the committed
fixtures and the frozen clock (no network, no database). Each command prints
one `ok`/`WARN` line per shot; the set passes with zero `WARN`.

```bash
pnpm install --frozen-lockfile
ID=01a05e35-c9ad-7e93-bef3-1ed9b55292c8
O=.web-shots/qa

pnpm web:shots / --theme dark --out $O                        # dashboard, dark (builds once)
pnpm web:shots /payments --theme dark --no-build --out $O     # one dense list (twelve rows)
pnpm web:shots /panels/$ID --theme dark --no-build --out $O  # one detail page
pnpm web:shots /settings --theme dark --no-build --out $O     # one settings form
pnpm web:shots /users --collapsed --theme dark --no-build --out $O   # collapsed sidebar
pnpm web:shots / /payments /panels/$ID /settings --theme light --no-build --out $O   # light theme
```

Outputs, by file name: `dashboard--dark--1440.png`, `payments--dark--1440.png`,
`panels-$ID--dark--1440.png`, `settings--dark--1440.png`,
`users--dark--1440--collapsed.png`, and the four `…--light--1440.png`, with
`report.json` beside them. Add `--width 390 --height 844` to any line for
the phone layout.
