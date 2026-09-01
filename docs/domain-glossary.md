# Domain glossary

The vocabulary, and the boundaries that must not blur. Where the legacy system
conflates two concepts, the conflation is named with its evidence, because the
conflation is the thing to avoid.

Terms marked **UNRESOLVED** have open questions in `docs/open-questions.md`.
Terms marked _(not yet modelled)_ are named here so that the first phase to need
them starts from the right word, not so that an empty class exists today.

---

## Tenancy

**Tenant** — a commercial boundary. Owns catalog, customers, settings and one or
more bot instances. `PRIMARY` or `RESELLER_BOT`; a reseller sales bot is a
tenant with a parent. `STOPPED` is not `DELETED`: a stopped tenant keeps its data
and its history.

**BotInstance** — a Telegram bot: a username, a status and an
envelope-encrypted token. **A BotInstance is not a Tenant.** One tenant may own
several.

> The legacy web admin has a real per-bot selector and an `Admin.bot` column,
> while its Telegram surface shows no scope column anywhere. Whether admins,
> texts and settings are per-bot or deployment-wide is flagged unknown in four
> separate investigation phases (UNK-ADM-004, UNK-BC-003, UNK-TXT-009,
> UNK-GS-010). Ours answers it once, structurally.

**ScopeContext** — either a `TenantContext` or an explicit `SystemContext` with a
stated reason. Never a null tenant.

---

## People

**Customer** _(not yet modelled)_ — an end user of a bot instance.

**CustomerTier** _(not yet modelled)_ — a customer's pricing and visibility
band. In the legacy system: `f` (normal), `n` (reseller), `n2` (advanced
reseller).

**AdminRole** — a composition of permissions, seeded as presets, tenant-scoped
and editable. **AdminRole is not CustomerTier.** They are independent axes: a
customer's tier says what they may buy and at what price; an admin's role says
what they may operate.

> These are already separate in the legacy database and blind to each other,
> which is correct. What is wrong there is that tier is a single enum reused by
> product visibility, pricing, discount scoping, cashback and mass tools — "one
> enum, four subsystems" — and that role is a bare string with no Role entity,
> no overrides, no status, and no update path at all: demotion means delete and
> recreate. There are also four role names in one surface and seven in the
> other, for the same column.

**Permission** — a global, frozen `resource.action[.qualifier]` key. Deny by
default; DENY overrides always win.

**Actor** — who is acting: `CUSTOMER`, `TELEGRAM_ADMIN`, `WEB_ADMIN`,
`SYSTEM_JOB`, `API`, `PROVIDER_SYNC`. Every write path carries one, jobs
included.

---

## Commerce

**Product** _(not yet modelled)_ — something offered for sale.

**Order** _(not yet modelled)_ — a commercial transaction: a purchase, a
renewal, or an add-on. Carries immutable item snapshots and a price quote.

**Service** _(not yet modelled)_ — a provisioned subscription on a provider
panel, with its own lifecycle.

> **Order is not Service.** An order is a commercial fact; a service is an
> operational one. Renewals and add-ons create orders and do not create
> services, and a paid order may have no service at all. On one observed
> account: 8 paid invoices, 1 purchased service. The legacy checkout screen also
> assigns a username and creates a backing record _before_ payment, which is how
> "unpaid" and "provisioned" become indistinguishable.

**OrderItemSnapshot** _(not yet modelled)_ — the product name, panel, duration,
volume, tier, unit price and full price trace, copied at order time. Historical
reporting reads snapshots, never catalog rows.

**PriceQuote** — the output of the one pricing engine: a final amount, a
currency, and a **mandatory** trace naming the rule that fired at each step.
Snapshotted onto the order and never recomputed. **UNRESOLVED**: the step
precedence is our design decision, pending sign-off — the legacy system has no
precedence to reproduce.

---

## Money — five separate concepts

The legacy system blurs all five. Keeping them apart is a structural
requirement, not a preference.

**Payment** _(not yet modelled)_ — an attempt to settle an amount through a
method: gateway, wallet, receipt, or a mix. Has its own lifecycle and its own
idempotency.

> The legacy system surfaces no payment entity, no payment list, no payment
> detail and no status enum anywhere. A payment _count_ exists (gateways gate on
> it) but no payment _record_ is reachable.

**Wallet** _(not yet modelled)_ — a customer's stored value, held as an
append-only ledger of entries. Balance is derived and cached, never
authoritative.

**Receipt** _(not yet modelled)_ — proof of a card-to-card transfer, submitted
for review. **A receipt is not a payment.** It is evidence offered toward one.

> The legacy menu says رسید (receipt) and the response says پرداخت (payment) for
> the same record, and whether the reviewed row is a receipt attached to a
> payment or a payment in an unverified state is explicitly unestablished
> (PRBR-004).

**Refund** _(not yet modelled)_ — returning value for an order, with its own
lifecycle and its own approval.

> In the legacy system refund is not an entity at all. The only refund-shaped
> verb appears in a log string attached to _deleting a service_ — a money
> outcome as a side effect of a provisioning action.

**Cashback** _(not yet modelled)_ — a promotional credit. Three distinct
sources: gateway, wallet top-up, renewal.

> The legacy system distinguishes these by which settings screen configures
> them, not by type, and all three end as an opaque balance bump. **UNRESOLVED**:
> whether they stack.

**Money** — `bigint` minor units plus an explicit currency.
**RateSnapshot** _(not yet modelled)_ — the immutable FX or crypto rate a
converted amount was derived from. Required only for converted amounts.

---

## Fulfilment

**Provider** _(not yet modelled)_ — a panel type: Marzban, 3X-UI, manual sale,
and a dozen others.

**ProviderAdapter** — one interface, with capabilities **declared** as data.
Capabilities are never inferred from a version string, and nothing outside the
adapter registry branches on provider type.

> The differences are of kind, not degree. 3X-UI carries a single opaque token
> where Marzban has a username and password, and needs a separately configured
> subscription-link domain because its sub URL is not derived from the panel
> address. A manual-sale provider has no backend at all.

**Panel** _(not yet modelled)_ — a configured instance of a provider. In the
legacy vocabulary a "location" **is** a panel, not a city.

**ServiceDelivery** — what the customer receives: a subscription link, raw
configs, a config file, or credentials. Provider-specific, so the adapter returns
a typed object rather than a link string.

---

## Observability

**DomainEvent** — a state change, written to the outbox in the business
transaction. Named `AggregatePastTense`, versioned by payload.

**AuditLog** — who changed what, with before and after **values**, a machine
action code, and the result including denials. Append-only.

**OperationalEvent** — what the system did: a code, a severity, a dedupe key, an
occurrence counter, and an explicit recovery event when the condition clears.

**Notification** _(not yet modelled)_ — an intent to inform someone, separate
from the attempts to deliver it.

**Metric** — a registry entry: one name, one formula, one filter set, one
interval semantic, one timestamp basis.

> The legacy reporting defects are definition failures, not query failures.
> "Sales" excludes renewals and add-ons — a 38% understatement against the same
> system's own revenue figure. "Buyer" means two different things inside one
> feature: 56,792 on one card, 27,732 across the group report. No metric states
> which timestamp it filters on. **UNRESOLVED** for every metric we port.
