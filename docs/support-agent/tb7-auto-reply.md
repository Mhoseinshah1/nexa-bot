# TB7 — Automatic replies, handoff and tickets

**Status: implemented.** Program: Intelligent Support Agent, §25–§27 and §37. Decided by
ADR-0033 §4–§6 and ADR-0034 §1, §6–§7. Builds on TB2 (conversations, epoch, the lane), TB3
(the support context), TB4 (providers, configuration) and TB5 (jobs, the `assistant` role,
the decision schema).

The AI may answer a topic the owner allowlisted. Anything else goes to a person, with a
ticket. The AI never touches money, services or ownership: its only output is a reply, or
nothing.

## Release defaults (binding)

- The mode is `OFF` for every tenant. No migration sets `AUTO_REPLY_SAFE`. Entering it needs
  `support_ai.auto_reply` (CRITICAL, owner only; TB4).
- The auto-topic allowlist (`auto_topics`) is **empty** by default, and an empty allowlist
  sends nothing, ever. Adding a topic, or lowering `auto_min_confidence` from `HIGH` to
  `MEDIUM`, also needs `support_ai.auto_reply`, in any mode. While the resulting mode is
  `AUTO_REPLY_SAFE`, so does loosening how much and how often it answers: raising
  `maxConsecutiveReplies`, `maxConsecutiveClarifyingQuestions` or `maxOutputChars`, or
  lowering `cooldownSeconds` or `settleDelaySeconds`. Outside AUTO those shape only Assist drafts; entering AUTO is itself
  charged, so whoever enters it adopts every bound on the form. Narrowing needs only
  `support_ai.configure`.
- A client that does not send the two new fields saves the safe values (the schema defaults
  them to `[]` and `HIGH`).
- `maxConsecutiveClarifyingQuestions` («حداکثر سؤال تکمیلی پیاپی», hotfix 2026-10-06) is 2 by
  default, 1–10. Migration `0218` added it with that default, so every existing tenant reads 2.
  See «Clarifying questions» below.

## The pipeline

