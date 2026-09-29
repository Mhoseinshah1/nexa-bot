# Provider capability audit: LOCATION_CHANGE and DEVICE_LIMIT_ADJUSTMENT (HF-A6A8)

**Status.** Audit complete. **Verdict: neither capability is declared for any provider in
this release.** No adapter method was written for either. This document says, per provider,
what the repository's evidence shows and what would have to happen before either could be
declared.

**Question asked by the owner.** A pre-release report said that no real provider advertises
`LOCATION_CHANGE`. The owner asked for two things:

- a Web Admin switch for «تغییر لوکیشن سرویس», shown and accepted only where the adapter
  really supports the capability. That switch is built; see the last section.
- an audit of every provider. Where a provider has a real, safe API, implement and advertise
  the capability. Where it does not, fake nothing and say exactly why. The same rule applies
  to `DEVICE_LIMIT_ADJUSTMENT`.

## The bar a capability has to clear

CLAUDE.md sets the bar, and this audit applies it unchanged:

- **Declared after real-panel acceptance, never before.** `capabilities` is what the product
  promises an operator. The guards `canChangeLocation` and `canAdjustDeviceLimit` in
  `packages/contracts/src/provider.ts` need both methods AND the declaration.
- **A fake proves nothing about a provider.** A fake this repository wrote and an adapter
  this repository wrote can only prove that they agree with each other. Four defects reached
  `main` that way (`docs/real-panel-acceptance.md`).
- **3X-UI gains no new mutable scope.** This is the owner's correction in
  `docs/phase4e-audit.md`, "Scope correction, mid-phase: Marzban only".
- **No real panel is available here.** `pnpm test:acceptance` fails rather than skips
  without one, and this environment has none. Acceptance evidence can therefore only come
  from what is already recorded in the repository.

The port contract adds its own conditions, stated on `readLocation` / `applyLocation` and
`readDeviceLimit` / `applyDeviceLimit` in `provider.ts`:

- The write is an **absolute target**, so a replay is a no-op.
- A **read of the panel's own record** settles every ambiguous write. A write whose answer
  was lost is never resent blind.
- A move moves **the same account on the same panel**. It is never a delete followed by a
  re-create, and never a move to another panel.
- A device-limit write **never lowers** a limit the panel already holds at or above the
  target.
- A move reports the subscription link the panel serves **afterwards**, read from the panel.

An endpoint that exists is not enough. Each of these rules is a property that has to be
observed on a real panel.

## Sources read

| Source                                                                                                                | What it is                                                                                                                    | Weight                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `apps/api/src/modules/platform/providers/infrastructure/{marzban,rickpanel,sanaei}.adapter.ts`, `adapter-registry.ts` | The three registered adapters: `marzban`, `rickpanel` and `sanaei`. `PROVIDER_TYPES` has no other.                            | What the product can do today                                                                               |
| `packages/contracts/src/provider.ts`, the descriptors                                                                 | Each descriptor's capability list, and the recorded reason each capability is absent                                          | The promise                                                                                                 |
| `docs/providers/marzban.md`, `docs/providers/sanaei-3xui.md`, `docs/providers/rickpanel.md`                           | Wire contracts, read from upstream source at pinned commits (Marzban, 3X-UI) or from the owner's OpenAPI document (RickPanel) | Evidence for the routes they list                                                                           |
| `docs/real-panel-acceptance.md`, `tests/acceptance/real-panel-{marzban,sanaei,rickpanel}.test.ts`                     | What was run against a real panel binary                                                                                      | The only acceptance evidence                                                                                |
| `docs/rickpanel-adapter-audit.md`, `docs/rickpanel-rotate-audit.md`, `docs/package-e-rickpanel-files-audit.md`        | The RickPanel contract comparison                                                                                             | Evidence. `rickpanel-openapi.json` itself is not vendored; these audits quote it                            |
| `docs/phase4e-audit.md`                                                                                               | The owner's 3X-UI freeze                                                                                                      | Decision                                                                                                    |
| `docs/open-questions.md` `OQ-WPA6-01`                                                                                 | WP-A6's own statement of the gap                                                                                              | Open question                                                                                               |
| `tests/support/fake-{marzban,3xui,rickpanel}.ts`                                                                      | Fakes                                                                                                                         | None as evidence. No fake implements a location or device-limit route, and one that did would prove nothing |
| `docs/research/` (the MirzaBot 3X-UI and Marzban investigations)                                                      | Research on the legacy bot's UI                                                                                               | Evidence of what the LEGACY product offered, not of any provider API                                        |

