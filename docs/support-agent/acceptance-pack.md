# Intelligent Support Agent — manual real-Telegram acceptance pack

Program §48. An operator runs this pack with a **real Telegram Business account** and **real AI
provider keys**, on a staging installation. Nothing here is automated or run in CI. The
automated suites prove that NEXA's code agrees with NEXA's fakes. Only this pack proves that
Telegram and the providers behave as those fakes say (`docs/real-panel-acceptance.md` gives the
reason, learned the expensive way).

Record every step in the results table at the end: pass or fail, the time, and the evidence
(a screenshot, a log line, a query result). A step that cannot be run is **not run**. It is
never marked as passed.

> **AUTO_REPLY_SAFE on a real Production tenant needs Product Owner approval.** This pack
> enables automatic replies on a **TEST tenant only** (section F). Turning `AUTO_REPLY_SAFE` on
> for any tenant that serves real customers is the Product Owner's decision, in writing, after
> this pack has passed. Even then it needs `support_ai.auto_reply`, which only the `owner` role
> holds. **No migration enables it.** Every tenant starts at mode `OFF` with an empty
> automatic-topic allowlist, and no migration writes `support_ai_configs` at all
> (`tb7-auto-reply.md`, "Release defaults").

## Prerequisites

| #   | What                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | A staging installation on this release, every role healthy: `botctl status` shows `api`, `worker`, `monitor`, `provisioner`, `recovery` and `assistant`. |
| P2  | The tenant's bot token registered, and the bot's **Business mode enabled in @BotFather** (Bot Settings → Business Mode).                                 |
| P3  | A Telegram account with **Telegram Business** (Premium), used as the _business account_. Its owner's phone is "the owner's phone" below.                 |
| P4  | A second, ordinary Telegram account, used as _the customer_. Linking it to a NEXA customer (it has used the bot) is needed for steps E and F.            |
| P5  | A test key for at least two providers (OpenAI, Anthropic or Z.AI), on accounts with **no customer data**. One spare key you can revoke (step H).         |
| P6  | Web Admin accounts: an `owner`, and a `support` operator.                                                                                                |
| P7  | A **TEST tenant** for section F. It is not the Production tenant, and no real customer writes to its business account.                                   |
| P8  | Read access to the database (`docs/support-agent/runbook.md`, conventions), for the evidence queries.                                                    |

## A. Connect, disconnect and rights

1. On the business account: Settings → Telegram Business → Chatbots → add the tenant's bot,
   and allow **reply to messages**.
   - **Expect:** on `/business-chats`, «اتصال‌های تلگرام بیزینس» lists the connection as
     «فعال», with the owner's Telegram id.
2. In the same Telegram screen, remove the permission to reply.
   - **Expect:** the connection shows «بدون اجازه پاسخ». A notification
     «اتصال تلگرام بیزینس نمی‌تواند پیام بفرستد» appears for the `support` operator.
3. Allow replying again.
   - **Expect:** «فعال», and that notification shows as resolved.
4. Disconnect the bot entirely, then connect it again.
   - **Expect:** «غیرفعال», then «فعال». A conversation that existed before the reconnect
     continues in the same row in the inbox. Record whether Telegram issued a new connection
     id (`OQ-TB-02`): a new row in `telegram_business_connections` with the old one superseded.

## B. A customer message reaches the inbox

1. From the customer's account, write to the business account: «سلام، اینترنتم وصل نمی‌شود».
   - **Expect:** within seconds, a new conversation at the top of `/business-chats`, state
     «هوش مصنوعی فعال» (AI_ACTIVE), with the text as preview and «منتظر پاسخ از» counting.
2. Open it.
   - **Expect:** the message under the customer's origin, in words. The customer is linked by
     exact Telegram id only (if P4 linked it).

## C. The owner typing takes over; our own echo is recognised

1. From the **owner's phone**, reply in that chat.
   - **Expect:** the conversation becomes «در اختیار انسان» (HUMAN_ACTIVE). Takeover reason:
     the owner wrote. «منتظر پاسخ از» clears. The transcript shows the owner's message under
     its own origin.
