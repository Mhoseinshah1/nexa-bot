# Phase 5 audit — what the payment core actually is on `58ec7ca`

Written before any Phase 5 code, against the merged tree the directive names
(`origin/main` = `58ec7ca3b9ef615ce21ae52ac10a74b2350aaa1b`, `v0.2.1`, deployed to
staging). Its job is to say what exists, what does not, and which of the missing
things this branch may build from evidence rather than from invention.

Subphase scope in this file is **5A** in detail and 5B–5F only far enough to say
what blocks them. Each later subphase gets its own section as it is reached.

---

## 1. What a manual transfer is today

`PaymentService.requestManualTransfer` creates a `PENDING` row on `payments` with
`method = 'MANUAL_TRANSFER'`, a generated `reference`, the order's frozen total, and
an `expires_at` that is the earlier of the order's own deadline and
`sales.payment_window_minutes`. It is idempotent by request hash, it re-issues an
existing live pending payment rather than creating a second one, and it closes a
stale pending payment through the same conditional UPDATE the sweep uses.

That part is sound. **What the customer is then told is not.**

`bot-runtime.ts:manualPayment` answers with `bot.payment.manual_instructions`, whose
Persian body is:

> برای پرداخت مبلغ {total} طبق راهنمای فروشنده اقدام کنید و سپس دکمهٔ «پرداخت را
> انجام دادم» را بزنید.\nکد پیگیری این پرداخت: {reference}

«طبق راهنمای فروشنده» — _follow the seller's instructions_. There are no seller's
instructions. The template's own description in `templates.ts` says so outright:

> The instructions themselves are tenant copy — this installation ships no bank
> details and invents none.

So the only way an operator can put a card number in front of a customer today is to
**override this template body** through the Templates surface and type the digits
into the message. That is the exact shape of the legacy defect this codebase was
built to end, and it fails in four distinct ways:

| Failure                                              | Why                                                                                                                                                                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A card number is history-bearing data stored as copy | Editing the template rewrites what _every already-issued_ payment instruction says, including ones a customer transferred against yesterday. The message in the chat is frozen; the truth behind it is not. |
| There is no second account                           | One template body is one destination. A tenant with two cards, or one card that gets blocked on a Friday, has nowhere to put the second.                                                                    |
| Nothing validates it                                 | A transposed digit is copy. It renders, it sends, and the money goes to whoever owns that card.                                                                                                             |
| The operator's workflow is wrong                     | Changing a card number should not require opening a message editor and re-typing a Persian sentence around it. `docs/phase4c-audit.md` §7 already lists "Payment settings" as unbuilt.                      |

**`payments` carries no destination at all** — not a column, not a reference, not a
snapshot. The full column list is in `schema.ts` and the nearest thing to a
destination is `external_reference`, which is documented as the _gateway's_ id and is
unused in this release.

## 2. What else is missing, measured rather than asserted

| Capability                            | State on `58ec7ca`                                                                                                                                                                         | Evidence                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Structured bank/card accounts         | **Absent.** No table, no service, no route, no screen.                                                                                                                                     | `grep -rn 'bank' packages/contracts/src/settings.ts` → one prose mention in an unrelated docblock |
| Payment destination snapshot          | **Absent.**                                                                                                                                                                                | `payments` has no destination column                                                              |
| Customer wallet top-up                | **Absent.** `wallet.topup.minimum` is in the registry with **no consumer**, deliberately — `docs/phase4c-audit.md` §6 records the decision and the correction that followed it             | `settings.ts:414`                                                                                 |
| Gateway configuration                 | **Absent.** `GATEWAY` is a frozen `PAYMENT_METHOD` member with no adapter, no row and no button; `PAYMENT_METHOD_UNAVAILABLE` is what a customer gets                                      | `payment.ts`, `bot-runtime.ts:paymentButtons`                                                     |
| Gateway callback / verify / reconcile | **Absent.** `PAYMENT_MACHINE` declares `LOSE_TRACK`, `RECONCILE_CONFIRMED` and `RECONCILE_FAILED`; none has a producer                                                                     | `OQ-4G-04`                                                                                        |
| `UNKNOWN` payments                    | **Unreachable.** No path writes the state, so `payments_unknown_idx` — the reconciliation queue — is a partial index over an empty set                                                     | `OQ-4G-04`                                                                                        |
| Refunds                               | **Absent as an entity.** `refunds.view` and `refunds.issue` are seeded permissions with no surface; `PURCHASE_REVERSAL`, `REFUND`, `CHARGEBACK` are frozen ledger reasons with no producer | `OQ-4C-02`                                                                                        |

