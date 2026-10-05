# TB10 — Polish, analytics and final QA

**Status: implemented.** Program: Intelligent Support Agent, §40–§49. The last package. It
builds on every one before it and changes no decision they made. What it adds is making the
support agent operable: who is told what, how fast a person sees a waiting customer, what the
AI is costing in tokens, and what an operator does when something goes wrong.

## What TB10 delivers

| Concern                    | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Notification integration   | Two categories in `NOTIFICATION_CATEGORIES` (a contract commit). `SUPPORT` (`business_chats.view`) carries `support.handoff_required`, which links to the conversation by its `conversationId`, and `support.business_connection.unusable`, which links to the inbox. `SUPPORT_AI` (`support_ai.configure`) carries `support.ai_provider.credential_rejected` and `support.ai_provider.unavailable`. Exact codes, never a prefix. |
| Inbox polish               | HANDOFF_REQUIRED first, then newest activity, then id. A three-key cursor; one the inbox did not issue is a 400. `unansweredSince` is the oldest customer message after the latest delivered reply, read in the same statement. `ticketId` drives a badge that links to the ticket. The state filter already offered «نیازمند پشتیبان».                                                                                           |
| Indexes (migration `0210`) | `business_conversations_inbox_priority_idx` on `(tenant_id, (state = 'HANDOFF_REQUIRED'), COALESCE(last_message_at, created_at), id)`. It replaces the TB2 index, which no query could use. Two analytics indexes on `(tenant_id, created_at)` for escalations and jobs. Proved by EXPLAIN in `support-plan.test.ts`.                                                                                                             |
| Provider health            | The config view adds a derived breaker per provider: `CLOSED`, `OPEN` or `HALF_OPEN` at the read, never stored. It also adds the failures in a row, `rejectedAt`, and `chainUnavailable` (the open `support.ai_provider.unavailable` condition). All from existing data.                                                                                                                                                          |
| Support analytics          | `GET /support-ai/analytics` (`support_ai.configure`), over the business reports' range resolver in the tenant's timezone and calendar, half-open. Six tenant-leading grouped reads with no text column. The response is assembled by a pure function.                                                                                                                                                                             |
| Web Admin                  | `/support-analytics` (a new page and nav entry). The provider health panel on `/support-ai`, plus a banner when no provider answers. The wait column and ticket badge on `/business-chats`. Persian titles and links for the four support notifications.                                                                                                                                                                          |
| RTL / dark / narrow        | A transcript message, an inbox preview and a knowledge answer take their direction from their own text (`unicode-bidi: plaintext`, `text-align: start`). The composer, draft editor and article body are `dir="auto"`. A stylesheet test pins tokens-only colours and logical sides for every `.bchat-*` and `.support-*` rule. The TB pages already used tokens and the kit's grids, which collapse at narrow widths.            |
| Runbooks and acceptance    | `runbook.md` (§0–§10) and `acceptance-pack.md` (§48).                                                                                                                                                                                                                                                                                                                                                                             |

## The analytics, field by field

Every figure is a named derivation. Snapshots ignore the window. Everything else is counted
in `[start, end)` by the row's `created_at`.

| Field               | Source                                                                                                                                                                    | Window   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `conversationsNow`  | `business_conversations` by `state`, every state zero-filled                                                                                                              | snapshot |
| `handoffsByReason`  | `business_conversation_escalations` by `reason` (one row per handoff)                                                                                                     | windowed |
| `auto`              | `support_ai_jobs` of kind `AUTO_DECISION`. `supportAutoOutcomeClass` sorts each outcome into sent, handed off or dropped; an outcome still null is pending, never a send. | windowed |
| `assist`            | `support_ai_jobs` of kind `ASSIST_DRAFT`, counted by the state each is in now                                                                                             | windowed |
| `providerRuns`      | `support_ai_runs` by provider and outcome: count, `percentile_cont` p50 and p95, token sums                                                                               | windowed |
| `learningByState`   | `support_learning_candidates` by state, zero-filled                                                                                                                       | windowed |
| `knowledgeBySource` | `support_knowledge_articles` by source, state and enabled                                                                                                                 | snapshot |

There is no cost field. `OQ-TB-07` stays open: no price is hard-coded, and a tenant price table
was not cheap enough for this package. The page says so in a banner and shows tokens.
There is no "resolved by AI" (`OQ-TB-09`).

## Decisions made in this package

1. **Two notification categories, not one.** A support agent must see a waiting customer. Only
   someone who can replace a key should be told one was rejected. One category would either
   hide handoffs from support or show key alerts to people who cannot act on them.
2. **Exact codes, not `support.`.** The four recoveries share the prefix, and a prefix would
   admit any `support.` code a later package records, without anyone deciding.
3. **Handoffs first is part of the keyset, not a second list.** A separate "needs a person"
   section would page independently of the list below it. One ordering with one index keeps
   both on a single bounded scan, and a state change between pages moves a row across the
   cursor in the same way activity always could.
4. **The wait is computed from delivered replies.** `last_human_at` and `last_ai_at` are set at
   delivery, so a pending send does not stop the clock (`OQ-TB-73`).
5. **The breaker is derived at read time, by the server.** A browser clock that disagrees with
   the server's would otherwise draw «available» for a provider the chain is skipping.
6. **Analytics are read under `support_ai.configure`**, as usage and cost always were
   (`tb0-audit.md` §7). A narrower key would be a contract change nobody has asked for yet
   (`OQ-TB-72`).
7. **No new table, so no harness change.** `0210` adds indexes only.

## Tests

- `tests/unit/support-tb10.test.ts` (18): the pure rules.
- `tests/integration/support-tb10.test.ts` (11): the real producers into the real inbox; the
  keyset over real rows; health; analytics boundaries and tenancy; the HTTP refusals.
- `tests/integration/support-plan.test.ts` (8): EXPLAIN of the real statements over two
  tenants of a year. With `0210`'s indexes dropped, five of the six plan cases failed.
- `tests/web/support-analytics.test.tsx` (7) and `tests/web/support-tb10-polish.test.tsx` (10).
- The existing suites (notification center, business conversations, support AI config, auto
  reply, assist, vision) pass with fixtures carrying the new fields.

Mutation results are in `tb10-falsification.md`.

## Not done here

- The manual acceptance pack has not been run (`OQ-TB-76`).
- The ops group still routes `support.` codes to its SYSTEM topic (`OQ-TB-70`).
- The analytics page offers presets only. The API accepts `CUSTOM` (`OQ-TB-75`).
