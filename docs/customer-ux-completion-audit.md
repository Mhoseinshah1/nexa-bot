# Customer Telegram UX completion — audit and decisions

Baseline: `main` at `4d0627c2bef136adbd7a5291a58d689743b7cf5f` (PR #72 merged; post-merge CI run 933 green).

The owner defined the customer-facing UX in full (the package brief, §A–§W). This document was written before the production code, as §R requires. For every requirement it records what exists at the baseline, what is missing, the domain path reused, the schema needed, the permission, the idempotency rule, the tenant-isolation rule, the tests, and the compatibility risk. Falsification rows are in `docs/customer-ux-completion-falsification.md`.

Scope set by the owner and kept: no Payment Fee, no invented external gateway, no release, tag or deploy, no fake buttons, no rewritten Persian defaults. Where a detail was not specified, current Nexa semantics are preserved, the safer behaviour is chosen, and the choice is recorded in §Z.

## Facts at the baseline that shape the design

- **The Telegram transport sends JSON only.** `telegramCall` (`apps/api/src/infrastructure/telegram/send-message.ts:91-166`) posts `application/json`; media can only be re-sent by an existing `file_id` (`fileMessageBody`). A QR code generated here has no `file_id`, so the transport gains a multipart upload path. There is no long-message splitting anywhere.
- **The delivery message is one HTML line.** `DeliveryService.deliver` sends `bot.service.subscription` = `لینک اشتراک شما:\n<code>{subscriptionUrl}</code>` (`delivery.service.ts:285-290`). Its durability (`markSendStarted`, `UNKNOWN → UNCONFIRMED`, 429 requeue) is right and is kept.
- **The renderer leaves a missing optional token as the literal `{token}`** (`packages/i18n/src/index.ts:163`). `bot.service.detail` therefore shows `{expiresAt}` for an unlimited service and `{syncedAt}` for one never synced, and the summary shows `{username}` when no name is reserved. Also `serviceDetail` passes the raw state enum into the text (`bot-runtime.ts:7959`). Both are fixed here, because the new cards would inherit them.
- **The add-traffic / add-time package screen cannot render.** `addonChoice` (`bot-runtime.ts:8025-8040`) puts `values` on a `TEMPLATE` label, which carries none; `bot.service.addon_option` requires `title` and `price`, so the resolver throws and the customer gets nothing. No test taps `v:` or `h:`. Fixed in §H5 with a test.
- **Every adapter hard-codes `lastConnectionAt: null`** (marzban 189, rickpanel 212, sanaei 451). Never-connected and unsupported are the same `null`. No research or acceptance evidence establishes a last-seen field for any panel, so none is claimed.
- **`REFERRAL_SIGNUP_GIFT` is already a ledger reason with no writer.** No new ledger reason is needed.
- **Payment gateways** are `(tenant, provider)` rows with `status`, `sort_order` (the display order), `topup_cashback_percent`, bounds and eligibility, and exactly one provider, `MANUAL_TRANSFER`. There is no allowed-for-purchase / allowed-for-top-up flag and no real external provider. `offer()` returns ONE route.
- **Products** have `title`, `description` (≤2000, rendered nowhere), no version column and no display metadata. `service_addons` (ADD_TRAFFIC / ADD_TIME) are tenant-level; renewal is the product itself re-priced.
- **Customers** have no phone column and no counters. `support.accounts` is a declared setting (list of handles, `consumer: 'PLANNED'`) with a Web editor already, read by nothing.
- **Captures** are per-table windows (`username_captures`, `discount_code_captures`, `receipt_captures`, `admin_amount_captures` with a purpose column). The customer has no generic text capture.
- **Dates** reach customers as ISO UTC. The tenant carries `display_timezone` (default `Asia/Tehran`) and `calendar` (default `jalali`), read by nothing on the bot side. Node's ICU renders `fa-IR-u-ca-persian` correctly (verified).
- **No media store exists.** The only file mechanism is a Telegram `file_id`, which is bot-scoped.

## §A — global principles, how each is held

| principle                   | mechanism                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB is the source of truth   | every card is rendered from rows re-read on the tap; a provider read never changes a state, only `traffic_used_bytes` / `usage_synced_at`                                                               |
| tenant isolation            | every new repository method calls `requireTenantId(scope)` and filters by `tenant_id` AND `customer_id` where a customer is involved                                                                    |
| untrusted identifiers       | callbacks carry ids only; `ownedService`, `orderForCustomer`, the capture's `customer_id` and the FAQ / gateway tenant filter decide; nothing is read from callback text as a fact                      |
| re-read on callback         | unchanged idiom (`ownedService`, `orderForCustomer`, `customerActionsFor` re-run on the tap)                                                                                                            |
| no network in a transaction | the QR is encoded before the send, outside any transaction; the banner bytes are read in one transaction and sent after it; provider work stays in the provisioner                                      |
| exactly-once money          | new writers (signup gift) use unique ledger references and a conditional UPDATE naming `from` states; top-up principal and gift stay `wallet_entries_topup_payment_key` / `_topup_cashback_payment_key` |
| provider idempotency        | no new provider call shape; refresh is a `SYNC_USAGE` operation through `planRequestedOperation`                                                                                                        |
| redelivery                  | all commands keyed by the update key or by a capture id (UUIDv7), replay returns the first result                                                                                                       |
| truthful buttons            | every button is drawn from a server-side decision that is re-decided on the tap; unsupported = hidden; a refusal maps to a typed reply                                                                  |
| no zero-for-unknown         | `usage_synced_at IS NULL` renders as unknown; unlimited stays «نامحدود» (PR #72 rule); last seen unsupported renders as unavailable                                                                     |
| tenant dates                | DATETIME placeholders render in the tenant's timezone and calendar (§H)                                                                                                                                 |
| secrets out of logs         | the QR encoder, the multipart body and the delivery composer log ids and outcomes only; a test asserts the subscription URL never reaches a log line or an audit row                                    |

## §B — service delivery after a successful purchase

- **Current.** Text-only `bot.service.subscription`, no buttons, sent by `DeliveryService.deliver`, re-sent by `redeliver` (customer) and `resendForOperator`, re-armed after a rotation.
- **Missing.** The rich card, the QR, the three buttons, a media message, the caption-limit arrangement, a tutorial flow for `📚 مشاهده آموزش استفاده` (none exists), the FAQ flow for `😐 مشکل دارم`.
- **Design.**
  - `QrCodeEncoder` port (provisioning application ports): `encode(text): Uint8Array` (PNG). Infrastructure implementation `infrastructure/qr/qr-png.ts` over `qrcode-generator` (zero dependencies) and a PNG writer on `node:zlib`. It is called with the EXACT `subscriptionUrl` the row holds at send time — the same value `markSendStarted` compares-and-sets — and with nothing else. A recording fake in tests asserts payload equality.
  - `CustomerFileMessage.source` becomes a union: `{ kind: 'FILE_ID', fileId }` (today) or `{ kind: 'BYTES', bytes, fileName, mimeType }`. `telegramCall` gains multipart encoding for the second; the JSON path is untouched.
  - The card is `bot.service.delivered` (TELEGRAM_HTML): the exact approved lines. `{serviceLocation}` is the product's `service_location_label`; its line is omitted when none is configured (renderer rule below). `{durationText}` and `{trafficLimitText}` are DURATION_DAYS / TRAFFIC_LIMIT placeholders through the PR #72 formatter. Buttons: `bot.service.tutorial_button` (`tu:`), `bot.service.connected_button` (`ok:<serviceId>`), `bot.service.problem_button` (`sp:`).
  - **One media message when the rendered caption ≤ 1024 characters** (Telegram's caption cap; the URL is inside it whole). Otherwise, deterministically: the photo with the short caption `bot.service.delivered_qr_caption`, then the full card as a text message carrying the buttons. The URL is never split: it is in exactly one message either way.
  - Durability unchanged: `markSendStarted` before the first send; the recorded outcome is the worst of the sends (`UNKNOWN` beats `DELIVERED`), so an ambiguous second send is `UNCONFIRMED`, never `DELIVERED`. No new attempt is spent on a 429. `redeliver` and `resendForOperator` send the same card; the operator copy carries no buttons.
  - `وصل شدم` answers `bot.service.connected_ack` and writes nothing financial or provider-side (an audit-free acknowledgement; recorded as nothing because it changes nothing — the rule against reporting a write that did not happen).
- **Schema.** None for delivery itself (the location label is §C).
- **Permission.** As today (`deliver` is system work; `redeliver` is ownership).
- **Idempotency.** As today (`delivery_state` compare-and-set).
- **Tenant isolation.** As today (`services` rows; the contact resolves per tenant).
- **Tests.** Unit: QR payload equality (recording encoder), PNG validity and round-trip decode, caption-limit arrangement (both branches), URL appears in exactly one message, worst-of outcome. Integration: provisioning delivery sends a photo with the card and three buttons; redeliver sends the same card; UNKNOWN on the text part yields `UNCONFIRMED`.
- **Compatibility risk.** `bot.service.subscription` stays in the catalogue (tenant overrides may exist) but is no longer sent; recorded. The provisioning-delivery tests that assert a `sendMessage` body change to assert a `sendPhoto` multipart body.

## §C — product display metadata

- **Current.** `title`, `description` (unused by the bot), commercial and provisioning fields. `productWriteSchema` has no version.
- **Missing.** Ordered locations, ordered features, service-location label. The public title is `title` (reused: the product's name IS its public name — no second title field, which would be two names for one thing). The customer-facing description reuses `description`, which the admin already edits and nothing else consumes.
- **Schema.** `products.display_locations jsonb NOT NULL DEFAULT '[]'`, `products.display_features jsonb NOT NULL DEFAULT '[]'`, `products.service_location_label text NULL`. Bounds in contracts: 30 locations ≤ 60 chars, 30 features ≤ 200 chars, label ≤ 60. Existing rows take the defaults — an empty section is omitted, never a false claim.
- **Routing rule.** The provisioner resolves the panel from `products.panel_id` and the service's `panel_id` only; display strings are read by the catalogue projection and the renderers and by nothing under `provisioning/`. Pinned by a test that provisions a product whose display locations name another panel's host and asserts the service lands on `panel_id`'s panel, and by the boundary that `ProductRepository` methods used by provisioning never select the display columns (`ProductSpecification` is unchanged).
- **Permission.** `catalog.edit` (existing product edit permission), `catalog.view`.
- **Idempotency.** As today (`WEB` namespace, request hash includes the new fields).
- **Tenant isolation.** As today.
- **Compatibility.** `productWriteSchema` takes the three fields as OPTIONAL with defaults, so a client on the previous release still writes; `productSummarySchema` gains them (additive). No version column is added: products have never had one, and inventing optimistic concurrency for one resource is out of scope; recorded in §Z.
- **Tests.** Unit: schema bounds and ordering. Integration: create/update round-trips ordered lists; Web: the form edits ordered lists.

## §D — pre-invoice

- **Current.** `orderSummary` renders one of four `bot.order.summary*` bodies with a confirm button; payment buttons (wallet, manual, cancel) appear only after `c:` moves the order to `AWAITING_PAYMENT`. A `g:` tap answers `bot.payment.unconfigured`.
- **Design.**
  - `bot.order.preinvoice` with the approved lines; `{orderedLocationLines}` / `{orderedFeatureLines}` are optional STRING tokens built by the surface from `bot.order.preinvoice_location_line` / `_feature_line` (`• {value}`); the locations heading is `bot.order.preinvoice_locations_heading`. Discount and cashback keep their truth as optional lines (`bot.order.preinvoice_discount_line`, `_cashback_line`) — a discounted order still shows the final price on `💵 قیمت`. `{walletBalance}` is read on render.
  - Payment buttons ON the pre-invoice: `💰 پرداخت از کیف پول` (`w:`), `💳 پرداخت با درگاه` (`g:`, drawn only when ≥1 ACTIVE gateway whose descriptor `settlesVia === 'GATEWAY'` allows service purchase — none exists, so it is never drawn), `🧾 ثبت پرداخت` (`m:`, drawn when the manual route is ACTIVE and allows purchase and an account is enabled), `🏷 اعمال کد تخفیف` (`dc:` / `dx:`), `🏠 بازگشت به منوی اصلی` (`mm:`). The old `c:` handler stays for messages already sent.
  - A wallet tap on a DRAFT: balance is read first; a shortfall answers `bot.wallet.insufficient` with the top-up button and confirms nothing (no reservation is held for money that is not there); otherwise `orders.confirm` (key `…:confirm`) then `settleFromWallet` (key `…:wallet`) — the second is the existing exactly-once settlement. A manual tap on a DRAFT confirms then `requestManualTransfer`. A gateway tap with zero real providers answers `bot.payment.unconfigured` — but the button is not drawn.
  - **Splitting.** `TelegramCustomerMessenger.send` splits any rendered body over 4096 characters at paragraph boundaries (`\n\n`), then line boundaries, never inside a line; the keyboard goes on the last part; the outcome is the worst of the parts. Generic, so FAQ (§J) uses the same rule.
- **Selector model.** `PaymentGatewayService.routesFor(scope, customerId, purpose, amount?)` returns every ACTIVE, eligible route allowed for the purpose, ordered by `(sort_order, provider)`, each with its descriptor. `selectExternal(routes)` is a pure function over descriptors, unit-tested with fake descriptors (`settlesVia: 'GATEWAY'`) that never become rows — the CHECK constraint on `provider` keeps the database honest.
- **Schema.** `payment_gateways.allow_service_purchase boolean NOT NULL DEFAULT true`, `allow_wallet_topup boolean NOT NULL DEFAULT true`.
- **Permission / idempotency / isolation.** Existing order and payment paths.
- **Tests.** §O5: discount + wallet, discount + manual, selector with zero providers, selector with fake descriptors. §Q pins the pre-invoice text, order of buttons, absence of the gateway button, the split of a long features list with the keyboard on the last part.
- **Compatibility.** `bot.order.summary*` keys stay for overrides; the surface stops sending them. `bot.order.awaiting_payment` is still sent after a manual request.

## §E — wallet page

- **Current.** `bot.wallet.balance` + top-up and referral buttons.
- **Design.** `bot.wallet.summary` with the approved lines. `{telegramId}` from the customer row; `{displayName}` = first + last name, else username, else the Telegram id (`bot.wallet.name_unknown` is not needed: a customer always has an id); `{phoneState}` is `bot.wallet.phone_missing` = `🔴 ارسال نشده است` (no phone column, none added); `{registeredAt}` = `customers.created_at` in the tenant calendar; `{serviceCount}` = services rows for the customer; `{paidInvoiceCount}` = CONFIRMED payments for the customer; `{referralCount}` = `countReferredBy`; `{customerGroup}` = `bot.wallet.group_reseller` when `ResellerService.standing` is non-null, else `bot.wallet.group_customer`. Buttons: `💰 افزایش موجودی` (`o:`), referral (`rf:`) when terms are active, `🏠 بازگشت به منوی اصلی`.
- **Reads.** `CustomerReadRepository.counters(scope, customerId)` — one query, tenant + customer scoped.
- **Tests.** §Q pins the text; a test with two customers proves the balance and counters are the tapping customer's.

## §F — wallet top-up

- **Current.** Preset amount buttons → `requestWalletTopup` → manual transfer instructions. One route.
- **Design.**
  - `افزایش موجودی` opens a `customer_text_captures` row with purpose `TOPUP_AMOUNT` (TTL `CUSTOMER_TEXT_CAPTURE_TTL_MS` = 10 min) and replies `bot.wallet.topup_amount_prompt` (with the presets as shortcut buttons `y:` when configured — a shortcut records the amount on the capture and continues).
  - The typed amount is parsed by `parseCustomerAmount`: Latin, Persian (۰–۹) and Arabic-Indic (٠–٩) digits, separators stripped, integer, > 0, in the installation's currency (major units → minor via the currency exponent). Validated against `wallet.topup.minimum` (exists) and the NEW `wallet.topup.maximum` (0 = no ceiling; the route's own `max_amount_minor` and `MAX_MONEY_AMOUNT_MINOR` still apply).
  - Then `💳 روش پرداخت خود را انتخاب نمایید` (`bot.wallet.topup_method_prompt`) listing `routesFor(WALLET_TOPUP, amount)`: each button `پرداخت با {name}` or `پرداخت با {name} ({percent} درصد شارژ هدیه)` when the route's `topup_cashback_percent > 0`; `{name}` is `display_name` or the product name for the route (`bot.payment.route_name_manual_transfer`). Callback `tp:<captureId>.<provider>` (54 bytes). Plus `❌ بستن لیست` (`tx:<captureId>`).
  - Choosing re-reads the capture (owner, `AMOUNT_RECORDED`, unexpired), re-decides the route (ACTIVE, allowed for top-up, eligible, amount within bounds) and calls `requestWalletTopup(amount, provider)` with key `topup-capture:<captureId>`; a replay returns the first payment.
  - **Financial invariant** unchanged: principal `TOPUP_RECEIPT` and gift `CASHBACK_TOPUP` are separate entries; `creditToWallet` (receipt credit) writes `RECEIPT_CREDIT` and no gift. Both already pinned; re-pinned in §O2.
- **Schema.** `customer_text_captures` (id, tenant_id, bot_instance_id, customer_id, purpose CHECK, subject_id uuid NULL, amount_minor bigint NULL, amount_currency text NULL, text NULL, state CHECK, expires_at, closed_at, close_reason, created_at; partial unique on `(tenant_id, bot_instance_id, customer_id) WHERE closed_at IS NULL`). Setting `wallet.topup.maximum`.
- **Permission.** Customer path (`maintenance.run` as the existing customer payment paths).
- **Idempotency.** Capture open: update key; amount record: capture row conditional UPDATE; request: capture-derived key.
- **Tenant isolation.** Capture rows carry tenant and customer; the route list is the tenant's.
- **Tests.** §O2 in full.

## §G — my services list

- **Current.** Keyset "more" pages of 20, no total, no search, no previous.
- **Design.** Page-number pagination (`ServiceRepository.pageForCustomer(scope, customerId, {page, size})` returning items and total, ordered `created_at DESC, id DESC`); `bot.service.list` with the approved text; one button per service `✨ {username} ✨` (`s:`); bottom rows `[جستجو نام کاربری][🔎 جستجو]` (both open the search capture, `ss:`), `[◀️][{page}/{pages}][▶️]` (`sl:<page>`; the middle re-renders the page — nothing dead), `🔙 بازگشت به منوی اصلی`. A page beyond the last is clamped to the last page (a stale callback fails safely). Search opens a `SERVICE_SEARCH` capture; the typed text is canonicalised (lowercase, digits normalised, ≤ 64 chars) and matched as a prefix on `provider_username` WITHIN `(tenant_id, customer_id)` in SQL.
- **Tests.** §P: ownership, pagination, search isolation (a crafted username of another customer returns nothing), stale page.

## §H — service detail and management

- **Design.** `bot.service.card` with the approved lines. Status text via `bot.service.state_<state>` keys with the emoji in the body; `{serviceLocation}` line omitted when no label; traffic: limit through TRAFFIC_LIMIT, used through BYTES **only when `usage_synced_at` is set** — otherwise the used and remaining lines say `bot.service.usage_unknown`; remaining = limit − used (floored at 0) with percent; unlimited → remaining «نامحدود», no percent; `{expiryDate}` in the tenant calendar with `{remainingTime}` in days, or `bot.service.no_expiry` when unlimited; `{lastSeenText}`: `bot.service.last_seen_unavailable` unless the row carries a proven value (§H "last seen" below); the hint line is drawn only when the rotate button is offered. A note line `📝 {note}` when set.
- **Buttons, each gated:**
  1. `♻️ بروزرسانی اطلاعات` — `ProvisioningService.requestSyncFromCustomer`: ownership, ACTIVE, `READ_USAGE` operability, and not within `CUSTOMER_SYNC_MIN_INTERVAL_MS` (60 s) of the last sync; queues `SYNC_USAGE` with `requested_by_customer_id` through `planRequestedOperation` (the provider is never called from the API process); replies `bot.service.refresh_requested`. `SYNC_USAGE` joins `CUSTOMER_REQUESTABLE_OPERATIONS` so the announcer tells the customer the outcome; a failed sync writes nothing to the row (`recordUsage` runs on `ok` only — held today, re-pinned).
  2. `🔗 لینک اشتراک` — `delivery.redeliver`: the stored URL, never regenerated.
  3. `⚙️ تغییر لینک` — existing `rc:`/`rd:` rotation (flag, cooldown, capability). The new-link message is the delivery card. Old-link invalidation is claimed only in the rotate template as the provider proved (unchanged wording).
  4. `📝 تغییر یادداشت` — `SERVICE_NOTE` capture (subject = service id); `ProvisioningService.setCustomerNote(scope, customerId, serviceId, note)` under the service row lock, ownership in the WHERE, ≤ 200 code points, control characters stripped; audit `service.customer_note`; key = capture id.
  5. `➕ خرید حجم اضافه` — `commercial.offer(ADD_TRAFFIC)` (label defect fixed: `TEXT{title, amount}`), quote rendered as the §D pre-invoice with the same payment buttons; settlement then the operation apply traffic once (existing `service_commercial_actions` + one open operation per service).
  6. `💊 تمدید سرویس` — one screen: the renewal (the product re-priced) and the ADD_TIME add-ons; each to a quote → pre-invoice. Remaining days preserved by `extendedExpiry`; cashback earned only after `SUCCEEDED` (existing, re-pinned).
  7. `❌ خاموش کردن اکانت` / 8. `✅ روشن کردن اکانت` — `customerActionsFor` (state + `DISABLE_USER` / `ENABLE_USER` capability); Sanaei never shows them.
  - `🏠 بازگشت به لیست سرویس ها` → the list. The existing terminate ask stays below the approved buttons (capability-gated, functional) — removing a working customer action is not asked for.
- **Last seen.** `ProviderUsage.lastConnectionAt: Date | null` becomes `lastSeen: { kind: 'AT'; at: Date } | { kind: 'NEVER' } | { kind: 'UNSUPPORTED' }`. Every adapter returns `UNSUPPORTED` today (truthful; no evidence for any panel). Persisted as `services.last_seen_at timestamptz NULL` + `services.last_seen_state text NULL` (CHECK), written by `recordUsage` when the adapter proves a value, never written from `UNSUPPORTED`. Rendering: `AT` → the time in the tenant calendar; `NEVER` → `متصل نشده`; otherwise → `bot.service.last_seen_unavailable`.
- **Schema.** `services.customer_note text NULL`, `services.last_seen_at`, `services.last_seen_state`.
- **Tests.** §P in full, including a fake adapter that returns `NEVER` vs `UNSUPPORTED` and the two renderings.

## §I — referral screen and the signup gift

- **Current.** `bot.referral.invite` text with code, link and count. Commission promised at confirmation, earned at delivery, reversed on refund. `REFERRAL_SIGNUP_GIFT` unused.
- **Design.**
  - Screen: banner photo (when configured) then `bot.referral.screen` with the approved copy, terms and stats; buttons `🔗 اشتراک گذاری لینک` (a URL button to `https://t.me/share/url?url=<link>` — a new `CustomerUrlButton`), `🎁 دریافت هدیه عضویت` (`rg:`, drawn only when the gift flag is on), `🏠 بازگشت`. When the caption would exceed 1024 the banner goes first with no caption and the text follows with the buttons — the same deterministic rule as §B.
  - **Banner.** `tenant_media_assets` (tenant_id, purpose CHECK `REFERRAL_BANNER`, mime_type CHECK png/jpeg, bytes bytea ≤ 1 MiB, sha256, version, timestamps; PK `(tenant_id, purpose)`). Uploaded and cleared from the Web Admin referral section as base64 JSON under `settings.edit`; sent by bytes through the multipart path. No filesystem path anywhere.
  - **Terms.** Feature flag `referral_signup_gift` (TENANT_WIDE, off) configured by settings `referral.signup_gift.total` (Money, 0 = disables), `referral.signup_gift.referrer_percent` (0–100, default 50), `referral.signup_gift.referred_percent` (default 50). A `SettingChangeGuard` refuses a save that leaves the two shares ≠ 100 while the flag is on, and the flag refuses to turn on while they are ≠ 100 or the total is 0.
  - **Two rewards, kept apart (owner's rule).** The MEMBERSHIP gift is owed the moment a new customer's first `/start` carries a valid referral link and the attribution is accepted; it is split by the two configured shares, paid once per side, and requires NO purchase, payment, provisioning or delivery — nothing about orders appears in its eligibility or its claim. The PURCHASE commission is the other reward and keeps its own rule: promised at confirmation, earned when the referee's order is delivered, reversed on refund. The two write distinct ledger reasons (`REFERRAL_SIGNUP_GIFT`, `REFERRAL_COMMISSION`) and never feed each other.
  - **Eligibility and claim.** `referral_signup_gifts` (id, tenant_id, referral_id UNIQUE, referrer_id, referee_id, total, referrer_amount, referred_amount, currency, referrer_entry_id, referee_entry_id, referrer_claimed_at, referee_claimed_at, created_at). `ReferralSignupGiftService.claim(scope, actor, customerId, {idempotencyKey})`: flag on and terms valid, else `REFERRAL_GIFT_DISABLED`; locks the customer's referral row(s) `FOR UPDATE` — as referee (their own share) and as referrer (each referee's referrer share); the gift row is created on the first claim with the terms snapshotted, so the second party receives the complement of the same total; each share is one `REFERRAL_SIGNUP_GIFT` credit with reference `<referralId>:signup-gift:<REFERRER|REFEREE>` (unique per tenant — the backstop) and a conditional UPDATE `WHERE <side>_claimed_at IS NULL`; self-referral cannot exist (attribution refuses it) and the claim re-checks `referrer_id <> referee_id`; nothing claimable answers `bot.referral.gift_nothing`. Independent from commission; no recursion (amounts come from settings, never a ledger entry).
  - **Stats.** referral count = `countReferredBy`; purchases = FULFILLED orders of referees (count, sum of totals); commission received = `REFERRAL_COMMISSION` credits minus `REFERRAL_COMMISSION_REVERSAL` debits for the referrer, from the ledger.
- **Permission.** Claim: customer path under `maintenance.run` like the other customer writes; banner: `settings.edit`/`settings.view`.
- **Tests.** §O3 in full, including two concurrent claims and tenant isolation. §O4 regression: commission earned on delivery, none on failed/unknown, reversed on refund.

## §J — support / FAQ

- **Current.** `📚 راهنما` → `/help` → static `bot.help`. `support.accounts` declared, unread. No FAQ, no tutorial.
- **Design.**
  - `support_faqs` (id, tenant_id, question ≤ 300, answer ≤ 2000, status CHECK ACTIVE/INACTIVE, sort_order, version, created_at, updated_at). `support_faq_seeds` (tenant_id PK, seeded_at): the nine approved defaults are inserted from the catalogue (`bot.faq.default_<n>_question` / `_answer`) the first time a tenant's FAQ is read or listed and the seed row is absent — Persian never enters a SQL file, and a tenant that deleted every FAQ is not re-seeded.
  - Screen: `bot.faq.heading`, items `bot.faq.item` (`{number} {question}\n\n✅ {answer}`, number = 1️⃣…9️⃣, 🔟, then `11.`), footer `bot.faq.footer`; split at item boundaries over 4096, keyboard on the last part. Buttons `📨 ارسال پیام به پشتیبانی` (URL button to `https://t.me/<first support account>`; hidden with `bot.support.unconfigured` shown when the list is empty) and `🏠 بازگشت`. No active FAQ → the support action directly (`bot.support.contact`).
  - `support.accounts` becomes `consumer: 'ACTIVE'` — it already has a Web editor.
  - `😐 مشکل دارم` (`sp:`) and `/help` and the menu button open this screen. `📚 مشاهده آموزش استفاده` (`tu:`) opens `bot.tutorial.choose` with an OS row (`to:<OS>`; `CONNECTION_GUIDE_PLATFORMS` = ANDROID, IOS, WINDOWS, MACOS, LINUX) and each renders `bot.tutorial.<os>` — raw templates the operator edits in Content. Defaults are short and neutral (§Z).
- **Web Admin.** `/support` page: FAQ list, create, edit (question, answer, sort order) with `expectedVersion`, activate/deactivate; the destination is the existing `support.accounts` editor on the settings page, linked from the support page. Routes under `SUPPORT_FAQ_ROUTES`; permission `settings.view`/`settings.edit`; audit `support_faq.create|update|status`; idempotency `WEB` namespace.
- **Tests.** §Q pins the seeded text and the split; §P/§T: FAQ tenant filter, destination from the right tenant.

## §K — main menu and routing

`bot.menu.help` is relabelled `💬 پشتیبانی` and routes to the FAQ (`/help`). Tutorial access is the delivery card's button. `/start`, `/catalog`, `/services`, `/wallet` unchanged. `🏠 بازگشت به منوی اصلی` (`mm:`) replies `bot.start.welcome_back` with the persistent keyboard.

## §L — Web Admin configuration

| area                                  | where                                                                                        | permission               |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------ |
| product display fields                | products form (ordered list editors for locations and features, label input)                 | `catalog.edit`           |
| gateway allow-purchase / allow-top-up | payment-gateways form (two switches; `sortOrder`, `topupCashbackPercent` already there)      | `payments.gateways.edit` |
| referral signup gift                  | settings page (three keys) + features page (flag); banner upload/clear on the referrals page | `settings.edit`          |
| support destination                   | settings page (`support.accounts`, existing editor)                                          | `settings.edit`          |
| FAQ CRUD / order / activation         | new `/support` page                                                                          | `settings.edit`          |

All mutations: guard-checked, tenant-scoped, audited, idempotent; FAQ carries `version` + `expectedVersion`; the banner carries `version`.

## §M — message architecture

Every string is a `TEMPLATES` key with a body in `catalogue.fa.ts`; the approved defaults are those bodies verbatim. Structured screens are composed by the surface from the main body plus per-line keys (the `bot.admin.receipt` idiom), so an absent optional block is omitted and the operator can still edit each piece. **Renderer rule added:** a declared OPTIONAL placeholder with no value renders as empty, and when it stood alone on its line the line goes with it — the literal-`{token}` leak is closed for every existing key. **Presentation rule added:** DATETIME renders in the tenant's timezone and calendar (`fa-IR-u-ca-persian-nu-latn` for `jalali`, Latin digits to match `formatMoney`), through a `TemplatePresentation` the resolver reads from the tenant row. Nothing rendered is persisted.

## §N — callbacks and captures

`customer_text_captures` with `purpose ∈ {TOPUP_AMOUNT, SERVICE_SEARCH, SERVICE_NOTE}`, `subject_id`, TTL 10 minutes, one open per (tenant, bot, customer). Opening one supersedes the customer's other open windows — username and discount included, through a `CustomerWindowSuperseder` port both directions — so the most recent prompt is the only reader. A typed message is offered to: admin capture → customer text capture → username → discount → unknown-command, each closing itself as EXPIRED past its deadline and answering `NO_WINDOW`. New callbacks carry ids only (`tp:` capture id + provider enum; `sl:` a page number that is clamped; `to:` a platform enum).

## §O / §P / §Q — test matrices

Named files: `tests/integration/customer-ux-payments.test.ts` (§O1, §O2, §O5), `tests/integration/referral-signup-gift.test.ts` (§O3, §O4), `tests/integration/customer-ux-services.test.ts` (§P), `tests/integration/customer-ux-screens.test.ts` (§Q pins), `tests/unit/qr-png.test.ts`, `tests/unit/customer-amount.test.ts`, `tests/unit/message-split.test.ts`, `tests/unit/gateway-selector.test.ts`, `tests/unit/template-presentation.test.ts`, `tests/web/support-faq.test.tsx`, `tests/web/products-display.test.tsx`, `tests/web/payment-gateways.test.tsx` (extended), `tests/web/referral-banner.test.tsx`.

## §S — migrations

`0119` onward, additive only: products (3 columns), payment_gateways (2 booleans), services (3 columns), `customer_text_captures`, `support_faqs`, `support_faq_seeds`, `referral_signup_gifts`, `tenant_media_assets`. No backfill of customer-facing claims; no historical financial row reinterpreted; every new table has `tenant_id NOT NULL` and a leading index; every status column has a CHECK from a contract enum. `migration-compatibility.test.ts`'s forbidden list is respected (no DROP, RENAME, TRUNCATE; `SET NOT NULL` only on columns this batch adds).

## §Z — choices the brief left open, and what was chosen

- **Refresh is queued, not synchronous.** A synchronous provider read from the API process would bypass the operation model (the brief's own DO NOT). The customer is told the request is recorded and the outcome arrives on the notification lane.
- **Last seen is unavailable for every panel today.** No panel's last-seen field is evidenced, so no adapter claims one; the typed tri-state and the columns exist so an adapter proven by acceptance can fill them.
- **Products get no version column.** They never had one; the brief asks for version protection "where project conventions require it", and the product editor's convention is last-writer-wins. Recorded, not changed.
- **No new permission keys.** FAQ, destination and banner are tenant configuration under `settings.*`; display fields under `catalog.edit`; gateway flags under `payments.gateways.edit`. A new key would need a backfill migration and seeds for a distinction no role needs today.
- **The signup gift is claimable for any valid attribution while the flag is on.** The referral row does not record the terms in force at attribution; restricting eligibility to attributions made after enabling would need a fact that does not exist. The safer reading is that the operator turning the flag on is offering the gift to their referred customers; the total is snapshotted at the first claim so both shares always sum to it.
- **Tutorial copy.** None was supplied. Five short neutral defaults exist so the button is real; the operator edits them in Content.
- **Terminate stays on the card**, below the approved buttons, capability-gated.
- **Digits.** Dates use Latin digits in the Persian calendar, matching `formatMoney`.
- **`bot.service.subscription`, `bot.order.summary*`, `bot.help`** stay in the catalogue (tenant overrides may exist); the surface no longer sends them.

## §Z2 — settled while building

Decisions the code forced after the audit above was written, recorded here rather than left implicit:

- **A terminal FAILED customer request is announced.** `OperationOutcomeAnnouncer` answered only SUCCEEDED and ABANDONED; a customer whose SUSPEND, RENEW or usage read failed for good heard nothing. Since a customer can now ask for a `SYNC_USAGE`, a FAILED row with no retry scheduled is an outcome and is announced `SERVICE_ACTION_FAILED` (a FAILED with a retry pending is not, and is not stamped). Migration `0120_announce_historical_failures` stamps the FAILED rows that completed under the old rule as answered at their completion, so the sweep announces no history; `dueForAnnouncement` picks up terminal FAILED rows since.
- **A zero gift share is neither paid nor stamped.** `referral_signup_gifts` requires an entry id beside a claim stamp and `wallet_entries` requires a positive amount, so a share of 0 is simply never claimable (`claimableFor` omits it) and `claim` skips it; the other side receives the whole total.
- **"Fulfilled" for the referral statistics** is an order in state `PAID` whose `PURCHASED_AS[purpose]` operation `SUCCEEDED` — the same predicate the commission earner uses; there is no FULFILLED order state.
- **`wallet.topup.maximum` binds the typed amount.** A preset is the operator's own figure and keeps the preset path's rules (`wallet.topup.minimum`, the route's bounds); the presets remain shortcuts onto the same capture and chooser.
- **The renderer's line rule** drops a body line when every placeholder on it is a declared optional with no value, and collapses the blank run a dropped paragraph leaves — only when something was dropped, so untouched bodies render byte for byte. `DURATION_DAYS` renders through `formatDurationDays` («نامحدود» for 0, else «{n} روز»); the two expiry reminders' `days`, a count of days LEFT, is retyped NUMBER so its zero is zero.
- **Dates** render in the tenant's calendar and timezone as `YYYY/MM/DD HH:mm` assembled from `Intl.formatToParts` — the separator is fixed by this code, not by ICU's CLDR data, which moves with Node upgrades.
- **The top-up route buttons carry the capture id and the provider**, never the amount; `WalletTopupFlowService.choose` re-reads the capture the customer owns and re-decides the route before `requestWalletTopupTyped` issues the payment under `topup-capture:<captureId>`.
- **The membership gift does not wait for a purchase.** An earlier summary of this package said the gift is claimable "only after the referred customer's first purchase is fulfilled"; that was never what the code did and is not the owner's rule. Eligibility is the accepted attribution alone; the purchase commission is the reward that waits for delivery. The two are independent in both directions and are now pinned by `tests/integration/referral-signup-gift.test.ts` › the membership gift, independent of any purchase.
- **`ok:` («وصل شدم») writes nothing** — no audit row, no operation, no ledger entry — because the customer's statement about their own device is not a fact this installation can check.
