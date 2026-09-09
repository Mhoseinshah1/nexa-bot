# Architecture Hardening — the audit, before any code changed

Fourteen items, each classified before a line was written, because a hardening
pass that starts by implementing is a pass that "fixes" things that already
work and calls the result progress.

Classification is one of **CONFIRMED GAP**, **PARTIALLY SOLVED**, **ALREADY
SOLVED** or **NOT APPLICABLE**. Nothing is classified ALREADY SOLVED without a
citation to the code that solves it, and nothing is classified a gap on the
strength of it being absent from a search — three items below were expected to
be gaps and are not.

Two of the findings are against work from the Backup V1 branch this one is
stacked on. They are recorded here rather than in that branch's own record
because they are hardening items, and they are named rather than quietly fixed.

## Summary

| Item                                             | Classification                                    | The finding in one line                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — stable Operation ID                          | PARTIALLY SOLVED                                  | Retry-stable identity exists as the idempotency key and is stored in exactly one table; nothing is short, quotable, or joinable across audit/event/opslog |
| B — durable idempotency on external side effects | PARTIALLY SOLVED                                  | Notification, probe and outbox paths are all durably claimed; the backup module has no scope, actor, audit row or idempotency key                         |
| C — ambiguous provider outcomes                  | PARTIALLY SOLVED                                  | The three-state model exists only in backup; the provider taxonomy has a retryability axis but no definitive/ambiguous axis, and cannot report one        |
| D — no network inside DB transactions            | PARTIALLY SOLVED                                  | The property holds everywhere today and **nothing enforces it**                                                                                           |
| E — provider contract hardening                  | PARTIALLY SOLVED                                  | All ten failure kinds real and producer-backed, adapters genuinely distinct; three specific weaknesses, one of them a real lockout risk                   |
| F — Redis admission cache                        | NOT APPLICABLE                                    | No confirmed gap it would close; two adjacent real defects, and one is an argument _against_ depending on Redis                                           |
| G — webhook edge hardening                       | PARTIALLY SOLVED                                  | Authentication and validation are strong; no rate limit, body parsed before auth, one test that cannot fail, one false docblock                           |
| H — worker health and freshness                  | PARTIALLY SOLVED                                  | Three of six background loops are invisible to every health signal                                                                                        |
| I — retention                                    | PARTIALLY SOLVED                                  | Nothing deletes business or audit state, structurally; four tables grow unbounded with no recorded decision                                               |
| J — Telegram report group                        | ALREADY SOLVED                                    | The mechanism the item asks for exists end to end, and the outbox framing was already tried and rejected on evidence                                      |
| K — reusable log contract                        | PARTIALLY SOLVED                                  | `context` is redacted but never reaches Telegram; `message` reaches Telegram and is never redacted                                                        |
| L — provider note foundation                     | CONFIRMED GAP (port) / NOT APPLICABLE (overwrite) | No note concept anywhere; nothing can overwrite a note because nothing can write one                                                                      |
| M — failure and concurrency testing              | PARTIALLY SOLVED                                  | No mock-only tests anywhere and real racing on every claim mechanism; five named failure modes untested                                                   |
| N — ADRs                                         | PARTIALLY SOLVED                                  | No erased decisions, no numbering gaps; index stale, two statuses stale, four Backup V1 decisions unrecorded                                              |

## A — a stable Operation ID

**PARTIALLY SOLVED.**

Four identifiers exist and only one is stable across a retry:

- UUIDv7 primary keys (`packages/contracts/src/ports.ts:16`) are minted per row
  inside the transaction, so a retried mutation mints new ones.
- `correlationId` is minted per request (`apps/api/src/surfaces/web/correlation.middleware.ts:23`).
  The middleware honours an inbound header, but nothing in `apps/web` ever sends
  one, and every background tick mints a fresh value. It changes on retry.
- `causationId` is **declared and never populated**. `outbox-writer.ts:47`
  accepts it, `:72` writes `event.causationId ?? null`, and no call site anywhere
  passes it. A column with no producer.
