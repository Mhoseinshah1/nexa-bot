# 04 — Import: dry run first

Phase 3. The import is the one destructive production step of the window (I6). It needs
GO-2 first. Precondition for the phase: phase 2 done.

## I0 — Session setup

**`read-only`**

```bash
set -o nounset
export DC="docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml"
mkdir -p ~/cutover && chmod 700 ~/cutover && cd ~/cutover
date -u +%FT%TZ | tee t0-start.txt
```

## I1 — Preflight

**`read-only`**

Precondition: phase 2 done.

```bash
sudo botctl cutover preflight --expect-version <vX.Y.Z> --expect-telegram none
```

Verification: PASS. Rollback: none needed.

## I2 — The target is fresh, checked independently

**`read-only`**

Precondition: the release checkout is at the approved commit
(`git -C <checkout> rev-parse HEAD` equals the commit in `botctl version`).

```bash
sudo $DC exec -T postgres psql -U nexa -d nexa -X -f - < <checkout>/deploy/rehearsal/verify-import.sql | tee verify-pre.tsv
```

Verification: customers 0, wallet entries 0, payments 0, orders 0, bot instances 0.

Rollback: none needed.

## I3 — Upload and verify the package

**`OWNER ONLY — separate explicit approval`**

Precondition: I1, I2.

Web Admin «بکاپ و بازیابی ← عملیات بازیابی»: choose the `.nxpkg`; give the key (file) or
passphrase. This uploads and verifies.

Verification: status `VERIFIED`. Any `NXPKG_*` code stops here.

Rollback: cancel the import (any non-terminal status → `CANCELLED`). Nothing was written.

## I4 — Bind the panel; the dry run runs

**`OWNER ONLY — separate explicit approval`**

Precondition: I3.

Bind the package's panel code(s) to the RickPanel (automatic when exactly one RickPanel is
ACTIVE). Optionally upload the ownership decisions. The dry run starts by itself and reads
RickPanel with GETs and the token exchange only.

Verification: status `DRY_RUN_DONE`.

Rollback: cancel. Nothing was written.

## I5 — Read the dry run

**`read-only`**

Precondition: I4.

Read every section: `customers`, `wallet_openings`, `legacy_debts`, `trials`, `products`,
`invoice_archive`, `services`, `history:*`, and one `table:<class>:<name>` per Mirza table.
Required:

- no `table:UNCLASSIFIED`, no `TABLE_INVENTORY_INCOMPLETE`;
- no `PROVIDER_INVENTORY_INCOMPLETE` or `INVENTORY_INCOMPLETE` (`PROVIDER_INVENTORY_CHURN`
  is information only);
- converter totals equal the importer's plan (else `DRY_RUN_MISMATCH`);
- the seven cutover values noted.

Compare with E1's converter figures (the three-source table in
`../legacy-migration/nxpkg-real-rehearsal.md` §6). Rows the import holds for manual review
are counted as held, never as matched.

Verification: every figure equal, or its difference explained in writing.

Rollback: cancel; fix the cause; re-export (phase 2) or re-dry-run.

## GO-2

**`OWNER ONLY — separate explicit approval`**

The owner's go/no-go #2 ([`09-go-no-go.md`](09-go-no-go.md)). NO-GO → R0.

## I6 — Approve and apply: the destructive production step

**`OWNER ONLY — separate explicit approval`**

Precondition: GO-2. The approval lives 24 h (`APPROVAL_EXPIRED` after).

In «تأیید بازیابی»: type `IMPORT MIRZA`. The same confirmation acknowledges the target and
records the cutover approval of the seven values.

Expected sequence: status `APPROVED` → `APPLYING`; a protective `PRE_RESTORE` backup is
taken and verified first (`preImportBackupRunId`); the installation-wide write freeze
(`recovery.quiesced`); apply; history; materialize (agents become resellers **with no
credit**); bot link (`NO_ACTIVE_BOT` is expected: there is no bot yet); reconcile; v2
report; post-import backup. **The import sends no customer anything.**

Verification: see I7.

Rollback:

- `FAILED` — nothing more is written. Read `errorCode`. If anything was written, restore the
  protective backup on the same page (**`OWNER ONLY — separate explicit approval`**), then R0.
- `COMPLETED_WITH_DISCREPANCY` — NO-GO. Restore the protective backup
  (**`OWNER ONLY — separate explicit approval`**), then R0.

