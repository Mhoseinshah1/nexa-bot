# WP17 — Payment System Phase 3: audit and what was done

Branch `claude/wp17-payments-phase3`, from `origin/main` at `4e6fb39`. Independent of
WP12–WP16 (PRs #76–#80, all unmerged).

Owner scope for this package, verbatim: "intentionally deferred payment features such as:
Payment Fee, payment history/timeline, refund architecture, advanced payment diagnostics,
potentially partial refunds … Do not invent any fee/refund semantics. Audit first and
implement only behavior already defined by existing product rules. If owner decisions
are genuinely required for money movement, document those blockers and leave those
specific behaviors unimplemented."

---

## 1. Authorities that bear on this package

- **Payment File 02** (`docs/payments-file02-design.md`) is the product authority for
  payments and overrides File 01 where they differ (lines 3–5).
- File 02 §22, as recorded at `payments-file02-design.md:182-192`, lists as out of scope:
  - payment fees of any kind;
  - a partial-refund UI or workflow;
  - a payment timeline;
  - a customer "My Payments" screen;
  - gateway refunds.
- D7 (`:137`) says "The detail page stays current-state, with no timeline."
- The WP17 instruction names the history/timeline as an "intentionally deferred" feature
  to take up now. That is the owner reopening one §22 item, and this package reads it
  that way **for the timeline only**:
  - a timeline is a read of facts already recorded;
  - it moves no money;
  - it decides nothing about any amount.
- Nothing in the WP17 instruction defines a fee or a new refund rule, so File 02's
  exclusions of those still stand.

## 2. Findings, per item the owner named

### F1 — Payment Fee: undefined, and explicitly excluded (BLOCKER)

- **Nothing in the repository defines a fee.**
  - Contracts: no ledger reason for a fee. `RESELLER_MEMBERSHIP_FEE` is the reseller
    membership (O-3), which has no writer and is not a payment fee.
  - Schema: no fee column on `payments`, whose money is `amount` + `currency` with
    `amount > 0`.
  - Settings: nothing.
  - Gateways: `payment_gateways.topup_cashback_percent` is a gift to the customer, not a
    charge on them.
- **Owner statements that exclude it:**
  - File 02 §4 ("No payment fee — met").
  - §22.
  - `docs/wp10-followup-audit.md:352`: File 01 §20–21, the fee, is overridden by File 02.
  - `docs/prerelease-hardening-audit.md:7` and `docs/customer-ux-completion-audit.md:7`:
    "no Payment Fee".
- **Research:** FBR-010 found no gateway fee in any of the five legacy schemas. The legacy
  deducted commission only (LGR-BR-012).
- **Open decision:** `docs/open-questions.md` (the Phase-5 DECISION, "Where do exchange
  rates and gateway fees come from?") is unresolved.
- **What an implementation would have to invent.** Each of these changes what a customer
  pays or what an operator receives:
  - who bears the fee (customer on top, or seller absorbed);
  - fixed or percentage, and on what basis (principal, total, per gateway, per method);
  - its currency and rounding for IRR/USD minor units;
  - where it is recorded (a column on the payment, a separate ledger entry, or both);
  - whether it is shown before confirmation (it must be, under the "honoured, never
    re-priced" rule, so it becomes part of the quote);
  - whether a refund returns it, in part or in full;
  - how it interacts with cashback, the top-up gift, referral commission and reseller
    credit.
- **Not implemented.** Recorded as `OQ-WP17-FEE` in `docs/open-questions.md`.

### F2 — Partial refunds: already defined and already built (no change)

A partial refund is not a deferred feature. It is the current behaviour, with one
arithmetic rule:

- **Contract:** `refundRequestSchema.amountMinor` is any positive amount
  (`packages/contracts/src/refunds.ts:269-283`).
- **Bound:** `refundFitsWithin` is `requested + consumed <= paid`, decided under the
  payment's row lock (`refund.service.ts:322-380`).
- **Schema:** "A payment can be refunded MORE THAN ONCE — partially, by different
  operators, at different times" (`schema.ts:3774-3776`).
- **Order state:** a partial refund leaves the order PAID. Only COMPLETED refunds that sum
  to the full amount move it to REFUNDED (`refund.service.ts:734-740`, WP10 P3).
- **Reversals:** the cashback and referral reversals use the cumulative target, so
  partial refunds sum to one full one (CLAUDE.md, pricing rule 4).
- **Notifications:** each completed refund is its own `REFUND_COMPLETED` fact.
- **Web Admin:** `RefundsCard` already shows paid, consumed and remaining, with a free
  amount field and a "refund all remaining" shortcut.
- **Tests:** `tests/integration/refunds.test.ts` ("will not let two partial wallet refunds
  exceed the payment together") and `tests/unit/refund-rules.test.ts`.

File 02 §22 excludes a _new_ partial-refund UI or workflow (for example per-line refunds;
`MAX_ORDER_LINES = 1` means there is only ever one line). Nothing is added.

### F3 — Refund architecture: defined; the undefined edges stay closed (BLOCKERS)

What is defined and unchanged:

- **States:** four states (REQUESTED, AWAITING_EXTERNAL, COMPLETED, FAILED).
- **Channels:** the channel is derived from the payment method, never chosen.
- **Credit path:** one credit path (`RefundService.refundUndeliverable` and the
  operator's wallet refund write the same `${refundId}:refund` entry).
- **Automatic refunds:** an automatic refund supersedes open manual ones.
- **Database guards:** a DB trigger freezes a refund's identity and its terminal state
  (migration 0073).

What is NOT defined, each left refused exactly as it is today:

| Behaviour                                                  | Today                                        | Decision needed                                                  |
| ---------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| Refund of a wallet top-up                                  | Refused `TOPUP_CREDITED_TO_WALLET`           | OQ-5H-04, which depends on UNK-UM-005 (may a wallet go negative) |
| Refund of a gateway payment through the provider           | `CHANNEL_UNSUPPORTED` (`supported: false`)   | OQ-WP10-01 / OQ-5D-01: no gateway provider is named              |
| Operator choosing wallet credit for a bank-transfer refund | Not offered: channel derives from the method | Owner decision; changes where money goes                         |
| Refunding a fee                                            | No fee exists (F1)                           | Part of F1                                                       |

### F4 — Payment history/timeline: data exists, nothing assembles it (IMPLEMENTED, read-only)

The detail page is current-state. The history of one payment is spread across eight
places, all already written by the flows that own them:

| Fact                                  | Source                                                             | Timestamp truthfulness                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Created                               | `payments.created_at`                                              | Exact                                                                                                                                                                                               |
| Customer said they sent it            | `payments.customer_signalled_at`                                   | Exact; stamped once                                                                                                                                                                                 |
| Confirmed (with evidence kind, admin) | `payments.confirmed_at`, `confirmed_by_admin_id`                   | Exact; frozen (0035)                                                                                                                                                                                |
| Ended without money (state, admin)    | `payments.resolved_at`, `resolved_by_admin_id`                     | Exact; `payments_resolved_check`                                                                                                                                                                    |
| Receipt submitted                     | `payment_receipts.created_at`                                      | Exact; UPDATE refused (0067)                                                                                                                                                                        |
| Receipt credited to the wallet        | `receipt_credits.decided_at`, `decided_by_admin_id`                | Exact                                                                                                                                                                                               |
| Wallet movements for this payment     | `wallet_entries` WHERE `payment_id` AND the payment's own customer | Exact; append-only                                                                                                                                                                                  |
| Refund requested / completed          | `refunds.created_at` / `completed_at`                              | Exact; `created_at` frozen (0073)                                                                                                                                                                   |
| Refund abandoned (FAILED)             | `refunds.updated_at`                                               | The last write to the row. FAILED is terminal in the DB, and the only writes are conditional from a non-terminal state, so this is the failure time. Labelled "closed", not given a column it lacks |
| Customer told                         | `customer_notifications` by subject (payment, or refund)           | When it was queued (`created_at`), plus the delivery state and `resolved_at`                                                                                                                        |

Deliberately left out:

- **`audit_logs` rows.** They are the same facts written a second way, under
  `audit.view`. The only reader (`AuditHistoryReader`) is on the unmerged WP14 branch,
  and two readers would be two answers. The domain rows above already carry each fact's
  time and admin.
- **`receipt_review_pushes`.** Delivery of a receipt to reviewers is one row per reviewer
  per receipt, which is internal to review, and File 02 §10 keeps review in Telegram.
  This is left for a diagnostics slice.
- **Notes** (`evidence_note`, `resolution_note`, refund reasons and completion notes).
  They are on the detail and refund cards already. A second copy is a second place to
  leak an operator's text about somebody's bank transfer.
- **The order's own `ORDER_EXPIRED` and `ORDER_CANCELLED` notifications.** Their subject
  is the order, not this payment.

### F5 — Payment diagnostics

- **What exists:**
  - list filters by state, method and disposition, customer, order and exact reference;
  - an UNKNOWN banner;
  - the compensation list;
  - the expiry sweep.
- **What this package adds:** the timeline (F4) is the per-payment diagnostic. It answers
  "was the customer told, and did it reach them" and "which wallet entries did this
  payment produce", which no screen could answer before.
- **What is not added:**
  - a Web receipt-review queue (File 02 §10 keeps review in Telegram; WP16 records it as
    the next ops slice);
  - UNKNOWN reconciliation diagnostics (OQ-4G-04: nothing produces UNKNOWN until a real
    gateway exists).

## 3. What this package changes

### D1 — `GET /payments/:id/timeline` (read-only)

- **Permission.** The route charges `payments.view`, like the detail. Each entry is
  present only when the viewer also holds the permission that already guards the same
  fact elsewhere:
  - receipt submissions need `receipts.view` (the receipts card's permission);
  - refund entries and refund notifications need `refunds.view` (the refunds card's);
  - wallet movements need `users.view` (the wallet ledger's, `WALLET_VIEW_PERMISSION`).

  A section the viewer cannot see is **withheld, and the response says so** (`withheld`),
  so an empty history is never mistaken for a complete one.

- **Probing without a denial event.** The per-section check reads the actor's effective
  permissions (`PermissionGuard.permissionsOf`) and does not record a denial. Missing one
  is not an attempted access; the payment itself is still charged through `check`.
- **Wallet movements** are restricted to the payment's **own customer**. A referral
  commission names the referee's payment but lands in the referrer's wallet, and that is
  somebody else's ledger. Entries with reason `REFUND` are not repeated here; the refund
  entry is the same money under its own permission.
- **Ordering.** Entries are sorted by time, then by a fixed rank of kinds, then by id, so
  two reads of the same rows render the same order. The assembly is a pure function
  (`payment-timeline.ts`) with its own unit tests.
- **Bounds.** At most `PAYMENT_TIMELINE_MAX_ENTRIES` (200). A longer history reports
  `truncated: true` rather than dropping entries silently.
- **Payloads.**
  - No note text of any kind.
  - No receipt caption or file id.
  - No destination.
  - No notification body; kinds are payload-free by ADR-0030.
  - Admin ids are included where the detail already shows them.
- **It changes nothing.** An integration test snapshots the rows around a read.

### D2 — Web Admin: a history card on the payment detail

- Rendered below the current-state cards.
- Every entry is a sentence from the catalogue.
- Money is shown through the shared money formatter.
- The withheld sections are named.
- No control on the card changes anything.

## 4. Deliberately not done

| Item                                          | Why                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Payment Fee                                   | F1. Undefined, and excluded by File 02 §4 and §22. `OQ-WP17-FEE`.                                    |
| New partial-refund workflow                   | F2. Already built. File 02 §22 excludes a new one.                                                   |
| Top-up refund, gateway refund, channel choice | F3. Each needs an owner decision about where money goes.                                             |
| Audit rows in the timeline                    | One reader, and it is on the unmerged WP14 branch. Merging both would give two answers for one fact. |
| Customer "My Payments"                        | File 02 §22. Not named by WP17.                                                                      |
| `payments.retry` consumer                     | No defined behaviour. Tests assert no retry route exists.                                            |
| Web receipt-review queue                      | File 02 §10 keeps review in Telegram.                                                                |

## 5. Evidence

Fifteen rules, each reverted alone and killed by a named test: `docs/wp17-falsification.md`
(P17-01..15), registered with the citation check so a renamed test fails the build. The
first pass cited one test by a title it does not have ("withholds refunds without
refunds.view"); the record cites it as it is.

A Codex review of the integrated head found two defects in the reader, both fixed with a
named test and falsified (P17-16..18): the sections were read statement by statement, so
a confirmation committed between two of them produced a history no moment ever had — they
are now read at one repeatable-read, read-only snapshot — and `GATEWAY_PAYMENT_FAILED`,
whose subject is the payment, was missing from the notification kinds.

A second Codex round, on the final candidate `ed4afec`, found three more (P17-19..22):

- The diagnostics reader (WP16 code, already merged in #80) read each count and its sample
  as two statements, so the two could describe different moments. Each pair is now read in
  one repeatable-read, read-only transaction.
- This timeline's wallet read had no payment-leading index and no floor. It is now bounded
  below by the payment's own `created_at`, which no entry naming it can predate.
- The Web card said "system" for a CANCELLED payment, which is always the customer's own
  withdrawal. It now says the customer.

A third Codex round, on `d41e5b9`, found one more (P17-23). The history card sits on the
same page as the refund card, and an answered refund did not re-read it, so the timeline
omitted what the operator had just done until the page was reloaded. The refund card's
refresh now invalidates the payment's timeline as well.

A fourth round, on `148be08`, found one more (P17-24..27). The detail and the history are
two requests, so a payment decided between them could reach one and not the other: a
detail still PENDING beside a history that records the confirmation. The card is now
handed the state the detail read and compares it with the terminal state its own entries
record. A payment only ever leaves an open state, so the side that still reads it open is
the older read, and only that side is read again. It is re-read once per disagreeing pair,
so two answers that cannot converge cost one extra request, never a loop. A truncated
history is not compared, because it cannot say.

A fifth round, on `b406e82`, found two more (P17-28..32), both about an answer kept on
screen after it moved. A notice the history shows as PENDING is still being decided by
the notification lane, so the card now reads the history again every
`TIMELINE_UNSETTLED_POLL_MS` (15 s), and only while such a notice is on it. A history
whose notices are all resolved is not polled at all. The viewer's section permissions
(`receipts.view`, `refunds.view`, `users.view`) are now part of the card's cache
identity. A permission revoked while the page is open is therefore a new question to the
server, which decides what is withheld, instead of the old answer kept on screen.

A sixth round, on `2af27fb`, found two more (P17-33..34). The history called a FAILED
resolution "closed without receiving money", but a receipt credited to the wallet closes
its payment FAILED while the money it carried is credited, in the row below. The label
now says the payment closed unsettled. A refund request answered with an error re-read
the ledger but not the history beside it. A 5xx may have committed, so the history is
now re-read too.

A seventh round, on `fdd6f71`, found two more (P17-35..40). The customer's transfer
signal leaves the payment PENDING, so comparing states could not see a signal that reached
one read and not the other. The signal is set once and frozen (migration 0058), so the
comparison now includes it, and the side without it is read again. Completing or
abandoning a refund is as ambiguous behind an error as requesting one, including a
response that never arrived. All three commands now re-read the ledger and the history on
any error.

An eighth round, on `834af1b`, found two more (P17-41..43). The wallet section was bounded
below by the payment's own `created_at`, but the wallet entry and the payment each take
their timestamp from their own writer. A clock stepped back between the two, or a writer
behind the payment's, could hide a movement that belongs to it. The floor is now a day
before the payment (`WALLET_FLOOR_TOLERANCE_MS`). The window is still bounded, and a new
index or a migration would have renumbered the three stacked packages behind this one.
The card polled only while a notice was PENDING, so a payment still OPEN, with no notice
yet, kept its history until something else moved it. It now also polls while the payment
it shows is OPEN, at the same 15 s, and stops once the payment is decided.

Tests added:

- **Unit:** `tests/unit/payment-timeline.test.ts` (7 cases) and
  `tests/unit/payment-timeline-sections.test.ts` (4 cases, the section decision over the
  real permission guard).
- **Integration:** `tests/integration/payment-timeline.test.ts` (10 cases), plus the new
  route in `tests/integration/route-registration.test.ts`, and two snapshot cases in
  `tests/integration/system-diagnostics.test.ts`.
- **Web:** `tests/web/payment-timeline.test.tsx` (8 cases: the card alone, and inside its
  page through the real route), and one case in `tests/web/payments.test.tsx` (the history
  is re-read after a refund is answered).

Targeted checks run locally:

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm check:i18n` and
  `pnpm check:boundaries` pass.
- `pnpm test:web` passes (34 files, 693 tests).
- The two integration files pass.

The full acceptance is deferred, as for every roadmap package.