- The idempotency key is the only retry-stable value
  (`request_idempotency`, unique on `(scope_ref, key)`), and `apps/web/src/submission-key.ts:66-83`
  deliberately keeps it across a 5xx and retires it only on a 4xx.

The gap is what that buys. The key is stored in exactly one table: no audit row,
outbox message, operational event or notification carries it. So the only join
key across a mutation's audit row, its event and its operational event is the
one identifier that changes on retry — and the value an operator is handed on
failure is a 36-character UUID.

`operationId` does not exist anywhere in the repository.

## B — durable idempotency on every external side effect

**PARTIALLY SOLVED.** Four outbound sinks exist. Three are durably claimed.

- **Telegram notifications** — a database lease: `claimDue` selects
  `FOR UPDATE SKIP LOCKED` and pushes `next_attempt_at` forward before the send;
  capacity is returned by an append-only fact row rather than a decrement, which
  is idempotent by construction. Intent identity is a unique dedupe key.
- **Panel probes** — both bounds are conditional writes committed _before_ the
  socket opens (`probe-core.ts:174-199`): a per-panel claim keyed on a
  configuration fingerprint, and a tenant token bucket.
- **Outbox relay** — claim and effect in one transaction, deduped by
  `processed_messages` unique on `(consumer, message_id)`.
- **Backup delivery** — the run row is the lock and nothing retries delivery, so
  there is no double-send to dedupe. But the module has **no `ScopeContext`, no
  `ActorContext`, no idempotency key, no audit row and no operational event** —
  a grep for any of them across `apps/api/src/modules/platform/backup/` returns
  nothing. `backup run` is a state-changing command an operator invokes, and
  `docs/conventions.md:138` requires an idempotency key on every one. Worse: a
  failed _scheduled_ backup produces a log line and a row and no notification,
  so the unattended failure is silent on the channel built to report failures.

`restoreInto` is the one state-changing external effect with no durable record
that it happened. It is a human one-shot, so that is arguably correct — but it
should be a decision, not an omission.

## C — ambiguous provider outcomes

**PARTIALLY SOLVED**, and the vocabulary exists in exactly one module.

`BACKUP_DELIVERY_STATES` distinguishes `FAILED_DEFINITIVE` from
`OUTCOME_UNKNOWN`, is durably stored, is never auto-retried, and already has a
reconciliation query. Its own docblock says this is "the state the rest of the
codebase does not have", and that is accurate.

`PROVIDER_FAILURE_KINDS` has ten kinds and **no ambiguity axis**. Its only axis
is `PROVIDER_FAILURE_RETRYABLE`, which encodes a decision rather than a fact —
the same conflation. Mapping the ten onto the real question:

- definitive (the provider answered): `AUTHENTICATION_FAILED`,
  `AUTHENTICATION_REQUIRES_INTERACTION`, `RATE_LIMITED`, `MALFORMED_RESPONSE`,
  `PROVIDER_ERROR`, `UNSUPPORTED_CAPABILITY`, and `BLOCKED_TARGET` (nothing was
  sent);
- ambiguous and **not encoded as such**: `TIMEOUT`, whose deadline can fire
  after the request body was written; and `UNREACHABLE`, which is overloaded
  across "DNS resolved nothing" (genuinely definitive) and a socket error during
  the response phase (request sent, verdict lost).

`safe-http.ts` cannot report the distinction even in principle: it never records
whether the request reached the socket, so there is no fact for the result to
carry. The retry loop is gated on retryability, so it would re-send after a
`TIMEOUT`. That is dormant rather than absent — `PANEL_HTTP_RETRIES` is 0 — and
for a Phase 4 mutating call it is exactly the blind retry the owner forbids.

## D — no network calls inside business transactions

**PARTIALLY SOLVED. The property holds. Nothing enforces it.**

Every one of the 19 `uow.run` call sites was followed to its leaves; none
reaches any of the four sinks. The probe explicitly commits its claim before
dialling; the dispatcher's claim commits before `deliver`; the backup pipeline
opens no transaction around its subprocess or its upload.

