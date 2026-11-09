import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  recoveryAcknowledgeUnreadableRequestSchema,
  type ActorContext,
  type SecretPurpose,
} from '@nexa/contracts';
import { type Container } from '../../apps/api/src/container';
import { runMigrations } from '../../apps/api/src/infrastructure/persistence/migrate';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { AesGcmSecretCipher } from '../../apps/api/src/infrastructure/crypto/secret-cipher';
import {
  trialDecryptSecrets,
  type SecretRowQueryable,
} from '../../apps/api/src/infrastructure/crypto/secret-trial';
import { createTestContainer, adminActorFor, createAdmin, tenantA, testConfig } from './harness';

/**
 * NEXA-FIX-RESTORE-SECRETS §2.3, what follows a refusal, end to end on real installations,
 * real backups, the real restore test and the real executor's cut-over:
 *
 * - a re-test of the SAME request (refused again while nothing changed);
 * - «ادامه؛ این‌ها را دوباره وارد می‌کنم»: acknowledge the exact list; the executor clears
 *   those values in the candidate; the attention list shows them until re-entered.
 *
 * The Recovery Kit import that was the other choice is removed (SFR A1). Old archives only
 * (no bundled keys): a self-contained one never needs either.
 */

const SAME_ID = 'install-20261107';
const OWNER_PASSWORD = 'the-owners-real-password';
const BACKUP_PASSWORD = 'the backup password A used';

