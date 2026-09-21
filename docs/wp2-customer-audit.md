# Work Package 2 — customer management: what already exists

Written before any code, against `main` at `1b51b09` (the commit that merged
WP1). Every row below was read in the file it names; nothing here is inferred
from a button's absence.

## The finding that shapes this package

**This is the mirror image of WP1.** There the backend was nearly complete and
the surface nearly empty. Here the Web Admin surface is real — a list with
search and paging, a detail page, block and unblock, a wallet card — and the
CAPABILITY is thin: `CustomerService` has four public methods, and the HTTP
surface is four routes.

And there is **no Telegram administrator section for customers at all**. Every
one of the `ADMIN_*` intents concerns receipts, administrators, services,
panels, username policy or reminders. The only customer call the whole Telegram
surface makes is `customers.resolveFromUpdate` on the inbound webhook — identity
resolution, not an operator capability.

Two docblocks explaining absences have gone **stale**, which is its own finding:
`users.tsx` says it shows no order history and no service list "because none of
those entities exists in this release", and `customers.controller.ts` says the
same of the summary shape. Orders arrived in Phase 4B and services in 4D/4E.
The reason those columns are missing stopped being true two phases ago.

## The classification

| #   | Requested                                     | State                   | Evidence                                                                                                                                                                                                  |
| --- | --------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Resolve a customer from a Telegram update     | **existing**            | `customer.service.ts:134` `resolveFromUpdate`, charged `maintenance.run`, replayed by update key, single-statement upsert rather than a lock                                                              |
| 2   | Customer list with search and paging          | **existing**            | `:319` `list`; `users.view` always, `users.search` only when a telegram id or username prefix is present (`:330`); keyset page, index-served prefix                                                       |
| 3   | Customer detail                               | **existing**            | `:303` `get`; `GET users/:id`; `users.tsx:451` renders identity, access and wallet                                                                                                                        |
| 4   | Block and unblock                             | **existing**            | `:372`/`:390` over one `setStatus` (`:414`); conditional `WHERE status = from`; reason stored on block and cleared on unblock                                                                             |
| 5   | Wallet credit and debit on a customer         | **existing**            | `wallet.controller.ts`; `users.tsx:679` `WalletCard`, gated on `users.wallet.credit` / `users.wallet.debit`                                                                                               |
| 6   | **A customer's orders on the detail page**    | **missing, and stale**  | `users.tsx:47-60` says the entities do not exist. Orders exist since 4B (`orders.controller.ts`), services since 4D/4E                                                                                    |
| 7   | **A customer's services on the detail page**  | **missing, and stale**  | Same docblock, same answer                                                                                                                                                                                |
| 8   | **Telegram Admin customer section**           | **missing**             | No `ADMIN_*` intent concerns a customer (`bot-runtime.ts:150-242`). `customer.service.ts:352` anticipates it: validation lives in the service "so a Telegram admin surface added later inherits the rule" |
| 9   | `users.edit`                                  | **declared, uncharged** | `permissions.ts:47`, seeded to `operator` (`:231`), charged by nothing anywhere                                                                                                                           |
| 10  | `users.tier.change`                           | **Phase 7**             | `permissions.ts:49`. No tier column, no tier type, no tier surface                                                                                                                                        |
| 11  | `users.wallet.mass`                           | **Phase 7**             | `permissions.ts:53`. No mass tool anywhere                                                                                                                                                                |
| 12  | `CustomerRepository.findByTelegramId`         | **dead**                | `ports.ts:127`, impl `drizzle-customer.repository.ts:154`. Zero callers in `apps/`, `packages/` or `tests/`                                                                                               |
| 13  | Per-user discount, commission, gateway hiding | **Phase 7**             | Evidenced by the research (UBR-004, UBR-007, UBR-008) and forbidden here without an explicit instruction                                                                                                  |
| 14  | Reseller lifecycle and expiry                 | **Phase 7**             | UBR-013, UBR-014, UBR-019                                                                                                                                                                                 |
| 15  | Mass wallet credit / mass volume grant        | **Phase 7, and worse**  | UBR-020 calls it "the single most dangerous control found anywhere in MirzaBot": no preview, no affected count, no confirmation, no undo                                                                  |

## What this package will therefore do

1. **A customer's orders and services on the detail page.** The stale docblocks
   become a real section. Both entities exist and both already have read paths.
2. **The Telegram administrator customer section** — list, search by numeric id,
   detail, block and unblock, permission-aware. The service already validates
   ids "so a Telegram admin surface added later inherits the rule"; this is that
   surface.
3. **Remove `findByTelegramId`**, or give it its one caller. Dead code on a port
   is a promise nothing keeps.
4. **Record `users.edit` honestly.** It is declared, seeded and charged by
   nothing. Every field on a customer comes FROM Telegram and is overwritten on
   the next update, so there is nothing an operator could edit that would
   survive — which is a product answer, not an oversight, and it belongs written
   down rather than left as a permission that looks unimplemented.

## Explicitly out of scope, and why

Everything in rows 10, 11, 13, 14 and 15 is **Phase 7** — discounts, referral,
cashback, affiliate, resellers and promotions — which `CLAUDE.md` forbids
without an explicit instruction. The research evidences all of it in the legacy
system, and evidence is not authorisation.

The two mass tools deserve their own sentence. The research executed one
end-to-end and recorded that the flow is `amount → tier → purchase filter →
notify`, that it commits on the notification answer with no separate
confirmation, that `لغو عملیات` cancels the broadcast and **not** the credit,
and that no affected count is shown at any step — so a one-account run and a
197,000-account run look identical. If they are ever built here they need the
ADR-0010 shape: dry run, affected count, typed confirmation, audited execution.
Not in this package.

## Evidence gaps

`docs/research/.../user-management-knowledge/MASTER.md:30-37` records the bundle
as IN PROGRESS with "UNKNOWN_AREAS = Everything, pending investigation". That
header is stale relative to `business-rules.md`, which holds 23 rules most of
them VERIFIED_BY_UI — but 19 open `UNK-UM-*` items remain, and
`telegram-customer-crossmap.md` is a three-line NOT_STARTED placeholder. So
there is no evidenced Telegram↔customer crossmap at all: the section this
package builds is designed from the Web Admin's own behaviour and this product's
permissions, not from an observed legacy screen.

Nothing here depends on a provider, a network or a running panel, so nothing is
blocked the way real-panel acceptance is.
