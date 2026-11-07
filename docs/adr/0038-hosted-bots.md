# ADR-0038 — Hosted bots and the creator panel («میزبانی‌ها»)

**Status:** Accepted (owner decision, phase 6A D1, 2026-11-05). The number is provisional; the
lead renumbers it at merge if another PR claims it.

## Context

One Nexa installation hosts the owner's own bot and, from 6A on, a Nexa bot for anyone the owner
chooses. Each hosted bot is a full, independent Nexa: its own Telegram bot, Web Admin, panels,
gateways, products, customers and operations group, with every feature. Billing is out of scope.

## Decisions

### A hosted bot is a tenant of kind `HOSTED`

- `TENANT_KINDS` gains `HOSTED`. A hosted tenant is a CHILD of the installation tenant (the one
  `PRIMARY`), as `tenants_parent_check` requires of every non-primary tenant — but it is **not** a
  reseller sub-tenant (`RESELLER_BOT`): a reseller bot sells its parent's catalogue; a hosted bot
  shares nothing with its parent but the server.
- The register is `hosted_bots`, **owned by the installation tenant** (`tenant_id` = the
  installation, `hosted_tenant_id` = the hosted tenant). It is the owner's record of what he hosts;
  a hosted bot's operators never see it, and under RLS the owner reads it in his own scope.
- Lifecycle `HOSTED_BOT_STATES`: `ACTIVE`, `SUSPENDED` (the owner), `EXPIRED` (the sweep),
  `DELETED` (soft, restorable, every row kept), `PURGED` (terminal). Each state holds the hosted
  TENANT row at a status — `ACTIVE`, `STOPPED` (suspended, expired), `DISABLED` (deleted, purged)
  — written in the same transaction by a conditional UPDATE naming its `from` status.
- **The tenant row is the kill switch.** `ScopeActivityReader.scopeIsActive` (every write path,
  inside its transaction), the Telegram webhook, Web Admin sign-in and every authenticated request
  already refuse a tenant that is not `ACTIVE`. Suspension therefore adds no new enforcement
  point that a future write path could forget; the tests prove each of the four.
