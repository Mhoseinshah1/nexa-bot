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

4. **An administrator may not grant a permission they do not hold themselves.**
   Rule 1 stops self-promotion; without this one it is trivially routed around
   by creating a puppet: an admin with `admins.edit` gives a new account the
   `finance` role, sets its password, and signs in as it. The two rules only
   work together. An owner holds the whole catalog, so this never constrains
   them — it constrains a _delegated_ admin manager, which is the case it
   exists for. Removing a role is exempt: taking authority away is not
   amplification, and requiring the remover to hold it would stop a manager
   cleaning up a role they were never given.

Changing one's own **password** is deliberately not covered by rule 1: it
requires the current password, grants nothing, and refusing it would mean an
administrator could never rotate a credential they believe is exposed.

### Identifiers are canonicalised at the boundary

Rule 1 was, in its first implementation, a `===` between two strings. The
security review defeated it in one request: Postgres compares `uuid` values
case-insensitively, so `…89AB` and `…89ab` are **one row**, while JavaScript
says they are two different strings. Upper-casing your own admin id in the URL
made the guard see somebody else, and every query afterwards resolved it back to
you. Both self-protected operations were reachable that way.

The lesson is not "add `toLowerCase` to that comparison". It is that **a check
which decides in the application about a row the database will resolve is only
as good as the two agreeing on identity.** So `uuidV7Schema` now lower-cases on
parse — every branded id in the system is canonical by construction, which fixes
the class rather than the instance — and the self-guard additionally re-runs
inside the transaction against the id the database _returned_, so it holds even
if some future path skips the boundary.

### The database enforces tenant ownership too

Migration 0005 put `tenant_id` on every identity table and made every unique
index composite on it — enough for the application to scope its predicates. The
foreign keys, though, still referenced globally unique ids alone, so a row could
name tenant A while pointing at tenant B's admin and tenant C's role and the
database would accept it. Because every read filters on `tenant_id`, such a row
is **invisible to the tenant that owns the id**: it simply grants, or fails to
grant, in silence.

Migration 0007 makes them composite — `(tenant_id, admin_id) → admins(tenant_id,
id)` and the same for roles — across `admin_roles`, `role_permissions`,
`admin_permission_overrides`, `admin_sessions`, and the `assigned_by` /
`created_by` actor references. Each parent gains a `UNIQUE (tenant_id, id)`
candidate key, redundant with its primary key and deliberately so: it is what
lets a child say "this admin, _in this tenant_".

This is not RLS by another name, and it does not reopen ADR-0004. RLS answers
"which rows may this session see"; a foreign key answers "may these two rows be
related at all". The second question has a cheap, declarative answer that does
not depend on anyone remembering a predicate, and v1 declining the first is no
reason to decline both.

`assigned_by_admin_id` and `created_by_admin_id` stay **nullable**. Installation
bootstrap grants the first owner role with no acting administrator, because none
exists yet; writing a fabricated actor there would be the invented identity this
codebase refuses elsewhere. NULL means "the installation did this", and the
audit row with actor `SYSTEM_JOB` carries the rest.

### Authorization decides under the lock

A security decision computed before the tenant lock is a decision about a
snapshot that may no longer exist when it is acted on.

`setRoles` used to read the target's current roles, compute the delta, and
authorize the owner-sensitive part of it — all before taking the lock:

```
target holds [support]
request B reads [support], intends [support]  -> delta mentions no owner
request A promotes target to [owner], commits
request B takes the lock and writes [support]
```

B has removed the owner role without `admins.permissions.edit` ever being
checked, because the delta B authorized against never mentioned it. The
last-owner trigger does not catch this — another active owner exists, so nothing
is violated. A privileged role was simply removed by a request never authorized
to touch it.

So the authoritative read, the delta, the owner-sensitive permission check, the
privilege-amplification check, the mutation and the audit `before`/`after` all
happen inside the transaction, after the lock, through transaction-aware
repository reads. A read on the _pool_ after the lock does not participate in it
and can observe a different snapshot, which is why `findById` and `roleKeysFor`
take the transaction handle.

`setStatus` already locked first but read through the pool; it now reads inside
the transaction for the same reason. `create` — which mints a new credential
with roles attached and a password the caller chooses, the most privileged act
on the surface — took no lock at all, and put scrypt inside the gap between
deciding and writing. A manager disabled mid-request still created a live
administrator after the revocation had committed, and a manager demoted
mid-request still granted the role they had just lost. It now authorizes under
the lock like the others; the cheap pre-check survives only so an unprivileged
caller cannot make the server spend a KDF per request.

Because these re-checks run inside a transaction, `PermissionResolver.resolve`,
`permissionsForAdmin`, `overridesForAdmin` and `roles.list` all take the
transaction handle. That is not tidiness: a nested read on the POOL while
holding a transaction both misses the lock and occupies a second connection, so
`DATABASE_POOL_MAX` concurrent admin mutations would each hold one connection
while waiting for another that never comes.

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
