# Full-project review — September 2026

**Commit under review:** `542e5495ae2ffa5f0616182dce7436e074341ff7`
(the merge of Phase 3A, `main` at the time of writing)

**Status:** review in progress. This document exists to carry the review; it
records no conclusions of its own.

## Why this exists

Phases 0, 1, 2, the deployment checkpoint, Secret Envelope v2 and Phase 3A have
each been reviewed as they landed, branch by branch. None of that is a review of
the product as a whole. A defect that lives in the seam between two phases — a
Phase 1 assumption that Phase 3A quietly invalidated, a deployment guarantee that
a later migration weakened — is invisible to a per-branch review by construction,
because no branch contains both halves.

This is one bounded pass over the whole repository at one commit, to look for
exactly that class of problem.

## What the review covers

The entire repository, not the diff of the pull request carrying this file.

1. Architecture and boundaries — tenant isolation, layer boundaries, the
   provider abstraction, accidental coupling, cross-module leakage, decisions
   that would be expensive to reverse.
2. Security — Secret Envelope v2 and its contextual binding, credential leakage
   through any surface, audit and log leakage, authentication and authorization
   bypass, idempotency authorization, SSRF, DNS rebinding, TLS and private-CA
   handling, redirects, URL composition, injection, deserialization, insecure
   defaults.
3. Database and data integrity — tenant predicates, constraints, indexes,
   archive and delete semantics, migration safety, races, transactional
   integrity, replay and idempotency correctness, stale reads and writes.
4. Provider and panel foundation — the Marzban adapter, panel credential
   handling, the provider registry, health normalization, capability contracts,
   error normalization, `SafeHttpClient`.
5. Deployment — installer, `botctl` update and rollback, immutable release
   assumptions, host asset replacement, backup and restore, release metadata,
   failure recovery, secret configuration migration, rollback compatibility.
6. Concurrency and jobs — locks, duplicate execution, retries, worker safety,
   transaction boundaries, race windows.
7. API and web surface — auth guards, tenant isolation, response leakage, error
   propagation, missing validation, privilege escalation.
8. Tests — invariants with no real test, tests that pass without exercising the
   path they name, stale-build tests, mocks hiding real bugs, missing hostile
   cases, false greens, untyped tests, mutation-resistant gaps.
9. Operational correctness — what passes CI but would fail on a real Ubuntu
   host; hostname and network behaviour; environment and configuration
   handling; assumptions that differ between test and production.
10. General correctness — logic bugs, unreachable code, wrong error mappings,
    broken edge cases, unsafe fallbacks.

## What the review is not for

Formatting, naming preference, stylistic opinion, speculative refactors with no
concrete defect, and work deliberately deferred to Phase 3B, 3C, 3D or later.
Those deferrals are recorded in `docs/open-questions.md` and are decisions, not
oversights.

## Known tradeoffs, already decided

A finding that restates one of these is a tradeoff being re-argued, not a defect
found. They are listed so the review can spend its budget elsewhere:

- `TRADEOFF-SSRF-PRIVATE` — private and internal addresses are reachable by
  design, because a self-hosted panel on RFC1918 space is the ordinary case.
- `TRADEOFF-SSRF-PLAINTEXT-NAME` — plaintext `http://` to a hostname is refused
  even when the host is private, because the URL check cannot resolve first.
- `TRADEOFF-HEALTH-LATEST` — one health row per panel, no history.
- `TRADEOFF-CAPS-DECLARED` — capabilities are declared by adapters, never
  persisted, so no SQL query can filter panels by capability.
- `TRADEOFF-TESTS-TYPED-PARTIAL` — sixteen named Phase 1 and 2 test files are
  excluded from `tsconfig.tests.json`; the list only shrinks.
- `TRADEOFF-NOTIF-RETAIN`, `TRADEOFF-OPSLOG-RETAIN` — no retention sweep for
  notification or operational-event history.
- The `addressAllowed` re-check inside the DNS pin is unreachable under the
  current already-filtered selection of `pinned`, and is kept against a future
  change to that selection.

Full text and reasoning: `docs/open-questions.md` and `docs/adr/`.
