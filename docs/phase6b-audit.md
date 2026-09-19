# Phase 6B audit — what panels and providers already do

Read before building. Every row is a claim about code at `155ac67`, with the
file and line that supports it, because the point of the audit is to stop 6B
rebuilding what Phase 3 already shipped.

The short version: **the panel module is largely complete.** Create, edit,
enable, disable, archive, encrypted credentials, credential replacement,
connection test, background health, capability enforcement, tenant isolation,
SSRF and stale-write protection all exist and are tested. Three things are
genuinely absent — capacity, health-aware eligibility, and any panel surface in
Telegram — and one is absent on purpose.

## The core, item by item

| #   | Capability                           | State                 | Where                                                                                                                                                                                                                                         |
| --- | ------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | create                               | EXISTS                | `panel.service.ts:462`, `POST /panels`                                                                                                                                                                                                        |
| 2   | edit (name, base URL, activation)    | EXISTS                | `panel.service.ts:754`. `providerType` is deliberately not editable                                                                                                                                                                           |
| 3   | enable / disable                     | EXISTS                | `panel.service.ts:1053` (`setStatus`)                                                                                                                                                                                                         |
| 4   | archive                              | EXISTS                | same route with `status: 'ARCHIVED'`; `panels.archived_at` + `panels_archived_at_check` (`schema.ts:1328`). There is no hard delete anywhere                                                                                                  |
| 5   | encrypted credential storage         | EXISTS                | `panel_credentials` (`schema.ts:1364`), per-field ciphertext + `key_id` + `set_at`, no plaintext column. AEAD context is `(purpose, tenantId, panelId)`, rebuilt from arguments and never stored                                              |
| 6   | credential rotation                  | EXISTS as **replace** | `panel.service.ts:920`, charged `panels.credentials.rotate` (CRITICAL). Three-state per field: absent leaves, `null` removes, a value replaces                                                                                                |
| 7   | connection test                      | EXISTS                | `panel.service.ts:1299`, `POST /panels/:id/test`                                                                                                                                                                                              |
| 8   | health monitoring + failure evidence | EXISTS                | `panel-monitor.service.ts`, its own process role. `panel_health` is latest-state-only; the history and the evidence are `operational_events` with one open condition per (panel, condition)                                                   |
| 9   | **capacity**                         | **ABSENT**            | No `max_services`, load, weight or priority column exists. `schema.ts:1248` states the omission deliberately. The only "capacity" in the module is the outbound probe token bucket, which is unrelated                                        |
| 10  | assignment eligibility               | **PARTIAL**           | A product pins one panel (`products.panel_id`); the catalogue checks only that it is non-null (`catalog-visibility.ts:46`). Neither panel STATUS nor health is consulted                                                                      |
| 11  | inbound discovery                    | **ABSENT**            | No `listInbounds` on any adapter or port, and neither fake serves an inbounds route                                                                                                                                                           |
| 11b | inbound selection                    | EXISTS                | `panels.activation`, parsed per provider by `PANEL_ACTIVATION_SCHEMAS`. Guessing a default inbound is explicitly refused (`provider.ts:176`)                                                                                                  |
| 12  | provider capability enforcement      | EXISTS                | `decideOperability` (`panel-operability.ts:70`), six ordered refusals; double-gated predicates require method AND declaration                                                                                                                 |
| 13  | tenant isolation                     | EXISTS                | Every repository method takes a `TenantContext`; composite `(tenant_id, panel_id)` FKs on all four child tables; `SystemContext` refused outright                                                                                             |
| 14  | SSRF protections                     | EXISTS, three layers  | URL policy at write time, re-checked at probe time, address pinned in the socket. Redirects not followed                                                                                                                                      |
| 15  | concurrency / stale-write            | EXISTS                | No version column by design. `SELECT … FOR UPDATE` first on every mutation, idempotency key + request hash, `checked_at` guard that reports `STALE_IGNORED`, and a configuration fingerprint re-checked under the lock after the network call |

Three permission keys exist and no more: `panels.view` (LOW), `panels.edit`
(HIGH), `panels.credentials.rotate` (CRITICAL). No built-in role but `owner`
holds the third.

**No panel response carries a credential, a ciphertext, a key id or a masked
stand-in.** The masked placeholder is explicitly rejected in both the contract
and the controller, for the reason CLAUDE.md gives: `********` can be
resubmitted as the real password.

## Marzban — ten declared capabilities

| Capability                  | Implemented              | Declared           | Real-panel evidence |
| --------------------------- | ------------------------ | ------------------ | ------------------- |
| `CREATE_USER`               | `marzban.adapter.ts:306` | yes                | A1                  |
| `READ_USAGE`                | `:651`                   | yes                | A2                  |
| `DISABLE_USER`              | `:589`                   | yes                | A3                  |
| `ENABLE_USER`               | `:598`                   | yes                | A4                  |
| `DELETE_USER`               | `:620`                   | yes                | A5                  |
| `RENEW_USER`                | `applyAllowance :529`    | yes                | A8                  |
| `ADD_VOLUME`                | same method              | yes                | A8                  |
| `ADD_TIME`                  | same method              | yes                | A8                  |
| `DELIVER_SUBSCRIPTION_LINK` | —                        | yes                | A1                  |
| `HEALTH_CHECK`              | `:261`                   | yes                | indirect            |
| reconcile (`lookupUser`)    | `:386`                   | needs none         | A2                  |
| inbound discovery           | ABSENT                   | no such capability | —                   |
| capacity reporting          | ABSENT                   | —                  | —                   |

