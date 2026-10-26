# The custom gateway — falsification record (Round 10 C1)

The money and security rules of `docs/custom-gateway-audit.md` and
`docs/protocols/custom-gateway.md`. Each row was reverted ALONE (a row marked "both" reverts the
two lines that hold its rule together) by a driver in the agent's scratchpad: the one source line
replaced, only the named test run (`vitest -t`), the file restored byte-for-byte afterwards, and
`packages/contracts` rebuilt around a row that mutates it (the suites read its `dist`). The
integration rows ran against the agent's own database (`nexa_test_r10c1`) with no other suite
using it. The table is the final run, against the tree that carries the tests below.

The first run found four rules no test could fail, all fixed and run again:

- **CG-21** — the seed writes the routes itself, so the tests never reached `ensureDefaults`. A test
  now deletes the route and runs the boot-time reconcile.
- **CG-24** — the refusal to change the bridge while ACTIVE is held twice: the service's check and
  the conditional UPDATE's `status = 'DISABLED'`. Each alone is a layer (below); both removed is
  killed.
- **CG-27** — the guard that refuses a response with no request nonce was redundant with the
  signed string while no test signed over an EMPTY nonce line. One now does.
- **CG-31** — the test's helper defaulted a missing sender address to an allowed one, so
  "unknown sender" was never delivered. It now passes `null` through as unknown.

