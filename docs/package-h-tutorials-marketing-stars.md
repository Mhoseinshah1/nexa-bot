# Package H — tutorial videos, the marketing opt-out policy, Stars from central FX

The owner's specification of 2026-10-02, sections 7, 8 and 9. §1 of each part is the audit
of what existed, §2 the design, §3 what the tests pin. Rollback notes are at the end.

## Spec §7 — tutorial / app video via the Telegram admin wizard («تنظیم ویدیو»)

### 7.1 Audit of the media architecture

| What                       | Where                                                          | Shape                                                                                            |
| -------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Referral banner            | `modules/control/media`, `tenant_media_assets`                 | Bytes in Postgres (`bytea`), uploaded in the Web Admin, sent as a multipart upload               |
| A client app's picture     | `modules/control/client-apps`, `client_apps.image_*`           | Bytes in Postgres, uploaded in the Web Admin (HF-A10), sent as a decorative photo lead           |
| A customer's receipt       | `payment_receipts`                                             | Telegram's `file_id` + `file_unique_id` only; re-sent by reference from the bot that received it |
| An administrator's prompts | `admin_amount_captures` (one open per admin per bot, by index) | A row with a purpose, a target, a deadline and the opening `update_id`                           |

A video for a tutorial arrives at Telegram from the administrator's phone, so its bytes are
already there; copying them into Postgres would duplicate large blobs and add an upload on
every send. The receipt's shape is the right one: **store Telegram's reference**. Because a
`file_id` is valid only for the bot that received it, the reference is stored **per bot**.

### 7.2 Design

- **Storage** — `client_app_videos` (migration 0158): one row per `(tenant, app, bot)` with
  `file_id`, `file_unique_id`, MIME type, duration, size, the administrator who set it and a
  `version`. Replacing is an upsert that bumps `version`; deleting removes the row; deleting
  the app cascades. The app's name and icon remain the title metadata (`client_apps`).
- **The wizard is a row** — `admin_amount_captures` gains the purpose `CLIENT_APP_VIDEO` and
  a `client_app_id` column. «تنظیم ویدیو» opens a prompt naming one administrator, one bot and
  one app, with a 15-minute deadline (`CLIENT_APP_VIDEO_CAPTURE_TTL_MS`) and the tap's
  `update_id`. The same table as every other admin prompt, so opening one supersedes
  whatever was open, and the database's partial unique index still holds.
- **The video message** (`ADMIN_APP_VIDEO_UPLOAD`) is offered to
  `ClientAppVideoService.receiveVideo`, which, under the administrator's advisory lock,
  stores it only when the prompt is open, unexpired and **older than the message**.
  Otherwise nothing is stored: an expired prompt is closed `EXPIRED`; a cancelled,
  superseded or never-opened one is simply not found; a message predating the tap, from
  another administrator, from a customer or to another bot matches no prompt.
- **Authorisation** — the section is drawn for `client_apps.view`; opening, cancelling,
  storing and deleting charge `client_apps.edit` inside the transaction
  (`runAuthorizedMutation`). A customer who crafts the callbacks reaches `adminTurn`,
  resolves to no administrator and gets the unknown-input reply.
- **Audit** — `client_app.video_set` (before/after) and `client_app.video_delete`. The audit
  names the video by its stable `file_unique_id`, not by the bot-scoped `file_id`. A delete
  that found nothing writes no audit row.
- **Idempotency** — every write takes the update's key (suffixed) in the actor's surface
  namespace; a redelivered video answers with the first result.
- **Customer** — an app's screen (`ca:<id>`) sends the video by reference as a decorative
  lead (`LeadMessage.VIDEO_FILE`, `sendVideo`) before the text, only for an ENABLED app and
  only from the bot the video was set through. A refusal drops the video and the screen
  still goes out.
- **Callbacks** — `va:` (the section) and `vb:<code>:<app uuid>` with `v` view, `s` set,
  `x` ask to delete, `X` delete — each naming the app — and `c` cancel, naming the PROMPT
  (its capture id), so a stale cancel never closes a newer prompt. Parsed in `surfaces/telegram/admin-tutorial-video.ts`;
  the runtime only routes.

### 7.3 Tests

