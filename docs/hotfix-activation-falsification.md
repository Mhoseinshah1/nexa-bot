# Activation / sellability hotfix — falsification

Every production rule this hotfix adds, mutated back and run against the
committed suite. A rule whose mutation leaves the suite green is a rule the suite
cannot see, and `CLAUDE.md` is explicit about the cost: _"A rule with no test is
a rule that will be silently reverted."_

Twenty mutations. **Twenty killed, none survived.** One initially reported
SURVIVED and did not — see "The one false survivor" below, which is the most
useful paragraph here.

## The sale evaluator

`decideEligibility` is one predicate with four callers — catalogue, confirmation,
settlement, release — so each of these is proved once and holds at all four.

| #   | Rule                                                                 | Mutation                                 | Named test                                                                                                | Result |
| --- | -------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| F1  | a panel whose activation does not parse cannot be sold               | the `activationIssues` branch deleted    | `panel-eligibility.test.ts` › refuses a panel whose activation does not parse, however healthy it is      | KILLED |
| F2  | a sale needs a connection test bound to the panel's CURRENT identity | the `connectionValidated` branch deleted | `panel-eligibility.test.ts` › refuses a panel nobody has ever probed, as UNVALIDATED and not as UNHEALTHY | KILLED |
| F3  | a provider with no service adapter cannot be sold                    | the `canProvision` branch deleted        | `panel-eligibility.test.ts` › refuses a provider this release has no service adapter for                  | KILLED |
| F4  | a panel whose credentials are not set cannot be sold                 | the `credentialsPresent` branch deleted  | `panel-eligibility.test.ts` › refuses a panel whose credentials are not set                               | KILLED |

## Retry classification

| #   | Rule                                                           | Mutation                                             | Named test                                                                                             | Result |
| --- | -------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| F5  | `ACTIVATION_INCOMPLETE` is deterministic and answered at once  | removed from `DETERMINISTIC_REFUSALS`                | `refusal-classification.test.ts` › answers ACTIVATION_INCOMPLETE at once instead of over seven minutes | KILLED |
| F11 | `PROVIDER_REFUSED` is never retried                            | `PROVIDER_FAILURE_RETRYABLE.PROVIDER_REFUSED` → true | `rickpanel-adapter.test.ts` › treats a 400 rule refusal as terminal and refundable, not as a retry     | KILLED |
| F12 | a refused create is FAILED, not UNKNOWN, so it refunds at once | removed from `SAFE_TO_REPLAY_FAILURE_KINDS`          | `rickpanel-adapter.test.ts` › treats a 400 rule refusal as terminal and refundable, not as a retry     | KILLED |

## The RickPanel adapter

| #   | Rule                                                                                                                    | Mutation                                                  | Named test                                                                                              | Result |
| --- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------ |
| F6  | a create reads the user back before claiming a delivery                                                                 | the create response parsed and returned as the delivery   | `rickpanel-adapter.test.ts` › reads the user back before it claims a delivery                           | KILLED |
| F7  | ~~a 409 whose user we own is ADOPTED, never created again~~ **SUPERSEDED by C2 below: a 409 is refused, never adopted** | the refusal replaced with the read-and-adopt branch       | `rickpanel-adapter.test.ts` › refuses a name that already exists even when the panel will show it to us | KILLED |
| F8  | a 409 for a name another admin owns is refused, not retried                                                             | `PROVIDER_REFUSED` → `PROVIDER_ERROR` on the 409+404 path | `rickpanel-adapter.test.ts` › refuses a name held by another admin instead of retrying it               | KILLED |
| F9  | a 400/403 on create is a rule, answered once                                                                            | `PROVIDER_REFUSED` → `PROVIDER_ERROR`                     | `rickpanel-adapter.test.ts` › treats a 400 rule refusal as terminal and refundable, not as a retry      | KILLED |
| F10 | RickPanel is sent no `inbounds` (see the note below for `proxies`)                                                      | `inbounds` added to the create payload                    | `rickpanel-adapter.test.ts` › sends the fixed proxies seed and no inbounds                              | KILLED |
| F13 | a rickpanel panel requires no activation                                                                                | `requiredActivationFields` set to `['proxyProtocols']`    | `rickpanel-adapter.test.ts` › requires no activation, where marzban requires two fields                 | KILLED |
| F14 | a rickpanel activation refuses a pasted Marzban payload                                                                 | `.strict()` dropped from `rickpanelActivationSchema`      | `rickpanel-adapter.test.ts` › requires no activation, where marzban requires two fields                 | KILLED |

**F10 amended by `docs/rickpanel-create-hotfix.md`.** The rule's `proxies` half was wrong
and is reversed there. A PARTIAL set is ignored, as the document says, but an ABSENT one is
refused. Every create now carries the fixed seed `{"vless": {}}`, held by RP-01 and RP-02 in `docs/rickpanel-hotfix-falsification.md`.
The `inbounds` half still holds. Its mutation was re-run against the renamed test and still kills it.

## The Web Admin

| #   | Rule                                                                    | Mutation                                              | Named test                                                                                         | Result |
| --- | ----------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| F15 | the panel page states sellability and its reason, not just health       | the reason banner's condition forced false            | `panels.test.tsx` › says a healthy panel with incomplete activation is not sellable, and why       | KILLED |
| F16 | the activation form refuses an unparseable value rather than sending it | the submit guard's condition forced false             | `panels.test.tsx` › refuses a protocol with no inbound tags instead of guessing one                | KILLED |
| F17 | an untouched activation is not mentioned, so a rename cannot erase one  | the conditional spread made unconditional             | `panels.test.tsx` › omits activation from the command when the operator did not touch it           | KILLED |
| F18 | the order page shows the service its order produced                     | the `OrderService` card deleted                       | `products-and-orders.test.tsx` › shows the service the order produced, and the attempt that failed | KILLED |
| F19 | the order page reaches its service THROUGH the order                    | the `orderId` query parameter dropped from the client | `products-and-orders.test.tsx` › shows the service the order produced, and the attempt that failed | KILLED |

