# Mirza → NEXA: the isolated rehearsal with a real backup

Status: **prepared, not run.** The kit below (`deploy/rehearsal/`) is tested by unit tests
and `docker compose config`; no rehearsal with real data has been run by anyone. Running it is the
operator's act, on a machine the operator controls. Production and the current staging are
never involved: the script refuses a host that carries a NEXA installation.

What it is: one NEXA, on its own Docker Compose project and its own new database, with
**no route to the internet** from any NEXA process, **no Telegram**, **no real panel** (a
read-only RickPanel stand-in that refuses and counts every write), into which the operator
imports a `.nxpkg` converted from a real Mirza backup — through the same admin page, the same
`migration` process role and the same production gates a future activation will use.

What it is not: a deployment, a staging environment, a cutover. Nothing in it is reachable
from outside the machine, and nothing it holds is ever copied anywhere by it.

Related: [`nxpkg-coverage.md`](nxpkg-coverage.md) (what moves where),
[`nxpkg-activation.md`](nxpkg-activation.md) (the future activation),
[`nxpkg-importer.md`](nxpkg-importer.md) (design).

## 1. The machine

- A machine that is **not** the production or staging server: a spare Linux server, a VM, or
  a Linux laptop. Docker Engine 24+ with Compose v2.24+ (`docker compose version`), `git`,
  `python3`. The script refuses a host with `/etc/nexa`, `/opt/nexa` or a Compose project
  named `nexa`, with no override.
- Sizing, from the 200,000-customer synthetic run: 4 CPU, **8 GB RAM** (peak 2.6 GB for the
  migration process, plus PostgreSQL), 20 GB free disk. A 200k import takes about 1.5 hours.
- The converted `.nxpkg` and its key file are copied to this machine by hand (USB, scp to
  the machine itself). Never through GitHub, CI, a chat or a shared drive.

## 2. Two stages

| Stage | Panel                                   | Proves                                                                                                                                                                      | Approval                       |
| ----- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **A** | the stand-in, **empty** inventory       | customers, opening balances, debts, trials, products, invoice archive, every history type, reconciliation, the v2 report, the standard backup, the gates; zero panel writes | this guide                     |
| **B** | the real RickPanel, **read-only** reads | which live services the panel proves, so adoption counts are real                                                                                                           | a separate owner decision (§8) |

Stage A is complete without B: with an empty inventory every live Mirza service is reported
as not on the panel and kept as history/review — the expected result of stage A, not a
failure.

## 3. Set it up (once)

```bash
git clone https://github.com/Mhoseinshah1/nexa-bot.git && cd nexa-bot
git checkout claude/mirza-nxpkg-importer          # the reviewed head; note `git rev-parse HEAD`
R=~/mirza-rehearsal-1                              # a NEW directory, outside the checkout
deploy/rehearsal/mirza-rehearsal.sh init  --dir "$R"   # secrets generated, 0600, never printed
deploy/rehearsal/mirza-rehearsal.sh build --dir "$R"   # the image, from this exact checkout
deploy/rehearsal/mirza-rehearsal.sh up    --dir "$R"   # migrate, provision, start, preflight
deploy/rehearsal/mirza-rehearsal.sh owner --dir "$R" --telegram-id <your numeric id>
```

`up` ends with the **isolation preflight** and stops if any check fails. Re-run it any time:
`mirza-rehearsal.sh preflight --dir "$R"`. It checks: the flags in `nexa.env`; the database is
the rehearsal's own `nexa_mirza_rehearsal`; `provisioner`, `monitor`, `assistant` and `recovery`
are not running; the `data`, `front` and `panelsim` networks are internal; `api`, `worker` and
`migration` **cannot reach the internet** (a real fetch to Telegram must fail); no Telegram bot
is configured; every panel is the stand-in.

Open **https://localhost:18443** in a browser on the same machine (accept Caddy's local
certificate once) and log in as the owner.

## 4. The panel (stand-in) — the RickPanel check

