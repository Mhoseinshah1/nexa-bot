# Intelligent Support Agent — operator runbook

For the person running a NEXA installation with the support agent (TB1–TB10). Each section is
a situation, what you see, and what to do. Nothing here needs a code change.

Conventions used below:

- **Web Admin pages.** «گفتگوهای تلگرام بیزینس» is `/business-chats`, «دستیار هوشمند
  پشتیبانی» is `/support-ai`, «آمار پشتیبانی» is `/support-analytics` and «مرکز اعلان‌ها»
  is `/notification-center`.
- **`psql` (read-only).** Every query here is a `SELECT`. It is run as

  ```bash
  docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml \
    exec -T postgres psql -U nexa -d nexa -c "<the query>"
  ```

  Never `UPDATE` a support table by hand. Every state change is a conditional write with its
  own audit and its own lock, and a hand edit skips all three.

- **Who may act.** Changing the mode, the chain or a key needs `support_ai.configure`
  (owner and admin). Entering `AUTO_REPLY_SAFE`, adding an automatic topic or lowering the
  confidence floor needs `support_ai.auto_reply` (owner only), and so does raising a limit
  under `AUTO_REPLY_SAFE` — «بیشترین پاسخ خودکار پیاپی», «حداکثر سؤال تکمیلی پیاپی», the reply
  length — or shortening its delays. Taking a conversation over or
  replying needs `business_chats.reply`.

## 0. What the alerts mean

The support agent raises five conditions. Each is deduplicated, closed by its own recovery,
and shown in the notification inbox (TB10) as well as on `/alerts` and in the ops group's
SYSTEM topic.

| Code                                      | Inbox category                     | Who sees it            | Closed by                                                                        |
| ----------------------------------------- | ---------------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `support.handoff_required`                | گفت‌وگوهای پشتیبانی (`SUPPORT`)    | `business_chats.view`  | a person taking the conversation, or returning it to the AI                      |
| `support.business_connection.unusable`    | گفت‌وگوهای پشتیبانی (`SUPPORT`)    | `business_chats.view`  | the connection being enabled again with `can_reply`, or replaced                 |
| `support.ai_provider.credential_rejected` | هوش مصنوعی پشتیبانی (`SUPPORT_AI`) | `support_ai.configure` | the provider answering `OK` with that key, or the key being replaced or removed  |
| `support.ai_provider.unavailable`         | هوش مصنوعی پشتیبانی (`SUPPORT_AI`) | `support_ai.configure` | any provider in the chain answering again                                        |
| `support.assistant.stalled`               | هوش مصنوعی پشتیبانی (`SUPPORT_AI`) | `support_ai.configure` | the `assistant` role completing a pass of its loop (`support.assistant.running`) |

A handoff alert links to the conversation. The others link to the page that acts on them.

## 1. Enabling Assist

Assist drafts a reply. A person edits it and sends it. Nothing is sent by itself.

1. Check the `assistant` role is healthy (§9): `botctl status` lists it, and
   `botctl logs assistant` shows no restart loop.
2. On `/support-ai`, under «کلیدهای ارائه‌دهنده‌ها», add a key for at least one provider. The
   key is written once and never shown again, not even masked.
3. Press «آزمون اتصال» with the EXACT model id you intend to use. The test is a capability
   test (§11): it lists the model, then sends the same request Assist and automatic replies
   send — the real system prompt, NEXA's decision schema as strict structured output, the
   same output-token budget — over a fixed synthetic conversation with no customer data, and
   parses the answer as a draft would be parsed. Expect «موفق» on every line:
   «دسترسی به مدل», «تولید پاسخ ساختاریافته», «اعتبار ساختار تصمیم» (and «تصویر» when vision
   is on). «موفق» on the first line alone is NOT readiness: a model that can be listed but
   rejects structured output fails the second line, with its reason. A rejected key shows
   «کلید رد شده است» on that row. A test costs one model lookup and one or two small
   generations; pressing again after an answer is a new test, a lost answer re-asked is not,
   and a provider's key can be tested at most once every 30 seconds («... پس از ۳۰ ثانیه دوباره امتحان کنید»).
   The decision-schema check is STRICT, exactly as an automatic reply is parsed (Assist drafts
   tolerate an over-long operator note or a malformed citation; automatic replies do not).
