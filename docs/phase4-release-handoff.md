# Phase 4 release handoff

Everything an owner needs to decide whether to cut the next release, and what to
do if they do. It is a HANDOFF rather than a release: this document creates no
tag, publishes nothing and deploys nothing.

Written at the Phase 4J merge. Every figure below was read from this repository
or from a run whose output is quoted; where something could not be verified from
here, it says so rather than estimating.

## The head this describes

| what               | value                                                 |
| ------------------ | ----------------------------------------------------- |
| `main`             | `018b096ec801006ce7c6bd0dced923c1f83aa626`            |
| last release tag   | `v0.2.0`, at `40f13d3` (the Phase 4I merge)           |
| releases before it | `v0.1.0-staging.1` … `v0.1.0-staging.15`              |
| migrations on disk | 62 (`0000` … `0061`), journal in step                 |
| process roles      | `api`, `worker`, `monitor`, `recovery`, `provisioner` |

## What Phase 4 merged, in order

| phase | what it built                                                                       | PR       | merge commit         |
| ----- | ----------------------------------------------------------------------------------- | -------- | -------------------- |
| 4A    | customers: `/start`, identity, block and unblock, the Web Admin Users surface       | #21      | `2cfd75f`            |
| 4B    | catalogue and orders: products, the customer catalogue, DRAFT → AWAITING_PAYMENT    | #22      | `39ae0c4`            |
| 4C    | wallet, payments and settlement: the append-only ledger, wallet and manual transfer | #23      | `5f22243`            |
| —     | the Telegram fresh-install bootstrap (`bootstrap-bot`, installer wiring)            | #24      | `4ed191d`            |
| 4D    | provisioning: the `provisioner` role, a paid order becomes a real service           | #25, #26 | `5249e24`, `8b04fc9` |
| 4E    | service management: usage, expiry, Marzban suspend/resume/terminate                 | #27      | `326d00e`            |
| 4F    | commercial actions: renew, add traffic, add time                                    | #28      | `f976dc8`            |
| 4G    | payment completion: reject, withdraw, the expiry sweep                              | #29      | `953b555`            |
| 4H    | the customer notification lane (ADR-0030), Telegram completion, Web Admin Services  | #30      | `6173336`            |
| 4I    | the thirteen deferred bootstrap findings                                            | #31      | `40f13d3`            |
| 4J    | final hardening, plus the persistent Telegram main menu                             | #32      | `018b096`            |

## Migrations since `v0.2.0`

Two, both additive and forward-only. Both were applied to an EMPTY database and
read back.

| migration                                  | what it does                                                       | rollback-safe?                                        |
| ------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------- |
| `0060_provisioning_operation_announced_at` | adds a nullable `timestamptz` column                               | yes — the previous release ignores it                 |
| `0061_customer_notification_kinds`         | re-adds `customer_notifications_kind_check` over a strict superset | yes for the SCHEMA; see the caveat below for the ROWS |

**The one rollback caveat.** `0061` is write-compatible and not
reader-compatible: `v0.2.0` cannot render the two kinds it admits. Rolling back
to `v0.2.0` with such a row queued strands it. `docs/deployment.md` → "Rolling
back" carries the detection query and the remedy (roll forward, then requeue).
Nothing else in this release has a rollback caveat.

## Evidence on this head

| gate                    | result                                                                        |
| ----------------------- | ----------------------------------------------------------------------------- |
| `pnpm verify`           | green — 1309 unit, 448 web, deploy suite, boundaries, i18n, shellcheck, build |
| `pnpm test:integration` | green — 77 files, 1467 tests                                                  |
| `pnpm db:check`         | `schema and migrations agree`                                                 |
| falsification citations | 1051, all resolving to a committed test                                       |
| CI on the exact head    | all ten checks green on `9640aeb`, the PR #32 head that `018b096` merges      |

Falsification for this phase is `docs/phase4j-falsification.md`: seventeen
mutations, fifteen KILLED, one SURVIVED-then-KILLED, one survivor recorded in
prose with its reason.

## Provider capability matrix

Declared in `packages/contracts/src/provider.ts` and enforced before dispatch:
an operation whose capability a panel does not declare is REFUSED rather than
attempted.

| operation                 | Marzban                        | 3X-UI (Sanaei)                 |
| ------------------------- | ------------------------------ | ------------------------------ |
| health check              | ✅ `HEALTH_CHECK`              | ✅ `HEALTH_CHECK`              |
| provision (create user)   | ✅ `CREATE_USER`               | ✅ `CREATE_USER`               |
| read a user back / usage  | ✅ `READ_USAGE`                | ✅ `READ_USAGE`                |
| deliver subscription link | ✅ `DELIVER_SUBSCRIPTION_LINK` | ✅ `DELIVER_SUBSCRIPTION_LINK` |
| device limit              | ❌ not declared                | ✅ `LIMIT_DEVICES`             |
| suspend                   | ✅ `DISABLE_USER`              | ❌                             |
| resume                    | ✅ `ENABLE_USER`               | ❌                             |
| terminate                 | ✅ `DELETE_USER`               | ❌                             |
| renew                     | ✅ `RENEW_USER`                | ❌                             |
| add traffic               | ✅ `ADD_VOLUME`                | ❌                             |
| add time                  | ✅ `ADD_TIME`                  | ❌                             |

There is no `LOOKUP` capability and there should not be one: reading a user back
is `READ_USAGE`, and a member with no producer is the empty declaration this
codebase refuses.

