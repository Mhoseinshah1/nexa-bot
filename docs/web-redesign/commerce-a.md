# Web Admin redesign — commerce A (users, trials, services, orders, payments, compensations)

Round W, Wave 2, agent COMM-A. Branch `claude/w-commerce-a`, from `main` `f465d58`.

This file has two jobs. **Phase 1** (this commit): the capability inventory of every page
this family owns, taken from the current code and its web tests. That inventory is the
checklist Phase 2 has to prove it kept. It also records how each page maps onto the reference
composition, and which kit components the rebuild needs. **Phase 2** adds the migration
record: routes migrated, deviations, and screenshot paths.

Authorities: `main` decides function, data and security. The reference preview
(`refs/reference/preview-v2`, shots `dark-users`, `dark-user-detail`, `dark-services`,
`dark-service-detail`, `mobile-services`, `light-service-detail`, `dark-orders`,
`dark-order-detail`, `dark-payments`, `dark-payment-detail`, `dark-ledger`) decides
presentation only.

Legend: **P** is the prop or permission that gates an item, **Q** a query (method, path and
key), **M** a mutation, **T** the test that pins it (`tests/web/<file>`, then the `it` title).

---

## 0. Cross-cutting rules every page here obeys (must survive the rebuild)

- **Permissions arrive as props from `resolve()` in `app.tsx`** and are never derived inside a
  page. When a card is denied, it draws an `info` Banner naming the permission and **issues no
  request** (`enabled: mayX`). It never draws a disabled control in place of that sentence. The
  server enforces every permission again.
- **Every list uses keyset cursors.** No list has offset pagination, counts, client sorting or
  totals. Paging direction differs by list:
  - Ascending lists pass `nextLabel="web.newer" previousLabel="web.older"`: `/users`,
    `/orders`, and the customer-orders card.
  - Descending lists keep `CursorPager`'s default labels: `/services`, the customer-services
    card, the wallet ledger, the payments list, the compensations list, the refund-request
    attention stream, trial overrides and the reset history.
- **Two kinds of cursor state.** Some pages keep the cursor in the URL as `?cursor=`, which
  gives Previous a jump to the first page: `/services`, `/payments` and `/compensations`.
  Others keep a trail in component state keyed by a filter signature, which gives Previous a
  one-page step back: `/users`, `/orders`, the embedded order and service cards, trial
  overrides and history, and the refund attention stream. The wallet ledger holds a single
  cursor, so its Previous also goes back to the first page. Each existing behaviour is kept
  exactly as it is.
- **Filters live in the URL.** A text filter keeps a draft in component state, keyed by the
  signature of the applied values. When navigation drops the query, the input boxes clear
  (T users: `clears the search boxes when navigation drops the query`). Applying filters is ONE
  `setQueries` navigation, and it drops `cursor`.
- **Filter ids are validated against the contract schema before any request is sent**
  (`uuidV7Schema`, `telegramUserIdSchema`, `providerUsernameLookupSchema`). A bad id shows an
  inline field error, and the submit is refused or disabled.
- **The toolbar is hidden when the list cannot answer**: `hidden={!mayRequest(query, denied)}`.
- **A page renders its view state only through `StateSwitch query=…`.**
  `state-switch-contract.test.tsx` forbids `state={` anywhere in `apps/web/src`, which is why
  the badge components take `value=`.
- **Idempotency.** Every write goes through `useSubmissionKey`: `current(fingerprint)` builds
  the key from the normalised body, `settle()` runs on success, and `settleOn(error)` runs on
  error. `settleOn` keeps the key after a 5xx or a lost response and retires it after a 4xx.
- **Error mapping.** Mutation errors render as a `danger` Banner with `messageFor(error)`
  (`pages/settings`). Two refund commands use `refundMessageFor` instead, which maps
  `REFUND_NOT_PERMITTED` with detail `DELIVERY_IN_PROGRESS` to `web.refund_delivery_in_progress`.
  Service actions use a toast, `useToast({tone:'danger'})`.
- **Formatting and bidi.** Money goes through `<Money>` (bigint minor units plus currency). Time
  goes through `formatTimestamp`, and traffic through `formatTrafficGbText` + `web.unit_gib`,
  with `UNLIMITED_TRAFFIC_BYTES` shown as a word. Technical values are wrapped in `<Ltr>`, and
  copyable ids use `<Copyable>` (`copy-identity-bidi.test.tsx`). An absent value is a faint `—`.
  Where the absence of a value is itself the answer, a sentence replaces the dash.
- **No secrets.** No subscription URL, subscription ref or provider client id is ever
  rendered; the response schemas do not carry them (T services: `renders no subscription url…`,
  T users: `renders no subscription link…`). The payment destination shows `•••• last4` only,
  and IBAN presence as a word.
- **Detail routes are keyed by id** in `resolve()`, so navigating between two ids remounts the
  page.
- **Shared vocabularies are imported from their owning page, never copied:**
  - `orders.tsx`: `STATE_LABELS`, `STATE_TONES`, `ORDER_PURPOSE_LABELS`.
  - `services.tsx`: `STATE_*`, `DELIVERY_*`, `OPERATION_TYPE_LABELS`, `OPERATION_STATE_*`.
  - `payments.tsx`: `TelegramIdentity`.
  - `referrals.tsx`: `PartyCell`, `TriggerBadge`.
  - `resellers.tsx`: `CreditLimitCell`, `OVERRIDE_LABELS`, `PricingText`,
    `ResellerStatusBadge`, `PRICE_LAYER_*`.
  - `custom-service.tsx`: `CUSTOM_SERVICE_LEVEL_LABELS`.

  These exports stay; other families import them (panels, referrals, resellers,
  custom-service, discounts).

---

## 1. `/users` — `UsersPage` (`pages/users.tsx`)

**Route.** Nav `users`; permission `users.view`. Props: `denied = !users.view`,
`maySearch = users.search`.

**Q** `GET /users?cursor&telegramUserId&username&status`, key
`['customers', searchSignature, cursor]`, `enabled: !denied`. The signature joins the three
parts on `|`.

**Columns (6).** T `renders the six real columns and invents no commercial telemetry`.

1. Telegram id: a link to `/users/:id`, drawn as `<Ltr>` (monospace, strong).
2. Username: `@username`, left-to-right, not monospace, or a dash.
3. Name: first name and last name, or a dash.
4. Status: badge. `ACTIVE` is ok, `BLOCKED` is danger.
5. First seen.
6. Last seen.

**Search** (only with `users.search`):

- Two fields, each with a label and a hint: `#users-telegram-id` (`inputMode=numeric`, `dir=ltr`,
  trimmed) and `#users-username` (`dir=ltr`, trimmed).
- An invalid Telegram id shows the inline error `web.users_search_invalid_telegram`, and the
  Apply button is disabled.
- The Apply button (`web.users_search_apply`) runs one `setQueries` for both fields.
- Clear (`web.users_search_clear`) is disabled unless something is applied or typed. It clears
  both the draft and the URL.
- Tests:
  - `sends the two searches as separate parameters, only when non-empty`
  - `applies BOTH search boxes, in one navigation, and clears both`
  - `answers a username search separately…`
  - `keeps what the operator is typing when the status filter changes`

**Without `users.search`.** No form is drawn. An info Banner (`web.users_search_denied`) is
shown instead. T `renders no search form, and names the permission…`

**Status filter.** Pills `ALL | ACTIVE | BLOCKED` in `?status=`. It is **not** gated on
`users.search` (T `keeps the status filter for an actor without users.search`).

**Empty states.** Two, and they differ: during a search, `web.users_search_empty` with its
hint and the inbox icon; otherwise `web.users_empty` with its hint and the users icon.

**Pager.** Ascending, with the labels swapped. It is drawn only when `queryState === 'ready'`,
and only as a sibling of the StateSwitch. Previous pops one page.

**Denied.** StateSwitch `denied`. T `renders the refusal, not a table, without users.view`.

**Extra card.** `web.users_scope_title` and `web.users_scope_body`.

**Must NOT appear:** total spent, purchase count, balance column, reseller column, a tag
column. Tags themselves were REVERSED by the owner in program §8 (Phase A3): the list has a
tag FILTER beside the status chips, and a customer's tags and notes are read on Customer 360
(`docs/customer-notes-tags.md`; T `draws no tag control while the tenant has defined no tag
(program §8)` and `tests/web/customer-crm.test.tsx`).

