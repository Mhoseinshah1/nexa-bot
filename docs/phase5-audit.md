# Phase 5 audit — what the payment core was on `58ec7ca`

Written before any Phase 5 code, against `origin/main` = `58ec7ca` (`v0.2.1`, deployed
to staging). It records what existed, what did not, and which missing things may be
built from evidence rather than invention. 5A in detail; 5B–5F only far enough to say
what blocks them.

## 1. What a manual transfer was

`PaymentService.requestManualTransfer` created a sound `PENDING` payment — idempotent by
request hash, re-issuing a live pending payment, closing a stale one through the sweep's
conditional UPDATE. **What the customer was then told was not sound.**
`bot.payment.manual_instructions` says «طبق راهنمای فروشنده» — _follow the seller's
instructions_ — and the template's own description says this installation ships no bank
details and invents none. So the only way to put a card number in front of a customer
was to override that template body and type the digits into the message.

| Failure                             | Why                                                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| History-bearing data stored as copy | Editing the template rewrites what _every already-issued_ instruction says, including one a customer paid against yesterday |
| No second account                   | One body is one destination; a tenant with two cards, or one blocked on a Friday, has nowhere to put the second             |
| Nothing validates it                | A transposed digit is copy. It renders, it sends, and the money goes to whoever owns that card                              |
| Wrong operator workflow             | Changing a card number should not mean opening a message editor                                                             |

`payments` carried no destination at all — not a column, not a reference, not a
snapshot.

## 2. What else is missing, measured

| Capability                            | State on `58ec7ca`                                                                     | Evidence                       |
| ------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------ |
| Structured bank/card accounts         | Absent — no table, service, route or screen                                            | —                              |
| Payment destination snapshot          | Absent                                                                                 | `payments` has no such column  |
| Customer wallet top-up                | Absent; `wallet.topup.minimum` is registered with no consumer, deliberately            | `docs/phase4c-audit.md` §6     |
| Gateway configuration                 | Absent; `GATEWAY` is a frozen `PAYMENT_METHOD` with no adapter, row or button          | `payment.ts`, `bot-runtime.ts` |
| Gateway callback / verify / reconcile | Absent; `LOSE_TRACK`, `RECONCILE_CONFIRMED`, `RECONCILE_FAILED` have no producer       | `OQ-4G-04`                     |
| `UNKNOWN` payments                    | Unreachable, so `payments_unknown_idx` is a partial index over an empty set            | `OQ-4G-04`                     |
| Refunds                               | Absent as an entity; `refunds.*` permissions and three ledger reasons have no producer | `OQ-4C-02`                     |

All seven share one shape: **the vocabulary is frozen and the producer is missing.**
Phase 5 is largely giving frozen contract members their first producer.

## 3. What the research corpus establishes about bank details

`کارت به کارت` exists in the legacy system as one of eleven gateways and is disabled in
the inspected installation (`FBR-004`); it has sixteen controls against the eight-control
gateway base (`FBR-009`), of which the corpus names only the auto-approval trio
(`FBR-007`) and the amount limits (`FBR-008`). The card-to-card field list was never
captured, so the corpus does **not** say whether a card number was a structured field or
lived inside the tutorial text.

Consequence: the 5A field list is derived from what an Iranian card-to-card transfer
requires, not from a claim about MirzaBot. One corpus finding does decide something —
the free-text tutorial field is what `INCIDENT-FIN-001` corrupted in production, which
is exactly why a payment destination must stop being free text.

## 4. 5A decisions that later code must obey

- **Two tables, not columns on `payments`.** A CHECK binding a destination to
  `method = 'MANUAL_TRANSFER'` could only be an implication, because every pre-migration
  manual transfer has no destination — the "two columns that can disagree" shape
  `payments_confirmed_check` exists to refuse. A payment issued before 5A simply has no
  snapshot row and falls back to the old template. `payment_destinations` is append-only
  by trigger.
- **No account field for `account_number`.** An Iranian card-to-card transfer is made
  against the card number or the Sheba; no evidence asks for the account number. `iban`
  is the only optional customer-facing field.
- **Accounts are disabled, never deleted** — this is the answer to the directive's
  "account delete policy". It keeps the snapshot's `account_id` provenance honest and
  matches `customers`' "a block is not a deletion".
- **Validation is structural.** Luhn and ISO 13616 mod-97 prove a string is well formed,
  never that the account exists or that the holder name matches it.
- **One deterministic destination**: the enabled default, else the enabled account with
  the lowest `(sort_order, created_at, id)`. At most one default per tenant is a partial
  unique index, and a default must be enabled is a CHECK — otherwise "a disabled account
  cannot be selected" is defeated by disabling the default. With no enabled account the
  request is refused by name and the button is not drawn.
- **The destination is composed from four line keys**, not an optional `{sheba}` token:
  `renderTemplateBody` leaves a declared-but-absent token as the literal `{token}`.
  Composition is in infrastructure behind a port, because `check-boundaries.sh` refuses
  an `@nexa/i18n` import in a surface. The body stays `PLAIN_TEXT` — a composed value is
  HTML-escaped, so `TELEGRAM_HTML`'s `<code>` would reach the customer as `&lt;code&gt;`.
