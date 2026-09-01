# Business rules — bot capabilities (CBR-###)

## CBR-001 — Capabilities are a paginated, grouped, global feature-flag table

- **Rule**: `⚙️ وضعیت قابلیت ها` presents **31** capabilities across **3 pages** in **3 named groups**
  (`📋 عمومی`, `🎮 سرگرمی و مالی`, `⏱ کرون‌ها`), each row rendering `عنوان` (title) and `وضعیت` (state).
- **Evidence**: full markup of all three pages read from the DOM, twice.
- **Confidence**: VERIFIED_BY_UI.

## CBR-002 — State is itself the button

- **Rule**: the state is not an icon beside a control; the `✅ روشن` / `❌ خاموش` cell **is** the
  interactive element. There is no separate toggle, no confirmation dialogue and no Save.
- **Consequence**: a single tap on the state cell is, to all appearances, the entire act of changing a
  global bot feature. This was **not tested** — safety takes priority over completeness.
- **Confidence**: VERIFIED_BY_UI (layout); INFERRED (immediate-apply behaviour).

## CBR-003 — Twelve capabilities carry nested configuration

- **Rule**: **twelve** rows add a third button (`⚙️ تنظیمات`, or `⚙️ تنظیم یوزرنیم` for support-in-PV),
  opening a separate settings flow. The remaining **19** are pure on/off.
- **Breakdown**: page 1/3 `📋 عمومی` → 2 (`👤 پشتیبانی در پیوی`, `🔗 لینک دانلود برنامه`);
  page 2/3 `🎮 سرگرمی و مالی` → 4 (`🎁 قرعه کشی شبانه`, `🎲 گردونه شانس`, `🎁 زیرمجموعه`,
  `🌍 محدودیت تغییر لوکیشن`); page 3/3 `⏱ کرون‌ها` → 6 (`🕚 کرون زمان`, `🕚 کرون اولین اتصال`,
  `🔋 کرون حجم`, `❌ کرون حذف`, `❌ کرون حذف حجم`, `🧯 متصل نبودن کاربر`).
- **Correction**: an earlier draft of this file said *ten*. That count was wrong;
  it is twelve. Corrected 2026-08-31 after the owner caught the error.
- **Consequence**: a capability is a flag **plus** an optional configuration record — not merely a boolean.
- **Confidence**: VERIFIED_BY_UI.

## CBR-004 — Location change is limited twice: a total allowance and a free sub-allowance

- **Rule**: `🌍 محدودیت تغییر لوکیشن` configures how many location changes a user may make in total,
  and how many of those are free.
- **Effect (what is actually verified)**: the settings screen names **two distinct allowances** —
  `↙️ محدودیت کلی` (how many location changes a user may make in total) and
  `🆓 محدودیت رایگان` (how many of those total changes are free). Both are configurable, and a
  third action `🔄 ریست محدودیت کل کاربران` resets the counters for all users.
- **Confidence — the two allowances exist**: **VERIFIED_BY_UI** (both are named verbatim in the prompt
  and both have their own buttons).
- **Confidence — that changes beyond the free allowance are charged**: **STRONGLY_INFERRED**. The
  prompt says only that N of the total are free; it does not say what happens beyond that, and no
  price field was observed on this screen. A price may live elsewhere, or the overage may simply be
  refused rather than sold.
- **Explicitly NOT claimed**: (a) we do **not** claim this flag was ON at some point in the past —
  we have no history for it; (b) we do **not** claim that this flag being `❌ خاموش` today is by
  itself the explanation for the absent customer-facing location-change UI. Both remain open
  questions (UNK-BC-004).

## CBR-005 — The capability layer is distinct from the Store and Panel capability layers

- **Rule**: MirzaBot has **three separate capability screens**: bot-level (31 flags, here), store-level
  (16 toggles, Store Settings), and panel-level (per-panel, Panel Management). Their contents do not
  overlap — no capability name appears in two of them.