2. On `/business-chats`, press «سپردن دوباره به هوش مصنوعی» and confirm.
   - **Expect:** AI_ACTIVE again.
3. From the Web Admin as `support`, send «لطفاً برنامه را به‌روزرسانی کنید» (step D sends the
   same way).
   - **Expect:** the message appears in the customer's chat **once**. In the transcript, NEXA's
     own echo of it is labelled as ours, not as the owner typing, and it does **not** take the
     conversation a second time (only the send itself did).
   - **Evidence:** `SELECT origin FROM business_messages WHERE conversation_id = '<id>' ORDER BY sent_at DESC LIMIT 3;`
     The echo is `OWN_ECHO`, not `HUMAN`.

## D. Operator send

1. As `support`, type a reply in the composer and send.
   - **Expect:** the composer says a send is a takeover. The conversation becomes
     HUMAN_ACTIVE. In «پیام‌های ارسالی», the row goes from pending to «ارسال شد».
2. Send the same text again by double-clicking.
   - **Expect:** the customer receives it once (one idempotency key per press).

## E. Assist: capability test, then draft, edit, send (program A5)

**Assist must pass before AUTO_REPLY_SAFE is attempted.** If any E step fails, section F is
NOT RUN, and the failure's class (runbook §11) is recorded in the results table.

Set the mode to `ASSIST_ONLY` on `/support-ai`, with the primary provider from P5 (runbook §1).

0. **The real capability test.** On `/support-ai`, under «کلیدهای ارائه‌دهنده‌ها», type the
   EXACT model id the chain will use into «مدل آزمون» (an API model id, never a ChatGPT
   product name) and press «آزمون اتصال». Repeat for every configured provider.
   - **Expect:** the headline «موفق», and «موفق» on each line: «دسترسی به مدل»,
     «تولید پاسخ ساختاریافته», «اعتبار ساختار تصمیم»; «تصویر» reads «آزمایش نشد» with vision
     off. The provider row's «آخرین آزمون اتصال» reads «موفق».
   - **If it fails:** record the failing line, its «علت», HTTP status and «پارامتر» exactly as
     shown (e.g. «این مدل قابلیت لازم را ندارد», 400, `response_format`). Do not continue to
     E1 with that model.
   - **Evidence:** a screenshot of the four lines, and
     `SELECT operation, model, outcome, failure_class, http_status, provider_error_param, schema_issue_path FROM support_ai_runs WHERE operation = 'CONNECTION_TEST' ORDER BY created_at DESC LIMIT 4;`
1. A real Telegram Business conversation: from the customer's account, write
   «سلام، سرویس من وصل نمیشه.»
