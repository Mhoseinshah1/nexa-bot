import { sql } from 'drizzle-orm';
import {
  HOSTING_ERROR_CODES,
  NexaError,
  TENANT_ARCHIVE_ERROR_CODES,
  type SecretCipher,
  type TenantArchiveManifest,
} from '@nexa/contracts';
import type { DatabaseHandle } from '../../../../infrastructure/persistence/database.js';
import {
  withDatabaseScope,
  withSystemScope,
  withTenantScopeIn,
} from '../../../../infrastructure/persistence/database-scope.js';
import {
  GLOBAL_UNIQUE_KEYS,
  SHARED_AGGREGATE_TYPES,
} from '../application/tenant-archive-inventory.js';
import {
  bufferWithin,
  ident,
  insertRows,
  orderSelfReferenced,
  pinSession,
  readByCursor,
  readCatalogue,
  rowsOf,
  selectTenantRows,
  tenantLoadOrder,
  type SqlExecutor,
  type TableShape,
} from './tenant-archive-copy.js';
import { canonicalDigests, tenantCounts } from './tenant-archive-restore.js';
import { resealRow, secretSlots } from './tenant-archive-secrets.js';

/**
 * Phase 6B (ADR-0039 § 4): bringing a VERIFIED scratch into the live database as a NEW hosted
 * child of this installation, keeping every id.
 *
 * `preflightRestore` is the dry run's refusals, read before any write: the tenant already
 * here (never a merge), its slug, its bot, its domain, and every other globally unique key —
 * each read across tenants on the system path under its pinned reason. `applyRestore` is ONE
 * transaction: the tenant row (STOPPED, parent = this installation) and the register
 * (`hosted_bots` SUSPENDED, `hosted_bot_activations` with the domain and NO marks, the host's
 * capacity limits) on the system path; every tenant row as `nexa_app` BOUND TO THE RESTORED
 * TENANT, so row-level security's WITH CHECK refuses any row of another tenant; secrets
 * re-sealed under this server's ACTIVE key; then the counts and the canonical digests of the
 * live copy compared with the scratch's. Any difference rolls the whole restore back.
 */

export interface PreflightResult {
  readonly slug: string;
  readonly counts: Readonly<Record<string, number>>;
}

function refuse(code: string, message: string, details?: Record<string, unknown>): NexaError {
  return new NexaError({
    kind: 'CONFLICT',
    code,
    message,
    ...(details === undefined ? {} : { details }),
  });
}

/** The scratch's distinct key tuples of one GLOBAL key, as text. */
async function scratchTuples(
  scratch: SqlExecutor,
  table: string,
  columns: readonly string[],
  where: string | null,
): Promise<string[][]> {
  const rows = await rowsOf<Record<string, string | null>>(
    scratch,
    sql`SELECT DISTINCT ${sql.join(
      columns.map(
        (column, index) => sql`${ident(column)}::text AS ${sql.raw(`k${String(index)}`)}`,
      ),
      sql`, `,
    )} FROM ${ident(table)}${where === null ? sql`` : sql` WHERE ${sql.raw(where)}`}`,
  );
  return rows
    .map((row) => columns.map((_column, index) => row[`k${String(index)}`] ?? null))
    .filter((tuple): tuple is string[] => tuple.every((value) => value !== null));
}

/**
 * The dry run's refusals (ADR-0039 § 4), in order, before any write. `slug` replaces the
 * archive's slug when the owner chose a new one.
 */
