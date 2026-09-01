# Unknown register — General Settings follow-up

Statuses: `OPEN` · `PARTIALLY_RESOLVED` · `RESOLVED` · `NOT_EXPOSED` · `OUT_OF_SCOPE`

---

### UNK-GS-001 — Which channels are currently enforced for forced-join?
- **Current evidence:** the feature exists; the enable/disable rule is known; the add-format is known.
- **Missing evidence:** the list itself, and even its length. The section never displays it.
- **Safe verification:** open the bot as a non-exempt customer and see whether a join gate appears
  and which channel it names. (Do **not** open `حذف کانال` — it is the deletion path.)
- **Priority:** P1 — this determines whether a customer-facing gate is live right now.
- **Status:** OPEN

### UNK-GS-002 — Topics are required, but no topic/thread id is asked for
- **Current evidence:** step 3 of the reports tutorial requires forum/topic mode on the group, yet
  the only field is the group id. Telegram needs a `message_thread_id` to post into a topic.
- **Missing evidence:** whether the bot picks a topic automatically, posts to "General", or stores a
  thread id elsewhere.
- **Safe verification:** read the MirzaBot source; or observe the notification group (owner-side).
- **Priority:** P2
- **Status:** OPEN

### UNK-GS-003 — What is the stored balance-warning amount?
- **Current evidence:** the field exists, is a single global Toman amount, and is not echoed.
- **Missing evidence:** the value.
- **Safe verification:** database/config read. It cannot be read through the bot without overwriting it.
- **Priority:** P2 (currently moot — the alert capability is OFF)
- **Status:** OPEN

### UNK-GS-004 — Does `0` disable the balance warning?
- **Current evidence:** none. This screen says nothing about 0, unlike
  `💰 حداقل مبلغ خرید برای پورسانت`, which documents `0` = disabled.
- **Missing evidence:** any statement or observed behaviour.
- **Safe verification:** source reading, or a clone bot. Do not probe on production.
- **Priority:** P3
- **Status:** OPEN

### UNK-GS-005 — Is the balance warning event-driven or cron-driven, and what does it say?
- **Current evidence:** the capability that gates it (`⚠️ اعلان کاهش موجودی`) is **not** in the
  `⏱ کرون‌ها` group — it sits in `🎮 سرگرمی و مالی`, which suggests event-driven.
- **Missing evidence:** the trigger, and the message text (nothing in `📝 تنظیم متن ربات` was inspected).
- **Safe verification:** source reading; or inspect `📝 تنظیم متن ربات` in a later phase.
- **Priority:** P3
- **Status:** PARTIALLY_RESOLVED (grouping is suggestive, not conclusive)

### UNK-GS-006 — Does `✅ تایید و  بهینه سازی` execute immediately?
- **Current evidence:** a single inline button on the warning message; no cancel; MirzaBot's inline
  confirms elsewhere act at once.
- **Missing evidence:** the actual behaviour — **deliberately not tested**.
- **Safe verification:** source reading, or a clone bot with throwaway data. **Never on production.**
- **Priority:** P1 for anyone operating this bot
- **Status:** OPEN — and intended to stay open

### UNK-GS-007 — How many records would optimization delete?
- **Current evidence:** six declared classes; no count shown anywhere.
- **Missing evidence:** the count, and whether users/wallets/payments are preserved.
- **Safe verification:** a `SELECT COUNT(*)` against the bot's database using the same predicates.
- **Priority:** P1 — an irreversible bulk delete is being offered without a magnitude.
- **Status:** OPEN

### UNK-GS-008 — Does optimization interact with the deletion crons?
- **Current evidence:** class 6 ("time or volume exhausted") is the same population the crons
  `❌ کرون حذف` (3 days after expiry) and `❌ کرون حذف حجم` (2 days after last connection) act on.
  The crons delete the **service on the panel**; optimization deletes the **order record**.
- **Missing evidence:** whether optimization respects the crons' grace windows, or deletes records
  for services still inside them.
- **Safe verification:** source reading.
- **Priority:** P2 — if it ignores the grace window it could orphan a live service's record.
- **Status:** OPEN

### UNK-GS-009 — Does `حذف کانال` confirm before deleting?
- **Current evidence:** none — not opened, by design.
- **Missing evidence:** the whole flow.
- **Safe verification:** clone bot, or source.
- **Priority:** P3
- **Status:** OPEN (out of scope for a read-only phase)

### UNK-GS-010 — Does a reseller sub-bot have its own channel / reports / warning settings?
- **Current evidence:** reseller sub-bots exist (`🔗 وبهوک مجدد ربات های نماینده`,
  `🔄 آپدیت همگانی ربات های نماینده` sit in this same menu).
- **Missing evidence:** whether these four settings are per-bot or deployment-wide.
- **Safe verification:** open a reseller sub-bot's own admin panel.
- **Priority:** P2 — same question as UNK-BC-003 from the previous phase, now applied here.
- **Status:** OPEN

### UNK-GS-011 — What is the exact notification set delivered to the reports group?
- **Current evidence:** the destination exists and is configured; `👤 اعلان کاربر جدید` (ON) is one
  plausible producer.
- **Missing evidence:** the full list of events that post there.
- **Safe verification:** owner can look at the group's history.
- **Priority:** P2
- **Status:** OPEN

### UNK-GS-012 — Is there any report scheduling anywhere in the product?
- **Current evidence:** none in this section. `📊 آمار ربات` is a live viewer, and the cron group
  contains no "send report" job.
- **Status:** **NOT_EXPOSED** — scheduled reporting appears not to exist in MirzaBot at all.