describe('after a restore refused for unreadable secrets', () => {
  let created: string[];
  const roots: string[] = [];
  const containers: Container[] = [];

  const urlOf = (database: string): string => {
    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = `/${database}`;
    return url.toString();
  };

  async function maintenance(sql: string): Promise<void> {
    const base = new URL(testConfig().DATABASE_URL);
    base.pathname = '/postgres';
    const client = new Client({ connectionString: base.toString() });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  async function withDb<T>(database: string, fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: urlOf(database) });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function installation(keyId: string, material: Buffer) {
    const database = `nexa_rsre_${randomBytes(6).toString('hex')}`;
    created.push(database);
    await maintenance(`CREATE DATABASE "${database}"`);
    await runMigrations(urlOf(database));
    const workRoot = await mkdtemp(join(tmpdir(), 'nexa-rsre-backups-'));
    const recoveryRoot = await mkdtemp(join(tmpdir(), 'nexa-rsre-recovery-'));
    roots.push(workRoot, recoveryRoot);
    const container = createTestContainer(
      testConfig({
        DATABASE_URL: urlOf(database),
        BACKUP_WORK_DIR: workRoot,
        RECOVERY_WORK_DIR: recoveryRoot,
        SECRETS_KEYS: `${keyId}:${material.toString('base64')}`,
        SECRETS_ACTIVE_KEY_ID: keyId,
      }),
      'recovery',
    );
    containers.push(container);
    await seed(container.database.db, container.cipher);
    container.setInstallationTenant(tenantA.tenantId);
    const owner: ActorContext = adminActorFor(
      await createAdmin(container, tenantA, {
        username: `owner-${randomBytes(3).toString('hex')}`,
        password: OWNER_PASSWORD,
        roleKeys: ['owner'],
      }),
    );
    return { container, database, workRoot, owner, keyId, material };
  }
  type Install = Awaited<ReturnType<typeof installation>>;

  async function setBackupPassword(install: Install, actor: ActorContext = install.owner) {
    await install.container.backupPasswords.set(
      tenantA,
      actor,
      {
        idempotencyKey: `set-${randomBytes(6).toString('hex')}`,
        password: BACKUP_PASSWORD,
        stepUp: { password: OWNER_PASSWORD },
      },
      { ip: null },
    );
  }

  /** A panel with a username and a password: two more purposes for the list. */
  async function addPanel(install: Install): Promise<string> {
    const name = `Panel-${randomBytes(3).toString('hex')}`;
    const panel = await install.container.panels.create(tenantA, install.owner, {
      name,
      providerType: 'marzban',
      baseUrl: `https://${name.toLowerCase()}.example.test`,
      idempotencyKey: `panel-${randomBytes(6).toString('hex')}`,
    });
    const id = panel.view.panel.id;
    await install.container.panels.setCredentials(tenantA, install.owner, id, {
      credentials: { username: 'admin', password: 'panel-password' },
      idempotencyKey: `creds-${randomBytes(6).toString('hex')}`,
    });
    return id;
  }

  /** An OLD archive: a 7z with no key bundle. */
  async function oldBackupOf(install: Install): Promise<string> {
    (install.container.backupArchiver as unknown as { keyBundle?: unknown }).keyBundle = undefined;
    const outcome = await install.container.backup.run('MANUAL');
    if (outcome.kind !== 'COMPLETED') throw new Error(`backup did not complete: ${outcome.kind}`);
    return join(install.workRoot, outcome.run.id, 'archive.7z');
  }

  async function upload(install: Install, archivePath: string) {
    const begun = await install.container.recoveryService.beginUpload(tenantA, install.owner, {
      clientFilename: 'old-server.7z',
    });
    await copyFile(archivePath, begun.workspace.archivePath);
    const { size } = await stat(begun.workspace.archivePath);
    await install.container.recoveryService.completeUpload(tenantA, begun.request.id, {
      sizeBytes: size,
      archiveSha256: 'a'.repeat(64),
    });
    return install.container.recoveryService.verifyAndTest(
      tenantA,
      install.owner,
      begun.request.id,
      {
        archivePassword: BACKUP_PASSWORD,
      },
    );
  }

  async function confirmAndExecute(
    install: Install,
    request: { id: string; artifactChecksum: string | null },
  ) {
    await install.container.recoveryService.confirm(tenantA, install.owner, request.id, {
      phrase: 'RESTORE NEXA',
      artifactChecksum: request.artifactChecksum ?? '',
    });
    await install.container.recoveryExecutor.tick();
    const row = await install.container.recoveryRequests.byIdUnscoped(request.id);
    created.push(row?.displacedDatabase ?? '');
    return row;
  }

  function onlyKey(keyId: string, material: Buffer): AesGcmSecretCipher {
    return new AesGcmSecretCipher(
      { activeKeyId: keyId, format: 'canonical', keys: new Map([[keyId, material]]) },
      false,
    );
  }

  async function trialWithOnly(database: string, keyId: string, material: Buffer) {
    return withDb(database, (client) =>
      trialDecryptSecrets(client as unknown as SecretRowQueryable, onlyKey(keyId, material)),
    );
  }

  /** A → old archive, refused on B (same key id, other bytes). */
  async function refusedOnB() {
    const keyA = randomBytes(32);
    const a = await installation(SAME_ID, keyA);
    await setBackupPassword(a);
    const panelId = await addPanel(a);
    const archivePath = await oldBackupOf(a);
    const ownerA = a.owner;
    await a.container.shutdown();
    containers.splice(containers.indexOf(a.container), 1);

    const keyB = randomBytes(32);
    const b = await installation(SAME_ID, keyB);
    const refused = await upload(b, archivePath);
    expect(refused.failureCode).toBe('recovery.candidate_secrets_unreadable');
    expect(refused.request.state).toBe('FAILED');
    return { b, keyA, keyB, panelId, ownerA, refused: refused.request };
  }

  beforeEach(() => {
    created = [];
  });

  afterEach(async () => {
    for (const container of containers.splice(0)) await container.shutdown().catch(() => undefined);
    for (const name of new Set(created.filter((name) => name !== ''))) {
      await maintenance(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    }
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('refuses a list that is not exactly the one found; with the exact list the values are cleared, listed, and leave the list when re-entered', async () => {
    const { b, keyB, panelId, ownerA, refused } = await refusedOnB();
    const recorded = refused.restoreTest?.unreadableSecrets ?? [];
    // The seed makes three bots; each token is sealed under A's key.
    const bots = await withDb(b.database, async (client) =>
      Number((await client.query('SELECT count(*)::int AS n FROM bot_instances')).rows[0].n),
    );
    const expected: { purpose: SecretPurpose; count: number }[] = [
      { purpose: 'bot_instance.token', count: bots },
      { purpose: 'panel.username', count: 1 },
      { purpose: 'panel.password', count: 1 },
      { purpose: 'backup.archive_password', count: 1 },
    ];
    expect([...recorded].sort((x, y) => x.purpose.localeCompare(y.purpose))).toEqual(
      [...expected].sort((x, y) => x.purpose.localeCompare(y.purpose)),
    );
    const ack = (unreadable: { purpose: SecretPurpose; count: number }[], key: string) =>
      b.container.recoveryService.acknowledgeUnreadable(tenantA, b.owner, refused.id, {
        idempotencyKey: key,
        unreadable,
      });

    // A wrong count, a missing purpose, an extra purpose: each refused, nothing moved.
    await expect(
      ack(
        expected.map((e) => (e.purpose === 'panel.password' ? { ...e, count: 2 } : e)),
        'ack-wrong-count',
      ),
    ).rejects.toMatchObject({ code: 'recovery.confirmation_invalid' });
    await expect(ack(expected.slice(1), 'ack-missing')).rejects.toMatchObject({
      code: 'recovery.confirmation_invalid',
    });
    await expect(
      ack([...expected, { purpose: 'gift_card.batch_export', count: 1 }], 'ack-extra'),
    ).rejects.toMatchObject({ code: 'recovery.confirmation_invalid' });
    // The same total split across a duplicated purpose: refused by the schema AND the service.
    const split = [
      ...expected.filter((e) => e.purpose !== 'bot_instance.token'),
      { purpose: 'panel.username' as const, count: 1 },
    ];
    expect(
      recoveryAcknowledgeUnreadableRequestSchema.safeParse({
        idempotencyKey: 'ack-split-1',
        unreadable: split,
      }).success,
    ).toBe(false);
    await expect(ack(split, 'ack-split-2')).rejects.toMatchObject({
      code: 'recovery.confirmation_invalid',
    });
    expect((await b.container.recoveryRequests.byIdUnscoped(refused.id))?.state).toBe('FAILED');

    // The exact list, in another order: accepted, and a replay of the key is the same answer.
    const reversed = [...expected].reverse();
    const passed = await ack(reversed, 'ack-exact-1');
    expect(passed.state).toBe('RESTORE_TEST_PASSED');
    expect(passed.restoreTest).toMatchObject({ clearUnreadable: true, cutoverPermitted: true });
    expect((await ack(reversed, 'ack-exact-1')).state).toBe('RESTORE_TEST_PASSED');

    const row = await confirmAndExecute(b, passed);
    expect(row?.failureCode ?? null).toBeNull();
    expect(row?.state).toBe('SUCCEEDED');
    expect(row?.restoreTest?.secretsCleared).toBe(bots + 3);

    // What is served: the cleared values read as NOT SET — no failed authentication
    // anywhere except the token the stopped bot keeps until it is replaced.
    const live = await trialWithOnly(b.database, SAME_ID, keyB);
    expect(new Set(live.unreadable.map((u) => u.purpose))).toEqual(new Set(['bot_instance.token']));
    const state = await withDb(b.database, async (client) => ({
      bots: (await client.query<{ status: string }>('SELECT status FROM bot_instances')).rows,
      panel: (
        await client.query(
          'SELECT username_ciphertext, password_ciphertext FROM panel_credentials WHERE panel_id = $1',
          [panelId],
        )
      ).rows[0],
      passwords: Number(
        (await client.query('SELECT count(*)::int AS n FROM backup_archive_passwords')).rows[0].n,
      ),
      items: (
        await client.query<{ purpose: string; entity_table: string }>(
          'SELECT purpose, entity_table FROM secret_reentry_items ORDER BY purpose',
        )
      ).rows,
    }));
    expect(state.bots.every((bot) => bot.status !== 'ACTIVE')).toBe(true);
    // The strip is TENANT-scoped: only tenant A's bots are on A's list.
    const botsOfA = await withDb(b.database, async (client) =>
      Number(
        (
          await client.query('SELECT count(*)::int AS n FROM bot_instances WHERE tenant_id = $1', [
            tenantA.tenantId,
          ])
        ).rows[0].n,
      ),
    );
    expect(botsOfA).toBeLessThan(bots);
    expect(state.panel).toEqual({ username_ciphertext: null, password_ciphertext: null });
    expect(state.passwords).toBe(0);
    expect(state.items).toEqual([
      { purpose: 'backup.archive_password', entity_table: 'backup_archive_passwords' },
      ...Array.from({ length: bots }, () => ({
        purpose: 'bot_instance.token',
        entity_table: 'bot_instances',
      })),
      { purpose: 'panel.password', entity_table: 'panels' },
      { purpose: 'panel.username', entity_table: 'panels' },
    ]);

    // The attention list (as the restored installation's owner) lists all four.
    const listed = await b.container.secretReentry.list(tenantA, ownerA);
    expect(listed.map((item) => [item.purpose, item.reenterAt]).sort()).toEqual(
      [
        ['backup.archive_password', 'recovery'],
        ...Array.from({ length: botsOfA }, () => ['bot_instance.token', 'bots']),
        ['panel.password', 'panels'],
        ['panel.username', 'panels'],
      ].sort(),
    );
    expect(listed.find((item) => item.purpose === 'panel.username')?.entityId).toBe(panelId);
    expect(JSON.stringify(listed)).not.toContain('ciphertext');

    // Re-entering through the ordinary write paths removes exactly those items.
    await setBackupPassword(b, ownerA);
    await b.container.panels.setCredentials(tenantA, ownerA, panelId, {
      credentials: { username: 'admin-again' },
      idempotencyKey: `creds-${randomBytes(6).toString('hex')}`,
    });
    const after = await b.container.secretReentry.list(tenantA, ownerA);
    expect(after.map((item) => item.purpose).sort()).toEqual([
      ...Array.from({ length: botsOfA }, () => 'bot_instance.token'),
      'panel.password',
    ]);
  }, 300_000);

  it('re-tests the SAME request: refused again while nothing changed, the upload kept, no kit offered', async () => {
    const { b, refused } = await refusedOnB();
    expect(refused.restoreTest).not.toHaveProperty('canUploadKit');
    const again = await b.container.recoveryService.retest(tenantA, b.owner, refused.id, {
      idempotencyKey: 'retest-1',
    });
    expect(again.failureCode).toBe('recovery.candidate_secrets_unreadable');
    expect(again.request.id).toBe(refused.id);
    expect(again.request.candidateDatabase ?? null).toBeNull();
  }, 300_000);

  it('refuses a re-test or an acknowledgment of a request that did not fail for unreadable secrets', async () => {
    const b = await installation('kek-b', randomBytes(32));
    const begun = await b.container.recoveryService.beginUpload(tenantA, b.owner, {
      clientFilename: 'x.nxb',
    });
    await b.container.recoveryService.failUpload(
      tenantA,
      begun.request.id,
      'recovery.upload_rejected',
    );
    await expect(
      b.container.recoveryService.retest(tenantA, b.owner, begun.request.id, {
        idempotencyKey: 'retest-wrong-failure',
      }),
    ).rejects.toMatchObject({ code: 'recovery.confirmation_invalid' });
    // The repository's own guard: leaving FAILED names the failure code (and a kept upload).
    expect(
      await b.container.recoveryRequests.transition({
        id: begun.request.id,
        from: ['FAILED'],
        to: 'UPLOADED',
        now: new Date(),
        failedWith: 'recovery.candidate_secrets_unreadable',
      }),
    ).toBe(false);
    await expect(
      b.container.recoveryService.acknowledgeUnreadable(tenantA, b.owner, begun.request.id, {
        idempotencyKey: 'ack-wrong-failure',
        unreadable: [{ purpose: 'bot_instance.token', count: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'recovery.confirmation_invalid' });
  }, 300_000);

  it('the attention list is denied by default to an administrator without backup.view', async () => {
    const b = await installation('kek-b', randomBytes(32));
    const nobody = adminActorFor(
      await createAdmin(b.container, tenantA, {
        username: `nobody-${randomBytes(3).toString('hex')}`,
      }),
    );
    await expect(b.container.secretReentry.list(tenantA, nobody)).rejects.toMatchObject({
      kind: 'PERMISSION_DENIED',
    });
    expect(await b.container.secretReentry.list(tenantA, b.owner)).toEqual([]);
  }, 300_000);

  it('clears only the named rows of the database it is pointed at — never the live one, never another tenant’s', async () => {
    const b = await installation('kek-b', randomBytes(32));
    const other = await installation('kek-other', randomBytes(32));
    const bot = await withDb(
      other.database,
      async (client) =>
        (
          await client.query<{ id: string; tenant_id: string }>(
            'SELECT id::text AS id, tenant_id::text AS tenant_id FROM bot_instances LIMIT 1',
          )
        ).rows[0],
    );
    if (bot === undefined) throw new Error('the seed made no bot');
    const named = {
      purpose: 'bot_instance.token' as const,
      table: 'bot_instances',
      column: 'token_ciphertext',
      entityId: bot.id,
    };
    // The right id under another tenant clears nothing.
    const foreign = await b.container.recoveryKeyCoverage.clearUnreadable(other.database, {
      unreadable: [{ ...named, tenantId: '00000000-0000-7000-8000-000000000999' }],
      recoveryId: '01900000-0000-7000-8000-000000000001',
      now: new Date(),
      newId: () => b.container.ids.uuid(),
    });
    expect(foreign).toMatchObject({ cleared: 0, items: 0, kept: [] });
    const status = async () =>
      withDb(
        other.database,
        async (client) =>
          (
            await client.query<{ status: string }>(
              'SELECT status FROM bot_instances WHERE id = $1',
              [bot.id],
            )
          ).rows[0]?.status,
      );
    expect(await status()).toBe('ACTIVE');
    // The live database is refused by name, before a connection is opened.
    await expect(
      b.container.recoveryKeyCoverage.clearUnreadable(b.database, {
        unreadable: [{ ...named, tenantId: bot.tenant_id }],
        recoveryId: '01900000-0000-7000-8000-000000000001',
        now: new Date(),
        newId: () => b.container.ids.uuid(),
      }),
    ).rejects.toThrow();
    // The named row of the database it IS pointed at: stopped.
    await b.container.recoveryKeyCoverage.clearUnreadable(other.database, {
      unreadable: [{ ...named, tenantId: bot.tenant_id }],
      recoveryId: '01900000-0000-7000-8000-000000000001',
      now: new Date(),
      newId: () => b.container.ids.uuid(),
    });
    expect(await status()).toBe('STOPPED');
  }, 300_000);
});
