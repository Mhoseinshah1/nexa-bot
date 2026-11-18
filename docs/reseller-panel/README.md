# Reseller web panel

An ACTIVE reseller manages selling from a web page under `/r/…`, served by `/api/reseller/v1/…`. The standing
rules are in `docs/project-status.md` § Reseller web panel; this file is the operator and developer reference.

PRs #466–#471 are merged on `main`. The route-by-route API reference is [`api.md`](api.md); the owner's screen
spec is [`approved-demo.dc.html`](approved-demo.dc.html).

## Flags and settings

| Key                                          | Default         | Meaning                                                                                |
| -------------------------------------------- | --------------- | -------------------------------------------------------------------------------------- |
| flag `reseller_web_panel` («پنل وب نماینده») | off             | The panel. Off ⇒ every `/api/reseller/v1` route answers 404 `reseller_web.unavailable` |
| flag `reseller_tier_progress`                | off             | The dashboard's «پیشرفت تا سطح بعد» card (display only); needs a target on the tier    |
| `reseller.trial_daily_quota`                 | 0               | Trials per reseller per tenant-calendar day, 0–20; 0 hides the card                    |
| `reseller.trial_product`                     | unset           | A PANEL id: a reseller trial is that panel's trial configuration                       |
| `hosting.reseller_bot_monthly_fee`           | 0 (not offered) | Dedicated-bot fee, money; installation tenant, owner only                              |
| `hosting.reseller_bot_grace_days`            | 3 (0–30)        | Days of notices before a bot that cannot be paid for is stopped                        |
| tier «هدف سطح بعد»                           | none            | Count or amount target the progress card measures                                      |

