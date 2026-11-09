import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOVE_ERROR_CODES } from '@nexa/contracts';
import {
  createDatabase,
  type DatabaseHandle,
} from '../../../apps/api/src/infrastructure/persistence/database';
import { withDatabaseScope } from '../../../apps/api/src/infrastructure/persistence/database-scope';
import {
  expectedMigrations,
  migrationsFolder,
} from '../../../apps/api/src/infrastructure/persistence/migration-state';
import { ensureRowLevelSecurity } from '../../../apps/api/src/infrastructure/persistence/row-level-security';
import { SEED_IDS } from '../../../apps/api/src/infrastructure/persistence/seed';
import { TenantArchiveService } from '../../../apps/api/src/modules/platform/backup/application/tenant-archive.service';
import {
  openMoveBundle,
  type OpenedMoveBundle,
} from '../../../apps/api/src/modules/platform/backup/infrastructure/move-bundle';
import {
  clearActivationMarks,
  hostedTenantPresence,
  isFreshTarget,
  liveDatabaseBytes,
  liveTenantDigest,
  moveBundleBots,
  moveTargetBusiness,
} from '../../../apps/api/src/modules/platform/backup/infrastructure/move-queries';
import {
  exportMoveBundle,
  refuseBundleHead,
  verifyHostedMembers,
  volumeFreeBytes,
} from '../../../apps/api/src/modules/platform/backup/infrastructure/server-move';
import { PostgresTenantArchiveEngine } from '../../../apps/api/src/modules/platform/backup/infrastructure/tenant-archive-engine';
import { migrationHead } from '../../../apps/api/src/modules/platform/backup/infrastructure/tenant-archive-export';
import {
  archiveCanonicalDigests,
  openTenantArchive,
} from '../../../apps/api/src/modules/platform/backup/infrastructure/tenant-archive-restore';
import { FAST_KDF } from '../../../apps/api/src/infrastructure/crypto/kek';
import { testAppDatabaseUrl, testOwnerDatabaseUrl } from '../harness';
import { buildWorld, HOSTED_1, HOSTED_2, type World } from './fixtures';

/**
 * Phase 6B PR-4 (ADR-0039 § 8) — the server move, end to end on real databases.
 *
 * The world is the isolation proof's: the installation and two full HOSTED tenants. `move
 * export` takes a VERIFIED installation backup and a VERIFIED archive of each hosted bot, all
 * sealed with ONE bundle password, as `nexa_app` with row-level security on. The bundle is
 * opened on a FRESH database: the installation member restored there must read back every
 * table with the source's counts and checksums, and each hosted member must match its tenant
 * in that restored installation by counts and canonical SHA-256 — while a single changed row
 * of one hosted tenant stops it, naming the tenant and the table.
 */

const PASSWORD = 'move-bundle-password-2026';
const INSTALLATION = SEED_IDS.tenantA;
/** Rows the export itself writes on the source (its own runs, tickets and events). */
const BOOKKEEPING = new Set([
  'backup_runs',
  'backup_run_parts',
  'heavy_job_tickets',
  'operational_events',
  'operational_conditions',
  'outbox_messages',
  'aggregate_sequences',
  'process_runs',
]);

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

/** `count:md5` of every public table, over the whole row text, in a fixed order. */
async function snapshot(handle: DatabaseHandle): Promise<Map<string, string>> {
  const tables = (
    await handle.db.execute(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    )
  ).rows as { tablename: string }[];
  const out = new Map<string, string>();
  for (const { tablename } of tables) {
    const rows = (
      await handle.db.execute(
        sql.raw(
          `SELECT count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '-') AS v FROM "${tablename}" t`,
        ),
      )
    ).rows as { v: string }[];
    out.set(tablename, rows[0]?.v ?? '');
  }
  return out;
}

