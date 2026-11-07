# NEXA-OWNER-BATCH-1: owner requests after Phase 6A

New session. No other session works on `nexa-bot` meanwhile. Base: latest `main` (after #418).

**Build on the existing code.** Change modules in place, reuse existing services, and never rewrite a module from scratch or copy logic per tenant. Every new loop runs through the worker's per-tenant fan-out from PR-6 (#418) and under RLS, like every other loop.

## 0. Rules

- **Skills.** Read `CLAUDE.md` first. Then follow:
  - `nexa-round-pipeline` (budget);
  - `nexa-pr-workflow`;
  - `nexa-conventions`;
  - `nexa-migrations`;
  - `nexa-test-selection`;
  - `nexa-ci-watch`;
  - `nexa-handoff`;
  - `nexa-web-design` (web PRs).

  A skill's safety rule wins over this prompt. Record any conflict under "Decisions taken".
- **Merge permission.** You have my explicit permission to push, open every PR below and **merge it yourself**:
  - as a merge commit;
  - once CI is fully green on the exact head;
  - and once the single Codex review's findings are fixed.

  Never push to `main`, never force-push, never push a tag. If a later commit is needed only to fix a red CI check, that is allowed; record it in the report.
- **Codex.** Right after opening each PR, post `gh api repos/Mhoseinshah1/nexa-bot/issues/<pr>/comments -f body='@codex review'`. Act on the first complete review of that head only, in one fix commit. Never re-request after the fix commit.
- **Agents.** The lead stays on **Opus** and stays thin: it plans, delegates, reviews each diff once, merges and reports. It is the reviewer for money and for deletion of customer services. Every subagent gets an explicit model:
  - **Opus:** PR-3 (deleting panel accounts) and PR-5 (late-payment money paths), plus the approve path in PR-2.
  - **Sonnet:** everything else (labels, bot flows, Web Admin UI, i18n, tests, CI triage, Codex replies, PR text, reports).
  - **Haiku:** the single CI checker and pure lookups.

  At most **2 implementers at a time**, each in its own worktree. A Sonnet task escalates to Opus only after failing twice.
- **Do not stop to ask.** Take the safest reading and record it under "Decisions taken".
- **Budget.** If context passes about 50%:
  1. finish and merge the PR in hand;
  2. write the handoff: what is merged, what is left, the exact next step;
  3. post a short Persian comment on #358;
  4. STOP.

  The next session resumes from that handoff.
- **Order of PRs.** PR-1 and PR-4 have no money risk; run them first, in parallel. Then PR-2, then PR-3, then PR-5.

---

## PR-1 · `feat/menu-mirza-defaults` (Sonnet): Mirza menu labels + search-button switches

### A. Default main-menu labels

Change the **default** text and style of these templates to exactly the values below. Keep the characters exactly as written, including Mirza's spelling without ZWNJ in «سرویس های من» and «زیر مجموعه گیری».

| Template | New default label | Default style |
|---|---|---|
| `bot.menu.catalog` | `🔐 خرید اشتراک` | `success` |
| `bot.menu.services` | `🛍 سرویس های من` | `success` |
| `bot.menu.wallet` | `🏦 کیف پول + شارژ` | `success` |
| `bot.menu.trial` | `اشتراک رایگان {تست}` | `primary` |
| `bot.menu.referral` | `👥 زیر مجموعه گیری` | `success` |
| `bot.menu.apps` | `📚 آموزش` | `success` |
| `bot.menu.help` | `☎️ پشتیبانی` | `success` |
| `bot.menu.admin` | `👨‍💼 پنل مدیریت` | `default` |

Rules:

- **Literal braces.** `{تست}` is literal text, not a placeholder. Make the template engine render it as written, by escaping it or by not treating it as a variable for this key. A tap on it must still route to the trial.
- **`bot.menu.tickets`** keeps its current default.
- **Owner overrides stay.** Only the DEFAULTS change. A label, style or layout the owner already saved in the Web Admin is never touched.
- **Old defaults still route.** A tap on a previous default label must still route; this is the existing older-defaults rule. Add the replaced defaults to that list.
- **Default layout** (two per row, Mirza order; applies only where no layout is saved):
  1. خرید اشتراک
  2. کیف پول + شارژ | سرویس های من
  3. اشتراک رایگان {تست}
  4. آموزش | زیر مجموعه گیری
  5. پشتیبانی
  6. درخواست نمایندگی (added by PR-2; until then the row is absent)
  7. پنل مدیریت (admins only)
- **Not added:** NO «تمدید سرویس» button, NO price-list button, NO lucky wheel.

### B. Two feature switches for the «سرویس‌های من» search row

The «سرویس‌های من» page has a search row built from `bot.service.search_label_button` («جستجوی نام کاربری») and `bot.service.search_button` («🔎 جستجو»).

- Add two feature flags on the Web Admin features page, each with its own switch, **both default OFF**:
  - `services_search_label_button` hides or shows the label button;
  - `services_search_button` hides or shows the search button.
- When both are off, the whole search row is gone.
- When one is on, only that button is drawn.
- With both off, the search capture flow itself must not be reachable from a stale button. Answer that tap with the usual "this option is no longer available" behaviour and edit-in-place back to the list.
- Each flag gets a full features-page description, following the existing model 1 entries: what it does, where it is seen, the effect when off.

**Tests:**
- exact default labels;
- `{تست}` renders literally and routes;
- old labels route;
- an owner override is unchanged;
- each search flag alone, both off, and a stale tap.

---

## PR-2 · `feat/reseller-request` (Sonnet bot/UI, Opus approve path): «👨‍💻 درخواست نمایندگی»

### 1. Feature flag and button

- Feature flag `reseller_requests`, default OFF.
- Registry button `reseller_request` with template `bot.menu.reseller_request`, default label `👨‍💻 درخواست نمایندگی`, default style `danger`.
- The button is not drawn while the flag is off.

### 2. Questions (owner-defined)

In the Web Admin («درخواست‌های نمایندگی» → «سؤال‌ها»), the owner manages an ordered list of questions:
- add, edit, delete and drag-to-reorder (use the kit's drag-and-drop list, no up/down buttons);
- each question has its text, required or optional, and a max answer length (default 500).

Changing the list never changes requests already sent; each request stores the questions as they were asked.

### 3. Customer flow (edit-in-place)

1. An intro text (template).
2. The questions one by one, each as its own step:
   - optional questions have «رد کردن»;
   - every step has «بازگشت» to the previous question.
3. A summary of all answers with «ارسال» and «ویرایش».
4. «درخواست شما ثبت شد».

Rules:

- **Already a reseller:** they see a text saying so, and no request is created.
- **One open request per customer:** tapping again shows its status.
- **After a rejection:** a new request is allowed only after `reseller_request.cooldown_days` (default 7, `0` = no wait). The reason, if any, is shown.
- **Decision message:** the customer gets a message (template), with the tier name on approval.

### 4. Conversation before the decision

A request is not only approve or reject: the owner can keep talking with the applicant.

- **Reuse the existing ticket/support thread machinery** (two-way messages, attachments, bot delivery, notifications) instead of building a new chat. If a ticket thread does not fit cleanly, record why and build the smallest equivalent on the same delivery path.
- **Owner side.** The owner writes a message from the Web Admin request page or with «💬 پیام به متقاضی» in the ops group.
- **Customer side.** The customer receives it in the bot with a «پاسخ» button. Their reply, text or a photo, is attached to the same request and appears in the Web Admin thread and in the ops group.
- **Status.** While a conversation is going, the request stays PENDING and shows «در حال گفتگو».
- **After a decision.** Once the request is decided, the thread is closed for replies.

### 5. Ops group

A new log type «درخواست نمایندگی». It shows:
- name, @username and Telegram id;
- number of services and total paid;
- every question with its answer.

Buttons:
- **«✅ تأیید»** opens an inline list of active reseller tiers, then a confirm.
- **«❌ رد»** takes an optional reason.
- **«💬 پیام به متقاضی»** starts a message to the applicant.

Each customer reply arrives as a new message under the request.

Only admins with the reseller-management permission may act; everyone else gets the usual refusal. A double tap or a race must never approve twice; use the existing idempotency.

### 6. Web Admin

Under «نمایندگان», a «درخواست‌های نمایندگی» list:
- chips for pending / in conversation / approved / rejected, with counts;
- the request page or side drawer shows the answers, then the conversation thread with a composer;
- approve with a tier choice, or reject with an optional reason;
- a link to the customer page;
- a «سؤال‌ها» tab with the question editor from §2.

### 7. Approve (Opus)

- Reuse the EXISTING "make reseller" service that the Web Admin customer page uses: same permission, same audit, same ops log.
- **No wallet or credit change.**
- The approval and the request's state change happen in one transaction.

### 8. Data

A migration adds tenant-scoped tables under RLS:
- **`reseller_request_questions`:** order, text, required, max_length, active.
- **`reseller_requests`:** the columns below.
- **Thread:** linked to a ticket thread, or its own message table if a ticket does not fit.

`reseller_requests` columns:
- id, tenant_id, customer_id;
- answers (the asked questions + answers, as stored at submit);
- status `PENDING|APPROVED|REJECTED`;
- decided_by, tier_id, reason;
- created_at, decided_at.

It also adds a partial unique index: one PENDING request per customer.

`botctl customers prune-empty` must count a request as a dependent row. It should get this from the FK graph; test it.

**Tests:**
- the full flow with required and optional questions, «بازگشت», summary edit;
- a question edit does not change an already-sent request;
- owner message → customer reply → appears in the Web Admin and the group;
- the thread is closed after a decision;
- one-open and cooldown;
- an existing reseller is refused;
- approve from the group and from the Web Admin → becomes a reseller, with no wallet change;
- a double approve is idempotent;
- reject with a reason;
- a non-permitted admin is refused;
- RLS isolation;
- flag off → no button.

---

## PR-3 · `feat/service-auto-delete` (Opus): automatic deletion of finished accounts (Mirza «کرون حذف»)

Today an EXPIRED or SUSPENDED service stays on the panel forever; deletion is manual only. Add automatic deletion.

### 1. Feature flag and settings

Feature flag `service_auto_delete`, default OFF. Settings:

| Key | Default | Meaning |
|---|---|---|
| `service.auto_delete.after_traffic_days` | `0` (off) | days after the traffic ran out |
| `service.auto_delete.after_time_days` | `0` (off) | days after the time ran out |
| `service.auto_delete.after_suspend_days` | `0` (off) | days after the service became SUSPENDED |
| `service.auto_delete.warn_hours` | `24` | warn the customer this long before deletion (`0` = no warning) |
| `service.auto_delete.max_per_minute` | `30` | deletions per minute per panel |

### 2. Telling traffic from time

`EXPIRED` covers both causes. Determine the cause from data Nexa already has:
- traffic used ≥ traffic limit → traffic;
- otherwise → time.

Store the moment and the cause when a service becomes EXPIRED if that is not stored today. Never guess from the current time alone. Record the rule in "Decisions taken".

### 3. Which services qualify

A service is due when the matching setting is > 0 and the service has been in that state for at least that many days.

**Never** delete a service that:
- was renewed, or is no longer in that state;
- has an open order, payment or receipt under review;
- belongs to a stopped tenant.

Trials are included. Reseller services are included.

### 4. Warning

`warn_hours` before deletion, the customer gets one message (template): «سرویس {username} فردا حذف می‌شود؛ برای حفظ آن تمدید کنید». It has a renew button that uses the existing renew flow. The message is sent at most once per service per due cycle.

### 5. Deletion

- Use the EXISTING terminate path, the same provisioning `TERMINATE` operation the Web Admin «پایان سرویس» uses, with reason `AUTO_DELETE`.
- No refund and no wallet change.
- Exactly once (idempotent).
- Rate-limited per panel by `max_per_minute`, through the existing provisioning queue.
- A failure retries with the existing backoff and never loops.

### 6. Ops logs

- Each deletion gets an ops-group log with the panel account username, cause and days.
- The nightly report gets a line with the count.

### 7. Safety for the first switch-on

With imported Mirza data, many old services may already qualify.

- In the Web Admin settings for this feature, show a live preview: «با این تنظیمات، N سرویس در ۲۴ ساعت آینده حذف می‌شود» (per cause).
- Turning the flag on asks for a confirm that repeats N.
- Deletions then drain slowly at the rate limit; no burst.

**Tests:**
- each cause with its days;
- a renewal before the deadline cancels;
- an open payment blocks;
- the warning is sent once;
- deletion goes through the terminate path exactly once;
- rate limit;
- a stopped tenant is skipped;
- RLS isolation;
- the preview count;
- flag off → nothing happens.

---

## PR-4 · `fix/webadmin-secrets-forms-json` (Sonnet): browser autofill, one Save, readable values

### A. No browser autofill or password-manager prompts

Root cause: 29 raw `type="password"` inputs across 15 pages. Examples are API keys, bot tokens, webhook secrets, panel passwords, backup passwords and recovery keys. The browser treats each one as a site login, so it:
- suggests saved logins under them;
- offers «Update password?» after a save.

Search boxes have no `autocomplete="off"`.

1. **Kit component `SecretInput`.**
   - A text input masked with CSS (`-webkit-text-security: disc`, with a fallback), plus a show/hide eye button.
   - It carries `autocomplete="off"`, `data-lpignore="true"`, `data-1p-ignore`, `data-form-type="other"` and a non-login `name`.
   - It is never inside a form that also has a username-like field.
   - Move all secret fields to it.
2. **Real logins keep the password manager.** Only these keep `type="password"`, with the proper `autocomplete="current-password"` or `"new-password"`:
   - the Web Admin login;
   - an admin changing their own password;
   - a hosted-bot owner creating their own login.
3. **Search and filters.** Every search, filter and free-text input that is not a login gets `autocomplete="off"`. Do it in the kit's input so that new pages get it by default.
4. **CI guard.** A test fails if a raw `type="password"` appears in `apps/web/src` outside the allowlist from step 2.

### B. One Save for multi-field credential dialogs

A gateway dialog, such as TonPays, saves the API key and the webhook secret with separate buttons. Each save closes the dialog, so it has to be reopened for the next field.

- Show all fields of the dialog in one form with **one «ذخیره»**.
- **An empty field keeps its stored value.** Stored secrets are never shown.
- Save only the fields that changed. Reuse the existing endpoints, or add one batch endpoint if cleaner.
- If one field fails, show which one, keep what the owner typed in the others, and do not close.
- Close only on full success.
- Apply this to every dialog with more than one separately-saved secret: gateways, panels credentials, bots, and any other you find.

### C. No raw JSON anywhere a value is displayed

`apps/web/src/pages/features.tsx` and `settings.tsx` fall back to `JSON.stringify` for non-string values. For example, the features page shows the referral gift total as `{"amountMinor":"0","currency":"IRT"}`. There are 49 `JSON.stringify` uses across `apps/web/src/pages`.

- Build one Persian value formatter in the kit and use it everywhere a setting or feature value is DISPLAYED:
  - money object → the existing money format («۲۰٬۰۰۰ تومان», Latin digits as the repo rule says);
  - boolean → «روشن» / «خاموش»;
  - duration → «۳ روز» / «۲ ساعت»;
  - arrays → a readable list;
  - known objects → labelled lines;
  - empty → «تعیین نشده».
- Audit all 49 uses: fix every one that reaches the screen. Uses that build request bodies or keys stay as they are.
- List the audit in the PR.

**Tests:**
- `SecretInput` has the attributes and never renders `type="password"`;
- the CI guard;
- one Save with one field empty keeps the stored value;
- a partial failure keeps the form open;
- the formatter's cases;
- the features page shows the gift total as money.

---

## PR-5 · `feat/late-payment-policy` (Opus): choose what happens to a late payment

Today each online gateway has a boolean late-credit setting (`LATE_CREDIT_SETTING_KEYS.*` in `settings.ts`):
- **on:** a late approval, re-verified with the provider, goes to the wallet once;
- **off:** it is recorded as a late completion and an operator decides.

### 1. The setting

Replace the boolean with a policy per gateway, keeping the same per-gateway keys or adding new ones with a migration. The values are:
- `WALLET`: today's "on";
- `REVIEW`: today's "off";
- `DELIVER`: new.

- **Migration:** `true` → `WALLET`, `false` → `REVIEW`. Nothing changes for existing installs until the owner picks `DELIVER`.
- **Web Admin:** a three-way choice on each gateway, with clear Persian descriptions.

### 2. `DELIVER`

After the same provider re-verification as today, the paid order's service is delivered as if it had been paid on time, when all of these hold:
- the product is still sellable;
- the paid amount covers the order's payable amount;
- the panel has capacity;
- the customer is not blocked.

Rules:

- Never recompute a price.
- If the order is in a terminal state, choose the smaller safe design, record it, and test it. Either:
  - add an explicit late-payment transition; or
  - create a fulfilment order tied to the same payment.
- If ANY condition fails, the money goes to the wallet (the `WALLET` path). Log the reason in the ops group and tell the customer (template).
- **The money never disappears and is never counted twice.** Exactly once, using the existing idempotency.

### 3. `REVIEW`

The late completion goes to the existing operator queue. In the Web Admin and in the ops-group message, the operator has two choices:
- **«تحویل سرویس»:** the `DELIVER` path, with the same checks and fallback;
- **«به کیف پول»:** the `WALLET` path.

Both need the payments-approve permission and are exactly once.

### 4. Scope and logs

- **Scope:** the gateways that have a late-credit setting today. Stars and card-to-card keep their current rules; record that.
- **Ops logs:** each outcome gets a log naming the gateway and, when delivered, the service's panel username.

**Tests:**
- the migration mapping;
- `WALLET` is unchanged;
- `DELIVER` success;
- `DELIVER` falls back for each failing condition;
- `REVIEW` → operator deliver and operator wallet, each exactly once;
- a double callback;
- a non-permitted admin is refused;
- RLS isolation.

---

## End of session

- **Round reports.** Append each merged PR to `docs/round-reports/owner-batch-1.md`.
- **#358 comment.** Post a Persian comment titled «درخواست‌های مالک — بخش ۱». It contains:
  - the PR links;
  - one line per item on what changed;
  - my test steps per item, with this order and wording:
    1. see the new menu labels;
    2. turn the search switches on and off;
    3. add 3 questions; send a reseller request with a test account; send the applicant a message from the group, answer it, then approve;
    4. set auto-delete days, check the preview, enable it, and watch one test service get the warning and then be deleted;
    5. open a gateway dialog, fill both fields and Save once;
    6. confirm Chrome no longer offers saved passwords there;
    7. check that the features page shows the gift total as money;
    8. set a gateway to `DELIVER`, pay a test invoice after its deadline, and see the service delivered;
    9. set a gateway to `REVIEW` and deliver from the group;
    10. last line: `sudo botctl roles disable provisioner monitor`.
- **Handoff.** Update the handoff.
- **Worktrees.** Remove your worktrees. List any branches you could not delete.
- **STOP.**
