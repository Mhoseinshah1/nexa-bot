# Phase 4H audit — what 4A–4G left the two surfaces owing

Written before any 4H code, against `main` at `953b555` (the Phase 4G merge). Every
claim here is a measurement quoted with the command that produced it, not a memory of
what the previous phases said they built. The 4G audit's own closing section records
why: the two worst defects of that phase were rules that were WRONG rather than
untested, and neither the suite nor the falsification pass could see them. An audit that
restates the previous phase's summary inherits its blind spots.

Phase 4H is **Final Telegram UX + Web Admin Operational Completion**. The owner's
standing exclusions apply: discounts, referral, cashback, affiliate, reseller and
promotions are Phase 7 and are not to be pulled forward.

---

## 1. The structural finding: there is one asynchronous customer message

```
$ grep -rno "'bot\.[a-z_.]*'" apps/api/src --include=*.ts \
    | grep -v "surfaces/telegram/bot-runtime" | sed 's/:[0-9]*:/ /' | sort -u
apps/api/src/modules/commerce/provisioning/application/delivery.service.ts 'bot.service.subscription'
```

One line. Every other customer-facing string in the product is produced inside
`bot-runtime.ts`, which is the **synchronous webhook turn** — a reply to something the
customer just did. The single exception is the subscription link, sent by
`DeliveryService` and driven by `ProvisionerLoop`'s tick.

That lane is not general. It is built for one message about one subject:

- its durable state is two columns on `services` (`delivery_state`, `delivery_attempts`),
- its `deliveryStateAfter` outcome table reasons about a subscription link specifically,
  including the rule that an UNKNOWN send is never retried automatically,
- its template key is a literal in the call.

So the product today can tell a customer exactly one thing they did not ask for. This is
wider than `OQ-4G-01` stated. That question is about a rejected or expired payment; the
same absence covers every asynchronous outcome in Phases 4D–4G.

**The boundary 4H must not break.** `ProvisionerLoop`'s constructor states it, and it is
a structural guarantee rather than a comment: the executor does not hold a messenger, so
a failed Telegram send _cannot_ reach the provisioning transaction. Any lane 4H builds
carries the same property, and the repository rule it serves is the non-negotiable
"no network call inside a database transaction".

## 2. Eleven frozen `bot.*` keys have no producer

```
$ for k in $(grep -o "key: 'bot\.[a-z_.]*'" packages/contracts/src/templates.ts | sed "s/key: '//;s/'//"); do
    [ "$(grep -rF "'$k'" apps/api/src --include=*.ts | wc -l)" -eq 0 ] && echo "$k"
  done
```

| Key                                                         | Classification                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `bot.discount.applied`, `bot.discount.rejected`             | **Phase 7.** Out of scope by owner decision                                           |
| `bot.referral.invite`, `bot.referral.unconfigured`          | **Phase 7.** Out of scope by owner decision                                           |
| `bot.trial.issued`, `bot.trial.unavailable`                 | Trials. No trial mechanism exists in any phase; not in the 4H roadmap                 |
| `bot.ping.reply`                                            | Phase 0 relic. `system.ping.v1` proved the outbox end to end and the flow was removed |
| `bot.order.cancelled`                                       | **In scope.** See §3                                                                  |
| `bot.payment.received_for_review`                           | **In scope.** See §4                                                                  |
| `bot.service.provisioning`, `bot.service.provision_delayed` | **In scope.** See §5                                                                  |

A frozen key with no producer is not itself a defect — the catalogue is a specification
and six of these name phases that have not happened. The four marked in scope are
different: they name sentences the product needs _now_, in flows that already exist.

## 3. `ORDER_MACHINE`'s CANCEL edge is writable and still has no caller

4G's audit established by measurement that `orders_cancelled_at_check` made CANCELLED
unwritable, and 4G fixed that by adding `cancelledAt` to the transition stamps. The edge
is now writable. Nothing writes it:

```
$ grep -rn "CANCELLED" apps/api/src/modules/commerce/orders/application/*.ts
ports.ts:145:   * is `(state = 'CANCELLED') = (cancelled_at IS NOT NULL)`, so the old signature could
ports.ts:146:   * name CANCELLED as its target and the statement would be refused every time.
```

