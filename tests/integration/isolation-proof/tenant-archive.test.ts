import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PLATFORM_ERROR_CODES,
  TENANT_ARCHIVE_ERROR_CODES,
  type IdGenerator,
  type SecretCipher,
} from '@nexa/contracts';
import { AesGcmSecretCipher } from '../../../apps/api/src/infrastructure/crypto/secret-cipher';
import { FAST_KDF } from '../../../apps/api/src/infrastructure/crypto/kek';
import {
  createDatabase,
  type DatabaseHandle,
} from '../../../apps/api/src/infrastructure/persistence/database';
import { runMigrations } from '../../../apps/api/src/infrastructure/persistence/migrate';
import {
  expectedMigrations,
  migrationsFolder,
} from '../../../apps/api/src/infrastructure/persistence/migration-state';
import { ensureRowLevelSecurity } from '../../../apps/api/src/infrastructure/persistence/row-level-security';
import { seed, SEED_IDS } from '../../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleBackupRunRepository } from '../../../apps/api/src/modules/platform/backup/infrastructure/drizzle-backup-run.repository';
import { DrizzleTenantRestoreRepository } from '../../../apps/api/src/modules/platform/backup/infrastructure/drizzle-tenant-restore.repository';
import { PostgresDatabaseTools } from '../../../apps/api/src/modules/platform/backup/infrastructure/pg-tools';
import {
  PostgresTenantArchiveEngine,
  type TenantArchiveEngineDeps,
} from '../../../apps/api/src/modules/platform/backup/infrastructure/tenant-archive-engine';
import { decodeCopyLine } from '../../../apps/api/src/modules/platform/backup/infrastructure/tenant-archive-copy';
import { exportTenant } from '../../../apps/api/src/modules/platform/backup/infrastructure/tenant-archive-export';
import {
  canonicalDigests,
  compareArchiveHead,
  migrateScratchTo,
  TENANT_ARCHIVE_HEAD_NEWER_REASON,
} from '../../../apps/api/src/modules/platform/backup/infrastructure/tenant-archive-restore';
import {
  readCatalogue,
  tenantLoadOrder,
} from '../../../apps/api/src/modules/platform/backup/infrastructure/tenant-archive-copy';
import { archiveCipher } from '../../../apps/api/src/modules/platform/backup/infrastructure/tenant-archive-secrets';
import { HeavyJobGate } from '../../../apps/api/src/modules/platform/capacity/application/heavy-job-gate';
import { DrizzleHeavyJobQueueRepository } from '../../../apps/api/src/modules/platform/capacity/infrastructure/drizzle-capacity.repository';
import {
  TenantArchiveService,
  TenantRestoreService,
} from '../../../apps/api/src/modules/platform/backup/application/tenant-archive.service';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../harness';
import { buildWorld, HOSTED_1, HOSTED_2, type World } from './fixtures';

/**
 * Phase 6B PR-1 (ADR-0039 § 1-5, § Cross-cutting) — the tenant archive, extending the
 * Phase 6A isolation proof.
 *
 * The world is the isolation proof's: the installation (PRIMARY) and two full HOSTED tenants
 * with the same household and a marker string each. The archive of HOSTED_1 is exported as
 * `nexa_app` with row-level security on, sealed, verified in a scratch database, and restored
 * into a FRESH install with its own key, where every table must read back with the same
 * counts and the same canonical checksums, its secrets under the TARGET's key, and nothing of
 * the target's own tenants changed. Each rule has a falsification beside it: a forged leak, a
 * flipped byte, a wrong password, a newer or diverged head, a duplicate, an owner connection.
 */

const PASSWORD = 'hosted-archive-password-1';
const MARKERS = { PRIMARY: 'zqprimaryq', HOSTED_2: 'zqhostedtwoq' } as const;
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

function cipherWith(keyId: string): SecretCipher {
  return new AesGcmSecretCipher(
    { activeKeyId: keyId, keys: new Map([[keyId, randomBytes(32)]]), format: 'canonical' },
    false,
  );
}

function urlFor(database: string, user?: 'nexa_app'): string {
  const url = new URL(testOwnerDatabaseUrl());
  url.pathname = `/${database}`;
  return user === undefined ? url.toString() : testAppDatabaseUrl(url.toString());
}