## The one false survivor

F11 reported SURVIVED on its first run, and the finding was about the HARNESS
rather than about the rule.

`@nexa/contracts` is consumed as compiled `dist`. A mutation applied to its
SOURCE is therefore invisible to any test until the package is rebuilt, so the
run that reported SURVIVED had executed the unmutated table and passed for a
reason that has nothing to do with coverage. Every contracts-level mutation in
this pass — F11, F12, F13, F14 — was affected identically.

The runner now rebuilds the package after mutating and again after restoring,
and all four kill. It is recorded here rather than quietly fixed because it is
precisely the shape of false comfort this whole exercise exists to refuse: a
green mutation run is supposed to mean the test cannot see the rule, and here it
meant the test could not see the mutation. A pass that reports SURVIVED should
always be asked which of the two it is.

## The Codex round: five findings, five mutations

The one authorised review of PR #58 returned five findings, two P1. All five
were validated against the code and all five were real. Each fix is mutated the
same way the rest of this document is — revert the single rule and watch the
named test fail.

| id    | the rule the fix installed                                                           | mutation                                                                  | tests that die                                                                                                                                                                                                                                                                                                                        | result                  |
| ----- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| C1a   | `activationIssues` normalises an unset activation to `{}` and lets the schema decide | return `[]` for `null`/`undefined` before parsing                         | `panel-eligibility.test.ts` › a Marzban with no activation is refused by both, naming its fields                                                                                                                                                                                                                                      | KILLED — 8 cases        |
| C1b   | `decideOperability` normalises the same way                                          | reject `null` outright, as it used to                                     | `panel-eligibility.test.ts` › a RickPanel with no activation is sellable AND operable, because it needs none                                                                                                                                                                                                                          | KILLED — those two only |
| C2    | a RickPanel `409` is `PROVIDER_REFUSED` with no read-back                            | restore the read-and-adopt branch                                         | `rickpanel-adapter.test.ts` › refuses a name that already exists even when the panel will show it to us; `rickpanel-adapter.test.ts` › carries no subscription, token or panel text out of a conflict                                                                                                                                 | KILLED — 3 cases        |
| C3    | `terminal` is what the tick did, via three named shapes                              | point `refusedAbandoned` and `refusedAndHeld` back at the old computation | `refusal-classification.test.ts` › a row transitioned to ABANDONED is terminal however its reason is classified; `refusal-classification.test.ts` › a row whose attempt was given back is never terminal, at any attempt count; `provisioning.test.ts` › reports an abandoned operation as terminal, however its reason is classified | KILLED — 3 cases        |
| C4/C5 | two Web Admin sentences say only what the page read                                  | restore both original strings                                             | `products-and-orders.test.tsx` › says a refunded order was refunded, and where the figure is; `products-and-orders.test.tsx` › does not tell an operator a refunded service purchase was not one                                                                                                                                      | KILLED — 2 cases        |

C1a and C1b are listed separately on purpose. Each fails exactly the side it
breaks and neither fails the other's cases, which is what says the pair measures
the DISAGREEMENT between the two evaluators rather than one evaluator's answer.
A single mutation failing everything would have been consistent with a test that
merely pins both to a constant.

### One case removed rather than left passing

The `refusedAndHeld` shape has no end-to-end test, and the honest reason is
worth recording. I wrote one — stop the tenant, run a tick, assert the refusal
reports `terminal: false` and the row was queued again with its attempt refunded
— and it returned `IDLE`. `runOnce` checks `scopeIsActive` BEFORE it claims, so
the in-executor `TENANT_STOPPED` refusal is the inside-the-transaction backstop
for a tenant that stops MID-tick, and a test that stops it first never reaches
the code it names.

The case was deleted rather than weakened to pass. What stands in its place is a
contract test on the three shapes across every attempt count, which is a smaller
claim honestly made: it proves `refusedAndHeld` can never report terminal, and
does not pretend to prove the two call sites use it. The `ABANDONED` direction —
the one Codex named first and the one reachable today — is proven end to end,
asserting the flag AND that the row really is `ABANDONED`.

## What is NOT proved here

- **RickPanel against a real panel.** Every F6–F14 row is mutated against a fake
  this repository wrote. `docs/real-panel-acceptance.md` is explicit that a fake
  we wrote and an adapter we wrote can only prove they agree with each other, and
  four defects reached `main` that way. `tests/acceptance/real-panel-rickpanel.test.ts`
  is the evidence and it has not been run. A Marzban acceptance result is not a
  RickPanel one.
- **The health hysteresis window.** `connectionValidated` asks whether a probe ran
  against the CURRENT identity, not whether it SUCCEEDED, because `recordHealth`
  writes `validated_identity` on failures too. A panel whose last probes all
  failed is still within `PANEL_UNHEALTHY_AFTER_FAILURES` and remains sellable
  until `isConfirmedUnusable` catches it. That is the existing window rather than
  a new hole, and closing it needs a durable "last SUCCEEDED for identity X" —
  a schema change, not a hotfix. `docs/hotfix-activation-audit.md` records it.
