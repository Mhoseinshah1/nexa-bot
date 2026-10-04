import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  systemJobActor,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import { parseArgs, runMode } from '../../apps/api/src/legacy-import.cli';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import {
  LegacyImportInterrupted,
  type LegacyImporterService,
} from '../../apps/api/src/modules/platform/legacy-importer/application/legacy-importer.service';
import {
  parsePanelMapping,
  type PanelMapping,
} from '../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import type {
  LegacyAdoptionCandidate,
  LegacyAdoptionPort,
} from '../../apps/api/src/modules/platform/legacy-importer/application/ports';
import {
  readFromSession,
  type LegacySnapshot,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import {
  SYNTHETIC_EXISTING_CUSTOMER,
  SYNTHETIC_EXPECTED,
  SYNTHETIC_PANEL_ACCOUNTS,
  buildSyntheticLegacyDataset,
  type SyntheticLegacyDataset,
} from '../fixtures/legacy/synthetic-legacy';
import { syntheticMappingFile } from '../fixtures/legacy/synthetic-support';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  validatePanelConnection,
  type TestContext,
} from './harness';

/**
 * Migration P7 — the legacy importer end to end, against PostgreSQL, two fake RickPanels
 * on real sockets, and the SYNTHETIC legacy dataset (`docs/legacy-migration/importer.md`).
 *
 * The provider fakes record every request; each case that reads them requires every one
 * to be a GET or the token exchange. NOT EVIDENCE about the legacy archive or RickPanel.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const GIB = 1024n ** 3n;

describe('Migration P7: the legacy importer', () => {
  let ctx: TestContext;
  let panelA: FakeRickpanel;
  let panelB: FakeRickpanel;
  let panelAId: string;
  let panelBId: string;
  let owner: ActorContext;
  let mapping: PanelMapping;
  let mappingText: string;

  const importerActor = (name: string) =>
    systemJobActor(`legacy-import:${name}`, `corr-${name}` as CorrelationId);

  beforeAll(async () => {
    ctx = await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  afterEach(async () => {
    await panelA?.close();
    await panelB?.close();
  });

  async function rickpanel(
    host: string,
    names: readonly string[],
    key: string,
  ): Promise<{ fake: FakeRickpanel; id: string }> {
    const fake = await startFakeRickpanel({ host });
    for (const name of names) fake.seedUser(name);
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: `Rick ${key}`,
      providerType: 'rickpanel',
      baseUrl: fake.baseUrl,
      credentials: { username: fake.username, password: fake.password },
      activation: {},
      idempotencyKey: `legacy-panel-${key}`,
    });
    await validatePanelConnection(ctx.container, tenantA, created.view.panel.id);
    return { fake, id: created.view.panel.id };
  }

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-legacy', roleKeys: ['owner'] }),
    );
    const a = await rickpanel('127.0.0.2', SYNTHETIC_PANEL_ACCOUNTS.A, 'a');
    const b = await rickpanel('127.0.0.3', SYNTHETIC_PANEL_ACCOUNTS.B, 'b');
    panelA = a.fake;
    panelB = b.fake;
    panelAId = a.id;
    panelBId = b.id;
    mappingText = syntheticMappingFile(tenantA.tenantId as unknown as string, panelAId, panelBId);
    mapping = parsePanelMapping(mappingText, tenantA.tenantId as unknown as string);

    // The current public tariff the 30 GB / 30 d shapes resolve to.
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ۳۰',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 1,
        panelId: null,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 30n * GIB, deviceLimit: null },
        price: money(200_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());

    // A legacy user who already used NEXA: matched, never re-created, never overwritten.
    await ctx.container.customers.resolveFromUpdate(tenantA, importerActor('webhook'), {
      idempotencyKey: 'legacy-existing',
      telegramUserId: SYNTHETIC_EXISTING_CUSTOMER,
      from: {
        id: Number(SYNTHETIC_EXISTING_CUSTOMER),
        first_name: 'Existing',
        username: 'existing_nexa',
      },
      botInstanceId: BOT_A,
    });
  });

  async function snapshot(
    dataset: SyntheticLegacyDataset = buildSyntheticLegacyDataset(),
  ): Promise<LegacySnapshot> {
    const connector = new FixtureLegacySourceConnector(dataset as never);
    return readFromSession(connector.label, await connector.open());
  }

  function importer(adoption: LegacyAdoptionPort | null = null): LegacyImporterService {
    return ctx.container.legacyImporter({ adoption, inventoryPageSize: 3 });
  }

  async function count(table: string, where = 'true'): Promise<number> {
    const result = await ctx.container.database.db.execute<{ n: number }>(
      sql.raw(
        `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = '${tenantA.tenantId as unknown as string}' AND ${where}`,
      ),
    );
    return result.rows[0]?.n ?? 0;
  }

  async function walletTotal(): Promise<bigint> {
    const result = await ctx.container.database.db.execute<{ t: string }>(sql`
      SELECT COALESCE(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS t
        FROM wallet_entries WHERE tenant_id = ${tenantA.tenantId as unknown as string}
    `);
    return BigInt(result.rows[0]?.t ?? '0');
  }

  function expectOnlyReads(): void {
    for (const fake of [panelA, panelB]) {
      const writes = fake.requests.filter(
        (r) => !(r.method === 'GET' || (r.method === 'POST' && r.path === '/api/admin/token')),
      );
      expect(writes, 'a provider write was sent').toEqual([]);
    }
  }

  function input(name: string, snap: LegacySnapshot, map: PanelMapping = mapping) {
    return { scope: tenantA, actor: importerActor(name), snapshot: snap, mapping: map };
  }

  it('audit reads the source, NEXA and the panels, and writes nothing at all', async () => {
    const before = await Promise.all([
      count('customers'),
      count('wallet_entries'),
      count('legacy_import_runs'),
      count('products'),
    ]);
    const report = await importer().audit({
      ...input('audit', await snapshot()),
      evidence: { available: false, reason: 'SOURCE_ENGINE_NOT_SQL' },
    });
    const after = await Promise.all([
      count('customers'),
      count('wallet_entries'),
      count('legacy_import_runs'),
      count('products'),
    ]);
    expect(after).toEqual(before);
    expect(report.synthetic).toBe(true);
    expect(report.verdict).toBe('READY_FOR_DRY_RUN');
    const sections = report.sections as Record<string, any>;
    expect(sections['plan'].services.categories).toEqual(SYNTHETIC_EXPECTED.services.categories);
    expect(sections['provider']).toMatchObject({ writes: 0, refusedWrites: 0 });
    expect(sections['provider'].reads).toBeGreaterThan(0);
    expectOnlyReads();
  });

  it('dry-run decides everything on a DRY_RUN run row and writes no business row', async () => {
    const report = await importer().dryRun(input('dry', await snapshot()));
    expect(await count('customers')).toBe(1);
    expect(await count('wallet_entries')).toBe(0);
    expect(await count('legacy_product_shapes')).toBe(0);
    expect(await count('legacy_import_map')).toBe(0);
    const run = (report.sections as Record<string, any>)['run'];
    expect(run).toMatchObject({ mode: 'DRY_RUN', status: 'COMPLETED' });
    const users = SYNTHETIC_EXPECTED.users;
    const services = SYNTHETIC_EXPECTED.services.categories;
    expect(run.rowsImported).toBe(users.imported + services.ADOPTION_ELIGIBLE);
    expect(run.rowsSkipped).toBe(services.TEST_INVOICE_SKIPPED + services.TEST_PANEL_SKIPPED);
    expect(run.rowsImported + run.rowsSkipped + run.rowsManualReview).toBe(
      users.source + SYNTHETIC_EXPECTED.services.candidates,
    );
    expect(await count('legacy_import_run_inputs')).toBe(1);
    expectOnlyReads();
  });

  it('import applies every phase once; a rerun duplicates nothing; reconcile and report agree', async () => {
    const preTotal = await walletTotal();
    const snap = await snapshot();
    const report = await importer().apply({ ...input('import', snap), mode: 'IMPORT' });
    expect(report.verdict).toBe('COMPLETED_ADOPTION_PENDING_P6');
    const applied = (report.sections as Record<string, any>)['applied'];
    const users = SYNTHETIC_EXPECTED.users;
    expect(applied.customers).toMatchObject({
      created: users.newCustomers,
      matchedExisting: 1,
      manualReviewRecorded: 2,
      sourceChanged: 0,
    });
    expect(applied.openings).toMatchObject({
      POSTED: 6,
      ALREADY_POSTED: 0,
      ZERO_NO_ENTRY: 2,
      CONFLICT: 0,
    });
    expect(applied.openings.postedSumMinor).toBe(users.legacyBalanceSumMinor);
    expect(applied.trials.APPLIED).toBe(users.imported);
    expect(applied.trials.decisions).toMatchObject({
      INHERIT_NEXA_POLICY: 4,
      LEGACY_TRIAL_CONSUMED: 2,
      LEGACY_NO_TRIALS: 1,
      LEGACY_LIMIT_UNREADABLE: 1,
    });
    expect(applied.products).toMatchObject({ created: 6, existing: 0 });
    expect(applied.services.categories).toEqual(SYNTHETIC_EXPECTED.services.categories);
    expect(applied.services.adoption).toMatchObject({ wired: false, PENDING: 4, ADOPTED: 0 });

    // NEXA now holds exactly that.
    expect(await count('customers')).toBe(1 + users.newCustomers);
    expect(await count('wallet_entries', "reason = 'MIGRATION_OPENING_BALANCE'")).toBe(6);
    expect(await walletTotal()).toBe(preTotal + users.legacyBalanceSumMinor);
    expect(await count('legacy_import_map', "legacy_table = 'user' AND status = 'IMPORTED'")).toBe(
      users.imported,
    );
    expect(
      await count('legacy_import_map', "legacy_table = 'user' AND status = 'MANUAL_REVIEW'"),
    ).toBe(2);
    // The invoice decisions the importer made, on the invoice's own map row; the ones whose
    // closed code arrives with the review queue are counted, not misfiled.
    expect(
      await count('legacy_import_map', "legacy_table = 'invoice' AND status = 'SKIPPED'"),
    ).toBe(2);
    expect(
      await count('legacy_import_map', "legacy_table = 'invoice' AND status = 'MANUAL_REVIEW'"),
    ).toBe(7);
    expect(
      await count('legacy_import_map', "legacy_table = 'invoice' AND status = 'IMPORTED'"),
    ).toBe(0);
    expect(applied.services.map).toMatchObject({
      INSERTED: 9,
      keyInvalid: 1,
      pendingReasonCode: {
        CUSTOMER_MISSING: 2,
        UNSUPPORTED_SHAPE: 2,
        PRODUCT_MAPPING_UNRESOLVED: 1,
      },
    });
    expect(await count('legacy_product_shapes')).toBe(6);
    expect(await count('legacy_product_shapes', "tariff_status = 'RESOLVED'")).toBe(5);
    expect(await count('outbox_messages', "event_type = 'CustomerImported'")).toBe(
      users.newCustomers,
    );
    // No adoption happened: no order, no service.
    expect(await count('orders')).toBe(0);
    expect(await count('services')).toBe(0);
    // The existing customer kept its own profile.
    const existing = await ctx.container.database.db.execute<{
      username: string;
      first_bot_instance_id: string;
    }>(sql`
      SELECT username, first_bot_instance_id FROM customers WHERE telegram_user_id = ${SYNTHETIC_EXISTING_CUSTOMER}`);
    expect(existing.rows[0]).toEqual({ username: 'existing_nexa', first_bot_instance_id: BOT_A });
    // No raw phone and no legacy username on any imported row beyond the profile name.
    const phones = await count('customers', 'phone_number IS NOT NULL');
    expect(phones).toBe(0);
    // No Telegram id of an imported user in any audit row or domain event the import wrote.
    for (const id of ['100000001', '100000003', '100000011']) {
      const leaked = await ctx.container.database.db.execute<{ n: number }>(sql`
        SELECT (SELECT count(*) FROM audit_logs WHERE coalesce(after::text, '') LIKE ${'%' + id + '%'})
             + (SELECT count(*) FROM outbox_messages WHERE payload::text LIKE ${'%' + id + '%'}) AS n`);
      expect(Number(leaked.rows[0]?.n), id).toBe(0);
    }

    // A rerun of the same source is a new run that writes nothing new.
    const rerun = await importer().apply({ ...input('rerun', snap), mode: 'IMPORT' });
    const again = (rerun.sections as Record<string, any>)['applied'];
    expect(again.customers).toMatchObject({ created: 0, matchedExisting: users.imported });
    expect(again.openings).toMatchObject({ POSTED: 0, ALREADY_POSTED: 6 });
    expect(again.trials).toMatchObject({ APPLIED: 0, REPLAYED: users.imported });
    expect(again.products).toMatchObject({ created: 0, existing: 6 });
    expect(again.services.map).toMatchObject({ INSERTED: 0, UNCHANGED: 9, REFUSED: 0 });
    expect(await count('wallet_entries')).toBe(6);
    expect(await count('customers')).toBe(1 + users.newCustomers);
    expect(await walletTotal()).toBe(preTotal + users.legacyBalanceSumMinor);

    const reconcile = await importer().reconcile(input('reconcile', snap));
    expect(reconcile.verdict).toBe('RECONCILED');
    const checks = (reconcile.sections as Record<string, any>)['checks'] as {
      id: string;
      ok: boolean;
    }[];
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.id)).toContain('provider.writes');

    const finalReport = await importer().finalReport({
      ...input('report', snap),
      targetClass: 'staging',
    });
    // C3 does not hold on the synthetic set on purpose: it carries one non-Telegram id.
    expect(finalReport.verdict).toBe('COMPLETED_WITH_DISCREPANCY');
    const final = finalReport.final as Record<string, any>;
    expect(final['schemaVersion']).toBe('1');
    expect(final['evidenceClass']).toBe('synthetic');
    expect(final['run']).toMatchObject({
      mode: 'APPLY',
      status: 'COMPLETED',
      tenant: 'acme',
      resumes: 0,
    });
    expect(final['provider']).toMatchObject({ writes: 0, inventoriesComplete: true });
    expect(final['provider'].reads).toBeGreaterThan(0);
    expect(final['customers']).toEqual({
      source: 11,
      existing: 1,
      created: 7,
      blocked: 1,
      skipped: 0,
      manualReview: 2,
      errors: 0,
    });
    expect(final['wallet']).toMatchObject({
      currency: 'IRT',
      importedTotalMinor: String(users.legacyBalanceSumMinor),
      openingEntries: 6,
      duplicatesPrevented: 6,
      expectedPostImportTotalMinor: final['wallet'].actualPostImportTotalMinor,
    });
    expect(final['services']).toMatchObject({
      candidates: 19,
      adopted: 0,
      testSkipped: 2,
      ambiguous: 2,
      mappingMissing: 1,
    });
    expect(final['manualReview'].byReason).toMatchObject({
      ADOPTION_PENDING_P6: 4,
      INVOICE_KEY_INVALID: 1,
    });
    const failed = (final['reconciliation'] as { id: string; holds: boolean }[])
      .filter((r) => !r.holds)
      .map((r) => r.id);
    expect(failed).toEqual(['C3']);
    // Aggregates only: no Telegram id of the dataset appears anywhere in the report.
    const text = JSON.stringify(final);
    for (const id of ['100000001', '100000005', '999999999']) expect(text).not.toContain(id);
    expectOnlyReads();
  });

  it('an interrupted import stays RUNNING; resume finishes it with no duplicate money, customer or product', async () => {
    const snap = await snapshot();
    const failing = importer();
    await expect(
      failing.apply({
        ...input('crash', snap),
        mode: 'IMPORT',
        afterPhase: (phase) => {
          if (phase === 'openings') throw new Error('simulated crash after the openings phase');
        },
      }),
    ).rejects.toBeInstanceOf(LegacyImportInterrupted);
    expect(await count('legacy_import_runs', "status = 'RUNNING' AND mode = 'APPLY'")).toBe(1);
    expect(await count('wallet_entries')).toBe(6);
    expect(await count('legacy_product_shapes')).toBe(0);

    // A fresh import is refused while that run is RUNNING; it says to resume.
    await expect(importer().apply({ ...input('again', snap), mode: 'IMPORT' })).rejects.toThrow(
      /--mode resume/u,
    );
    // A resume under a different mapping is refused.
    const otherMapping = parsePanelMapping(
      JSON.stringify({ ...JSON.parse(mappingText), testPanels: ['tst', 'tst2'] }),
      tenantA.tenantId as unknown as string,
    );
    await expect(
      importer().apply({ ...input('remap', snap, otherMapping), mode: 'RESUME' }),
    ).rejects.toThrow(/different panel mapping/u);
    // A resume of a CHANGED source is refused (the repository's fingerprint rule).
    const changed = buildSyntheticLegacyDataset();
    const drifted = {
      ...changed,
      tables: {
        ...changed.tables,
        user: changed.tables.user.map((u, i) => (i === 0 ? { ...u, Balance: '1' } : u)),
      },
    };
    await expect(
      importer().apply({ ...input('drift', await snapshot(drifted)), mode: 'RESUME' }),
    ).rejects.toThrow();

    const resumed = await importer().apply({ ...input('resume', snap), mode: 'RESUME' });
    const applied = (resumed.sections as Record<string, any>)['applied'];
    expect((resumed.sections as Record<string, any>)['run'].status).toBe('COMPLETED');
    expect(applied.openings).toMatchObject({ POSTED: 0, ALREADY_POSTED: 6 });
    expect(applied.customers.created).toBe(0);
    expect(applied.products.created).toBe(6);
    expect(await count('wallet_entries')).toBe(6);
    expect(await count('customers')).toBe(1 + SYNTHETIC_EXPECTED.users.newCustomers);
    expect(await count('legacy_import_runs', "status = 'RUNNING'")).toBe(0);
    // One APPLY run per cycle: the resume finished the SAME run, and the report counts it.
    expect(await count('legacy_import_runs', "mode = 'APPLY'")).toBe(1);
    const after = await importer().finalReport({
      ...input('report', snap),
      targetClass: 'staging',
    });
    expect((after.final as Record<string, any>)['run']).toMatchObject({
      resumes: 1,
      status: 'COMPLETED',
    });
    expect((await importer().reconcile(input('reconcile', snap))).verdict).toBe('RECONCILED');
  });

  it('the CLI glue: one snapshot per mode, the tenant by slug, report JSON in the schema shape', async () => {
    const connector = new FixtureLegacySourceConnector(buildSyntheticLegacyDataset() as never);
    const base = [
      '--tenant',
      'acme',
      '--source',
      'fixture:tests/fixtures/legacy/synthetic-legacy.json',
      '--target',
      'nexa_p4_import',
      '--panel-map',
      'unused.json',
    ];
    const tenantId = await importer().resolveTenant('acme');
    expect(tenantId).toBe(tenantA.tenantId as unknown as string);
    expect(await importer().resolveTenant('no-such-tenant')).toBeNull();
    const context = { tenantId: tenantId as string, targetClass: 'staging' as const };
    const audit = await runMode(
      importer(),
      parseArgs(['audit', ...base]),
      connector,
      mappingText,
      'corr-a',
      context,
    );
    expect(audit?.mode).toBe('AUDIT');
    await runMode(
      importer(),
      parseArgs(['import', ...base]),
      connector,
      mappingText,
      'corr-i',
      context,
    );
    const report = await runMode(
      importer(),
      parseArgs(['report', ...base, '--format', 'json']),
      connector,
      mappingText,
      'corr-r',
      context,
    );
    expect(report?.final).toBeDefined();
    const final = report?.final as Record<string, any>;
    expect(Object.keys(final).sort()).toEqual(
      [
        'customers',
        'evidenceClass',
        'generatedAt',
        'manualReview',
        'products',
        'provider',
        'reconciliation',
        'run',
        'schemaVersion',
        'services',
        'source',
        'trials',
        'wallet',
      ].sort(),
    );
    expect(final['provider'].writes).toBe(0);
    expectOnlyReads();
  });
  it('the wallet equation holds with a pre-existing NEXA balance and activity after the import', async () => {
    const existingId = (
      await ctx.container.database.db.execute<{ id: string }>(
        sql`SELECT id FROM customers WHERE telegram_user_id = ${SYNTHETIC_EXISTING_CUSTOMER}`,
      )
    ).rows[0]?.id as string;
    const credit = (key: string, amount: bigint) =>
      ctx.container.wallet.adjust(tenantA, owner, existingId as never, {
        idempotencyKey: key,
        direction: 'CREDIT',
        amountMinor: amount,
        currency: 'IRT',
        note: 'fixture',
      });
    await credit('pre-import', 10_000n);
    const snap = await snapshot();
    await importer().apply({ ...input('import', snap), mode: 'IMPORT' });
    // NEXA balance + legacy balance for the existing customer, additive.
    expect(await walletTotal()).toBe(10_000n + SYNTHETIC_EXPECTED.users.legacyBalanceSumMinor);
    await credit('post-import', 500n);
    const reconcile = await importer().reconcile(input('reconcile', snap));
    expect(reconcile.verdict).toBe('RECONCILED');
    const wallet = (reconcile.sections as Record<string, any>)['wallet'];
    expect(wallet).toMatchObject({
      preImportTotalMinor: 10_000n,
      nonOpeningMovementSinceRunMinor: 500n,
      actualTotalMinor: 10_500n + SYNTHETIC_EXPECTED.users.legacyBalanceSumMinor,
    });
    const report = await importer().finalReport({
      ...input('report', snap),
      targetClass: 'staging',
    });
    const final = report.final as Record<string, any>;
    expect(final['wallet'].preImportTotalMinor).toBe('10500');
    expect(final['reconciliation'].find((r: { id: string }) => r.id === 'W1')).toMatchObject({
      holds: true,
    });
  });

  it('resume with nothing RUNNING is refused, and changes nothing', async () => {
    await expect(
      importer().apply({ ...input('resume', await snapshot()), mode: 'RESUME' }),
    ).rejects.toThrow(/no RUNNING import/u);
    expect(await count('legacy_import_runs')).toBe(0);
  });

  it('a source whose balances changed after import is surfaced, never absorbed', async () => {
    await importer().apply({ ...input('import', await snapshot()), mode: 'IMPORT' });
    const changed = buildSyntheticLegacyDataset();
    const drifted = {
      ...changed,
      tables: {
        ...changed.tables,
        user: changed.tables.user.map((u) =>
          u['id'] === '100000001' ? { ...u, Balance: '99' } : u,
        ),
      },
    };
    const report = await importer().apply({
      ...input('drift', await snapshot(drifted)),
      mode: 'IMPORT',
    });
    const applied = (report.sections as Record<string, any>)['applied'];
    expect(applied.customers.sourceChanged).toBe(1);
    // Nothing further is written for that user: the opening stays as first posted.
    const opening = await ctx.container.database.db.execute<{ amount: string }>(sql`
      SELECT amount::text FROM wallet_entries WHERE reference = 'legacy:opening:100000001'`);
    expect(opening.rows).toEqual([{ amount: '50000' }]);
  });

  it('reconcile reports a discrepancy instead of passing over one', async () => {
    const snap = await snapshot();
    await importer().apply({ ...input('import', snap), mode: 'IMPORT' });
    // An opening nobody imported appears (a second writer, a hand-made row).
    const stray = await ctx.container.customers.resolveFromUpdate(tenantA, importerActor('w2'), {
      idempotencyKey: 'stray',
      telegramUserId: '777777777',
      from: { id: 777777777, first_name: 'Stray' },
      botInstanceId: BOT_A,
    });
    await ctx.container.migrationOpeningBalance.post(tenantA, importerActor('stray'), {
      customerId: stray.customer.id,
      telegramUserId: '777777777',
      legacyBalanceMinor: 1_000n,
      currency: 'IRT',
    });
    const report = await importer().reconcile(input('reconcile', snap));
    expect(report.verdict).toBe('DISCREPANCY');
    const failed = (
      (report.sections as Record<string, any>)['checks'] as { id: string; ok: boolean }[]
    )
      .filter((c) => !c.ok)
      .map((c) => c.id);
    expect(failed).toEqual(
      expect.arrayContaining(['wallet.openings_sum', 'wallet.openings_count']),
    );
  });

  it('with P6 wired, every eligible candidate reaches the adoption port with a resolved product', async () => {
    const seen: LegacyAdoptionCandidate[] = [];
    const adoption: LegacyAdoptionPort = {
      adopt: (_scope, actor, candidate) => {
        expect(actor.type).toBe('SYSTEM_JOB');
        seen.push(candidate);
        return Promise.resolve({ kind: 'ADOPTED' as const });
      },
    };
    const report = await importer(adoption).apply({
      ...input('adopt', await snapshot()),
      mode: 'IMPORT',
    });
    expect(report.verdict).toBe('COMPLETED');
    expect(seen).toHaveLength(SYNTHETIC_EXPECTED.services.categories.ADOPTION_ELIGIBLE);
    for (const candidate of seen) {
      expect([panelAId, panelBId]).toContain(candidate.panelId);
      expect(candidate.customerId).toMatch(/^[0-9a-f-]{36}$/u);
      if (candidate.product.kind === 'HIDDEN_SHAPE')
        expect(candidate.product.shapeId).toMatch(/^[0-9a-f-]{36}$/u);
    }
    expect(seen.map((c) => c.providerUsername).sort()).toEqual([
      'svc_a1',
      'svc_a2',
      'svc_a3',
      'svc_nullmatch',
    ]);
    expect(seen.filter((c) => c.product.kind === 'NAMED_PRODUCT')).toHaveLength(1);
    expectOnlyReads();
  });

  it('refuses a mapping that names a panel that is not an ACTIVE RickPanel of the tenant', async () => {
    await ctx.container.database.db.execute(
      sql`UPDATE panels SET status = 'DISABLED' WHERE id = ${panelBId}`,
    );
    await expect(
      importer().audit({
        ...input('audit', await snapshot()),
        evidence: { available: false, reason: 'SOURCE_ENGINE_NOT_SQL' },
      }),
    ).rejects.toThrow(/not ACTIVE/u);
  });

  it('every write is charged to maintenance.run: an operator without it is denied and nothing is written', async () => {
    const support = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'observer-legacy',
        roleKeys: ['observer'],
      }),
    );
    await expect(
      importer().dryRun({ ...input('dry', await snapshot()), actor: support }),
    ).rejects.toThrow();
    expect(await count('legacy_import_runs')).toBe(0);
  });

  it('a stopped tenant accepts no import write', async () => {
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId as unknown as string}`,
    );
    await expect(
      importer().apply({ ...input('import', await snapshot()), mode: 'IMPORT' }),
    ).rejects.toThrow();
    expect(
      await count('customers', "telegram_user_id <> '" + SYNTHETIC_EXISTING_CUSTOMER + "'"),
    ).toBe(0);
  });
});
