import { sql } from 'drizzle-orm';
import { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  systemJobActor,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import {
  exitCodeFor,
  exitCodeForError,
  importerOptions,
  parseArgs,
  runMode,
} from '../../apps/api/src/legacy-import.cli';
import { parseReviewArgs, runReview } from '../../apps/api/src/legacy-import-review';
import { DrizzleLegacyImportRepository } from '../../apps/api/src/modules/platform/legacy-import/infrastructure/drizzle-legacy-import.repository';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import {
  LegacyImportInterrupted,
  type LegacyImporterService,
} from '../../apps/api/src/modules/platform/legacy-importer/application/legacy-importer.service';
import {
  PanelMappingRefused,
  parsePanelMapping,
  type PanelMapping,
} from '../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import { LegacySourceRefused } from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';
import type {
  LegacyAdoptionCandidate,
  LegacyAdoptionOutcome,
  LegacyAdoptionPort,
} from '../../apps/api/src/modules/platform/legacy-importer/application/ports';
import {
  readFromSession,
  type LegacySnapshot,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import {
  LEGACY_IMPORT_PROCESS_LOCK_CLASS,
  PgLegacyImportProcessLock,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/pg-legacy-import-process-lock';
import {
  SYNTHETIC_EXISTING_CUSTOMER,
  SYNTHETIC_EXPECTED,
  SYNTHETIC_PANEL_ACCOUNTS,
  buildSyntheticLegacyDataset,
  type SyntheticLegacyDataset,
} from '../fixtures/legacy/synthetic-legacy';
import { syntheticMappingFile } from '../fixtures/legacy/synthetic-support';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import { changedTables, databaseFingerprint } from '../support/database-fingerprint';
import {
  PANEL_STATE_SCHEMA,
  comparePanelStates,
  panelState,
  type PanelStateSnapshot,
} from '../support/legacy-rehearsal-panel-state';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { RickpanelAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel.adapter';
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
    // Live accounts with an expiry and a data limit: P6 adopts an account only when its
    // expiry matches a renewable (dated) product, and the products below are 30-day ones.
    for (const name of names) {
      fake.seedUser(name, {
        expire: Math.floor(Date.UTC(2027, 0, 1) / 1000),
        dataLimit: 30 * 1024 ** 3,
        usedTraffic: 1024 ** 3,
      });
    }
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

  async function setup(): Promise<void> {
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

    // The current public tariff the 30 GB / 30 d shapes resolve to.
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ۳۰',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 1,
        // Bound to a panel and categorised: a tariff is a product a customer can buy today.
        panelId: panelAId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 30n * GIB, deviceLimit: null },
        price: money(200_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    // The named legacy product p1 renews as this product: the owner's explicit map.
    mappingText = syntheticMappingFile(
      tenantA.tenantId as unknown as string,
      panelAId,
      panelBId,
      product.id,
    );
    mapping = parsePanelMapping(mappingText, tenantA.tenantId as unknown as string);

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
  }
  beforeEach(setup);

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
    // WP-D3: EVERY table, not a chosen few — a write anywhere (a probe budget, an
    // operational event, a cache row) breaks "audit is read-only".
    const everything = await databaseFingerprint(ctx.container.database.db);
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
    expect(changedTables(everything, await databaseFingerprint(ctx.container.database.db))).toEqual(
      {},
    );
    expect(report.synthetic).toBe(true);
    expect(report.verdict).toBe('READY_FOR_DRY_RUN');
    const sections = report.sections as Record<string, any>;
    expect(sections['plan'].services.categories).toEqual(SYNTHETIC_EXPECTED.services.categories);
    expect(sections['provider']).toMatchObject({ writes: 0, refusedWrites: 0 });
    expect(sections['provider'].reads).toBeGreaterThan(0);
    expectOnlyReads();
  });

  it('WP-D2: an audit BLOCKS on a live code_panel the map does not account for, and passes once it is declared', async () => {
    const snap = await snapshot();
    const forgot = parsePanelMapping(
      JSON.stringify(
        (({ unresolvedPanels: _drop, ...rest }) => rest)(
          JSON.parse(mappingText) as Record<string, unknown>,
        ),
      ),
      tenantA.tenantId as unknown as string,
    );
    const blocked = await importer().audit({
      ...input('audit-forgot', snap, forgot),
      evidence: { available: false, reason: 'SOURCE_ENGINE_NOT_SQL' },
    });
    expect(blocked.verdict).toBe('BLOCKED');
    const blockedSections = blocked.sections as Record<string, any>;
    expect(blockedSections['panelMapping'].completeness).toMatchObject({
      complete: false,
      unmapped: { zzz: 1 },
      declaredUnresolved: {},
    });
    expect(blockedSections['blockers']).toEqual([expect.stringContaining('"zzz": 1 invoice(s)')]);

    const declared = await importer().audit({
      ...input('audit-declared', snap),
      evidence: { available: false, reason: 'SOURCE_ENGINE_NOT_SQL' },
    });
    expect(declared.verdict).toBe('READY_FOR_DRY_RUN');
    const sections = declared.sections as Record<string, any>;
    expect(sections['panelMapping'].completeness).toEqual({
      complete: true,
      unmapped: {},
      declaredUnresolved: { zzz: { reason: 'OWNER_DECIDES_LATER', liveRealInvoices: 1 } },
      stale: [],
      productionPanelsUnreferenced: [],
    });
    expect(sections['panelMapping'].declaredUnresolvedCodes).toBe(1);
    // Declaring a code decides nothing about its invoices: they stay PANEL_UNMAPPED review.
    expect(sections['plan'].services.categories).toEqual(SYNTHETIC_EXPECTED.services.categories);

    // A map entry no live invoice carries is reported as stale, and does not block.
    const stale = parsePanelMapping(
      JSON.stringify({ ...JSON.parse(mappingText), testPanels: ['tst', 'old-test'] }),
      tenantA.tenantId as unknown as string,
    );
    const withStale = await importer().audit({
      ...input('audit-stale', snap, stale),
      evidence: { available: false, reason: 'SOURCE_ENGINE_NOT_SQL' },
    });
    expect(withStale.verdict).toBe('READY_FOR_DRY_RUN');
    expect((withStale.sections as Record<string, any>)['panelMapping'].completeness.stale).toEqual([
      'old-test',
    ]);
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
    // Owner decision 6: the negative balance is a legacy debt, never a ledger entry.
    expect(applied.openings).toMatchObject({
      POSTED: 5,
      ALREADY_POSTED: 0,
      ZERO_NO_ENTRY: 2,
      CONFLICT: 0,
      DEBT_RECORDED: 1,
      DEBT_ALREADY_RECORDED: 0,
      PRIOR_DEBIT_OPENING: 0,
    });
    expect(applied.openings.postedSumMinor).toBe(users.positiveBalanceSumMinor);
    expect(applied.openings.debtRecordedSumMinor).toBe(users.debtSumMinor);
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
    expect(await count('wallet_entries', "reason = 'MIGRATION_OPENING_BALANCE'")).toBe(5);
    expect(await count('wallet_entries', "direction = 'DEBIT'")).toBe(0);
    expect(await count('legacy_wallet_debts')).toBe(1);
    expect(await walletTotal()).toBe(preTotal + users.positiveBalanceSumMinor);
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
    ).toBe(12);
    // Every review row carries its closed review reason and enters review OPEN.
    expect(
      await count(
        'legacy_import_map',
        "legacy_table = 'invoice' AND status = 'MANUAL_REVIEW' AND review_state = 'OPEN'",
      ),
    ).toBe(12);
    for (const [reason, n] of [
      ['CUSTOMER_MISSING', 2],
      ['UNSUPPORTED_SHAPE', 2],
      ['PRODUCT_MAPPING_UNRESOLVED', 1],
      ['PROVIDER_MISSING', 2],
      ['INVALID_SOURCE_ROW', 2],
    ] as const) {
      expect(
        await count('legacy_import_map', `legacy_table = 'invoice' AND reason_code = '${reason}'`),
        reason,
      ).toBe(n);
    }
    expect(
      await count('legacy_import_map', "legacy_table = 'invoice' AND status = 'IMPORTED'"),
    ).toBe(0);
    expect(applied.services.map).toMatchObject({
      INSERTED: 14,
      keyInvalid: 1,
      reviewClosed: 0,
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
    expect(again.openings).toMatchObject({
      POSTED: 0,
      ALREADY_POSTED: 5,
      DEBT_RECORDED: 0,
      DEBT_ALREADY_RECORDED: 1,
    });
    expect(again.trials).toMatchObject({ APPLIED: 0, REPLAYED: users.imported });
    expect(again.products).toMatchObject({ created: 0, existing: 6 });
    expect(again.services.map).toMatchObject({ INSERTED: 0, UNCHANGED: 14, REFUSED: 0 });
    expect(await count('wallet_entries')).toBe(5);
    expect(await count('legacy_wallet_debts')).toBe(1);
    expect(await count('customers')).toBe(1 + users.newCustomers);
    expect(await walletTotal()).toBe(preTotal + users.positiveBalanceSumMinor);

    const reconcile = await importer().reconcile(input('reconcile', snap));
    expect(reconcile.verdict).toBe('RECONCILED');
    const checks = (reconcile.sections as Record<string, any>)['checks'] as {
      id: string;
      ok: boolean;
    }[];
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.id)).toContain('provider.writes');
    // Mirza PR4: the users-and-wallets section — every source row accounted for, the
    // positives in the ledger, the negative as a debt, no DEBIT opening. Aggregates only.
    const uw = (reconcile.sections as Record<string, any>)['usersWallets'];
    expect(uw.version).toBe('nexa-legacy-users-wallets/v1');
    expect(uw.holds).toBe(true);
    expect(uw.users.outcomes).toEqual({
      IMPORTED_NEW: users.newCustomers,
      IMPORTED_EXISTING: users.existing,
      SKIPPED_INVALID_IDENTITY: users.invalidIdentity,
      SKIPPED_BALANCE_UNREADABLE: 1,
      SKIPPED_BALANCE_OUT_OF_RANGE: 1,
      SKIPPED_DUPLICATE_SOURCE_ID: 0,
      SKIPPED_REVIEW_CLOSED: 0,
      SOURCE_CHANGED: 0,
      NOT_YET_IMPORTED: 0,
    });
    expect(uw.wallet.positive).toMatchObject({
      users: users.opening.POSITIVE,
      sumMinor: String(users.positiveBalanceSumMinor),
      openingEntries: users.opening.POSITIVE,
      openingSumMinor: String(users.positiveBalanceSumMinor),
    });
    expect(uw.wallet.legacyDebts).toMatchObject({
      users: 1,
      sumMinor: String(users.debtSumMinor),
      recorded: 1,
      recordedSumMinor: String(users.debtSumMinor),
      byState: { PENDING_REVIEW: { count: 1, sumMinor: String(users.debtSumMinor) } },
    });
    expect(uw.wallet.ledgerDebitOpenings).toBe(0);
    expect(uw.users.agents.resellerGrants).toBe('NONE');
    for (const id of ['100000001', '100000005', '999999999']) {
      expect(JSON.stringify(uw)).not.toMatch(new RegExp(`(?<![0-9])${id}(?![0-9])`, 'u'));
    }

    const finalReport = await importer().finalReport({
      ...input('report', snap),
      evidenceClass: 'synthetic',
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
      importedTotalMinor: String(users.positiveBalanceSumMinor),
      negative: { count: 1, sumMinor: String(-users.debtSumMinor) },
      openingEntries: 5,
      duplicatesPrevented: 5,
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
    // Aggregates only: no Telegram id of the dataset appears anywhere in the report — as a
    // whole number, not as digits inside a sum (Σ not-imported now holds the out-of-range
    // balance, whose digits happen to contain one of these ids).
    const text = JSON.stringify(final);
    for (const id of ['100000001', '100000005', '999999999']) {
      expect(text).not.toMatch(new RegExp(`(?<![0-9])${id}(?![0-9])`, 'u'));
    }
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
    expect(await count('wallet_entries')).toBe(5);
    expect(await count('legacy_wallet_debts')).toBe(1);
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
    // WP-D3: refused for THAT reason (any error used to pass here), and before any write.
    const beforeDrift = await databaseFingerprint(ctx.container.database.db);
    const drift = importer()
      .apply({ ...input('drift', await snapshot(drifted)), mode: 'RESUME' })
      .catch((e: unknown) => e);
    expect(await drift).toMatchObject({
      code: 'legacy_import.run_conflict',
      message: expect.stringContaining('a different source or mode'),
    });
    expect(
      changedTables(beforeDrift, await databaseFingerprint(ctx.container.database.db)),
    ).toEqual({});

    const resumed = await importer().apply({ ...input('resume', snap), mode: 'RESUME' });
    const applied = (resumed.sections as Record<string, any>)['applied'];
    expect((resumed.sections as Record<string, any>)['run'].status).toBe('COMPLETED');
    expect(applied.openings).toMatchObject({
      POSTED: 0,
      ALREADY_POSTED: 5,
      DEBT_ALREADY_RECORDED: 1,
      DEBT_RECORDED: 0,
    });
    expect(applied.customers.created).toBe(0);
    expect(applied.products.created).toBe(6);
    expect(await count('wallet_entries')).toBe(5);
    expect(await count('legacy_wallet_debts')).toBe(1);
    expect(await count('customers')).toBe(1 + SYNTHETIC_EXPECTED.users.newCustomers);
    expect(await count('legacy_import_runs', "status = 'RUNNING'")).toBe(0);
    // One APPLY run per cycle: the resume finished the SAME run, and the report counts it.
    expect(await count('legacy_import_runs', "mode = 'APPLY'")).toBe(1);
    const after = await importer().finalReport({
      ...input('report', snap),
      evidenceClass: 'synthetic',
    });
    expect((after.final as Record<string, any>)['run']).toMatchObject({
      resumes: 1,
      status: 'COMPLETED',
    });
    expect((await importer().reconcile(input('reconcile', snap))).verdict).toBe('RECONCILED');
  });

  // Runbooks review, item 11: the owner's approval is bound to the exact source and mapping.
  it('--expected-fingerprint binds import and resume to the approved source, refusing a mismatch with zero writes', async () => {
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
      '--evidence-class',
      'synthetic',
    ];
    const tenantId = await importer().resolveTenant('acme');
    const context = { tenantId: tenantId as string, productionLikeTarget: false };
    const snap = await snapshot();
    const wrong = 'f'.repeat(64);
    const writes = () =>
      Promise.all([
        count('legacy_import_runs'),
        count('legacy_import_map'),
        count('customers'),
        count('wallet_entries'),
        count('legacy_product_shapes'),
      ]);
    const before = await writes();

    for (const mode of ['import', 'resume']) {
      const source = runMode(
        importer(),
        parseArgs([mode, ...base, '--expected-fingerprint', wrong]),
        connector,
        mappingText,
        'corr-fp',
        context,
      );
      await expect(source).rejects.toBeInstanceOf(LegacySourceRefused);
      // The message names both values, so the operator sees which source they approved.
      await expect(source).rejects.toThrow(wrong);
      await expect(source).rejects.toThrow(snap.fingerprint);
      expect(exitCodeForError(await source.catch((e: unknown) => e))).toBe(65);

      const map = runMode(
        importer(),
        parseArgs([mode, ...base, '--expected-panel-map-fingerprint', wrong]),
        connector,
        mappingText,
        'corr-fp',
        context,
      );
      await expect(map).rejects.toBeInstanceOf(PanelMappingRefused);
      await expect(map).rejects.toThrow(mapping.fingerprint);
      expect(exitCodeForError(await map.catch((e: unknown) => e))).toBe(65);
    }
    // Refused before any write.
    expect(await writes()).toEqual(before);

    // A production-like target requires it: no approval bound to a source, no import.
    await expect(
      runMode(importer(), parseArgs(['import', ...base]), connector, mappingText, 'corr-fp', {
        ...context,
        productionLikeTarget: true,
      }),
    ).rejects.toThrow(/--expected-fingerprint is required/u);
    expect(await writes()).toEqual(before);

    // The approved values import.
    const ok = await runMode(
      importer(),
      parseArgs([
        'import',
        ...base,
        '--expected-fingerprint',
        snap.fingerprint,
        '--expected-panel-map-fingerprint',
        mapping.fingerprint,
      ]),
      connector,
      mappingText,
      'corr-fp',
      context,
    );
    expect(ok?.verdict).toMatch(/^COMPLETED/u);
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
    const context = { tenantId: tenantId as string, productionLikeTarget: false };
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
      parseArgs(['import', ...base, '--evidence-class', 'synthetic']),
      connector,
      mappingText,
      'corr-i',
      context,
    );
    const report = await runMode(
      importer(),
      parseArgs(['report', ...base, '--format', 'json', '--evidence-class', 'synthetic']),
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
    expect(final['evidenceClass']).toBe('synthetic');
    // A synthetic source can never be labelled staging or production, whatever is claimed.
    for (const claim of ['staging', 'production']) {
      await expect(
        runMode(
          importer(),
          parseArgs(['report', ...base, '--evidence-class', claim]),
          connector,
          mappingText,
          'corr-x',
          context,
        ),
      ).rejects.toThrow(/SYNTHETIC marker/u);
    }
    // And never run against a production-like target, even read-only.
    await expect(
      runMode(importer(), parseArgs(['audit', ...base]), connector, mappingText, 'corr-p', {
        ...context,
        productionLikeTarget: true,
      }),
    ).rejects.toThrow(/looks like production/u);
    // The service refuses the mislabel too, for any caller that is not the CLI.
    await expect(
      importer().finalReport({
        ...input('report', await snapshot()),
        evidenceClass: 'staging',
      }),
    ).rejects.toThrow(/SYNTHETIC marker/u);
    expectOnlyReads();
  });

  /** The list pages a fake was asked for, as `offset/limit` pairs. */
  function listPages(fake: FakeRickpanel, since = 0): string[] {
    return fake.requests
      .slice(since)
      .filter((r) => r.method === 'GET' && r.path.split('?')[0] === '/api/users')
      .map((r) => {
        const query = new URLSearchParams(r.path.split('?')[1] ?? '');
        return `${query.get('offset') ?? '?'}/${query.get('limit') ?? '?'}`;
      });
  }

  const CLI_BASE = [
    'audit',
    '--tenant',
    'acme',
    '--source',
    'fixture:tests/fixtures/legacy/synthetic-legacy.json',
    '--target',
    'nexa_p4_import',
    '--panel-map',
    'unused.json',
  ];

  it('hardening 2026-10-07: the CLI walks RickPanel with 200-row pages unless the operator says otherwise', async () => {
    const defaulted = ctx.container.legacyImporter({
      adoption: null,
      ...importerOptions(parseArgs(CLI_BASE)),
    });
    const report = await defaulted.audit({
      ...input('audit-200', await snapshot()),
      evidence: { available: false, reason: 'SOURCE_ENGINE_NOT_SQL' },
    });
    expect(report.verdict).toBe('READY_FOR_DRY_RUN');
    const provider = (report.sections as Record<string, any>)['provider'];
    expect(provider).toMatchObject({ inventoryPageSize: 200, writes: 0, refusedWrites: 0 });
    // Every list page the provider saw asked for 200 rows: two walks of one page each.
    expect(listPages(panelA)).toEqual(['0/200', '0/200']);
    expectOnlyReads();

    const since = panelA.requests.length;
    const explicit = ctx.container.legacyImporter({
      adoption: null,
      ...importerOptions(parseArgs([...CLI_BASE, '--inventory-page-size', '3'])),
    });
    const smaller = await explicit.audit({
      ...input('audit-3', await snapshot()),
      evidence: { available: false, reason: 'SOURCE_ENGINE_NOT_SQL' },
    });
    expect((smaller.sections as Record<string, any>)['provider'].inventoryPageSize).toBe(3);
    expect(listPages(panelA, since).every((page) => page.endsWith('/3'))).toBe(true);
    expect(listPages(panelA, since).length).toBeGreaterThan(2);
    expectOnlyReads();
  });

  it('hardening 2026-10-07: at the CLI default, a panel that changes mid-walk still BLOCKS the audit (TOTAL_CHANGED), once, with no retry', async () => {
    // More accounts than one 200-row page, so the walk has a second page to change under.
    for (let i = 0; i < 230; i += 1) panelA.seedUser(`bulk${String(i).padStart(3, '0')}`);
    const since = panelA.requests.length;
    let changed = false;
    panelA.beforeListPage = (offset) => {
      if (offset > 0 && !changed) {
        changed = true;
        panelA.seedUser('arrivedmidwalk');
      }
    };
    const everything = await databaseFingerprint(ctx.container.database.db);
    const report = await ctx.container
      .legacyImporter({ adoption: null, ...importerOptions(parseArgs(CLI_BASE)) })
      .audit({
        ...input('audit-total-changed', await snapshot()),
        evidence: { available: false, reason: 'SOURCE_ENGINE_NOT_SQL' },
      });
    panelA.beforeListPage = null;
    expect(report.verdict).toBe('BLOCKED');
    expect(exitCodeFor(report)).toBe(3);
    const sections = report.sections as Record<string, any>;
    expect(sections['blockers']).toContain(
      `inventory of panel ${panelAId} is incomplete (TOTAL_CHANGED)`,
    );
    expect(sections['provider'].inventoryPageSize).toBe(200);
    // Fail closed on the FIRST walk: two pages, then stop. No second walk, no retry.
    expect(listPages(panelA, since)).toEqual(['0/200', '200/200']);
    expect(changedTables(everything, await databaseFingerprint(ctx.container.database.db))).toEqual(
      {},
    );
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
    expect(await walletTotal()).toBe(10_000n + SYNTHETIC_EXPECTED.users.positiveBalanceSumMinor);
    await credit('post-import', 500n);
    const reconcile = await importer().reconcile(input('reconcile', snap));
    expect(reconcile.verdict).toBe('RECONCILED');
    const wallet = (reconcile.sections as Record<string, any>)['wallet'];
    expect(wallet).toMatchObject({
      preImportTotalMinor: 10_000n,
      nonOpeningMovementSinceRunMinor: 500n,
      actualTotalMinor: 10_500n + SYNTHETIC_EXPECTED.users.positiveBalanceSumMinor,
    });
    const report = await importer().finalReport({
      ...input('report', snap),
      evidenceClass: 'synthetic',
    });
    const final = report.final as Record<string, any>;
    expect(final['wallet'].preImportTotalMinor).toBe('10500');
    expect(final['reconciliation'].find((r: { id: string }) => r.id === 'W1')).toMatchObject({
      holds: true,
    });
  });

  it('a row a person closed in the review queue is counted and never retried, even when the source changes', async () => {
    await importer().apply({ ...input('import', await snapshot()), mode: 'IMPORT' });
    const queue = ctx.container.legacyReviewQueue;
    const actor = importerActor('reviewer');
    // Dismiss the user whose balance was unreadable, and every CUSTOMER_MISSING invoice.
    await queue.resolve(tenantA, actor, {
      legacyTable: 'user',
      legacyId: '100000004',
      expectedReasonCode: 'INVALID_SOURCE_ROW',
      resolutionCode: 'WILL_NOT_IMPORT',
      idempotencyKey: 'dismiss-user-4',
    });
    const missing = await ctx.container.database.db.execute<{ legacy_id: string }>(sql`
      SELECT legacy_id FROM legacy_import_map
       WHERE legacy_table = 'invoice' AND reason_code = 'CUSTOMER_MISSING' ORDER BY legacy_id`);
    expect(missing.rows).toHaveLength(2);
    for (const row of missing.rows) {
      await queue.resolve(tenantA, actor, {
        legacyTable: 'invoice',
        legacyId: row.legacy_id,
        expectedReasonCode: 'CUSTOMER_MISSING',
        resolutionCode: 'WILL_NOT_IMPORT',
        idempotencyKey: `dismiss-${row.legacy_id}`,
      });
    }
    // The archive changes under both: the user's balance becomes readable, the orphan's
    // username changes. A rerun must not import the user nor rewrite the invoice row.
    const changed = buildSyntheticLegacyDataset();
    const drifted = {
      ...changed,
      tables: {
        ...changed.tables,
        user: changed.tables.user.map((u) =>
          u['id'] === '100000004' ? { ...u, Balance: '45' } : u,
        ),
        invoice: changed.tables.invoice.map((i) =>
          i['id_user'] === '999999999' ? { ...i, username: 'svc_renamed' } : i,
        ),
      },
    };
    const report = await importer().apply({
      ...input('rerun', await snapshot(drifted)),
      mode: 'IMPORT',
    });
    const applied = (report.sections as Record<string, any>)['applied'];
    expect(applied.customers.reviewClosed).toBe(1);
    expect(applied.services.map.reviewClosed).toBe(1);
    expect(await count('customers', "telegram_user_id = '100000004'")).toBe(0);
    expect(await count('wallet_entries', "reference = 'legacy:opening:100000004'")).toBe(0);
    expect(
      await count('legacy_import_map', "review_state = 'DISMISSED' AND status = 'MANUAL_REVIEW'"),
    ).toBe(3);
    // A RETRY_AFTER_FIX resolution, by contrast, invites the next run to decide again.
    await queue.reopen(tenantA, actor, {
      legacyTable: 'user',
      legacyId: '100000004',
      idempotencyKey: 'reopen-4',
    });
    await queue.resolve(tenantA, actor, {
      legacyTable: 'user',
      legacyId: '100000004',
      expectedReasonCode: 'INVALID_SOURCE_ROW',
      resolutionCode: 'RETRY_AFTER_FIX',
      idempotencyKey: 'retry-4',
    });
    const retried = await importer().apply({
      ...input('retry', await snapshot(drifted)),
      mode: 'IMPORT',
    });
    expect((retried.sections as Record<string, any>)['applied'].customers.reviewClosed).toBe(0);
    expect(await count('customers', "telegram_user_id = '100000004'")).toBe(1);
    expect(await count('wallet_entries', "reference = 'legacy:opening:100000004'")).toBe(1);
  });

  it('the review subcommand pages the real queue to the terminal and resolves and reopens a row', async () => {
    await importer().apply({ ...input('import', await snapshot()), mode: 'IMPORT' });
    const lines: string[] = [];
    let n = 0;
    const run = (argv: string[]) =>
      runReview(
        ctx.container.legacyReviewQueue,
        parseReviewArgs([
          argv[0] as string,
          '--tenant',
          'acme',
          '--target',
          'nexa_p4_import',
          ...argv.slice(1),
        ]),
        tenantA,
        importerActor('review-cli'),
        () => `cli-review-test-${String((n += 1))}`,
        (line) => lines.push(line),
      );
    await run(['counts']);
    expect(lines[0]).toMatch(/^review rows 14 {2}open 14 /u);
    lines.length = 0;
    await run(['list', '--limit', '5']);
    expect(lines[0]).toBe('table\tlegacy_id\treason\tstate\tresolution\tattempts\tupdated_at');
    expect(lines).toHaveLength(7);
    const next = lines[6]?.replace('next page: --after ', '') ?? '';
    expect(next).toMatch(/^(invoice|user):/u);
    lines.length = 0;
    await run(['list', '--limit', '500', '--after', next]);
    expect(lines.at(-1)).toBe('(last page)');
    expect(lines).toHaveLength(1 + 9 + 1);
    lines.length = 0;
    await run([
      'resolve',
      '--table',
      'user',
      '--legacy-id',
      '100000004',
      '--expected-reason',
      'INVALID_SOURCE_ROW',
      '--resolution',
      'WILL_NOT_IMPORT',
    ]);
    expect(lines).toEqual(['RESOLVED: user row is DISMISSED (WILL_NOT_IMPORT)']);
    lines.length = 0;
    await run(['reopen', '--table', 'user', '--legacy-id', '100000004']);
    expect(lines).toEqual(['REOPENED: user row is OPEN']);
    // Nothing the subcommand printed went into an audit row: the queue audits by uuid.
    const audited = await ctx.container.database.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_logs
       WHERE coalesce(after::text, '') LIKE '%100000004%' OR coalesce(entity_id, '') = '100000004'`);
    expect(audited.rows[0]?.n).toBe(0);
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

  // Review round (Codex, PR #183) — findings 1 and 2.
  it('reconcile and report refuse a source or a panel mapping the run was not made from', async () => {
    const snap = await snapshot();
    await importer().apply({ ...input('import', snap), mode: 'IMPORT' });
    const otherMapping = parsePanelMapping(
      JSON.stringify({ ...JSON.parse(mappingText), testPanels: ['tst', 'tst2'] }),
      tenantA.tenantId as unknown as string,
    );
    await expect(importer().reconcile(input('reconcile', snap, otherMapping))).rejects.toThrow(
      /different panel mapping/u,
    );
    await expect(
      importer().finalReport({
        ...input('report', snap, otherMapping),
        evidenceClass: 'synthetic',
      }),
    ).rejects.toThrow(/different panel mapping/u);
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
    await expect(
      importer().finalReport({
        ...input('report', await snapshot(drifted)),
        evidenceClass: 'synthetic',
      }),
    ).rejects.toThrow(/source changed/u);
    // The run's own source and mapping still reconcile and report.
    expect((await importer().reconcile(input('reconcile', snap))).verdict).toBe('RECONCILED');
    await importer().finalReport({ ...input('report', snap), evidenceClass: 'synthetic' });
  });

  // Finding 3.
  it('reconcile refuses a run that is not COMPLETED: resume or abort it first', async () => {
    const snap = await snapshot();
    await expect(
      importer().apply({
        ...input('crash', snap),
        mode: 'IMPORT',
        afterPhase: (phase) => {
          if (phase === 'openings') throw new Error('simulated crash after the openings phase');
        },
      }),
    ).rejects.toBeInstanceOf(LegacyImportInterrupted);
    await expect(importer().reconcile(input('reconcile', snap))).rejects.toThrow(
      /is RUNNING, not COMPLETED.*resume.*abort/u,
    );
    const running = await importer().runningRun(tenantA);
    await importer().abortRunning(tenantA, importerActor('abort'), running as string);
    await expect(importer().reconcile(input('reconcile', snap))).rejects.toThrow(
      /is ABORTED, not COMPLETED/u,
    );
  });

  // Finding 4.
  it('failed adoptions and unapplied rows are never reported as success', async () => {
    const failing: LegacyAdoptionPort = {
      adopt: () =>
        Promise.resolve({
          kind: 'FAILED',
          reason: 'PROVIDER_READ_FAILED',
        } as LegacyAdoptionOutcome),
    };
    const report = await importer(failing).apply({
      ...input('fail', await snapshot()),
      mode: 'IMPORT',
    });
    expect(report.verdict).toBe('COMPLETED_WITH_FAILURES');
    expect(exitCodeFor(report)).toBe(3);
    expect((report.sections as Record<string, any>)['attention']).toMatchObject({
      adoptionFailed: SYNTHETIC_EXPECTED.services.categories.ADOPTION_ELIGIBLE,
      total: SYNTHETIC_EXPECTED.services.categories.ADOPTION_ELIGIBLE,
    });

    // A rerun of a source whose balance changed after import leaves that user unapplied.
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
    const rerun = await importer().apply({
      ...input('drift', await snapshot(drifted)),
      mode: 'IMPORT',
    });
    expect(rerun.verdict).toBe('COMPLETED_WITH_FAILURES');
    expect((rerun.sections as Record<string, any>)['attention']).toMatchObject({
      customerSourceChanged: 1,
    });
  });

  // Finding 6.
  it('a rerun re-resolves a MATCHED shape, so a changed public tariff refreshes the hidden product', async () => {
    const snap = await snapshot();
    await importer().apply({ ...input('import', snap), mode: 'IMPORT' });
    const hiddenPrices = async () =>
      (
        await ctx.container.database.db.execute<{ price: string }>(sql`
          SELECT DISTINCT p.price_amount::text AS price
            FROM legacy_product_shapes s JOIN products p ON p.id = s.product_id
           WHERE s.tenant_id = ${tenantA.tenantId as unknown as string}
             AND s.tariff_status = 'RESOLVED'`)
      ).rows.map((r) => r.price);
    expect(await hiddenPrices()).toEqual(['200000']);
    await ctx.container.database.db.execute(sql`
      UPDATE products SET price_amount = 250000
       WHERE tenant_id = ${tenantA.tenantId as unknown as string} AND audience = 'EVERYONE'`);
    const rerun = await importer().apply({ ...input('rerun', snap), mode: 'IMPORT' });
    expect((rerun.sections as Record<string, any>)['applied'].products.tariff).toMatchObject({
      MATCHED: expect.any(Number),
    });
    expect(await hiddenPrices()).toEqual(['250000']);
  });

  // Finding 7.
  it('the wallet equation holds when an entry commits between the pre-import total and the run start', async () => {
    const existingId = (
      await ctx.container.database.db.execute<{ id: string }>(
        sql`SELECT id FROM customers WHERE telegram_user_id = ${SYNTHETIC_EXISTING_CUSTOMER}`,
      )
    ).rows[0]?.id as string;
    const svc = importer();
    const destination = (
      svc as unknown as {
        deps: { destination: { walletTotals: (...args: unknown[]) => Promise<unknown> } };
      }
    ).deps.destination;
    const original = destination.walletTotals.bind(destination);
    let injected = false;
    destination.walletTotals = async (...args: unknown[]) => {
      const result = await original(...args);
      if (!injected) {
        injected = true;
        // Commits after the pre-import measurement and before the run row exists.
        await ctx.container.wallet.adjust(tenantA, owner, existingId as never, {
          idempotencyKey: 'between',
          direction: 'CREDIT',
          amountMinor: 700n,
          currency: 'IRT',
          note: 'fixture',
        });
      }
      return result;
    };
    const snap = await snapshot();
    await svc.apply({ ...input('import', snap), mode: 'IMPORT' });
    expect(injected).toBe(true);
    const reconcile = await importer().reconcile(input('reconcile', snap));
    expect(reconcile.verdict).toBe('RECONCILED');
    expect((reconcile.sections as Record<string, any>)['wallet']).toMatchObject({
      preImportTotalMinor: 0n,
      nonOpeningMovementSinceRunMinor: 700n,
    });
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

  it('an eligible invoice whose map row a person closed is not handed to P6', async () => {
    // P6 records eligible rows itself; stand in for an earlier run that routed the first
    // invoice (svc_a1 on panel A) to review, and a person who dismissed it.
    const runs = new DrizzleLegacyImportRepository(ctx.container.database.db);
    const runId = ctx.container.ids.uuid();
    const snap = await snapshot();
    const first = snap.liveInvoices[0];
    if (first === undefined) throw new Error('no invoice');
    await ctx.container.uow.run(tenantA, async (tx) => {
      const now = ctx.container.clock.now();
      await runs.startOrResume(
        tenantA,
        { id: runId, mode: 'APPLY', sourceFingerprint: '0'.repeat(64), codeVersion: null, now },
        tx,
      );
      await runs.recordDecision(
        tenantA,
        {
          runId,
          legacyTable: 'invoice',
          legacyId: first.idInvoice,
          checksum: first.checksum,
          decision: { status: 'MANUAL_REVIEW', reasonCode: 'SUBSCRIPTION_REF_BLOCKED' },
          now,
        },
        tx,
      );
      await runs.finish(tenantA, runId, { status: 'COMPLETED' }, now, tx);
    });
    await ctx.container.legacyReviewQueue.resolve(tenantA, importerActor('reviewer'), {
      legacyTable: 'invoice',
      legacyId: first.idInvoice,
      expectedReasonCode: 'SUBSCRIPTION_REF_BLOCKED',
      resolutionCode: 'WILL_NOT_IMPORT',
      idempotencyKey: 'dismiss-first',
    });
    const seen: string[] = [];
    const adoption: LegacyAdoptionPort = {
      adopt: (_scope, _actor, candidate) => {
        seen.push(candidate.legacyInvoiceId);
        return Promise.resolve({ kind: 'ADOPTED' } as LegacyAdoptionOutcome);
      },
    };
    const report = await importer(adoption).apply({ ...input('adopt', snap), mode: 'IMPORT' });
    const adopted = (report.sections as Record<string, any>)['applied'].services.adoption;
    expect(adopted).toMatchObject({ REVIEW_CLOSED: 1, ADOPTED: 3 });
    expect(seen).not.toContain(first.idInvoice);
  });

  // REHEARSE against 9942263f: `resume` printed pg's "client is already executing a query"
  // DeprecationWarning — two queries issued concurrently on ONE transaction's client.
  it('import and resume with real adoption issue no concurrent query on one pg client', async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on('warning', onWarning);
    // pg warns once per process, so a warning an earlier test already caused would hide a
    // regression here. Count the exact condition pg warns on as well: a query issued while
    // that client's queue still holds another.
    const proto = PgClient.prototype as unknown as {
      query: (...args: unknown[]) => unknown;
      _queryQueue: unknown[];
    };
    const original = proto.query;
    let overlaps = 0;
    proto.query = function (this: typeof proto, ...args: unknown[]) {
      if (this._queryQueue.length > 0) overlaps += 1;
      return original.apply(this, args);
    };
    try {
      const real = ctx.container.legacyImporter({ inventoryPageSize: 3 });
      const snap = await snapshot();
      await expect(
        real.apply({
          ...input('crash', snap),
          mode: 'IMPORT',
          afterPhase: (phase) => {
            if (phase === 'trials') throw new Error('simulated crash after the trials phase');
          },
        }),
      ).rejects.toBeInstanceOf(LegacyImportInterrupted);
      const resumed = await real.apply({ ...input('resume', snap), mode: 'RESUME' });
      expect((resumed.sections as Record<string, any>)['applied'].services.adoption.ADOPTED).toBe(
        SYNTHETIC_EXPECTED.services.categories.ADOPTION_ELIGIBLE,
      );
      await new Promise((r) => setImmediate(r));
    } finally {
      proto.query = original;
      process.off('warning', onWarning);
    }
    expect(overlaps).toBe(0);
    expect(
      warnings.filter(
        (w) => w.name === 'DeprecationWarning' && /client\.query\(\)/u.test(w.message),
      ),
    ).toEqual([]);
    expectOnlyReads();
  });

  it('with the real P6 wired (the container default), eligible services are adopted with zero provider writes', async () => {
    const real = ctx.container.legacyImporter({ inventoryPageSize: 3 });
    const snap = await snapshot();
    const report = await real.apply({ ...input('import', snap), mode: 'IMPORT' });
    const applied = (report.sections as Record<string, any>)['applied'];
    expect(applied.services.adoption).toMatchObject({ wired: true, PENDING: 0 });
    expect(applied.services.adoption.ADOPTED).toBe(
      SYNTHETIC_EXPECTED.services.categories.ADOPTION_ELIGIBLE,
    );
    expect(report.verdict).toBe('COMPLETED');
    // P6 wrote the eligible invoices' map rows; P7 recorded none of them itself.
    expect(
      await count('legacy_import_map', "legacy_table = 'invoice' AND status = 'IMPORTED'"),
    ).toBe(SYNTHETIC_EXPECTED.services.categories.ADOPTION_ELIGIBLE);
    // Adoption orders: NEW_SERVICE + LEGACY_ADOPTION, zero totals; one service each.
    expect(await count('orders', "origin = 'LEGACY_ADOPTION' AND total_amount = 0")).toBe(
      SYNTHETIC_EXPECTED.services.categories.ADOPTION_ELIGIBLE,
    );
    expect(await count('services')).toBe(SYNTHETIC_EXPECTED.services.categories.ADOPTION_ELIGIBLE);
    expect(await count('provisioning_operations')).toBe(0);
    // Zero provider writes: every request either fake received was a read.
    expectOnlyReads();

    // Every adopted service holds the subscription link the RickPanel adapter's own
    // read-only `lookupUser` delivers for that account (derived from the same inventory
    // walk, with no request of its own).
    const adopted = await ctx.container.database.db.execute<{
      panel_id: string;
      provider_username: string;
      subscription_url: string | null;
    }>(sql`
      SELECT panel_id, provider_username, subscription_url FROM services
       WHERE tenant_id = ${tenantA.tenantId as unknown as string}`);
    expect(adopted.rows).toHaveLength(SYNTHETIC_EXPECTED.services.categories.ADOPTION_ELIGIBLE);
    const adapter = new RickpanelAdapter();
    for (const row of adopted.rows) {
      const fake = row.panel_id === panelAId ? panelA : panelB;
      const found = await adapter.lookupUser(
        {
          baseUrl: fake.baseUrl,
          credentials: {
            shape: 'USERNAME_PASSWORD',
            username: fake.username,
            password: fake.password,
          },
          activation: {},
        },
        new SafeHttpClient({
          allowLoopback: true,
          totalTimeoutMs: 2_000,
          maxResponseBytes: 512 * 1024,
          maxRetries: 0,
        }).forBase(fake.baseUrl),
        {
          username: row.provider_username,
          subscriptionRef: 'unused',
          clientId: '019250ab-cdef-7012-8345-6789abcdef01',
        },
      );
      if (!found.ok || !found.found || found.delivery.kind !== 'SUBSCRIPTION_LINK') {
        throw new Error('expected the adapter to deliver a link');
      }
      expect(row.subscription_url, row.provider_username).toBe(found.delivery.url);
    }
    // The link is a credential: in no report, audit row, domain event or map/run row.
    // (Every seeded token reads `seeded-token-N`, and every link carries its token.)
    expect(
      JSON.stringify(report, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toMatch(/seeded-token|\/sub\//u);
    const linkLeaks = await ctx.container.database.db.execute<{ n: number }>(sql`
      SELECT (SELECT count(*) FROM audit_logs a WHERE a::text LIKE '%seeded-token%')
           + (SELECT count(*) FROM outbox_messages o WHERE o::text LIKE '%seeded-token%')
           + (SELECT count(*) FROM legacy_import_map m WHERE m::text LIKE '%seeded-token%')
           + (SELECT count(*) FROM legacy_import_runs r WHERE r::text LIKE '%seeded-token%')
           + (SELECT count(*) FROM legacy_import_run_inputs i WHERE i::text LIKE '%seeded-token%')
           AS n`);
    expect(Number(linkLeaks.rows[0]?.n)).toBe(0);
    expectOnlyReads();
    expect((report.sections as Record<string, any>)['provider']).toMatchObject({
      writes: 0,
      refusedWrites: 0,
    });

    // A rerun adopts nothing twice.
    const rerun = await real.apply({ ...input('rerun', snap), mode: 'IMPORT' });
    expect((rerun.sections as Record<string, any>)['applied'].services.adoption).toMatchObject({
      ADOPTED: 0,
      ALREADY_ADOPTED: SYNTHETIC_EXPECTED.services.categories.ADOPTION_ELIGIBLE,
    });
    expect(await count('services')).toBe(SYNTHETIC_EXPECTED.services.categories.ADOPTION_ELIGIBLE);

    // The final report: adopted, no pending, the closure holds, provider writes 0.
    const final = (await real.finalReport({ ...input('report', snap), evidenceClass: 'synthetic' }))
      .final as Record<string, any>;
    expect(final['services']).toMatchObject({
      adopted: SYNTHETIC_EXPECTED.services.categories.ADOPTION_ELIGIBLE,
    });
    expect(final['manualReview'].byReason['ADOPTION_PENDING_P6']).toBeUndefined();
    expect(final['provider'].writes).toBe(0);
    const failed = (final['reconciliation'] as { id: string; holds: boolean }[])
      .filter((r) => !r.holds)
      .map((r) => r.id);
    expect(failed).toEqual(['C3']);
    expectOnlyReads();
  });

  it('with P6 wired, every eligible candidate reaches the adoption port with a resolved product', async () => {
    const seen: LegacyAdoptionCandidate[] = [];
    const adoption: LegacyAdoptionPort = {
      adopt: (_scope, actor, candidate) => {
        expect(actor.type).toBe('SYSTEM_JOB');
        seen.push(candidate);
        return Promise.resolve({ kind: 'ADOPTED' } as LegacyAdoptionOutcome);
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

  // --- WP-D3: interruption at every phase, inside adoption, and concurrent resumes -----

  /**
   * What an import leaves behind, keyed by what is STABLE across two fresh databases
   * (legacy ids, Telegram ids, usernames, panel names) — never a generated uuid, a
   * timestamp or the random subscription_ref. Two imports of the same source into the
   * same starting state must produce the same digest, however they were interrupted.
   */
  async function businessDigest(): Promise<Record<string, unknown>> {
    const tenant = tenantA.tenantId as unknown as string;
    const q = async (query: ReturnType<typeof sql>) =>
      (await ctx.container.database.db.execute<Record<string, unknown>>(query)).rows;
    return {
      customers: await q(sql`
        SELECT telegram_user_id, username FROM customers
         WHERE tenant_id = ${tenant} ORDER BY telegram_user_id`),
      wallet: await q(sql`
        SELECT c.telegram_user_id, w.direction, w.reason, w.amount::text AS amount, w.currency
          FROM wallet_entries w JOIN customers c ON c.tenant_id = w.tenant_id AND c.id = w.customer_id
         WHERE w.tenant_id = ${tenant} ORDER BY c.telegram_user_id, w.reason, w.amount`),
      map: await q(sql`
        SELECT legacy_table, legacy_id, checksum, status, reason_code, entity_type,
               entity_id IS NOT NULL AS has_entity, review_state
          FROM legacy_import_map WHERE tenant_id = ${tenant} ORDER BY legacy_table, legacy_id`),
      shapes: await q(sql`
        SELECT shape_key, legacy_code_panel, traffic_bytes::text AS traffic, duration_days,
               is_custom, product_id IS NOT NULL AS has_product, tariff_status, unresolved_reason
          FROM legacy_product_shapes WHERE tenant_id = ${tenant} ORDER BY shape_key`),
      trials: await q(sql`
        SELECT c.telegram_user_id, t.legacy_limit_usertest, t.legacy_had_trial, t.decision,
               t.override_before, t.override_after, t.input_hash
          FROM legacy_trial_eligibility t JOIN customers c ON c.tenant_id = t.tenant_id AND c.id = t.customer_id
         WHERE t.tenant_id = ${tenant} ORDER BY c.telegram_user_id`),
      overrides: await q(sql`
        SELECT c.telegram_user_id, o.trial_limit
          FROM trial_limit_overrides o JOIN customers c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
         WHERE o.tenant_id = ${tenant} ORDER BY c.telegram_user_id`),
      orders: await q(sql`
        SELECT o.origin, o.purpose, o.state, o.total_amount::text AS total, c.telegram_user_id,
               count(*)::int AS n
          FROM orders o JOIN customers c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
         WHERE o.tenant_id = ${tenant}
         GROUP BY o.origin, o.purpose, o.state, o.total_amount, c.telegram_user_id
         ORDER BY c.telegram_user_id, o.origin`),
      services: await q(sql`
        SELECT s.provider_username, p.name AS panel, s.state, s.order_id IS NOT NULL AS has_order,
               s.subscription_url IS NOT NULL AS has_link, s.expires_at, s.traffic_limit_bytes::text AS traffic
          FROM services s JOIN panels p ON p.tenant_id = s.tenant_id AND p.id = s.panel_id
         WHERE s.tenant_id = ${tenant} ORDER BY p.name, s.provider_username`),
      runs: await q(sql`
        SELECT mode, status, count(*)::int AS n FROM legacy_import_runs
         WHERE tenant_id = ${tenant} GROUP BY mode, status ORDER BY mode, status`),
      customerImportedEvents: await count('outbox_messages', "event_type = 'CustomerImported'"),
      provisioningOperations: await count('provisioning_operations'),
      customerNotifications: await count('customer_notifications'),
    };
  }

  /** The digest a clean, uninterrupted import with the real P6 leaves, on a fresh state. */
  async function cleanImportDigest(): Promise<Record<string, unknown>> {
    await panelA.close();
    await panelB.close();
    await setup();
    const report = await ctx.container
      .legacyImporter({ inventoryPageSize: 3 })
      .apply({ ...input('clean', await snapshot()), mode: 'IMPORT' });
    expect(report.verdict).toBe('COMPLETED');
    return businessDigest();
  }

  const PHASES = ['customers', 'openings', 'trials', 'products', 'adoption'] as const;

  it.each(PHASES)(
    'a crash after the %s phase leaves one RUNNING run; its resume ends exactly where a clean import does',
    async (crashAfter) => {
      const real = ctx.container.legacyImporter({ inventoryPageSize: 3 });
      const snap = await snapshot();
      const crashed = await real
        .apply({
          ...input(`crash-${crashAfter}`, snap),
          mode: 'IMPORT',
          afterPhase: (phase) => {
            if (phase === crashAfter) throw new Error(`simulated crash after ${crashAfter}`);
          },
        })
        .catch((e: unknown) => e);
      expect(crashed).toBeInstanceOf(LegacyImportInterrupted);
      expect((crashed as LegacyImportInterrupted).phase).toBe(crashAfter);
      expect(await count('legacy_import_runs', "status = 'RUNNING' AND mode = 'APPLY'")).toBe(1);

      const resumed = await real.apply({ ...input(`resume-${crashAfter}`, snap), mode: 'RESUME' });
      expect(resumed.verdict).toBe('COMPLETED');
      expect((resumed.sections as Record<string, any>)['run'].status).toBe('COMPLETED');
      const afterResume = await businessDigest();
      expect(afterResume['runs']).toEqual([{ mode: 'APPLY', status: 'COMPLETED', n: 1 }]);
      expectOnlyReads();

      expect(afterResume).toEqual(await cleanImportDigest());
    },
  );

  it('a crash INSIDE adoption (after some services exist) resumes to one order and one service per invoice', async () => {
    const real = ctx.container.legacyImporter({ inventoryPageSize: 3 });
    const eligible = SYNTHETIC_EXPECTED.services.categories.ADOPTION_ELIGIBLE;
    expect(eligible).toBeGreaterThan(2);
    let adopted = 0;
    // The real P6, killed mid-phase: two candidates adopted and committed, then the process
    // "dies" before the third.
    const dying: LegacyAdoptionPort = {
      adopt: async (scope, actor, candidate) => {
        if (adopted === 2) throw new Error('simulated crash inside the adoption phase');
        const outcome = await ctx.container.legacyAdoption.adoptCandidate(scope, actor, candidate);
        adopted += 1;
        return outcome;
      },
    };
    const snap = await snapshot();
    const crashed = await importer(dying)
      .apply({ ...input('crash-in-adoption', snap), mode: 'IMPORT' })
      .catch((e: unknown) => e);
    expect(crashed).toBeInstanceOf(LegacyImportInterrupted);
    expect((crashed as LegacyImportInterrupted).phase).toBe('adoption');
    expect(await count('services')).toBe(2);
    expect(await count('orders')).toBe(2);
    expect(await count('legacy_import_runs', "status = 'RUNNING' AND mode = 'APPLY'")).toBe(1);

    const resumed = await real.apply({ ...input('resume-in-adoption', snap), mode: 'RESUME' });
    expect(resumed.verdict).toBe('COMPLETED');
    const adoption = (resumed.sections as Record<string, any>)['applied'].services.adoption;
    expect(adoption).toMatchObject({ ADOPTED: eligible - 2, ALREADY_ADOPTED: 2 });
    expect(await count('services')).toBe(eligible);
    expect(await count('orders', "origin = 'LEGACY_ADOPTION'")).toBe(eligible);
    // One service per adopted invoice, and every service has its own order.
    const perInvoice = await ctx.container.database.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM legacy_import_map m
        JOIN services s ON s.tenant_id = m.tenant_id AND s.id = m.entity_id
       WHERE m.tenant_id = ${tenantA.tenantId as unknown as string}
         AND m.legacy_table = 'invoice' AND m.status = 'IMPORTED'`);
    expect(perInvoice.rows[0]?.n).toBe(eligible);
    expect(
      await count('services', 'order_id IN (SELECT id FROM orders) AND order_id IS NOT NULL'),
    ).toBe(eligible);
    expect(await count('provisioning_operations')).toBe(0);
    expectOnlyReads();

    const afterResume = await businessDigest();
    expect(afterResume).toEqual(await cleanImportDigest());
  });

  it('two concurrent resumes of one interrupted run: exactly one completes it, the other is refused', async () => {
    const snap = await snapshot();
    await expect(
      ctx.container.legacyImporter({ inventoryPageSize: 3 }).apply({
        ...input('crash-concurrent', snap),
        mode: 'IMPORT',
        afterPhase: (phase) => {
          if (phase === 'openings') throw new Error('simulated crash after openings');
        },
      }),
    ).rejects.toBeInstanceOf(LegacyImportInterrupted);

    const resume = (name: string) =>
      ctx.container.legacyImporter({ inventoryPageSize: 3 }).apply({
        ...input(name, snap),
        mode: 'RESUME',
      });
    const results = await Promise.allSettled([resume('resume-1'), resume('resume-2')]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((won[0] as PromiseFulfilledResult<{ verdict: string }>).value.verdict).toBe('COMPLETED');
    // Refused cleanly, as a conflict — not a deadlock, not an interruption half-way.
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'legacy_import.run_conflict',
    });
    expect((lost[0] as PromiseRejectedResult).reason).not.toBeInstanceOf(LegacyImportInterrupted);

    // One run, completed once, resumed once; nothing written twice.
    expect(await count('legacy_import_runs')).toBe(1);
    expect(await count('legacy_import_runs', "status = 'COMPLETED'")).toBe(1);
    const afterResume = await businessDigest();
    expectOnlyReads();
    expect(afterResume).toEqual(await cleanImportDigest());
  });

  it('a live importer process refuses a resume with zero writes; once it dies, the resume proceeds', async () => {
    const snap = await snapshot();
    await expect(
      importer().apply({
        ...input('crash-held', snap),
        mode: 'IMPORT',
        afterPhase: (phase) => {
          if (phase === 'customers') throw new Error('simulated crash after customers');
        },
      }),
    ).rejects.toBeInstanceOf(LegacyImportInterrupted);

    // Another process holds the tenant's claim (a live importer elsewhere).
    const other = await new PgLegacyImportProcessLock(ctx.container.config.DATABASE_URL).tryAcquire(
      tenantA.tenantId as unknown as string,
    );
    expect(other).not.toBeNull();
    const before = await databaseFingerprint(ctx.container.database.db);
    const refused = await importer()
      .apply({ ...input('resume-refused', snap), mode: 'RESUME' })
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({
      code: 'legacy_import.run_conflict',
      message: expect.stringContaining('Another importer process'),
    });
    expect(changedTables(before, await databaseFingerprint(ctx.container.database.db))).toEqual({});

    // That process dies: its session ends, and the claim with it — no operator step.
    await ctx.container.database.db.execute(sql`
      SELECT pg_terminate_backend(pid) FROM pg_locks
       WHERE locktype = 'advisory' AND classid = ${LEGACY_IMPORT_PROCESS_LOCK_CLASS} AND granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    // pg_terminate_backend only signals; the session ends (and frees the lock) a moment later.
    for (let i = 0; i < 100; i += 1) {
      const held = await ctx.container.database.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_locks
         WHERE locktype = 'advisory' AND classid = ${LEGACY_IMPORT_PROCESS_LOCK_CLASS}
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
      if (held.rows[0]?.n === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const resumed = await importer().apply({
      ...input('resume-after-death', snap),
      mode: 'RESUME',
    });
    expect((resumed.sections as Record<string, any>)['run'].status).toBe('COMPLETED');
    await other?.release();
  });

  it('WP-D4 (P4): the import leaves every production panel account as it was; a panel write would show', async () => {
    const key = Buffer.alloc(32, 9);
    const walk = async (): Promise<PanelStateSnapshot> => {
      const inventory = ctx.container.legacyPanelInventory({ inventoryPageSize: 3 });
      const panels = [];
      for (const id of [panelAId, panelBId]) {
        panels.push(panelState(id, await inventory.read(tenantA, id), key));
      }
      const requests = inventory.requestCounts();
      expect(requests.refusedWrites).toBe(0);
      expect(requests.reads).toBeGreaterThan(0);
      return { schema: PANEL_STATE_SCHEMA, panels, requests };
    };
    const before = await walk();
    expect(before.panels.map((p) => p.complete)).toEqual([true, true]);
    expect(before.panels.map((p) => p.accounts)).toEqual([
      SYNTHETIC_PANEL_ACCOUNTS.A.length,
      SYNTHETIC_PANEL_ACCOUNTS.B.length,
    ]);
    // A full import with the real P6: adoption reads, and must change nothing on a panel.
    const report = await ctx.container
      .legacyImporter({ inventoryPageSize: 3 })
      .apply({ ...input('import-p4', await snapshot()), mode: 'IMPORT' });
    expect(report.verdict).toBe('COMPLETED');
    expect(await count('services')).toBeGreaterThan(0);
    expect(comparePanelStates(before, await walk())).toBe('unchanged');
    expectOnlyReads();

    // What a panel write looks like to the same walk: one account's limit changed.
    const victim = SYNTHETIC_PANEL_ACCOUNTS.A[0] as string;
    panelA.seedUser(victim, {
      expire: Math.floor(Date.UTC(2027, 0, 1) / 1000),
      dataLimit: 60 * 1024 ** 3,
      usedTraffic: 1024 ** 3,
    });
    expect(comparePanelStates(before, await walk())).toBe(
      `changed: ${panelAId}: accounts ${SYNTHETIC_PANEL_ACCOUNTS.A.length}->${SYNTHETIC_PANEL_ACCOUNTS.A.length}, added 0, removed 0, changed 1`,
    );
  });

  it('a claim whose session is killed mid-import stops the import as interrupted; resume finishes it', async () => {
    const snap = await snapshot();
    const lockBackend = sql`
      SELECT pid FROM pg_locks
       WHERE locktype = 'advisory' AND classid = ${LEGACY_IMPORT_PROCESS_LOCK_CLASS} AND granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
    let killedPid: number | null = null;
    const crashed = await ctx.container
      .legacyImporter({ inventoryPageSize: 3 })
      .apply({
        ...input('claim-lost', snap),
        mode: 'IMPORT',
        afterPhase: async (phase) => {
          if (phase !== 'customers') return;
          // Exactly the claim's own connection: one pid, the lock's holder. Nothing else.
          const holders = await ctx.container.database.db.execute<{ pid: number }>(lockBackend);
          expect(holders.rows).toHaveLength(1);
          killedPid = holders.rows[0]?.pid ?? null;
          await ctx.container.database.db.execute(sql`SELECT pg_terminate_backend(${killedPid})`);
          // The client hears its session end a moment later.
          for (let i = 0; i < 100; i += 1) {
            const still = await ctx.container.database.db.execute<{ n: number }>(
              sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ${killedPid}`,
            );
            if (still.rows[0]?.n === 0) break;
            await new Promise((r) => setTimeout(r, 20));
          }
          await new Promise((r) => setTimeout(r, 200));
        },
      })
      .catch((e: unknown) => e);
    expect(killedPid).not.toBeNull();
    expect(crashed).toBeInstanceOf(LegacyImportInterrupted);
    expect(String((crashed as LegacyImportInterrupted).cause)).toContain('process claim was lost');
    // Stopped before the next phase wrote anything: customers exist, openings do not.
    expect(await count('legacy_import_runs', "status = 'RUNNING' AND mode = 'APPLY'")).toBe(1);
    expect(await count('wallet_entries')).toBe(0);

    const resumed = await ctx.container
      .legacyImporter({ inventoryPageSize: 3 })
      .apply({ ...input('resume-after-lost', snap), mode: 'RESUME' });
    expect(resumed.verdict).toBe('COMPLETED');
    expect(await count('legacy_import_runs', "status = 'COMPLETED'")).toBe(1);
  });

  it('G10 at apply time: import and resume refuse a map that forgets a live code_panel, writing nothing', async () => {
    const snap = await snapshot();
    const forgot = parsePanelMapping(
      JSON.stringify(
        (({ unresolvedPanels: _drop, ...rest }) => rest)(
          JSON.parse(mappingText) as Record<string, unknown>,
        ),
      ),
      tenantA.tenantId as unknown as string,
    );
    const before = await databaseFingerprint(ctx.container.database.db);
    for (const mode of ['IMPORT', 'RESUME'] as const) {
      const refused = await importer()
        .apply({ ...input(`g10-${mode}`, snap, forgot), mode })
        .catch((e: unknown) => e);
      expect(refused, mode).toBeInstanceOf(PanelMappingRefused);
      expect(String((refused as Error).message)).toContain('"zzz": 1 invoice(s)');
    }
    expect(changedTables(before, await databaseFingerprint(ctx.container.database.db))).toEqual({});
    // A RUNNING run from before the map lost the declaration cannot be resumed under it.
    await expect(
      importer().apply({
        ...input('g10-crash', snap),
        mode: 'IMPORT',
        afterPhase: (phase) => {
          if (phase === 'customers') throw new Error('simulated crash');
        },
      }),
    ).rejects.toBeInstanceOf(LegacyImportInterrupted);
    await expect(
      importer().apply({ ...input('g10-resume', snap, forgot), mode: 'RESUME' }),
    ).rejects.toBeInstanceOf(PanelMappingRefused);
    // With the declaration, the same import goes through.
    const ok = await importer().apply({ ...input('g10-ok', snap), mode: 'RESUME' });
    expect((ok.sections as Record<string, any>)['run'].status).toBe('COMPLETED');
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

  // ---------------------------------------------------------------------------------------
  // Mirza PR4 — users and wallets: negative balances held for review (owner decision 6),
  // duplicate source ids, a ledger DEBIT left by the code before the decision, and a newer
  // snapshot (owner constraint 4). Synthetic data only.
  // ---------------------------------------------------------------------------------------

  /** Snapshot B: the same legacy bot, later — balances and rows changed since A. */
  function snapshotB(): SyntheticLegacyDataset {
    const a = buildSyntheticLegacyDataset();
    const users = a.tables.user
      // 100000007 (an opening of 1 000 in A) is gone from B.
      .filter((u) => u['id'] !== '100000007')
      .map((u) => {
        switch (u['id']) {
          case '100000001': // positive → negative: the owner's
            return { ...u, Balance: '-5000' };
          case '100000003': // negative (a debt) → positive: the owner's
            return { ...u, Balance: '8000' };
          case '100000010': // a different positive figure
            return { ...u, Balance: '9000' };
          case '100000011': // the balance as recorded; the username changed
            return { ...u, username: 'renamed_legacy' };
          default:
            return u;
        }
      });
    // A new user with a negative balance appears in B.
    const added = { ...(a.tables.user[0] as Record<string, unknown>) };
    added['id'] = '100000012';
    added['Balance'] = '-700';
    added['username'] = 'none';
    added['number'] = 'none';
    return { ...a, tables: { ...a.tables, user: [...users, added as never] } };
  }

  async function debtRows(): Promise<{ legacy_user_id: string; amount: string; fp: string }[]> {
    const result = await ctx.container.database.db.execute<{
      legacy_user_id: string;
      amount: string;
      fp: string;
    }>(sql`
      SELECT legacy_user_id, amount_minor::text AS amount, source_fingerprint AS fp
        FROM legacy_wallet_debts WHERE tenant_id = ${tenantA.tenantId as unknown as string}
       ORDER BY legacy_user_id`);
    return result.rows;
  }

  it('PR4: a negative legacy balance is a debt with provenance, never a ledger entry; the balance is 0', async () => {
    const snap = await snapshot();
    const report = await importer().apply({ ...input('import', snap), mode: 'IMPORT' });
    const run = (report.sections as Record<string, any>)['run'];
    const debts = await debtRows();
    expect(debts).toEqual([{ legacy_user_id: '100000003', amount: '20000', fp: snap.fingerprint }]);
    const [debt] = (
      await ctx.container.database.db.execute<{
        run_id: string;
        row_checksum: string;
        state: string;
      }>(sql`SELECT run_id, row_checksum, state, synthetic FROM legacy_wallet_debts`)
    ).rows;
    expect(debt).toEqual({
      run_id: run.id,
      row_checksum: snap.users.find((u) => u.id === '100000003')?.checksum,
      state: 'PENDING_REVIEW',
      // The fixture carries the synthetic marker, and the debt says so.
      synthetic: true,
    });
    // No ledger entry of any kind for that customer: the NEXA balance is 0.
    expect(
      await count(
        'wallet_entries',
        `customer_id = (SELECT id FROM customers WHERE telegram_user_id = '100000003')`,
      ),
    ).toBe(0);
    expect(await count('wallet_entries', "direction = 'DEBIT'")).toBe(0);
    // The map row keeps its warning reason; the debt is not a review-queue row.
    expect(
      await count(
        'legacy_import_map',
        "legacy_table = 'user' AND legacy_id = '100000003' AND status = 'IMPORTED' AND reason_code = 'NEGATIVE_BALANCE'",
      ),
    ).toBe(1);
    // Legacy agents (100000007 'n', 100000009 'n2') are ordinary customers: no reseller row,
    // so no tier, no discount and never credit (CLAUDE.md: there is no reseller credit).
    expect(await count('customers', "telegram_user_id IN ('100000007', '100000009')")).toBe(2);
    expect(await count('resellers')).toBe(0);
    // The legacy identity is kept: one map row per user id, naming its customer.
    expect(
      await count(
        'legacy_import_map',
        "legacy_table = 'user' AND legacy_id IN ('100000007', '100000009') AND entity_type = 'CUSTOMER'",
      ),
    ).toBe(2);
    // The debt's audit row names no Telegram id.
    expect(await count('audit_logs', "action = 'legacy.wallet_debt.recorded'")).toBe(1);
    expect(
      await count(
        'audit_logs',
        "action = 'legacy.wallet_debt.recorded' AND after::text LIKE '%100000003%'",
      ),
    ).toBe(0);
  });

  it('PR4: duplicate source user ids create no customer, no opening and no debt — one review row', async () => {
    const base = buildSyntheticLegacyDataset();
    const twin = { ...(base.tables.user[0] as Record<string, unknown>), Balance: '60000' };
    const dataset = {
      ...base,
      tables: { ...base.tables, user: [...base.tables.user, twin as never] },
    };
    const snap = await snapshot(dataset);
    const report = await importer().apply({ ...input('import', snap), mode: 'IMPORT' });
    expect((report.sections as Record<string, any>)['plan'].customers.duplicateSourceIds).toEqual({
      ids: 1,
      rows: 2,
    });
    expect(await count('customers', "telegram_user_id = '100000001'")).toBe(0);
    expect(await count('wallet_entries', "reference = 'legacy:opening:100000001'")).toBe(0);
    expect(await count('legacy_wallet_debts', "legacy_user_id = '100000001'")).toBe(0);
    expect(
      await count(
        'legacy_import_map',
        "legacy_table = 'user' AND legacy_id = '100000001' AND status = 'MANUAL_REVIEW' AND reason_code = 'INVALID_SOURCE_ROW'",
      ),
    ).toBe(1);
    // A rerun with the rows in the other order keys the same review row: nothing changes.
    const reversed = {
      ...dataset,
      tables: { ...dataset.tables, user: [...dataset.tables.user].reverse() },
    };
    const again = await importer().apply({
      ...input('rerun', await snapshot(reversed)),
      mode: 'IMPORT',
    });
    expect((again.sections as Record<string, any>)['applied'].customers.entityMismatch).toBe(0);
    expect(await count('customers', "telegram_user_id = '100000001'")).toBe(0);

    const reconcile = await importer().reconcile(input('reconcile', await snapshot(reversed)));
    const uw = (reconcile.sections as Record<string, any>)['usersWallets'];
    expect(uw.users.outcomes.SKIPPED_DUPLICATE_SOURCE_ID).toBe(2);
    expect(uw.checks.find((c: { id: string }) => c.id === 'U1').holds).toBe(true);
    const final = (
      await importer().finalReport({
        ...input('report', await snapshot(reversed)),
        evidenceClass: 'synthetic',
      })
    ).final as Record<string, any>;
    expect(final['reconciliation'].find((r: { id: string }) => r.id === 'C1').holds).toBe(true);
  });

  it('PR4: a ledger DEBIT opening left by the code before owner decision 6 is never rewritten nor doubled', async () => {
    // The rehearsal state the old code could leave: customer 100000003 with a DEBIT opening.
    const resolved = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      importerActor('webhook-3'),
      {
        idempotencyKey: 'legacy-prior-debit',
        telegramUserId: '100000003',
        from: { id: 100000003, first_name: 'Prior' },
        botInstanceId: BOT_A,
      },
    );
    const { DrizzleWalletRepository } =
      await import('../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository');
    await new DrizzleWalletRepository(ctx.container.database.db).append(tenantA, {
      id: ctx.container.ids.uuid(),
      customerId: resolved.customer.id,
      direction: 'DEBIT',
      reason: 'MIGRATION_OPENING_BALANCE',
      amount: money(20_000n, 'IRT'),
      reference: 'legacy:opening:100000003',
      now: ctx.container.clock.now(),
    });
    const before = await walletTotal();
    const snap = await snapshot();
    const plan = (
      await importer().audit({
        ...input('audit', snap),
        evidence: { available: false, reason: 'SOURCE_ENGINE_NOT_SQL' },
      })
    ).sections as Record<string, any>;
    expect(plan['plan'].wallet.openings.PRIOR_DEBIT_OPENING).toBe(1);

    const report = await importer().apply({ ...input('import', snap), mode: 'IMPORT' });
    expect(report.verdict).toBe('COMPLETED_WITH_FAILURES');
    const sections = report.sections as Record<string, any>;
    expect(sections['applied'].openings.PRIOR_DEBIT_OPENING).toBe(1);
    expect(sections['attention'].priorDebitOpening).toBe(1);
    // Nothing rewritten and nothing added for that customer: the DEBIT stays, no debt beside it.
    expect(
      await count(
        'wallet_entries',
        "reference = 'legacy:opening:100000003' AND direction = 'DEBIT'",
      ),
    ).toBe(1);
    expect(await count('legacy_wallet_debts')).toBe(0);
    expect(await walletTotal()).toBe(before + SYNTHETIC_EXPECTED.users.positiveBalanceSumMinor);

    const reconcile = await importer().reconcile(input('reconcile', snap));
    expect(reconcile.verdict).toBe('DISCREPANCY');
    const uw = (reconcile.sections as Record<string, any>)['usersWallets'];
    expect(uw.wallet.ledgerDebitOpenings).toBe(1);
    expect(uw.wallet.perUser.priorDebitOpening).toBe(1);
    expect(uw.checks.find((c: { id: string }) => c.id === 'U6').holds).toBe(false);
  });

  it('PR4: a newer snapshot reports changed users and sign flips, applies none, and duplicates nothing', async () => {
    const snapA = await snapshot();
    await importer().apply({ ...input('import-a', snapA), mode: 'IMPORT' });
    const totalAfterA = await walletTotal();
    const openingsAfterA = await count('wallet_entries');
    const debtAfterA = await debtRows();

    const snapB = await snapshot(snapshotB());
    expect(snapB.fingerprint).not.toBe(snapA.fingerprint);
    const audit = (
      await importer().audit({
        ...input('audit-b', snapB),
        evidence: { available: false, reason: 'SOURCE_ENGINE_NOT_SQL' },
      })
    ).sections as Record<string, any>;
    // The plan already says a changed figure is a CONFLICT, never a second opening.
    expect(audit['plan'].wallet.openings).toMatchObject({ CONFLICT: 3, RECORD_DEBT: 1 });

    const report = await importer().apply({ ...input('import-b', snapB), mode: 'IMPORT' });
    expect(report.verdict).toBe('COMPLETED_WITH_FAILURES');
    const applied = (report.sections as Record<string, any>)['applied'];
    expect(applied.customers.sourceChanged).toBe(4);
    expect(applied.openings).toMatchObject({ POSTED: 0, DEBT_RECORDED: 1, CONFLICT: 0 });

    // Nothing applied: the ledger is exactly A's, A's debt is exactly A's, and the one new
    // negative user has its own debt bound to B.
    expect(await walletTotal()).toBe(totalAfterA);
    expect(await count('wallet_entries')).toBe(openingsAfterA);
    expect(await debtRows()).toEqual([
      ...debtAfterA,
      { legacy_user_id: '100000012', amount: '700', fp: snapB.fingerprint },
    ]);

    const reconcile = await importer().reconcile(input('reconcile-b', snapB));
    const sections = reconcile.sections as Record<string, any>;
    // The B plan's balances are not what NEXA holds: an honest DISCREPANCY…
    expect(reconcile.verdict).toBe('DISCREPANCY');
    // …which the users-and-wallets section explains exactly, and closes.
    const uw = sections['usersWallets'];
    expect(uw.holds).toBe(true);
    expect(uw.users.outcomes.SOURCE_CHANGED).toBe(4);
    expect(uw.sourceChanged.users).toBe(4);
    expect(uw.sourceChanged.byClass).toMatchObject({
      POSITIVE_TO_NEGATIVE: {
        count: 1,
        recordedSumMinor: '50000',
        sourceSumMinor: '-5000',
        differenceMinor: '-55000',
      },
      NEGATIVE_TO_POSITIVE: {
        count: 1,
        recordedSumMinor: '-20000',
        sourceSumMinor: '8000',
        differenceMinor: '28000',
      },
      POSITIVE_CHANGED: { count: 1, differenceMinor: '2000' },
      PROFILE_ONLY: { count: 1, differenceMinor: '0' },
    });
    const refOf = async (id: string) =>
      (
        await ctx.container.database.db.execute<{ ref: string }>(sql`
          SELECT ref::text AS ref FROM legacy_import_map
           WHERE legacy_table = 'user' AND legacy_id = ${id}`)
      ).rows[0]?.ref;
    expect(uw.sourceChanged.ownerReview).toEqual({
      POSITIVE_TO_NEGATIVE: [await refOf('100000001')],
      NEGATIVE_TO_POSITIVE: [await refOf('100000003')],
    });
    expect(uw.wallet.carried.absentOpenings).toEqual({ count: 1, sumMinor: '1000' });
    expect(uw.wallet.legacyDebts).toMatchObject({
      users: 1,
      recorded: 2,
      recordedSumMinor: '20700',
    });
    // Aggregates and opaque refs only.
    for (const id of ['100000001', '100000003', '100000012']) {
      expect(JSON.stringify(uw)).not.toMatch(new RegExp(`(?<![0-9])${id}(?![0-9])`, 'u'));
    }

    // A rerun of B duplicates nothing either.
    const rerun = await importer().apply({ ...input('rerun-b', snapB), mode: 'IMPORT' });
    expect((rerun.sections as Record<string, any>)['applied'].openings).toMatchObject({
      POSTED: 0,
      DEBT_RECORDED: 0,
      DEBT_ALREADY_RECORDED: 1,
    });
    expect(await count('legacy_wallet_debts')).toBe(2);
    expect(await walletTotal()).toBe(totalAfterA);
  });

  it('PR4 (Codex on #233): a leftover synthetic debt is a CONFLICT in the plan and in APPLY, and the report is never COMPLETED', async () => {
    // A synthetic import leaves a synthetic debt (100000003, −20 000). The same rows then
    // arrive as a REAL snapshot — modelled by clearing the snapshot's synthetic flag (the
    // fixture connector refuses an unmarked dataset by design). The invalid id is dropped
    // so C3 holds and only the users-and-wallets section can decide the verdict.
    const base = buildSyntheticLegacyDataset();
    const dataset = {
      ...base,
      tables: {
        ...base.tables,
        user: base.tables.user.filter((u) => u['id'] !== 'not-a-telegram-id'),
      },
    };
    const synthetic = await snapshot(dataset);
    await importer().apply({ ...input('import-synthetic', synthetic), mode: 'IMPORT' });
    expect(await count('legacy_wallet_debts', 'synthetic')).toBe(1);

    const real = { ...synthetic, synthetic: false };
    const audit = (
      await importer().audit({
        ...input('audit-real', real),
        evidence: { available: false, reason: 'SOURCE_ENGINE_NOT_SQL' },
      })
    ).sections as Record<string, any>;
    const applied = (
      (await importer().apply({ ...input('import-real', real), mode: 'IMPORT' }))
        .sections as Record<string, any>
    )['applied'];
    // The plan says what APPLY does: the debt of the other evidence class is a CONFLICT.
    expect(audit['plan'].wallet.openings.CONFLICT).toBe(1);
    expect(audit['plan'].wallet.openings.DEBT_ALREADY_RECORDED).toBe(0);
    expect(applied.openings.CONFLICT).toBe(audit['plan'].wallet.openings.CONFLICT);
    expect(applied.openings.DEBT_ALREADY_RECORDED).toBe(0);
    expect(await count('legacy_wallet_debts')).toBe(1);

    const report = await importer().finalReport({
      ...input('report-real', real),
      evidenceClass: 'staging',
    });
    const final = report.final as Record<string, any>;
    // Every v1 equation holds; only U8 does not — and that alone keeps it from COMPLETED.
    expect((final['reconciliation'] as { holds: boolean }[]).every((r) => r.holds)).toBe(true);
    const uw = report.usersWallets as Record<string, any>;
    expect(
      uw.checks.filter((c: { holds: boolean }) => !c.holds).map((c: { id: string }) => c.id),
    ).toEqual(['U8']);
    expect(report.verdict).toBe('COMPLETED_WITH_DISCREPANCY');
    expect(exitCodeFor(report)).toBe(3);
    const reconcile = await importer().reconcile(input('reconcile-real', real));
    expect(reconcile.verdict).toBe('DISCREPANCY');
  });
});