The outbox relay is the exception worth naming: it _does_ run consumers inside
the claim transaction, by design, and is safe only because there is exactly one
consumer in the codebase and it writes to the ops log. A future consumer that
sends is a one-line mistake with nothing standing in its way.

And there is no guard. `check-boundaries.sh` forbids a _provider adapter_
importing a network library and says nothing about transactions or any other
directory; the ESLint restricted-import list covers frameworks but not
`node:http`, `node:child_process` or bare `fetch`. The rule is documented in
four places and enforced in none — which, by this repository's own standard, is
a rule awaiting its silent reversion.

## E — provider contract hardening

**PARTIALLY SOLVED.** The taxonomy and the separation are in good shape; three
specific weaknesses.

All ten failure kinds exist and every one has a real producer. Downstream the
taxonomy is preserved rather than collapsed: the retryability map is total, and
the monitor's health mapping is an exhaustive switch, so adding a kind is a
compile error there.

The two providers are genuinely distinct, not merged: separate adapters sharing
no protocol code, Marzban judging on HTTP status plus a token field while 3x-ui
judges on a `{success,msg,obj}` envelope and maps `200 + success:false` to an
authentication failure; per-descriptor credential shapes narrowed before the
adapter is reached; and a boundary check that fails the build if the monitor
ever branches on a provider type.

- **E-1 — a declared capability nothing enforces.** Both descriptors declare
  `HEALTH_CHECK` and both adapters implement `supports()`, and there is no
  production caller: `probe-core.ts:209` probes unconditionally. The array is
  published to the Web Admin as a promise the product makes, and nothing on the
  server consults it. It is vacuous today, which is exactly when the gate is
  cheap to install.
- **E-2 — the probe cooldown floor understates the work it bounds.** The floor is
  `timeout × (1 + retries)`, and its comment says a shorter cooldown "would let a
  second request start while the first is still on the wire". But the deadline is
  _per request_, and a 3x-ui session probe issues **four** sequential requests. At
  the defaults the floor is 10s while a session probe can occupy ~40s, so a
  second probe of the same panel can be granted while the first login sequence is
  still running — against a panel that counts failed logins per IP and username,
  which is the lockout this cooldown exists to prevent.
  **Fixed on this branch**: `ProviderDescriptor.maxRequestsPerProbe`, the derived
  `MAX_REQUESTS_PER_PROBE`, and that term added to the floor in `container.ts`.
- **E-3 — no producer check for the failure taxonomy.** The boundary script fails
  the build for a declared _error code_ with no producer;
  `PROVIDER_FAILURE_KINDS` gets no equivalent, and every existing test iterates
  the list to assert consumers. `AUTHENTICATION_REQUIRES_INTERACTION` has exactly
  one producer; removing it would leave a live entry in a frozen taxonomy with a
  green suite.

## F — a Redis admission cache

**NOT APPLICABLE as proposed.** Two adjacent defects are real, and neither is
closed by adding one.

Redis today stores nothing. `createRedis` is constructed, handed to the
readiness probe, exported and closed — four references — and the only command
issued anywhere is `ping`. Its own docblock says so.

The owner's constraint is honoured with no near-miss: every piece of admission,
rate-limit and idempotency state is in PostgreSQL, and the login-throttle
repository writes down _why_ — "an attacker must not be able to clear their own
counter by waiting out a cache eviction or a restart".

- **F-1 — Redis is a hard readiness dependency while storing nothing.** A Redis
  outage makes the API healthcheck fail and can roll a release back, for a
  dependency that holds no state and that nothing reads. That is a self-inflicted
  availability gap and an argument _against_ depending on Redis, not for it.
- **F-2 — the notification rate ceiling is per-process.** `windowStartedAt` and
  `sentInWindow` are instance fields, so two workers allow twice the configured
  rate and a restart resets the window. ADR-0018 states this plainly. It is the
  one place a shared counter would help — and the matching mechanism is a
  conditional write in Postgres, exactly like the two counters beside it, not
  Redis.