export async function preflightRestore(input: {
  readonly app: DatabaseHandle;
  readonly scratch: DatabaseHandle;
  readonly manifest: TenantArchiveManifest;
  readonly slug?: string;
}): Promise<PreflightResult> {
  const tenantId = input.manifest.tenant.id;
  const slug = input.slug ?? input.manifest.tenant.slug;
  const scratchCatalogue = await readCatalogue(input.scratch.db);
  const order = await tenantLoadOrder(input.scratch.db, scratchCatalogue);
  const counts = await tenantCounts(input.scratch.db, scratchCatalogue, order, tenantId);

  const bots = await rowsOf<{ username: string | null; telegram_bot_id: string | null }>(
    input.scratch.db,
    sql`SELECT username, telegram_bot_id::text AS telegram_bot_id FROM bot_instances
         WHERE tenant_id = ${tenantId}::uuid`,
  );
  // Security review of PR-1: the host facts are the archive's word. The owner admin it names
  // must be an admin of the archived tenant itself (the register's foreign key would refuse
  // anything else too); a bot it names that the tenant does not hold is dropped.
  const owners = await rowsOf<{ n: number }>(
    input.scratch.db,
    sql`SELECT count(*)::int AS n FROM admins
         WHERE tenant_id = ${tenantId}::uuid AND id = ${input.manifest.host.ownerAdminId}::uuid`,
  );
  if ((owners[0]?.n ?? 0) !== 1) {
    throw new NexaError({
      kind: 'PRECONDITION_FAILED',
      code: TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
      message: "The archive's host facts name an owner who is not an admin of its tenant.",
    });
  }
  const keyTuples = new Map<string, string[][]>();
  for (const key of GLOBAL_UNIQUE_KEYS) {
    if (key.kind !== 'GLOBAL' || key.table === 'tenants' || key.table === 'bot_instances') continue;
    keyTuples.set(
      key.index,
      await scratchTuples(input.scratch.db, key.table, key.columns, key.where),
    );
  }
  const liveCatalogue = await readCatalogue(input.app.db);

  await withSystemScope('tenant archive: global key collisions before restore', async () => {
    const exists = await rowsOf<{ n: number }>(
      input.app.db,
      sql`SELECT count(*)::int AS n FROM tenants WHERE id = ${tenantId}::uuid`,
    );
    if ((exists[0]?.n ?? 0) > 0) {
      throw refuse(TENANT_ARCHIVE_ERROR_CODES.TENANT_EXISTS, 'این ربات همین حالا روی این سرور هست');
    }
    const slugTaken = await rowsOf<{ n: number }>(
      input.app.db,
      sql`SELECT count(*)::int AS n FROM tenants WHERE slug = ${slug}`,
    );
    if ((slugTaken[0]?.n ?? 0) > 0) {
      throw refuse(HOSTING_ERROR_CODES.SLUG_TAKEN, 'The slug is taken here; choose another.');
    }
    for (const bot of bots) {
      const taken = await rowsOf<{ n: number }>(
        input.app.db,
        sql`SELECT count(*)::int AS n FROM bot_instances
             WHERE tenant_id <> ${tenantId}::uuid
               AND (username = ${bot.username} OR telegram_bot_id::text = ${bot.telegram_bot_id})`,
      );
      if ((taken[0]?.n ?? 0) > 0) {
        throw refuse(
          TENANT_ARCHIVE_ERROR_CODES.BOT_TAKEN,
          'The bot belongs to another tenant here.',
        );
      }
    }
    if (input.manifest.host.domain !== null) {
      const domain = await rowsOf<{ n: number }>(
        input.app.db,
        sql`SELECT count(*)::int AS n FROM hosted_bot_activations WHERE domain = ${input.manifest.host.domain}`,
      );
      if ((domain[0]?.n ?? 0) > 0) {
        throw refuse(
          TENANT_ARCHIVE_ERROR_CODES.DOMAIN_TAKEN,
          "The domain is another hosted bot's here.",
        );
      }
    }
    for (const key of GLOBAL_UNIQUE_KEYS) {
      const tuples = keyTuples.get(key.index) ?? [];
      const shape = liveCatalogue.get(key.table);
      if (tuples.length === 0 || shape === undefined) continue;
      const types = key.columns.map(
        (column) => shape.columns.find((c) => c.name === column)?.type ?? 'text',
      );
      const hasTenant = shape.columns.some((column) => column.name === 'tenant_id');
      for (let start = 0; start < tuples.length; start += 500) {
        const values = sql.join(
          tuples.slice(start, start + 500).map(
            (tuple) =>
              sql`(${sql.join(
                tuple.map((value, i) => sql`${value}::${sql.raw(types[i] ?? 'text')}`),
                sql`, `,
              )})`,
          ),
          sql`, `,
        );
        const hit = await rowsOf<{ n: number }>(
          input.app.db,
          sql`SELECT count(*)::int AS n FROM ${ident(key.table)}
               WHERE (${sql.join(
                 key.columns.map((column) => ident(column)),
                 sql`, `,
               )}) IN (VALUES ${values})
                 ${key.where === null ? sql`` : sql`AND ${sql.raw(key.where)}`}
                 ${hasTenant ? sql`AND tenant_id <> ${tenantId}::uuid` : sql``}`,
        );
        if ((hit[0]?.n ?? 0) > 0) {
          throw refuse(
            TENANT_ARCHIVE_ERROR_CODES.UNIQUE_COLLISION,
            'A globally unique key of the archive is held by another tenant here.',
            { table: key.table },
          );
        }
      }
    }
  });
  return { slug, counts };
}