async function admin(statement: string): Promise<void> {
  const client = new Client({ connectionString: urlFor('postgres') });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

const clock = { now: () => new Date() };
const ids = {
  uuid: () => uuidv7Like(),
  callbackRef: () => randomBytes(8).toString('hex'),
} as unknown as IdGenerator;
function uuidv7Like(): string {
  const hex = (Date.now().toString(16).padStart(12, '0') + randomBytes(10).toString('hex')).slice(
    0,
    32,
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function engineFor(input: {
  app: DatabaseHandle;
  ownerUrl: string;
  root: string;
  cipher: SecretCipher;
  installationTenantId: string;
  folder?: string;
  maxExtractedBytes?: number;
}): PostgresTenantArchiveEngine {
  const deps: TenantArchiveEngineDeps = {
    app: input.app,
    scratch: new PostgresDatabaseTools({
      databaseUrl: input.ownerUrl,
      dumpTimeoutMs: 300_000,
      restoreTimeoutMs: 300_000,
      migratorEntrypoint: 'unused',
    }),
    sevenZip: SEVEN_ZIP,
    root: input.root,
    cipher: input.cipher,
    kdf: FAST_KDF,
    installationTenantId: () => input.installationTenantId,
    installationId: () => input.installationTenantId,
    release: 'test',
    migrationsFolder: input.folder ?? migrationsFolder(),
    now: () => new Date(),
    ...(input.maxExtractedBytes === undefined
      ? {}
      : { maxExtractedBytes: input.maxExtractedBytes }),
  };
  return new PostgresTenantArchiveEngine(deps);
}

describe('tenant archive (Phase 6B PR-1) — export, verify, restore, as nexa_app', () => {
  let world: World;
  let app: DatabaseHandle;
  let owner: DatabaseHandle;
  let root: string;
  let engine: PostgresTenantArchiveEngine;
  let archivePath: string;
  const targetName = `nexa_tarc_target_${randomBytes(4).toString('hex')}`;
  let target: { app: DatabaseHandle; owner: DatabaseHandle; cipher: SecretCipher; actor: string };

  beforeAll(async () => {
    world = await buildWorld();
    app = createDatabase(testAppDatabaseUrl(), 4);
    owner = createDatabase(testOwnerDatabaseUrl(), 2);
    expect(await app.scopeEnforcement()).toBe('enforcing');
    root = await mkdtemp(join(tmpdir(), 'nexa-tarc-'));
    engine = engineFor({
      app,
      ownerUrl: testOwnerDatabaseUrl(),
      root,
      cipher: world.api.container.cipher,
      installationTenantId: SEED_IDS.tenantA,
    });

    // A FRESH install: its own database, its own key, the seed's installation and an owner.
    await admin(`CREATE DATABASE "${targetName}"`);
    await runMigrations(urlFor(targetName));
    const targetOwner = createDatabase(urlFor(targetName), 2);
    const targetCipher = cipherWith('target-key');
    await seed(targetOwner.db, targetCipher);
    const actor = '01900000-0000-7000-8000-0000000fa001';
    await targetOwner.db.execute(sql`
      INSERT INTO admins (id, tenant_id, username, display_name, password_hash, password_updated_at)
      VALUES (${actor}, ${SEED_IDS.tenantA}, 'target-owner', 'Target owner', 'x', now())`);
    target = {
      app: createDatabase(urlFor(targetName, 'nexa_app'), 4),
      owner: targetOwner,
      cipher: targetCipher,
      actor,
    };
  }, 600_000);

  afterAll(async () => {
    await target?.app.close();
    await target?.owner.close();
    await app?.close();
    await owner?.close();
    await world?.close();
    await admin(`DROP DATABASE IF EXISTS "${targetName}" WITH (FORCE)`).catch(() => undefined);
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  /** Every part of an export: table -> decoded rows, and the raw bytes. */
  async function partsOf(directory: string): Promise<{
    rows: Map<string, { columns: string[]; rows: (string | null)[][] }>;
    bytes: string;
  }> {
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
      tables: { name: string; file: string; columns: { name: string }[] }[];
    };
    const out = new Map<string, { columns: string[]; rows: (string | null)[][] }>();
    let bytes = '';
    for (const table of manifest.tables) {
      const text = await readFile(join(directory, table.file), 'utf8');
      bytes += text;
      out.set(table.name, {
        columns: table.columns.map((column) => column.name),
        rows: text
          .split('\n')
          .filter((line) => line !== '')
          .map(decodeCopyLine),
      });
    }
    return { rows: out, bytes };
  }

  /** The rows of `parts` that are not `tenantId`'s. Empty passes. */
  async function foreignRows(
    parts: Map<string, { columns: string[]; rows: (string | null)[][] }>,
    tenantId: string,
  ): Promise<string[]> {
    const outbox = new Set(
      (
        (
          await owner.db.execute(
            sql`SELECT id::text AS id, aggregate_type || '|' || aggregate_id AS agg FROM outbox_messages WHERE tenant_id = ${tenantId}`,
          )
        ).rows as { id: string; agg: string }[]
      ).flatMap((row) => [row.id, row.agg]),
    );
    const out: string[] = [];
    for (const [table, part] of parts) {
      const at = (name: string) => part.columns.indexOf(name);
      for (const row of part.rows) {
        const own =
          table === 'tenants'
            ? row[at('id')] === tenantId
            : table === 'processed_messages'
              ? outbox.has(row[at('message_id')] ?? '')
              : table === 'aggregate_sequences'
                ? outbox.has(`${row[at('aggregate_type')] ?? ''}|${row[at('aggregate_id')] ?? ''}`)
                : row[at('tenant_id')] === tenantId;
        if (!own) out.push(table);
      }
    }
    return out;
  }

  it('an export of HOSTED_1 holds every one of its tables and no row of another tenant', async () => {
    const directory = join(root, 'export-1');
    await mkdir(directory, { recursive: true });
    const archiveKey = randomBytes(32);
    const manifest = await exportTenant({
      app,
      tenantId: HOSTED_1,
      installationTenantId: SEED_IDS.tenantA,
      directory,
      archiveId: 'export-1',
      archiveKeyId: 'archive-export-1',
      createdAt: new Date(),
      source: { installationId: 'test', release: 'test' },
      sourceCipher: world.api.container.cipher,
      archiveCipher: archiveCipher('archive-export-1', archiveKey),
      migrationsFolder: migrationsFolder(),
    });
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    const parts = await partsOf(directory);
    // Non-vacuous: the household is there.
    for (const table of [
      'tenants',
      'customers',
      'orders',
      'wallet_entries',
      'bot_instances',
      'tickets',
    ]) {
      expect(parts.rows.get(table)?.rows.length ?? 0, table).toBeGreaterThan(0);
    }
    expect(manifest.secrets.perPurpose['bot_instance.token']).toBe(1);
    expect(manifest.notExported.map((entry) => entry.name)).toContain('admin_sessions');
    expect(manifest.host.botUsername).toBe('hosted_one_bot');
    // The proof: not one row of another tenant, by tenant_id and by the three joins…
    expect(await foreignRows(parts.rows, HOSTED_1)).toEqual([]);
    // …and not one marker of another tenant anywhere in the bytes.
    expect(parts.bytes).toContain('zqhostedoneq');
    expect(parts.bytes).not.toContain(MARKERS.PRIMARY);
    expect(parts.bytes).not.toContain(MARKERS.HOSTED_2);
    // No secret of this server travels: the stored token is under the archive key only.
    const token = parts.rows.get('bot_instances');
    const keyIdAt = token?.columns.indexOf('token_key_id') ?? -1;
    expect(token?.rows.map((row) => row[keyIdAt])).toEqual(['archive-export-1']);

    // Falsified: the same detector flags a part that carries another tenant's row.
    const forged = new Map(parts.rows);
    const customers = parts.rows.get('customers');
    if (customers === undefined) throw new Error('no customers part');
    const tenantAt = customers.columns.indexOf('tenant_id');
    forged.set('customers', {
      columns: customers.columns,
      rows: [...customers.rows, customers.rows[0]!.map((v, i) => (i === tenantAt ? HOSTED_2 : v))],
    });
    expect(await foreignRows(forged, HOSTED_1)).toEqual(['customers']);
  });

  it('refuses an export on a connection that bypasses row-level security', async () => {
    const directory = join(root, 'export-owner');
    await expect(
      exportTenant({
        app: owner,
        tenantId: HOSTED_1,
        installationTenantId: SEED_IDS.tenantA,
        directory,
        archiveId: 'export-owner',
        archiveKeyId: 'archive-export-owner',
        createdAt: new Date(),
        source: { installationId: 'test', release: 'test' },
        sourceCipher: world.api.container.cipher,
        archiveCipher: archiveCipher('archive-export-owner', randomBytes(32)),
        migrationsFolder: migrationsFolder(),
      }),
    ).rejects.toMatchObject({ code: TENANT_ARCHIVE_ERROR_CODES.RLS_BYPASSED });
    // And a tenant that is not hosted here (the installation itself) is refused.
    await expect(
      exportTenant({
        app,
        tenantId: SEED_IDS.tenantA,
        installationTenantId: SEED_IDS.tenantA,
        directory,
        archiveId: 'export-primary',
        archiveKeyId: 'archive-export-primary',
        createdAt: new Date(),
        source: { installationId: 'test', release: 'test' },
        sourceCipher: world.api.container.cipher,
        archiveCipher: archiveCipher('archive-export-primary', randomBytes(32)),
        migrationsFolder: migrationsFolder(),
      }),
    ).rejects.toMatchObject({ code: TENANT_ARCHIVE_ERROR_CODES.NOT_HOSTED });
  });

  it('runs the six stages through the queue: DELIVER only after a VERIFY_RESTORE that passed', async () => {
    const runs = new DrizzleBackupRunRepository(world.api.container.database.db);
    const gate = new HeavyJobGate({
      repository: new DrizzleHeavyJobQueueRepository(world.api.container.database.db),
      limits: { numberOf: async () => 1 },
      probe: { memory: async () => ({ hostAvailableBytes: null, containerHeadroomBytes: null }) },
      ownerOpsLog: { record: async () => undefined },
      clock,
      ids,
      installationTenantId: () => SEED_IDS.tenantA,
    } as never);
    const logger = { info: () => undefined, error: () => undefined };
    const service = (over: Partial<PostgresTenantArchiveEngine> = {}) =>
      new TenantArchiveService({
        runs,
        engine: Object.assign(Object.create(engine) as PostgresTenantArchiveEngine, over),
        heavyJobs: gate,
        clock,
        ids,
        leaseOwner: 'test',
        queue: {
          pollMs: 10,
          maxWaitMs: 5_000,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        },
        logger,
      });
    const done = await service().run({ tenantId: HOSTED_1, trigger: 'MANUAL', password: PASSWORD });
    expect(done.kind).toBe('COMPLETED');
    if (done.kind !== 'COMPLETED') return;
    expect(done.run.state).toBe('SUCCEEDED');
    expect(done.run.verifiedAt).not.toBeNull();
    expect(done.run.subjectTenantId).toBe(HOSTED_1);
    expect(done.run.archiveFormat).toBe('SEVEN_ZIP');
    // Not the owner's backup: his "last good backup" does not see it.
    expect(await runs.latestVerified()).toBeNull();
    // The archive stays, verified, under hosted/<tenant>/<run>/; the plaintext is gone.
    const directory = join(root, 'hosted', HOSTED_1, done.run.id);
    expect((await readdir(directory)).sort()).toEqual(['archive.7z']);
    archivePath = join(root, 'kept.7z');
    await copyFile(join(directory, 'archive.7z'), archivePath);
    // Through the queue: the ticket is DONE.
    const tickets = (
      await owner.db.execute(
        sql`SELECT kind, state FROM heavy_job_tickets WHERE tenant_id = ${HOSTED_1}`,
      )
    ).rows as { kind: string; state: string }[];
    expect(tickets).toContainEqual({ kind: 'BACKUP', state: 'DONE' });

    // Falsified: a verification that fails leaves the run FAILED at VERIFY_RESTORE, never
    // DELIVER, and takes the unproven archive with it.
    const failed = await service({
      verify: async () => {
        throw Object.assign(new Error('scratch mismatch'), {
          code: 'tenant_archive.verification_failed',
        });
      },
    }).run({ tenantId: HOSTED_1, trigger: 'MANUAL', password: PASSWORD });
    if (failed.kind !== 'COMPLETED') throw new Error('not completed');
    expect(failed.run.state).toBe('FAILED');
    expect(failed.run.stage).toBe('VERIFY_RESTORE');
    expect(failed.run.verifiedAt).toBeNull();
    await expect(readdir(join(root, 'hosted', HOSTED_1, failed.run.id))).rejects.toThrow();
  }, 300_000);

  it('the verification catches a flipped byte and a wrong password', async () => {
    const directory = await mkdtemp(join(root, 'verify-'));
    await expect(
      engine.verify({
        archivePath,
        password: 'not-the-password',
        directory,
        expectedManifestSha256: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_AUTH_FAILED });
    // A part changed after the manifest was written: re-seal the changed plaintext, verify.
    const ws = await engine.workspace(HOSTED_2, uuidv7Like());
    const dumped = await engine.dump({
      tenantId: HOSTED_2,
      directory: ws.plainDirectory,
      archiveId: 'flip',
      createdAt: new Date(),
      password: PASSWORD,
    });
    const part = dumped.manifest.tables.find((table) => table.name === 'customers');
    if (part === undefined) throw new Error('no customers part');
    const path = join(ws.plainDirectory, part.file);
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace('zqhostedtwoq', 'zqhostedtwoX'));
    await engine.seal({
      directory: ws.plainDirectory,
      archivePath: ws.archivePath,
      password: PASSWORD,
    });
    await expect(
      engine.verify({
        archivePath: ws.archivePath,
        password: PASSWORD,
        directory: ws.verifyDirectory,
        expectedManifestSha256: dumped.manifestSha256,
      }),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.BACKUP_CHECKSUM_MISMATCH });
    await ws.discardAll();
  }, 300_000);

  function targetEngine(folder?: string): PostgresTenantArchiveEngine {
    return engineFor({
      app: target.app,
      ownerUrl: urlFor(targetName),
      root,
      cipher: target.cipher,
      installationTenantId: SEED_IDS.tenantA,
      ...(folder === undefined ? {} : { folder }),
    });
  }

  function restoreService(
    on: PostgresTenantArchiveEngine,
    handle: DatabaseHandle,
  ): TenantRestoreService {
    return new TenantRestoreService({
      engine: on,
      requests: new DrizzleTenantRestoreRepository(handle.db),
      heavyJobs: {
        runWhenAdmitted: async (_kind, _tenant, job) => ({ ran: true, result: await job() }),
      },
      clock,
      ids,
      queue: { pollMs: 10, maxWaitMs: 1_000, sleep: async () => undefined },
    });
  }

  async function digestsOf(
    handle: DatabaseHandle,
    tenantId: string,
    cipher: SecretCipher,
  ): Promise<Record<string, string>> {
    return handle.db.transaction(async (tx) => {
      const catalogue = await readCatalogue(tx);
      const order = (await tenantLoadOrder(tx, catalogue)).filter((table) => table !== 'tenants');
      return canonicalDigests(tx, catalogue, order, tenantId, cipher);
    });
  }

  it('export → fresh install → restore: identical counts and checksums, secrets under the target key, no other tenant touched', async () => {
    const before = await digestsOf(target.owner, SEED_IDS.tenantA, target.cipher);
    const service = restoreService(targetEngine(), target.app);
    const dry = await service.restore({
      installationTenantId: SEED_IDS.tenantA,
      actorAdminId: target.actor,
      archivePath,
      password: PASSWORD,
      directory: join(root, 'restore-dry'),
      mode: 'NEW',
    });
    if (dry === null) throw new Error('not admitted');
    expect(dry.summary.head).toBe('EQUAL');
    // The dry run wrote nothing to the live database.
    expect(
      (
        (
          await target.owner.db.execute(
            sql`SELECT count(*)::int AS n FROM tenants WHERE id = ${HOSTED_1}`,
          )
        ).rows[0] as { n: number }
      ).n,
    ).toBe(0);
    const applied = await service.restore({
      installationTenantId: SEED_IDS.tenantA,
      actorAdminId: target.actor,
      archivePath,
      password: PASSWORD,
      directory: join(root, 'restore-apply'),
      mode: 'NEW',
      confirmRequestId: dry.requestId,
    });
    expect(applied?.summary.counts).toEqual(dry.summary.counts);

    // Identical row counts and canonical checksums, table by table.
    const source = await digestsOf(owner, HOSTED_1, world.api.container.cipher);
    const restored = await digestsOf(target.owner, HOSTED_1, target.cipher);
    expect(restored).toEqual(source);
    expect(Object.keys(source).length).toBeGreaterThan(20);
    // The secret reads under the TARGET's key, and names it.
    const bot = (
      await target.owner.db.execute(
        sql`SELECT id, token_ciphertext, token_key_id FROM bot_instances WHERE tenant_id = ${HOSTED_1}`,
      )
    ).rows[0] as { id: string; token_ciphertext: string; token_key_id: string };
    expect(bot.token_key_id).toBe('target-key');
    const original = (
      await owner.db.execute(
        sql`SELECT token_ciphertext, token_key_id FROM bot_instances WHERE id = ${bot.id}`,
      )
    ).rows[0] as { token_ciphertext: string; token_key_id: string };
    const context = {
      purpose: 'bot_instance.token' as const,
      tenantId: HOSTED_1,
      entityId: bot.id,
    };
    expect(
      target.cipher.decrypt({ ciphertext: bot.token_ciphertext, keyId: bot.token_key_id }, context),
    ).toBe(
      world.api.container.cipher.decrypt(
        { ciphertext: original.token_ciphertext, keyId: original.token_key_id },
        context,
      ),
    );
    // A new HOSTED child of the target, stopped, with the register SUSPENDED and no marks.
    const tenant = (
      await target.owner.db.execute(
        sql`SELECT kind, parent_tenant_id, status FROM tenants WHERE id = ${HOSTED_1}`,
      )
    ).rows[0];
    expect(tenant).toEqual({
      kind: 'HOSTED',
      parent_tenant_id: SEED_IDS.tenantA,
      status: 'STOPPED',
    });
    const register = (
      await target.owner.db.execute(
        sql`SELECT b.state, a.dns_verified_at, a.webhook_registered_at FROM hosted_bots b
            JOIN hosted_bot_activations a USING (tenant_id, hosted_tenant_id)
           WHERE b.hosted_tenant_id = ${HOSTED_1}`,
      )
    ).rows[0];
    expect(register).toEqual({
      state: 'SUSPENDED',
      dns_verified_at: null,
      webhook_registered_at: null,
    });
    // The target's own tenant is unchanged, table by table.
    expect(await digestsOf(target.owner, SEED_IDS.tenantA, target.cipher)).toEqual(before);
    const request = (
      await target.owner.db.execute(
        sql`SELECT state, stage, confirmed_at IS NOT NULL AS confirmed FROM tenant_restores WHERE id = ${dry.requestId}`,
      )
    ).rows[0];
    expect(request).toEqual({ state: 'SUCCEEDED', stage: 'DONE', confirmed: true });
  }, 600_000);

  it('refuses the same tenant twice, never merging, and refuses replace', async () => {
    const service = restoreService(targetEngine(), target.app);
    await expect(
      service.restore({
        installationTenantId: SEED_IDS.tenantA,
        actorAdminId: target.actor,
        archivePath,
        password: PASSWORD,
        directory: join(root, 'restore-dup'),
        mode: 'NEW',
      }),
    ).rejects.toMatchObject({ code: TENANT_ARCHIVE_ERROR_CODES.TENANT_EXISTS });
    // On the source install, where it still lives, likewise.
    const sourceService = restoreService(engine, app);
    const actor = world.tenants.PRIMARY.owner.id;
    await expect(
      sourceService.restore({
        installationTenantId: SEED_IDS.tenantA,
        actorAdminId: actor,
        archivePath,
        password: PASSWORD,
        directory: join(root, 'restore-dup-source'),
        mode: 'NEW',
      }),
    ).rejects.toMatchObject({ code: TENANT_ARCHIVE_ERROR_CODES.TENANT_EXISTS });
    await expect(
      service.restore({
        installationTenantId: SEED_IDS.tenantA,
        actorAdminId: target.actor,
        archivePath,
        password: PASSWORD,
        directory: join(root, 'restore-replace'),
        mode: 'REPLACE',
      }),
    ).rejects.toMatchObject({ code: TENANT_ARCHIVE_ERROR_CODES.REPLACE_UNAVAILABLE });
  }, 600_000);

  /**
   * Security review of PR-1: an archive is only as trustworthy as whoever holds its password.
   * HOSTED_2's archive, opened and re-sealed with chosen edits (the manifest's own SHA-256 per
   * part recomputed, as a forger would): the edits must not reach the register, the tenant's
   * kind, a shared sequence, or the disk.
   */
  async function crafted(
    edit: (directory: string, manifest: Record<string, any>) => Promise<void>,
  ): Promise<string> {
    const ws = await engine.workspace(HOSTED_2, uuidv7Like());
    await engine.dump({
      tenantId: HOSTED_2,
      directory: ws.plainDirectory,
      archiveId: `crafted-${randomBytes(3).toString('hex')}`,
      createdAt: new Date(),
      password: PASSWORD,
    });
    const manifestPath = join(ws.plainDirectory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, any>;
    await edit(ws.plainDirectory, manifest);
    for (const table of manifest.tables as { file: string; bytes: number; sha256: string }[]) {
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
    const out = join(root, `crafted-${randomBytes(3).toString('hex')}.7z`);
    await copyFile(ws.archivePath, out);
    await ws.discardAll();
    return out;
  }

  /** Rewrites one column of one table's part. */
  async function rewrite(
    directory: string,
    manifest: Record<string, any>,
    table: string,
    column: string,
    value: string,
  ): Promise<void> {
    const part = (
      manifest.tables as { name: string; file: string; columns: { name: string }[] }[]
    ).find((t) => t.name === table);
    if (part === undefined) throw new Error(`no ${table} part`);
    const at = part.columns.findIndex((c) => c.name === column);
    const path = join(directory, part.file);
    const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line !== '');
    await writeFile(
      path,
      lines
        .map((line) =>
          line
            .split('\t')
            .map((v, i) => (i === at ? value : v))
            .join('\t'),
        )
        .join('\n') + '\n',
    );
  }

  async function dryThenApply(path: string, on = targetEngine()) {
    const service = restoreService(on, target.app);
    const dry = await service.restore({
      installationTenantId: SEED_IDS.tenantA,
      actorAdminId: target.actor,
      archivePath: path,
      password: PASSWORD,
      directory: join(root, `dry-${randomBytes(3).toString('hex')}`),
      mode: 'NEW',
    });
    if (dry === null) throw new Error('not admitted');
    return service.restore({
      installationTenantId: SEED_IDS.tenantA,
      actorAdminId: target.actor,
      archivePath: path,
      password: PASSWORD,
      directory: join(root, `apply-${randomBytes(3).toString('hex')}`),
      mode: 'NEW',
      confirmRequestId: dry.requestId,
    });
  }

  it('a crafted archive cannot exhaust a shared sequence, name a foreign owner, or overrun the disk', async () => {
    const tenantRows = async () =>
      (
        (
          await target.owner.db.execute(
            sql`SELECT count(*)::int AS n FROM tenants WHERE id = ${HOSTED_2}`,
          )
        ).rows[0] as { n: number }
      ).n;
    // A ticket numbered near the end of the shared integer sequence: refused, rolled back.
    const huge = await crafted((dir, m) => rewrite(dir, m, 'tickets', 'number', '2147483000'));
    await expect(dryThenApply(huge)).rejects.toMatchObject({
      code: TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
    });
    expect(await tenantRows()).toBe(0);
    // An owner who is not an admin of the archived tenant: refused in the dry run.
    const foreign = await crafted(async (_dir, m) => {
      m.host.ownerAdminId = target.actor;
    });
    await expect(dryThenApply(foreign)).rejects.toMatchObject({
      code: TENANT_ARCHIVE_ERROR_CODES.VERIFICATION_FAILED,
    });
    // More data than this installation opens: refused before anything is extracted.
    const small = engineFor({
      app: target.app,
      ownerUrl: urlFor(targetName),
      root,
      cipher: target.cipher,
      installationTenantId: SEED_IDS.tenantA,
      maxExtractedBytes: 16,
    });
    await expect(dryThenApply(archivePath, small)).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.BACKUP_ARCHIVE_MALFORMED,
    });
    expect(await tenantRows()).toBe(0);
  }, 600_000);

  it('a crafted archive lands HOSTED, with no expiry and no capacity limits of its own choosing', async () => {
    const forged = await crafted(async (dir, m) => {
      m.host.expiresAt = '2000-01-01T00:00:00.000Z';
      m.host.capacityLimits = [{ resource: 'UPDATE_CONCURRENCY', mode: 'UNLIMITED', value: null }];
      await rewrite(dir, m, 'tenants', 'kind', 'RESELLER_BOT');
    });
    await dryThenApply(forged);
    const tenant = (
      await target.owner.db.execute(
        sql`SELECT kind, parent_tenant_id, status FROM tenants WHERE id = ${HOSTED_2}`,
      )
    ).rows[0];
    expect(tenant).toEqual({
      kind: 'HOSTED',
      parent_tenant_id: SEED_IDS.tenantA,
      status: 'STOPPED',
    });
    const register = (
      await target.owner.db.execute(
        sql`SELECT state, expires_at FROM hosted_bots WHERE hosted_tenant_id = ${HOSTED_2}`,
      )
    ).rows[0];
    expect(register).toEqual({ state: 'SUSPENDED', expires_at: null });
    const limits = (
      await target.owner.db.execute(
        sql`SELECT count(*)::int AS n FROM tenant_capacity_limits WHERE tenant_id = ${HOSTED_2}`,
      )
    ).rows[0] as { n: number };
    expect(limits.n).toBe(0);
  }, 600_000);

  it('the schema-version policy: equal, older, newer and diverged heads', () => {
    const expected = expectedMigrations(migrationsFolder());
    const last = expected.at(-1)!;
    const head = (n: number) => {
      const m = expected[n - 1]!;
      return { count: n, lastTag: m.tag, lastHash: m.hash, lastWhen: m.when };
    };
    expect(compareArchiveHead(head(expected.length), expected)).toBe('EQUAL');
    expect(compareArchiveHead(head(expected.length - 2), expected)).toBe('OLDER');
    expect(
      compareArchiveHead({ ...head(expected.length), count: expected.length + 1 }, expected),
    ).toBe('NEWER');
    expect(
      compareArchiveHead({ ...head(expected.length), lastHash: 'f'.repeat(64) }, expected),
    ).toBe('DIVERGED');
    expect(last.tag).toMatch(/tenant_archive/);
  });

  describe('across releases', () => {
    const olderName = `nexa_tarc_older_${randomBytes(4).toString('hex')}`;
    const newerName = `nexa_tarc_newer_${randomBytes(4).toString('hex')}`;
    const olderTenant = '01900000-0000-7000-8000-0000000e0001';
    const newerTenant = '01900000-0000-7000-8000-0000000e0002';
    let newerFolder: string;

    afterAll(async () => {
      for (const name of [olderName, newerName]) {
        await admin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
      }
    });

    /** A source install at `folder`'s first `count` migrations, holding one hosted tenant. */
    async function sourceAt(name: string, tenantId: string, count: number, folder: string) {
      await admin(`CREATE DATABASE "${name}"`);
      await migrateScratchTo({
        databaseUrl: urlFor(name),
        liveDatabase: 'never-this',
        folder,
        expected: expectedMigrations(folder),
        count,
        workDirectory: await mkdtemp(join(root, 'mig-')),
      });
      const ownerHandle = createDatabase(urlFor(name), 2);
      await ensureRowLevelSecurity(ownerHandle);
      const cipher = cipherWith('source-key');
      await seed(ownerHandle.db, cipher);
      const hostedAdmin = `${tenantId.slice(0, -4)}a001`;
      const installationAdmin = `${tenantId.slice(0, -4)}a002`;
      const botId = `${tenantId.slice(0, -4)}b001`;
      const token = cipher.encrypt('123:hosted-token', {
        purpose: 'bot_instance.token',
        tenantId,
        entityId: botId,
      });
      await ownerHandle.db.execute(sql`
        INSERT INTO tenants (id, kind, parent_tenant_id, slug, display_name, status)
        VALUES (${tenantId}, 'HOSTED', ${SEED_IDS.tenantA}, ${`older-${name}`}, 'Older hosted', 'ACTIVE')`);
      await ownerHandle.db.execute(sql`
        INSERT INTO admins (id, tenant_id, username, display_name, password_hash, password_updated_at)
        VALUES (${hostedAdmin}, ${tenantId}, ${`h-${name}`}, 'Hosted owner', 'x', now()),
               (${installationAdmin}, ${SEED_IDS.tenantA}, ${`i-${name}`}, 'Installation owner', 'x', now())`);
      await ownerHandle.db.execute(sql`
        INSERT INTO bot_instances (id, tenant_id, username, status, token_ciphertext, token_key_id, telegram_bot_id)
        VALUES (${botId}, ${tenantId}, ${`bot_${name}`.slice(0, 30)}, 'ACTIVE', ${token.ciphertext}, ${token.keyId},
                ${String(7200000000 + count)})`);
      await ownerHandle.db.execute(sql`
        INSERT INTO hosted_bots (tenant_id, hosted_tenant_id, state, owner_admin_id, created_by_admin_id,
                                 created_at, state_changed_at, updated_at)
        VALUES (${SEED_IDS.tenantA}, ${tenantId}, 'ACTIVE', ${hostedAdmin}, ${installationAdmin}, now(), now(), now())`);
      const appHandle = createDatabase(urlFor(name, 'nexa_app'), 2);
      const sourceEngine = engineFor({
        app: appHandle,
        ownerUrl: urlFor(name),
        root,
        cipher,
        installationTenantId: SEED_IDS.tenantA,
        folder,
      });
      const ws = await sourceEngine.workspace(tenantId, uuidv7Like());
      const dumped = await sourceEngine.dump({
        tenantId,
        directory: ws.plainDirectory,
        archiveId: `arch-${name}`,
        createdAt: new Date(),
        password: PASSWORD,
      });
      await sourceEngine.seal({
        directory: ws.plainDirectory,
        archivePath: ws.archivePath,
        password: PASSWORD,
      });
      await appHandle.close();
      await ownerHandle.close();
      return { archive: ws.archivePath, manifest: dumped.manifest };
    }

    it('an archive from an OLDER head restores onto this head, migrated up in scratch', async () => {
      const expected = expectedMigrations(migrationsFolder());
      const older = await sourceAt(olderName, olderTenant, expected.length - 2, migrationsFolder());
      expect(older.manifest.migrations.count).toBe(expected.length - 2);
      const service = restoreService(targetEngine(), target.app);
      const dry = await service.restore({
        installationTenantId: SEED_IDS.tenantA,
        actorAdminId: target.actor,
        archivePath: older.archive,
        password: PASSWORD,
        directory: join(root, 'older-dry'),
        mode: 'NEW',
      });
      expect(dry?.summary.head).toBe('OLDER');
      const applied = await service.restore({
        installationTenantId: SEED_IDS.tenantA,
        actorAdminId: target.actor,
        archivePath: older.archive,
        password: PASSWORD,
        directory: join(root, 'older-apply'),
        mode: 'NEW',
        confirmRequestId: dry!.requestId,
      });
      expect(applied?.summary.counts['bot_instances']).toBe(1);
      const bot = (
        await target.owner.db.execute(
          sql`SELECT id, token_ciphertext, token_key_id FROM bot_instances WHERE tenant_id = ${olderTenant}`,
        )
      ).rows[0] as { id: string; token_ciphertext: string; token_key_id: string };
      expect(
        target.cipher.decrypt(
          { ciphertext: bot.token_ciphertext, keyId: bot.token_key_id },
          { purpose: 'bot_instance.token', tenantId: olderTenant, entityId: bot.id },
        ),
      ).toBe('123:hosted-token');
    }, 600_000);

    it('an archive from a NEWER head is refused: «اول نکسای مقصد را به‌روز کنید»', async () => {
      // A release one migration ahead of this one.
      newerFolder = await mkdtemp(join(root, 'newer-'));
      const real = migrationsFolder();
      await mkdir(join(newerFolder, 'meta'));
      const journal = JSON.parse(await readFile(join(real, 'meta', '_journal.json'), 'utf8')) as {
        entries: {
          idx: number;
          version: string;
          when: number;
          tag: string;
          breakpoints: boolean;
        }[];
      };
      for (const entry of journal.entries) {
        await copyFile(join(real, `${entry.tag}.sql`), join(newerFolder, `${entry.tag}.sql`));
      }
      const last = journal.entries.at(-1)!;
      journal.entries.push({
        ...last,
        idx: last.idx + 1,
        when: last.when + 1,
        tag: '9999_from_the_future',
      });
      await writeFile(join(newerFolder, '9999_from_the_future.sql'), 'SELECT 1;');
      await writeFile(join(newerFolder, 'meta', '_journal.json'), JSON.stringify(journal));
      const newer = await sourceAt(newerName, newerTenant, journal.entries.length, newerFolder);
      const service = restoreService(targetEngine(), target.app);
      await expect(
        service.restore({
          installationTenantId: SEED_IDS.tenantA,
          actorAdminId: target.actor,
          archivePath: newer.archive,
          password: PASSWORD,
          directory: join(root, 'newer-dry'),
          mode: 'NEW',
        }),
      ).rejects.toMatchObject({
        code: TENANT_ARCHIVE_ERROR_CODES.HEAD_NEWER,
        message: TENANT_ARCHIVE_HEAD_NEWER_REASON,
      });
      // Nothing of it reached the target.
      expect(
        (
          (
            await target.owner.db.execute(
              sql`SELECT count(*)::int AS n FROM tenants WHERE id = ${newerTenant}`,
            )
          ).rows[0] as { n: number }
        ).n,
      ).toBe(0);
    }, 600_000);
  });
});
