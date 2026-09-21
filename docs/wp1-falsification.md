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

## Round 2 — the nine Codex findings

One review round, nine findings, all nine validated against the code and all
nine real. Eight of the fixes carry a mutation; the ninth is a comment.

| #    | Rule reverted                                                 | Suite                | Result |
| ---- | ------------------------------------------------------------- | -------------------- | ------ |
| R-01 | the expiry predicate on `revokeAllForAdmin`                   | `admin-http`         | KILLED |
| R-02 | the `AdminPasswordChanged` write on an operator reset         | `admin-http`         | KILLED |
| R-03 | the replay lookup on `create`                                 | `admin-http`         | KILLED |
| R-04 | the replay lookup on `setStatus`                              | `telegram-admin`     | KILLED |
| R-05 | the non-empty requirement put back on the role EDIT           | `web/administrators` | KILLED |
| R-06 | the role picker snapshots the row instead of deriving from it | `web/administrators` | KILLED |
| R-07 | revoke gated on a cached empty session list again             | `web/administrators` | KILLED |
| R-08 | the creation stops sending its idempotency key                | `web/administrators` | KILLED |

### The two with no mutation row, and why

**The self-revocation docblock.** The fix is prose: the method claimed
self-revocation was "a safe act anybody may perform on themselves" while both
the preflight and the in-transaction check charge `admins.edit` unconditionally.
Widening the permission to match the sentence was the other available fix and
was refused — authorization here is deny-by-default, an administrator who wants
their current session ended already has the logout route, and "sign out
everywhere" performed by somebody accountable leaves the better record. So the
sentence changed, not the code, and there is nothing to mutate.

**The Telegram roster bound.** `adminSection` now slices to
`ADMIN_ROSTER_LIMIT` and prints `shown` against `total`, because an unbounded
map into one inline keyboard eventually exceeds Telegram's limit and fails the
whole send — at exactly the roster size where an operator most needs it.

That slice has **no test**, and neither does any other part of this section's
RENDERING: nothing in the suite drives `adminSection` or `adminAdmin` at all.
What is covered is the layer beneath them — `listAll`, `setStatus`, tenant
isolation, the permission, the last-owner rule and the redelivery replay, eight
integration cases and two killed mutations. What is not covered is which buttons
a reply carries, and the bound is part of that.

It is recorded here rather than asserted because the honest options were a test
or a note, and a note is what this is. The damage a silent revert would do is
bounded by the counts being printed: a reverted slice makes `shown` equal
`total` again, which is visible in the message rather than silent — but visible
to an operator, not to CI, and that is the gap.

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
