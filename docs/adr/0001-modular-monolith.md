# ADR-0001 — Modular monolith with process roles

**Status:** Accepted. Matches the architecture review's ADR-001.

## Decision

One repository, one deployable image, several process roles started from that
image with different entrypoints: `api` and `worker` now; `scheduler` and
`monitor` when they have work to do.

## Why not microservices

The hardest requirement is atomic money operations. A purchase will touch an
order, its item snapshots, a wallet reservation, ledger entries, a payment, a
discount redemption, a referral commission, an audit row and outbox events. In
one Postgres transaction that is trivially correct. Across services it is a saga
with compensating actions — machinery for a distribution problem this system
does not have.

The observed failure modes are I/O failures: panels returning 503, expired TLS,
connection timeouts, a gateway rejecting the same payload 23 times over 15 days.
Those are isolated by queues, timeouts, circuit breakers and adapters, all of
which work inside a monolith. At roughly 400 orders a day against ~197k user
rows, no component is near a scaling limit.

The deployment target also decides it: the product is installed by operators on
modest servers. A service mesh is not operable there.

## What we take from microservices

Hard module boundaries, explicit contracts between modules, domain events as the
integration mechanism, and independently scalable process roles.

## Why `worker` is separate from day one

Broadcasts and scheduled backups must not share an event loop with the webhook.
An env toggle would be worse than a second entrypoint: a missing variable would
silently make an HTTP process drain the queue, and shutdown semantics would be
ambiguous. Two `main` files over one module graph cost nothing now and avoid
redoing bootstrap, health and shutdown later.

## Risk

A monolith degrades into a mud ball without discipline. Mitigated by boundary
lint and `scripts/check-boundaries.sh` in CI. Any module can be extracted later
precisely because the boundaries are real.
