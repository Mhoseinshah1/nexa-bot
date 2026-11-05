import type { PoolClient } from 'pg';
import type { DatabaseHandle } from './database.js';

/**
 * Row-level security on every tenant-owned table (ADR-0037).
 *
 * Applied OUTSIDE the migrator, one table per short transaction, for the same reason
 * `online-indexes.ts` is: `ENABLE ROW LEVEL SECURITY` and `CREATE POLICY` each take an
 * ACCESS EXCLUSIVE lock, drizzle runs every pending migration in ONE transaction, and
 * `botctl update` migrates while the outgoing release is still serving. In the migrator
 * that would be two hundred tables locked until the last one commits, behind whichever
 * transaction happened to be holding a row on any of them.
 *
 * Here each table is locked alone, under `lock_timeout`, and released at once; a table
 * that is busy is retried a few times and then the run FAILS, naming it. Idempotent: a
 * table that already has RLS and its policy is not touched (and not locked), so a
 * rerun after a failure resumes where it stopped.
 *
 * The set of tables is DISCOVERED, not listed: every table in `public` with a
 * `tenant_id` column. A table a later migration adds is covered by the same `migrate`
 * run that creates it, and `tests/integration/row-level-security.test.ts` fails if any
 * tenant table ends up without the policy.
 *
 * Nothing here FORCEs row-level security, so the table owner still bypasses it. That is
 * the rollout's safety: an installation still connecting as the owner behaves exactly
 * as before, and the policies bind from the moment its processes connect as `nexa_app`.
 */

/** The application's login role: no BYPASSRLS, owns nothing. */
export const APP_ROLE = 'nexa_app';
/** Reached only by `SET ROLE` from `nexa_app`, for an explicit `SystemContext`. */
export const SYSTEM_ROLE = 'nexa_system';
/** The tenant a checkout is bound to (`nexa_current_tenant_id()`, 0317). */
export const TENANT_SETTING = 'app.current_tenant_id';
/** The system scope's reason; the system policy refuses every row without one. */
export const SYSTEM_REASON_SETTING = 'app.system_reason';

/**
 * The policy's name. Also the idempotency key: a change to the expression needs a NEW
 * name (and the old policy dropped), never an edit that a rerun would not notice.
 */
export const TENANT_POLICY = 'nexa_tenant_isolation';

/**
 * ONE policy per table, TO PUBLIC (0317 says why the roles are named inside the
 * functions, not in `TO`): the system path, or the bound tenant's rows.
 */
export const TENANT_POLICY_PREDICATE =
  '(SELECT nexa_rls_system_path()) OR tenant_id = (SELECT nexa_current_tenant_id())';

/**
 * The application roles' privileges, re-asserted on every migration run.
 *
 * 0317 granted them once, and default privileges cover what this owner creates later.
 * What neither covers is a database that LOST them: backups are dumped `--no-acl`, so a
 * recovery's restored candidate holds no grant for nexa_app, and a process connecting
 * as nexa_app to it would be refused on every table. Idempotent and lock-free (a GRANT
 * changes the catalog row, it takes no lock on the table), and a no-op on a cluster
 * where the roles do not exist.
 */
export const APPLICATION_ROLE_GRANTS_SQL = `
DO $grants$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SYSTEM_ROLE}') THEN
    RETURN;
  END IF;
  GRANT USAGE ON SCHEMA public TO ${APP_ROLE}, ${SYSTEM_ROLE};
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}, ${SYSTEM_ROLE};
  GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}, ${SYSTEM_ROLE};
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}, ${SYSTEM_ROLE};
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${APP_ROLE}, ${SYSTEM_ROLE};
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
    GRANT USAGE ON SCHEMA drizzle TO ${APP_ROLE}, ${SYSTEM_ROLE};
    IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
      GRANT SELECT ON drizzle.__drizzle_migrations TO ${APP_ROLE}, ${SYSTEM_ROLE};
    END IF;
  END IF;
  IF to_regprocedure('nexa_gateway_order_id_taken(text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION nexa_gateway_order_id_taken(text, text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION nexa_gateway_order_id_taken(text, text) TO ${APP_ROLE}, ${SYSTEM_ROLE};
  END IF;
  IF to_regprocedure('nexa_service_username_taken(uuid, text, text)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION nexa_service_username_taken(uuid, text, text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION nexa_service_username_taken(uuid, text, text) TO ${APP_ROLE}, ${SYSTEM_ROLE};
  END IF;
  IF to_regprocedure('nexa_installation_recovery(text[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION nexa_installation_recovery(text[]) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION nexa_installation_recovery(text[]) TO ${APP_ROLE}, ${SYSTEM_ROLE};
  END IF;
  IF to_regprocedure('nexa_installation_nxpkg_import(text[])') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION nexa_installation_nxpkg_import(text[]) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION nexa_installation_nxpkg_import(text[]) TO ${APP_ROLE}, ${SYSTEM_ROLE};
  END IF;
END
$grants$`;

