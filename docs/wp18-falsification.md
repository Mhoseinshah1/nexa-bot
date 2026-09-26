# WP18 gateway customer fee and financial log — falsification record

Each rule was reverted alone against the WP18 branch. The named test file was then run: the
integration tests against a freshly created test database, the web and unit tests in their
own projects. Afterwards the file was restored byte-for-byte; the driver refuses to continue
if `git diff` is not empty.

The first pass left two mutations alive:

- W18-12: the failure log's `cause` was never asserted, so an operator rejection and a
  provider's verdict read the same.
- W18-17: no test replayed an event past a lost relay claim, so a dedupe key made unique
  per write went unnoticed.

A test was added for each, and both are now killed.

| #      | rule                                                                                          | tests that die                                                                                                                                      | result |
| ------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| W18-01 | The fee is `principal × bps / 10000` rounded half-up to the minor unit, in integer arithmetic | `wp18-customer-fee.test.ts` › rounds half-up to the minor unit                                                                                      | KILLED |
| W18-02 | The provider is asked for the PAYABLE (principal + fee), not the principal                    | `tonpays-gateway.test.ts` › invoices principal + fee, keeps the payment amount the principal, and settles the order at its own total                | KILLED |
| W18-03 | `payments.amount` stays the principal; the fee lives in its own snapshot columns              | `tonpays-gateway.test.ts` › invoices principal + fee, keeps the payment amount the principal, and settles the order at its own total                | KILLED |
| W18-04 | The attempt snapshots the ROUTE's rate when it is opened                                      | `tonpays-gateway.test.ts` › credits a top-up’s principal only, bases the gift on the principal, and never credits the fee                           | KILLED |
| W18-05 | `nexa_payments_confirmation_guard` freezes the three fee columns in every state               | `tonpays-gateway.test.ts` › snapshots the rate: a later change neither alters the open attempt nor the invoice it hands back                        | KILLED |
| W18-06 | `payments_customer_fee_check` holds `payable = amount + fee`                                  | `tonpays-gateway.test.ts` › holds the payable to principal + fee, and a fee only on a gateway payment, in the database too                          | KILLED |
| W18-07 | A non-zero fee is refused on a route that does not settle through a gateway                   | `tonpays-gateway.test.ts` › refuses a non-zero fee on a route that does not settle through a gateway                                                | KILLED |
| W18-08 | A route save that does not mention the fee keeps the stored rate                              | `tonpays-gateway.test.ts` › refuses a non-zero fee on a route that does not settle through a gateway                                                | KILLED |
| W18-09 | The customer is shown the principal, fee and payable lines when the fee is above zero         | `tonpays-gateway.test.ts` › invoices principal + fee, keeps the payment amount the principal, and settles the order at its own total                | KILLED |
| W18-10 | The financial log goes to the payments topic when one is configured                           | `tonpays-gateway.test.ts` › logs a gateway order payment to the payments topic with principal, fee, payable and the provider’s figure as diagnostic | KILLED |
| W18-11 | The financial log obeys `ops_notifications`; a configured chat is not consent                 | `tonpays-gateway.test.ts` › logs nothing while ops_notifications is off, even with a chat configured                                                | KILLED |
| W18-12 | A gateway failure is logged with cause `GATEWAY_FAILED`, never as an operator rejection       | `tonpays-gateway.test.ts` › logs a gateway failure and a late approval, once each                                                                   | KILLED |
| W18-13 | A late approval is logged once, when first observed                                           | `tonpays-gateway.test.ts` › logs a gateway failure and a late approval, once each                                                                   | KILLED |
| W18-14 | The automatic refund announces `RefundCompleted`                                              | `tonpays-gateway.test.ts` › logs a completed refund and a superseded one, and writes nothing when the log is not configured                         | KILLED |
| W18-15 | A superseded refund announces `RefundFailed`                                                  | `tonpays-gateway.test.ts` › logs a completed refund and a superseded one, and writes nothing when the log is not configured                         | KILLED |
| W18-16 | A top-up's gift is read from the ledger entry, never recomputed                               | `tonpays-gateway.test.ts` › logs a top-up with the principal credit, fee, total paid and gift apart                                                 | KILLED |
| W18-17 | The log dedupes on the event id, so a replay past a lost claim writes nothing new             | `tonpays-gateway.test.ts` › writes one log for an event replayed past a lost relay claim                                                            | KILLED |
| W18-18 | Web: the fee field is drawn only for a route that settles through a gateway                   | `payment-gateways.test.tsx` › draws no fee field for card-to-card, and sends no fee from that form                                                  | KILLED |
| W18-19 | Web: the typed percent reaches the server as basis points from the one parser                 | `payment-gateways.test.tsx` › reopens 525 basis points as 5.25 and saves a typed 7.5 as 750 basis points                                            | KILLED |
| W18-20 | The percent parser refuses a third decimal rather than rounding it                            | `wp18-customer-fee.test.ts` › refuses %j rather than rounding it                                                                                    | KILLED |
