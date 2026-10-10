import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE_NAME,
  legacyHistoryResponseSchema,
  systemJobActor,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type UserId,
} from '@nexa/contracts';
import { openNxpkg } from '../../apps/api/src/infrastructure/nxpkg';
import type { HistoryRecordSource } from '../../apps/api/src/modules/platform/legacy-history/application/ports';
import {
  HISTORY_DIRECTORIES,
  HISTORY_FILES,
  LegacyHistoryIngestRefused,
} from '../../apps/api/src/modules/platform/legacy-history/application/record-map';
import { LegacyHistoryController } from '../../apps/api/src/surfaces/web/legacy-history.controller';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type SeededAdmin,
  type TestContext,
} from './harness';

/**
 * Mirza `.nxpkg` importer — the history archive (`legacy_history_records`, design §5) end to
 * end against PostgreSQL. SYNTHETIC records only (shaped like the converter's, and the
 * converter's own synthetic fixture package); no real value anywhere.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const TG_A = '7000000069';
const TG_B = '7000000037';
const TG_NOBODY = '5000000003';
const PACKAGE_IMPORT_ID = 'synthetic-import-0001';
const FIXTURES = join(__dirname, '../fixtures/nxpkg');

type Rec = Record<string, unknown>;

/** An in-memory package: the ingest sees only `files()`, `has()` and `iterJsonl()`. */
function memorySource(files: Readonly<Record<string, readonly Rec[]>>): HistoryRecordSource {
  return {
    files: () => Object.keys(files).map((path) => ({ path })),
    has: (rel) => Object.hasOwn(files, rel),
    async *iterJsonl(rel) {
      for (const record of files[rel] ?? []) yield record;
    },
  };
}

const flagsOff = { affects_wallet: false, applies_to_live_state: false, creates_payment: false };
const payment = (n: number, tg: string | null, over: Rec = {}): Rec => ({
  record_type: 'legacy_payment_history',
  schema: 'mirza.payment_report.v1',
  idempotency_key: `legacy:payment:${n}`,
  customer: { telegram_user_id: tg, source_user_id: tg, relation: 'CUSTOMER_IMPORTED' },
  amount: { amount_minor: String(1000 * n), currency: 'IRT', raw: String(1000 * n) },
  status: { outcome: 'SUCCEEDED', raw: 'paid' },
  method: { normalized: 'CARD_TO_CARD', raw: 'cart to cart' },
  times: { created: { local: '2025-01-01T08:02:17', unix: 1_735_700_000 + n } },
  provenance: { source_table: 'Payment_report', source_pk: String(n) },
  ...flagsOff,
  counts_as_revenue: false,
  ...over,
});
const ticketMessage = (n: number): Rec => ({
  record_type: 'legacy_ticket_message',
  schema: 'm2n.support.ticket_message.v1',
  idempotency_key: `legacy:support:ticket_message:${n}`,
  fields_raw: { message: 'synthetic text', sender: 'admin', ticket_id: '1' },
  sent_at: '2024-08-01T10:01:00',
  seq: n,
  provenance: { source_table: 'ticket_message', source_pk: String(n) },
  ...flagsOff,
});
const serviceOperation = (n: number, tg: string): Rec => ({
  record_type: 'legacy_service_operation',
  schema: 'mirza.service_other.v1',
  idempotency_key: `legacy:service-op:${n}`,
  owner: { raw: tg, telegram_user_id: tg, role: 'OWNER' },
  operation_type: { normalized: 'RENEWAL', raw: 'extend_user' },
  status: { normalized: 'PAID', raw: 'paid' },
  amount: { amount_minor: '20000', currency: 'IRT', applied: false },
  panel_account_username: 'syn49',
  provision: false,
  ...flagsOff,
});
const archiveRow = (table: string, n: number): Rec => ({
  record_type: 'legacy_archive_row',
  schema: `mirza.${table}.v1`,
  idempotency_key: `legacy:${table}:${n}`,
  class: 'REVIEW',
  fields: { id: String(n), id_user: TG_A, status: 'done' },
  applies_to_live_state: false,
});

/** The standard synthetic package: 4 payments (2 of A, 1 of B, 1 of nobody), 2 ops, 2 ticket messages, 1 archive row. */
const standard = (): Record<string, Rec[]> => ({
  'records/customers.jsonl': [{ record_type: 'customer', idempotency_key: 'legacy:customer:1' }],
  'records/payments.jsonl': [
    payment(1, TG_A),
    payment(2, TG_A),
    payment(3, TG_B),
    payment(4, TG_NOBODY),
  ],
  'records/service_operations.jsonl': [serviceOperation(1, TG_A), serviceOperation(2, TG_B)],
  'records/support/ticket_messages.jsonl': [ticketMessage(1), ticketMessage(2)],
  'records/archive/vs_order.jsonl': [archiveRow('vs_order', 1)],
});