| Step                 | Where                                                 | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Enqueue           | webhook transaction (`SupportAutoEnqueuer.onInbound`) | Only a customer's own message (`INBOUND`) under `AUTO_REPLY_SAFE` in an `AI_ACTIVE` conversation. One `AUTO_DECISION` job, capturing the epoch, due after the settle delay (TB4 config, 3–30 s, default 6 s) or the cooldown, whichever is later.                                                                                                                                                                                                                                                                                                                                                          |
| 2. Coalesce          | same transaction                                      | A newer inbound message discards the pending job (`dropped_coalesced`) and enqueues one due a full delay later. A partial unique index allows one pending job per conversation.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 3. Idempotency       | same transaction                                      | The job key names the message and its content version. A redelivery records nothing new (TB2) and the key would refuse it anyway. An edit re-enqueues only while a job is still pending AND the edit is of that job's own trigger; an edit of an older message leaves the pending job on its trigger (it reads the edited transcript anyway).                                                                                                                                                                                                                                                              |
| 4. Re-check          | `assistant` role (`SupportAutoReplyService.produce`)  | Mode, epoch and state, before any provider cost. A person who spoke during the delay drops the job (`dropped_epoch`). A job produced more than `SUPPORT_AI_AUTO_STALE_SECONDS` (600 s) after its `due_at` hands off (`handoff_stale`, `REPLY_STALE`) with no provider call. A stopped tenant writes nothing (`INACTIVE`, the job untouched).                                                                                                                                                                                                                                                               |
| 4b. Vision (TB6)     | `planVision`, `SupportImageSource`, `autoImageGuard`  | The customer's images are fetched as Assist fetches them, outside any transaction. An image the reply would be about (the trigger, or the latest customer message) that no model saw hands off as `UNSUPPORTED_CONTENT`: vision off, no vision step, a fetch or sniff refused, or an answering step that was not given the image. Every image considered gets one `support_ai_image_outcomes` row.                                                                                                                                                                                                         |
| 5. Preflight guards  | `domain/auto-reply-guards.ts` `autoPreflight`         | The trigger is the customer's readable text; the customer is not blocked; fewer than `maxConsecutiveReplies` AUTO replies since a person last acted (the current epoch); fewer than 10 in the last hour.                                                                                                                                                                                                                                                                                                                                                                                                   |
| 6. Decision          | TB4 chain → `supportAiDecisionSchema`                 | Invalid output or a provider refusal is `AI_OUTPUT_INVALID`; any other chain failure is `AI_UNAVAILABLE`. Both hand off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 7. Decision guards   | `autoDecisionGuards`                                  | Every one must pass: `REPLY` or `ASK_CLARIFYING_QUESTION` (hotfix 2026-10-06); not a hard-handoff topic; not `HUMAN_REQUESTED`; topic on the allowlist; a general topic for an unlinked customer; no payment under review and no unreconciled service; confidence at least the minimum; reply non-empty and within the bound; every cited fact and knowledge entry in the payload; for a question, the clarifying streak below the tenant's limit.                                                                                                                                                         |
| 8. Enqueue the reply | one transaction                                       | Checks scope activity (stopped: nothing written), re-reads the mode, locks the conversation, then decides AGAIN on what is true now: the configuration, the trigger, the loop counts and the customer's account facts (`autoGuardFlags`), each read in this transaction; `autoPreflight` and `autoDecisionGuards` run again, and a failure HANDS OFF here instead of enqueueing. `enqueueAutoSend` locks the conversation and refuses a moved epoch, a state other than `AI_ACTIVE` or a connection that cannot send; the job moves to `SENT` only from `QUEUED`. The lane row carries the CAPTURED epoch. |
| 9. The final check   | TB2 lane                                              | `businessOutboundSendable` (equal epoch and `AI_ACTIVE`) and, new in TB7, the mode still `AUTO_REPLY_SAFE`, all under the conversation's lock in the stamp's transaction. This is the authority. An AUTO row still unsent `SUPPORT_AI_AUTO_STALE_SECONDS` after it was enqueued is superseded (`support_ai.reply_stale`) and handed off (`REPLY_STALE`).                                                                                                                                                                                                                                                   |

## Handoff

Every outcome that is not a send and not a drop hands off, through TB2 `handOff`, with a
typed reason (`BUSINESS_HANDOFF_REASONS`, extended by the TB7 contract commit). That
includes a topic that is merely **not on the allowlist**: guards fail closed, and a person
answers instead.

In the transaction that moves the conversation to `HANDOFF_REQUIRED`,
`BusinessEscalationService`:

1. **Opens or links a ticket** (`TicketService.escalateFromBusinessChat`, the canonical
   escalation). It links the conversation's own ticket while it is active, else the customer's
   newest active ticket. Otherwise it opens one with `origin = BUSINESS_CHAT`, idempotent on
   `business-conversation:<id>:escalation:<epoch>`. A ticket gets one SYSTEM fact per handoff
   (`ESCALATED_FROM_BUSINESS_CHAT`). The customer's words are never copied into it, because the
   transcript keeps its 30-day retention. The tenant's default categories are seeded in the same
   transaction when they never were. An unlinked customer (OQ-TB-40), a blocked customer, a
   tenant with no active category, or a stopped tenant gets no ticket. Nothing here throws for
   a business reason, because a refused ticket must not undo its handoff: a seed refused
   because an operator's override of `bot.ticket.category_default_N` renders an unusable title
   is `NO_CATEGORY` (recorded and signalled, no ticket). The seed renders and judges every
   title BEFORE it writes anything, so a refused seed leaves no half-made categories and no
   "seeded" mark.
2. **Records the handoff** in `business_conversation_escalations`: one row per epoch, with the
   reason, the ticket outcome and the AI's short operator-facing summary. The summary is never
   sent to the customer and is purged after 30 days.
