# WP21 GB traffic inputs — falsification record

Each rule was reverted against the WP21 branch, and the named test file was run:
integration files against their own test database, and the unit and web files in their
own projects. Each mutation was reverted with `git checkout` before the next one ran. A
mutation of `packages/contracts` rebuilds the package before its test and again after the
restore, because the tests import its `dist`. Every row is driven by
`scripts/mutate-wp21.py`, which is committed.

The first pass reported W21-13 and W21-14 as killed with no test output. The file they
named, `wp21-traffic-rule.test.ts`, was never run at all: the web project only includes
`*.test.tsx`, so vitest found no test and exited non-zero. The file is now
`wp21-traffic-rule.test.tsx`, and both mutations were run again against it. Both are
killed by the assertions named below.

| #      | rule                                                                                 | tests that die                                                                                                  | result |
| ------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------ |
| W21-01 | One GB is 1,073,741,824 bytes, the GiB the codebase displays, not 10^9               | `wp21-traffic-to-provider.test.ts` › asks the panel for exactly the bytes 10.25 GB converts to                  | KILLED |
| W21-02 | A hundredth is rounded to the NEAREST byte, not truncated                            | `wp21-traffic-input.test.ts` › rounds a hundredth that is not a whole number of bytes to the nearest byte       | KILLED |
| W21-03 | At most two decimals                                                                 | `products-http.test.ts` › refuses three decimals, a sign, an exponent, a comma and raw bytes (WP21)             | KILLED |
| W21-04 | No sign                                                                              | `wp21-traffic-input.test.ts` › refuses more than two decimals, a sign, an exponent and anything ambiguous       | KILLED |
| W21-05 | A stored figure reopens at its NEAREST hundredth, so a saved figure reopens as typed | `wp21-traffic-input.test.ts` › reopens a saved figure as typed                                                  | KILLED |
| W21-06 | A figure sent back as the form showed it keeps the stored bytes                      | `products-http.test.ts` › keeps a historical byte count an edit did not touch, and stores one it did (WP21)     | KILLED |
| W21-07 | Zero is never kept over a change to or from zero                                     | `wp21-traffic-input.test.ts` › never keeps a figure over a change to or from zero                               | KILLED |
| W21-08 | A product of zero traffic is refused, never read as unlimited                        | `products-http.test.ts` › stores an explicit unlimited as zero bytes, and refuses a typed zero (WP21)           | KILLED |
| W21-09 | The product update applies the untouched-figure rule                                 | `products-http.test.ts` › keeps a historical byte count an edit did not touch, and stores one it did (WP21)     | KILLED |
| W21-10 | The add-on update applies the untouched-figure rule                                  | `products-http.test.ts` › keeps an add-on’s historical byte count an edit did not touch (WP21)                  | KILLED |
| W21-11 | The product boundary converts GB to bytes with `parseTrafficGb`                      | `products-http.test.ts` › stores 10.25 GB as its exact bytes, and 0.01 GB rounded to the nearest byte (WP21)    | KILLED |
| W21-12 | The add-on boundary converts GB to bytes with `parseTrafficGb`                       | `products-http.test.ts` › takes an add-on’s traffic in GB too, and never zero (WP21)                            | KILLED |
| W21-13 | Web: unlimited is sent as null, never as zero                                        | `wp21-traffic-rule.test.tsx` › sends null, not zero, for unlimited, and the schema takes it                     | KILLED |
| W21-14 | Web: the form refuses zero, as the schema does                                       | `wp21-traffic-rule.test.tsx` › accepts exactly what the schema accepts                                          | KILLED |
| W21-15 | Web: a stored allowance reopens as its GB figure, not its bytes                      | `products-and-orders.test.tsx` › reopens a saved 10.25 GB as 10.25, and sends it back as GB, never bytes (WP21) | KILLED |
