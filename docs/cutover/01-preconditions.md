# 01 — Preconditions

No step of the window starts until every gate below is green. Phase 0 runs from T−7 d to
T−1 d and ends with **GO-1**. Conventions: [`00-overview.md`](00-overview.md).

## Gates that must already be green

| #   | Gate                                                                                                                                                                                                                                                                                                                                                   | Evidence                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| P1  | The approved release `vX.Y.Z` is tagged by the owner and CI is green on its commit.                                                                                                                                                                                                                                                                    | CI run URL; `botctl version` on production                  |
| P2  | `docs/vps-acceptance.md` run on the **production** host and signed (including §7 backup, §7b DR pipeline, §7c Recovery Kit on a second server, §12b restore from the Web Admin, §12c).                                                                                                                                                                 | the signed checklist                                        |
| P3  | Rehearsal with the **latest real Mirza backup** on an isolated machine (`../legacy-migration/nxpkg-real-rehearsal.md` Stage A): COMPLETED, RECONCILED, v2 holds, `verify-import.sql` figures = dry run = converter, and `cutover-reconcile` on the rehearsal database → `RECONCILED` or `RECONCILED_WITH_HELD` with every held class accepted by name. | rehearsal record and the reconcile output (aggregates)      |
| P4  | Import duration measured in P3 (it sets the window length).                                                                                                                                                                                                                                                                                            | P3 record                                                   |
| P5  | The production RickPanel read is complete in a dry run (no `PROVIDER_INVENTORY_INCOMPLETE`, no `INVENTORY_INCOMPLETE`). Needs the owner's Stage B approval (`nxpkg-real-rehearsal.md` §8) or the production dry run itself.                                                                                                                            | dry-run report                                              |
| P6  | Every legacy table classified (no `table:UNCLASSIFIED:*`, no `TABLE_INVENTORY_INCOMPLETE`).                                                                                                                                                                                                                                                            | dry-run report                                              |
| P7  | No open P0/P1 for the migration in `docs/open-questions.md`; OQ-CUT-01…05 answered or accepted by the owner.                                                                                                                                                                                                                                           | the OQ entries                                              |
| P8  | Recovery Kit exported after the last key rotation, held off-host, passphrase separate (`docs/backup.md`).                                                                                                                                                                                                                                              | owner's statement and date                                  |
| P9  | Mirza's freeze, unfreeze and webhook re-registration commands written down by the owner (OQ-REH-02, **OQ-CUT-02**).                                                                                                                                                                                                                                    | filled `02-freeze.md` F2 and `08-rollback.md` R0/R1         |
| P10 | Production Nexa has the PRIMARY tenant (currency IRT), the owner (2FA on), the RickPanel(s) created in «پنل‌ها» with a passing connection test, the current tariff products, and **no customer, order, payment or ledger entry**.                                                                                                                      | Web Admin; `verify-import.sql` before the import (all zero) |

P9 is open: until the owner writes the commands, GO-1 cannot be given.

## 0.1 Install production Nexa (fresh)

**`OWNER ONLY — separate explicit approval`**

Precondition: P1; DNS of `<nexa-domain>` points at the host.

```bash
sudo bash install.sh --domain <nexa-domain> --acme-email <email> --version <vX.Y.Z> \
  --owner-username <owner> --owner-telegram-id <owner-numeric-id> --skip-telegram
sudo botctl roles disable provisioner monitor
sudo botctl roles status
```

Verification: `roles status` shows `provisioner disabled` and `monitor disabled`;
`botctl status` is ready; `botctl telegram status` prints `none`.

Rollback: none needed (an empty installation serves nobody). A failed install is rerun
(`docs/vps-acceptance.md` §2b).

Record: version, commit, digest.

## 0.2 vps-acceptance on production (P2)

**`OWNER ONLY — separate explicit approval`**

Run `docs/vps-acceptance.md` in full. Its update, rollback and reinstall sections run
**before** any data exists. Command: as that document says. Rollback: as that document
says. Record: the signed checklist.

## 0.3 Panels and tariffs

**`OWNER ONLY — separate explicit approval`** (the Web Admin writes configuration)

Precondition: 0.1.

