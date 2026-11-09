import { sql } from 'drizzle-orm';
import type { SecretCipher, TenantArchiveManifest } from '@nexa/contracts';
import type { DatabaseHandle } from '../../../../infrastructure/persistence/database.js';
import {
  withDatabaseScope,
  withSystemScope,
} from '../../../../infrastructure/persistence/database-scope.js';
import {
  pinSession,
  readCatalogue,
  rowsOf,
  tenantLoadOrder,
  type SqlExecutor,
} from './tenant-archive-copy.js';
import { canonicalDigests, tenantCounts } from './tenant-archive-restore.js';

/**
 * Phase 6B PR-4 (ADR-0039 § 8): the server move's database statements.
 *
 * Installation rows (`hosted_bots`, `hosted_bot_activations`, the installation's own bots) are
 * read and written in the INSTALLATION's own scope. The four statements that read across
 * tenants run on the system path (ADR-0037), each under its own literal reason, pinned in
 * `tests/unit/system-path-allowlist.ts`; a hosted tenant's rows are read BOUND to it, as the
 * tenant archive's export reads them.
 */

const scopeOf = (tenantId: string) => ({
  tenantId: tenantId as never,
  botInstanceId: null,
});

export interface MoveBotFacts {
  readonly tenantId: string;
  readonly kind: 'INSTALLATION' | 'HOSTED';
  readonly botInstanceId: string | null;
  readonly username: string | null;
  readonly telegramBotId: string | null;
  readonly domain: string | null;
  readonly state: string | null;
}

/**
 * Every bot the bundle must name: the installation's own, and every non-PURGED hosted bot with
 * its domain — what re-pointing DNS and webhooks on the new server needs.
 */
export async function moveBundleBots(
  app: DatabaseHandle,
  installationTenantId: string,
): Promise<readonly MoveBotFacts[]> {
  const own = await withDatabaseScope(scopeOf(installationTenantId), () =>
    rowsOf<{ id: string; username: string | null; telegram_bot_id: string | null }>(
      app.db,
      sql`SELECT id::text AS id, username, telegram_bot_id::text AS telegram_bot_id
            FROM bot_instances WHERE tenant_id = ${installationTenantId}::uuid ORDER BY id`,
    ),
  );
  const hosted = await withDatabaseScope(scopeOf(installationTenantId), () =>
    rowsOf<{
      hosted_tenant_id: string;
      state: string;
      domain: string | null;
      bot_instance_id: string | null;
    }>(
      app.db,
      sql`SELECT b.hosted_tenant_id::text AS hosted_tenant_id, b.state, a.domain,
                 a.bot_instance_id::text AS bot_instance_id
            FROM hosted_bots b
            LEFT JOIN hosted_bot_activations a
              ON a.tenant_id = b.tenant_id AND a.hosted_tenant_id = b.hosted_tenant_id
           WHERE b.tenant_id = ${installationTenantId}::uuid AND b.state <> 'PURGED'
           ORDER BY b.hosted_tenant_id`,
    ),
  );
  const ids = hosted.map((row) => row.hosted_tenant_id);
  // The hosted tenants' bots belong to those tenants: one read across them, named.
  const identities =
    ids.length === 0
      ? []
      : await withSystemScope('move: list hosted tenants for the bundle', () =>
          rowsOf<{
            tenant_id: string;
            id: string;
            username: string | null;
            telegram_bot_id: string | null;
          }>(
            app.db,
            sql`SELECT tenant_id::text AS tenant_id, id::text AS id, username,
                       telegram_bot_id::text AS telegram_bot_id
                  FROM bot_instances
                 WHERE tenant_id IN (${sql.join(
                   ids.map((id) => sql`${id}::uuid`),
                   sql`, `,
                 )})
                 ORDER BY tenant_id, id`,
          ),
        );
  const out: MoveBotFacts[] = own.map((bot) => ({
    tenantId: installationTenantId,
    kind: 'INSTALLATION',
    botInstanceId: bot.id,
    username: bot.username,
    telegramBotId: bot.telegram_bot_id,
    domain: null,
    state: null,
  }));
  for (const row of hosted) {
    const bots = identities.filter((bot) => bot.tenant_id === row.hosted_tenant_id);
    const bot =
      row.bot_instance_id === null
        ? bots.length === 1
          ? bots[0]
          : undefined
        : bots.find((candidate) => candidate.id === row.bot_instance_id);
    out.push({
      tenantId: row.hosted_tenant_id,
      kind: 'HOSTED',
      botInstanceId: bot?.id ?? null,
      username: bot?.username ?? null,
      telegramBotId: bot?.telegram_bot_id ?? null,
      domain: row.domain,
      state: row.state,
    });
  }
  return out;
}