Two comments about the constraint, and no caller. `bot.order.cancelled` is the message
that has nowhere to be sent from. This is the other half of `OQ-4G-02` — 4G's rejection
and withdrawal both deliberately leave the order open, and whether an operator may end
an order in one action is the unresolved part. A customer abandoning their own order is
a narrower question than that one and may be answerable without it.

## 4. A customer who pays by transfer cannot say they have paid

`bot.payment.manual_instructions` hands the customer a reference and bank details. After
that the flow is silent in both directions: there is no "I have sent it" signal from the
customer, and `bot.payment.received_for_review` — the sentence for exactly that moment —
has no producer. The operator learns of the transfer from their bank, not from the bot,
and the customer's only two buttons are the withdrawal pair 4G added.

`OQ-4C-03` is adjacent and must not be confused with it: owner revision 17 says receipt
review happens in Telegram, and 4C confirmed in the Web Admin because the frozen
contracts are web-admin-shaped (`confirmed_by_admin_id` references `admins.id`). That
question is about where the DECISION lives. This one is about whether the customer can
signal at all, which is a customer-side action and needs no admin identity.

**No receipt FILE is in scope.** Revision 17's other half — that no receipt is stored,
archived or displayed — is honoured in full today and 4H does not change it.

## 5. Nothing is said while a paid order is being provisioned, or when it stalls

`bot.service.provisioning` and `bot.service.provision_delayed` are the two sentences for
the window between settlement and the subscription link, and neither has a producer. A
customer who has paid sees `bot.order.settled` and then nothing until the link arrives.
When provisioning is _delayed_ — a panel unreachable, an operation held off at its
attempt ceiling, a service in `UNRECONCILED` — they see nothing at all, for as long as it
takes.

## 6. Four operation kinds complete asynchronously and tell the customer nothing

`PERFORMABLE_OPERATION_TYPES` in `provision-executor.ts` names nine:

```
PROVISION, RECONCILE, SYNC_USAGE, SUSPEND, RESUME, TERMINATE, RENEW, ADD_TRAFFIC, ADD_TIME
```

Of these, the customer initiates SUSPEND, RESUME and TERMINATE (4E) and RENEW,
ADD_TRAFFIC and ADD_TIME (4F) from My Services. Each tap answers synchronously with
`bot.service.action_requested` — "we have asked" — and the operation then completes or
fails on the provisioner's own schedule. Nothing tells the customer which happened.

For the three commercial actions this is money: the customer has paid for a renewal and
is told only that the request was recorded.

## 6b. A rate limit permanently withholds a paid customer's subscription link

Found while answering §11's design question, and it is a defect in merged code rather
than an absence. The chain is four links, each checkable by reading:

1. `infrastructure/telegram/send-message.ts:135` — a 429 returns `FAILED_RETRYABLE` with
   `errorCode: 'telegram.rate_limited'` and Telegram's own `retry_after` as `retryAfterMs`.
2. `messaging/infrastructure/telegram-customer-messenger.ts:181` —
   `const unknown = result.outcome === 'FAILED_RETRYABLE'`, so every retryable failure
   becomes `UNKNOWN`. The distinct code and the `retryAfterMs` are discarded.
3. `provisioning/application/delivery.service.ts:61` —
   `deliveryStateAfter('PENDING', 'UNKNOWN', n)` is `'UNCONFIRMED'`.
4. `provisioning/infrastructure/drizzle-service.repository.ts:451` — the due query claims
   `deliveryState = 'PENDING'` only, so `UNCONFIRMED` is never re-claimed.

So a single 429 parks a paid customer's subscription link out of the automatic lane until
a person notices — and a 429 is what Telegram sends precisely when many customers are
being served at once.

The classification is deliberate, not an oversight: `provisioning.ts:443` names the 429
explicitly among `UNCONFIRMED`'s causes. It is still wrong, and being listed beside three
genuinely ambiguous cases is how it survived. A timeout, a 5xx and an unreadable 2xx may
all have been delivered; a 429 is Telegram declining the request and telling us when to
return.

