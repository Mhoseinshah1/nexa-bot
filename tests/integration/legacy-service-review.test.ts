import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { Client as PgClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  LEGACY_SERVICE_OUTCOMES,
  LEGACY_SERVICE_REVIEW_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  SESSION_COOKIE_NAME,
  legacyServiceCandidateDetailResponseSchema,
  legacyServiceCandidateListResponseSchema,
  legacyServiceCandidateResponseSchema,
  legacyServiceCandidateSummaryResponseSchema,
  money,
  systemJobActor,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type LegacyServiceOutcome,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import { runInvoicesRead } from '../../apps/api/src/legacy-import-invoices';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { LegacyImporterService } from '../../apps/api/src/modules/platform/legacy-importer/application/legacy-importer.service';
import { LegacyImportInterrupted } from '../../apps/api/src/modules/platform/legacy-importer/application/legacy-importer.service';
import { digestInvoiceArchiveReadSet } from '../../apps/api/src/modules/platform/legacy-importer/application/invoice-archive-read-set';
import {
  parsePanelMapping,
  type PanelMapping,
} from '../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import type { LegacyAdoptionPort } from '../../apps/api/src/modules/platform/legacy-importer/application/ports';
import {
  readFromSession,
  readImportV1Identity,
  type LegacySnapshot,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import type { LegacyServiceCandidateRecord } from '../../apps/api/src/modules/platform/legacy-service-review/application/ports';
import { LegacyServicesController } from '../../apps/api/src/surfaces/web/legacy-services.controller';
import {
  SYNTHETIC_EXISTING_CUSTOMER,
  SYNTHETIC_EXPECTED,
  SYNTHETIC_PANEL_ACCOUNTS,
  SYNTHETIC_PANEL_CODES,
  buildSyntheticLegacyDataset,
  type SyntheticLegacyDataset,
  type SyntheticRow,
} from '../fixtures/legacy/synthetic-legacy';
import { syntheticMappingFile } from '../fixtures/legacy/synthetic-support';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  validatePanelConnection,
  type TestContext,
} from './harness';

/**
 * Mirza migration PR5 — service adoption outcomes and the operator's review (Area D; owner
 * decision 8), end to end: PostgreSQL, two fake RickPanels on real sockets, the SYNTHETIC
 * legacy dataset and the real P6 adoption. NOT EVIDENCE about the legacy archive or RickPanel.
 *
 * Every case that reads the fakes requires every request to be a GET or the token exchange:
 * no provider write, ever — not by the import, not by an operator's ADOPT approval.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const GIB = 1024n ** 3n;

describe('Mirza PR5: legacy service candidates and their review', () => {
  let ctx: TestContext;
  let panelA: FakeRickpanel;
  let panelB: FakeRickpanel;
  let panelAId: string;
  let panelBId: string;
  let owner: ActorContext;
  let mapping: PanelMapping;

  const job = (name: string) =>
    systemJobActor(`legacy-import:${name}`, `corr-${name}` as CorrelationId);
  const db = () => ctx.container.database.db;
  const review = () => ctx.container.legacyServiceReview;
  let keySeq = 0;
  const key = () => `svc-review-${String((keySeq += 1))}-${ctx.container.ids.uuid()}`;

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

  async function rickpanel(host: string, names: readonly string[], name: string) {
    const fake = await startFakeRickpanel({ host });
    for (const n of names) {
      fake.seedUser(n, {
        expire: Math.floor(Date.UTC(2027, 0, 1) / 1000),
        dataLimit: 30 * 1024 ** 3,
        usedTraffic: 1024 ** 3,
      });
    }
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: `Rick ${name}`,
      providerType: 'rickpanel',
      baseUrl: fake.baseUrl,
      credentials: { username: fake.username, password: fake.password },
      activation: {},
      idempotencyKey: `pr5-panel-${name}`,
    });
    await validatePanelConnection(ctx.container, tenantA, created.view.panel.id);
    return { fake, id: created.view.panel.id };
  }

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-pr5', roleKeys: ['owner'] }),
    );
    const a = await rickpanel('127.0.0.2', SYNTHETIC_PANEL_ACCOUNTS.A, 'a');
    const b = await rickpanel('127.0.0.3', SYNTHETIC_PANEL_ACCOUNTS.B, 'b');
    panelA = a.fake;
    panelB = b.fake;
    panelAId = a.id;
    panelBId = b.id;
    const products = new DrizzleProductRepository(db());
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
    mapping = parsePanelMapping(
      syntheticMappingFile(tenantA.tenantId as unknown as string, panelAId, panelBId, product.id),
      tenantA.tenantId as unknown as string,
    );
    await ctx.container.customers.resolveFromUpdate(tenantA, job('webhook'), {
      idempotencyKey: 'pr5-existing',
      telegramUserId: SYNTHETIC_EXISTING_CUSTOMER,
      from: { id: Number(SYNTHETIC_EXISTING_CUSTOMER), first_name: 'Existing' },
      botInstanceId: BOT_A,
    });
  });

  async function snapshot(
    dataset: SyntheticLegacyDataset = buildSyntheticLegacyDataset(),
  ): Promise<LegacySnapshot> {
    const connector = new FixtureLegacySourceConnector(dataset as never);
    return readFromSession(connector.label, await connector.open());
  }

  /** The real P6 (the container default) unless a port is given. */
  function importer(adoption?: LegacyAdoptionPort | null): LegacyImporterService {
    return ctx.container.legacyImporter({
      ...(adoption === undefined ? {} : { adoption }),
      inventoryPageSize: 3,
    });
  }

  function apply(
    name: string,
    snap: LegacySnapshot,
    options: {
      readonly productionLikeTarget?: boolean;
      readonly adoption?: LegacyAdoptionPort | null;
      readonly mode?: 'IMPORT' | 'RESUME';
      readonly afterPhase?: (phase: string) => Promise<void> | void;
    } = {},
  ) {
    return importer(options.adoption).apply({
      scope: tenantA,
      actor: job(name),
      snapshot: snap,
      mapping,
      productionLikeTarget: options.productionLikeTarget ?? false,
      mode: options.mode ?? 'IMPORT',
      ...(options.afterPhase === undefined ? {} : { afterPhase: options.afterPhase }),
    });
  }

  async function count(table: string, where = 'true'): Promise<number> {
    const result = await db().execute<{ n: number }>(
      sql.raw(
        `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = '${tenantA.tenantId as unknown as string}' AND ${where}`,
      ),
    );
    return result.rows[0]?.n ?? 0;
  }

  function expectOnlyReads(): void {
    for (const fake of [panelA, panelB]) {
      const writes = fake.requests.filter(
        (r) => !(r.method === 'GET' || (r.method === 'POST' && r.path === '/api/admin/token')),
      );
      expect(writes, 'a provider write was sent').toEqual([]);
      expect(fake.createCalls(), 'an account was created').toBe(0);
      expect(fake.putCalls(), 'an account was modified').toBe(0);
    }
  }

  function invoiceKeyOf(snap: LegacySnapshot, username: string): string {
    const found = snap.liveInvoices.find((i) => i.username === username);
    if (found === undefined) throw new Error(`no live invoice for ${username}`);
    return found.idInvoice;
  }

  async function candidate(invoiceKey: string): Promise<LegacyServiceCandidateRecord> {
    const rows = await db().execute<{ id: string }>(
      sql`SELECT id FROM legacy_service_candidates WHERE tenant_id = ${tenantA.tenantId} AND invoice_key = ${invoiceKey}`,
    );
    const id = rows.rows[0]?.id;
    if (id === undefined) throw new Error(`no candidate for ${invoiceKey}`);
    return (await review().get(tenantA, owner, id)).candidate;
  }

  async function outcomeCounts(): Promise<Partial<Record<LegacyServiceOutcome, number>>> {
    const rows = await db().execute<{ outcome: LegacyServiceOutcome; n: number }>(
      sql`SELECT outcome, count(*)::int AS n FROM legacy_service_candidates
           WHERE tenant_id = ${tenantA.tenantId} GROUP BY outcome`,
    );
    return Object.fromEntries(rows.rows.map((r) => [r.outcome, r.n]));
  }

  const approve = (c: LegacyServiceCandidateRecord, panelId?: string, actor = owner) =>
    review().approveAdoption(tenantA, actor, c.id, {
      idempotencyKey: key(),
      expectedVersion: c.version,
      ...(panelId === undefined ? {} : { panelId }),
      reason: 'حساب در پنل B پیدا شد',
    });

  // --- outcomes ---------------------------------------------------------------------------

  it('every live invoice gets exactly ONE outcome; an empty-code invoice is never adopted, even with one holder', async () => {
    const snap = await snapshot();
    const report = await apply('import', snap);
    expect(report.verdict).toBe('COMPLETED');
    expect(await count('legacy_service_candidates')).toBe(SYNTHETIC_EXPECTED.services.candidates);
    const c = SYNTHETIC_EXPECTED.services.categories;
    const expected: Partial<Record<LegacyServiceOutcome, number>> = {};
    for (const [category, n] of Object.entries(c)) {
      if (n > 0) expected[category === 'ADOPTION_ELIGIBLE' ? 'ADOPTED' : (category as never)] = n;
    }
    expect(await outcomeCounts()).toEqual(expected);
    const applied = (report.sections as Record<string, any>)['applied'].services;
    expect(applied.outcomes['NO_PANEL']).toBe(3);
    expect(
      Object.values(applied.outcomes as Record<string, number>).reduce((a, b) => a + b, 0),
    ).toBe(SYNTHETIC_EXPECTED.services.candidates);

    // svc_nullmatch: one holder (panel B, mapped), and STILL not adopted (owner decision 8).
    const nullmatch = await candidate(invoiceKeyOf(snap, 'svc_nullmatch'));
    expect(nullmatch).toMatchObject({
      outcome: 'NO_PANEL',
      blocker: 'PANEL_UNMAPPED',
      reviewState: 'OPEN',
      serviceId: null,
      panelCode: null,
    });
    expect(nullmatch.evidence).toMatchObject({
      panelCodeClass: 'EMPTY',
      mappedPanelId: null,
      customer: 'IMPORTED',
      holders: [{ panelId: panelBId, mapped: true, spellings: 1, state: 'active' }],
      incompletePanels: [],
    });
    expect(
      await count('services', "provider_username = 'svc_nullmatch'"),
      'a no-panel invoice was adopted automatically',
    ).toBe(0);
    // Two holders, and none: NO_PANEL as well — never AMBIGUOUS, never PROVIDER_MISSING.
    expect((await candidate(invoiceKeyOf(snap, 'svc_shared'))).outcome).toBe('NO_PANEL');
    expect((await candidate(invoiceKeyOf(snap, 'svc_nowhere'))).outcome).toBe('NO_PANEL');
    // An adopted candidate names its service.
    const adopted = await candidate(invoiceKeyOf(snap, 'svc_a2'));
    expect(adopted).toMatchObject({ outcome: 'ADOPTED', reviewState: 'ADOPTED' });
    expect(adopted.serviceId).toMatch(/^[0-9a-f-]{36}$/u);

    // The reconcile's closure: one outcome per candidate, from THIS run, this source.
    const reconciled = await importer().reconcile({
      scope: tenantA,
      actor: job('reconcile'),
      snapshot: snap,
      mapping,
      productionLikeTarget: false,
    });
    const section = (reconciled.sections as Record<string, any>)['serviceOutcomes'];
    expect(section.invariant).toMatchObject({ holds: true, missing: 0, decidedByAnotherRun: 0 });
    expect(section.candidates).toBe(SYNTHETIC_EXPECTED.services.candidates);
    expect(section.adopted).toBe(c.ADOPTION_ELIGIBLE);
    expect(section.archivedHistory.notAdopted).toBe(
      SYNTHETIC_EXPECTED.services.candidates - c.ADOPTION_ELIGIBLE,
    );
    expect(
      (reconciled.sections as Record<string, any>)['checks'].find(
        (x: { id: string }) => x.id === 'services.outcomes.closure',
      ),
    ).toMatchObject({ ok: true });
    // PII-free: the section names no invoice key and no legacy username.
    const text = JSON.stringify(section);
    for (const word of ['svc_', invoiceKeyOf(snap, 'svc_a2'), '100000001']) {
      expect(text).not.toContain(word);
    }
    // A row that no longer describes this source row breaks the closure: DISCREPANCY.
    await db().execute(
      sql`UPDATE legacy_service_candidates SET invoice_checksum = ${'f'.repeat(64)}
           WHERE tenant_id = ${tenantA.tenantId} AND invoice_key = ${invoiceKeyOf(snap, 'svc_a2')}`,
    );
    const broken = await importer().reconcile({
      scope: tenantA,
      actor: job('reconcile-2'),
      snapshot: snap,
      mapping,
      productionLikeTarget: false,
    });
    expect(broken.verdict).toBe('DISCREPANCY');
    expect((broken.sections as Record<string, any>)['serviceOutcomes'].invariant).toMatchObject({
      holds: false,
      checksumDiffers: 1,
    });
    const reported = await importer().finalReport({
      scope: tenantA,
      actor: job('report'),
      snapshot: snap,
      mapping,
      productionLikeTarget: false,
      evidenceClass: 'synthetic',
    });
    expect(reported.verdict).toMatch(/_WITH_DISCREPANCY$/u);
    expectOnlyReads();
  });

  it('a rerun keeps one row per invoice: ALREADY_ADOPTED stays adopted, even when the account left the panel', async () => {
    const snap = await snapshot();
    await apply('first', snap);
    const a2 = await candidate(invoiceKeyOf(snap, 'svc_a2'));
    (panelA.users as Map<string, unknown>).delete('svc_a2');
    const again = await apply('second', snap);
    expect(await count('legacy_service_candidates')).toBe(SYNTHETIC_EXPECTED.services.candidates);
    const after = await candidate(invoiceKeyOf(snap, 'svc_a2'));
    expect(after).toMatchObject({
      id: a2.id,
      outcome: 'ALREADY_ADOPTED',
      // Never unadopted: the fresh decision is the blocker, for a person.
      blocker: 'PROVIDER_MISSING',
      reviewState: 'ADOPTED',
      serviceId: a2.serviceId,
    });
    expect(await count('services')).toBe(SYNTHETIC_EXPECTED.services.categories.ADOPTION_ELIGIBLE);
    // The map refuses to downgrade the adopted row: attention, never success.
    expect(again.verdict).toBe('COMPLETED_WITH_FAILURES');
    // The database refuses to unadopt it too, for every role.
    await expect(
      db().execute(
        sql`UPDATE legacy_service_candidates SET outcome = 'PROVIDER_MISSING', review_state = 'OPEN', service_id = NULL WHERE id = ${a2.id}`,
      ),
    ).rejects.toThrow();
    await expect(
      db().execute(sql`DELETE FROM legacy_service_candidates WHERE id = ${a2.id}`),
    ).rejects.toThrow();
    expectOnlyReads();
  });

  it('ambiguous ownership: two owners claiming one account adopt neither; keeping one as history lets the other adopt', async () => {
    const base = buildSyntheticLegacyDataset();
    const extra: SyntheticRow = {
      ...(base.tables.invoice.find((r) => r['username'] === 'svc_a2') as SyntheticRow),
      id_invoice: 'beef0001',
      id_user: '100000002',
      code_product: null,
    };
    const dataset = {
      ...base,
      tables: { ...base.tables, invoice: [...base.tables.invoice, extra] },
    } as SyntheticLegacyDataset;
    const snap = await snapshot(dataset);
    await apply('ownership', snap);
    const claims = snap.liveInvoices.filter((i) => i.username === 'svc_a2');
    expect(claims).toHaveLength(2);
    for (const i of claims) {
      const c = await candidate(i.idInvoice);
      expect(c).toMatchObject({ outcome: 'AMBIGUOUS_OWNERSHIP', serviceId: null });
      expect(c.evidence.claims).toBe(2);
    }
    expect(await count('services', "provider_username = 'svc_a2'")).toBe(0);
    // An ownership ambiguity is not adoptable by a click: it is resolved by history.
    const wrong = await candidate('beef0001');
    await expect(approve(wrong)).rejects.toMatchObject({
      code: LEGACY_SERVICE_REVIEW_ERROR_CODES.NOT_ADOPTABLE,
    });
    await review().decide(tenantA, owner, wrong.id, {
      idempotencyKey: key(),
      expectedVersion: wrong.version,
      decision: 'KEEP_AS_HISTORY',
      reason: 'مالک دیگری دارد',
    });
    await apply('ownership-2', snap);
    const right = claims.find((i) => i.idInvoice !== 'beef0001');
    expect((await candidate(right?.idInvoice ?? '')).outcome).toBe('ADOPTED');
    expect(await candidate('beef0001')).toMatchObject({
      outcome: 'ADOPTION_ELIGIBLE',
      reviewState: 'KEPT_AS_HISTORY',
      // The importer did not hand it to P6 at all (P6's own re-read is the second layer).
      blocker: null,
    });
    expect(await count('services', "provider_username = 'svc_a2'")).toBe(1);
    expectOnlyReads();
  });

  // --- the explicit ADOPT --------------------------------------------------------------------

  it('an explicit ADOPT: refused without a mapped holder panel or at a stale version; executed by the next run through P6, with no provider write', async () => {
    const snap = await snapshot();
    await apply('import', snap);
    const before = await candidate(invoiceKeyOf(snap, 'svc_nullmatch'));
    const detail = await review().get(tenantA, owner, before.id);
    expect(detail.adoptPanels).toEqual([panelBId]);

    // No panel named for an invoice that names none; a panel that does not hold it.
    await expect(approve(before)).rejects.toMatchObject({
      code: LEGACY_SERVICE_REVIEW_ERROR_CODES.PANEL_REFUSED,
    });
    await expect(approve(before, panelAId)).rejects.toMatchObject({
      code: LEGACY_SERVICE_REVIEW_ERROR_CODES.PANEL_REFUSED,
    });
    // Bound to the version the operator saw.
    await expect(
      review().approveAdoption(tenantA, owner, before.id, {
        idempotencyKey: key(),
        expectedVersion: before.version + 1,
        panelId: panelBId,
        reason: 'stale',
      }),
    ).rejects.toMatchObject({ code: LEGACY_SERVICE_REVIEW_ERROR_CODES.VERSION_CONFLICT });
    // A test invoice is not adoptable at all.
    const trial = await candidate(snap.liveInvoices.find((i) => i.isTest === '1')?.idInvoice ?? '');
    await expect(approve(trial, panelAId)).rejects.toMatchObject({
      code: LEGACY_SERVICE_REVIEW_ERROR_CODES.NOT_ADOPTABLE,
    });

    // The approval: a label bound to the checksum and outcome; NOTHING is adopted yet.
    const k = key();
    const body = {
      idempotencyKey: k,
      expectedVersion: before.version,
      panelId: panelBId,
      reason: 'حساب در پنل B',
    };
    const approved = await review().approveAdoption(tenantA, owner, before.id, body);
    expect(approved).toMatchObject({
      reviewState: 'ADOPT_APPROVED',
      approvedPanelId: panelBId,
      approvedChecksum: before.invoiceChecksum,
      approvedOutcome: 'NO_PANEL',
      version: before.version + 1,
    });
    // An idempotent replay answers the same; nothing moves twice.
    expect((await review().approveAdoption(tenantA, owner, before.id, body)).version).toBe(
      approved.version,
    );
    // A replay after the row moved returns the ORIGINAL response, never today's row.
    const reopened = await review().reopen(tenantA, owner, before.id, {
      idempotencyKey: key(),
      expectedVersion: approved.version,
      reason: 'again',
    });
    expect(await review().approveAdoption(tenantA, owner, before.id, body)).toEqual(approved);
    expect((await candidate(before.invoiceKey)).reviewState).toBe('OPEN');
    await review().approveAdoption(tenantA, owner, before.id, {
      ...body,
      idempotencyKey: key(),
      expectedVersion: reopened.version,
    });
    expect(await count('services', "provider_username = 'svc_nullmatch'")).toBe(0);

    // The next run re-runs every check against the inventory it walks, and adopts via P6.
    const run = await apply('import-2', snap);
    const after = await candidate(before.invoiceKey);
    expect(after).toMatchObject({
      outcome: 'ADOPTED',
      reviewState: 'ADOPTED',
      approvedPanelId: null,
      lastApprovalRefusal: null,
    });
    const services = await db().execute<{ panel_id: string; provider_username: string }>(
      sql`SELECT panel_id, provider_username FROM services WHERE id = ${after.serviceId}`,
    );
    expect(services.rows).toEqual([{ panel_id: panelBId, provider_username: 'svc_nullmatch' }]);
    expect(
      await count(
        'legacy_import_map',
        `legacy_id = '${before.invoiceKey}' AND status = 'IMPORTED'`,
      ),
    ).toBe(1);
    expect((run.sections as Record<string, any>)['applied'].services.approvals).toMatchObject({
      executed: 1,
    });
    const audits = await db().execute<{ action: string; actor_type: string }>(
      sql`SELECT action, actor_type FROM audit_logs WHERE entity_id = ${before.id} ORDER BY occurred_at, action`,
    );
    expect(audits.rows.map((r) => r.action)).toEqual([
      'legacy.service_candidate.approve_adoption',
      'legacy.service_candidate.approval_executed',
    ]);
    // A third run adopts nothing twice.
    await apply('import-3', snap);
    expect(await count('services', "provider_username = 'svc_nullmatch'")).toBe(1);
    expect((await candidate(before.invoiceKey)).outcome).toBe('ALREADY_ADOPTED');
    expectOnlyReads();
  });

  it('an approval whose checks fail at execution adopts nothing and creates no account: account gone, inventory changed mid-walk, source row changed', async () => {
    const snap = await snapshot();
    await apply('import', snap);
    const nullmatch = await candidate(invoiceKeyOf(snap, 'svc_nullmatch'));
    await approve(nullmatch, panelBId);

    // 1. The panel's inventory changes during the walk (TOTAL_CHANGED): fail closed.
    for (let i = 0; i < 7; i += 1) panelB.seedUser(`bulkb${String(i)}`);
    let changed = false;
    panelB.beforeListPage = (offset) => {
      if (offset > 0 && !changed) {
        changed = true;
        panelB.seedUser('arrivedmidwalk');
      }
    };
    await apply('total-changed', snap);
    panelB.beforeListPage = null;
    let now = await candidate(nullmatch.invoiceKey);
    // The run decided it on the operator's panel, whose walk was incomplete: never adopted.
    expect(now).toMatchObject({
      reviewState: 'OPEN',
      lastApprovalRefusal: 'INVENTORY_INCOMPLETE',
      outcome: 'INVENTORY_INCOMPLETE',
      serviceId: null,
    });
    expect(now.evidence.incompletePanels).toEqual([panelBId]);
    // And the evidence no longer shows panel B holding it: a new approval waits for a run
    // with a complete inventory, never decided from an incomplete one.
    await expect(approve(now, panelBId)).rejects.toMatchObject({
      code: LEGACY_SERVICE_REVIEW_ERROR_CODES.PANEL_REFUSED,
    });
    await apply('complete-again', snap);
    now = await candidate(nullmatch.invoiceKey);
    expect(now.outcome).toBe('NO_PANEL');

    // 2. The account left the panel: PROVIDER_MISSING, never a fake account.
    await approve(now, panelBId);
    (panelB.users as Map<string, unknown>).delete('svc_nullmatch');
    await apply('gone', snap);
    now = await candidate(nullmatch.invoiceKey);
    expect(now).toMatchObject({ reviewState: 'OPEN', lastApprovalRefusal: 'PROVIDER_MISSING' });
    panelB.seedUser('svc_nullmatch', {
      expire: Math.floor(Date.UTC(2027, 0, 1) / 1000),
      dataLimit: 30 * 1024 ** 3,
      usedTraffic: 1024 ** 3,
    });

    // 3. A newer snapshot changed the row the approval was bound to: SOURCE_CHANGED.
    await apply('back', snap);
    now = await candidate(nullmatch.invoiceKey);
    await approve(now, panelBId);
    const base = buildSyntheticLegacyDataset();
    const changedRow = {
      ...base,
      tables: {
        ...base.tables,
        invoice: base.tables.invoice.map((r) =>
          r['username'] === 'svc_nullmatch' ? { ...r, Volume: '31' } : r,
        ),
      },
    } as SyntheticLegacyDataset;
    await apply('changed', await snapshot(changedRow));
    now = await candidate(nullmatch.invoiceKey);
    expect(now).toMatchObject({ reviewState: 'OPEN', lastApprovalRefusal: 'SOURCE_CHANGED' });

    expect(await count('services', "provider_username = 'svc_nullmatch'")).toBe(0);
    expect(
      await count(
        'legacy_import_map',
        `legacy_id = '${nullmatch.invoiceKey}' AND status = 'IMPORTED'`,
      ),
    ).toBe(0);
    expectOnlyReads();
  });

  it('a SYNTHETIC approval is never executed against a production-like target; it is left, audited, and attention', async () => {
    const snap = await snapshot();
    await apply('import', snap);
    const nullmatch = await candidate(invoiceKeyOf(snap, 'svc_nullmatch'));
    const approved = await approve(nullmatch, panelBId);
    const report = await apply('prod-like', snap, { productionLikeTarget: true });
    expect(report.verdict).toBe('COMPLETED_WITH_FAILURES');
    expect((report.sections as Record<string, any>)['attention'].approvalLeft).toBe(1);
    const after = await candidate(nullmatch.invoiceKey);
    expect(after).toMatchObject({ reviewState: 'ADOPT_APPROVED', approvedPanelId: panelBId });
    expect(after.version).toBeGreaterThanOrEqual(approved.version);
    expect(await count('services', "provider_username = 'svc_nullmatch'")).toBe(0);
    const left = await db().execute(
      sql`SELECT 1 FROM audit_logs WHERE action = 'legacy.service_candidate.approval_synthetic_refused' AND entity_id = ${nullmatch.id}`,
    );
    expect(left.rows).toHaveLength(1);
    expectOnlyReads();
  });

  it('crash and resume: a claimed approval (ADOPTING) is executed by the resume, adopting exactly once', async () => {
    const snap = await snapshot();
    await apply('import', snap);
    const nullmatch = await candidate(invoiceKeyOf(snap, 'svc_nullmatch'));
    await approve(nullmatch, panelBId);
    // The process dies right after P6 committed the adoption, before the approval settles.
    const real = ctx.container.legacyAdoption;
    const dying: LegacyAdoptionPort = {
      adopt: async (scope, actor, c) => {
        const outcome = await real.adoptCandidate(scope, actor, c);
        if (c.legacyInvoiceId === nullmatch.invoiceKey) throw new Error('process killed');
        return outcome;
      },
    };
    await expect(apply('dies', snap, { adoption: dying })).rejects.toBeInstanceOf(
      LegacyImportInterrupted,
    );
    expect((await candidate(nullmatch.invoiceKey)).reviewState).toBe('ADOPTING');
    // A person cannot reopen a claimed approval.
    const claimed = await candidate(nullmatch.invoiceKey);
    await expect(
      review().reopen(tenantA, owner, claimed.id, {
        idempotencyKey: key(),
        expectedVersion: claimed.version,
        reason: 'x',
      }),
    ).rejects.toMatchObject({ code: LEGACY_SERVICE_REVIEW_ERROR_CODES.NOT_IN_STATE });
    await apply('resume', snap, { mode: 'RESUME' });
    expect(await candidate(nullmatch.invoiceKey)).toMatchObject({
      reviewState: 'ADOPTED',
      outcome: 'ALREADY_ADOPTED',
    });
    expect(await count('services', "provider_username = 'svc_nullmatch'")).toBe(1);
    expectOnlyReads();
  });

  // --- concurrency ---------------------------------------------------------------------------

  it('two operators approving the same candidate at once: exactly one wins; the other is refused, never applied', async () => {
    const snap = await snapshot();
    await apply('import', snap);
    const c = await candidate(invoiceKeyOf(snap, 'svc_nullmatch'));
    const second = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-pr5-2', roleKeys: ['owner'] }),
    );
    const results = await Promise.allSettled([
      approve(c, panelBId),
      review().decide(tenantA, second, c.id, {
        idempotencyKey: key(),
        expectedVersion: c.version,
        decision: 'KEEP_AS_HISTORY',
        reason: 'هم‌زمان',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect((refused as PromiseRejectedResult).reason).toMatchObject({
      code: expect.stringMatching(/version_conflict|not_in_state/u),
    });
    const now = await candidate(c.invoiceKey);
    expect(now.version).toBe(c.version + 1);
    await apply('import-2', snap);
    expect(await count('services', "provider_username = 'svc_nullmatch'")).toBeLessThanOrEqual(1);
  });

  it('an operator alongside a running import: a keep landing mid-run is honoured by P6 under the invoice lock; an approval mid-run waits for the next run', async () => {
    const snap = await snapshot();
    // A first run with adoption OFF records the candidates (eligible ones stay eligible).
    await apply('record', snap, { adoption: null });
    const a1Key = snap.liveInvoices.find(
      (i) =>
        i.username === 'svc_a1' &&
        i.idUser === '100000001' &&
        i.isTest === '0' &&
        /^[0-9a-f]{8}$/u.test(i.idInvoice),
    )?.idInvoice as string;
    const a1 = await candidate(a1Key);
    expect(a1.outcome).toBe('ADOPTION_ELIGIBLE');
    const nullmatch = await candidate(invoiceKeyOf(snap, 'svc_nullmatch'));
    // During the next run — after it read the review state, before it adopts — a person
    // keeps svc_a1 as history and approves svc_nullmatch.
    await apply('concurrent', snap, {
      afterPhase: async (phase) => {
        if (phase !== 'products') return;
        await review().decide(tenantA, owner, a1.id, {
          idempotencyKey: key(),
          expectedVersion: a1.version,
          decision: 'KEEP_AS_HISTORY',
          reason: 'هم‌زمان با ورود',
        });
        await approve(nullmatch, panelBId);
      },
    });
    // P6 re-read the keep under the invoice lock: svc_a1 was NOT adopted.
    expect(await candidate(a1Key)).toMatchObject({
      reviewState: 'KEPT_AS_HISTORY',
      outcome: 'ADOPTION_ELIGIBLE',
      blocker: 'KEPT_AS_HISTORY',
    });
    expect(await count('services', "provider_username = 'svc_a1'")).toBe(0);
    // The approval arrived after the run read the approvals: still waiting, not lost.
    expect((await candidate(nullmatch.invoiceKey)).reviewState).toBe('ADOPT_APPROVED');
    await apply('next', snap);
    expect((await candidate(nullmatch.invoiceKey)).reviewState).toBe('ADOPTED');
    expect(await count('services', "provider_username = 'svc_nullmatch'")).toBe(1);
    expect(await count('services', "provider_username = 'svc_a1'")).toBe(0);
    expectOnlyReads();
  });

  it('a keep landing after P6 adopted the invoice is refused: never both a keep and a service', async () => {
    const snap = await snapshot();
    await apply('record', snap, { adoption: null });
    const key1 = invoiceKeyOf(snap, 'svc_a2');
    const c = await candidate(key1);
    let refusal: unknown = null;
    await apply('adopt', snap, {
      adoption: {
        adopt: async (scope, actor, cand) => {
          const o = await ctx.container.legacyAdoption.adoptCandidate(scope, actor, cand);
          if (cand.legacyInvoiceId === key1) {
            // P6 committed; the candidate row still says what the operator saw.
            refusal = await review()
              .decide(tenantA, owner, c.id, {
                idempotencyKey: key(),
                expectedVersion: c.version,
                decision: 'KEEP_AS_HISTORY',
                reason: 'too late',
              })
              .then(
                () => null,
                (error: unknown) => error,
              );
          }
          return o;
        },
      },
    });
    expect(refusal).toMatchObject({ code: LEGACY_SERVICE_REVIEW_ERROR_CODES.NOT_IN_STATE });
    expect(await candidate(key1)).toMatchObject({ outcome: 'ADOPTED', reviewState: 'ADOPTED' });
    expect(await count('services', "provider_username = 'svc_a2'")).toBe(1);
  });

  it('a decision takes the invoice lock P6 takes first, and P6 reads a keep under it', async () => {
    const snap = await snapshot();
    await apply('record', snap, { adoption: null });
    const key1 = invoiceKeyOf(snap, 'svc_a2');
    const c = await candidate(key1);
    const holder = new PgClient({ connectionString: ctx.container.config.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `legacy-adoption:${tenantA.tenantId as unknown as string}:invoice:${key1}`,
      ]);
      let settled = false;
      const decision = review()
        .decide(tenantA, owner, c.id, {
          idempotencyKey: key(),
          expectedVersion: c.version,
          decision: 'KEEP_AS_HISTORY',
          reason: 'waits for the lock',
        })
        .finally(() => {
          settled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled, 'the decision did not wait for the invoice lock').toBe(false);
      await holder.query('COMMIT');
      expect((await decision).reviewState).toBe('KEPT_AS_HISTORY');
    } finally {
      await holder.end();
    }
  });

  it('a person reopening an approval mid-run wins: the run does not claim or execute it', async () => {
    const snap = await snapshot();
    await apply('import', snap);
    const c = await candidate(invoiceKeyOf(snap, 'svc_nullmatch'));
    const approved = await approve(c, panelBId);
    const run = await apply('mid', snap, {
      afterPhase: async (phase) => {
        if (phase !== 'customers') return;
        await review().reopen(tenantA, owner, c.id, {
          idempotencyKey: key(),
          expectedVersion: approved.version,
          reason: 'changed my mind',
        });
      },
    });
    expect((run.sections as Record<string, any>)['applied'].services.approvals).toMatchObject({
      executed: 0,
      claimLost: 1,
    });
    expect((await candidate(c.invoiceKey)).reviewState).toBe('OPEN');
    expect(await count('services', "provider_username = 'svc_nullmatch'")).toBe(0);
  });

  // --- the archive link ------------------------------------------------------------------------

  it('every invoice not adopted stays archived history: its candidate links the invoice archive revision', async () => {
    const dataset = buildSyntheticLegacyDataset();
    const session = await new FixtureLegacySourceConnector(dataset as never).open();
    const fp = {
      v1: (await readImportV1Identity(session)).fingerprint,
      archive: (await digestInvoiceArchiveReadSet(session)).fingerprint,
    };
    await session.close();
    await runInvoicesRead(
      ctx.container.legacyImporter(),
      new FixtureLegacySourceConnector(dataset as never),
      { expectedFingerprint: fp.v1, expectedInvoiceArchiveFingerprint: fp.archive, batchSize: 5 },
      { scope: tenantA, actor: job('invoices-read'), productionLikeTarget: false },
    );
    const snap = await snapshot(dataset);
    await apply('import', snap);
    const notLinked = await count(
      'legacy_service_candidates',
      "archive_id IS NULL AND outcome NOT IN ('ADOPTED', 'ALREADY_ADOPTED')",
    );
    expect(notLinked).toBe(0);
    const nullmatch = await candidate(invoiceKeyOf(snap, 'svc_nullmatch'));
    const detail = await review().get(tenantA, owner, nullmatch.id);
    expect(detail.archive).toMatchObject({ classification: 'NO_PANEL', panelCode: null });
    const reconciled = await importer().reconcile({
      scope: tenantA,
      actor: job('reconcile'),
      snapshot: snap,
      mapping,
      productionLikeTarget: false,
    });
    expect(
      (reconciled.sections as Record<string, any>)['serviceOutcomes'].archivedHistory,
    ).toMatchObject({ notLinkedToArchive: 0 });
  });

  // --- permissions, tenants, scope, audit ----------------------------------------------------

  it('is permission-gated: an observer cannot view, a support admin cannot decide, the importer cannot decide; denials audited', async () => {
    const snap = await snapshot();
    await apply('import', snap);
    const c = await candidate(invoiceKeyOf(snap, 'svc_nullmatch'));
    const observer = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'observer-pr5',
        roleKeys: ['observer'],
      }),
    );
    await expect(review().list(tenantA, observer, {})).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PERMISSION_DENIED,
    });
    await expect(review().get(tenantA, observer, c.id)).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PERMISSION_DENIED,
    });
    const support = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'support-pr5', roleKeys: ['support'] }),
    );
    await expect(approve(c, panelBId, support)).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PERMISSION_DENIED,
    });
    await expect(approve(c, panelBId, job('not-an-admin'))).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PERMISSION_DENIED,
    });
    const denied = await db().execute(
      sql`SELECT 1 FROM audit_logs WHERE action = 'legacy.service_candidate.approve_adoption'
             AND result = 'DENIED' AND entity_id = ${c.id}`,
    );
    expect(denied.rows.length).toBeGreaterThanOrEqual(2);
    expect((await candidate(c.invoiceKey)).reviewState).toBe('OPEN');
  });

  it('keeps tenants apart, refuses a stopped tenant, and audits codes and ids only', async () => {
    const snap = await snapshot();
    await apply('import', snap);
    const c = await candidate(invoiceKeyOf(snap, 'svc_nullmatch'));
    const ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-pr5-b', roleKeys: ['owner'] }),
    );
    expect((await review().list(tenantB, ownerB, {})).items).toEqual([]);
    await expect(review().get(tenantB, ownerB, c.id)).rejects.toMatchObject({
      code: LEGACY_SERVICE_REVIEW_ERROR_CODES.NOT_FOUND,
    });
    await expect(
      review().decide(tenantB, ownerB, c.id, {
        idempotencyKey: key(),
        expectedVersion: c.version,
        decision: 'ACKNOWLEDGE',
        reason: 'cross',
      }),
    ).rejects.toMatchObject({ code: LEGACY_SERVICE_REVIEW_ERROR_CODES.NOT_FOUND });

    const acked = await review().decide(tenantA, owner, c.id, {
      idempotencyKey: key(),
      expectedVersion: c.version,
      decision: 'ACKNOWLEDGE',
      reason: 'دیده شد',
    });
    expect(acked.reviewState).toBe('ACKNOWLEDGED');
    const audit = await db().execute<{ before: unknown; after: unknown }>(
      sql`SELECT before, after FROM audit_logs WHERE action = 'legacy.service_candidate.decide' AND entity_id = ${c.id}`,
    );
    const text = JSON.stringify(audit.rows);
    for (const word of ['svc_nullmatch', '100000002', c.invoiceKey]) {
      expect(text, `audit carries ${word}`).not.toContain(word);
    }

    await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`);
    await expect(
      review().reopen(tenantA, owner, c.id, {
        idempotencyKey: key(),
        expectedVersion: acked.version,
        reason: 'x',
      }),
    ).rejects.toMatchObject({ code: LEGACY_SERVICE_REVIEW_ERROR_CODES.SCOPE_STOPPED });
  });

  it('backfills the two keys into existing owner roles only, idempotently', async () => {
    await db().execute(
      sql`DELETE FROM role_permissions WHERE permission_key LIKE 'legacy.services.%'`,
    );
    const migration = readFileSync(
      'apps/api/drizzle/0231_legacy_service_review_grants.sql',
      'utf8',
    );
    const backfill = migration.slice(migration.indexOf('INSERT INTO "role_permissions"'));
    await db().execute(sql.raw(backfill));
    await db().execute(sql.raw(backfill));
    const rows = await db().execute<{ role_key: string; permission_key: string }>(
      sql`SELECT r.key AS role_key, rp.permission_key FROM role_permissions rp
            JOIN roles r ON r.id = rp.role_id
           WHERE rp.tenant_id = ${tenantA.tenantId} AND rp.permission_key LIKE 'legacy.services.%'
           ORDER BY r.key, rp.permission_key`,
    );
    expect(rows.rows.map((r) => `${r.role_key}:${r.permission_key}`)).toEqual([
      'owner:legacy.services.decide',
      'owner:legacy.services.view',
    ]);
  });

  // --- the HTTP surface ------------------------------------------------------------------------

  it('the Web Admin surface: filters by outcome, panel and product; the wire shapes parse; an approval goes through the service', async () => {
    const snap = await snapshot();
    await apply('import', snap);
    const { token } = await ctx.container.auth.login(
      tenantA,
      {
        type: 'API',
        id: null,
        label: null,
        surface: 'WEB',
        correlationId: 'pr5-web' as CorrelationId,
      },
      { username: 'owner-pr5', password: 'a-perfectly-fine-password' },
      { ip: '203.0.113.10', userAgent: 'vitest' },
    );
    type WebRequest = Parameters<LegacyServicesController['list']>[0];
    const request = (method: string) =>
      ({
        method,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
        ip: '203.0.113.10',
      }) as unknown as WebRequest;
    const controller = new LegacyServicesController(ctx.container);
    const noPanel = legacyServiceCandidateListResponseSchema.parse(
      await controller.list(request('GET'), { outcome: 'NO_PANEL' }),
    );
    expect(noPanel.candidates).toHaveLength(3);
    const byPanel = legacyServiceCandidateListResponseSchema.parse(
      await controller.list(request('GET'), { panelCode: SYNTHETIC_PANEL_CODES.mappedB }),
    );
    expect(byPanel.candidates.every((c) => c.panelCode === SYNTHETIC_PANEL_CODES.mappedB)).toBe(
      true,
    );
    const byProduct = legacyServiceCandidateListResponseSchema.parse(
      await controller.list(request('GET'), { productCode: 'p1' }),
    );
    expect(byProduct.candidates.map((c) => c.productCode)).toEqual(['p1']);
    // Pages walk every candidate exactly once.
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = legacyServiceCandidateListResponseSchema.parse(
        await controller.list(request('GET'), { limit: '4', ...(after ? { after } : {}) }),
      );
      seen.push(...page.candidates.map((c) => c.id));
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(SYNTHETIC_EXPECTED.services.candidates);
    const summary = legacyServiceCandidateSummaryResponseSchema.parse(
      await controller.summary(request('GET')),
    );
    expect(summary.total).toBe(SYNTHETIC_EXPECTED.services.candidates);
    expect(Object.keys(summary.byOutcome).sort()).toEqual([...LEGACY_SERVICE_OUTCOMES].sort());
    const target = noPanel.candidates.find((c) => c.evidence.holders.length === 1);
    if (target === undefined) throw new Error('no single-holder candidate');
    const detail = legacyServiceCandidateDetailResponseSchema.parse(
      await controller.detail(request('GET'), target.id),
    );
    expect(detail.adoptPanels).toEqual([panelBId]);
    const approved = legacyServiceCandidateResponseSchema.parse(
      await controller.adopt(request('POST'), target.id, {
        idempotencyKey: key(),
        expectedVersion: target.version,
        panelId: panelBId,
        reason: 'از طریق وب',
      }),
    );
    expect(approved.candidate).toMatchObject({
      reviewState: 'ADOPT_APPROVED',
      approvedPanelId: panelBId,
    });
  });
});
