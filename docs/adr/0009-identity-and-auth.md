# ADR-0009 — No authentication in Phase 0

**Status:** Accepted for Phase 0. The authentication model itself is an **open
decision** for Phase 1.

## Decision

Phase 0 ships **no authentication of any kind**, and no `admins` or identity
table.

Instead:

- `AUTH_MODE=none` is permitted only when `NODE_ENV=development`. The process
  refuses to boot otherwise, and a unit test asserts it.
- The permission guard is real and deny-by-default, with a resolver that grants
  nothing to anyone who is not `SYSTEM_JOB`.
- The web admin shell states plainly, on screen, that there is no authentication
  yet.

## Why not a stub

A stub login is the "silent success" pattern this codebase exists to avoid, and
stubs get copied into the next phase. A hard boot failure does not.

More concretely: the shape of the identity table depends on a decision nobody
has taken yet. Telegram Login Widget, local credentials, or both? Is an admin
identified by Telegram numeric id, by username, or by an internal id? The legacy
system does it **differently in each of its two surfaces** — numeric id in one,
username in the other (C-ADM-004) — which is exactly what happens when the table
is created before the question is answered.

Creating the table first would mean guessing, and then living with the guess.

## What Phase 1 must decide

1. Telegram Login Widget, local credentials, or both.
2. Whether an admin is global or scoped per bot (`UNK-ADM-004` — see
   `docs/open-questions.md`; the fallback is tenant-scoped, keyed
   `(tenant_id, telegram_user_id)`, plus an explicit platform-admin flag).
3. Session lifetime, rotation and revocation, and whether a role change takes
   effect on the next request or invalidates in-flight sessions.

## Correction: `SYSTEM_JOB` is not a bypass

An earlier version of the guard returned early for `SYSTEM_JOB`, treating
background work as trusted because it is our own code. A security review found
the hole: the HTTP ping controller constructed a `SYSTEM_JOB` actor for an
anonymous caller, so that actor type — the one that skipped deny-by-default —
was reachable from the internet.

Deny-by-default now has no exceptions. Jobs hold `SYSTEM_JOB_PERMISSIONS`, an
explicit list in the frozen contract, so widening what background work may do is
a visible contract change. The HTTP endpoint is additionally registered only
when `NODE_ENV=development`.

The lesson generalises: "trusted by construction" is a claim about the entire
codebase, and a guard cannot verify it.

## What is already built, so Phase 1 does not start from nothing

The permission catalog, role seeds, the DENY-wins resolution rule with expiring
overrides, the guard, deny-recording as both an audit row and an operational
event, and the six self-protection rules named in the architecture review as
requirements. Only the resolver's data source is missing.