Record: import id, `preImportBackupRunId`, the seven values, start and end times.

## I7 — Read the result, and verify independently

**`read-only`**

Precondition: I6.

Read the import result: status **COMPLETED**, reconcile **RECONCILED**, v2 `verdict.holds`,
exact-match `holds` with `unexplained 0`, post-import backup TAKEN. Then run
`verify-import.sql` again:

```bash
sudo $DC exec -T postgres psql -U nexa -d nexa -X -f - < <checkout>/deploy/rehearsal/verify-import.sql | tee verify-post.tsv
```

Verification: all of the above; and in `verify-post.tsv` the customers, opening
credits/debits (count and sum), `wallet_entries_other = 0`, payments as history only, orders
only `LEGACY_ADOPTION` with sum 0, bot instances 0, `customer_notifications` 0. Equal to
I5 and E1.

Rollback: as I6.

Record: post-import backup run id, `verify-post.tsv` (aggregates), dry-run figures.

## I8 — Restart the worker

**`OWNER ONLY — separate explicit approval`**

Precondition: I7.

```bash
sudo botctl restart background
```

This restarts the worker only; `provisioner` and `monitor` are disabled and skipped.

Verification: `botctl status` ready; `botctl roles status` shows both still disabled.

Rollback: none needed.

## Negative balances

A customer whose Mirza balance was negative now has a negative Nexa wallet (a DEBIT
opening). Every purchase is refused until a top-up brings it to zero; a top-up is never
refused. Nothing ages or rewrites it, and no customer is told automatically.

## Rollback of the phase

Before I6: cancel (nothing written). After I6: restore the protective backup, then R0
([`08-rollback.md`](08-rollback.md)). Never delete rows, never drop a database.

## راهنمای فارسی

فاز ۳: ابتدا آزمایشی (dry run)، بعد تأیید مالک، بعد اعمال. تنها مرحلهٔ مخرب تولیدی پنجره، I6 است.

- **I0–I2** (فقط خواندنی): تنظیم نشست، پیش‌پرواز، و بررسی مستقل اینکه مقصد تازه است
  (`verify-pre.tsv`: مشتری، ورودی کیف پول، پرداخت، سفارش و نمونهٔ ربات همه صفر).
- **I3 و I4** (فقط مالک — با تأیید صریح جداگانه): در «بکاپ و بازیابی ← عملیات بازیابی» بسته و
  کلید را بدهید؛ وضعیت `VERIFIED`؛ پنل بسته به RickPanel وصل می‌شود و dry run خودکار انجام
  می‌شود (`DRY_RUN_DONE`). بازگشت: لغو؛ چیزی نوشته نشده است.
- **I5** (فقط خواندنی): همهٔ بخش‌ها خوانده می‌شود؛ بدون `UNCLASSIFIED` و بدون
  `INVENTORY_INCOMPLETE`؛ ارقام مبدل و ایمپورتر برابر؛ هفت مقدار تأیید ثبت شود. ردیف‌های نگه‌داشته‌شده
  هرگز «منطبق» نیستند.
- **GO-2** (فقط مالک): تصمیم دوم؛ «نه» یعنی R0.
- **I6** (فقط مالک — مرحلهٔ مخرب): در «تأیید بازیابی» عبارت `IMPORT MIRZA` را بنویسید.
  بکاپ محافظ `PRE_RESTORE` ابتدا گرفته می‌شود؛ نمایندگان میرزا بدون هیچ اعتبار به reseller تبدیل می‌شوند؛
  **هیچ پیامی به مشتری ارسال نمی‌شود**. در `FAILED` یا `COMPLETED_WITH_DISCREPANCY` بکاپ محافظ
  بازیابی شود (فقط مالک) و سپس R0.
- **I7** (فقط خواندنی): وضعیت COMPLETED و RECONCILED، `verify-post.tsv` و `customer_notifications`
  برابر صفر.
- **I8** (فقط مالک): `sudo botctl restart background`؛ نقش‌های `provisioner` و `monitor` همچنان
  غیرفعال می‌مانند.
- موجودی منفی میرزا کیف پول منفی می‌شود و تا شارژ، خرید را رد می‌کند؛ به مشتری خودکار چیزی گفته
  نمی‌شود.