| #     | rule                                                                                            | tests that die                                                                                                                                                         | result |
| ----- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| CG-01 | `PAID` approves only when `amount_paid` is exactly the amount sent                              | `integration/custom-gateway.test.ts` › amount mismatch: PAID with another amount_paid is held UNKNOWN, credits nothing                                                 | KILLED |
| CG-02 | `PAID` for another invoice id is a mismatch                                                     | `unit/custom-gateway-rules.test.ts` › a PAID for another invoice id, another reference, no reference, or other figures is a MISMATCH                                   | KILLED |
| CG-03 | `PAID` for another bridge reference is a mismatch                                               | `unit/custom-gateway-rules.test.ts` › a PAID for another invoice id, another reference, no reference, or other figures is a MISMATCH                                   | KILLED |
| CG-04 | `UNDERPAID` is held for an operator, never approved                                             | `integration/custom-gateway.test.ts` › UNDERPAID is held UNKNOWN for an operator, credits nothing                                                                      | KILLED |
| CG-05 | `OVERPAID` is held for an operator, never approved                                              | `integration/custom-gateway.test.ts` › OVERPAID is held UNKNOWN for an operator, credits nothing                                                                       | KILLED |
| CG-06 | Toman is sent x10 as rial, by the one helper                                                    | `integration/custom-gateway.test.ts` › sends the payable in rial with the customer number and the frozen URL, and credits exactly once on PAID                         | KILLED |
| CG-07 | A callback timestamp more than 300 s off is refused                                             | `integration/custom-gateway.test.ts` › a stale timestamp (301 s) is refused like a bad signature                                                                       | KILLED |
| CG-08 | Rotation: every `v1` is compared, not only the first                                            | `unit/custom-gateway-signature.test.ts` › refuses two t values, and accepts rotation: ANY v1 that verifies, wherever it stands                                         | KILLED |
| CG-09 | A callback never credits: the inquiry's verdict alone decides                                   | `integration/custom-gateway.test.ts` › a callback that says PAID credits nothing while the inquiry says PENDING                                                        | KILLED |
| CG-10 | A callback is deduplicated on its delivery id (replay)                                          | `integration/custom-gateway.test.ts` › a verified callback brings the inquiry forward, and the same delivery id twice is a replay                                      | KILLED |
| CG-11 | Only `429` WITH `RATE_LIMITED` clears the send stamp; a bare 429 is unknown                     | `unit/custom-gateway-adapter.test.ts` › 429 RATE_LIMITED is the one answer that clears the stamp, and a bare 429 is UNKNOWN                                            | KILLED |
| CG-12 | `409 INVOICE_CONFLICT` is ambiguous, never a refusal                                            | `unit/custom-gateway-adapter.test.ts` › 409 INVOICE_CONFLICT is AMBIGUOUS, never refused, never re-keyed                                                               | KILLED |
| CG-13 | An unsigned 2xx create is unknown, never created                                                | `unit/custom-gateway-adapter.test.ts` › an unsigned 2xx, or one signed for another request, is UNKNOWN — it may exist and proves nothing                               | KILLED |
| CG-14 | An unsigned inquiry answer is no information, never an approval                                 | `integration/custom-gateway.test.ts` › an unsigned inquiry answer saying PAID approves nothing                                                                         | KILLED |
| CG-15 | The base URL is https only                                                                      | `integration/custom-gateway.test.ts` › takes an https base URL only, refuses one the URL policy refuses, and audits each change                                        | KILLED |
| CG-16 | A callback from outside the allow-list is refused before its signature is read                  | `integration/custom-gateway.test.ts` › a sender outside the IP allow-list is refused before its signature is read                                                      | KILLED |
| CG-17 | The bridge URL is frozen on the attempt (a route change never follows open attempts)            | `integration/custom-gateway.test.ts` › an open attempt keeps asking the bridge that created it after the route’s URL changes                                           | KILLED |
| CG-18 | Late credit is OFF by default                                                                   | `integration/custom-gateway.test.ts` › is only recorded when the switch is OFF (the default)                                                                           | KILLED |
| CG-19 | The signed path is the protocol path, never the base URL's prefix                               | `unit/custom-gateway-adapter.test.ts` › creates against the reference bridge: signed request under the base prefix, signed answer                                      | KILLED |
| CG-20 | The endpoint write reads scope activity inside its transaction                                  | `integration/custom-gateway.test.ts` › refuses the endpoint write once the scope has stopped accepting work (checked in the transaction)                               | KILLED |
| CG-21 | The route is provisioned DISABLED                                                               | `integration/custom-gateway.test.ts` › provisioning creates the route DISABLED for a tenant that has none (the boot-time reconcile)                                    | KILLED |
| CG-22 | A callback is verified against the route's one credential before it is read                     | `integration/custom-gateway.test.ts` › a bad signature is refused before it is read: nothing recorded, nothing scheduled, an alert opened                              | KILLED |
| CG-23 | Enabling needs the bridge address                                                               | `integration/custom-gateway.test.ts` › starts DISABLED and cannot be enabled without its secret, then without its bridge address                                       | KILLED |
| CG-24 | The bridge address changes only while DISABLED (both: the service check and the UPDATE's WHERE) | `integration/custom-gateway.test.ts` › refuses to change the bridge address while the route is ACTIVE                                                                  | KILLED |
| CG-25 | `FAILED`/`EXPIRED` that reports money captured is held, never failed                            | `unit/custom-gateway-rules.test.ts` › FAILED or EXPIRED that says money WAS captured is held, never failed                                                             | KILLED |
| CG-26 | A lost create is read by invoice id (never re-sent) and the reference adopted                   | `integration/custom-gateway.test.ts` › a lost create is never re-sent: a callback naming only the invoice id brings a read BY invoice id, and the reference is adopted | KILLED |
| CG-27 | A response never verifies without its request's nonce                                           | `unit/custom-gateway-signature.test.ts` › a response is bound to its request’s nonce: a recorded answer does not answer another request                                | KILLED |
| CG-28 | The request's nonce is in the response's signed string                                          | `unit/custom-gateway-signature.test.ts` › domain separation: a callback signature is not a response signature, nor the reverse                                         | KILLED |
| CG-29 | The one secret is at least 32 characters                                                        | `integration/custom-gateway.test.ts` › refuses a secret shorter than 32 characters                                                                                     | KILLED |
| CG-30 | A response and a callback sign different strings (domain separation)                            | `unit/custom-gateway-signature.test.ts` › domain separation: a callback signature is not a response signature, nor the reverse                                         | KILLED |
| CG-31 | With an allow-list set, an unknown sender address is refused (fail closed)                      | `integration/custom-gateway.test.ts` › a sender outside the IP allow-list is refused before its signature is read                                                      | KILLED |
| CG-32 | A create echoing another invoice id or amount is refused, its link never shown                  | `unit/custom-gateway-adapter.test.ts` › an echo of another invoice id or amount is REFUSED and never shown, the reference kept                                         | KILLED |
| CG-33 | A non-https payment link is never shown                                                         | `unit/custom-gateway-adapter.test.ts` › a payment_url that is not https is refused, never shown                                                                        | KILLED |

## Layers

| #      | rule                                                              | what holds it                                                                                                                                                          |
| ------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CG-24s | the service's `before.status !== 'DISABLED'` check, removed alone | the repository's conditional UPDATE (`status = 'DISABLED'` in its WHERE) still refuses: the test stays green; CG-24 removes both and is killed                         |
| CG-24w | the UPDATE's `status = 'DISABLED'`, removed alone                 | the service's check, read in the same transaction, still refuses: the test stays green; the WHERE is what refuses an enable committing between that read and the write |
