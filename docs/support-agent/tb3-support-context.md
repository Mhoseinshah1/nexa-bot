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
  model wrote. They hold **only the aliases that survived the byte budget**, so an alias
  the model was never shown resolves to nothing.

**Aliases are positional within one build.** `S2` in one build and `S2` in the next can name
different services: a new purchase, a state change or a different truncation all reorder
them. A consumer must therefore resolve an alias only through the `references` of the
**same** build that produced the payload the model read. Keep that build with the turn, and
never rebuild in order to resolve an alias.

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
| `knowledge[≤8]`   | `{ alias, source, question, answer }`: only entries the query matched (A8).                                                                                                                                                                                                              |
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

| Family           | Reader                                                                                                                                                                                                                                                                                                                                                 | Statements                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| customer         | `CustomerRepository.findById` (tenant in WHERE)                                                                                                                                                                                                                                                                                                        | 1                                                      |
| services         | `ProvisioningService.supportServicesForCustomer(scope, id, 10)`. It uses the same repository and the same tenant, customer and `notRefundedAway()` predicate as `pageForCustomer`. Every non-TERMINATED service comes before any TERMINATED one, newest first within each group. **Not** `listForCustomer`, which still shows a service refunded away. | 1                                                      |
| service card     | `SupportContextReader.serviceCardFacts`: one `unnest … WITH ORDINALITY` over the page's `(order, product)` pairs, for the order line's title (this customer's order only) and the product's `service_location_label`. This replaces N `purchaseTitle` and `displayFor` calls.                                                                          | 1                                                      |
| status           | `serviceDisplayStatus` (provisioning domain) and `ProvisioningService.isDeliverable` for `hasSubscriptionLink`. The same answers the service card draws.                                                                                                                                                                                               | 0                                                      |
| orders           | `SupportContextReader.recentOrders`: tenant, customer, not `DRAFT`, `(created_at, id)` DESC, limit 5 (`orders_customer_created_idx`).                                                                                                                                                                                                                  | 1                                                      |
| payments         | `SupportContextReader.recentPayments`: tenant, customer, DESC, limit 5, with `underReview` in SQL. A second `LIMIT 1` statement over the same predicate sets the flag across **all** of the customer's payments, and it stops at the first match.                                                                                                      | 2 (parallel)                                           |
| incidents        | `SupportContextReader.activeIncidentNotices`: ACTIVE, with a `customer_message`, matched by the notice audience's rule, limit 3.                                                                                                                                                                                                                       | 1                                                      |
| client apps      | `ClientAppRepository.list(ENABLED)`, filtered by `isClientAppRelevant` with facts from `ProvisionedServiceFacts.factsOf(services already read)`. That method is new, and `factsFor` now delegates to it. Rendered as the customer's detail screen renders.                                                                                             | 1 + 1 (panels) + panel-policy reads per (panel, state) |
| knowledge        | `SupportFaqRepository.list(ACTIVE)`, **not** `SupportScreenReader.screenFor`, which seeds on first read.                                                                                                                                                                                                                                               | 1                                                      |
| support accounts | `SettingsResolver.valueOf('support.accounts')`                                                                                                                                                                                                                                                                                                         | 1                                                      |

**Measured** (`support-context.test.ts`, "measures one full build"; local PostgreSQL 16,
warm pool). Statements are counted at `pool.query`.

- **After the PR #198 review** (five runs on 2026-10-05, run while `pnpm verify` was
  loading the machine):
  - A customer with 12 services, 7 payments and one incident took **12 statements** and
    **12.9–20.1 ms** wall time (median 14.2 ms). The payload was 6,603 bytes.
  - The statement count is unchanged. The services read lost its count statement (2 to 1),
    and the payments read gained its flag statement (1 to 2).
  - A public-only build took **3 statements** and **2.1–6.7 ms**.
- **Before the review** (2026-10-04): 12 statements; 11.6–28.8 ms (median about 14 ms); a
  public-only build took 3 statements and 1.9–6.0 ms.

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
   services in the payload. Those ten are non-TERMINATED services first, so newer
   terminated services cannot crowd a live or unreconciled one out (`OQ-TB-17`). This takes
   the reviewer's first option (live first) rather than only recording the gap. The
   ordering lives beside `pageForCustomer` in the same repository and reuses its
   `notRefundedAway()`, so no predicate is copied, and it also removes the count statement
   the context never used.
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

The budget is `SUPPORT_CONTEXT_MAX_BYTES` (24 KiB of UTF-8 JSON since A8, 2026-10-07; it was
16 KiB). When the payload is over
it, `fitPayload` drops **whole entries from the tail** of each family, family by family, in
`SUPPORT_CONTEXT_TRUNCATION_ORDER`:

