# 12 — Rehearsal: the whole runbook against a disposable database

**Status: built and tested against synthetic packages; not yet run on the test server.** The
rehearsal is the last thing done on the **test server** before GO-1: it runs this runbook's
data steps end to end with the final Mirza export (or the latest real backup converted with
Mirza2Nexa), into a database it creates for the purpose and drops afterwards, and prints the
reconciliation report and a go/no-go. Conventions: [`00-overview.md`](00-overview.md).

It is not the cutover and it changes nothing the cutover depends on: the live database, the
live tenant, the bot token, the webhook, the panels and the customers are never touched.

## What it runs

`sudo botctl cutover rehearse` runs `node dist/cutover-rehearse.cli.js` in a one-off `api`
container (`pnpm cutover-rehearse` from a checkout). One line per step, in the runbook's order:

| Line                | Runbook           | What it does                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`            | 02, freeze-equiv. | The disposable database is new; its name carries a non-production word; it is **not** the database `DATABASE_URL` names. Each is a refusal (exit 65) before anything is created.                                                                                                                                                              |
| `messaging`         | 02, freeze-equiv. | The run's own configuration has notification dispatch, the webhook, backup delivery to Telegram, the backup schedule, the provisioner and the monitor **forced off**, whatever `nexa.env` says, and every outbound `fetch` of the process is refused.                                                                                         |
| `package`           | 03 E2             | The package's SHA-256 (the `finalDumpSha256` of D5); `package-unchanged` takes it again at the end.                                                                                                                                                                                                                                           |
| `database`          | 01, 04 I2         | `CREATE DATABASE`, every migration, `migrate --check` = `current`.                                                                                                                                                                                                                                                                            |
| `fresh-target`      | 04 I2             | One PRIMARY tenant (`cutover-rehearsal`, IRT), the rehearsing owner (in this database only), and the `verify-import.sql` "before" figures: customers, wallet entries, payments, orders, bot instances all 0.                                                                                                                                  |
| `verify` … `import` | 04 I3–I7          | The import through the **same** service and executor the restore page uses: upload, key, verify, panel binding, dry run, the owner's approval (with the target acknowledgement where the target is production-like), apply — protective backup, write freeze, history, resellers with no credit, reconcile, final report, post-import backup. |
| `panels`            | 01 0.3            | One **read-only RickPanel stand-in** per package panel target (`deploy/rehearsal/rickpanel-standin.mjs`), inside the rehearsal's own process, registered and connection-tested like any panel. It refuses and counts every write. A real panel is never contacted.                                                                            |
| `reconciliation`    | 05 C3–C5          | Balances (`cutover-reconcile`'s own rules: zero tolerance, agent credit listed never credited, every reseller credit zero) and **services** (below), Mirza package against Nexa.                                                                                                                                                              |
| `token-handover`    | 06                | `SKIP`, always. No token, no webhook, no bot.                                                                                                                                                                                                                                                                                                 |
| `no-messages`       | 10                | Zero customer notifications, broadcast recipients, outbox publications, operator alerts sent, provisioning operations and bot instances in the disposable database; zero outbound `fetch` attempts (Telegram's counted apart); zero write attempts on a stand-in. An attempt that was stopped is still a FAIL.                                |
| `background-roles`  | 07                | `SKIP`, dry: no role is started; the provisioning-operation count it would start from is shown.                                                                                                                                                                                                                                               |
| `cleanup`           | —                 | The database this run created is dropped; with `--keep-database` it is kept and named.                                                                                                                                                                                                                                                        |

Then the two reports and one line, `go/no-go: GO | GO_WITH_HELD | NO_GO (reasons)`.

## The service reconciliation

Every Mirza service the package's own snapshot carries (every live invoice, and every other
invoice that was ever paid for — the importer's own list) against the outcome the import
recorded (`legacy_service_candidates`) and the Nexa services that name the invoice
(`source MIRZA`, `source_ref invoice:<id>`):

- **matched** — adopted, its service exists, is not terminated, and belongs to the invoice's own
  Mirza user;
- **held**, by outcome — not adopted; never a match; kept as a terminated history service or not
  at all. With the default empty stand-in inventory every live service is held as
  `PROVIDER_MISSING`: that is the expected stage-A result, not a failure;
- **differences** (any one is NO_GO): `SERVICE_NOT_DECIDED`, `SERVICE_ADOPTED_MISSING`,
  `SERVICE_DUPLICATED`, `SERVICE_LIVE_WHILE_HELD`, `SERVICE_OWNER_DIFFERS`,
  `SERVICE_NOT_IN_MIRZA`, `CANDIDATE_NOT_IN_MIRZA`.

Differences name an invoice by its position in the package and a service by its Nexa id —
never a Telegram id, a panel username or a link.

## R1 — Run the rehearsal (test server)

**`OWNER ONLY — separate explicit approval`** (creates, fills and drops a NEW database on the
test server's PostgreSQL; never the live one, never on production)

Precondition: the test server runs the approved release; the package and its key are in
`~/cutover` (mode 0700), copied as in [`03-final-export.md`](03-final-export.md) E2/E3; room on
Docker's data root for one more imported database, the decrypted package and two backups of it.

```bash
set -o nounset
mkdir -p ~/cutover && chmod 700 ~/cutover && cd ~/cutover
date -u +%FT%TZ | tee rehearsal-start.txt
sudo botctl cutover rehearse ~/cutover/nexa-restore-mirza-<date>.nxpkg \
  --key-file ~/cutover/<key>.nxkey --owner-telegram-id <owner-numeric-id> \
  | tee rehearsal.txt; echo "exit ${PIPESTATUS[0]}"
