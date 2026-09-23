# WP9-A — referral: audit and decisions

§9 of the execution plan covers resellers and referral, and says to keep them apart. They
ship as two packages. This one is referral. The reseller package follows in its own branch
and its own audit.

The design is decisions **F1–F12** below. Anything this document calls UNKNOWN is recorded
in `docs/open-questions.md` as `OQ-WP9-*`.

## 1. What exists before this package

| Thing                    | Where                       | State                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `referrals` table        | migration 0000, `schema.ts` | Created and never written. <br>• One row per referee: `referrals_referee_key` is unique on `(tenant_id, referee_id)`. <br>• `referrals_not_self_check` refuses self-referral. <br>• A composite FK to `customers` keeps both parties in one tenant. <br>• It has a `trigger` column, and a `reward_entry_id` / `rewarded_at` pair. |
| `REFERRAL_TRIGGERS`      | `promotions.ts`             | `ON_SIGNUP`, `ON_FIRST_PAID_ORDER`. Consumed only by the table's CHECK constraint.                                                                                                                                                                                                                                                 |
| `REFERRAL_REWARD_TYPES`  | `promotions.ts`             | `FIXED_AMOUNT`, `ORDER_PERCENTAGE`. Consumed by nothing.                                                                                                                                                                                                                                                                           |
| `referralCodeFor(id)`    | `promotions.ts`             | Eight characters of Crockford base32, derived from the last 64 bits of the customer's UUID. Nothing calls it.                                                                                                                                                                                                                      |
| `REFERRAL_REJECTIONS`    | `promotions.ts`             | `SELF_REFERRAL`, `ALREADY_ATTRIBUTED`, `CODE_UNKNOWN`, `REFERRER_BLOCKED`, `CIRCULAR`. Consumed by nothing.                                                                                                                                                                                                                        |
| Ledger reasons           | `ledger.ts`                 | `REFERRAL_COMMISSION`, `REFERRAL_COMMISSION_REVERSAL` (already listed as a reversal reason), `REFERRAL_SIGNUP_GIFT`.                                                                                                                                                                                                               |
| `ReferralRewarded` event | `events.ts`                 | Declared and never emitted.                                                                                                                                                                                                                                                                                                        |
| Templates                | `templates.ts`              | `bot.referral.invite` (`{referralCode}`) and `bot.referral.unconfigured`. Nothing renders them.                                                                                                                                                                                                                                    |
| `/start` payload         | `bot-runtime.ts` `intentOf` | Matched on the first token only. The payload is deliberately dropped: "4F's referral codes arrive that way".                                                                                                                                                                                                                       |

So the storage, the vocabulary and the code derivation were declared in Phase 0. Nothing
attributes, nothing pays, and nothing shows the customer a code.

### What the research establishes

These are MirzaBot's facts, used as evidence and not as specification:

- **Commission.** The referrer is paid a percentage of the referee's purchase, into their
  wallet (CBR-016, LGR-BR-070).
- **The legacy toggles:**
  - A "first purchase only" toggle and a "commission after purchase" toggle exist. Both were
    deliberately left unpressed, so their behaviour is UNKNOWN (UNK-BC-006, UNK-BC-017).
  - A minimum-purchase floor exists and is set to 0 on the audited installation (CBR-016).
- **Visible values.**
  - A 10% default rate is visible (UBR-007). It is a competitor's commercial number and is
    not copied.
  - A per-user rate override exists; its setter was not tested.
- **Attribution.** How a referral is attributed is not covered by the corpus. The binding is
  claimed to be permanent, INFERRED from bot text only (entities-relations.md). Whether an
  admin can override it is UNK-UM-006.
- **Refunds.** Reversal on refund is UNKNOWN: "No clawback message exists" (UNK-LGR-012).
- **Levels.** One level against several is not covered. The only model drawn is referrer
  0..1, referees 0..N.
- **Customer view.** The customer sees only a referral count, on `/wallet`.

## 2. Decisions

**F1 — Referral is its own subsystem.**

- It has its own tables and its own ledger reasons (`REFERRAL_COMMISSION`,
  `REFERRAL_COMMISSION_REVERSAL`).
- It shares nothing with cashback or reseller pricing except the pure proportional-reversal
  arithmetic, `cashbackTargetMinor`. That arithmetic is renamed to the neutral
  `proportionalTargetMinor` in the contracts commit, and the old name is kept as an alias.
- A commission is never a price step. It does not change what the referee pays.

**F2 — Attribution happens at registration, and only there.**

- A referral is recorded only on the update that CREATES the referee's customer row:
  `resolveFromUpdate` with `created: true`.
- It must be a `/start` whose payload is `ref-<CODE>`. It is written in the same
  transaction as the customer.
