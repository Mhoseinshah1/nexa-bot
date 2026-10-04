# TB5 — Assist Mode

**Status: implemented.** Program: Intelligent Support Agent. Decided by ADR-0034 §6–§7.
Builds on TB2 (conversations and the lane), TB3 (the support context) and TB4 (providers).

The AI drafts. A person decides and sends. Nothing in this package sends a message by itself.

## What TB5 delivers

| Concern    | Implementation                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contract   | `SUPPORT_AI_DECISIONS`, the closed SAFE and HANDOFF topic sets (disjoint), `supportAiDecisionSchema` (strict), the matching provider JSON schema (closed, fully required), job kinds and states, the draft view and requests, `SUPPORT_AI_ASSIST_ROUTES`, `SUPPORT_AI_DRAFT_RETENTION_DAYS = 30`, and the permission `support_ai.assist`.              |
| Schema     | `support_ai_jobs` (migration `0201`); grants in `0202`. Every state and decision column is CHECK-pinned to its contract enum.                                                                                                                                                                                                                          |
| Jobs       | Every transition is a conditional UPDATE naming its `from` state. A draft discarded while the `assistant` role was producing it is never resurrected. A newer request discards the conversation's older open draft.                                                                                                                                    |
| Production | The `assistant` process role (the sixth) claims QUEUED jobs with a lease. Outside any transaction, it builds the prompt from the bounded transcript (the last 20 messages, 1,500 characters each), the TB3 payload and the fixed policy (`SUPPORT_AI_POLICY_VERSION`), then calls the TB4 chain. A job claimed three times without a result is failed. |
| Validation | The output is parsed by the strict decision schema and the configured reply bound. Anything else is a `FAILED` draft with `decision.invalid`, never shown as advice. A cited alias the payload did not contain is dropped. The operator sees labels (a service's username, an order's title, a payment's method and amount), never row ids.            |
| Sending    | Only the operator sends, edited or not. The send goes through TB2's `enqueueHumanSend` as an `ASSIST` row and needs `business_chats.reply`. It is a human signal, so the conversation becomes `HUMAN_ACTIVE` and the epoch moves. The operator's key makes a retry send once.                                                                          |
| Mode       | `OFF` refuses a request. `ASSIST_ONLY` and above allow drafts.                                                                                                                                                                                                                                                                                         |
| Retention  | Draft text (summary, intent, reply and labels) is purged with the transcript after 30 days.                                                                                                                                                                                                                                                            |
| Surfaces   | Draft list, request, send and discard routes on the web controller. Authorization is in the service.                                                                                                                                                                                                                                                   |
| Deployment | `assistant` service in `deploy/compose.yml`, `start:assistant`, heartbeat `ASSISTANT_HEARTBEAT_PATH`. It is not in `NEXA_READY_SERVICES`: a provider outage must not block an update.                                                                                                                                                                  |

## Decisions made in this package

1. **The policy prompt is not the defence against prompt injection.** The model has no authority to abuse: its scope is bound server-side, and its output is a validated decision with no mutating action. The prompt still states the rules, so an attack produces a handoff instead of a confused answer. Customer text and the NEXA facts are labelled as data.
2. **An unlinked customer's prompt says to discuss no account.** The TB3 payload carries no account for them either; the prompt is the second line.
3. **The transcript starts with the customer** and alternates turns, merging consecutive lines from the same side. Every provider requires this.
4. **A draft's citation is evidence only if the payload contained it.**

## Tests

- `tests/unit/support-ai-prompt.test.ts` (14): the rules, the data framing, the unlinked rule, tone below the rules, turn shaping and the decision schema.
- `tests/unit/support-context-source.test.ts` (3): labels never carry row ids; linkage comes from the payload; a system scope is refused.
- `tests/integration/support-assist.test.ts` (9): a draft and no send; an invalid, over-long or extra-key decision becomes FAILED; a chain failure becomes FAILED; operator send through the lane, which takes the conversation, with a replay sending once; a newer request discards; no resurrection; OFF refuses; permissions.

Mutation results are in `tb5-falsification.md`.