One finding from the research matters for the location question. PBR-006 in
`docs/research/mirzabotmarzbanpanelinvestigation/panel-management-knowledge/business-rules.md`
records that the legacy bot's «تغییر لوکیشن» meant moving a service **from one panel to
another**. That is a delete on one panel and a create on another. The Nexa contract
excludes exactly that, so the legacy feature is no evidence that any provider can move an
account.

## The table

| Provider                             | Capability                | Evidence in the repository                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Verdict                                                                             | Exact blocker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Marzban v0.8.4** (`7f396db3`)      | `LOCATION_CHANGE`         | Read from the source, not run: `UserModify.inbounds` on `PUT /api/user/{username}`, which `crud.update_user` turns into `excluded_inbounds` (descriptor comment and `OQ-WPA6-01`). A `Node` serves every inbound, so no node can be assigned to one user. The adapter never reads an account's inbounds: `lookupUser` and `readUsage` read usage and status. The acceptance suite (A1 to A8) contains no inbound modify. `docs/providers/marzban.md` already records one case where the source's apparent meaning of `inbounds` was the opposite of the panel's.               | **Not supported.** Nothing implemented, nothing declared.                           | **Needs real-panel acceptance of `PUT /api/user/{username}` with `inbounds`**: what the account serves afterwards, what its subscription link is, whether the same body sent twice changes nothing, and whether usage, expiry and status survive. It also needs a READ of the account's inbound set, which has not been verified, and an **owner decision on which inbound set counts as a "location"** for an operator. Until then an `applyLocation` could not honestly satisfy the contract. |
| **Marzban v0.8.4**                   | `DEVICE_LIMIT_ADJUSTMENT` | Read from the source: the `User` table (`app/db/models.py`) and `UserCreate` / `UserModify` (`app/models/user.py`) have no per-user device, IP or connection limit. Their fields are proxies, inbounds, expiry, data limit, reset strategy, note and on-hold (descriptor comment). `PROVIDER_RULES` for Marzban is `deviceLimitOnCreate: NOT_SENT`.                                                                                                                                                                                                                            | **Not supported.**                                                                  | **The API has no such operation**: v0.8.4 has no field to raise. A later Marzban release would be a new pinned contract and would need its own acceptance.                                                                                                                                                                                                                                                                                                                                      |
| **RickPanel**                        | `LOCATION_CHANGE`         | The owner's `rickpanel-openapi.json`, quoted in `docs/rickpanel-adapter-audit.md` §2 and `docs/providers/rickpanel.md`, says that on create "`inbounds` and a partial `proxies` set are accepted but ignored: every user gets every protocol and every inbound". On modify it says "you cannot take protocols or inbounds away here". None of the modify route's twelve properties (next row) places an account on a node or host.                                                                                                                                             | **Not supported.**                                                                  | **The API has no such operation**: a RickPanel account has no location of its own to change. It would need a documented per-account placement route, and then real-panel acceptance.                                                                                                                                                                                                                                                                                                            |
| **RickPanel**                        | `DEVICE_LIMIT_ADJUSTMENT` | The same OpenAPI document gives `PUT /api/user/{username}` exactly twelve properties: `proxies`, `expire`, `data_limit`, `data_limit_reset_strategy`, `inbounds`, `note`, `sub_updated_at`, `sub_last_user_agent`, `online_at`, `on_hold_expire_duration`, `on_hold_timeout` and `auto_delete_in_days`. None of them bounds devices, IPs or connections. The only mention of devices is a "multi-device warning" on the subscription page (descriptor comment). No RickPanel acceptance has been run at all (`docs/providers/rickpanel.md`, "What has NOT been verified").     | **Not supported.**                                                                  | **The API has no such operation** in the documented contract. Separately, no RickPanel acceptance has ever been run, so even a documented field would still need a real panel.                                                                                                                                                                                                                                                                                                                  |
| **Sanaei 3X-UI v3.7.0** (`f727d04f`) | `LOCATION_CHANGE`         | `GET panel/api/clients/get/:email` answers `{client, inboundIds, …}`, and `POST panel/api/clients/update/:email` is registered in `internal/web/controller/client.go` (`docs/providers/sanaei-3xui.md`, service-half table). What `update` does with `inboundIds` has been neither read nor measured. The adapter uses only `clients/add` and `clients/traffic`.                                                                                                                                                                                                               | **Not supported.**                                                                  | **Owner decision: 3X-UI gains no new mutable scope** (`docs/phase4e-audit.md`). Moving a live client is exactly that. Even with the freeze lifted, it **needs the `update` route's `inboundIds` semantics read from the v3.7.0 source, and real-panel acceptance** of the move, the replay, the link and the sibling clients.                                                                                                                                                                   |
| **Sanaei 3X-UI v3.7.0**              | `DEVICE_LIMIT_ADJUSTMENT` | The strongest evidence of the six. `limitIp` is 3X-UI's per-client device limit (`internal/database/model/model.go`). `createUser` writes it, and real-panel acceptance A5 read it back through the panel's own operator API (`tests/acceptance/real-panel-sanaei.test.ts`), which is why `LIMIT_DEVICES` is declared. `clients/update/:email` exists. What has NOT been established: whether `update` needs the whole client object or takes a partial one, whether it takes the CSRF token in session mode as `add` does, and what a replay does. None of this has been run. | **Not supported.** A route and a field exist, but updating a live client is frozen. | **Owner decision: 3X-UI gains no new mutable scope** (`docs/phase4e-audit.md`). Raising a live client's `limitIp` is new mutable scope. Lifting the freeze is the owner's call. After that it **needs acceptance of `POST panel/api/clients/update/:email` carrying `limitIp`**: that it changes only that client, keeps traffic, expiry and `enable`, never lowers a higher limit, and that a replay is a no-op. `readDeviceLimit` would read `clients/get/:email`.                            |