- A customer who already exists is never attributed, whatever link they follow later.

Why registration only:

- **It is the strongest reading of "immutable".** The schema already holds one row per
  referee. Registration-only means there is also no window in which an existing customer
  can be claimed by whoever sends them a link first.
- **It makes the referral graph acyclic by construction.** A referrer always existed before
  their referee, so `CIRCULAR` cannot occur.
- **It makes the lock order below well-founded.** Every transaction that holds two customers'
  wallet locks takes the referee's, then the older referrer's.
- **It is compatible with the plan's default.** That default is "attribution immutable once
  the first eligible paid order settles". Registration comes before any order, so this is
  strictly stronger. The plan also says to preserve registration-time locking where the
  repository already implies it, and the table's docblock ("concurrent `/start` commands
  carrying different codes") does.

**F3 — The code, and where it is resolved.**

- The customer's code is `referralCodeFor(customerId)`, the Phase 0 derivation.
- It is recorded in a new `referral_codes` table the first time the customer asks for it,
  with `(tenant_id, code)` unique and `(tenant_id, customer_id)` unique.
- Attribution resolves the code through that table, inside the tenant. A code from another
  tenant is therefore `CODE_UNKNOWN`, never a match.
- A derived code that collides with another customer's is refused with
  `REFERRAL_CODE_UNAVAILABLE`. It is never reassigned. At 40 bits this is a theoretical case,
  and it is handled rather than assumed away.

**F4 — The program is on only when a tenant turns it on and chooses a rate.**

- A new feature flag, `referrals`, is TENANT_WIDE and off by default.
- The program is ACTIVE only when the flag is on AND `referral.commission_percent` is set.
- While it is not active:
  - no attribution is recorded;
  - no commission is promised;
  - the customer's invite button answers `bot.referral.unconfigured`.
- Commissions and attributions that already exist are kept and still settle. Turning the
  program off withdraws the offer; it does not break a promise already made.

**F5 — The three settings.**

| Key                             | Values                                   | Default            | Meaning                                                                                         |
| ------------------------------- | ---------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| `referral.commission_percent`   | 1–100 or null                            | null               | Null is unconfigured. There is no default rate, because the research's 10% is not ours to copy. |
| `referral.commission_scope`     | `FIRST_PAID_ORDER` or `EVERY_PAID_ORDER` | `FIRST_PAID_ORDER` | The bounded payout is the conservative default.                                                 |
| `referral.minimum_order_amount` | an amount and currency, zero or more     | 0 IRT              | Zero means no floor. See the note below.                                                        |

- **The scope is snapshotted onto the attribution**, in the existing `trigger` column, as
  `ON_FIRST_PAID_ORDER` or the new `ON_EVERY_PAID_ORDER`. It governs that referee for life.
  So a later change to the setting affects only people referred afterwards.
- **The percent and the floor are read at each commercial action.** They affect only orders
  confirmed afterwards.
- **The floor.** `open-questions.md` O-9 says the floor should be "on by default", but no
  evidence gives an amount, so the default is zero, the legacy installation's own floor
  (CBR-016). A floor in a currency the order is not in earns nothing rather than being
  converted (OQ-WP9-02).
- **`ON_SIGNUP` stays declared and is never produced.** A signup reward is a credit for a
  button click, which §9.7 forbids ("Do not credit commission on draft/button click").
  `REFERRAL_SIGNUP_GIFT` stays reserved.

**F6 — A commission is promised at confirmation.**
It is written by the one confirmation hook both order paths share, `PricingService.redeem`,
as an `order_referral_commissions` row in `PENDING`. The same conditions are checked again
inside the transaction. A promise is written only when all of these hold:

- the program is active (F4);
- the order is not `TRIAL`, so a trial never earns anyone anything;
- the order total is positive and at least the floor;
- the referee has an attribution;
- the referrer is not `BLOCKED`.

The row snapshots:

- the referrer and the referral;
- the percent and the scope;
- the basis (the order total);
- the amount, `floor(total × percent / 100)`, and its currency.

A promise that rounds to zero is not written. A wallet top-up is not an order, so it is
never a basis.

**F7 — Earned at delivery, exactly once.**

- **Where it is decided.** The same lane as cashback:
  - `settleDue` runs on the provisioner tick.
  - "Delivered" means an operation of `PURCHASED_AS[purpose]` has `SUCCEEDED`.
  - "Ended" means the order is `CANCELLED`, `EXPIRED` or `REFUNDED`, and ends the promise
    as `VOID`.
- **The credit.** Earning credits the REFERRER's wallet with `REFERRAL_COMMISSION`,
  reference `${orderId}:referral`, under the referrer's wallet lock.