4. In «پیکربندی», choose the primary provider and model (and optionally up to two
   fallbacks), set the mode to `ASSIST_ONLY` and save.
5. Grant `support_ai.assist` to the roles that should ask for drafts. The seeded `support` and
   `admin` roles already have it.
6. Open any conversation and press «درخواست پیش‌نویس». A draft appears within seconds.

To stop Assist, set the mode back to `OFF`. Open drafts stay readable but nothing new is
produced.

## 2. Rotating a provider key

A provider key is set and replaced, and never read back.

1. Create the new key in the provider's console. Keep the old one valid for now.
2. On `/support-ai`, on that provider's row, press «جایگزینی کلید», paste the new key and
   save. The replacement is immediate for every role: the next call reads the new key.
3. Press «آزمون اتصال». Expect «موفق».
4. Revoke the old key in the provider's console.

The breaker and any rejection are bound to the key's version. A call still in flight with the
old key can neither trip nor reject the new one. Replacing a rejected key closes
`credential_rejected` at once.

**Envelope keys (KEK).** Provider keys are encrypted under the installation's secret key and
registered for rotation (`support_ai_provider.api_key`). `botctl secrets rewrap` re-encrypts
them with the rest. See `docs/deployment.md`.

## 3. A provider outage

**You see:**

- On `/support-ai`, the provider's row shows «موقتاً کنار گذاشته شده» (breaker `OPEN`) with a
  time, or «در انتظار یک آزمون دوباره» (`HALF_OPEN`), and «خطای پیاپی» ≥ 3.
- If every provider is failing, a red banner «هیچ سرویس هوش مصنوعی پاسخ نمی‌دهد», and a
  `support.ai_provider.unavailable` notification.

**What NEXA does by itself:**

- Three transient failures in a row (rate limit, timeout, 5xx, a proxy page) open the
  provider's breaker for five minutes. The chain skips it and uses the next step.
- After five minutes ONE caller probes it. An `OK` closes the breaker. A failure re-opens it.
- With no provider answering, Assist drafts fail («این بار پیش‌نویسی آماده نشد»). Every automatic job
  hands off (`AI_UNAVAILABLE`) and a person answers. Nothing is queued to be sent later, and
  **the customer is sent nothing at all** — no automatic «a colleague will answer» message
  exists. They wait, in silence, for a person.

**What to do:**

1. Check the provider's status page. If it is a regional outage, add or move a fallback step
   to another provider on `/support-ai` and save.
2. If the mode is `AUTO_REPLY_SAFE` and the outage is long, consider `ASSIST_ONLY` (§8). What
   staying in AUTO costs: every conversation a customer writes in while it is `AI_ACTIVE` is
   handed off — one escalation record, one `support.handoff_required` alert in the inbox, the
   ops group and `/alerts`, and, for a linked NEXA customer, a ticket opened (or their active
   ticket linked; an unlinked peer gets none, `OQ-TB-40`). The conversation then stays
   `HANDOFF_REQUIRED`, so later messages in it raise nothing more until a person returns it to
   the AI — and returning it during the outage hands it off again on the next message.
   `ASSIST_ONLY` raises none of this: conversations stay `AI_ACTIVE`, and a person answers
   from the inbox.
3. Watch «آمار پشتیبانی» → «فراخوانی سرویس‌های هوش مصنوعی»: `TIMEOUT`/`TEMPORARY` falling
   back to `OK` is the recovery.

## 4. A credential-rejected alert

**You see:** a `SUPPORT_AI` notification «کلید یک سرویس هوش مصنوعی رد شد». On `/support-ai`,
the row is marked «کلید رد شده است», with «رد کلید در» set.

