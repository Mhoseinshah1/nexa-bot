# Web Admin redesign — COMM-B (commerce pages, part B)

Round W, Wave 2. Branch `claude/w-commerce-b` (from `main` f465d58).
Phase 1 (§0–§6) is the inventory and mapping; **Phase 2 (§7) is the redesign itself**,
built on FOUND's kit, with the per-route changes and the capability checklist.

Authorities (owner-locked, `w-common.md`): current `main` for function, data and
security; the reference preview (`refs/reference/preview-v2`, screenshots in the
scratchpad `w-ref/zip/shots/`) for presentation only. Anything the reference shows that
Nexa has no data for is listed under "not carried over" and is **not** added.

Routes owned: `/products`, `/products/:id`, `/product-categories`, `/extra-devices`,
`/service-locations`, `/custom-service`, `/discounts`, `/campaigns`, `/campaigns/new`,
`/campaigns/:id`, `/broadcasts`, `/broadcasts/new`, `/broadcasts/:id`,
`/bulk-operations`, `/bulk-operations/new`, `/bulk-operations/:id`, `/referrals`,
`/resellers`, `/reseller-tiers`, `/reseller-plans`, `/reports`. Shared pieces owned:
the audience builder (`audience-builder.tsx`), the reseller standing cards
(`reseller-standing.tsx`), the referral banner card (in `referrals.tsx`),
`business.tsx` and `report-view.ts`.

---

## 0. Cross-cutting facts that constrain every page

