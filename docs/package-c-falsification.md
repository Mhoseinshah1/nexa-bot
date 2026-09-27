# Package C (GB display) — falsification record

Each rule below was reverted against the Package C branch, and the named test file was run
in its project (unit or web). The mutations ran in a separate worktree, never the
implementation checkout, and each was reverted with `git checkout` before the next one ran.
A mutation of `packages/contracts` or `packages/i18n` rebuilds that package before its test
and again after the restore, because the tests import its `dist`. Every row is driven by
`scripts/mutate-package-c.py`, which is committed. The input half of the package is WP21's
and is falsified in `docs/wp21-falsification.md` (W21-01..W21-15).

The first pass reported one survivor, and it was the driver's error, not a gap: C-05's name
filter contained `2^53`, which `vitest -t` reads as a regular expression, so no test ran.
The filter now names the test by its other words, and the row is killed.

Every row is killed.

| #    | rule                                                                | tests that die                                                                                                                            | result |
| ---- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C-01 | The bot's traffic figure is `formatTrafficGb`, never the byte count | `unit/traffic-format.test.ts` › shows every allowance in GB, with no noisy .00                                                            | KILLED |
| C-02 | The bot's figure is grouped in thousands                            | `unit/traffic-format.test.ts` › keeps a large allowance in GB, grouped, instead of switching unit                                         | KILLED |
| C-03 | A figure is rounded to the NEAREST hundredth, not truncated         | `unit/traffic-format.test.ts` › rounds to the nearest hundredth, never truncating to a figure that is not the nearest                     | KILLED |
| C-04 | A trailing zero is dropped: `10.5`, never `10.50`                   | `unit/traffic-format.test.ts` › shows every allowance in GB, with no noisy .00                                                            | KILLED |
| C-05 | The grouping is `bigint` text, exact past 2^53                      | `unit/traffic-format.test.ts` › stays exact past 2^53, where Number would round                                                           | KILLED |
| C-06 | The Web Admin's figure is the bot's figure                          | `unit/traffic-format.test.ts` › is the Web Admin’s rule too, so one figure reads the same on both surfaces                                | KILLED |
| C-07 | The product list shows GB                                           | `web/products-and-orders.test.tsx` › shows a 10.25 GB allowance as 10.25 and a 1 TiB one as 1,024 — GB, never a switched unit (Package C) | KILLED |
| C-08 | The order line shows GB                                             | `web/products-and-orders.test.tsx` › shows the order line’s traffic in GB with its two decimals (Package C)                               | KILLED |
| C-09 | The service detail shows the limit and the used traffic in GB       | `web/services.test.tsx` › shows the limit and the used traffic in GB, never a switched unit (Package C)                                   | KILLED |
| C-10 | Zero used traffic reads «0 گیگابایت», never bytes                   | `unit/customer-screens.test.ts` › floors remaining days and remaining traffic at zero                                                     | KILLED |