1. `mirza-rehearsal.sh standin-credentials --dir "$R"` prints its address
   (`http://172.30.243.10:8000` by default), username and password — rehearsal values that
   open nothing else.
2. **پنل‌ها → افزودن پنل**: type **RickPanel**, that address, that username and password. Save,
   run the **connection test** (it must pass), then enable the panel.
3. Check: the panel shows provider **RickPanel**, status ACTIVE. `mirza-rehearsal.sh preflight`
   still passes (the only panel is the stand-in).

Never register a real panel in the rehearsal (stage B is its own decision).

## 5. The import

On the admin page **«مهاجرت از میرزا»**:

1. **Target acknowledgement.** The page shows `NEXA_LEGACY_IMPORT_TARGET_ACK=<16 hex>` (the
   rehearsal runs with production semantics). Give it to the migration role:
   `mirza-rehearsal.sh set-target-ack --dir "$R" <16 hex>`.
2. **بارگذاری**: upload the `.nxpkg`. Then the key: the `.nxkey` file (or the passphrase). The key
   is sealed with the rehearsal's keyring, never logged, erased at the end.
3. **بررسی بسته**: verify must pass (crypto, version 1.4.0, structure, fingerprint). Any
   `NXPKG_*` code stops here.
4. **پنل‌ها و مشتریان**: bind the package's panel code(s) to the stand-in RickPanel; optionally
   upload the sealed `ownership-decisions.json` from the converter.
5. **اجرای آزمایشی (Dry Run)**. Read every section before going on:
   - `customers`, `wallet_openings`, `legacy_debts`, `trials`, `products`, `invoice_archive`,
     `services`, `history` and every `history:<type>`;
   - one `table:<class>:<name>` per Mirza table — no `table:UNCLASSIFIED:…` line may exist, and
     no `INVENTORY_INCOMPLETE` warning (a production-like dry run refuses it anyway);
   - warnings and quarantine; the wallet and debt totals; the ownership summary;
   - the seven cutover values.
     Write the figures down (or save the page) — §6 compares them.
6. **Stop sales** (the cutover gate requires it): **رخدادها و نگهداری** → a **MAINTENANCE**
   incident, `stop_sales` on, targeting every panel (the stand-in) and every gateway (none in a
   rehearsal), active now. No customer message is needed (there is no bot).
7. **تأیید انتقال نهایی** (`/legacy-cutover`): record the owner's approval of exactly the seven
   values the dry run listed.
8. **تأیید نهایی**: type `IMPORT MIRZA`. The migration role imports in the background; the page
   shows progress. A crash or a restart resumes by itself (lease, 5 minutes).
9. **گزارش، تطبیق، ممیزی و پشتیبان**: the run must end **COMPLETED**, reconciliation
   **RECONCILED**, the v2 report holding, and a standard backup **TAKEN**.

## 6. Independent checks after the import

```bash
deploy/rehearsal/mirza-rehearsal.sh verify        --dir "$R"   # counts straight from the database
deploy/rehearsal/mirza-rehearsal.sh standin-check --dir "$R"   # must say: refused(write attempts)=0
deploy/rehearsal/mirza-rehearsal.sh backup-list   --dir "$R"   # the backup the migration took
deploy/rehearsal/mirza-rehearsal.sh preflight     --dir "$R"   # still isolated
```

`verify` (`deploy/rehearsal/verify-import.sql`, read-only) prints, from the database itself:
customers (all, and those with a Mirza id), opening credits (count and sum, IRT), any other
wallet entry (**must be 0**), legacy debts (count, sum, by state), orders (only
`LEGACY_ADOPTION`, sum **0**), payments (**0**), bot instances (**0**), service candidates by
outcome, services, invoice archive (and test invoices), history by record type, panels,
the import's status and the backup runs.

Compare, line by line, three independent sources:

| Figure                        | Converter (Windows, `reports/reconciliation.json` / its UI) | NEXA dry run (§5.5)             | `verify` (database)                                  |
| ----------------------------- | ----------------------------------------------------------- | ------------------------------- | ---------------------------------------------------- |
| customers                     | customers converted                                         | `customers` imported            | `customers_from_mirza`                               |
| opening balances (count, sum) | positive balances                                           | `wallet_openings`, wallet total | `opening_credits`                                    |
| debts (count, sum)            | negative balances                                           | `legacy_debts`, debt total      | `legacy_debts`                                       |
| invoices                      | invoice rows                                                | `invoice_archive`               | `invoice_archive`                                    |
| history per type              | record counts per file                                      | `history:<type>`                | `history:<type>`                                     |
| services                      | live service candidates                                     | `services`                      | `service_candidates`, `services`                     |
| money that must not move      | —                                                           | —                               | `wallet_entries_other`=0, `payments`=0, orders sum 0 |

Any difference is a finding to report, never to fix by hand in the database.

The standard backup: `backup-list` shows the run (state SUCCEEDED, verified). To keep a copy
outside the rehearsal volume:

```bash
docker compose -p nexa-mirza-rehearsal --env-file "$R/deploy.env" \
  -f deploy/compose.yml -f deploy/rehearsal/compose.mirza-rehearsal.yml \
  cp api:/var/lib/nexa/backups/<archive file from backup-list> ./
```

It is encrypted with the rehearsal's keyring (in `$R/nexa.env`); keep the two together and
private — it holds real customer data.

## 7. Stop, keep, retry

- `mirza-rehearsal.sh down --dir "$R"` stops and removes the containers and **keeps every volume**
  (the rehearsal database is evidence). `up` brings the same data back.
- Nothing here deletes a database or a volume. To repeat stage A from an empty database, use a
  NEW directory and a different `--subnet-octet` and `--https-port` (`init --dir ~/mirza-rehearsal-2
--subnet-octet 244 --https-port 18444`), or a new machine. Deleting an old rehearsal's
  volumes is the owner's decision, by hand.
- A failed import is not repaired in place: read the error code and the report, keep the
  directory, start a new rehearsal.

## 8. Stage B (only after the owner's separate approval)

Reading the real RickPanel's account list makes adoption counts real. It is reads only (the
token exchange and `GET`), but it is a connection to a production system, so it is the owner's
call, and it needs the rehearsal's network changed by hand (the panel's address must be
reachable from `api` and `migration`; today nothing is). Recommended when approved: a
dedicated RickPanel admin account, the panel's address allowed and nothing else, the
`provisioner` still absent, and `standin-check` replaced by the panel's own access log showing
GETs only. This is NOT prepared in the kit.

## 9. Owner decisions this rehearsal surfaces

1. Stage B (read-only real panel) — §8.
2. NEXA does not compare its service-candidate and invoice counts with the converter's
   `services.jsonl` / `invoices.jsonl`, nor read `reconciliation.json`; the operator compares
   them in §6. Automating that comparison is a change to decide.
3. The categories NEXA keeps as history only (payments, reseller data, tickets, discounts,
   referrals, configuration — `nxpkg-coverage.md` §3): whether any becomes live data later.

---

## راهنمای فارسی: آزمایش ایزوله با بکاپ واقعی

**این محیط چیست:** یک NEXA کاملاً جدا، با پروژهٔ Docker و دیتابیس تازهٔ خودش. هیچ‌کدام از فرایندهای NEXA در آن به اینترنت دسترسی ندارد، تلگرامی در کار نیست و به پنل واقعی وصل نمی‌شود. به‌جای پنل، یک RickPanel جایگزین فقط‌خواندنی کار می‌کند که هر تلاش برای نوشتن را رد و شمارش می‌کند. Production و Staging هیچ نقشی در آن ندارند و اسکریپت روی سروری که NEXA روی آن نصب است اجرا نمی‌شود.

