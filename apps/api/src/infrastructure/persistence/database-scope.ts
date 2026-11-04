import { AsyncLocalStorage } from 'node:async_hooks';
import { isSystemContext, systemContext, type ScopeContext } from '@nexa/contracts';
import type { Pool, PoolClient } from 'pg';
import { SYSTEM_ROLE } from './row-level-security.js';

/**
 * Which scope a database checkout runs for (ADR-0037).
 *
 * Row-level security reads the tenant from the SESSION (`app.current_tenant_id`), and a
 * repository reaches the database through two kinds of handle: the open transaction of
 * a unit of work, and the bare pool (`tx ?? this.db`) for a read outside one. Both
 * acquire a connection through `pool.connect`, so that is where the scope is applied —
 * every checkout, whichever handle asked for it, before the caller sees the client.
 *
 * The scope comes from here: `DrizzleUnitOfWork` binds it for the whole of `run`,
 * `runSnapshot` and `withTenant`, and code that reads outside a unit of work binds it
 * with `withDatabaseScope`. NOTHING bound is not a default tenant and not the system:
 * the checkout is `nexa_app` with no tenant, and a statement that touches a tenant table
 * RAISES (`nexa_current_tenant_id()`), so a missed binding is an error, never somebody
 * else's rows and never an empty answer that reads as "not found".
 *
 * A `SystemContext` is the system path: the checkout switches to `nexa_system`
 * (`SET ROLE`; nexa_app is a member WITH INHERIT FALSE, so it holds none of its rights
 * until it switches) and binds the reason, which that role's policy requires and which
 * `application_name` carries into `pg_stat_activity` and the server log.
 */
const boundScope = new AsyncLocalStorage<ScopeContext>();

/** Runs `fn` with every database checkout it makes bound to `scope`. */
export function withDatabaseScope<T>(
  scope: ScopeContext,
  fn: () => Promise<T> | PromiseLike<T>,
): Promise<T> {
  // AWAITED inside the binding: a drizzle query is a lazy thenable that runs only when
  // awaited, and awaited outside `run` it would check out with the caller's scope.
  return boundScope.run(scope, async () => await fn());
}

/**
 * Runs `fn` on the SYSTEM path: every checkout as `nexa_system`, with `reason` bound.
 *
 * For the reads that are cross-tenant by nature — a session token presented before any
 * tenant is known, an installation-wide lock — and say so where they are made. The
 * reason is the audit trail (`app.system_reason`, `application_name`), so it names the
 * read, never a generic "system".
 */
export function withSystemScope<T>(
  reason: string,
  fn: () => Promise<T> | PromiseLike<T>,
): Promise<T> {
  return withDatabaseScope(systemContext(reason), fn);
}

/** The scope the next checkout would be bound to, if any. */
export function boundDatabaseScope(): ScopeContext | undefined {
  return boundScope.getStore();
}

/**
 * `enforcing`: connected as a role the policies bind (nexa_app). `owner`: connected as
 * the table owner or a superuser, which bypass row-level security — the rollout state of
 * an installation not yet given `DATABASE_APP_URL`, where applying scopes would change
 * nothing and cost a round trip per checkout.
 */
export type ScopeEnforcement = 'enforcing' | 'owner';

const DETECT_ENFORCEMENT = `
  SELECT NOT r.rolsuper AND NOT r.rolbypassrls
         AND EXISTS (SELECT 1 FROM pg_roles s
                      WHERE s.rolname = '${SYSTEM_ROLE}'
                        AND pg_has_role(session_user, s.oid, 'SET'))
         AND NOT EXISTS (SELECT 1 FROM pg_class c
                          WHERE c.relname = 'tenants'
                            AND c.relnamespace = 'public'::regnamespace
                            AND pg_has_role(session_user, c.relowner, 'USAGE'))
           AS enforcing,
         current_setting('application_name') AS application_name
    FROM pg_roles r
   WHERE r.rolname = session_user`;

