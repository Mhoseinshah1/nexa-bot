# TB4 — falsification

Each rule below was reverted on its own by the committed `scripts/mutate-tb4.py`, and the
named test was run against the mutant. Run on 2026-10-04 against the TB4 head. 9 of 9 killed.

| Id     | Rule reverted                                                           | Killed by                                                           |
| ------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| TB4-01 | The chain stops on an outcome that does not fall back                   | `support-ai-chain.test.ts` › never falls back (×2)                  |
| TB4-02 | `INVALID_OUTPUT` is not a fallback outcome                              | `support-ai-chain.test.ts` › never falls back on INVALID_OUTPUT     |
| TB4-03 | A tripped provider is skipped                                           | `support-ai-chain.test.ts` › skips a tripped provider …             |
| TB4-04 | `credential_rejected` is raised only on the transition into rejected    | `support-ai-chain.test.ts` › raises credential_rejected once …      |
| TB4-05 | OpenAI quota exhaustion is `AUTH_FAILED` with `quota`, not a rate limit | `support-ai-adapters.test.ts` › … never RATE_LIMITED                |
| TB4-06 | Anthropic `stop_reason: refusal` is a refusal                           | `support-ai-adapters.test.ts` › maps refusal to REFUSED_BY_PROVIDER |
| TB4-07 | Entering `AUTO_REPLY_SAFE` requires `support_ai.auto_reply`             | `support-ai-config.test.ts` › entering automatic replies require …  |
| TB4-08 | Replacing a rejected key closes the alert                               | `support-ai-config.test.ts` › … replacing the key closes it         |
| TB4-09 | A provider call never follows a redirect                                | `support-ai-adapters.test.ts` › … never follows a redirect (×3)     |
