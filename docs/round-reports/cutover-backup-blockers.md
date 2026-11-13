# Round: cutover blockers — backups to Telegram, backup speed, the 2-hour DUMP

Evidence: the owner's test server on 2026-11-13 (aarch64, 4 vCPU / 8 GB, a real 135 MB Mirza
import of about 197k customers). Per-PR detail is in each PR description: what changed, the
Codex fix, tests and mutation checks, and decisions.

## PRs

| PR                                                        | What                                                                                                                                                                                            | Merge       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| [#479](https://github.com/Mhoseinshah1/nexa-bot/pull/479) | §1 multi-part delivery: one deadline, streamed, real cause recorded; safe part resend; «ارسال دوبارهٔ بخش‌های نرسیده»; `backup.part_mb`; compaction re-delivers before its gate; migration 0346 | `a1b1d2bd9` |
| [#480](https://github.com/Mhoseinshah1/nexa-bot/pull/480) | §2 speed: seal with the cores the container is allowed, mx5 plans, cgroup-aware memory                                                                                                          | `5d6af3ecc` |
| [#481](https://github.com/Mhoseinshah1/nexa-bot/pull/481) | §3 dump watchdog: sized timeout, `--lock-wait-timeout`, lock recorded, process-group kill; stale runs closed on every scheduler tick                                                            | this PR     |

## Real causes

- **«fetch failed».** Node's global `fetch` (bundled undici) has 300 s headers and body
  timeouts. They sit below `BACKUP_DELIVERY_TIMEOUT_MS` (10 min), so a slow 45 MB
  `sendDocument` was cut off. The error's `cause` was discarded, so the exact undici code of the
  test-server run cannot be recovered from its row. From #479 on, every failure records it.
- **NOT_ATTEMPTED on the import's backups.** This is by design: the Mirza restore's PRE_RESTORE
  and post-import backups are `deliver: false`. Delivery stays off. They are now labelled
  «طبق طراحی فقط روی سرور نگه داشته شد (بکاپ ایمپورت)».
- **The 2-hour DUMP** (medium confidence). The run was closed at 10:22:55 by the stale-lease
  reclaim, which used to run only when the next backup started. Its process had stopped
  heart-beating by 10:08 at the latest. The likeliest cause is that the API process, which runs
  a Web Admin manual backup inside the request, restarted and took `pg_dump` with it.
  - Ruled out by the code: a pipe deadlock, a 7-Zip deadlock, and the old 2 h timeout.
  - Not ruled out: a lock wait (`pg_dump` had no `--lock-wait-timeout`).
  - To confirm: the run's `failure_code` (`backup.lease_expired`) and the API container's restart
    time.

## Backup time

The sandbox is x86-64 with 4 vCPU, not the owner's aarch64 server. On a 2.6 GB dump the seal
went from 37.4 min to 4.4 min, the archive is 1.04× its old size, and peak RSS fell from 680 to
135 MiB. Under the 70 % CPU duty cycle the projection is about 7 min end to end. This is not yet
measured on the owner's server.

## Owner check list

1. `sudo botctl update vX.Y.Z` (the owner tags it).
2. On the test server with the imported data: «بکاپ الان» → all 5 parts reach the group. Note
   the minutes.
3. Run «پاک‌سازی تکمیلی» (the compaction) → it completes. Note the database size before → after.
4. On a backup with a failed part, «ارسال دوبارهٔ بخش‌های نرسیده» delivers only the missing
   parts.
5. Optional: for the 08:32 run, read its `failure_code` and the API container's restart time.
6. `sudo botctl roles disable provisioner monitor`

## Usage

| PRs | Agents                                   | Tiers                              | CI cycles                 | Codex                                           |
| --- | ---------------------------------------- | ---------------------------------- | ------------------------- | ----------------------------------------------- |
| 3   | 3 implementers (+ fix/merge resumptions) | lead; money (§1, §3); default (§2) | #479: 2, #480: 3, #481: 2 | #479: 1 P2 fixed; #480: 1 P2 fixed; #481: clean |
