# Phase 4F audit — commercial actions

What Phase 4E left, checked against the code and against a running Marzban rather than
remembered, before any of this phase is written.

4E's headline was that the vocabulary for service management was frozen and almost none
of it had an implementation. This one is different in kind. The three operations this
phase owes — `RENEW`, `ADD_TRAFFIC`, `ADD_TIME` — are frozen in the same way, but the
gap under them is not an adapter method. It is that **every one of them needs money, and
the money path in this repository is hard-wired to produce a NEW service.**

## What already exists

| Thing                                                                      | Where                                                  | State                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `OPERATION_TYPES` `RENEW`, `ADD_TRAFFIC`, `ADD_TIME`                       | `packages/contracts/src/provisioning.ts`               | **Frozen, none executed**                                                    |
| `OPERATION_REQUIRED_CAPABILITIES` → `RENEW_USER`, `ADD_VOLUME`, `ADD_TIME` | same                                                   | Frozen and complete                                                          |
| `SERVICE_MACHINE` edge `EXPIRED → ACTIVE on RENEW`                         | same                                                   | **Frozen, no caller.** The only `RENEW` edge in the machine                  |
| `PROVIDER_CAPABILITIES` `RENEW_USER`, `ADD_VOLUME`, `ADD_TIME`             | `packages/contracts/src/provider.ts`                   | Frozen; **declared by neither descriptor**                                   |
| `LEDGER_REASONS` `CASHBACK_RENEWAL`                                        | `packages/contracts/src/ledger.ts`                     | Frozen; Phase 7, **out of scope tonight**                                    |
| `METRIC_BASES` `RENEWED_AT`                                                | `packages/contracts/src/metrics.ts`                    | Frozen; Phase 8, no producer                                                 |
| `OPERATION_LEGAL_FROM.RENEW / ADD_TRAFFIC / ADD_TIME`                      | `.../provisioning/application/provision-executor.ts`   | Present and **deliberately empty**, so the state check refuses them too      |
| `PERFORMABLE_OPERATION_TYPES`                                              | same                                                   | Six members; the three commercial types are absent, and the docblock says so |
| Order → payment → settlement core                                          | `.../payments/application/payment.service.ts`          | Implemented for `WALLET` and `MANUAL_TRANSFER`, tested                       |
| `ProvisioningService.requestFromCustomer`                                  | `.../provisioning/application/provisioning.service.ts` | The 4E pattern for a customer-initiated operation. **Takes no money**        |
| Telegram My Services list/detail/resend/suspend/resume/terminate           | `apps/api/src/surfaces/telegram/bot-runtime.ts`        | Implemented; six service callback prefixes in use                            |

## The five absences, and what each costs

### 1. A settled order always creates a service

`PaymentService.confirmAndSettle` ends with an unconditional
`provisioning.planForSettledOrder(...)`. Every order that settles writes a `services`
row and a `PROVISION` operation. There is no discriminator anywhere on `orders` saying
what the order is FOR.

So a renewal modelled as "another order against the same product" — which is exactly
what `services.order_id`'s own docblock says a renewal is — would settle, and then
provision a **second provider account** that the customer did not buy and would be
billed for once while occupying twice. `services_tenant_order_key` does not stop it: it
is unique on `(tenant_id, order_id)`, and a renewal has its own new order id.

This is the single most dangerous edit in the phase, and it is the same shape as 4E's:
a path that does one thing unconditionally, being given a second kind of input.

### 2. There is no price for any of the three actions

`products` carries exactly one `(price_amount, price_currency)`, one `duration_days` and
one `traffic_bytes`. There is no renewal price, no traffic package, no time package, and
no setting in `SETTINGS_REGISTRY` that could hold one — the eleven registered keys are
notifications, `sales.currency`, `support.accounts`, `telegram.channels`,
`sales.order_expiry_minutes`, `provisioning.usage_sync_minutes` and
`wallet.topup.minimum`.

`ADD_TRAFFIC` and `ADD_TIME` therefore have **no configurable source of a price at all**.
Implementing them means introducing that configuration; until an operator has configured
one the action must be explicitly unavailable, never free and never guessed.

### 3. An operation row cannot say what it intends to do

`provisioning_operations` records `type`, `service_id`, `order_id`, `panel_id`, the claim,
the attempt count and the failure. It has **no column for a desired target.** A `SUSPEND`
needs none — the type is the whole intent. `RENEW`, `ADD_TRAFFIC` and `ADD_TIME` each
carry a quantity, and a quantity that lives only in the process that planned the call
cannot survive the crash the retry lane exists for.

### 4. `PriceQuote` has no step that describes any of this

`PRICING_STEPS` is `BASE_PRICE`, `TIER_PRICE`, `PANEL_ADJUSTMENT`,
`CUSTOM_SERVICE_FORMULA`, `USER_OVERRIDE`, `PROMOTIONAL_DISCOUNT`. A renewal quoted from
a product's current list price is a `BASE_PRICE`; an add-on priced from its own
configured row is not any of them. A quote's `trace` is mandatory and non-empty, so this
is a real contract question and not a formatting one.

