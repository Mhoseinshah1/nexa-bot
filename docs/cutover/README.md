# MirzaBot → Nexa production cutover

**Status: PREPARED, NOT RUN.** Nothing in this directory has been executed against the
production host, its database, its Telegram bot or its panels. Executing any step marked
**`OWNER ONLY — separate explicit approval`** needs the owner's own, explicit approval for
that run; approving or merging the pull request that added these pages approves none of them.

## The one rule

The cutover moves every Mirza customer, balance and service into a **new, empty** Nexa
installation with the `.nxpkg` Fresh Migration ([`../legacy-migration/nxpkg-importer.md`](../legacy-migration/nxpkg-importer.md)),
hands the **same Telegram bot token** over to Nexa, and proves — before a single customer can
buy — that every Mirza balance is exactly the customer's Nexa wallet, with **zero
tolerance**, and that no Mirza agent credit became wallet money. Each stage has a rollback
back to MirzaBot; none of them deletes a row or drops a database, and nothing tells a
customer anything automatically.

## Pages

| Page                                               | What it covers                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`00-overview.md`](00-overview.md)                 | Topology, roles, the timeline, what this runbook never does, conventions                                  |
| [`01-preconditions.md`](01-preconditions.md)       | Gates that must already be green; the production installation; the rehearsal; go/no-go #1                 |
| [`02-freeze.md`](02-freeze.md)                     | Stopping Mirza's writes (bot endpoint, crons, MySQL read-only)                                            |
| [`03-final-export.md`](03-final-export.md)         | The final Mirza backup → `.nxpkg` with Mirza2Nexa                                                         |
| [`04-import.md`](04-import.md)                     | Dry run first, the owner's approval, the import, the independent checks                                   |
| [`05-reconciliation.md`](05-reconciliation.md)     | The balance reconciliation report (`cutover-reconcile`) on a restored copy, and the reseller credit check |
| [`06-token-handover.md`](06-token-handover.md)     | The same bot token: the webhook switch and what happens to in-flight updates                              |
| [`07-background-roles.md`](07-background-roles.md) | Enabling `provisioner`, then `monitor`, then the customer link, then sales — with the checks between      |
| [`08-rollback.md`](08-rollback.md)                 | Back to Mirza at each stage: token, webhook, and the data written meanwhile                               |
| [`09-go-no-go.md`](09-go-no-go.md)                 | The owner's go/no-go checklist, one table per decision point                                              |
| [`10-communications.md`](10-communications.md)     | What customers are told, by whom, when — and what Nexa never sends                                        |
| [`11-records.md`](11-records.md)                   | The cutover record to fill in as you go                                                                   |
| [`12-rehearsal.md`](12-rehearsal.md)               | **Rehearsal**: the whole runbook on the test server against a disposable database, with the go/no-go      |

## The tools these pages use

The first three are read-only. None can change the installation, and none reads the live
database except through the same read-only CLIs `botctl status` already runs. The fourth
writes only a database it creates for itself.

- **`sudo botctl cutover preflight [--expect-version V] [--expect-telegram none|ready]
[--max-backup-age-hours N] [--min-free-gib N]`** — eight checks (release, readiness,
  recovery role, provisioner and monitor off, migrations, a fresh verified backup, disk, the
  Telegram webhook), `PASS`/`FAIL` each; exit 0 only when all pass. A release with no
  manifest cannot be confirmed and FAILs; the disk line measures Docker's data root as
  `docker info` reports it (where the database and backup volumes live) and FAILs when it
  cannot. It takes no lock and starts or stops nothing. Tests:
  `tests/deploy/cutover-preflight.test.sh`.
- **`migrate.js --check`** — one word (`current`, `ahead`, `behind`, `none`, `diverged`);
  applies nothing. The preflight's `migrations` line.
