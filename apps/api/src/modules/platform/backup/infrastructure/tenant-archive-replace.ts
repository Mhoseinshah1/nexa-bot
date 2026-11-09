import { sql, type SQL } from 'drizzle-orm';
import {
  HOSTED_BOT_TENANT_STATUS,
  NexaError,
  TENANT_ARCHIVE_ERROR_CODES,
  type SecretCipher,
  type TenantArchiveManifest,
} from '@nexa/contracts';
import type { DatabaseHandle } from '../../../../infrastructure/persistence/database.js';
import {
  withSystemScope,
  withTenantScopeIn,
} from '../../../../infrastructure/persistence/database-scope.js';
import {
  TENANT_KEYED_OTHERWISE,
  tenantArchiveClassOf,
} from '../application/tenant-archive-inventory.js';
import {
  ident,
  pinSession,
  readCatalogue,
  rowsOf,
  tenantLoadOrder,
  type SqlExecutor,
} from './tenant-archive-copy.js';
import {
  compareWithScratch,
  copyArchiveRows,
  predicateFor,
  refuse,
  scratchExpectation,
  withScratchRows,
} from './tenant-archive-apply.js';

// ---------------------------------------------------------------------------
// REPLACE (ADR-0039 § 4, § 10)
// ---------------------------------------------------------------------------

/**
 * The append-only guards that fire on DELETE, by table — read from the catalogue, so a guard
 * added later is covered without a list to forget. A constraint trigger (the last-owner check,
 * deferred to commit) is not one: the replace must still commit with an active owner.
 */
export async function deleteGuardedTables(executor: SqlExecutor): Promise<Set<string>> {
  const rows = await rowsOf<{ name: string }>(
    executor,
    sql`SELECT DISTINCT c.relname AS name
          FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE NOT t.tgisinternal AND t.tgconstraint = 0 AND (t.tgtype & 8) = 8
           AND c.relnamespace = 'public'::regnamespace`,
  );
  return new Set(rows.map((row) => row.name));
}

/**
 * The tenant's rows of NEVER tables that hold a foreign key to one of its TENANT tables (sign-in
 * sessions and challenges, read windows, group-connect codes, probe claims): live state bound to
 * the rows being replaced, so a replace ends them — everyone of the bot signs in again.
 */
async function neverTablesBoundToTenantRows(executor: SqlExecutor): Promise<string[]> {
  const rows = await rowsOf<{ child: string; parent: string }>(
    executor,
    sql`SELECT DISTINCT c.relname AS child, p.relname AS parent
          FROM pg_constraint k
          JOIN pg_class c ON c.oid = k.conrelid
          JOIN pg_class p ON p.oid = k.confrelid
         WHERE k.contype = 'f' AND c.relnamespace = 'public'::regnamespace`,
  );
  return [
    ...new Set(
      rows
        .filter(
          (row) =>
            tenantArchiveClassOf(row.child) === 'NEVER' &&
            row.parent !== 'tenants' &&
            tenantArchiveClassOf(row.parent) === 'TENANT',
        )
        .map((row) => row.child),
    ),
  ].sort();
}

/** The order a replace deletes in: the counters and dedupe rows (named through the outbox) first, then children before parents. */
export function replaceDeleteOrder(loadOrder: readonly string[]): string[] {
  const first = Object.keys(TENANT_KEYED_OTHERWISE).filter((table) => table !== 'tenants');
  return [
    ...first.filter((table) => loadOrder.includes(table)),
    ...[...loadOrder].reverse().filter((table) => table !== 'tenants' && !first.includes(table)),
  ];
}

/**
 * REPLACE: the verified scratch over the SAME hosted tenant, in ONE transaction (ADR-0039 § 4):
 *
 *  1. the tenant row and its register row are locked (every write path holds the tenant row
 *     FOR SHARE, so nothing of the bot writes until this commits or rolls back);
 *  2. the request row claims the tenant rewrite allowance for THIS transaction
 *     (`rewrite_xact_id`), and `nexa.tenant_rewrite` names it;
 *  3. the tenant's rows are deleted, children first — a table an append-only guard protects on
 *     the system path under the replace's reason (the guard admits it only for this tenant,
 *     this transaction and this request), every other one BOUND TO THE TENANT (row-level
 *     security confines the statement to it);
 *  4. the archive's rows are inserted exactly as a new restore inserts them, the tenant row's
 *     own settings taken from the archive (never its id, kind, parent, slug or status);
 *  5. the register names the archive's owner admin when the current one is not in it, and the
 *     tenant ends at the status its register state holds (`HOSTED_BOT_TENANT_STATUS`);
 *  6. the copy is counted and compared with the scratch; any difference — or any failure before
 *     — rolls everything back, so the old rows stay until the new ones are in and counted.
 */
