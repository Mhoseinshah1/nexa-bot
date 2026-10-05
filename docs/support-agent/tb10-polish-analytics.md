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
| Indexes (migration `0210`) | `business_conversations_inbox_priority_idx` on `(tenant_id, (state = 'HANDOFF_REQUIRED'), COALESCE(last_message_at, created_at), id)`. It replaces the TB2 index, which no query could use. Two analytics indexes on `(tenant_id, created_at)` for escalations and jobs, and (PR #205 review) one on `(tenant_id, created_at, state)` for learning candidates. Proved by EXPLAIN in `support-plan.test.ts`.                       |
| Provider health            | The config view adds a derived breaker per provider: `CLOSED`, `OPEN` or `HALF_OPEN` at the read, never stored. It also adds the failures in a row, `rejectedAt`, and `chainUnavailable` (the open `support.ai_provider.unavailable` condition). All from existing data.                                                                                                                                                          |
| Support analytics          | `GET /support-ai/analytics` (`support_ai.configure`), over the business reports' range resolver in the tenant's timezone and calendar, half-open; a `CUSTOM` window is at most 366 days. Six tenant-leading grouped reads with no text column, in one `REPEATABLE READ, READ ONLY` snapshot. The response is assembled by a pure function.                                                                                        |
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
4. **The wait is computed from delivered replies, on Telegram's clock.** `last_human_at` and
   `last_ai_at` are set at delivery, so a pending send does not stop the clock (`OQ-TB-73`).
   Since PR #205's review (S1) a reply NEXA delivered is stamped with the `date` Telegram
   returned for it — the same date its `OWN_ECHO` row carries, and the clock every customer
   message is stamped on — not with the server's `now`. The comparison is made on whole
   seconds, and a customer message in the reply's own second is unanswered: within a second
   Telegram does not say who spoke first. `businessUnansweredSince` (contract) and the
   repository's `firstUnansweredAt` (`m.sent_at >= date_trunc('second', replied)`) state the
   same rule; the integration suite runs the real lane with a skewed and a sub-second server
   clock and checks they agree. Consequence: the AUTO cooldown now runs from Telegram's date
   for the reply, off the server's clock by the host's skew and under a second.
5. **Handoffs first is a mutable keyset key.** A conversation handed back to the AI between
   two pages moves below the cursor and is read again: the web draws it once (`inboxRows`,
   the first position, the fresher read). The other direction is a skip: a conversation
   handed off, or with new activity, after its page was read moves above the cursor, and
   «load more» does not show it until the list is read again from the top. Its handoff still
   reaches the notification inbox.
6. **The breaker is derived at read time, by the server.** A browser clock that disagrees with
   the server's would otherwise draw «available» for a provider the chain is skipping.
7. **Analytics are read under `support_ai.configure`**, as usage and cost always were
   (`tb0-audit.md` §7). A narrower key would be a contract change nobody has asked for yet
   (`OQ-TB-72`).
8. **No new table, so no harness change.** `0210` adds indexes only.
9. **`0210` is an ordinary migration, not an online index, and must ship in the release that
   carries `0196`–`0209`** (PR #205 review, N1). The repository's rule
   (`docs/deployment.md`, «Indexes that must not lock the table they are built on are not
   migrations») exists because `botctl update` migrates while the outgoing release still
   serves, and a plain `CREATE INDEX` holds a SHARE lock for its build. Every table `0210`
   indexes — `business_conversations` (`0197`), `support_ai_jobs` (`0201`),
   `business_conversation_escalations` (`0205`) and `support_learning_candidates` (`0207`) —
   is created by a migration no release has shipped yet (no tag contains PR #196's merge).
   In the release that carries them, the migrator creates each table empty and indexes it in
   the same transaction: the lock is on an empty table nobody can be writing to. The online
   path would cost more than it saves here: those indexes would leave `schema.ts`, so
   `pnpm db:check` could no longer see them, and the inbox index replaces a TB2 index the
   same migration drops. **If a release ever ships `0196`–`0209` without `0210`, this
   reasoning no longer holds**, and `0210`'s indexes must move to `online-indexes.ts` first.
10. **A `CUSTOM` analytics window is at most 366 days** (PR #205 review, N5). The provider
    runs' `percentile_cont` p50 and p95 sort every run in the window, per provider and
    outcome. The reports' own `CUSTOM` bound (731 days) would let one request sort two years
    of a busy tenant's calls; the cap is the longest preset's span (`THIS_YEAR` in a leap
    year), so it removes nothing a preset can ask for. The rest is bounded by the
    per-statement `statement_timeout`: on a tenant whose year of runs cannot be sorted in
    time, the request fails rather than holding a connection.
11. **The analytics are one snapshot** (PR #205 review, N3): the six statements run in one
    `REPEATABLE READ, READ ONLY` transaction, so no figure counts a row another missed.

## Tests

- `tests/unit/support-tb10.test.ts` (20): the pure rules, and the `CUSTOM` cap.
- `tests/integration/support-tb10.test.ts` (15): the real producers into the real inbox; the
  keyset over real rows; the wait on one clock through the real lane; health; analytics
  boundaries, tenancy and the snapshot; the HTTP refusals.
- `tests/integration/support-plan.test.ts` (9): EXPLAIN of the real statements over two
  tenants of a year. With `0210`'s first three indexes dropped, five of the six original plan
  cases failed; with the learning-candidate index dropped, its case fails (228 buffers
  against 23).
- `tests/unit/business-gateway.test.ts` and `business-transport.test.ts`: Telegram's `date`
  for a sent message, read and carried.
- `tests/web/support-analytics.test.tsx` (7) and `tests/web/support-tb10-polish.test.tsx` (11).
- The existing suites (notification center, business conversations, support AI config, auto
  reply, assist, vision) pass with fixtures carrying the new fields.

Mutation results are in `tb10-falsification.md`.

## Not done here

- The manual acceptance pack has not been run (`OQ-TB-76`).
- The ops group still routes `support.` codes to its SYSTEM topic (`OQ-TB-70`).
- The analytics page offers presets only. The API accepts `CUSTOM` (`OQ-TB-75`).