- **`cutover-reconcile`** (`node dist/cutover-reconcile.cli.js` in the image,
  `pnpm cutover-reconcile`) — the Mirza package's own `user.Balance` against the sum of every
  ledger entry of each Nexa customer, zero tolerance; agent credit (`maxbuyagent`) listed
  separately and never added; reseller credit limits must be zero. It refuses any database
  whose name lacks a non-production word (`nexa` is refused), so at the cutover it reads a
  **restored copy** of the post-import backup (`nexa_cutover_scratch`). Exit 0 `RECONCILED`,
  2 `RECONCILED_WITH_HELD`, 3 `DIFFERENCES`. Tests: `tests/unit/cutover-reconciliation.test.ts`,
  `tests/integration/cutover-reconcile.test.ts`.
- **`sudo botctl cutover rehearse PACKAGE (--key-file FILE | --passphrase) --owner-telegram-id N
[--database NAME] [--keep-database] [--panel-inventory FILE] [--json]`** (`pnpm cutover-rehearse`)
  — the rehearsal ([`12-rehearsal.md`](12-rehearsal.md)): a NEW database on the server, migrated,
  provisioned and imported into through the restore page's own service and executor with
  read-only panel stand-ins, then the balance, service and reseller-credit reconciliation against
  the package and a go/no-go; the database is dropped afterwards. It refuses the live database
  (by name, and when it equals `DATABASE_URL`'s), a production-like name and an existing database;
  it never hands the token over, changes a webhook, starts a role, calls Telegram or messages a
  customer. Exit 0 `GO`, 2 `GO_WITH_HELD`, 3 `NO_GO`, 64 usage, 65 refused target. Tests:
  `tests/integration/cutover-rehearsal.test.ts`, `tests/unit/cutover-rehearsal.test.ts`,
  `tests/deploy/cutover-rehearse.test.sh`.

## Related

The older P7 (MySQL dump) path on an existing installation, whose reasoning these pages reuse:
[`../legacy-migration/cutover-runbook.md`](../legacy-migration/cutover-runbook.md),
[`../legacy-migration/rollback-runbook.md`](../legacy-migration/rollback-runbook.md),
[`../legacy-migration/production-gate.md`](../legacy-migration/production-gate.md).
Open questions: `docs/open-questions.md` § OQ-CUT.

---

## راهنمای فارسی

**وضعیت: آماده‌شده، اجرا نشده.** هیچ مرحله‌ای از این پوشه روی سرور اصلی، دیتابیس آن، ربات
تلگرام یا پنل‌ها اجرا نشده است. هر مرحله‌ای که با «فقط مالک — با تأیید صریح جداگانه» مشخص
شده، برای هر بار اجرا به تأیید صریح خود مالک نیاز دارد؛ تأیید یا ادغام درخواست ادغامی که این
صفحه‌ها را اضافه کرد، هیچ‌کدام از آن مراحل را تأیید نمی‌کند.

قاعدهٔ اصلی: همهٔ مشتریان، موجودی‌ها و سرویس‌های میرزا با «انتقال تازه» از فایل `.nxpkg` به یک
نصب **تازه و خالی** از Nexa منتقل می‌شوند، **همان توکن ربات** به Nexa سپرده می‌شود، و پیش از آنکه
هیچ مشتری بتواند خرید کند ثابت می‌شود که موجودی هر مشتری در میرزا دقیقاً برابر کیف پول او در
Nexa است (بدون هیچ اختلاف مجاز) و اعتبار نمایندگی میرزا به پول کیف پول تبدیل نشده است. هر مرحله
راه بازگشت به میرزا دارد؛ هیچ‌کدام ردیفی را پاک نمی‌کند یا دیتابیسی را حذف نمی‌کند، و هیچ پیامی
خودکار به مشتری فرستاده نمی‌شود.

ابزارها (همه فقط خواندنی): `sudo botctl cutover preflight` (هشت بررسی با PASS/FAIL)،
`migrate.js --check`، و `cutover-reconcile` (مقایسهٔ موجودی میرزا با کیف پول Nexa روی **نسخهٔ
بازیابی‌شده** از بکاپ پس از انتقال؛ دیتابیس اصلی `nexa` را نمی‌پذیرد).
