# RickPanel ROTATE_SUBSCRIPTION_LINK — audit and design

An operator can give a customer a new subscription link on a RickPanel-backed service.
The panel mints a new token, Nexa stores the new link, and the delivery lane sends it
to the customer. This file records what existed before, the evidence the operation
rests on, the design decisions, and what is still not proven.

## 1. What already existed

- **`ROTATE_SUBSCRIPTION`** is an `OPERATION_TYPES` member. It requires the
  `ROTATE_SUBSCRIPTION_LINK` capability through `OPERATION_REQUIRED_CAPABILITIES`.
  Both have been in `@nexa/contracts` since Phase 4.
- **Nothing performs it.** `PERFORMABLE_OPERATION_TYPES` leaves it out, its
  `OPERATION_LEGAL_FROM` is `[]`, no adapter has a method for it, and no descriptor
  declares the capability. The executor's own comment names what was missing: "neither
  an adapter method nor a product decision behind it".
- **The delivery lane already sends a link.** `DeliveryService.deliver` sends
  `bot.service.subscription` ("your subscription link:" followed by the link) for any
  service whose `delivery_state` is `PENDING`. The sweep claims only `ACTIVE`
  services. The template says nothing about why the link is being sent, so it is
  truthful for a rotated link, and it makes no claim about the old one.
- **Operator-requested operations owe the customer no outcome message.**
  `OperationOutcomeAnnouncer` stamps them without notifying, so the customer hears
  about a rotation only through the delivery lane.

## 2. The evidence

These are the owner's direct calls to a correctly connected RickPanel. They are also
transcribed in `docs/rickpanel-create-hotfix.md` §2.

| call                                             | result                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `OPTIONS /api/user/{username}/revoke_sub`        | advertises `POST`                                                                                |
| `POST /api/user/{username}/revoke_sub`           | 200                                                                                              |
| `GET /api/user/{username}` afterwards            | `subscription_url` **changed**, `sub_token` **changed**; status, expiry and data limit unchanged |
| the old and new links, fetched from the sub host | **504 for both.** Old-link invalidation is **not proven**                                        |

The OpenAPI document lists the route (`POST /api/user/{username}/revoke_sub`) with no
schema or description beyond its existence.

## 3. Decisions

### D1 — Who can rotate: operators, in this package

Operators can rotate from the Web Admin service actions and the Telegram Admin services
section, with `services.edit`, the permission suspend and resume already use.

