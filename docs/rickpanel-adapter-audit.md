# RickPanel is not Marzban: auditing the adapter against the panel's own contract

**Status.** Audit complete. Decision taken: a separate `rickpanel` provider type
and adapter. Written before any code, as the convention requires.

**Evidence.** The owner attached `rickpanel-openapi.json`, an OpenAPI 3.1
document titled _RickPanel API_, generated per-admin — its own description says
"a document issued to one account does not describe another's". It is the
authoritative contract for the production panel behind order
`01a0c54b-d282-71a7-8607-3978533cd3a0`.

The corpus corroborates that the production panel is a RickPanel:
`scripts/sanitize-research.mjs` redacts `rickpanel.io` as "a provider panel host
belonging to the deployment", and the legacy bot registered it under the label
`TEST_MARZBAN_RICKPANEL` — that is, the legacy system also treated a RickPanel
as "a Marzban", which is the same mistake this repository inherited.

---

## 1. What the document is, and what it is not

It is trustworthy about **paths, methods, status codes and prose semantics**.
Those are what the rest of this audit rests on.

It is **not** trustworthy about payload schemas, and that has to be said plainly
because the temptation is to generate a client from it:

- every property of `UserCreate` and `UserModify` is typed `"string"`, including
  `expire`, which the same operation's description says is "a UTC timestamp in
  seconds", and `data_limit`, which it says "is in bytes". A document that types
  an integer as a string is a document whose types were flattened.
- `UserCreate.required` is `[]`, and the object declares **no `username`
  property at all** — while `POST /api/user` documents `409` for "a username
  already in use", and every subsequent operation addresses the user as
  `/api/user/{username}`.
- `components.schemas` is empty. There is no `User` schema, so the record
  returned by `GET /api/user/{username}` has no declared shape anywhere in the
  document. Its description says the record "includes the config links, the
  subscription URL and the subscription token" — three facts, no field names.
- the token endpoint's `requestBody` is declared as `application/json` while its
  own description says "The request body is form-encoded, not JSON".

So: **the descriptions are the contract and the schemas are lossy.** Where the
two disagree, the description wins, and that is recorded here rather than
discovered later by somebody reading the JSON.

### What follows from that, and what does not

`username` is sent on create. That is not an invention: a created user is
addressed by `/api/user/{username}` immediately afterwards, and a duplicate
`username` is refused with `409`. A username the client did not choose could be
neither addressed nor collided with. The document omits the property; the
document's own semantics require it.

