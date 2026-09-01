# ADR-0002 — Module layout and boundary enforcement

**Status:** Accepted.

## Decision

```
apps/api/src/
  modules/<context>/<submodule>/{domain,application,infrastructure}
  surfaces/{telegram,web}
  infrastructure/          shared adapters: config, persistence, redis, logging, crypto
  container.ts             the composition root
```

Contexts: `platform`, `commerce`, `money`, `fulfilment`, `partner`, `insight`.
Only `platform` exists in Phase 0. The others are named in
`docs/architecture.md` rather than created as empty directories — a folder with
nothing in it is a promise, not architecture.

## Reconciling the review

The architecture review's §3 shows `src/commerce/ordering`, while its
agent-ownership section shows `modules/ordering`. The two disagree on nesting.
Resolved as `src/modules/<context>/<submodule>`, which keeps the review's
bounded-context taxonomy and its one-public-surface-per-module rule.

## Rules, and what enforces them

| Rule                                                                  | Enforced by                   |
| --------------------------------------------------------------------- | ----------------------------- |
| `@nexa/contracts` imports nothing from the workspace and no framework | `check-boundaries.sh`, ESLint |
| Domain and application layers import no framework or I/O library      | `check-boundaries.sh`, ESLint |
| Domain and application layers do not import surfaces                  | `check-boundaries.sh`, ESLint |
| Surfaces contain no data access                                       | `check-boundaries.sh`, ESLint |
| `apps/web` imports only `@nexa/contracts` and `@nexa/i18n`            | `check-boundaries.sh`, ESLint |
| No `new Date()` in domain or application code                         | `check-boundaries.sh`, ESLint |

## Dependency inversion

Domain and application layers **declare ports**; infrastructure implements them
and depends inward. The cross-cutting ports — `Clock`, `IdGenerator`,
`Translator`, `SecretCipher`, `UnitOfWork`, `IdempotencyStore`, `AuditWriter`,
`OperationalEventRecorder`, `EventPublisher` — live in `@nexa/contracts`, which
is pure declarations and depends on nothing. Module-specific ports live in that
module's `application/ports.ts`.

`container.ts` is the only place an adapter is constructed.

## Why rule "surfaces contain no business logic" matters most

Every cross-surface inconsistency in the legacy system has one root cause: two
surfaces each owning their own version of a shared concept. Four admin roles in
one and seven in the other. Thirty-six editable texts in one and 608 in the
other. Two definitions of "buyer" inside one feature, differing by 29,060 users.
A revenue figure understated by 38% on one surface. Removing the possibility is
a better fix than resolving the instances.
