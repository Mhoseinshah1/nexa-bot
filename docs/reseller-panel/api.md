# Reseller web panel — API reference (PR-4 and PR-5, API halves)

The web half (`apps/web`, routes under `/r/…`) codes against this. Every shape, path and
constant named here is exported by `@nexa/contracts` (`packages/contracts/src/reseller-panel.ts`,
plus the mini app's wire shapes it reuses from `miniapp.ts`). Wire conventions are the mini
app's: money is `MoneyWire` `{ amountMinor: "<decimal string>", currency }`, byte counts are
decimal strings, instants ISO-8601 UTC.

## Basics

- **Prefix:** `RESELLER_API_PREFIX` = `/api/reseller/v1`. Same origin as the page (Caddy already
  sends `/api/*` to the API), so `fetch` with `credentials: 'same-origin'`.
- **Feature flag:** `reseller_web_panel` (default OFF, «قابلیت‌ها»). While it is off for the tenant
  of the request's Host, **every** route answers `404 reseller_web.unavailable` — treat it as "the
  panel does not exist".
- **Tenant:** decided by the request's Host only — a hosted tenant's verified domain, otherwise the
  installation. Never sent by the client.
- **Session cookie:** `nexa_reseller_session` (production: `__Host-nexa_reseller_session`),
  `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` in production. JavaScript never sees it; the
  admin cookie never works here and this one never works on `/api/admin/v1`.
- **Writes** (POST/PUT) must come from the page's own origin (`Origin` checked) and most carry an
  `idempotency-key` header (`resellerIdempotencyKeySchema`: 16–64 of `[A-Za-z0-9-]`, e.g. a UUID).
  Required on: `rotate-link`, `quote`, `pay-wallet`, `wallet/topup`, `transfer-sent`, `receipt`,
  `tickets` (create), `tickets/:id/replies`, and (PR-5) `purchases/quote` (the header IS the
  batch key: re-send the same key to re-read the same quote), `purchases/:id/confirm`,
  `clients/:id/renew-all`, `services/:id/auto-renew` (PUT), `trial` (POST). Harmless elsewhere.
- **Errors:** `{ error: { code, message, details? } }`. Show `web.err_<code with dots → _>`
  (`apps/web/src/error-text.ts` already maps every `reseller_web.*` code to Persian).

| HTTP | code                                    | when                                                                                                                |
| ---- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 404  | `reseller_web.unavailable`              | flag off for this tenant                                                                                            |
| 401  | `reseller_web.link_invalid`             | unknown/malformed link, another tenant's, reseller not ACTIVE                                                       |
| 401  | `reseller_web.link_used`                | link already opened → «این لینک قبلاً باز شده است…»                                                                 |
| 401  | `reseller_web.link_expired`             | link older than 10 minutes                                                                                          |
| 401  | `reseller_web.session_invalid`          | no/ended/expired session, reseller suspended or blocked → back to «از ربات لینک بگیرید»                             |
| 401  | `reseller_web.second_factor_required`   | session waits for the TOTP code → show the code step                                                                |
| 401  | `reseller_web.second_factor_invalid`    | wrong/used code                                                                                                     |
| 409  | `reseller_web.second_factor_state`      | 2FA already on/off, or `details.reason = FRESH_SIGN_IN_REQUIRED` (enrol/disable need a session opened < 15 min ago) |
| 429  | `reseller_web.rate_limited`             | 20 sign-in attempts/min/IP, or 10 file fetches/service/10 min                                                       |
| 400  | `reseller_web.request_invalid`          | body/query/header does not match                                                                                    |
| 404  | `reseller_web.not_found`                | not this reseller's, or does not exist (one answer)                                                                 |
| 409  | `reseller_web.files_unavailable`        | panel unreachable/refused, or no files in this state                                                                |
| 409  | `reseller_web.telegram_undelivered`     | the bot could not deliver to the reseller's chat                                                                    |
| 409  | `reseller_web.rotate_unavailable`       | the provider cannot issue a fresh link                                                                              |
| 409  | `commerce.wallet_insufficient_funds`    | `pay-wallet` with a short (or negative) wallet; `details.shortfallMinor`                                            |
| 400  | `reseller_web.custom_username_single`   | PR-5: a «دلخواه» username with a quantity above 1                                                                   |
| 409  | `reseller_web.trial_unavailable`        | PR-5: «سرویس تست» off / not configured / today's quota used (`details.reason`)                                      |
| 409  | `reseller_web.auto_renew_plan_required` | PR-5: an imported service switched on without `planId` → «برای روشن کردن، پلن تمدید را انتخاب کنید»                 |

## Sign-in

`/r/login#token=…` — read the fragment first (before the router), then:

| Method & path              | Body                   | 200 response                                                                                                                                                              |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/exchange`      | `{ token }` (43 chars) | `{ state: 'ACTIVE' \| 'SECOND_FACTOR_REQUIRED', expiresAt }` + cookie                                                                                                     |
| `POST /auth/second-factor` | `{ code }` (6 digits)  | `{ state: 'ACTIVE', expiresAt }` (cookie lifetime extended)                                                                                                               |
| `POST /auth/logout`        | —                      | `{ ok: true }`, cookie cleared                                                                                                                                            |
| `GET /me`                  | —                      | `ResellerMeResponse`: `customer {firstName, username, telegramUserId}`, `reseller {tierName, since}`, `balance`, `botUsername`, `secondFactor`, `session {id, expiresAt}` |

Five wrong codes end a pending session (a new link is then needed). Sessions end after 30 idle
days or 90 days in all.

## Security card («امنیت»)

| Method & path                               | Body                            | 200 response                                                                                                                                    |
| ------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /security/sessions`                    | —                               | `{ items: [{ id, current, device ("Chrome on Android"), network ("203.0.113.x"), createdAt, lastSeenAt }] }`                                    |
| `POST /security/sessions/:sessionId/revoke` | —                               | `{ ok: true }` (another reseller's id → 404)                                                                                                    |
| `POST /security/sessions/revoke-all`        | —                               | `{ ended }`, this session included, cookie cleared                                                                                              |
| `GET /security/activity?cursor=`            | —                               | `{ items: [{ id, action, entityType, entityId, result, at }], nextCursor }` newest first, 20 a page; `action` ∈ `RESELLER_WEB_ACTIVITY_ACTIONS` |
| `POST /security/totp/enrol`                 | —                               | `ResellerTotpEnrolResponse` `{ secret, otpauthUri, qrPngDataUrl, expiresAt, parameters }`                                                       |
| `POST /security/totp/activate`              | `{ code }`                      | `{ ended }` (every other session ends)                                                                                                          |
| `POST /security/totp/disable`               | `{ code }`                      | `{ ok: true }`                                                                                                                                  |
| `GET /settings/notifications`               | —                               | `ResellerPreferences` `{ newDeviceAlert, expiringDigest, dailySalesReport, ticketReply }`                                                       |
| `PUT /settings/notifications`               | any subset of the four booleans | the full preferences                                                                                                                            |

«اعلان ورود جدید» (`newDeviceAlert`, default on) is consumed now: a Telegram message once per new
device (browser family + /24). The other three are stored and returned; see "Not yet consumed".

## Dashboard, services, connection

| Method & path                        | Notes                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /dashboard`                     | `ResellerDashboard`: `balance`, `activeServices`, `monthSales {count, amount: MoneyWire[]}` (this calendar month, tenant calendar), `expiringCount`, `expiring` (≤5 rows), `tier {name, pricingMode, discountPercent}`, `recentTransactions` (≤5)                                               |
| `GET /services?filter=&q=&page=`     | `filter` ∈ `ALL ACTIVE EXPIRING EXPIRED SUSPENDED OTHER`; `q` searches username, note, code; `page` from 0; PR-5 `clientId` keeps one client's services. Answers `{ items: ResellerServiceRow[], counts, page, pages, total }`; 20 a page; each row's `client`/`clientId` from the clients book |
| `GET /services/:id`                  | `ResellerServiceDetail`: row + `subscriptionUrl` (null on files-only), `qrKinds` (`SUB_LINK`/`SINGBOX`, [] on files-only), `singboxProfileName`, `filesOnly`, `filesOffered`, `canRotateLink`, `actions` (`RENEW`, `ADD_TRAFFIC`, `ADD_TIME`), `working`                                        |
| `PUT /services/:id/note`             | `{ note: string \| null }` → `{ note }`                                                                                                                                                                                                                                                         |
| `GET /services/:id/qr/:kind`         | PNG (`image/png`), the bot's renderer                                                                                                                                                                                                                                                           |
| `POST /services/:id/send-connection` | the bot's link+QR card to the reseller's own chat (files-only: the files) → `{ outcome: 'SENT', sent }`                                                                                                                                                                                         |
| `POST /services/:id/rotate-link`     | only when `canRotateLink`; the new link arrives in the bot → `{ ok: true }`                                                                                                                                                                                                                     |
| `GET /services/:id/files`            | fetches NOW: `{ files: [{ index, fileName, sizeBytes }] }`                                                                                                                                                                                                                                      |
| `GET /services/:id/files/:index`     | the file: `Content-Disposition: attachment; filename=…; filename*=UTF-8''…`, `Cache-Control: no-store, private`, `X-Content-Type-Options: nosniff`                                                                                                                                              |
| `GET /services/:id/files-zip`        | all files, one `application/zip`, same headers                                                                                                                                                                                                                                                  |
| `POST /services/:id/files/send`      | exactly the bot's «دریافت فایل‌ها» → `{ outcome: 'SENT', sent }`                                                                                                                                                                                                                                |

Every file route counts against 10 fetches per service per 10 minutes (list included). Never
cache a file or a response in the service worker; download via a normal navigation/anchor.

## Renewal and add-ons («تمدید» / «حجم اضافه»)

| Method & path                      | Body                                                            | 200 response                                                                                     |
| ---------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /services/:id/offer/:kind`    | —                                                               | `MiniAppServiceOffer` `{ kind, options: [{ addonId, planId, title, price, personalDiscount }] }` |
| `POST /services/:id/quote`         | `{ kind: 'RENEW'\|'ADD_TRAFFIC'\|'ADD_TIME', addonId, planId }` | `MiniAppOrder` (a DRAFT, priced once, honoured)                                                  |
| `POST /orders/:orderId/pay-wallet` | —                                                               | `{ order: MiniAppOrder, paymentId }`; short wallet → 409 `commerce.wallet_insufficient_funds`    |

## Wallet («کیف پول»)

| Method & path                                              | Body                                 | 200 response                                                                                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /wallet`                                              | —                                    | `{ balance, presets: MoneyWire[], minimum, maximum }`                                                                                                                                             |
| `GET /wallet/entries?direction=ALL\|CREDIT\|DEBIT&cursor=` | —                                    | `MiniAppWalletEntries` `{ items: [{ id, direction, reason, amount, createdAt }], nextCursor }` (CREDIT = «واریز», DEBIT = «برداشت»)                                                               |
| `POST /wallet/topup/quote`                                 | `{ amount: MoneyWire }`              | `MiniAppTopupQuoteResponse`: `BELOW_MINIMUM` / `ABOVE_MAXIMUM` / `ROUTES` with `routes [{ provider, kind, name, paysInChat, giftPercent }]` — the tenant's enabled methods and the bot's own fees |
| `POST /wallet/topup`                                       | `{ amount, provider }`               | `{ kind: 'GATEWAY', attempt }` or `{ kind: 'CARD_TO_CARD', instruction }` (the mini app's shapes)                                                                                                 |
| `GET /payments/:paymentId`                                 | —                                    | the mini app's `MiniAppPaymentStatus`; the screen re-reads a gateway attempt until its invoice (and link) exists                                                                                  |
| `POST /payments/:paymentId/transfer-sent`                  | —                                    | `{ receiptWindowMinutes, reference }`                                                                                                                                                             |
| `POST /payments/:paymentId/receipt`                        | `{ imageBase64, mimeType }` (≤ 5 MB) | the mini app's receipt answer                                                                                                                                                                     |

## Price list and support

| Method & path                       | Notes                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /prices`                       | `{ groups: [{ categoryId, title, items: [{ productId, title, trafficBytes, durationDays, listPrice, yourPrice, discountPercent }] }] }`, categories in the tenant's order. «کپی لیست برای مشتری» copies `listPrice` only |
| `GET /ticket-categories`            | `{ items: [{ id, title }] }`                                                                                                                                                                                             |
| `GET /tickets` · `GET /tickets/:id` | the mini app's ticket summary / `MiniAppTicketDetail`                                                                                                                                                                    |
| `POST /tickets`                     | `{ categoryId, text }` → `MiniAppTicketDetail`                                                                                                                                                                           |
| `POST /tickets/:id/replies`         | `{ text }` → `MiniAppTicketDetail`; replies also arrive in the bot                                                                                                                                                       |

## Web Admin (reseller drawer)

Under `/api/admin/v1` with the admin session:

- `GET /resellers/:customerId/web-panel` (`resellers.view`) → `{ lastLoginAt, activeSessions, secondFactor }`
  — «پنل وب: آخرین ورود …».
- `POST /resellers/:customerId/web-panel/force-logout` (`resellers.edit`) with
  `{ reason (3–500), idempotencyKey }` → `{ ended }` — «خروج اجباری از همهٔ دستگاه‌ها», audited.

## PWA and headers

`/r/…` is served by Caddy's SPA handler (`deploy/caddy/routes.caddy`) under the existing document
CSP (`default-src 'self'` covers `manifest-src` and `worker-src`). A `manifest.webmanifest` and a
service worker shipped as static files of `apps/web` need no API route and keep that CSP passing;
the API's own responses carry `Cache-Control: no-store` and must never be cached by the worker.

## Notification preferences (consumed since PR-5)

- `ticketReply` (default on): off, a support reply to this reseller queues no `TICKET_REPLY` (nor
  its file) notice in the bot; the reply is read in the panel.
- `expiringDigest` (default on): once per tenant-local day, a `RESELLER_WEB_EXPIRING_DIGEST` lists
  the reseller's services with ≤ 7 days or ≤ 10 % traffic left (none → no message).
- `dailySalesReport` (default off): once per tenant-local day, `RESELLER_WEB_DAILY_SALES` gives
  yesterday's count and sum (the reseller sales statement).

Both daily reports are a `SYSTEM_JOB` pass of the customer reminder loop; the row in
`reseller_web_daily_reports` (unique per reseller, kind and day) is the "once a day" rule.

## Buying («خرید», PR-5 §5.5)

The catalogue is the bot's own reads for this reseller — nothing is invented on the web side.

| Method & path                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /catalogue/servers?page=`            | `{ enabled, step, items: [{id, name}], page, hasMore }`; draw the server step only when `step` (setting on AND more than one server), as the bot's `serverList`                                                                                                                                                                                                                                           |
| `GET /catalogue/categories?serverId=`     | `{ items: [{id, name, emoji}], page, hasMore }` in the tenant's `sort_order`                                                                                                                                                                                                                                                                                                                              |
| `GET /catalogue/categories/:id?serverId=` | `{ items: ResellerPlan[] }` — the mini app's product wire + `listPrice` (strike it through); `price` is the reseller's price                                                                                                                                                                                                                                                                              |
| `GET /catalogue/custom`                   | `{ offered, locations: [{ panelId, label, volume {min,max} (hundredths of GB), days {min,max} }] }` — the «سرویس دلخواه» tab only when `offered`                                                                                                                                                                                                                                                          |
| `POST /purchases/quote`                   | body `{ plan: {kind:'PLAN', productId} \| {kind:'CUSTOM', panelId, volume, days}, quantity 1–50, username: {mode:'AUTOMATIC'} \| {mode:'CUSTOM', value}, clientId, note }` → `ResellerPurchaseQuote` `{ batchId, unitPrice, listUnitPrice, total, saving, balance, balanceAfter, sufficient, shortfall, … }`. Creates the N drafts (each priced once, honoured). `sufficient` false → show «شارژ کیف پول» |
| `GET /purchases/:batchId`                 | `ResellerPurchaseBatch` `{ items: [{ index, orderId, orderCode, status QUOTED\|PAID\|CREATED\|FAILED, reason, total, serviceId, username, subscriptionUrl }] }` — poll it until the links arrive; «کپی همهٔ لینک‌ها» copies the `subscriptionUrl`s                                                                                                                                                        |
| `POST /purchases/:batchId/confirm`        | «خرید»: the whole total pre-checked under the wallet lock (short/negative → 409 `commerce.wallet_insufficient_funds`, nothing charged), then each order paid; the per-service result                                                                                                                                                                                                                      |
| `POST /purchases/:batchId/send-links`     | «ارسال همهٔ لینک‌ها در تلگرام» → `{ sent, failed }` (the bot's delivery card + files, to the reseller's own chat)                                                                                                                                                                                                                                                                                         |

To keep the UI live while the quantity changes, compute the display from the plan card's
`price × quantity`; call `quote` once, on the review step (it drafts N orders).

## Clients book and auto-renew (PR-5 §5.6)

| Method & path                        | Notes                                                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /clients?archived=&q=`          | `{ items: [{ id, name, contact, note, serviceCount, expiringCount, archived, createdAt }] }` — `expiringCount` 0 → «همه فعال»                         |
| `POST /clients` · `PUT /clients/:id` | `{ name 1–80, contact ≤80 \| null, note ≤500 \| null }` → the client                                                                                  |
| `POST /clients/:id/archive`          | archive (never deleted) → the client                                                                                                                  |
| `GET /clients/:id/services`          | `{ items: (ResellerServiceRow + autoRenew)[] }`                                                                                                       |
| `GET /clients/:id/renew-all`         | `{ count, total, balance, sufficient, shortfall, items: [{ serviceId, username, price, skipped }] }` (imported → `skipped: 'PLAN_REQUIRED'`)          |
| `POST /clients/:id/renew-all`        | each ACTIVE service renewed once (total pre-checked; 409 when short) → `{ items: [{ serviceId, status RENEWED\|FAILED\|SKIPPED, reason, orderId }] }` |
| `PUT /services/:id/client`           | `{ clientId \| null }` — only a client of this reseller, only their own service                                                                       |
| `GET /services/:id/auto-renew`       | `ResellerAutoRenew` `{ enabled, offered, price, leadHours, imported, planId, plans, unavailable FEATURE_OFF\|NOT_AVAILABLE\|PLAN_REQUIRED }`          |
| `PUT /services/:id/auto-renew`       | `{ enabled, expected: MoneyWire \| null, planId \| null }` — `expected` is the price shown; an imported service needs `planId` (one of `plans`)       |

«+ سرویس برای این مشتری» opens buying with `clientId` set. «+ مشتری جدید» is `POST /clients`.

## Trials and tier progress (PR-5 §5.7, §5.8)

| Method & path        | Notes                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /trial`         | `{ enabled, quota, usedToday }` — «سرویس تست — امروز: usedToday از quota»; hide the card when `!enabled`                                                  |
| `POST /trial`        | «ساخت تست» → `{ serviceId, orderId, usedToday, quota }`; the link arrives in the bot; 409 `reseller_web.trial_unavailable`                                |
| `GET /tier-progress` | `{ shown, tierName, target {kind COUNT, count} \| {kind AMOUNT, amount}, count, amount, remainingCount, remainingAmount, monthEnd }` — hide when `!shown` |

## Web Admin additions (PR-5)

- `POST /resellers/:customerId/web-panel/totp-reset` (`resellers.edit`) `{ reason (3–500), idempotencyKey }`
  → `{ reset, ended }` — «بازنشانی ورود دومرحله‌ای», audited `reseller_web.totp_reset`.
- `GET /resellers/:customerId/web-panel/trials` (`resellers.view`) → `{ today, quota, total }`.
- `GET|PUT /reseller-tiers/:id/next-target` (`resellers.view` / `resellers.edit`)
  `{ target: {kind:'COUNT', count} | {kind:'AMOUNT', amount: MoneyWire} | null, idempotencyKey }`.
- Settings `reseller.trial_daily_quota` (0–20) and `reseller.trial_product` (the panel whose trial
  is issued) are ordinary settings (`/settings`), for the resellers settings card.