2. In that conversation press «درخواست پیش‌نویس».
   - **Expect:** within seconds a READY draft with a concise Persian summary, a usable Persian
     suggested reply, and «بر پایهٔ:» listing what grounded it (a service, or a knowledge
     entry's question). The customer receives **nothing**.
   - **If it fails:** the draft reads «ناموفق» with its «علت» line. Record it, and run the
     second query of runbook §11 for the conversation. A draft failed with
     «سرویس دستیار در حال اجرا نیست» means the `assistant` role is down (runbook §9).
3. Edit the draft's text, then send it once.
   - **Expect:** the customer receives exactly the EDITED text, once. The draft shows as sent.
     The conversation is HUMAN_ACTIVE.
4. Return the conversation to the AI, request another draft and discard it.
   - **Expect:** nothing is sent.
5. On «آمار پشتیبانی», for today:
   - **Expect:** «پیش‌نویس درخواست‌شده» 2, «فرستاده شد» 1, «کنار گذاشته شد» 1,
     «جایگزین با درخواست تازه» 0 (L1: a draft a second «درخواست پیش‌نویس» replaced is counted
     there, never as discarded — if you pressed request twice, both figures say so). Under
     «فراخوانی سرویس‌های هوش مصنوعی», runs with real latencies and token counts.
     «علت خطاهای هوش مصنوعی» lists nothing for the ASSIST_DRAFT operation.

## F. AUTO_REPLY_SAFE — on the TEST tenant only (program A6)

> Only on the tenant from P7. Never on Production without the Product Owner's written approval.
> Run this section only after every step of E passed.

Sign in as `owner` of the TEST tenant. On `/support-ai`, set the mode to `AUTO_REPLY_SAFE`,
allowlist **only** `CONNECTION_TROUBLESHOOTING` (the box «مشکل اتصال» under
«موضوعات مجاز برای پاسخ خودکار»), keep the confidence floor at `HIGH` («زیاد») and the
settle delay at 6 s, and save.

1. **A connection issue gets exactly one automatic reply.** From the customer's account:
   «سلام، سرویس من وصل نمیشه.»
   - **Expect:** about six seconds later, ONE reply from the business account. The transcript
     shows it as an automatic send. «آمار پشتیبانی» → «پاسخ خودکار فرستاده شد» goes up by one.
   - **If it hands off instead:** the handoff in «سپردن‌ها به پشتیبان» shows its reason and,
     for «خروجی هوش مصنوعی معتبر نبود» or «سرویس هوش مصنوعی در دسترس نبود», its «علت» and
     particulars. Record them.
   - **Evidence:** `SELECT outcome, handoff_reason, failure_class FROM support_ai_jobs WHERE conversation_id = '<id>' ORDER BY created_at DESC LIMIT 1;`
2. **A refund request is handed off, with a ticket, and never answered automatically.** From
   the customer: «پولم را پس بدهید».
   - **Expect:** no automatic reply. The conversation is «نیازمند پشتیبان» (HANDOFF_REQUIRED) with
     its reason. A ticket in «تیکت‌های پشتیبانی» with the AI's note (never the customer's words). The
     inbox row carries «تیکت دارد». A notification «گفت‌وگویی منتظر پاسخ یک همکار است» for
     `support`, linking to the conversation.
   - Take the conversation over: the notification resolves. Return it to the AI.
3. **A human speaking within the settle delay wins.** From the customer, ask a connection
   question. **Within six seconds**, reply from the owner's phone.
   - **Expect:** NO automatic reply is sent. The conversation is HUMAN_ACTIVE.
   - **Evidence:** `SELECT outcome FROM support_ai_jobs WHERE conversation_id = '<id>' ORDER BY created_at DESC LIMIT 1;`
     returns `dropped_epoch` (or the lane row is `SUPERSEDED`).
4. **Mode OFF stops it at once.** Set the mode to `OFF`, then ask a connection question.
   - **Expect:** nothing is sent automatically.
5. **No duplicate send.** Set `AUTO_REPLY_SAFE` again. Send one connection question, then
   (before the reply) two more lines quickly.
   - **Expect:** exactly one automatic reply for the three lines; `business_outbound_messages`
     holds one `AUTO` row for that epoch.
6. **No stale reply after stop and resume.** Stop the `assistant` role
   (`docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml stop assistant`),
   send a connection question, wait more than ten minutes, then start it again (`… start assistant`).
   - **Expect:** no automatic reply; the job hands off as `handoff_stale`.
7. **A connection without the reply right fails closed, without a provider call.** In
   Telegram, remove the bot's permission to reply, then send a connection question.
   - **Expect:** no automatic reply; the job is `dropped_connection`; and no new
     `support_ai_runs` row for that conversation (the transcript was never sent to a provider).
   - Allow replying again afterwards.

## G. Vision

With a vision-capable model in the chain (OpenAI or Anthropic; Z.AI is declared blind,
`OQ-TB-30`) and the image option enabled:

1. From the customer, send a screenshot of a connection error, then press
   «درخواست پیش‌نویس».
   - **Expect:** the draft refers to what the image shows. Record whether `getFile` worked on
     business-chat media (`OQ-TB-05`, `OQ-TB-32`).
