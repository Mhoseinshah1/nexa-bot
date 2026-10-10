import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  LEGACY_MIGRATION_APPROVAL_PHRASE,
  LEGACY_MIGRATION_HTTP_ERROR_CODES,
  LEGACY_MIGRATION_ROUTES,
  legacyMigrationCapabilitiesResponseSchema,
  legacyMigrationImportListResponseSchema,
  legacyMigrationImportResponseSchema,
  SESSION_COOKIE_NAME,
  type CorrelationId,
  type LegacyMigrationDryRunReport,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { LegacyMigrationExecutor } from '../../apps/api/src/modules/platform/legacy-migration/application/legacy-migration-executor';
import {
  LegacyMigrationStepFailure,
  type MigrationRunner,
} from '../../apps/api/src/modules/platform/legacy-migration/application/ports';
import { reportDigest } from '../../apps/api/src/modules/platform/legacy-migration/domain/import-lifecycle';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

/**
 * Mirza `.nxpkg` importer — the `legacy-migration` module against a real PostgreSQL and the
 * real HTTP surface.
 *
 * What this file defends:
 * - the upload streams to a 0600 file in a 0700 directory, counted and hashed by the server,
 *   and an oversized body is refused by the COUNTER with no row and no file left behind;
 * - one active import per tenant is the database's partial unique index;
 * - the key is sealed (`legacy_migration.package_key`, bound to the row) and round-trips
 *   through the installation keyring, and no response carries it or a path;
 * - permissions: an observer reads nothing; a manager without `apply` cannot approve, and the
 *   refusal is audited DENIED; the approval binds the current dry run digest;
 * - the lease: one claim per row across two owners, a heartbeat, a stale lease released for
 *   the next claim; an UPLOADED row is not work until its key is held;
 * - the executor drives the real repository through every state with fake ports, RESUMES an
 *   interrupted apply, and erases the key (both columns NULL) at every terminal state — under
 *   the table's own CHECK constraints, which refuse any other shape.
 */

const ORIGIN = 'https://admin.example.test';
const H = (c: string) => c.repeat(64);
const PASSPHRASE = 'a package passphrase nobody may read back';
const MAX_UPLOAD = 4096;

const dryRunReport: LegacyMigrationDryRunReport = {
  importerVerdict: 'READY',
  sections: [
    { section: 'customers', source: 2, imported: 2, archived: 0, skipped: 0, quarantined: 0 },
  ],
  warnings: [],
  quarantine: [],
  wallets: { currency: 'IRT', customers: 2, beforeTotalMinor: '0', afterTotalMinor: '500' },
  debts: { currency: 'IRT', count: 0, totalMinor: '0' },
  ownership: {
    decisionsProvided: false,
    proven: 1,
    adminApprovedUnverified: 0,
    quarantined: 0,
    rejected: 0,
    pending: 0,
    stale: 0,
  },
  cutover: {
    sourceFingerprint: 'a'.repeat(64),
    panelMapFingerprint: 'b'.repeat(64),
    inventoryFingerprint: 'c'.repeat(64),
    productsFingerprint: 'd'.repeat(64),
    invoiceArchiveFingerprint: 'e'.repeat(64),
    freezeProofSha256: 'f'.repeat(64),
    finalDumpSha256: '1'.repeat(64),
  },
};