- **Exactly once.** Three guards, each sufficient: the conditional `PENDING → EARNED`
  update, the unique ledger reference, and the lock.
- **The amount.** The earned amount is the promise less what completed refunds have already
  given back, by the same proportional formula as cashback.
- **First-order scope** is decided HERE, under the referrer's lock. If the referral already
  has an `EARNED` commission, the new one is `VOID`. One referral therefore pays at most once
  under that scope, however many orders are in flight at the same moment.
- **A reversed first commission still counts as the first.** It stays `EARNED` with its
  reversal beside it, so a later order is not promised again. "First paid order" is the
  first one that earned, not the first one that stayed paid. Otherwise every refund would
  hand the referrer another chance at the commission.
- **A referrer blocked after confirmation still earns.** The block governs what the referrer
  may do, not what the ledger owes them. The fail-closed check is at confirmation, when the
  promise is made.

**F8 — Reversed by refunds.**

- When a refund of the referee's order reaches `COMPLETED`, inside the refund's own
  transaction, the referrer's commission is reduced to its proportional target.
- The difference is debited as `REFERRAL_COMMISSION_REVERSAL`, referenced
  `${refundId}:referral-reversal`.
- What the referrer's balance cannot cover is recorded as `unrecovered`, never collected, and
  never taken below zero. This mirrors cashback (OQ-WP8-05).
- There is one reversal row per refund, so a replay takes nothing twice.
- **The state is judged only after the referrer's lock.** That is the WP8-16 lesson: a
  `PENDING` read taken without the lock can be an earner mid-credit.

**F9 — Lock order.**
A refund's transaction takes, in order:

1. its payment or refund lock;
2. the referee's wallet lock, for the refund credit and the cashback reversal;
3. the referrer's wallet lock.

The earner takes only the referrer's lock. Under F2 a referrer is always older than their
referee, so no transaction takes an older customer's lock before a newer one's, and no cycle
exists.

**F10 — No administrative writes.**

- The plan says to "prevent arbitrary reassignment". UNK-UM-006's fallback, an audited
  override, is a feature nobody asked for, and an override is a write that changes who is
  owed money.
- This package ships READ surfaces only: attributions, commissions and their reversals.
- A future override is its own decision (OQ-WP9-01).

**F11 — Refused attributions are audited, not dropped.**

- A `/start ref-…` that does not produce an attribution is recorded as a `referral.attribute`
  audit row, `result: 'DENIED'`, with the reason.
- The possible reasons are `CODE_UNKNOWN`, `REFERRER_BLOCKED`, `ALREADY_REGISTERED` (new) and
  `PROGRAM_INACTIVE` (new).
- `SELF_REFERRAL` and `ALREADY_ATTRIBUTED` are named in the code as well but cannot occur.
  Only a customer created in the same transaction is attributed, and nobody holds a code for
  an id that did not exist yet. They are kept so that a refusal is named, never a constraint
  violation.
- The customer is never told. The greeting is the same either way, so the bot is not an
  oracle for which codes exist.

**F12 — The surfaces.**

- **Telegram.** `/wallet` gains an invite button when the program is active.
  - The button (`rf:`) answers `bot.referral.invite` with three values: the deep link
    `https://t.me/<bot>?start=ref-<CODE>`, the code, and the number of people the customer
    has referred. That count is the one figure the legacy bot showed.
  - It answers `bot.referral.unconfigured` when the program is not active.
  - No main-menu or slash-command change is needed: the menu is a routing contract and
    `/wallet` is where the legacy bot put this.
- **HTTP.** These routes need the new `referrals.view` permission:
  - `GET /referrals` for attributions;
  - `GET /referral-commissions` for commissions, each with its frozen scope and the totals
    its reversals took back and could not recover;
  - `GET /users/:id/referral` for one customer's referrer, their own code (null until they
    first open their invite), how many they referred, and totals per currency. It sits under
    `/users` like every other per-customer route. The referees themselves are paged on
    `/referrals?referrerId=`.
- **Web Admin.** A Referrals page with attributions and the commission ledger, and a
  referral card on the customer detail page. The program itself is configured on the
  existing features and settings pages.

## 3. What is not in this package

- **The reseller half of §9.** Tiers, pricing inheritance, entitlements, the credit line and
  purchase snapshots come in the next package.
- **Multi-level commission.** The plan's default is single-level only.
- **A signup gift**, for F5's reason.
- **A per-referrer rate override** (UBR-007's `🧮 پورسانت اختصاصی`). It is a per-customer
  commercial number with no evidence of how it is used (OQ-WP9-03).
- **A customer notification when a commission is earned.** Cashback has none either. A
  notification that names an amount would need the parameterised payload ADR-0030 refuses.
