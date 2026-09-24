# Customer UX completion falsification — the approved screens, one rule at a time

Every production rule the customer UX completion introduces, reverted one at a
time, with the committed test that fails as a result. A rule with no test is a
rule the next commit reverts silently; a test that stays green under mutation
is not a test.

The area has one failure shape and twenty ways to reach it: a customer shown
something that is not theirs, or not true. Another customer's card, a search
that reaches across customers, a route the operator switched off, a gift paid
twice, a usage figure that was never read shown as zero, a raw byte count where
a unit belongs, a subscription URL in a log line, a keyboard on the wrong half of
a split message.

Procedure, per row: apply exactly one mutation in a worktree of its own
(`/home/user/nexa-falsify`, detached at the branch head) against a database of
its own (`nexa_falsify_ux`); run only the named tests with `-t`; record KILLED
when vitest exits non-zero AND the named test is the one listed as failed;
restore the file byte-for-byte and confirm the tree is clean before the next
row. Every survivor's named test was observed green under the mutation, so a
survivor is a real gap in what the suite can see, not a broken test.

## The twenty-two

| #    | Rule                                              | Mutation                                                                                                                                   | Result | Named test                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UX01 | the QR encodes the EXACT stored subscription URL  | `delivery.service.ts` `sendCard`: `qr.encode(sentUrl)` → `qr.encode(service.providerUsername)`                                             | KILLED | `tests/unit/delivery-card.test.ts` › encodes the QR from the EXACT stored subscription URL and nothing else                                                                                                                                                               |
| UX02 | a service is read by its owner only               | `provisioning.service.ts` `getForCustomer`: the `service.customerId !== customerId` half of the guard deleted                              | KILLED | `tests/integration/customer-ux-services.test.ts` › never shows another customer’s card, by id; › cannot be asked for another customer’s service                                                                                                                           |
| UX03 | search stays within the customer's own services   | `drizzle-service.repository.ts` `searchForCustomer`: the `customerId` predicate removed                                                    | KILLED | `tests/integration/customer-ux-services.test.ts` › finds by prefix within the customer’s own services only                                                                                                                                                                |
| UX04 | a route switched off for a purpose is not offered | `gateway-selection.ts` `allowsPurpose`: body → `return true`                                                                               | KILLED | `tests/integration/payment-gateway-purposes.test.ts` › filters by the purpose switches, each on its own; › refuses a route switched off for top-up; `tests/integration/customer-ux-payments.test.ts` › offers no route that is not allowed for top-up, and says so        |
| UX05 | a receipt credit earns no top-up gift             | `receipt-disposition.service.ts` `creditToWallet`: a second append, `CASHBACK_TOPUP` for a tenth of the amount                             | KILLED | `tests/integration/receipt-dispositions.test.ts` › earns no top-up gift: a credited top-up receipt is not a top-up                                                                                                                                                        |
| UX06 | a gift side is claimed once                       | `drizzle-referral-signup-gift.repository.ts` `claimSide`: the `IS NULL` predicate on the side's `claimed_at` removed from the UPDATE       | KILLED | `tests/integration/referral-signup-gift.test.ts` › replays the same key with the first result and credits nothing more on a new key; › yields exactly one entry per side under two CONCURRENT claims by the same customer                                                 |
| UX09 | the wallet summary is the tapping customer's      | `drizzle-wallet.repository.ts` `balanceOf`: the `customerId` predicate removed                                                             | KILLED | `tests/integration/customer-ux-payments.test.ts` › renders the approved account summary from the customer’s OWN rows                                                                                                                                                      |
| UX10 | add-traffic applies once on replay                | `provisioning.service.ts` `planCommercialAction`: the operation id suffixed with the clock, so a replay plans a second operation           | KILLED | `tests/integration/rickpanel-management.test.ts` › adds traffic without touching the expiry, and adds time without touching the traffic; › converges when a renewal was applied and its answer lost: the replay sets, it does not add                                     |
| UX11 | renewal applies once on replay                    | same line as UX10                                                                                                                          | KILLED | `tests/integration/rickpanel-management.test.ts` › renews: charged once, applied once, and Nexa and the panel agree                                                                                                                                                       |
| UX12 | an unsupported action is not rendered             | `bot-runtime.ts` `serviceDetail`: the suspend button pushed whether or not `actions` includes `SUSPEND`                                    | KILLED | `tests/integration/customer-ux-services.test.ts` › shows the switch-on button, not the switch-off one, for a suspended service                                                                                                                                            |
| UX13 | FAQ rows are the tenant's                         | `drizzle-support-faq.repository.ts` `list`: the tenant predicate removed                                                                   | KILLED | `tests/integration/support-faq.test.ts` › keeps one tenant’s FAQ invisible and unreachable from the other                                                                                                                                                                 |
| UX14 | the support destination is this tenant's          | `support-screen.reader.ts` `screenFor`: `support.accounts` read under the first scope the reader ever saw, not the caller's                | KILLED | `tests/integration/support-faq.test.ts` › takes the support URL from THIS tenant’s support.accounts                                                                                                                                                                       |
| UX15 | display data is never routing                     | `drizzle-order.repository.ts` `create`: `panel_id` overwritten with the tenant panel whose host appears in the product's display locations | KILLED | `tests/integration/products-display.test.ts` › provisions on the panel_id panel when the display locations name another panel’s host                                                                                                                                      |
| UX16 | no raw byte figure reaches a customer             | `customer-screens.ts` `serviceCard`: `trafficBytes` passed as a string of the integer rather than the typed value                          | KILLED | `tests/unit/customer-screens.test.ts` › renders the approved lines, in order, from the rows                                                                                                                                                                               |
| UX17 | unread usage is a word, never 0                   | `customer-screens.ts` `serviceCard`: `known = facts.usageSyncedAt !== null` → `known = true`                                               | KILLED | `tests/unit/customer-screens.test.ts` › never turns an unread usage into 0, and never claims never-connected for an unsupported field; `tests/integration/customer-ux-services.test.ts` › keeps unlimited and unread apart from zero                                      |
| UX18 | a subscription URL never reaches a log            | `redaction.ts`: `subscription` removed from `SENSITIVE_FRAGMENTS`                                                                          | KILLED | `tests/unit/secrets-and-ids.test.ts` › redacts a subscription URL and reference by key, wherever they sit                                                                                                                                                                 |
| UX19 | a stale capture consumes nothing                  | `customer-capture.service.ts` `readText`: the `EXPIRED` branch deleted                                                                     | KILLED | `tests/integration/customer-ux-payments.test.ts` › an amount typed with no window open is not a top-up, and a window past its deadline reads nothing                                                                                                                      |
| UX20 | a terminal FAILED request is answered once        | `operation-outcome-announcer.ts` `announce`: `terminalFailure` → `false`                                                                   | KILLED | `tests/unit/operation-outcome-announcer.test.ts` › answers a usage read the CUSTOMER asked for, and a terminal failure of it                                                                                                                                              |
| UX21 | a wallet tap on a short balance confirms nothing  | `bot-runtime.ts` `walletPayment`: the balance pre-check deleted, so `confirmDraft` runs first                                              | KILLED | `tests/integration/customer-ux-payments.test.ts` › names the shortfall, offers the top-up, and confirms NOTHING when the balance is short                                                                                                                                 |
| UX22 | the pre-invoice keyboard sits on the LAST part    | `telegram-customer-messenger.ts` split send: `last = index === sequence.length - 1` → `last = index === 0`                                 | KILLED | `tests/unit/telegram-messenger-parts.test.ts` › goes out as several parts in order, buttons and keyboard on the last only; `tests/integration/customer-ux-payments.test.ts` › splits a long pre-invoice at section boundaries and puts the keyboard on the last part only |

