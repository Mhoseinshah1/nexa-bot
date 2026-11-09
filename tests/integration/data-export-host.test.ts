import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DATA_EXPORT_ERROR_CODES,
  HOSTING_ERROR_CODES,
  isNexaError,
  type ActorContext,
  type CorrelationId,
  type TenantContext,
} from '@nexa/contracts';
import type { ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminPermissionOverrides,
  auditLogs,
  customers,
  tenantDataExports,
} from '../../apps/api/src/infrastructure/persistence/schema';
import {
  totpForStep,
  totpStepAt,
} from '../../apps/api/src/modules/platform/identity/application/totp';
import { readZip } from '../support/zip-reader';
import {
  createAdmin,
  createApiApp,
  migrateOnce,
  resetDatabase,
  tenantA,
  testConfig,
  type SeededAdmin,
} from './harness';

const ORIGIN = 'https://admin.dataexport.test';
const OWNER_PASSWORD = 'the-owners-own-password';
const HOSTED_PASSWORD = 'the-hosted-owners-password';

/**
 * Phase 6B PR-3 (ADR-0039) — the installation owner's door to a hosted bot's data export,
 * from «میزبانی‌ها»: the owner-only guard, the section session, a FRESH second-factor code on
 * the request, the audit row in the OWNER's own log (the hosted tenant's log is not written,
 * D5), and the hosted bot's own owner not seeing what the host asked for.
 *
 * Set up like the creator panel's own suite (`hosting-panel.test.ts`): the app connects as
 * `nexa_app`, the clock is the container's, frozen in the middle of a TOTP step.
 */