- **Evidence**: the three lists compared side by side across phases.
- **Consequence**: a feature can be gated at up to three independent layers. Do not merge them.
- **Confidence**: VERIFIED_BY_UI (that the lists are disjoint); UNKNOWN (whether gating is AND-ed at runtime).

## CBR-006 — Crons are exposed as user-facing feature flags

- **Rule**: eight of the 31 capabilities are scheduled background jobs (`⏱ کرون‌ها`), each independently
  switchable and **six** of them separately configurable
  (`🔓 کرون تست` and `🎛 آپتایم نود` have no settings button).
- **Consequence**: an admin can silently disable expiry processing, volume accounting or deletion from
  the same screen that toggles a dice game. Operationally significant, and a real risk surface.
- **Confidence**: VERIFIED_BY_UI.

## CBR-007 — Several capabilities pair with settings that live elsewhere

- **Rule**: `⚠️ اعلان کاهش موجودی` (flag, here) pairs with `⚠️ مبلغ هشدار موجودی` (the threshold value,
  one level up in General Settings). `♨️ قوانین` and `🔒 احراز هویت` correspond to the
  `وضعیت تایید قانون` and `وضعیت احراز هویت` fields on the user record in User Management.
- **Consequence**: the flag and its parameter are frequently on different screens.
- **Confidence**: VERIFIED_BY_UI (both surfaces observed); INFERRED (that they are the same mechanism).

## CBR-008 — The bot's entire button paradigm is a single global flag

- **Rule**: `🛡 شیشه ای بودن دکمه ربات`, when enabled, converts **every** bot button to a glassy/inline
  button and **removes the bottom reply keyboard entirely**.
- **Evidence**: owner clarification (VERIFIED_BY_OWNER); currently `❌ خاموش`.
- **Scope**: global, all menus, customer and admin.
- **Consequence**: reply-keyboard versus inline is not a per-menu design decision in MirzaBot — it is
  one switch. Any rebuild must decide whether to support both paradigms or commit to one, and any
  automation driving this bot must not assume which paradigm is in force.
- **Confidence**: VERIFIED_BY_OWNER.

## CBR-009 — The bot's master on/off switch is an undifferentiated row in the capability list

- **Rule**: `📡 وضعیت ربات` turns the whole bot on or off, and is rendered identically to the other
  thirty capabilities — same styling, no confirmation, no warning.
- **Evidence**: owner clarification, plus the observed screen layout.
- **Consequence**: shutting down the entire business is one tap, visually indistinguishable from
  toggling `🎰 نمایش تاس`.
- **Confidence**: VERIFIED_BY_OWNER (meaning); VERIFIED_BY_UI (the layout).

## CBR-010 — Inactivity outreach is a live customer-facing job

- **Rule**: `🧯 متصل نبودن کاربر` (ON) messages customers who have not connected to their service for a
  configured number of days, asking whether there is a problem and surfacing their service details.
- **Evidence**: owner clarification.
- **Consequence**: it is a churn-prevention mechanism, not error handling — the label misleads. Its
  day threshold and message text presumably live in its `⚙️ تنظیمات` screen, which was not opened.
- **Confidence**: VERIFIED_BY_OWNER (purpose); UNKNOWN (threshold and text).


## CBR-011 — A capability's settings take one of four shapes, never just a boolean

- **Rule**: the twelve configurable capabilities use four distinct settings shapes:
  **(A) single scalar prompt** (`🕚 کرون زمان`, `🔋 کرون حجم`, `👤 پشتیبانی در پیوی`, and the
  three other crons); **(B) small menu of scalars** (`🌍 محدودیت تغییر لوکیشن`, `🎁 قرعه کشی شبانه`,
  `🎲 گردونه شانس`); **(C) a subsystem menu** mixing scalars, a media upload and sub-toggles
  (`🎁 زیرمجموعه`, 8 leaves); **(D) a CRUD collection** (`🔗 لینک دانلود برنامه`, 9 records with
  add / edit / delete).
- **Consequence**: modelling capabilities as a flat `map[string]bool` cannot represent B, C or D.
  A rebuild needs `Capability { enabled: bool, settings: A|B|C|D|null }`.