Two rows the plan listed are held by a mechanism rather than by a mutation a test
can see, and are declared rather than dropped:

| #    | Rule                          | What was tried                                                                                                                                                                                       | What holds it                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UX07 | no self-referral              | the `SELF_REFERRAL` refusal in `attributeOnArrival` AND the `referrerId !== refereeId` re-check in the gift claim both deleted; `referrals.test.ts` (_makes self-referral impossible…_) stayed green | a customer's own link is a RETURNING arrival, refused `ALREADY_REGISTERED` before any code is resolved, and the database CHECK `referrals_not_self_check` refuses a self row written any other way. Neither code branch is reachable from a test; both are kept as the re-check the in-source comment already calls unreachable                                                                      |
| UX08 | gift claims are tenant-scoped | the tenant predicate removed from `openSides`; `referral-signup-gift.test.ts` (_never credits tenant B's referral through tenant A's claim…_) stayed green                                           | the claim path locks through `lockReferralsOf`, which keeps its own tenant predicate, and `openSides` is already bounded by the customer id — the same Telegram user is a different customer row in each tenant. The predicate stays: a query that names its tenant is the convention, and one that relies on an id's uniqueness across tenants is the kind of query that is right until a migration |

## What the pass changed

UX06 did not kill on the first attempt. `claim` read the gift row under the
referral's lock and skipped a side whose `claimed_at` was set BEFORE calling
`claimSide`, whose conditional UPDATE names the same predicate. With both
present the suite stayed green when either was reverted alone — the read masked
the write and the write masked the read — and killed only when both went. The
same shape as Phase 6C's F6C-03: a read issued before a conditional write is an
optimisation wearing a rule's clothes.

The conditional UPDATE is the half that survives concurrency — two claims from
two replicas serialise on the referral lock, and the second sees zero rows —
so the pre-read is gone and the row above is the repository predicate alone,
which now kills. `amount <= 0n` stays in the service: a zero share is refused
before an entry id is drawn, which is a rule about what is owed, not about
whether it was paid.

UX03b, the tenant predicate in the same `searchForCustomer` the row UX03
mutates, survived as predicted: a customer id is a UUIDv7 unique across
tenants, so the customer predicate alone bounds the rows for any fixture the
suite can build. It is recorded here rather than in a row because it is not a
gap a test can close — there is no way to give one customer id service rows in
two tenants — and the predicate stays for the reason UX08 gives.

## Two things the pass established rather than assumed

- **UX15 died a step earlier than the plan expected.** The decoy panel the
  display locations named was refused `PANEL_NOT_ELIGIBLE` at confirmation
  before the test's own `panel_id` assertion ran: an order routed by display
  text meets the eligibility gate first. The named test failed either way; the
  order in which the two defences fire is now on record.
- **`traffic-format.test.ts` cannot see UX16.** It tests the formatters
  directly and stayed green while the card passed a raw string through; the kill
  came from the screen composer's own test. A formatter test proves a formatter,
  not that the value reached it.