/** Tables the tenant binding cannot write (no `tenant_id`): written in the same transaction. */
const UNBOUND = new Set(['tenants']);

/**
 * Security review of PR-1: how far past the live sequence a restored identity value may sit.
 * The sequences are SHARED by every tenant, so an archive must never be able to move one to
 * the end of its range: a restored value more than this above the live value — or past half
 * the column type's range — refuses the restore (the transaction rolls back).
 */
export const IDENTITY_RESTORE_HEADROOM = 10_000_000n;
const IDENTITY_TYPE_MAX: Readonly<Record<string, bigint>> = {
  smallint: 32_767n,
  integer: 2_147_483_647n,
  bigint: 9_223_372_036_854_775_807n,
};

/** Raises each identity sequence of `shape` past the restored tenant's largest value, bounded. */
async function advanceIdentities(executor: SqlExecutor, shape: TableShape): Promise<void> {
  for (const column of shape.columns.filter((c) => c.identity)) {
    const [row] = await rowsOf<{ top: string | null; last: string | null }>(
      executor,
      sql`SELECT max(${ident(column.name)})::text AS top,
                 pg_sequence_last_value(pg_get_serial_sequence(${shape.name}, ${column.name})::regclass)::text AS last
            FROM ${ident(shape.name)}`,
    );
    if (row?.top === null || row?.top === undefined) continue;
    const top = BigInt(row.top);
    const last = row.last === null ? 0n : BigInt(row.last);
    const typeMax = IDENTITY_TYPE_MAX[column.type] ?? IDENTITY_TYPE_MAX['integer']!;
    if (top > last + IDENTITY_RESTORE_HEADROOM || top > typeMax / 2n) {
      throw new NexaError({
        kind: 'PRECONDITION_FAILED',
        code: TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
        message:
          'The archive carries a numbered row far past this installation’s shared sequence; ' +
          'restoring it would exhaust the numbering of every tenant.',
        details: { table: shape.name, column: column.name },
      });
    }
    if (top > last) {
      await executor.execute(
        sql`SELECT setval(pg_get_serial_sequence(${shape.name}, ${column.name}), ${top.toString()}::bigint)`,
      );
    }
  }
}

/**
 * A SHARED_KEY aggregate's counter is the installation's (`AGGREGATE_OWNERSHIP`): the archive's
 * messages of it are given the next numbers of THIS installation's counter, in their order,
 * rather than the source's — which another tenant here may already hold. The counter row is
 * locked for the transaction and advanced once every message is in.
 */
async function renumberShared(
  executor: SqlExecutor,
  columns: readonly string[],
  rows: (string | null)[][],
  counters: Map<string, bigint>,
): Promise<void> {
  const type = columns.indexOf('aggregate_type');
  const id = columns.indexOf('aggregate_id');
  const sequence = columns.indexOf('sequence');
  for (const row of rows) {
    const aggregateType = row[type] ?? '';
    if (!SHARED_AGGREGATE_TYPES.includes(aggregateType)) continue;
    const aggregateId = row[id] ?? '';
    const key = `${aggregateType}\u0000${aggregateId}`;
    let last = counters.get(key);
    if (last === undefined) {
      await executor.execute(sql`
        INSERT INTO aggregate_sequences (aggregate_type, aggregate_id, last_sequence)
        VALUES (${aggregateType}, ${aggregateId}, 0) ON CONFLICT DO NOTHING`);
      const [locked] = await rowsOf<{ last: string }>(
        executor,
        sql`SELECT last_sequence::text AS last FROM aggregate_sequences
             WHERE aggregate_type = ${aggregateType} AND aggregate_id = ${aggregateId} FOR UPDATE`,
      );
      last = BigInt(locked?.last ?? '0');
    }
    last += 1n;
    counters.set(key, last);
    row[sequence] = last.toString();
  }
}