No committed test asserts either the current behaviour or the corrected one. ADR 0030 §2
decides the correction and 4H-2 implements it, with its regression test, for the lane and
for `DeliveryService` together so there is no second copy to drift.

## 7. The Web Admin has no Services surface at all

```
$ grep -o "^export const [A-Z_]*_ROUTES" packages/contracts/src/http.ts
HEALTH  AUTH  ADMIN  CONTROL  PANEL  CUSTOMER  PRODUCT
SERVICE_ADDON  ORDER  WALLET  PAYMENT  BACKUP  RECOVERY
```

There is no `SERVICE_ROUTES`. Meanwhile `permissions.ts` declares four:

```
p('services.view', 'View provisioned services', 'LOW'),
p('services.edit', 'Edit a service'),
p('services.terminate', 'Terminate a service', 'HIGH'),
p('services.transfer', 'Transfer a service to another customer', 'HIGH'),
```

and three seeded roles carry `services.view` and `services.edit`. Services have been real
rows since 4D. So an operator whose role says they may view and edit services has no
endpoint to call and no screen to call it from: `/services` renders `PlannedPage`.

This is the largest operational gap in the Web Admin and the clearest reading of
"operational completion". It is also the same defect class as Codex C5 on PR #29, where
`receipt_reviewer` could not open the payment its own name refers to — a permission the
product grants and the product cannot exercise.

`SERVICE_ADDON_ROUTES` exists (4F), which is worth noting: the add-on CATALOGUE is
administrable and the services those add-ons attach to are not.

## 8. The remaining planned Web Admin surfaces

`PLANNED_SURFACES` lists five: `services`, `discounts`, `resellers`, `reports`, `bots`.

