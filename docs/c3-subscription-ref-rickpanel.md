# C3 — `subscription_ref` compatibility for adopted RickPanel accounts

**Conclusion: `SAFE_WITH_CONSTRAINTS`** — decided from code evidence (program 4, Item 3,
finalised 2026-10-04). The real-panel confirmation is **MANUAL ACCEPTANCE, NOT RUN**:
there are no RickPanel credentials in this environment, no experiment here touched a
panel, and nothing in this file is a result from a real panel. The one command that
confirms it is in "Manual acceptance" below; it is read-only by construction.

## The program's five questions, answered (program 4, Item 3)

| #   | Program question                                                                                | Answer (code evidence)                                                                                                                                                                                                                                            | Real-panel confirmation                    |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | Can an existing provider account use a local NEXA `subscription_ref` without provider mutation? | **Yes.** No RickPanel request carries the ref (Evidence 1, pinned by `tests/unit/rickpanel-subscription-ref.test.ts`, mutation-checked). A freshly minted 32-hex ref is consistent with any account by construction; nothing on the panel is told about it.       | not needed — a property of NEXA's own code |
| 2   | Does config/subscription retrieval need a mutation?                                             | **No.** The link comes from `GET api/user/{username}` (`subscriptionFrom`), the files from `GET api/user/{username}/files`, and the customer's client fetches the link with a `GET` (Evidence 2, 3).                                                              | MANUAL: C3 step, checks 1–4                |
| 3   | Rotation?                                                                                       | **No ref rotation exists for RickPanel, and adoption must not rotate.** "New link" is `revoke_sub`, a provider WRITE that changes the panel's token and `services.subscription_url`, never `subscription_ref` (Evidence 4). `OQ-RP-07` is irrelevant to adoption. | not part of migration acceptance           |
| 4   | Uniqueness scope?                                                                               | **Per NEXA panel row** — `services_panel_subscription_ref_key (panel_id, subscription_ref)` (migration 0045), 128 random bits. RickPanel has no ref, so no provider-side scope applies.                                                                           | not needed                                 |
| 5   | Can an adopted account remain usable with zero provider mutation?                               | **Yes, under the six constraints below**: store the panel's own link read at adoption, mint the ref normally, store the exact provider spelling, reserve the name, never a CREATE path, no write during adoption.                                                 | MANUAL: C3 step, checks 5–7                |

Why `SAFE_WITH_CONSTRAINTS` and not `SAFE`: the answer to 5 holds only if P6 honours the
constraints (each is a way an adoption could break a working account or mint a broken
link), and whether a real RickPanel serves a pre-existing account's link exactly as the
code expects (`subscription_url` on the record, `OQ-RP-01`) is confirmed only by the
manual step. Not `BLOCKED`: nothing in the code requires a provider write to adopt.

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

## Constraints P6 must honour (the "WITH CONSTRAINT")

1. **Store the provider's own link, read at adoption time** — `services.subscription_url`
   from `lookupUser`'s `delivery`. Never construct one from `subscription_ref`, and never
   call `rotateSubscription` to "get" a link. If the read yields no link (`delivery: NONE`),
   the service is adopted without one and the operator decides; nothing writes.
2. **Mint the ref the normal way** — `secrets.hex(SUBSCRIPTION_REF_BYTES)` in the adoption
   transaction — so the local CHECK and the per-panel unique index hold and the value is a
   capability nobody can compute. Do not derive it from the legacy row or the panel token.
3. **Store the username exactly as the panel spells it.** Every RickPanel route addresses
   the account by `encodeURIComponent(username)`. The P5 inventory keeps the panel's
   exact spelling (`providerUsername`) beside the lowercase key, and an `ELIGIBLE` match
   carries it: store THAT, never `lower(username)`, which the panel may not resolve. Where
   two spellings fold to one key on a panel (`Alice`, `alice`) the match is
   `USERNAME_CASE_COLLISION` manual review, never eligible. (The legacy audit found zero
   mixed-case names, so this is expected to be empty.)
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

**Status: MANUAL ACCEPTANCE, NOT RUN.** The read-only step is code
(`tests/acceptance-readonly/subscription-acceptance.ts`, driven by
`tests/acceptance-readonly/real-rickpanel-subscription.test.ts`) and runs in the same
command as C1, with the same variables:

```bash
pnpm install --frozen-lockfile
NEXA_INVENTORY_RICKPANEL_URL='https://<panel-address>' \
NEXA_INVENTORY_RICKPANEL_USERNAME='<admin>' \
NEXA_INVENTORY_RICKPANEL_PASSWORD='<password>' \
NEXA_INVENTORY_KNOWN_USERNAME='<a LEGACY account NEXA did not create, spelled exactly as the panel spells it>' \
NEXA_INVENTORY_PAGE_SIZE=50 \
NEXA_INVENTORY_DRIFT_TOLERANCE=0 \
pnpm test:acceptance:inventory
```

