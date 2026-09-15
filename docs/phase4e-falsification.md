# Phase 4E falsification — the real-panel acceptance

Rules introduced or corrected while standing a real MHSanaei/3x-ui v3.7.0 panel
up against the shipped adapter. `docs/real-panel-acceptance.md` is what the
acceptance covers and how to run it; this is what happens when each rule is
taken away.

One row **SURVIVED**, and it is recorded with the reading that makes it a
finding rather than a gap — see F4E-02.

| #      | Rule                                                                | Mutation                                                               | Named test                                                                                               | Result   |
| ------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------- |
| F4E-01 | A session-mode request carries the CSRF token the panel minted      | `'x-csrf-token': csrfToken,` removed from the session auth headers     | `sanaei-adapter.test.ts` › 17. creates a client through a session and sends the token on the POST        | KILLED   |
| F4E-02 | The fake refuses an unsafe `/panel/api` call with no bound token    | the `/panel/api` CSRF gate → `if (false && ...)`                       | `sanaei-adapter.test.ts` › 17. creates a client through a session and sends the token on the POST        | SURVIVED |
| F4E-03 | A replay of the same create is an idempotent success                | the fake's `existing.subId === subId` branch → `if (false)`            | `sanaei-adapter.test.ts` › 19. a replay of the same create is an idempotent success, not a refusal       | KILLED   |
| F4E-04 | A Bearer create sends no CSRF token                                 | covered by the same header removal as F4E-01, from the other direction | `sanaei-adapter.test.ts` › 18. a BEARER create sends no CSRF token, because api_authed short-circuits it | n/a      |
| F4E-05 | The CSRF rule reaches provisioning end to end, not just the adapter | `'x-csrf-token': csrfToken,` removed from the session auth headers     | `provisioning-delivery.test.ts` › sends the subscription in the SAME tick that provisions it             | KILLED   |

## F4E-02, the survival

Disabling the fake's CSRF gate does not fail a test **on its own**, and that is
correct: the gate is not a production rule. It exists so that F4E-01 kills.

What matters is whether the pair is load-bearing, so both mutations were applied
together — the adapter as it shipped before this fix, and the fake as it was
before this fix. Measured: `1 failed | 3 passed | 62 skipped`. The one that still
failed is test 17, which asserts the header value directly against
`server.mintedCsrfTokens[0]` and therefore does not depend on the gate at all.
Tests 18, 19 and 20 passed — which is precisely the state the repository was in
before this commit, with forty-odd green scenarios and a panel answering 403.

So the rule has two independent covers, and the record says which is which:

- **Test 17** pins the header directly, and would have caught this without any
  gate. It did not exist, because no unit test drove a session-mode MUTATION at
  all; every session-mode case in the file was a `probe`, which is a GET.
- **The gate** is what makes tests 19 and 20 — and the whole integration file,
  F4E-05 — fail on the same mutation. That breadth is what stops the next person
  removing the header in a refactor and seeing one narrow assertion break.

The restore after the two-file mutation was verified byte-identical against a
copy taken beforehand, and `git status` was clean afterwards.

## What is NOT falsified here

The acceptance suite itself. Its mutations would have to be run against a live
panel, and `scripts/falsify.sh` names one of `unit`, `web`, `exhaustive`,
`integration` or `shell` — deliberately, because an unknown project silently
matched no files and manufactured seven KILLED verdicts in one session. Adding
`acceptance` to that list would make the harness report a kill whenever no panel
was running, which is the same failure wearing the same clothes.

What the acceptance suite has instead is that it FAILS rather than skips when
`NEXA_ACCEPTANCE_PANEL_URL` is absent, so it cannot be green without a panel.
