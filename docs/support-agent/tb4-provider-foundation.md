# TB4 — AI provider foundation

**Status: implemented.** Program: Intelligent Support Agent. Decided by ADR-0034. This
package does **not** send anything automatically to a customer. TB5 (Assist) and TB7 (Auto
Reply) are the callers.

## 1. What TB4 delivers

| Concern           | Implementation                                                                                                                                                                                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vocabulary        | `packages/contracts/src/support-ai.ts`: three providers (`OPENAI`, `ANTHROPIC`, `ZAI`), three modes (`OFF` default, `ASSIST_ONLY`, `AUTO_REPLY_SAFE`), seven outcomes, capabilities, configuration bounds and the operational-event codes.                                                                                   |
| Adapters          | `apps/api/src/infrastructure/ai/{openai,anthropic,zai}-adapter.ts`, over one HTTP sink (`ai-http.ts`). The sink refuses to run inside a transaction, sets `redirect: 'error'`, has an abort timeout and a bounded body read, never throws, and logs nothing. **No SDK dependency.**                                          |
| Chain             | `SupportAiChain`. It falls back only on `RATE_LIMITED`, `AUTH_FAILED`, `TEMPORARY` and `TIMEOUT`, and **stops** on `INVALID_OUTPUT` and `REFUSED_BY_PROVIDER`. A step without a key is skipped, never called keyless. A tripped provider is skipped.                                                                         |
| Breaker           | State lives on the credential row (`consecutive_failures`, `tripped_until`). Three consecutive transient failures open it for 5 minutes, and the first call after that is the half-open probe. Each update is a single conditional statement, which is safe across replicas. `operational_events` only reports it.           |
| Rejected key      | `rejected_at` on the credential row. `support.ai_provider.credential_rejected` is raised **once**, on the transition into rejected, and closed **once**, when the provider next answers, the key is replaced or the key is removed (TB0 amendment 4).                                                                        |
| Chain unavailable | `support.ai_provider.unavailable` is raised when every step failed. `support.ai_provider.available` is recorded only when that condition is open.                                                                                                                                                                            |
| Configuration     | `support_ai_configs`: one row per tenant, created on the first save, with optimistic versioning. Every input bound is also a CHECK, including the settle delay (default 6 s, range 3–30 s). A tenant with no row runs on `SUPPORT_AI_DEFAULT_CONFIG`, which is mode `OFF`.                                                   |
| Keys              | `support_ai_provider_credentials`, under secret purpose `support_ai_provider.api_key` (AAD bound to the row id) and registered in `SECRET_COLUMNS` for rotation. A key is set, never read back, and has no masked stand-in. The audit records which provider's key changed, never the value. Deleting a key deletes the row. |
| Permissions       | `support_ai.configure` (HIGH) and `support_ai.auto_reply` (CRITICAL, requires configure), granted to owner only by `0200`. **Entering** `AUTO_REPLY_SAFE` needs `auto_reply`; leaving it needs only `configure`.                                                                                                             |
| Telemetry         | `support_ai_runs` records provider, model, position in the fallback chain, latency, tokens, outcome and failure code. **No prompt and no response are stored.** `GET /support-ai/usage` returns a 30-day summary.                                                                                                            |
| API               | `GET` and `PUT /support-ai/config`, `PUT` and `DELETE /support-ai/credentials/:provider`, `POST /support-ai/credentials/:provider/test`, `GET /support-ai/usage`.                                                                                                                                                            |

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

- A 400, 404 or 422 is configuration rather than a transient failure. It is reported as `INVALID_OUTPUT` so that no fallback hides the mistake.
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
  skips, breaker counting, chain exhaustion, and `OFF`.
- `tests/integration/support-ai-config.test.ts` covers the `OFF` default with no row,
  optimistic versioning, the 3–30 s CHECK, the CRITICAL entry into automatic replies, the
  one-way key (no key in any view, audit row, operational event or ciphertext), a region only
  for Z.AI, rejection closed by replacement, deletion, the breaker threshold, and telemetry.
- Mutation results are in `tb4-falsification.md` (9 of 9 killed).

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