- **Confidence**: VERIFIED_BY_UI (all twelve screens opened).

## CBR-012 — The value-entry contract is uniform and has no Save step

- **Rule**: pressing a settings button puts the admin's session into "awaiting value";
  **the next ordinary text message becomes the value**. There is no inline editor, no
  confirmation and no Save button. `▶️ بازگشت به منوی قبل` exits the wait state safely.
  Invalid input is answered `⭕️ ورودی نا معتبر` and the wait state persists.
- **Consequence**: while a prompt is open, *any* text sent to the bot is consumed as the value —
  **including a menu label**. This is the exact mechanism behind INCIDENT-FIN-001 in the Financial
  phase, where typing a menu label overwrote a production tutorial text.
- **Confidence**: VERIFIED_BY_UI.

## CBR-013 — The current value is usually invisible, so reading requires writing

- **Rule**: only 6 of the 12 settings screens echo their current value. The referral percentage,
  the start-gift amount, the volume threshold, the lottery prizes and the luck-wheel prize are all
  write-only from the admin's point of view.
- **Consequence**: an admin cannot audit the bot's configuration through the bot. A rebuild should
  print the current value in every prompt — `💰 حداقل مبلغ خرید برای پورسانت` already does it
  correctly and is the model to copy.
- **Confidence**: VERIFIED_BY_UI. See SOURCE bug BC-SB-003.

## CBR-014 — Two deletion crons exist and they are not interchangeable

- **Rule**: `❌ کرون حذف` deletes accounts whose **time** expired, N days after expiry
  (currently **3**). `❌ کرون حذف حجم` deletes accounts whose **traffic** ran out, N days after the
  customer's **last connection** (currently **2**), and the bot states this one applies to the
  **Marzban** panel.
- **Consequence**: two different grace windows, measured from two different clocks, and one of them
  is panel-type-specific. This is the only capability in the tree that declares a panel dependency.
  Both destroy real customer accounts, and both are switchable from the same list as a dice toggle.
- **Confidence**: VERIFIED_BY_UI (both prompts and both current values read).

## CBR-015 — The two "not connected" jobs address opposite customer states

- **Rule**: `🕚 کرون اولین اتصال` (❌ OFF, threshold 4 days) targets customers whose service is in
  the panel state **`on_hold`** — bought but never activated. `🧯 متصل نبودن کاربر` (✅ ON,
  threshold 3 days) targets customers with a live service who **stopped** connecting.
- **Consequence**: activation-chasing is currently **disabled** while churn-chasing is enabled —
  i.e. the shop chases customers who drift away but not customers who never started. That is a
  business decision the owner may not have made deliberately, since the UI gives no hint of the
  distinction; both rows are just labelled "cron".
- **Confidence**: VERIFIED_BY_UI (both prompts); VERIFIED_BY_OWNER (the purpose of the latter).

## CBR-016 — Referral commission has two parallel payouts and one disabled floor

- **Rule**: the referral subsystem pays the referrer **both** a percentage of the referee's purchase
  (`🧮 تنظیم درصد زیرمجموعه`) **and** a flat amount per new referral (`🌟 مبلغ هدیه استارت`).
  A minimum-purchase floor (`💰 حداقل مبلغ خرید برای پورسانت`) can suppress the percentage payout,
  but it is currently **`0`, i.e. disabled** — every referred purchase pays commission regardless of
  size. The bot documents `0` as "disable this limit" on that screen.
- **Related**: a `🚨 هشدار زیرمجموعه‌گیری مشکوک` (suspicious-referral alert) option exists and was
  not pressed, so whether fraud alerting is on is UNKNOWN.
- **Consequence**: with a per-referral flat gift **and** no minimum purchase, the referral scheme's
  worst case is a self-referral farm paying out on 1-Toman orders. Worth the owner's attention
  independently of the rebuild.
- **Confidence**: VERIFIED_BY_UI (all three prompts; the floor's current value and 0-semantics).
