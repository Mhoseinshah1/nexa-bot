# TB4 — AI provider foundation

**Status: implemented.** Program: Intelligent Support Agent. Decided by ADR-0034. This
package does **not** send anything automatically to a customer. TB5 (Assist) and TB7 (Auto
Reply) are the callers.

## 1. What TB4 delivers

| Concern           | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vocabulary        | `packages/contracts/src/support-ai.ts`: three providers (`OPENAI`, `ANTHROPIC`, `ZAI`), three modes (`OFF` default, `ASSIST_ONLY`, `AUTO_REPLY_SAFE`), seven outcomes, capabilities, configuration bounds and the operational-event codes.                                                                                                                                                                                                                                                                                    |
| Adapters          | `apps/api/src/infrastructure/ai/{openai,anthropic,zai}-adapter.ts`, over one HTTP sink (`ai-http.ts`). The sink refuses to run inside a transaction, sets `redirect: 'error'`, has an abort timeout and a bounded body read (1 MB: `body_too_large`; a failed read: `body_read_failed`), never throws, and logs nothing. **No SDK dependency.** A 2xx whose body is not JSON (a proxy's page) is `TEMPORARY`. The output budget is the caller's `maxOutputTokens` plus a bounded headroom (`outputTokenBudget`, `OQ-TB-20`).  |
| Chain             | `SupportAiChain`. It falls back only on `RATE_LIMITED`, `AUTH_FAILED`, `TEMPORARY` and `TIMEOUT`, and **stops** on `INVALID_OUTPUT` and `REFUSED_BY_PROVIDER`. A step without a key is skipped, never called keyless. A tripped provider is skipped.                                                                                                                                                                                                                                                                          |
| Breaker           | State lives on the credential row (`consecutive_failures`, `tripped_until`). Three consecutive transient failures open it for 5 minutes. After that ONE caller claims the half-open probe (`claimProbe`, a conditional UPDATE pushing `tripped_until` forward); every other caller keeps skipping. Each update is a single conditional statement bound to the key version (`api_key_set_at`) the call was made with, which is safe across replicas and against a key replaced mid-call. `operational_events` only reports it. |
| Rejected key      | `rejected_at` on the credential row. `support.ai_provider.credential_rejected` is raised on the transition into rejected and closed when the provider next answers **`OK`** (never on `INVALID_OUTPUT`, which may be a 4xx), the key is replaced or the key is removed (TB0 amendment 4). State and alert are two writes, so the alert is self-healing (`SupportAiCredentialAlert`): a rejected key with no open alert raises it again, an accepted key with one open closes it. Bound to the key version throughout.         |
| Chain unavailable | `support.ai_provider.unavailable` is raised when every step failed. `support.ai_provider.available` is recorded only when that condition is open, under a dedupe key, so two concurrent successes collapse onto one row.                                                                                                                                                                                                                                                                                                      |
| Configuration     | `support_ai_configs`: one row per tenant, created on the first save, with optimistic versioning. Every input bound is also a CHECK, including the settle delay (default 6 s, range 3–30 s). A tenant with no row runs on `SUPPORT_AI_DEFAULT_CONFIG`, which is mode `OFF`.                                                                                                                                                                                                                                                    |
| Keys              | `support_ai_provider_credentials`, under secret purpose `support_ai_provider.api_key` (AAD bound to the row id) and registered in `SECRET_COLUMNS` for rotation. A key is set, never read back, and has no masked stand-in. The audit records which provider's key changed, never the value, and the idempotency request hash never includes it (a replay with a different key value under the same idempotency key answers the first result). Deleting a key deletes the row.                                                |
| Permissions       | `support_ai.configure` (HIGH) and `support_ai.auto_reply` (CRITICAL, requires configure), granted to owner only by `0200`. **Entering** `AUTO_REPLY_SAFE` needs `auto_reply`; leaving it needs only `configure`. A refusal of `auto_reply` leaves its own DENIED audit row and denial event.                                                                                                                                                                                                                                  |
| Telemetry         | `support_ai_runs` records provider, model, position in the fallback chain, latency, tokens, outcome and failure code. **No prompt and no response are stored.** `GET /support-ai/usage` returns a 30-day summary.                                                                                                                                                                                                                                                                                                             |
| API               | `GET` and `PUT /support-ai/config`, `PUT` and `DELETE /support-ai/credentials/:provider`, `POST /support-ai/credentials/:provider/test`, `GET /support-ai/usage`.                                                                                                                                                                                                                                                                                                                                                             |

## 2. Wire decisions (from the TB4 audit of each provider's official reference, SDK or OpenAPI spec)

**OpenAI**

- Calls go to `POST /v1/chat/completions` with `response_format: json_schema` (`strict: true`) and `max_completion_tokens`.
- Responses are checked in this order: refusal, then `finish_reason`, then JSON.
- `insufficient_quota` and `billing_hard_limit_reached` map to `AUTH_FAILED` with `quota`.
- The connection test is `GET /v1/models/{model}`.

**Anthropic**

- Calls go to `POST /v1/messages` with `output_config.format: json_schema`, which is GA and needs no beta header.
- No forced tool is used, because the current models refuse `tool_choice` forcing.
- `stop_reason: refusal` on a 200 is checked first.
- 402 and `billing_error` map to `AUTH_FAILED` with `quota`. 529 maps to `TEMPORARY`. 504 maps to `TIMEOUT`.
- The connection test is `GET /v1/models/{model}`.

**Z.AI**

- Calls go to `POST {host}/chat/completions`. The host is a closed per-key region choice, never a URL: `api.z.ai` (INTERNATIONAL) or `open.bigmodel.cn` (CHINA).
- Requests use `response_format: json_object`, with the schema stated in the system prompt (`structuredOutput: false`).
- Business code `1301` maps to a refusal. `1113` maps to `AUTH_FAILED` with `quota`.
- No models endpoint is documented, so the connection test is a 1-token completion.

**All three providers**

- A 400, 404 or 422 is configuration rather than a transient failure. It is reported as `INVALID_OUTPUT` so that no fallback hides the mistake. Being a 4xx, it never clears a rejection.
- A 2xx whose body is not JSON is not the provider answering: `TEMPORARY` (falls back), for a generation and a connection test alike.
- `max_tokens` (Anthropic, Z.AI) and `max_completion_tokens` (OpenAI) are `outputTokenBudget(maxOutputTokens)`: the caller's figure plus `AI_OUTPUT_TOKEN_HEADROOM` (4 096), capped at 8 192 and never below the caller's figure, so reasoning or thinking tokens do not truncate the reply. No effort or thinking field is sent for OpenAI or Anthropic until the acceptance proves one (`OQ-TB-20`).
- Output is first unwrapped from a ```json fence. The caller's zod schema is the authority.

## 3. Decisions made in this package

1. **Quota is `AUTH_FAILED` with `quota: true`, not an eighth outcome.** It is not transient.
   Retrying it is useless. The operator must act on the credential. The alert says which of
   the two it is.
2. **The `assistant` process role moves to TB5.** TB4 makes no background calls. The chain
   runs in whatever role calls it, and the only TB4 caller is the operator's connection test,
   a deliberate API action like the panel connection test. TB5 brings the first background
   producer (draft jobs), and the role and its `deploy/` service arrive with it.
3. **Cost is not calculated.** `OQ-TB-07` stands: no price table is hard-coded. The run rows
   carry tokens. A tenant-entered per-model price is TB10's.
4. **The Web Admin settings page is TB5's**, together with the Assist controls it sits beside.
   TB4 ships the API.

## 4. Tests

- `tests/unit/support-ai-adapters.test.ts` is **the shared contract suite**. All three adapters
  must pass the same cases: success with usage, refusal, truncation, non-JSON, overload, a
  rejected key, quota, 429 with the provider's wait, timeout, network failure, and the key
  appearing only in a header with no redirect. Provider-specific wire details are tested
  alongside.
- `tests/unit/support-ai-chain.test.ts` covers the fallback rules, the stop on unsafe or
  invalid output, the rejected-key alert raised once and closed once, the tripped and keyless
  skips, breaker counting, chain exhaustion, and `OFF`; since the substitute review also the
  single half-open probe, the self-healing alert, `INVALID_OUTPUT` never clearing a rejection,
  the gated and deduplicated recovery, and the distinct-providers schema rule.
- `tests/integration/support-ai-config.test.ts` covers the `OFF` default with no row,
  optimistic versioning, the 3–30 s CHECK, the CRITICAL entry into automatic replies, the
  one-way key (no key in any view, audit row, operational event or ciphertext), a region only
  for Z.AI, rejection closed by replacement, deletion, the breaker threshold, and telemetry;
  since the substitute review also the `auto_reply` denial trail, a stopped tenant, a slow call
  holding a replaced key (no rejection, no breaker count, no clearing), the probe claim, and
  the key kept out of the idempotency hash.
- Mutation results are in `tb4-falsification.md` (38 of 38 killed).

## 5. Opt-in real-provider acceptance (`OQ-TB-20`)

Not run in CI and never with customer data. With a test key for each provider:

1. `PUT /support-ai/credentials/:provider`, then `POST …/test` with a current model id.
   Expect `OK`.
2. Replace the key with a wrong one and test again. Expect `AUTH_FAILED`, and one open
   `credential_rejected`.
3. Through a staging-only harness, call the chain with a small JSON schema. Record the real
   response shape.
4. Wherever the real shape differs from the fixtures in `support-ai-adapters.test.ts`,
   correct the fixture and the adapter **in the same commit**.
5. With an Anthropic key whose balance is exhausted, record whether the answer is a 402 /
   `billing_error` or a 400 "credit balance is too low", and map it from that fixture.
6. With a reasoning model on each provider, record how many output tokens thinking consumes
   for a typical decision, and settle which effort or thinking field to send.