Phase siblings (not reseller keys): `captcha.kind` (#467), `backup.archive_keep_on_host` (#466).

## Routes

Pages (SPA, `deploy/caddy/routes.caddy` sends `/r` and `/r/` to the document): `/r/login`, `/r/dashboard`,
`/r/buy`, `/r/services`, `/r/clients`, `/r/wallet`, `/r/prices`, `/r/support`, `/r/bot`, `/r/settings`;
`/r/manifest.webmanifest` and the service worker `/r/sw.js`.

API groups under `/api/reseller/v1` (shapes: `packages/contracts/src/reseller-panel.ts`):

| Group             | Paths                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| sign-in           | `POST /auth/exchange`, `/auth/second-factor`, `/auth/logout`; `GET /me`                                                                 |
| security          | `/security/sessions` (+ revoke, revoke-all), `/security/activity`, `/security/totp/{enrol,activate,disable}`, `/settings/notifications` |
| dashboard         | `GET /dashboard`, `/trial` (+ POST), `/tier-progress`                                                                                   |
| services          | `/services`, `/services/:id` (+ note, qr, send-connection, rotate-link, files, files-zip, files/send, offer, quote, auto-renew, client) |
| buying            | `/catalogue/{servers,categories,categories/:id,custom}`, `POST /purchases/quote`, `/purchases/:id` (+ confirm, send-links)              |
| clients           | `/clients` (+ `:id`, archive, services, renew-all)                                                                                      |
| wallet and orders | `/wallet`, `/wallet/entries`, `/wallet/topup[/quote]`, `/payments/:id` (+ transfer-sent, receipt), `/orders/:id/pay-wallet`             |
| price list, help  | `/prices`, `/ticket-categories`, `/tickets` (+ replies)                                                                                 |
| own bot           | `GET /own-bot`, `POST /own-bot/requests`, `/own-bot/requests/:id/cancel`, `/own-bot/requests/:id/pay`                                   |

Admin side (`/api/admin/v1`, admin session): `GET /resellers/:customerId/web-panel`, `POST …/force-logout`,
`POST …/totp-reset` (reason 3–500 each, audited), the trial and tier-target editors on the resellers pages, and the
«درخواست‌های نماینده‌ها» tab of «میزبانی‌ها».

## Authentication

- **One-time link.** The bot's «ورود به پنل وب» issues `/r/login#token=…` (valid 10 minutes). The page captures the
  fragment before the router starts, posts it once to `/auth/exchange`, and never stores it. A refresh of a used link
  says «این لینک قبلاً باز شده است…».
- **Cookie.** `nexa_reseller_session` (`__Host-` prefix and `Secure` in production), HttpOnly, SameSite=Strict, Path=/.
  The admin cookie does not work here and this one does not work on the admin API. Writes check `Origin`; money
  writes carry an `idempotency-key`.
- **Sessions.** 30 days idle, 90 absolute; the tenant is decided by the request's Host only. A suspended or blocked
  reseller's session is refused (`reseller_web.session_invalid`).
- **2FA (optional TOTP).** Enrol and disable need a session opened less than 15 minutes ago
  (`FRESH_SIGN_IN_REQUIRED`). Five wrong codes end a pending session; the count is kept under the session row lock.
  Disabling consumes the code step (no replay). The secret is sealed under `reseller_web.totp_secret` and is covered
  by `secrets status`, `rewrap`, `retire-check` and restore clearing.
- **Rate limits.** 20 sign-in attempts per minute per IP; 10 file fetches (list included) per service per 10 minutes.
- **Notices.** A new device (browser family + /24, also the first sign-in) sends a Telegram message.
- **Admin controls.** Forced logout (reason) and 2FA reset (reason; ends sessions with `ADMIN_FORCE_LOGOUT`).

## Dedicated bot and its fee

A reseller of the installation files a request (token checked by `getMe`, sealed, shown masked; optional domain).
The owner approves in «میزبانی‌ها» with a fresh creator-panel code: the first month is debited from the reseller's
wallet in one transaction (ledger reason `HOSTED_BOT_FEE`, reference `hosted-bot-fee:<request>:<period>`); a short
wallet refuses approval. The fee is the figure snapshotted when the request was filed. The monthly job
(`reseller-bot-renewal`) debits each period once; a short wallet gets one notice per UTC day during the grace days,
then the bot is stopped (EXPIRED; data kept) and a later debit or «پرداخت و فعال‌سازی دوباره» resumes it. Reject and
cancel never charge; an approved request that never gets a bot is not refunded.

Owner requests support server-side cursor pagination and «بارگذاری بیشتر»; `/r/bot` keeps all
noncurrent requests and their timelines accessible. See the [history and performance audit](request-history-audit.md)
for cursor semantics, the reproduced presentation defect and repeatable measurements.

## Demo comparison

Screens: `docs/reseller-panel/screens/` — every `/r/` screen, dark and light, `desk-*` at 1536×730 and `phone-*` at
390×844 (plus the service drawer, the filled buying form, a pending bot request and `phone-login.png`), captured from
a scratch tree holding #471 and #470 merged (not pushed), the production build under the production CSP, API
stubbed with the shapes the web tests use. No console CSP violation and no horizontal page scroll on any of them; the
desktop dashboard fits 730 px.

`approved-demo.dc.html` needs the owner's `support.js` runtime, which is not in the repository, so it could not be
opened beside the app; the comparison is of the demo's source against the screens. Differences, all deliberate:

- No «+ خرید سرویس» header button on the dashboard: the sidebar item carries it.
- «ربات اختصاصی»: the demo's «راه‌اندازی: کمتر از 1 روز», «قیمت سرویس‌ها: سطح شما» and the line «سرویس‌ها از همین
  سرورها، با قیمت سطح شما» are not drawn (no API field or rule backs them); no confirm dialog on cancel, as in the demo.
- «پرداخت و فعال‌سازی دوباره» appears only when the bot is stopped for its fee, not during the grace days.
- Top-up methods that pay in the chat (Stars) are listed but disabled with «فقط در ربات».
- Buying: the summary is price × quantity from the plan card; a custom service's price appears only on the review
  step. A short wallet shows «شارژ کیف پول» instead of «خرید» (no credit).
- The recent-transactions card sits under the expiring list (compact rows) so the dashboard fits 730 px.
- «تمدید خودکار» on an imported service asks for the plan to renew into (owner decision, `OQ-R10-D1-01`).
- Notification switches: `expiringDigest` and `dailySalesReport` are daily reports (once per tenant-local day); `ticketReply` off also suppresses the attachment notice.
- Not in the panel (owner: not wanted): bulk operations, saved templates, profit reports, public status page, branding.

Admin pages touched by #468, #469, #471, #470: `pnpm web:demo-diff` was run on a scratch tree holding all of them
(light, 1440): before KEEP 372, suppressed 153, remaining 219 (#468 alone reported 216). The three extra are on
`/resellers`: the head «سرویس تست نماینده» and the two trial-card labels, which the demo does not have. `/reseller-tiers`,
`/reseller-plans`, `/hosting` and `/reseller-requests`: no difference. **Owner: re-run `pnpm web:demo-diff` (four
combinations) after the merges**; dark 1440 and both 390 runs were not made here.
