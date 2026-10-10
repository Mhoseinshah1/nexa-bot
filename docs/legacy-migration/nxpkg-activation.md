# Mirza → NEXA Fresh Migration: isolated rehearsal and future activation

Status: **built and tested on isolated databases only.** Production and the current staging are
untouched. Nothing here may run against them until the owner approves activation separately
(`production-gate.md`). Design: [`nxpkg-importer.md`](nxpkg-importer.md).

## 1. What the operator does (simple path)

1. Convert the Mirza backup with **Mirza2Nexa ≥ 0.6.0** on the operator's own Windows PC (contract
   1.4.0). Choose the main panel's target as **RickPanel** («پنل مقصد در NEXA»). Optionally run the
   bulk ownership review there and export the **sealed** `ownership-decisions.json`.
2. In the fresh NEXA, create the RickPanel through **Panels** (credentials are entered there, never
   taken from the package) and run its connection test.
3. Open **«مهاجرت از میرزا»**, upload the `.nxpkg`, give the key file (or passphrase), bind the
   package's panel code to the RickPanel, optionally upload the decisions file.
4. Read the dry run: customers, balances, debts, services, history, warnings and quarantine. If it is
   right, approve (typed confirmation). On a production-like target, also record the cutover
   approval of the seven values shown and stop sales.
5. The `migration` process imports, reconciles, writes the v2 report and takes a standard backup.

## 2. Isolated rehearsal (what was run for this PR)

```bash
pnpm install --frozen-lockfile && scripts/dev-services.sh      # local Postgres 16 + Redis 7
createdb -h 127.0.0.1 -U nexa nexa_rehearsal_mirza             # a NEW empty database
export DATABASE_URL=postgres://nexa:nexa@127.0.0.1:5432/nexa_rehearsal_mirza
pnpm db:migrate:dev && pnpm db:seed:dev
# synthetic package: mirza2nexa synth + convert (converter repo), or the fixtures in tests/fixtures/nxpkg
pnpm vitest run --project integration tests/integration/legacy-migration-nxpkg.test.ts \
  tests/integration/nxpkg-importer.test.ts tests/integration/legacy-history.test.ts
```

The database name contains `rehearsal`, so the importer's production guard classifies it as
non-production; synthetic packages are allowed there and refused on a production-like target.
Fake RickPanels on `127.0.0.1` answer only GET and the token exchange; tests assert provider
writes = 0.

## 3. Future activation (only after the owner's separate approval)

1. Deploy a release containing this code to a **new, empty** NEXA installation (never the current
   production or staging; never wipe a database to make it "fresh" — the importer refuses a
   non-empty tenant with `FRESH_TARGET_NOT_EMPTY` and deletes nothing).
2. Add a `migration` service to the deployment (command `node dist/main.migration.js`, health check
   on `LEGACY_MIGRATION_HEARTBEAT_PATH`, a persistent `LEGACY_MIGRATION_WORK_DIR`, a direct
   PostgreSQL connection — not a transaction pooler, the importer holds a session advisory lock).
   Not added to `deploy/` in this PR.
3. Set `LEGACY_MIGRATION_ENABLED=true` for the API and the `migration` role only for the migration
   window; set it back to `false` afterwards.
4. On the production-like target set `NEXA_LEGACY_IMPORT_TARGET_ACK` in the `migration` process's
   environment to the value the page shows (guard digest of host/port/database/tenant).
5. Upload, verify, dry run, review. Record the cutover approval (`/legacy-cutover`) for the seven
   values the dry run lists, stop sales, approve the import.
6. After COMPLETED: check the reconciliation (RECONCILED) and the v2 report invariants, keep the
   standard backup the migration took, then resume sales.

## 4. Recovery

- A crashed `migration` process: the lease expires (5 min) and the next claim resumes the same run
  (the importer's resume is idempotent; history ingest is idempotent by key).
- A failed import (`FAILED`, `COMPLETED_WITH_DISCREPANCY`): nothing is rolled back automatically.
  Restore the backup taken **before** the import (NEXA Backup & Restore), fix the cause, upload
  again. The importer never deletes data to retry.
- The key is erased on every terminal state; a new attempt needs it again.

## 5. Owner decisions still open

1. `freezeProofSha256` = package payload SHA-256 and `finalDumpSha256` = uploaded `.nxpkg` SHA-256
   for the cutover approval of a package import.
2. The CRITICAL web approval standing in for the CLI's `--allow-production-target` (the env target
   ack is still required).
3. Retention of the encrypted package and decisions files after the import.
4. The `migration` service in `deploy/`.
5. Existing-customer handling is moot in Fresh Migration (a non-empty target is refused); merging
   into a live NEXA stays unsupported.

---

## راهنمای فارسی (خلاصه)

۱. بکاپ میرزا را با Mirza2Nexa نسخه ۰٫۶٫۰ یا بالاتر تبدیل کنید و پنل مقصد را **RickPanel** بگذارید.
۲. در NEXA تازه، پنل RickPanel را از بخش «پنل‌ها» با اطلاعات ورود خودش بسازید و تست اتصال بگیرید.
۳. در «مهاجرت از میرزا» فایل `.nxpkg` را بارگذاری کنید، کلید را وارد کنید، کد پنل را به RickPanel متصل کنید.
۴. نتیجه اجرای آزمایشی (Dry Run) را بررسی و تأیید نهایی کنید؛ Import در پس‌زمینه انجام و پس از آن بکاپ استاندارد گرفته می‌شود.
۵. Importer فقط روی دیتابیس خالی اجرا می‌شود؛ اگر داده‌ای وجود داشته باشد متوقف می‌شود و هیچ چیزی را پاک نمی‌کند.
۶. فعال‌سازی روی سرور واقعی فقط پس از تأیید جداگانه مالک و طبق بخش ۳ همین سند.
