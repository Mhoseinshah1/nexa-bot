# Architecture decision records

One file per decision: what was decided, why, what was rejected, and what would
make us revisit it.

Two conventions matter here.

**A decision taken _against_ the architecture review is recorded, never
silent.** Where the owner chose differently from an ACCEPTED review decision,
the ADR names the review decision, the owner's choice, and the cost.

**A design decision is never presented as an observation.** Where the legacy
system had no rule to reproduce — pricing precedence is the clearest case — the
ADR says so explicitly.

| ADR                                      | Decision                                                          | Status                                      |
| ---------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------- |
| [0001](0001-modular-monolith.md)         | Modular monolith with process roles                               | Accepted                                    |
| [0002](0002-module-boundaries.md)        | Module layout and boundary enforcement                            | Accepted                                    |
| [0003](0003-frozen-contracts.md)         | `@nexa/contracts` as a compiled frozen spec                       | Accepted                                    |
| [0004](0004-tenant-isolation.md)         | Application-level tenant scoping, no RLS                          | Accepted — **deviates from review ADR-004** |
| [0005](0005-money-and-rate-snapshots.md) | Money representation and when a rate snapshot is required         | Accepted                                    |
| [0006](0006-outbox-and-idempotency.md)   | Transactional outbox, at-least-once delivery, durable idempotency | Accepted                                    |
| [0007](0007-events-audit-opslog.md)      | Domain events, audit and operational events are three things      | Accepted                                    |
| [0008](0008-drizzle-over-prisma.md)      | Drizzle ORM with checked-in SQL migrations                        | Accepted                                    |
| [0009](0009-identity-and-auth.md)        | No authentication in Phase 0                                      | Accepted — open decision for Phase 1        |
| [0010](0010-destructive-operations.md)   | Destructive and bulk operation protocol                           | Accepted                                    |
| [0011](0011-backup-delivery.md)          | Telegram backup delivery retained                                 | Accepted — **deviates from review ADR-013** |
| [0012](0012-toolchain.md)                | TypeScript 6, ESM, Node 22, NestJS 12                             | Accepted                                    |