```

A passphrase instead of a key file: `--passphrase` (typed on the terminal, never on argv).
`--json` prints one JSON document instead (`> rehearsal.json`). Other options:
`--database NAME` (default `nexa_cutover_rehearsal_<UTC>`), `--keep-database` (keep it to
inspect; drop it yourself afterwards), `--panel-inventory FILE` (stage B accounts for the
stand-ins, `{"<code_panel>": [account, …]}`; default empty), `--list-differences` (terminal
only, never pasted).

Verification:

- exit **0** `GO`, or exit **2** `GO_WITH_HELD` with each held class (balances `held …` lines,
  services `held <OUTCOME>` lines) accepted by name, exactly as at GO-3;
- every step line `PASS` or `SKIP`; `token-handover` and `background-roles` are `SKIP`;
- `no-messages` PASS: every count 0;
- balances: `verdict: RECONCILED` or `RECONCILED_WITH_HELD`; every `difference …: 0`; the five
  reseller lines of C5 at 0; `agent credit LISTED, NOT CREDITED: n rows, S IRT` copied as a
  figure that was NOT credited;
- services: every `difference …: 0`; matched + held = Mirza services;
- `cleanup` names the database dropped (or kept, on request).

Exit **3** `NO_GO`: the reasons are on the `go/no-go` line; run again with
`--list-differences` on the terminal to see which rows. Fix the cause (package, converter,
release) and rehearse again — never repair rows. Exit 64 is a usage error, 65 a refused target
(the live database, a production-like name, a database that already exists), 1 anything else.

Rollback: none needed — nothing on the installation changed. If the run was killed before its
cleanup, its database is left behind under the name the `target` line printed; drop it
(**`OWNER ONLY — separate explicit approval`**, that name only):

```bash
sudo docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml \
  exec -T postgres dropdb -U nexa nexa_cutover_rehearsal_<stamp>