describe('server move (Phase 6B PR-4) — export two hosted bots and the installation, import fresh', () => {
  let world: World;
  let app: DatabaseHandle;
  let owner: DatabaseHandle;
  let workRoot: string;
  let scratch: string;
  let bundle: OpenedMoveBundle;
  let before: Map<string, string>;
  let after: Map<string, string>;
  const targetName = `nexa_move_target_${randomBytes(4).toString('hex')}`;
  let target: { owner: DatabaseHandle; app: DatabaseHandle } | undefined;

  beforeAll(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'nexa-move-work-'));
    scratch = await mkdtemp(join(tmpdir(), 'nexa-move-'));
    world = await buildWorld({
      BACKUP_WORK_DIR: workRoot,
      RECOVERY_WORK_DIR: join(workRoot, 'recovery'),
    });
    app = createDatabase(testAppDatabaseUrl(), 4);
    owner = createDatabase(testOwnerDatabaseUrl(), 2);
    expect(await app.scopeEnforcement()).toBe('enforcing');
  }, 600_000);

  afterAll(async () => {
    await target?.app.close();
    await target?.owner.close();
    await app?.close();
    await owner?.close();
    await world?.close();
    await admin(`DROP DATABASE IF EXISTS "${targetName}" WITH (FORCE)`).catch(() => undefined);
    if (workRoot !== undefined) await rm(workRoot, { recursive: true, force: true });
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  });

  it('exports a bundle of three VERIFIED members sealed with one password', async () => {
    const container = world.api.container;
    const sevenZip = {
      binary: container.config.BACKUP_SEVEN_ZIP_BIN,
      level: 1,
      threads: 2,
      memoryBudgetMb: 1_000,
      memoryHeadroomMb: 0,
      readAvailableMb: async () => null,
      lowPriorityPrefix: [] as string[],
      sealTimeoutMs: 300_000,
      openTimeoutMs: 300_000,
    };
    const engine = new PostgresTenantArchiveEngine({
      app,
      scratch: container.backupTools,
      sevenZip,
      root: workRoot,
      cipher: container.cipher,
      kdf: FAST_KDF,
      installationTenantId: () => INSTALLATION,
      installationId: () => INSTALLATION,
      release: 'test',
      migrationsFolder: migrationsFolder(),
      now: () => new Date(),
    });
    const archives = new TenantArchiveService({
      runs: container.backupRuns,
      engine,
      heavyJobs: container.heavyJobs,
      clock: container.clock,
      ids: container.ids,
      leaseOwner: 'server-move-test',
      queue: {
        pollMs: 200,
        maxWaitMs: 60_000,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      logger: { info: () => undefined, error: () => undefined },
    });
    const queue = {
      pollMs: 200,
      maxWaitMs: 60_000,
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    };

    before = await snapshot(owner);
    const result = await exportMoveBundle(
      {
        installationTenantId: INSTALLATION,
        installationId: INSTALLATION,
        release: 'test',
        image: null,
        migrations: await withDatabaseScope(
          { tenantId: INSTALLATION as never, botInstanceId: null },
          () => migrationHead(app.db, migrationsFolder()),
        ),
        now: () => new Date(),
        sevenZip,
        environment: { BACKUP_TELEGRAM_BOT_TOKEN: 'never-in-the-bundle' },
        ownerDomains: ['owner.example.test'],
        cnameTarget: 'owner.example.test',
        serverIps: [],
        databaseBytes: () => liveDatabaseBytes(app),
        freeBytes: volumeFreeBytes,
        bots: () => moveBundleBots(app, INSTALLATION),
        backupInstallation: async (sealPassword) => {
          const queued = await container.heavyJobs.runWhenAdmitted(
            'BACKUP',
            INSTALLATION,
            () => container.backup.run('MOVE', { deliver: false, sealPassword }),
            queue,
          );
          if (!queued.ran || queued.result.kind !== 'COMPLETED') return null;
          const run = queued.result.run;
          return { run, archivePath: join(workRoot, run.id, 'archive.7z') };
        },
        archiveHosted: async (tenantId, sealPassword) => {
          const outcome = await archives.run({ tenantId, trigger: 'MOVE', password: sealPassword });
          if (outcome.kind !== 'COMPLETED') return null;
          return {
            run: outcome.run,
            archivePath: join(workRoot, 'hosted', tenantId, outcome.run.id, 'archive.7z'),
          };
        },
        progress: () => undefined,
      },
      { password: PASSWORD, workDirectory: join(scratch, 'work') },
    );
    after = await snapshot(owner);

    expect(result.manifest.members.map((member) => [member.kind, member.tenantId])).toEqual([
      ['INSTALLATION', INSTALLATION],
      ['HOSTED', HOSTED_1],
      ['HOSTED', HOSTED_2],
    ]);
    const hostedBots = result.manifest.bots.filter((bot) => bot.kind === 'HOSTED');
    expect(hostedBots.map((bot) => bot.username)).toEqual(['hosted_one_bot', 'hosted_two_bot']);
    expect(JSON.stringify(result.manifest)).not.toContain('never-in-the-bundle');
    // Every member run is a MOVE run that VERIFIED and was never delivered.
    const runs = (
      await owner.db.execute(
        sql`SELECT trigger, state, verified_at IS NOT NULL AS verified, delivery_state
              FROM backup_runs WHERE trigger = 'MOVE' ORDER BY started_at`,
      )
    ).rows as { trigger: string; state: string; verified: boolean; delivery_state: string }[];
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      expect(run).toMatchObject({
        state: 'SUCCEEDED',
        verified: true,
        delivery_state: 'NOT_ATTEMPTED',
      });
    }

    bundle = await openMoveBundle({
      bundlePath: result.bundlePath,
      password: PASSWORD,
      directory: join(scratch, 'open'),
      sevenZip,
      freeBytes: async () => null,
    });
    expect(refuseBundleHead(bundle.manifest, expectedMigrations(migrationsFolder()))).toBe('EQUAL');
  }, 900_000);

  it('restores the installation on a fresh database with identical counts and checksums', async () => {
    const container = world.api.container;
    const member = bundle.manifest.members.find((candidate) => candidate.kind === 'INSTALLATION');
    expect(member).toBeDefined();
    const dumpPath = join(scratch, 'installation.pgcustom');
    // The SAME open every restore uses, with the bundle password alone.
    const opened = await container.backupArchiver.open({
      archivePath: bundle.memberPath(member!),
      dumpPath,
      passwords: [PASSWORD],
    });
    expect(opened.dumpChecksum).toBe(opened.manifest.checksum);
    await container.backupTools.createDatabase(targetName);
    await container.backupTools.restoreIntoEmpty(targetName, dumpPath);
    const targetOwner = createDatabase(urlFor(targetName), 2);
    await ensureRowLevelSecurity(targetOwner);
    target = { owner: targetOwner, app: createDatabase(urlFor(targetName, 'nexa_app'), 4) };

    const restored = await snapshot(targetOwner);
    // The export's own bookkeeping changes the source while it runs; nothing else may.
    const churn = [...before.keys()].filter((table) => before.get(table) !== after.get(table));
    expect(churn.filter((table) => !BOOKKEEPING.has(table))).toEqual([]);
    const compared = [...before.keys()].filter((table) => !BOOKKEEPING.has(table));
    expect(compared.length).toBeGreaterThan(100);
    for (const table of compared) expect(restored.get(table), table).toBe(before.get(table));
    // Not a fresh target any more: move import would refuse to merge into it.
    expect(isFreshTarget(await moveTargetBusiness(target.app))).toBe(false);
  }, 600_000);

  it('verifies both hosted bots against the restored installation by counts and canonical SHA-256', async () => {
    const container = world.api.container;
    const db = target!.app;
    const verify = () =>
      verifyHostedMembers(
        {
          installationTenantId: INSTALLATION,
          presence: (tenantId) => hostedTenantPresence(db, INSTALLATION, tenantId),
          openMember: async (member, fn) => {
            const directory = join(scratch, 'verify', member.tenantId);
            await mkdir(directory, { recursive: true });
            try {
              const opened = await openTenantArchive({
                archivePath: bundle.memberPath(member),
                password: PASSWORD,
                directory,
                sevenZip: {
                  binary: container.config.BACKUP_SEVEN_ZIP_BIN,
                  level: 1,
                  threads: 2,
                  memoryBudgetMb: 1_000,
                  memoryHeadroomMb: 0,
                  readAvailableMb: async () => null,
                  lowPriorityPrefix: [],
                  sealTimeoutMs: 300_000,
                  openTimeoutMs: 300_000,
                },
                limits: {
                  maxExtractedBytes: 1024 ** 3,
                  headroomBytes: 0,
                  freeBytes: async () => null,
                },
              });
              try {
                return await fn(opened.manifest, await archiveCanonicalDigests(opened));
              } finally {
                opened.keyMaterial.fill(0);
              }
            } finally {
              await rm(directory, { recursive: true, force: true });
            }
          },
          live: (tenantId, manifest) => liveTenantDigest(db, tenantId, manifest, container.cipher),
          progress: () => undefined,
        },
        bundle,
      );

    const verified = await verify();
    expect(verified.missing).toEqual([]);
    expect(verified.verified.map((entry) => entry.tenantId)).toEqual([HOSTED_1, HOSTED_2]);
    for (const entry of verified.verified) expect(entry.tables).toBeGreaterThan(10);

    // One changed row of ONE hosted tenant stops it, naming that tenant and table.
    await target!.owner.db.execute(
      sql`UPDATE customers SET last_name = 'Changed' WHERE tenant_id = ${HOSTED_2}`,
    );
    await expect(verify()).rejects.toMatchObject({
      code: MOVE_ERROR_CODES.HOSTED_MISMATCH,
      details: { tenantId: HOSTED_2, table: 'customers' },
    });
  }, 600_000);

  it('clears the activation marks earned on the old server, in the installation scope', async () => {
    const db = target!.app;
    await target!.owner.db.execute(sql`
      INSERT INTO hosted_bot_activations (tenant_id, hosted_tenant_id, domain, token_verified_at,
                                          dns_verified_at, tls_verified_at,
                                          webhook_registered_at, created_at, updated_at)
      VALUES (${INSTALLATION}, ${HOSTED_1}, 'one.example.test', now(), now(), now(), now(),
              now(), now())
      ON CONFLICT DO NOTHING`);
    const cleared = await withDatabaseScope(
      { tenantId: INSTALLATION as never, botInstanceId: null },
      () => db.db.transaction((tx) => clearActivationMarks(tx, INSTALLATION, new Date())),
    );
    expect(cleared).toBe(1);
    const left = (
      await target!.owner.db.execute(
        sql`SELECT count(*)::int AS n FROM hosted_bot_activations
             WHERE dns_verified_at IS NOT NULL OR tls_verified_at IS NOT NULL
                OR webhook_registered_at IS NOT NULL`,
      )
    ).rows as { n: number }[];
    expect(left[0]?.n).toBe(0);
  });

  it('confirms the installation member for the executor as MOVE, with no administrator', async () => {
    const container = world.api.container;
    const member = bundle.manifest.members.find((candidate) => candidate.kind === 'INSTALLATION');
    const outcome = await container.recoveryService.requestMove({
      archivePath: bundle.memberPath(member!),
      password: PASSWORD,
    });
    expect(outcome.failureCode).toBeNull();
    const row = (
      await owner.db.execute(
        sql`SELECT source, state, confirmed_by_admin_id, confirmed_checksum = artifact_checksum AS bound,
                   confirmation_expires_at > now() AS live, restore_test->>'cutoverPermitted' AS permitted
              FROM recovery_requests WHERE id = ${outcome.request.id}`,
      )
    ).rows as Record<string, unknown>[];
    expect(row[0]).toMatchObject({
      source: 'MOVE',
      state: 'RESTORE_REQUESTED',
      confirmed_by_admin_id: null,
      bound: true,
      live: true,
      permitted: 'true',
    });
    // A wrong password never reaches a confirmation.
    const refused = await container.recoveryService.requestMove({
      archivePath: bundle.memberPath(member!),
      password: 'not-the-bundle-password',
    });
    expect(refused.failureCode).toBe('recovery.archive_auth_failed');
    // The executor is not running here: the request is closed so it holds nothing.
    await owner.db.execute(
      sql`UPDATE recovery_requests SET state = 'FAILED', stage = 'CLEANUP', finished_at = now(),
                 failure_code = 'recovery.internal' WHERE id = ${outcome.request.id}`,
    );
  }, 600_000);

  it('keeps a confirmation all-or-nothing, and an administrator only off MOVE', async () => {
    const insert = (source: string, admin: string | null) =>
      owner.db.execute(sql`
        INSERT INTO recovery_requests (id, tenant_id, source, state, stage, created_at, updated_at,
                                       finished_at, confirmed_at, confirmed_by_admin_id,
                                       confirmed_checksum, confirmation_expires_at)
        VALUES (${world.api.container.ids.uuid()}, ${INSTALLATION}, ${source}, 'FAILED', 'CLEANUP',
                now(), now(), now(), now(), ${admin}, ${'a'.repeat(64)}, now())`);
    const someAdmin = world.tenants.PRIMARY.owner.id;
    await expect(insert('MOVE', null)).resolves.toBeDefined();
    await expect(insert('MOVE', someAdmin)).rejects.toThrow();
    await expect(insert('UPLOAD', null)).rejects.toThrow();
    await expect(insert('UPLOAD', someAdmin)).resolves.toBeDefined();
  });
});
