# WP6-C — a customer may rotate their own subscription link

Written before the code, as `docs/wp6-audit.md` §2 and §7 were. `docs/wp6-audit.md` §3
fixed the outline, and OQ-WP6-04 (formerly OQ-RP-08) gave the entitlement rule: a
tenant setting, behind a flag that is off by default. This document says where each
part lives, what already exists, and what does not.

## 1. What exists, and what is reused unchanged

- **The operation.** `ROTATE_SUBSCRIPTION` already exists. It needs the
  `ROTATE_SUBSCRIPTION_LINK` capability, which only RickPanel declares, and it is an
  `IDEMPOTENT_MUTATION`: settled by a read-back inside the attempt, never `UNKNOWN`
  (`docs/rickpanel-rotate-audit.md` D3–D5).
- **Execution.** `finishRotation` stores the new link, re-arms delivery (`PENDING`,
  zero attempts) and writes the audit row. The sweep sends `bot.service.subscription`
  with the new link. Every delivery write is compare-and-set on the link, so an old
  send cannot mark the new one delivered (RR-04..RR-15).
- **The planner.** `planRequestedOperation` is shared by the customer and operator
  request paths and applies these checks:
  - the state is legal;
  - the panel can perform the operation (`decideOperability`, which includes the
    capability);
  - scope activity is read inside the transaction;
  - an open operation of the same type is returned, not rivalled;
  - the operation id is derived from the caller's idempotency key, so a replay
    returns the same row;
  - one audit row per request.
- **Nothing about the old link is claimed.** Old-link invalidation is not proven
  (OQ-RP-07). No customer-facing sentence here says the previous link stops working.

## 2. What does not exist, and what WP6-C adds

| gap                                                     | addition                                                                                                                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No flag                                                 | `customer_link_rotation`, off by default, `TENANT_WIDE`: turning it on offers a new action to every customer at once, like `trials`                                                           |
| No rate rule                                            | `services.link_rotation_cooldown_hours`, integer 1..720, default 24, `configures` the flag. Zero is refused: "no cooldown" is the abuse rule D1 of the rotation audit said nobody had decided |
| No service row lock                                     | `ServiceRepository.lockForUpdate` (`SELECT … FOR UPDATE`), taken inside the planning transaction and before anything else is read there                                                       |
| No record of when a customer last rotated               | Read from the operations the customer asked for. No new column: `provisioning_operations_service_idx` already leads with `(service_id, created_at)`                                           |
| No outcome sentence for a rotation a customer asked for | `ROTATE_SUBSCRIPTION` joins `CUSTOMER_REQUESTABLE_OPERATIONS`. An operator's rotation still says nothing, because `requested_by_customer_id` is null                                          |
| No customer surface                                     | A button on the service detail, an ask screen and a confirmation, on two new callback prefixes                                                                                                |

## 3. Decisions

### C1 — The customer rule is narrower than the operator's

- **`ACTIVE` only.** An operator may rotate a `SUSPENDED` service (rotation audit D2).
  A customer may not: the delivery sweep sends only to `ACTIVE` services, so a
  suspended customer would be told the request succeeded and receive no link.
- **The same operability.** The panel must be operable for `ROTATE_SUBSCRIPTION`, which
  includes the capability. So the button is drawn only for a RickPanel-backed service,
  and a Marzban or 3X-UI service is refused if the callback is sent anyway.
- **Ownership is the authorisation**, exactly as `requestFromCustomer`. The actor is the
  webhook's `SYSTEM_JOB`, charged `maintenance.run` like every other customer write
  (`docs/wp6-audit.md` A9).
- **A blocked customer is refused inside the transaction** with `CUSTOMER_BLOCKED`. The
  surface already refuses a blocked customer on arrival, and a block can commit in
  between.

### C2 — The cooldown

- **Scope.** Per service, per customer.
- **What counts.** Only the customer's own rotations count. An operator's rotation does
  not start the customer's cooldown: that rotation is the operator's decision, and the
  customer did not spend anything.
- **Which rotations count.** Only one that `SUCCEEDED`, measured from when it was
  requested (`created_at`, the indexed column; the gap to completion is seconds).
  - A `FAILED` or `ABANDONED` rotation changed nothing the customer holds, because a
    rotation is settled by a read-back. Charging it would refuse a customer whose link
    never changed.
  - An open one (`PLANNED` or `IN_FLIGHT`) is not a cooldown question: it is returned
    as the request already under way, by the planner's existing open-operation rule.
- **Where it is decided.** Inside the planning transaction, after the service row lock.
  That makes two taps with different keys serial:
  - the second waits on the lock;
  - it then finds the first either open (and is given it) or `SUCCEEDED` (and is
    refused);
  - it never plans a second rotation beside the first.
- **Replays go before the cooldown.** A replayed request is answered with the operation
  it already planned, before the cooldown is read. Otherwise a redelivered webhook for
  the request that started the cooldown would be refused by its own success.
- **The refusal.** It is `SERVICE_ROTATION_COOLDOWN`, carrying `availableAt`. The
  customer is told when they may ask again (`bot.service.rotate_cooldown`, one
  `DATETIME` placeholder), not merely "later".

### C3 — What the customer is told

1. **The ask screen** (`bot.service.rotate_ask`). It says a new link will be issued and
   has to be put into the customer's apps. It shows the cooldown in hours
   (`cooldownHours`). It does not say the old link stops working.
2. **The confirmation** answers `bot.service.action_requested`, which already
   deliberately does not say "done".
3. **On success:**
   - the announcer enqueues `SERVICE_ACTION_SUCCEEDED`, as for the customer's other
     actions;
   - separately, the delivery sweep sends the new link. That is the answer the customer
     actually needs, and it already exists.
4. **On abandonment** the customer is told `SERVICE_ACTION_FAILED`, and the cooldown has
   not been charged.

### C4 — Callback prefixes

`rc:<serviceId>` opens the ask, and `rd:<serviceId>` confirms. Neither is a prefix of
another registered prefix, and no registered prefix is a prefix of either. `r:`
(resend) is not a prefix of `rc:`, because the second character differs.

The confirmation carries no link stamp, unlike the operator's `rb:`, for two reasons:

- a stale confirmation lands on the cooldown, which is the rule that matters to a
  customer;
- a confirmation tapped after the cooldown has passed is a real request, made by the
  person the service belongs to.

The idempotency key is the update key suffixed `:rotate`, the convention
`docs/wp6-audit.md` §4 records.

## 4. Not in this package

- Web self-service: customers have no Web surface.
- Rotation from `SUSPENDED` for a customer (C1).
- Any claim about the old link (OQ-RP-07 stays open).
- Marzban rotation: the route exists, but it is not proven against the real panel, so
  the capability stays undeclared (rotation audit D7).

## 5. UNKNOWN

| id        | question                                                                   | what WP6-C does meanwhile                                                                                                     |
| --------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| OQ-WP6-05 | Should an operator's rotation also reset or start the customer's cooldown? | No. Only the customer's own `SUCCEEDED` rotations count (C2). A one-line change in the repository query if decided otherwise. |
| OQ-WP6-06 | Should a customer be able to rotate a suspended service?                   | No (C1). Delivery would not reach them until the service is resumed.                                                          |
