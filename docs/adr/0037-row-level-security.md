# ADR-0037 — Row-level security for tenant isolation — supersedes ADR-0004

**Status:** Accepted (owner decision, 2026-11-01). **Supersedes
[ADR-0004](0004-tenant-isolation.md).** The ADR number is provisional and is renumbered at
merge with the migration (`0317` in this branch) if another PR claims either first.

## Why ADR-0004 no longer holds

ADR-0004 kept tenant scoping in the repository layer only, and said why that was defensible:
the deployment model was **one install per customer**, so a missed tenant predicate leaked
between one customer's own tenants (its primary tenant and its reseller sales bots), never
between unrelated companies. It named its own exit: "the product moves to a shared
multi-tenant deployment".

That is what happened. One install now hosts the owner's bot **and many unrelated owners'
bots** ("hosted bots", each a tenant). A missed predicate is now a leak between strangers, so
PostgreSQL enforces the boundary itself. The repository guard (`requireTenantId`) and
`tests/integration/tenant-isolation.test.ts` stay: RLS is the backstop for the predicate a
reviewer did not see, not a replacement for writing it.

## Decision

### Three roles

| Role                                                               | Logs in                  | Owns tables | Row-level security              | Used by                                                      |
| ------------------------------------------------------------------ | ------------------------ | ----------- | ------------------------------- | ------------------------------------------------------------ |
| the owner (`nexa` on a Docker install; ADR-0004's `nexa_migrator`) | yes                      | yes         | bypasses (not FORCEd)           | migrations, `pg_dump`/`pg_restore`, the CLIs                 |
| `nexa_app`                                                         | yes (`DATABASE_APP_URL`) | no          | bound, no BYPASSRLS             | api, worker, monitor, provisioner, assistant, recovery pools |
| `nexa_system`                                                      | **never**                | no          | bound by its own admission rule | reached only by `SET ROLE` from `nexa_app`                   |

The existing owner role is the migrator; it was not renamed, because an ownership transfer on
every existing install buys nothing. `DATABASE_URL` stays the owner's (migrate, backup,
restore keep working unchanged); `DATABASE_APP_URL` is new and, when set, every process's
application pool uses it (`container.ts`).

`nexa_app` is a member of `nexa_system` **WITH INHERIT FALSE, SET TRUE**: it holds none of
`nexa_system`'s rights until it switches, and it can switch only for a checkout. Neither role
may be SUPERUSER or BYPASSRLS; migration 0317 and the deploy step refuse one that is.

### The policy

Every table in `public` with a `tenant_id` column gets RLS enabled and **one** policy, `TO
PUBLIC`, for all commands, `USING` and `WITH CHECK`:

```sql
(SELECT nexa_rls_system_path()) OR tenant_id = (SELECT nexa_current_tenant_id())
```

- `nexa_current_tenant_id()` reads `app.current_tenant_id` and **raises** (42501) when it is
  unset. The brief offered the `missing_ok` + `nullif` form, under which an unset tenant
  yields zero rows; an error is safer here. An unbound read that came back empty reads as
  "not found" and can drive a wrong write or a wrong customer message; an error names the
  bug — and it is what makes "the suite passes as `nexa_app`" a proof that nothing was
  missed, because a missed binding cannot pass quietly.
- `nexa_rls_system_path()` is true only as `nexa_system`, and raises there unless
  `app.system_reason` is bound. The reason is mandatory, enforced by the database.
- `TO PUBLIC`, with the role names inside the functions: a policy that names a role cannot be
  restored where the role does not exist, and the backup's verification restores on a
  scratch server with no Nexa roles. PUBLIC is also the right audience — any non-owner role,
  including one somebody adds later, needs a tenant bound.
- Each function is called through `(SELECT …)`: evaluated once per statement (an init plan),
  not once per row, and still usable as an index key.

The policies are applied by `row-level-security.ts` after the migrator — **not** inside a
migration — one table per short transaction under `lock_timeout = 3s` with bounded retries.
`ENABLE ROW LEVEL SECURITY` and `CREATE POLICY` take ACCESS EXCLUSIVE locks, drizzle runs all
pending migrations in one transaction, and `botctl update` migrates while the outgoing
release serves: in the migrator that is two hundred tables locked until the last commits. The
set of tables is discovered (`tenant_id` column), so a later migration's table is covered by
the run that creates it. The same step re-asserts the roles' grants (lock-free), because
dumps are `--no-acl`.

### How a statement gets its tenant

The tenant lives in the **session**, applied by the pool on **every checkout**
(`database-scope.ts`): a transaction's, a bare-pool statement's (`tx ?? this.db`), and
`withClient`'s all go through `pool.connect`. The scope applied is the one bound in an
`AsyncLocalStorage` when the checkout is asked for, written in full (role, tenant, reason)
whenever it differs from what that connection last had, before `BEGIN`, so no rollback undoes
it and no borrower inherits the previous one's tenant. A checkout whose scope cannot be
applied is destroyed.

Who binds it:

- `DrizzleUnitOfWork.run`, `runSnapshot` and `withTenant` bind their scope for the whole
  callback — the seam ADR-0004 held open.
