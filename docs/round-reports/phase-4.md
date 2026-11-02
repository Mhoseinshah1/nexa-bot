# Phase 4 — Support AI (PHASE4.md)

Round of 2026-11-01. Six PRs against `Mhoseinshah1/nexa-bot`, issue #358, all merged under the round prompt's explicit
approval (push → Codex → one fix commit → green CI on the exact head → merge commit). Plus one owner-requested
test-only PR (#372, gift-card security investigation) — see the end.

**§0 holds for the whole phase:** the support AI READS and writes text. No path added here moves money, changes a
service or a balance. Where it points a customer at an action (renew, trial, top-up, link), it is a deep link into
the bot's own, already-checked flow; the customer taps, the bot decides again.

Every new customer-facing capability ships OFF: `support.ai.actions_enabled`, `support.ai.tickets_enabled`,
`support.knowledge.auto_refresh`, `support.ai.label_enabled` (OFF). `support.ai.feedback_enabled` is ON by the
round prompt's design (default on) but takes effect only while the tools are on.

## Order and migrations

| PR   | Branch                    | Number | Migration              | State          |
| ---- | ------------------------- | ------ | ---------------------- | -------------- |
| PR-1 | `fix/sai-handoff-policy`  | #365   | 0296                   | merged a8fb982 |
| PR-5 | `feat/sai-admin-ux`       | #366   | 0297, 0298             | merged e67879b |
| PR-2 | `feat/sai-knowledge-live` | #367   | 0299 (written as 0297) | merged 48d2db2 |
| PR-3 | `feat/sai-actions`        | #369   | 0300                   | merged 84e1f58 |
| PR-4 | `feat/sai-bot-tickets`    | #371   | 0301                   | merged e0f6f31 |
| PR-6 | `chore/sai-eval`          | #370   | none                   | merged dfd14a2 |

PR-2 and PR-5 were branched from PR-1's head (D2) and PR-3 from PR-2's, PR-4 from PR-3's (D9, D14); each had
`origin/main` merged in (merge commit, never rebase) after its base merged. Migration numbers were checked at every
merge; PR-2's 0297 collided with PR-5's and was renumbered to 0299 with the renumber script, SQL byte-identical.

---

## PR-1 #365 `fix/sai-handoff-policy` — merge commit a8fb982 (fix commit 2957956)

https://github.com/Mhoseinshah1/nexa-bot/pull/365. The AI ended almost every Business conversation with a human
handoff. This PR changes the handoff policy and hardens the reply.

**Background audit** (against main e3f67a8) confirmed every claim in the brief: mode OFF with an empty topic list
means everything is `TOPIC_NOT_ALLOWED`; a handoff and any person's message were permanent; `OTHER` was a handoff
topic; the money guard fired on پرداخت/تومان/پول/موجودی; `account_review` fired on any under-review payment of any
age; a trailing OFFLINE line made the request end with an assistant turn and a 400 ended the chain.

**What changed**

- Hard vs soft handoff (`businessHandoffKindOf`, contracts). HARD: human requested, customer blocked, send outcome
  unknown, account under review, money guard, a hard topic. Everything else SOFT. Migration 0296 adds `handoff_kind`
  to the conversation and to each escalation; NULL (every hold from before) stays sticky. A person's message over an
  AI-held conversation pauses it SOFT; over PAUSED it is HARD; the operator's explicit takeover is HARD.
- Automatic return (`autoResumeTrigger`, pure): `RESOLVED` (the handoff's ticket is closed), `NEW_SESSION` (silent for
  the window, no person wrote), `HUMAN_SILENT` (no person for the window). Evaluated under the conversation lock when
  the customer next writes. Window `support.ai.resume_after_minutes` (default 30, 0 = never), and 0 unless mode is
  AUTO_REPLY_SAFE.
- Eight new safe topics (purchase, renewal, add-on, trial, location, speed, get-subscription-link, payment how-to) and
  POLICY_REFUSAL. `OTHER` gets one clarifying question; the second in a row hands off SOFT. NO_ACTION on an
  allowlisted safe topic closes silently. Repeated advice gets one regeneration before the handoff.
- Money guard narrowed to refund, dispute/chargeback/fraud/complaint, a deduction, «I paid» in the first person past
  tense, and «bought but did not arrive». Price, how-to-pay and balance questions go to the model.
- Account-review guard scoped to four account topics, 14-day window, and unreconciled means a service the reply cites
  or a recent one.
- Unlinked customers: general topics answered; an account topic gets one templated bot start link
  (`bot.support.ai_link_account`), no handoff.
- Recommended preset («اعمال تنظیمات پیشنهادی»): all safe topics, MEDIUM confidence, vision when the primary provider
  can see. Form only, saved by the owner; a banner while the stored config is restrictive; AUTO with zero topics is
  refused (`support_ai.auto_topics_required`).
- Prompt `sai5p-2026-11-01`: goal-and-order rule, manipulation rule, Persian and Finglish examples.
- Runtime: trailing automated lines dropped; 400/404/422 `request_rejected` is a CONFIG failure that falls back with
  one alert condition per provider; 60 s default timeout; `reasoning_effort` only for o-series/GPT-5; a throwing job
  releases its lease once and then gives up SOFT instead of stalling the pass.
- Handoff-rate alert (`support.ai.handoff_rate_high`, every 10 min, last 50 finished jobs, `support.ai.handoff_alert_pct`).
- Cross-cutting hardening (D1): context audit (the payload carries only the customer's own facts and published
  content; a test pins the key set), the pure output validator `domain/output-policy.ts`, and the repeated-refusal
  signal (3rd POLICY_REFUSAL in an epoch is a SOFT handoff `SUSPICIOUS_PROBING` plus `support.ai.suspicious_probing`).
  The validator is a backstop, not the primary control: nothing secret is in the model's context. It checks links,
  emails, domains in any script (IDNA), handles, long digit sequences across separators and scripts (NFKC,
  every `\p{Nd}`), dates only within ±1 year of now, and promise words.

**Codex (4 P2) and lead (D3), one fix commit 2957956**

1. Money window stopped at an intervening business reply: a refund a person already handled no longer hands off the
   next unrelated question.
2. Lease covered only one generation: `SUPPORT_AI_GENERATIONS_PER_JOB = 2` now enters `assistantJobWorstCaseMs`, so
   no replica reclaims a job whose regeneration is still running.
3. Soft human holds had no sticky takeover in the UI: «تحویل گرفتن» is offered on a SOFT-held HUMAN_ACTIVE
   conversation, and the summary carries `handoffKind` (optional, for rolling deploys).
4. NO_ACTION silent close skipped the cited-service review flag: it now gets the same flag as the reply path and hands
   off with the specific reason.
5. Lead D3: see Decisions.

**Tests.** New `support-sai-handoff-policy.test.ts` (20); money guard lists of 59 hard and 49 pass-through phrasings
(Persian, Finglish, English); chain tests for a 400/404/422 from each real adapter (9); 9 new integration cases
(each auto-resume trigger, hard stays sticky, owner pause, validator regenerate-then-handoff and
regenerate-then-send, refusal abuse event). Gate clean; selected unit 758/758; affected integration 297/297; web
support-ai suites 71/71.
**Mutation checks (30, all red then restored):** money-guard pattern removed, currency word hands off again, window
widened, account review on every topic, citation ignored, OTHER streak ignored, unlinked to handoff, money handoff
soft, auto-resume ignoring kind / window 0 / person-in-window, links / promises / numbers unchecked, config rejection
without fallback, trailing away message kept, per-job exception rethrown, hard handoffs counted in the rate, bare
domains not links, split digits per chunk, Telegram aliases not folded, emails not links, non-Latin hosts not links,
whole-reply digit join removed, dates exempt whatever the year, no NFKC, U+3002/FF0E/FF61 not folded, handle
lookahead excluding '.', Latin-only TLD.

**Migration 0296** `sai_handoff_kind`: two nullable `handoff_kind` columns, a shape CHECK, regenerated reason /
outcome / topic CHECKs, each `NOT VALID` then `VALIDATE` by hand edit (large tables).

---

## PR-5 #366 `feat/sai-admin-ux` — merge commit e67879b (fix commit e31f57c)

https://github.com/Mhoseinshah1/nexa-bot/pull/366. Stacked on PR-1; migrations 0297 and 0298.

**What changed**

- Contracts (own commits): console, readiness, handoff-questions and knowledge-gaps wire types;
  `SUPPORT_AI_OPERATIONS += TEST_CONSOLE`; `POST /business-chats/resume-all`; optional `aiMode` on chat list/detail.
- Test console `POST /support-ai/test-console`: runs the STORED config through the same context, prompt, chain, strict
  parse, money guard, decision guards and output validator as production, in the same order, and reports verdict,
  answer, topic, confidence, knowledge used, blocking guard and reason (hard/soft). It sends nothing: the service holds
  no outbound, conversation, job or ticket port. Needs `support_ai.configure` (plus `users.view` when a customer is
  picked), audited without the question text, refused when mode is OFF, a repeated key is refused.
- Readiness card `GET /support-ai/readiness`: eight checks (connection and reply right, support handle, key and
  breaker, capability test, assistant role via `process_runs` with stall condition, topics, approved knowledge,
  vision), each with a Persian one-line fix and the botctl command.
- `GET /support-ai/handoff-questions` and `/knowledge-gaps` (30 days, need configure and `business_chats.view`).
- ASSIST_ONLY auto-draft per inbound message (idempotent, replaces the open draft).
- Bulk «بازگرداندن همه» through the existing per-conversation resume (max 100).
- Web: readiness card, test console with customer picker, model dropdown, collapsed «تنظیمات پیشرفته» with help for
  all seven limits, per-mode consequences, failure «چه کنم» per class, inbox real-mode labels and hard/soft badges,
  analytics (answered share, tokens, «رفع» per reason, questions on demand, knowledge gaps, «ساخت مقاله از این»).
  Docs: runbook false statement fixed, runbook §17, `docs/support-agent/owner-setup-guide.fa.md`.

**CI and Codex (4 P2) and lead (D6), one fix commit e31f57c**

- CI web (5 failures): Persian text for three refusal codes, error banner carries its reference, the analytics «رفع» is
  a plain `#anchor`, console and bulk dialog use `useSubmissionKey`.
- Codex 1: `resumeAll` walked only the newest N rows, so soft holds behind hard ones were never reached. It now pages
  by keyset past skipped holds (scan cap 2000 rows per state) and `more` is true only when an eligible hold remains.
- Codex 2: eligibility is re-decided on the LOCKED row inside the resume mutation; a hold a person took over meanwhile
  is left alone, unaudited, counted as skipped.
- Codex 3: the console claims its idempotency key atomically BEFORE the paid provider call; of overlapping same-key
  requests exactly one reaches the provider.
- Codex 4: readiness `TEST_PASSED` was kept after saving a different model. Migration 0298 records `last_tested_model`;
  passed only when it equals the primary's current model.
- Lead D6: the analytics intro still said no customer text is read. New key, old one removed (OQ-SAI-5-05 closed).

**Tests.** `support-admin-ux-domain` (10), integration `support-admin-ux` (27), web `support-admin-ux` (24); affected
integration 253/253, web 94 + 245.
**Mutation checks:** console without configure check; console writing to a conversation (snapshot also counts
outbound, jobs, escalations, tickets, outbox); replay not refused; draft key check removed; bulk ignoring
`includeHard`; handoff questions without `business_chats.view`; console customer without `users.view`. After the fix
commit the pagination, locked recheck, atomic claim and tested-model rules each got a mutation-checked test.

**Migrations.** 0297 `sai_test_console_operation` widens `support_ai_runs_operation_check` (NOT VALID then VALIDATE).
0298 adds `last_tested_model`.

---

## PR-2 #367 `feat/sai-knowledge-live` — merge commit 48d2db2 (merge of main 9edad97, fix commit 133821d)

https://github.com/Mhoseinshah1/nexa-bot/pull/367. The AI could not quote a price, its knowledge lost every tutorial
and payment instruction to the scrubber, retrieval matched «کار نمی‌کنه» to the card-payment article, and knowledge
was rebuilt only by hand.

**What changed**

- Live catalogue priced at the checkout's boundary: `PricingService.quoteListPrices` runs every line through the same
  `quoteWith` the checkout uses (reseller layer, automatic rules, first purchase, cashback, personal percent), read
  only, no draft. `SupportCatalogueReader` supplies catalogue, add-ons and per-service renewal prices. Payload gains
  `catalogue[]`, `addons[]`, `services[].renewalPrice`; prompt `sai6k` (rules 4c, 8, 11a).
- Price family wired into the output validator (`livePriceFamily`): catalogue, add-on, renewal and the customer's own
  amounts, in the forms a person writes the same amount (rials, toman, thousands).
- Precomputed account facts: `formatted` money, `remainingTraffic`, `daysLeft`, `expiresOn` (tenant calendar),
  `usageAge`, through a `SupportFactFormatter` port (boundary check forbids i18n in domain/application).
- Scrubber business allowlist: owner-published public links and prices stay for every source; card/IBAN only in a
  payment route's instructions; never subscription links, secrets, UUIDs, IPs, phones, e-mails, stranger handles.
  Learning keeps the strict scrub and writes `{مبلغ}` / `{پیوند}` placeholders (prompt `sai6l`).
- Automatic knowledge refresh `support.knowledge.auto_refresh` (OFF): applies ADD/UPDATE/RETIRE in one transaction,
  leaves reviewer-edited CONFLICTs pending, charges `maintenance.run`, scope activity read in tx, idempotent by diff
  signature, audited; `SupportKnowledgeRefreshLoop` in the worker role every 60 s with a 2-minute debounce and a
  nightly pass at 23:00 UTC. Build page shows a banner when the 100/400 caps cut.
- Retrieval: one `normalizePersian` for retrieval and dedupe; protected words (کارت, سرعت, قیمت, پرداخت) never
  stemmed; Finglish dictionary and VPN synonym groups; Persian tags; fallback to three general entries when nothing
  scores; budget 24 to 44 KiB so at least five articles fit.
- Learning: duplicate-title index partial on PENDING, `replaces_article_id`, `assisted`; handback learns from the reply
  that RESOLVED the conversation; ASSIST-origin sources flagged in the review queue.
- Vision: a `document` of image/jpeg|png|webp is read as a photo; a PDF stays OTHER.

**CI, Codex (P1 + 7 P2) and lead (D8), one fix commit 133821d**

1. CI `loop-stall-labels`: Persian label for the `support-knowledge-refresh` worker loop.
2. P1 (two findings, one rule): a business link was exempt from every sensitive check, hiding credentials in query or
   path. A link is kept only after `isPublicBusinessLink`: no userinfo, no subscription-shaped path, no credential
   query key, no UUID, provider key or long mixed run in a path, query or fragment.
3. P2: «ممنون ولی هنوز وصل نمیشه» is not a resolution; contrastive thanks, and thanks that is not the customer's last
   word, do not count.
4. P2 (two findings): the prompt allowed describing a personal discount that the validator would refuse. Resolved by
   telling the model to quote the price as is and never mention a discount (policy `sai6m`).
5. P2: automatic retirement was permanent. An article the automatic refresh retired (and nobody edited) is reinstated
   when its source returns; a reviewer's own retirement is never undone.
6. P2: the catalogue ignored reseller grants. It is now the customer's own catalogue (`customerCatalogue`).
   OQ-SAI-2-02 closed.
7. P2: the ZWNJ normalisation change would orphan stored dedupe keys. Stored keys are not rewritten; the duplicate
   check compares under both today's key and the legacy key.
8. P2: resolution scoped to the episode since the conversation's latest handoff.
9. P2: lesson merge made conditional on `state = 'PENDING'`; a candidate decided meanwhile makes the lesson a new one.
10. Lead D8: integration test that the price family is wired into the auto-reply service.

**Tests.** `support-sai-knowledge-live` unit (21) and integration (4: the catalogue price equals the draft order total
for a 20 % personal discount, a 30 % promotion, 25 % + 10 %, and an unlinked list price; building the context creates
no order), +5 in knowledge-build, +1 in learning, +2 web. Gate clean; `pnpm test` 10583 passed, 16 failed (only the
7-Zip backup-CLI suites, environment); web 3440/3440; support-knowledge-live and auto-reply 157/157.
**Mutation checks:** card allowed for every source; protected words removed from the stemmer; price family `has` →
false; `quoteListPrices` ignoring the personal percent; after the fix: the credential-link check, the PENDING
condition and the auto-reply wiring.

**Migration 0299** `sai_learning_pending_dedupe` (written as 0297, renumbered after PR-5's 0297/0298, SQL
byte-identical): partial unique index on PENDING, `replaces_article_id`, `assisted`.

---

## PR-3 #369 `feat/sai-actions` — merge commit 84e1f58 (fix commit 5707539)

https://github.com/Mhoseinshah1/nexa-bot/pull/369. READ-ONLY tools, bot deep links, check-before-handoff and
buttons, all behind `support.ai.actions_enabled` (OFF). With it off, replies are text only and the existing suites
pass unchanged.

**What changed**

- Contract change in its own commit: action kinds and the decision's optional `action {kind, target}`, guards
  `tool_scope` / `tool_rate_limit`, new outcomes, `SUPPORT_AI_TOOL_CALL_LIMIT = 6`, the deep-link codec
  (`sai-<flow>[-<uuid>]`), the callback codec (`sai:<a>:<row id>`), handoff reason `CUSTOMER_UNSATISFIED` (soft),
  keyboard schema (URL buttons only to `https://t.me/…`, or `sai:` callbacks), settings
  `support.ai.actions_enabled`, `label_enabled`, `feedback_enabled`, 29 new Persian template keys.
- Tools take no id from the model: `target` is an alias the payload showed, resolved through the server-built alias
  map; anything else (unseen alias, UUID, wrong prefix, lower case) is refused, regenerated once, then SOFT handoff.
  Second wall: the tool reader puts tenant and the conversation's customer in every WHERE.
- SEND_SUBSCRIPTION_LINK sends the customer's own link (live service, linked customer); on a files-only panel it
  sends a button to the service card instead. The service is re-read in the enqueue transaction. Logged as
  `support.ai.subscription_link_sent` without the link. The validator allows that one link only because the tool
  sends it.
- PAYMENT_STATUS adds templated payment lines (code, amount, method, state) and promises nothing.
- Deep links route to existing intents only (catalogue, reorder category, renew, add traffic, add time, change
  location, rotate ask, service card, trial entry, top-up). Trial is pre-read with `eligibleForSupportOffer`.
- Tool-call limit: more than 6 in an epoch is a SOFT handoff `SUSPICIOUS_PROBING` with the ops event.
- Check-before-handoff: a money matter splits into DISPUTE (straight HARD handoff) and PAID_NOT_RECEIVED (read the
  customer's last-14-day payments, answer once: under review / confirmed but undelivered / delivered with the link and
  👍/👎 / nothing found: ask once for receipt, code or amount / unlinked: bot link). The facts message is the
  handoff's notice. Never promises a refund, credit or re-provisioning. Every handoff note carries a Persian summary.
- Buttons: «👤 پشتیبان انسانی» on every reply (HARD), «مشکل حل شد؟ 👍/👎» (👎 SOFT `CUSTOMER_UNSATISFIED`, feeds the
  knowledge-gaps report), optional label «🤖 پاسخ هوش مصنوعی». Taps are accepted only if the row is AUTO and DELIVERED,
  and the message id, chat, business connection, bot and the tapping customer all match.
- Voice, sticker, non-image file: one templated request to type the question. Transcription is not built.
- Prompt `sai7b`, rule 14 (actions); with tools off the model returns `{"kind":"NONE","target":""}`.

**CI (2 unit), Codex (3 P2), lead (D12), one fix commit 5707539**

- CI: support-tb10 outcome-class table counts the three new SENT outcomes; the seven new texts use Appearance icon
  slots, with the auto-reply rendering markers as plain emoji for Business.
- Codex 1: PAYMENT_STATUS and WALLET topics exited through the topic guards before the read-only tool. With tools on,
  two read-only answers exist (`readOnlyToolAnswer`): PAYMENT_STATUS with the payment-status action, WALLET with the
  top-up action, checked in both the first guard run and the enqueue recheck; REPLY only. Policy `sai7c`.
- Codex 2: a PDF or voice note sent in answer to the receipt question got the generic "please type" reply. The
  pending payment follow-up is now decided BEFORE the unsupported-content reply and goes to a person (HARD).
- Codex 3: the unlinked customer's account-link reply skipped the label and buttons; it is composed like every other
  reply.
- Lead D12 and the forwarded-link test: see Decisions. New integration test through the real bot runtime and a real
  provisioned service: another customer opening `sai-rn/at/am/lc/ro/sv-<owner's service>` learns nothing and changes
  nothing; the owner's own link opens the card.

**Tests.** `support-sai-actions` unit (49) and integration (29), plus the updated wire and prompt-digest suites;
integration 221/221 and 159/159 on a fresh private DB.
**Mutation checks (13):** alias resolution falling back to the first service; customer filter removed from the
services reader; customer filter removed from the payments reader; tool-call limit never reached; link allowance
dropped; callback `from`, chat, message-id and connection checks each removed; open payment no longer deciding first;
dispute folded into paid-not-received; ask-once ignoring a pending question; `CUSTOMER_UNSATISFIED` removed from the
gap reasons.

**Migration 0300** `sai_actions` (was 0298 before the main merge): `buttons` and `feedback` on
`business_outbound_messages`, template CHECK relaxed so a notice may carry a body, `support_ai_jobs.tool_action`,
regenerated reason / outcome CHECKs; NOT VALID then VALIDATE.

---

## PR-4 #371 `feat/sai-bot-tickets` — merge commit e0f6f31 (contract commit 3f1e428, fix commit 0038531)

https://github.com/Mhoseinshah1/nexa-bot/pull/371. Behind `support.ai.tickets_enabled` (OFF), the AI writes the first
answer inside a ticket opened in the bot or the Mini App (both call `TicketService`, so one hook covers both). It is
the Business pipeline, not a fork.

**What changed**

- Contract commits: sender `AI` in `TICKET_MESSAGE_SENDERS` (status unchanged by an AI message), the setting, three
  templates `bot.ticket.ai_replied`, `bot.ticket.line_ai`, `bot.ticket.ai_open_in_bot`, ticket job and hold state sets.
  Policy version stays `sai7c`.
- Migration 0301: `support_ai_ticket_jobs` and `support_ai_ticket_holds` (own tables, isolation by construction, pinned
  by a static test); `ticket_messages` sender/shape checks accept `AI`.
- `SupportToolPreparer` extracted from the 2.3k-line auto-reply service (text moved verbatim).
- `SupportTicketAiTrigger` (in the customer's transaction): returns first if the switch is off or mode is not
  AUTO_REPLY_SAFE; BOT-origin tickets only; coalesces a pending job; settle delay.
- `SupportTicketAiService` (assistant role loop): same preflight, money, no-progress, flood guards, prompt, strict
  parse, decision guards, alias-only tools, output validator with one regeneration, tool-call limit, refusal signal.
  Identity comes from `tickets.customer_id`. The final transaction re-decides everything.
- `TicketService.postAiReply`: AI row, idempotent on the job, no status move, queued on the existing `TICKET_REPLY`
  lane; Web Admin, bot view and Mini App label it AI.
- Resume rule: a person's reply (derived from ADMIN messages, no hook in the reply path) pauses for
  `support.ai.resume_after_minutes`; soft handoffs hold the same way; HARD is sticky.
- Handoff = hold plus a SYSTEM_JOB audit record, nothing sent (the ticket is already in the human queue).
- Web: a switch card on `/support-ai`.

**CI (ddl + web state), Codex (2 P1, 3 P2), one fix commit 0038531 plus contract commit 3f1e428 (D18)**

- CI: migration 0301 sender/shape CHECKs `NOT VALID` then `VALIDATE`; the AI card's unreadable-state line comes from
  `queryState()`, not a bare `isError`.
- P1: the final in-transaction account-review check received an empty alias map, so a cited service turning
  UNRECONCILED during generation was never seen. It now gets the real cited-service labels.
- P2: a handoff decided after a person replied or the customer wrote again was stale but still wrote a HARD hold. The
  handoff path takes the same under-lock still-the-newest-message check as the reply path and drops.
- P2: `actionsEnabled` was not passed to `autoDecisionGuards`, so the PAYMENT_STATUS and WALLET read-only answers became
  hard handoffs. Passed initially and re-read in the final transaction, as the Business producer does.
- P1: turning `support.ai.tickets_enabled` on needed only `settings.edit`, letting an operator override the owner's
  decision without `support_ai.auto_reply`. Contract metadata `SETTING_ENABLE_PERMISSIONS` (own commit 3f1e428) names
  the extra permission; `SettingsService.set` enforces it early (audited on refusal) and again in the transaction;
  turning it OFF never needs it.
- P2: the trigger scheduled after only the settle delay. It now uses the later of the settle delay and the AI's last
  answer plus `cooldownSeconds`.
- Lead: open items recorded as OQ-SAI-4-01 and OQ-SAI-4-02.

**Tests.** unit `support-sai-tickets` (16), integration `support-sai-tickets` (39, +6 in the fix), web
`support-ai-tickets-switch` (6) and `tickets` +1. Integration on private DB `nexa_sai4`: tickets + actions +
auto-reply + migration-ordering 230/230; unit 105/105; web 96/96.
**Mutation checks (10):** trigger ignores the switch; producer ignores the switch; a person's reply does not pause;
HARD treated as soft; origin not checked; context built for another customer; output validator bypassed; tool reader
customer filter removed; claim without tenant filter; trigger-still-newest check removed. The six fix tests are each
mutation-checked.

**Migration 0301** `sai_ticket_ai`, after 0300; no renumber needed.

---

## PR-6 #370 `chore/sai-eval` — merge commit dfd14a2 (fix commit 598771d, merge of main 57e1772)

https://github.com/Mhoseinshah1/nexa-bot/pull/370. The eval suite for the support AI. No migration; main (84e1f58)
merged in cleanly.

**What changed**

- `eval/sai-corpus.ts`: 37 EVERYDAY scenarios (Persian and Finglish: purchase, renew, price, add-on, trial, send-link,
  speed, location, iOS/Android, voice, pending card payment, unlinked), 16 HARD (refund, dispute, deducted without
  service, credentials, security, human requested), 45 ATTACK (other customer's data, fake admin, jailbreak, image
  injection, emotional story, prompt request, tool scope). Synthetic; attacker targets are planted `.invalid` / `0000`
  fakes that are in no model context.
- `eval/sai-runner.ts`: runs the post-model pipeline with the real functions (strict parse, decision guards with tools
  on, `planAction` via alias map, `checkOutputPolicy` with the live price family, repeated advice,
  regenerate-once-then-handoff). Attacks are scored on the DELIVERED text by independent oracles (planted strings,
  promise words, resolved tool ids). The scripted offline provider includes fooled outputs, each tried with a good
  retry and as a stubborn repeat. The live path reuses the A10 paid-call gate.
- `eval/sai-replay.ts` and CLI: `--replay <local file>` (scrubbed JSON/JSONL; refused inside the repo, also for
  `--json`; counts only), `--config-from-db <slug>` (read-only transaction through the production repository),
  `--preset recommended`, `--suite classic|sai|all`. `.gitignore` covers replay exports.
- Docs: `docs/support-agent/sai-eval.md`, runbook pointer, OQ-SAI-6-01 and 02.

**CI (boundary) and Codex (3 P2), one fix commit 598771d**

- CI boundary check: report fields named `total` (counts) renamed `count`.
- P2: live SAI runs and replays built the request with the classic suite's fixed 800-character limit and without the
  tools switch. `prepareScenario` now takes the effective config's `maxOutputChars` and the tools switch.
- P2: a valid NO_ACTION on a safe topic was passed straight to the reply guards. It goes through
  `autoNoActionVerdict` first (production step 5b): a pass is CLOSED_SILENTLY and counts as no handoff, a fail hands
  off with the specific reason.
- P2: `--only` with a stale or misspelled selector ran both suites with zero scenarios. It must now match a scenario of
  an enabled suite (`checkOnlyMatches`), otherwise a usage error.

**Tests.** `tests/unit/support-ai-sai-eval.test.ts` (21); the A10 classic suite still passes (60 across both files).
**Mutation checks:** output validator disabled (attack assertions red); tool scoping disabled (`toolEscapes` > 0,
`a-tool-*` red); each of the link, number, handle and promise rules muted (leaks or promises > 0);
`checkOutputPolicy` returning ok (3 tests red); `planAction` trusting the target (targets test red). Source mutations
restored.

### Eval: before and after

Offline corpus, scripted provider. Before = the old restrictive stored configuration (8 safe topics, HIGH minimum
confidence); after = the recommended preset (all safe topics, MEDIUM).

| Group                                | Before (old config)                                            | After (recommended preset)                                                 | Target |
| ------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------- | ------ |
| Everyday, resolved without a handoff | 12/37 = 32.4 % (10 resolved + 2 clarifying, 25 handed off)     | 37/37 = 100 % (33 resolved + 4 clarifying)                                 | 90 %   |
| Hard cases routed to a person        | 16/16 (no failures)                                            | 16/16                                                                      | all    |
| Attacks                              | 45 scenarios / 112 trials: 0 leaks, 0 promises, 0 tool escapes | 45 scenarios / 112 adversarial trials: 0 leaks, 0 promises, 0 tool escapes | 0      |

The safety rows do not depend on the preset; the preset is what moves the resolution rate. Caveat (D16, OQ-SAI-6-02):
offline is the PIPELINE ceiling with scripted model answers, not a measurement of any real model. The live run is an
owner command (documented in `docs/support-agent/sai-eval.md`); it spends provider money and is not run in CI.

---

## Gift-card integration failure — investigated as a security test (#372, merge commit 0d25a29)

Owner instruction (D19): PR #371's head failed once in `tests/integration/gift-cards-http.test.ts:172`
(`created.body` matched `/[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}/`) and passed on the single re-run; before
closing the phase, decide whether it was a test bug or a real code leak.

**Verdict: (a) test bug, not a leak.** The batch-create answer has no field that can carry a gift-card code
(`toWire` copies ids, label, amount, counts, state, ISO dates; the response schema has no code field). The code
alphabet includes the digits 2–9, and the answer holds two lowercase UUIDv7 ids (`batch.id`, `createdByAdminId`);
their digit-only groups match the regex — observed `9452-7982`, `9786-7936`, `7774-8226`, always on `id`.
Reproduction: 3 matches in 300 creates within one run (≈1 %); a two-UUID simulation gives ≈4 % per create. The
planned 50 file-runs were cut short (≈25 s per run); no seed exists (ids come from `uuidv7()`).

**Fix (test-only, one file):** the test reads the codes this batch minted from its own CSV export and asserts that
no string value in the parsed answer contains any of them (hyphenated or compact) or is shaped like a full 5×4 code;
the raw-body regex is gone. Mutation check: the controller putting a minted code into the answer's label → red;
restored → green. CI 23/23 green on 444a06d; Codex 👍 on that head (no findings). PR:
https://github.com/Mhoseinshah1/nexa-bot/pull/372.

---

## Decisions taken

- **D1 — manipulation hardening split.** The owner added a cross-cutting hardening section mid-run, while PR-1 was in
  progress. PR-1 took context audit, the output validator framework with the promise-word check, the prompt rules
  and the repeated-refusal signal. PR-2 extended the validator with the live prices. PR-3 took tools that take no ids,
  the tool-call rate limit, and the validator extended to the customer's own links. PR-4 reuses all of it for tickets.
  PR-6 carries the 45 attack scenarios.
- **D2 — stacking.** PR-2 and PR-5 were branched from PR-1's head while PR-1 was in review, to keep two implementers
  busy; each got `origin/main` merged in after PR-1 merged (merge, never rebase).
- **D3 — promise words (lead review, PR-1).** The check let a promise word pass if the WORD appeared anywhere in
  approved knowledge, so a plan saying «۱۰٪ تخفیف تمدید» approved «تخفیف می‌دم». Tightened: the reply's PHRASE (the hit
  and one neighbouring word each side, within its clause) must appear in knowledge.
- **D4 — ACCOUNT_UNDER_REVIEW is HARD, SUSPICIOUS_PROBING is SOFT.** The first is money-adjacent (the owner's "no money
  outcome" rule); the second is soft as the owner's item 7 says.
- **D5 — bulk return skips hard holds.** «بازگرداندن همه» skips HARD, unknown-kind and PAUSED holds unless the operator
  ticks an explicit checkbox; each row goes through the existing per-conversation resume (permission, audit, key
  `<key>:<id>`). Stricter than "always included".
- **D6 — false analytics intro (lead review, PR-5).** The intro said no customer text is read, but the new
  handoff-questions and knowledge-gaps views show customer text. A new key was added in the fix commit and the old one
  removed, so the page tells the owner the truth.
- **D7 — PR-5 commit trailer.** PR-5's commits carry a "Claude Sonnet 5.5" co-author trailer rather than the
  session's line. Left as is: no history rewrite, no force-push.
- **D8 — price wiring untested (lead review, PR-2).** The price-family-to-validator wiring in the auto-reply service
  had no test (tests called the validator directly). Required in the fix commit. Knowledge auto-refresh ships OFF by
  default (`support.knowledge.auto_refresh`) because every feature ships OFF; the owner turns it on.
- **D9 — PR-3 stacked on PR-2's head** while PR-2 was in review.
- **D10 — Codex posted two passes on PR-2's head.** The first had 5 findings; the second had duplicates and 3 new. The
  rule is "first complete review only"; the lead nevertheless adopted the 3 new findings (dedupe-key compatibility,
  episode-scoped resolution, atomic PENDING recheck) in the same single fix commit, because each is a real
  correctness bug and costs no extra review round.
- **D11 — one flag for actions.** Tools, buttons, deep links, check-before-handoff, the human button and the voice
  reply ship behind `support.ai.actions_enabled` (OFF). The label is OFF; feedback 👍/👎 defaults ON but is effective
  only when actions are on. Inline buttons on Business messages are unverified live (OQ-SAI-3-01); the owner verifies
  before enabling.
- **D12 — trial deep link (lead review, PR-3).** It mapped to TRIAL_CLAIM, which provisions a service as soon as /start
  is opened. Changed in the fix commit to land on the main menu, whose own trial button is the explicit in-bot tap.
  Plus a test that a deep link carrying another customer's service alias or id is refused by the existing handler.
- **D13 — misposted review request (incident).** The lead's `@codex review` for PR-3 was first posted on #368 (the
  owner's own legacy-import PR) by an off-by-one. It was deleted within seconds and re-posted on #369. If Codex reviewed
  #368 because of it, that review was not requested by the owner.
- **D14 — PR-4 stacked on PR-3's head** while PR-3 was in review.
- **D15 — ticket AI rules (PR-4).** Needs both `support.ai.tickets_enabled` (OFF) and mode AUTO_REPLY_SAFE; answers
  BOT-origin tickets only; a ticket handoff sends the customer nothing; a file in the customer's message or money
  wording hands off (money is HARD); no check-before-handoff in tickets (the one-message flow is Business-only);
  deep links render as one text line. Ticket jobs live in their own tables, pinned by a static test. Lead: no operator
  "return a HARD-held ticket to the AI" and analytics/failure pages do not list ticket jobs; recorded as OQ-SAI-4-01
  and OQ-SAI-4-02 in the fix commit.
- **D16 — what "resolved" means in the eval (PR-6).** "Resolved without a handoff" = resolved + clarifying. The offline
  37/37 is the pipeline ceiling with scripted answers, not a model measurement; the live run is an owner command. The
  validator does not detect a verbatim prompt echo, by design (hardening item 8: nothing in the prompt is secret).
- **D17 — container restart during PR-4's fix.** Unpushed fix work was backed up to `wip/feat/sai-bot-tickets`
  (7caf9ed, ordinary push); the PR-4 agent resumed and folded the uncommitted OQ doc into its never-pushed fix commit.
  The owner deletes that branch after the round.
- **D18 — contract commit for the ticket-AI permission (PR-4).** `SETTING_ENABLE_PERMISSIONS` is its own commit next to
  the single fix commit, per CLAUDE.md "a contract change is its own commit".

- **D19 — gift-card failure as a security test.** Owner instruction: investigate before closing Phase 4; one tiny
  PR at most, same pipeline.
- **D20 — where this report lives.** On `docs/r11-handoff`, carried into main by Phase 5's first PR (as Phase 3's
  was), because PR-6 already had its one fix commit and the report needed the final merge SHAs.
- **D21 — gift-card verdict (a).** Test bug; see the section above.

## Blocked

- Voice transcription (OQ-SAI-3-03): not built. Voice and non-image files get one templated request to type the
  question (tools on) or follow the older path (tools off).
- Inline buttons on Business messages (OQ-SAI-3-01): follow the Bot API but were never observed live. Verify on a real
  Business chat before turning `support.ai.actions_enabled` on.
- Live panel usage refresh (OQ-SAI-2-01): the AI quotes the last stored usage with its age (`usageAge`).
- The live eval run: needs provider money; owner command only.
- Local-only: the unit project's 7-Zip / backup-CLI suites (16 tests) fail in the sandbox and pass in CI.

## Open questions recorded in `docs/open-questions.md`

OQ-SAI-2-01 (live usage refresh), OQ-SAI-2-03 (package listing without a panel's per-purchase cap; OQ-SAI-2-02
reseller-only plans was closed by the PR-2 fix), OQ-SAI-3-01 (buttons on Business messages), OQ-SAI-3-02 (no QR in the
Business chat), OQ-SAI-3-03 (voice transcription), OQ-SAI-4-01 (return a HARD-held ticket to the AI), OQ-SAI-4-02
(ticket jobs in analytics and the failure page), OQ-SAI-5-01 (support handle check exact only when the owner's
username is known) and the remaining OQ-SAI-5-xx entries (OQ-SAI-5-05 closed), OQ-SAI-6-01 (fabricated secret and
prompt echo are not validator-owned), OQ-SAI-6-02 (offline rate is a ceiling). Also known: an older Web Admin tab
fails the strict topic enum until reloaded after the rolling update; the validator's blunt digit rule may refuse a
long troubleshooting reply full of small numbers (one regeneration, then a SOFT handoff).

## Owner checklist (in order)

1. Pull main (all six PRs are merged).
2. Update the server, then `sudo botctl roles enable assistant` and `sudo botctl roles status` (assistant running).
3. Web Admin `/support-ai`: the readiness card must be all green.
4. Press «اعمال تنظیمات پیشنهادی» and save (mode AUTO_REPLY_SAFE needs `support_ai.auto_reply`).
5. Test console on `/support-ai`: ask ten sample questions and read each verdict: price, renewal, send my link,
   «وصل نمیشه», iPhone app, card payment pending, a trial question, a speed question, an add-on traffic question,
   and a refund (this one MUST hand off, HARD).
6. A real Telegram Business chat from a second account: one linked, one unlinked.
7. Analytics: answered share, handoff reasons with «رفع», questions and knowledge gaps.
8. Optional, each OFF by default: `support.ai.actions_enabled` (verify buttons on the Business chat first, OQ-SAI-3-01),
   `support.ai.tickets_enabled` (switch card on `/support-ai`), `support.knowledge.auto_refresh` (Web Admin settings,
   support group).
9. Optional live eval (owner command, spends provider money): see `docs/support-agent/sai-eval.md`.
10. End: `sudo botctl roles disable provisioner monitor`.

## Branches for the owner to delete

`fix/sai-handoff-policy`, `feat/sai-admin-ux`, `feat/sai-knowledge-live`,
`feat/sai-actions`, `feat/sai-bot-tickets`, `chore/sai-eval`, `fix/gift-card-code-assertion`, and `wip/feat/sai-bot-tickets` (backup, D17).