/**
 * Applies the verified scratch to the live database, as a NEW hosted child of
 * `installationTenantId`, in ONE transaction. Returns the live counts per table.
 */
export async function applyRestore(input: {
  readonly app: DatabaseHandle;
  readonly scratch: DatabaseHandle;
  readonly manifest: TenantArchiveManifest;
  readonly slug: string;
  readonly installationTenantId: string;
  readonly actorAdminId: string;
  readonly now: Date;
  /** The archive key's cipher (opens the scratch's secrets). */
  readonly archiveCipher: SecretCipher;
  /** This server's cipher (seals them under its ACTIVE key). */
  readonly targetCipher: SecretCipher;
}): Promise<Record<string, number>> {
  const tenantId = input.manifest.tenant.id;
  const tenantScope = { tenantId: tenantId as never, botInstanceId: null };
  const scratchCatalogue = await readCatalogue(input.scratch.db);
  const order = await tenantLoadOrder(input.scratch.db, scratchCatalogue);
  const expectedCounts = await tenantCounts(input.scratch.db, scratchCatalogue, order, tenantId);
  const compared = order.filter((table) => table !== 'tenants');
  const expectedDigests = await input.scratch.db.transaction(
    async (tx) => {
      await pinSession(tx);
      return canonicalDigests(tx, scratchCatalogue, compared, tenantId, input.archiveCipher);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );

  return withSystemScope('tenant archive: create the restored tenant and its register', () =>
    input.app.db.transaction(async (tx) => {
      await pinSession(tx);
      const liveCatalogue = await readCatalogue(tx);
      const tenantShape = liveCatalogue.get('tenants');
      if (tenantShape === undefined) throw new Error('the live database has no tenants table');

      // The tenant row: the archive's, as a HOSTED child of this installation, STOPPED.
      await withScratchRows(
        input.scratch,
        scratchCatalogue.get('tenants'),
        tenantShape,
        tenantId,
        async (columns, rows) => {
          const at = (name: string) => columns.indexOf(name);
          // Security review of PR-1: exactly the archive's one tenant row, by its own id, and
          // whatever the archive says its kind is, it lands as a HOSTED child of this install.
          if (rows.length !== 1 || rows[0]?.[at('id')] !== tenantId) {
            throw new NexaError({
              kind: 'PRECONDITION_FAILED',
              code: TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
              message: "The archive's tenant row is not the tenant its manifest names.",
            });
          }
          const fixed = rows.map((row) => {
            const out = [...row];
            out[at('kind')] = 'HOSTED';
            out[at('parent_tenant_id')] = input.installationTenantId;
            out[at('status')] = 'STOPPED';
            out[at('slug')] = input.slug;
            return out;
          });
          await insertRows(tx, tenantShape, columns, fixed);
        },
      );

      // Every tenant row, bound to the restored tenant: RLS refuses a row of anyone else.
      const counters = new Map<string, bigint>();
      await withTenantScopeIn(tx, tenantScope, async () => {
        for (const table of order) {
          if (UNBOUND.has(table)) continue;
          const live = liveCatalogue.get(table);
          if (live === undefined) continue;
          await withScratchRows(
            input.scratch,
            scratchCatalogue.get(table),
            live,
            tenantId,
            async (columns, rows) => {
              const slots = secretSlots(table, columns);
              for (const row of rows)
                resealRow(row, slots, input.archiveCipher, input.targetCipher);
              if (table === 'outbox_messages') await renumberShared(tx, columns, rows, counters);
              await insertRows(
                tx,
                live,
                columns,
                live.selfReferences.length > 0 ? orderSelfReferenced(live, columns, rows) : rows,
              );
            },
          );
          await advanceIdentities(tx, live);
        }
      });

      // The shared counters move past the messages renumbered onto them (locked above).
      for (const [key, last] of counters) {
        const [type, id] = key.split('\u0000') as [string, string];
        await tx.execute(sql`
          UPDATE aggregate_sequences SET last_sequence = GREATEST(last_sequence, ${last.toString()}::bigint)
           WHERE aggregate_type = ${type} AND aggregate_id = ${id}`);
      }

      // The register, in the installation tenant, from the host facts: SUSPENDED, no marks.
      const host = input.manifest.host;
      await tx.execute(sql`
        INSERT INTO hosted_bots (tenant_id, hosted_tenant_id, state, expires_at, owner_admin_id,
                                 created_by_admin_id, created_at, state_changed_at, updated_at)
        VALUES (${input.installationTenantId}::uuid, ${tenantId}::uuid, 'SUSPENDED',
                NULL, ${host.ownerAdminId}::uuid, ${input.actorAdminId}::uuid,
                ${input.now}, ${input.now}, ${input.now})`);
      await tx.execute(sql`
        INSERT INTO hosted_bot_activations (tenant_id, hosted_tenant_id, bot_instance_id, domain,
                                            created_at, updated_at)
        VALUES (${input.installationTenantId}::uuid, ${tenantId}::uuid,
                (SELECT b.id FROM bot_instances b
                  WHERE b.tenant_id = ${tenantId}::uuid AND b.id = ${host.botInstanceId}::uuid),
                ${host.domain}, ${input.now}, ${input.now})`);
      // Security review of PR-1: the expiry and the capacity limits are the HOST's policy, set
      // by this owner in «میزبانی‌ها» — never taken from an archive anyone with its password could
      // have written. The restored bot gets no expiry and this installation's default limits;
      // the manifest's values are informational only.

      // The copy is counted and compared, inside the transaction: a difference rolls it back.
      const actual = await withTenantScopeIn(tx, tenantScope, async () => {
        const counts = await tenantCounts(tx, liveCatalogue, order, tenantId);
        const digests = await canonicalDigests(
          tx,
          liveCatalogue,
          compared,
          tenantId,
          input.targetCipher,
        );
        return { counts, digests };
      });
      const differing = order.filter(
        (table) =>
          actual.counts[table] !== expectedCounts[table] ||
          (table !== 'tenants' && actual.digests[table] !== expectedDigests[table]),
      );
      if (differing.length > 0) {
        throw new NexaError({
          kind: 'INTERNAL',
          code: TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
          message: 'The restored copy does not match the verified scratch; nothing was kept.',
          details: { tables: differing },
        });
      }
      return actual.counts;
    }),
  );
}

/**
 * The scratch's rows of one table in the LIVE table's columns (the scratch is at the target's
 * head, so they are the same), handed over in pages; a self-referencing table in one page.
 */
async function withScratchRows(
  scratch: DatabaseHandle,
  scratchShape: TableShape | undefined,
  live: TableShape,
  tenantId: string,
  onRows: (columns: string[], rows: (string | null)[][]) => Promise<void>,
): Promise<void> {
  if (scratchShape === undefined) return;
  const columns = live.columns.map((column) => column.name);
  const missing = columns.filter((column) => !scratchShape.columns.some((c) => c.name === column));
  if (missing.length > 0) {
    throw new NexaError({
      kind: 'INTERNAL',
      code: TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
      message: 'The migrated scratch does not have the live schema.',
      details: { table: live.name, columns: missing },
    });
  }
  const whole = live.selfReferences.length > 0;
  await withDatabaseScope({ tenantId: tenantId as never, botInstanceId: null }, () =>
    scratch.db.transaction(
      async (stx) => {
        await pinSession(stx);
        const buffered: (string | null)[][] = [];
        const bufferedBytes = { bytes: 0 };
        await readByCursor(
          stx,
          selectTenantRows(scratchShape, columns, tenantId),
          columns.length,
          async (rows) => {
            if (whole) bufferWithin(buffered, rows, bufferedBytes, live.name);
            else await onRows(columns, rows);
          },
        );
        if (whole && buffered.length > 0) await onRows(columns, buffered);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    ),
  );
}
