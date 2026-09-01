# ADR-0003 — `@nexa/contracts` as a compiled frozen specification

**Status:** Accepted. Matches the architecture review's ADR-015.

## Decision

One package holds entity types, branded ids, `Money`, time periods, actor and
tenant contexts, state-machine encoding, the `ProviderAdapter` interface, the
`PriceQuote` shape, the ledger reason vocabulary, the domain event catalog, the
permission catalog, the error taxonomy, the metric registry, template keys and
the cross-cutting ports.

It depends on nothing — not on another workspace package, not on a framework.

**Adding a state, an event, a permission, a ledger reason, a metric or a
template key is a contract change.** It gets its own commit and its own review.
It is never folded into a feature change.

## Why a package rather than a document

A document drifts silently and nothing fails when it does. A compiled package
makes the compiler the reviewer that never gets tired: a module that invents its
own `OrderStatus` fails the build rather than a code review, and an event name
that is not in the catalog throws at the point of writing it.

This matters more than usual here, because much of the implementation will be
written by AI agents at volume, and the legacy system's defining characteristic
is accumulated inconsistency that nobody decided on — one provider identity with
four renderings, one status enum with four encodings, one price label meaning two
different things in two message families.

## Deliberate contents in Phase 0

Full catalogs where the vocabulary is decidable now: permissions, ledger
reasons, error kinds, actor types. Shapes only where the implementation is
later: `ProviderAdapter`, `PriceQuote`, state machines. Genuinely empty where
nothing can honestly be registered yet: the metric registry, the provider
descriptor list, the state machine list. An empty registry is honest; an
aspirational one is not.

## Risk

Contract changes become a bottleneck. That is the intended property. Frequent
churn signals that the domain was misunderstood, and it should be loud.
