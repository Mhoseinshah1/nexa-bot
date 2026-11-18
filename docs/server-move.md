# انتقال سرور / Server move

ADR-0039 § 8 (D6). The whole installation — the owner's bot and every hosted bot — moves to a new
server (another data centre) with one bundle file and one password. English follows the Persian.

---

## فارسی

### پیش از شروع

- یک سرور جدید آماده کنید (همان مشخصات یا بیشتر). هنوز DNS را عوض نکنید.
- همهٔ کارها را داخل `tmux` اجرا کنید؛ قطع شدن SSH کار را نیمه‌کاره نمی‌کند.
- تلگرام پیام‌های یک وب‌هوک ناموفق را تا **۲۴ ساعت** نگه می‌دارد: از لحظهٔ «انجماد» تا ثبت دوبارهٔ
  وب‌هوک روی سرور جدید، کمتر از ۲۴ ساعت وقت بگذارید.

### ۱. روی سرور قدیمی: انجماد و خروجی

```bash
tmux new -s nexa-move 'sudo botctl move export --out /root/nexa-move.7z'
```

- **انجماد:** پیش از هر کار، همهٔ نقش‌های برنامه (api، worker، monitor، provisioner، assistant،
  recovery) خاموش می‌شوند. از این لحظه سرور قدیمی **سفارش نمی‌گیرد** و چیزی در پایگاه داده نوشته
  نمی‌شود. PostgreSQL، Redis، `backup-verify` و لبه (Caddy) روشن می‌مانند.
- رمز بسته دو بار، بی‌نمایش، پرسیده می‌شود (دست‌کم ۱۲ نویسه). این رمز هرگز در خط فرمان، متغیر محیطی
  یا لاگ نمی‌آید. **آن را جایی امن نگه دارید**: بدون آن بسته باز نمی‌شود.
- یک بکاپ تازهٔ نصب و یک آرشیو تازه از هر ربات میزبانی‌شده (به‌جز PURGED) گرفته می‌شود، یکی‌یکی از
  صف کارهای سنگین. هر کدام پیش از ورود به بسته در پایگاه دادهٔ موقت بازیابی و تأیید می‌شود
  (ADR-0025). اگر حتی یکی تأیید نشود، هیچ بسته‌ای نوشته نمی‌شود.
- در پایان اندازه و SHA-256 بسته و گام‌های بعد چاپ می‌شود. **سرور قدیمی منجمد می‌ماند**؛
  `botctl restart`، `update` و `rollback` تا وقتی منجمد است اجرا نمی‌شوند.

### ۲. انتقال فایل

```bash
scp /root/nexa-move.7z root@NEW-SERVER:/root/
```

### ۳. روی سرور جدید: نصب و ورود

1. `install.sh` **همان نسخه یا جدیدتر** را اجرا کنید (دامنهٔ مدیریت همان قبلی؛ گواهی TLS بعد از تغییر
   DNS گرفته می‌شود).
2. ورود بسته:

   ```bash
   tmux new -s nexa-move 'sudo botctl move import /root/nexa-move.7z'
   ```

   - نقش‌های `provisioner` و `monitor` اول خاموش می‌شوند و خاموش می‌مانند.
   - بسته و SHA-256 هر عضو بررسی می‌شود؛ بستهٔ نسخهٔ جدیدتر از این سرور رد می‌شود
     («اول نکسای مقصد را به‌روز کنید»)؛ سروری که از قبل مشتری، سفارش، کیف پول یا ربات میزبانی‌شده
     دارد رد می‌شود (ادغام نمی‌شود).
   - نصب از **همان مسیر بازیابی موجود** برمی‌گردد: تأیید، آزمون بازیابی، بکاپ پیش از بازیابی، جابه‌جایی
     پایگاه داده. تأیید آن همین پوستهٔ root و رمز بسته است.
   - هر ربات میزبانی‌شده با نصب بازیابی‌شده مقایسه می‌شود (تعداد ردیف‌ها و SHA-256 هر جدول). هر
     ناهمخوانی کار را متوقف می‌کند و نام ربات و جدول را می‌گوید. رباتی که در بکاپ نصب نیست بازیابی
     نمی‌شود: فایلش در `/var/lib/nexa/backups/move-unrestored/` می‌ماند تا از «میزبانی‌ها» ←
     «بازیابی ربات از فایل» با همان رمز بسته بازیابی شود.
   - نشانه‌های DNS/TLS/وب‌هوک ربات‌های میزبانی‌شده (که روی سرور قدیمی گرفته شده بودند) پاک می‌شوند.
   - چک‌لیست فارسی چاپ می‌شود.

### ۴. DNS

- دامنهٔ مدیریت مالک (و هر نام `WEB_ADMIN_ORIGINS`): رکورد A/AAAA به IP سرور جدید.
- دامنهٔ هر ربات میزبانی‌شده: CNAME به `HOSTED_BOTS_CNAME_TARGET` سرور جدید (یا A به IP آن).