/** The live database's size in bytes (the disk check before an export). */
export async function liveDatabaseBytes(app: DatabaseHandle): Promise<number> {
  const rows = await rowsOf<{ bytes: string }>(
    app.db,
    sql`SELECT pg_database_size(current_database())::text AS bytes`,
  );
  return Number(rows[0]?.bytes ?? '0');
}

export interface MoveTargetBusiness {
  readonly otherTenants: number;
  readonly customers: number;
  readonly orders: number;
  readonly walletEntries: number;
}

/**
 * What the new server already runs, across EVERY tenant: `move import` never merges into a
 * running business (ADR-0039 § 8), and a fresh install has one tenant and no customer.
 */
export async function moveTargetBusiness(app: DatabaseHandle): Promise<MoveTargetBusiness> {
  const rows = await withSystemScope('move: refuse an import into a running business', () =>
    rowsOf<{ tenants: number; customers: number; orders: number; wallet: number }>(
      app.db,
      sql`SELECT (SELECT count(*)::int FROM tenants WHERE kind <> 'PRIMARY') AS tenants,
                 (SELECT count(*)::int FROM customers) AS customers,
                 (SELECT count(*)::int FROM orders) AS orders,
                 (SELECT count(*)::int FROM wallet_entries) AS wallet`,
    ),
  );
  const row = rows[0];
  return {
    otherTenants: row?.tenants ?? 0,
    customers: row?.customers ?? 0,
    orders: row?.orders ?? 0,
    walletEntries: row?.wallet ?? 0,
  };
}

export function isFreshTarget(business: MoveTargetBusiness): boolean {
  return (
    business.otherTenants === 0 &&
    business.customers === 0 &&
    business.orders === 0 &&
    business.walletEntries === 0
  );
}

export type HostedPresence = 'PRESENT' | 'ABSENT' | 'NOT_HOSTED';

/**
 * Whether a hosted member's tenant is in the restored installation as a HOSTED child of it —
 * checked once on the system path before anything is read bound to it.
 */
export async function hostedTenantPresence(
  app: DatabaseHandle,
  installationTenantId: string,
  tenantId: string,
): Promise<HostedPresence> {
  const rows = await withSystemScope('move: bind a hosted tenant to verify it after import', () =>
    rowsOf<{ kind: string; parent_tenant_id: string | null }>(
      app.db,
      sql`SELECT kind, parent_tenant_id::text AS parent_tenant_id
            FROM tenants WHERE id = ${tenantId}::uuid`,
    ),
  );
  const row = rows[0];
  if (row === undefined) return 'ABSENT';
  return row.kind === 'HOSTED' && row.parent_tenant_id === installationTenantId
    ? 'PRESENT'
    : 'NOT_HOSTED';
}

export interface LiveTenantDigest {
  /** `rows:sha256` per table the archive names, over the archive's columns. */
  readonly digests: Record<string, string>;
  /** Live tables with rows of this tenant that the archive does not name. */
  readonly extraTables: readonly string[];
}