### 5. No refusal vocabulary for an ineligible commercial action

`COMMERCE_ERROR_CODES` has `SERVICE_NOT_FOUND`, `SERVICE_UNRECONCILED`,
`SERVICE_NOT_DELIVERABLE`, `PANEL_NOT_OPERABLE`, `PRODUCT_NOT_PRICED`,
`PRODUCT_NOT_PURCHASABLE`. It has nothing for "this service cannot be renewed", and
`requestFromCustomer` currently answers an illegal state with `ORDER_STATE_INVALID` —
a code named for orders, on a path that has no order.

## What a real Marzban actually does, measured

Read out of `app/routers/user.py` and `app/db/crud.py` at the pinned commit
`7f396db3e703d71a28060bc9ce4a532ec64cb1f4`, then **run** against a panel built from it.
`scripts/marzban-allowance-check.sh` is that measurement, committed rather than
described, and the nine rows below are its own output. It drives the panel with plain
`curl` and shares no code with the adapter — the adapter is written FROM this table and
must not be the thing that produces it.

| #   | What was done                                                  | What the panel did                                                           |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | `PUT {"expire": <epoch>}`, then the identical PUT again        | Set **absolutely**; the replay is `200` and changes nothing                  |
| 2   | `PUT {"data_limit": <bytes>}`, then the identical PUT again    | Set **absolutely**; the replay is `200` and changes nothing                  |
| 3   | `PUT {"note": "x"}`                                            | `expire` and `data_limit` unchanged — an omitted key is no change            |
| 4   | Raise `data_limit` on a `limited` account                      | `limited` → `active`, and `used_traffic` is **kept** (1 GB used, 3 GB limit) |
| 5   | Extend `expire` **alone** on a `limited` account               | Stays `limited`. More time does not revive an exhausted account              |
| 6   | Extend `expire` and raise `data_limit` on a `disabled` account | Stays `disabled` through both. Neither field re-enables it                   |
| 7   | Send `expire` **and** `data_limit` to a `limited` account      | `limited` → `active`, allowance raised, `used_traffic` kept                  |
| 8   | `PUT {"expire": 0, "data_limit": 0}`                           | Both become SQL NULL — `0` means unlimited, as on create                     |
| 9   | `PUT` against an absent username                               | `404`                                                                        |

Rows 4, 5 and 7 start from a `limited` account, which Marzban only enters from its own
background job on its own schedule. The script reaches that starting state by writing
`used_traffic` and `status` into the panel's SQLite file, and then measures the panel's
own response to an ordinary API call from there. The write is the fixture; the HTTP
exchange is the measurement. `NEXA_ACCEPTANCE_MARZBAN_DB` has no default and the script
refuses without it, because a panel whose database this may be written to is by
definition the disposable one.

Five consequences, and each one decides a rule:

- **Both fields are absolute, so a commercial mutation expressed as an absolute target is
  idempotent on the wire** (rows 1, 2). That is the same property `SUSPEND`, `RESUME` and
  `TERMINATE` have, measured the same way — which is what would let these three join
  `IDEMPOTENT_MUTATIONS` rather than route an uncertain outcome into an `UNKNOWN` that
  `RECONCILE` cannot resolve, the dead end the Phase 4E Codex round found and removed.
  A `+N` increment has exactly the opposite property and must not be used.
- **Raising the limit keeps consumption** (rows 4, 7). "Add traffic" is a larger total,
  never a cleared counter. `POST /api/user/{username}/reset` exists and is deliberately
  not used: replayed after the customer has consumed more, it would destroy real evidence.
- **Neither field re-enables a `disabled` account** (row 6). A commercial action on a
  SUSPENDED service tops up an allowance and does not resume it, so nothing may report the
  service as ACTIVE afterwards.
- **Time alone does not revive a `limited` account** (row 5), and **both fields together
  do** (row 7). A renewal that buys a period and an allowance has to send both, in one
  call, or the customer pays and stays cut off.
- **An omitted key is no change** (row 3), so a single PUT can carry exactly the fields an
  action bought and nothing else. `ADD_TIME` need not restate a limit it did not buy.

## 3X-UI

Out of scope for all three operations, by the owner's standing decision. `ADD_VOLUME`,
`ADD_TIME` and `RENEW_USER` stay absent from the Sanaei descriptor, no adapter method is
added, and `decideOperability` refuses each of the three against a 3X-UI-backed service
with `CAPABILITY_UNSUPPORTED` **before any network call** — the same refusal that already
covers `SUSPEND`, `RESUME` and `TERMINATE` there. That refusal needs a test, because it
is the only thing standing between the owner's decision and a half-implemented mutation.

## What this phase must NOT do

- No discounts, referral, cashback, affiliate, reseller or promotion engine. `CASHBACK_RENEWAL`
  stays a frozen word with no producer.