const APPLY_SCOPE = `
  SELECT set_config('role', $1, false),
         set_config('app.current_tenant_id', $2, false),
         set_config('app.system_reason', $3, false),
         set_config('application_name', $4, false)`;

/** PostgreSQL keeps 63 bytes of `application_name`. */
const APPLICATION_NAME_MAX = 63;

interface Enforcement {
  readonly mode: ScopeEnforcement;
  readonly applicationName: string;
}

/**
 * Makes every checkout of `pool` apply the bound scope. Returns how the pool's role
 * relates to the policies, resolved on its first checkout.
 *
 * The setting is SESSION-level and written IN FULL on every checkout whose scope differs
 * from the one the connection last had (role, tenant, reason — each set or cleared), so
 * a connection can never carry one borrower's tenant into the next. It runs before the
 * caller's first statement and outside any transaction, so a rollback cannot undo it.
 * A checkout whose scope could not be applied is DESTROYED, not returned to the pool.
 */
export function bindCheckoutsToScope(pool: Pool): { enforcement(): Promise<ScopeEnforcement> } {
  let enforcement: Promise<Enforcement> | undefined;
  const applied = new WeakMap<PoolClient, string>();
  const rawConnect = pool.connect.bind(pool) as () => Promise<PoolClient>;

  const detect = async (client: PoolClient): Promise<Enforcement> => {
    const result = await client.query<{ enforcing: boolean; application_name: string }>(
      DETECT_ENFORCEMENT,
    );
    const row = result.rows[0];
    return {
      mode: row?.enforcing === true ? 'enforcing' : 'owner',
      applicationName: row?.application_name ?? '',
    };
  };

  const checkout = async (scope: ScopeContext | undefined): Promise<PoolClient> => {
    const client = await rawConnect();
    try {
      enforcement ??= detect(client);
      const resolved = await enforcement.catch((error: unknown) => {
        // Not memoised: a failed detection is retried by the next checkout.
        enforcement = undefined;
        throw error;
      });
      if (resolved.mode === 'enforcing') {
        const key = scopeKey(scope);
        if (applied.get(client) !== key) {
          applied.delete(client);
          await client.query(APPLY_SCOPE, settingsFor(scope, resolved.applicationName));
          applied.set(client, key);
        }
      }
      return client;
    } catch (error) {
      client.release(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  };

  type ConnectCallback = (
    error: Error | undefined,
    client?: PoolClient,
    done?: (release?: unknown) => void,
  ) => void;
  const connect = (callback?: ConnectCallback): Promise<PoolClient> | undefined => {
    // Read NOW, synchronously, in the caller's async context: pg-pool's `query` calls
    // `connect` from inside the caller's statement.
    const scope = boundDatabaseScope();
    const pending = checkout(scope);
    if (typeof callback !== 'function') return pending;
    pending.then(
      (client) => callback(undefined, client, (release) => client.release(release as Error)),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    );
    return undefined;
  };
  (pool as unknown as { connect: typeof connect }).connect = connect;

  return {
    async enforcement() {
      if (enforcement === undefined) {
        const client = await pool.connect();
        client.release();
      }
      return (await (enforcement as Promise<Enforcement>)).mode;
    },
  };
}

function scopeKey(scope: ScopeContext | undefined): string {
  if (scope === undefined) return 'none';
  return isSystemContext(scope) ? `system:${scope.reason}` : `tenant:${scope.tenantId}`;
}

function settingsFor(
  scope: ScopeContext | undefined,
  applicationName: string,
): [string, string, string, string] {
  if (scope === undefined) return ['none', '', '', applicationName];
  if (isSystemContext(scope)) {
    // An empty reason is passed through as empty, and the system policy then refuses
    // the statement: the reason is the audit trail, so there is no default for it.
    const label = `nexa system: ${scope.reason}`.slice(0, APPLICATION_NAME_MAX);
    return [SYSTEM_ROLE, '', scope.reason, label];
  }
  return ['none', scope.tenantId, '', applicationName];
}

/**
 * Binds every method of a persistence adapter to the scope it is CALLED with.
 *
 * The rule, in order:
 *
 * 1. A method's database scope is the first `ScopeContext` among its arguments (or the
 *    `scope` of the first argument carrying one — a `TransactionScope`, an input
 *    object). That is the value its own `requireTenantId(scope)` reads, so the tenant in
 *    the SQL predicate and the tenant row-level security enforces are the same value by
 *    construction, for the transaction handle and for the bare pool alike.
 * 2. A method called with NO scope while one is already bound (a unit of work's, the
 *    scoped method that called this helper) keeps that binding.
 * 3. A method called with no scope and nothing bound is, by this codebase's own rule
 *    (ADR-0004: no tenant means an explicit system scope, never a null), cross-tenant
 *    work: it runs on the SYSTEM path with the reason `Class.method`, so each such read
 *    is named in `pg_stat_activity` and the server log rather than hidden in a pool.
 *
 * `installation: true`, for an adapter whose data is the INSTALLATION's rather than any
 * one tenant's (recovery, backups, the import and compaction lifecycles, the key
 * store): an unscoped call is always the system path, even under an inherited tenant
 * binding — the installation's recovery is not a hosted tenant's row to filter.
 *
 * Applied to every class under `infrastructure/` that holds a `Database`; the boundary
 * check refuses one that is not decorated (`scripts/check-boundaries.sh`).
 */
export function ScopeBound(options: { readonly installation?: boolean } = {}): ClassDecorator {
  return (target) => {
    const className = (target as { name?: unknown }).name;
    const prototype = (target as unknown as { prototype: Record<string, unknown> }).prototype;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (descriptor === undefined || typeof descriptor.value !== 'function') continue;
      const method = descriptor.value as (...args: unknown[]) => unknown;
      const system = systemContext(`${String(className)}.${name}`);
      const bound = function (this: unknown, ...args: unknown[]): unknown {
        const scope =
          scopeAmong(args) ??
          (options.installation === true || boundScope.getStore() === undefined
            ? system
            : undefined);
        if (scope === undefined) return method.apply(this, args);
        return boundScope.run(scope, () => {
          const result = method.apply(this, args);
          // A method that RETURNS a drizzle query rather than awaiting it: the query runs
          // when the caller awaits it, outside this binding, so its `then` re-enters it.
          // The builder itself is returned — a caller may compose it or call `toSQL`.
          if (isLazyQuery(result)) bindLazyQuery(result, scope);
          return result;
        });
      };
      Object.defineProperty(bound, 'name', { value: method.name });
      Object.defineProperty(prototype, name, { ...descriptor, value: bound });
    }
  };
}

function bindLazyQuery(query: PromiseLike<unknown>, scope: ScopeContext): void {
  const then = query.then.bind(query);
  Object.defineProperty(query, 'then', {
    configurable: true,
    writable: true,
    value: (...handlers: Parameters<typeof then>) => boundScope.run(scope, () => then(...handlers)),
  });
}

function isLazyQuery(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Promise) &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function isScopeContext(value: unknown): value is ScopeContext {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { kind?: unknown; reason?: unknown; tenantId?: unknown };
  if (candidate.kind === 'SYSTEM') return typeof candidate.reason === 'string';
  return typeof candidate.tenantId === 'string' && 'botInstanceId' in candidate;
}

function scopeAmong(args: readonly unknown[]): ScopeContext | undefined {
  // A scope passed directly wins over one carried inside another argument.
  for (const arg of args) if (isScopeContext(arg)) return arg;
  for (const arg of args) {
    if (typeof arg === 'object' && arg !== null && 'scope' in arg) {
      const inner = (arg as { scope?: unknown }).scope;
      if (isScopeContext(inner)) return inner;
    }
  }
  return undefined;
}