describe('legacy migration (Mirza .nxpkg)', () => {
  let api: ApiApp;
  let workRoot: string;
  let ownerCookie: string;
  let managerCookie: string;
  let observerCookie: string;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'nexa-lmig-'));
    const config = testConfig({
      WEB_ADMIN_ORIGINS: ORIGIN,
      LEGACY_MIGRATION_ENABLED: 'true',
      LEGACY_MIGRATION_WORK_DIR: workRoot,
      LEGACY_MIGRATION_UPLOAD_MAX_BYTES: String(MAX_UPLOAD),
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  });

  afterAll(async () => {
    await api?.close();
    await rm(workRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Each case starts with an empty work directory, like an empty table.
    for (const entry of await readdir(workRoot)) {
      await rm(join(workRoot, entry), { recursive: true, force: true });
    }
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    const manager = await createAdmin(api.container, tenantA, {
      username: 'manager',
      password: 'the-managers-password',
    });
    // `view` + `manage` and NOT `apply`: a HIGH operator who prepares, never approves.
    await grant(manager.id, ['legacy.migration.view', 'legacy.migration.manage']);
    await createAdmin(api.container, tenantA, {
      username: 'observer',
      password: 'the-observers-password',
      roleKeys: ['observer'],
    });
    ownerCookie = await cookieFor('owner', 'the-owners-real-password');
    managerCookie = await cookieFor('manager', 'the-managers-password');
    observerCookie = await cookieFor('observer', 'the-observers-password');
  });

  async function grant(adminId: string, keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      await api.container.database.db.execute(sql`
        INSERT INTO admin_permission_overrides (tenant_id, admin_id, permission_key, effect, reason, created_at)
        VALUES (${tenantA.tenantId}, ${adminId}, ${key}, 'GRANT', 'legacy migration test', now())`);
    }
  }

  async function cookieFor(username: string, password: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(response.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error(`No session cookie for ${username}.`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  const headers = (cookie: string) => ({ cookie, origin: ORIGIN });
  const get = (path: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: headers(cookie) });
  const post = (path: string, cookie: string, payload: unknown) =>
    inject({ method: 'POST', url: `${API_PREFIX}${path}`, headers: headers(cookie), payload });
  const upload = (cookie: string, body: Buffer, route: string = LEGACY_MIGRATION_ROUTES.upload) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${route}`,
      headers: {
        ...headers(cookie),
        'content-type': 'application/octet-stream',
        'x-nexa-filename': encodeURIComponent('../../etc/mirza.nxpkg'),
      },
      payload: body,
    });
  let keys = 0;
  const idempotencyKey = () => `lmig-${String((keys += 1))}-${String(Date.now())}`;

  async function uploaded(cookie = ownerCookie): Promise<{ id: string; bytes: Buffer }> {
    const bytes = randomBytes(1500);
    const response = await upload(cookie, bytes);
    expect(response.statusCode, response.body).toBe(201);
    return { id: legacyMigrationImportResponseSchema.parse(response.json()).import.id, bytes };
  }

  async function row(id: string) {
    const result = await api.container.database.db.execute<Record<string, unknown>>(
      sql`SELECT * FROM legacy_nxpkg_imports WHERE id = ${id}`,
    );
    return result.rows[0];
  }

  // --- the HTTP surface -------------------------------------------------------------------

  it('streams the package to a private file, hashed by the server; the view carries no path', async () => {
    const { id, bytes } = await uploaded();
    const detail = await get(LEGACY_MIGRATION_ROUTES.detail(id), ownerCookie);
    expect(detail.statusCode).toBe(200);
    const view = legacyMigrationImportResponseSchema.parse(detail.json()).import;
    expect(view.status).toBe('UPLOADED');
    expect(view.fileSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(view.fileBytes).toBe(String(bytes.length));
    // The browser's name is a label, sanitised: never a path.
    expect(view.fileName).not.toContain('/');
    expect(detail.body).not.toContain(workRoot);

    const stored = await row(id);
    const path = String(stored?.['file_path']);
    expect(path.startsWith(join(workRoot, id))).toBe(true);
    expect(await readFile(path)).toEqual(bytes);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(workRoot, id))).mode & 0o777).toBe(0o700);
  });

  it('refuses an oversized package by counting it, leaving no row and no file', async () => {
    const response = await upload(ownerCookie, randomBytes(MAX_UPLOAD + 1));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: LEGACY_MIGRATION_HTTP_ERROR_CODES.UPLOAD_TOO_LARGE },
    });
    const count = await api.container.database.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM legacy_nxpkg_imports`,
    );
    expect(count.rows[0]?.n).toBe('0');
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('accepts one active import per tenant', async () => {
    await uploaded();
    const second = await upload(ownerCookie, randomBytes(100));
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      error: { code: LEGACY_MIGRATION_HTTP_ERROR_CODES.ALREADY_ACTIVE },
    });
  });

  it('seals the key under the keyring, bound to the row, and never returns it', async () => {
    const { id } = await uploaded();
    const response = await post(LEGACY_MIGRATION_ROUTES.key(id), ownerCookie, {
      idempotencyKey: idempotencyKey(),
      passphrase: PASSPHRASE,
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.body).not.toContain(PASSPHRASE);
    const view = legacyMigrationImportResponseSchema.parse(response.json()).import;
    expect(view).toMatchObject({ keyPresent: true, keyKind: 'PASSPHRASE' });

    const stored = await row(id);
    const ciphertext = String(stored?.['key_ciphertext']);
    expect(ciphertext).not.toContain(PASSPHRASE);
    expect(
      api.container.cipher.decrypt(
        { keyId: String(stored?.['key_key_id']), ciphertext },
        { purpose: 'legacy_migration.package_key', tenantId: tenantA.tenantId, entityId: id },
      ),
    ).toBe(PASSPHRASE);
    // Bound to THIS row: the same ciphertext under another id does not open.
    expect(() =>
      api.container.cipher.decrypt(
        { keyId: String(stored?.['key_key_id']), ciphertext },
        {
          purpose: 'legacy_migration.package_key',
          tenantId: tenantA.tenantId,
          entityId: '019600ab-cdef-7012-8345-6789abcd0fff',
        },
      ),
    ).toThrow();
    // Nor is it in the audit log.
    const audit = await api.container.database.db.execute<{ rows: string }>(
      sql`SELECT coalesce(json_agg(a)::text, '') AS rows FROM audit_logs a`,
    );
    expect(audit.rows[0]?.rows).not.toContain(PASSPHRASE);
    expect(audit.rows[0]?.rows).not.toContain(ciphertext);
  });

  it('refuses an observer everything, and a manager the approval (audited DENIED)', async () => {
    const { id } = await uploaded();
    expect((await get(LEGACY_MIGRATION_ROUTES.list, observerCookie)).statusCode).toBe(403);
    expect((await upload(observerCookie, randomBytes(10))).statusCode).toBe(403);
    expect((await get(LEGACY_MIGRATION_ROUTES.list, managerCookie)).statusCode).toBe(200);

    const approve = await post(LEGACY_MIGRATION_ROUTES.approve(id), managerCookie, {
      idempotencyKey: idempotencyKey(),
      dryRunSha256: H('a'),
      confirmation: LEGACY_MIGRATION_APPROVAL_PHRASE,
    });
    expect(approve.statusCode).toBe(403);
    const denied = await api.container.database.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM audit_logs
           WHERE action = 'legacy.migration.approve' AND result = 'DENIED'`,
    );
    expect(denied.rows[0]?.n).toBe('1');
  });

  it('binds the approval to the current dry run digest, then cancels before the apply', async () => {
    const { id } = await uploaded();
    await post(LEGACY_MIGRATION_ROUTES.key(id), ownerCookie, {
      idempotencyKey: idempotencyKey(),
      passphrase: PASSPHRASE,
    });
    const digest = reportDigest(dryRunReport);
    await api.container.database.db.execute(sql`
      UPDATE legacy_nxpkg_imports
         SET status = 'DRY_RUN_DONE', dry_run_report = ${JSON.stringify(dryRunReport)}::jsonb,
             dry_run_sha256 = ${digest}
       WHERE id = ${id}`);
    const approve = (dryRunSha256: string) =>
      post(LEGACY_MIGRATION_ROUTES.approve(id), ownerCookie, {
        idempotencyKey: idempotencyKey(),
        dryRunSha256,
        confirmation: LEGACY_MIGRATION_APPROVAL_PHRASE,
      });
    const wrong = await approve(H('b'));
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toMatchObject({
      error: { code: LEGACY_MIGRATION_HTTP_ERROR_CODES.DIGEST_MISMATCH },
    });
    const right = await approve(digest);
    expect(right.statusCode, right.body).toBe(201);
    expect(legacyMigrationImportResponseSchema.parse(right.json()).import).toMatchObject({
      status: 'APPROVED',
      approvedDryRunSha256: digest,
    });

    const cancel = await post(LEGACY_MIGRATION_ROUTES.cancel(id), ownerCookie, {
      idempotencyKey: idempotencyKey(),
    });
    expect(cancel.statusCode, cancel.body).toBe(201);
    const stored = await row(id);
    expect(stored).toMatchObject({ status: 'CANCELLED', error_code: 'CANCELLED' });
    expect(stored?.['key_ciphertext']).toBeNull();
    expect(stored?.['key_key_id']).toBeNull();
    expect(stored?.['finished_at']).not.toBeNull();

    const list = legacyMigrationImportListResponseSchema.parse(
      (await get(LEGACY_MIGRATION_ROUTES.list, ownerCookie)).json(),
    );
    expect(list.imports.map((item) => item.id)).toEqual([id]);
    const capabilities = legacyMigrationCapabilitiesResponseSchema.parse(
      (await get(LEGACY_MIGRATION_ROUTES.capabilities, ownerCookie)).json(),
    );
    expect(capabilities).toMatchObject({ enabled: true, maxUploadBytes: MAX_UPLOAD });
  });

  it('stores the decisions file content-addressed and refuses one over its limit', async () => {
    const { id } = await uploaded();
    const body = Buffer.from('{"decisions":[]}');
    const response = await upload(ownerCookie, body, LEGACY_MIGRATION_ROUTES.decisions(id));
    expect(response.statusCode, response.body).toBe(201);
    expect(legacyMigrationImportResponseSchema.parse(response.json()).import.decisionsPresent).toBe(
      true,
    );
    const stored = await row(id);
    const sha = createHash('sha256').update(body).digest('hex');
    expect(String(stored?.['decisions_file_path'])).toBe(
      join(workRoot, id, `ownership-decisions-${sha}.json`),
    );
    expect(await readFile(String(stored?.['decisions_file_path']))).toEqual(body);
  });

  // --- the lease ------------------------------------------------------------------------------

  it('claims one row per owner, heartbeats it, and releases a stale lease for the next claim', async () => {
    const { id } = await uploaded();
    const repository = api.container.legacyNxpkgImports;
    const now = new Date();
    const later = (ms: number) => new Date(now.getTime() + ms);

    // UPLOADED with no key is not work.
    expect(await repository.claim({ leaseOwner: 'a', now, leaseUntil: later(60_000) })).toBeNull();
    await post(LEGACY_MIGRATION_ROUTES.key(id), ownerCookie, {
      idempotencyKey: idempotencyKey(),
      keyFileText: 'nxpkg-key-v1:AAAA',
    });

    const first = await repository.claim({ leaseOwner: 'a', now, leaseUntil: later(60_000) });
    expect(first?.id).toBe(id);
    expect(await repository.claim({ leaseOwner: 'b', now, leaseUntil: later(60_000) })).toBeNull();
    expect(
      await repository.heartbeat({ id, leaseOwner: 'a', now, leaseUntil: later(120_000) }),
    ).toBe(true);
    expect(
      await repository.heartbeat({ id, leaseOwner: 'b', now, leaseUntil: later(120_000) }),
    ).toBe(false);
    // An operator's command refuses while a worker holds the row.
    const bindings = await post(LEGACY_MIGRATION_ROUTES.panelBindings(id), ownerCookie, {
      idempotencyKey: idempotencyKey(),
      bindings: [{ codePanel: 'P1', panelId: '019600ab-cdef-7012-8345-6789abcd0fff' }],
    });
    expect(bindings.statusCode).toBe(409);

    // Not stale yet; then stale.
    expect(await repository.reclaimStale({ now: later(60_000) })).toEqual([]);
    const released = await repository.reclaimStale({ now: later(180_000) });
    expect(released.map((r) => r.id)).toEqual([id]);
    expect(released[0]?.status).toBe('UPLOADED');
    const second = await repository.claim({ leaseOwner: 'b', now, leaseUntil: later(60_000) });
    expect(second?.id).toBe(id);
    // A lease-guarded write by the former owner matches nothing.
    expect(
      await repository.transition({
        id,
        from: ['UPLOADED'],
        to: 'VERIFYING',
        now,
        leaseOwner: 'a',
      }),
    ).toBe(false);
  });

  // --- the executor against the real repository -------------------------------------------

  function executorWith(runner: Partial<MigrationRunner>, calls: string[]) {
    const container = api.container;
    return new LegacyMigrationExecutor({
      repository: container.legacyNxpkgImports,
      workspaces: container.migrationWorkspaces,
      cipher: container.cipher,
      verifier: {
        verify: async (context) => {
          // The key the executor hands a port is the one the operator gave.
          calls.push('passphrase' in context.secret ? context.secret.passphrase : 'key-file');
          // The step directory is private and exists for the step.
          calls.push(String((await stat(context.workDir)).mode & 0o777));
          return {
            packageImportId: 'pkg-int-1',
            sourceFingerprint: H('c'),
            packageSchemaVersion: '1.4.0',
            converterVersion: '0.5.0',
            synthetic: true,
            panelTargets: [{ codePanel: 'P1', providerType: 'rickpanel', services: 1 }],
            recordCounts: [{ code: 'user', count: 2 }],
            decisions: null,
          };
        },
      },
      runner: {
        precheck: async () => undefined,
        dryRun: async () => ({ report: dryRunReport, legacyRunId: null }),
        apply: async (_context, input) => {
          calls.push(`apply:${input.mode}`);
          return { legacyRunId: null as unknown as string, importerVerdict: 'COMPLETED' };
        },
        reconcile: async () => ({ verdict: 'DISCREPANCY' as const }),
        finalReport: async (_context, input) => ({
          importerVerdict: input.importerVerdict,
          reconcileVerdict: input.reconcileVerdict,
          reportHolds: false,
          failedInvariants: ['WALLETS_RECONCILED'],
          sections: [],
          history: [...input.history],
        }),
        ...runner,
      },
      freshTarget: { check: async () => ({ fresh: true }) },
      history: { ingest: async () => ({ counts: [{ code: 'payment', count: 3 }] }) },
      backup: { runAfterImport: async () => ({ outcome: 'SKIPPED_QUIESCED', runId: null }) },
      clock: container.clock,
      correlation: () => 'corr' as CorrelationId,
      leaseOwner: 'migration:integration',
      tickIntervalMs: 1000,
      enabled: true,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
  }

  it('drives an import through every state, resumes an interrupted apply, and erases the key', async () => {
    const { id } = await uploaded();
    await post(LEGACY_MIGRATION_ROUTES.key(id), ownerCookie, {
      idempotencyKey: idempotencyKey(),
      passphrase: PASSPHRASE,
    });
    const calls: string[] = [];
    let crash = true;
    const executor = executorWith(
      {
        apply: async (_context, input) => {
          calls.push(`apply:${input.mode}`);
          if (crash) {
            crash = false;
            throw new Error('interrupted');
          }
          return { legacyRunId: null as unknown as string, importerVerdict: 'COMPLETED' };
        },
      },
      calls,
    );

    await executor.tick();
    expect((await row(id))?.['status']).toBe('VERIFIED');
    expect(calls.slice(0, 2)).toEqual([PASSPHRASE, String(0o700)]);

    const panelId = '019600ab-cdef-7012-8345-6789abcd0fff';
    expect(
      (
        await post(LEGACY_MIGRATION_ROUTES.panelBindings(id), ownerCookie, {
          idempotencyKey: idempotencyKey(),
          bindings: [{ codePanel: 'P1', panelId }],
        })
      ).statusCode,
    ).toBe(201);
    const requested = await post(LEGACY_MIGRATION_ROUTES.dryRun(id), ownerCookie, {
      idempotencyKey: idempotencyKey(),
    });
    expect(requested.statusCode, requested.body).toBe(201);
    await executor.tick();
    const done = legacyMigrationImportResponseSchema.parse(
      (await get(LEGACY_MIGRATION_ROUTES.detail(id), ownerCookie)).json(),
    ).import;
    expect(done.status).toBe('DRY_RUN_DONE');
    expect(done.dryRunSha256).toBe(reportDigest(dryRunReport));
    expect(done.dryRunReport).toEqual(dryRunReport);

    const approved = await post(LEGACY_MIGRATION_ROUTES.approve(id), ownerCookie, {
      idempotencyKey: idempotencyKey(),
      dryRunSha256: done.dryRunSha256,
      confirmation: LEGACY_MIGRATION_APPROVAL_PHRASE,
    });
    expect(approved.statusCode, approved.body).toBe(201);

    // First apply attempt is interrupted: the row stays APPLYING, lease released, key held.
    await executor.tick();
    let stored = await row(id);
    expect(stored).toMatchObject({ status: 'APPLYING', claimed_by: null });
    expect(stored?.['key_ciphertext']).not.toBeNull();
    // A cancel is refused while it applies.
    const cancel = await post(LEGACY_MIGRATION_ROUTES.cancel(id), ownerCookie, {
      idempotencyKey: idempotencyKey(),
    });
    expect(cancel.statusCode).toBe(409);

    await executor.tick();
    stored = await row(id);
    expect(stored).toMatchObject({ status: 'COMPLETED_WITH_DISCREPANCY', error_code: null });
    expect(stored?.['key_ciphertext']).toBeNull();
    expect(stored?.['key_key_id']).toBeNull();
    expect(stored?.['key_kind']).toBe('PASSPHRASE');
    expect(stored?.['finished_at']).not.toBeNull();
    expect(calls.filter((call) => call.startsWith('apply:'))).toEqual([
      'apply:IMPORT',
      'apply:RESUME',
    ]);
    const view = legacyMigrationImportResponseSchema.parse(
      (await get(LEGACY_MIGRATION_ROUTES.detail(id), ownerCookie)).json(),
    ).import;
    expect(view.progress).toMatchObject({
      applyAttempts: 2,
      reconcileVerdict: 'DISCREPANCY',
      backup: 'SKIPPED_QUIESCED',
      history: [{ code: 'payment', count: 3 }],
    });
    expect(view.applyReport?.failedInvariants).toEqual(['WALLETS_RECONCILED']);
    // No decrypted step directory survived.
    expect((await readdir(join(workRoot, id))).filter((name) => name.startsWith('step-'))).toEqual(
      [],
    );
  });

  it('fails a verification with the verifier’s code and erases the key', async () => {
    const { id } = await uploaded();
    await post(LEGACY_MIGRATION_ROUTES.key(id), ownerCookie, {
      idempotencyKey: idempotencyKey(),
      passphrase: PASSPHRASE,
    });
    const executor = executorWith({}, []);
    (executor as unknown as { deps: { verifier: unknown } }).deps.verifier = {
      verify: async () => {
        throw new LegacyMigrationStepFailure('NXPKG_WRONG_KEY', 'wrong key');
      },
    };
    await executor.tick();
    const stored = await row(id);
    expect(stored).toMatchObject({ status: 'VERIFY_FAILED', error_code: 'NXPKG_WRONG_KEY' });
    expect(stored?.['key_ciphertext']).toBeNull();
    // Terminal: a new package may be uploaded.
    await uploaded();
  });
});