## 2. `/users/:id` — `UserDetailPage`

**Props:**

- `mayBlock` = users.block
- `mayViewWallet` = users.view
- `mayCredit` = users.wallet.credit
- `mayDebit` = users.wallet.debit
- `mayViewOrders` = orders.view
- `mayViewServices` = services.view
- `mayEditTrial` = users.trial.edit
- `mayViewReferrals` = referrals.view
- `mayViewReseller` = resellers.view
- `mayEditReseller` = resellers.edit
- `denied` = !users.view

T route table: `derives the two commerce cards…`, `withholds both commerce cards…`,
`derives debit from users.wallet.debit…`.

**Q** `GET /users/:id`, key `['customer', id]`. PageHead subtitle is the `telegramUserId`.

**Blocked banner.** A danger Banner when the status is `BLOCKED`.

**Identity card.** KV rows:

- Telegram id (Copyable)
- Username (`@`, left-to-right)
- Name
- Language (left-to-right)
- First seen
- Last seen

**Access card.** KV rows:

- Status badge
- Blocked at
- Blocked reason
- _Reason shown to the customer_ (yes or no). Only when `BLOCKED` and a reason exists.
- _Marketing opt-in/out_ (read-only)
- _Opted out since_. Only when the customer opted out.
- Hint `web.user_marketing_hint`

**Block and unblock (two steps).** Only with `mayBlock`; without it, an info Banner
`web.user_block_denied`.

- **Step 1** is a button: `web.user_block` (danger) when the customer is `ACTIVE`,
  `web.user_unblock` (primary) when `BLOCKED`.
- **Step 2, block:**
  1. A warn Banner (confirm title and body).
  2. A required reason field `#user-block-reason`. It is counted in code points against
     `CUSTOMER_BLOCK_REASON_MAX_LENGTH`. Its inline errors are `…_required` (whitespace only)
     and `…_too_long`.
  3. Confirm (danger) is disabled while pending, while the reason is empty, or while it is
     too long.
  4. Cancel resets.
- **Step 2, unblock:** a warn Banner, then Confirm (primary), which sends **no** reason, and
  Cancel.
- **M** `POST block` or `POST unblock`. The key is bound to `{id, to, reason}`.
- On success:
  - toast `user_blocked_done` or `user_unblocked_done`
  - `setQueryData(['customer', id])`
  - invalidate `['customers']`
- On error: a danger Banner with `messageFor`.
- Tests: `sends a block with an idempotency key and the mandatory reason, in two steps`,
  `unblock asks for confirmation, then sends no reason`, `cancel closes…`,
  `sends no block until a non-empty reason…`, `shows the server refusal…`,
  `draws no block control at all without users.block`.

**TrialCard.** Q `GET /users/:id/trial`, key `['customer-trial', id]`. It is always fetched.

- A banner `trial_feature_off` when the feature is disabled.
- KV: global limit, override (value or `web.trial_override_none`), effective limit, used,
  remaining. Then a hint.
- With `mayEdit`:
  - Limit field `#trial-limit` (numeric).
  - Reason field `#trial-reason`, `maxLength` `TRIAL_ADMIN_REASON_MAX_LENGTH`.
  - `web.trial_override_set` (primary), disabled while the limit is empty.
  - `web.trial_override_remove`, only when an override exists.
  - M `setTrialOverride` or `removeTrialOverride`, keyed.
  - Toast `trial_override_done` or `trial_override_removed`.
  - `setQueryData`, and invalidate `['trial-overrides']`.
- Otherwise a Banner `trial_override_denied`.
- T trials: `echoes the stored override…`, `says «none»…`.

**ResellerCard.** Needs `mayViewReseller`; Q key `['customer-reseller', id]`, where 404 means
null.

- Without the permission: a Banner naming it, and no request.
- Not a reseller: the text "none", plus a link `/resellers?register=<id>` when `mayEdit`.
- A reseller: KV of tier, status badge, pricing text and effective credit limit. A warn Banner
  when `SUSPENDED`. A link to `/resellers?search=<telegramId>`.
- T resellers.test (heading «نمایندگی», `closest('section')`).

**WalletCard.** Needs `mayViewWallet`.

- Q `['wallet', id]` returns the derived balance and the entry count.
- A negative balance gets a warn Badge and a warn Banner with a hint.
- Q `['wallet-entries', id, cursor]` has limit `WALLET_PAGE_DEFAULT`. Its table columns are:
  direction badge, amount, reason, actor (Copyable, or "system"), note, time.
- The pager's Previous returns to the first page (null).
- Text: `wallet_balance_hint` and `wallet_immutable`.
- **Adjust form**, only with credit or debit permission:
  - A `<fieldset disabled>` until the wallet has loaded, because the currency comes from the
    balance with no fallback.
  - `#wallet-amount` takes a decimal string in minor units. `#wallet-note` has `maxLength` 500.
  - The credit button (primary) needs `mayCredit`; the debit button (danger) needs `mayDebit`.
  - M `adjustWallet`. The key is the normalised body `{customerId, direction, amount.trim,
currency, note.trim}`.
  - Toast credit or debit done; invalidate the wallet and its entries.
  - Separate info Banners `wallet_credit_denied` and `wallet_debit_denied` for whichever
    permission is missing.
- There must be **no** set-balance control, no row edit and no row delete.
- Tests:
  - `renders the DERIVED balance…`
  - `shows the ledger…`
  - `draws NO control that could set a balance or remove an entry`
  - `sends a CREDIT…`
  - `repeats the SAME idempotency key…`
  - `reuses the key when a FAILED submission is retried with only whitespace changed`
  - `draws only the button a credit-only operator is entitled to`
  - `asks for nothing … may not read a wallet`
  - `pages the ledger…`

**CustomerOrdersCard.** Needs `mayViewOrders`.

- Q `GET /orders?customerId&limit=10`, key `['customer-orders', id, cursor]`. Trail pager,
  ascending labels.
- Columns: snapshot title (link), state badge, total, created.
- Text: `user_orders_hint`, and a link `/orders?customerId=` («همهٔ سفارش‌های این مشتری»).
- Empty: `user_orders_empty`, no count.

**CustomerServicesCard.** Needs `mayViewServices`.

- Q `GET /services?customerId&limit=10`, key `['customer-services', id, cursor]`. Trail pager,
  descending labels.
- Columns: username (a link, `<Ltr>`), state, **delivery (a separate column)**, expires.
- Text: `user_services_hint`, and a link `/services?customerId=`.

Tests for the two cards: `asks for THIS customer, with the embedded bound, on both lists`,
`draws a delivered failure as ACTIVE and FAILED…`, both pager-label tests,
`steps the orders pager back one page…`, both `names the missing permission and asks for
nothing…` tests, `says a customer has none rather than showing a count`.

**CustomerReferralCard.** Needs `mayViewReferrals`; Q `['customer-referral', id]`.

- KV: referred by (PartyCell, TriggerBadge and time, or "not referred"), referred count, code
  (`<Ltr>`, or "no code").
- A per-currency totals table (pending, earned, reversed, unrecovered), or "no commissions".
- A link `/referrals?referrerId=`.
- Read-only. T referrals.test (heading «معرفی»).

**Scope card.** `users_scope_*`.

**Must NOT appear:** a recent-activity feed or commercial cards
(T `carries no recent-activity feed and no commercial cards`).

## 3. `/trials` — `TrialsPage` (`pages/trials.tsx`)

**Props:** `mayViewPanels` = panels.view, `mayViewOverrides` = users.view,
`mayReset` = settings.destructive AND users.view, `mayViewHistory` = settings.view. Each of the
four cards is gated separately, and each denied card is a Banner naming its permission.

**Panels overview.** Q `['trial-panels']`. Columns:

- Panel: a link to `/panels/:id`, labelled with the trial label or the panel name.
- Traffic: `trafficInputOf` in GB or MB units, or a dash.
- Hours.
- State: badge, one of disabled (neutral), offered (ok), not offered (warn).

The card carries a hint, and has an empty state. T `lists each configured panel…`,
`says which permission the overview needs…`.

