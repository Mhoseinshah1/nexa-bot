# 06 — Same-token handover

Phase 5. Only the webhook URL changes. Telegram delivers each update to one webhook;
registering Nexa's URL with the same token replaces Mirza's registration at Telegram. The
bot's username, chats and customer history stay. Precondition for the phase: GO-3.

Never call `setWebhook` or `deleteWebhook` from the Nexa host by hand, and never put the
bot token on a command line.

## In-flight updates

During the freeze Mirza's endpoint answers non-2xx, so Telegram keeps the updates queued
(for a limited time, about 24 h; the exact retention is **UNKNOWN** — see OQ-CUT-03, and
this repository does not document it).

Nexa's **first** registration of a bot sets `drop_pending_updates = true`
(`bot-bootstrap.service.ts`: `dropPendingUpdates = ensured.createdNow`). So **every update
queued during the freeze is discarded at the handover** — none reaches Mirza or Nexa.

Consequences:

- A message or button tap a customer sent during the window gets no answer.
- No money moves on it: Mirza processed nothing and Nexa never saw it.
- Updates sent **after** the handover reach Nexa. An old Mirza inline button arrives as a
  `callback_query` and is answered `bot.callback.stale` with the main-menu button; it writes
  nothing commercial.

This is Decision D3 and **OQ-CUT-01**: the owner accepts it, or asks for a code change so the
first registration keeps the queue (not part of this runbook). It is settled before GO-4.

## H1 — Stop sales behind an incident

**`OWNER ONLY — separate explicit approval`**

Precondition: GO-3.

Web Admin «رخدادها و نگهداری»: create a MAINTENANCE incident with `stop_sales` ON targeting
every panel and every payment gateway, `admin_banner` ON, and the **customer message
EMPTY**. Start it and press **Apply effects**. Never press «اطلاع‌رسانی» (`incidents.notify`).

Verification: the incident is ACTIVE; the effects list one `PANEL_DRAIN` per panel and one
`GATEWAY_DISABLE` per gateway, all APPLIED.

Rollback: resolve or cancel the incident (sales were not open yet).

Record: incident id, time.

## H2 — Preflight

**`read-only`**

Precondition: H1.

```bash
sudo botctl cutover preflight --expect-version <vX.Y.Z> --expect-telegram none
```

Verification: PASS. Rollback: none needed.

## GO-4

**`OWNER ONLY — separate explicit approval`**

The owner's go/no-go #4 ([`09-go-no-go.md`](09-go-no-go.md)). NO-GO → R0.

## H3 — Register the Mirza bot's token on Nexa

**`OWNER ONLY — separate explicit approval`** (production Telegram)

Precondition: GO-4.

Rerun the installer with the same arguments as step 0.1 **without** `--skip-telegram`. It
asks for the token with no echo (or use `--bot-token-file` for a file the container can
read). A rerun never re-asks for anything already configured and never replaces a stored
token.

```bash
sudo bash install.sh --domain <nexa-domain> --acme-email <email> --version <vX.Y.Z>
```

Verification: the installer reports the bot configured; `getMe` is the Mirza bot (same
username); `sudo botctl roles status` still shows `provisioner` and `monitor` disabled
(the installer honours `NEXA_DISABLED_ROLES`).

Rollback: **R1** ([`08-rollback.md`](08-rollback.md)).

Record: time of H3 (UTC) — the `since` of R1's loss list.

## H4 — Check Telegram

**`read-only`**

Precondition: H3.

```bash
sudo botctl telegram status | tee telegram-after.txt
sudo botctl cutover preflight --expect-version <vX.Y.Z> --expect-telegram ready
```

Verification: `ready`; both halves agree (the URL is Nexa's); pending updates 0 (dropped, as
described above); no last error; preflight PASS.

Rollback: R1.

## H5 — The owner's own chat

**`OWNER ONLY — separate explicit approval`** (a real chat)

Precondition: H4.

From the **owner's own** Telegram account only: `/start` shows the Nexa main menu; tap an
old Mirza button in that chat → «این دکمه قدیمی است…» and the main menu; nothing else.

Verification: as described; and `orders`, `payments`, `wallet_entries`, `services` and
`provisioning_operations` are unchanged — read with the snapshot query of
[`07-background-roles.md`](07-background-roles.md) (B1) using `since` = H3's time.

Rollback: R1.

## H6 — Record the bot instance

**`read-only`**

Precondition: H4.

```bash
sudo $DC exec -T postgres psql -U nexa -d nexa -X -At -c "SELECT id, status FROM bot_instances"
```

Verification: exactly one ACTIVE. Record the id for B6/B7.

## H7 — Communications

Optional until sales open: the owner posts in the channel or pins in the bot that Nexa is
live (manual; [`10-communications.md`](10-communications.md)). Nexa sends nothing.

## راهنمای فارسی

فقط نشانی وب‌هوک عوض می‌شود؛ ربات، نام کاربری و تاریخچهٔ گفتگوها همان می‌ماند.

**به‌روزرسانی‌های در راه:** در فریز، تلگرام به‌روزرسانی‌ها را (حدود ۲۴ ساعت؛ مقدار دقیق نامعلوم،
OQ-CUT-03) صف می‌کند. اولین ثبت ربات در Nexa با `drop_pending_updates = true` همهٔ آن‌ها را **دور
می‌ریزد**. پیامی که مشتری در پنجره فرستاده بی‌پاسخ می‌ماند و هیچ پولی جابه‌جا نمی‌شود. دکمهٔ
قدیمی میرزا پس از انتقال با «این دکمه قدیمی است…» و منوی اصلی پاسخ می‌گیرد. این تصمیم D3 /
OQ-CUT-01 است و پیش از GO-4 مالک آن را می‌پذیرد.

- **H1** (فقط مالک — با تأیید صریح جداگانه): در «رخدادها و نگهداری» رخداد MAINTENANCE با
  `stop_sales` برای همهٔ پنل‌ها و درگاه‌ها، پیام مشتری **خالی**، «Apply effects»؛ هرگز
  «اطلاع‌رسانی» را نزنید.
- **H2** (فقط خواندنی): پیش‌پرواز با `--expect-telegram none`.
- **GO-4** (فقط مالک).
- **H3** (فقط مالک — تلگرام تولید): اجرای دوبارهٔ نصب‌کننده بدون `--skip-telegram`؛ توکن بدون echo
  پرسیده می‌شود. بازگشت: R1.
- **H4** (فقط خواندنی): `botctl telegram status` و پیش‌پرواز با `--expect-telegram ready`.
- **H5** (فقط مالک): فقط از حساب شخصی مالک: `/start` و یک دکمهٔ قدیمی؛ هیچ سفارش، پرداخت یا
  ورودی کیف پول نباید تغییر کند.
- **H6** (فقط خواندنی): شناسهٔ نمونهٔ ربات را برای B6/B7 ثبت کنید.
- **H7**: اطلاع‌رسانی دستیِ مالک، اختیاری تا باز شدن فروش.