**Meaning:** the provider answered `AUTH_FAILED`. The key was revoked, is wrong, or (when the
alert says `quota`) the account has no credit. Unlike an outage, this is not retried into
health: the chain falls back to the next step on every call until someone acts.

**What to do:**

1. Open the provider's console. Is the key revoked? Has the billing run out?
2. Either top up and press «آزمون اتصال» (an `OK` closes the alert), or replace the key (§2),
   or delete it to take the provider out of the chain.
3. If the provider was the only step, Assist and automatic replies are effectively off until
   then. Every automatic job hands off, at the cost described in §3 step 2.

## 5. A stuck outbound lane (UNCONFIRMED rows)

**Background.** Every message NEXA sends as the business account goes through the outbound
lane, which runs in the `worker` role. A send is stamped BEFORE the Telegram call. A stamped
row with no recorded answer becomes `UNCONFIRMED` after five minutes, and is **never resent**.
Telegram may have delivered it, and a second send would be a duplicate in the customer's chat.

**You see:**

- In a conversation's «پیام‌های ارسالی» card, a row «نامشخص — دوباره ارسال نمی‌شود» (UNCONFIRMED).
- For an automatic reply, the conversation is handed off (`SEND_OUTCOME_UNKNOWN`) with a
  `support.handoff_required` alert, and a ticket when the customer is a linked NEXA customer.

**What to do:**

1. Open the conversation and look at the customer's Telegram chat on the business account. If
   the message is there, nothing is needed. If it is not, write it again yourself: your
   message is a human takeover.
2. If many rows are stuck, check the worker: `botctl status`, then `botctl logs worker`. Look
   for `business-outbound` and for Telegram errors.
3. To count them:

   ```sql
   SELECT state, origin, count(*) FROM business_outbound_messages
    WHERE created_at > now() - interval '1 day' GROUP BY 1, 2 ORDER BY 1, 2;
   ```

   `PENDING` rows that are not decreasing mean the worker is not claiming. `UNCONFIRMED` rows
   that keep appearing mean Telegram calls are timing out from this host.

Never set an `UNCONFIRMED` row back to `PENDING`. That is exactly the duplicate the state
exists to prevent.

## 6. A disconnect and reconnect

**You see:** a `support.business_connection.unusable` notification. On `/business-chats`,
«اتصال‌های تلگرام بیزینس» shows «غیرفعال» or «بدون اجازه پاسخ». Each affected conversation in the inbox
shows the connection badge.

**Meaning:** the business account owner disconnected the bot in Telegram (Settings → Telegram
Business → Chatbots), or removed its permission to reply. NEXA sends nothing through that
connection. Queued sends are refused (not lost silently), and automatic jobs drop
(`dropped_connection`).

**What to do:**

1. Ask the account owner to reconnect the bot, with **«پاسخ به پیام‌ها»** (`can_reply`)
   allowed.
2. Telegram reports the change. The connection returns to «فعال», the alert closes, and the
   existing conversations continue: they are keyed by the bot, the owner and the chat, not by
   the connection id.
3. Messages that arrived while disconnected are not delivered to the bot by Telegram. If a
   customer wrote meanwhile, answer from the phone.

## 7. Purging and retention

What a customer wrote is kept for 30 days, then the text is purged. The rows stay so the
history of who spoke and when is still readable.

| What                                                        | Kept                                                            | Purged by                                |
| ----------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------- |
| Message text and photo references (`business_messages`)     | 30 days after sending; at once when Telegram reports a deletion | the outbound loop's sweep (`worker`)     |
| Outbound bodies (`business_outbound_messages`)              | 30 days after the row was resolved                              | the same sweep                           |
| Handoff notes (`business_conversation_escalations.summary`) | 30 days                                                         | the same sweep                           |
| Draft text: summary, reply, labels (`support_ai_jobs`)      | 30 days                                                         | the assistant loop's sweep (`assistant`) |
| Learning candidate text, pending ones too (`OQ-TB-56`)      | 30 days                                                         | the same sweep                           |
| Telemetry (`support_ai_runs`, image outcomes)               | kept: no text, no prompt, no response                           | —                                        |
| Approved knowledge                                          | until a reviewer retires it                                     | never automatically                      |