export async function applyReplace(input: {
  readonly app: DatabaseHandle;
  readonly scratch: DatabaseHandle;
  readonly manifest: TenantArchiveManifest;
  readonly installationTenantId: string;
  readonly requestId: string;
  readonly now: Date;
  readonly archiveCipher: SecretCipher;
  readonly targetCipher: SecretCipher;
}): Promise<Record<string, number>> {
  const tenantId = input.manifest.tenant.id;
  const tenantScope = { tenantId: tenantId as never, botInstanceId: null };
  const scratchCatalogue = await readCatalogue(input.scratch.db);
  const order = await tenantLoadOrder(input.scratch.db, scratchCatalogue);
  const expected = await scratchExpectation(
    input.scratch,
    scratchCatalogue,
    order,
    tenantId,
    input.archiveCipher,
  );

  return withSystemScope("tenant archive: replace a hosted tenant's rows", () =>
    input.app.db.transaction(async (tx) => {
      await pinSession(tx);
      const liveCatalogue = await readCatalogue(tx);
      const liveOrder = await tenantLoadOrder(tx, liveCatalogue);
      const tenantShape = liveCatalogue.get('tenants');
      if (tenantShape === undefined) throw new Error('the live database has no tenants table');

      // 1. The bot holds still: its tenant row and its register row, locked to the end.
      const [target] = await rowsOf<{ state: string; owner_admin_id: string }>(
        tx,
        sql`SELECT b.state, b.owner_admin_id::text AS owner_admin_id
              FROM tenants t
              JOIN hosted_bots b ON b.hosted_tenant_id = t.id
                                AND b.tenant_id = ${input.installationTenantId}::uuid
             WHERE t.id = ${tenantId}::uuid AND t.kind = 'HOSTED'
               AND t.parent_tenant_id = ${input.installationTenantId}::uuid
               FOR UPDATE OF t, b`,
      );
      if (target === undefined) {
        throw refuse(
          TENANT_ARCHIVE_ERROR_CODES.REPLACE_TARGET_MISSING,
          'The hosted bot to replace is no longer on this server.',
        );
      }
      if (target.state === 'PURGED') {
        throw refuse(TENANT_ARCHIVE_ERROR_CODES.PURGED, 'A purged hosted bot is closed for good.');
      }

      // 2. The allowance, for this transaction only.
      const claimed = await rowsOf<{ id: string }>(
        tx,
        sql`UPDATE tenant_restores
               SET rewrite_xact_id = (pg_current_xact_id()::text)::bigint, updated_at = ${input.now}
             WHERE id = ${input.requestId}::uuid
               AND tenant_id = ${input.installationTenantId}::uuid
               AND hosted_tenant_id = ${tenantId}::uuid
               AND mode = 'REPLACE' AND state = 'APPLYING'
         RETURNING id::text AS id`,
      );
      if (claimed.length !== 1) {
        throw new NexaError({
          kind: 'CONFLICT',
          code: TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
          message: 'The replace request is not applying; nothing was replaced.',
        });
      }
      await tx.execute(sql`SELECT set_config('nexa.tenant_rewrite', ${input.requestId}, true)`);
      // The register may name the archive's owner admin once it is reinserted; still checked
      // at commit.
      await tx.execute(sql`SET CONSTRAINTS hosted_bots_owner_admin_fk DEFERRED`);

      // 3. The old rows, children first.
      const guarded = await deleteGuardedTables(tx);
      const deleteIn = async (table: string): Promise<void> => {
        const statement = sql`DELETE FROM ${ident(table)} WHERE ${predicateFor(table, tenantId)}`;
        if (guarded.has(table)) {
          // The system path, under the replace's reason: the guard admits only this tenant.
          await tx.execute(statement);
        } else {
          await withTenantScopeIn(tx, tenantScope, () => tx.execute(statement));
        }
      };
      for (const table of await neverTablesBoundToTenantRows(tx)) {
        await withTenantScopeIn(tx, tenantScope, () =>
          tx.execute(sql`DELETE FROM ${ident(table)} WHERE tenant_id = ${tenantId}::uuid`),
        );
      }
      for (const table of replaceDeleteOrder(liveOrder)) await deleteIn(table);
      // The host's unspent «ورود به پنل» tokens for this bot end with it: one minted before the
      // replace would open a session over rows that are no longer the ones it was minted for.
      // (Its entered sessions are `admin_sessions`, deleted above with every other session.)
      await tx.execute(sql`
        UPDATE hosting_enter_tokens SET expires_at = created_at + interval '1 millisecond'
         WHERE tenant_id = ${input.installationTenantId}::uuid
           AND hosted_tenant_id = ${tenantId}::uuid
           AND used_at IS NULL AND expires_at > ${input.now}`);

      // 4. The archive's rows. The tenant row keeps who it is here; its settings are the archive's.
      await withScratchRows(
        input.scratch,
        scratchCatalogue.get('tenants'),
        tenantShape,
        tenantId,
        async (columns, rows) => {
          const at = (name: string) => columns.indexOf(name);
          if (rows.length !== 1 || rows[0]?.[at('id')] !== tenantId) {
            throw new NexaError({
              kind: 'PRECONDITION_FAILED',
              code: TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
              message: "The archive's tenant row is not the tenant its manifest names.",
            });
          }
          const row = rows[0] ?? [];
          const kept = new Set(['id', 'kind', 'parent_tenant_id', 'slug', 'status', 'updated_at']);
          const settings = columns.filter((column) => !kept.has(column));
          await tx.execute(sql`
            UPDATE tenants SET ${sql.join(
              settings.map((column) => {
                const type = tenantShape.columns.find((c) => c.name === column)?.type ?? 'text';
                return sql`${ident(column)} = ${row[at(column)] ?? null}::${sql.raw(castName(type))}`;
              }),
              sql`, `,
            )}, updated_at = ${input.now}
             WHERE id = ${tenantId}::uuid`);
        },
      );
      await copyArchiveRows(tx, input, scratchCatalogue, liveCatalogue, order);

      // 5. The register: the owner admin, and the bot the activation names.
      const [ownerKept] = await rowsOf<{ n: number }>(
        tx,
        sql`SELECT count(*)::int AS n FROM admins
             WHERE tenant_id = ${tenantId}::uuid AND id = ${target.owner_admin_id}::uuid`,
      );
      const owner =
        (ownerKept?.n ?? 0) > 0 ? target.owner_admin_id : input.manifest.host.ownerAdminId;
      await tx.execute(sql`
        UPDATE hosted_bots SET owner_admin_id = ${owner}::uuid, updated_at = ${input.now}
         WHERE tenant_id = ${input.installationTenantId}::uuid
           AND hosted_tenant_id = ${tenantId}::uuid`);
      // The activation keeps its domain and DNS/TLS marks (they are the domain's); it names the
      // archive's bot, or the one it named if that is still the tenant's. A different bot (or
      // none) has not had its token or webhook proven here: those marks are cleared.
      await tx.execute(sql`
        WITH next AS (
          SELECT coalesce(
                   (SELECT b.id FROM bot_instances b
                     WHERE b.tenant_id = ${tenantId}::uuid AND b.id = ${input.manifest.host.botInstanceId}::uuid),
                   (SELECT b.id FROM bot_instances b
                     WHERE b.tenant_id = ${tenantId}::uuid AND b.id = a.bot_instance_id)) AS bot
            FROM hosted_bot_activations a
           WHERE a.tenant_id = ${input.installationTenantId}::uuid
             AND a.hosted_tenant_id = ${tenantId}::uuid)
        UPDATE hosted_bot_activations a
           SET token_verified_at = CASE WHEN a.bot_instance_id IS NOT DISTINCT FROM next.bot
                                        THEN a.token_verified_at END,
               webhook_registered_at = CASE WHEN a.bot_instance_id IS NOT DISTINCT FROM next.bot
                                            THEN a.webhook_registered_at END,
               bot_instance_id = next.bot,
               updated_at = ${input.now}
          FROM next
         WHERE a.tenant_id = ${input.installationTenantId}::uuid
           AND a.hosted_tenant_id = ${tenantId}::uuid`);
      // The tenant ends where its register state holds it (the hold, if any, ends here).
      await tx.execute(sql`
        UPDATE tenants SET status = ${registerStatusSql(target.state)}, updated_at = ${input.now}
         WHERE id = ${tenantId}::uuid`);

      // 6. Counted and compared before anything commits.
      const counts = await compareWithScratch(
        tx,
        tenantId,
        liveCatalogue,
        order,
        expected,
        input.targetCipher,
      );
      await tx.execute(sql`SELECT set_config('nexa.tenant_rewrite', '', true)`);
      return counts;
    }),
  );
}

/** The tenant status a register state holds its tenant at, as a literal (a closed enum). */
function registerStatusSql(state: string): SQL {
  const status = (HOSTED_BOT_TENANT_STATUS as Readonly<Record<string, string>>)[state];
  if (status === undefined) throw new Error(`unknown hosted bot state ${state}`);
  return sql`${status}`;
}

/** A `format_type` name usable in a cast (the catalogue's own spelling). */
function castName(type: string): string {
  if (!/^[a-z_][a-z0-9_ ]*(\([0-9, ]+\))?(\[\])*$/.test(type)) {
    throw new Error('a column type is not one this release can name');
  }
  return type;
}