One method serves renew, add-traffic and add-time because on the pinned binary
all three are one `PUT /api/user/{username}` carrying an ABSOLUTE target. That
is what makes them replayable.

## 3X-UI — five declared capabilities

| Capability                     | Implemented             | Declared   | Evidence   |
| ------------------------------ | ----------------------- | ---------- | ---------- |
| `CREATE_USER`                  | `sanaei.adapter.ts:746` | yes        | A1, A5, A6 |
| `READ_USAGE`                   | `:882`                  | yes        | A3         |
| `DELIVER_SUBSCRIPTION_LINK`    | —                       | yes        | A4         |
| `LIMIT_DEVICES`                | `:389`                  | yes        | A5         |
| `HEALTH_CHECK`                 | `:477`                  | yes        | A7, A8     |
| reconcile (`lookupUser`)       | `:820`                  | needs none | A2, A6     |
| suspend / resume / terminate   | **ABSENT**              | **ABSENT** | none       |
| renew / add-traffic / add-time | **ABSENT**              | **ABSENT** | none       |
| inbound discovery              | ABSENT                  | —          | —          |

Nothing is implemented-but-undeclared or declared-but-unimplemented on either
adapter, and `registries.test.ts:388` enforces the implication.

**3X-UI gains nothing in 6B.** The owner's correction in
`docs/phase4e-audit.md:161` is the reason, and it is not a preference: the three
wire facts a mutation would need — how v3.7.0 disables one client, how it
deletes one and what it answers when already gone, and what each does to the
inbound's other clients — were never read from source and never run against the
binary. The fake serves no update or delete route either, so a mutation written
today could not be tested even against our own stand-in. An unsupported mutation
is refused by `decideOperability` before a request is sent, and no surface draws
a button for one.

## Inbound discovery is evidence-blocked, not deferred by preference

Marzban's real API has `GET /api/inbounds`. This repository's rule is that a
provider behaviour is verified against the real binary and the fake is corrected
to match in the same commit — `docs/real-panel-acceptance.md` exists because
four defects reached `main` behind a green suite written against a fake that
agreed with its adapter. There is no disposable panel in this environment, so
building discovery here would mean writing an adapter method and a fake route
that agree with each other and prove nothing.

So 6B does not build it. Inbound SELECTION already exists and is covered by
tests; DISCOVERY waits for a phase that can stand a panel up.

## What 6B builds

1. **Panel capacity** — an optional operator-set soft cap, `NULL` meaning
   unlimited, enforced by an atomic slot reservation rather than a count.
   Usage is active and provisioning services plus unexpired reservations. A slot
   is reserved before payment is accepted, released on payment or order expiry,
   rejection or cancellation, and consumed when provisioning succeeds. The
   re-check is atomic so two concurrent purchases cannot oversell the last slot.
   Lowering a cap below current usage never terminates anything; it refuses new
   sales until usage falls back under the cap.

2. **Eligibility that consults the panel** — `DISABLED` and `ARCHIVED` always
   hide a product and refuse an order. A panel with several consecutive recent
   probe failures is temporarily ineligible until it recovers; a single failure
   is not, and `UNCHECKED` or stale health never empties a catalogue. Order
   confirmation re-checks before taking payment rather than trusting what the
   browse page decided.

3. **A newly configured panel passes connection validation before it can be
   enabled.**

4. **Web Admin** — capacity used/reserved/cap, the products and services a panel
   carries, and a safe confirmation on archive, which is a single click today.

5. **Telegram Admin** — a permission-aware Panels section: list, the unhealthy
   queue, a capacity summary, detail, health refresh, and enable/disable behind
   an explicit confirmation. No credential entry, no secret display, no raw
   provider body. Credential creation and rotation stay in the Web Admin.

## Carry-forward: admin-assisted renew and add-ons are 6C/6D

Phase 6A's report placed operator-initiated `RENEW`, `ADD_TRAFFIC` and
`ADD_TIME` order creation in Phase 7. **That was wrong and is corrected here.**
Phase 7 is discounts, referral, cashback, affiliate, resellers and promotions —
pricing and growth mechanics. An operator creating a renewal order on a
customer's behalf is ordinary commerce with an operator actor, and it belongs to
**6C/6D**. It is not built in 6B.

## Two documentation defects, both verified by hand

- `docs/providers/sanaei-3xui.md:29` states "the declared capability set is
  therefore exactly `HEALTH_CHECK` — and so is Marzban's". Both halves are false
  now: the descriptors declare five and ten. It is stale Phase 3B text that the
  correct later sections of the same file contradict.