No prompt and no provider response is ever stored. A message the customer deletes in Telegram
loses its text in NEXA as soon as Telegram reports the deletion.

To check the sweep is keeping up:

```sql
SELECT count(*) FROM business_messages
 WHERE text IS NOT NULL AND sent_at < now() - interval '31 days';
```

The count should be 0. A growing number means the worker is not running the sweep (§5 step 2).
The draft and learning sweeps need the `assistant` role (§9).

## 8. Disabling AI in an emergency (mode OFF)

When the AI says something it must not, or anything about it is in doubt:

1. On `/support-ai`, set the mode to **`OFF`** and save. Leaving `AUTO_REPLY_SAFE` needs only
   `support_ai.configure`. Turning safety on is never harder than turning it off.
2. The change applies at once, everywhere:
   - pending automatic jobs drop (`dropped_mode`);
   - automatic replies already queued on the lane are refused at the final send check, which
     re-reads the mode under the conversation's lock;
   - new draft requests are refused.
3. Take over any conversation where a reply already went out, and answer it yourself.
4. Read what happened on «آمار پشتیبانی» (sent, handed off, dropped) and in the conversations
   themselves.

If the Web Admin itself is unreachable, stop the `assistant` role (§9). With no assistant,
nothing new is produced. Rows already queued are still checked against the mode by the worker,
so also set `OFF` as soon as the Web Admin is back.

## 9. The assistant process role is unhealthy

**Background.** `assistant` is the sixth process role, from the same image. It is the only one
that calls an AI provider in the background (drafts, automatic decisions, learning
extraction). It is deliberately NOT required for `botctl update` readiness. A dead assistant
costs drafts and automatic replies, never money, a delivered service or a customer message
already queued.

**You see:**

- A notification «دستیار هوشمند پشتیبانی اجرا نمی‌شود» (`support.assistant.stalled`, D5). The
  WORKER raises it when an Assist draft or an automatic job has been due for 120 s
  (`SUPPORT_ASSISTANT_STALL_SECONDS`) with no live lease while no job is leased at all — the
  assistant's own heartbeat is a file inside its container, which no other role can read, so
  the watch reads the work it leaves undone. It closes by itself when the assistant completes
  a pass of its loop (`support.assistant.running`). A job under a live lease is a busy
  assistant, not a dead one, and raises nothing.
- `botctl status` shows `assistant` unhealthy or restarting.
- A requested draft keeps saying «دستیار در حال نوشتن پیش‌نویس است».
- Under `AUTO_REPLY_SAFE`, customers get no automatic answer. «آمار پشتیبانی» shows
  «هنوز در صف» growing.

**What to do:**

1. `botctl logs assistant`. Look for a configuration error at start (a missing secret, an
   unreachable database), or repeated provider timeouts.
2. Its health is a heartbeat file written every `WORKER_HEARTBEAT_INTERVAL_MS`. A loop stuck
   on a long provider call stops writing it. The default provider timeout bounds every call.
3. Restart only the assistant:

   ```bash
   docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml \
     restart assistant
   ```

   A job claimed by the dead process is reclaimed when its lease expires. A job whose first
   three claims all died without a result is failed on the next claim: as a draft,
   «این بار پیش‌نویسی آماده نشد»; as an automatic job, a handoff.

4. If it cannot be made healthy and automatic replies are on, set the mode to `ASSIST_ONLY` or
   `OFF` (§8) so customers are handed to people instead of waiting.

**Capacity under a burst (L5, an operational note — not a defect being fixed).** One
`assistant` replica produces jobs strictly one at a time: each pass claims up to four
(`ASSIST_BATCH`) every 2 s, and each job waits for its provider call. At 10–30 s per call that
is roughly 2–6 jobs a minute. The bounds that then apply:

- an automatic job produced more than 600 s (`SUPPORT_AI_AUTO_STALE_SECONDS`) after it fell
  due is not answered: it hands off as `REPLY_STALE` (`handoff_stale`). A burst of more than
  about 20–60 customer messages arriving together under `AUTO_REPLY_SAFE` therefore ends with
  the late ones handed to a person;
- an Assist draft waiting more than 300 s with no live lease (`SUPPORT_AI_DRAFT_UNCLAIMED_SECONDS`)
  is failed `job.unclaimed`, so an operator who requested one behind a long queue sees
  «ناموفق» and requests again;
- `support.assistant.stalled` (D5) does NOT fire while a job holds a live lease: a busy
  assistant is not a dead one. A burst shows instead as `handoff_stale` in «آمار پشتیبانی» and
  as a growing «هنوز در صف».

Nothing is lost: every late job hands off or fails visibly, and none is sent late. What helps
is a faster model or a shorter provider timeout (§1, «پیکربندی»), and during an announced
outage switching to `ASSIST_ONLY` (§8). The claim is replica-safe (`FOR UPDATE SKIP LOCKED`,
tested with two replicas in `support-assist.test.ts`), but running more than one `assistant`
replica is not a `botctl` operation and has not been accepted on a real installation.

## 10. Reading «آمار پشتیبانی»

- **Snapshots** (now, whatever the period): conversations by state, knowledge by source.
- **Counted in the period**, half-open `[start, end)` in the tenant's timezone and calendar:
  handoffs by reason, automatic jobs, Assist drafts, provider calls, learning candidates.
- **Cost is not computed** (`OQ-TB-07`). Multiply the token columns by your provider's
  current price if you need a figure.
- «پاسخ خودکار فرستاده شد» counts jobs that queued a reply. The lane's final check may still
  have superseded it, if a person spoke first. «بی‌اقدام کنار رفت» is not a failure: a person
  intervened, a newer message replaced the job, or the mode changed.

## 11. Why the AI did not answer: diagnostics

A customer whose conversation the AI could not answer is handed to a person, and is never
shown an error. The handoff reason stays coarse — «خروجی هوش مصنوعی معتبر نبود»
(`AI_OUTPUT_INVALID`) or «سرویس هوش مصنوعی در دسترس نبود» (`AI_UNAVAILABLE`) — and beside it NEXA
records the exact **class** of the failure, the deciding provider call's provider, model,
position in the chain, latency, tokens and HTTP status, the provider's own error code, type
and parameter (short machine identifiers only), and, for an answer that failed NEXA's
decision schema, the field and the rule it broke. Never the prompt, the model's answer, the
provider's message or a key.

### Where to read it

| Where                                                  | What it shows                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `/support-ai` → «آزمون اتصال»                          | each check, its result, and for a failed one its class and particulars       |
| `/support-ai` → the provider row → «آخرین آزمون اتصال» | the last test's outcome and, when not OK, its class                          |
| A conversation → «دستیار هوشمند» → a failed draft      | «علت»: the class, then provider, model, HTTP status, error type/param, field |
| A conversation → «سپردن‌ها به پشتیبان»                 | the same, under an `AI_OUTPUT_INVALID` / `AI_UNAVAILABLE` handoff            |
| «آمار پشتیبانی» → «علت خطاهای هوش مصنوعی»              | failed calls in the period, by class, operation and provider                 |

### The classes, and what to do