### ۵. بررسی و وب‌هوک‌ها

```bash
sudo botctl move verify          # تا همهٔ دامنه‌ها DNS و TLS «آماده» شوند
sudo botctl telegram register    # ربات اصلی
sudo botctl telegram register-hosted # ربات‌های میزبانی‌شده؛ داخل ترمینال
```

با نام کاربری و رمز مالک نصب وارد شوید؛ اگر ورود دومرحله‌ای فعال است کد آن هم پرسیده می‌شود.
سپس کد جداگانهٔ بخش «میزبانی‌ها» یا کد بازیابی آن را وارد کنید و با `REGISTER <count>` تعداد
نمایش‌داده‌شده را تأیید کنید. اگر این بخش عامل دوم ندارد، ابتدا در پنل آن را فعال کنید.
رمزها و کدها بی‌نمایش خوانده می‌شوند؛ هیچ توکن رباتی وارد نکنید و هیچ رمزی در آرگومان یا متغیر
محیطی ننویسید.

فرمان با همان توکن رمزگذاری‌شده و دامنهٔ ثبت‌شده، هویت ربات، DNS، TLS و وب‌هوک را یکی‌یکی بررسی
می‌کند (صفحه‌های ۵۰تایی). ربات اصلی را تغییر نمی‌دهد. ربات تعلیق‌شده، متوقف، منقضی، حذف‌شده،
پاک‌شده یا در حال بازیابی کنار گذاشته می‌شود. سرور قدیمیِ منجمد این فرمان را نمی‌پذیرد.
برای هر شناسهٔ ربات، `READY`، `SKIPPED` یا `FAILED` و کد بستهٔ خطا چاپ می‌شود؛ مشکل را روی کارت
همان ربات در «میزبانی‌ها» اصلاح و فرمان را دوباره اجرا کنید. خطای یک ربات مانع ادامهٔ بقیه نیست.
DNS حداکثر ۵ ثانیه، TLS حداکثر ۲۵ ثانیه و درخواست تلگرام مهلت تنظیم‌شدهٔ خود را دارد.
خروج ۰ یعنی همهٔ ربات‌های امتحان‌شده آماده‌اند (کنارگذاشته‌ها جدا شمرده می‌شوند)، ۲ یعنی بعضی
شکست خورده‌اند و ۱ یعنی ورود، تأیید یا اجرا متوقف شده است. نشست‌های همین فرمان در پایان بسته
می‌شوند. پاسخ گم‌شدهٔ تلگرام موفقیت شمرده نمی‌شود؛ اجرای دوباره پیام‌های صف را حفظ می‌کند.

هنگام اجرا دامنه یا وضعیت ربات‌ها را تغییر ندهید: نوشتن در پایگاه داده و تلگرام تراکنش مشترک
ندارد. دسترسی مالک، اتصال ربات، دامنه و وضعیت درست پیش از ثبت دوباره بررسی می‌شوند و مسیر
دریافت وب‌هوک همچنان ربات متوقف را رد می‌کند. در پایان دوباره `sudo botctl move verify` بزنید تا
ستون وب‌هوک ربات‌های فعال موردنظر «آماده» شود؛ خروج ۰ آن یعنی همه‌چیز آماده است.

### ۶. پایان

- مقدارهای محرمانه‌ای را که چک‌لیست نام برده (مثلاً `BACKUP_TELEGRAM_BOT_TOKEN`، کلیدهای S3) در
  `/etc/nexa/nexa.env` سرور جدید وارد کنید و `sudo botctl restart` بزنید.
- وقتی همه‌چیز را بررسی کردید: `sudo botctl roles enable provisioner monitor`.
- سرور قدیمی را فقط حالا خاموش کنید. تا آن وقت روشنش نکنید: همان توکن‌ها با سرور جدید مسابقه می‌دهند.

### برگشت

اگر انتقال را رها می‌کنید (سرور جدید وارد نشده یا خاموش شده): روی سرور قدیمی
`sudo botctl move abort` — همان نقش‌هایی که منجمد شده بودند دوباره روشن می‌شوند.

---

## English

### Before you start

- Prepare the new server (same size or larger). Do not change DNS yet.
- Run everything inside `tmux`; a dropped SSH session does not cut a long step.
- Telegram keeps a failing webhook's updates for **24 hours**: from the freeze until the new
  server's webhooks are registered must take less than that.

### 1. Old server: freeze and export

```bash
tmux new -s nexa-move 'sudo botctl move export --out /root/nexa-move.7z'
```

- **The freeze** comes first: every application role (api, worker, monitor, provisioner,
  assistant, recovery) is stopped. From this moment the old server **takes no orders** and
  nothing writes to its database. PostgreSQL, Redis, `backup-verify` and the edge stay up. The
  roles stopped are recorded in `/etc/nexa/move-frozen`.