## Why nothing was implemented behind the ports

The owner's instruction allows implementing an adapter method, without declaring the
capability, where a provider has a real, repository-evidenced API. Four of the six rows have
no API at all: Marzban's device limit, and both of RickPanel's capabilities. The two 3X-UI
rows have a route, but mutating a live client on 3X-UI is what the owner froze, and the
route's semantics for either field are unread. Writing `applyDeviceLimit` or `applyLocation`
there would mean one of two things:

- guessing the body of `clients/update`. That is exactly how two wrong routes and a dropped
  CSRF token reached `main` on 3X-UI's create path.
- building mutable scope the owner said not to build.

On Marzban, `applyLocation` over `inbounds` is expressible. Even so:

- it would need an inbound READ nobody has verified;
- it would need a meaning of "location" nobody has decided;
- it would rely on the one field whose documented meaning a real panel has already
  contradicted once.

An undeclared method is not harmless, either. The registry would show it as
`NOT_DECLARED` ("implemented, not yet proven against a real panel"), which is a claim about
the code's quality that nothing supports.

## What the customer and the operator see

- **The capability registry** on a panel's «قابلیت‌ها» tab shows both rows as unsupported
  on every provider, with the gap `NOT_SUPPORTED`. It is derived from the adapter on every
  read, never stored. `tests/unit/panel-advanced-settings.test.ts` pins that
  location change reads unsupported everywhere, and `tests/unit/registries.test.ts` pins
  that no provider declares either capability.
- **The «تغییر لوکیشن سرویس» switch** (HF-A6A8) is drawn on every panel. On every panel in
  this release it is disabled, and the registry's reason is shown beside it.
  - The server refuses a new or changed `LOCATION_CHANGE` policy entry with
    `panel.policy_capability_unsupported`, through `unsupportedPolicyActions` over the derived
    registry.
  - A stored entry is kept when it is sent back unchanged, under A8's existing rule.
  - On a panel whose adapter implements and declares the capability, the switch works. Off,
    it refuses the button, the choice screen, the tapped target, the quote, the quote's
    confirmation and the free request (`tests/integration/location-change.test.ts`, which
    runs against a scripted provider and says so).
- **No customer is offered either action on any panel.** A crafted callback, a direct quote
  or a free request is refused with `PANEL_NOT_OPERABLE` before an order exists.

## What declaring one would take

For whichever provider comes first, in this order. This is the order `OQ-WPA6-01` already
sets out.

1. **The decision.** For 3X-UI, the owner lifts the freeze for that operation. For Marzban's
   location, the owner decides which inbound set an operator's "location" means.
2. **The contract, read.** Read the route and the field semantics out of the pinned upstream
   source and record them in `docs/providers/<provider>.md`.
3. **The adapter.** Implement both methods, the read and the absolute write, to the port's
   rules in `provider.ts`.
4. **Acceptance.** Add cases to `tests/acceptance/real-panel-<provider>.test.ts` and run them
   against a disposable panel. They must show:
   - the target lands;
   - a replay changes nothing;
   - a sibling account is untouched;
   - a device limit is never lowered;
   - the subscription link the panel serves afterwards is what the adapter reports.
5. **The fake.** Correct it to match the panel, in the same commit.
6. **The declaration.** Add the capability to the descriptor. In the same commit, edit the
   registry tests that pin "no provider declares it". The Web Admin switch then becomes
   usable for that provider with no further change.
