# Package D (custom service) — falsification record

Each rule below was reverted against the Package D branch, and the named test was run:

- **Unit files** ran in the unit project.
- **The integration file** ran against its own test database (`nexa_dmut`) and Redis
  database (14), because the suite truncates between tests.

The mutations ran in a separate worktree, never the implementation checkout. Each was
reverted with `git checkout` before the next one ran. Every row is driven by
`scripts/mutate-package-d.py`, which is committed.

The first pass left two mutations alive. Each was a real gap in a test, now closed.

- **D-10.** The two concurrent overlapping creates raced with nothing holding them
  together, so the race depended on scheduling. It passed with the write lock made
  SHARED. The test now holds the rules' lock from outside until `pg_locks` shows both
  creates waiting on it, then releases it. With a shared lock, both creates read an empty
  table and both insert.
- **D-17.** Confirmation compares the rule id the quote named. The only case exercised,
  a more specific rule appearing, also changed the level, so dropping the id comparison
  changed nothing. The test now deletes the rule and recreates an identical one: same
  level, same price, another id. That is refused.

D-32's first anchor matched two queries. It now names the location lookup alone.

The database-held rules are exercised directly by SQL in the integration file rather than
mutated, because a mutation would need a second migration:

- `orders_product_purpose_check`;
- the frozen-terms trigger;
- the arithmetic CHECKs on `order_custom_service_terms`.

The one Codex review of PR #88 found three defects, and each fix has its own rows, D-33..D-37. Every row, D-01..D-37, was then re-run against the fixed code. D-24 now mutates `FIRST_PURCHASE_PURPOSES`, the one list the first-purchase query and the lock both read.

Every row is killed.

