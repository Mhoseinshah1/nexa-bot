# ADR-0014 — Roles, permissions and administrator scope

**Status:** Accepted for Phase 1.

## Decision

An administrator's authority is `(roles ∪ GRANT overrides) − DENY overrides`,
resolved per request, within one tenant, denied by default.

Administrators belong to the **tenant**, not to a bot instance.

## Roles are data, not an enum

`ROLE_SEEDS` in the frozen contract is seeded into a tenant's `roles` and
`role_permissions` rows. The seeds give an operator a shape they recognise on
day one; the rows are what they can actually change afterwards.

This is the single biggest departure from the legacy model, where the role is a
bare string column with four values in one surface and seven in the other
(`CON-WEB-001`), no role can be changed at all — demotion means delete and
recreate — and no privilege change is audited anywhere.

Seeded roles are marked `is_system` and cannot be deleted; a database trigger
refuses it. An installation that deleted its owner role would be recoverable
only by hand-editing the database.

## Overrides

Per-admin `GRANT` and `DENY`, with a mandatory reason and an optional expiry.
Justified by the resolution rule already frozen in Phase 0's contract rather
than added speculatively: `DENY` always wins, and an expired override stops
applying without anyone running a cleanup job.

An unexplained standing exception is indistinguishable from a mistake six months
later, which is why `reason` is `NOT NULL`.

## Tenant scope, not bot scope

`UNK-ADM-004` — whether an admin is global or per-bot — is still unresolved. The
web surface carries a bot column; the Telegram surface shows no scope at all;
all four production admins hold full access, so no restricted role was ever
exercised and the evidence cannot settle it.

Tenant-wide is the model that can be **narrowed** later. Adding
`bot_instance_id` to `admin_roles` is additive. Removing a scope that turned out
to be wrong is not.

Reseller sub-bots are explicitly out of scope for Phase 1.

## Self-protection

Three rules, all enforced in the application under a tenant row lock, and two of
them repeated by database triggers as a backstop.

1. **An administrator never changes their own roles or status.** Holding
   `admins.edit` is authority over _other_ administrators. Without this rule,
   anyone who can edit administrators can grant themselves everything, and every
   other boundary is decorative. This is the concrete answer to `UNK-ADM-005`,
   which asks whether a restricted admin can reach admin management and escalate
   — here they cannot, whatever they hold.
2. **The last active owner cannot be disabled or demoted.** Losing it is not a
   permission problem to be solved by granting more; it means editing the
   database by hand to get back in.
3. **Granting or removing the owner role needs `admins.permissions.edit`**, not
   merely `admins.edit`. Creating an administrator and creating an _owner_ are
   different acts.

Changing one's own **password** is deliberately not covered by rule 1: it
requires the current password, grants nothing, and refusing it would mean an
administrator could never rotate a credential they believe is exposed.

### On the triggers

The migration repeats the last-owner rule as `AFTER` constraint triggers. They
are **defence in depth, not the concurrency control**: a trigger that counts
rows can still be raced by two transactions that each see the other's row. The
row lock in the application is what makes the rule correct; the triggers are what
catch a future code path that forgets to take it.

They are deferred to commit time so a legitimate hand-over — grant the successor,
then disable the predecessor — passes, while a transaction that _ends_ with no
active owner fails.

## No new permission keys

Phase 1 adds none. `admins.view`, `admins.edit` and `admins.permissions.edit`
were already in the Phase 0 catalog, and RBAC is built against the frozen
catalog rather than the catalog being grown to fit the implementation.

## The bootstrap exception, and why it is not a bypass

`BootstrapOwnerService` creates an administrator without authorizing a caller,
because provisioning has no caller. That is the same shape the Phase 0 security
review found in the guard and removed, so it is fenced by construction instead:

- it is a CLI, never a route, and `scripts/check-boundaries.sh` fails the build
  if a surface imports it;
- it refuses outright once the tenant has any administrator, so it creates the
  first owner and nothing else;
- it audits itself as `SYSTEM_JOB`, so the first row in the audit log says how
  the first owner came to exist.

"No caller to authorize" is a true statement about a provisioning step and a
false one about a request handler. The boundary check is what keeps the
difference real.
