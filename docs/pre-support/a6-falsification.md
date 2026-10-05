# Pre-support A6 — falsification record

Item: the service location a customer is told (audit section 2, "A6"). PO default applied:
`serviceLocation = service.locationLabel ?? <label of the initial service_locations row of the
service's CURRENT panel> ?? product.serviceLocationLabel ?? null`, on the service card and on
the delivery card alike, through one function (`displayedServiceLocation`). No schema change,
no contract change.

Driver: `scripts/mutate-a6.py`. Each mutation reverts one rule, runs the named test, and
restores the file byte for byte. A mutant counts as killed only if the named test RAN and
failed. Run on 2026-10-05 against a dedicated integration database (`nexa_test_w1e`).

| ID    | Rule reverted                                                              | Test that failed                                                                 | Result |
| ----- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| A6-01 | The moved label wins over the panel's initial label (order swapped)        | moved label, then the panel initial label, then the product label … (unit)       | KILLED |
| A6-02 | The panel's initial label wins over the product label (order swapped)      | names the sibling panel's location for a service balanced onto it, on both cards | KILLED |
| A6-03 | The product label is the last fallback (dropped)                           | falls back to the product's label when the panel has no initial location         | KILLED |
| A6-04 | Only the panel-wide initial row is the panel's location (product rows too) | reads only the panel-wide INITIAL row as the panel's location (unit)             | KILLED |
| A6-09 | The moved label is honoured at all (ignored)                               | names where a moved service was moved to, over its panel and its product         | KILLED |
| A6-05 | The service card reads the CURRENT panel's initial label (read removed)    | names the sibling panel's location … on both cards                               | KILLED |
| A6-06 | The delivery card reads it too (read removed)                              | names the sibling panel's location … on both cards                               | KILLED |
| A6-07 | The runtime is wired to the label source (wiring removed)                  | names the sibling panel's location … on both cards                               | KILLED |
| A6-08 | The label, never the location key, is shown (key returned instead)         | never shows an internal panel or provider identifier                             | KILLED |

9 of 9 killed.

A finding while writing the driver: A6-01 first SURVIVED its integration test, because both
callers pass `null` for the panel label once a service has moved (they skip the read), so the
swapped order cannot be observed end to end. The unit test over the pure function is what pins
the order; A6-09 is the integration mutant for "the moved label is honoured".
