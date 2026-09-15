# Phase 4E audit — service management

What Phase 4D left, checked against the code rather than remembered, before any of
this phase is written. The 4D audit's headline was that the contracts and the schema
for provisioning had already landed in Architecture Hardening; this one's is narrower
and less comfortable: **the vocabulary for service management is entirely frozen and
almost none of it has an implementation.**

## What already exists

| Thing                                                                                                                       | Where                                                  | State                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `SERVICE_MACHINE` edges for `SUSPEND`, `RESUME`, `EXPIRE`, `RENEW`, `TERMINATE`                                             | `packages/contracts/src/provisioning.ts`               | **Frozen, and only `PROVISIONED` / `PROVISION_LOST_TRACK` / `RECONCILED_*` have a caller** |
| `OPERATION_TYPES` `SUSPEND`, `RESUME`, `TERMINATE`, `SYNC_USAGE`, `RENEW`, `ADD_TRAFFIC`, `ADD_TIME`, `ROTATE_SUBSCRIPTION` | same                                                   | **Frozen, none executed** — the executor performs `PROVISION` and `RECONCILE`              |
| `OPERATION_REQUIRED_CAPABILITIES` for all ten types                                                                         | same                                                   | Frozen and complete                                                                        |
| Permissions `services.view`, `services.edit`, `services.terminate`, `services.transfer`                                     | `packages/contracts/src/permissions.ts`                | Frozen; `view` is read by `list`/`get`, the other three have **no caller at all**          |
| `ProvisioningService.list` / `get` / `operationsFor` / `listForCustomer` / `getForCustomer`                                 | `.../provisioning/application/provisioning.service.ts` | Implemented, permission-guarded, tested — and **no route reaches them**                    |
| `DeliveryService.redeliver`                                                                                                 | `.../application/delivery.service.ts`                  | Implemented and tested; **no caller**                                                      |
| Adapter methods `createUser`, `lookupUser`, `readUsage`                                                                     | both adapters                                          | Implemented                                                                                |
| `ProviderAdapter` port                                                                                                      | `packages/contracts/src/provider.ts`                   | Declares **only** those three plus `probe`/`supports`                                      |

## What is missing, and what each absence costs

**1. No adapter can disable, enable or delete a user.** The port declares three
methods; `DISABLE_USER`, `ENABLE_USER` and `DELETE_USER` are in
`PROVIDER_CAPABILITIES` and in neither descriptor. So `SUSPEND`, `RESUME` and
`TERMINATE` cannot be executed by any provider in this release, and
`decideOperability` would refuse them with `CAPABILITY_UNSUPPORTED` — correctly, and
uselessly.

**2. The executor performs one operation type and says so.** `provisionCall` calls
`createUser` unconditionally and its docblock records, in the words of the commit that
corrected it, that a future type routed through it "would silently create a user on
somebody's panel". Adding operation types therefore means adding a DISPATCH, and that
dispatch is the single most dangerous edit in this phase: the property to preserve is
that an operation whose type has no implementation is refused before any provider is
contacted, not defaulted to the one call the function used to make.

**3. Nothing expires a service.** `services.expires_at` is written by the create and by
the adopt path, `services_expiry_idx` exists, and no code reads either. A service whose
window closed stays `ACTIVE` in Nexa for ever while the panel stops serving it — the
two authorities disagreeing, which is the shape `SERVICE_MACHINE`'s comment about the
provider "not the authority, and not ignored either" exists to prevent.

**4. Nothing syncs usage.** `readUsage` is implemented on both adapters and called by
nothing. `services.traffic_used_bytes` and `usage_synced_at` are written once, by the
create and the adopt path, and never refreshed. A customer asking how much traffic they
have left would be told the figure from the moment their account was made.

**5. The customer cannot see a service at all.** `BOT_INTENTS` is
`START, CATALOG, ORDER, CONFIRM, WALLET, PAY_WALLET, PAY_MANUAL, PAY_GATEWAY,
UNSUPPORTED`. There is no `SERVICES`, no `SERVICE`, and no way to ask for a
configuration again — so `listForCustomer`, `getForCustomer` and `redeliver`, all
written and tested in 4D, are unreachable. A customer whose delivery ended
`UNCONFIRMED` or `FAILED` has no way to recover it themselves, which is the remedy
those states were designed around.

## What this phase must NOT do

- **`RENEW`, `ADD_TRAFFIC` and `ADD_TIME` are commerce, not management.** Each needs a
  new paid order against an existing service, which is Phase 4F. Their operation types
  stay unexecuted here, and the dispatch must refuse them the same way it refuses any
  type it cannot perform.
- **`services.transfer` stays unimplemented.** Moving a service between customers has
  no product decision behind it yet and no research entry that settles what happens to
  the order history.
- **The Web Admin Services surface is the later Web Admin phase**, per the standing
  scope correction. The HTTP layer may gain routes; the React screens do not.

## Two things to verify before writing the adapter

Phase 3B's rule was that a wire fact is read from the upstream source, not assumed, and
the fake 3X-UI models what was read. The same applies to three new routes:

- how v3.7.0 disables and re-enables a single client (whether it is a field on an
  update call or a dedicated route, and what it does to an inbound's other clients);
- how it deletes one, and what it returns when the client is already gone — which
  decides whether a repeated `TERMINATE` is idempotent or an error;
- whether Marzban's API supports the same three, and whether its descriptor should gain
  them in this phase or stay at four.

`docs/open-questions.md` takes anything that cannot be settled from the source rather
than a guess, per the rule this file's own phase is bound by.

## Carried in from 4D

`OQ-PROV-01` — a connection reset after the request is sent reads as `UNREACHABLE` —
becomes more expensive here, not less: it is contained for `PROVISION` because the
derived username makes a replay collide, and `TERMINATE` has no such collision. A
delete replayed after a lost answer deletes nothing the second time, which is harmless,
but a `SUSPEND` replayed against a service an operator resumed in between is not. The
dispatch must classify each new type's mutations through the existing
`failureOutcome`, never a new table.

`OQ-PROV-02` — the announcement uses the bot the customer FIRST wrote to — is a
natural fit for this phase, because it wants a column on `orders` and this phase is
already in the service lifecycle. It is listed as a candidate, not a commitment.
