# 02 — Freeze MirzaBot

**What "freeze" means.** MirzaBot answers no update, none of its crons run (they write to
RickPanel), and its MySQL accepts no write. Telegram gets a non-2xx from the endpoint and
**queues** updates; MirzaBot's webhook registration is **not** deleted, because a rollback
(R1) needs it. Nexa sends nothing during the freeze.

Phase 1 of the window. Precondition for the whole phase: GO-1 given and the window started.
Conventions: [`00-overview.md`](00-overview.md).

## F1 — Preflight

**`read-only`**

Precondition: GO-1 given.

```bash
sudo botctl cutover preflight --expect-version <vX.Y.Z> --expect-telegram none | tee preflight-t0.txt
```

Verification: `PASS (8 checks)`.

Rollback: none needed.

Record: `preflight-t0.txt`.

## F2 — Stop MirzaBot (legacy host)

**`OWNER ONLY — separate explicit approval`**

Precondition: F1 PASS.

Do three things:

1. Stop the PHP bot so it answers no update: **disable its webhook endpoint** (web server
   vhost or route) so Telegram gets a non-2xx and queues updates. Do **not** `deleteWebhook`.
2. Stop every Mirza cron (expiry, notifications, panel sync).
3. MySQL `SET GLOBAL read_only = ON` (and `super_read_only` where supported).

Exact commands: **TBD — see OQ-CUT-02** (and OQ-REH-02). The owner writes them here before
GO-1 (P9):

```text
(1) endpoint:  TBD — see OQ-CUT-02
(2) crons:     TBD — see OQ-CUT-02
(3) MySQL:     TBD — see OQ-CUT-02
```

Verification: a button tap in Mirza gets no answer; a test write as an ordinary MySQL
account fails read-only; the scheduler shows Mirza's jobs off; the RickPanel account count
(read in the panel UI) is stable over 10 minutes.

Rollback: **R0** — start the endpoint and crons, `read_only = OFF`. Nothing changed anywhere
else. Commands: TBD — see OQ-CUT-02.

Record: freeze time (UTC).

## F3 — Final Mirza backup (legacy host)

**`OWNER ONLY — separate explicit approval`**

Precondition: F2 verified.

Take the final Mirza backup with the tool Mirza2Nexa expects. Which tool is **UNKNOWN**:
TBD — see OQ-CUT-02 (and OQ-LCO-04 in `docs/open-questions.md`). Then:

```bash
sha256sum <file> | tee mirza-final.sha256
```

Verification: the file is non-empty; the checksum is recorded; the file is copied to the
Windows PC over the owner's private channel and the checksum re-verified there.

Rollback: R0.

## F4 — Record

**`read-only`**

Precondition: F3. Write the freeze time, backup file name, size and SHA-256 into
[`11-records.md`](11-records.md).

## F5 — Communications

None from Nexa. The owner's own announcement happened at T−24 h and T−1 h
([`10-communications.md`](10-communications.md)).

## Verification of the phase

F2's four observations hold and F3's checksum matches on both machines. If any fails, do not
continue: roll back with R0 ([`08-rollback.md`](08-rollback.md)).

## راهنمای فارسی

فریز یعنی: ربات میرزا به هیچ به‌روزرسانی پاسخ نمی‌دهد، هیچ کرونی از میرزا اجرا نمی‌شود (چون روی
RickPanel می‌نویسند) و MySQL آن فقط‌خواندنی است. نشانی وب‌هوک میرزا **حذف نمی‌شود** تا بازگشت
(R1) ممکن بماند؛ تلگرام به‌روزرسانی‌ها را صف می‌کند.

- **F1** (فقط خواندنی): پیش‌پرواز؛ باید PASS باشد.
- **F2** (فقط مالک — با تأیید صریح جداگانه، سرور قدیمی): توقف نقطهٔ پایانی ربات بدون
  `deleteWebhook`، توقف همهٔ کرون‌ها، فقط‌خواندنی کردن MySQL. دستورها: TBD — see OQ-CUT-02؛ مالک
  پیش از GO-1 می‌نویسد. بازگشت: R0.
- **F3** (فقط مالک): بکاپ نهایی میرزا و `sha256sum`؛ ابزار بکاپ: TBD — see OQ-CUT-02 /
  OQ-LCO-04. فایل از کانال خصوصی مالک به رایانهٔ ویندوز می‌رود و جمع‌کنترلی دوباره بررسی می‌شود.
- **F4** (فقط خواندنی): زمان فریز، نام فایل، اندازه و SHA-256 در `11-records.md` ثبت می‌شود.
- **F5**: هیچ پیامی از Nexa؛ اطلاعیهٔ مالک ۲۴ ساعت و ۱ ساعت پیش داده شده است.