In «پنل‌ها», create each RickPanel (credentials typed there, never taken from the package)
and run its connection test. Create the current tariff products.

Verification: the connection test passes; the panel is ACTIVE.

Rollback: archive the panel or product (configuration only, no customer data).

## 0.4 Preflight (dry)

**`read-only`**

```bash
sudo botctl cutover preflight --expect-version <vX.Y.Z> --expect-telegram none
```

Verification: `preflight: PASS (8 checks)`. On any FAIL: fix, rerun. Never proceed on FAIL.

Rollback: none needed.

## 0.5 Rehearsal reconciliation

On the **test server**, the whole rehearsal is one command: `sudo botctl cutover rehearse`
([`12-rehearsal.md`](12-rehearsal.md) R1) creates a disposable database, imports the package into
it, prints this reconciliation together with the service and reseller-credit checks, and drops it.
Its `rehearsal.txt` and exit code stand for `rehearsal-reconcile.txt` below. The isolated kit
remains the way to rehearse on a machine with no installation:

Run on the isolated rehearsal machine, **not** production. It reads the rehearsal database
(its name carries `rehearsal`; the kit's database is `nexa_mirza_rehearsal`).

**`read-only`**

```bash
export NXPKG_KEY="$(cat <path-to>.nxkey)"   # the key file TEXT, never on argv
docker compose -p nexa-mirza-rehearsal --env-file "$R/deploy.env" \
  -f deploy/compose.yml -f deploy/rehearsal/compose.mirza-rehearsal.yml \
  run --rm --no-deps -T -e NXPKG_KEY -v "<abs path>.nxpkg:/cutover/final.nxpkg:ro" \
  --entrypoint node api dist/cutover-reconcile.cli.js \
  --package /cutover/final.nxpkg --package-key-env NXPKG_KEY --database nexa_mirza_rehearsal \
  | tee rehearsal-reconcile.txt; echo "exit ${PIPESTATUS[0]}"
unset NXPKG_KEY
```

Verification: exit 0 `RECONCILED`, or exit 2 `RECONCILED_WITH_HELD` with each held class
accepted by name. A held row is never a match. Exit 3 means the rehearsal found a
difference: stop and fix the cause before GO-1.

Rollback: none needed (rehearsal database only).

Record: `rehearsal-reconcile.txt` (aggregates), the rehearsal's import duration.

## GO-1

The owner's go/no-go #1 is the first table in [`09-go-no-go.md`](09-go-no-go.md).

## راهنمای فارسی

هیچ مرحلهٔ پنجره پیش از سبز بودن همهٔ دروازه‌های P1 تا P10 شروع نمی‌شود. فاز ۰ از هفت روز تا
یک روز پیش از پنجره است و با **GO-1** پایان می‌یابد. دستورها در بخش انگلیسی‌اند.

- **۰.۱ نصب تازهٔ Nexa** (فقط مالک — با تأیید صریح جداگانه): با `--skip-telegram`؛ پس از آن
  هر دو نقش `provisioner` و `monitor` غیرفعال و `botctl telegram status` برابر `none` است.
- **۰.۲ پذیرش سرور** (فقط مالک): `docs/vps-acceptance.md` پیش از وجود هرگونه داده.
- **۰.۳ پنل‌ها و تعرفه‌ها** (فقط مالک): در «پنل‌ها» هر RickPanel با آزمایش اتصال موفق ساخته
  می‌شود و محصولات تعرفهٔ فعلی ساخته می‌شوند.
- **۰.۴ پیش‌پرواز** (فقط خواندنی): باید `preflight: PASS (8 checks)` ببینید؛ با هر FAIL ادامه
  ندهید.
- **۰.۵ تطبیق در تمرین** (فقط خواندنی، روی دستگاه تمرین نه تولید): خروجی ۰ یا ۲؛ هر دستهٔ
  نگه‌داشته‌شده باید با نام پذیرفته شود و هرگز «منطبق» حساب نمی‌شود.
- P9 باز است: تا زمانی که مالک دستورهای فریز، رفع فریز و ثبت دوبارهٔ وب‌هوک میرزا را ننوشته
  است (OQ-CUT-02)، GO-1 داده نمی‌شود.
