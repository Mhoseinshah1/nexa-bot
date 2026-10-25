# 07 — Background roles, customer link, sales

Phase 6. Order: **provisioner**, then **monitor**, then **link customers to the bot**, then
**open sales** — with a check between each. Precondition for the phase: H5 passed and the
MAINTENANCE incident from H1 is ACTIVE.

## Why this order

- The **provisioner** is the only role that writes to RickPanel (creates, renews, suspends
  accounts for orders) and runs the usage sync and the cashback, referral and refund
  sweeps. While sales are stopped it has nothing to create, so enabling it first proves it
  is quiet on imported data. (The first usage sync after an import is recorded silently:
  reminder baseline, Round 5A.)
- The **monitor** only probes panel health (GETs) on a timer. It comes second so a probe
  problem is not confused with a provisioner problem.
- The **customer link** (B7) comes after both because it turns reminders and notices ON for
  every imported customer at once.
- **Sales** open last.

The preflight's `background-roles` check expects both roles off, so after B2 it FAILS that
line by design (D9). From B2 on use `botctl roles status` and the step's own checks, not the
preflight.

## Session setup

**`read-only`**

```bash
set -o nounset
export DC="docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml"
mkdir -p ~/cutover && chmod 700 ~/cutover && cd ~/cutover
date -u +%FT%TZ | tee t0-start.txt
```

## The snapshot query

**`read-only`**

Used by B1, B3, B5 and B8 (and by H5 and the loss lists in [`08-rollback.md`](08-rollback.md)).
`:since` is a UTC time in single quotes inside the double quotes. psql interpolates `:since`
only in a script read with `-f`, never in `-c`, hence the heredoc. It runs in a `READ ONLY`
transaction, so a mistyped edit of it cannot write.

```bash
sudo $DC exec -T postgres psql -U nexa -d nexa -X -q -At -v ON_ERROR_STOP=1 -v since="'<UTC time>'" -f - <<'SQL'
BEGIN READ ONLY;
  SELECT 'provisioning_ops_since', type || ':' || state, count(*) FROM provisioning_operations
     WHERE created_at >= :since GROUP BY 2
  UNION ALL SELECT 'customer_notifications_since', state, count(*) FROM customer_notifications
     WHERE created_at >= :since GROUP BY 2
  UNION ALL SELECT 'payments_since', state, count(*) FROM payments WHERE created_at >= :since GROUP BY 2
  UNION ALL SELECT 'wallet_entries_since', reason, count(*) FROM wallet_entries WHERE created_at >= :since GROUP BY 2
  UNION ALL SELECT 'orders_since', state, count(*) FROM orders WHERE created_at >= :since GROUP BY 2
  UNION ALL SELECT 'orders_changed_since', state, count(*) FROM orders
     WHERE created_at < :since AND updated_at >= :since GROUP BY 2
  UNION ALL SELECT 'services_since', state, count(*) FROM services WHERE created_at >= :since GROUP BY 2
  UNION ALL SELECT 'services_changed_since', state, count(*) FROM services
     WHERE created_at < :since AND updated_at >= :since GROUP BY 2
  UNION ALL SELECT 'orders_fingerprint', coalesce(md5(string_agg(id::text || ':' || state, ',' ORDER BY id)), '-'),
     count(*) FROM orders
  UNION ALL SELECT 'services_fingerprint', coalesce(md5(string_agg(id::text || ':' || state || ':'
       || coalesce(expires_at::text, '-') || ':' || coalesce(traffic_limit_bytes::text, '-') || ':'
       || coalesce(device_limit::text, '-') || ':' || panel_id::text || ':' || customer_id::text, ','
       ORDER BY id)), '-'), count(*) FROM services
  UNION ALL SELECT 'ops_events_open', code, count(*) FROM operational_events WHERE resolved_at IS NULL GROUP BY 2
  UNION ALL SELECT 'panel_health', p.name || ':' || coalesce(h.state, 'UNCHECKED'), 1
     FROM panels p LEFT JOIN panel_health h ON h.panel_id = p.id;
ROLLBACK;
SQL
```

