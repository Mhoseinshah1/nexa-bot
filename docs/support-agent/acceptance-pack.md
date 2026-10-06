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

## E. Assist: draft, edit, send

Set the mode to `ASSIST_ONLY` on `/support-ai`, with the primary provider from P5 (runbook §1).

1. Press «آزمون اتصال» on each configured provider.
   - **Expect:** «موفق». Record the model id used.
2. In a conversation where the customer asked a connection question, press
   «درخواست پیش‌نویس».
   - **Expect:** a draft within seconds, with a summary, a suggested reply and what it was
     based on. The customer receives **nothing**.
3. Edit the draft's text, then send it.
   - **Expect:** the customer receives exactly the EDITED text, once. The draft shows as sent.
     The conversation is HUMAN_ACTIVE.
4. Request another draft and discard it.
   - **Expect:** nothing is sent.
5. On «آمار پشتیبانی», for today:
   - **Expect:** «پیش‌نویس درخواست‌شده» 2, «فرستاده شد» 1, «کنار گذاشته شد» 1. Under
     «فراخوانی سرویس‌های هوش مصنوعی», runs with real latencies and token counts.

## F. AUTO_REPLY_SAFE — on the TEST tenant only

> Only on the tenant from P7. Never on Production without the Product Owner's written approval.

Sign in as `owner` of the TEST tenant. On `/support-ai`, set the mode to `AUTO_REPLY_SAFE`,
allowlist **only** `CONNECTION_TROUBLESHOOTING` (the box «مشکل اتصال» under
«موضوعات مجاز برای پاسخ خودکار»), keep the confidence floor at `HIGH` («زیاد») and the
settle delay at 6 s, and save.

1. **A safe topic is answered automatically.** From the customer's account: «اپ وصل نمی‌شود،
   چه کنم؟».
   - **Expect:** about six seconds later, ONE reply from the business account. The transcript
     shows it as an automatic send. «آمار پشتیبانی» → «پاسخ خودکار فرستاده شد» goes up by one.
2. **A hard topic is handed off, with a ticket.** From the customer: «پولم را پس بدهید».
   - **Expect:** no automatic reply. The conversation is «نیازمند پشتیبان» (HANDOFF_REQUIRED) with
     its reason. A ticket in «تیکت‌های پشتیبانی» with the AI's note (never the customer's words). The
     inbox row carries «تیکت دارد». A notification «گفت‌وگویی منتظر پاسخ یک همکار است» for
     `support`, linking to the conversation.
   - Take the conversation over: the notification resolves. Return it to the AI.
3. **A human typing during the settle delay wins.** From the customer, ask a connection
   question. **Within six seconds**, reply from the owner's phone.
   - **Expect:** NO automatic reply is sent. The conversation is HUMAN_ACTIVE.
   - **Evidence:** `SELECT outcome FROM support_ai_jobs WHERE conversation_id = '<id>' ORDER BY created_at DESC LIMIT 1;`
     returns `dropped_epoch` (or the lane row is `SUPERSEDED`).
4. **Turning it off stops it at once.** Set the mode to `OFF`, then ask a connection question.
   - **Expect:** nothing is sent automatically.

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

## Results

| Step | Pass / Fail / Not run | Time (UTC) | Evidence | Notes (OQ to update) |
| ---- | --------------------- | ---------- | -------- | -------------------- |
| A1–4 |                       |            |          | OQ-TB-02             |
| B1–2 |                       |            |          |                      |
| C1–3 |                       |            |          | OQ-TB-03, OQ-TB-19   |
| D1–2 |                       |            |          |                      |
| E1–5 |                       |            |          | OQ-TB-20             |
| F1–4 |                       |            |          | OQ-TB-47             |
| G1–3 |                       |            |          | OQ-TB-05, OQ-TB-32   |
| H1–3 |                       |            |          | OQ-TB-20, OQ-TB-22   |
| I1–4 |                       |            |          |                      |
| J1–3 |                       |            |          |                      |
| K1–4 |                       |            |          |                      |

Sign-off:

- Operator (name, date):
- Product Owner, for section F and for any Production `AUTO_REPLY_SAFE` (name, date):