**Overrides.** Q `['trial-overrides', cursor]` with `TRIAL_OVERRIDE_PAGE_DEFAULT`. Columns:
customer (a link to `/users/:id`, labelled `@username`, then first name, then Telegram id),
override, used, remaining, set at. Trail pager with the default labels. Empty state only on
the first page. Hint `trial_zero_hint`.

**Global reset (danger).**

1. A danger Banner.
2. A Preview button runs M `fetchTrialResetPreview`, which sets the preview and clears what was
   typed.
3. If nothing would be affected: an info Banner `trials_reset_nothing`.
4. Otherwise: KV (affected grants, affected customers), then a sample table (customer, grants).
5. `#trial-reset-count` must equal the previewed count, and `#trial-reset-reason` must be
   non-empty (`maxLength` `TRIAL_ADMIN_REASON_MAX_LENGTH`).
6. The execute button (danger) runs M `executeTrialReset {expectedGrants, expectedFingerprint,
reason}`, keyed.
7. Toast; then invalidate the resets, the overrides and `customer-trial`.

Errors from either step show as a Banner with `messageFor`. T `stays disabled until the
previewed count is typed back with a reason, then sends it`, `names the permission…`.

**History.** Q `['trial-resets', cursor]`. Columns: time, affected grants, customers, reason,
actor (Copyable). Trail pager.

## 4. `/services` — `ServicesPage` (`pages/services.tsx`)

**Props:** `denied` = !services.view, `mayViewRefundRequests` = refunds.view. The nav entry
appears with ANY of the two permissions.

**Refund-request attention card** (`OpenServiceRefundRequestsCard`). It is drawn first, and
only with refunds.view. It is independent of `denied`, so a finance reviewer holding only
refunds.view reaches the queue and **never requests the services list**
(T service-refund-requests: `reaches the queue from the navigation, and never asks for the
services list`).

- Q `GET /service-refund-requests?attention=true&cursor`, key
  `['service-refund-requests', 'attention', cursor]`. One stream, paged by a trail of
  `{at, id}` cursors.
- Columns:
  - state badge
  - service (a link, labelled with the username or the id)
  - customer (Telegram id and `@username`, left-to-right)
  - reason
  - principal
  - remaining
  - approved (or a dash)
  - operation state token (`Ltr`)
  - outcome (rejection reason, or the failure kind as `Ltr`)
  - created
- Read-only.

**List.** Q `GET /services?cursor&state&deliveryState&customerId&panelId&providerUsername`, key
`['services', …7]`.

- **Filters:**
  - Two pill rows: the state (all plus the frozen `SERVICE_STATES`) and the delivery state (all
    plus the frozen `SERVICE_DELIVERY_STATES`). Each resets the cursor.
  - A form with three fields: customer id (uuidv7) `#services-customer`, panel id (uuidv7)
    `#services-panel`, and account name (`providerUsernameLookupSchema`, exact match, sent raw)
    `#services-username`. Each has a hint and an inline error. Submit is `web.services_search_apply`.
- **Columns:**
  1. Username: a link, as `<Ltr>`, plus a trial Badge when `isTrial`.
  2. State badge.
  3. **Delivery badge (a separate column; never merged with the state).**
  4. Customer: short id, links to `/users/:id`.
  5. Panel: short id, links to `/panels/:id`.
  6. Expires.
  7. Created.
- **Pager.** `?cursor` in the URL, with the descending default labels. Previous returns to the
  first page. T `labels the next page older, the way a descending list must` (queries `.pager`).
- **Empty:** `services_empty` with its hint.
- **Rules card:** `services_rule_no_protocol`, `services_rule_ordering`,
  `services_rule_plan_filter` and `services_transfer_absent`. The route inventory tests assert
  this copy.
- **Tests:**
  - `offers no write from the list: every request it makes is a GET` (exactly one form, one
    submit)
  - `asks the server for the exact name, and sends it unfolded`
  - `refuses a name the server would refuse…`
  - `marks a free trial…`
  - `shows an active service whose delivery failed as active, and separately as failed`
  - `refuses to render the list at all without services.view`

## 5. `/services/:id` — `ServiceDetailPage`

**Props:** `denied`, `mayEdit` = services.edit, `mayTerminate` = services.terminate,
`mayViewRefundRequests` = refunds.view, `mayDecideRefundRequests` = refunds.issue AND
services.terminate.

**Q** `['service', id]` and `['service-operations', id]`, both run in parallel. After any
action, `refresh` invalidates `service`, `service-operations` and `services`.

**Refund requests card** (`ServiceRefundRequestsCard`, only with refunds.view). Drawn at the
top.

- Q `['service-refund-requests', 'service', id]`. The columns are the same as the attention
  card, minus the service column.
- For the OPEN request:
  - With `mayDecide`, `DecisionForm` is shown.
  - Otherwise an info Banner `service_refund_denied` is shown.
- **DecisionForm, approve:**
  1. Amount `#service-refund-amount`, digits only, `maxLength` 19, sent as a minor-unit
     string.
  2. A destructive-confirm checkbox (`label.check`) that must be ticked.
  3. The approve button (danger) is disabled until the box is ticked and the amount is not 0.
  4. The toast depends on the returned state: COMPLETED gives `…completed_toast`, FAILED gives
     the danger `…failed_toast`, anything else gives `…approved_toast`.
- **DecisionForm, reject:** the reason `#service-refund-reject` must satisfy
  `isServiceRefundRejectionReason` (counted in code points). The reject button then sends it.
- Both commands are keyed. On either success or error they invalidate the refund requests, the
  service and its operations.
- Tests: `approves only after the destructive confirmation is ticked…`,
  `never says "deletion started" for a replayed approval…`,
  `accepts a reason of 300 emoji…`, `rejects with the typed reason`,
  `tells an operator without both decision keys so…`,
  `offers no decision on a request that is no longer open`.

**Banners:**

- `UNRECONCILED`: a warn Banner. It does not suggest creating the service again.
- `UNCONFIRMED` delivery: a warn Banner (it is not retried automatically).
- `FAILED` delivery: a danger Banner.

**Identity card.** KV rows:

- State badge
- Username (Copyable)
- Provider user id (Copyable, or a dash)
- Customer (a full-id link)
- Order (a full-id link)
- Panel (a full-id link)
- Product (a link, or «custom service» text when `productId` is null)
- Expires
- Created
- Updated
- Hint `service_username_hint`

**Traffic card.** Limit (unlimited shown as a word), used (GB), device limit (or a
"none" sentence), usage synced at (or `service_usage_never` as a sentence).

**Delivery card.** KV rows:

- Delivery badge
- Subscription **present or absent as a word** (never the value)
- Attempts
- Next attempt
- Delivered at
- Provisioned at
- Terminated at
- Sentence `service_subscription_withheld`

**Actions card** (`ServiceActions`). Drawn from `row.actions`, the server's verdicts.

- There is one button per ordinary action, in `SERVICE_OPERATOR_ACTIONS` order, excluding the
  terminate class (`ACTION_NEEDS_TERMINATE`).
- A button is disabled when `!mayEdit`, `!available` or pending. An unavailable action shows the
  blocker **sentence** (`BLOCKER_LABELS`) beneath it.
- `!mayEdit` shows a neutral Banner `service_action_denied_edit`.
- **Terminate is isolated.**
  1. A danger Banner.
  2. Without `mayTerminate`: a neutral Banner `…denied_terminate`.
  3. If terminate is blocked: the blocker sentence.
  4. Otherwise: the phrase `SERVICE_TERMINATE_CONFIRMATION` shown as `Ltr`, and a text input
     (`dir=ltr`, `autoComplete=off`). A warn Banner appears when the phrase does not match.
  5. The terminate button (danger) is enabled only on an exact match, and sends
     `confirm: phrase`.
- M `actOnService {id, action, idempotencyKey(command, id, action), confirm?}`.
- The toast is `service_action_resent` when the operation is null (a resend), otherwise
  `service_action_planned`. It never says "done".
- On error: a danger toast with `messageFor`.
- Tests:
  - `draws a button for every action the server declares, and no others`
  - `disables a refused action and says WHY…`
  - `posts the action…`
  - `reports a planned operation as recorded…`
  - `says a resend was sent…`
  - `refuses every action … without services.edit, in a sentence`
  - `separates the terminate permission…`
  - `keeps the terminate button unpressable until the phrase matches exactly` (queries
    `input[dir="ltr"]`)
  - `sends the phrase…`
  - `re-reads the service and its history after an action`