Reading it: a `_since` line that is absent means 0. `orders_since` counts every order
created — a DRAFT included, because `OrderService.createDraft` stores the order before any
payment; `orders_changed_since` counts older orders whose state moved. `services_since` counts
services created. `services_changed_since` also counts the usage sync's own touches (it
updates `updated_at`), so once the provisioner is on it is not the test: the two
**fingerprints** are — a hash over every order's state and every service's state, expiry,
traffic and device limit, panel and customer (usage counters excluded), with the row count
beside it. An unchanged fingerprint means no order or service was created, renewed,
suspended, moved or removed since the earlier snapshot. Tests:
`tests/integration/cutover-snapshot-query.test.ts` runs this block, as written here, against
the real schema.

## B1 — Baseline

**`read-only`**

Precondition: H5; incident ACTIVE.

```bash
date -u +%FT%TZ | tee b1.txt
```

Run the snapshot query with `since` = the time in `b1.txt`, saving the output as `b1.tsv`.

Verification: baseline recorded. Rollback: none needed.

## B2 — Enable the provisioner

**`OWNER ONLY — separate explicit approval`**

Precondition: B1.

```bash
sudo botctl roles enable provisioner
```

Verification: `roles status` shows provisioner enabled and monitor disabled; `botctl status`
ready.

Rollback:

```bash
sudo botctl roles disable provisioner
```

## B3 — Watch the provisioner

**`read-only`**

Precondition: B2. Wait 15–30 minutes (at least two provisioner ticks and one usage-sync
cycle). Run the snapshot query with `since` = b1, saving `b3.tsv`, and scan the logs for
repeated errors:

```bash
sudo botctl logs provisioner
```

Verification:

- provisioning operations since b1: only the types the sweeps create for **existing**
  services (usage sync); none `CREATE`, `RENEW`, `SUSPEND` or `TERMINATE`;
- `customer_notifications` since b1 = 0; no `notification.reminder_burst`; no new
  provisioner lane event;
- payments and wallet entries since b1 = 0;
- `orders_since`, `orders_changed_since` and `services_since` = 0, and `orders_fingerprint`
  and `services_fingerprint` equal `b1.tsv`'s (no order or service created or changed);
- RickPanel's own access log shows GETs and the token exchange only.

Rollback: B2's rollback. If a write reached RickPanel: P0 incident, R2.

## B4 — Enable the monitor

**`OWNER ONLY — separate explicit approval`**

Precondition: B3 clean.

```bash
sudo botctl roles enable monitor
```

Verification: `roles status` shows both enabled; `botctl status` ready.

Rollback:

```bash
sudo botctl roles disable monitor
```

## B5 — Watch the monitor

**`read-only`**

Precondition: B4. Wait one monitor interval plus margin. Run the snapshot query → `b5.tsv`.

Verification: every RickPanel health is HEALTHY (or its reason is shown); no new open ops
event; RickPanel's log shows GETs only; `orders_fingerprint` and `services_fingerprint` still
equal `b1.tsv`'s.

Rollback: B4's rollback.

## B6 — Customer link, dry run

**`read-only`**

Precondition: B5.

```bash
sudo $DC run --rm --no-deps -T --entrypoint node api dist/customers-link-bot.cli.js --bot <bot instance id from H6>
```

This is a dry run; it prints counts only. Whether a first `/start` already links an imported
customer is **UNKNOWN** (OQ-CUT-04), so B6 and B7 are required and their counts are the
evidence.