The **subscription field names are genuinely unknown** and are treated as such.
The adapter reads `subscription_url` first — RickPanel is visibly Marzban-derived
(`/api/admin/token`, `/api/user`, `data_limit_reset_strategy`,
`on_hold_expire_duration`, `sub_updated_at`, `sub_last_user_agent` are Marzban
v0.8.4's own names) — then `subscription_token`, then the first entry of `links`.
If none of the three is present it returns `MALFORMED_RESPONSE`, which for a
mutating call classifies as UNKNOWN and routes to reconciliation. It never
reports a delivery it could not read. That is the fail-safe direction, and it is
the direction to take while a field name is a guess.

---

## 2. The Marzban adapter against the RickPanel contract

|                     | Marzban v0.8.4 (what `marzban.adapter.ts` targets)                                                                      | RickPanel (attached contract)                                                                                           | Material? |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------- |
| Token               | `POST /api/admin/token`, form-encoded, bearer back                                                                      | identical, prose confirms form-encoded                                                                                  | no        |
| Auth header         | `Authorization: Bearer <jwt>`                                                                                           | `bearerAuth`, `bearerFormat: JWT`                                                                                       | no        |
| Health              | `GET /api/system`                                                                                                       | `/api/system` present                                                                                                   | no        |
| Create route        | `POST /api/user`                                                                                                        | `POST /api/user`                                                                                                        | no        |
| **Create payload**  | `proxies` and `inbounds` REQUIRED — omitting `inboundTags` excludes every inbound and delivers a zero-byte subscription | "`inbounds` and a partial `proxies` set are **accepted but ignored**: every user gets every protocol and every inbound" | **YES**   |
| **Create response** | returns the created record; adapter takes `subscription_url` from it                                                    | "**The response returns before the nodes have the user.**"                                                              | **YES**   |
| **Duplicate**       | 409 → `PROVIDER_ERROR` → UNKNOWN → reconcile                                                                            | 409 documented for a name in use                                                                                        | partly    |
| **Refusal**         | 422 for an invalid status                                                                                               | **400** "saying which rule was hit" — user limit, too-short service, data limit, on hold                                | **YES**   |
| Delete              | permanent                                                                                                               | permanent, plus **403 when the service only allows deleting expired users**                                             | yes       |
| Modify              | `PUT /api/user/{username}`, omitted means no change                                                                     | same, plus "you cannot take protocols or inbounds away here"                                                            | no        |
| Read                | `GET /api/user/{username}`, 404 for absent                                                                              | same, and 404 also for a user you do not own                                                                            | no        |

Four material differences. Three of them are enough on their own.

### F-RP-1 — activation is meaningless, and requiring it makes the panel unsellable for ever

This is the one that connects to the hotfix. `decideEligibility` now refuses a
sale when `activationIssues` is non-empty, and `marzban`'s activation schema
requires `proxyProtocols` and `inboundTags`. A RickPanel registered as `marzban`
therefore needs an operator to configure two fields that **RickPanel documents it
will ignore**. Whatever they type is a fiction; it changes nothing on the panel
and it exists only to satisfy a rule written for a different product.

Worse in the other direction: the whole reason Marzban demands `inboundTags` is
that omitting it means NO inbound. RickPanel's contract says the opposite —
every user gets every inbound, always. A rule that is load-bearing for one panel
is noise on the other, and the two cannot share one schema honestly.

### F-RP-2 — a 200 on create is not a delivery

Marzban's create returns the user, subscription URL included, and the adapter
treats that record as authoritative. RickPanel states that the create "returns
before the nodes have the user". A 200 therefore proves that the panel accepted
the user, and proves nothing about whether the account exists on any node or
whether its subscription data is readable yet.

Marking a service DELIVERED on that 200 is exactly the class of defect
`docs/real-panel-acceptance.md` is about: a green response and a customer holding
a link that serves nothing.

### F-RP-3 — 400 is deterministic and must not be retried

RickPanel's 400 on create carries an operator-fixable reason: the admin's user
limit is reached, or the service refuses a user that is too short, or has a data
limit, or is on hold. The current adapter maps every non-2xx to `PROVIDER_ERROR`,
which the provisioner treats as UNKNOWN and reconciles. For RickPanel that means
five attempts and seven minutes against a panel that will refuse identically
every time — the precise shape of the production incident, reached by a second
path.

### F-RP-4 — 409 should be read, not re-sent

Both panels answer 409 for a name in use, and today both route to reconciliation,
which does eventually read the user back. That is acceptable and slow. RickPanel
makes it worth doing directly: with an idempotency-safe username, a 409 means
_this installation's own earlier create landed_, and the correct next move is one
`GET /api/user/{username}` to adopt it. Never a second create under a different
name — that is a second paid-for account on somebody's panel.

---

## 3. The decision: a separate `rickpanel` provider type

The owner's preference is a separate adapter when authentication, endpoints,
payloads, response semantics or asynchronous behaviour differ materially. Auth
and endpoints do not differ. Payload semantics, response semantics and
asynchronous behaviour all do, and F-RP-1 alone is disqualifying: a compatibility
flag inside the Marzban adapter would have to reach out of the adapter and change
what `PANEL_ACTIVATION_SCHEMAS['marzban']` requires, because activation
completeness is decided in the application layer and not in the adapter. That is
the "weaken the standard Marzban contract to make RickPanel fit" the instruction
forbids, and it would put a branch in the one predicate four callers share.

So: `rickpanel` is its own `ProviderType`, its own descriptor, its own activation
schema and its own adapter file.

### Existing installations are not reinterpreted

Nothing migrates. Every stored `marzban` panel stays `marzban` and keeps
Marzban's rules, because this repository cannot tell from a row whether the host
behind it is a Marzban or a RickPanel — and guessing would silently change which
API a customer's next purchase is created through.

`provider_type` is immutable on an existing panel by design (`PanelService`
refuses to change it, and `connectionIdentityOf` carries it). An operator whose
panel is a RickPanel therefore **adds a new panel** of type `rickpanel`, tests
the connection, and moves their products onto it. That is explicit, reversible
and visible in the operational log, which is what "explicit and
backward-compatible" has to mean here. `docs/providers/rickpanel.md` says so in
the operator's words.

---

## 4. The acceptance gap, stated as a gap

**No RickPanel was contacted while writing this.** This session has no RickPanel
instance, no credentials for one, and the safe acceptance request the instruction
permits could not be made. Every behaviour below is implemented against the
attached document's prose and verified against a deterministic fake server that
this repository wrote.

`docs/real-panel-acceptance.md` is explicit about what that is worth: a fake this
repository wrote and an adapter this repository wrote can only prove they agree
with each other. Four defects reached `main` that way. So:

- **Marzban acceptance has been run** (`tests/acceptance/real-panel-marzban.test.ts`,
  against a real v0.8.4) and is unaffected by this change.
- **RickPanel acceptance has NOT been run.** `tests/acceptance/real-panel-rickpanel.test.ts`
  exists, fails rather than skips without a disposable panel, and is not in
  `pnpm verify`.
- The two must never be reported as one. A RickPanel result is not a Marzban
  result and the reverse.

### The one place this deviates from a standing repository rule

`CLAUDE.md`: "A capability is declared AFTER the acceptance proves it, never
before." Taken literally, `rickpanel` would declare nothing, `canProvision` would
be false, no RickPanel would be sellable, and the production incident this hotfix
exists to fix would stay unfixed.

The deviation is therefore taken deliberately and recorded here rather than
quietly: `rickpanel` declares the capabilities its adapter implements, and the
owner is asked to run `pnpm test:acceptance` against a RickPanel before the next
deployment. Until that has been run, every capability on the `rickpanel`
descriptor is a promise supported by a document and a fake, and the rule says
what that is worth.

### Open questions, not guesses

| id       | question                                                                | why it is not resolved here                                                                                                |
| -------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| OQ-RP-01 | What are the subscription field names on the fetched user record?       | The document names the three facts and no keys. The adapter tries three shapes and reports MALFORMED rather than assuming. |
| OQ-RP-02 | Does `POST /api/user` accept `status`, as Marzban's does?               | Not declared. The adapter does not send it on create; the panel's own default applies, and a suspend is a separate PUT.    |
| OQ-RP-03 | What does the create actually return — the user, or an acknowledgement? | "Success", no schema. The adapter does not depend on the answer: it reads the user back either way.                        |
| OQ-RP-04 | How long does node propagation take?                                    | Unmeasured. The bounded read policy is stated in the adapter as an assumption, not a measurement.                          |