- No `ROTATE_SUBSCRIPTION`: no adapter method, no product decision.
- No second wallet and no second payment system. 4C's settlement core is the only one.
- No Web Admin commercial screens beyond what 4H owns.
- No `POST /api/user/{username}/reset` anywhere.

## What the legacy system did, from the research corpus

`docs/research/` is evidence of observed behaviour, not a specification. Five findings
change a decision in this phase and one of them contradicts itself.

- **A renewal is priced from the ordinary catalogue.** `TBR-008` — one entry point with
  two paths: a "renew the current plan" shortcut **at the identical price**, or the full
  category/product picker, so a renewal may become an upgrade. There is no renewal price
  table. `SBR-013` adds a per-product 3-way gate — purchase-only / renewal-only / both —
  and `SBR-011` that withdrawing a product from sale does **not** stop renewals of
  services already bought from it. All `VERIFIED_BY_TELEGRAM`.
- **Add-on prices are configured PER PANEL.** `PBR-009` — `قیمت حجم اضافه` and
  `قیمت زمان اضافه` are two independent free-text pricing fields, each scoped
  "برای این پنل". Not global, not per product. `VERIFIED_BY_TELEGRAM`.
- **Extra volume is bounded by the service's existing expiry and does not extend it.**
  `TBR-009`, `VERIFIED_BY_TELEGRAM`, on a sample priced to the Toman: 5 GB at a flat
  4,500 T/GB. The quantity is free text.
- **Extra time has no captured price point at all.** `TBR-015` groups it with extra
  volume as one pricing mechanism, but only the volume rate was ever confirmed. Its
  configuration field exists (`PBR-009`); its rate is **not evidenced**. The two must not
  be generalised from one another.
- **A renewal produces a new financial record and no new service.** The 8-invoices /
  1-service observation is `INFERRED` from a single account, but it is corroborated
  structurally twice: `LGR-REC-004` — the purchase, service-purchase and test log topics
  are disjoint and "orders exclude renewals, add-ons and tests"; and the Web Admin's
  `/invoice/service`, an **append-only ancillary ledger with seven operation types**,
  separate from `/invoice/` (`WEB-BR-022` names three: `add_volume_miniapp`,
  `add_time_miniapp`, `extend_user_miniapp`). That is the shape this phase should follow.

And the one that does not resolve:

- **Whether a renewal resets consumed traffic is a five-valued per-panel enum in the
  legacy system, and nobody knows which value this deployment uses.** `PBR-003`: the
  panel setting `روش تمدید سرویس` defaults on a new panel to `ریست حجم و زمان` — reset
  volume and time. `XUI-BR-014`: 3X-UI offers the same five mutually-exclusive
  strategies, so the behaviour is not provider-specific. But `TBR-012`: the bot's own
  `/support` FAQ states that unused **days** stack on renewal — an account renewed five
  days early gets 5 + 30. Both are `VERIFIED_BY_UI`/`VERIFIED_BY_TELEGRAM` and they point
  opposite ways; they reconcile only if the live panel is set to one of the four
  non-default carry-over methods, which `UNK-XUI-006` says nobody could read off the
  screen. The five strategy names were never captured.

  **So there is no single legacy behaviour to copy.** This is a configuration variable,
  and treating it as one settled answer would be exactly the guess `docs/research/README.md`
  forbids.

## One architectural fact that overrides a legacy shape

The legacy add-on flows take a **free-text quantity** — a GB count, a day count — typed
into a conversational prompt. This bot has no FSM and no conversation state, by a rule
with an incident behind it: the legacy prompt capture swallowed an ordinary message and
overwrote a production gateway setting (`INCIDENT-FIN-001`). A callback may carry an
intent and an identifier and never a quantity.

A free-entry quantity is therefore not available to this surface, and the alternative is
not a smaller version of it: the purchasable quantities have to be **configured rows the
customer selects by id**, so that the amount, the unit and the price are all server-side
and the callback names a row rather than a number. That is a departure from what the
legacy system does, made deliberately, and it is why an add-on needs its own configured
catalogue rather than a price-per-unit field.

## Open product questions this phase raises

Recorded in `docs/open-questions.md` rather than answered here.

- **OQ-4F-01** — what a renewal does to an allowance the customer has not spent, and to
  consumption already recorded. The legacy answer is a five-valued per-panel enum whose
  live value is unknown, and its two documented candidates contradict each other.
- **OQ-4F-02** — whether a renewal's period runs from now or from the old expiry when the
  service has not yet expired, and what happens inside the legacy three-day post-expiry
  grace window (`LGR-BR-032`). Absent from the corpus in both directions.
- **OQ-4F-03** — where a renewal's price comes from when the originating product has been
  withdrawn, re-priced or re-specified since the purchase. `SBR-011` says withdrawal must
  not block renewal; it does not say what the renewal then costs.
- **OQ-4F-04** — the deferred legacy renewal configuration: `SBR-003`'s
  remaining-volume eligibility threshold and `SBR-013`'s purchase-only / renewal-only /
  both product gate. Neither is implemented in this phase.
