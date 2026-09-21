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

| #   | Rule                                                        | Mutation                                                  | Named test                                                                                         | Result |
| --- | ----------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| F6  | a create reads the user back before claiming a delivery     | the create response parsed and returned as the delivery   | `rickpanel-adapter.test.ts` › reads the user back before it claims a delivery                      | KILLED |
| F7  | a 409 whose user we own is ADOPTED, never created again     | the adopt read replaced with a bare `PROVIDER_ERROR`      | `rickpanel-adapter.test.ts` › adopts our own existing user instead of creating a second one        | KILLED |
| F8  | a 409 for a name another admin owns is refused, not retried | `PROVIDER_REFUSED` → `PROVIDER_ERROR` on the 409+404 path | `rickpanel-adapter.test.ts` › refuses a name held by another admin instead of retrying it          | KILLED |
| F9  | a 400/403 on create is a rule, answered once                | `PROVIDER_REFUSED` → `PROVIDER_ERROR`                     | `rickpanel-adapter.test.ts` › treats a 400 rule refusal as terminal and refundable, not as a retry | KILLED |
| F10 | RickPanel is sent neither `inbounds` nor `proxies`          | both added to the create payload                          | `rickpanel-adapter.test.ts` › sends neither inbounds nor proxies, because the panel ignores both   | KILLED |
| F13 | a rickpanel panel requires no activation                    | `requiredActivationFields` set to `['proxyProtocols']`    | `rickpanel-adapter.test.ts` › requires no activation, where marzban requires two fields            | KILLED |
| F14 | a rickpanel activation refuses a pasted Marzban payload     | `.strict()` dropped from `rickpanelActivationSchema`      | `rickpanel-adapter.test.ts` › requires no activation, where marzban requires two fields            | KILLED |

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