- **Two new permissions**, `payments.accounts.view` (LOW) and `payments.accounts.edit`
  (CRITICAL), rather than reusing owner-only `settings.edit` — a finance operator unable
  to replace a blocked card is the defect migration `0055` exists to repair. Backfilled
  by hand-written migration, safe for `0011`'s reason: a permission that never existed
  cannot have been deliberately withdrawn.

## 5. The provider choice 5D needs

`docs/phase4c-audit.md` §6 inventories eleven legacy gateways, three enabled
(NowPayments, درگاه سفارشی, Telegram Stars), with درگاه سفارشی carrying 169 of 174
financial messages in the log group. **Several providers evidenced, no owner choice** —
so 5A–5C are built provider-neutrally and the question goes to the owner at 5D.

Two corpus facts constrain 5C: no gateway schema exposes a fee, a currency selector or
an exchange rate (`FBR-010`), and Telegram Stars has no conversion-rate setting while
its payments are stored in Toman (`LGR-BR-062`). Nexa's answer does not change — every
amount carries a currency, and a payment whose currency differs from the order's is
refused, never rescaled.

## 6. Defects found here that are not 5A's

| #     | Defect                                                                                                                                                          | Owner |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| A5-01 | `bot.service.detail` omits `expiresAt`/`syncedAt` when null, so a service with no expiry or no completed sync renders the literal `{expiresAt}` to the customer | 5F    |

## 7. Owner addendum: the invoice keyboard and receipt submission

Received mid-5A. The manual-transfer invoice keyboard is exactly:

```
[📋 کپی شماره کارت]    [💵 کپی مبلغ]
[✅ پرداخت را انجام دادم | ارسال رسید]
```

`ارسال رسید` is part of the same label, not a second button. The tap starts receipt
submission for that exact payment, does NOT settle it, and the receipt is bound to
tenant + bot instance + customer + payment. Settlement still requires the existing
operator confirmation.

**It reverses owner revision 17** (_no receipt is stored, archived or displayed_) —
recorded in `OQ-4C-03` rather than smoothed over. What does **not** move is the review
model: `PAYMENT_EVIDENCE_KINDS` stays `OPERATOR_REVIEW` and an upload confirms nothing.

The copy buttons are Telegram `CopyTextButton`s (`copy_text`, Bot API 7.11), carrying no
callback data, with both values read from the payment's frozen snapshot — so copying on
a week-old invoice copies what that invoice says.

**The upload window is not the prompt capture `INCIDENT-FIN-001` describes**, and this
is the constraint 5R's code has to keep: it is opened by a tap on ONE payment and stores
that payment's id, so no later message can land in a "current prompt"; it accepts a
photo or a document and nothing else, so text — including `/start` and the menu labels —
routes exactly as it does today; it can attach a file to a payment and change no
setting, price or configuration; and it expires, never outliving the payment's window.

## 8. The Codex round on PR #34

Ten findings, all P2.

| #   | Finding                                                                 | Verdict   | Where it landed                                |
| --- | ----------------------------------------------------------------------- | --------- | ---------------------------------------------- |
| C1  | The accounts screen derives every control from `payments.accounts.view` | CONFIRMED | `mayEdit` is passed separately, from `resolve` |
| C2  | The create hash omits `makeDefault`                                     | CONFIRMED | `hashRequest` covers it                        |
| C3  | A disable racing a promotion surfaces as a CHECK violation              | CONFIRMED | the predicate names `is_default`               |
| C4  | A lost disable returns the row it had read                              | CONFIRMED | the null branch re-reads                       |
| C5  | A reissue's audit row names no account                                  | CONFIRMED | read from the snapshot                         |
| C6  | The table's card and Sheba checks are shape-only                        | CONFIRMED | migration 0065                                 |
| C7  | `enabled: false, makeDefault: true` succeeds half-applied               | CONFIRMED | refused by name                                |
| C8  | The per-tenant limit is not serialised                                  | CONFIRMED | `lockForCreate`, on the owner's ruling         |
| C9  | The frozen destination reaches no operator surface                      | CONFIRMED | `paymentDestinationViewSchema`                 |
| C10 | The default race reports `PAYMENT_ACCOUNT_DUPLICATE`                    | CONFIRMED | its own code                                   |

C8 was first answered as an accepted race and the owner overruled that. The lock's
rationale — advisory rather than a row lock, because `scopeIsActive` already takes
`FOR SHARE` on the tenant row in every write transaction — is above `lockForCreate` in
`account-ports.ts`; the mutations are F5A-20 and F5A-21.

Check digits are now enforced in three places: `packages/contracts` at the HTTP
boundary, migration 0065 at the table, and the seed's fixtures, which satisfy Luhn and
mod-97 so the suite exercises the real validation. `nexa_luhn_ok` and `nexa_iban_ir_ok`
are functions, so drizzle-kit models neither them nor a CHECK calling one — the drift
check is unaffected by construction.