| #    | rule                                                                              | tests that die                                                                                                                                   | result |
| ---- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| D-01 | Two matching rules at one level are AMBIGUOUS, never the first one                | `unit/custom-service-pricing.test.ts` › refuses two matching rules at one level rather than summing or choosing one                              | KILLED |
| D-02 | A tier rule prices only its own tier; null is the ordinary customers              | `unit/custom-service-pricing.test.ts` › never prices a reseller by the ordinary customers’ rules, nor an ordinary customer by a tier’s           | KILLED |
| D-03 | A range is inclusive at both ends                                                 | `unit/custom-service-pricing.test.ts` › treats both bounds as inclusive, and nothing outside them                                                | KILLED |
| D-04 | The volume price is rounded half up to the minor unit                             | `unit/custom-service-pricing.test.ts` › rounds the volume price to the minor unit, half up, and only there                                       | KILLED |
| D-05 | A rule in another currency than `sales.currency` cannot price                     | `unit/custom-service-pricing.test.ts` › is unavailable when a rule is in another currency than the sales currency                                | KILLED |
| D-06 | Only ENABLED rules overlap                                                        | `unit/custom-service-pricing.test.ts` › admits an adjacent range, another level, another panel, another dimension and a disabled rule            | KILLED |
| D-07 | Overlap is per panel: another panel is another key                                | `unit/custom-service-pricing.test.ts` › admits an adjacent range, another level, another panel, another dimension and a disabled rule            | KILLED |
| D-08 | A create refuses an overlapping enabled range                                     | `integration/custom-service.test.ts` › refuses an overlapping enabled range at the same specificity, and names the other rule                    | KILLED |
| D-09 | An edit that enables an overlapping rule is refused                               | `integration/custom-service.test.ts` › refuses to ENABLE a disabled rule that overlaps an enabled one                                            | KILLED |
| D-10 | The write lock is EXCLUSIVE, so concurrent creates serialise                      | `integration/custom-service.test.ts` › serialises two concurrent overlapping creates: exactly one wins                                           | KILLED |
| D-11 | A rule is priced in `sales.currency`, never a client figure                       | `integration/custom-service.test.ts` › prices a rule in the sales currency, never one the client names                                           | KILLED |
| D-12 | A disabled location is not offered                                                | `integration/custom-service.test.ts` › is unavailable on a location that is not offered, and on a panel that cannot sell                         | KILLED |
| D-13 | A panel that cannot sell is not priced                                            | `integration/custom-service.test.ts` › is unavailable on a location that is not offered, and on a panel that cannot sell                         | KILLED |
| D-14 | An ACTIVE reseller is priced at their tier                                        | `integration/custom-service.test.ts` › prices an ACTIVE reseller by their tier’s rules, with no reseller layer on top                            | KILLED |
| D-15 | No reseller layer on top of a custom price                                        | `integration/custom-service.test.ts` › prices an ACTIVE reseller by their tier’s rules, with no reseller layer on top                            | KILLED |
| D-16 | Confirmation re-decides the terms under the order lock                            | `integration/custom-service.test.ts` › refuses a confirmation whose rule was re-priced since the quote, and never re-prices it                   | KILLED |
| D-17 | Confirmation compares the RULE the quote named, not only its level and price      | `integration/custom-service.test.ts` › refuses a confirmation when a more specific rule now applies, or the location was withdrawn               | KILLED |
| D-18 | Confirmation refuses while the flag is off                                        | `integration/custom-service.test.ts` › refuses a confirmation while the feature is off                                                           | KILLED |
| D-19 | A draft refuses while the flag is off                                             | `integration/custom-service.test.ts` › refuses while the feature is off (D1)                                                                     | KILLED |
| D-20 | The draft closes the days window in its own transaction                           | `integration/custom-service.test.ts` › reads the volume, keeps the window open on a bad figure, carries the volume to the days window and drafts | KILLED |
| D-21 | The two figure windows stay open on a refused figure                              | `integration/custom-service.test.ts` › reads the volume, keeps the window open on a bad figure, carries the volume to the days window and drafts | KILLED |
| D-22 | A code may be entered on a custom draft                                           | `integration/custom-service.test.ts` › applies a code that names CUSTOM_SERVICE, re-quoting from the frozen terms                                | KILLED |
| D-23 | A code re-quotes a custom draft from its own frozen terms                         | `integration/custom-service.test.ts` › applies a code that names CUSTOM_SERVICE, re-quoting from the frozen terms                                | KILLED |
| D-24 | A live custom order counts as a purchase for first-purchase                       | `integration/custom-service.test.ts` › counts a live custom order as a purchase, so the customer is no longer a first-time buyer                 | KILLED |
| D-25 | No extension button is offered for a product-less service                         | `integration/custom-service.test.ts` › refuses to renew or extend a custom service (OQ-PKG-D-01)                                                 | KILLED |
| D-26 | Renewing or extending a custom service is refused `CUSTOM_SERVICE_NOT_EXTENDABLE` | `integration/custom-service.test.ts` › refuses to renew or extend a custom service (OQ-PKG-D-01)                                                 | KILLED |
| D-27 | A custom order is delivered by PROVISION, which earns its cashback                | `integration/custom-service.test.ts` › promises cashback at confirmation and earns it at delivery                                                | KILLED |
| D-28 | `recordPurchase` writes no reseller terms for a custom order                      | `integration/custom-service.test.ts` › prices an ACTIVE reseller by their tier’s rules, with no reseller layer on top                            | KILLED |
| D-29 | A paid custom service is a refund request's source                                | `integration/custom-service.test.ts` › lets a paid custom service be the source of a refund request                                              | KILLED |
| D-30 | The receipt card names the username a custom order reserved                       | `integration/custom-service.test.ts` › names the reserved username on the operator’s receipt card for a custom order                             | KILLED |
| D-31 | A volume no rule prices is refused before the days are asked                      | `integration/custom-service.test.ts` › refuses a volume no rule prices before asking for the days                                                | KILLED |
| D-32 | A location is read in the caller's tenant only                                    | `integration/custom-service.test.ts` › never lets another tenant’s customer buy on this tenant’s location                                        | KILLED |
| D-33 | An undiscounted purchase confirmation takes the first-purchase lock               | `integration/custom-service.test.ts` › queues an undiscounted custom confirmation on the first-purchase lock                                     | KILLED |
| D-34 | A discounted purchase confirmation takes it too, not only a first-purchase rule's | `integration/custom-service.test.ts` › queues a discounted custom confirmation on the first-purchase lock too                                    | KILLED |
| D-35 | Confirmation's terms check leaves panel eligibility to `panelSales.acquire`       | `integration/custom-service.test.ts` › answers a panel that filled up after the quote as unavailable, never as a price change (Codex, PR #88)    | KILLED |
| D-36 | A rule's price across its range is refused past the ceiling, at the field         | `integration/custom-service.test.ts` › refuses a price that cannot be carried across its range, as a field error (Codex, PR #88)                 | KILLED |
| D-37 | The ceiling admits exactly its bound                                              | `unit/custom-service-pricing.test.ts` › admits exactly the ceiling and refuses one minor unit past it                                            | KILLED |
