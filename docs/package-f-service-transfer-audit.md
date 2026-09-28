# Package F — service transfer between customers: audit and design

The post-WP20 brief's Package F: a customer hands one of their own services to another
customer of the same tenant, from `سرویس‌های من → مشخصات سرویس`. The provider account
stays where it is. This is **not** a panel migration.

## 1. What the owner settled, and what stood in the way

Since Phase 2, `services.transfer` has been a declared permission that nothing charges.
Its docblock (`packages/contracts/src/permissions.ts`) names four questions a wrong guess
makes expensive. The brief answers each one:

| question                                                                 | the brief's rule (F4)                                                                                                   |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| the ORDER                                                                | It stays the original payer's. `services.order_id` keeps naming it.                                                     |
| the PAYMENT, the wallet, cashback, referral commission, earlier renewals | Historical truth, never rewritten.                                                                                      |
| the LINK                                                                 | "Do not rotate the subscription link merely because ownership changed." The recipient can rotate it themselves (WP6-C). |
| the capacity slot, the username reservation                              | Both are keyed to the ORDER, which does not move. Nothing about them changes.                                           |

Future renewals and add-ons are the new owner's, because every one of them is a new order
paid by whoever owns the service when they buy it.

This package builds the **customer** path the brief describes and nothing else. An operator
route that transfers a service is not asked for. `services.transfer` stays declared and
unserved, and its docblock says why now.

### 1.1 What the schema did to a transfer before this package

Nothing in the application could have moved a service. Two composite foreign keys forbade it:

- **`services_order_fk`** `(tenant_id, order_id, customer_id) → orders` (0034). A confirmed
  order's customer is frozen (`nexa_orders_snapshot_guard`, 0033/0083). So a service could
  never name a customer other than its order's.
- **`service_commercial_actions_service_fk`** `(tenant_id, service_id, customer_id) →
services (tenant_id, id, customer_id)` (0047). Its rows are append-only (0048), so even an
  abandoned renewal draft would make the owner's row unchangeable.

Both encoded "the customer on this row is the service's owner", which was true only while
ownership never changed. Each is replaced by what it actually protects, as two rules:

1. **At creation**, a service's customer is its order's customer. A `BEFORE INSERT` check on
   `services` keeps that exactly: a service still cannot land in the wrong list.
2. **Afterwards**, `services.customer_id` changes only through a transfer.
   - A `BEFORE UPDATE` trigger refuses any change of `customer_id` unless the newest
     `service_ownership_transfers` row for that service names exactly this `from → to`.
   - `order_id` becomes immutable outright.
   - A commercial action's customer must be the service's owner when the action is written
     (`BEFORE INSERT` on `service_commercial_actions`). The two-column reference keeps the
     service itself, and the order reference still pins the payer.

These are reference-shape changes, not new data. Every existing row satisfies both rules as
it stands.

## 2. The customer flow (F1)

1. The service detail shows `🔄 انتقال سرویس` beside the refund request (row 4), only when
   the service is transferable (§4). Drawing it is a courtesy; the confirmation decides
   again.
2. A tap opens a capture window, `SERVICE_TRANSFER_RECIPIENT` (subject = the service), and
   asks for the recipient's numeric id. The id is the `telegram_user_id` the recipient's own
   `/wallet` shows as «🪪 آی دی عددی».
3. The typed id is validated by `telegramUserIdSchema`, after Persian `۰-۹` and Arabic-Indic
   `٠-٩` digits are read as ASCII — a recipient's id copied onto a Persian keyboard is still
   their id. The recipient is resolved inside the
   tenant by the exact lookup `CustomerRepository.list({ telegramUserId })`, the one the admin
   search already uses. The screen then shows:
   - the service's account name and location (for a custom service, the location label its
     order's frozen terms recorded);
   - the remaining traffic and time;
   - the recipient's numeric id and, when Telegram gave one, their display name or @username.
4. The button carries `ta:<serviceId>` (39 bytes) and opens the window; it moves nothing.
   `✅ تأیید انتقال سرویس` carries `tc:<serviceId>.<recipientTelegramId>`: at most 59 bytes,
   under Telegram's 64. The confirmation reads the recipient again. Nothing on the button is
   trusted.
5. The transfer commits in one transaction (§5). The sender is told
   `✅ سرویس با موفقیت به کاربر مقصد منتقل شد.`

The recipient is never asked to accept, as the brief says.

## 3. Recipient eligibility (F2)

| refusal             | when                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `RECIPIENT_UNKNOWN` | no customer of THIS tenant has the id. A customer of another tenant is exactly as unknown, so a transfer can never cross a tenant. |
| `RECIPIENT_SELF`    | the id is the sender's own                                                                                                         |
| `RECIPIENT_BLOCKED` | the recipient is `BLOCKED`. A blocked customer cannot use the bot, so they could not manage what they were given.                  |

There is no deleted customer state in this model. A typed text that is not a numeric id at
all is `RECIPIENT_INVALID`.