2. With vision disabled, repeat.
   - **Expect:** the draft says it could not see the image, or hands off. It never pretends to
     have seen it.
3. On the TEST tenant under `AUTO_REPLY_SAFE`, send only a photo.
   - **Expect:** a handoff (`UNSUPPORTED_CONTENT`) unless the image was seen. Never an
     automatic answer about an unseen image.

## H. A provider key rejected: the alert and the fallback

Use the spare key from P5, with that provider as the primary and a second provider as the
fallback.

1. Revoke the spare key in the provider's console, then request a draft.
   - **Expect:** the draft still arrives, from the FALLBACK provider. On `/support-ai`, the
     primary's row shows «کلید رد شده است». A notification «کلید یک سرویس هوش مصنوعی رد شد»
     appears for the `owner`, and NOT for `support`.
2. Replace the key with a valid one (runbook §2) and press «آزمون اتصال».
   - **Expect:** «موفق». The rejection clears and the notification resolves.
3. Optional, with a key whose balance is exhausted: record whether the provider answers 402,
   a `billing_error` or a 400, and attach the raw status (`OQ-TB-20`, `OQ-TB-22`).

## I. Learning: approve and reject

1. In a conversation where `support` sent a good, general answer, press
   «پیشنهاد به‌عنوان دانش» on that reply.
   - **Expect:** a candidate appears in the learning queue (`/support-learning`), with no
     personal data (no phone, card, username or link).
2. As `owner`, approve it, editing the title.
   - **Expect:** an approved article on `/support-knowledge` with source «آموخته از پاسخ‌ها».
3. Propose another, and reject it with a reason.
   - **Expect:** REJECTED. No article is created.
4. Request a draft on a related question.
   - **Expect:** under «بر پایهٔ», the line «دانش پشتیبان:» lists the approved article's
     **title** (D3) — the model cites it by its `K` alias in `knowledgeRefs`, and the server
     shows the title. The rejected candidate's title never appears there, nor anywhere in the
     draft. A draft that cited no knowledge shows no such line; that is not a failure of this
     step unless the reply plainly uses the article's content.
   - **Evidence:** `SELECT knowledge_labels, fact_labels, knowledge_sent, knowledge_available FROM support_ai_jobs WHERE id = '<draft id>';`
     `knowledge_labels` holds the approved title; `knowledge_sent` is at least 1 (D2).

## J. Knowledge build from NEXA: apply and conflict

1. On `/knowledge-build`, run «ساخت دانش از NEXA».
   - **Expect:** proposals from products, client apps, tutorials, FAQ, terms and payment
     methods. No price, no panel and no reseller-only product.
2. Apply all without conflict.
   - **Expect:** articles with source NEXA_BUILD. Running the build again shows them as
     unchanged.
3. Edit one built article by hand. Then change its source (for example, a client app's
   description) and run the build again.
   - **Expect:** that item is a CONFLICT. «اعمال همهٔ موارد بدون تعارض» does not overwrite it.
     Only an explicit choice («جایگزینی با متن ساخته‌شده» or «نگه‌داشتن ویرایش فعلی»)
     resolves it.

## K. Closing checks

1. «آمار پشتیبانی» for today: every figure above is accounted for. No money figure is shown.
2. `/notification-center` as `support`: only «گفت‌وگوهای پشتیبانی» items. As `owner`: both
   support categories.
3. Retention: none of this pack's message text is older than 30 days yet. Schedule a
   re-check of runbook §7's query 31 days later.
4. Set the TEST tenant back to `OFF` unless the Product Owner asked for it to stay on.

## L. Product-flow fixes (2026-10-06) — NOT RUN

Added with the support-AI product-flow fixes (D2, D3, D5, D7, D8, D9, L1–L5). Every step below
needs the real Telegram Business account and real provider keys of the prerequisites, and is
**NOT RUN** until an operator records it. Steps L4 and L6 depend on the `K` aliases of the
runtime-diagnostics branch (the model cites knowledge as `K1`…); run them on a build that has
both.