```

Record: `rehearsal.txt` (aggregates only), the exit code, the duration (`rehearsal-start.txt`
to the end), the held classes accepted, into [`11-records.md`](11-records.md) and the GO-1 table.

## What it never does

- It never uses the live database: the name `DATABASE_URL` names is refused whatever word it
  carries, a production-like name is refused, and a database that already exists is refused —
  it never reuses, empties or drops a database it did not create.
- It never hands the token over, changes a webhook, registers a bot, starts the bot, the worker,
  the provisioner or the monitor against the disposable database, or calls Telegram: the
  disposable database holds no bot, the run's dispatch and webhook settings are forced off, and
  every outbound `fetch` of the process is refused and counted.
- It never sends a customer anything: no notification, no broadcast, no outbox publication
  (no relay runs); the `no-messages` line proves it from the database it filled.
- It never contacts a real panel: the only panels in the disposable database are its own
  read-only stand-ins, inside the rehearsal process.
- It never touches the live tenant: it reads nothing from it and writes nothing to it. Its
  backups and package copies stay in its own private directory inside the one-off container.

## Limits

- **No tariff products.** The disposable database has none (the live tenant's are not copied),
  so a service found on a stand-in may still be held with the outcome the import records for
  it. The money reconciliation is complete without them (stage A, as in
  [`../legacy-migration/nxpkg-real-rehearsal.md`](../legacy-migration/nxpkg-real-rehearsal.md)).
  See OQ-R11-A2-01.
- **The stand-ins listen on the one-off container's own address** (its edge-network address in
  production; loopback is refused there) for the length of the run, behind random credentials,
  read-only.
- **Redis is the installation's.** The configuration requires a `REDIS_URL`, so the process is
  given the installation's, as every one-off container is. Redis holds only the readiness probe
  and the bot's and mini app's rate counters; the rehearsal serves no bot or mini-app request.
- **The test server, not production.** Nothing stops it on production's host, and it would
  touch no live data there either, but this page is written for the test server (OQ-R11-A2-02).

Tests: `tests/integration/cutover-rehearsal.test.ts` (a package with a known reconciliation;
one deliberate balance and service mismatch and a Telegram fetch attempt → NO_GO; the live
database refused and unchanged), `tests/unit/cutover-rehearsal.test.ts`,
`tests/deploy/cutover-rehearse.test.sh`.

## راهنمای فارسی

**وضعیت: ساخته و با بسته‌های مصنوعی آزموده شده؛ هنوز روی سرور آزمایشی اجرا نشده است.** تمرین
انتقال، همهٔ مراحل داده‌ای این راهنما را با خروجی نهایی میرزا روی یک **دیتابیس تازه و دورریختنی**
روی سرور آزمایشی اجرا می‌کند و در پایان گزارش تطبیق و نتیجهٔ «برو / نرو» را چاپ می‌کند.

- **دستور** (فقط مالک — با تأیید صریح جداگانه، فقط روی سرور آزمایشی):
  `sudo botctl cutover rehearse <بسته>.nxpkg --key-file <کلید>.nxkey --owner-telegram-id <شناسه>`.
  گذرواژه به جای فایل کلید: `--passphrase` (روی ترمینال تایپ می‌شود، هرگز روی خط فرمان).
- **چه می‌کند:** دیتابیس تازه می‌سازد، همهٔ مهاجرت‌ها را اجرا می‌کند، یک مستأجر اصلی (IRT) می‌سازد،
  بسته را با همان سرویس و اجراکنندهٔ صفحهٔ «بکاپ و بازیابی ← عملیات بازیابی» وارد می‌کند (پنل‌ها
  نسخهٔ جایگزین فقط‌خواندنی‌اند، هرگز پنل واقعی)، موجودی کیف پول‌ها، سرویس‌ها و اعتبار نمایندگان را
  با بستهٔ میرزا تطبیق می‌دهد و در پایان دیتابیس را حذف می‌کند (`--keep-database` آن را نگه می‌دارد).
- **هرگز:** دیتابیس اصلی (با نام رد می‌شود)، دیتابیسی که از قبل وجود دارد، سپردن توکن (مرحلهٔ ۰۶)،
  تغییر وب‌هوک، روشن کردن ربات یا worker روی دیتابیس تمرینی، هیچ تماسی با تلگرام، هیچ پیامی به
  مشتری، هیچ پنل واقعی، هیچ دست‌زدن به مستأجر اصلی. خط `no-messages` این را از خود دیتابیس ثابت می‌کند.
- **خروجی:** ۰ یعنی `GO`؛ ۲ یعنی `GO_WITH_HELD` و مالک هر دستهٔ نگه‌داشته‌شده را با نام می‌پذیرد؛
  ۳ یعنی `NO_GO` (دلایل روی خط `go/no-go` است؛ هرگز ردیفی «تعمیر» نمی‌شود)؛ ۶۴ خطای استفاده؛ ۶۵ مقصد
  ردشده.
- **محدودیت:** دیتابیس تمرینی محصول تعرفه ندارد، پس سرویسی که روی پنل جایگزین پیدا شود ممکن است
  همچنان نگه‌داشته شود؛ تطبیق پول بدون آن کامل است (OQ-R11-A2-01).