/** Per lock attempt. Short: a migration waiting longer is already an outage for writes. */
export const RLS_LOCK_TIMEOUT_MS = 3_000;
const RLS_LOCK_ATTEMPTS = 5;
const RLS_RETRY_DELAY_MS = 1_000;

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export interface RowLevelSecurityState {
  readonly table: string;
  readonly enabled: boolean;
  readonly forced: boolean;
  readonly tenantPolicy: boolean;
}

/** Every table in `public` with a `tenant_id` column, and what it has today. */
export async function tenantTableSecurity(client: PoolClient): Promise<RowLevelSecurityState[]> {
  const result = await client.query<{
    table: string;
    enabled: boolean;
    forced: boolean;
    tenant_policy: boolean;
  }>(
    `SELECT c.relname AS table,
            c.relrowsecurity AS enabled,
            c.relforcerowsecurity AS forced,
            EXISTS (SELECT 1 FROM pg_policies p
                     WHERE p.schemaname = 'public' AND p.tablename = c.relname
                       AND p.policyname = $1) AS tenant_policy
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                       AND a.attnum > 0 AND NOT a.attisdropped)
      ORDER BY c.relname`,
    [TENANT_POLICY],
  );
  return result.rows.map((row) => ({
    table: row.table,
    enabled: row.enabled,
    forced: row.forced,
    tenantPolicy: row.tenant_policy,
  }));
}

function complete(state: RowLevelSecurityState): boolean {
  return state.enabled && state.tenantPolicy;
}

/**
 * Applies RLS where it is missing, and re-asserts the application roles' grants.
 * Returns the tables it changed.
 */
export async function ensureRowLevelSecurity(handle: DatabaseHandle): Promise<string[]> {
  await handle.withClient((client) => client.query(APPLICATION_ROLE_GRANTS_SQL));
  const changed: string[] = [];
  const pending = await handle.withClient(async (client) =>
    (await tenantTableSecurity(client)).filter((state) => !complete(state)),
  );
  for (const { table } of pending) {
    if (!SAFE_IDENTIFIER.test(table)) {
      throw new Error(`${table} is not a plain table name; refusing to interpolate it.`);
    }
    if (await secureTable(handle, table)) changed.push(table);
  }
  return changed;
}

async function secureTable(handle: DatabaseHandle, table: string): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await handle.withClient((client) => secureTableOnce(client, table));
    } catch (error) {
      const busy = (error as { code?: unknown }).code === '55P03';
      if (!busy) throw error;
      if (attempt >= RLS_LOCK_ATTEMPTS) {
        throw new Error(
          `row-level security: ${table} stayed locked by other work through ${RLS_LOCK_ATTEMPTS} ` +
            `attempts of ${RLS_LOCK_TIMEOUT_MS}ms. Nothing on it changed; tables before it are ` +
            'done. Rerun the migration (it resumes here) when the installation is quieter.',
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, RLS_RETRY_DELAY_MS * attempt));
    }
  }
}

async function secureTableOnce(client: PoolClient, table: string): Promise<boolean> {
  await client.query('BEGIN');
  try {
    // Interpolated as an integer constant, never a parameter: SET takes none.
    await client.query(`SET LOCAL lock_timeout = ${RLS_LOCK_TIMEOUT_MS}`);
    // The lock first, then the state READ UNDER IT: a second migrator running the same
    // step waits here and then finds the policies already present.
    await client.query(`LOCK TABLE "${table}" IN ACCESS EXCLUSIVE MODE`);
    const state = (await tenantTableSecurity(client)).find((row) => row.table === table);
    if (state === undefined || complete(state)) {
      await client.query('COMMIT');
      return false;
    }
    if (!state.tenantPolicy) {
      await client.query(
        `CREATE POLICY ${TENANT_POLICY} ON "${table}" AS PERMISSIVE FOR ALL TO PUBLIC
           USING (${TENANT_POLICY_PREDICATE}) WITH CHECK (${TENANT_POLICY_PREDICATE})`,
      );
    }
    if (!state.enabled) {
      await client.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