```
clientApps → knowledge (down to its reserve) → orders → payments → services → incidents
→ the knowledge reserve
```

D2 (2026-10-06) changed this. Knowledge used to give way **first**, "retrievable again", but
nothing retrieved it: with six apps and twenty articles no article reached the model at all.
Now:

- **Relevance.** The knowledge entries are the `SUPPORT_CONTEXT_LIMITS.knowledge` most relevant
  of every approved article and live FAQ entry, ranked by a deterministic lexical score
  (`support-context/domain/knowledge-relevance.ts`) over the title (weight 3), tags (2) and body
  (1), each term weighted by its rarity among the candidates. The query is the customer's latest
  three messages (`latestCustomerWords`). Persian is folded first: Arabic `ي`/`ك`, ZWNJ and the
  zero-width joiners, diacritics, digits, a few verb prefixes and suffixes. No embedding service.
  Ties, and an empty query, keep the reader's order: approved articles newest first, then the
  FAQ. The candidates are read up to the per-tenant article bound (1000).
- **Client apps first.** They are long, and an app whose guide a SELECTED knowledge article
  already carries (a NEXA_BUILD `CLIENT_APP` article) is sent with an empty `guide`, so the same
  text is not counted twice.
- **A knowledge reserve.** In its turn knowledge is cut only down to
  `SUPPORT_CONTEXT_KNOWLEDGE_RESERVE_BYTES` (12 KiB of its own JSON since A8; it was 6 KiB), and
  never below its first, most relevant entry. The rest of it gives way only after every other family is empty.
- **Telemetry.** `support_ai_jobs.knowledge_sent` and `.knowledge_available` record, with the
  job's result, how many entries the request carried and how many there were to choose from
  (null when no provider was asked).

An incident affecting this customer gives way last among the account facts. The `customer`, the
`flags` and the `supportAccounts` are never cut, and flags are computed before any cut. Every
family can be emptied, so the result always fits. The worst case for 20 FAQs at the stored maxima
is about 90 KB of Persian, which is why the cut exists.

## A7 — the transcript beside the context (2026-10-07)

The payload above is the account; the transcript is the conversation, and it is read from the
rows each time — `business_messages` plus the delivered `business_outbound_messages`
(`readSupportTranscript`, `mergeTranscript`). No copy of it is stored anywhere.

- **60 read, 40 shown.** `SUPPORT_TRANSCRIPT_READ_LINES` is 60 (was 40) and the prompt shows the
  latest `SUPPORT_AI_TRANSCRIPT_MESSAGES` = 40 (was 20). Each line is still cut to 1,500
  characters, so the transcript is bounded by 40 × 1,500 characters plus NEXA's markers.
