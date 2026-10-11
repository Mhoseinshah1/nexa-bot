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
5. Upload, verify, dry run, review, approve the import (typed confirmation). The dry run
   records nothing: the read sets the cutover approval binds are recorded when the approved
   import starts, and the import then waits (`CUTOVER_APPROVAL_MISSING`). Record the cutover
   approval (`/legacy-cutover`) for exactly the seven values the dry run listed, stop sales; the
   import continues by itself.
6. After COMPLETED: check the reconciliation (RECONCILED) and the v2 report invariants, keep the
   standard backup the migration took, then resume sales.

## 4. Recovery

- **A crashed `migration` process**: the lease expires (5 min) and the next claim resumes the same
  run (the importer's resume is idempotent; history ingest is idempotent by key). Every step is
  bounded: VERIFY and the DRY RUN are failed after 5 starts (`VERIFY_FAILED` / `DRY_RUN_FAILED`,
  `IMPORT_FAILED`), an apply after 5 (`FAILED`, `IMPORT_FAILED`) — a crash loop is a verdict to
  read, not a process that retries for ever.
- **Another importer process holds the tenant** (`RUN_CONFLICT` from the importer's process lock,
  or another legacy run RUNNING): NOT a failure. The step is released, the attempt is not counted,
  and it runs again on a later tick; the log says `another importer process holds the tenant`.
  The operator's action:
  1. find what holds it — a `legacy-import` CLI run on the server, or a second `migration`
     replica: `docker compose ps` / `ps aux | grep legacy-import`;
  2. let a CLI run finish, or stop it (its claim ends with its database connection);
  3. a run left RUNNING by a dead process of ANOTHER source or mode is aborted from the terminal:
     `legacy-import <mode> --tenant <tenant> --abort-running …` (`importer.md` §6); the migration
     then continues by itself. Never abort the import's own RUNNING apply run — the next tick
     resumes it.
- **A lost lease** (a replica stalled past 5 minutes and another took the import over): the
  first process's step is aborted through its signal and it writes nothing more; the importer's
  own process lock refuses it as a second writer meanwhile. Nothing to do.
- **A failed import** (`FAILED`, `COMPLETED_WITH_DISCREPANCY`): nothing is rolled back
  automatically. Read `errorCode`, the refusal counts and the apply report (`failedSections`,
  `failedInvariants`). Restore the backup taken **before** the import (NEXA Backup & Restore),
  fix the cause, upload again. The importer never deletes data to retry. COMPLETED is reached only
  when the importer said `COMPLETED`, the reconcile is RECONCILED and the v2 report holds.
- **The key** is erased on every terminal state, and BEFORE the post-import backup is requested
  (the backup never holds it). A key left idle in VERIFIED or DRY_RUN_DONE longer than
  `LEGACY_MIGRATION_KEY_IDLE_MS` (one day) is erased too; the page asks for it again (the same
  key file or passphrase) and the dry run or approval continues.
- **Files**: decrypted step directories are removed after every step, at the role's start and on
  every tick (for every finished import, and for a directory no import names). A finished
  import's encrypted package and decisions file are deleted unless
  `LEGACY_MIGRATION_RETAIN_PACKAGE=true`.

### Configuration keys of the `migration` role

| Key                                                           | Default                                  | Meaning                                                                 |
| ------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| `LEGACY_MIGRATION_ENABLED`                                    | `false`                                  | the feature, for the API and the role                                   |
| `LEGACY_MIGRATION_WORK_DIR`                                   | `/var/lib/nexa/legacy-migration`         | packages and private step directories                                   |
| `LEGACY_MIGRATION_RETAIN_PACKAGE`                             | `false`                                  | keep a finished import's encrypted package and decisions file           |
| `LEGACY_MIGRATION_KEY_IDLE_MS`                                | `86400000`                               | erase a key idle this long in VERIFIED / DRY_RUN_DONE (1 min … 30 days) |
| `LEGACY_MIGRATION_TICK_MS`, `LEGACY_MIGRATION_HEARTBEAT_PATH` | `15000`, `/tmp/nexa-migration.heartbeat` | the loop                                                                |

## 5. Owner decisions still open

1. `freezeProofSha256` = package payload SHA-256 and `finalDumpSha256` = uploaded `.nxpkg` SHA-256
   for the cutover approval of a package import.
2. The CRITICAL web approval standing in for the CLI's `--allow-production-target` (the env target
   ack is still required).
3. Retention of the encrypted package and decisions files after the import — built as
   `LEGACY_MIGRATION_RETAIN_PACKAGE` (default `false`: deleted at the terminal state); the owner
   decides whether a migration window turns it on.
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
