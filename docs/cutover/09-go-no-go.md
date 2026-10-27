# 09 — Go / no-go checklist

Print this page. One list per decision point; tick each box only when the evidence named
beside it exists and is filed in [`11-records.md`](11-records.md). **One unticked box is a
NO-GO.** Only the owner decides. Giving a GO approves only the steps up to the next
decision point, and every `OWNER ONLY — separate explicit approval` step still needs its own
explicit approval for that run.

## GO-1 — schedule the window (T−1 d)

- [ ] P1–P10 all green ([`01-preconditions.md`](01-preconditions.md)) — evidence: the gate table
- [ ] Rehearsal `cutover-reconcile` exit 0, or exit 2 with every held class accepted by name — `rehearsal-reconcile.txt`
- [ ] `sudo botctl cutover rehearse` on the test server: exit 0 `GO`, or exit 2 `GO_WITH_HELD` with every held class (balances and services) accepted by name; `no-messages` PASS; `token-handover` SKIP — `rehearsal.txt` ([`12-rehearsal.md`](12-rehearsal.md))
- [ ] Import duration ≤ half the window — rehearsal record
- [ ] `sudo botctl cutover preflight --expect-version <vX.Y.Z> --expect-telegram none` is `PASS (8 checks)` — 0.4 output
- [ ] Mirza freeze, unfreeze and webhook re-registration commands written (P9, OQ-CUT-02) — `02-freeze.md` F2, `08-rollback.md` R0/R1
- [ ] Recovery Kit held off-host, passphrase separate — owner's statement and date
- [ ] Announcement text ready (manual, Mirza broadcast) — [`10-communications.md`](10-communications.md)
- [ ] Rollback owner and operator named — [`11-records.md`](11-records.md)
- [ ] OQ-CUT-01…05 answered or accepted — `docs/open-questions.md`

Signed: owner ______________ date/time (UTC) ______________ GO / NO-GO

## GO-2 — approve the import (after I5)

- [ ] Preflight PASS at I1 — I1 output
- [ ] `verify-pre.tsv` all zero (customers, wallet entries, payments, orders, bot instances)
- [ ] Dry run complete: no `UNCLASSIFIED`, no `INVENTORY_INCOMPLETE`, no `DRY_RUN_MISMATCH`
- [ ] Dry-run figures equal the converter's figures (E1); any difference explained in writing
- [ ] Rows held for review counted as held, none counted as matched
- [ ] The seven cutover values recorded
- [ ] Window time left ≥ measured import + 2 h

Signed: owner ______________ date/time (UTC) ______________ GO / NO-GO

## GO-3 — after the reconciliation

- [ ] Import `COMPLETED`, reconcile `RECONCILED`, v2 `verdict.holds`, exact-match `holds` with `unexplained 0` — I7
- [ ] `cutover-reconcile` exit 0, or exit 2 with every held class accepted by name — `reconcile.txt`
- [ ] Every `difference <KIND>: 0`
- [ ] Reseller checks C5 all zero (`RESELLER_CREDIT_LIMIT`, `RESELLER_TIER_CREDIT_LIMIT`, `RESELLER_PURCHASE_CAP`, `RESELLER_NOT_A_MIRZA_AGENT`, `AGENT_CREDIT_IN_WALLET`)
- [ ] Agent credit figure recorded as **NOT credited**
- [ ] `customer_notifications` = 0 — `verify-post.tsv`
- [ ] Three sources agree (tool, import exact-match, converter) — C4

Signed: owner ______________ date/time (UTC) ______________ GO / NO-GO

## GO-4 — hand the token over

- [ ] GO-3 given
- [ ] MAINTENANCE incident ACTIVE, `stop_sales` APPLIED on every panel and gateway, customer message empty — H1
- [ ] Preflight PASS with `--expect-telegram none` — H2
- [ ] The R1 procedure (flag off, then Mirza re-registration) in hand, with commands written — `08-rollback.md`
- [ ] OQ-CUT-01 accepted: updates queued during the freeze are dropped

Signed: owner ______________ date/time (UTC) ______________ GO / NO-GO

## GO-5 — open sales

- [ ] H4 and H5 passed (from the owner's own account)
- [ ] B3, B5 and B8 clean
- [ ] Provider writes 0
- [ ] No reminder burst
- [ ] Owner satisfied with the bot from their own account

Signed: owner ______________ date/time (UTC) ______________ GO / NO-GO

## راهنمای فارسی

این صفحه را چاپ کنید. برای هر نقطهٔ تصمیم یک فهرست هست؛ هر کادر فقط وقتی تیک می‌خورد که مدرکِ
نام‌برده موجود و در `11-records.md` بایگانی شده باشد. **یک کادر بدون تیک یعنی NO-GO.** فقط مالک
تصمیم می‌گیرد؛ «برو» تنها تا نقطهٔ تصمیم بعدی را تأیید می‌کند و هر مرحلهٔ «فقط مالک — با تأیید صریح
جداگانه» همچنان تأیید خودش را می‌خواهد. فهرست‌ها (آیتم‌ها دقیقاً همان بخش انگلیسی‌اند):

- **GO-1** زمان‌بندی پنجره؛ **GO-2** تأیید انتقال پس از I5؛ **GO-3** پس از تطبیق موجودی‌ها و بررسی
  اعتبار نمایندگی؛ **GO-4** واگذاری توکن؛ **GO-5** باز کردن فروش.
- هر ردیف نگه‌داشته‌شده برای بررسی «منطبق» حساب نمی‌شود و اعتبار نمایندگی میرزا هرگز پول کیف پول
  نیست.