- The bundle password is asked twice, hidden (12 characters or more). It never appears in an
  argument, the environment or a log; it reaches each one-off container on standard input. Keep
  it safe: the bundle does not open without it.
- A fresh installation backup and a fresh archive of every non-PURGED hosted bot are taken one
  at a time through the heavy-job queue, each sealed with the bundle password and each restored
  into a scratch database and verified before it joins the bundle (ADR-0025). If one fails, no
  bundle is written and the work directory is removed.
- The bundle (`move-manifest.json`, `checklist.fa.txt`, `installation/*.7z`, `hosted/<id>.7z`)
  is copied out through its SHA-256; its size, hash and the next steps are printed in Persian.
  **The old server stays frozen**: `botctl restart`, `update` and `rollback` refuse while it is.

### 2. Copy the file

`scp /root/nexa-move.7z root@NEW-SERVER:/root/`

### 3. New server: install and import

1. `install.sh` of the **same or a newer** release (same admin domain; its certificate waits for
   DNS).
2. `tmux new -s nexa-move 'sudo botctl move import /root/nexa-move.7z'`:
   - `provisioner` and `monitor` are disabled first and stay disabled;
   - the bundle and every member's SHA-256 are checked; a bundle whose migration head is newer
     than this release is refused («اول نکسای مقصد را به‌روز کنید»), and so is a target that
     already holds a hosted bot, a customer, an order or a wallet entry (never a merge);
   - the installation is restored through the **existing recovery executor** (`recovery_requests`
     source `MOVE`): verification, restore test, pre-restore backup, candidate, forward migration
     if behind, rename cutover, readiness. The root shell and the bundle password are the
     confirmation; no Web Admin administrator is named, the checksum binding is kept;
   - each hosted member is verified against its tenant in the restored installation (the
     installation backup still contains hosted rows, ADR-0039 § 6) by row counts and a canonical
     SHA-256 per table (secrets decrypted, key ids dropped, the archive's own columns). Any
     mismatch stops the import naming the tenant and the table. A hosted bot absent from the
     installation is not restored here: its member is kept in
     `/var/lib/nexa/backups/move-unrestored/` for «بازیابی ربات از فایل» with the bundle password;
   - every hosted activation's DNS/TLS/webhook marks (earned on the old server) are cleared;
   - the Persian checklist is printed.

### 4. DNS

The owner's names (`WEB_ADMIN_ORIGINS`): A/AAAA to the new server. Every hosted domain: CNAME to
the new `HOSTED_BOTS_CNAME_TARGET` (or A to its addresses).

### 5. Verify and webhooks

`sudo botctl move verify` until every domain resolves here and answers TLS; then
`sudo botctl telegram register` (the installation's bot), followed by
`sudo botctl telegram register-hosted` in an interactive terminal. Sign in as the installation
owner (password and the sign-in factor if enrolled), enter the separate hosting-section code
or recovery code, then confirm `REGISTER <count>`. Credentials are hidden prompts, never
arguments or environment variables. Enrol a missing hosting factor in «میزبانی‌ها» first.

The command checks the stored token identity → DNS → TLS → webhook for each eligible hosted
bot, one at a time, using pages of 50 and the existing encrypted credential. It neither asks
for bot tokens nor changes domains or the primary bot. Stopped, suspended, expired (including a
deadline not yet swept), deleted, purged and restoring bots are skipped. The owner/section
session, domain/bot binding and lifecycle are rechecked before registration. No background
roles are started. The old server's move-freeze marker refuses this command.

Each line names a hosted tenant id and READY, SKIPPED or FAILED with a closed activation code;
look up that id's card in «میزبانی‌ها» to repair its configuration. DNS lookups have a five-second
ceiling, HTTPS probes 25 seconds, and Telegram calls use the existing configured transport
timeout. A bot's failure does not stop the next bot. Exit 0 means all attempted bots are ready
(skips are counted), 2 means some failed, and 1 means sign-in, confirmation or execution stopped.
The CLI closes its own sessions on exit. A lost Telegram answer is a failure, never assumed
success; repeating the command uses the same bootstrap reconciliation and retains queued updates.

Do not edit activation settings or change lifecycle while the command runs. Database changes
and Telegram writes cannot share an atomic transaction; the per-bot registration claim and
last-moment rechecks narrow that race, and the webhook receiver still refuses stopped tenants.
Then run `sudo botctl move verify` until every intended active webhook reads «آماده»; its exit 0
means everything is ready.

### 6. Finish

Re-enter the secret values the checklist names in `/etc/nexa/nexa.env` and `sudo botctl restart`;
then `sudo botctl roles enable provisioner monitor`. Only now decommission the old server.

### Going back

`sudo botctl move abort` on the OLD server starts exactly the roles the freeze stopped and lifts
the marker. Do it only if the new server never went live (or is switched off).
