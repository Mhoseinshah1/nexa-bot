import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_ARCHIVE_ERROR_CODES, type IdGenerator, type SecretCipher } from '@nexa/contracts';
import { FAST_KDF } from '../../../apps/api/src/infrastructure/crypto/kek';
import {
  createDatabase,
  type DatabaseHandle,
} from '../../../apps/api/src/infrastructure/persistence/database';
import { migrationsFolder } from '../../../apps/api/src/infrastructure/persistence/migration-state';
import { SEED_IDS } from '../../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleBackupRunRepository } from '../../../apps/api/src/modules/platform/backup/infrastructure/drizzle-backup-run.repository';
import { DrizzleTenantRestoreRepository } from '../../../apps/api/src/modules/platform/backup/infrastructure/drizzle-tenant-restore.repository';
import { PostgresDatabaseTools } from '../../../apps/api/src/modules/platform/backup/infrastructure/pg-tools';
import { PostgresTenantArchiveEngine } from '../../../apps/api/src/modules/platform/backup/infrastructure/tenant-archive-engine';
import {
  readCatalogue,
  tenantLoadOrder,
} from '../../../apps/api/src/modules/platform/backup/infrastructure/tenant-archive-copy';
import { canonicalDigests } from '../../../apps/api/src/modules/platform/backup/infrastructure/tenant-archive-restore';
import {
  replaceTarget,
  TENANT_REPLACE_REASON,
} from '../../../apps/api/src/modules/platform/backup/infrastructure/tenant-archive-apply';
import { DrizzleTenantReplaceHold } from '../../../apps/api/src/modules/platform/backup/infrastructure/tenant-replace-hold';
import {
  TenantArchiveService,
  TenantRestoreService,
} from '../../../apps/api/src/modules/platform/backup/application/tenant-archive.service';
import { hostedPreReplaceArchive } from '../../../apps/api/src/modules/platform/hosting/application/hosted-pre-replace';
import { DrizzleHostedBackupPolicies } from '../../../apps/api/src/modules/platform/hosting/infrastructure/drizzle-hosted-backup-policies';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../harness';
import { buildWorld, HOSTED_1, HOSTED_2, type World } from './fixtures';

/**
 * Phase 6B (ADR-0039 § 4, § 10) — REPLACE: a hosted archive restored over the SAME hosted bot,
 * on the same server, extending the isolation proof.
 *
 * HOSTED_1 is archived, then changes (an append-only audit row, a customer). The replace's dry
 * run changes nothing; its apply holds the bot still, takes a PRE_REPLACE archive that must
 * verify, deletes the bot's rows under the tenant rewrite allowance and inserts the archive's
 * in ONE transaction, compared with the verified scratch before it commits. Proven here:
 *
 *  - afterwards HOSTED_1 reads back exactly as archived (counts and canonical checksums, every
 *    table), and the rows written after the archive are gone (kept in the PRE_REPLACE archive);
 *  - the installation and HOSTED_2 are unchanged, table by table;
 *  - the bot ends at the status its register state holds (ACTIVE stays ACTIVE, DELETED stays
 *    DELETED/DISABLED), and was STOPPED while its rows were archived and replaced;
 *  - a replace that fails inside its transaction leaves every old row in place;
 *  - the allowance dies with the transaction: afterwards the guards refuse again;
 *  - a bot with no backup password, a PURGED bot, and a bot that is not this server's are
 *    refused before a row is touched.
 */

const PASSWORD = 'hosted-archive-password-1';
const SEVEN_ZIP = {
  binary: process.env['BACKUP_SEVEN_ZIP_BIN'] ?? '7z',
  level: 1,
  threads: 2,
  memoryBudgetMb: 1_000,
  memoryHeadroomMb: 0,
  readAvailableMb: async () => null,
  lowPriorityPrefix: [] as string[],
  sealTimeoutMs: 300_000,
  openTimeoutMs: 300_000,
};