- **Who wrote each line.** Every line carries an `author` decided from the rows: `CUSTOMER`;
  `STAFF` (an operator's send, or an outgoing message not provably ours — the conservative rule);
  `AI_AUTO` (an automatic reply); `AI_ASSIST` (an AI draft a person reviewed and sent);
  `AUTOMATED` (Telegram's away message, another bot); `UNATTRIBUTED` (an echo of ours whose
  outbound row is outside the window). An echo takes the lane of the reply it is, so an automatic
  reply that Telegram echoed back before the lane wrote its id — classified `HUMAN` — is still
  the AI's. A customer's message is never relabelled.
- **Markers nobody can type.** Each support-side line opens with a square-bracketed marker
  (`SUPPORT_AI_AUTHOR_MARKERS`, e.g. `[support staff (a person) wrote]`,
  `[earlier automatic AI reply]`). Like the TB6 image markers they are written only by the server:
  every square bracket in a line's own text — ASCII, full-width, white, lenticular — becomes a
  parenthesis first, so a customer, a caption or a business message cannot forge "a person
  wrote this". Policy rule 13 explains the markers, forbids repeating a step an earlier line
  gave, forbids contradicting what a person said, and forbids writing a marker into a reply.

## A8 — knowledge retrieval with conversation memory (2026-10-07)

D2 chose knowledge by the customer's latest three messages. A customer five steps into a
connection problem who wrote «باز هم نشد» matched nothing, and the article the conversation was
about left the request just when it was needed. A8 keeps the lexical scorer (no embeddings, no
model, no I/O) and changes three things:

1. **A weighted query** (`support-ai/domain/knowledge-query.ts`, `knowledgeQueryFor`), every part
   decided by NEXA from rows, never by a model:

   | Part                        | Source                                                            | Weight |
   | --------------------------- | ----------------------------------------------------------------- | ------ |
   | the customer's latest words | the latest three customer messages with text                      | 1      |
   | the last intent             | the latest decided job's `intent`                                 | 0.6    |
   | the knowledge cited before  | the titles the latest two decided jobs cited (`knowledge_labels`) | 0.5    |
   | the troubleshooting episode | up to six earlier customer messages, while an episode is open     | 0.5    |
   | the last topic              | a fixed Persian vocabulary per safe topic (`TOPIC_QUERY_TERMS`)   | 0.4    |

   A "decided job" is an `ASSIST_DRAFT` or `AUTO_DECISION` row with a decision in `READY` or
   `SENT` — never `DISCARDED` (an operator's rejection, a superseded draft, a handed-off or
   dropped automatic job) or `FAILED`. `DrizzleSupportAiJobRepository.priorDecisions` reads at
   most three, tenant- and conversation-scoped, over `support_ai_jobs_conversation_idx`. The
   troubleshooting episode is **open** when the latest decided job gave a step or asked a
   question (`REPLY`, `ASK_CLARIFYING_QUESTION`) on a troubleshooting topic
   (`CONNECTION_TROUBLESHOOTING`, `APP_SETUP`, `SUBSCRIPTION_UPDATE`, `KNOWN_ERROR`). A term in two
   parts counts once, at the higher weight. At most `KNOWLEDGE_QUERY_MAX_TERMS` (64) distinct
   terms are scored, the highest-priority part's first, and each part is clipped, so scoring a
   thousand candidates is bounded whatever the transcript holds.

2. **A zero score is never sent.** An entry the query does not match at all is excluded from the
   top-k, so a greeting, an image with no caption or a question nothing answers carries no
   knowledge — the model is not handed eight unrelated articles to cite.
3. **At most eight entries** (`SUPPORT_CONTEXT_LIMITS.knowledge`, was 20) in a 24 KiB budget with
   a 12 KiB knowledge reserve (was 16 KiB and 6 KiB): about three full Persian articles survive
   any cut, instead of two of twenty.

Only `APPROVED` and enabled articles are candidates (`activeForContext`), with the `ACTIVE` FAQ;
that is unchanged. Policy rule 4b tells the model the entries are the few that match, most
relevant first, and that an entry that does not fit is never a reason to answer.

**Known gap.** An automatic decision does not record the titles it cited (`finishAuto` stores
`fact_refs` only; the knowledge aliases are positional per build), so the "knowledge cited
before" part reads Assist drafts only. An automatic decision still contributes its intent and
topic. Recording the titles belongs to the automatic reply's finish path (owned by the handoff
work) and is left as a follow-up.

A7/A8 tests: `tests/unit/support-ai-transcript.test.ts` (authors, markers, the window),
`tests/unit/support-knowledge-query.test.ts` (the weighted query, the episode, continuity, the
bounds, the source), `tests/unit/support-ai-prompt.test.ts` (rules 4b and 13, the policy digest)
and `tests/integration/support-assist.test.ts` (`priorDecisions` and the end-to-end repeated
failure). Mutation results are in `sai-memory-falsification.md` (20 of 20 killed).

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
- `tests/integration/support-context.test.ts` (19 tests, run on `nexa_test_tb3`):
  - the exact customer's own services, orders and payments, and not another customer's;
  - the same Telegram id in tenant B;
  - another tenant's customer id resolving to nobody;
  - each reader under the wrong tenant reading nothing;
  - a service refunded away being excluded;
  - `underReview` for `UNKNOWN` and for signalled `PENDING`, and not for plain `PENDING` or
    `CONFIRMED`;
  - the flag reading all payments;
  - null remaining traffic when unsynced;
  - the null-customer public payload, and that neither a public build nor a linked build
    performs any write;
  - a BLOCKED customer being flagged;
  - incidents (ACTIVE with a message only, title and description absent);
  - incident agreement with `noticePreview` over ten target shapes;
  - the measured build;
  - from the PR #198 review:
    - references hold only the aliases that survived a real byte-budget cut;
    - a panel-scoped incident reaches only the customer with a live service on that panel;
    - a TERMINATED-only customer is in neither the notice audience nor the context, across
      all ten target shapes;
    - the gateway facets of `underReview`: `PARTIAL` on `FAILED`, on `CONFIRMED` and with a
      refund row; `LATE_COMPLETION`; and `PENDING` with only a provider review;
    - the DRAFT exclusion;
    - client-app relevance for a Marzban customer;
    - `serviceCardFacts` reading only the customer's own order;
    - live services coming first.
  - The secrets seeded and asserted absent are the subscription URL and ref, the provider
    client id, the note, the payment reference and external reference, the phone, the
    Telegram id, the panel id and name, the service id, the customer id and the tenant id.

Mutation results are in `tb3-falsification.md`.

## Not done here

- No AI call and no prompt. TB4 and TB5 consume `payload`, and server-side tools consume
  `references`.
- No Web Admin preview of the context. That belongs to Assist Mode (TB5).
