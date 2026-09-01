# ADR-0011 — Telegram backup delivery is retained as a requirement

**Status:** Accepted. **Deviates from the architecture review's ADR-013, which
is marked ACCEPTED.** Raised explicitly with the owner; the owner chose to keep
Telegram delivery.

Nothing in Phase 0 implements backups. This ADR exists so the decision and its
accepted risk are on the record before Phase 8 designs the pipeline.

## The conflict

**The review (ADR-013):** backups must never go to Telegram. Encrypted backups
go to object storage with per-backup keys, integrity manifests, retention and
verified restores; Telegram receives a **notification** carrying a checksum and
a row count, never the artifact.

**The product brief:** encrypted scheduled backups **with Telegram delivery**,
plus off-server storage support.

## The evidence behind the review's position

The legacy system delivers a 43 MB production database dump into a five-member
Telegram group twelve times a day, protected by a shared ZIP password obtainable
by messaging support. That is roughly 4,400 copies of the customer database per
year sitting in a chat client, on every member's devices, replicated to
Telegram's servers, inherited in full by anyone added to the group later, and
outside any retention or revocation control. The review rates it Critical, and
notes that the problem is the distribution channel rather than the cipher:
access cannot be revoked and copies cannot be counted.

## The decision

Telegram delivery stays a supported capability. The owner's reasoning is
operational: operators of this product recover from Telegram, and a backup they
cannot reach is not a backup.

## Accepted risk, stated plainly

Delivering a database backup to a chat channel means: copies cannot be counted,
access cannot be revoked, a member added later inherits the entire history, and
the artifact exists on every member's devices outside any retention policy.
Choosing this is a business decision, and it is recorded as one.

## Compensating controls the Phase 8 design must carry

Because the channel cannot be made safe, the payload has to be:

1. **Per-backup encryption keys**, never a shared password, and never one
   distributed through the same channel as the backup.
2. **Off-server object storage as the primary destination.** Telegram is a
   secondary copy, not the system of record.
3. **A size ceiling**, above which Telegram receives a notification and a
   retrieval link rather than the artifact.
4. **A retention and deletion policy for the Telegram channel**, applied by the
   system rather than by hand.
5. **A dedicated channel with a documented, reviewed membership list**, not the
   general operations group.
6. **An access log** recording every delivery, and an alert on membership change.
7. **A verified restore drill**, timed, before the first production backup is
   relied on.

## Revisit when

Before Phase 8 implements the backup pipeline, and immediately if the deployment
model changes to a shared multi-tenant one — at which point a single chat
channel would carry more than one customer's data and the calculus changes
entirely.