const clock = { now: () => new Date() };
function uuidv7Like(): string {
  const hex = (Date.now().toString(16).padStart(12, '0') + randomBytes(10).toString('hex')).slice(
    0,
    32,
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const ids = {
  uuid: () => uuidv7Like(),
  callbackRef: () => randomBytes(8).toString('hex'),
} as unknown as IdGenerator;
const passthrough = {
  runWhenAdmitted: async <T>(_kind: unknown, _tenant: unknown, job: () => Promise<T>) => ({
    ran: true as const,
    result: await job(),
  }),
};
const queue = { pollMs: 10, maxWaitMs: 1_000, sleep: async () => undefined };
const logger = { info: () => undefined, error: () => undefined };

describe('tenant archive REPLACE (Phase 6B) — the same hosted bot, on the same server', () => {
  let world: World;
  let app: DatabaseHandle;
  let owner: DatabaseHandle;
  let root: string;
  let engine: PostgresTenantArchiveEngine;
  let archives: TenantArchiveService;
  let cipher: SecretCipher;
  let actor: string;
  let archivePath: string;
  let archived: Record<string, string>;
  const statusDuringPreReplace: string[] = [];

  async function digestsOf(tenantId: string): Promise<Record<string, string>> {
    return owner.db.transaction(async (tx) => {
      const catalogue = await readCatalogue(tx);
      const order = (await tenantLoadOrder(tx, catalogue)).filter((table) => table !== 'tenants');
      return canonicalDigests(tx, catalogue, order, tenantId, cipher);
    });
  }

  async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
    return (await owner.db.execute(query)).rows[0] as T;
  }

  async function bot(): Promise<{ state: string; status: string }> {
    return one(sql`SELECT b.state, t.status FROM hosted_bots b JOIN tenants t ON t.id = b.hosted_tenant_id
                    WHERE b.hosted_tenant_id = ${HOSTED_1}`);
  }

  function service(): TenantRestoreService {
    const preReplace = hostedPreReplaceArchive({
      policies: new DrizzleHostedBackupPolicies(app.db),
      cipher,
      archives,
      installationTenantId: () => SEED_IDS.tenantA,
    });
    const hold = new DrizzleTenantReplaceHold(app, () => new Date());
    return new TenantRestoreService({
      engine,
      requests: new DrizzleTenantRestoreRepository(app.db),
      replace: {
        hold: (installation, hosted) => hold.hold(installation, hosted),
        release: (installation, hosted) => hold.release(installation, hosted),
        preReplace: async (hosted) => {
          statusDuringPreReplace.push((await bot()).status);
          return preReplace(hosted);
        },
      },
      heavyJobs: passthrough,
      clock,
      ids,
      leaseOwner: 'test',
      queue,
    });
  }

  async function dryThenApply(path: string): Promise<{ requestId: string }> {
    const restores = service();
    const dry = await restores.restore({
      installationTenantId: SEED_IDS.tenantA,
      actorAdminId: actor,
      archivePath: path,
      password: PASSWORD,
      directory: join(root, `dry-${randomBytes(3).toString('hex')}`),
      mode: 'REPLACE',
    });
    if (dry === null) throw new Error('not admitted');
    try {
      await restores.restore({
        installationTenantId: SEED_IDS.tenantA,
        actorAdminId: actor,
        archivePath: path,
        password: PASSWORD,
        directory: join(root, `apply-${randomBytes(3).toString('hex')}`),
        mode: 'REPLACE',
        confirmRequestId: dry.requestId,
      });
    } catch (error) {
      throw Object.assign(error as Error, { requestId: dry.requestId });
    }
    return { requestId: dry.requestId };
  }

  beforeAll(async () => {
    world = await buildWorld();
    cipher = world.api.container.cipher;
    actor = world.tenants.PRIMARY.owner.id;
    app = createDatabase(testAppDatabaseUrl(), 4);
    owner = createDatabase(testOwnerDatabaseUrl(), 2);
    expect(await app.scopeEnforcement()).toBe('enforcing');
    root = await mkdtemp(join(tmpdir(), 'nexa-treplace-'));
    engine = new PostgresTenantArchiveEngine({
      app,
      scratch: new PostgresDatabaseTools({
        databaseUrl: testOwnerDatabaseUrl(),
        dumpTimeoutMs: 300_000,
        restoreTimeoutMs: 300_000,
        migratorEntrypoint: 'unused',
      }),
      sevenZip: SEVEN_ZIP,
      root,
      cipher,
      kdf: FAST_KDF,
      installationTenantId: () => SEED_IDS.tenantA,
      installationId: () => SEED_IDS.tenantA,
      release: 'test',
      migrationsFolder: migrationsFolder(),
      now: () => new Date(),
    });
    archives = new TenantArchiveService({
      runs: new DrizzleBackupRunRepository(world.api.container.database.db),
      engine,
      heavyJobs: passthrough,
      clock,
      ids,
      leaseOwner: 'test',
      queue,
      logger,
    });
    // The owner set HOSTED_1's backup password (the PRE_REPLACE archive is sealed with it).
    const policyId = uuidv7Like();
    const sealed = cipher.encrypt(PASSWORD, {
      purpose: 'hosting.archive_password',
      tenantId: SEED_IDS.tenantA,
      entityId: policyId,
    });
    await owner.db.execute(sql`
      INSERT INTO hosted_bot_backup_policies (id, tenant_id, hosted_tenant_id, enabled, daily_time,
                                              keep, password_ciphertext, password_key_id,
                                              password_set_at, created_at, updated_at)
      VALUES (${policyId}, ${SEED_IDS.tenantA}, ${HOSTED_1}, true, '04:30', 7, ${sealed.ciphertext},
              ${sealed.keyId}, now(), now(), now())`);

    // The archive the owner will restore over the bot.
    const done = await archives.run({ tenantId: HOSTED_1, trigger: 'MANUAL', password: PASSWORD });
    if (done.kind !== 'COMPLETED' || done.run.state !== 'SUCCEEDED') throw new Error('no archive');
    archivePath = join(root, 'replace.7z');
    await copyFile(join(root, 'hosted', HOSTED_1, done.run.id, 'archive.7z'), archivePath);
    archived = await digestsOf(HOSTED_1);
  }, 600_000);

  afterAll(async () => {
    await app?.close();
    await owner?.close();
    await world?.close();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  /** The bot changes after its archive: an append-only audit row and a customer. */
  async function changeAfterArchive(marker: string): Promise<void> {
    await owner.db.execute(sql`
      INSERT INTO audit_logs (id, tenant_id, occurred_at, actor_type, action, entity_type,
                              correlation_id, source_surface, result)
      VALUES (${uuidv7Like()}, ${HOSTED_1}, now(), 'SYSTEM_JOB', ${marker}, 'Tenant', 'c',
              'WORKER', 'SUCCESS')`);
    await owner.db.execute(sql`
      INSERT INTO customers (id, tenant_id, telegram_user_id, first_name)
      VALUES (${uuidv7Like()}, ${HOSTED_1}, ${String(900_000_000 + Math.floor(Math.random() * 1e6))},
              ${marker})`);
  }

  it('refuses before any row is touched: no password, a purged bot, a bot not of this server', async () => {
    await expect(replaceTarget(app, randomUUID(), SEED_IDS.tenantA)).rejects.toMatchObject({
      code: TENANT_ARCHIVE_ERROR_CODES.REPLACE_TARGET_MISSING,
    });
    await expect(replaceTarget(app, HOSTED_1, HOSTED_2)).rejects.toMatchObject({
      code: TENANT_ARCHIVE_ERROR_CODES.REPLACE_TARGET_MISSING,
    });
    await owner.db
      .execute(sql`UPDATE hosted_bots SET state = 'PURGED', deleted_at = now(), purged_at = now()
                                WHERE hosted_tenant_id = ${HOSTED_1}`);
    try {
      await expect(dryThenApply(archivePath)).rejects.toMatchObject({
        code: TENANT_ARCHIVE_ERROR_CODES.PURGED,
      });
    } finally {
      await owner.db
        .execute(sql`UPDATE hosted_bots SET state = 'ACTIVE', deleted_at = NULL, purged_at = NULL
                                  WHERE hosted_tenant_id = ${HOSTED_1}`);
    }
    const before = await digestsOf(HOSTED_1);
    await owner.db.execute(sql`
      UPDATE hosted_bot_backup_policies SET password_ciphertext = NULL, password_key_id = NULL,
                                             password_set_at = NULL
       WHERE hosted_tenant_id = ${HOSTED_1}`);
    try {
      await expect(dryThenApply(archivePath)).rejects.toMatchObject({
        code: TENANT_ARCHIVE_ERROR_CODES.PRE_REPLACE_FAILED,
      });
    } finally {
      const policy = await one<{ id: string }>(
        sql`SELECT id FROM hosted_bot_backup_policies WHERE hosted_tenant_id = ${HOSTED_1}`,
      );
      const sealed = cipher.encrypt(PASSWORD, {
        purpose: 'hosting.archive_password',
        tenantId: SEED_IDS.tenantA,
        entityId: policy.id,
      });
      await owner.db.execute(sql`
        UPDATE hosted_bot_backup_policies
           SET password_ciphertext = ${sealed.ciphertext}, password_key_id = ${sealed.keyId},
               password_set_at = now()
         WHERE id = ${policy.id}`);
    }
    expect(await digestsOf(HOSTED_1)).toEqual(before);
    // The hold was released: the bot is ACTIVE again.
    expect(await bot()).toEqual({ state: 'ACTIVE', status: 'ACTIVE' });
  }, 600_000);

  it('replaces an ACTIVE bot: exactly the archive afterwards, others untouched, PRE_REPLACE kept', async () => {
    await changeAfterArchive('zq-after-archive');
    // Since the archive the host entered the bot: its HOST principal (undeletable outside a
    // replace) and an entered session, which the replace must end.
    const host = uuidv7Like();
    await owner.db.execute(sql`
      INSERT INTO admins (id, tenant_id, username, display_name, kind, password_hash,
                          password_updated_at)
      VALUES (${host}, ${HOSTED_1}, 'host-principal', 'میزبان', 'HOST', NULL, now())`);
    await owner.db.execute(sql`
      INSERT INTO admin_sessions (id, tenant_id, admin_id, token_hash, issued_at, expires_at,
                                  last_seen_at, impersonated_by_admin_id,
                                  impersonation_hosting_session_id)
      VALUES (${uuidv7Like()}, ${HOSTED_1}, ${host}, ${randomBytes(32).toString('hex')}, now(),
              now() + interval '15 minutes', now(), ${actor}, ${uuidv7Like()})`);
    const changed = await digestsOf(HOSTED_1);
    expect(changed).not.toEqual(archived);
    const primary = await digestsOf(SEED_IDS.tenantA);
    const other = await digestsOf(HOSTED_2);
    statusDuringPreReplace.length = 0;

    const { requestId } = await dryThenApply(archivePath);

    expect(await digestsOf(HOSTED_1)).toEqual(archived);
    expect(
      (
        await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_logs
                                     WHERE tenant_id = ${HOSTED_1} AND action = 'zq-after-archive'`)
      ).n,
    ).toBe(0);
    // The HOST principal written after the archive is gone with the rest, and so is every
    // session of the bot — the host's entered one included.
    expect(
      await one<{ hosts: number; sessions: number }>(sql`
        SELECT (SELECT count(*)::int FROM admins WHERE tenant_id = ${HOSTED_1} AND kind = 'HOST') AS hosts,
               (SELECT count(*)::int FROM admin_sessions WHERE tenant_id = ${HOSTED_1}) AS sessions`),
    ).toEqual({ hosts: 0, sessions: 0 });
    // Nobody else changed, table by table.
    expect(await digestsOf(SEED_IDS.tenantA)).toEqual(primary);
    expect(await digestsOf(HOSTED_2)).toEqual(other);
    // Held still while its rows were archived and replaced; back to its register's status.
    expect(statusDuringPreReplace).toEqual(['STOPPED']);
    expect(await bot()).toEqual({ state: 'ACTIVE', status: 'ACTIVE' });
    // The PRE_REPLACE archive: taken through the pipeline, verified, named by the request.
    const request = await one<{
      state: string;
      mode: string;
      pre: string | null;
      xact: string | null;
    }>(
      sql`SELECT state, mode, pre_replace_run_id AS pre, rewrite_xact_id::text AS xact
            FROM tenant_restores WHERE id = ${requestId}`,
    );
    expect(request).toMatchObject({ state: 'SUCCEEDED', mode: 'REPLACE' });
    expect(request.xact).not.toBeNull();
    const pre = await one<{ trigger: string; state: string; verified: boolean; subject: string }>(
      sql`SELECT trigger, state, verified_at IS NOT NULL AS verified, subject_tenant_id AS subject
            FROM backup_runs WHERE id = ${request.pre}`,
    );
    expect(pre).toEqual({
      trigger: 'PRE_REPLACE',
      state: 'SUCCEEDED',
      verified: true,
      subject: HOSTED_1,
    });
    // The PRE_REPLACE archive holds the rows the replace removed: it restores into scratch.
    const preArchive = join(root, 'hosted', HOSTED_1, String(request.pre), 'archive.7z');
    const checked = await engine.verify({
      archivePath: preArchive,
      password: PASSWORD,
      directory: await mkdtemp(join(root, 'pre-')),
      expectedManifestSha256: (
        await one<{ checksum: string }>(
          sql`SELECT checksum FROM backup_runs WHERE id = ${request.pre}`,
        )
      ).checksum,
    });
    expect(checked.rows).toBeGreaterThan(0);

    // The allowance died with its transaction: the system path, the reason, the request named —
    // and the guard refuses a DELETE of the bot's append-only rows again.
    const client = new Client({ connectionString: testAppDatabaseUrl() });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('role', 'nexa_system', true), set_config('app.system_reason', $1, true),
                set_config('nexa.tenant_rewrite', $2, true)`,
        [TENANT_REPLACE_REASON, requestId],
      );
      await expect(
        client.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [HOSTED_1]),
      ).rejects.toMatchObject({ code: '23001' });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  }, 600_000);

  it('a replace that fails inside its transaction leaves every old row in place', async () => {
    // A forged archive (re-sealed with the password, as anyone holding it could): one audit
    // row carries the id of one of HOSTED_2's. The dry run cannot see it; the apply's INSERT
    // collides after the old rows were deleted — and the whole transaction rolls back.
    const foreign = await one<{ id: string } | undefined>(
      sql`SELECT id FROM audit_logs WHERE tenant_id = ${HOSTED_2} LIMIT 1`,
    );
    const foreignId = foreign?.id ?? uuidv7Like();
    if (foreign === undefined) {
      await owner.db.execute(sql`
        INSERT INTO audit_logs (id, tenant_id, occurred_at, actor_type, action, entity_type,
                                correlation_id, source_surface, result)
        VALUES (${foreignId}, ${HOSTED_2}, now(), 'SYSTEM_JOB', 'x', 'Tenant', 'c', 'WORKER', 'SUCCESS')`);
    }
    const ws = await engine.workspace(HOSTED_1, uuidv7Like());
    await engine.dump({
      tenantId: HOSTED_1,
      directory: ws.plainDirectory,
      archiveId: `forged-${randomBytes(3).toString('hex')}`,
      createdAt: new Date(),
      password: PASSWORD,
    });
    const manifestPath = join(ws.plainDirectory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      tables: {
        name: string;
        file: string;
        columns: { name: string }[];
        bytes: number;
        sha256: string;
      }[];
    };
    const audit = manifest.tables.find((table) => table.name === 'audit_logs');
    if (audit === undefined) throw new Error('no audit part');
    const at = audit.columns.findIndex((column) => column.name === 'id');
    const path = join(ws.plainDirectory, audit.file);
    const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line !== '');
    lines[0] = lines[0]!
      .split('\t')
      .map((value, index) => (index === at ? foreignId : value))
      .join('\t');
    // The scratch re-reads in primary-key order: the forged row takes its place in it.
    const key = (line: string) => line.split('\t')[at] ?? '';
    lines.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    await writeFile(path, lines.join('\n') + '\n');
    for (const table of manifest.tables) {
      const bytes = await readFile(join(ws.plainDirectory, table.file));
      table.bytes = bytes.length;
      table.sha256 = createHash('sha256').update(bytes).digest('hex');
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    await engine.seal({
      directory: ws.plainDirectory,
      archivePath: ws.archivePath,
      password: PASSWORD,
    });
    const forged = join(root, 'forged.7z');
    await copyFile(ws.archivePath, forged);
    await ws.discardAll();

    await changeAfterArchive('zq-before-failed-replace');
    const before = await digestsOf(HOSTED_1);
    const others = [await digestsOf(SEED_IDS.tenantA), await digestsOf(HOSTED_2)];
    let requestId = '';
    await expect(
      dryThenApply(forged).catch((error: unknown) => {
        requestId = (error as { requestId?: string }).requestId ?? '';
        throw error;
      }),
    ).rejects.toThrow();
    expect(await digestsOf(HOSTED_1)).toEqual(before);
    expect([await digestsOf(SEED_IDS.tenantA), await digestsOf(HOSTED_2)]).toEqual(others);
    expect(await bot()).toEqual({ state: 'ACTIVE', status: 'ACTIVE' });
    const request = await one<{ state: string; pre: string | null }>(
      sql`SELECT state, pre_replace_run_id AS pre FROM tenant_restores WHERE id = ${requestId}`,
    );
    expect(request.state).toBe('FAILED');
    expect(request.pre).not.toBeNull();
  }, 600_000);

  it('restores a DELETED bot over itself; it stays DELETED until the owner activates it', async () => {
    await owner.db.execute(sql`UPDATE hosted_bots SET state = 'DELETED', deleted_at = now()
                                WHERE hosted_tenant_id = ${HOSTED_1}`);
    await owner.db.execute(sql`UPDATE tenants SET status = 'DISABLED' WHERE id = ${HOSTED_1}`);
    await changeAfterArchive('zq-before-deleted-replace');
    statusDuringPreReplace.length = 0;
    await dryThenApply(archivePath);
    expect(await digestsOf(HOSTED_1)).toEqual(archived);
    expect(statusDuringPreReplace).toEqual(['DISABLED']);
    expect(await bot()).toEqual({ state: 'DELETED', status: 'DISABLED' });
  }, 600_000);
});
