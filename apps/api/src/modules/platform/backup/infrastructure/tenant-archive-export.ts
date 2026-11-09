import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { sql } from 'drizzle-orm';
import {
  NexaError,
  TENANT_ARCHIVE_ERROR_CODES,
  TENANT_ARCHIVE_FORMAT,
  TENANT_ARCHIVE_FORMAT_VERSION,
  tenantArchiveManifestSchema,
  type SecretCipher,
  type TenantArchiveManifest,
} from '@nexa/contracts';
import type { DatabaseHandle } from '../../../../infrastructure/persistence/database.js';
import {
  withDatabaseScope,
  withSystemScope,
} from '../../../../infrastructure/persistence/database-scope.js';
import { expectedMigrations } from '../../../../infrastructure/persistence/migration-state.js';
import {
  notExportedReason,
  tenantArchiveClassOf,
} from '../application/tenant-archive-inventory.js';
import {
  encodeCopyLine,
  ident,
  LineDigest,
  pinSession,
  readByCursor,
  readCatalogue,
  rowsOf,
  selectTenantRows,
  tenantLoadOrder,
  type SqlExecutor,
} from './tenant-archive-copy.js';
import { resealRow, secretSlots } from './tenant-archive-secrets.js';

/**
 * Phase 6B (ADR-0039 § 2): the logical export of ONE hosted tenant.
 *
 * ONE SNAPSHOT: every table is read in one `REPEATABLE READ READ ONLY` transaction, so the
 * archive is one instant of the tenant. BOUND AND NAMED: the transaction runs as `nexa_app`
 * with the hosted tenant bound (`app.current_tenant_id`) AND every statement names the tenant
 * in its own predicate, so a missed predicate returns nothing under row-level security rather
 * than another tenant's rows — the isolation proof is in the database, not only in the SQL. A
 * connection that bypasses RLS is refused (`tenant_archive.rls_bypassed`).
 *
 * Writes one `data/NNNN-<table>.copy` per TENANT table with rows (load order), each line a
 * row in COPY text format with its secrets re-sealed under the archive key, and returns the
 * manifest (counts and SHA-256 per part). Nothing here encrypts the container: the six-stage
 * pipeline seals and verifies what this wrote.
 */

export interface TenantExportInput {
  /** `nexa_app` (enforcing). The owner role is refused. */
  readonly app: DatabaseHandle;
  readonly tenantId: string;
  readonly installationTenantId: string;
  /** An empty 0700 directory: the parts and the manifest go here. */
  readonly directory: string;
  readonly archiveId: string;
  readonly archiveKeyId: string;
  readonly createdAt: Date;
  readonly source: { readonly installationId: string; readonly release: string };
  /** This server's cipher (decrypts the stored secrets). */
  readonly sourceCipher: SecretCipher;
  /** The archive key's cipher (seals them for the archive). */
  readonly archiveCipher: SecretCipher;
  /** The migrations folder whose journal names the applied head (this release's). */
  readonly migrationsFolder: string;
}

interface HostFacts {
  readonly state: string;
  readonly expiresAt: string | null;
  readonly ownerAdminId: string;
  readonly domain: string | null;
  readonly botInstanceId: string | null;
}

function refuse(code: string, message: string, details?: Record<string, unknown>): NexaError {
  return new NexaError({
    kind: 'PRECONDITION_FAILED',
    code,
    message,
    ...(details === undefined ? {} : { details }),
  });
}

/**
 * The register row of a hosted tenant, read in the INSTALLATION's own scope (it is the
 * installation's row; no system path is needed for it).
 */
async function hostFacts(input: TenantExportInput): Promise<HostFacts> {
  const rows = await withDatabaseScope(
    { tenantId: input.installationTenantId as never, botInstanceId: null },
    () =>
      rowsOf<{
        state: string;
        expires_at: string | null;
        owner_admin_id: string;
        domain: string | null;
        bot_instance_id: string | null;
      }>(
        input.app.db,
        sql`SELECT b.state, to_char(b.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
                   b.owner_admin_id, a.domain, a.bot_instance_id
              FROM hosted_bots b
              LEFT JOIN hosted_bot_activations a
                ON a.tenant_id = b.tenant_id AND a.hosted_tenant_id = b.hosted_tenant_id
             WHERE b.tenant_id = ${input.installationTenantId}::uuid
               AND b.hosted_tenant_id = ${input.tenantId}::uuid`,
      ),
  );
  const row = rows[0];
  if (row === undefined) {
    throw refuse(TENANT_ARCHIVE_ERROR_CODES.NOT_HOSTED, 'The tenant is not hosted here.');
  }
  if (row.state === 'PURGED') {
    throw refuse(TENANT_ARCHIVE_ERROR_CODES.PURGED, 'A purged tenant is not archived.');
  }
  return {
    state: row.state,
    expiresAt: row.expires_at,
    ownerAdminId: row.owner_admin_id,
    domain: row.domain,
    botInstanceId: row.bot_instance_id,
  };
}

