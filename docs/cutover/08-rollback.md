# 08 — Rollback: back to MirzaBot

**The rule.** A rollback never deletes rows and never drops a database. Nexa's data is
either left in place (unseen) or restored through the recovery lane (two renames; the
displaced database is kept). MirzaBot is the system of record again after any rollback; its
MySQL is unfrozen only by the owner. Same spirit as
`../legacy-migration/rollback-runbook.md`.

Session setup:

**`read-only`**

```bash
set -o nounset
export DC="docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml"
mkdir -p ~/cutover && chmod 700 ~/cutover && cd ~/cutover
date -u +%FT%TZ | tee t0-start.txt
```

## Stages

| Stage                                                                 | Reached when | Token / webhook                                                   | Nexa data                                                                                   | Data written meanwhile                                                                                                 |
| --------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **R0** — before the handover (phases 1–4; any NO-GO up to GO-4)       | F2 … C6      | untouched: Telegram still points at Mirza (Nexa never registered) | leave it, or restore the protective backup (`preImportBackupRunId`) to return Nexa to empty | none: Mirza frozen, Nexa unseen by customers                                                                           |
| **R1** — after the handover, sales still stopped (H3 … B8, before B9) | H3 done      | Nexa holds the webhook; see R1 below                              | keep as is (incident ACTIVE)                                                                | customers' `/start` and taps only; no sale, no top-up                                                                  |
| **R2** — after provisioner/monitor on, sales still stopped            | B2 … B8      | as R1                                                             | disable the roles first                                                                     | as R1, plus any RickPanel write by Nexa (should be none) and reminders sent after B7 (cannot be unsent)                |
| **R3** — after sales opened (B9+)                                     | B9           | as R1                                                             | new MAINTENANCE incident with `stop_sales`; disable the roles                               | **real money**: Nexa payments, top-ups, wallet purchases, renewals and new services on RickPanel that Mirza never knew |

## R0 — before the handover

Nothing outside Mirza and the Nexa import changed.

**Step 1 — re-enable Mirza.**

**`OWNER ONLY — separate explicit approval`** (legacy host)

Re-enable the webhook endpoint, start the crons, `read_only = OFF`. Commands: **TBD — see
OQ-CUT-02** (P9; the same ones written in `02-freeze.md` F2, reversed).

**Step 2 — a Mirza button answers.**

**`read-only`**

Precondition: step 1. Verification: a button tap in Mirza gets an answer.

**Step 3 — cancel or resolve the Nexa incident, if created.**

**`OWNER ONLY — separate explicit approval`**

Resolve or cancel the MAINTENANCE incident in «رخدادها و نگهداری». Still never notify.

**Optional — return Nexa to empty.**

**`OWNER ONLY — separate explicit approval`**

Restore the protective backup (`preImportBackupRunId`) in «بکاپ و بازیابی ← عملیات بازیابی»
(«تأیید بازیابی»). The displaced database is kept. Otherwise leave Nexa as it is: nobody can
reach it.

**Step 4 — record** the time and the reason in [`11-records.md`](11-records.md).

## R1 — after the handover, sales still stopped

Order matters. **First stop Nexa from re-pointing the webhook, then re-register Mirza's.**

**Step 1 — stop Nexa re-registering.**

**`OWNER ONLY — separate explicit approval`**

In `/etc/nexa/nexa.env` set `TELEGRAM_WEBHOOK_ENABLED=false`, then:

```bash
sudo botctl restart
```

The route then answers 404, and `bootstrap`, `telegram register` and the update's menu
reconcile refuse to register (`bot-bootstrap.service.ts` `unavailableScopeReason`).

**Step 2 — re-register Mirza's webhook.**

**`OWNER ONLY — separate explicit approval`**

With Mirza's own procedure, **without** `drop_pending_updates`, the token never on argv.
Command: **TBD — see OQ-CUT-02** (P9).

Verification: `getWebhookInfo` via Mirza's side shows Mirza's URL.

**Step 3 — Mirza answers (R0 steps 1–2 after the webhook moves).** Restore the endpoint,
crons and `read_only = OFF` per R0, then confirm a button answers.

**Step 4 — loss list.**

**`read-only`**

Run the snapshot query of [`07-background-roles.md`](07-background-roles.md) with `since` =
H3's time. Expected: payments, non-opening wallet entries, orders and provisioning
operations all 0. Any non-zero: settle by hand in Mirza
(**`OWNER ONLY — separate explicit approval`**).