There is no benchmark, profile, operational event or open question reporting
contention on any admission path. Adding a cache in front of tenant status would
also introduce precisely what the constraint forbids: a stale `ACTIVE` served
after an operator stopped the tenant, on a path required to read scope activity
_inside_ its transaction.

## G — webhook edge hardening

**PARTIALLY SOLVED.** Authentication and validation are strong; five specific
gaps.

Solved, with evidence: secret-token check before the bot id is parsed and
compared in constant time over equal-length digests; a boot refusal for a weak
secret; a 1 MB body limit; schema-validated update shape; a UUID-validated path
parameter; unknown bot, disabled bot and stopped tenant all answering an
identical 404; a tenant-status check that satisfies the scope-activity
non-negotiable at this surface; a deterministic idempotency identity per update;
a sanitised correlation header; and a Caddy route placed before the SPA fallback
so an update cannot be answered with `index.html`.

- no rate limiting anywhere on the route — no limiter in the dependency tree and
  none at the edge, while every other credential-bearing surface is throttled;
- the 1 MB body is parsed _before_ the secret is checked, and nothing upstream
  trims it, so an unauthenticated caller gets a megabyte of parsing;
- the docblock claims the webhook "answers immediately and does the work behind
  the outbox". It does not: two round trips and a write transaction are awaited
  inline. Harmless today, and it is the sentence a later handler author will
  rely on;
- **the feature-flag-off test cannot fail.** It posts to `/telegram/webhook`
  with no `:botInstanceId`, and the route requires one — so it 404s whether the
  controller is registered or not, and stays green under the exact mutation it
  exists to catch;
- no source-IP allowlist. Defensible, since the secret is the real control, but
  it should be a stated absence.

**Fixed on this branch**, and ADR-0026 records the decisions: a 64 KiB
route-scoped body limit enforced on the stream by `routeOptions.bodyLimit`; the
docblock rewritten to state the rule it was reaching for instead of describing a
shape the method does not have; the feature-flag case rewritten to post a request
the route would otherwise answer. The two absences are now decisions with reasons
rather than silences — no in-application rate limit, because every admission
counter here is a PostgreSQL write and a limiter would convert a cheap
unauthenticated request into one; no source-IP allowlist, because one install per
customer sits behind a front door this codebase cannot see. The edge-side rate
limit is recorded in `docs/open-questions.md` as still owed.

## H — worker health and freshness

**PARTIALLY SOLVED.** The mechanism is sound and the two newest loops are
exemplary. Three of six loops are invisible.

The heartbeat writes only when its check returns true, and the container reads
the file's age — so it genuinely means more than "the process exists".

| Loop                    | In a health signal?                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Panel monitor           | **Yes** — progress-based, no startup grace, nothing recorded on a throwing tick            |
| Backup scheduler        | **Yes** — `lastTickAt` advanced only on a completed tick and deliberately not in the catch |
| Outbox relay            | **No**                                                                                     |
| Throttle sweeper        | **No**                                                                                     |
| Session sweeper         | **No**                                                                                     |
| Notification dispatcher | **No**                                                                                     |

The relay's failure is the subtlest: if `processBatch` _hangs_ rather than
throws, the loop never reschedules, `running` stays true so `start()` is a
no-op, and the worker's heartbeat keeps writing because `SELECT 1` still
succeeds. The only signal is the API process's outbox-lag probe, which is
threshold-based and reports zero lag when the outbox is empty — so a dead relay
during a quiet period is green everywhere.

The dispatcher's is the most consequential: it drains the queue by which the
installation reports anything being wrong. A silently dead dispatcher means the
system has lost its ability to say it is broken, while its container reports
healthy.

## I — retention

**PARTIALLY SOLVED.**

**Nothing in this repository deletes business or audit state**, and the property
is structural rather than conventional: six tables carry `BEFORE DELETE`
triggers, and the one time a retention sweep for `operational_events` was
drafted, the trigger stopped it and the setting was removed rather than the
guard weakened. What the sweepers delete is expired rate-limiter counters and
expired sessions, and the forensic content of a session is on the audit row
itself.