`tests/integration/client-app-video.test.ts` (set, replace, delete, cancel, expired, older
message, customer video, crafted callbacks, app deletion) and
`tests/unit/admin-tutorial-video.test.ts` (callback and message boundary, `sendVideo` body).

### 7.4 Not done

- The Web Admin's client apps page does not show whether a video is set per bot.
- A tenant with several bots sets the video once per bot (a `file_id` cannot cross bots).
- A backup carries the row, not the video; a revoked bot token makes the reference unusable
  (the receipt's limitation, stated in `schema.ts`).

## Spec §8 — Telegram Stars priced from central FX only

### 8.1 Audit of the Stars formula

Before this package (`docs/package-a-telegram-stars-audit.md` §2.2, `docs/fx-audit.md` §3.5)
a Stars attempt was priced by one of two policies, chosen by `stars.pricing_mode`:

- `FIXED_RATE` (the default): `stars = ceil(payable / provider_unit_rate_minor)` — an
  operator-typed Toman per Star stored on the route. This is the **manual Stars FX rate**.
- `CENTRAL_FX`: `stars = ceil(payable × ratio / usdt_rate)`, where `usdt_rate` is the central
  quote and `ratio = stars.per_usdt`.

`stars.per_usdt` is **not** a fiat rate: it is the provider-side Star↔USD component (how
many Stars one USDT buys), which Telegram publishes no feed for (`OQ-FX-01`). It is kept.

### 8.2 Design

- The Stars descriptor's conversion spec is `policies: ['CENTRAL_FX']` with no mode setting
  (contract commit). `PaymentService.resolveConversion` is unchanged: a single-policy route
  uses its policy, so a stored `stars.pricing_mode` (even `FIXED_RATE`) cannot bring the
  manual rate back. Cache, stale window, `UNAVAILABLE` and the customer refusal
  (`FX_UNAVAILABLE` → `bot.payment.fx_unavailable`) are the central FX infrastructure's own.
  Rounding is unchanged: one integer ceiling, at least one Star for a positive payable.
- `stars.pricing_mode` is RETIRED (declared, `consumer: PLANNED`, hidden on the settings
  page; its guard refuses every change). `stars.per_usdt` cannot be cleared while the Stars
  route is ACTIVE.
- The route's legacy `provider_unit_rate_minor` is kept on the row and never read; a request
  can no longer set one (clearing is accepted), and an edit that does not mention it saves.
- Enabling the Stars route requires `central_fx` on and `stars.per_usdt` set
  (`PAYMENT_GATEWAY_UNAVAILABLE {reason: FX_UNAVAILABLE, detail: DISABLED | UNIT_RATIO_MISSING}`).
  New rows start DISABLED. A central-only route with no ratio is not offered (a courtesy).
  The enable and a ratio clear both take the route row FOR UPDATE first, so they serialise.
- A tutorial video write takes an advisory lock on its (tenant, app, bot) identity before
  it reads the `before` it audits (§7).
- The FX status no longer reports a fixed rate; the Web Admin drops the mode selector and the
  fixed-rate line.
- Found on the way: the financial log keyed "converted attempt" on a fixed rate being present,
  so a central-rate Stars payment was logged with `—` for the charge and the Stars. It keys on
  the policy now.

### 8.3 Tests

`tests/integration/fx-stars.test.ts` (legacy rate and mode ignored; no quote → refused,
never the legacy rate; stale/beyond-stale/feature-off; enable and clear gates; courtesy;
rollback write shape) and `tests/integration/telegram-stars.test.ts` (end to end at the
central rate), `tests/unit/fx-conversion.test.ts` (policy resolution, ceiling arithmetic).

### 8.4 Upgrade note

An installation that sold Stars at a fixed rate must, after upgrading, switch `central_fx` on
and set `stars.per_usdt` (Toman per Star = USDT rate ÷ ratio). Until then a new Stars invoice
is refused with the customer message; invoices already issued keep their frozen snapshot.

## Spec §9 — the marketing opt-out policy («اجازه قطع پیام‌های تبلیغاتی توسط مشتری»)

### 9.1 Audit

`/stop`, `mk:out` and `mk:in` call `CustomerService.setMarketingOptOut` (conditional UPDATE,
audit, `CustomerMarketingOptOutChanged`). MARKETING broadcasts exclude
`marketing_opt_out_at IS NOT NULL` at three points: the preview count, the launch's
materialisation, and the dispatcher's stamp. ADR-0030's lane never reads it.

### 9.2 Design

- A boolean switch is a **feature flag** (CLAUDE.md: "A feature flag is a boolean; its
  parameters are settings"): `customer_marketing_opt_out`, default ON, TENANT_WIDE, on the
  Web Admin features page with the owner's label. Its changes are audited by the flag service.
- OFF: the support screen draws no opt-out/opt-in button; `/stop` and any old button are
  answered `bot.marketing.unavailable` and change nothing. `setMarketingOptOut` re-decides
  inside its transaction and refuses (`MARKETING_OPT_OUT_DISABLED`), so no stale callback or
  other caller can bypass it.
- MARKETING broadcasts decide the opt-out at ONE point, the dispatcher's stamp, under the
  customer's lock and against the policy in force at that moment (Codex review of #143).
  The preview and the launch count and materialise every member — an opted-out customer is
  written PENDING, exactly as a frozen draft already counted one — so the confirmed count
  is the audience, and a send launched while ON and switched OFF before it goes reaches
  the opted-out customer (and the reverse resolves SKIPPED). The broadcast page's purpose
  hint and the flag's off-effect tell the operator. The stored value is never erased.
  Transactional messages and service announcements are unaffected either way.

### 9.3 Tests

`tests/integration/marketing-opt-out-policy.test.ts` and the §9 cases in
`tests/integration/round-n-close.test.ts`.

### 9.4 Not done

The `/stop` entry stays in the Telegram command menu while the policy is OFF (the menu is
per bot and synced separately); it answers `bot.marketing.unavailable`.

## Falsification

`scripts/mutate-package-h.py` reverts each rule once, runs its named tests and restores the
file. Recorded on the branch head before the §7 commit (counts from real output):

| #   | Rule reverted                                                          | Result                    |
| --- | ---------------------------------------------------------------------- | ------------------------- |
| M1  | §7 a video older than the tap is offered to the prompt                 | 1 failed / 7 integration  |
| M2  | §7 an expired prompt still stores                                      | 1 failed / 7 integration  |
| M3  | §9 the service write does not re-check the policy                      | 1 failed / 3 integration  |
| M4  | §9 MARKETING always excludes stored opt-outs                           | 2 failed / 20 integration |
| M5  | §9 the support screen draws the button while OFF                       | 1 failed / 3 integration  |
| M6  | §8 a central-only route with no ratio is offered                       | 1 failed / 20 integration |
| M7  | §8 the Stars route enables with central_fx off                         | 1 failed / 20 integration |
| M8  | §8 the ratio can be cleared while the route is on                      | 1 failed / 20 integration |
| M9  | §8 a legacy stored rate blocks every route edit                        | 1 failed / 20 integration |
| M10 | §8 the Stars spec back to FIXED_RATE-first, two policies               | 3 failed / 43 unit        |
| M12 | §9 the launch excludes opted-out members again (Codex #143 F1)         | 6 failed / 21 integration |
| M13 | §7 a cancel closes whatever prompt is open (Codex #143 F2)             | 1 failed / 9 integration  |
| M14 | §8 the enable reads the ratio without the route lock (Codex #143 F3)   | 1 failed / 22 integration |
| M15 | §8 the ratio guard reads the route without the lock (Codex #143 F3)    | 1 failed / 22 integration |
| M16 | §7 the upload reads `before` without the identity lock (Codex #143 F4) | 1 failed / 9 integration  |
| M11 | §8 the retired mode guard accepts a change                             | 1 failed / 20 integration |

## Rollback

Migration 0158 is additive: a new table, a nullable column, widened CHECKs. The previous
release ignores `client_app_videos` and never writes `CLIENT_APP_VIDEO`. Before rolling back
past §8, re-enter a fixed rate on the Stars route (the previous release prices by it by
default). The `customer_marketing_opt_out` flag row is ignored by the previous release, which
honours every stored opt-out.