Only if the panel serves subscriptions from a SEPARATE host, also set
`NEXA_INVENTORY_SUBSCRIPTION_ORIGIN='https://<subscription-host>'` — a bare origin,
exactly, or the run refuses to start. Unset (the default), the link is fetched only when
it is on the panel's own origin (`NEXA_INVENTORY_RICKPANEL_URL`'s). A link anywhere else
— a private address, a metadata endpoint, a host nobody named — is refused WITHOUT a
request (`fetch.failure: ORIGIN_NOT_ALLOWED`) and the run fails. This allowlist was
chosen over re-deriving the installation's `PANEL_HTTP_DENIED_SUBNETS` policy because it
is strictly narrower: an operator names the one host they expect, and a malformed record
cannot aim the step at anything else.

C3 alone: `pnpm test:acceptance:inventory real-rickpanel-subscription` (C1 alone:
`pnpm test:acceptance:inventory real-rickpanel-inventory`). Without the variables the
suite FAILS; it never skips. Put the password in the environment from a secret store,
not shell history.

What the step does, for the one known account:

1. login exchange + `GET api/user/{name}` through `readOnlyRickpanelHttp` — the inventory's
   three fixed reads, never the adapter. The record must name the account asked for, in
   its exact provider spelling (`username === NEXA_INVENTORY_KNOWN_USERNAME`); any other
   2xx record is `WRONG_ACCOUNT` and fails;
2. the link from that record by the adapter's own `subscriptionFrom` (what `lookupUser`
   delivers and P6 stores) — never built from `subscription_ref`;
3. ONE `GET` of that link — only on the panel's origin or the one allowed above —
   through a guard that refuses, without sending, anything but a `GET`. The body is
   CLASSIFIED and dropped: base64 or plain share links (every non-empty line a
   `vless://`, `vmess://`, `trojan://`, `ss://`, `ssr://`, `hysteria(2)://`, `hy2://`,
   `tuic://`, `wireguard://`/`wg://`, `socks://` or `anytls://` link), a JSON client
   config (`outbounds`), or a Clash config (`proxies:` with named entries). A login,
   WAF or error page is `UNRECOGNISED` and fails, however many bytes it has;
4. login exchange + `GET api/user/{name}` again, and a comparison of every field a write
   would change (`username`, `status`, `expire`, `data_limit`,
   `data_limit_reset_strategy`, `sub_token`, `subscription_url`, `subscription_token`,
   `links`, `proxies`, `inbounds`, `note`, `on_hold_*`, `auto_delete_in_days` — every
   documented `PUT /api/user/{username}` property, `docs/provider-capability-audit.md`)
   — by digest, never printed. The documented modify set's three telemetry properties
   (`sub_updated_at`, `sub_last_user_agent`, `online_at`) are reported by name instead,
   because a client's own GET moves them.

Checks (all must pass): known account read by GET; the panel's record carries a
subscription link; the link answers 2xx to a GET; the served body is non-empty; the
served body is a recognised subscription format; the account reads the same afterwards; no write-relevant field changed; no write was
attempted.

Printed (`C3 evidence {...}`, safe to paste): whether a link was present, whether it is
on the panel's origin, the fetch's status, its media type (from an allowlist —
`text/plain`, `text/html`, `application/json`, `application/octet-stream`, the YAML types —
else `OTHER`; never the header as sent, which could carry a token in a parameter), the
body's **format classification and entry count**, its **byte count**, the NAMES of
changed fields, request and refusal counts. Never the username, the link, a token or any
byte of the body.

**The one thing a GET does change.** A Marzban-lineage panel records a client's fetch in
`sub_updated_at` / `sub_last_user_agent` (and traffic/`online_at` move with use). That is
the panel's own telemetry of a read, exactly what the customer's client produces daily;
it is reported by name (`changedTelemetryFields`) and is not a failure. It is not a
request NEXA made to change the account: provider mutation count stays 0. The step fetches
the link once, on purpose.

**Reading the result.** All checks pass → record the printed JSON and the panel version
under "Results", and C3 becomes `ACCEPTED` (`SAFE_WITH_CONSTRAINTS` confirmed). "record
carries a subscription link" failing → the record shape differs from `OQ-RP-01`'s answer
for pre-existing accounts: capture the top-level KEYS of the record by hand (not values),
correct `subscriptionFrom` and the fake in one commit, re-run; until then P6 adopts
without a link (constraint 1) and the operator decides. `WRONG_ACCOUNT` → the panel
answered for a different account than the exact name given: check the spelling, never
fold it. `ORIGIN_NOT_ALLOWED` → the record points off the panel's origin: if that host
is the panel's real subscription host, set `NEXA_INVENTORY_SUBSCRIPTION_ORIGIN` to it and
re-run; otherwise the record is wrong and C3 is `BLOCKED` for link delivery. "2xx",
"non-empty" or "recognised subscription format" failing →
the panel does not serve the stored link from where the record says: C3 is `BLOCKED` for
link delivery until resolved. A write-relevant field changing → someone changed the
account during the run, or the panel mutates on read: re-run at a quiet hour; if it
persists, C3 is `BLOCKED`.

The same step runs against the fake panel in
`tests/unit/rickpanel-subscription-acceptance.test.ts`, which proves the mechanics (each
check can fail; nothing but reads is sent; the report carries no username, link, token
or body) and is **not** evidence about RickPanel.

- `OQ-RP-07` (old link refused after `revoke_sub`) is a WRITE experiment and is **not part
  of migration acceptance**; it stays open and is irrelevant to adoption as long as
  adoption never rotates.

## Results

_None yet. MANUAL ACCEPTANCE, NOT RUN._
