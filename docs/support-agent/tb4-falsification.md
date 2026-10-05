# TB4 — falsification

Each rule below was reverted on its own by the committed `scripts/mutate-tb4.py`, and the
named test was run against the mutant. Run on 2026-10-04 against the TB4 head. 9 of 9 killed;
the substitute review below adds 29 more.

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

## Substitute review of PR #199 — every fix, falsified

Codex was unavailable, so one read-only substitute review ran. It found eight should-fix
findings and four nits; all were valid and all are fixed or pinned. Each fix has a regression
test, and reverting the fix fails that test. Run on 2026-10-05 with
`TEST_DATABASE_URL=… python3 scripts/mutate-tb4.py`; TB4-06 was re-anchored after prettier
(F7) and TB4-04 moved with `markRejected`'s caller into `credential-alert.ts`.

| ID             | Finding                                                                                     | Fix                                                                                               | Regression test                                                           | Result |
| -------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------ |
| TB4-10         | F1: a refused entry into `AUTO_REPLY_SAFE` left no DENIED audit row and no denial event     | the `auto_reply` refusal is recorded by `recordMutationDenial` once the transaction unwinds       | `support-ai-config.test.ts` › … one DENIED audit row and one denial event | KILLED |
| TB4-11         | F2: a slow call holding the OLD key could mark the NEW key rejected                         | `markRejected` names `api_key_set_at` read with the key                                           | › a 401 from a call made with a since-replaced key …                      | KILLED |
| TB4-12         | F2: … and count toward the new key's breaker                                                | `recordResult` names the key version                                                              | › a transient failure from a call made with a since-replaced key …        | KILLED |
| TB4-13         | F2: … and clear the new key's rejection                                                     | `clearRejected` names the key version                                                             | › an answer from a call made with a since-replaced key never clears …     | KILLED |
| TB4-14, TB4-15 | F3: every concurrent caller after the window went to the failing provider                   | `claimProbe`: a conditional UPDATE pushes `tripped_until` forward; only the claimer calls         | `support-ai-chain.test.ts` › exactly one of two …; config › claims … once | KILLED |
| TB4-16         | F4: an `INVALID_OUTPUT` (possibly a 4xx quota answer) cleared a rejection                   | only `OK` clears; the 400 quota shape is recorded in `OQ-TB-20`, not guessed                      | chain › never clears a rejection or emits credential_accepted …           | KILLED |
| TB4-17–TB4-19  | F5: thinking tokens could exhaust the output budget and truncate the reply                  | `outputTokenBudget`: caller's figure + 4 096, capped at 8 192; effort control left to `OQ-TB-20`  | adapters › gives every adapter a bounded output headroom …                | KILLED |
| TB4-20–TB4-22  | F6: `assertScopeActive` in update, set and delete had no test                               | — (the rule held; a test pins each)                                                               | config › refuses … once the tenant is stopped                             | KILLED |
| TB4-23, TB4-24 | F6: truncation was tested only with unparseable content                                     | —                                                                                                 | adapters › maps truncatedParseable to INVALID_OUTPUT                      | KILLED |
| TB4-25         | F6: delete closing a rejection had no test                                                  | —                                                                                                 | config › deleting a rejected key closes its alert                         | KILLED |
| TB4-26         | F6: the distinct-providers `superRefine` had no test                                        | —                                                                                                 | chain › refuses a chain that repeats a provider …                         | KILLED |
| TB4-27         | F6: `markRejected`'s `rejected_at IS NULL` had no test                                      | —                                                                                                 | config › … a second mark answers false                                    | KILLED |
| TB4-28         | F6: the keyless skip was only reached through the state lookup                              | —                                                                                                 | chain › never calls a step whose key is gone …                            | KILLED |
| TB4-29         | F6: the 1 MB cap had no test — and an oversized body was reported as `TIMEOUT`              | the read says why it stopped; too large is `body_too_large`                                       | adapters › refuses a body over the 1 MB cap …                             | KILLED |
| TB4-30         | F6: `assertOutsideTransaction` in the sink had no test                                      | —                                                                                                 | adapters › refuses to run inside a database transaction …                 | KILLED |
| TB4-31         | F6: the recovery's `tenantConditionIsOpen` gate had no test                                 | —                                                                                                 | chain › records available only while unavailable is open …                | KILLED |
| TB4-32         | N1: two concurrent successes could each write an `available` row                            | the recovery carries a dedupe key                                                                 | chain › records available only while unavailable is open …                | KILLED |
| TB4-04, TB4-33 | F8: a crash between `rejected_at` and the alert left a rejected key with no alert, for ever | `SupportAiCredentialAlert`: a rejected key with no open alert raises it again (the log dedupes)   | chain › raises credential_rejected once …; › raises … again …             | KILLED |
| TB4-34         | F8 (the mirror): an accepted key with the alert still open                                  | the next `OK` closes it                                                                           | chain › closes a credential alert left open …                             | KILLED |
| TB4-35, TB4-36 | N4: a 200 whose body is not JSON was `INVALID_OUTPUT`                                       | `nonJsonSuccess` → `TEMPORARY` (and never `OK` for a connection test)                             | adapters › reads a 200 whose body is not JSON as TEMPORARY …              | KILLED |
| TB4-37         | N4: a read error that was not an abort was labelled `body_too_large`                        | `body_read_failed`                                                                                | adapters › labels a body that fails mid-read …                            | KILLED |
| TB4-38         | N3: the idempotency hash was an unsalted SHA-256 over the plaintext key                     | the key is out of the hash (the panel and gateway precedent); the replay limitation is documented | config › keeps the plaintext key out of the idempotency request hash      | KILLED |

N2 (the chain and the connection test write run and breaker state without
`ScopeActivityReader` in a transaction) is a stated exception in `docs/conventions.md`, with
its bound. F7 is the re-anchored TB4-06.

**38 of 38 killed.**