۱. **ماشین:** یک سرور یا ماشین مجازی جدا، **نه** سرور Production یا Staging. حداقل ۴ هستهٔ پردازنده، ۸ گیگابایت حافظه، ۲۰ گیگابایت فضای خالی دیسک، Docker و Compose نسخهٔ ۲٫۲۴ یا بالاتر. فایل `.nxpkg` و فایل کلید را فقط دستی منتقل کنید (فلش یا scp مستقیم). هرگز از GitHub، CI یا پیام‌رسان استفاده نکنید.
۲. **راه‌اندازی:** دستورهای بخش ۳ را اجرا کنید: `init`، `build`، `up` و `owner`. اگر بررسی ایزوله‌بودن (preflight) خطا بدهد، ادامه ندهید.
۳. **ورود:** `https://localhost:18443` را روی همان ماشین باز کنید و گواهی محلی را یک‌بار بپذیرید.
۴. **پنل:** خروجی `standin-credentials` را بگیرید. در «پنل‌ها» یک پنل از نوع **RickPanel** با همان نشانی و نام کاربری و رمز بسازید. تست اتصال باید موفق شود؛ سپس پنل را فعال کنید.
۵. **مقدار تأیید هدف:** در صفحهٔ «مهاجرت از میرزا» مقدار `NEXA_LEGACY_IMPORT_TARGET_ACK` نمایش داده می‌شود. آن را با `set-target-ack` به فرایند migration بدهید.
۶. **بارگذاری و بررسی:** فایل `.nxpkg` را بارگذاری کنید و فایل کلید را بدهید. «بررسی بسته» باید موفق شود.
۷. **پنل‌ها و مشتریان:** کد پنل بسته را به RickPanel جایگزین وصل کنید. اگر فایل تصمیم‌های مالکیت مُهرشده دارید، آن را هم بارگذاری کنید.
۸. **اجرای آزمایشی (Dry Run):** همهٔ بخش‌ها را بخوانید و اعداد را یادداشت کنید. هیچ خطی با `table:UNCLASSIFIED` و هیچ هشدار `INVENTORY_INCOMPLETE` نباید وجود داشته باشد.
۹. **توقف فروش:** در «رخدادها و نگهداری» یک رخداد MAINTENANCE فعال با `stop_sales` روی همهٔ پنل‌ها بسازید.
۱۰. **تأیید انتقال نهایی:** در «تأیید انتقال نهایی» همان هفت مقدار اجرای آزمایشی را ثبت کنید.
۱۱. **تأیید نهایی:** عبارت `IMPORT MIRZA` را تایپ کنید. Import در پس‌زمینه انجام می‌شود و اگر فرایند قطع شود، خودش از همان‌جا ادامه می‌دهد.
۱۲. **پایان کار:** وضعیت باید **COMPLETED** باشد، تطبیق **RECONCILED**، گزارش v2 معتبر، و بکاپ استاندارد گرفته شده باشد.
۱۳. **کنترل مستقل:** `verify` (شمارش مستقیم از دیتابیس)، `standin-check` (تعداد تلاش برای نوشتن باید صفر باشد)، `backup-list` و دوباره `preflight` را اجرا کنید. اعداد را با گزارش مبدل در ویندوز و با Dry Run مقایسه کنید (جدول بخش ۶). هر اختلاف یک یافته است و هرگز نباید دستی در دیتابیس اصلاح شود.
۱۴. **توقف:** دستور `down` کانتینرها را متوقف می‌کند و **همهٔ داده‌ها را نگه می‌دارد**. هیچ دستوری در این ابزار دیتابیس یا Volume را حذف نمی‌کند. برای تکرار آزمایش، یک پوشهٔ جدید با `--subnet-octet` و `--https-port` دیگر بسازید.
۱۵. **مرحلهٔ B** (خواندن فهرست حساب‌های پنل واقعی، فقط‌خواندنی): فقط پس از تأیید جداگانهٔ مالک انجام می‌شود و در این ابزار آماده نشده است.