Eight tables grow without bound. Four are documented decisions and are therefore
not gaps. Four have no recorded decision: `outbox_messages`, `processed_messages`,
`request_idempotency` and `backup_runs` — the last being from the branch this one
is stacked on. None of them is business or audit state; the awkward one is
`processed_messages`, which is guarded as append-only evidence while being pure
bookkeeping, so it is the one that could not be swept without a migration.

## J — Telegram report group foundation

**ALREADY SOLVED**, and one part of the request should not be carried out.

The mechanism the item describes exists end to end: a configured destination
with a chat id and a forum topic id, an off-by-default feature flag with a
tenant-wide blast radius, a token that never leaves the transport, a projection
implemented as a decorator so it cannot be forgotten at a call site, once per
_condition_ rather than per occurrence, severity routing, explicit recovery
announcements, a destination snapshotted onto each intent, and a test-send.

**The outbox framing was already tried and rejected on evidence.** ADR-0018
records that the dispatcher is a poller _because_ relay consumers run inside the
claim transaction, so a sending consumer would hold a database transaction open
across a Telegram call. The `NotificationQueued` event was removed rather than
the no-network-in-a-transaction rule bent. The durability the item actually
wants is present anyway: the intent row is written inside the business
transaction, under a savepoint so a failed projection cannot abort the caller.

A distinct "report group" destination alongside the ops destination would
reintroduce the legacy defect ADR-0018 names — two independent destinations for
one concept with no way to tell which is authoritative.

Missing: only two notification kinds exist, so a report that is not an
operational event has no kind and no template key. That is a contracts change
and its own commit.

## K — a reusable log contract

**PARTIALLY SOLVED.** The container exists; the contract does not.

`correlationId` is first-class and branded. Failure classification exists in two
frozen vocabularies but is encoded into the event _code_ rather than carried as
a field. Panel and provider identity travel as untyped `context` keys by
convention — nothing stops the next caller writing `panel_id`. Telegram numeric
id, `@username` and customer display name have no producer and no customer
entity. `OrderId` and `ServiceId` are branded already, so declaring those fields
invents no entity. `operationId` does not exist in any form.

Two real gaps, and they are the ones that matter:

- **`context` never reaches Telegram.** The projector queues exactly five values
  and the Persian template renders only those. Every field this item asks for
  would be invisible in the report group even once produced.
- **`message` is stored raw and unredacted**, and it _is_ what reaches Telegram.
  `context` is redacted on write; `message` is not. Today that is safe by author
  discipline — a real discipline, written down — but it is an argument, not a
  mechanism, and this item's field list would put customer-supplied text exactly
  there.

The English-and-searchable requirement is already met by mechanism: the code is
rendered inside `<code>`, no Persian-digit conversion exists anywhere in the
repository, so Latin values survive verbatim.

## L — provider note foundation

**CONFIRMED GAP** for the port; **NOT APPLICABLE** for the overwrite rule.

There is no note concept anywhere: not on the connection port, not on
`CreateProviderUserInput`, not in the sixteen-entry capability list, not as a
column on `panels`. Both adapters can only authenticate and read status.

The overwrite rule is correct and has nothing to attach to: there is no write
path to any provider-side user field, so nothing can overwrite a note.

The research corpus says nothing about a provider-side note field. Per
`CLAUDE.md` that is `NOT_EXPOSED`, not proof of absence, and must go to
`docs/open-questions.md` rather than be resolved by guessing.

What could exist now without inventing a Phase 4 entity: the format function and
its rules — Telegram id first, no `NEXA` prefix, 500-character cap — and the
read-before-write contract declared alongside the already-declared, unimplemented
`createUser`. Everything else waits. A capability entry must **not** be added
until an adapter performs it: `provider.ts` records that Marzban's descriptor
once advertised fourteen operations no code could perform and that this was
rejected, because the endpoint publishing that array is how the product tells an
operator what it can do.