The four are a closed set in `packages/contracts/src/service-transfer.ts`, carried by
`commerce.service_transfer_recipient_refused`. The customer is told `RECIPIENT_UNKNOWN` and
`RECIPIENT_BLOCKED` in ONE sentence: telling them apart would tell a stranger which Telegram
accounts an operator has blocked. Each recipient refusal opens the window again, because its
sentence asks for the id once more.

## 4. Service eligibility (F3)

A service may be transferred only when all of these hold, decided under its locks at
confirmation:

- it belongs to the sender, and was not refunded away (`getForCustomer`'s own predicate);
- its state is `ACTIVE` or `SUSPENDED`. The brief names both.
  - `PENDING_PROVISION` and `UNRECONCILED` are undecided provider states.
  - `TERMINATED` is gone.
  - `EXPIRED` is refused too: nothing in the brief asks for it, and a renewal is the
    sender's to buy before giving it away.
- its subscription has been DELIVERED. A link still on its way would reach whoever owns
  the service when the sender retries, which is a race with no right answer.
- no provisioning operation on it is undecided (`PLANNED`, `IN_FLIGHT`, `UNKNOWN`), other
  than a SCHEDULED `SYNC_USAGE` read (`requested_by_customer_id` null). This covers:
  - a paid renewal, add-traffic or add-time not yet applied;
  - a suspend, resume or rotation on its way;
  - a terminate an operator planned;
  - a usage read the SENDER asked for. The announcer tells its outcome to whoever owns the
    service when it ends, so the recipient would be told "your request was done" about a
    request they never made. A scheduled read is announced to nobody, and is let through.
- no refund request on it is `OPEN` or `EXECUTING`.
- no commercial order for it is `AWAITING_PAYMENT`. The sender may be paying for it right
  now.
- it is not a trial.
  - A trial is free, and the grant counts against the claimant's own allowance.
  - Passing trials to one account would turn every free account into a trial for somebody
    else.
  - The brief does not ask for trials to move. This is the conservative reading, recorded
    here.

A commercial DRAFT the sender left behind is not refused. Instead, confirming or settling
a commercial order requires the order's customer to OWN the service. The old owner's
draft cannot be paid into the new owner's service:

- confirmation already refuses with `SERVICE_NOT_FOUND`: `CommercialActionService.confirm`
  reads the service through `ownedService`, which compares its owner with the order's
  customer. Nothing changes there; a test now holds it for a transferred service;
- settlement refuses with the `SERVICE_NOT_OWNED` preparation refusal
  (`commerce.service_action_not_allowed`, like the other preparation refusals), which is new: the
  confirmation reads the service without a lock, so an order confirmed in the moment a
  transfer commits reaches settlement naming a service its payer no longer owns.

A refused settlement follows the existing rule: a wallet purchase is refused and never
debited, and a transfer is refunded through the one credit path.

## 5. The transaction, and its locks

`ServiceTransferService.transfer`, in one `uow.run`:

1. **Idempotency.** The transfer row carries the update's idempotency key, `UNIQUE(tenant,
key)`. A replayed update returns the row it already wrote.
2. **The service row, `lockForUpdate`, then the lifecycle lock `lockLifecycle`.** This is
   the order a terminate and a refund request take: the row, then the lifecycle lock last.
   - A commercial settlement takes the lifecycle lock without the row. Before it inserts its
     operation it takes the `FOR KEY SHARE` a foreign key takes, which does not conflict
     with the `NO KEY UPDATE` held here.
   - So a settlement already inside finishes first, and the transfer then sees its
     operation and refuses.
   - A settlement arriving later waits on the lifecycle lock. It then finds a service its
     payer no longer owns, and refuses (§4).
   - The reassignment in step 4 escalates the row lock. `customer_id` is a column of
     `services_tenant_id_customer_key`, so PostgreSQL takes `FOR UPDATE`, not
     `NO KEY UPDATE`, for the UPDATE that changes it. That conflicts with the `FOR KEY SHARE`
     of a foreign-key check. A commercial draft's insert already in flight on the row
     finishes first; one arriving after it waits for the transfer to commit and then reads
     the new owner, which the insert's owner check refuses. The key is kept for exactly
     this serialisation, although no foreign key targets it any more. The escalation
     cannot deadlock with a settlement: a settlement takes the lifecycle lock before it
     inserts anything that references the service, and the transfer already holds that
     lock when it escalates.
3. **Re-decide everything in §3 and §4.**
   - If the sender no longer owns the service because THIS transfer already happened (the
     newest transfer row is `sender → this recipient`), the answer is the completed result,
     not an error. A double tap is two updates with two keys, and the second one must not
     say the first failed.
4. **Write:**
   - the `service_ownership_transfers` row (append-only), FIRST: the database admits the
     change of owner only when the newest row for the service names it. "Newest" is an
     identity column `seq`, not `created_at`, so two transfers a clock tick apart, or on
     two replicas whose clocks disagree, still have one newest row. The row lock makes
     `seq` their commit order;
   - `services.customer_id = recipient` and `customer_note = NULL` (F5);
   - one audit row, `service.transfer`, with `from`/`to` customer ids;
   - one outbox event, `ServiceOwnershipTransferred {serviceId, fromCustomerId,
toCustomerId}`;
   - one customer notification for the recipient.

The recipient's customer row is read, not locked. A block that commits a moment later is
the same as a block a moment after the transfer. Waiting on the recipient's wallet lock
would be the only lock in this codebase taken on a customer after a service lifecycle lock.

## 6. What moves and what does not (F4, F5)

| moves                                                  | stays exactly as written                               |
| ------------------------------------------------------ | ------------------------------------------------------ |
| `services.customer_id`                                 | the order, its payment, and every wallet entry         |
| (the recipient now sees it; the sender no longer does) | cashback earned and its reversals                      |
|                                                        | referral commissions                                   |
|                                                        | discount redemptions, reseller terms                   |
|                                                        | earlier commercial actions (the payer of each renewal) |
|                                                        | the refund requests the sender filed                   |
|                                                        | trial grants, username reservations                    |
|                                                        | provisioning operations' `requested_by_customer_id`    |
|                                                        | every audit row                                        |

- **The provider account is untouched.** No adapter is called: no username change, no
  re-creation, and no rotation.
- **The customer's note is cleared.** It was written by the sender, for the sender. There is
  no operator-internal service note.
- **A refund request by the recipient is refused** by the existing rule that the source
  payment's payer must be the service's owner (`SOURCE_UNRESOLVED`). The recipient cannot
  refund money somebody else paid.
- **The sender's link keeps working.** That is the brief's rule, and the recipient can rotate
  it. §9 records it.
- **Reminders are keyed on the service and its period basis.**
  - A reminder raised before the transfer for the same expiry is not raised again for the
    recipient.
  - The next basis — a renewal, or new traffic — reaches the recipient.

## 7. Notifications (F6)

- **The sender** is answered at once, as an interactive reply.
- **The recipient** receives `SERVICE_TRANSFER_RECEIVED`, enqueued in the transaction that
  commits the transfer, so a Telegram failure never undoes the transfer. It rides the
  ordinary dispatcher's retries.
  - Its subject is the transfer row. Its values are derived at send time from that row and
    the service: account name, location, remaining traffic and time.
  - It carries ONE inline button, `مشخصات سرویس`, whose callback is `s:<serviceId>`.
  - The button is derived from the subject by kind, never stored. So the lane still carries
    no payload (ADR-0030 §1). The tap goes through `getForCustomer` for whoever taps it.
  - The derivation is the Telegram surface's `notificationButtons`, handed to the
    dispatcher by the composition root: the callback vocabulary is the surface's, and the
    messaging application does not import it. The values are read through
    `ServiceTransferService.notificationFacts`. A transfer row or service that cannot be
    read sends nothing and marks the row FAILED, as a reminder with no subject does.
- **Precondition.** The notification is sent only while the recipient still owns the
  service. A service passed on again before the message left would otherwise announce
  something the recipient no longer has. `DrizzleNotificationSubjectReader` answers it from
  the transfer row joined to the service on `customer_id = to_customer_id`, and SUPERSEDES
  the row when that no longer holds.

## 8. Audit and events (F7)

- The audit row `service.transfer`: entity `Service`, before `{customerId: from}`, after
  `{customerId: to, transferId}`. The actor is the bot's `SYSTEM_JOB`, and the audit timestamp is its
  own.
- The event `ServiceOwnershipTransferred`.
- Neither carries the subscription URL, token or any file.

## 9. External and product gaps

- **The sender keeps the link.** This follows the brief's rule, not an oversight. Where the
  tenant offers it and the panel can rotate, the recipient's own `⚙️ تغییر لینک` (WP6-C)
  retires it, subject to the rotation cooldown.
- **No operator transfer.** Not asked for. `services.transfer` stays unserved, and the Web
  Admin sentence now says a customer transfers from the bot and the audit log carries it.

## 10. Rollback

The migration only widens what may be written:

- two foreign keys narrowed to two columns;
- two trigger functions behind three triggers: `nexa_services_ownership_guard` on the
  services INSERT and on an UPDATE of `tenant_id`, `order_id` or `customer_id`, and
  `nexa_commercial_action_owner_guard` on the commercial-action INSERT;
- a new table, with two append-only triggers;
- three re-pinned CHECK constraints (the notification kind, the capture purpose and the
  capture subject).

The previous release writes nothing that violates the new rules. A service transferred under
this release names a customer its order does not. The previous release reads that row
without complaint, because its three-column foreign key is gone. Restoring that key would
fail on such a row, and no rollback restores it.

Two things a rolled-back release does with rows this one wrote, both bounded:

- A `SERVICE_TRANSFER_RECEIVED` notification is a kind the older dispatcher cannot render,
  so it defers the row without spending an attempt (`docs/conventions.md`, "A widened enum
  is write-compatible, not reader-compatible").
- A `SERVICE_TRANSFER_RECIPIENT` window still open at the rollback falls through, in the
  older `capturedText`, to the `SERVICE_NOTE` branch: the next message the sender types in
  those ten minutes is saved as that service's note. Ownership is re-checked by the note's
  write, so it lands only on the sender's own service, and nothing else happens.