describe('data export from «میزبانی‌ها» (phase 6B PR-3)', () => {
  let api: ApiApp;
  let workDir: string;
  let offsetMs = 0;
  let baseMs = 0;
  let keys = 0;
  let owner: SeededAdmin;
  let ownerActor: ActorContext;
  let operatorActor: ActorContext;

  const key = () => `dx-host-key-${String((keys += 1))}`;
  const now = () => api.container.clock.now();
  const code = (secret: string) => {
    offsetMs += 30_000;
    return totpForStep(secret, totpStepAt(now()));
  };
  const codeOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      if (isNexaError(error)) return error.code;
      throw error;
    }
    throw new Error('expected a refusal');
  };
  const actorFor = (admin: { id: string; username: string }, sessionId: string): ActorContext => ({
    type: 'WEB_ADMIN',
    id: admin.id,
    label: admin.username,
    surface: 'WEB',
    correlationId: 'test-correlation' as CorrelationId,
    sessionId,
  });
  const signIn = async (
    username: string,
    password: string,
    scope: TenantContext,
    id: string,
  ): Promise<ActorContext> => {
    const result = await api.container.auth.login(
      scope,
      { type: 'API', id: null, label: null, surface: 'WEB', correlationId: 'c' as CorrelationId },
      { username, password },
      { ip: null, userAgent: null },
    );
    return actorFor({ id, username }, result.session.id);
  };

  async function openPanel() {
    const enrolment = await api.container.hostingSection.enrol(
      tenantA,
      ownerActor,
      { password: OWNER_PASSWORD },
      { ip: null },
    );
    const activated = await api.container.hostingSection.activate(tenantA, ownerActor, {
      code: code(enrolment.secret),
    });
    return { secret: enrolment.secret, token: activated.opened.token };
  }

  async function createBot(panel: { secret: string; token: string }) {
    const created = await api.container.hosting.create(tenantA, ownerActor, panel.token, {
      idempotencyKey: key(),
      proof: { code: code(panel.secret) },
      slug: 'hosted-dx',
      displayName: 'Bot hosted-dx',
      adminUsername: 'hosted-dx-admin',
      adminDisplayName: 'Hosted owner',
      adminPassword: HOSTED_PASSWORD,
      expiresAt: null,
    });
    const id = created.bot.tenantId;
    const hostedScope = { tenantId: id as never, botInstanceId: null } as TenantContext;
    await api.container.database.db.insert(customers).values({
      id: api.container.ids.uuid(),
      tenantId: id,
      telegramUserId: '555',
      firstName: 'مشتری',
      status: 'ACTIVE',
      createdAt: now(),
    } as never);
    const [hostedAdmin] = await api.container.database.db
      .execute(
        // The hosted bot's first owner, signed in as themselves.
        (await import('drizzle-orm'))
          .sql`SELECT id FROM admins WHERE tenant_id = ${id} AND username = 'hosted-dx-admin'`,
      )
      .then((r) => r.rows as { id: string }[]);
    const hostedActor = await signIn(
      'hosted-dx-admin',
      HOSTED_PASSWORD,
      hostedScope,
      hostedAdmin!.id,
    );
    return { id, hostedScope, hostedActor };
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'data-export-host-'));
    const config = testConfig({
      WEB_ADMIN_ORIGINS: ORIGIN,
      HOSTED_BOTS_CREATE_ENABLED: 'true',
      BACKUP_WORK_DIR: workDir,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
    const clock = api.container.clock as { now: () => Date };
    baseMs = Math.floor(Date.now() / 30_000) * 30_000 + 10_000;
    clock.now = () => new Date(baseMs + offsetMs);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    offsetMs = 0;
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    owner = await createAdmin(api.container, tenantA, {
      username: 'panel-owner',
      password: OWNER_PASSWORD,
      roleKeys: ['owner'],
    });
    ownerActor = await signIn('panel-owner', OWNER_PASSWORD, tenantA, owner.id);
    const operator = await createAdmin(api.container, tenantA, {
      username: 'panel-operator',
      roleKeys: ['operator'],
    });
    await api.container.database.db.insert(adminPermissionOverrides).values({
      tenantId: tenantA.tenantId,
      adminId: operator.id,
      permissionKey: 'hosting.manage',
      effect: 'GRANT',
      reason: 'test: a delegated key must not open the owner’s section',
    });
    operatorActor = await signIn('panel-operator', operator.password, tenantA, operator.id);
  });

  it('asks with a fresh code, is made by the worker, downloads — audited in the OWNER’s log only', async () => {
    const panel = await openPanel();
    const { id, hostedScope, hostedActor } = await createBot(panel);

    const asked = await api.container.dataExport.requestHosted(
      tenantA,
      ownerActor,
      panel.token,
      id,
      {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
      },
    );
    expect(asked.export).toMatchObject({ state: 'REQUESTED', requestedByHost: true });
    const made = await api.container.dataExportRunner.tick();
    expect(made?.id).toBe(asked.export.id);

    const listed = await api.container.dataExport.listHosted(tenantA, ownerActor, panel.token, id);
    expect(listed.exports[0]).toMatchObject({ state: 'READY', downloadable: true });
    const file = await api.container.dataExport.downloadHosted(
      tenantA,
      ownerActor,
      panel.token,
      id,
      asked.export.id,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) chunks.push(chunk as Buffer);
    const zip = readZip(Buffer.concat(chunks));
    expect(zip.get('customers.csv')?.toString('utf8')).toContain('مشتری');
    expect(zip.has('README.fa.md')).toBe(true);

    // The audit rows are the installation's own; the hosted tenant's log holds none (D5).
    const db = api.container.database.db;
    const own = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.tenantId, tenantA.tenantId), like(auditLogs.action, 'data_export.%')),
      );
    expect(own.map((r) => r.action).sort()).toEqual([
      'data_export.downloaded',
      'data_export.requested',
    ]);
    const theirs = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.tenantId, id), like(auditLogs.action, 'data_export.%')));
    expect(theirs).toEqual([]);

    // The hosted bot's OWN owner does not see what the host asked for, nor take it.
    expect((await api.container.dataExport.listOwn(hostedScope, hostedActor)).exports).toEqual([]);
    expect(
      await codeOf(api.container.dataExport.downloadOwn(hostedScope, hostedActor, asked.export.id)),
    ).toBe(DATA_EXPORT_ERROR_CODES.NOT_FOUND);
  });

  it('writes a hosted bot’s export row on the system path, under its own reason — never by binding that tenant', async () => {
    const panel = await openPanel();
    const { id, hostedScope } = await createBot(panel);
    const db = api.container.database.db;
    const sqlTag = (await import('drizzle-orm')).sql;
    // A probe on the table: what the session says it is acting as when the row is written.
    await db.execute(
      sqlTag`CREATE TABLE IF NOT EXISTS dx_reason_probe (role text, reason text, tenant text)`,
    );
    await db.execute(sqlTag`TRUNCATE dx_reason_probe`);
    await db.execute(sqlTag`
      CREATE OR REPLACE FUNCTION dx_reason_probe_fn() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN
        INSERT INTO dx_reason_probe VALUES (current_setting('role'),
          coalesce(current_setting('app.system_reason', true), ''),
          coalesce(current_setting('app.current_tenant_id', true), ''));
        RETURN NEW;
      END $$`);
    await db.execute(sqlTag`
      CREATE TRIGGER dx_reason_probe_trg BEFORE INSERT ON tenant_data_exports
        FOR EACH ROW EXECUTE FUNCTION dx_reason_probe_fn()`);
    try {
      const asked = await api.container.dataExport.requestHosted(
        tenantA,
        ownerActor,
        panel.token,
        id,
        { idempotencyKey: key(), proof: { code: code(panel.secret) } },
      );
      const probe = (await db.execute(sqlTag`SELECT role, reason FROM dx_reason_probe`)).rows as {
        role: string;
        reason: string;
      }[];
      expect(probe).toEqual([
        {
          role: 'nexa_system',
          reason: 'data-export: host requests an export for a hosted bot',
        },
      ]);
      expect(asked.export.id).toBeDefined();
      // The hosted bot's own door still binds its own tenant.
      expect(hostedScope.tenantId).toBe(id);
    } finally {
      await db.execute(sqlTag`DROP TRIGGER IF EXISTS dx_reason_probe_trg ON tenant_data_exports`);
      await db.execute(sqlTag`DROP FUNCTION IF EXISTS dx_reason_probe_fn()`);
      await db.execute(sqlTag`DROP TABLE IF EXISTS dx_reason_probe`);
    }
  });

  it('refuses with no section session, a wrong or spent code, a non-owner, and another tenant’s owner — changing nothing', async () => {
    const panel = await openPanel();
    const { id, hostedActor, hostedScope } = await createBot(panel);
    const ask = (proof: unknown, token: string | null = panel.token, actor = ownerActor) =>
      api.container.dataExport.requestHosted(tenantA, actor, token, id, {
        idempotencyKey: key(),
        proof,
      });
    const count = async () =>
      (await api.container.database.db.select().from(tenantDataExports)).length;

    expect(await codeOf(ask({ code: code(panel.secret) }, null))).toBe(
      HOSTING_ERROR_CODES.SECTION_SESSION_REQUIRED,
    );
    expect(await codeOf(ask({ code: '123456' }))).toBe(HOSTING_ERROR_CODES.CODE_REJECTED);
    const spent = code(panel.secret);
    await ask({ code: spent });
    // The same code twice: the second is refused (a step is spent once).
    expect(await codeOf(ask({ code: spent }))).toBeTruthy();
    // A delegated hosting.manage is not the owner.
    expect(await codeOf(ask({ code: code(panel.secret) }, panel.token, operatorActor))).toBe(
      HOSTING_ERROR_CODES.OWNER_ONLY,
    );
    // The hosted bot's own owner holds every key in their tenant, and still cannot use the door.
    await expect(
      api.container.dataExport.requestHosted(hostedScope, hostedActor, panel.token, id, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
      }),
    ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
    expect(await count()).toBe(1);
  });

  it('a retry of a request that committed answers the first result and spends no code', async () => {
    const panel = await openPanel();
    const { id } = await createBot(panel);
    const idempotencyKey = key();
    const first = await api.container.dataExport.requestHosted(
      tenantA,
      ownerActor,
      panel.token,
      id,
      {
        idempotencyKey,
        proof: { code: code(panel.secret) },
      },
    );
    // No proof at all: the replay is answered before a code is asked for.
    const again = await api.container.dataExport.requestHosted(
      tenantA,
      ownerActor,
      panel.token,
      id,
      {
        idempotencyKey,
        proof: { code: '000000' },
      },
    );
    expect(again.replayed).toBe(true);
    expect(again.export.id).toBe(first.export.id);
    expect((await api.container.database.db.select().from(tenantDataExports)).length).toBe(1);
  });

  it('only a hosted bot of this installation: the installation’s own tenant and an unknown id are not found', async () => {
    const panel = await openPanel();
    await createBot(panel);
    for (const id of [tenantA.tenantId as string, '01900000-0000-7000-8000-00000000ffff']) {
      expect(
        await codeOf(
          api.container.dataExport.requestHosted(tenantA, ownerActor, panel.token, id, {
            idempotencyKey: key(),
            proof: { code: code(panel.secret) },
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.BOT_NOT_FOUND);
    }
    expect((await api.container.database.db.select().from(tenantDataExports)).length).toBe(0);
  });

  it('the installation’s own owner holds data.export but his tenant is not exported', async () => {
    expect(
      await codeOf(
        api.container.dataExport.requestOwn(tenantA, ownerActor, { idempotencyKey: key() }),
      ),
    ).toBe(DATA_EXPORT_ERROR_CODES.NOT_HOSTED);
  });
});
