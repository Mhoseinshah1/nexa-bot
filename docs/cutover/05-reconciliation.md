# 05 — Balance reconciliation and the reseller credit check

Phase 4. Zero tolerance: before a single customer can buy, every Mirza balance must be
exactly the customer's Nexa wallet, and no Mirza agent credit may have become wallet money.
Ends with GO-3. Precondition for the phase: I7 passed.

## Session setup

**`read-only`**

```bash
set -o nounset
export DC="docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml"
mkdir -p ~/cutover && chmod 700 ~/cutover && cd ~/cutover
date -u +%FT%TZ | tee t0-start.txt
```

## What it compares

`cutover-reconcile` compares Mirza's `user.Balance`, read from the package's own snapshot,
with Nexa's wallet: the sum of **every** ledger entry (CREDIT − DEBIT) per customer, in IRT.
**Tolerance zero** — a one-Toman difference is a difference.

It also reports: counts (Mirza rows vs Nexa customers); money totals (readable signed sum,
positive, negative); negative wallets (must equal Mirza's negative rows; they stay negative
and block purchases until a top-up); non-opening ledger entries (must be 0 right after the
import); legacy-debt side rows (must be 0); resellers (no credit of any kind); and agent
credit, listed separately.

Second source: the import's own exact-match and v2 report (I7). Third: the converter's
reconciliation (E1).

**Rows held for review never count as matched.** `INVALID_IDENTITY`, `DUPLICATE_SOURCE_ID`,
`BALANCE_UNREADABLE` and `HELD_BY_IMPORT` (by `status:reason_code`) are counted with their
money but are never a match. A run with held rows and no difference ends
`RECONCILED_WITH_HELD` (exit 2), and the owner signs each held class off by name.

Verdicts and exit codes: `RECONCILED` 0 · `RECONCILED_WITH_HELD` 2 · `DIFFERENCES` 3 ·
usage 64 · refused target or no tenant 65 · anything else 1.

Difference kinds: `MISSING_IN_NEXA`, `BALANCE_DIFFERS`, `AGENT_CREDIT_IN_WALLET`
(wallet = Mirza balance + agent cap), `OTHER_CURRENCY`, `NOT_IN_MIRZA`,
`IMPORTED_WHILE_HELD`, `RESELLER_CREDIT_LIMIT`, `RESELLER_TIER_CREDIT_LIMIT`,
`RESELLER_PURCHASE_CAP`, `RESELLER_NOT_A_MIRZA_AGENT`, `LEGACY_DEBT_ROWS`.

**The reseller credit rule.** Mirza agent credit (`maxbuyagent`) never becomes wallet money.
The tool prints it as `agent credit LISTED, NOT CREDITED: n rows, S IRT` and adds it to
nothing.

**Never the live database.** The tool refuses `nexa` (exit 65), so it reads a **restored
copy** of the post-import backup, `nexa_cutover_scratch`. `nexa` itself is never dropped,
never restored over and never edited.

## C1 — Find the post-import backup

**`read-only`**

Precondition: I7.

```bash
sudo $DC run --rm --no-deps -T --entrypoint node api dist/backup.cli.js list --limit 10 | tee backups-post.txt
```

Verification: the import's post-import run is `SUCCEEDED verified`.

Rollback: none needed.

## C2 — Restore the post-import backup into a NEW database

**`OWNER ONLY — separate explicit approval`** (creates a new database on the production
server; not the live one)

Precondition: C1; the `disk` preflight check PASS (room for a second copy).

```bash
sudo $DC exec -T postgres createdb -U nexa nexa_cutover_scratch
sudo $DC exec -T api ls -l /var/lib/nexa/backups/<post-import run id>/
sudo $DC exec -T api node dist/backup.cli.js restore --archive /var/lib/nexa/backups/<run id>/<file> [--archive <next part> …] --target nexa_cutover_scratch
```

The archive lives in the api container's volume, so the restore runs inside it. For a 7-Zip
archive add `--password-stdin` and feed the password the way `botctl restore` does, never on
argv:

```bash
IFS= read -rs pw </dev/tty; printf '%s' "$pw" | sudo $DC exec -T api node dist/backup.cli.js restore … --password-stdin; unset pw
```

Alternative: download the archive from the Web Admin history to `~/cutover` and run

```bash
sudo botctl restore --target nexa_cutover_scratch <parts…>
```

The CLI refuses the live database itself.

Verification:

```bash
sudo $DC exec -T postgres psql -U nexa -d nexa_cutover_scratch -X -At -c 'select count(*) from customers'
```

The count equals `verify-post` customers.

Rollback: none needed — the live database is untouched. Keep the copy until sign-off.

## C3 — Run the reconciliation on the copy

**`read-only`** (reads the scratch copy only; the tool refuses `nexa`)

Precondition: C2.

```bash
export NXPKG_KEY="$(cat ~/cutover/<key>.nxkey)"
sudo --preserve-env=NXPKG_KEY $DC run --rm --no-deps -T -e NXPKG_KEY -v "$HOME/cutover/nexa-restore-mirza-<date>.nxpkg:/cutover/final.nxpkg:ro" --entrypoint node api dist/cutover-reconcile.cli.js --package /cutover/final.nxpkg --package-key-env NXPKG_KEY --database nexa_cutover_scratch | tee reconcile.txt; echo "exit ${PIPESTATUS[0]}"
```

Then the same command with `--json > reconcile.json` in place of `| tee reconcile.txt; echo
"exit ${PIPESTATUS[0]}"`:

```bash
sudo --preserve-env=NXPKG_KEY $DC run --rm --no-deps -T -e NXPKG_KEY -v "$HOME/cutover/nexa-restore-mirza-<date>.nxpkg:/cutover/final.nxpkg:ro" --entrypoint node api dist/cutover-reconcile.cli.js --package /cutover/final.nxpkg --package-key-env NXPKG_KEY --database nexa_cutover_scratch --json > reconcile.json
unset NXPKG_KEY
```

Verification:

- exit 0 `RECONCILED`, or exit 2 `RECONCILED_WITH_HELD` with each held class (`held …`
  lines, `held by import <status:reason>`) explained by the dry run's manual-review counts;
- every `difference <KIND>: 0`;
- `matched` sum = Mirza readable sum − held sums; `nexa wallets` sum = Mirza readable sum
  − held sums;
- `non-opening ledger entries 0`; `legacy debt rows 0`;
- negative wallets = Mirza negative rows (minus held).

Rollback: exit 3 is NO-GO. Run with `--list-differences` **on the terminal** to find which
rows (never paste it; it shows Nexa customer ids, Mirza row numbers and amounts, never a
Telegram id), then R0, restoring the protective backup
(**`OWNER ONLY — separate explicit approval`**). Never repair rows.

Record: verdict, exit code, `reconcile.txt` and `reconcile.json` (aggregates only).

## C4 — Cross-check the three sources

**`read-only`**

Precondition: C3.

Compare `reconcile.txt` with the I7 exact-match (`user` → `customers`,
`user.Balance` → `wallet_entries`) and with E1's converter `reconciliation.json`.

Verification: the three agree. Any disagreement is NO-GO until explained in writing.

Rollback: none needed.

## C5 — Reseller credit check

**`read-only`**

Precondition: C3.

In `reconcile.txt` confirm:

- `difference RESELLER_CREDIT_LIMIT: 0`
- `difference RESELLER_TIER_CREDIT_LIMIT: 0`
- `difference RESELLER_PURCHASE_CAP: 0`
- `difference RESELLER_NOT_A_MIRZA_AGENT: 0`
- `difference AGENT_CREDIT_IN_WALLET: 0`
- `mirza agents` equals the `matched` agents.

Copy `agent credit LISTED, NOT CREDITED: n rows, S IRT` into the sign-off **as a figure that
was NOT credited**. Then in the Web Admin (resellers page, read only): each Mirza reseller
shows no credit limit; its tier's limit is zero; `source_detail.purchaseCap.applied` is
`false`.

Verification: all zero; the figure recorded.

Rollback: any non-zero is NO-GO → R0.

## C6 — Sign-off (GO-3)

**`OWNER ONLY — separate explicit approval`**

Precondition: C3–C5.

The owner signs [`11-records.md`](11-records.md) § Reconciliation: verdict, Mirza rows,
matched rows and sum, held rows and sum **per class** (each accepted by name), negative
wallets, agent credit listed-not-credited, date (UTC), name. This is **GO-3**.

Keep `nexa_cutover_scratch` until the final report is accepted. Then, and only then:

**`OWNER ONLY — separate explicit approval`**

```bash
sudo $DC exec -T postgres dropdb -U nexa nexa_cutover_scratch
```

This drops the copy only. **`nexa` itself is never dropped** — not here, not in any
rollback.

Verification: signed.

## Rollback of the phase

Nothing in the live database changed in this phase. A NO-GO restores the protective backup
and goes to R0 ([`08-rollback.md`](08-rollback.md)).

## راهنمای فارسی

فاز ۴: موجودی هر مشتری در میرزا (`user.Balance` از خودِ بسته) باید **دقیقاً** برابر مجموع تمام
ردیف‌های دفتر کل او در Nexa باشد (تلورانس صفر)، و اعتبار نمایندگی میرزا (`maxbuyagent`) هرگز
پول کیف پول نشود. ابزار `cutover-reconcile` دیتابیس اصلی `nexa` را نمی‌پذیرد؛ بنابراین روی
**نسخهٔ بازیابی‌شدهٔ** بکاپ پس از انتقال (`nexa_cutover_scratch`) اجرا می‌شود. `nexa` هرگز حذف
نمی‌شود.

- **C1** (فقط خواندنی): بکاپ پس از انتقال را پیدا کنید (`SUCCEEDED verified`).
- **C2** (فقط مالک — با تأیید صریح جداگانه): ساخت دیتابیس جدید و بازیابی بکاپ در آن؛ گذرواژه
  هرگز روی خط فرمان نمی‌آید.
- **C3** (فقط خواندنی): خروجی ۰ یعنی `RECONCILED`؛ ۲ یعنی `RECONCILED_WITH_HELD` و مالک هر دسته را با
  نام می‌پذیرد؛ ردیف نگه‌داشته‌شده هرگز «منطبق» نیست؛ ۳ یعنی اختلاف: NO-GO و R0 (بدون «تعمیر»
  ردیف). `--list-differences` فقط روی ترمینال و هرگز چسباندنی نیست.
- **C4** (فقط خواندنی): سه منبع (ابزار، تطبیق دقیق ایمپورت، گزارش مبدل) باید یکی باشند.
- **C5** (فقط خواندنی): همهٔ تفاوت‌های `RESELLER_*` و `AGENT_CREDIT_IN_WALLET` صفر؛ رقم «اعتبار
  فهرست‌شده، نه واریزشده» ثبت شود؛ در صفحهٔ نمایندگان هیچ سقف اعتباری دیده نشود.
- **C6** (فقط مالک): امضای تطبیق در `11-records.md` = **GO-3**. نسخهٔ `nexa_cutover_scratch` تا
  پذیرش گزارش نهایی نگه داشته می‌شود و فقط آن موقع (فقط مالک) حذف می‌شود.