| Class (`failure_class`)  | Persian label                             | Usually means                                                                                                   | Do                                                                       |
| ------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `unsupported_capability` | این مدل قابلیت لازم را ندارد              | the model refuses strict structured output (`param: response_format`), a `system` message, or a parameter       | choose a model that supports structured outputs; re-run «آزمون اتصال»    |
| `request_rejected`       | ارائه‌دهنده درخواست را رد کرد             | HTTP 400/404/422: a mistyped model id (`model_not_found`), an output limit the model does not allow             | read the code/param; fix the model id; re-run the test                   |
| `auth`                   | کلید رد شد                                | 401/403                                                                                                         | §4                                                                       |
| `quota`                  | اعتبار یا سهمیهٔ حساب تمام شده است        | no balance or quota on the provider account                                                                     | top up the provider account                                              |
| `rate_limited`           | محدودیت تعداد درخواست                     | 429 that is not quota                                                                                           | wait; the chain falls back meanwhile                                     |
| `timeout`                | پاسخ در مهلت نرسید                        | no answer within «مهلت هر درخواست»                                                                              | §3; consider a longer timeout                                            |
| `network`                | خطای شبکه                                 | no HTTP answer, or a 2xx that was not JSON (a proxy page)                                                       | check the server's egress (§3)                                           |
| `provider_error`         | خطای سرور ارائه‌دهنده                     | 408/409/5xx/529                                                                                                 | §3                                                                       |
| `refused`                | ارائه‌دهنده پاسخ را رد کرد (پالایش محتوا) | the provider's refusal or content filter                                                                        | nothing: a person answers                                                |
| `no_content`             | پاسخ خالی بود                             | a 2xx with no text                                                                                              | re-run the test; if it repeats, change model                             |
| `truncated`              | پاسخ ناقص ماند (سقف توکن خروجی)           | the answer hit the output-token limit (a reasoning model thinking at length)                                    | lower «بیشترین طول پاسخ (نویسه)», or choose a non-reasoning model        |
| `not_json`               | پاسخ JSON نبود                            | the model ignored the output format                                                                             | change model                                                             |
| `schema_invalid`         | ساختار تصمیم نامعتبر بود                  | JSON that is not NEXA's decision; «بخش نامعتبر تصمیم» names the field (e.g. `topic`, `factRefs.0`)              | re-run the test; if it repeats with one field, report it with that field |
| `reply_too_long`         | پاسخ طولانی‌تر از حد مجاز بود             | the reply exceeded «بیشترین طول پاسخ (نویسه)» (the test, and automatic replies; Assist shows it with a warning) | raise the limit, or accept the handoff                                   |
| `no_provider`            | هیچ ارائه‌دهنده‌ای قابل فراخوانی نبود     | no key, every breaker open, or the mode is OFF                                                                  | §3, §4                                                                   |

A job that failed for a reason that is not the AI — the `assistant` role not running
(«سرویس دستیار در حال اجرا نیست», `job.unclaimed`, §9), an empty transcript — carries no
class; the draft panel says that reason in words instead.

### From the database (read-only)

```sql
-- The last failed calls, with their class and particulars (no text is stored).
SELECT created_at, operation, provider, model, attempt_index, outcome, failure_class,
       http_status, provider_error_code, provider_error_type, provider_error_param,
       schema_issue_path, schema_issue_code, latency_ms, input_tokens, output_tokens
  FROM support_ai_runs
 WHERE outcome <> 'OK'
 ORDER BY created_at DESC
 LIMIT 20;

-- One handed-off conversation: the job's class and its deciding call.
SELECT j.id, j.outcome, j.handoff_reason, j.failure_class,
       r.provider, r.model, r.http_status, r.provider_error_param, r.schema_issue_path
  FROM support_ai_jobs j
  LEFT JOIN LATERAL (
    SELECT * FROM support_ai_runs r
     WHERE r.tenant_id = j.tenant_id AND r.job_id = j.id
     ORDER BY r.created_at DESC, r.attempt_index DESC LIMIT 1
  ) r ON true
 WHERE j.conversation_id = '<conversation id>'
 ORDER BY j.created_at DESC;
```

A run recorded before this release has no class (`failure_class` is null); its
`failure_code` (`openai.http_400`, `openai.truncated`, …) still says roughly the same thing.

## 12. Clarifying questions and their limit (hotfix 2026-10-06)

Under `AUTO_REPLY_SAFE` the AI may ask the customer a clarifying question on an allowlisted
topic («با چه برنامه‌ای وصل می‌شید؟») instead of handing off, when every guard passes. A
question is shown in «آمار پشتیبانی» as «سؤال تکمیلی فرستاده شد» (`sent_clarifying`), apart
from an answer («فرستاده شد», `sent`), and opens no ticket.

