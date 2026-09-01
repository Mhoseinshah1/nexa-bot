# Business Rules — User Management (UBR-###)

Format per the phase brief: Rule · Evidence · Scope · Preconditions · Action · Result · Customer Effect ·
Admin Effect · Confidence.

No rule is recorded until it has been observed in this phase. Rules carried in from earlier phases keep
their original IDs (BR-###, TBR-###, PBR-###, SBR-###) and are cited, never renumbered.

---

## UBR-001 — The Telegram User Management menu is an inline keyboard with ten entries

- **Rule**: `👤 مدیریت کاربر` answers `📌 از لیست زیر یک گزینه را انتخاب نمایید` and attaches a
  ten-button **inline** keyboard: five list views, an order search, a user search, a messaging section,
  and two mass-mutation tools.
- **Evidence**: read directly from the message's own markup in the DOM.
- **Scope**: the whole User Management subsystem.
- **Preconditions**: admin privilege on the bot.
- **Action**: pressing `👤 مدیریت کاربر` on the admin reply keyboard.
- **Result**: the inline menu is displayed.
- **Customer Effect**: none.
- **Admin Effect**: none until a button is pressed.
- **Confidence**: VERIFIED_BY_UI.

## UBR-002 — User Management exposes two store-wide mutation tools that the Web Admin does not

- **Rule**: `👥 شارژ همگانی` (mass wallet top-up) and `🔋 حجم یا زمان همگانی` (mass volume/time grant)
  live inside User Management. Neither appears anywhere in the Web Admin user pages documented in the
  earlier phase.
- **Evidence**: this phase's menu read, against `project-knowledge/admin-panel.md`'s button inventory.
- **Scope**: every user / every service.
- **Preconditions**: unknown — whether the menu is role-gated was not testable (one admin account exists).
- **Action**: not performed and not to be performed.
- **Result**: unknown by design.
- **Customer Effect**: would be store-wide and financial.
- **Admin Effect**: unknown.
- **Confidence**: VERIFIED_BY_UI for existence; UNKNOWN for behaviour, deliberately.

## UBR-003 — Negative balance is a first-class, queryable state

- **Rule**: User Management offers `لیست کاربرانی که موجودی منفی دارند` as a standing list view.
- **Evidence**: this phase's menu read.
- **Scope**: all users.
- **Result**: a wallet balance below zero is a real, indexed state — not merely a purchase-time
  eligibility check against the Advanced-Reseller credit ceiling.
- **Confidence**: VERIFIED_BY_UI for the list's existence; the semantics of how a balance gets there
  remain UNKNOWN (UNK-UM-005).

## UBR-004 — The per-user discount is a plain percentage applied to any purchase, with no confirmation

- **Rule**: `🎁 درصد تخفیف` sets an integer percentage on the user record. It applies "if the user makes
  any purchase" per the bot's own prompt. `0` is the neutral value. Non-numeric input is rejected with
  `⭕️ ورودی نا معتبر` and the flow stays open for a retry. There is **no confirmation step** — the value
  commits on send.
- **Evidence**: set to `7`, verified by re-reading the record, restored to `0`.
- **Scope**: one user.
- **Customer Effect**: not observed (no checkout performed).
- **Admin Effect**: record field `درصد تخفیف کاربر` changes.
- **Confidence**: VERIFIED_BY_UI for the mechanism; UNKNOWN for runtime pricing behaviour.

## UBR-005 — `♻️  بروزرسانی اطلاعات` edits the record message in place

- **Rule**: refreshing does not post a new message; it edits the existing `👀 اطلاعات کاربر:` message
  and raises a Telegram alert `اطلاعات بروزرسانی گردید`.
- **Evidence**: observed directly; the discount changed from `0` to `7` inside the original message.
- **Consequence**: the attached 29-button keyboard is re-laid-out, so any coordinate captured before the
  refresh is stale. This caused INCIDENT-UM-002.
- **Confidence**: VERIFIED_BY_UI.

## UBR-006 — The Telegram user record is tier-adaptive

- **Rule**: for a Normal User (`f`) the record shows only the account and financial sections, and the
  action keyboard contains **no** reseller expiry, reseller discount or negative-balance-ceiling
  controls. Tier is changed through a reseller **toggle** (`🤖 افزودن نماینده` / `🤖 حذف نماینده`),
  not through an f/n/n2 picker.
- **Evidence**: full record and full 29-button keyboard read from the DOM while the user was `f`.
- **Confidence**: VERIFIED_BY_UI for the `f` state; the `n` / `n2` states are NOT_TESTED.

## UBR-007 — The Telegram record exposes a per-user commission override the Web Admin does not

- **Rule**: `🔰 درصد پورسانت اختصاصی` (dedicated commission %) appears on the record and has its own
  action button `🧮 پورسانت اختصاصی`. When unset it renders as `پیش‌فرض (10%)` — i.e. it displays the
  **global default in parentheses**, which also reveals that the global referral commission is 10%.
- **Evidence**: live record for the test user.
- **Confidence**: VERIFIED_BY_UI for existence and display; the setter is NOT_TESTED.

## UBR-008 — Per-user payment-gateway visibility exists

- **Rule**: `💵 مخفی کردن درگاه` hides a payment gateway for one specific user. The earlier phase knew
  gateway visibility only as global conditions (minimum membership days, minimum successful payments,
  hide-after-N). A per-user override was not previously known.
- **Evidence**: button present on the per-user action keyboard.
- **Confidence**: VERIFIED_BY_UI for existence; behaviour NOT_TESTED.

## UBR-009 — Admin wallet adjustment is an exact signed delta with no confirmation

- **Rule**: `👆افزایش موجودی` and `👇 کم کردن موجودی` each prompt for a Toman amount and apply it as an
  exact delta to the user's balance. There is **no confirmation step**; the amount commits on send.
- **Evidence**: 2,659,767 → +1,000 → 2,660,767 → −1,000 → 2,659,767, each step verified by re-reading
  the record via `♻️  بروزرسانی اطلاعات`.
- **Scope**: one user.
- **Customer Effect**: wallet balance changes immediately.
- **Confidence**: VERIFIED_BY_UI.

## UBR-010 — The reseller list is segmented by the raw tier tokens

- **Rule**: `لیست نمایندگان` first asks `📌 کدام گروه از نمایندگان می خواهید مشاهده کنید ؟` with three
  inline buttons: **`n`**, **`n2`**, `تمام نمایندگان`.
- **Evidence**: read from the live menu.
- **Significance**: this is the first time the Telegram admin UI shows the raw `n` / `n2` tokens as
  user-facing labels, independently confirming the tier enum from the Telegram side rather than
  inferring it from the web panel.
- **Confidence**: VERIFIED_BY_UI.

## UBR-011 — Every list view renders a table with a per-row "manage user" shortcut

- **Rule**: all list views share the header
  `⭕️ در این بخش میتوانید تمام کاربران را مشاهده کنید / ⚠️ برای مدیریت کاربر روی دکمه مدیریت کاربر جلوی هر کاربر بزنید`
  and render rows of `شناسه | نام کاربری | عملیات`, where the operations cell is a `مدیریت کاربر ⚙️`
  button that opens the same per-user action keyboard. Paging is via `بعدی`, with
  `بازگشت به منوی قبل` to exit.
- **Evidence**: observed on the `n2` reseller list and on a full user list.
- **Confidence**: VERIFIED_BY_UI.

## UBR-012 — Manual phone verification writes a sentinel string into the phone field

- **Rule**: pressing `تایید دستی شماره تلفن` answers `شماره کاربر تایید گردید.` and sets the record's
  `شماره موبایل` field to the literal string **`confrim number by admin`** — including the misspelling
  of "confirm".
- **Evidence**: the field read `none` at baseline and `confrim number by admin` afterwards.
- **Significance**: the phone column is overloaded — it stores either a real phone number or an
  admin-verification sentinel, so it cannot be treated as a phone-number field in a rebuild.
- **Confidence**: VERIFIED_BY_UI.
- **See also**: SOURCE_BUG-UM-001 for the misspelling itself.


## UBR-013 — The per-user action keyboard is tier-adaptive; the record is not

- **Rule**: a Normal User (`f`) gets **29** buttons; a Normal Reseller (`n`) gets **35**. The six extra
  are `🤖 فعالسازی ربات فروش`, `❌ حذف ربات فروش`, `🔄 تغییر توکن ربات نماینده`,
  `❌ مخفی کردن پنل برای ربات نماینده`, `🗑 نمایش پنل های مخفی شده`, `⏱️ زمان انقضا نمایندگی`.
  The **record text is identical** between the two tiers apart from the `نوع کاربری` line.
- **Evidence**: both keyboards read from the DOM on two live accounts of different tiers.
- **Significance**: reseller state is invisible to an admin reading the record — expiry, discount and
  sales-bot status can only be reached by pressing buttons. This differs from the Web Admin, whose
  نمایندگی tab displays them.
- **Confidence**: VERIFIED_BY_UI for `f` and `n`; `n2` NOT_TESTED.

## UBR-014 — Reseller expiry is a day count that schedules an automatic demotion to `f`

- **Rule**: `⏱️ زمان انقضا نمایندگی` takes a **number of days**. When it elapses the user's group is
  changed to **`f`**, an active reseller sales bot is **stopped but not deleted**, and **the user is
  notified**.
- **Evidence**: the prompt and the success message both state it explicitly; `abc` was rejected with
  `⭕ ورودی نا معتبر`.
- **Preconditions**: the user must already be a reseller (the button only exists for `n`).
- **Customer Effect**: loses reseller pricing and their sales bot stops; receives a notification.
- **Admin Effect**: no confirmation step; the existing value is never displayed.
- **Confidence**: VERIFIED_BY_UI.

## UBR-015 — `⭕ ورودی نا معتبر` is the shared validation error string

- **Rule**: the same error text is returned by at least the per-user discount field and the reseller
  expiry field for non-numeric input, and the input state is preserved for a retry in both.
- **Confidence**: VERIFIED_BY_UI (two fields).

## UBR-016 — Account-status changes are confirmed; financial changes are not

- **Rule**: `🔒 مسدود کردن کاربر` replies `در صورت تایید روی دکمه تایید کلیک کنید` with an inline
  `تایید` button and applies nothing until it is pressed. By contrast the discount, wallet credit,
  wallet debit, reseller-expiry and test-account-limit fields all commit immediately on send, with no
  confirmation at all.
- **Evidence**: block pressed, prompt observed, never confirmed; the other five fields each committed
  on a single message during this phase.
- **Significance**: the confirmation design is inverted relative to risk — a reversible status flag is
  gated, while irreversible money movement is not.
- **Confidence**: VERIFIED_BY_UI.

## UBR-017 — Reseller-bot panel visibility uses a multi-select terminated by a typed command

- **Rule**: `🗑 نمایش پنل های مخفی شده` replies
  `❌ از لیست زیر پنل هایی که میخواهید مجددا در ربات نماینده نشان داده شود را  انتخاب نمایید بعد از انتخاب تمامی پنل ها  دستور /remove را ارسال کنید تا ذخیره شود.`
  — i.e. the admin selects any number of panels and then sends the literal command **`/remove`** to
  commit the batch.
- **Significance**: a batch-select pattern that is committed by a typed command rather than a button.
  It is the third distinct input idiom in this bot, after single-tap buttons and free-text values.
- **Confidence**: VERIFIED_BY_UI for the prompt; the selection UI itself was not exercised.

## UBR-018 — Blocking is confirm-then-reason; unblocking is immediate

- **Rule**: `🔒 مسدود کردن کاربر` → inline `تایید` → the account is blocked
  (`🚫 کاربر مسدود شد حالا دلیل مسدودی هم ارسال کنید.`) → a free-text **reason** is then requested and
  stored (`✍️ دلیل مسدودی کاربر ذخیره شد`). `🔓 رفع مسدودی کاربر` reverses it **with no confirmation
  and no reason**.
- **Evidence**: performed end-to-end on the authorised account and then reversed.
- **Record effect**: `وضعیت کاربر` becomes the literal English `block`, and returns to `Active`.
- **Significance**: the restrictive direction is confirmed and audited; the permissive direction is a
  single unlogged tap. A rebuild should record a reason on both.
- **Confidence**: VERIFIED_BY_UI.

## UBR-019 — Reseller expiry appears on the record only once it is set

- **Rule**: the line `⭕️ تاریخ پایان نمایندگی : <Jalali datetime> ( N روز مانده )` is rendered on the
  user record **only when an expiry exists**. For a reseller with no expiry set, the record shows no
  reseller line at all.
- **Evidence**: the same account showed no expiry line before `⏱️ زمان انقضا نمایندگی` was set, and
  afterwards showed `۱۴۱۵/۰۶/۰۷ ۲۲:۴۹:۲۴ (  3650  روز مانده )` — an absolute Jalali datetime **plus a
  live remaining-days countdown**, even though the input was a day count.
- **Correction**: this supersedes the earlier reading in `reseller-management.md` that the record never
  shows reseller state. The record is **conditional**, not blind — the field is simply absent when null.
- **Confidence**: VERIFIED_BY_UI.

## UBR-020 — The mass top-up has no scope, no preview and no confirmation

- **Rule (PARTIALLY SUPERSEDED — see UBR-021)**: `👥 شارژ همگانی` opens with
  `📌 مبلغ را برای شارژ همگانی ارسال نمایید` and no preview, no percentage-vs-fixed choice and no
  confirmation at that step. The claim that it has **no scoping** was **wrong** and is corrected by
  UBR-021: scoping exists, it is simply asked *after* the amount.
- **Evidence**: flow opened and observed; nothing submitted.
- **Significance**: this is the single most dangerous control found anywhere in MirzaBot so far. One tap
  plus one number credits every account in the bot, with no undo path in the UI. Any rebuild must scope
  it, preview the affected count and total, and require a typed confirmation.
- **Confidence**: VERIFIED_BY_UI for the absence of safeguards; the commit behaviour itself is INFERRED
  from every other money field in the bot committing on send.


## UBR-021 — The mass top-up scopes by user group, after the amount

- **Rule**: `👥 شارژ همگانی` asks for the amount first, then
  `📌 شارژ برای کدام یک از گروه کاربری زیر واریز شود.` with inline options `همه کاربران`,
  `کاربران گروه f`, `کاربران گروه n`, `کاربران گروه n2`, plus `بازگشت به منوی اصلی` as an escape hatch.
- **Evidence**: observed live after the amount was submitted.
- **Significance**: the tool is boundable to a single tier, so a safe test is possible (`n2` = 1
  account). It still shows **no affected-count preview**, unlike the Store bulk-price tool, so the admin
  is never told how many wallets they are about to credit.
- **Correction note**: this supersedes the "no scoping" claim in UBR-020, which was made from the amount
  prompt alone before the flow had been walked to the end.
- **Confidence**: VERIFIED_BY_UI.

## UBR-022 — The mass top-up scope is two-dimensional: tier × purchase history

- **Rule**: `👥 شارژ همگانی` runs `amount → user group → purchase-history filter`. The second filter is
  `📌 چه کاربر شارژ همگانی ارسال شود` with `همه کاربران` / `کاربرانی که خرید داشتند` /
  `کاربرانی که خرید نداشتند`. `بازگشت به منوی اصلی` is offered at both scoping steps, so the flow is
  abortable until the final step.
- **Evidence**: observed live.
- **Significance**: the tool can target, for example, "every `f` user who has never purchased" — it is a
  campaign instrument, not merely a blunt global credit. It still shows **no affected-count preview at
  any step**, which remains its main safety gap.
- **Confidence**: VERIFIED_BY_UI.

## UBR-023 — Mass top-up executes on the notification answer; only the broadcast is cancellable

- **Rule**: `👥 شارژ همگانی` runs `amount → tier → purchase filter → notify (1/0)` and then executes.
  Answering step 4 is the point of commitment — there is no separate confirmation. It returns
  `✅ مبلغ به موجودی کاربران اضافه شد` and, if notification was requested,
  `✅ عملیات ارسال پیام آغاز گردید پس از پایان اطلاع رسانی خواهد شد.` with an inline `لغو عملیات`.
- **The cancel button cancels the message broadcast, not the credit.** The credit is reported complete
  in its own message, which has no cancel control. There is no undo for the money.
- **No affected-count is shown before or after** — the success message never states how many accounts
  were credited, so a one-account run and a 197,000-account run are visually identical.
- **Evidence**: executed end-to-end at the smallest scope (`n2` × buyers = 1 account, 10,000 تومان).
- **Confidence**: VERIFIED_BY_UI.
