# WP19 customer service refund request — falsification record

Each rule was reverted against the WP19 branch and the named test file was run: the
integration file against its own test database, the web file in its project. Each mutation
was reverted with `git checkout` before the next one ran. The integration rows are
driven by `scripts/mutate-wp19.py`, which is committed. The three web rows were reverted by
hand, one at a time.

The first pass left six mutations alive.

- **W19-02.** No test ever reached an UNKNOWN deletion: a 5xx on an idempotent DELETE is
  retried, not lost. A test now forces the operation to UNKNOWN and asserts that the sweep
  neither credits nor releases.
- **W19-05, W19-06, W19-11, W19-14.** Each reverted one of two guards, and the other one
  decided:
  - W19-05, W19-14: the service's early state check, backed by the repository's
    conditional UPDATE naming `OPEN`;
  - W19-06: the zero check, backed by `refundFitsWithin`;
  - W19-11: the pre-read for an open request, backed by the partial unique index with
    `ON CONFLICT DO NOTHING`.

  Each pair was reverted together (the `b` rows below), and each test dies.

- **W19-18** survives by design. The approval's operation key names the request, but a
  second approval never reaches the planner with a different key. The request is no longer
  OPEN, and `planWithin` answers any open `TERMINATE` for the service before it reads a
  key. The key is a label, not a rule, and no test is cited for it.

| #       | rule                                                                                               | tests that die                                                                                                                                 | result |
| ------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| W19-01  | A SUCCEEDED deletion whose service is not TERMINATED credits nothing                               | `service-refund-requests.test.ts` › credits nothing when a deletion reads SUCCEEDED but the service did not move                               | KILLED |
| W19-02  | An UNKNOWN deletion is not decidable: the request stays EXECUTING and the reservation stays held   | `service-refund-requests.test.ts` › leaves a request whose deletion is UNKNOWN executing, crediting and releasing nothing                      | KILLED |
| W19-03  | Only a SUCCEEDED deletion credits; FAILED releases the reservation                                 | `service-refund-requests.test.ts` › releases the reservation and credits nothing when the deletion definitively fails                          | KILLED |
| W19-04  | Deciding needs `services.terminate` as well as `refunds.issue`                                     | `service-refund-requests.test.ts` › refuses an administrator who may refund but not delete, and records nothing                                | KILLED |
| W19-05b | Approval moves only an OPEN request (early check AND conditional UPDATE reverted)                  | `service-refund-requests.test.ts` › approves once when two administrators approve together                                                     | KILLED |
| W19-06b | A zero amount is refused (service check AND `refundFitsWithin` reverted)                           | `service-refund-requests.test.ts` › refuses an amount above what is left, and zero, with nothing reserved                                      | KILLED |
| W19-07  | The reservation is bounded by the payment's refundable remainder under its lock                    | `service-refund-requests.test.ts` › shares the payment’s bound with an operator’s own refund made concurrently                                 | KILLED |
| W19-08  | An operator cannot complete or abandon a request's reserved refund by hand                         | `service-refund-requests.test.ts` › refuses an operator completing or abandoning a request’s reserved refund by hand                           | KILLED |
| W19-09  | The generic `REFUND_COMPLETED` notice is suppressed; APPROVED already names the amount             | `service-refund-requests.test.ts` › credits the wallet exactly once, only after the account is deleted, then hides the service                 | KILLED |
| W19-10  | A service whose request COMPLETED is hidden from the customer                                      | `service-refund-requests.test.ts` › credits the wallet exactly once, only after the account is deleted, then hides the service                 | KILLED |
| W19-11b | One live request per service (pre-read AND `ON CONFLICT` reverted)                                 | `service-refund-requests.test.ts` › files exactly one request however many times, and however concurrently, it is filed                        | KILLED |
| W19-12  | Filing and the offer obey `customer_refund_requests`                                               | `service-refund-requests.test.ts` › offers nothing, and refuses a forged tap, while the switch is off                                          | KILLED |
| W19-13  | The reason is 3–500 code points                                                                    | `service-refund-requests.test.ts` › refuses a reason outside 3–500 code points and asks again, then files the next one                         | KILLED |
| W19-15  | A rejection is logged with no amount                                                               | `service-refund-requests.test.ts` › logs each outcome to the financial log, and the rejection with no amount                                   | KILLED |
| W19-16  | The review card goes only to administrators holding both decision keys                             | `service-refund-requests.test.ts` › enqueues one review card per administrator who may decide, and keeps the request if none is sent           | KILLED |
| W19-17  | A customer may file only for their own service                                                     | `service-refund-requests.test.ts` › answers a request for another customer’s service like one that does not exist                              | KILLED |
| W19-19  | Web: approve is disabled until the destructive confirmation is ticked                              | `service-refund-requests.test.tsx` › approves only after the destructive confirmation is ticked, with the amount as minor units                | KILLED |
| W19-20  | Web: the attention card lists only OPEN, EXECUTING and FAILED requests                             | `service-refund-requests.test.tsx` › lists open, executing and failed requests, and not decided ones                                           | KILLED |
| W19-21  | Web: an operator without both decision keys is told so and given no form                           | `service-refund-requests.test.tsx` › tells an operator without both decision keys so, and draws no form                                        | KILLED |
| W19-22  | A COMPLETED reservation is answered only when its own credit exists (the rollback audit)           | `service-refund-requests.test.ts` › refuses to announce a reservation closed elsewhere without its credit, and settles the next request anyway | KILLED |
| W19-23  | The sweep decides each request in its own guarded transaction, so one refusal holds none behind it | `service-refund-requests.test.ts` › refuses to announce a reservation closed elsewhere without its credit, and settles the next request anyway | KILLED |
