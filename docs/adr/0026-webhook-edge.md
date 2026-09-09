# ADR-0026 — What bounds the Telegram webhook, and what deliberately does not

**Status:** Accepted. Written during the Architecture Hardening pass (item G),
which found a real gap, a false claim, and two absences that had never been
decided either way. Supersedes nothing.

## The problem

`/telegram/webhook/:botInstanceId` is the only route on this installation that an
unauthenticated caller can usefully reach. Every other credential-bearing surface
is throttled: Web Admin login has a durable per-subject throttle that deliberately
cannot be cleared by waiting out a cache eviction, and panel probes are bounded by
a per-panel claim and a per-tenant token bucket. This route had no bound of any
kind beyond the application-wide 1 MB body limit, and no record saying whether
that was a decision.

The hardening audit also found that the controller's own docblock described a
shape the method does not have — "the webhook ANSWERS IMMEDIATELY and does the
work behind the outbox" — while two database round trips and a write transaction
are awaited before the 200. And it found the feature-flag test could not fail.

## Decision

### The route gets its own, much smaller, body limit

64 KiB, set by an `onRoute` hook in `bootstrap.ts` and exported from the
controller beside the route it bounds.

The application-wide 1 MB is sized for Web Admin requests from an operator who
has already signed in. This route is different in kind, because the secret token
is checked INSIDE the handler: Fastify has read and parsed the body before the
request can be rejected. So an unauthenticated caller could hand the process a
megabyte of JSON to parse per request and pay nothing for the 401 it got back.

64 KiB is generous for the traffic. Telegram caps a message at 4096 characters,
so the largest realistic update is a long text plus entities and a forwarded
origin — tens of kilobytes at worst, under a kilobyte normally.

`routeOptions.bodyLimit` rather than a guard reading `content-length`, because
the limit has to bound the READ. A header check is advisory: a chunked request
declares no length, and a dishonest one declares any length it likes. Fastify's
body reader counts the bytes it actually receives, which is why the test posts an
oversized body behind a `content-length: 20` and still gets refused.

### There is no rate limit on this route, and that is the decision

Not an oversight. Three reasons, in order of weight:

1. **A durable limiter would amplify the attack it answers.** Every admission
   counter in this codebase is a conditional write in PostgreSQL, on purpose —
   `login_throttle` records why: an attacker must not be able to clear their own
   counter by waiting out a cache eviction or a restart. Applying that here
   means an unauthenticated request, which currently costs one 64 KiB parse and
   a constant-time hash compare, would instead cost a database write. A flood
   would then be a flood against PostgreSQL, which is the one component whose
   loss takes the whole installation down.
2. **The secret token is the real control, and it is strong.** It is checked
   before the bot id is even parsed, in constant time over equal-length SHA-256
   digests, and the API refuses to boot with a weak one. An unauthenticated
   caller cannot reach any state-changing path, cannot learn which bot ids
   exist, and cannot distinguish an unknown bot from a disabled one from a
   stopped tenant — all three answer an identical 404.
3. **The right place for a request-rate bound is the edge, not the
   application**, and the edge is `deploy/`'s Caddy, which already has a route
   for this path placed before the SPA fallback. A limiter there bounds the
   traffic before it costs this process anything, which is the opposite of (1).

What is owed, and is not being paid in this pass: Caddy's built-in server has no
rate limiter, so this needs either a plugin in the production image or a
different front door. That is a deployment change, and the deployment checkpoint
has not yet been run against a real server (`docs/vps-acceptance.md`), so adding
an unexercised plugin to the image would be adding an unknown to a topology that
already has one. Recorded in `docs/open-questions.md` instead.

### There is no source-IP allowlist

Telegram publishes its webhook source ranges, and pinning them would be a real
control. It is not adopted, for one reason that is about this product rather than
about security in general: one install per customer, behind whatever front door
that customer has, frequently behind a CDN or a tunnel the operator chose. An
allowlist maintained in this codebase would fail closed on a topology we do not
control and cannot see, and the symptom would be a bot that silently stops
receiving updates. `TRUSTED_PROXY_IPS` already exists for the cases where the
operator does know their front door; an allowlist belongs beside it, as operator
configuration, not as a default.

### The docblock says what the code does

The rule it was reaching for is real and is now stated as a rule: no handler here
calls an external service inline, because Telegram times a webhook out in seconds
and a timeout makes Telegram redeliver — so the slow path becomes a duplicated
one. The outbox is where the CONSEQUENCES of an update go, not where the update's
own handling goes.

The old sentence mattered more than a stale comment usually does, because it
described the shape every later handler is told to copy. An author reading it
would have concluded that awaiting work here was either already forbidden or
already handled, and neither was true.

## Consequences

- An unauthenticated request to this route costs at most a 64 KiB parse. It used
  to cost up to 1 MB.
- The feature-flag-off case is now a real test. It posts to the real route, with
  a real seeded bot and the correct secret token — the same request the body-limit
  block gets a 201 for with the flag on — so its 404 means the flag and not a
  malformed request. Before, it posted to `/telegram/webhook` with no bot id,
  which 404s whether the controller is registered or not.
- Two absences are now decisions with reasons, which means a later reviewer
  arguing for either one is arguing with a record rather than filling a silence.
- The rate limit remains owed at the edge, as an open question rather than as a
  closed one.

## What was considered and rejected

- **A per-IP limiter in PostgreSQL.** Rejected per (1) above: it converts a cheap
  unauthenticated request into a database write.
- **A per-IP limiter in Redis.** Rejected for the same reason plus a worse one:
  Redis currently stores nothing in this system, and `docs/hardening-audit.md`
  § F records that making it hold admission state would both contradict the
  owner's constraint on Redis and add a hard dependency for state that must
  survive a restart.
- **An in-memory limiter.** Rejected on the same grounds as every other
  in-memory bound in this codebase: the deployment runs more than one API
  replica, so the effective limit is the configured one times the replica count,
  and a restart clears it.
- **Rejecting on `content-length` before parsing.** Rejected as advisory; see
  the body-limit decision above.
