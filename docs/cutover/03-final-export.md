# 03 — Final `.nxpkg` export

Phase 2. Runs on the Windows PC, offline; MirzaBot is still frozen. Precondition for the
phase: phase 1 done (the F3 backup exists, its checksum recorded). Conventions:
[`00-overview.md`](00-overview.md).

## E1 — Convert the backup with Mirza2Nexa

**`OWNER ONLY — separate explicit approval`** (Windows PC, offline)

Precondition: F3.

Use Mirza2Nexa ≥ 0.6.0 (content contract ≥ 1.4.0). Convert the F3 backup:

- main panel target **RickPanel** («پنل مقصد در NEXA»);
- optional bulk ownership review → a sealed `ownership-decisions.json`;
- output: `nexa-restore-mirza-<date>.nxpkg` plus its key (`.nxkey`) or passphrase.

Command: the converter's own screens (no command line is specified by this runbook; see
`../legacy-migration/nxpkg-activation.md`).

Verification: the converter reports readiness `ready` with no blockers. Copy the figures of
its `reports/reconciliation.json` (customers, positive balances count and sum, negative
balances count and sum, invoices, live services) into [`11-records.md`](11-records.md).

Rollback: none needed (offline; Mirza is still frozen).

## E2 — Checksum across the transfer

**`read-only`**

Precondition: E1.

```bash
sha256sum nexa-restore-mirza-<date>.nxpkg
```

Run it on the PC and again on the Nexa host after the transfer (directory `~/cutover`, mode
0700). Verification: the two values are equal.

Record: the SHA-256 (this is `finalDumpSha256` under D5 / OQ-CUT-05).

## E3 — The key travels separately

The key or passphrase never travels over the same channel as the package and never in a
chat. Verification: the owner confirms the channel. Rollback: none needed.

## Verification of the phase

The package exists on the Nexa host, its SHA-256 equals the PC's, the key arrived by a
different channel, and the converter's figures are in the record.

## Rollback

None needed: nothing in production changed. To abandon, go to R0
([`08-rollback.md`](08-rollback.md)).

## راهنمای فارسی

فاز ۲ روی رایانهٔ ویندوز و بدون اینترنت اجرا می‌شود و میرزا هنوز فریز است.

- **E1** (فقط مالک — با تأیید صریح جداگانه): تبدیل بکاپ F3 با Mirza2Nexa نسخهٔ ۰٫۶٫۰ یا بالاتر
  (قرارداد محتوا ۱٫۴٫۰ یا بالاتر)، مقصد پنل اصلی RickPanel («پنل مقصد در NEXA»)؛ خروجی
  `nexa-restore-mirza-<date>.nxpkg` و کلید `.nxkey` یا گذرواژه. آمادگی باید `ready` و بدون مانع
  باشد؛ ارقام `reports/reconciliation.json` در `11-records.md` ثبت می‌شود.
- **E2** (فقط خواندنی): `sha256sum` روی رایانه و دوباره روی سرور Nexa؛ باید برابر باشند.
- **E3**: کلید یا گذرواژه هرگز از همان کانال بستهٔ نهایی و هرگز در چت فرستاده نمی‌شود.
- بازگشت: چیزی در تولید تغییر نکرده است؛ برای انصراف R0.
