# 11 — Cutover record

Fill this in as you go; file it with the signed [`09-go-no-go.md`](09-go-no-go.md) pages.
Aggregates only: never a Telegram id, username, token, key, phone, subscription link or one
person's amount. Every time is UTC.

## People

| Role                      | Name | Contact channel |
| ------------------------- | ---- | --------------- |
| Owner                     |      |                 |
| Operator                  |      |                 |
| Rollback owner / operator |      |                 |

## Release and host (0.1)

| Item                             | Value |
| -------------------------------- | ----- |
| Version `vX.Y.Z`                 |       |
| Commit                           |       |
| Image digest                     |       |
| Rehearsal import duration (GO-1) |       |
| Window start (T0)                |       |

## Rehearsal on the test server (12, R1)

| Item                                                                  | Value |
| --------------------------------------------------------------------- | ----- |
| Date (UTC), release on the test server                                |       |
| Package SHA-256 (the `package` line)                                  |       |
| Exit code and `go/no-go` line                                         |       |
| Duration (`rehearsal-start.txt` to the end)                           |       |
| Balances: verdict, matched rows and sum, held per class               |       |
| Services: verdict, matched, held per outcome                          |       |
| Agent credit LISTED, NOT CREDITED (rows, IRT) — a figure NOT credited |       |
| `no-messages` line (every count 0)                                    |       |
| `cleanup` line (dropped, or kept and dropped by hand on …)            |       |
| Held classes accepted by name (owner)                                 |       |

## Freeze and export (F4, E1, E2)

| Item                                                             | Value |
| ---------------------------------------------------------------- | ----- |
| Freeze time                                                      |       |
| Mirza backup file name, size                                     |       |
| Mirza backup SHA-256                                             |       |
| `.nxpkg` file name                                               |       |
| `.nxpkg` SHA-256 on the PC / on the host (`finalDumpSha256`, D5) |       |
| Converter figures: customers                                     |       |
| Converter figures: positive balances (count / sum)               |       |
| Converter figures: negative balances (count / sum)               |       |
| Converter figures: invoices, live services                       |       |
| Key delivered by (channel), separately from the package          |       |

## Import (I1–I8)

| Item                                                                  | Value |
| --------------------------------------------------------------------- | ----- |
| Import id                                                             |       |
| `preImportBackupRunId`                                                |       |
| Post-import backup run id                                             |       |
| The seven cutover values                                              |       |
| Dry-run figures (customers, openings, debts, services, held by class) |       |
| Start / end time of apply                                             |       |
| `verify-pre.tsv`, `verify-post.tsv` filed                             |       |
| Status / reconcile / v2 `verdict.holds`                               |       |

## Reconciliation (C6) — signed

| Item                                                       | Value |
| ---------------------------------------------------------- | ----- |
| Verdict and exit code                                      |       |
| Mirza rows                                                 |       |
| Matched rows / sum                                         |       |
| Held rows / sum **per class**, each accepted by name       |       |
| `INVALID_IDENTITY`                                         |       |
| `DUPLICATE_SOURCE_ID`                                      |       |
| `BALANCE_UNREADABLE`                                       |       |
| `HELD_BY_IMPORT` (`status:reason_code`)                    |       |
| Negative wallets (count / sum)                             |       |
| Agent credit **LISTED, NOT CREDITED**: rows / IRT          |       |
| Reseller checks (C5) all zero                              |       |
| `reconcile.txt`, `reconcile.json` filed                    |       |
| `nexa_cutover_scratch` dropped on (after the final report) |       |

Signed: owner ______________ date/time (UTC) ______________

## Handover and background roles (H, B)

| Item                                                  | Value |
| ----------------------------------------------------- | ----- |
| Incident id / time (H1)                               |       |
| H3 time (the `since` of R1)                           |       |
| `telegram-after.txt` filed (H4)                       |       |
| Bot instance id (H6)                                  |       |
| b1 time; `b1.tsv`, `b3.tsv`, `b5.tsv`, `b8.tsv` filed |       |
| B2 / B4 / B7 / B9 times                               |       |
| B7 customers linked                                   |       |

## Go / no-go

| Decision | GO / NO-GO | Owner | Time (UTC) |
| -------- | ---------- | ----- | ---------- |
| GO-1     |            |       |            |
| GO-2     |            |       |            |
| GO-3     |            |       |            |
| GO-4     |            |       |            |
| GO-5     |            |       |            |

## Communications (10)

| Item                                      | Value |
| ----------------------------------------- | ----- |
| Announcement text, T−24 h / T−1 h sent at |       |
| "Nexa is live" posted at                  |       |
| "Sales open" posted at                    |       |

## Rollback, if any (08)

| Item                      | Value |
| ------------------------- | ----- |
| Stage (R0–R3) and trigger |       |
| Time                      |       |
| Loss list filed (R1–R3)   |       |

## Open questions

Settled or accepted before the dates shown. Text: `docs/open-questions.md` § OQ-CUT.

| Question                                                                         | Answer / who / date |
| -------------------------------------------------------------------------------- | ------------------- |
| OQ-CUT-01 queued updates dropped at the first registration (before GO-4)         |                     |
| OQ-CUT-02 Mirza freeze, unfreeze, webhook re-registration commands (before GO-1) |                     |
| OQ-CUT-03 Telegram's queue retention (matters only if OQ-CUT-01 changes)         |                     |
| OQ-CUT-04 does a first `/start` link an imported customer (B6/B7 until known)    |                     |
| OQ-CUT-05 the two package bindings of the approval (D5)                          |                     |
| OQ-CUT-06 reconciliation never reads the live database; held rows                |                     |

## راهنمای فارسی

این جدول‌ها را همزمان با پیشرفت پر کنید و همراه صفحه‌های امضاشدهٔ `09-go-no-go.md` بایگانی کنید.
فقط ارقام تجمیعی؛ هرگز شناسهٔ تلگرام، نام کاربری، توکن، کلید، تلفن، لینک اشتراک یا مبلغ یک
فرد. زمان‌ها همه UTC. بخش‌ها: افراد؛ نسخه و میزبان؛ فریز و خروجی؛ انتقال؛ تطبیق (امضاشده توسط
مالک: حکم، ردیف‌های میرزا، منطبق، نگه‌داشته‌شده به تفکیک دسته با پذیرش نام‌به‌نام، کیف پول‌های منفی،
اعتبار نمایندگی **فهرست‌شده، نه واریزشده**)؛ واگذاری و نقش‌ها؛ تصمیم‌ها؛ اطلاع‌رسانی؛ بازگشت؛
پرسش‌های باز OQ-CUT-01 تا OQ-CUT-06.
