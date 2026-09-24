# Pre-release hardening before v0.4.0 — audit and decisions

Baseline: `main` at `3265d5627f778b0fa69d8632dc96fa65c69a2832` (PR #71 merged).

Scope was set by the owner:

- **No new product features.** No external payment gateway, no Payment Fee, and no release, tag or deploy.
- **OQ-WP10F-03 stays open.** Generic blocking is not redesigned.

Falsification rows for every rule below are in `docs/prerelease-hardening-falsification.md`.

## §1 — a receipt-review decision needs a stored receipt

**The defect.** A pending manual transfer with no receipt could still be decided from the receipt-review surface. The buttons were drawn only on a receipt, but the callbacks were not checked, and a crafted `D:` (approve), `E:` (reject), `wa:` (credit) or `xa:`/`xb:` (block from receipt) reached the service with nothing to review.

**The fix.** Enforcement is in the backend, at the layer that writes and at the surface's admission. It does not depend on a button being absent.

| action             | admission (surface / capture)                                                                                             | the write                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Approve            | `ReceiptService.reviewItem` returns null with no receipt (`C:` item, `D:` path)                                           | `PaymentService.confirmManualTransfer` with `requireReceipt: true` refuses in its transaction                         |
| Reject             | `ReceiptReasonCaptureService.admitted` — the policy AND `countForPayment > 0` — at `subjectOf`, `open` and `submitReason` | `PaymentService.rejectManualTransfer` with `requireReceipt: true` (from the reject policy) refuses in its transaction |
| Credit to wallet   | already guarded on `main`: capture open refuses (`bot.admin.credit_no_receipt`)                                           | already guarded on `main`: `creditToWallet` refuses in its transaction                                                |
| Block from receipt | the same `admitted` check, at `ask`, `open` and `submitReason`                                                            | — (a block is not a disposition, and its admission is the guard)                                                      |

- **The typed refusal.** It is the existing one: `commerce.payment_state_invalid` with `details.reason = 'NO_RECEIPT'`, the shape `creditToWallet` already used. The surface answers with the existing `bot.admin.receipt_gone`, or `bot.admin.credit_no_receipt` for a credit. No contract changed.
- **Races.** `payment_receipts` is append-only (`payment_receipts_no_delete`), so a receipt counted once cannot disappear. A count taken inside the deciding transaction therefore cannot be invalidated by a concurrent write. The exactly-once edges from PRs #70 and #71 are untouched. Those are the conditional `PENDING → CONFIRMED | FAILED` transitions and the `receipt_credits` row, and every race suite from #70/#71 passes.
- **Other callers.** The Web Admin has no approve or reject: card-to-card review is Telegram-only by the owner's decision. The flag is opt-in, so no other caller of `confirmManualTransfer` or `rejectManualTransfer` changed.

Tests: `tests/integration/receipt-evidence-guard.test.ts` (12).

## §2 — the block idempotency namespace (OQ-WP10F-04, RESOLVED)

**The defect.** `CustomerService.setStatus` recorded every block's and unblock's idempotency key under `WEB`, whatever surface the command came from. The audit row, meanwhile, recorded `actor.surface` truthfully. Two consequences followed:

- A Telegram block was remembered as a Web one.
- The same key string from the two surfaces answered for each other. It was either replayed as the other surface's result, or refused as a payload mismatch.

**Decision.** The namespace is the ACTOR's surface, `actor.surface`. That is the typed `SourceSurface` the audit writer already stores as `source_surface`, so the idempotency record and the audit row agree by construction. No parameter was added, no string literal was introduced, and the command's shape did not change.

**Every caller:**

| caller                                       | actor surface | idempotency key                      |
| -------------------------------------------- | ------------- | ------------------------------------ |
| Web `POST /users/:id/block` / `unblock`      | `WEB`         | the request's `Idempotency-Key`      |
| Telegram customers section (`9:b:` / `9:u:`) | `TELEGRAM`    | `<update key>:customer-status`       |
| Receipt Block User (`xc:` confirm)           | `TELEGRAM`    | `receipt-block-capture:<capture id>` |

The customers-section key is SUFFIXED because the update's own key is already `resolveFromUpdate`'s record in the `TELEGRAM` namespace. Unsuffixed, a block would collide with the resolve of the same update and be refused as a payload mismatch.

**What is preserved:**

- Same-surface retries are replays: one change and one audit row.
- The same key string on the other surface is its own command.
- A reused key on one surface for a different customer is still refused (`platform.idempotency_payload_mismatch`).
- The idempotency store's `scope_ref` stays `tenant|namespace`, so tenant isolation is untouched.
- `users.block` is charged as before.

Tests: `tests/integration/customer-block-surface.test.ts` (7), plus one case in `customers-http.test.ts`.

**Other hard-coded `WEB` namespaces are not changed.** These services are the add-on, product-category, product, payment-account, gateway, refund, cashback-rule and discount admin services. Each has only Web callers today, so none records a Telegram command under `WEB`. The rule is to use `actor.surface` when a second surface first calls one of them. They are not changed here (§7: no unrelated refactors).

## §3 — traffic is shown in a unit

**The defect.** Every traffic placeholder declared `BYTES` and said "the renderer owns the unit". The renderer printed `String(value)`, so the bot showed customers `53687091200`. One type also served two meanings of zero, which the renderer could not tell apart:

- a used or added **quantity**, where zero is zero;
- an **allowance**, where `UNLIMITED_TRAFFIC_BYTES` (zero) means no limit.

**The fix.** It is presentation only. No stored value, price or provider semantic changed.

- **A new type.** Contract commit: `TRAFFIC_LIMIT` joins `PLACEHOLDER_TYPES`. It is accepted and coerced exactly as `BYTES` is, so no caller's value is refused. Ten allowance tokens are retyped:
  - the four order summaries;
  - `bot.admin.receipt_traffic`;
  - the admin and customer service views' totals;
  - the three usage reminders.
    Usage and an add-on's added volume stay `BYTES`.
- **One rule.** `splitByteCount` (contracts) holds the rule the Web Admin already used:
  - binary units;
  - the largest unit reached;
  - one decimal, truncated and never rounded up;
  - `bigint` throughout, exact past 2^53.
    `@nexa/i18n`'s renderer and the Web Admin's `splitBytes` both call it, so one figure reads the same on both surfaces.
- **Rendering:**
  - an allowance of zero is «نامحدود»;
  - a quantity of zero is «0 بایت»;
  - an unknown figure is never passed and stays a dash (the receipt caption's `REVIEW_NONE`, the Web's `Dash`);
  - a non-integer value is shown as given.
- **The Web product form** shows the typed byte count in a unit beneath the input. The input stays in bytes.
- **Units stay binary**, the established semantics. A package sold as "10 گیگ" and stored as 10,000,000,000 bytes therefore reads «9.3 گیگابایت». That is the stored figure, stated truthfully, and the Web Admin has always shown it so.

**Surfaces audited:**

| surface                              | before                       | now                                                       |
| ------------------------------------ | ---------------------------- | --------------------------------------------------------- |
| Customer order summaries (×4)        | raw bytes, `0` for unlimited | unit, «نامحدود»                                           |
| Customer service detail              | raw bytes                    | unit; zero used is «0 بایت»; unlimited total is «نامحدود» |
| Add-traffic / renew / add-time quote | raw bytes                    | unit; an add-time package reads «0 بایت»                  |
| Usage reminders (×3)                 | raw bytes                    | unit                                                      |
| Admin service view                   | raw bytes                    | unit                                                      |
| Receipt caption volume               | raw bytes                    | unit or «نامحدود»; a top-up keeps «—»                     |
| Web products, orders, services       | binary units already         | same rule, now shared                                     |
| Web product form                     | bytes only                   | bytes plus a readout                                      |

**Not changed, and recorded.** `DURATION_DAYS` values also render as a bare number, and `0` means unlimited there too. It is outside §3's traffic scope and is deferred below.

Tests: `tests/unit/traffic-format.test.ts` (13), plus a web readout case. Four tests that pinned the raw integer now pin the unit.

## §4 — OQ-WP10F-03 stays open

The Telegram customers section still blocks on one tap with its fixed surface note, and the Web reason stays optional. Nothing in this package changes either.

## §5 — regression audit of PRs #68–#71

The audit was narrow, looking only for release-blocking defects:

- financial duplication, tenant isolation, authz bypass, idempotency and races;
- lying customer-facing state, migration compatibility, a workflow that cannot complete;
- secret exposure, and documented but unenforced invariants.

### V1 — a limited discount code could be used past its limit (CONFIRMED, FIXED)

**Where.** `OrderService.confirm` (discount redemption at confirm).

**The defect.** `confirm` read the order, then took the order's row lock, then redeemed from the first read. A code applied while the confirmation waited on the lock committed its discounted total first. The confirmation then redeemed the draft as it had been, with no code, and moved the order to `AWAITING_PAYMENT` at the discounted price with no redemption. A one-use code stayed unused.

**The fix.** The order is read again under the lock. The slot, the name, the redemption and the audit all decide from that row. A confirmation that finds the order already `AWAITING_PAYMENT` under the lock answers as the unlocked path always did: success, `changed: false`, and no second redemption attempt.

**Tests.** Two `pg_locks` barrier cases in `pricing-discounts.test.ts`: the racing code entry, and a second confirmation waiting behind the first. The first failed before the fix, with 0 redemptions.

### V2 — private block notes shown to customers (CONFIRMED, FIXED)

**Where.** PR #71 and OQ-WP10F-02.

**The defect.** Until PR #71 the Web Admin's hint under the block-reason field read «این یادداشت برای اپراتور است و هرگز به مشتری نشان داده نمی‌شود» ("this note is for the operator and is never shown to the customer"). PR #71 showed every stored reason to the blocked customer, including every note written under that promise. An upgrade would have published those notes to the customers they describe.

**The fix.** Migration `0118_customer_block_reason_shown` adds `customers.blocked_reason_shown boolean NOT NULL DEFAULT false`. It is additive, and every existing row gets FALSE.

- **Writer.** The repository's block sets the flag when it stores a reason. Every caller now writes under copy that says the customer sees the reason. An unblock clears it.
- **Reader.** `blockedReply` shows a reason only when the flag is TRUE.
- **No CHECK.** None ties the flag to status or reason, because the previous release's unblock does not know the column and `botctl rollback` keeps this schema.

**Tests:**

- unit: the flag is FALSE → `bot.blocked`;
- integration: a row written as the previous release wrote it stays private;
- integration: a new block is marked, and an unblock clears the mark.

**Rolling-window edge, accepted.** During a rolling update the previous release's replica can unblock a customer (leaving a stale TRUE) and then block the same customer again with a note written under the old "never shown" copy. That note would then be shown. It needs two operator actions on one customer inside a minutes-long window, with the old Web UI.

**Historic rejection notes were checked and are safe.** `PaymentRepository.rejectionReasonFor` reads only an administrator-resolved rejection. The only surface that ever rejected was Telegram, whose pre-reason note is filtered, and the Web Admin has no reject.

### V3 — a reason capture after a lost permission (NOT release-blocking; recorded)

An administrator whose `receipts.review` (or `users.block`) is revoked while their reason capture is open gets a denial for typed text until the capture's 5-minute TTL closes it. This fails closed: no decision is taken, and nothing is swallowed silently, because the denial is answered.

Proposed follow-up: check the permission before `findAwaitingReason` and answer `NO_CAPTURE`, so the text routes normally.

### V4 — a push delivered late in a long batch recorded UNKNOWN (NOT release-blocking; recorded)

`claimDue` leases a whole batch for `RECEIPT_PUSH_LEASE_MS` (2 min), and the batch sends one row at a time. A row whose send starts after its lease has expired is reap-eligible while in flight. Another replica's reaper can mark it `UNKNOWN`, and open `payments.receipt_push_failed`, although the administrator receives it.

It is never sent twice: `markSendStarted` is conditional, and UNKNOWN is never resent. The effect is a false operator alert, not a duplicate and not money.

Proposed follow-up: `markSendStarted` sets `next_attempt_at = now + lease`.

### V5 — (PR #70) recorded in `docs/wp10-followup-audit.md`; nothing new found

### Also read, nothing release-blocking found

The audit pass that produced V1–V5 also read these areas and found nothing release-blocking:

- tenant scoping in the repositories added by #68–#71;
- permission charging on their write paths;
- the idempotency of the push, capture and credit paths;
- the #71 migrations (0116, 0117), which are additive.

The product questions it met in the referral and reseller packages (#68, #69) are the ones already recorded as OQ-WP9-01…05. They are owner decisions, not defects, and nothing here changes them.

## Deferred and known, not changed here

- **OQ-WP10F-03.** A mandatory reason on every block. OPEN.
- **Duration.** `DURATION_DAYS` renders as a bare number, with `0` for unlimited, in bot text (e.g. «مدت: 30»). This is a presentation follow-up of the same shape as §3.
- **V3 and V4.** Above, with proposed one-line fixes.
- **Other `WEB` namespaces.** The remaining hard-coded `'WEB'` idempotency namespaces are Web-only services today (§2).
- **OQ-WP9-01…05.** The referral and reseller owner decisions, unchanged.