**Operations card.** Columns:

- Type
- State badge
- Attempts
- Created
- Scheduled
- Completed
- Failure message (the adapter's own words)

When `hasMore`, a notice gives the truncation with the server's `limit`. Empty state
`service_operations_empty`. T `…history was cut, with the bound the SERVER applied`,
`prints no truncation notice…`.

**Footer card.** `services_transfer_absent`: no disabled transfer button.

## 6. `/orders` — `OrdersPage` (`pages/orders.tsx`)

**Props:** `denied` = !orders.view. The page is **read-only**: no cancel, mark-paid, refund,
settle or fulfil (T `presses every control it has and still issues nothing but reads`).

**Q** `GET /orders?cursor&state&customerId&productId`, key `['orders', signature, cursor]`.

**Filters:**

- A form with customer id `#orders-customer` and product id `#orders-product`. Both are uuidv7;
  an invalid value shows the error `orders_filter_invalid_id`.
- Apply is disabled while either value is invalid, and runs one `setQueries`.
- Clear works as on `/users`.
- Pills: ALL plus the frozen `ORDER_STATES`, all six.
- T `applies BOTH filters, in one navigation, and clears both`,
  `offers every frozen state as a filter…`.

**Columns:**

1. Snapshot `lineTitle` (a link).
2. State badge (`REFUNDED` is violet).
3. Total.
4. Customer (short id, links).
5. Created.
6. Expires.

T `renders the SNAPSHOT title, not a product lookup`.

**Empty.** Filtered and unfiltered variants. **Pager:** ascending, trail.

**Cards.** `orders_scope_*`, then the "future rules" card: `orders_rule_history`,
`orders_rule_attention` and `orders_rule_shared_projection`. T `records the needs-attention,
history and shared-projection rules`.

## 7. `/orders/:id` — `OrderDetailPage`

**Props:** `denied` = !orders.view, `mayViewPayments` = payments.view,
`mayViewServices` = services.view.

**Q** `['order', id]`. PageHead subtitle is `lineTitle`.

**Banners.** `AWAITING_PAYMENT`: an info Banner with no mark-paid button. `REFUNDED`: an info
Banner saying where the figure is. T `says the order is waiting…`,
`says a refunded order was refunded…`.

**Line card** (snapshot, with hint). Rows:

- Purpose label
- Title
- Category (the snapshot name, with emoji when present; `order_category_unknown` when null,
  never the live category)
- Duration (unlimited shown as a word)
- Traffic in GB
- Device limit (or "provider default")
- Unit price
- Quantity

**Totals card.** Subtotal, discount, total.

**Custom service card.** Only when the purpose is `CUSTOM_SERVICE`. Q
`['order-custom-service', id]`. KV rows:

- Location
- Panel (Copyable)
- Volume
- Days
- Price per GB
- Price per day
- Volume price
- Time price
- Base price
- Volume rule (level label and Copyable id)
- Time rule (level label and Copyable id)

T custom-service.test.

**Pricing card.** Q `['order-pricing', id]`, charged `orders.view`.

- Reseller terms, when present. KV rows:
  - Reseller (a link, short id)
  - Tier
  - Layer (with its step)
  - Percent
  - List
  - Cost
  - Promotion
  - Sale
  - Margin
  - Currency
  - Bot (Copyable)
  - Recorded at
  - Margin note
- The code (`Ltr`, or "none").
- An adjustments table (rule, before, after) in the server's order.
- A redemptions table (rule id Copyable, amount, time).
- A cashback KV: rule, percent, promised, state badge (null state shows `cashback_state_draft`),
  earned, reversed, unrecovered. A warn Banner appears when unrecovered is non-zero.

T discounts.test, resellers.test.

**Lifecycle card.** State badge, created, expires, confirmed, settled, updated.

**References card** (with hint). Customer (a full-id link), product (a link, or custom-service
text), panel (Copyable). T `labels the product and customer links as navigation…`.

**Payments card** (payments.view gated, and no request without it).

- Q `['payments', 'order', id]`.
- A plain list of `reference link — state label — amount`.
- An info Banner `order_payments_truncated` when there is a `nextCursor`.
- T `asks for no payments, and says why…`.

**Service card** (services.view gated).

- Q `GET /services?orderId&limit=1`.
- KV rows: username (a link), state badge, delivery badge, provider user id (Copyable, or a
  dash), provisioned at, delivered at, terminated at.
- Empty state with a hint.
- Followed by an operations card: Q `['service-operations', serviceId]`, five columns (type,
  state, attempts, completed, failure). The `hasMore` notice.
- T `shows the service the order produced, and the attempt that failed`,
  `asks for no service…`, `says an order produced no service…`,
  `does not tell an operator a refunded service purchase was not one`.

**Scope card.**

## 8. `/payments` — `PaymentsPage` (`pages/payments.tsx`)

**Props:** `denied` = !payments.view.

**Q** `GET /payments?cursor&state&method&disposition&customerId&orderId&reference`, key
`['payments', …8]`.

**Filters:**

- Three pill rows: state (frozen `PAYMENT_STATES`), method (frozen `PAYMENT_METHODS`) and
  receipt disposition (frozen `RECEIPT_DISPOSITIONS`). Each resets the cursor.
- The sentence `planned_missing_gateway` (T `says why a gateway never appears…`).
- A form: customer id `#payments-customer` and order id `#payments-order` (both uuidv7, with
  inline errors), and reference `#payments-reference` (free text, left-to-right).
- Apply runs one `setQueries` and drops the cursor.
- T `applies all three filters in ONE navigation, and drops the cursor`,
  `refuses a partial id at the field…`, `offers every FROZEN state and method as a filter`,
  `tells a credited receipt from a rejected one on the list, and filters by it`.

**Columns (14):**

1. Id (Copyable, displayed as the first 8 characters)
2. Reference (a link to the detail, `Ltr`)
3. State badge (`UNKNOWN` is warn)
4. Disposition badge (or a dash)
5. Method label
6. Gateway name (manual, TonPays, Stars, a raw `Ltr`, or a dash)
7. Amount (safe past 2^53)
8. Customer (short id, links)
9. Telegram identity (id and `@username`)
10. Order: a short-id link, or the **top-up word** when there is no order
11. **Customer signalled at** (or a dash)
12. External reference
13. Created
14. Updated

The evidence note is **not** on the list (T `keeps the evidence note off the LIST`).

**Pager.** URL cursor, descending default labels.

## 9. `/payments/:id` — `PaymentDetailPage` (plus `payment-timeline.tsx`)

**Props:**

- `mayViewReceipts` = receipts.view
- `mayViewRefunds` = refunds.view
- `mayIssueRefunds` = refunds.issue
- `mayViewOrders` = orders.view
- `mayViewWallet` = users.view (used only in the timeline cache identity)
- `denied` = !payments.view

**No card-to-card decision exists here, even for `receipts.review`** (T `offers no
card-to-card decision even to receipts.review`, `draws no control that could confirm, reject,
cancel, retry or refund a payment`, and the contract test `names no confirm, reject or credit
route…`).

**Q** `['payment', id]`. PageHead subtitle is the reference. `UNKNOWN` gets a warn Banner
("neither success nor failure").

**Main KV.** Rows:

- Id (Copyable)
- State
- Disposition
- Method
- Gateway
- Amount
- Reference (Copyable)
- Customer (a full-id link)
- Telegram identity
- Order (a link, or the top-up word)
- External reference (Copyable, or a dash)
- Created
- Updated
- Expires
- Customer signalled: a time, or the **sentence** `…signalled_none`, plus a hint when
  signalled

**Conditional cards**, each absent (not dashed) when its value is null:

- **Top-up gift %:** `topupCashbackPercent`.
- **Customer fee (WP18):** rate `formatBasisPointsPercent`, fee, payable, hint. It is shown
  beside the principal, never added into it.
- **Gateway invoice (WP11A, FX):**
  - Provider order id (Copyable)
  - Invoice id
  - Charge id (the row is absent when null)
  - Creation state and error code
  - Provider status and `paid=`
  - Last inquiry and its error code
  - Webhook hint and count
  - Amounts `sent/request/final/credit unit`
  - Conversion policy label
  - FX snapshot line (absent when null)
  - Outcome
  - Late completion (a warn badge)
- **Receipt credit:** amount, admin (Copyable), time, note, hint. Read-only.
- **Resolution** (only when `resolvedAt`): time, resolver (Copyable; a dash when there is
  none), note.
- **Destination:** label, bank, holder, `•••• last4`, IBAN given or absent, account id
  (Copyable). T `never renders a full card number…`.

**Evidence card** (always drawn). Evidence kind, note, reviewer (Copyable), confirmed at.

**ReceiptsCard** (only with receipts.view; otherwise **nothing at all**).

- Q `['payment-receipts', id]`. Empty state `payment_receipts_empty`, and the note
  `payment_receipts_note`.
- Per receipt: KV of kind, file name, size (`splitBytes`), sent at.
- The View or Download button runs M `fetchPaymentReceiptBytes`, which produces a Blob and an
  object URL. The object URL is **revoked on unmount or replace**.
- A PHOTO renders as `<img class="receipt-image">` with its type taken from the record only.
- A DOCUMENT is **never inline**: it gets a save `<a download>`.
- A failure shows a warn Banner.
- T: 7 receipt tests, which query `img.receipt-image`, so that class name must survive or the
  test must move to `getByRole('img', {name})` with the same assertion.

**RefundsCard** (only with refunds.view).

- Q `['refunds', id]`.
- KV of paid, consumed and **remaining (the server's `refundableMinor`, never recomputed)**.
- `!refundable` shows an info Banner.
- When the order is refunded, an info Banner with a link to the order. It reads the order via
  Q `['order', orderId]`, **only with orders.view**.
- A table of amount, state (`AWAITING_EXTERNAL` is warn, `FAILED` is neutral), channel,
  reason, requested by, completed by (a sentence while awaiting), created, completed and
  external reference.
- **Request form.** Shown only when refundable and remaining > 0, and only with refunds.issue;
  otherwise a Banner `refund_denied`.
  1. `#refund-amount` (digits, `maxLength` 19).
  2. The "all" button fills the server's figure.
  3. `#refund-reason` (`maxLength` 500).
  4. The request button is disabled unless the amount is not 0 and the reason is at least 3
     characters.
  5. M `requestRefund`, keyed `{paymentId, amount, reason}`.
- **The issue error Banner sits OUTSIDE the form** (it must survive the form hiding).
- **Answer form.** Shown only with refunds.issue and at least one `AWAITING_EXTERNAL` refund.
  1. A select `#refund-answering`.
  2. `#refund-note` (at least 3 characters, `maxLength` 500).
  3. `#refund-external-reference` (`maxLength` 140).
  4. Complete (primary) and abandon (danger). Both are disabled while either is pending.
  5. M `completeRefund` or `failRefund`, keyed.
- Success invalidates `refunds`, `wallet`, `order`, `orders` and `payment-timeline`. An error
  re-reads the refunds and the timeline.
- T payments.test (9 refund tests) and payments-refund-consequences.test (5).

**PENDING manual transfer.** A card saying review happens in Telegram
(`payment_review_in_telegram`), with no controls.

**PaymentTimelineCard.** Q `['payment-timeline', id, sections]`.

- **Polling:** `pollUnlessFinalWhile(15s, timelineStillMoving)`. It polls only while a notice
  is PENDING or the payment is still OPEN. It stops on a final answer, 403 or 404.
- **Reconciliation:**
  - It re-reads `['payment']` or the timeline once per disagreeing pair. When a re-read fails,
    it retries after 15s.
  - It re-reads the receipts card when the timeline names an unseen receipt. It _watches_ the
    receipts query with `enabled: false` and never fetches it itself.
- **Refresh.** An explicit refresh button in the card actions (`retryOf`).
- **Content:**
  - A withheld-sections info Banner.
  - A truncated warn Banner.
  - A table of at, event and detail, in the server's order and never sorted. The detail
    includes actor wording: by the customer for a WALLET_DEBIT confirmation and for
    CANCELLED; otherwise by the system or an admin.
- T payment-timeline.test (28).

**Final card.** `payment_not_settled_here`.

## 10. `/compensations` — `CompensationsPage` (`pages/compensations.tsx`)

**Props:** `denied` = !payments.view. Crumbs are under payments. Read-only.

**Q** `GET /compensations?cursor`, key `['compensations', cursor]`, with a URL cursor.

**Columns (8):**

1. Payment (short id, links)
2. Order (short id links, or a dash)
3. Customer (short id links, plus `TelegramIdentity`)
4. Principal
5. Credited
6. Reason (`UNDELIVERABLE` as words, otherwise `Ltr`)
7. State badge
8. Time (completed, or else created)

**Empty.** `compensations_empty`. **Pager:** descending default labels. T compensations.test (5).

---

## 11. Mapping to the reference composition

Kit terms: FOUND's names, assumed to follow the reference kit (`PageHead{title, badge, sub,
actions}`, `DataTable{toolbar, filters}`, `Chip`, `SearchBox`, stat cards `grid c4`/`card
stat`, `Tabs`, `two-col`, `KV`, `Who`, `Status`/`Badge`, `Banner`, `Modal`/`Confirm`).

### Lists (`/users`, `/services`, `/orders`, `/payments`, `/compensations`, the trials tables)

Reference: a compact PageHead (a title plus a `sub` line, actions to the left), then ONE table
card whose top is a toolbar row (search and selects) with a chip row beneath it
(`dark-users`, `dark-services`, `dark-orders`, `dark-payments`), and dense rows.

Mapping:

- **Toolbar row:** the existing exact-match fields become compact inline inputs in the table
  toolbar, with a SearchBox-style search icon on the primary field:
  - users: Telegram id and username
  - services: username, customer id and panel id
  - orders: customer id and product id
  - payments: reference, customer id and order id

  Each keeps its `<label>` (visually compact, still accessible), its hint (as a
  title/`aria-describedby`, or small text), its inline error, and Apply and Clear. The `form`
  element stays, because services asserts exactly one form and one submit.

- **Chip row:** the existing Pills become filter chips. Services and payments have two or three
  groups, separated the way the reference separates chip groups with a divider. The
  selected-state class contract in `stylesheet-contract.test.tsx` must hold for whichever
  component FOUND provides.
- **Table:** the dense `tbl` style, sticky header, `Ltr` technical cells, and badge statuses.
  Every current column stays; none is hidden to fit.
- **Pager:** the kit `CursorPager` at the table foot, with the labels unchanged.
- **Explanatory cards** (users scope, orders scope and future rules, services rules and
  transfer-absent, the payments `planned_missing_gateway` sentence) become compact muted
  "notes" cards, or a footer note, below the table. The text stays rendered (i18n
  key-rendered check and tests).

### Detail pages

- **`/services/:id`** (`dark-service-detail`, `light-service-detail`):
  - PageHead: title = the provider username (`Ltr`, mono); badge = the state plus the delivery
    state; sub = short customer, panel and product references.
  - PageHead actions: the ordinary server-declared actions as a button group. Each disabled
    one carries its blocker sentence via `aria-describedby`, and the sentence is rendered
    visibly in a compact "why unavailable" list, so the test's text assertions hold.
  - Banners (unreconciled, delivery) under the head.
  - `grid c4` stat cards from real fields:
    - Traffic used/limit: a progress bar when limited, the word when unlimited.
    - Expiry date.
    - Delivery state and attempts.
    - Device limit, with usage synced at.
  - Tabs: **Overview** (the identity KV, traffic KV and delivery KV in `two-col`), **Operations**
    (the history table), and **Refund requests** (only with refunds.view).
  - **Terminate in an isolated danger-zone card**, at the end of Overview. The typed phrase
    stays.
  - The transfer-absent note.
- **`/users/:id`** (`dark-user-detail`):
  - A head card: an identity block (name, `@username`, `Ltr` Telegram id, status badge,
    first/last seen) and quick actions (block or unblock; its two-step confirm opens inline
    under the head, or in a kit ConfirmDialog with the reason field — the reason validation
    and Cancel must stay).
  - `head-stats` strip from real reads only: wallet balance (from `['wallet', id]`, when
    users.view), referred count (only with referrals.view), trial remaining.
  - Tabs:
    - Overview: identity, access and marketing KV, trial card.
    - Services
    - Orders
    - Wallet: balance, ledger (the `dark-ledger` table style), adjust form.
    - Reseller
    - Referral
  - A denied tab still renders its permission sentence.
- **`/orders/:id`** (`dark-order-detail`):
  - PageHead: title = `lineTitle`; badge = the order state; sub = purpose and created at.
  - `two-col`:
    - Main column: line and totals ("order items", reference style), pricing, custom service,
      lifecycle.
    - Side column: references (customer, product, panel), payments (compact), and the
      produced service with its operations.
  - No actions: the page is read-only.
- **`/payments/:id`** (`dark-payment-detail`):
  - PageHead: title = the reference (`Ltr`); badge = state plus disposition; sub = method,
    amount and created at.
  - The `UNKNOWN` banner.
  - `two-col`:
    - Main: transaction details (the main KV), the gateway invoice, customer fee, destination,
      evidence, resolution, receipt credit.
    - Side: the customer (link plus Telegram identity), top-up gift, receipts.
  - Full-width below: refunds (the only write, its destructive answer isolated), then the
    timeline (the reference's "attempts" timeline position).
  - The Telegram-review note for a PENDING manual transfer.
- **`/trials`:** PageHead, then four stacked cards (panels, overrides, reset, history). The
  reset card is styled as a danger zone.
- **`/compensations`:** a list page as above, with no filters (the server offers none).

### Reference items NOT built (no backend, or forbidden)

These are not added, because they would be fake data or new capability:

- **Counts and aggregates:**
  - KPI stat rows on orders and payments (paid, awaiting, failed-delivery and refund counts;
    success rate)
  - The payment-method donut
  - Chip counts
  - "N results"
  - "64 users · 10 resellers · 3 blocked" style subtitles
  - User head stats "total spent", "order count" and "active services"
  - No endpoint returns a count; `users.tsx` records the owner's refusal of client-side counts.
- **Filters and search the server does not offer:**
  - Period selectors (امروز/۷ روز/۳۰ روز/…) on orders and payments
  - Free-text name search
  - Level, tag, location and protocol filters
  - "Expiring in 7 days", "auto-renew" and "online now" chips
- **Actions with no route:**
  - Row checkboxes and bulk actions (bulk operations have their own page)
  - CSV export and «پیام گروهی»
  - PDF receipt
  - The user's tags, notes, notify and "change balance" as a single field
  - Service renew, add traffic, reset, migrate and toggle as the reference draws them: Nexa
    has its own server-declared action list
  - Order resend-receipt and note
- **Data Nexa does not expose, or that is forbidden:**
  - Protocol badges (`web.services_rule_no_protocol` forbids protocol in the normal UI)
  - The raw gateway response JSON (a raw provider payload, forbidden)
  - Service 7-day usage chart, auto-renew and behaviour toggles, last activity
  - Avatars with customer names where the row carries only a customer id (services, orders,
    payments). The users list may use a name/initials identity cell, because it has the
    names.
- **Global wallet ledger page** (`dark-ledger`): Nexa has no tenant-wide ledger endpoint. The
  per-customer ledger on `/users/:id` takes that table style.
- **Demo apparatus:** the demo "state switcher", the «پیش‌نمایش» banner and the maturity
  legend banners are forbidden. Current pages pass `maturity="now"` to PageHead; whether the
  badge stays is FOUND's PageHead decision.

### Current capabilities the reference lacks (kept)

- **Payments:**
  - The refund card and its two-step external answer
  - The payment timeline with polling and reconciliation
  - The receipts viewer
  - The gateway invoice and FX snapshot
  - Customer fee, destination, receipt credit, disposition, customer signalled at
- **Services:**
  - The refund-request queue and decision form
  - The delivery axis
  - Blocker sentences
  - The terminate phrase
- **Orders:** pricing, cashback, reseller terms, custom-service terms, and the service it
  produced with its operations.
- **Users:** trial override, reseller card, referral card, marketing opt-out, and the reason
  shown to the customer.
- **The `/trials` and `/compensations` pages in full.**
- **All permission-denied sentences.**

---

## 12. Kit components needed (to check against FOUND's API when it lands)

**Needed:**

- `PageHead` with `badge` (node) + `sub` (node) + `actions`
- `Card` (keeps `<section>` + heading `h2`: many tests use `closest('section')` and
  `findByRole('heading', {name})`)
- `Banner`, `Badge`, `KV`, `Copyable`, `Ltr`, `Money`, `Num`
- `DataTable` with `toolbar` and `filters` slots and a `caption` (tests use
  `getByRole('table', {name: caption})`)
- `CursorPager` (keep `.pager`, or re-point the services test at a role query)
- `Pills`→`Chip` filter group (with a selected-state class under the stylesheet contract)
- `Field` (label, hint, error; `htmlFor`)
- `Empty` (title, hint, icon)
- `StateSwitch`
- `Tabs` + `TabPanel` (already keyboard-contracted)
- A stat card (`card stat`: label, value, small unit, delta/hint, optional progress bar)
- A `Progress` bar
- `grid c4` / `two-col` layout utilities
- `useToast`

**Plausibly missing from a generic kit** (flag to the lead). I can add them to the kit as NEW
components if FOUND does not ship them:

1. **Detail head card with a stats strip** (reference `head-card` + `head-stats`), for
   `/users/:id`.
2. **`Progress` bar** (traffic used/limit), with an accessible label and value text, and no
   colour-only meaning.
3. **Danger-zone card** (`Card` tone `danger`), for terminate, trial reset and refund
   abandon. It could be a `Card` prop rather than a new component.
4. **Inline filter-field** styling for labelled exact-match inputs inside a table toolbar,
   where the hint and error must stay visible without breaking row height. Probably a `Field`
   `compact` variant.
5. **Chip-group divider** in a `filters` row, so several filter axes are distinguishable.
6. **`Who`/identity cell** (name + `@username` + Ltr id); `Ident` in the current kit is close.
7. **Notes card** (muted rule sentences), which can be plain `Card`.

**Page-family CSS to move into my family stylesheet.** `.receipt-list`, `.receipt` and
`.receipt-image`. The generic `.check`, `.plain`, `.stack`, `.tight`, `.btn-group`, `.toolbar`,
`.nowrap`, `.faint`, `.muted`, `.small`, `.strong` and `.card-subtitle` are expected to stay
generic in the kit or shell stylesheet.

## 13. Test impact plan (Phase 2)

- **Tab-hidden panels.** Cards moved under tabs on `/users/:id` and `/services/:id` are not in
  the DOM until their tab is selected (mount-on-activate, as the reference does). The affected
  tests will first select the tab by role (`getByRole('tab', {name})`) and then assert exactly
  what they assert now. This touches users.test, referrals.test, resellers.test, trials.test
  (the customer trial card), services.test and service-refund-requests.test.
  - An assertion of the form "no request without permission" still holds.
  - An assertion of the form "both lists are requested on open" becomes "requested when the tab
    opens". This narrows _when_ the request happens, not _what_ is asserted. I will call this
    out in the report.
  - **Alternative, if the lead prefers:** keep every panel mounted and hidden. That preserves
    request timing exactly, but costs requests the operator may never look at.
  - **Tab state lives in `?tab=`**, so it is linkable and addressable by the screenshot harness.
- **CSS-class queries that may break:** `.pager` (services), `img.receipt-image` (payments), and
  `closest('section')` (many). Each will be switched to an equivalent role/label query only if
  the class disappears.
- **New tests:**
  - The tab strip on both detail pages: every tab reachable, and a denied tab still states its
    permission.
  - The stat cards render only server fields: unlimited traffic shows the word and no bar.
  - The route inventory for my routes, if FOUND's inventory test does not already cover them.

## 14. Phase 2 record

Branch `claude/w-commerce-a`, on the merged foundation. Presentation only: no API,
contract, backend, permission or query changed. Page CSS is `styles/pages/commerce-a.css`
(`ca-*` classes, no kit class restyled, no `style` attribute); the one new shared piece is
`pages/commerce-parts.tsx` (`ChipGroup`, a labelled group of kit `FilterChip`s). Three web
keys were added (`web.user_stat_trial_remaining`, `web.service_identity_title`,
`web.payment_tech_details`) and one removed because nothing renders it any more
(`web.user_identity_title` — its rows moved into the customer head).

### 14.1 What changed, per route

| Route            | Before                                                                             | Now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/users`         | Card with a stacked search form, a Pills row, a default table, pager; a scope card | One list card: the two exact-match boxes as a compact toolbar form (label, hint and inline error kept; Apply with a search icon, Clear as a ghost button), the status filter as a labelled chip group, a dense sticky-header table (name column gains a decorative initial tile; status badge gains a dot), the ascending pager at the foot; the scope card is muted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `/users/:id`     | PageHead «مشتری» + nine stacked cards                                              | `DetailHead`: initial tile, name (or `@username`, or «مشتری»), status badge, meta line (username, Telegram id with copy, language), block/unblock as the head action, and a strip — first seen, last seen, balance (only with `users.view` wallet read), trial remaining — read through the SAME query keys as the cards (no extra request). Blocked banner under it. `TwoColumn`: main = services, orders, wallet; side = access (status, blocked at/reason, reason-shown, marketing), trial, reseller, referral, scope. «All orders / all services / all referrals / manage reseller» links moved into the card heads. Block/unblock step two is a `Modal` (block: danger, warn banner, mandatory reason with the same two inline errors; unblock: plain confirm), error banner inside it                                                                                                                                                                                                              |
| `/trials`        | Four stacked cards                                                                 | Panels overview full width (dense, dot badges); `TwoColumn`: overrides + reset history (actor shown as an 8-char copyable id) / the global reset as a danger-zone card (preview, typed count, reason, solid-danger execute)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `/services`      | Refund queue card, a card with two Pills rows and a form, table, pager, rules card | Refund queue (dense, dot badges) unchanged in place; list card with the three exact-match boxes as a toolbar form (one form, one submit — unchanged), state and delivery as two labelled chip groups split by a divider, a dense sticky table (state badge filled, delivery badge outlined — two columns, never merged), the pager; the four rules as a muted notes list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `/services/:id`  | PageHead + refund card + banners + five stacked cards                              | PageHead: the username (LTR) with a copy button as the title, state + delivery (+ trial) badges, the ordinary actions as the head's button group (each refused one `aria-describedby` its blocker sentence). Banners. Four stat cards: traffic used (with the limit, a bar only when limited, and «synced at» or the «never read» sentence), expiry, delivery attempts (+ next attempt), device limit (or its sentence). Refund requests (decision form split into an approve block with a danger border and a reject block). `TwoColumn`: identity (provider user id, customer, order, panel, product, created, updated, username hint) / action notes (hint, the `services.edit` denial, one row per refused action: action name → blocker sentence) + delivery (subscription present/absent, delivered, provisioned, terminated, withheld sentence). Operations full width (dense; failure message verbatim, LTR). Transfer-absent note (muted). Terminate isolated in a danger-zone card at the foot |
| `/orders`        | As `/users`                                                                        | As `/users`: toolbar form (customer, product), state chips, dense sticky table (total end-aligned), ascending pager; scope and future-rules as two muted cards side by side                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `/orders/:id`    | PageHead «جزئیات سفارش» + ten stacked cards                                        | PageHead: the snapshot title, state badge, subtitle «جزئیات سفارش · <order id>». Banners. `TwoColumn`: main = what was bought (purpose, title, category, duration, traffic, devices, unit price, quantity, then subtotal/discount/total as a totals block), custom-service terms, pricing (reseller terms, code, adjustments, redemptions, cashback), the produced service + its operations; side = lifecycle (created, expires, confirmed, settled, updated — the state is the head badge), references, payments (one line each: reference link, state badge, amount), scope                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `/payments`      | Card with three Pills rows, a sentence and a form, table, pager                    | Toolbar form (reference, customer, order), state / method / disposition as three labelled chip groups, the `planned_missing_gateway` sentence under them, a dense sticky table (14 columns, amount end-aligned, state dot badge, disposition outlined), the URL-cursor pager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `/payments/:id`  | PageHead + up to twelve stacked cards                                              | PageHead: the reference (LTR) with a copy button, state badge, method as subtitle. UNKNOWN banner. `TwoColumn`: main = payment details (id, disposition, gateway, amount, customer, Telegram identity, order or top-up, external reference, created, updated, expires, signalled + hint), evidence, resolution, receipt credit, customer fee, gateway invoice (its rows inside a closed `<details>` — technical, one click away); side = the Telegram-review note for a pending manual transfer, destination, top-up gift, receipts. Full width: refunds (ledger inline; request form and the answer form each in their own block, the answer block danger-bordered because «abandon» is there; the issue error banner stays OUTSIDE the request form), then the timeline, then the not-settled-here note (muted)                                                                                                                                                                                        |
| `/compensations` | Card, table, pager                                                                 | Dense sticky table (payment link strong, amounts end-aligned, state dot badge), the URL-cursor pager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 14.2 Deviations from the Phase 1 plan (§11–§13), and why

- **No tabs on `/users/:id` or `/services/:id`.** Every card stays mounted, so every request
  fires when it did before and no existing "asks for X / asks for nothing" assertion moved.
  The reference's tab composition is approximated with a head + summary strip + two
  columns. Nothing about the tabs was a capability; they can be added later with
  `RoutedTabs` without touching any card.
- **Identity rows moved into the heads** rather than duplicated: the customer's username,
  Telegram id and language are the head's meta line and first/last seen are its strip; the
  service's username is the title (with copy), its traffic/devices/expiry/attempts are the
  stat cards; the payment's reference is the title (with copy), its state the badge and its
  method the subtitle; an order's state is the badge. Each value is drawn once, so no test
  query became ambiguous and no reader sees two copies that could disagree.
- **Order totals are the foot of the line card**, not their own card; the three figures are
  unchanged.
- **Payment timeline stays a table.** It is an ordered audit the server returns (28 tests read
  its rows and cells); it gains a dense layout, a tone dot per event kind beside the label,
  and an icon refresh button.

### 14.3 Capability checklist (§0–§10) — result: all preserved

Each line was checked against the code and the suite; «T» names the test that still pins it.

- [x] §0 Permissions arrive as props; denied cards draw the info banner and issue no request
      (users, services, orders, payments, trials suites; `commerce-a-redesign`: no wallet read
      and no balance without the permission).
- [x] §0 Keyset cursors, labels and cursor state per list unchanged (URL cursor: services,
      payments, compensations; trails: users, orders, embedded cards, trials, refund queue;
      wallet single cursor). T `labels the next page older…`, `steps the orders pager back one
page…`, both embedded pager-label tests, `pages the ledger…`.
- [x] §0 Filters in the URL, one `setQueries` per apply, draft follows the URL, cursor
      dropped. T `applies BOTH search boxes…`, `applies all three filters in ONE navigation…`,
      `clears the search boxes when navigation drops the query`.
- [x] §0 Ids validated against the contract before a request (Telegram id, uuidv7,
      provider username). T `refuses a malformed Telegram id…`, `refuses a partial id at the
field…`, `refuses a name the server would refuse…`.
- [x] §0 Toolbars hidden while the list cannot answer (`hidden={!mayRequest(…)}` on each
      toolbar row now, instead of one wrapper).
- [x] §0 View state only through `StateSwitch query=…` (state-switch contract test).
- [x] §0 Idempotency (`useSubmissionKey`, `settle`/`settleOn`) untouched on every write.
      T `repeats the SAME idempotency key…`, `reuses the key when a FAILED submission…`.
- [x] §0 Error mapping (`messageFor`, `refundMessageFor`, service toast) unchanged.
- [x] §0 Money/time/traffic/bidi formatting; no subscription URL/ref/client id rendered;
      destination `•••• last4` only. T `renders no subscription url…` (list and detail),
      `renders no subscription link…`, `never renders a full card number…`.
- [x] §0 Detail routes keyed by id; shared vocabularies still exported from their owners.
- [x] §1 `/users`: six columns, search only with `users.search` (else the named sentence),
      status chips for everyone, two empty states, ascending pager, no tags/commercial columns.
- [x] §2 `/users/:id`: identity rows (head), access rows, two-step block with the mandatory
      code-point-counted reason and unblock with no reason, trial card (override set/remove),
      reseller card, wallet (derived balance, entry count, negative warning, ledger, immutable
      note, credit/debit under their own permissions, fieldset disabled until the balance
      loads, no set-balance control), orders and services cards (bound 10, separate delivery
      column, links to the full lists), referral card, scope card, no activity feed.
      T all 49 of `users.test`, referrals/resellers/trials customer-card tests.
- [x] §3 `/trials`: four independently gated cards; reset needs the previewed count typed
      back and a reason, keyed; history pager. T `stays disabled until the previewed count…`,
      `names the permission…`, `lists each configured panel…`.
- [x] §4 `/services`: refund queue independent of `services.view`; two filter axes; exactly
      one form and one submit; exact-name lookup sent raw; trial badge; state and delivery in
      separate columns; rules copy. T all of `services.test` list block,
      `service-refund-requests.test`.
- [x] §5 `/services/:id`: refund requests + decision form (tick-to-approve, 300-emoji
      reject reason, toast by returned state, both keyed); banners; identity, traffic and
      delivery facts; one button per declared ordinary action, disabled with its blocker
      sentence; `services.edit` and `services.terminate` denials as sentences; terminate only on
      the exact typed phrase, sent as `confirm`; «planned»/«resent» toasts; refresh of service,
      operations and list; operations with the server's truncation bound; transfer-absent note.
      T all of `services.test` detail block; `commerce-a-redesign` (blocker as description,
      bar only when limited).
- [x] §6 `/orders`: read-only; two id filters + six state chips; snapshot title; ascending
      trail pager; scope and future-rules copy. T `presses every control it has and still
issues nothing but reads`, `offers every frozen state…`, `records the needs-attention…`.
- [x] §7 `/orders/:id`: awaiting/refunded banners; snapshot line (purpose, title, category
      snapshot, duration, traffic, devices, unit price, quantity) and totals; custom-service
      terms; pricing (reseller terms, code, adjustments, redemptions, cashback + unrecovered
      warning); lifecycle; references; payments (gated, truncation banner); produced service
      and its operations (gated). T `products-and-orders`, `discounts`, `resellers`,
      `custom-service` order tests.
- [x] §8 `/payments`: three chip axes, the missing-gateway sentence, three filters in one
      navigation, 14 columns, no evidence note on the list, URL-cursor pager. T all
      `payments.test` list cases.
- [x] §9 `/payments/:id`: no card-to-card decision for anyone; every conditional card absent
      (not dashed) when null; receipts only with `receipts.view` (object URL revoked, photo
      inline as `img.receipt-image`, document as a download); refunds (remaining is the
      server's figure, both forms, the issue error outside the form, answer complete/abandon
      disabling each other); pending-transfer note; timeline polling and reconciliation
      untouched. T `payments.test` (50), `payments-refund-consequences.test`,
      `payment-timeline.test` (28), `wp18-payments-topic-test`.
- [x] §10 `/compensations`: eight columns, reason words, URL-cursor pager. T
      `compensations.test`.

New behaviour is pinned in `tests/web/commerce-a-redesign.test.tsx` (7 cases, two of them
checked by mutation: removing the wallet leave guard and removing the blocker
`aria-describedby` each fail their case). The only edit to an existing assertion: the
wallet balance test now looks inside the wallet card (the head strip draws the same
derived balance) and additionally asserts the strip.

### 14.4 Forms and dirty state

`useUnsavedChanges` holds the leave guard while any of these holds typed input: the wallet
movement, the trial override, the trial reset confirmation, a refund request or answer, a
service refund decision. The block reason lives in a modal that cancel/Escape discards, so
it is not guarded.

### 14.5 Screenshots (`pnpm web:shots`, zero WARN)

Scratch paths, not committed: `/tmp/claude-0/ca-shots/final/` — every route dark at 1440,
`/users/:id` and `/services/:id` light, `/services`, `/users` and `/orders/:id` at 390, and
`/payments/:id` and `/services/:id` at 900. Fixture ids: user `019210ab-…6789abcdef01`,
service `019250ab-…`, order `019230ab-…`, payment `019240ab-…` (same suffix).

### 14.6 Left as it was, on purpose

- **Short ids on lists** are still the first 8 characters of a uuidv7, as before. Those
  characters are the timestamp, so rows created close together share them; showing a
  different slice is a product decision, not a presentation one.
- **The payments list keeps all 14 columns** and scrolls horizontally inside its card at
  desk width, as the inventory requires every column.
- **No kit change.** A disclosure (`<details>`) for technical sections is page-level here
  (`.ca-tech`); if other families need it, it belongs in the kit.

---

## 15. Roadmap B5 — Customer 360 as the operator's workspace

`/users/:id` gained what an operator answering a customer still had to leave the page for.
Everything else on the page (§2, §14) is unchanged.

| Section (anchor)                                         | Source                                                                                       | Gate (route prop ← permission)                                                                                                                                                                                | Deep links                                                                                                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| نیازمند رسیدگی (`#c360-attention`), first under the head | **`GET /users/:id/workspace` (new)**                                                         | `users.view` charged; each row null without its page's permission (server)                                                                                                                                    | `/services?q=<id>&state=UNRECONCILED`, `/payments?q=<id>&queue=UNKNOWN`, `/business-chats/<id>` for a single handoff (else `/business-chats?state=HANDOFF_REQUIRED`), `/tickets?customer=<id>&awaiting=support` |
| آخرین سفارش‌ها و پرداخت‌ها (`#c360-latest`)              | the same workspace: newest five of each, newest first                                        | each half null without `orders.view` / `payments.view` → the existing denial sentence, no "all" link                                                                                                          | `/orders/:id`, `/payments/:id`, `/orders?q=<id>`, `/payments?q=<id>`                                                                                                                                            |
| تیکت‌های پشتیبانی (`#c360-support`)                      | `GET /tickets?customer=<id>&limit=5` (the inbox's own endpoint) + the workspace's open count | `mayViewTickets` ← `tickets.view`; without it the denial sentence and NO request                                                                                                                              | `/tickets/:id`, `/tickets?customer=<id>`                                                                                                                                                                        |
| میان‌برهای اپراتور (side, first)                         | none — links only                                                                            | each link only under its list's permission (`orders.view`, `services.view`, `payments.view` ← `mayViewPayments`, `tickets.view`, `users.view` for the wallet, `business_chats.view` ← `mayViewBusinessChats`) | the lists, filtered by the filter each already has                                                                                                                                                              |

Why a new endpoint: `/orders` and `/payments` page OLDEST first (the owner's decision recorded
in §2), so "latest" had no read, and nothing counted one customer's tickets or handoffs. The
workspace is read-only, tenant-scoped by the session, charged `users.view` through the guard (a
refusal is the recorded 403 every customer read gives), and computes each section only under
the permission of the page it links to — `CUSTOMER_WORKSPACE_PERMISSIONS` — answering `null`
otherwise with no recorded denial (the financial summary's rule). Counts are the sidebar's
predicates narrowed to the customer, each `count(*)` over a LIMITed subquery (`COUNTER_CAP`);
the lists are bounded by `CUSTOMER_WORKSPACE_LATEST_LIMIT` = 5 and tie-broken on id. A glance
is not a history: the keyset-paged lists stay where they are, one link away, and the paged
orders card below is untouched.

Nothing is computed in the browser: the balance is still the wallet read, the counts are the
server's, a capped count is drawn as a floor, and a withheld section is said to be withheld
(«بخش‌هایی که مجوز صفحهٔ آن‌ها را ندارید…»), never drawn as zero. The status/block controls
(§2) and the existing commerce, wallet, reseller and referral cards are unchanged.

Borrowed, not copied: the payment state/method and ticket status vocabularies moved out of the
pages into `apps/web/src/payment-labels.ts` and `apps/web/src/ticket-labels.ts` (review N8), which
the payments and tickets pages and the workspace all import.

Review round (PR #240): «چیزی در انتظار رسیدگی نیست» is drawn only when all four counting
sections (tickets, handoffs, payments, services) were counted; over a withheld one only the
withheld note appears, and `orders` (which adds no row) is never reported as withheld (N3).

Tests: `tests/integration/customer-workspace.test.ts` (7), `tests/web/customer-workspace.test.tsx`
(14: rows and exact hrefs, zero/withheld, the "nothing waits" state, caps, the latest card and
its denials, the tickets card's request and its absence, the shortcuts, and the ROUTE deriving
each new prop from its own key — an actor with only `users.view` sees none of them). Mutation
record: `docs/web-redesign/dashboard.md` §8.