describe('Mirza .nxpkg importer: the history archive', () => {
  let ctx: TestContext;
  let owner: SeededAdmin;
  let ownerActor: ActorContext;
  let customerA: UserId;
  let customerB: UserId;
  let importId: string;
  const job = systemJobActor('legacy-migration:history', 'corr-history' as CorrelationId);
  const db = () => ctx.container.database.db;
  const ingest = () => ctx.container.legacyHistoryIngest;
  const lookup = () => (ids: readonly string[]) =>
    new Map(
      ids.flatMap((id) =>
        id === TG_A ? [[id, customerA as string]] : id === TG_B ? [[id, customerB as string]] : [],
      ) as [string, string][],
    );
  const run = (files: Record<string, Rec[]>, over: { dryRun?: boolean; batchSize?: number } = {}) =>
    ingest().ingest(tenantA, job, {
      nxpkgImportId: importId,
      packageImportId: PACKAGE_IMPORT_ID,
      source: memorySource(files),
      customerIdByTelegram: lookup(),
      batchSize: over.batchSize ?? 3,
      ...(over.dryRun === undefined ? {} : { dryRun: over.dryRun }),
    });

  async function q<T extends Record<string, unknown>>(query: ReturnType<typeof sql>) {
    return (await db().execute<T>(query)).rows;
  }
  const rowCount = async () =>
    Number(
      (await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM legacy_history_records`))[0]?.n,
    );

  async function refusalOf(promise: Promise<unknown>): Promise<LegacyHistoryIngestRefused> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof LegacyHistoryIngestRefused) return error;
      throw error;
    }
    throw new Error('expected a refusal');
  }

  async function resolveCustomer(telegramUserId: string): Promise<UserId> {
    const resolved = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      {
        type: 'SYSTEM_JOB',
        id: null,
        label: 'telegram-update:test',
        surface: 'TELEGRAM',
        correlationId: `r-${telegramUserId}` as CorrelationId,
      },
      {
        idempotencyKey: `resolve-history-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'synthetic' },
        botInstanceId: BOT_A,
      },
    );
    return resolved.customer.id;
  }

  async function insertImport(packageImportId: string | null): Promise<string> {
    const id = ctx.container.ids.uuid();
    await db().execute(sql`
      INSERT INTO legacy_nxpkg_imports
        (id, tenant_id, status, file_name, file_path, file_sha256, file_bytes, package_import_id,
         requested_by_admin_id, created_at, updated_at)
      VALUES (${id}, ${tenantA.tenantId}, 'VERIFIED', 'synthetic.nxpkg', '/nonexistent/synthetic.nxpkg',
              ${'a'.repeat(64)}, 1, ${packageImportId}, ${owner.id}, now(), now())`);
    return id;
  }

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = await createAdmin(ctx.container, tenantA, {
      username: 'owner-hana',
      roleKeys: ['owner'],
    });
    ownerActor = adminActorFor(owner);
    customerA = await resolveCustomer(TG_A);
    customerB = await resolveCustomer(TG_B);
    importId = await insertImport(PACKAGE_IMPORT_ID);
  });

  it('a dry run counts and writes nothing; two ingests write each record once', async () => {
    const dry = await run(standard(), { dryRun: true });
    expect(await rowCount()).toBe(0);
    expect(dry.dryRun).toBe(true);
    expect(dry.operationalFiles).toEqual(['records/customers.jsonl']);
    expect(dry.sections.payment).toEqual({
      source: 4,
      inserted: 4,
      alreadyPresent: 0,
      linkedToCustomer: 3,
      unlinked: 1,
    });

    const first = await run(standard());
    expect(first.sections).toEqual(dry.sections);
    expect(first.totals).toEqual({
      source: 9,
      inserted: 9,
      alreadyPresent: 0,
      linkedToCustomer: 5,
      unlinked: 4,
    });
    expect(first.sections.ticket_message).toEqual({
      source: 2,
      inserted: 2,
      alreadyPresent: 0,
      linkedToCustomer: 0,
      unlinked: 2,
    });
    expect(await rowCount()).toBe(9);

    const second = await run(standard(), { batchSize: 2 });
    expect(second.totals).toEqual({
      source: 9,
      inserted: 0,
      alreadyPresent: 9,
      linkedToCustomer: 0,
      unlinked: 0,
    });
    expect(await rowCount()).toBe(9);
    const dryAgain = await run(standard(), { dryRun: true });
    expect(dryAgain.totals.alreadyPresent).toBe(9);

    // The audit row names counts only, never a record value.
    const audits = await q<{ after: Record<string, unknown> }>(
      sql`SELECT after FROM audit_logs WHERE action = 'legacy.history.ingest' AND result = 'SUCCESS'`,
    );
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain(TG_A);
  });

  it('links each record to its customer before the insert, keeps the payload verbatim', async () => {
    await run(standard());
    const rows = await q<{
      record_type: string;
      idempotency_key: string;
      legacy_user_id: string | null;
      customer_id: string | null;
      occurred_at: string | null;
      payload: Rec;
      nxpkg_import_id: string;
    }>(sql`SELECT * FROM legacy_history_records ORDER BY idempotency_key`);
    const byKey = new Map(rows.map((row) => [row.idempotency_key, row]));
    expect(byKey.get('legacy:payment:1')).toMatchObject({
      record_type: 'payment',
      legacy_user_id: TG_A,
      customer_id: customerA,
      nxpkg_import_id: importId,
    });
    expect(new Date(String(byKey.get('legacy:payment:1')?.occurred_at)).toISOString()).toBe(
      new Date((1_735_700_000 + 1) * 1000).toISOString(),
    );
    expect(byKey.get('legacy:payment:1')?.payload).toEqual(payment(1, TG_A));
    expect(byKey.get('legacy:payment:4')).toMatchObject({
      legacy_user_id: TG_NOBODY,
      customer_id: null,
    });
    expect(byKey.get('legacy:service-op:2')).toMatchObject({
      record_type: 'service_operation',
      customer_id: customerB,
    });
    // A local wall time without an offset is not an instant.
    expect(byKey.get('legacy:support:ticket_message:1')).toMatchObject({
      record_type: 'ticket_message',
      legacy_user_id: null,
      occurred_at: null,
    });
    expect(byKey.get('legacy:vs_order:1')?.record_type).toBe('archive_row');
  });

  it('fails closed on an unknown record type, an unknown file, a live flag or a duplicate key — before writing anything', async () => {
    const cases: [Record<string, Rec[]>, string, string][] = [
      [
        {
          ...standard(),
          'records/support/ticket_messages.jsonl': [
            ticketMessage(1),
            { ...ticketMessage(2), record_type: 'legacy_brand_new' },
          ],
        },
        'UNKNOWN_RECORD_TYPE',
        'NXPKG_UNSUPPORTED_VERSION',
      ],
      [
        { ...standard(), 'records/zz_new_history.jsonl': [] },
        'UNKNOWN_FILE',
        'NXPKG_UNSUPPORTED_VERSION',
      ],
      [
        {
          ...standard(),
          'records/support/ticket_messages.jsonl': [
            ticketMessage(1),
            { ...ticketMessage(2), provision: true },
          ],
        },
        'LIVE_FLAG',
        'NXPKG_LIVE_FLAG',
      ],
      [
        {
          ...standard(),
          'records/payments.jsonl': [payment(1, TG_A), payment(2, TG_A, { affects_wallet: true })],
        },
        'LIVE_FLAG',
        'NXPKG_LIVE_FLAG',
      ],
      [
        {
          ...standard(),
          'records/archive/vs_order.jsonl': [
            { ...archiveRow('vs_order', 1), idempotency_key: 'legacy:payment:1' },
          ],
        },
        'IDEMPOTENCY_KEY_DUPLICATED',
        'IMPORT_FAILED',
      ],
      [
        {
          ...standard(),
          'records/payments.jsonl': [payment(1, TG_A, { idempotency_key: 'payment:1' })],
        },
        'IDEMPOTENCY_KEY_INVALID',
        'IMPORT_FAILED',
      ],
      [
        { ...standard(), 'records/payments.jsonl': [{ ...ticketMessage(9) }] },
        'RECORD_TYPE_MISMATCH',
        'IMPORT_FAILED',
      ],
    ];
    for (const [files, reason, code] of cases) {
      for (const dryRun of [true, false]) {
        const error = await refusalOf(run(files, { dryRun }));
        expect([error.reason, error.code]).toEqual([reason, code]);
      }
    }
    expect(await rowCount()).toBe(0);
  });

  it('refuses an import of another package, or of another tenant', async () => {
    const other = await refusalOf(
      ingest().ingest(tenantA, job, {
        nxpkgImportId: importId,
        packageImportId: 'another-package',
        source: memorySource(standard()),
      }),
    );
    expect(other.reason).toBe('PACKAGE_IMPORT_MISMATCH');
    const missing = await refusalOf(
      ingest().ingest(tenantA, job, {
        nxpkgImportId: ctx.container.ids.uuid(),
        packageImportId: PACKAGE_IMPORT_ID,
        source: memorySource(standard()),
      }),
    );
    expect(missing.reason).toBe('PACKAGE_IMPORT_MISMATCH');
    // An administrator is not the migration job: maintenance.run is SYSTEM_JOB work.
    await expect(
      ingest().ingest(
        tenantA,
        adminActorFor(await createAdmin(ctx.container, tenantA, { username: 'x-op' })),
        {
          nxpkgImportId: importId,
          packageImportId: PACKAGE_IMPORT_ID,
          source: memorySource(standard()),
        },
      ),
    ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
    expect(await rowCount()).toBe(0);
  });

  it('is append-only: UPDATE and DELETE are refused for every role', async () => {
    await run(standard());
    await expect(
      db().execute(sql`UPDATE legacy_history_records SET customer_id = NULL`),
    ).rejects.toThrow();
    await expect(db().execute(sql`DELETE FROM legacy_history_records`)).rejects.toThrow();
    await expect(
      db().execute(
        sql`UPDATE legacy_history_records SET payload = '{}'::jsonb WHERE record_type = 'payment'`,
      ),
    ).rejects.toThrow();
    expect(await rowCount()).toBe(9);
  });

  it("ingests the converter's synthetic fixture package through the .nxpkg reader", async () => {
    const workRoot = mkdtempSync(join(tmpdir(), 'nxpkg-history-'));
    const pkg = await openNxpkg(
      join(FIXTURES, 'synthetic-keyfile.nxpkg'),
      { keyFileText: readFileSync(join(FIXTURES, 'synthetic-keyfile.nxkey'), 'utf8') },
      {
        workDir: join(workRoot, 'work'),
        maxPayloadBytes: 64 * 1024 * 1024,
        maxFiles: 1000,
        maxFileBytes: 32 * 1024 * 1024,
      },
    );
    try {
      const packageImportId = String(pkg.manifest.import_id);
      const fixtureImport = await (async () => {
        // One non-terminal import per tenant: finish the standard one first.
        await db().execute(sql`
          UPDATE legacy_nxpkg_imports SET status = 'CANCELLED', error_code = 'CANCELLED', finished_at = now()
          WHERE id = ${importId}`);
        return insertImport(packageImportId);
      })();
      const options = { nxpkgImportId: fixtureImport, packageImportId, source: pkg, batchSize: 50 };
      const dry = await ingest().ingest(tenantA, job, { ...options, dryRun: true });
      // Every record line of every history file, no more, no less.
      let lines = 0;
      for (const file of dry.files) {
        for await (const _ of pkg.iterJsonl(file)) lines += 1;
      }
      expect(dry.totals.source).toBe(lines);
      expect(lines).toBeGreaterThan(50);
      expect(
        dry.files.every(
          (file) =>
            Object.hasOwn(HISTORY_FILES, file) ||
            Object.keys(HISTORY_DIRECTORIES).some((d) => file.startsWith(d)),
        ),
      ).toBe(true);
      expect(dry.operationalFiles).toContain('records/customers.jsonl');
      const applied = await ingest().ingest(tenantA, job, options);
      expect(applied.totals.inserted).toBe(lines);
      const again = await ingest().ingest(tenantA, job, options);
      expect(again.totals.alreadyPresent).toBe(lines);
      expect(await rowCount()).toBe(lines);
    } finally {
      await pkg.close();
      rmSync(workRoot, { recursive: true, force: true });
    }
  }, 120_000);

  describe('the Customer 360 read', () => {
    type WebRequest = Parameters<LegacyHistoryController['list']>[0];

    async function requestAs(admin: SeededAdmin): Promise<WebRequest> {
      const { token } = await ctx.container.auth.login(
        tenantA,
        {
          type: 'API',
          id: null,
          label: null,
          surface: 'WEB',
          correlationId: 'hana-web' as CorrelationId,
        },
        { username: admin.username, password: admin.password },
        { ip: '203.0.113.10', userAgent: 'vitest' },
      );
      return {
        method: 'GET',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
        ip: '203.0.113.10',
      } as unknown as WebRequest;
    }

    async function grant(admin: SeededAdmin, ...keys: string[]) {
      for (const key of keys) {
        await db().execute(sql`
          INSERT INTO admin_permission_overrides (tenant_id, admin_id, permission_key, effect, reason)
          VALUES (${tenantA.tenantId}, ${admin.id}, ${key}, 'GRANT', 'test')`);
      }
    }

    it('the owner reads the history, grouped counts and pages; unredacted and audited', async () => {
      await run(standard());
      const controller = new LegacyHistoryController(ctx.container);
      const request = await requestAs(owner);
      const page = legacyHistoryResponseSchema.parse(
        await controller.list(request, customerA, { limit: '2' }),
      );
      // A: two payments, one service operation (the archive row's id_user is not a link).
      expect(page.matching).toBe(3);
      expect(page.byType).toEqual([
        { recordType: 'payment', count: 2 },
        { recordType: 'service_operation', count: 1 },
      ]);
      expect(page.items).toHaveLength(2);
      expect(page.piiRedacted).toBe(false);
      expect(page.items[0]?.legacyUserId).toBe(TG_A);
      expect(page.invoiceArchive).toEqual({ invoices: 0 });
      expect(page.walletDebts).toEqual({ debts: 0 });
      const next = legacyHistoryResponseSchema.parse(
        await controller.list(request, customerA, { limit: '2', offset: '2' }),
      );
      expect(next.items).toHaveLength(1);
      const onlyOps = legacyHistoryResponseSchema.parse(
        await controller.list(request, customerA, { type: 'service_operation' }),
      );
      expect(onlyOps.matching).toBe(1);
      expect(onlyOps.items[0]?.summary).toMatchObject({ operation: 'RENEWAL', status: 'PAID' });
      const reveals = await q<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM audit_logs WHERE action = 'legacy.history.pii_view'`,
      );
      expect(Number(reveals[0]?.n)).toBe(3);
      // Bounded: a page above the maximum is refused.
      await expect(controller.list(request, customerA, { limit: '101' })).rejects.toThrow();
      await expect(controller.list(request, customerA, { type: 'nope' })).rejects.toThrow();
    });

    it('an unlinked record is found under the customer Telegram id', async () => {
      // B's customer is unknown to the lookup at ingest time: the rows stay unlinked.
      await ingest().ingest(tenantA, job, {
        nxpkgImportId: importId,
        packageImportId: PACKAGE_IMPORT_ID,
        source: memorySource(standard()),
        customerIdByTelegram: () => new Map(),
      });
      const page = await ctx.container.legacyHistoryRead.forCustomer(
        tenantA,
        ownerActor,
        customerB,
        {},
      );
      expect(page.matching).toBe(2);
      expect(page.items.every((item) => item.legacyUserId === TG_B)).toBe(true);
    });

    it('redacts personal fields without the PII key, and refuses without legacy.history.view', async () => {
      await run(standard());
      const viewer = await createAdmin(ctx.container, tenantA, { username: 'viewer-hana' });
      await grant(viewer, 'users.view');
      const controller = new LegacyHistoryController(ctx.container);
      const request = await requestAs(viewer);
      await expect(controller.list(request, customerA, {})).rejects.toMatchObject({
        kind: 'PERMISSION_DENIED',
      });
      await grant(viewer, 'legacy.history.view');
      const page = legacyHistoryResponseSchema.parse(await controller.list(request, customerA, {}));
      expect(page.piiRedacted).toBe(true);
      expect(page.invoiceArchive).toBeNull();
      expect(page.walletDebts).toBeNull();
      expect(page.matching).toBe(3);
      for (const item of page.items) {
        expect(item.legacyUserId).toBeNull();
        expect(JSON.stringify(item.payload)).not.toContain(TG_A);
      }
      const op = page.items.find((item) => item.recordType === 'service_operation');
      expect(op?.redacted).toEqual([
        'owner.raw',
        'owner.telegram_user_id',
        'panel_account_username',
      ]);
      expect(op?.payload).toMatchObject({
        status: { normalized: 'PAID' },
        panel_account_username: null,
      });
      const reveals = await q<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM audit_logs WHERE action = 'legacy.history.pii_view'`,
      );
      expect(Number(reveals[0]?.n)).toBe(0);

      // Without users.view the customer page itself is refused.
      const stranger = await createAdmin(ctx.container, tenantA, { username: 'stranger-hana' });
      await grant(stranger, 'legacy.history.view');
      await expect(controller.list(await requestAs(stranger), customerA, {})).rejects.toMatchObject(
        { kind: 'PERMISSION_DENIED' },
      );
      // An unknown customer is not found, not empty.
      await expect(
        ctx.container.legacyHistoryRead.forCustomer(
          tenantA,
          ownerActor,
          ctx.container.ids.uuid(),
          {},
        ),
      ).rejects.toMatchObject({ kind: 'NOT_FOUND' });
    });
  });
});