Note the shape all six share: the **vocabulary is already frozen and the producer is
missing**. Phase 5 is largely a phase of giving existing contract members their first
producer, which is the cheapest kind of work this codebase admits — and the kind
`scripts/check-boundaries.sh` is built to police, since it fails a declared error code
that nothing throws.

## 3. What the research corpus does and does not establish about bank details

Searched: every file under `docs/research/` for `sheba`, `iban`, `card number`,
`card_number`, `شبا`, `کارت به کارت`.

**Established.**

- `کارت به کارت` exists in the legacy system as one of eleven _gateways_, and it is
  **disabled** in the inspected installation (`FBR-004`).
- Every gateway shares an eight-control base schema — name, cashback, tutorial, min
  amount, max amount, and three history/age gating controls — "differing only in
  gateway-specific credential/endpoint fields" (`FBR-009`).
- The card-to-card schema has **sixteen** controls, so eight are specific to it. The
  three the corpus names are the auto-approval trio (`FBR-007`) and the per-gateway
  amount limits (`FBR-008`).
- `📚 تنظیم آموزش کارت به کارت` — _set the card-to-card tutorial_ — is a free-text
  setting, and it is the field `INCIDENT-FIN-001` overwrote in production by typing a
  navigation string into a captured prompt.

**Not established.** The remaining card-to-card controls were never captured: the
distilled corpus carries `MASTER.md`, `business-rules.md` and `incidents.md` for this
bundle, and `payment-gateways.md` — which would hold the per-gateway field list — is
not among them. So the corpus does **not** tell us whether the legacy system stored a
card number as a structured field or only inside the tutorial text.

**Consequence for 5A.** `docs/research/README.md`'s rule applies: `NOT_EXPOSED` means
"the UI did not show it", never "it does not exist", and an `UNKNOWN` is never resolved
by guessing. So the field list below is derived from **what an Iranian card-to-card
transfer actually requires**, not from a claim about MirzaBot, and this file says which
is which. The directive permits exactly that: _"If the research corpus establishes
additional bank/payment metadata, use it. If not evidenced and not required for current
UX, leave it out."_

One thing the corpus _does_ decide for us, and it is the most useful finding here:
**the tutorial-as-free-text field is the mechanism that INCIDENT-FIN-001 corrupted.**
5A's whole point is that a payment destination must stop being free text.

## 4. 5A design decisions, and why each is the narrowest one

### 4.1 Two tables, not columns on `payments`

`payment_accounts` is the tenant's mutable configuration. `payment_destinations` is
the immutable snapshot, one row per payment, primary-keyed by `payment_id`.

Columns on `payments` were the first idea and are wrong for a reason the schema
already argues elsewhere: a CHECK binding a destination to
`method = 'MANUAL_TRANSFER'` cannot be an equality, because **every manual-transfer
payment issued before this migration has no destination** and an implication is the
"two columns that can disagree" shape `payments_confirmed_check` exists to refuse. A
separate table states the same fact without a constraint that has to lie: a payment
issued before 5A simply has no snapshot row, and the renderer falls back to the
existing template for exactly those.

The snapshot table gets the append-only guard `audit_logs` uses — no UPDATE, no
DELETE. A destination that could be edited after issuance is the defect this
subphase exists to remove, one layer down.

### 4.2 Fields

`label`, `bank_name`, `holder_name`, `card_number`, `iban`, `enabled`, `sort_order`,
`is_default`, plus the timestamps. `account_number` is **not** included: the directive
allows it "only if product requirements support it", an Iranian card-to-card transfer
is performed against the card number or the Sheba and never the account number, and no
evidence asks for it.

`iban` is the only optional customer-facing field. Everything else is required, which
is what makes the rendered instruction always complete.

### 4.3 Validation is structural, and says so

- Card number: Persian and Arabic-Indic digits normalised to ASCII, separators
  stripped, then **exactly 16 digits and a passing Luhn check**.
- Sheba: normalised to `IR` + 24 digits, then the **ISO 13616 mod-97 check**.

Both are _structural_: they prove the string is well-formed, never that the account
exists or that the holder name matches it. The code says that where somebody might
read it as a guarantee.

### 4.4 Accounts are disabled, never deleted