| Surface     | Disposition for 4H                                                                                                                                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services`  | **In scope.** §7                                                                                                                                                                                                                                                                              |
| `discounts` | Phase 7. Stays planned                                                                                                                                                                                                                                                                        |
| `resellers` | Phase 7. Stays planned                                                                                                                                                                                                                                                                        |
| `reports`   | Not in the 4H roadmap. Needs a decision about metric timestamp basis that `docs/open-questions.md` still carries from the research (UNK-RSV2-006), and inventing one would be exactly the legacy defect where two surfaces computed revenue differently                                       |
| `bots`      | Open. `OQ-TG-01` records that an installation cannot change the bot it serves or recover a revoked token, and `OQ-TG-04` defers the bootstrap hardening by owner decision to 4I. A `/bots` surface would sit on top of decisions 4I is meant to take, so it follows 4I rather than leading it |

A promoted page must be REMOVED from `PLANNED_SURFACES` in the same commit:
`planned-and-absent.test.tsx` asserts the two lists agree, and a page left in the list
renders its placeholder instead of itself. `payments`, `products`, `orders` and `users`
are the precedents.

## 9. Telegram has four commands, no menu, and never says what it can do

```
$ grep -n "if (command === " apps/api/src/surfaces/telegram/bot-runtime.ts
449:  if (command === '/start') ...
450:  if (command === '/catalog') ...
451:  if (command === '/wallet') ...
452:  if (command === '/services') {
```

```
$ grep -rn "setMyCommands\|setChatMenuButton\|ReplyKeyboard" apps/api/src --include=*.ts
(no matches)
```

`/start` replies with plain text and no buttons. Its Persian says only «برای دیدن
سرویس‌ها دستور /catalog را بفرستید» — so a customer is never told that `/wallet` or
`/services` exist. An unrecognised message gets «این دستور شناخته نشد.» and nothing else.

Two of the four commands are therefore discoverable only by guessing. There is no
`setMyCommands` registration, so Telegram's own command menu is empty, and no persistent
keyboard.

## 10. What this phase must NOT do

- **No FSM.** `INCIDENT-FIN-001` is the legacy defect where a stateful prompt outlived
  its question and an ordinary message overwrote a production gateway setting. Everything
  the runtime needs is in the update it is handling; that is what makes a Telegram
  redelivery a replay rather than a step in a half-finished dialogue. A "received for
  review" signal (§4) is a BUTTON on the message that issued the reference, not a prompt
  waiting for the next thing the customer types.
- **No receipt upload, storage, archival or display.** Owner revision 17, honoured in
  full today, and asserted by existing tests.
- **No Phase 7.** Discounts, referral, cashback, affiliate, reseller, promotions.
- **No rendered text persisted.** A template body is stored raw and rendered nowhere near
  where it is edited.
- **No second notification lane beside the Phase 2 dispatcher's.** That one's destinations
  are operator channels and its `DELIVERY_OUTCOMES` enum is pinned by a CHECK constraint.
  A customer lane is a different audience with a different failure question, and 4G's
  backup rules already name what happens when one enum is made to serve two purposes.

## 11. The design question 4H has to answer first

`OQ-4G-01` names it: **what a failed send to a customer means.** The Phase 2 dispatcher
answers it for operator channels, `DeliveryService` answers it for one subscription link
with a three-outcome table and an explicit no-automatic-retry rule for UNKNOWN, and
neither answer transfers unexamined.

The specific sub-questions, to be settled with evidence before code:

1. A customer who has BLOCKED the bot. Telegram answers 403 forever; retrying is
   pointless and recording nothing is a silent loss.
2. Whether a message about a resolved payment is still worth sending an hour late, and
   what "expired" means for a notification.
3. Whether one customer's failing sends may hold up another's — the tenant-fairness
   question the panel monitor answered with a claim-and-budget model.
4. Whether the lane is a table or a reuse of the outbox. The outbox is already the
   inside-the-transaction mechanism and `processed_messages` is already the
   effectively-once one.

These are design questions with real evidence available in this repository, not business
policy, so 4H answers them rather than recording them.

---

## Summary: the 4H work list, as the audit establishes it

| #   | Item                                                            | Evidence            |
| --- | --------------------------------------------------------------- | ------------------- |
| 1   | A durable customer notification lane                            | §1, §11, `OQ-4G-01` |
| 2   | Payment rejected / expired reaches the customer                 | §1, `OQ-4G-01`      |
| 3   | Operation outcome reaches the customer (6 kinds)                | §6                  |
| 4   | Provisioning progress and delay reach the customer              | §5                  |
| 5   | A customer-side "I have sent the transfer" signal               | §4                  |
| 6   | A customer may cancel their own unpaid order                    | §3                  |
| 7   | Web Admin Services surface, end to end                          | §7                  |
| 8   | Telegram command discovery: menu, help, `setMyCommands`         | §9                  |
| 9   | A rate limit must not park a customer's message out of the lane | §6b, ADR 0030 §2    |

Items 2–4 are one mechanism applied three times; item 1 is that mechanism, and item 9 is
a correction that mechanism has to carry. Items 5, 6, 7 and 8 are independent and can
land in any order.

---

## What has landed, and where

Kept current as the phase proceeds, because a work list nobody ticks is a work list
that gets re-done or silently dropped. Each row names the commit's own subject line.

| #   | Item                                    | Landed in                                                                         |
| --- | --------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | The durable customer notification lane  | contracts / schema / repository / dispatcher — four commits, ADR 0030             |
| 2   | Payment rejected and expired reach them | «producers: a rejected or expired payment now reaches the customer»               |
| 3   | Operation outcome reaches them          | «producers: a customer learns how the thing they asked for turned out»            |
| 4   | Provisioning progress and delay         | «a customer who has paid is told what happens next, and when it stalls»           |
| 5   | The "I have sent the transfer" signal   | «a customer can say they have paid, and withdraw an order they have not»          |
| 6   | A customer may cancel their own order   | same commit as item 5                                                             |
| 7   | Web Admin Services surface              | **not yet**                                                                       |
| 8   | Telegram command discovery              | «telegram: the commands exist, so the client should offer them»                   |
| 9   | A rate limit must not park a message    | «lane: the dispatcher, its loop, and the 429 that used to strand a paid customer» |

Item 9's fix went in with the lane rather than after it, because the lane's own
`CustomerSendOutcome` is where `RATE_LIMITED` has to exist: adding it afterwards would
have meant two shapes of the same enum in one release.

Item 7 landed last, in three commits: the endpoint («services: the endpoint four
declared permissions have had no way to reach»), the correction its consumer exposed
(«services: the operator's list is ordered newest first, and the dead reads are gone»)
and the page itself («services: the Web Admin surface, and the placeholder it
replaces»).

Item 4 landed in two halves that are deliberately NOT the same mechanism. The progress
sentence is synchronous — the customer is right there, having just paid, so it is a
second message in the same turn rather than a queued one; a lane that sent it up to a
minute later could deliver "your service is being made" after the link had arrived. The
delay sentence goes through the lane, because by definition nobody is looking when it
becomes true.

## The self-review of the complete phase diff

One pass over `953b555..HEAD`, read against the invariants the phase is accountable
for rather than against the diff's own story. Four things it found, all of them in
work this branch had already called finished.

**A recorded owner decision that nothing in code obeyed.** The `/services` placeholder
has said since Phase 3D that services are ordered `created_at` descending — owner
revision 13 — and the repository paged ascending, copied from the three lists that
legitimately do. Promoting the page would have printed the sentence above a list whose
first page was the oldest service the installation ever sold. Fixed with the keyset,
the pager labels and a test that asserts the ROW ORDER rather than the copy; recorded
as F4H-24.

**Three authorized read methods with no callers.** `ProvisioningService.list`, `.get`
and `.operationsFor` were written in 4D and never wired to anything — which is how §7
above could measure a declared permission with no way to exercise it while three
readers of the same rows sat in that file. Removed, leaving `ServiceAdminService` as
the one implementation. `SERVICE_PAGE_MAX` was also declared twice with the same
literal and is now imported from the contract the HTTP layer validates against.

**A contract field the Web Admin never rendered, and the red suite that hid it.**
`customerSignalledAt` has been required by `paymentSummarySchema` since `7b934a5`, and
`payments.tsx` showed it nowhere — while `tests/web/payments.test.tsx` carried a
fixture without it, so all nineteen cases in that file failed the zod parse and the
branch head had a RED web suite no gate run in this session had reported. Both halves
fixed, recorded as F4H-25. The general lesson is narrow and worth keeping: a contracts
commit whose own tests live in another package can turn a suite red without any commit
in that package changing, and «the gate was green» is a claim about when it was last
run.

**A first falsification that survived.** F4H-25's original test asserted the column
HEADER and that not every cell was a dash, and survived a mutation replacing the
column's renderer with a constant — the header comes from the column definition, not
from the data. The rewritten case reads the body cell by index. Recorded in
`docs/phase4h-falsification.md` rather than quietly repaired, because a test that
survives its own mutation once is evidence about how the rest were written.

What the pass checked and found sound: every new write path authorizes before its
replay, reads `ScopeActivityReader` inside its own transaction, re-reads the subject
server-side and compares ownership against the row rather than against anything a
client sent; the three new Telegram callbacks carry an identifier and nothing else, no
amount and no state; the dispatcher holds no transaction across a send, and its three
durable writes are separate `uow.run` calls with the send between them; `UNKNOWN` is
never inferred into a success or a failure and is never retried automatically; and no
service response, on any of the three routes, carries a subscription URL, a
subscription ref or a provider client id — asserted against the RAW body, and again in
the page against a hostile fixture that volunteers all three.

Two things the pass deliberately did not change. `ORDER_PLACE_PERMISSION` is
`'maintenance.run'`, which is what a customer-initiated turn holds as `SYSTEM_JOB`; the
constant's NAME reads like a permission that does not exist, and renaming it is churn
across three services for no behavioural gain. `@Get('services/:id')` hardcodes its
path while the list uses `SERVICE_ROUTES.list` — the same split `payments.controller.ts`
and `orders.controller.ts` have, and the integration tests drive the route CONSTANTS
against the real app, so a divergence fails the suite rather than shipping.