- Every persistence adapter is `@ScopeBound()`: a method's scope is the first `ScopeContext`
  among its arguments (or the `scope` an argument carries). That is the value its own
  `requireTenantId(scope)` reads, so the SQL predicate's tenant and the enforced tenant are
  one value by construction. This is what covers the bare-pool reads without editing ~800
  `this.db` call sites. `scripts/check-boundaries.sh` refuses an undecorated adapter.
- A method called with no scope keeps the caller's binding. With none at all it is, by
  ADR-0004's own rule ("no tenant means an explicit system scope, never a null"), cross-tenant
  work, and runs on the system path with the reason `Class.method`.
- `@ScopeBound({ installation: true })` marks the adapters whose data is the installation's
  (recovery, backups, the key store, the import and compaction lifecycles): their unscoped
  calls are always the system path.
- Nothing bound at all: `nexa_app` with no tenant — a tenant table raises.

### The system path, and why it is audited

A `SystemContext` checkout runs `SET ROLE nexa_system` and binds `app.system_reason` to the
context's reason, also visible as `application_name` (`nexa system: <reason>`) in
`pg_stat_activity` and in the server log's `%a`. The policy refuses `nexa_system` without a
reason. There is no BYPASSRLS anywhere.

Considered and not chosen: a **second pool** with its own `nexa_system` credential. It would
stop a SQL injection from switching roles — but the same injection can already set
`app.current_tenant_id` to any tenant, so RLS here defends against a **missed predicate**, not
against a compromised process, and a second credential and pool buys little against that
threat for real cost (a second pool size, a second secret to rotate). A process compromise is
also out of RLS's reach for a stated reason: the owner's credential stays in the same env file
for migrations and backups (below).

### Installation-wide questions inside a tenant's transaction

The write gate asks, inside **every** unit of work, whether a recovery or a Mirza import has
frozen the installation. Those rows belong to the installation's tenant, so a hosted tenant's
transaction would not see them and its writes would go through a restore. Two narrow
`SECURITY DEFINER` functions answer exactly that question on the caller's own transaction
(`nexa_installation_recovery`, `nexa_installation_nxpkg_import`, 0317), returning an id and a
state, never a row.

### Tables without RLS

Tables with no `tenant_id`, and why each holds no hosted tenant's data:

- `tenants` — the tenant directory (slug, display name, status, parent). Read before a tenant
  is known (bot token → tenant, boot resolution) and across parent/child reseller pairs. Not
  secret; protecting it needs a hierarchy-aware policy (open question).
- `aggregate_sequences` — a per-aggregate counter, no payload.
- `processed_messages` — the outbox consumers' dedupe ledger (message ids).
- `process_runs`, `backup_runs`, `backup_run_parts`, `installation_keys` — the installation's
  own process, backup and key-management state.

The completeness test pins this list, so a new tenant-data table without `tenant_id` is a
decision, not an accident.

## Rollout

- **The migration changes nothing for an install still on the owner.** The owner bypasses RLS
  (nothing is FORCEd), and a Docker install's owner is the image's superuser, which bypasses
  it always. The pool detects this on its first checkout and does not apply scopes there.
- `botctl update` (and the installer, and `botctl restart`) then run
  `nexa_ensure_app_db_role` after the migrations: it gives `nexa_app` its login and a
  generated password (on psql's stdin, never in argv, in a session that has turned off
  statement logging and `pg_stat_statements` utility tracking first), and only after that succeeds adds
  `DATABASE_APP_URL` to its own `/etc/nexa/app-database.env` (0600) by rename — `nexa.env`
  is never rewritten. On a later run it reads the
  password back and re-asserts it, so a cluster that lost the role agrees with the file again.
- The **first** update into this release runs the outgoing release's `botctl`, which does not
  know the step: the install comes up on the owner, RLS inert. The next `botctl restart` or
  `botctl update` switches it. A failure of the step is a warning, never a failed update: the
  processes keep the owner's connection, exactly as before.
- A rollback to an older release ignores `DATABASE_APP_URL` and connects as the owner.
- A recovery's restored candidate gets the grants back before cutover (`pg-tools.ts`).

## Proof

- `tests/integration/row-level-security.test.ts` lists every table with a `tenant_id` column
  from `pg_catalog` and fails if one lacks RLS or the policy, pins the tables without one, and
  reads across tenants as `nexa_app`.
- The integration suite's containers connect as `nexa_app` (`tests/integration/harness.ts`);
  fixtures and cross-tenant assertions use the owner's handle, application code never does.
  `tenant-isolation.test.ts` therefore runs as the application role.

## Consequences

- A new tenant-owned table needs nothing: the next `migrate` secures it, and the test fails if
  it did not.
- A new persistence adapter must be `@ScopeBound()`; the boundary check says so.
- A new entry into the system path (an unscoped public adapter method, a `withSystemScope`
  reason) fails `tests/unit/system-path.test.ts` until it is added to its allowlist.
- Cross-tenant reads are now visible (each has a reason) and cost a role switch per checkout.
- Changing the policy expression means a new policy name and dropping the old one.
