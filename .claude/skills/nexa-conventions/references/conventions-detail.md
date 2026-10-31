# Conventions in full (moved verbatim from SKILL.md, token diet)

`SKILL.md` keeps the short form of each rule below; this is the full wording.

## The write path

Every state-changing operation follows all seven steps, in order. Copy
`RecordPingService` rather than inventing a variant.

1. Authenticate — the caller supplies an `ActorContext`.
2. Resolve scope — `TenantContext` or explicit `SystemContext`.
3. Authorize — `guard.check(scope, actor, permission)`. Deny by default, for
   **every** actor type including `SYSTEM_JOB`, which holds only
   `SYSTEM_JOB_PERMISSIONS`. Never add an actor-type bypass. Audit the denial
   before rethrowing.
4. Validate — parse into a typed command with zod at the boundary.
5. Idempotency — look the key up; return the first result on a replay.
6. Transact — domain change, audit row and outbox rows in **one** transaction.
7. Project — the relay publishes; consumers do the rest.

## Events, audit and operational events

Three different things. Do not merge them.

- **Domain event** → `outbox_messages`, written inside the business transaction.
  The event type must already be in the catalog; adding one is a contract change.
- **Audit** → who changed what, `before`/`after` as **values**, machine `action`
  code, and `result` including `DENIED`.
- **Operational event** → what the system did: code, severity, dedupe key,
  occurrence counter, and an explicit recovery event when a condition clears.

The database is the log. Telegram is a projection of it.

## Idempotency

Every state-changing command takes a key, namespaced by the acting surface. A
replay returns the first result. A key reused with a **different** payload is
rejected — that is a caller bug, and returning the stale result would hide it.
Never widen a key's namespace: two surfaces sharing one lets either consume the
other's keys.

## Secrets

- Stored credentials use `SecretCipher` (envelope encryption, `keyId` on the
  ciphertext). No API response ever contains a credential.
- Redact before writing anything durable. `infrastructure/redaction.ts` is the
  one implementation, shared by the logger, the audit log and the ops log — do
  not write a second one, and do not bypass it.

## Domain invariants — the ones most often broken (full bullets)

- **Only the inquiry decides** a gateway payment; a webhook is a hint. The
  attempt's deadline is checked under the payment's lock.
- **A create whose answer was lost is never retried and never re-keyed**, and
  **UNKNOWN is never refunded** — a READ decides first.
- An order has **two terminal outcomes and no third**: FULFILLED or REFUNDED,
  through the **one credit path**, `RefundService.refundUndeliverable`. A
  **wallet purchase is refused, never refunded**.
- **One pricing boundary**, `PricingService.price`; a quote is **honoured, never
  re-priced**. Cashback and commission are earned once, at delivery.
- **There is no reseller credit**; a negative wallet blocks every purchase.
- **Every state change is a conditional UPDATE naming its `from` states.**
  There is no `setState`.
- A capacity slot is a **RESERVATION ROW**, not a count; one eligibility
  evaluator, four callers.
- A panel credential travels **one way**; never a masked stand-in.
- A customer is told a fact through the **notification lane**, never a string.
- An operational-event CODE is part of the schema: never rename or split one.
- **Import silence:** imported subjects are never notified for state that
  existed at import, and the first figure observed after import is silent —
  only a change after that is news (R5A-2, R5C-2: the first usage figure after
  the backfill is silent on every write path). No customer message from a
  migration, an import or a backfill. The operations log is silent only for
  the records the import itself created: it reads the provenance of the record
  a log is ABOUT (the order, the ticket, the customer row of a registration),
  never the customer's — a migrated customer's purchase, block, alert, failure,
  ticket, referral commission or signup gift after the import is logged
  (v0.8.2-e, R10 B5, R11 A6).