This is the answer to the directive's "old payment snapshot survives account
disable/**delete** policy": there is no delete. It keeps the snapshot's
`account_id` provenance honest, it matches `customers`' own "a block is not a
deletion" rule, and disable + edit covers every reason an operator would reach for
delete. Recorded here because it is a product decision, not an omission.

### 4.5 One deterministic destination

Selection for a new payment is: the enabled account marked default; failing that, the
enabled account with the lowest `(sort_order, created_at, id)`. At most one default
per tenant is a **partial unique index**, not a service rule, so two operators racing
to set different defaults produce one default and one conflict rather than two
defaults. A default must be enabled — also a CHECK — because "disabled accounts cannot
be newly selected" must not be defeated by an account that was default when it was
disabled.

With **no** enabled account the manual-transfer request is refused with a named code,
and the Telegram button is not drawn. `paymentButtons` is a pure function today and
becomes one that is told whether a destination exists. No dead payment button.

### 4.6 Rendering: one instruction body, four line keys

`renderTemplateBody` leaves a declared-but-absent token as the literal `{token}`, so
an optional `{sheba}` placeholder inside the instruction body would put the string
`{sheba}` in front of a customer whose tenant configured no Sheba. The destination is
therefore composed as a single `{destination}` value from four small template keys —
`bot.payment.destination.bank`, `.holder`, `.card`, `.sheba` — and a line whose field
is absent is simply not composed. Each key stays tenant-overridable through the
existing Templates surface, and the instruction body keeps one editable form.

Composition happens in **infrastructure**, behind a port the surface is handed, for
the reason `check-boundaries.sh` enforces: a surface sends a template key, and the
catalogue is resolved behind the application layer. This is the `MainMenuRoutes`
shape from 4J-5, one aggregate over.

The instruction stays `PLAIN_TEXT`. `TELEGRAM_HTML` would give `<code>` tap-to-copy on
the card number, and it cannot be used here: the composed `{destination}` is
interpolated as a VALUE, and values are HTML-escaped, so the tags would reach the
customer as `&lt;code&gt;`. Card and Sheba are rendered as unseparated digit runs,
which is what pastes correctly into a banking app.

### 4.7 Permissions

Two new keys, `payments.accounts.view` (LOW) and `payments.accounts.edit` (CRITICAL),
rather than reusing `settings.edit`. Reuse would mean only the owner can change a card
number, because `settings.edit` is owner-only and the `finance` role has neither
settings key — and a finance operator unable to change the destination money arrives
at is the permission catalogue promising something the seeded role cannot do, which is
the defect migration `0055` exists to repair.

They are backfilled into existing seeded roles by a hand-written migration, following
`0011`, `0031` and `0055`, and safely for the reason `0011` states: a permission that
has never existed in any release cannot have been deliberately withdrawn from a role.

## 5. The provider choice 5D needs, recorded now

`docs/phase4c-audit.md` §6 already inventories what the corpus evidences: **eleven
legacy gateways, three enabled** — NowPayments, درگاه سفارشی (a custom gateway) and
Telegram Stars — with ZarinPal, آقای پرداخت, Plisio, three FX→Rial slots, an offline
FX slot and card-to-card making up the rest. Production traffic in the log group shows
درگاه سفارشی carrying 169 of 174 financial messages.

That is **several providers evidenced and no owner decision between them**, which is
precisely the case the directive says must not be resolved silently:

> If multiple providers are evidenced and no owner choice exists: pick none silently;
> record the choice as a genuine owner/product decision; continue all provider-neutral
> work; stop only the adapter-specific slice if the missing provider choice is the only
> blocker.

So 5A, 5B and 5C are built provider-neutrally and the question is put to the owner when
5D is reached — not before, because asking blocks and there are three subphases of
provider-neutral work in front of it.

Two further facts the corpus fixes, and both constrain 5C's entity: **no gateway
schema anywhere exposes a fee, a currency selector or an exchange rate** (`FBR-010`,
VERIFIED_BY_UI for the five inspected), and Telegram Stars has no conversion-rate
setting at all while its payments are stored in Toman (`LGR-BR-062`). Nexa's answer is
already frozen and does not change: `money.ts` requires a currency on every amount, and
a payment whose currency differs from the order's is refused, never rescaled.

## 6. Defects found during this audit that are not 5A's

Recorded so they are not lost, with the subphase that owns each.

| #     | Defect                                                                                                                                                                                                                                                                                                                                     | Owner                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| A5-01 | `bot.service.detail` declares `expiresAt` and `syncedAt` optional, and `bot-runtime.ts:1399-1400` omits them when null — so a service with no expiry or no completed usage sync renders the literal `{expiresAt}` / `{syncedAt}` to the customer. `renderTemplateBody` substitutes only tokens it is given and leaves the rest as written. | 5F (a payment-adjacent instance of the same renderer behaviour 5A works around in §4.6) |
| A5-02 | `CLAUDE.md`'s deployment paragraph still reads "It has never been run against a real server", which `v0.2.0` and `v0.2.1` staging deployments contradict. `docs/vps-acceptance.md` was corrected in PR #33; this sentence was missed.                                                                                                      | 5A (one-line documentation correction, carried with this branch)                        |

---

## 7. 5A work list

1. Contracts: card/Sheba normalisation and structural validation, the account shape,
   two permissions with role seeds, refusal codes, HTTP schemas and routes, five
   template keys.
2. Schema and forward-only migrations: `payment_accounts`, `payment_destinations` with
   its append-only guard, and the role-permission backfill.
3. `PaymentAccountService` and its Drizzle repository — list, create, edit,
   enable/disable, reorder, set-default — each taking a `ScopeContext` and an
   `ActorContext`, reading `ScopeActivityReader` inside its transaction, and writing an
   audit row.
4. `requestManualTransfer` resolves the destination and writes the snapshot in the same
   transaction that creates the payment; a re-issued pending payment keeps the snapshot
   it was created with.
5. Telegram renders the structured destination from the snapshot, omits absent fields,
   and does not draw the manual button when no destination exists.
6. Web Admin: a real Payment Accounts surface under the financial section.
7. The nine required test areas, a mutation pass, the full gate, one self-review, one
   Codex review.

---

## 8. Owner addendum: the invoice keyboard and receipt submission

Received mid-5A, after the account model and migrations were committed. It specifies
the manual-transfer invoice's inline keyboard exactly:

```
[📋 کپی شماره کارت]    [💵 کپی مبلغ]
[✅ پرداخت را انجام دادم | ارسال رسید]
```

with `ارسال رسید` part of the SAME label as `پرداخت را انجام دادم`, a second-row tap
that starts receipt submission for that exact payment, does NOT settle it, and asks the
customer to upload the receipt; the receipt bound to tenant + bot instance + customer +
payment; settlement still requiring the existing operator confirmation.

### 8.1 It reverses owner revision 17, and that is recorded rather than smoothed over

`OQ-4C-03` and `templates.ts` both carry owner revision 17: _no receipt is stored,
archived or displayed anywhere in this product_. It is why
`bot.payment.manual_instructions` stopped saying «سپس رسید را ارسال نمایید», why
`bot.payment.received_for_review` is worded as recording the customer's CLAIM, and why
`receipts.view` / `receipts.review` govern a payment rather than a receipt entity.

This addendum is a later instruction from the same owner and supersedes it. What changes
is the storage decision only — **the review model does not move**: a receipt is evidence
an operator looks at, `PAYMENT_EVIDENCE_KINDS` stays `OPERATOR_REVIEW`, and nothing about
an upload confirms a payment. `OQ-4C-03` is updated to say so.

### 8.2 The two copy buttons are a real Telegram mechanism, not a message that says "copy this"

Telegram's `InlineKeyboardButton.copy_text` (a `CopyTextButton`, Bot API 7.11) copies a
string to the client clipboard on tap. That is what these two buttons use. The
alternative — a callback that replies with a message containing only the digits — is
what a bot does when the API has no copy button, and it puts a second message in the chat
for every tap.

Both values come from the payment's FROZEN snapshot and its own amount, never from the
account row, so tapping copy on a week-old invoice copies what that invoice says.

### 8.3 Why the receipt flow is its own subphase, and why the label waits for it

5A ships the copy buttons and keeps the existing `پرداخت را انجام دادم` label. The
combined label lands in the same commit as the flow behind it, for the rule this codebase
is organised around: a button whose label promises a capability that does not exist is
the defect, not a step towards fixing it. Subphase **5R**, immediately after 5A.

### 8.4 The capture window is bounded, payment-scoped and cannot swallow a message

The addendum asks for "after tapping it, ask the customer to upload the receipt", which
is prompt capture — the mechanism `INCIDENT-FIN-001` records destroying a production
setting, and which earlier directives forbade in the general form. The general form is
still forbidden. What 5R builds is narrower in four ways, and each one is what makes it
not that incident:

- it is opened by a tap on ONE payment and stores that payment's id, so there is no
  "current prompt" a later message can land in by accident;
- it accepts a PHOTO or a DOCUMENT and nothing else — a text message during an open
  window routes exactly as it does today, including `/start` and the main-menu labels,
  so nothing a customer types can be consumed;
- it is a customer-side window that can attach a file to a payment and can change no
  configuration, no price and no setting;
- it expires, and it cannot outlive the payment's own window.

## §9 — The Codex round on PR #34

Ten findings, all P2. Seven fixed, three answered, and this section is the ledger so the
next reader does not have to reconstruct it from a thread.

| #   | Finding                                                                 | Verdict   | Where it landed                                |
| --- | ----------------------------------------------------------------------- | --------- | ---------------------------------------------- |
| C1  | The accounts screen derives every control from `payments.accounts.view` | CONFIRMED | `mayEdit` is passed separately, from `resolve` |
| C2  | The create hash omits `makeDefault`                                     | CONFIRMED | `hashRequest` covers it                        |
| C3  | A disable racing a promotion surfaces as a CHECK violation              | CONFIRMED | the predicate names `is_default`               |
| C4  | A lost disable returns the row it had read                              | CONFIRMED | the null branch re-reads                       |
| C5  | A reissue's audit row names no account                                  | CONFIRMED | read from the snapshot                         |
| C6  | The table's card and Sheba checks are shape-only                        | CONFIRMED | migration 0065                                 |
| C7  | `enabled: false, makeDefault: true` succeeds half-applied               | CONFIRMED | refused by name                                |
| C8  | The per-tenant limit is not serialised                                  | ANSWERED  | a stated decision; see below                   |
| C9  | The frozen destination reaches no operator surface                      | CONFIRMED | `paymentDestinationViewSchema`                 |
| C10 | The default race reports `PAYMENT_ACCOUNT_DUPLICATE`                    | CONFIRMED | its own code                                   |

**C8 was answered and is now FIXED, on the owner's ruling.**

The first answer argued the race was acceptable: `PAYMENT_ACCOUNT_MAX_PER_TENANT` is a
rail that keeps the account list complete rather than a policy anybody buys, two creates
at the ceiling leave fifty-one, and a list of fifty-one returned without pagination is
still complete. The owner overruled it, and the ruling is the better one: an invariant
this codebase states in a constant should hold rather than be recorded as raceable.

The cost of holding it turned out to be one line. `lockForCreate` takes
`pg_advisory_xact_lock(PAYMENT_ACCOUNT_LOCK_CLASS, hashtext(tenant_id))` at the top of
the create transaction, before the count. It is:

- **tenant-scoped** — `hashtext` of the tenant id is the object key, so two tenants
  adding accounts at the same moment do not wait for each other;
- **transaction-scoped** — released by the commit or the rollback, so there is no unlock
  path to forget and no lock to leak on a crash;
- **not a row lock**, and that is the load-bearing choice. `scopeIsActive` takes
  `FOR SHARE` on the tenant row inside every write transaction in the product, and its
  own comment calls that "this installation's single busiest row". A `FOR UPDATE` here
  would have put account creation behind every scope-activity check in the system, and
  every one of those behind an operator adding a bank card.

Two honest limits, stated rather than hidden. Two tenants whose ids hash to the same
`int4` would wait for each other — one in 2^32 per pair, costing mutual exclusion on an
operator action measured in single digits per tenant per year. And the lock serialises
CREATES only; edits, promotions and disables are untouched, because none of them can
change the row count.

The test is a controlled interleaving rather than a `Promise.all`, and it is
deterministic in both directions: a holder connection takes the same advisory key, then
the suite polls `pg_locks` until each create is provably WAITING on it. That poll is also
the falsification detector — with the lock removed a create does not wait, it completes,
and the test says so by name rather than by a count that might happen to be right.

### Two things this round changed about how 5A is tested

**Two race tests did not bite, and were rewritten.** The first versions of C3's and C4's
cases committed the competing change with raw SQL before the service ran, so the
service's own pre-check refused and the branch under test was never reached; both passed
with the fix reverted. They now hold a `FOR UPDATE` row lock, which is the technique
`customer-order-actions.test.ts` already uses for the same window. `docs/phase5a-falsification.md`
records this in full, because it is the third time on this project that a race test has
needed exactly this correction.

**Check digits are now enforced in three places, not two.** `packages/contracts` at the
HTTP boundary, migration 0065 at the table, and the seed's own fixtures, which are
fabricated and satisfy Luhn and mod-97 so the suite exercises the real validation rather
than a version with the checks turned off. `nexa_luhn_ok` and `nexa_iban_ir_ok` are
functions, so drizzle-kit models neither them nor a CHECK that calls one — they live in
the hand-written migration and the drift check is unaffected by construction.

### One collision to expect

Subphase **5R** was branched from 5A's head before this round and carries its own
migrations numbered 0065 and 0066. 5A now owns 0065. 5R must renumber to 0066/0067 when
it rebases, which is forward-only and safe because it has never been pushed or applied
anywhere but a local development database.