- `docs/real-panel-acceptance.md:289` says the Marzban suite is "sixteen cases,
  in seven groups" and tables A1–A7. Group A8 — the commercial half, nine cases
  driving `applyAllowance` — exists at `real-panel-marzban.test.ts:337` and is
  recorded nowhere in that document.

Both are corrected in this phase. A capability matrix that contradicts the
documentation is the failure this audit exists to catch.

## Migration 0080: what happened, and what was proved

The first version of 0080 was pushed in `1a9ea79`, then regenerated in
`99cd6d8` because the column it added had to be renamed and `drizzle-kit`
cannot disambiguate a rename without a TTY. **The commit message for `99cd6d8`
said "no database anywhere has applied the version being replaced". That was
wrong**, and the correction matters more than the convenience it claimed: the
obsolete version HAD been applied to the local development database, which was
then rolled back by hand. The statement should have been "no shared or durable
database", which is what the evidence below actually supports.

| #   | Claim                                     | How it was checked                                                                            | Result                                                                                             |
| --- | ----------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | never on `main`                           | `git log origin/main -- 'apps/api/drizzle/0080*'`                                             | no commits                                                                                         |
| 2   | never in a release                        | `git tag --contains 1a9ea79`                                                                  | no tags. `v0.2.6` is based on `28f50f6`, which is an ancestor of all 6B work                       |
| 3   | never in a durable CI database            | `.github/workflows/ci.yml:73`                                                                 | the Postgres service container declares no `volumes:`; it is created per job and destroyed with it |
| 4   | never on staging or production            | neither is reachable from this environment and no deployment was performed in this phase      | no path existed                                                                                    |
| 5   | local databases recreated                 | `nexa_dev` and `nexa_test` dropped and created empty                                          | done                                                                                               |
| 6   | an empty database applies the whole chain | fresh `nexa_dev`, full migrator run                                                           | 81 migrations, all four 0080 objects present, obsolete column absent                               |
| 7   | a database at `main` upgrades through it  | `nexa_upgrade` staged with `main`'s own 80-migration folder, then migrated with this branch's | 80 → 81, all four objects appear                                                                   |
| 8   | no ledger drift between the two paths     | compared the stored hash of the last entry in both databases                                  | identical: `7d50838…fb75a`                                                                         |
| 9   | schema and migrations agree               | `pnpm db:check`                                                                               | ok                                                                                                 |

Staging the `main`-state database took a second attempt worth recording,
because the first one silently proved nothing. `NEXA_MIGRATIONS_DIR` is not a
variable the migrator reads — `migrationsFolder()` resolves relative to its own
compiled location — so pointing it at `main`'s folder applied THIS branch's
chain instead, and the ledger showed 81 where it should have shown 80. The
proof only became real once `main`'s migration folder was placed beside a copy
of the compiled migrator and run from there.

No `0081` rename was written. An 0081 that renamed a column would describe a
transition no database outside this branch has ever made, and the forward-only
rule exists to protect applied history rather than to require fictional history.

## The one place the owner's two answers pull against each other

The owner settled eligibility with two sentences that are both right and, taken
literally together, cannot both be implemented:

> UNCHECKED or stale health must not empty the catalogue automatically.

> A newly configured panel must pass connection validation before it can be
> enabled.

`PanelRepository.create` writes `status: 'ACTIVE'`. If creating a panel counts
as ENABLING it, then a created panel must be born `DISABLED` and an operator
must run a connection test before it can sell — at which point no `ACTIVE` panel
is ever `UNCHECKED` at its first sale, and the first sentence has almost nothing
left to protect.

**What is implemented: the validation gate is on the TRANSITION into `ACTIVE`
from something else, not on creation.** Creating a panel is initial
configuration, and there is no prior state for the gate to protect; the panel is
made immediately probe-eligible in the same transaction, so a real answer
arrives within one monitor tick. Enabling a panel that an operator had disabled
— the case where the gate earns its keep, because the ordinary sequence is
"test, find the password wrong, fix it, enable" — is refused without a fresh
passing test bound to the panel's current identity.

Recorded here rather than resolved silently, because the other reading is
defensible and it is the owner's call. Switching to it is a three-line change in
`DrizzlePanelRepository.create` plus its schedule eligibility, and a large
number of test fixtures that create a panel and expect to sell from it.

## Two settlement-time refusals a reader should expect to be unreachable

`ProvisioningService.planForSettledOrder` can now refuse with
`PANEL_NOT_ELIGIBLE`, which rolls the settlement back. Through the ordinary path
that refusal cannot fire for `AT_CAPACITY`: the slot was reserved at
confirmation and is released inside the same transaction, before the count.

It fires for the cases that matter and are all operator- or time-driven: the
panel was archived or disabled between confirmation and payment, the monitor
confirmed it unreachable three times running, or the customer paid after their
own order deadline had lapsed and the hold with it. Rolling back is the honest
outcome in each — an installation that cannot deliver must not keep the money —
and it is why the refusal exists rather than a log line.

A settlement REPLAY skips the decision entirely (`alreadyProvisioned`). Judging
a replay would refuse a transaction whose money has already moved, for a
customer who already has what they paid for.
