# TB9 — falsification record

Driver: `scripts/mutate-tb9.py`. Each mutation reverts one rule, runs the named test, and
restores the file byte for byte. Run on 2026-10-05 against a dedicated integration database
(`nexa_test_tb89`).

| ID     | Rule reverted                                                                            | Test that failed                                                                         | Result |
| ------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------ |
| TB9-01 | An article edited since the last build apply is a CONFLICT, not an UPDATE                | CONFLICT when the source changed AND the article was edited … (unit)                     | KILLED |
| TB9-02 | A source as last built (or acknowledged) is UNCHANGED                                    | apply publishes, is idempotent and audited; a build with no changes is all UNCHANGED     | KILLED |
| TB9-03 | A retired article is never brought back                                                  | a retired article is never brought back (unit)                                           | KILLED |
| TB9-04 | An UPDATE rewrites only from the revision the build saw                                  | an article edited AFTER the build is never overwritten                                   | KILLED |
| TB9-05 | Apply never applies a CONFLICT (the apply filter and the `unedited` predicate, together) | an article a reviewer edited is a CONFLICT: apply-all never overwrites it                | KILLED |
| TB9-06 | A superseded build applies nothing                                                       | a superseded build applies nothing                                                       | KILLED |
| TB9-07 | A run supersedes the open build (one OPEN build per tenant)                              | a superseded build applies nothing                                                       | KILLED |
| TB9-08 | The apply's idempotent replay                                                            | apply publishes, is idempotent and audited …                                             | KILLED |
| TB9-09 | Run, apply and resolve charge `support_knowledge.review`                                 | permissions: support may view the build but not run or apply it                          | KILLED |
| TB9-10 | KEEP_CURRENT acknowledges the source hash                                                | an article a reviewer edited is a CONFLICT … (UNCHANGED next time)                       | KILLED |
| TB9-11 | An applied UPDATE becomes the new built revision                                         | a changed source is an UPDATE and a new revision                                         | KILLED |
| TB9-12 | Products: audience `EVERYONE` only (no reseller-only or hidden product)                  | no secret, internal, price or reseller field appears in any proposal                     | KILLED |
| TB9-13 | Products: never the price                                                                | no secret, internal, price or reseller field appears in any proposal                     | KILLED |
| TB9-14 | Payment instructions with a placeholder are skipped                                      | every item is an allowlisted type, and no secret, price or internal field appears (unit) | KILLED |
| TB9-15 | The TB3 context reads a built FAQ entry once                                             | the TB3 context carries a built FAQ entry once, as knowledge                             | KILLED |
| TB9-16 | «Apply all» names no proposal (web)                                                      | apply all names no proposal; a single apply names exactly one                            | KILLED |
| TB9-17 | A conflict offers only the two explicit choices (web)                                    | a conflict offers only the two explicit choices, never an apply                          | KILLED |

**17 of 17 killed.**

Notes:

- **TB9-05 is a pair, on purpose.** A CONFLICT is refused twice: the apply filter takes only
  ADD and UPDATE, and the rewrite of an UPDATE requires `built_revision = base_revision`.
  Reverting the filter alone survives: the conditional rewrite then finds the edited article
  and leaves it alone.
- **TB9-11 needed a stronger test.** The first version of "a changed source is an UPDATE"
  checked only the body and the revision rows; without `built_revision` advancing, the NEXT
  source change would have been a CONFLICT. The test now changes the source a second time and
  expects an UPDATE (committed as its own test change).
- **Not mutated:** the per-source and per-build bounds (no test builds 100 items), the ADD
  path's "an article appeared for this source meanwhile" check (a race no test stages), and the
  partial unique index on open builds (SQL; TB9-07 shows the run's own supersede is required).
