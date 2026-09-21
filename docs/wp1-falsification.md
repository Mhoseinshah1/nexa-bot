# Work Package 1 — falsification record

Every production rule this package added or changed, reverted one at a time
against the suite that names it. A rule whose mutation SURVIVES is a rule the
suite cannot tell from its opposite; each one below is either killed, or killed
after the gap it exposed was closed, or recorded as inert and removed.

Run as: revert the single rule, run the named suite, restore. Nothing here was
run and thrown away — each row names a test that exists on this branch.

| #     | Rule reverted                                                           | Suite                         | Result   |
| ----- | ----------------------------------------------------------------------- | ----------------------------- | -------- |
| W-01  | `assertNotSelf` on `resetPassword`, BOTH copies                         | `admin-http`                  | KILLED   |
| W-01a | the pre-lock copy alone                                                 | `admin-http`                  | SURVIVED |
| W-01b | the in-transaction copy alone                                           | `admin-http`                  | SURVIVED |
| W-02  | `assertRestoresNoMorePrivilegeThanHeld` on `resetPassword`              | `admin-http`                  | KILLED\* |
| W-03  | `revokeAllForAdmin` on `resetPassword` (rotate without ending sessions) | `admin-http`                  | KILLED   |
| W-04  | the in-transaction `guard.check` on `resetPassword`                     | `transactional-authorization` | KILLED\* |
| W-05  | the `adminId` + live predicates on `listForAdmin`                       | `admin-http`                  | KILLED   |
| W-06  | `token_hash` added to the repository projection alone                   | `admin-http`                  | SURVIVED |
| W-06b | `token_hash` added AND the service mapping spread instead of named      | `admin-http`                  | KILLED\* |
| W-07  | `requireAdmin` scope resolution on `listSessions`                       | `admin-http`                  | KILLED   |
| W-08  | the self-revocation exception to `assertSessionStillLive`               | `admin-http`                  | SURVIVED |
| W-10  | `listAll` falls back to `listTelegramBound`, unauthorized               | `telegram-admin`              | KILLED   |
| W-11  | Telegram status stops reaching `AdminManagementService.setStatus`       | `telegram-admin`              | KILLED   |

\* Killed only after the gap the first run exposed was closed. The three are
worth naming, because each was a real hole rather than a missing assertion.

## W-02 — the bound that nothing tested

Setting somebody's password is taking their account: whoever does it can sign in
as them afterwards. `resetPassword` is therefore bound by the same question as
re-enabling a disabled administrator — "may you BECOME this one" — and an actor
holding `admins.edit` but not what the target holds must be refused.

The first run removed that bound and every case still passed. The package's
denial case used `support`, who holds no `admins.edit` at all, so it proved only
that the permission is charged. Closed by
`refuses a reset that would hand the caller authority they do not hold`, which
gives the actor `admins.edit` and the target one permission the actor lacks —
and carries a negative half, a peer the same actor MAY reset, so the rule cannot
be satisfied by refusing everything.

Without it this route is the escalation path `UNK-ADM-005` names, reached with a
permission the research found every one of Mirza's four production
administrators holding.

## W-04 — the recheck that had no race to fail

`assertMayAttempt` runs on the POOL. An actor demoted while the request waits on
the tenant lock has already passed it, and only the in-transaction `guard.check`
sees the demotion. Removing that check changed nothing the suite could see.

Closed by adding `admins.password_reset` to the revocation-race matrix in
`transactional-authorization.test.ts`, which holds the mutation at the barrier,
demotes the actor, releases, and asserts the refusal, the untouched hash, the
DENIED audit row and the single WARN event.

## W-06 — an assertion the schema was answering

The leak test read `adminSessionListResponseSchema.parse(...)`. A zod object
strips keys it does not declare, so adding `token_hash` to the repository
projection passed: the assertion was proving the schema is narrow, not that the
response is clean. Re-pointed at `listed.body`, the raw string a browser
receives. It then takes both layers to leak — projection AND the service's named
mapping — which is what W-06b shows.

## W-08 — a branch that could not fire, and is now gone

`revokeSessions` skipped its liveness check for the caller's own id, reasoning
that a replayed second click should report zero rather than "your session is
invalid". The mutation removing the branch changed nothing, and the reason is
that the branch is unreachable: the controller resolves the session BEFORE
calling the service, so a replay is refused at authentication and never reaches
the transaction.

The branch was removed rather than kept as an inert special case with a comment
describing behaviour this product does not have, and the real answer is pinned
by `refuses a REPLAYED self sign-out at authentication, having already done it`.

## W-01a / W-01b — defence in depth, recorded as such

Each copy of the self-refusal survives alone because the other still fires. That
is the design: the pre-lock copy rejects before a deliberately slow KDF, and the
in-transaction copy is checked against the id the DATABASE returned rather than
the one the caller supplied. Removing both is refused (W-01), so the RULE is
tested; neither copy is individually load-bearing and neither is claimed to be.

## What was NOT falsified

The Web Admin components. `apps/web` has unit coverage for the shared kit and
none for this page's new controls, so nothing here claims a mutation result for
them. The behaviour they reach is the HTTP surface, which the rows above cover.