3. **Raises `support.handoff_required`**, deduplicated per conversation. It is recovered by
   `support.handoff_resolved` when a person takes the conversation or returns it to the AI.

The lane's own handoffs (`SEND_OUTCOME_UNKNOWN`, `TRANSPORT_REFUSED`, `REPLY_STALE`) go through
the same path. So an UNKNOWN automatic send is `UNCONFIRMED`, is never resent, and is handed off
with a ticket. One conversation's handoff that throws anyway (an infrastructure failure) never
stalls the tenant's lane: each row is delivered, and each stranded row reaped, in its own
transaction with its own handoff; a failure is logged, rolls back that row alone (it stays
stamped and is reaped on a later pass), and the pass goes on to the next row.

The AI's summary is the conversation's to show: a ticket's detail returns it only to an actor
who also holds `business_chats.view`. `tickets.view` alone sees that a handoff happened and why.

A handoff happens only for the conversation the job was about. If a person already intervened
(the epoch moved), the job is dropped, because the person holds the conversation. A job that a
newer message replaced while its provider call was in flight writes nothing. Its transaction,
handoff included, rolls back.

An ordinary answered question opens no ticket.

## Telemetry

Each job ends with one code from `SUPPORT_AI_AUTO_OUTCOMES`, pinned by a CHECK:

- `sent` (an answer) or `sent_clarifying` (a question, hotfix 2026-10-06);
- `dropped_mode`, `_epoch`, `_state`, `_coalesced` or `_connection`;
- `guard_<guard>`;
- `handoff_ai_requested`, `handoff_output_invalid`, `handoff_ai_unavailable` or `handoff_stale`.