## M — failure and concurrency testing

**PARTIALLY SOLVED**, and stronger than expected in the two places the item
worried about.

**No test in this repository merely asserts that a mock was called.** Across
1921 `it(` calls there are 31 `vi.fn` uses and zero `vi.mock`. Ten
`toHaveBeenCalled*` assertions exist and every one is paired with a state
assertion; the weakest stands in for `process.exit`, which cannot be called for
real. Real failures injected include a destroyed socket, a server that never
responds, a real 429 with `retry-after`, a held row lock asserted by SQLSTATE, a
statement timeout with an orphan-statement check against `pg_stat_activity`, a
dropped and concurrently rebuilt index, real subprocesses with real exit codes,
and constraints doing the rejecting.

**Concurrency is proven by racing.** The tenant claim races 600 rounds and
asserts both zero double-claims and bounded starvation, so a "fix" that starves
one side is visible. The notification claim uses two real connections with the
second's block observed as an ungranted lock in `pg_locks` rather than a sleep.
The backup lock races four services with distinct lease owners. And the backup
falsification record already contains the drop-the-real-index technique.

Five failure modes have no test:

- a database connection dying mid-transaction — `pg_terminate_backend` appears
  nowhere in the repository, so the relay's outer-transaction abort is untested;
- a subprocess killed by timeout — the branch exists in `pg-tools.ts` and every
  test passes a generous timeout; the `binDir` hook that would make it reachable
  is unused;
- disk full — modelled for the installer, not for `BACKUP_WORK_DIR`, which
  ADR-0025 itself says needs three artifacts on disk at once;
- Redis unreachable — readiness slows the database checkout and never the cache;
- and the CLI, which had no test at all. **That one is already fixed** on the
  Backup V1 branch; the rest are listed here.

`.only`, `.skip`, `xit`, `expect(true)` and empty test bodies: **zero
occurrences** outside the checker's own fixtures.

## N — ADRs

**PARTIALLY SOLVED.**

Numbering is clean: 25 files, `0001`–`0025`, no gap, no duplicate. **No
superseded decision has been erased** — ADRs grow additively, the largest
deletion in any ADR commit is 23 lines inside a 154-line addition, ADR-0009
gained a correction section rather than a rewrite, and ADR-0011 kept the whole
original conflict narrative including the review's opposing position.

- **The index is stale.** `docs/adr/README.md` ends at 0023; ADR-0024 and
  ADR-0025 are both absent.
- **ADR-0010 is stale.** It says nothing enforces the destructive-operation
  protocol "because Phase 0 has no destructive or bulk operation". Two of its
  steps are enforced today by the feature-flag typed confirmation, and
  `docs/conventions.md` already says so.
- **ADR-0009 is mildly stale** — still describing the authentication model as an
  open decision that ADR-0013 has since made.
- **Four Backup V1 decisions are unrecorded**: the operator restore protocol
  (which is a destructive operation and a deliberate deviation from ADR-0010's
  five steps — no dry run, no counted preview, no typed confirmation, no audit
  row); that a failed backup raises no operational event; where the scheduler
  runs and why it is not a fourth process role; and the eight new error codes,
  in particular the deliberate choice to collapse four cryptographic causes into
  one code and to _not_ collapse the malformed case.

## What this audit changes about the plan

Three items are not gaps and will not be implemented: **F** (no Redis admission
cache — and one of its findings argues for depending on Redis _less_), **J** (the
foundation exists, and the outbox framing was already rejected on evidence), and
the overwrite half of **L**.

Two items are mostly about _enforcement_ rather than behaviour — **D** and parts
of **E** and **M** — where the property already holds and the work is making it
impossible to lose quietly.

The rest are real. The sharpest, in order of what they cost when they fire: the
notification dispatcher's invisibility (**H**), the backup module's missing
scope, audit and operational event (**B**), the probe cooldown floor (**E-2**),
and the webhook test that cannot fail (**G**).