- **CSP forbids inline `style` attributes** (`style-src 'self'`, asserted by
  `tests/web/csp.test.tsx` and by `reports.test.tsx`, which checks
  `document.querySelector('[style]')` is null). The reference `ui/charts.tsx` and
  `ProgressBar`s use `style={{…}}` throughout; nothing may be ported that way. Bars and
  charts use SVG geometry attributes and classes (the pattern `Distribution` and
  `reseller-plans.tsx`'s `ProgressBar` already follow).
- **Every write already carries an idempotency key** through `useSubmissionKey()`
  (`current(payload)` / `settle()` / `settleOn(error)`); the key is bound to the payload
  fingerprint so an edited field is a new command. The redesign moves buttons, never
  this wiring.
- **Permission gating is by props computed in `app.tsx` `resolve()`** from separate
  server keys; pages never infer a permission from `denied`. Every gate listed below must
  survive exactly; UI hiding stays a courtesy, the server still refuses.
- **Filters that mint a new query are hidden while the list cannot answer**
  (`mayRequest(query, denied)`), on products, discounts, cashback, referral commissions
  and resellers. Keep that when filters move into a FilterBar.
- **Cursor trails are keyed by the filter signature** (a cursor minted under one filter is
  never replayed under another). `/products` pages an ASCENDING keyset, so its pager uses
  `nextLabel="web.newer"` / `previousLabel="web.older"`; `/extra-devices` and the discount
  and cashback lists do the same; referrals, resellers, campaigns use default labels.
- **Tests depend on structure, not only text**: many assert via `closest('section')`
  (a kit `Card` renders `<section>` with an `<h2>` title), `closest('tr')`, element ids
  (`product-title-create`, `discount-edit-label`, `aud-*`, `bc-*`, `bulk-*`,
  `campaign-typed-*`, `grants-<kind>`…), accessible names of buttons, `.list-editor-row`
  (kit `ListEditor`), `.faint` (the dash for "no value", products test), `.trend-readout`,
  `polyline.current|previous` and `data-testid="trend-slot-N"` (kit `TrendChart`).
  Phase 2 keeps each asserted behaviour; where a class disappears the test switches to a
  role/label/text query asserting the same thing.
- **Exports consumed by other families** (names and signatures must not change):
  - `products.tsx`: `STATUS_LABELS`, `STATUS_TONES` (used by `panels.tsx` [OPS] and
    `business.tsx`), `catalogueGap`, `bodyFrom`.
  - `resellers.tsx`: `RESELLER_STATUS_LABELS`, `PRICE_LAYER_LABELS`, `PRICE_LAYER_STEPS`
    (used by `orders.tsx` [COMM-A]), `CreditLimitCell`, `OVERRIDE_LABELS`, `PricingText`,
    `ResellerStatusBadge` (used by `users.tsx` [COMM-A]), `TIER_PRICING_LABELS`,
    `limitWire`, `creditAmountOf`, `percentOf`, `resellerBodyFrom`, `debtWarningOf`.
  - `referrals.tsx`: `PartyCell`, `TriggerBadge` (used by `users.tsx`), label maps.
  - `custom-service.tsx`: `CUSTOM_SERVICE_LEVEL_LABELS` (used by `orders.tsx`).
  - `discounts.tsx`: `PURPOSE_LABELS` (campaigns, reseller-tiers), `REASON_LABELS`,
    body builders, `localInputOf`, `instantOf`.
  - `business.tsx`: `BusinessOverview` (rendered by `dashboard.tsx` [DASH] for the Super
    Admin), `ReportsPage`, `ReferralAnalytics`, `RangePicker`, `ChangeNote`,
    `formatInstantIn`.
  - `audience-builder.tsx`: `AudienceBuilder`, `EMPTY_AUDIENCE`, `draftOf`,
    `describeAudience`, `audienceMessage`, `SERVICE_STATE_LABELS`.
  - `reseller-standing.tsx`: the four cards, `changedFieldsOf`; `TierHistoryCard` is
    used by `reseller-tiers.tsx`.
  - `extra-devices.tsx`: `everyPage` (used by `service-locations.tsx`).
- **Imported from other families** (read only, not changed by me): `messageFor` from
  `settings.tsx` [OPS]; `STATE_LABELS/STATE_TONES` from `orders.tsx` and `services.tsx`
  [COMM-A].

---

## 1. Capability inventory

Notation: **Q** query (key → endpoint), **M** mutation, **P** permission prop (server key),
**T** toast, **E** error mapping, **V** client validation.

### 1.1 `/products` — `ProductsPage` (`products.tsx`)

- **P**: `denied = !catalog.view` (disables both queries; StateSwitch shows the denied
  state); `mayEdit = catalog.edit` (create form, else an info card naming the permission
  `web.product_edit_denied`). Nav: ANY of `catalog.view`, `catalog.edit`.
- **Q**: `['products', signature, cursor]` → `GET /products` with `status`, `audience`,
  `title`, `categoryId` (`none` = uncategorised), `cursor`;
  `['product-categories']` → `GET /product-categories` (names, filter pills, catalogue
  badge facts).
- **URL state**: `?status=ACTIVE|INACTIVE`, `?audience=EVERYONE|RESELLERS_ONLY|HIDDEN`,
  `?categoryId=<id>|none`, `?title=`. The search draft follows the applied value
  (sidebar link with empty query clears the box — tested).
- **Search**: form (title, `maxLength=PRODUCT_TITLE_MAX_LENGTH`), Apply (submit), Clear
  (disabled when nothing to clear).
- **Filters**: 3 pill groups: status (all/active/inactive), audience (all/everyone/
  resellers/hidden), category (all/`none`/each category by name).
- **Columns**: title (link to `/products/:id`), status badge (ACTIVE ok / INACTIVE
  neutral), catalogue badge (`catalogueGap` — 9 gaps in server order: INACTIVE,
  UNLISTED [warn], RESELLERS, UNPRICED, NO_PANEL, UNCATEGORISED, CATEGORY_INACTIVE,
  CATEGORY_HIDDEN [warn], CATEGORY_UNKNOWN; green "in catalogue" otherwise), category
  (warn badge "uncategorised" / emoji + name / dash), audience, price (Money or dash —
  never 0), duration (days or "unlimited"), traffic (GB text or "unlimited"), sort order.
- **Pagination**: CursorPager, ascending keyset (newer/older labels), trail keyed on the
  4-field signature.
- **Empty**: search-empty vs catalogue-empty copy.
- **Create form** (`ProductForm mode="create"`) — see 1.2 for fields; T
  `web.product_created`; resets to BLANK after create; note "created inactive".
- **Scope card**: `products_scope_body`, `products_panel_rule` (owner revision 10).
- Tests: `products-and-orders.test.tsx` (list/form/detail/routes parts),
  `products-display.test.tsx`.

### 1.2 `/products/:id` — `ProductDetailPage` + `ProductForm mode="edit"`

- Keyed by id in `resolve()`. **P**: `denied = !catalog.view`, `mayEdit = catalog.edit`.
- **Q**: `['product', id]` → `GET /products/:id`; `['product-categories']`;
  inside the form `['panels','for-product']` → `GET /panels?limit=PANEL_PAGE_MAX`.
- **Gap banner** (when not sellable): info for UNLISTED/CATEGORY_HIDDEN, warn otherwise.
- **Identity KV**: title, description, status badge, catalogue badge, category (warn
  badge if none, name, or dash), audience, price, duration, traffic, device limit
  ("provider default" when null), sort order, panel (Copyable id), display locations
  (ordered list), display features (ordered list), service-location label, created,
  updated.
- **Category move card** (mayEdit): select without a blank option (blank only while the
  product has none); button disabled until a different category is chosen;
  **M** `assignProductCategory` → T `web.product_category_assigned`; invalidates
  product, products, categories; error banner `messageFor`.
- **Status card** (mayEdit): Activate (INACTIVE) / Deactivate (ACTIVE, danger button);
  **M** `activateProduct` / `deactivateProduct` → T activated/deactivated; note
  `product_deactivate_note` (withdrawal touches nothing already bought). No
  confirmation today.
- **Edit form** fields and **V** (`bodyFrom`, bounds from contracts):
  title (required, max), description (textarea, optional), audience (select),
  panel (select when `panels.view` answers AND the list is complete; typed LTR id
  otherwise, with a hint distinguishing "too many" from "denied"), category (select /
  typed id fallback; "none" option), duration days (0..MAX_DURATION_DAYS, 0 = unlimited),
  traffic: "unlimited" checkbox + GB text (≤2 decimals via `parseTrafficGb`, >0, ≤ max;
  typed 0 refused), device limit (optional 1..MAX), price amount (optional; digits, >0;
  empty = unpriced, never 0) + currency (`SALES_CURRENCY_CODES` only; pair sent
  together), display locations / features (`ListEditor`, ordered, per-line trim,
  no blank line, max length, max items, no newlines), service-location label
  (optional, max, no newline), sort order (PRODUCT_SORT_MIN..MAX). `categoryId` always
  sent (null for none). Problem shown as warn banner; submit disabled while a problem
  exists or pending. T `web.product_saved`; `setQueryData(['product', id])`;
  invalidates `['products']`. Error banner `messageFor`.
- No dirty-state protection today.

### 1.3 `/product-categories` — `ProductCategoriesPage`

- **P**: `denied = !catalog.view`; `mayEdit = catalog.edit` (all write controls and the
  form). Nav: ANY of view/edit.
- **Q**: `['product-categories']`.
- **Columns**: name (emoji + name), product count (server-computed, withdrawn
  included), status badge (active/inactive), visibility badge (visible/hidden), actions.
- **Row actions** (mayEdit, all disabled while any mutation is busy): Edit (loads form),
  Activate/Deactivate (**M** `transitionProductCategory` status route), Show/Hide
  (**M** same, visibility route — never the status one, tested), Move up / Move down
  (disabled at the ends; **M** `reorderProductCategories` sends the WHOLE order
  renumbered from 0), Delete (danger; **`window.confirm(web.category_delete_confirm)`**;
  **M** `deleteProductCategory`; server refuses non-empty with
  `commerce.category_not_empty` + `details.productCount`, shown in its OWN banner with the
  count).
- **T**: `category_saved`, `category_reordered`, `category_deleted`.
- **Notes under table**: inactive note, hidden note.
- **Form** (outside the StateSwitch, so an empty tenant still gets it): name (required,
  max 120), description (max 500), emoji (max 40), sort order (create only). Save
  disabled on empty name; Cancel edit while editing. Shared failure banner for
  save/transition/reorder.
- Tests: `product-categories.test.tsx` (uses `window.confirm` stubs).

### 1.4 `/extra-devices` — `ExtraDevicesPage`

- **P**: `denied = !catalog.view`; `mayEdit = catalog.edit`; `mayViewPanels = panels.view`
  (panel scope list only asked with it).
- **Q**: `['service-addons','ADD_DEVICES',cursor]` → `GET /service-addons?kind=ADD_DEVICES
&limit=50`; `['panels','extra-devices-scope']` and `['products','extra-devices-scope']`
  read EVERY page via `everyPage` (refuses a repeated cursor), `retry:false`.
- **Capability banner**: which provider types declare `DEVICE_LIMIT_ADJUSTMENT` (warn if
  none).
- **Columns**: title, unit price (Money or "unpriced"), max quantity, scope
  ("panel / product", names resolved, "all" words), state badge, updated, actions
  (Edit; Enable/Disable → **M** `setServiceAddonActive`, no confirmation).
- **Pagination**: CursorPager with a local trail (newer/older labels).
- **Form** (mayEdit): title (max 120), unit price (digits, >0), currency (IRT/IRR with
  Persian labels), max quantity (1..`DEVICE_ADDON_MAX_QUANTITY`, warn banner otherwise),
  panel scope (all / each panel, "unsupported" suffix for incapable panels), product
  scope (all / each product), sort. Danger banner when a scope list could not be read
  whole. Save disabled until title, price and quantity are valid. **M**
  create/update (`kind: ADD_DEVICES`, traffic/duration null). T `extra_devices_saved`.
- Tests: `extra-devices.test.tsx`.

### 1.5 `/service-locations` — `ServiceLocationsPage`

- **P**: `denied = !catalog.view`; `mayEdit = catalog.edit`; `mayReadPanels = panels.view`
  (panels read when `mayReadPanels && (!denied || mayEdit)`: an edit-only role gets a
  working form).
- **Q**: `['service-locations']`; panels and products via `everyPage`.
- **Capability banner**: providers with `LOCATION_CHANGE`.
- **Columns**: panel name, label (+ "initial" info badge), key (LTR mono), product scope,
  price (Money / "free" for 0 / "unpriced"), limits text (cooldown hours; max changes
  per N days; "no limits"), state badge (target on/off), updated, actions (Edit; Delete
  danger — **no confirmation today**).
- **Form**: panel (select with "unsupported" suffix, or typed id without `panels.view`;
  changing panel clears a product that is not on the new panel), label (max), key (LTR,
  max), product (only the chosen panel's products; typed id fallback), initial
  (checkbox), enabled (checkbox), price (optional digits) + currency, cooldown hours,
  max changes, period days (each optional 1..max; max-changes and period must be set
  together → warn banner `service_locations_limit_pair`), sort. **V**: panel, key and
  label required; enabled requires a price; initial requires no product scope.
  **M** create/update → T `saved` or `unchanged` (server `changed`); **M** delete → T
  `deleted`. **E** `commerce.service_location_invalid` `details.reason` → 7 Persian
  messages (IN_USE, DUPLICATE_KEY, SECOND_INITIAL, CURRENCY, PRODUCT_PANEL, PANEL_FULL,
  COUNT).
- Tests: `service-locations.test.tsx`.

### 1.6 `/custom-service` — `CustomServicePage`

- **P**: `denied = !catalog.view`; `mayEdit = catalog.pricing.edit`;
  `mayViewPanels = panels.view`, `mayViewTiers = resellers.view` (pickers; typed ids
  otherwise).
- **Q**: `['panels','for-custom-service']` (limit PANEL_PAGE_MAX; select only when
  complete), `['reseller-tiers']`, `['custom-service-locations']`,
  `['custom-service-rules']`.
- Flag banner (`custom_service_flag_*`: the feature flag must be on).
- **Locations card**: one row per listed panel plus any location on an unlisted panel;
  columns panel (Copyable id/name), label, offered badge (not offered / offered /
  disabled), actions (Offer or Edit; Delete with **`window.confirm`**). **M**
  `deleteCustomServiceLocation` → T. Form card (keyed per panel): panel (fixed when
  editing, select or typed), label (required, max), enabled (Switch). **M**
  `saveCustomServiceLocation` → T `location_saved`.
- **Rules card**: columns dimension, label, range (VOLUME grouped GB / TIME days), unit
  price per GB/day, audience (ordinary / tier Copyable / customer link to `/users/:id`),
  panel (all / Copyable), enabled badge, actions (Edit; Delete with **`window.confirm`**).
  Rule form: dimension (VOLUME|TIME), label (max), minimum and maximum (VOLUME: GB ≤2
  decimals, 1 unit..max; TIME: whole days 1..`CUSTOM_SERVICE_MAX_DAYS`; max ≥ min),
  price (positive integer), audience (ORDINARY/TIER/CUSTOMER, with tier select or typed
  id, customer uuid), panel (all / select incl. a no-longer-listed id / typed), enabled
  (Switch). T created/saved/deleted. **E** `customServiceMessage`: overlap, rule not
  found, location not found, invalid + field (panelId/customerId/resellerTierId/count).
- Specificity card: ordered list of the four levels + four notes.
- Non-editors see info cards naming the key (`custom_service_edit_denied`).
- Tests: `custom-service.test.tsx` (also covers order-detail terms, owned by COMM-A).

### 1.7 `/discounts` — `DiscountsPage`

- **P**: `denied = !catalog.view`; `mayEditDiscounts = catalog.discounts.edit`;
  `mayEditCashback = catalog.pricing.edit` (separately; each form names its own key when
  missing).
- **Scope options**: `['products','for-pricing']` (limit PRODUCT_PAGE_MAX; select only if
  complete), `['product-categories']`.
- **Discount rules card**: filter pills kind (all/code/automatic) and status
  (all/active/inactive) — local state, trail keyed `kind|status`; **Q**
  `['discounts',sig,cursor]`. Columns: label + code (LTR), kind badge, value (N% or
  Money), scope (purposes; product/category Copyable name; customer link; first-purchase;
  minimum Money), window (always / from / until), usage (live redemptions of total limit
  or "unlimited"; per-customer limit), priority + stackable/exclusive badge, status
  badge, actions (Edit; Activate/Deactivate → **M** `transitionDiscount`, T). Empty:
  filter-empty vs none. Pager newer/older.
- **Discount form** (create/edit): kind + code (create only; edit shows them read-only
  with "locked" note and sends STORED values), label (required, max), type
  (PERCENTAGE|FIXED_AMOUNT), value (1..100 % or positive minor ≤ MAX), currency (fixed
  only; sales currencies + stored one), scope fields (purpose checkboxes in contract order;
  scope kind ALL/PRODUCT/CATEGORY with select or typed id; starts/ends `datetime-local`
  preserving the stored instant if untouched; start < end), customer id (uuid,
  optional), first purchase only (only with purposes = [NEW_SERVICE]), minimum subtotal,
  total limit, per-customer limit (1..1e9), priority (min..max), stackable. T created /
  saved; "created inactive" note.
- **Cashback rules card**: status pills, table (label, percent, scope, window, status,
  actions edit/activate/deactivate), form (label, percent MIN..MAX, scope fields).
- **Price preview card** (read-only tool, `catalog.view`): purpose (grantable operations
  minus CHANGE_LOCATION), product (select/typed) or add-on id, customer id, code → **Q**
  `['price-preview', asked]` → `GET PRICE_PREVIEW_ROUTE`; result KV (subtotal, discount,
  total, cashback line or "none", code verdict badge + reason) and rules table (label,
  kind, outcome badge APPLIED/SKIPPED/INELIGIBLE/CUSTOMER_DEPENDENT, reason).
- Scope card: 3 rules (no delete, usage, cashback).
- Tests: `discounts.test.tsx` (also covers order pricing, owned by COMM-A).

### 1.8 `/campaigns` — `CampaignsPage`

- **P**: `denied = !campaigns.view`; `mayManage = campaigns.manage` ("new" action).
- **Q**: `['campaigns','list',filter,cursor]` → `GET /campaigns?state=&cursor=`.
- **URL**: `?state=<CampaignState>` (pill change navigates with `replace`).
- Semantics banner (audience frozen, cancel undoes nothing, results).
- **Columns**: name (link), state badge (6 states, tones), window (start ← end, local
  moments LTR), action kinds text, confirmed audience count or "not confirmed".
- Pager: local trail.

### 1.9 `/campaigns/new` and `/campaigns/:id` — `CampaignNewPage`, `CampaignDetailPage`

- **P**: `denied = !campaigns.view`; `mayManage = campaigns.manage`; per-action editor
  keys from `campaignActionPermissions`: discount `catalog.discounts.edit`, cashback
  `catalog.pricing.edit`, wallet gift `users.wallet.mass`, service gifts (traffic/time)
  `services.mass.grant`, announcement `broadcasts.send`. An action without its key shows
  `NotPermitted` text and no checkbox (tested per `<section>` heading).
- New page: without view+manage → no-permission Empty. **Q** presentation (tenant
  calendar + timezone) via `fetchCampaigns({limit:1})` before the form renders.
- **Form sections** (each a `Card`/`<section>` with heading; tests rely on it):
  identity (name max, description max), window (start/end local date text `1405-07-10`
  - time, in the tenant calendar/zone), audience (`AudienceBuilder`), discount (toggle;
    kind AUTOMATIC/CODE + code `[A-Za-z0-9_-]{3,40}`, type, value, purposes, scope picker,
    minimum, total/per-customer limits, first purchase, stackable), cashback (toggle,
    percent, purposes, scope), gifts (wallet amount + notify; traffic GB + notify; time
    days 1..365 + notify; service-gift hint), announcement (toggle, body with placeholders,
    purpose MARKETING/SERVICE_ANNOUNCEMENT, up to `BROADCAST_BUTTONS_MAX` buttons
    label+URL). Footer: referral note, problem banner, "save draft" submit + hint.
    **V** `campaignBodyOf` (names the problem). **M** create/update → T `campaign_saved`,
    navigate to the campaign; **E** `campaignErrorMessage` (11 codes) as danger toast.
- **Detail**: PageHead title + description; Edit button (DRAFT && mayManage).
  Summary KV (state, window, action kinds, audience lines from `describeAudience`,
  confirmed count, scheduled at, cancelled at). Actions table (action, state badge,
  rule status badge, terms text, engine record: link to `/discounts` / broadcast / bulk
  words / failure `audience.changed` in words / raw failure code).
- **Confirm card** (DRAFT && mayManage): **Q** preview keyed by `updatedAt`; KV
  (audience, reachable, discount max liability or "not determinable", wallet count +
  total, traffic count, time count); announcement body preview; sample names; typed
  counts when `typedCountRequired.*`; "reviewed" checkbox; Confirm (disabled until
  reviewed) → **M** `scheduleCampaign` binding hash/fingerprint/counts/typed counts;
  answers reset whenever the preview binding changes (tested); on error refetch + toast.
- **Commands card** (mayManage): pause (ACTIVE), resume (PAUSED), launch pending
  (live && any PENDING/FAILED action), cancel (not COMPLETED/CANCELLED) with an inline
  confirmation banner (`campaign_cancel_confirm_*`, tested by button name) → **M**
  `commandCampaign` → T `campaign_command_done` / error toast.
- **Results card** (not DRAFT): targeted, discount redemption tallies, cashback tallies
  and totals (earned/reversed/unrecovered per currency), announcement tally, wallet
  tally + credited total, traffic/time tallies. Facts only, no revenue attribution
  (tested).
- Tests: `campaigns.test.tsx`.

### 1.10 `/broadcasts`, `/broadcasts/new`, `/broadcasts/:id` — `broadcasts.tsx`

- **P**: list/detail `denied = !broadcasts.view`; `maySend = broadcasts.send` (new
  button, composer, media, launch, steering).
- **List**: **Q** `['broadcasts', cursor]`, `?cursor=` in the URL (Previous returns to the
  first page). Columns: title (link), state badge (6), kind, recipients, progress %,
  created. Empty.
- **Composer** (new, and DRAFT detail, keyed by `version`): title (max), kind (6 content
  kinds), purpose, for FORWARD/COPY: source chat id + message id (LTR) + note; otherwise
  body/caption (`dir=auto`, max by kind) + placeholder legend; pin checkbox + hint;
  buttons (not for FORWARD; add up to max, remove last); live preview through the bot's
  own renderer `renderTemplateBody` (sample name); audience builder; Save/Create
  (disabled without title or a valid source). **M** create (idempotency key) / update
  (`expectedVersion`) → T `bc_saved`, navigate on create. Reports dirtiness to the page.
- **Media card** (non-TEXT, non-sourced kinds): metadata KV, file input (accept by kind,
  size bound by type, rejected banner), remove; **blocked while the composer is dirty**
  (tested).
- **Launch card**: source-verified banner (sourced kinds); Test send (**M**
  `testBroadcast` → ok/warn toast); Count (**M** `previewBroadcast`); preview KV
  (recipients, reachable, as-of); mode NOW/SCHEDULE (+ `datetime-local`); freeze
  warning; confirmation checkbox; typed count when ≥ `BROADCAST_LARGE_AUDIENCE`;
  Send/Schedule (danger) bound to version + hash + recipients + fingerprint → T
  `bc_launched`; preview cleared on error.
- **Report card** (non-DRAFT): counts KV (total, pending, sent, failed, unreachable,
  unconfirmed, skipped, cancelled, progress, pinned/pin-failed if pin), `<progress>`,
  bot-unavailable pause banner, unconfirmed hint; steering (maySend): pause (SENDING),
  resume (PAUSED), retry failed (failed>0), cancel with inline confirm (tested by name).
- **Recipients card**: state filter select, table (customer, state, attempts, error code,
  resolved at, pin state/code), local cursor trail; **polls every 5 s while SENDING**
  (`BROADCAST_LIVE_REFRESH_MS`), invalidated when the broadcast state changes. The detail
  query itself polls every 5 s while SENDING.
- **E** `broadcastMessage` (audience codes + 16 broadcast codes).
- Tests: `broadcasts.test.tsx`.

### 1.11 `/bulk-operations`, `/bulk-operations/new`, `/bulk-operations/:id`

- **P**: list/detail `denied = !bulk_operations.view`; "new" shown when
  `users.wallet.mass || services.mass.grant`; new page kinds gated per key (wallet /
  traffic+time); detail steering/cancel gated by the key of the operation's kind.
- **List**: `?cursor=`; columns kind (link), grant (Money / GB / days), state badge (4),
  items, progress %, created.
- **New**: kind select (only permitted kinds), amount (wallet, tenant currency from
  audience options) / traffic GB (`TRAFFIC_GB_PATTERN`) / days; notify checkbox;
  audience builder; any change resets the preview. Preview (**M**
  `previewBulkOperation`): KV (count of customers/services, distinct customers, total
  liability, as-of), sample table; when count>0: danger banner, reason (required, max),
  typed count (must equal), confirmation checkbox, Execute (danger) bound to hash,
  count, fingerprint, total → T `bulk_started`, navigate to detail. **E**
  `bulkMessage`.
- **Detail**: report KV (state, grant, items, liability, credited total, 7 item counts,
  awaiting reconciliation, notified, notice queued, progress, reason, created by/at,
  not-before, as-of), `<progress>`, cancel/pause notes, frozen-audience note, audience
  lines; pause/resume/cancel (inline confirm) when RUNNING/PAUSED and permitted. Items
  card: state filter, table (customer, service, state — PLANNED+UNKNOWN reads "awaiting
  reconciliation" — why (skip reason words / failure kind code), notice state), trail.
  **Polls every 5 s while RUNNING** (detail and items; items invalidated on state change).
- Tests: `bulk-operations.test.tsx`.

### 1.12 Audience builder (`audience-builder.tsx`, used by broadcasts, bulk, campaigns)

- **Q** `['audience-options']` (tiers, products, panels, currency); **M**
  `previewAudience` (Count button → customers/reachable KV; error banner).
- Fields (ids `aud-*`): who (ordinary + each reseller tier checkbox; none = everyone),
  customer ids textarea (LTR, split on whitespace/commas), purchase, customer status,
  trial, referral filters, registered from/before (date), account age min/max, last
  purchase from/before, no purchase for N days, wallet balance min/max (tenant currency
  label), service filter toggle → products, panels, service states checkboxes, expiring
  within hours (exclusive with expired), expired. `disabled` prop supported.
- `describeAudience` renders the saved definition in words (detail pages).

### 1.13 `/referrals` — `ReferralsPage` (+ referral banner, + `ReferralAnalytics`)

- **P**: `denied = !referrals.view` (read-only page; nav on that key alone);
  `mayViewBanner = settings.view`, `mayEditBanner = settings.edit`;
  `superAdmin` (owner + reports.view) → analytics; `mayExportReports` (owner +
  reports.export).
- **Referrer filter**: `?referrerId=` (uuid-validated inline error; Apply submit; Clear
  link). Narrows BOTH lists.
- **Analytics** (superAdmin): see 1.18 `ReferralAnalytics`.
- **Attributions**: **Q** `['referrals', referrerId, cursor]`; columns referrer and
  referee (`PartyCell`: link to `/users/:id`, name or Telegram id LTR), trigger badge,
  created. Default-label pager.
- **Commissions**: state pills (all/pending/earned/void), **Q**
  `['referral-commissions', referrerId, state, cursor]`; columns order link (8-char LTR),
  referrer, referee, scope, percent, basis, promised, state badge, earned (dash when
  null, never 0), reversed, unrecovered, created, settled. Unrecovered warn banner.
- **Banner card** (settings.view): **Q** `['tenant-media','REFERRAL_BANNER']` metadata
  only (type, size, version, updated, SHA-256 LTR) — never the bytes; empty state.
  Editor (settings.edit): file input (PNG/JPEG, ≤ `TENANT_MEDIA_MAX_BYTES`, invalid type /
  too large / unreadable → inline field error, nothing sent), Upload (base64 under the
  declared type) → T; Clear → T. Otherwise "read only" sentence.
- Scope card (3 rules).
- Tests: `referrals.test.tsx`, `referral-banner.test.tsx`,
  `referral-banner-stale-options.test.tsx`, part of `reports.test.tsx`.

### 1.14 `/resellers` — `ResellersPage` (+ standing cards, + policy card)

- **P**: `denied = !resellers.view`; `mayEdit = resellers.edit` (register/edit form, edit
  buttons); `mayViewWallet = users.view` (credit standing + debt acknowledgement),
  `mayViewOrders = orders.view` (purchases), `mayViewAudit = audit.view` (history),
  `mayViewCatalog = catalog.view`, `mayViewPanels = panels.view` (policy pickers).
- **URL**: `?search=` (applied search; Clear link), `?register=<customerId>` (prefills the
  register form — linked from the user detail).
- **Filters**: status pills (all/active/suspended) and tier select — local state; trail
  keyed on search|status|tier.
- **Q**: `['reseller-tiers']`, `['resellers', sig, cursor]`.
- _Since 2026-10-01 (owner decision, `docs/reseller-phase3-closure.md` §5) there is no
  reseller credit: the credit-limit column and fields, `debtWarningOf` and the
  acknowledgement are gone, and `ResellerCreditCard` became `ResellerBalanceCard` (balance,
  and a legacy-debt line only when negative). The notes below record the redesign as built._
- **Columns**: reseller (link to `/users/:id`, name or Telegram id, Telegram id subline),
  tier, status badge, pricing (override label + %), credit limit (effective Money + own/
  from-tier), actions: "standing" (opens the standing section below for that customer),
  Edit (mayEdit; also opens standing).
- **Register/Edit form**: no-tiers warning with link; customer id (register, uuid) or
  identity KV (edit); tier; status (edit); pricing mode (TIER/LIST/PERCENTAGE) with the
  tier's current pricing shown; percent 1..99; own limit checkbox → amount (≤ max) +
  currency, else "uses tier limit" Money. **Debt acknowledgement**: `debtWarningOf` when
  lowering the limit below the debt or suspending a reseller who owes (needs credit
  standing, `users.view`), checkbox resets on any change; Save disabled until
  acknowledged. **M** register/update → T; invalidates resellers, tiers, credit,
  history; `setQueryData(['customer-reseller', id])`.
- **Standing section** (when a row is opened): `ResellerCreditCard` (state badge,
  effective limit + source, balance, allowance, in use, available, over limit; over-limit
  and currency-mismatch banners; 2 rules; denied banner without `users.view`),
  `ResellerPurchasesCard` (confirmed, order + state badge, purpose, terms tier·layer·%,
  list, cost, promotion, sale; cursor trail; denied without `orders.view`),
  `ResellerHistoryCard` (when, action words, actor type + label, result badge, changed
  fields; denied without `audit.view`), `ResellerPolicyCard` (see 1.16).
- Scope card (3 rules) + links to `/reseller-tiers`, `/reseller-plans`.
- Tests: `resellers.test.tsx`, `reseller-standing.test.tsx`.

### 1.15 `/reseller-tiers` — `ResellerTiersPage`

- **P**: `denied = !resellers.view`; `mayEdit = resellers.edit`; `mayViewCatalog`,
  `mayViewPanels` (grant pickers; typed ids otherwise; BOT always typed);
  `mayViewAudit` (tier history).
- **Q**: `['reseller-tiers']`; grant options only while a grants panel is open.
- **Columns**: name, pricing, credit limit, reseller count, grants summary (per kind:
  none [danger] / all [ok] / N [info]; "sells nothing" when a dimension is blocked),
  actions (Edit [mayEdit], Grants, History).
- **Grants editor** (mayEdit) / read-only view: blocked-dimensions warning, per kind a
  radio NONE/ALL/SOME + checkbox list (incl. stored ids no longer listed) or typed
  textarea; **V** `grantsBodyFrom` (non-empty SOME, valid ids/operations, ≤ max);
  **M** `replaceResellerTierGrants` → T; invalidates tiers, tier history, policy.
- **Tier history**: `TierHistoryCard` (audit.view).
- **Tier form**: name (max), pricing mode (LIST_PRICE/PERCENTAGE_DISCOUNT), percent
  1..99, credit limit minor + currency. T created/saved; "created empty" note.
- Scope card (4 rules) + link to `/resellers`.

### 1.16 `/reseller-plans` — `ResellerPlansPage` (+ `ResellerPolicyCard`)

- **P**: `denied = !resellers.view`; `mayEdit = resellers.edit`; `mayViewOrders =
orders.view` (progress card), `mayViewCatalog`, `mayViewPanels`.
- **Tiers table**: name, products (catalogue grants in words), panels (grants in words),
  pricing, monthly minimum (Money or "none"), actions (edit products = grants editor or
  read-only card; edit minimum [mayEdit]).
- **Tier minimum form**: amount (digits ≤ max; 0 = none) + currency → **M**
  `setResellerTierMinimum` → T; invalidates tiers, minimums, policy, tier history.
- **Minimum progress card** (`orders.view`, else info banner): period pills
  (this/previous month) and filter pills (all/achieved/below) sent to the server; KV
  period (local dates LTR) + timezone; "running" note; 4 stat counts; truncated warning;
  table (reseller link, tier + status badge when not active, minimum + source, achieved,
  remaining, progress bar (SVG, floored %), state badge, "policy" button).
- **Policy card**: tier + status, suspended warning, entitlements table (dimension, tier
  value, override value or "inherited", effective + source badge), pricing KV (tier,
  override, effective layer + %), minimum KV (tier, own, effective + source), products
  preview (null → "needs catalog.view"; partial note; empty; table product / can sell
  (allowed/refused + dimension)); Edit (mayEdit) → **OverrideEditor**: per dimension
  INHERIT/OWN radio + kind editors (only OWN dimensions sent) → **M**
  `replaceResellerOverrides` → T; minimum INHERIT/NONE/OWN + amount → **M**
  `setResellerMinimum` → T.
- Rules card (5 rules) + links to `/features`, `/settings`, `/resellers`.
- Tests: `reseller-plans.test.tsx`.

### 1.17 `/reports` — `ReportsPage` (`business.tsx`, `report-view.ts`)

- **Business gate**: `denied = !superAdmin` where `isSuperAdmin = role owner AND
reports.view`; nav entry `ownerOnly`; denied renders the owner-only Empty + no-logs note
  and fetches nothing (tested). `mayExport = owner AND reports.export`; export links are
  `<a download href={reportExportUrl(range, report, csv|xlsx)}>` (server-rendered).
- **Range**: `?range=` one of 8 (`TODAY`, `YESTERDAY`, `LAST_7_DAYS`, `LAST_30_DAYS`,
  `THIS_MONTH`, `PREVIOUS_MONTH`, `THIS_YEAR`, `CUSTOM`), default `THIS_MONTH` here
  (`TODAY` on the dashboard overview, `LAST_30_DAYS` for referral analytics);
  CUSTOM adds `?from=&to=` local dates in the tenant calendar (form, applied on submit,
  re-keyed when the URL moves); queries are disabled until a custom range is complete.
- **Tabs** (`?tab=`): sales, products, services, payments, wallet, infrastructure,
  resellers, failures (invalid → sales). Accessible `Tabs`/`TabPanel`.
- **Polling**: every report query `refetchInterval: pollUnlessFinal(300 000 ms)`
  (tested: not faster); Refresh button invalidates `['reports']`.
- **Sales tab**: KPI card (sales, revenue per currency, successful orders, new users,
  new services, renewals, wallet top-up + count, active services now) each with
  `ChangeNote` (+x% / −x% / "new" / dash; basis-point math, never ∞), sub-stats (new
  buyers, active customers, trial services, discount per currency), period note
  (current/previous spans, generated-at in tenant zone+calendar, lengths differ);
  Trend card (metric pills REVENUE/SALES/NEW_USERS/RENEWALS; `TrendChart` current +
  previous with an accessible readout; gaps are dashes; other-currencies note; empty);
  Orders drill-down (purpose pills; columns settled at, purpose, product title,
  gross, discount, total, method, links to order and customer; cursor paging reset per
  range; CSV/XLSX `SALES`).
- **Products tab**: ranking pills (count/revenue), page-number paging (25/page; 10 in
  compact), columns rank, product (+category emoji/name), lifecycle badge, orders,
  revenue; export `PRODUCTS`. Compact version (dashboard) links "view all".
- **Services tab**: stats (new, trial, active, traffic sold GB + unlimited lines),
  operations table (purpose, orders + change, revenue per currency), states table.
- **Payments tab**: rows by method × provider × kind (attempts, confirmed, failed
  terminal, pending+unknown, success rate, confirmed amounts); total success rate;
  export `PAYMENTS`.
- **Wallet tab**: groups table (group, entries, net amount), balances, reasons table
  (reason LTR, group, direction, entries, amount); export `WALLET`.
- **Infrastructure tab**: per panel and per provider (created, active, traffic sold,
  unlimited lines, provisioning failures); truncated note; "location unsupported" note;
  export `INFRASTRUCTURE`.
- **Resellers tab**: reseller (link `/resellers/<id>` — **see defect D1**), tier, status,
  orders, sales, services, credit in use / limit; export `RESELLERS`.
- **Failures tab**: stats (failed payments, failed provisioning, failed commercial,
  refunded orders, unknown now) + failure kinds list.
- No-logs note under every tab.
- `BusinessOverview` (dashboard, Super Admin): range picker (default TODAY) + link to
  `/reports`, KPI card, trend, compact top products, failure summary.
- Tests: `reports.test.tsx` (dashboard-overview assertions render `DashboardPage`).

### 1.18 `ReferralAnalytics` (in `business.tsx`, rendered on `/referrals`)

- Owner only (not rendered and not asked otherwise). Range picker (default
  LAST_30_DAYS, shares `?range`), Refresh, CSV/XLSX `REFERRALS` (mayExport). KPIs:
  signups (+change), converted buyers + conversion rate, signup gifts, commissions,
  referred revenue + sales. Top referrers: ranking pills (signups/buyers/revenue/
  commission), page paging (10), table rank, referrer (link by id only), signups, buyers,
  revenue, commission. Period note.

---

## 2. Mapping to the reference composition

Kit names below are the brief's §3 names; Phase 2 uses whatever FOUND ships under them.

### Shared layout patterns I will use

- **List page**: `PageHead` (title, subtitle, primary action on the start side) →
  one `Card` holding a `FilterBar` (search box + filter chips, the reference
  `dark-products`/`dark-resellers` treatment) → dense `Table` → `Pagination` in the card
  foot. Page-specific notes/rules move to a compact muted "rules" card at the bottom
  (kept, never removed).
- **List + editor pages** (categories, extra devices, service locations, custom service
  locations/rules, tiers): two-column grid on wide screens — table card (main) + editor
  card (side), as `dark-categories` does with its side card; single column below the
  breakpoint. The editor stays a real, always-rendered card (tests find its inputs by id
  without extra clicks); "new …" in the PageHead is an in-page link to it.
- **Detail/editor pages** (product, campaign, broadcast, bulk op): `PageHead` with the
  status badge beside the title and grouped actions; a summary strip of `StatCard`s /
  `DefinitionList`; sectioned form cards with a sticky **section sub-nav** (anchors) like
  `dark-product-editor`; side column for read-only facts/help; destructive or
  state-changing actions isolated in their own clearly marked card. Sections stay
  rendered (not hidden behind step tabs) so every field remains reachable and every test
  that fills several sections keeps working.
- **Row actions**: primary action as a small button; secondary ones grouped (a row
  `Menu` if the kit has one, otherwise a compact `ButtonGroup`).
- Destructive confirmations: kit `ConfirmDialog` replaces `window.confirm` (three places)
  with the same button labels; inline confirm banners that tests address by button name
  (campaign/broadcast/bulk cancel) may become `ConfirmDialog` with identical labels.

### Per page

| Page                            | Reference                                | Composition in Phase 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/products`                     | `dark-products`                          | PageHead (actions: categories link, "new product" anchor). Card: search + 3 chip rows (status, audience, category incl. "بدون دسته") → dense table (title link w/ category subline, status, catalogue badge, category, audience, price, duration, traffic, sort) → pager foot. Create form card below; scope/rule card last.                                                                                                                                                                                                                                                                                                                                  |
| `/products/:id`                 | `dark-product-editor`                    | PageHead: title = product title, status + catalogue badges beside it, subtitle category · id. Gap banner. Grid: section sub-nav (پایه، قیمت، حجم و مدت، پنل، نمایش، ترتیب) · form card split into those sections (same fields/ids) with explicit Save · side column: facts `DefinitionList` (created/updated, panel id Copyable, device default), category-move card, isolated status card (activate / deactivate, note).                                                                                                                                                                                                                                     |
| `/product-categories`           | `dark-categories`                        | PageHead (back to products, "new category" anchor). Grid: table card (name+emoji, count, status, visibility, actions: edit + menu for toggle/visibility/move/delete) · side form card. Notes under the table.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `/extra-devices`                | (products family)                        | Capability banner → grid: rates table (pager) · side form.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `/service-locations`            | (products family)                        | Capability banner → grid: locations table · side form. Limit-pair warning inline at the field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `/custom-service`               | (products family)                        | Flag banner → two list+side-form grids (locations, rules) → specificity card.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `/discounts`                    | `dark-discounts`, `dark-discount-editor` | PageHead (link to campaigns). Discount card: kind/status chips → dense table (label + mono LTR code, value badge, scope, window, usage with a CSP-safe progress bar when a total limit exists, priority/stackable, status badge, actions) → pager. Discount form as a sectioned card (کد و مقدار · محدودیت استفاده · بازه · دامنه · اولویت) with a segmented type control and a currency/percent input addon. Cashback card and form the same way. Price preview as a "tool" card: inputs row + result `DefinitionList` + outcomes table.                                                                                                                     |
| `/campaigns`                    | `dark-campaigns`                         | PageHead (new campaign, link to discounts). Semantics callout. Card: state chips → table (name link + actions subline, state badge, window, action kinds as small badges, confirmed audience) → pager.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `/campaigns/new`, edit          | `dark-campaign-editor`                   | PageHead + section sub-nav (هویت، بازه، مخاطب، تخفیف، کش‌بک، هدیه‌ها، اطلاعیه). Each action stays its own `<section>` card with heading and toggle. Side column: help card with the existing semantic notes. Sticky footer with the draft Save.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/campaigns/:id`                | `dark-campaign-editor` (detail)          | PageHead: name + state badge, Edit action. Summary strip (state, window, audience confirmed, actions). Actions table. Confirm card (preview figures as stat cards, typed counts, reviewed, Confirm). Commands card isolated (pause/resume/launch/cancel w/ confirmation). Results card.                                                                                                                                                                                                                                                                                                                                                                       |
| `/broadcasts`                   | `dark-notifications` family              | PageHead (new). Card: table (title link, state badge, kind, recipients, progress bar + %, created) → pager.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `/broadcasts/new`, `/:id`       | `dark-notification-compose`              | PageHead: title + state badge. Summary card. DRAFT: grid composer sections (محتوا، دکمه‌ها، مخاطبان) · side **live preview** in a Telegram-bubble frame fed by the real `renderBroadcastPreview` (+ buttons), media card, launch card (test, count, stat pills, mode, confirmations, send). Non-DRAFT: report (stat cards + progress + steering) and recipients table with state filter.                                                                                                                                                                                                                                                                      |
| `/bulk-operations`, new, `/:id` | same family                              | List as broadcasts. New: grant card, audience card, preview card (stat cards, sample table, danger zone with reason/typed count/confirm/Execute). Detail: PageHead kind + state badge, stat strip + counts `DefinitionList`, steering isolated, items table with state filter.                                                                                                                                                                                                                                                                                                                                                                                |
| Audience builder                | compose "گیرندگان"                       | Grouped sub-sections: "چه کسانی" (segment chips), filters grid (two columns, single below breakpoint), collapsible service filter, Count button with result as inline stat pills. Same ids and fields.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `/referrals`                    | — (list family)                          | PageHead; filter bar (referrer id); owner analytics as KPI stat grid + top-referrers table; attributions and commissions dense tables (commission state chips); banner card (metadata `DefinitionList`, file control); rules card.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `/resellers`                    | `dark-resellers`, `dark-reseller-detail` | PageHead (register action anchor). Card: search + status chips + tier select in one FilterBar → table (reseller with initials avatar + Telegram id LTR, tier, status, pricing, credit limit + source, actions) → pager. Standing: **decision D-A below**.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `/reseller-tiers`               | (resellers family)                       | Tiers table (grants summary as compact badges) → opened panel (grants editor or read-only; tier history) → tier form side/below; rules card.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `/reseller-plans`               | (resellers family)                       | Tiers table; grants editor / minimum form when opened; progress card: chips + period facts + 4 `StatCard`s + table with CSP-safe progress bars; policy card; rules card.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `/reports`                      | `dark-reports`                           | PageHead with period control (8 ranges as a segmented control + custom from/to), Refresh, exports per report (only for `mayExport`). Tabs (8). Sales: KPI `StatCard` grid with delta chip and semantic direction only where the metric has one (revenue/sales/new users/renewals up = good), inside a section titled «شاخص‌های اصلی»; `ChartCard` with the existing `TrendChart` (current + previous); orders drill-down table. Payments: add a `Donut`/`HBars` of confirmed attempts by method from the rows already fetched (textual table stays). Services: HBars of orders by purpose from `operations` (table stays). Others: dense tables + stat cards. |

### Reference content NOT carried over (no data in Nexa — not added)

- Products: 30-day sales / revenue / bestseller / average-basket KPI row; per-product
  sales, revenue, conversion, location flags; "store preview" toggle; "change order" for
  products; bot preview and 30-day performance cards in the product editor; "copy" and
  "archive" and "delete product" (no such operations — deactivate is what exists).
- Categories: the "bot view" preview (the web has no authoritative rendering of the
  bot's category menu); per-category "active products" count (only `productCount`).
- Discounts: "sales with code" column; editor performance and bot-preview cards.
- Campaigns: channel column, delivery / click / purchase percentages, duplicate action;
  step wizard with message preview for non-announcement campaigns.
- Compose: precomputed segment counts in the audience list (Nexa counts on demand).
- Resellers: 30-day reseller sales / share / negative-balance / active-bot KPIs, per-row
  balance, sales sparkline, sales-bot column, reseller expiry; detail tabs for bot and
  panels & prices beyond what the policy card holds; "message resellers" and "settle"
  actions; 12-week performance chart.
- Reports: order-mix stacked columns per bucket (the trend endpoint returns one metric
  per request; if DASH adds a purchases-vs-renewals aggregate for the dashboard I will
  reuse it rather than compute a second answer); sales by location (the server states
  it is unsupported); busy hours; "scheduled report"; the compare-with-previous toggle
  (Nexa always shows the previous period; a toggle is only added if the kit's period
  control provides it, as presentation).

### Current capability the reference lacks (all kept)

Catalogue gap badges and the category "none" filter; extra devices, service locations
and custom service pages entirely; cashback rules and the price preview; campaign
multi-action composition, typed-count confirmation and results tallies; broadcast
forward/copy sources, media, pin, test send, scheduling, recipients drill-down, retry
failed; bulk operations; referral commissions ledger, referral banner and owner
analytics; reseller credit standing, purchases, audit history, tier grants,
monthly minimums and policy overrides; the 8 report ranges, 8 tabs, exports, orders
drill-down and failure report.

---

## 3. Kit components needed (and flags)

Needed from FOUND (brief §3 names): `PageHead` (status badge slot next to the title,
actions), `Card` (**must keep rendering `<section>` + heading**, title/hint/actions/foot),
`StatCard` (+ delta), `Badge`/`StatusDot`, `Button`/`ButtonGroup`/`IconButton`,
`Input`/`Textarea`/`Select`/`Checkbox`/`Radio`/`Switch`, `Field` (label ↔ control, hint,
inline error), `Search`, `FilterBar` + chips (the current `Pills` semantics:
`aria-pressed`, `role=group`), `Table` (dense, sticky header, `align:'end'`, caption),
`Pagination` (cursor pager with custom next/previous labels **and** a page-number
variant for reports), `Tabs`/`TabPanel` (current a11y behaviour), `ConfirmDialog`,
`Toast`, `EmptyState`/`LoadingState`/`ErrorState`/`PermissionDeniedState` (the current
`StateSwitch` contract incl. stale-after-error), `ChartCard`, `Metric`,
`DefinitionList` (`KV`), `Copyable`/`Ltr`/`Money`/`Num`, `ListEditor`.

Plausibly missing — I would ADD these (no change to existing APIs) unless FOUND ships
them:

1. **Section sub-nav** (vertical anchor list, sticky) for long editors — product,
   discount, campaign, broadcast. OPS's settings needs the same thing; better in the kit.
2. **Row action menu** (`Menu`/kebab) for rows with 4–6 actions (categories, tiers).
3. **Progress bar** (CSP-safe SVG, tone, accessible value) — discount usage, broadcast
   and bulk progress, reseller minimums (today a private `ProgressBar` in
   `reseller-plans.tsx` and native `<progress>`).
4. **Input addon / group** (currency or `%` suffix inside the field) — discount value,
   prices, limits.
5. **Segmented control** (single choice, e.g. discount type, NOW/SCHEDULE) — may be the
   same component as the period control.
6. **Period control** (preset ranges + custom from/to) — shared with DASH; the reports
   need all 8 ranges and URL-backed state.
7. **Charts beyond `TrendChart`**: `Donut`/`HBars` (+ `Legend`) ported without inline
   styles. `TrendChart` must keep `.trend-readout`, `polyline.current/previous` and
   `data-testid="trend-slot-N"` or the reports test is migrated to equivalent roles.
8. **Telegram preview frame** (reference `TelegramPreview`) — only fed with text the
   real renderer produced (broadcast composer and detail, campaign announcement).
9. **Avatar (initials)** for reseller rows, if the kit has `Who`/`Avatar`.
10. **Dirty-state guard** (`useUnsavedChanges(dirty)`: `beforeunload` + a confirm on
    in-app `navigate`) — brief §8 requires dirty-state protection and none of my forms
    has it today (only the broadcast composer tracks dirtiness, to block media). The
    in-app half needs a hook in `router.ts` (shared) — needs FOUND/lead.

---

## 4. Pre-existing defects found during the inventory (not fixed in Phase 1)

- **D1** `business.tsx` Resellers report links each row to `/resellers/<customerId>`,
  a route that does not exist — it resolves to NotFound. Fixed naturally by decision D-A
  (option 1); otherwise the link should go to `/users/<customerId>`.
- **D2** The campaign form's `Field`s have no `htmlFor`/ids, so most campaign inputs have
  no programmatic label (brief §11 "labelled inputs"). Phase 2 adds ids.
- **D3** Service-location **delete** has no confirmation; category and custom-service
  deletes use `window.confirm`. Phase 2 puts all four behind `ConfirmDialog` (tests
  updated to answer the dialog instead of stubbing `window.confirm`, same assertions).
- **D4** No dirty-state protection on any of these forms (see kit item 10).
- **D5** The broadcast and bulk lists keep one cursor in the URL, so "previous" from
  page 3 returns to page 1. Existing behaviour; unchanged unless the lead wants a trail.

---

## 5. Decisions I need from the lead before Phase 2

- **D-A Reseller detail.** The reference has a reseller detail page; Nexa shows standing
  inline under the list when a row is "opened". Options:
  1. Add `/resellers/:customerId` (one entry in the `resolve()` route table, keyed by id,
     `resellers.view`), presentation only over existing endpoints
     (`GET /resellers/:id`, `/credit`, `/purchases`, `/history`, `/policy`): header card
     with badges + summary strip, tabs Overview (terms + edit form) · Credit · Purchases ·
     Policy · History. Row "standing" becomes a link. Fixes D1. Tests in
     `resellers.test.tsx`/`reseller-standing.test.tsx` move from "click opens below" to
     rendering the detail route — same assertions.
  2. Keep the inline section, restyled as a detail panel with the same tabs.
     I recommend 1; it touches `app.tsx` (one route block, no nav change).
- **D-B `BusinessOverview` on the dashboard.** DASH will likely replace it. If DASH stops
  rendering it, the dashboard-overview assertions in `reports.test.tsx` belong to DASH's
  tests and I delete `BusinessOverview` only once nothing imports it; until then I keep
  its export stable.
- **D-C Category/extra-device/location editors**: side card (my default) vs `Drawer`.
- **D-D** Whether inline cancel confirmations (campaign, broadcast, bulk) should move to
  `ConfirmDialog` for consistency (labels unchanged) or stay inline.

---

## 6. Phase 2 plan (after FOUND merges)

1. Merge `origin/main`; read FOUND's kit API and family-stylesheet layout.
2. Rebuild in this order, one logical commit per family: products (list, detail,
   categories, extra devices, service locations, custom service) → discounts → audience
   builder + broadcasts + bulk → campaigns → referrals → resellers (+ standing, tiers,
   plans) → reports (`business.tsx`).
3. Page CSS only in my family stylesheet; new i18n keys (section names, "danger zone",
   etc.) in a localized block of `web.fa.ts`, each rendered (`check-i18n-keys`).
4. Tests: update the files listed in §1 without weakening; add tests for the
   ConfirmDialog deletes (D3), the campaign labels (D2), the reseller detail route
   (if D-A=1) and any new kit component I add.
5. Screenshots via FOUND's harness (fixtures added to `scripts/visual/fixtures.mjs` or its
   successor) at dark 1440×900, light, ~900px; compare with `dark-products`,
   `dark-product-editor`, `dark-categories`, `dark-discounts`, `dark-discount-editor`,
   `dark-campaigns`, `dark-campaign-editor`, `dark-notification-compose`,
   `dark-resellers`, `dark-reseller-detail`, `dark-reports`.
6. `pnpm build`, then `pnpm verify` once; push; report. If the diff is too large for one
   PR I will propose a split at step 2's boundary (catalogue+pricing | messaging+mass
   ops+campaigns | resellers+referrals+reports).

---

## 7. Phase 2 — what changed, and what was kept

Built on FOUND's kit (`ui/kit.tsx`, `ui/charts.tsx`, `ui/unsaved.tsx`). Page CSS is only
in `styles/pages/commerce-b.css`, every class prefixed (`cb-` for the family's shared
editor pieces, `products-`, `categories-`, `discounts-`, `bc-`, `bulk-`, `campaign-`,
`referrals-`, `resellers-`, `tiers-`, `report-`, `aud-`, `custom-`). No kit class is
restyled; no `style` attribute is written. No backend, contract or route-table change.

### 7.1 Shared pieces added (page level, `pages/editor-layout.tsx`)

- `SectionNav` — the sticky section list beside a long editor. Buttons, not `#hash`
  links: a hash link is a history entry, which the router treats as a navigation on a
  dirty page. Hidden below 980px.
- `FormSection` — one titled section of a sectioned form card (`form-section` +
  `form-grid`), focusable so the nav can land on it.
- `SaveBar` — the editor foot: the unsaved marker (`web.unsaved_changes`) while the form
  differs from what it loaded, then the explicit Save.
- `CheckField`, `ChipGroup`, `revealField` — a checkbox laid out as a field, a labelled set
  of chips inside one filter row, and "scroll to and focus" after the click's render.

Every editor now calls `useUnsavedChanges(dirty)`; `dirty` is the form against what it
loaded or last saved. A save that navigates (new broadcast, new campaign, started bulk
operation) passes `{ force: true }`, because the work is saved.

### 7.2 Per route

| Route                             | Phase 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/products`                       | Head actions (categories, new product → focuses the create form). One card: flush search + two chip rows (status·audience, category incl. «بدون دسته»), dense sticky table — category under the title, duration·traffic in one cell, the catalogue gap as a wrapping dot-and-sentence (a badge held a sentence and pushed columns off the card), price/sort right-aligned. Create form sectioned; rules card muted.                                                                                                                                                                                                       |
| `/products/:id`                   | Title + status badge in the head, id as meta. Section nav · sectioned edit form (پایه، قیمت‌گذاری، حجم و مدت، پنل و دسته‌بندی، نمایش در ربات) with save bar and leave guard; each `bodyFrom` problem is shown at its field (a pristine create form shows none). Side column: identity facts, the category move card, the status card (danger-toned while ACTIVE).                                                                                                                                                                                                                                                         |
| `/product-categories`             | List + sticky side form. Row actions: ghost Edit/Activate/Hide, icon move up/down (same accessible names), icon Delete → **ConfirmDialog** (was `window.confirm`). Notes as a list.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `/extra-devices`                  | Head "add", dense table with kit row actions, form in one 3-column grid with save bar; the max-quantity rule is the field's error (was a banner).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `/service-locations`              | Label + key in one cell, dense table, **delete now asks** (ConfirmDialog; it asked nothing — D3). Form in three sections (کجا · عرضه و هزینه · محدودیت‌ها); the limit-pair rule is the period field's error.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `/custom-service`                 | Locations: list + side form. Rules: list then a full-width form. Both deletes via ConfirmDialog; switches as labelled lines; save bars and leave guards.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `/discounts`                      | Chip sets (kind, status) in a flush filter row, dense tables, code in mono under the label, value/kind as badges, live redemptions with a CSP-safe `Progress` against the total limit. Discount and cashback editors sectioned (کد و مقدار · دامنه · بازه · محدودیت استفاده · اولویت و ترکیب), segmented calculation type, unit addons, save bars, leave guard. Price preview: inputs in one grid, the quote beside the rules it was decided by.                                                                                                                                                                          |
| `/campaigns`                      | State chips, dense table, action kinds as tags, links to discounts and new.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/campaigns/new`, edit            | Section nav beside the seven cards (each still a `<section>` with its heading), sticky save bar, leave guard. **Every input has an id and `htmlFor`**, purposes a legend (D2).                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `/campaigns/:id`                  | State badge in the head; main: actions, preview-and-confirm (figures as stat cards, typed counts, reviewed box, Confirm), results; side: summary, the command card (danger-toned). Cancel asks through ConfirmDialog with its existing words.                                                                                                                                                                                                                                                                                                                                                                             |
| `/broadcasts`                     | Dense table, state badge with a live dot while sending, progress bar + %.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `/broadcasts/new`, `/:id` (DRAFT) | Composer sectioned (محتوا · دکمه‌ها · مخاطبان) with the message in a chat bubble beside the fields (the bot's own `renderTemplateBody`), save bar, leave guard. Media and launch cards; launch keeps count → mode → checkbox → typed count, and **adds a final ConfirmDialog** before anything is sent or scheduled.                                                                                                                                                                                                                                                                                                      |
| `/broadcasts/:id` (sent)          | Head badge; report as stat cards + progress + the remaining counts inline; steering buttons with cancel through ConfirmDialog; recipients with a toolbar filter and state badges; summary card at the side.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/bulk-operations`                | As broadcasts. New: grant grid, audience, preview as stat cards, the danger block (reason, typed count, checkbox) and **a final ConfirmDialog** before Execute. Detail: head badge, stat strip, report card, summary and an isolated steering card; cancel through ConfirmDialog.                                                                                                                                                                                                                                                                                                                                         |
| Audience builder                  | "Who" as selectable tiles, filters grouped (ویژگی‌های کاربر · زمان عضویت و خرید · موجودی کیف پول) in three-column grids, the service filter as a framed block, the count beside its button. Same ids.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `/referrals`                      | Compact referrer filter bar, dense tables, money right-aligned, commission state chips, banner card beside the rules. Owner analytics as stat cards + ranking chips.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `/resellers`                      | Head actions (tiers, plans, register). Search + tier select + status chips; initials avatar, tier tag, row actions; opened row highlighted. **Standing** (decision D-A: kept inline, no new route): DetailHead (who, tier, status, terms strip, close) then edit form, policy, purchases and history beside the credit card, which gains an in-use `Meter`.                                                                                                                                                                                                                                                               |
| `/reseller-tiers`                 | Row actions, opened grants/history scrolled to, grants summary in two columns, tier form with save bar and leave guard beside the rules.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `/reseller-plans`                 | Row actions; minimum progress with chip sets, stat cards and the kit `Progress` (replacing the private `ProgressBar`); rules as a list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `/reports`                        | Range as a segmented control of the eight ranges (custom still applies on submit), KPIs as kit stat cards with the change as a **neutral** delta (never judged, spec §23) and the definition as the tile tooltip; trend in a `ChartCard` with metric chips and a current/previous legend (`TrendChart` and its readout unchanged); chips for rankings and the drill-down purpose; dense tables. New charts from rows already fetched: services orders per purpose (`BarChart`, current vs previous), payments confirmed per method (`Donut`); the tables stay. Resellers report links go to `/users/<id>` (**D1 fixed**). |

### 7.3 Decisions taken without the lead (§5)

- **D-A** option 2: the standing stays inline, now a detail panel; no route added
  (`app.tsx` untouched). D1 is fixed instead by linking the report to the customer page.
- **D-B** `BusinessOverview` keeps its export and signature; it inherits the new KPI cards.
- **D-C** side card for the short editors (categories, custom-service locations); a
  full-width form under the list where the table is wide (extra devices, locations, rules).
- **D-D** inline cancel confirmations moved to ConfirmDialog with the **same** labels.

### 7.4 Capability checklist

Each line is §1's inventory item, checked against the Phase 2 code and the suite.

- [x] 1.1 products: both queries and gates; four URL filters incl. `none`; draft follows the
      applied title; signature-keyed ascending trail (newer/older); search vs catalogue empty;
      nine catalogue gaps in server order; unpriced as a dash; create + created-inactive note;
      scope card and owner revision 10. _(products-and-orders, products-display)_
- [x] 1.2 product detail: gap banner; every identity fact; category move (no blank option,
      disabled until changed); activate/deactivate + note; every field, bound and problem of
      `bodyFrom`; panel/category typed fallbacks and hints; currencies from
      `SALES_CURRENCY_CODES`; ordered display lists; keyed by id. **+ leave guard.**
- [x] 1.3 categories: status and visibility routes kept apart; whole-order reorder; delete
      refusal count in its own banner; form outside the StateSwitch. Delete now ConfirmDialog.
- [x] 1.4 extra devices: capability banner; scope lists via `everyPage`; unsupported suffix;
      local trail; validation gates Save. **+ leave guard.**
- [x] 1.5 service locations: typed panel/product without `panels.view`; product cleared on
      panel change; the three rules; seven refusal messages; saved/unchanged toasts.
      Delete now asks (D3).
- [x] 1.6 custom service: flag banner; locations incl. unlisted panels; rule bounds, audience
      kinds, panel incl. no-longer-listed id; overlap and field errors; specificity order;
      edit-denied cards. Deletes via ConfirmDialog.
- [x] 1.7 discounts: separate edit keys; local kind/status filters (status is still the
      second group); trail per filter; kind/code read-only on edit and sent back; every
      bound; cashback list and form; preview with verdict and outcomes. _(discounts)_
- [x] 1.8–1.9 campaigns: `?state=` with replace; semantics banner; per-action permission
      (`NotPermitted`, no checkbox); presentation before the form; `campaignBodyOf`; confirm
      binding reset on a new preview; typed counts; commands and cancel wording; results as
      facts. **+ labels (D2), leave guard.** _(campaigns)_
- [x] 1.10 broadcasts: `?cursor=`; composer create/update with version; sourced kinds;
      placeholders and bot-renderer preview; media blocked while dirty; test, count, mode,
      schedule, freeze note, checkbox, typed count, bindings; report counts incl. pins;
      steering; recipients filter; 5 s polling of detail and recipients. **+ final dialog.**
- [x] 1.11 bulk: kinds per key; grant inputs reset the preview; preview figures and sample;
      reason, typed count, checkbox, bindings; detail counts incl. awaiting reconciliation;
      pause/resume/cancel per kind key; items filter; 5 s polling. **+ final dialog.**
- [x] 1.12 audience builder: every `aud-*` id and field; count; `describeAudience`.
- [x] 1.13 referrals: referrer filter (uuid error, Clear), both lists narrowed, default-label
      pagers, commission chips, dashes for unset earned/settled, unrecovered banner, banner
      metadata/upload/clear on `settings.*`, owner analytics. _(referrals, referral-banner×2)_
- [x] 1.14 resellers: `?search=`, `?register=`, status/tier filters, trail; register/edit
      with debt acknowledgement; the four standing cards on their own keys. _(resellers,
      reseller-standing)_
- [x] 1.15 tiers: grants editor/read-only, `grantsBodyFrom`, tier history on `audit.view`,
      tier form. 1.16 plans: minimum form, progress (period/filter sent to the server,
      truncated warning, floored %), policy + override editor. _(reseller-plans)_
- [x] 1.17–1.18 reports: owner-only gate fetching nothing; `mayExport` links; 8 ranges,
      custom form, disabled queries until complete; 8 tabs; 300 s polling and Refresh; every
      report's figures and exports; referral analytics. _(reports)_

### 7.5 Tests

Updated where the markup legitimately changed, assertions kept: the two `window.confirm`
stubs (categories, custom service ×2) now answer the dialog; broadcast launch and bulk
execute click the new final dialog's yes. New `tests/web/commerce-b-redesign.test.tsx`
pins the product editor's guard and marker, the section nav, problems-at-field on a
pristine form, the location delete dialog, a declined broadcast send, campaign labels (D2)
and the report link (D1) — the guard and the link were mutation-checked.

### 7.6 Screenshots

`pnpm web:shots` fixtures for every route above are in `tests/web/shots/fixtures/commerce-b.ts`
(the reseller standing is reached with `--click '.tbl tbody tr:first-child .row-actions
button'`). All 30 route captures report `ok` (dark 1440), plus light and 900/390 px for
products, product detail, discounts, a campaign, a broadcast, resellers and reports.

### 7.7 Not changed, on purpose

- No kit component added or restyled; the family's pieces live in `editor-layout.tsx`.
- No reseller detail route (D-A); no URL for the opened standing.
- Deactivating a product, a discount or an add-on still has no confirmation — they are
  reversible and asked nothing before.
- D5 (single-cursor broadcast/bulk list paging) left as it was.
- Reference-only content listed in §2 ("not carried over") is still not added.