Verification: the count equals the imported customers with no bot link (about I7's customers).

Rollback: none needed.

## B7 — Link customers: reminders go ON

**`OWNER ONLY — separate explicit approval`** (turns reminders ON for every imported
customer)

Precondition: B6. The owner accepts that reminders now flow, capped by
`reminders.max_per_minute`, with the burst alarm `reminders.burst_alarm_per_hour`.

```bash
sudo $DC run --rm --no-deps -T -e CUSTOMER_FIRST_BOT_BACKFILL_CONFIRM=yes --entrypoint node api dist/customers-link-bot.cli.js --bot <bot instance id> --apply
```

Verification: linked = the B6 count; a rerun links 0.

Rollback: none that is clean — reminders cannot be unsent. To stop them, switch the reminder
feature flags off; the dispatcher holds queued reminders of a switched-off kind unsent
(`../legacy-migration/cutover-runbook.md` step 18).

## B8 — Watch the first reminder sweep

**`read-only`**

Precondition: B7. After the first reminder sweep, run the snapshot query → `b8.tsv`.

Verification: `customer_notifications` since B7 look like an ordinary day, not a burst; no
`notification.reminder_burst`.

Rollback: switch the reminder flags off (B7's rollback).

## GO-5

**`OWNER ONLY — separate explicit approval`**

The owner's go/no-go #5 ([`09-go-no-go.md`](09-go-no-go.md)). NO-GO → keep sales stopped;
R2 if needed.

## B9 — Open sales

**`OWNER ONLY — separate explicit approval`**

Precondition: GO-5.

In «رخدادها و نگهداری», resolve the MAINTENANCE incident (sales and top-ups resume). Still
never notify.

Verification: effects REVERTED; a catalogue shows products. Observe at T+15 m, 1 h and 24 h
with the step-18 queries of `../legacy-migration/cutover-runbook.md`.

Rollback: create a new MAINTENANCE `stop_sales` incident (R3).

## Negative balances

A customer whose Mirza balance was negative holds a negative Nexa wallet. Every purchase on
every rail is refused until a top-up brings it to zero (`assertWalletNotNegative`); a
top-up is never refused. Nothing ages or rewrites it, and no customer is told anything about
it automatically.

## Record

b1.txt and the four `.tsv` snapshots; B7's linked count; B9's time.

## راهنمای فارسی

ترتیب: **provisioner** ← **monitor** ← **اتصال مشتریان به ربات** ← **باز کردن فروش**، با بررسی میان
هر مرحله. provisioner تنها نقشی است که روی RickPanel می‌نویسد؛ تا فروش بسته است کاری برای ساختن
ندارد و باید ساکت بماند. پس از B2 بررسی `background-roles` در پیش‌پرواز طبق طراحی FAIL می‌شود؛ از
آن پس از `botctl roles status` و بررسی‌های خود هر مرحله استفاده کنید.

- **کوئری اسنپ‌شات** (فقط خواندنی): یک بار در بخش انگلیسی آمده و در B1، B3، B5 و B8 با `since` مناسب
  اجرا می‌شود.
- **B1** (فقط خواندنی): خط پایه. **B2** (فقط مالک — با تأیید صریح جداگانه): فعال‌سازی provisioner.
- **B3** (فقط خواندنی): ۱۵ تا ۳۰ دقیقه صبر؛ هیچ `CREATE`/`RENEW`/`SUSPEND`/`TERMINATE`، هیچ
  `customer_notifications`، پرداخت یا ورودی کیف پول، هیچ سفارش یا سرویس تازه یا تغییرکرده
  (`orders_since`، `orders_changed_since`، `services_since` صفر و دو اثرانگشت
  `orders_fingerprint` و `services_fingerprint` برابر `b1.tsv`)، و در لاگ RickPanel فقط GET.
  نوشتن روی RickPanel یعنی رخداد P0 و R2.
- **B4** (فقط مالک): فعال‌سازی monitor. **B5** (فقط خواندنی): سلامت همهٔ پنل‌ها؛ دو اثرانگشت
  همچنان برابر `b1.tsv`.
- **B6** (فقط خواندنی): اجرای آزمایشی اتصال مشتریان. **B7** (فقط مالک): `--apply` با
  `CUSTOMER_FIRST_BOT_BACKFILL_CONFIRM=yes`؛ **یادآورها برای همهٔ مشتریان روشن می‌شوند** و پس‌گرفتنی
  نیستند (فقط خاموش‌کردن پرچم‌های یادآور). OQ-CUT-04 نامعلوم است.
- **B8** (فقط خواندنی): پس از اولین دور یادآور، سیل ناگهانی نباید باشد.
- **GO-5** (فقط مالک). **B9** (فقط مالک): رخداد MAINTENANCE را حل کنید؛ هرگز اطلاع‌رسانی نزنید.
- موجودی منفی: کیف پول منفی تا شارژ هر خریدی را رد می‌کند و شارژ هرگز رد نمی‌شود.
