import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  systemJobActor,
  type ActorContext,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import { nxpkgOwnershipHoldFor, parseArgs, runMode } from '../../apps/api/src/legacy-import.cli';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { checkNxpkgForImport } from '../../apps/api/src/modules/platform/legacy-importer/application/nxpkg-acceptance';
import { buildPanelMappingFromTargets } from '../../apps/api/src/modules/platform/legacy-importer/application/nxpkg-panel-binding';
import { readImportV1Identity } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import {
  FRESH_TARGET_TABLES,
  checkFreshTarget,
  tenantPanelFacts,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/nxpkg-fresh-target';
import { NxpkgImportRefused } from '../../apps/api/src/modules/platform/legacy-importer/application/nxpkg-panel-binding';
import { parsePanelMapping } from '../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import { planTalliesDigest } from '../../apps/api/src/modules/platform/legacy-importer/application/plan';
import {
  readFromSession,
  type LegacySnapshot,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import {
  nxpkgSourceConnector,
  type NxpkgLegacySourceConnector,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/nxpkg-legacy-source';
import {
  SYNTHETIC_PANEL_ACCOUNTS,
  SYNTHETIC_PANEL_CODES,
  buildSyntheticLegacyDataset,
} from '../fixtures/legacy/synthetic-legacy';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import { newRawKey, writeNxpkg } from '../support/nxpkg/writer';
import {
  READY_MANIFEST,
  snapshotOfDataset,
  snapshotPackageFiles,
} from '../support/nxpkg-legacy-package';
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
 * Mirza `.nxpkg` importer, end to end through the EXISTING importer: a synthetic package (the
 * converter's 1.4.0 layout, written by the test writer), opened by the real reader, read by
 * `NxpkgLegacySourceConnector`, checked (`checkNxpkgForImport`), its RickPanel targets bound
 * (`buildPanelMappingFromTargets`), the target proven fresh (`checkFreshTarget`), the package's
 * ownership evidence turned into a hold — then the CLI's own `runMode` for dry run and import
 * against PostgreSQL and two fake RickPanels on real sockets, and reconcile.
 *
 * NOT EVIDENCE about any real Mirza backup or RickPanel. Every fake request is required to be
 * a read: provider writes during a migration are zero.
 */

const GIB = 1024n ** 3n;
const TENANT = SEED_IDS.tenantA as unknown as string;

describe('Mirza .nxpkg: the existing importer over a package', () => {
  let ctx: TestContext;
  let work: string;
  let panelA: FakeRickpanel;
  let panelB: FakeRickpanel;
  let panelAId: string;
  let panelBId: string;
  let owner: ActorContext;
  let productId: string;
  let connector: NxpkgLegacySourceConnector | null = null;

  const job = (name: string) =>
    systemJobActor(`legacy-import:${name}`, `corr-${name}` as CorrelationId);

  beforeAll(async () => {
    ctx = await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
    work = await mkdtemp(join(tmpdir(), 'nxpkg-it-'));
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
    await rm(work, { recursive: true, force: true });
  });

  afterEach(async () => {
    await connector?.close();
    connector = null;
    await panelA?.close();
    await panelB?.close();
  });

  async function rickpanel(host: string, names: readonly string[], key: string) {
    const fake = await startFakeRickpanel({ host });
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
      idempotencyKey: `nxpkg-panel-${key}`,
    });
    await validatePanelConnection(ctx.container, tenantA, created.view.panel.id);
    return { fake, id: created.view.panel.id };
  }

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-nxpkg', roleKeys: ['owner'] }),
    );
    const a = await rickpanel('127.0.0.2', SYNTHETIC_PANEL_ACCOUNTS.A, 'a');
    const b = await rickpanel('127.0.0.3', SYNTHETIC_PANEL_ACCOUNTS.B, 'b');
    panelA = a.fake;
    panelB = b.fake;
    panelAId = a.id;
    panelBId = b.id;
    // The current public tariff the 30 GB / 30 d hidden shapes resolve to.
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ۳۰',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 1,
        panelId: panelAId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 30n * GIB, deviceLimit: null },
        price: money(200_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    productId = product.id;
  }, 120_000);

  async function count(table: string, where = 'true'): Promise<number> {
    const result = await ctx.container.database.db.execute<{ n: number }>(
      sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = '${TENANT}' AND ${where}`),
    );
    return result.rows[0]?.n ?? 0;
  }

  function expectOnlyReads(): void {
    for (const fake of [panelA, panelB]) {
      const writes = fake.requests.filter(
        (r) => !(r.method === 'GET' || (r.method === 'POST' && r.path === '/api/admin/token')),
      );
      expect(writes, 'a provider write was sent').toEqual([]);
    }
  }

  /**
   * The synthetic dataset as a package: the snapshot, the operator's RickPanel targets (rp1 an
   * existing NEXA panel, rp2 one to connect; the other codes left for the owner), and one
   * ownership record per live invoice — proven onto its `id_user`, except `held`, which the
   * converter found ambiguous.
   */
  async function writePackage(held: string): Promise<{ path: string; keyFileText: string }> {
    const dataset = buildSyntheticLegacyDataset();
    const parts = snapshotOfDataset(dataset as never);
    const live = new Set(['active', 'disabled', 'disabledn', 'disablebyadmin', 'end_of_volume']);
    const ownership = dataset.tables.invoice
      .filter((i) => live.has(i['Status'] ?? ''))
      .map((i) => ({
        record_type: 'legacy_service_ownership',
        schema: 'mirza.service_ownership.v1',
        idempotency_key: `legacy:service-ownership:${i['id_invoice'] ?? ''}`,
        invoice_key: i['id_invoice'],
        ownership_decision: i['username'] === held ? 'AMBIGUOUS_OWNER' : 'CONFIRMED_CURRENT_OWNER',
        final_owner_telegram_user_id: i['username'] === held ? null : i['id_user'],
        provision: false,
        applies_to_live_state: false,
        affects_wallet: false,
        creates_payment: false,
      }));
    const target = (code: string, nexaPanelId: string | null) => ({
      record_type: 'legacy_panel_target',
      schema: 'm2n.legacy_panel_target.v1',
      idempotency_key: `legacy:panel-target:${code}`,
      code_panel: code,
      target: {
        provider_type: 'rickpanel',
        provider_display_name: 'RickPanel',
        provider_version_declared: '1.0.0',
        nexa_panel_id: nexaPanelId,
        binding:
          nexaPanelId === null ? 'CREATE_IN_NEXA_THEN_CONNECT' : 'CONNECT_EXISTING_NEXA_PANEL',
        decided_by: 'operator',
        evidence: [],
      },
      mapping_state: 'TARGET_SELECTED',
      nexa_panel_map_entry: nexaPanelId === null ? null : { codePanel: code, panelId: nexaPanelId },
      credentials_in_package: false,
      services_reprovisioned: false,
      provision: false,
      applies_to_live_state: false,
    });
    const unselected = (code: string) => ({
      ...target(code, null),
      target: null,
      mapping_state: 'OPERATOR_MUST_MAP',
    });
    const C = SYNTHETIC_PANEL_CODES;
    const key = newRawKey();
    const written = await writeNxpkg(join(work, `p-${ctx.container.ids.uuid()}.nxpkg`), {
      files: snapshotPackageFiles(parts, {
        'records/panel_target_mapping.jsonl': {
          records: [
            target(C.mappedA, panelAId),
            target(C.mappedB, null),
            unselected(C.test),
            unselected(C.declaredMissing),
            unselected(C.unmapped),
            unselected('(no code_panel)'),
          ],
        },
        'records/service_ownership.jsonl': { records: ownership },
      }),
      secret: { rawKey: key.rawKey },
      manifest: { ...READY_MANIFEST, import_id: 'abcdefabcdefabcdefabcdefabcdefab' },
    });
    return { path: written.path, keyFileText: key.keyFileText };
  }

  async function targets(c: NxpkgLegacySourceConnector) {
    const out: Record<string, unknown>[] = [];
    for await (const r of c.pkg?.iterJsonl('records/panel_target_mapping.jsonl') ?? []) out.push(r);
    return out;
  }

  it('fresh guard: panels allowed; every operational table counted; it never deletes', async () => {
    const fresh = await checkFreshTarget(ctx.container.database.db, TENANT);
    expect(fresh).toEqual({
      fresh: true,
      code: null,
      counts: Object.fromEntries(FRESH_TARGET_TABLES.map((t) => [t, 0])),
    });
    // Products are configuration (the product review maps onto them): this tenant has one.
    expect(await count('products')).toBe(1);
    await ctx.container.customers.resolveFromUpdate(tenantA, job('webhook'), {
      idempotencyKey: 'nxpkg-existing',
      telegramUserId: '555000555',
      from: { id: 555000555, first_name: 'Existing' },
      botInstanceId: SEED_IDS.botA1 as never,
    });
    const notFresh = await checkFreshTarget(ctx.container.database.db, TENANT);
    expect(notFresh).toMatchObject({ fresh: false, code: 'FRESH_TARGET_NOT_EMPTY' });
    expect(notFresh.counts.customers).toBe(1);
    // Read twice, nothing removed.
    expect(await checkFreshTarget(ctx.container.database.db, TENANT)).toEqual(notFresh);
    expect(await count('customers')).toBe(1);
  });

  /** The package, its products read and p1 decision, the binding, the CLI glue. */
  async function setup() {
    const pkgFile = await writePackage('svc_a2');
    connector = await nxpkgSourceConnector(
      pkgFile.path,
      { keyFileText: pkgFile.keyFileText },
      work,
    );
    const pkg = connector.pkg;
    if (pkg === null) throw new Error('no package');

    // §1: the package may be imported.
    expect(await checkNxpkgForImport(pkg)).toEqual({ ok: true, problems: [] });

    // The products read and the owner's p1 decision, through the PACKAGE connector — the
    // fingerprint it records is the one the fixture would have recorded for the same rows.
    const v1 = (await readImportV1Identity(await connector.open())).fingerprint;
    const fixtureV1 = (
      await readImportV1Identity(
        await new FixtureLegacySourceConnector(buildSyntheticLegacyDataset() as never).open(),
      )
    ).fingerprint;
    expect(v1).toBe(fixtureV1);
    const read = (expectedProductsFingerprint: string | null) =>
      ctx.container.legacyImporter().readProducts({
        scope: tenantA,
        actor: job('products'),
        connector: connector as NxpkgLegacySourceConnector,
        expectedFingerprint: v1,
        expectedProductsFingerprint,
        batchSize: 500,
        productionLikeTarget: false,
      });
    await read((await read(null)).fingerprint);
    const { items } = await ctx.container.legacyProductReviews.list(tenantA, owner, { q: 'p1' });
    const row = items.find((i) => i.review.codeProduct === 'p1')?.review;
    if (row === undefined) throw new Error('no p1 review row');
    await ctx.container.legacyProductReviews.approveExisting(tenantA, owner, row.id, {
      idempotencyKey: `nxpkg-review-p1-${row.version}`,
      expectedFactsChecksum: row.factsChecksum,
      expectedVersion: row.version,
      productId,
      reason: 'synthetic rehearsal',
    });

    // The binding: the package's RickPanel targets onto the tenant's RickPanels (the refusals
    // — a Marzban panel, another id, an unbound target — are unit-tested).
    const tenantPanels = await tenantPanelFacts(ctx.container.database.db, TENANT);
    const list = await targets(connector);
    const binding = buildPanelMappingFromTargets({
      tenantId: TENANT,
      targets: list,
      bindings: { rp1: panelAId, rp2: panelBId },
      tenantPanels,
      products: [{ codeProduct: 'p1', productId }],
    });
    expect(binding.unresolved).toEqual(['gone', 'tst', 'zzz']);

    // §6: fresh — but for this source's own read sets (the products read above), which the
    // guard does not count when it is told the source; without it, every read set counts.
    expect(
      (await checkFreshTarget(ctx.container.database.db, TENANT, { sourceFingerprint: v1 })).fresh,
    ).toBe(true);
    const unscoped = await checkFreshTarget(ctx.container.database.db, TENANT);
    expect(unscoped.fresh).toBe(false);
    expect(unscoped.counts.legacy_read_set_runs).toBeGreaterThan(0);

    // The CLI's own glue: argv, runMode, the ownership hold from the package's records.
    const holdFor = await nxpkgOwnershipHoldFor(connector, null);
    const argv = (mode: string, ...extra: string[]) =>
      parseArgs([
        mode,
        '--tenant',
        TENANT,
        '--target',
        'nexa_test',
        '--panel-map',
        'map.json',
        '--source',
        `nxpkg:${pkgFile.path}`,
        '--package-key-env',
        'NXPKG_TEST_KEY',
        '--evidence-class',
        'synthetic',
        ...extra,
      ]);
    const importer = ctx.container.legacyImporter({ inventoryPageSize: 3 });
    const context = { tenantId: TENANT, productionLikeTarget: false, ownershipHoldFor: holdFor };
    return {
      connector: connector as NxpkgLegacySourceConnector,
      v1,
      binding,
      holdFor,
      argv,
      importer,
      context,
    };
  }

  it('dry run and import through the NXPKG connector: customers, openings, debts, adoption; the held service is never adopted; reconcile RECONCILED; provider writes 0', async () => {
    const { connector: c, v1, binding, argv, importer, context } = await setup();

    const dry = await runMode(importer, argv('dry-run'), c, binding.text, 'corr-dry', context);
    if (dry === null) throw new Error('no dry run report');
    const drySections = dry.sections as Record<string, any>;
    expect(dry.synthetic).toBe(true);
    expect(drySections['source'].engine).toBe('NXPKG');
    expect(drySections['source'].fingerprint).toBe(v1);
    expect(drySections['ownershipHold']).toEqual({ invoices: 1, changedCategory: 1 });
    expect(drySections['planTalliesDigest']).toMatch(/^[0-9a-f]{64}$/u);
    const categories = drySections['plan'].services.categories as Record<string, number>;
    expect(categories['ADOPTION_ELIGIBLE']).toBe(1);
    expect(categories['AMBIGUOUS_OWNERSHIP']).toBe(1);
    expect(await count('customers')).toBe(0);

    const applied = await runMode(
      importer,
      argv('import', '--expected-plan-tallies-digest', drySections['planTalliesDigest']),
      c,
      binding.text,
      'corr-imp',
      context,
    );
    if (applied === null) throw new Error('no import report');
    const a = (applied.sections as Record<string, any>)['applied'];
    expect(applied.verdict).toBe('COMPLETED');
    expect(a.customers.created).toBe(8);
    expect(a.openings).toMatchObject({ POSTED: 5, DEBT_RECORDED: 1 });
    expect(a.services.adoption).toMatchObject({ wired: true, ADOPTED: 1, PENDING: 0 });
    expect(await count('customers')).toBe(8);
    expect(await count('wallet_entries', "reason = 'MIGRATION_OPENING_BALANCE'")).toBe(5);
    expect(await count('legacy_wallet_debts')).toBe(1);
    expect(await count('services')).toBe(1);
    const adopted = await ctx.container.database.db.execute<{ provider_username: string }>(
      sql`SELECT provider_username FROM services WHERE tenant_id = ${TENANT}`,
    );
    expect(adopted.rows.map((r) => r.provider_username)).toEqual(['svc_a1']);
    // The held invoice: manual review (the map's AMBIGUOUS_OWNERSHIP reason), a candidate
    // with that outcome, no service.
    expect(
      await count(
        'legacy_import_map',
        "legacy_table = 'invoice' AND status = 'MANUAL_REVIEW' AND reason_code = 'CONFLICTING_EXISTING_ENTITY'",
      ),
    ).toBe(1);
    expect(await count('legacy_service_candidates', "outcome = 'AMBIGUOUS_OWNERSHIP'")).toBe(1);
    expect(await count('provisioning_operations')).toBe(0);

    const reconciled = await runMode(
      importer,
      argv('reconcile'),
      c,
      binding.text,
      'corr-rec',
      context,
    );
    expect(reconciled?.verdict).toBe('RECONCILED');

    // No longer fresh: a second Fresh Migration into this tenant is refused, nothing deleted.
    const after = await checkFreshTarget(ctx.container.database.db, TENANT);
    expect(after).toMatchObject({ fresh: false, code: 'FRESH_TARGET_NOT_EMPTY' });
    expect(after.counts).toMatchObject({
      customers: 8,
      services: 1,
      wallet_entries: 5,
      legacy_wallet_debts: 1,
      legacy_import_runs_apply: 1,
    });
    expect((applied.sections as Record<string, any>)['provider']).toMatchObject({ writes: 0 });
    expectOnlyReads();
  });

  it("guards: the panel map must be the targets' own; DRY_RUN_MISMATCH; FRESH_TARGET_NOT_EMPTY inside the start transaction", async () => {
    const { connector: c, binding, holdFor, argv, importer, context } = await setup();

    // H2: a map the package targets do not make (a test panel declared, an unresolved code
    // moved) is refused before the snapshot is read — whoever wrote it.
    const file = JSON.parse(binding.text) as Record<string, any>;
    const tampered = JSON.stringify({
      ...file,
      testPanels: ['tst'],
      unresolvedPanels: file['unresolvedPanels'].filter((u: any) => u.codePanel !== 'tst'),
    });
    await expect(
      runMode(importer, argv('dry-run'), c, tampered, 'corr-map', context),
    ).rejects.toMatchObject({ code: 'PANEL_TARGET_MISMATCH' });

    const dry = await runMode(importer, argv('dry-run'), c, binding.text, 'corr-dry', context);
    const digest = (dry?.sections as Record<string, any>)['planTalliesDigest'] as string;
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);

    // DRY_RUN_MISMATCH: another approved digest is refused before any write.
    await expect(
      runMode(
        importer,
        argv('import', '--expected-plan-tallies-digest', '0'.repeat(64)),
        c,
        binding.text,
        'corr-mm',
        context,
      ),
    ).rejects.toMatchObject({ code: 'DRY_RUN_MISMATCH' });
    expect(await count('legacy_import_runs', "mode = 'APPLY'")).toBe(0);

    // H1: the importer itself, past the CLI's courtesy read — a customer lands after it. The
    // run-start transaction counts again with the tenant locked and refuses; no run row stays.
    const session = await c.open();
    let snapshot: LegacySnapshot;
    try {
      snapshot = await readFromSession(c.label, session);
    } finally {
      await session.close();
    }
    const hold = await holdFor(snapshot);
    const input = {
      scope: tenantA,
      actor: job('apply'),
      snapshot,
      mapping: parsePanelMapping(binding.text, TENANT),
      productionLikeTarget: false,
      ownershipHold: hold,
      ownershipDecisionsDigest: null,
    };
    expect(
      planTalliesDigest(
        (await importer.prepare(tenantA, snapshot, input.mapping, false, { ownershipHold: hold }))
          .plan,
      ),
    ).toBe(digest);
    await ctx.container.customers.resolveFromUpdate(tenantA, job('webhook'), {
      idempotencyKey: 'nxpkg-late-customer',
      telegramUserId: '555000556',
      from: { id: 555000556, first_name: 'Late' },
      botInstanceId: SEED_IDS.botA1 as never,
    });
    const refused = await importer.apply({ ...input, mode: 'IMPORT' }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(NxpkgImportRefused);
    expect(refused).toMatchObject({ code: 'FRESH_TARGET_NOT_EMPTY', counts: { customers: 1 } });
    expect(await count('legacy_import_runs', "mode = 'APPLY'")).toBe(0);
    expect(await count('customers')).toBe(1);
    expectOnlyReads();
  });

  it('a resume is not refused by its own writes; one ownership hold per run (resume, reconcile)', async () => {
    const { connector: c, binding, holdFor, importer } = await setup();
    const session = await c.open();
    let snapshot: LegacySnapshot;
    try {
      snapshot = await readFromSession(c.label, session);
    } finally {
      await session.close();
    }
    const hold = await holdFor(snapshot);
    const mapping = parsePanelMapping(binding.text, TENANT);
    const input = {
      scope: tenantA,
      actor: job('apply'),
      snapshot,
      mapping,
      productionLikeTarget: false,
      ownershipHold: hold,
      ownershipDecisionsDigest: null,
    };
    const digest = planTalliesDigest(
      (await importer.prepare(tenantA, snapshot, mapping, false, { ownershipHold: hold })).plan,
    );

    // A run interrupted after its customers phase: a RESUME is not refused by those writes.
    await expect(
      importer.apply({
        ...input,
        mode: 'IMPORT',
        freshTarget: true,
        dryRunTalliesDigest: digest,
        afterPhase: (phase) => {
          if (phase === 'customers') throw new Error('simulated crash');
        },
      }),
    ).rejects.toThrow(/interrupted in the customers phase/u);
    expect(await count('customers')).toBe(8);

    // M7: the same run under another hold is refused — resume, then reconcile and report.
    await expect(
      importer.apply({ ...input, ownershipHold: new Set<string>(), mode: 'RESUME' }),
    ).rejects.toThrow(/OWNERSHIP_HOLD_MISMATCH/u);
    await expect(
      importer.apply({ ...input, ownershipDecisionsDigest: 'f'.repeat(64), mode: 'RESUME' }),
    ).rejects.toThrow(/OWNERSHIP_HOLD_MISMATCH/u);
    const resumed = await importer.apply({ ...input, mode: 'RESUME', freshTarget: true });
    expect(resumed.verdict).toBe('COMPLETED');
    expect((resumed.sections as Record<string, any>)['ownershipHold']).toEqual({
      invoices: 1,
      changedCategory: 1,
    });
    await expect(
      importer.reconcile({ ...input, ownershipHold: new Set<string>() }),
    ).rejects.toThrow(/OWNERSHIP_HOLD_MISMATCH/u);
    expect((await importer.reconcile(input)).verdict).toBe('RECONCILED');
    expectOnlyReads();
  });
});