`dropped_scope` is no longer written (a stopped tenant's job is left untouched); it stays in
the set because the CHECK pins it and older rows carry it.

A handed-off job also carries its `handoff_reason`. Provider runs are recorded by TB4 under
the operation `AUTO_DECISION`.

## Schema (migrations `0205`, `0206`, `0218`)

- `support_ai_jobs` gains the following columns. A CHECK pins the shape of an automatic job.
  - `trigger_telegram_message_id`, `trigger_content_version`;
  - `control_epoch`, `due_at`;
  - `outcome`, `handoff_reason`.
- `support_ai_jobs` also gains the partial unique index `support_ai_jobs_auto_pending_key`.
- `support_ai_configs` gains `auto_topics` (default `{}`, a CHECK of a subset of the safe
  topics) and `auto_min_confidence` (default `HIGH`).
- `business_conversations.ticket_id`.
- `tickets.origin` (default `BOT`).
- `business_conversation_escalations`.
- Two existing CHECKs are widened: the ticket system events and the handoff reasons.
- `0206` (substitute review of PR #202) widens the four CHECKs built from
  `BUSINESS_HANDOFF_REASONS` (+`REPLY_STALE`) and `SUPPORT_AI_AUTO_OUTCOMES` (+`handoff_stale`).
- `0218` (hotfix 2026-10-06) adds `support_ai_configs.max_consecutive_clarifying_questions`
  (integer, NOT NULL, DEFAULT 2, CHECK 1–10) and widens the same four CHECKs
  (+`CLARIFYING_LIMIT`; +`sent_clarifying`, `guard_clarifying_limit`).

No grants are needed (no new permission).

## Clarifying questions (hotfix 2026-10-06)

**Root cause of the report.** `autoDecisionGuards` refused every decision other than `REPLY`
(`guard_decision`, `DECISION_NOT_REPLY`). A safe, allowlisted, confident
`ASK_CLARIFYING_QUESTION` on «مشکل در اتصال دارم» was therefore handed off, and a handoff of a
linked customer opens or links a ticket. A conversation was escalated the moment the AI needed
one more detail.

**What is sent now.** `ASK_CLARIFYING_QUESTION` is sent automatically, its question being
`replyText`, when it passes every guard a `REPLY` passes, in the same order, at both checks (after
the provider, and again in the enqueue transaction under the conversation's lock): not a
hard-handoff topic, not `HUMAN_REQUESTED`, on the allowlist, identity, account review,
confidence, bounds (an empty or blank question is never sent), grounding — and the money guard
and every preflight, lane and final-send check before and after it, unchanged. `NO_ACTION` still
hands off (`DECISION_NOT_REPLY`) and is never a customer message; `HANDOFF` and
`CREATE_OR_LINK_TICKET` are unchanged. A question opens no ticket, whatever `ticketAction` it
carries, exactly like a `REPLY`. It is recorded as `sent_clarifying`.

**The limit.** One more guard, last, for a question only: `clarifying_limit`
(`guard_clarifying_limit`, `CLARIFYING_LIMIT`, «سؤال‌های تکمیلی پیاپی هوش مصنوعی به سقف رسید»).
A question when the conversation's clarifying streak has reached
`maxConsecutiveClarifyingQuestions` hands off and nothing is sent. It is not
`maxConsecutiveReplies`, which bounds every automatic reply (loop safety) and still applies.

**The streak** is NEXA's count, never the model's (`DrizzleSupportAiJobRepository.clarifyingStreak`,
`clarifyingStreakOf`): the AUTO lane rows at the job's epoch, joined to the SENT job that
enqueued each (`sent_outbound_id`), whose recorded `decision` says what it was; walking back from
the newest, the `ASK_CLARIFYING_QUESTION`s before the first `REPLY`.

- A `REPLY` (a greeting included) ends the streak. A customer message does not: the point is
  question, answer, question, answer, troubleshooting step.
- A person's message, a takeover, a return to the AI and every handoff move the epoch: a new
  streak.
- A lane row counts while `PENDING` (on its way — fail closed; it stops counting once
  superseded), `DELIVERED` or `UNCONFIRMED` (Telegram may have shown it; it is never resent).
  `FAILED` (Telegram refused it) and `SUPERSEDED` never reached the customer and count neither as
  a question nor as the reply that resets. A DISCARDED or FAILED job has no lane row. One job has
  at most one row (its idempotency key), so a redelivered message or a repeated lane pass is
  counted once.
- The decision was already stored on `support_ai_jobs.decision` (and survives the 30-day text
  purge); nothing new is stored.

**Why after the provider.** Only the decision says whether this job is a question at all, and a
`REPLY` at the limit is welcome — it is what the streak was waiting for. Refusing before the
provider would hand off a conversation the model was about to answer. The limit is therefore a
decision guard, run with the other guards after the call and again in the enqueue transaction
(a limit lowered during the call applies).

**Grounding, tightened.** The automatic path checked cited FACT aliases only, so a made-up
knowledge alias (`K9`) passed. A `knowledgeRefs` alias the payload did not carry is now
`INSUFFICIENT_GROUNDING` too, for a reply and a question alike.

**The prompt** says a question goes in `replyText` and is never empty, and to give a grounded
first step when a knowledge entry or fact covers the problem rather than ask, never repeating a
question already asked (the model reads its own delivered replies since D7). The policy version
is `sai2-2026-10-06`. Assist reads the same prompt; its handling of a draft is unchanged.

**Review of PR #228.** A save that omits `maxConsecutiveClarifyingQuestions` — an older web
bundle that does not know it — keeps the STORED value (the default only when nothing is
stored): the request schema makes the field optional (`supportAiConfigSaveSchema`) while the
configuration as read always carries it, and the service merges it before the permission and
version logic, so an absent field is never a widening (N4). A reply or question made only of
zero-width or invisible marks (U+200B–U+200F, U+2060, U+FEFF) is empty and hands off as
`REPLY_OUT_OF_BOUNDS`; the trimmed original is what is sent otherwise (N7). Rule 9a of the
prompt yields to rules 5–7 («Unless rules 5–7 require HANDOFF», policy `sai3-2026-10-06`, N5).
A question still `PENDING` on the lane counts toward the streak (N1, tested).

**The setting** is in the tenant's Support AI configuration, versioned and idempotent like the
other fields, drawn on `/support-ai` in the numeric-field pattern with its help text and the
shared Persian bound error. Raising it while the resulting mode is `AUTO_REPLY_SAFE` is a widening
charged `support_ai.auto_reply`, like `maxConsecutiveReplies`; lowering it is not, and outside
AUTO it is ordinary configuration. The page warns about the widening before the save.

## Decisions made in this package

1. **Every guard failure hands off**, including "not on the allowlist" and `NO_ACTION`
   (OQ-TB-41). The alternative is a customer who wrote and was answered by nobody.
2. **The loop guard counts AUTO rows at the current epoch.** Every human signal and every
   resume moves the epoch, so this counts "AUTO replies since a person last acted" with no
   counter column. The window cap counts across epochs.
3. **The mode is read at processing time, at every step.** Before TB7 the lane checked only the
   epoch and the state. Now the producer reads the mode before the provider call and again in
   the enqueue transaction, and the lane reads it under the conversation's lock when it stamps
   a send. A step that finds the mode is not `AUTO_REPLY_SAFE` ends its work for good: a pending
   job is `dropped_mode`, a queued row `SUPERSEDED` (`support_ai.mode_off`). Nothing is
   superseded at the moment the mode is switched, so a mode switched OFF and back ON before
   the assistant or the lane reached a job or a row leaves it to be produced or sent, under
   every other check (the epoch, the state, the guards, and the staleness bound).
4. **Automatic jobs are invisible to Assist.** The draft list, discard and send act on
   `ASSIST_DRAFT` only. An operator's draft request no longer discards a pending automatic job.
5. **Escalation lives in business-chats and calls the ticket system through a port.** It runs
   in the handoff's transaction, for the lane's handoffs and the AI's alike.
6. **On the reviewed TB5 (PR #200), an AUTO job lives under TB5's concurrency rules.** It is
   claimed by the same `claimNext` — one job at a time, in a transaction that checks scope
   activity, under the `(1 + maxFallbacks) × timeout + 2 min` lease — which also filters by
   kind (an AUTO job only when the loop has its producer) and by `due_at`. Its
   `request_hash` is NULL: it is keyed on the triggering message, not on an operator's request.
   The **unclaimed-draft rule (`job.unclaimed`) applies to `ASSIST_DRAFT` only**: an AUTO job
   is nobody's screen wait, it is coalesced or dropped by its own producer, and one that keeps
   failing hands off through `giveUp` with a ticket; failing it as unclaimed would silence a
   customer with no handoff. Before the provider call the producer checks scope activity in a
   transaction (a stopped tenant's transcript goes to no provider), and every result write
   checks it again in its own transaction. A stopped tenant's job is left UNTOUCHED (`INACTIVE`,
   no write at all, telemetry included), as TB5 leaves a draft; see decision 8.
7. **On the reviewed TB6 (PR #201), AUTO vision uses `stepSight`.** The variant carries the
   loaded images and a `render(seen)`; the latest customer image is the chain's `requiredId`,
   and every required image (the trigger too) must be in the answering step's `sight.seen`, or
   the job hands off `UNSUPPORTED_CONTENT`. A loaded image is PROCESSED only when that step was
   given it; otherwise SKIPPED with the reason `sight` gives. The outcome rows are written
   inside the job's own transition's transaction and only after it succeeded (TB6 S1): a job
   replaced or dropped meanwhile records none.

8. **A stopped scope takes no writes; a resumed one gets no stale reply** (substitute review of
   PR #202; the Product Owner's rule: fail closed). An AUTO job produced more than
   `SUPPORT_AI_AUTO_STALE_SECONDS` (600 s) after its `due_at`, and an AUTO lane row still unsent
   that long after it was enqueued, is never sent: the conversation is handed off with
   `REPLY_STALE`, so a person answers. Measured from `due_at` rather than the message because
   `due_at` is the message's arrival plus the settle delay (≤ 30 s), or the end of the owner's
   own cooldown (≤ 1 h) when that is later; a bound on the message's age would hand off every
   reply the owner deliberately postponed. 600 s is far above the normal latency (the assistant
   polls every 2 s; one job's worst case is 7 min, its lease 9 min, so a job re-claimed after a
   crash is normally still answered) and far below a stop and a later resume. None of the
   existing reasons said "too late" (`AI_UNAVAILABLE` would tell the operator the provider
   failed), so the reason is new, in its own contract commit.
9. **The guards decide on the facts of the enqueue, not of the provider call** (substitute
   review, finding 1). The call can take minutes; an allowlist narrowed, a customer blocked, a
   payment put under review or a trigger deleted meanwhile hands off in the enqueue transaction.
   The account facts are read by `DrizzleSupportContextReader.autoGuardFlags`, over ALL of the
   customer's services (the payload's flag covers one page of them): broader is the fail-closed
   direction. The cited facts are still judged against the payload the model was given.

## Tests

- `tests/integration/support-auto-reply.test.ts` (52, with TB6's and the substitute review's). It covers:
  - the end-to-end send, and the settle delay;
  - a human during the delay, during the provider call, and after the enqueue (the final
    check);
  - the mode switched off while a job is pending and while a row is queued;
  - coalescing, an in-flight job replaced by a newer message, and a redelivery;
  - echo, away messages and the owner never triggering;
  - both loop guards, each guard alone, and a retried-out job;
  - one ticket, then linked, with the signal raised and resolved;
  - an existing ticket linked, and an unlinked customer with no ticket;
  - an UNKNOWN send that becomes UNCONFIRMED, is handed off and gets a ticket;
  - an empty allowlist, the CRITICAL widening, and tenant isolation;
  - the substitute review of PR #202 (21 tests): each guard decided again in the enqueue
    transaction (allowlist, blocked customer, payment under review, deleted trigger); a stop
    that writes nothing, and a stale job and a stale lane row that hand off; a bad category
    override that still hands off and leaves the lane sending; per-row isolation at the send
    and at the reaper; R4–R12 (edits, the customer lock, the connection refusal, the epoch at
    the handoff, the summary purge, superseded rows and the loop guard, Telegram REFUSED, the
    takeover's recovery); the summary gate on `business_chats.view`; the loosened bounds.
- On TB6, four more integration tests cover a seen photo being answered (PROCESSED), a photo with vision off, a photo that cannot be fetched or read, and a photo the answering step was not given. The unit file gains the photo preflight and `autoImageGuard`.
- `tests/unit/support-auto-reply-guards.test.ts`: the pure evaluator, guard by guard, and
  the configuration defaults; since the hotfix, a question through every guard, the limit, the
  streak walk, the setting's default and bounds, and short connection phrases the money lexicon
  must leave to the model.
- Hotfix 2026-10-06: `describe('hotfix: automatic clarifying questions')` in the integration
  file (23 cases: the spec's tests 1–16, the enqueue-time recheck, a real Telegram refusal,
  short connection messages, the transcript, identity and the acceptance flow) and
  `tests/web/support-ai-clarifying.test.tsx` (8).
- TB2's and TB5's suites pass unchanged in substance. TB2's lane is built with a mode reader
  that allows AUTO, because its races are about the epoch and the state.

Mutation results are in `tb7-falsification.md`.

## Manual real-Telegram acceptance (pending staging)

1. With the mode `OFF`, a customer message produces no job.
2. Set `AUTO_REPLY_SAFE` with `CONNECTION_TROUBLESHOOTING` allowlisted. A connection question
   is answered once, about six seconds later, from the business account.
3. Type in the chat from the owner's phone within the delay. Nothing is sent automatically.
4. Ask for a refund. The conversation is handed off, a ticket appears in «تیکت‌ها» with the
   AI's note, and the handoff alert fires.
5. Return the conversation to the AI. The alert resolves. A second handoff links the same
   ticket.