- Creating one makes the tenant (the installation's locale, timezone, calendar and currency), its
  system roles and its first Web Admin owner (a username and a password the creator chooses and
  hands over; never returned, never in an idempotency hash). Its Telegram bot is connected by that
  owner from their own Web Admin (the existing bots page). Web Admin sign-in for a hosted tenant is
  not routed yet: the login surface resolves the installation tenant only — 6B.

### Who reaches the panel: the installation owner, precisely

`HostingOwnerGuard`, deny by default, every one required, re-checked inside every write:

1. the scope is the installation tenant's;
2. the actor is an administrator;
3. the guard grants `hosting.manage` (new, CRITICAL, seeded to `owner` only);
4. the administrator holds the system `owner` role there;

plus, inside a write, the Web Admin session is still live. (1) stops a hosted bot's own owner, who
holds every key in their tenant; (4) stops an installation operator handed the key by a custom
role or a GRANT override. Every refusal writes a DENIED audit row.

### The section's own second factor (this section only)

- A TOTP factor (RFC 6238 via the existing, RFC-vector-tested `identity/application/totp.ts`)
  separate from the Web Admin sign-in factor: its own table, its own secret purpose
  (`hosting.totp_secret`, sealed by the installation keyring), its own ten recovery codes (hashed,
  one-time, a domain-separated hash, regenerated as a whole set), its own issuer «Nexa Hosting».
- Enrolment needs the password (the shared throttled step-up); activation needs a first code from
  the same Web Admin session within 15 minutes.
- A **12-hour section session** (`hosting_sessions`, its own httpOnly `__Host-nexa_hosting`
  cookie) bound to the Web Admin session it was opened from, timed by the `Clock`.
- **Every sensitive action re-asks**: create, suspend, activate, delete, purge, set expiry, a
  limit change (and, when built, enter) carry a fresh proof, spent before the action's
  transaction. A step is accepted once; replays and an idempotent replay of the same request are
  answered from the idempotency store without asking again.
- **Throttle**: each code is judged under the factor row's lock and a wrong one is counted in the
  same committed transaction; five wrong codes lock every code (TOTP and recovery) for 15 minutes.

### Limits, server card, expiry

- Limits reuse PR-2's `CapacityLimitsService` (`list`, `set`) behind the section and a fresh code.
- The server card reads `os` (cores, load, total RAM) and PR-2's `ProcSystemProbe` (free memory,
  `statfs` of `/` and the backup directory — the alerts' own readings). The estimate is
  `docs/capacity/after-guards.md`: budget `floor(75 × min(1, cores/4))` concurrently active
  customers, minus 25 for the owner, minus 1 per live hosted bot; `more` = headroom ÷ 1 small,
  ÷ 3 medium, ÷ 10 large; 0 while memory is under the alert floor or a disk is at 90 %.
- The expiry sweep runs in the worker's installation-scoped sweep loop every pass, as
  `SYSTEM_JOB`, FOR UPDATE SKIP LOCKED + a conditional UPDATE from `ACTIVE` — idempotent — and
  records `hosting.bot_expired` on the installation tenant (the owner's group) in its transaction.

### The production gate

Creating is refused unless `HOSTED_BOTS_CREATE_ENABLED` is on AND, in any NODE_ENV other than
`development`/`test`, the compiled `HOSTED_BOTS_PRODUCTION_RELEASE_MARKER` equals its exact value.
The marker is a code constant (`null` today); PR-5 sets it once RLS (PR-1) and the isolation proof
(PR-5) are merged, editing `tests/unit/hosting-create-gate.test.ts` in the same commit.

### Cross-tenant work: one port, on the RLS system path

Every read or write the panel makes in another tenant's rows goes through
`HostedTenantSystemPath` (`DrizzleHostedTenantSystemPath`), each method taking a `SystemContext`
whose reason is `hosting.<operation>`: the directory rows, customer counts, owner and bot
usernames, provisioning a hosted tenant's roles and first owner, its tenant status, closing it on a
purge, the purge preview. Each runs on the ADR-0037 system path under its own literal reason
(`hosting: …`, pinned in `tests/unit/system-path-allowlist.ts`): `withSystemScopeIn` on the owner's
transaction when there is one — `provision` and `closeForPurge` write hosted-tenant rows (tenants,
admins, roles, admin_sessions, bot_instances) inside it, and row-level security would otherwise
confine them to the installation tenant — and `withSystemScope` on the pool for the list's facts
and the purge preview. The installation-wide last backup time is read the same way. The panel's own
tables (`hosted_bots`, `hosting_sessions`, `hosting_totp_factors`, `hosting_recovery_codes`) carry
the installation tenant's `tenant_id`, so the discovered tenant policy and the default grants cover
them; `tests/integration/hosting-panel.test.ts` runs as `nexa_app`.

A HOSTED tenant is never the role's cached installation tenant: every role resolves `findPrimary()`
(kind PRIMARY) at boot, and the fail-closed guard (PR #411) never re-resolves on a hosted tenant's
behalf; a role that had recorded one as HOSTED and saw it vanish stops its scope and alerts the
owner. The session's permission list drops `hosting.manage` for anyone but the installation
tenant's `owner`, so the «میزبانی‌ها» link is not drawn in a hosted bot's Web Admin (chrome only;
`HostingOwnerGuard` refuses the routes).

### «ورود به پنل» (enter) — designed for 6B, stubbed now

`POST /hosting/bots/:id/enter` exists, takes a fresh proof and answers
`hosting.enter_not_implemented`. The 6B design: a fresh code mints a short-lived (15 min),
single-use, audience-bound impersonation token recorded in the OWNER's audit log; it opens a Web
Admin session in the hosted tenant marked `impersonatedBy` that (D5) writes no row to the hosted
tenant's audit log, carries the owner's actor reference for the installation's log, cannot change
that tenant's admins or credentials, and ends with the section session.

## Open

- Purge closes the tenant for good (sessions revoked, bots disabled, `PURGED`); the physical
  erasure of its rows is not built — append-only tables (audit, operational events, outbox) refuse
  per-tenant deletes, so erasure needs its own design (6B).
- A lost section factor with no recovery codes has no reset yet (the sign-in factor has
  `admin-2fa-reset.cli.ts`); a matching CLI is a follow-up.
