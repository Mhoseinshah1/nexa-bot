# TB3 — the support context

**Status: implemented.** Program: Intelligent Support Agent. Decided by ADR-0034 §4 and
ADR-0035. Builds on TB2 (`tb2-conversations.md`): the customer id comes from
`business_conversations.customer_id`. No AI code is in this package.

## What TB3 delivers

`SupportContextBuilder.build(scope: TenantContext, customerId: string | null)`
(`apps/api/src/modules/commerce/support-context/application/support-context.builder.ts`,
wired as `container.supportContext`) returns:

- `payload`: the shape declared in `packages/contracts/src/support-context.ts`, parsed by
  its strict schema before it is returned, so a key outside the allowlist fails the build;
- `references`: the alias to row-id maps (`S1` to a service id, and so on). They stay on the
  server. A later server-side tool resolves an alias through them and never through text a
  model wrote.

It is **read-only and deterministic**. It writes nothing, and its answer depends only on the
rows and the `Clock`. The integration test pins that `support_faq_seeds`, `audit_logs` and
`outbox_messages` are unchanged by a build.

### Payload

| Field             | Contents                                                                                                                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generatedAt`     | The `Clock`'s now, so the model can judge an expiry.                                                                                                                                                                                                                                     |
| `customer`        | `status`, `username`, `firstName`, `languageCode`, `lastSeenAt`, or null.                                                                                                                                                                                                                |
| `services[≤10]`   | `alias` S1.., `label` (provider username), `productTitle`, `locationLabel`, `state`, `displayStatus`, `isTrial`, `expiresAt`, `trafficLimitBytes` ("0" = unlimited), `trafficUsedBytes`, `remainingTrafficBytes`, `usageSyncedAt`, `deviceLimit`, `hasSubscriptionLink`, `unreconciled`. |
| `orders[≤5]`      | `alias` O1.., `state`, `purpose`, `title`, `total` {amountMinor, currency}, `createdAt`, `settledAt`, `expiresAt`.                                                                                                                                                                       |
| `payments[≤5]`    | `alias` P1.., `amount`, `method`, `routeLabelKey`, `state`, `underReview`, `createdAt`, `confirmedAt`.                                                                                                                                                                                   |
| `clientApps[≤6]`  | `platform`, `name`, `description`, `guide` (rendered, at most 1500 chars), `helpUrl`, `officialUrl`.                                                                                                                                                                                     |
| `incidents[≤3]`   | `customerMessage`, `startedAt`, `scheduledEndAt`.                                                                                                                                                                                                                                        |
| `knowledge[≤20]`  | `{ source: 'FAQ', question, answer }`.                                                                                                                                                                                                                                                   |
| `supportAccounts` | The `support.accounts` setting.                                                                                                                                                                                                                                                          |
| `flags`           | `hasUnderReviewPayment`, `hasUnreconciledService`, `identityLinked`, `customerBlocked`.                                                                                                                                                                                                  |

Money and byte counts are decimal strings, and instants are ISO strings. The payload is
JSON-safe with no bigint.

**Never included** (absent from the strict schema, and asserted absent from
`JSON.stringify(payload)` in both suites):

- the subscription URL and reference;
- the panel name and id;
- provider client and user ids;
- raw service, order and payment ids;
- a payment's reference, external reference and notes;
- the ledger and the wallet balance;
- the phone number, Telegram id, last name and block reason;
- an incident's title and description;
- the service's `customerNote`.

### Where each family comes from

Every read is customer-scoped, with **no permission** ("the scoping is the
authorisation", as for `ProvisioningService.pageForCustomer`). The agent acts as
`SYSTEM_JOB`, which holds only `maintenance.run`. Borrowing an operator service would be
the actor-type bypass this codebase refuses.

| Family           | Reader                                                                                                                                                                                                                                                                        | Statements                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| customer         | `CustomerRepository.findById` (tenant in WHERE)                                                                                                                                                                                                                               | 1                                                      |
| services         | `ProvisioningService.pageForCustomer(scope, id, 1)`: tenant, customer, `notRefundedAway()`, newest first, page of 10. **Not** `listForCustomer`, which still shows a service refunded away.                                                                                   | 2 (count + page)                                       |
| service card     | `SupportContextReader.serviceCardFacts`: one `unnest … WITH ORDINALITY` over the page's `(order, product)` pairs, for the order line's title (this customer's order only) and the product's `service_location_label`. This replaces N `purchaseTitle` and `displayFor` calls. | 1                                                      |
| status           | `serviceDisplayStatus` (provisioning domain) and `ProvisioningService.isDeliverable` for `hasSubscriptionLink`. The same answers the service card draws.                                                                                                                      | 0                                                      |
| orders           | `SupportContextReader.recentOrders`: tenant, customer, not `DRAFT`, `(created_at, id)` DESC, limit 5 (`orders_customer_created_idx`).                                                                                                                                         | 1                                                      |
| payments         | `SupportContextReader.recentPayments`: tenant, customer, DESC, limit 5, with `underReview` in SQL and `bool_or(underReview) OVER ()` over **all** of the customer's payments.                                                                                                 | 1                                                      |
| incidents        | `SupportContextReader.activeIncidentNotices`: ACTIVE, with a `customer_message`, matched by the notice audience's rule, limit 3.                                                                                                                                              | 1                                                      |
| client apps      | `ClientAppRepository.list(ENABLED)`, filtered by `isClientAppRelevant` with facts from `ProvisionedServiceFacts.factsOf(services already read)`. That method is new, and `factsFor` now delegates to it. Rendered as the customer's detail screen renders.                    | 1 + 1 (panels) + panel-policy reads per (panel, state) |
| knowledge        | `SupportFaqRepository.list(ACTIVE)`, **not** `SupportScreenReader.screenFor`, which seeds on first read.                                                                                                                                                                      | 1                                                      |
| support accounts | `SettingsResolver.valueOf('support.accounts')`                                                                                                                                                                                                                                | 1                                                      |

**Measured** (`support-context.test.ts`, "measures one full build"; local PostgreSQL 16,
warm pool, five runs on 2026-10-04, four of them also timing the public build). Statements are counted at `pool.query`.

- A customer with 12 services, 7 payments and one incident took **12 statements** and
  **11.6–28.8 ms** wall time (median about 14 ms). The payload was 6,603 bytes.
- A public-only build (`customerId` null) took **3 statements** and **1.9–6.0 ms**.

The test records these numbers and asserts none of them.

## Under review

`underReviewCondition()` in the reader is built **only** from the Payment Operations
Center's `paymentOpsQueueCondition`. It is never a second calculation. A payment is under
review when it is in any of these:

- the `UNKNOWN` queue;
- the `PENDING` queue **and** either `customer_signalled_at` or `provider_review_started_at`
  is set. A pending payment nobody has acted on is just unpaid.
- the `PARTIAL` or `LATE_COMPLETION` queue, on a payment that is **not** `CONFIRMED` and
  **not** in `REFUND_RELATED`. Money arrived that settled nothing, and no refund has been
  started for it.

The facet choice is `OQ-TB-12`. `NEEDS_RECONCILIATION` and `MISMATCH` are subsets of
`UNKNOWN` while they are open. `PROVIDER_ERROR` alone is not a sign that money moved.

## Incident matching

`activeIncidentNotices` mirrors `DrizzleIncidentRepository.audience`'s service match for one
customer and every ACTIVE incident at once. The customer matches when they have a live
(`ACTIVE`/`SUSPENDED`) service on one of these:

- a panel the incident names;
- the panel of a location it names;
- a product it names.

An incident naming no panel, no **resolvable** location and no product reaches every
customer with a live service. That is how `audience` treats empty `panels` and `products`
lists, including a gateway-only incident and a location id that no longer resolves.

Delivery reachability (customer ACTIVE, an active bot) is the notice lane's question. It is
deliberately not mirrored.

The test "incident matching agrees with the notice audience" runs ten target shapes. For
each one it compares the reader against the real `IncidentService.noticePreview`, so the
two rules cannot drift silently.

## Decisions made in this package

1. **Knowledge is the ACTIVE FAQ until TB8** adds approved articles (ADR-0035 §1). The
   builder never seeds. A tenant whose FAQ was never opened has no rows, so it has no
   knowledge (`OQ-TB-15`).
2. **The wallet balance is excluded by default** (ADR-0034 §4 excludes the ledger, and a
   balance is a ledger projection) (`OQ-TB-11`).
3. **DRAFT orders are excluded.** A draft is a quote nobody confirmed (`OQ-TB-13`).
4. **SCHEDULED incidents are excluded.** Only ACTIVE incidents are read (`OQ-TB-14`).
5. **An unlinked peer gets public support only.** `customerId` null, or an id this tenant
   does not have (for example another tenant's customer), gives `customer: null` and no
   account family. No incident is included either, because incidents reach a customer
   through their services. `identityLinked` is false. The unit test pins that no account
   reader is even called.
6. **A BLOCKED customer still gets context**, flagged `customerBlocked`. Whether to answer
   is the AI policy's decision (TB5, `tb0-audit.md` §3.6).
7. **`remainingTrafficBytes` is null when usage was never synced or the allowance is
   unlimited.** An unread usage is unknown, never zero. It is clamped at zero when used up.
8. **`hasUnderReviewPayment` covers all payments.** `hasUnreconciledService` covers the 10
   services in the payload (`OQ-TB-17`).
9. **The service's `customerNote` is excluded.** It is free text the customer wrote,
   addressed to themselves. Customer- and operator-authored strings that **are** included
   (`firstName`, `username`, titles, FAQ, app text, incident message) are untrusted input
   to the model. TB5's guards decide how they are framed (`OQ-TB-16`).
10. **Client apps follow the operator's order** (platform first). The first six relevant
    entries are kept (`OQ-TB-18`).
11. **Every string is clipped to its schema bound**, and a cut never splits a surrogate
    pair. A row written outside the product's own validation therefore cannot fail the
    build.

## Byte budget and truncation

The budget is `SUPPORT_CONTEXT_MAX_BYTES` (16 KiB of UTF-8 JSON). When the payload is over
it, `fitPayload` drops **whole entries from the tail** of each family, family by family, in
`SUPPORT_CONTEXT_TRUNCATION_ORDER`:

```
knowledge → clientApps → orders → payments → services → incidents
```

Public knowledge and app guides give way first. They are long and can be retrieved again.
An incident affecting this customer gives way last. The `customer`, the `flags` and the
`supportAccounts` are never cut, and flags are computed before any cut. Every family can be
emptied, so the result always fits. The worst case for 20 FAQs at the stored maxima is about
90 KB of Persian, which is why the cut exists.

## Tests

- `tests/unit/support-context-payload.test.ts` (32 tests):
  - the allowlist snapshot, which lists every key path and fails when a key appears that is
    not in the list;
  - 19 forbidden keys rejected by the strict schema;
  - numeric money and fractional bytes rejected;
  - family limits;
  - display statuses equal to the provisioning domain's;
  - aliases, remaining traffic and `clip`;
  - truncation order and tail-dropping;
  - the builder over fakes: alias to reference mapping, no secret or id in the JSON, null
    customer reading no account reader, and the BLOCKED flag.
- `tests/integration/support-context.test.ts` (12 tests, run on `nexa_test_tb3`):
  - the exact customer's own services, orders and payments, and not another customer's;
  - the same Telegram id in tenant B;
  - another tenant's customer id resolving to nobody;
  - each reader under the wrong tenant reading nothing;
  - a service refunded away being excluded;
  - `underReview` for `UNKNOWN` and for signalled `PENDING`, and not for plain `PENDING` or
    `CONFIRMED`;
  - the flag reading all payments;
  - null remaining traffic when unsynced;
  - the null-customer public payload, and that the build performs no writes;
  - a BLOCKED customer being flagged;
  - incidents (ACTIVE with a message only, title and description absent);
  - incident agreement with `noticePreview` over ten target shapes;
  - the measured build.
  - The secrets seeded and asserted absent are the subscription URL and ref, the provider
    client id, the note, the payment reference and external reference, the phone, the
    Telegram id, the panel id and name, the service id, the customer id and the tenant id.

Mutation results are in `tb3-falsification.md`.

## Not done here

- No AI call and no prompt. TB4 and TB5 consume `payload`, and server-side tools consume
  `references`.
- No Web Admin preview of the context. That belongs to Assist Mode (TB5).