/**
 * The canonical digest of a hosted tenant's LIVE rows, read in one `REPEATABLE READ READ ONLY`
 * transaction bound to it (`nexa_app`, `app.current_tenant_id`) with the tenant in every
 * predicate: per table of the archive, over the archive's own columns (a newer release's added
 * columns are not compared), secrets decrypted with this server's `cipher`.
 */
export async function liveTenantDigest(
  app: DatabaseHandle,
  tenantId: string,
  manifest: TenantArchiveManifest,
  cipher: SecretCipher,
): Promise<LiveTenantDigest> {
  const columns = new Map(
    manifest.tables.map((table) => [table.name, table.columns.map((column) => column.name)]),
  );
  return withDatabaseScope(scopeOf(tenantId), () =>
    app.db.transaction(
      async (tx) => {
        const executor: SqlExecutor = tx;
        await pinSession(executor);
        const catalogue = await readCatalogue(executor);
        const named = manifest.tables.map((table) => table.name);
        const digests = await canonicalDigests(
          executor,
          catalogue,
          named,
          tenantId,
          cipher,
          { columnsOf: (table) => columns.get(table) },
        );
        for (const table of named) digests[table] ??= 'missing-table';
        const others = (await tenantLoadOrder(executor, catalogue)).filter(
          (table) => !columns.has(table),
        );
        const counts = await tenantCounts(executor, catalogue, others, tenantId);
        const extraTables = Object.entries(counts)
          .filter(([, rows]) => rows > 0)
          .map(([table]) => table);
        return { digests, extraTables };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    ),
  );
}

/**
 * Clears every hosted activation's DNS, TLS and webhook marks after an import (ADR-0039 § 8):
 * they were earned on the OLD server, and the new one earns them again. The installation's own
 * rows, in its own scope, in the caller's transaction.
 */
export async function clearActivationMarks(
  executor: SqlExecutor,
  installationTenantId: string,
  now: Date,
): Promise<number> {
  const rows = await rowsOf<{ n: number }>(
    executor,
    sql`WITH cleared AS (
          UPDATE hosted_bot_activations
             SET dns_verified_at = NULL, tls_verified_at = NULL, webhook_registered_at = NULL,
                 updated_at = ${now.toISOString()}::timestamptz
           WHERE tenant_id = ${installationTenantId}::uuid
             AND (dns_verified_at IS NOT NULL OR tls_verified_at IS NOT NULL
                  OR webhook_registered_at IS NOT NULL)
          RETURNING 1)
        SELECT count(*)::int AS n FROM cleared`,
  );
  return rows[0]?.n ?? 0;
}

/** Every non-PURGED hosted activation's domain and bot, in the installation's scope. */
export async function hostedActivations(
  app: DatabaseHandle,
  installationTenantId: string,
): Promise<
  readonly {
    readonly hostedTenantId: string;
    readonly domain: string | null;
    readonly botInstanceId: string | null;
    readonly state: string;
  }[]
> {
  const rows = await withDatabaseScope(scopeOf(installationTenantId), () =>
    rowsOf<{
      hosted_tenant_id: string;
      domain: string | null;
      bot_instance_id: string | null;
      state: string;
    }>(
      app.db,
      sql`SELECT b.hosted_tenant_id::text AS hosted_tenant_id, a.domain,
                 a.bot_instance_id::text AS bot_instance_id, b.state
            FROM hosted_bots b
            LEFT JOIN hosted_bot_activations a
              ON a.tenant_id = b.tenant_id AND a.hosted_tenant_id = b.hosted_tenant_id
           WHERE b.tenant_id = ${installationTenantId}::uuid AND b.state <> 'PURGED'
           ORDER BY b.hosted_tenant_id`,
    ),
  );
  return rows.map((row) => ({
    hostedTenantId: row.hosted_tenant_id,
    domain: row.domain,
    botInstanceId: row.bot_instance_id,
    state: row.state,
  }));
}