Customer self-service rotation belongs to WP6 ("rotate subscription link where
supported"). This package builds the operation so that WP6 only adds a surface and an
entitlement decision. Offering a customer a button with no rate or abuse rule would be
a product decision taken by default.

### D2 — From which states: `ACTIVE` and `SUSPENDED`

- **`SUSPENDED` is included deliberately.** The ordinary reason to rotate is a leaked
  link, and the ordinary response to a leak is to suspend first. The new link is
  stored at once, but the delivery sweep claims only `ACTIVE` services, so it reaches
  the customer when the service is resumed. The customer is not messaged while their
  service is paused.
- `PENDING_PROVISION`, `UNRECONCILED`, `EXPIRED` and `TERMINATED` are refused. There
  is either no account yet, no certainty about it, or nothing to use a link for.

### D3 — Classification: a CONVERGENT mutation, retried rather than reconciled

A rotation is not literally idempotent: every `revoke_sub` mints a new token. But the
state an operator asks for is "the customer holds a link the panel minted after my
request". Replaying a rotation converges on that state rather than compounding away
from it.

`UNKNOWN` is not an option. `IDEMPOTENT_MUTATIONS` documents why: `UNKNOWN` is settled
by `RECONCILE`, which asks only whether an account **exists**. An uncertain rotation
would sit in `UNKNOWN` for ever. So `ROTATE_SUBSCRIPTION` joins `IDEMPOTENT_MUTATIONS`,
on the strength of the rule in D4, and the list's docblock says so.

### D4 — The adapter settles its own ambiguity, inside the attempt

`rotateSubscription(target, http, ref, previousUrl)` sends the `revoke_sub`, then reads
the account back and compares the panel's current link with the one Nexa last stored:

| `revoke_sub` answered             | read-back link             | outcome                                                                                       |
| --------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| 2xx                               | differs from `previousUrl` | **rotated**: the new link                                                                     |
| 2xx                               | equals `previousUrl`       | `MALFORMED_RESPONSE`: the panel said yes and changed nothing. Terminal, and nothing is stored |
| 404                               | —                          | `found: false`: the account is gone                                                           |
| 429                               | —                          | `RATE_LIMITED`                                                                                |
| 400 / 403                         | —                          | `PROVIDER_REFUSED`: a rule; terminal                                                          |
| any transport failure, 5xx, other | differs from `previousUrl` | **rotated**: the rotation took effect and only its answer was lost                            |
| transport failure, 5xx, other     | equals `previousUrl`       | the original failure: provably not rotated, so a retry is a first attempt                     |
| transport failure, 5xx, other     | read-back fails as well    | the original failure. A retry rotates again, which converges (D3)                             |

**Every transport failure is read back**, including the kinds `SAFE_TO_REPLAY_FAILURE_KINDS`
calls never-read. `SafeHttpClient` reports a socket that died after the request was
written as `UNREACHABLE`, so for a rotation that kind does not prove nothing happened.
Found by falsification (RR-03 in `docs/rickpanel-rotate-falsification.md`): the first
version returned those kinds unread, and no test could tell. The shared classifier is
not changed here; whether a post-write reset should stop being `UNREACHABLE` for the
create path too is recorded as OQ-RP-09 (§6).

Two consequences:

- **A stored link is never replaced by one that was not read from the panel.** The
  `revoke_sub` response is not read for a link, as with the create.
- **Nexa never reports a rotation that did not happen.** A 2xx with an unchanged link
  is refused rather than recorded as done.

### D5 — Storing the new link, and the delivery race

On success, one transaction:

- marks the operation `SUCCEEDED`;
- writes the new link to the service, conditional on the service still being
  `ACTIVE` or `SUSPENDED`;
- **re-arms delivery**: `PENDING`, attempts 0, no backoff, no send in progress, not
  delivered;
- writes an audit row that carries **no link**, since both links are bearer
  capabilities and the audit log is not a place for one;
- writes a `ServiceSubscriptionRotated` event carrying the customer id only.

**The race.** A send of the OLD link may be in flight when the rotation commits. Its
completion would record `DELIVERED` against a row that now holds the NEW link, and the
new link would never be sent: a customer holding a dead link while the service says it
was delivered.

The fix is a compare-and-set on the delivery writes:

- `recordDelivery` and `recordRateLimited` now require the row to still hold **the
  link that was sent**. A send overtaken by a rotation records nothing.
- The rotation cleared `delivery_send_started_at`, so the row is claimable, and the
  next sweep sends the new link.

### D6 — What the customer is told

The delivery lane sends `bot.service.subscription`: "your subscription link:" and the
link. Nothing says the old link has stopped working, because that is **not proven**
(§2). No new customer template is added.

### D7 — The capability is declared in the same change that implements it

`ROTATE_SUBSCRIPTION_LINK` joins the RickPanel descriptor together with the adapter
method, the executor branch and the tests that hold them. `canRotateSubscription`
requires both the method and the declaration, as the other optional operations do.

Marzban and 3X-UI stay without it:

- Marzban has a `revoke_sub` route, but it has not been run against the pinned binary,
  and this repository declares a capability only after a real panel proves it.
- 3X-UI has no such route.

## 4. Not in this package

- **`RESET_USAGE` stays unpublished.** The route answers `OPTIONS` with `POST`, but
  what it resets has not been measured with non-zero usage. The acceptance step that
  would settle it is to rotate traffic through a disposable user, call the route, and
  read back `used_traffic`, the lifetime counter, the expiry, the data limit, the
  status, the link and the token.
- **Customer self-service rotation** is WP6 (D1).
- **Old-link invalidation** is not claimed anywhere. Proving it needs a reachable
  subscription host, which the owner's test environment did not have (§2).

## 5. What was built, and where it is held

| piece                                    | where                                                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `rotateSubscription` and D4's table      | `rickpanel.adapter.ts`; `tests/unit/rickpanel-adapter.test.ts` › RickPanel subscription rotation                                  |
| the executor branch and `finishRotation` | `provisioner.service.ts`; `tests/integration/rickpanel-rotate-link.test.ts`                                                       |
| the link stored and delivery re-armed    | `DrizzleServiceRepository.recordRotation`                                                                                         |
| the compare-and-set on delivery writes   | `recordDelivery` and `recordRateLimited`, fed by `DeliveryService.deliver`; the two race cases in `rickpanel-rotate-link.test.ts` |
| operator-only, `services.edit`           | `OPERATOR_SERVICE_OPERATIONS`, `OPERATOR_OPERATION_PERMISSION`                                                                    |
| Web Admin                                | `POST /services/:id/rotate-link`; the action row on the service page                                                              |
| Telegram Admin                           | `ra:` asks, `rb:` confirms; only the confirmation screen produces `rb:`                                                           |
| RickPanel alone declares the capability  | `tests/integration/panels-http.test.ts`; `telegram-admin-services.test.ts` asserts no rotation is offered on a Marzban            |

**The race is tested by a controlled interleaving, not by `Promise.all`.** The Telegram
stand-in holds the old link's send until the rotation has committed, then answers it.
Two answers are driven: a 200, which without the compare-and-set would mark the new
link DELIVERED unsent, and a 429, which would park the new link behind a rate limit it
never received.

**One refusal lost its only input.** With `ROTATE_SUBSCRIPTION` performable, every
member of `OPERATION_TYPES` is, so `isPerformableOperation`'s ABANDONED branch has no
contract type left that reaches it. It stays, for the next type the contract gains;
`tests/unit/registries.test.ts` pins the performable list so such a type cannot arrive
without its branch. The integration case that used to exercise it now exercises the
other refusal: a rotation on a 3X-UI panel is refused before the panel is dialled.

## 6. Open questions

| id       | question                                                                                                                                                                                    | what settles it                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-RP-07 | After `revoke_sub`, does the subscription host refuse the OLD link?                                                                                                                         | Fetch both links from a reachable subscription host after a rotation on a disposable user. Until then nothing in Nexa claims the old link stops working (D6). |
| OQ-RP-08 | Is a customer allowed to rotate their own link, and how often?                                                                                                                              | A product decision, WP6 (D1). The operation is built so that WP6 adds a surface and an entitlement rule, not a second implementation.                         |
| OQ-RP-09 | `SafeHttpClient` classifies a connection reset after the request was written as `UNREACHABLE`, which `SAFE_TO_REPLAY_FAILURE_KINDS` treats as never read. Is that safe for the create path? | Distinguish a reset before the request was flushed from one after it, at the socket, and decide per kind. Rotation no longer depends on it (D4).              |

Neither is exercised by `pnpm test:acceptance` yet. The acceptance suite has not been
run against a RickPanel in any form, because this session has no disposable panel.