1. **The echo (D7, OQ-TB-03 #4).** In step C3, record whether Telegram echoed NEXA's own send:
   `SELECT origin, telegram_message_id FROM business_messages WHERE conversation_id = '<id>' ORDER BY sent_at DESC LIMIT 3;`
   - Either answer is acceptable since D7. Then, on the TEST tenant under `AUTO_REPLY_SAFE`,
     ask a connection question, let the automatic reply arrive, and answer «باز کردم، هنوز
     وصل نمیشه».
   - **Expect:** the second reply builds on the first (a next step), not step one again.
     Record the echo answer in OQ-TB-03 #4.
2. **Owner typing (D8).** From the owner's phone, answer a customer's connection question
   with a general instruction. On `/business-chats/<id>`, as `owner`:
   - **Expect:** the owner's row (origin «اپراتور (دستی)», `HUMAN`) carries «پیشنهاد به‌عنوان دانش»; the
     customer's rows do not. Press it: a PENDING candidate appears on `/support-learning`,
     with no phone, card, link or personal handle.
   - As `support` (no `support_knowledge.review`), press it on another owner row.
   - **Expect:** refused with a permission error; the denial is audited.
3. **Money guard (D9).** On the TEST tenant under `AUTO_REPLY_SAFE`, from the customer:
   «سلام، سرویس من وصل نمیشه، پولمو پس بدید».
   - **Expect:** no automatic reply; HANDOFF_REQUIRED with the hard-topic reason (`HANDOFF_TOPIC`); a ticket.
   - **Evidence:** `SELECT outcome, handoff_reason FROM support_ai_jobs WHERE conversation_id = '<id>' ORDER BY created_at DESC LIMIT 1;`
     returns `guard_handoff_topic` / `HANDOFF_TOPIC`, and no `support_ai_runs` row was written
     for it (no provider was asked).
4. **Knowledge reaches the model (D2).** With at least four client apps enabled and ten or more
   approved articles of realistic length, one titled «وصل نمی‌شود» and NOT the most recently
   edited, request a draft on «سرویس من وصل نمیشه».
   - **Evidence:** `SELECT knowledge_sent, knowledge_available, knowledge_labels FROM support_ai_jobs WHERE id = '<draft id>';`
     `knowledge_sent` ≥ 1, and `knowledge_labels` names «وصل نمی‌شود» when the draft cited it.
5. **A stopped assistant (D5).** `docker stop` the `assistant` container. Request a draft (or,
   on the TEST tenant under AUTO, send a connection question) and wait three minutes.
   - **Expect:** a notification «دستیار هوشمند پشتیبانی اجرا نمی‌شود» for `owner`, not for
     `support`. Start the container again: within a minute the alert shows as resolved
     (`support.assistant.running`).
6. **Grounding shown (D3).** Step I4 as rewritten above: the approved article's title under
   «دانش پشتیبان:».
7. **Analytics (L1).** Step E5 as rewritten above, pressing «درخواست پیش‌نویس» twice before
   discarding: «کنار گذاشته شد» 1 and «جایگزین با درخواست تازه» 1.
8. **Payment label (L2).** For a linked customer with a card-to-card payment, request a draft
   that cites it.
   - **Expect:** under «بر پایهٔ», «کارت به کارت 1,500,000 تومان» style — never `MANUAL_TRANSFER`
     or minor units.
9. **Support accounts in the build (L3).** With `support.accounts` set, run «ساخت دانش از NEXA».
   - **Expect:** a SUPPORT_ACCOUNTS proposal that names the handle; an FAQ naming a personal
     handle is still excluded (`after.excluded.kinds` contains `USERNAME`).

## M. Clarifying questions (hotfix 2026-10-06) — NOT RUN

Needs the real Telegram Business account and a real provider key; **NOT RUN** until an operator
records it. On the TEST tenant under `AUTO_REPLY_SAFE` with `CONNECTION_TROUBLESHOOTING` and
`GREETING` allowlisted, the confidence floor `HIGH`, «حداکثر سؤال تکمیلی پیاپی» at 2, and at
least one approved, enabled article about Sing-box connection errors. (Roadmap A1 replaced
«بیشترین پاسخ خودکار پیاپی» with the session budget, default 20, which a greeting never spends;
see section N.)

1. **The conversation.** From the customer, one message at a time, waiting for each answer:

   | Customer             | Expect from the business account                                                                                |
   | -------------------- | --------------------------------------------------------------------------------------------------------------- |
   | «سلام»               | a greeting                                                                                                      |
   | «مشکل در اتصال دارم» | a clarifying question, e.g. «حتماً. با چه برنامه‌ای وصل می‌شید و موقع اتصال چه خطایی می‌بینید؟» — **no ticket** |
   | «Sing-box»           | a second relevant question if one is needed, or already the troubleshooting steps                               |
   | «خطای اتصال میده»    | troubleshooting steps from the approved knowledge                                                               |
   - **Expect:** each message answered once; no handoff and no ticket; the conversation stays
     «هوش مصنوعی فعال».
   - **Evidence:**
     `SELECT decision, outcome, handoff_reason, knowledge_sent FROM support_ai_jobs WHERE kind = 'AUTO_DECISION' AND conversation_id = '<id>' ORDER BY created_at;`
     shows `REPLY/sent`, `ASK_CLARIFYING_QUESTION/sent_clarifying` (once or twice), then
     `REPLY/sent`; `SELECT count(*) FROM tickets WHERE customer_id = '<customer id>'` is unchanged.

2. **The limit.** Set «حداکثر سؤال تکمیلی پیاپی» to 1 and save. Start a new connection
   problem and answer the AI's question vaguely («نمی‌دونم») until it would ask again.
   - **Expect:** at the second question in a row nothing is sent; the conversation is
     «نیازمند پشتیبان» with «سؤال‌های تکمیلی پیاپی هوش مصنوعی به سقف رسید», and a ticket.
   - Return it to the AI: the next customer message is answered like a fresh conversation.
3. **Money still hands off.** «وصل نمیشه، پولمو هم پس بدید» — no automatic reply, `HANDOFF_TOPIC`,
   no provider call (step L3's evidence query).
4. **The widening.** As an `admin` without `support_ai.auto_reply`, raise «حداکثر سؤال تکمیلی
   پیاپی». **Expect:** the warning before saving, and the save refused.
5. Set the limit back to 2.

## N. Session budget, hourly limit, clarifying default (roadmap A1/A2) — NOT RUN

Needs the real Telegram Business account and a real provider key; **NOT RUN** until an operator
records it. On the TEST tenant under `AUTO_REPLY_SAFE` with `CONNECTION_TROUBLESHOOTING` and
`GREETING` allowlisted.

1. **The fields.** Open `/support-ai`. **Expect:** «سقف پاسخ خودکار در هر جلسه» (20, range 5 – 40)
   and «سقف پاسخ خودکار در هر ساعت» (30, range 10 – 60), each with its help text; no
   «بیشترین پاسخ خودکار پیاپی». Type 4 and 41 into the first, 9 and 61 into the second:
   «بازهٔ مجاز» error and the save disabled each time.
2. **The budget.** Set the session budget to 5 and save. From the customer send six connection
   messages, one at a time, each answered before the next. **Expect:** five automatic replies;
   the sixth message is not answered, the conversation is «نیازمند پشتیبان» with «پاسخ‌های خودکار
   جلسه یا ساعت به سقف رسید», a ticket, and `guard_consecutive` in the evidence query of M1.
3. **Greetings are free.** Return it to the AI. Send «سلام» six times, then one connection
   message. **Expect:** seven automatic replies, no handoff.
4. **Inactivity.** Leave a conversation that used part of its budget with no message either way
   for six hours, then write. **Expect:** answered; `sessionReplyCount` would read 1 (the evidence
   query in runbook §13 shows the gap). A conversation silent five hours continues its session.
5. **The hour.** Set the hourly limit to 10 and the budget to 40. Send eleven messages within an
   hour. **Expect:** ten replies, then `guard_window` and a handoff.
6. **The widening.** As an `admin` without `support_ai.auto_reply`, raise either limit.
   **Expect:** the warning before saving, and the save refused; lowering it is saved.
7. **Clarifying default (A2).** On a tenant that never set «حداکثر سؤال تکمیلی پیاپی» it reads 3;
   on one saved earlier at 2, it still reads 2. With 3: three questions in a row are sent, the
   fourth hands off with `CLARIFYING_LIMIT`; a «سلام» answered between questions does not reset
   the count, a real answer does.
8. Set the limits back to 20, 30 and the tenant's previous clarifying limit.

## O. Progress guards, handoff notice and context, NO_ACTION (roadmap A3–A6) — NOT RUN

Needs the real Telegram Business account and a real provider key; **NOT RUN** until an operator
records it. On the TEST tenant under `AUTO_REPLY_SAFE`, `CONNECTION_TROUBLESHOOTING` and
`GREETING` allowlisted.

1. **No progress.** Ask a connection question; after each answer reply «نشد», «هنوز وصل نمیشه»,
   «بازم همونه». **Expect:** three answers, then no fourth; one message from the business
   account: «پیامت برای بررسی دقیق‌تر به پشتیبان منتقل شد. لطفاً همین‌جا ادامه بده؛ نیازی به
   ارسال دوباره نیست.»; «نیازمند پشتیبان» with «مشتری چند بار گفت راهنمایی هوش مصنوعی جواب نداد»,
   and in «سپردن‌ها به پشتیبان» the topic, intent and «پاسخ‌های خودکار این جلسه: ۳».
2. **The notice is sent once.** Keep writing to the handed-off chat. **Expect:** no second notice.
3. **A person first.** Trigger a handoff («پولمو پس بدید») and take the conversation over from the
   Web Admin within a few seconds, before the lane's next pass. **Expect:** no notice (its row
   `SUPERSEDED`). Timing-dependent: record what happened.
4. **Repeated advice.** Hard to provoke on demand; record any `guard_repeated_advice` seen in
   «آمار پشتیبانی» with the two replies.
5. **Flood.** Send «کسی هست؟» three times, waiting for each answer; and separately nine short
   messages within a minute. **Expect:** a handoff with «مشتری پیام تکراری…» each time.
6. **NO_ACTION.** After an answer, write «مرسی، حل شد». **Expect:** no reply, no notice, no ticket,
   the chat stays «هوش مصنوعی فعال»; «بی‌پاسخ بسته شد» in the analytics; the next question is
   answered.
7. **Template.** Edit `bot.support.handoff_notice` in `/templates`, trigger a handoff. **Expect:**
   the edited text.

## Results

Mark each step **PASS**, **FAIL** or **NOT RUN**. A step that was not executed is NOT RUN,
never PASS. The A5/A6 rows below were NOT RUN in the sandbox this release was built in: it has
no real provider key and no Telegram Business account (program §0).

| Step                                                      | PASS / FAIL / NOT RUN | Time (UTC) | Evidence | Notes (OQ to update)                          |
| --------------------------------------------------------- | --------------------- | ---------- | -------- | --------------------------------------------- |
| A1–4                                                      | NOT RUN               |            |          | OQ-TB-02                                      |
| B1–2                                                      | NOT RUN               |            |          |                                               |
| C1–3                                                      | NOT RUN               |            |          | OQ-TB-03, OQ-TB-19                            |
| D1–2                                                      | NOT RUN               |            |          |                                               |
| E0 capability test (each provider)                        | NOT RUN               |            |          | OQ-TB-20; record each line's result and «علت» |
| E1 real conversation                                      | NOT RUN               |            |          |                                               |
| E2 draft: summary, Persian reply, grounding, nothing sent | NOT RUN               |            |          |                                               |
| E3 edit and send once                                     | NOT RUN               |            |          |                                               |
| E4 discard another draft                                  | NOT RUN               |            |          |                                               |
| E5 analytics: requested / sent / discarded                | NOT RUN               |            |          |                                               |
| F1 connection issue → exactly one auto reply              | NOT RUN               |            |          | OQ-TB-47                                      |
| F2 refund → handoff and ticket, no auto reply             | NOT RUN               |            |          |                                               |
| F3 human within settle delay → no auto reply              | NOT RUN               |            |          | OQ-TB-03                                      |
| F4 mode OFF → immediate stop                              | NOT RUN               |            |          |                                               |
| F5 no duplicate send                                      | NOT RUN               |            |          |                                               |
| F6 no stale reply after stop/resume                       | NOT RUN               |            |          |                                               |
| F7 no `can_reply` → fails closed, no provider call        | NOT RUN               |            |          |                                               |
| G1–3                                                      | NOT RUN               |            |          | OQ-TB-05, OQ-TB-32                            |
| H1–3                                                      | NOT RUN               |            |          | OQ-TB-20, OQ-TB-22                            |
| I1–4                                                      | NOT RUN               |            |          |                                               |
| J1–3                                                      | NOT RUN               |            |          |                                               |
| K1–4                                                      | NOT RUN               |            |          |                                               |
| L1 echo observation (D7, OQ-TB-03 #4)                     | NOT RUN               |            |          | OQ-TB-03                                      |
| L2 owner typing → propose as knowledge (D8)               | NOT RUN               |            |          |                                               |
| L3 money guard (D9)                                       | NOT RUN               |            |          |                                               |
| L4 knowledge reaches the model (D2)                       | NOT RUN               |            |          |                                               |
| L5 stopped assistant alert and recovery (D5)              | NOT RUN               |            |          |                                               |
| L6 grounding shown (D3)                                   | NOT RUN               |            |          |                                               |
| L7 analytics superseded vs discarded (L1)                 | NOT RUN               |            |          |                                               |
| L8 Persian payment label (L2)                             | NOT RUN               |            |          |                                               |
| L9 support accounts in the build (L3)                     | NOT RUN               |            |          |                                               |
| M1 greeting → question → question → grounded answer       | NOT RUN               |            |          |                                               |
| M2 clarifying limit hands off, resume starts fresh        | NOT RUN               |            |          |                                               |
| M3 money still hands off before the provider              | NOT RUN               |            |          |                                               |
| M4 raising the limit is the owner's widening              | NOT RUN               |            |          |                                               |
| N1 the two fields, bounds in Persian                      | NOT RUN               |            |          |                                               |
| N2 session budget of 5 hands off the sixth                | NOT RUN               |            |          |                                               |
| N3 greetings never spend the budget                       | NOT RUN               |            |          |                                               |
| N4 six hours of inactivity start a new session            | NOT RUN               |            |          |                                               |
| N5 hourly limit hands off                                 | NOT RUN               |            |          |                                               |
| N6 raising a limit is the owner's widening                | NOT RUN               |            |          |                                               |
| N7 clarifying default 3; stored 2 kept; greeting no reset | NOT RUN               |            |          |                                               |
| O1 three «نشد» hand off, notice once, context shown       | NOT RUN               |            |          |                                               |
| O2 no second notice in one handoff                        | NOT RUN               |            |          |                                               |
| O3 a person first → no notice                             | NOT RUN               |            |          |                                               |
| O4 repeated advice observed                               | NOT RUN               |            |          |                                               |
| O5 same message ×3 / nine in a minute hand off            | NOT RUN               |            |          |                                               |
| O6 «مرسی، حل شد» ends silently                            | NOT RUN               |            |          |                                               |
| O7 the notice template override is what is sent           | NOT RUN               |            |          |                                               |

Sign-off:

- Operator (name, date):
- Product Owner, for section F and for any Production `AUTO_REPLY_SAFE` (name, date):
