# Work Package 3 — what service management already is

Written before any code, the way WP1 and WP2 were. Every row below was read out
of the tree at `fd1a2db` — the `main` that carries WP2 — and nothing here is a
plan dressed up as a finding.

## The short version

**Service management is the most built of the three, and the least reachable.**
Phases 4D through 4F gave it a provisioning lane, seven operator actions, an
operation history and two providers; 6A gave it a Web Admin screen and a
Telegram queue; WP2 has just given it a card on the customer's detail page. What
none of that gave it is a way to find ONE service from what a customer actually
says.

A customer writes: _"my account nx-7f3a91 stopped working."_ Every surface in
this product can operate that service and none of them can find it. The
`providerUsername` is not a filter on `ServiceSearch`, not a field on any
search form, and not an argument to any command. The two ways in are the
internal UUID — which exists nowhere outside the Web Admin's own URLs — and the
customer, if the operator can work out which customer that is.

That is the same shape WP2 found in the other direction, and it is this
package's centre.

## The fifteen

| #   | What                                             | State                                                                                      | Verdict |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------- |
| S01 | `ServiceAdminService.list/get/detail/operations` | real, charges `services.view`, clamps its limit, keyset-paged descending                   | KEEP    |
| S02 | the seven operator actions and their verdicts    | one evaluator, blocker codes, all seven routed and drawn                                   | KEEP    |
| S03 | Web Admin `/services` list                       | filters state, deliveryState, customerId, panelId — and NOT the provider username          | WORK    |
| S04 | Web Admin service detail                         | withholds `subscriptionUrl`, `subscriptionRef` and `providerClientId` structurally         | KEEP    |
| S05 | the customer's services card on `/users/:id`     | shipped in WP2, paged, permission-gated                                                    | KEEP    |
| S06 | Telegram admin services section                  | a QUEUE of ten — `UNRECONCILED` plus failed delivery — with `nextCursor` dropped           | WORK    |
| S07 | Telegram admin service detail                    | renders the customer as a raw UUID: `customer: service.customerId`                         | WORK    |
| S08 | Telegram `/service <id>`                         | exact lookup by the INTERNAL uuid, which no support conversation ever contains             | WORK    |
| S09 | Telegram customer "My Services"                  | paged, own-services only, redelivery and the three commercial actions                      | KEEP    |
| S10 | operation history                                | newest first, bounded at 50, unpaged — and the bound is stated in words but never measured | WORK    |
| S11 | `services.transfer`                              | declared, HIGH risk, seeded to nothing, charged by nothing, rule undecided                 | RECORD  |
| S12 | the two-tap terminate confirmation               | the destructive callback is produced only by the confirmation screen                       | KEEP    |
| S13 | capability gating                                | an action needs the adapter method AND the declaration; unproven means refused             | KEEP    |
| S14 | `UNKNOWN` outcomes                               | never retried, never refunded, service goes to `UNRECONCILED` and a READ decides           | KEEP    |
| S15 | `PURCHASED_AS`                                   | an operation carries its `order_id`, so only an operation matching the purchase may refund | KEEP    |

## The four that become work

### 1. A service can be found by the name its customer quotes (S03, S08)

`ServiceSearch` gains `providerUsername`, and it is an **EXACT** match, not a
prefix. Two reasons, and the second is the one that decides it:

- The username is canonicalised to lowercase by the reservation system, so exact
  equality is well defined without a functional index.
- A prefix match over account names is an enumeration of a panel's accounts.
  `CustomerSearch.telegramUserId` is exact for precisely this reason and says so;
  `usernamePrefix` is a prefix because a _Telegram_ username is half-remembered,
  and a provider username is not — it is generated or chosen, and it is quoted
  whole.

`services_panel_provider_username_key` is `(panel_id, provider_username)` and
cannot serve a tenant-scoped lookup, so this needs a forward migration adding
`(tenant_id, provider_username)`. The plan test that explains the statement gets
a row for it, the way `customers-plan.test.ts` does.

Surfaces: a field on the Web Admin filter bar, and `/service` accepting the
username as well as the uuid — one command, because an operator holding one of
the two should not have to know which command it belongs to.

### 2. The Telegram admin service screen says who the customer is (S07)

It renders `service.customerId`, a UUID. WP2 has just built a customer detail
screen reachable at `9:v:<uuid>`, so the screen can name the customer the way an
operator recognises them and offer a button to it. It carries no wallet balance
and no order — the WP2 rule about what a forwardable message may hold applies
unchanged.

### 3. The Telegram section can browse, not only queue (S06)

`adminServices` is a queue of the ten things needing attention and drops its
cursor deliberately — that stays, because the eleventh unreconciled service is
not a thing an operator scrolls to. What is missing is the other half: a
**browsable, paged** list, the way the customers section pages, so a service
that is perfectly healthy is reachable from a phone at all.

### 4. The operation bound is measured, not asserted (S10)

`web.service_operations_hint` says the list is not paged and that "a service with
dozens of operations is itself the problem". The first half is true; the second
is an opinion that a service renewing monthly for two years will falsify, and
neither half tells an operator whether they are looking at all of them. The
bound is 50. It should be printed the way the administrator roster prints
`shown of total` — a truncated list that reads like a complete one is the defect
WP1 named.

## The one that is recorded and not built

**`services.transfer` is declared, HIGH risk, and charged by nothing.** That is
the same shape as `users.edit` in WP2, and the resolution is different, because
the reason is different.

`users.edit` is not charged because the product has an answer: every customer
attribute comes from Telegram and is overwritten on the next update, so an
operator edit would look like a correction and silently not be one.

`services.transfer` is not charged because the product has **no** answer.
`web.services_transfer_absent` states it: the order, the payment, and the link
the previous owner already holds are all unsettled. Transferring a service moves
something somebody PAID for, and the previous owner's subscription URL is a
bearer capability that a transfer does not revoke. Deciding any of that here
would be resolving an UNKNOWN by guessing, which `docs/research/` forbids, and
it would be doing it with money.

So this package adds the comment beside the permission saying so — the way WP2
did for `users.edit` — and builds nothing. If the owner wants transfer, the rule
comes first.

## Out of scope, stated

Phase 7 — discounts, referral, cashback, affiliate, resellers, promotions —
remains unbuilt and untouched. Nothing below turns into a reason to start it.

Real-panel acceptance is the owner's to run. Nothing in this package changes a
provider rule, so `pnpm test:acceptance` has nothing new to prove; if that
changes during implementation it is recorded as an evidence gap, never as a
passed test.