## R2 — after provisioner / monitor on

**`OWNER ONLY — separate explicit approval`**

```bash
sudo botctl roles disable provisioner monitor
```

Then R1. The loss list also lists any RickPanel write by Nexa (should be none) and the
reminders sent after B7 (they cannot be unsent), for the owner.

## R3 — after sales opened

Real money has moved on Nexa. **Prefer a forward fix.** R3 is taken only on the owner's
explicit decision, after the loss list exists.

1. **`OWNER ONLY — separate explicit approval`** — a new MAINTENANCE incident with
   `stop_sales`, and `sudo botctl roles disable provisioner monitor`.
2. **`read-only`** — produce the loss list **first**, per customer, terminal only:
   payments, wallet entries, orders, services created or renewed, panel accounts touched.
   Take it from the live database — or, if the owner chooses a restore, from the displaced
   database afterwards. Aggregate counts: the snapshot query with `since` = H3's time.
   The per-customer query: **TBD — see OQ-CUT-07** (no command produces it yet).
3. **`OWNER ONLY — separate explicit approval`** — settle each item by hand in Mirza
   (balances, service expiry).
4. RickPanel accounts Nexa created stay on the panel; list them for Mirza to take over or
   remove by hand.
5. Then the R1 steps.

## Triggers

Mapped from `../legacy-migration/rollback-runbook.md` T1–T9:

- `cutover-reconcile` exit 3, or a held class the owner does not accept (T1/T6);
- any provider write during import, B3 or B5 (T2);
- import `FAILED` or `COMPLETED_WITH_DISCREPANCY` (T3);
- the H5 check, or B3/B5/B8, fails (T4/T5);
- the window runs out before GO-4 (T7);
- the owner decides (T8).

## Never, during a rollback

- `botctl rollback` to undo data (it is application only);
- deleting rows;
- dropping `nexa` or `nexa_pre_restore_*`;
- `deleteWebhook` / `setWebhook` from the Nexa host;
- running the compaction;
- a customer broadcast from Nexa;
- unfreezing MirzaBot's MySQL without the owner.

## راهنمای فارسی

قاعده: بازگشت هرگز ردیفی را پاک نمی‌کند و دیتابیسی را حذف نمی‌کند. داده‌های Nexa یا دست‌نخورده
می‌مانند یا با مسیر بازیابی (دو تغییر نام؛ دیتابیس جابه‌جاشده نگه داشته می‌شود) برمی‌گردند. پس از
هر بازگشت، میرزا دوباره مرجع است و فقط مالک MySQL آن را از حالت فقط‌خواندنی درمی‌آورد.

- **R0** (پیش از واگذاری توکن): تلگرام هنوز به میرزا اشاره می‌کند. گام ۱ (فقط مالک): فعال‌سازی دوبارهٔ
  نقطهٔ پایانی، کرون‌ها و `read_only = OFF` — دستورها TBD — see OQ-CUT-02. گام ۲ (فقط خواندنی):
  دکمه‌ای در میرزا پاسخ بدهد. گام ۳ (فقط مالک): رخداد Nexa حل یا لغو شود. اختیاری: بازیابی بکاپ
  محافظ برای خالی‌کردن Nexa.
- **R1** (پس از واگذاری، فروش بسته): **ابتدا** (فقط مالک) `TELEGRAM_WEBHOOK_ENABLED=false` و
  `sudo botctl restart`، **سپس** ثبت دوبارهٔ وب‌هوک میرزا بدون `drop_pending_updates` (TBD — see
  OQ-CUT-02). سپس فهرست زیان با کوئری اسنپ‌شات از زمان H3 (فقط خواندنی)؛ انتظار: همه صفر.
- **R2**: ابتدا (فقط مالک) `sudo botctl roles disable provisioner monitor`، سپس R1.
- **R3** (پس از باز شدن فروش): پول واقعی جابه‌جا شده است؛ راه‌حل رو‌به‌جلو ترجیح دارد و R3 فقط با
  تصمیم صریح مالک و پس از تهیهٔ فهرست زیان. هر مورد دستی در میرزا (فقط مالک) تسویه می‌شود؛ حساب‌های
  ساخته‌شدهٔ Nexa روی پنل فهرست می‌شوند.
- هرگز: `botctl rollback` برای برگرداندن داده، حذف ردیف، حذف `nexa` یا `nexa_pre_restore_*`،
  `deleteWebhook`/`setWebhook` از سرور Nexa، compaction، یا پیام همگانی از Nexa.
