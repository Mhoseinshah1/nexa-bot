# C3 — `subscription_ref` compatibility for adopted RickPanel accounts

**Conclusion: SAFE WITH CONSTRAINT** (code-side). The provider-dependent points below are
**MANUAL ACCEPTANCE**, not run: there are no RickPanel credentials in this environment,
and no experiment here touched a panel. P6 stays HOLD.

## Background

`services.subscription_ref` is 32 lowercase hex — 16 random bytes
(`SUBSCRIPTION_REF_LENGTH` / `SUBSCRIPTION_REF_BYTES`, `packages/contracts/src/provisioning.ts`),
minted in the settling transaction by `ProvisioningService`
(`provisioning.service.ts`, `subscriptionRef: this.deps.secrets.hex(SUBSCRIPTION_REF_BYTES)`),
CHECK-pinned to `^[0-9a-f]{32}$` and unique per panel by
`services_panel_subscription_ref_key (panel_id, subscription_ref)` (migration `0045`). It is
treated as a bearer capability (`infrastructure/redaction.ts` redacts it).

## Evidence

1. **No RickPanel operation sends it.** `rickpanel.adapter.ts` never reads
   `ref.subscriptionRef` / `input.subscriptionRef`: create sends exactly `username`, `expire`,
   `data_limit`, `data_limit_reset_strategy` and the fixed `proxies` seed; read, modify, delete,
   `revoke_sub` and `/files` address the account by `username` only. The only adapter that
   uses the ref is 3X-UI (`sanaei.adapter.ts`, as the client `subId` and in
   `https://<subscriptionDomain>/sub/<subId>`). Marzban does not use it either.
   **Pinned by a test**: `tests/unit/rickpanel-subscription-ref.test.ts` runs create, lookup,
   usage, suspend, resume and files through the adapter and asserts the ref appears in no
   request path or body (mutation-checked: adding the ref to the create body fails it).
2. **The customer's link comes from the panel's record, never from the ref.**
   `subscriptionFrom` in `rickpanel.adapter.ts` takes `subscription_url` (OQ-RP-01, answered
   by the owner's calls in `docs/rickpanel-create-hotfix.md` §2), else
   `subscription_token` joined onto the panel's own `/sub/{token}` route, else `links[0]`;
   `lookupUser` returns it as `delivery`. The same test shows an account NEXA did not
   create, read under two different local refs, yields the panel's own link both times,
   containing neither ref.
3. **Reading needs no write.** `lookupUser`/`readUsage` are `GET /api/user/{username}`
   after the token exchange (a `POST` the panel contract makes a read, `effect: 'READ'`).
   `fetchSubscriptionFiles` is `GET /api/user/{username}/files`. The test asserts every
   request after seeding was a GET or the token exchange and the panel's token did not
   change.
4. **Rotation is a provider write and does not touch the ref.** `rotateSubscription` is
   `POST /api/user/{username}/revoke_sub`, then a read; the new link is stored in
   `services.subscription_url`. Nothing updates `subscription_ref` after insert (the
   repository only inserts it). Owner evidence (`docs/rickpanel-rotate-audit.md` §2): a
   rotation changes `subscription_url` and `sub_token` and nothing else; whether the OLD
   link is then refused is unproven (`OQ-RP-07`).

## The five questions

| #   | question                                                                                            | answer                                                                                                                                                                                                                                           | basis              |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| 1   | Can NEXA store a random local ref for an existing provider account without changing provider state? | **Yes.** For RickPanel the ref never leaves NEXA, so any random 32-hex value is consistent with the panel by construction.                                                                                                                       | Evidence 1, test   |
| 2   | Does config/subscription fetch need a provider mutation?                                            | **No.** The link is read from `GET /api/user/{username}`; `/files` is a GET.                                                                                                                                                                     | Evidence 2, 3      |
| 3   | Effect of ref rotation?                                                                             | **None on the provider.** NEXA has no ref-rotation for RickPanel; the product's "new link" is `revoke_sub` (a provider WRITE) which changes the panel token and `services.subscription_url`, never `subscription_ref`. Adoption must not rotate. | Evidence 4         |
| 4   | Uniqueness scope?                                                                                   | **Per NEXA panel row**, `(panel_id, subscription_ref)`, enforced locally; 128 random bits. No provider-side uniqueness is involved for RickPanel. (For 3X-UI, where the ref IS the `subId`, the scope would matter — not this provider.)         | Evidence 1, schema |
| 5   | Is any provider write required to make an adopted service usable?                                   | **No, under the constraints below.**                                                                                                                                                                                                             | all                |

## Constraints P6 must honour (the "WITH CONSTRAINT")

1. **Store the provider's own link, read at adoption time** — `services.subscription_url`
   from `lookupUser`'s `delivery`. Never construct one from `subscription_ref`, and never
   call `rotateSubscription` to "get" a link. If the read yields no link (`delivery: NONE`),
   the service is adopted without one and the operator decides; nothing writes.
2. **Mint the ref the normal way** — `secrets.hex(SUBSCRIPTION_REF_BYTES)` in the adoption
   transaction — so the local CHECK and the per-panel unique index hold and the value is a
   capability nobody can compute. Do not derive it from the legacy row or the panel token.
3. **Store the username exactly as the panel spells it.** Every RickPanel route addresses
   the account by `encodeURIComponent(username)`. The P5 inventory reports
   `providerSpellingDiffers`; the legacy audit found zero mixed-case names, but a name the
   panel spells differently from `lower(username)` must be stored in the panel's spelling or
   go to manual review — not be lower-cased into a name the panel may not resolve.
4. **Reserve the adopted name** in `service_username_reservations` under the panel's
   namespace (provider type + host), funded, exactly as a purchase does — otherwise a new
   customer can choose the adopted name, and the create would hit the 409 refusal path.
5. **Never put an adopted service on a CREATE path.** `assertSendableProviderUsername`
   (only on create) accepts `[a-z0-9_-]{4,20}` or the old `nx`+32-hex shape; legacy names
   outside that are fine for read/modify/delete but would throw on a create. An adopted
   service is inserted in its live state with no CREATE operation, so nothing reconciles it
   by re-creating.
6. **No rotation, enable/disable, renew or allowance write during adoption** (§1.3). The
   first provider write on an adopted service is an ordinary operator or customer action
   afterwards, through the existing guarded paths.

## Manual acceptance (provider-dependent, NOT RUN)

Read-only, on a production-like RickPanel, for a few known legacy accounts:

- `GET /api/user/{username}` returns `subscription_url` (or `subscription_token`) for
  accounts NEXA did not create — i.e. OQ-RP-01's answer holds for pre-existing accounts, not
  only NEXA-created ones. (`pnpm test:acceptance:inventory` reads these records but
  deliberately does not output links; check presence by hand, print nothing.)
- The link read that way serves a non-empty subscription from the panel's subscription
  host — a GET by the customer's client, which is a read; record only status and byte
  count, never the URL.
- Reading the account (GET) changes nothing visible on the panel: compare `sub_updated_at`,
  `sub_token` presence and status before/after, aggregate only.
- `OQ-RP-07` (old link refused after `revoke_sub`) is a WRITE experiment and is **not part
  of migration acceptance**; it stays open and is irrelevant to adoption as long as
  adoption never rotates.
