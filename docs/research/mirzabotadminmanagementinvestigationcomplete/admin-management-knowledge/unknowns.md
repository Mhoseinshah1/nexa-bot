# Unknown register — Admin Management

Statuses: `OPEN` · `PARTIALLY_RESOLVED` · `RESOLVED` · `NOT_EXPOSED` · `OUT_OF_SCOPE`

### UNK-ADM-001 — Are the four roles actually enforced? *(the phase's central question)*
- **Evidence:** four roles with written scopes; a test admin now exists on the narrowest one.
- **Missing:** any observation of the bot behaving differently for a restricted admin.
- **Safe verification:** owner sends `/start` from `[TELEGRAM_USER_ID_REDACTED]` and screenshots the admin keyboard
  (full procedure in `access-enforcement.md`). Read-only, ~5 minutes.
- **Priority:** **P1** · **Status:** OPEN — carried forward from Web-Admin UNK-005, still unresolved.

### UNK-ADM-002 — Menu hiding vs backend authorization
- **Evidence:** none — depends on UNK-ADM-001.
- **Missing:** whether a restricted admin sees a shorter keyboard, or the full keyboard with denials,
  or the full keyboard with no denials at all.
- **Safe verification:** as above; step 3 answers visibility, step 4 answers authorization.
- **Priority:** **P1** · **Status:** OPEN.

### UNK-ADM-003 — Can an admin be created for an id with no customer record?
- **Evidence:** the add flow performed **no validation at all** on the id, which suggests yes.
- **Missing:** a test — which would require an id other than the authorised test account.
- **Safe verification:** clone bot, or source.
- **Priority:** P2 · **Status:** OPEN.

### UNK-ADM-004 — Is the admin set global, or per-bot in the reseller sub-bot deployment?
- **Evidence:** reseller sub-bots exist (`🔗 وبهوک مجدد ربات های نماینده`,
  `🔄 آپدیت همگانی ربات های نماینده`). The Web `Admin` entity has a **"bot username (scope)"** field;
  the Telegram list shows **no scope column**.
- **Missing:** whether these five rows apply to this bot only or to every sub-bot.
- **Safe verification:** open a reseller sub-bot's own admin section and compare the list.
- **Priority:** **P1** for a rebuild — it decides whether `Admin` is keyed by (bot, id) or by id alone.
- **Status:** OPEN.

### UNK-ADM-005 — Can a restricted admin reach `👨‍🔧 بخش ادمین` and escalate?
- **Evidence:** no role description mentions admin management, not even `مدیر کل`'s.
- **Missing:** enforcement, i.e. UNK-ADM-001. If unenforced, **any** admin can create a `مدیر کل`,
  which makes every role equivalent to full access.
- **Safe verification:** part of the same test; look for `⚙️ تنظیمات عمومی` on the restricted keyboard.
- **Priority:** **P1** (security) · **Status:** OPEN.

### UNK-ADM-006 — Are admin mutations written to the Admin Log?
- **Evidence:** the Web log's confirmed ~20-verb vocabulary contains **no** admin-management verbs.
  Suggestive, not conclusive — that sample came from a deployment whose admin set was stable.
- **Missing:** a look at `/admin/logs` for entries at **02:28** and **02:34 on 31 Aug 2026**, the exact
  timestamps of this phase's create and re-add attempts.
- **Safe verification:** read-only page load in the Web panel.
- **Priority:** **P1** — if admin changes are unlogged, adding a super-admin leaves no trace anywhere.
- **Status:** OPEN, and cheaply closable.

### UNK-ADM-007 — Does `❌` delete immediately, or confirm first?
- **Evidence:** the header says only "press the ❌ next to it"; no confirmation appears anywhere else
  in this section; the create flow has none either.
- **Missing:** the actual behaviour — **deliberately not tested** (it would delete a real admin).
- **Safe verification:** clone bot, or source.
- **Priority:** P1 for operators · **Status:** OPEN, intentionally.

### UNK-ADM-008 — Are there self-protection rules?
- **Missing:** whether the bot prevents deleting the last `مدیر کل`, deleting the bot owner, or an
  admin deleting themselves. Nothing in the UI hints either way, and every row — including all four
  production super-admins — carries an identical `❌`.
- **Safe verification:** source reading, or a clone. **Must not** be probed here: the only way to test
  "can the last super admin be deleted?" on production is to risk losing control of the bot.
- **Priority:** **P1** · **Status:** OPEN.

### UNK-ADM-009 — Is there a protected "owner" distinct from `مدیر کل`?
- **Evidence:** the list renders all four production admins identically; nothing marks an owner. One
  of them is the referrer of the test account, but that is a customer relation, not an admin one.
- **Missing:** whether the deployment has a hard-coded owner id outside this table.
- **Safe verification:** source.
- **Priority:** P2 · **Status:** OPEN.

### UNK-ADM-010 — What happens to an admin's in-flight session when their record is deleted?
- **Missing:** entirely untested.
- **Priority:** P3 · **Status:** OPEN.

### UNK-ADM-011 — Do the three restricted roles gate the **mass** tools?
- **Evidence:** `👥 شارژ همگانی` and `🔋 حجم یا زمان همگانی` sit inside `👤 مدیریت کاربر`, the menu
  that `فروشنده` and `پشتیبان` are described as reaching. No description carves them out.
- **Missing:** enforcement.
- **Priority:** **P1** — this is store-wide financial mutation from a phone.
- **Status:** OPEN.

### UNK-ADM-012 — Admin creation validation for malformed / non-existent ids
- **Missing:** behaviour for junk input, or an id that is not a Telegram account.
- **Safe verification:** clone bot. Not testable here (the brief allows only one id).
- **Priority:** P3 · **Status:** OPEN.

### UNK-ADM-013 — Admin detail, activity and audit metadata
- **Status:** **NOT_EXPOSED.** There is no detail screen, no created-at, no created-by, no
  last-activity anywhere in the Telegram surface. Not an open question — a missing feature.