**Marzban is the supported mutable provider**; 3X-UI keeps the five it has, of
which only `CREATE_USER` mutates anything. That is the owner's correction,
recorded in `docs/phase4e-audit.md`. Every declared capability was proved against
a real panel binary before it was declared — `docs/real-panel-acceptance.md`, and
`pnpm test:acceptance` fails rather than skips without a disposable panel.

## Suggested next release

- **Version: `v0.3.0`.** A minor bump, not a patch: this release adds customer-
  visible behaviour (the main menu, two notification kinds) and two migrations.
  It is not `v1.0.0` — see the readiness classification below.
- **Title:** _Persistent main menu, and the two places a customer could be left
  with nothing_
- **Tag target:** `018b096` (or whatever `main` is when the owner decides).

### Release notes, ready to paste

> **Customer-facing**
>
> - A persistent button menu in the bot: 🛒 خرید اشتراک, 📱 سرویس‌های من,
>   💰 کیف پول, 📚 راهنما. A customer no longer needs to know any slash command.
>   The slash commands and Telegram's own command menu still work.
> - A recorded transfer claim and a withdrawn order now reach the customer even
>   when Telegram rate-limits the immediate reply.
>
> **Operational**
>
> - An operation that finishes while a process is dying is now answered by a
>   sweep instead of being silently forgotten.
> - A notification kind a running release cannot render is deferred rather than
>   consumed, so a mixed-version fleet loses nothing.
>
> **Migrations:** `0060`, `0061`. Both additive and forward-only.
>
> **Rollback:** to `v0.2.0` only with the caveat in `docs/deployment.md` →
> "Rolling back": a queued rate-limit fallback notification is stranded, with a
> detection query and a remedy given there.

## Required configuration changes

**None.** No environment variable is added, removed or changed by this release,
and `.env.example`, `deploy/nexa.env.template` and `config.schema.ts` are
unchanged since `v0.2.0`. An installation updates without editing
`/etc/nexa/nexa.env`.

`NEXA_READY_SERVICES` already names all five process roles plus Caddy
(`api worker monitor recovery provisioner caddy`); the provisioner joined it in
Phase 4D, which is before `v0.2.0`.

## Update

```bash
sudo botctl update v0.3.0
```

The release is resolved to a digest once and addressed by digest afterwards; the
run takes an exclusive lock, backs the database up before migrating, and health-
checks before it commits to the new release.

### Post-update checks

```bash
sudo botctl status            # every service healthy, the new version recorded
sudo botctl version           # the digest actually running
sudo botctl telegram status   # the command menu, and whether it matches
```

Then, in the bot itself, the check that this release exists for: send `/start`
to the customer bot and confirm the four-button keyboard appears under the chat,
and that 💰 کیف پول answers with the wallet balance.

### Rollback

```bash
sudo botctl rollback
```

Returns the application to the previous release's image. It does **not** restore
the database — that is deliberate and is the most important sentence in
`docs/deployment.md`. Read the notification caveat above before rolling back
past this release.

## Production readiness

### BLOCKER

- **`BLOCKER-SECRETS-V2`** — the v1 secret envelope binds no context to its
  ciphertext and `keyId` is recorded but no rotation can yet be performed. A key
  retired today makes every row encrypted under it unreadable. Tracked in
  `docs/open-questions.md`; `docs/deployment.md` §"Secrets, keys and rotation"
  states what an operator can and cannot do until it lands.

### REQUIRED BEFORE REAL CUSTOMER TRAFFIC

- **`docs/vps-acceptance.md` answers recorded somewhere readable.** A real v0.2.0
  staging acceptance ran — it produced the main-menu finding — but which steps
  passed is not written down in this repository. An installation taking money
  should not depend on somebody's memory of a checklist.
- **A restore rehearsed end to end on staging.** The recovery lane has
  integration tests against real renames (ADR-0028), and a rehearsal on a real
  host is a different claim. `pnpm backup verify` and the Web Admin recovery
  section are the surfaces.
- **A gateway, if the installation intends to take money any way other than a
  wallet credit or a bank transfer.** `PAY_GATEWAY` is refused rather than
  simulated; there is no adapter.
- **Currency and FX.** Every amount is `bigint` minor units with an explicit
  currency, and nothing converts between currencies. An installation selling in
  one currency is complete; one that needs two needs `OQ-4C-04` answered first.

### ACCEPTABLE DEFERRED

- `OQ-4G-03` — a DRAFT order nothing ever confirms is never swept. It holds no
  money and blocks nothing; it accumulates rows.
- `OQ-4G-04` — `UNKNOWN` and the two payment reconciliation edges have no
  producer, because they need the gateway adapter that does not exist.
- `OQ-4C-02` — what a refund IS, as a state. Nothing refunds today, and the
  legacy system's "refund" was a log verb on deleting a service.
- `OQ-4F-05` — a free-entry add-on quantity has no home in a bot with no FSM.
- `OQ-PROV-01` — a connection reset after the request is sent reads as
  `UNREACHABLE`; the conservative classification is already the safe one.
- The rollback caveat above, for exactly one release.

### OPTIONAL

- 3X-UI mutable operations (suspend/resume/terminate/renew/add-traffic/add-time).
  The executor would dispatch them; the capabilities are not declared and the
  owner scoped them out.
- Phase 7: discounts, referral, cashback, affiliate, resellers, promotions.
- A second locale. The catalogue is keyed and the machinery is there; only `fa`
  ships.

## What this document does not do

It does not tag, publish or deploy anything. Creating the release is the owner's
action, and `docs/deployment.md` §"Releases" states what must be true before one
exists.