/**
 * The applied migration head, as `migration-state.ts` reads the ledger: the newest applied
 * migration, named by this release's journal. A ledger whose newest entry the journal does not
 * name (a newer or diverged database) is refused: the manifest would not say what it is.
 */
async function migrationHead(
  executor: SqlExecutor,
  folder: string,
): Promise<TenantArchiveManifest['migrations']> {
  const applied = await rowsOf<{ hash: string; created_at: string }>(
    executor,
    sql`SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
  );
  const last = applied.at(-1);
  const expected = expectedMigrations(folder);
  const named =
    last === undefined
      ? undefined
      : expected.find((m) => m.when === Number(last.created_at) && m.hash === last.hash);
  if (last === undefined || named === undefined) {
    throw refuse(
      TENANT_ARCHIVE_ERROR_CODES.HEAD_DIVERGED,
      "The database's migration head is not one this release's journal names.",
    );
  }
  return {
    count: applied.length,
    lastTag: named.tag,
    lastHash: named.hash,
    lastWhen: named.when,
  };
}

/** Exports the tenant into `input.directory` and returns the manifest. */
export async function exportTenant(input: TenantExportInput): Promise<TenantArchiveManifest> {
  if ((await input.app.scopeEnforcement()) !== 'enforcing') {
    throw refuse(
      TENANT_ARCHIVE_ERROR_CODES.RLS_BYPASSED,
      'The export connection bypasses row-level security; a tenant archive is taken as nexa_app.',
    );
  }
  const host = await hostFacts(input);
  // The one place installation work binds a hosted tenant for export: the tenant is checked to
  // be a HOSTED child of this installation with no children of its own, on the system path
  // under its pinned reason, before anything is read bound to it.
  const tenantRow = await withSystemScope('tenant archive: bind a hosted tenant for export', () =>
    rowsOf<{
      kind: string;
      parent_tenant_id: string | null;
      slug: string;
      display_name: string;
      locale: string;
      display_timezone: string;
      calendar: string;
      currency: string;
      children: number;
    }>(
      input.app.db,
      sql`SELECT t.kind, t.parent_tenant_id, t.slug, t.display_name, t.locale,
                 t.display_timezone, t.calendar, t.currency,
                 (SELECT count(*)::int FROM tenants c WHERE c.parent_tenant_id = t.id) AS children
            FROM tenants t WHERE t.id = ${input.tenantId}::uuid`,
    ),
  );
  const tenant = tenantRow[0];
  if (
    tenant === undefined ||
    tenant.kind !== 'HOSTED' ||
    tenant.parent_tenant_id !== input.installationTenantId
  ) {
    throw refuse(TENANT_ARCHIVE_ERROR_CODES.NOT_HOSTED, 'Only a hosted tenant is archived.');
  }
  if (tenant.children > 0) {
    throw refuse(
      TENANT_ARCHIVE_ERROR_CODES.HAS_CHILD_TENANTS,
      'A tenant with child tenants is not archived.',
    );
  }

  await mkdir(join(input.directory, 'data'), { recursive: true, mode: 0o700 });
  const scope = { tenantId: input.tenantId as never, botInstanceId: null };
  return withDatabaseScope(scope, () =>
    input.app.db.transaction(
      async (tx) => {
        await pinSession(tx);
        const migrations = await migrationHead(tx, input.migrationsFolder);
        const postgres = await rowsOf<{ v: string }>(
          tx,
          sql`SELECT current_setting('server_version') AS v`,
        );
        const catalogue = await readCatalogue(tx);
        const order = await tenantLoadOrder(tx, catalogue);
        const tables: TenantArchiveManifest['tables'] = [];
        const perPurpose: Record<string, number> = {};
        let position = 0;
        for (const table of order) {
          const shape = catalogue.get(table);
          if (shape === undefined) continue;
          const columns = shape.columns.map((column) => column.name);
          const slots = secretSlots(table, columns);
          position += 1;
          const file = `data/${String(position).padStart(4, '0')}-${table}.copy`;
          const digest = new LineDigest();
          const out = createWriteStream(join(input.directory, file), { mode: 0o600 });
          try {
            await readByCursor(
              tx,
              selectTenantRows(shape, columns, input.tenantId),
              columns.length,
              async (rows) => {
                for (const row of rows) {
                  for (const purpose of resealRow(
                    row,
                    slots,
                    input.sourceCipher,
                    input.archiveCipher,
                  )) {
                    perPurpose[purpose] = (perPurpose[purpose] ?? 0) + 1;
                  }
                  const line = encodeCopyLine(row);
                  digest.add(line);
                  if (!out.write(line)) await once(out, 'drain');
                }
              },
            );
          } finally {
            out.end();
            await once(out, 'close');
          }
          if (digest.rows === 0) {
            position -= 1;
            await rm(join(input.directory, file), { force: true });
            continue;
          }
          tables.push({
            name: table,
            file,
            columns: shape.columns.map((column) => ({ name: column.name, type: column.type })),
            rows: digest.rows,
            bytes: digest.bytes,
            sha256: digest.hex(),
          });
        }

        // The tenant's rows in INSTALLATION and NEVER tables: counted, never exported.
        const notExported: TenantArchiveManifest['notExported'] = [];
        for (const [table, shape] of [...catalogue].sort(([a], [b]) => a.localeCompare(b))) {
          if (tenantArchiveClassOf(table) === 'TENANT') continue;
          if (!shape.columns.some((column) => column.name === 'tenant_id')) continue;
          const counted = await rowsOf<{ n: number }>(
            tx,
            sql`SELECT count(*)::int AS n FROM ${ident(table)} WHERE tenant_id = ${input.tenantId}::uuid`,
          );
          const rows = counted[0]?.n ?? 0;
          if (rows > 0) {
            notExported.push({
              name: table,
              rows,
              reason: notExportedReason(table) ?? 'not exported',
            });
          }
        }

        // The activation's bot, or — before activation bound one — the tenant's only bot.
        const bots = await rowsOf<{
          id: string;
          username: string | null;
          telegram_bot_id: string | null;
        }>(
          tx,
          sql`SELECT id::text AS id, username, telegram_bot_id::text AS telegram_bot_id
                FROM bot_instances WHERE tenant_id = ${input.tenantId}::uuid ORDER BY id`,
        );
        const bot =
          host.botInstanceId === null
            ? bots.length === 1
              ? bots[0]
              : undefined
            : bots.find((candidate) => candidate.id === host.botInstanceId);
        const limits = await rowsOf<{ resource: string; mode: string; value: number | null }>(
          tx,
          sql`SELECT resource, mode, value FROM tenant_capacity_limits
               WHERE tenant_id = ${input.tenantId}::uuid ORDER BY resource`,
        );

        const manifest: TenantArchiveManifest = {
          format: TENANT_ARCHIVE_FORMAT,
          formatVersion: TENANT_ARCHIVE_FORMAT_VERSION,
          archiveId: input.archiveId,
          createdAt: input.createdAt.toISOString(),
          source: {
            installationId: input.source.installationId,
            release: input.source.release,
            postgresVersion: postgres[0]?.v ?? 'unknown',
          },
          migrations,
          tenant: {
            id: input.tenantId,
            kind: 'HOSTED',
            slug: tenant.slug,
            displayName: tenant.display_name,
            locale: tenant.locale,
            timezone: tenant.display_timezone,
            calendar: tenant.calendar,
            currency: tenant.currency,
          },
          host: {
            state: host.state,
            expiresAt: host.expiresAt,
            ownerAdminId: host.ownerAdminId,
            domain: host.domain,
            botInstanceId: host.botInstanceId,
            botUsername: bot?.username ?? null,
            telegramBotId: bot?.telegram_bot_id ?? null,
            capacityLimits: limits.map((limit) => ({
              resource: limit.resource,
              mode: limit.mode,
              value: limit.value,
            })),
          },
          tables,
          notExported,
          secrets: { archiveKeyId: input.archiveKeyId, perPurpose },
          exclusions: [],
        };
        // The writer holds itself to the reader's schema.
        tenantArchiveManifestSchema.parse(manifest);
        return manifest;
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    ),
  );
}
