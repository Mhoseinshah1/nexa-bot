# WP14 reseller phase 2 — falsification record

Each rule reverted ALONE against the integration branch, the named test file run (the
integration ones against a freshly created test database), and the file restored
byte-for-byte; the driver refuses to continue if `git diff` of the mutated file is not empty.

R14-11 and R14-12 are the P2 from the read-only hostile review of this package: the WP12
report derived credit in use a second way. R14-13 to R14-16 hold the Web Admin's wiring of
each reseller read to its own key and the edit form's credit gate; their tests were added
in this pass and each mutation was re-run here.

**Five rows are retired, not corrected (owner decision, 2026-10-01).** `R14-02` (the credit
view's allowance per currency), `R14-09` and `R14-10` (the Web Admin's debt
acknowledgement), `R14-12` (the report's effective limit) and `R14-16` (the edit form's
credit read) each held a rule of the reseller credit line the owner removed
(`docs/reseller-phase3-closure.md` §5). The allowance is zero, the report names no limit,
and the form neither offers a limit nor reads a balance, so there is nothing for those
rules to hold. `R14-11` keeps its rule — the debt is read in the SELLING currency — under
its test's new name; its mutation (the balance read in the stored limit's currency) was
re-run against that test and still dies.

| #      | rule                                                                                                                                        | tests that die                                                                                                                                                                                                                | result |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| R14-01 | Credit in use (debt) is the negative part of the balance only: a positive balance shows zero credit in use                                  | `reseller-credit.test.ts` › reads a positive balance as no credit in use                                                                                                                                                      | KILLED |
| R14-03 | Purchase history reads the frozen order_reseller_terms snapshot (R9), never the live tier: mutation reads the tier name from reseller_tiers | `reseller-phase2-http.test.ts` › lists the purchase as confirmation recorded it, survives a tier re-price and rename, and omits the margin                                                                                    | KILLED |
| R14-04 | Change history returns only rows of THIS entity (entity_id filter): one reseller never sees another reseller's or another tier's history    | `reseller-phase2-http.test.ts` › returns a tier’s own audited changes and never another tier’s; `reseller-phase2-http.test.ts` › returns exactly this reseller’s audited changes, newest first, without IP or user agent      | KILLED |
| R14-05 | Change history returns only the reseller.* / reseller_tier.* actions on the entity, nothing else recorded against the customer              | `reseller-phase2-http.test.ts` › returns exactly this reseller’s audited changes, newest first, without IP or user agent                                                                                                      | KILLED |
| R14-06 | GET /resellers/:id/credit charges users.view (the balance is the customer wallet) in addition to resellers.view                             | `reseller-phase2-http.test.ts` › charges resellers.view and the extra key each view needs, on every new route                                                                                                                 | KILLED |
| R14-07 | GET /resellers/:id/purchases 404s a customer who is not a reseller IN THIS TENANT (tenant-scoped existence check before listing)            | `reseller-phase2-http.test.ts` › shows tenant B nothing of tenant A’s credit, purchases or history, and 404s an unknown id                                                                                                    | KILLED |
| R14-08 | Web: the credit card never requests the credit route without users.view                                                                     | `reseller-standing.test.tsx` › asks for each view only with its key, and names the key otherwise                                                                                                                              | KILLED |
| R14-11 | The report's credit figures come from the one derivation: the balance read in the SELLING currency (not the limit's)                        | `reports.test.ts` › reports a legacy debt exactly as the balance card derives it, whatever limit is stored                                                                                                                    | KILLED |
| R14-13 | The reseller route asks for the credit view on users.view (app.tsx wiring)                                                                  | `reseller-standing.test.tsx` › asks for none of the three views on resellers.view alone, and names each key; `reseller-standing.test.tsx` › lets an editor without users.view save a suspension without asking for the credit | KILLED |
| R14-14 | The reseller route asks for the purchases view on orders.view (app.tsx wiring)                                                              | `reseller-standing.test.tsx` › asks for none of the three views on resellers.view alone, and names each key                                                                                                                   | KILLED |
| R14-15 | The reseller route asks for the history view on audit.view (app.tsx wiring)                                                                 | `reseller-standing.test.tsx` › asks for none of the three views on resellers.view alone, and names each key                                                                                                                   | KILLED |

## Held by construction, with no single line to revert

| rule                                                               | what holds it                                                                                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| the credit card and the report never disagree on a limit or a debt | both call `creditAllowanceOf` / `creditFigures` / `effectiveLimitOf` from `reseller-credit.ts`; there is no second copy of the rule to revert |