- **The limit.** «حداکثر سؤال تکمیلی پیاپی» on `/support-ai` (default 2, 1–10) is how many
  questions in a row the AI may send before a person continues. The count runs from the AI's
  last automatic answer; a customer's reply does not reset it, an AI answer does, and a
  takeover or «سپردن دوباره به هوش مصنوعی» starts a new count. A refused or superseded send is
  never counted.
- **At the limit** the conversation is handed off with «سؤال‌های تکمیلی پیاپی هوش مصنوعی به سقف
  رسید» (`CLARIFYING_LIMIT`, outcome `guard_clarifying_limit`) and a ticket, like any handoff.
  Nothing more is sent to the customer automatically.
- **If customers are handed off at the limit too often**, read the conversations first: a model
  that keeps asking where an approved article answers needs better knowledge (TB8/TB9), not a
  higher limit. Raising the limit under `AUTO_REPLY_SAFE` needs `support_ai.auto_reply`.
- **From the database (read-only)**, a conversation's automatic decisions in order:

  ```sql
  SELECT j.created_at, j.decision, j.outcome, j.handoff_reason, o.state AS lane_state, o.control_epoch
    FROM support_ai_jobs j
    LEFT JOIN business_outbound_messages o ON o.tenant_id = j.tenant_id AND o.id = j.sent_outbound_id
   WHERE j.kind = 'AUTO_DECISION' AND j.conversation_id = '<conversation id>'
   ORDER BY j.created_at;
  ```

## 14. Conversation memory and knowledge selection (A7, A8 — 2026-10-07)

- **What the AI reads.** The latest 40 lines of the conversation (60 are read so every reply in
  the window is placed), each cut to 1,500 characters. Every support-side line is marked with who
  wrote it — a person, an automatic AI reply, an AI draft a person sent, an automatic message —
  so the AI does not repeat its own earlier step as if it were new, and does not contradict what
  a person on the team said. Nothing new is stored: the transcript is read from the messages each
  time, and follows their 30-day retention.
- **Which knowledge goes with a request.** At most eight approved, enabled articles (and live FAQ
  entries) that MATCH the conversation: the customer's latest words, the last intent and topic,
  the titles an earlier draft cited, and — while a troubleshooting episode is open — the
  customer's earlier description of the problem. An article that matches nothing is never sent,
  so a greeting carries no knowledge at all.
- **If the AI keeps missing an article that exists**, look at its title and tags first: the
  match is lexical (Persian spelling variants and a few inflections are folded, no embeddings). A
  title in the words customers actually write («وصل نمی‌شود», «قطعی») is found; a title like
  «راهنمای شماره ۳» is not. `knowledge_sent` on the job says how many entries went with the request:

  ```sql
  SELECT created_at, kind, decision, topic, knowledge_sent, knowledge_available, knowledge_labels
    FROM support_ai_jobs
   WHERE conversation_id = '<conversation id>'
   ORDER BY created_at;
  ```

  `knowledge_sent = 0` with `knowledge_available > 0` means nothing matched — rewrite the
  article's title or tags (TB8 review), never widen anything in configuration.

- **Policy version.** Telemetry records `sai4m-2026-10-07` (or later) for requests built with
  these rules.
- **Prompt size and cost.** The transcript the model reads doubled (20 → 40 lines) and the
  context grew (16 → 24 KiB). The bounds, in the worst case: the transcript is at most 24,000
  characters of line text plus NEXA's markers (about 48 KB of Persian UTF-8; 40 × 1,500 would
  have been 60,000), and the context 24 KiB, so a request carries at most about 75 KB besides the
  fixed policy (about 9 KB) and any images. A typical conversation is far smaller: the transcript
  is what was actually said. Expect the input tokens per request to rise roughly in proportion
  to how much longer conversations now reach the model — about double for long ones, unchanged
  for short ones. `support_ai_runs` records the tokens of every call (`GET /support-ai/usage`):
  compare a week before and after to see the real change. No price is computed (`OQ-TB-07`).
