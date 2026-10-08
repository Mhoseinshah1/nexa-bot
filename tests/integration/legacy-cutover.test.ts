import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  LEGACY_CUTOVER_ERROR_CODES,
  LEGACY_CUTOVER_GATE_STEPS,
  LEGACY_FINAL_REPORT_V2_INVARIANTS,
  LEGACY_TABLE_CLASSIFICATION,
  money,
  systemJobActor,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type LegacyCutoverApprovalKind,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import {
  CUTOVER_EXPECTED_FLAGS,
  runCutoverGate,
  runFreezeChecker,
  sha256OfFile,
  type CutoverGateArgs,
} from '../../apps/api/src/legacy-import-cutover';
import { runInventory } from '../../apps/api/src/legacy-import-inventory';
import { exitCodeForError, parseArgs, runMode } from '../../apps/api/src/legacy-import.cli';
import { LegacyCutoverRefused } from '../../apps/api/src/modules/platform/legacy-cutover/domain/cutover-rules';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { LegacyImporterService } from '../../apps/api/src/modules/platform/legacy-importer/application/legacy-importer.service';
import { takeLegacyInventory } from '../../apps/api/src/modules/platform/legacy-importer/application/legacy-inventory';
import {
  parsePanelMapping,
  type PanelMapping,
} from '../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import {
  readFromSession,
  readImportV1Identity,
  type LegacySnapshot,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import {
  SYNTHETIC_EXISTING_CUSTOMER,
  SYNTHETIC_PANEL_ACCOUNTS,
  SYNTHETIC_UNCLASSIFIED_TABLE,
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
// The rehearsal's own validator, so the schema test and the harness can never disagree.
import { loadRefs, validate } from '../../scripts/legacy-rehearsal-report-check.mjs';

/**
 * Mirza migration PR6 — the owner's cutover approval, the gated import, SOURCE_SUPERSEDED,
 * the final report v2 and the cutover gate, end to end: PostgreSQL, two fake RickPanels, the
 * SYNTHETIC legacy dataset. NOT EVIDENCE about the legacy archive or RickPanel; every count
 * is a closure over the fixture, never a real-data figure.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const GIB = 1024n ** 3n;
const V2_SCHEMA = 'docs/legacy-migration/final-report-v2.schema.json';
const CHECKER = 'scripts/legacy-freeze-checksum-verify.sh';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** The dataset with no UNCLASSIFIED table (every table reviewed) and no non-Telegram id. */
function cleanDataset(base: SyntheticLegacyDataset = buildSyntheticLegacyDataset()) {
  return {
    ...base,
    schema: base.schema.filter((c) => c.table !== SYNTHETIC_UNCLASSIFIED_TABLE),
    tables: {
      ...base.tables,
      user: base.tables.user.filter((u) => u['id'] !== 'not-a-telegram-id'),
      [SYNTHETIC_UNCLASSIFIED_TABLE]: [],
    },
  } as SyntheticLegacyDataset;
}

/** A newer snapshot: one balance changed, one user added. Same tables. */
function newerSnapshot(base: SyntheticLegacyDataset): SyntheticLegacyDataset {
  const users = base.tables.user.map((u) =>
    u['id'] === '100000011' ? ({ ...u, Balance: '22345' } as SyntheticRow) : u,
  );
  const template = base.tables.user.find((u) => u['id'] === '100000011') as SyntheticRow;
  users.push({ ...template, id: '100000099', Balance: '4000' });
  return { ...base, tables: { ...base.tables, user: users } };
}

describe('Mirza PR6: the cutover approval, the gate and the final report v2', () => {
  let ctx: TestContext;
  let panelA: FakeRickpanel;
  let panelB: FakeRickpanel;
  let owner: ActorContext;
  let mapping: PanelMapping;
  let p1Product: string;
  let mappingText: string;
  let keySeq = 0;
  const key = () => `cutover-${String((keySeq += 1))}-${ctx.container.ids.uuid()}`;
  const job = (name: string) =>
    systemJobActor(`legacy-import:${name}`, `corr-${name}` as CorrelationId);
  const db = () => ctx.container.database.db;
  const cutover = () => ctx.container.legacyCutover;
  const FREEZE_FROZEN = 'base_tables\n2\nTable\tChecksum\noldbot.invoice\t11\noldbot.user\t22\n';
  const FREEZE_RESTORED =
    'base_tables\n2\nTable\tChecksum\noldbot_b.invoice\t11\noldbot_b.user\t22\n';
  const FREEZE_SHA = sha(FREEZE_FROZEN);
  const DUMP_SHA = sha('the final dump');

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
      idempotencyKey: `pr6-panel-${name}`,
    });
    await validatePanelConnection(ctx.container, tenantA, created.view.panel.id);
    return { fake, id: created.view.panel.id };
  }

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-pr6', roleKeys: ['owner'] }),
    );
    const a = await rickpanel('127.0.0.2', SYNTHETIC_PANEL_ACCOUNTS.A, 'a');
    const b = await rickpanel('127.0.0.3', SYNTHETIC_PANEL_ACCOUNTS.B, 'b');
    panelA = a.fake;
    panelB = b.fake;
    const products = new DrizzleProductRepository(db());
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ۳۰',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 1,
        panelId: a.id as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 30n * GIB, deviceLimit: null },
        price: money(200_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    mappingText = syntheticMappingFile(
      tenantA.tenantId as unknown as string,
      a.id,
      b.id,
      product.id,
    );
    mapping = parsePanelMapping(mappingText, tenantA.tenantId as unknown as string);
    p1Product = product.id;
    await ctx.container.customers.resolveFromUpdate(tenantA, job('webhook'), {
      idempotencyKey: 'pr6-existing',
      telegramUserId: SYNTHETIC_EXISTING_CUSTOMER,
      from: { id: Number(SYNTHETIC_EXISTING_CUSTOMER), first_name: 'Existing' },
      botInstanceId: BOT_A,
    });
  });

  function importer(): LegacyImporterService {
    return ctx.container.legacyImporter({ inventoryPageSize: 3 });
  }

  const connectorOf = (ds: SyntheticLegacyDataset) => new FixtureLegacySourceConnector(ds as never);

  async function snapshotOf(ds: SyntheticLegacyDataset): Promise<LegacySnapshot> {
    const connector = connectorOf(ds);
    return readFromSession(connector.label, await connector.open());
  }

  interface Fingerprints {
    readonly v1: string;
    readonly inventory: string;
    readonly products: string;
    readonly archive: string;
  }

  /** PR1–PR3's reads, as the runbook runs them: digest, approve, ingest, each bound to v1. */
  async function recordReadSets(ds: SyntheticLegacyDataset): Promise<Fingerprints> {
    const read = { scope: tenantA, actor: job('read'), productionLikeTarget: false };
    const session = await connectorOf(ds).open();
    const v1 = (await readImportV1Identity(session)).fingerprint;
    await session.close();
    const inventory = await runInventory(
      importer(),
      connectorOf(ds),
      { expectedFingerprint: v1 },
      read,
    );
    const products = await importer().readProducts({
      ...read,
      connector: connectorOf(ds),
      expectedFingerprint: v1,
      expectedProductsFingerprint: null,
    });
    await importer().readProducts({
      ...read,
      connector: connectorOf(ds),
      expectedFingerprint: v1,
      expectedProductsFingerprint: products.fingerprint,
    });
    // aud5 F5: the map's p1 entry is what the approved review exports (as products-export
    // would write it); an APPLY refuses a map the review does not back.
    const p1 = (
      await ctx.container.legacyProductReviews.list(tenantA, owner, { q: 'p1' })
    ).items.find((i) => i.review.codeProduct === 'p1')?.review;
    if (p1 !== undefined && p1.state === 'PENDING_REVIEW') {
      await ctx.container.legacyProductReviews.approveExisting(tenantA, owner, p1.id, {
        idempotencyKey: key(),
        expectedFactsChecksum: p1.factsChecksum,
        expectedVersion: p1.version,
        productId: p1Product,
        reason: 'the panel map names this product',
      });
    }
    const archive = await importer().readInvoiceArchive({
      ...read,
      connector: connectorOf(ds),
      expectedFingerprint: v1,
      expectedInvoiceArchiveFingerprint: null,
    });
    await importer().readInvoiceArchive({
      ...read,
      connector: connectorOf(ds),
      expectedFingerprint: v1,
      expectedInvoiceArchiveFingerprint: archive.fingerprint,
    });
    return {
      v1,
      inventory: inventory.inventory.fingerprint,
      products: products.fingerprint,
      archive: archive.fingerprint,
    };
  }

  function expectationOf(fp: Fingerprints, overrides: Partial<Record<string, string | null>> = {}) {
    return {
      sourceFingerprint: fp.v1,
      panelMapFingerprint: mapping.fingerprint,
      inventoryFingerprint: fp.inventory,
      productsFingerprint: fp.products,
      invoiceArchiveFingerprint: fp.archive,
      freezeProofSha256: FREEZE_SHA,
      finalDumpSha256: DUMP_SHA,
      ...overrides,
    } as never;
  }

  function approveBody(
    fp: Fingerprints,
    kind: LegacyCutoverApprovalKind = 'CUTOVER',
    prior: string | null = null,
  ) {
    return {
      idempotencyKey: key(),
      kind,
      sourceFingerprint: fp.v1,
      panelMapFingerprint: mapping.fingerprint,
      inventoryFingerprint: fp.inventory,
      productsFingerprint: fp.products,
      invoiceArchiveFingerprint: fp.archive,
      freezeProofSha256: FREEZE_SHA,
      finalDumpSha256: DUMP_SHA,
      priorSourceFingerprint: prior,
      reason: 'approved after the freeze proof and the final dump',
    };
  }

  function apply(
    name: string,
    snap: LegacySnapshot,
    options: {
      readonly productionLikeTarget?: boolean;
      readonly gate?: Record<string, string | null> | null;
    } = {},
  ) {
    return importer().apply({
      scope: tenantA,
      actor: job(name),
      snapshot: snap,
      mapping,
      productionLikeTarget: options.productionLikeTarget ?? false,
      mode: 'IMPORT',
      ...(options.gate === undefined || options.gate === null
        ? {}
        : { cutoverGate: { expectation: options.gate as never } }),
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

  const businessWrites = () =>
    Promise.all([
      count('legacy_import_runs', "mode = 'APPLY'"),
      count('legacy_import_map'),
      count('customers'),
      count('wallet_entries'),
      count('legacy_wallet_debts'),
      count('services'),
      count('legacy_service_candidates'),
    ]);

  /**
   * Stop sales the runbook's way: a MAINTENANCE incident ACTIVE with stop_sales, every panel
   * drained, every gateway disabled. A gated import requires it at its start and its finish
   * (aud6 F2). Returns a function that reopens sales (resolves the incident).
   */
  async function stopSales(): Promise<() => Promise<void>> {
    await db().execute(sql`
      INSERT INTO incidents (id, tenant_id, kind, severity, status, title, stop_sales, admin_banner,
                             started_at, created_at, updated_at)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'MAINTENANCE', 'MAJOR', 'ACTIVE',
              'migration window', true, true, now(), now(), now())`);
    await db().execute(
      sql`UPDATE panels SET drained_at = now(), drain_reason = 'cutover' WHERE tenant_id = ${tenantA.tenantId}`,
    );
    await db().execute(
      sql`UPDATE payment_gateways SET status = 'DISABLED' WHERE tenant_id = ${tenantA.tenantId}`,
    );
    return async () => {
      await db().execute(
        sql`UPDATE incidents SET status = 'RESOLVED', resolved_at = now() WHERE tenant_id = ${tenantA.tenantId} AND status = 'ACTIVE'`,
      );
    };
  }

  async function refusal(promise: Promise<unknown>): Promise<LegacyCutoverRefused> {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LegacyCutoverRefused);
    return error as LegacyCutoverRefused;
  }

  // --- the approval -------------------------------------------------------------------------

  it('the owner records an approval bound to RECORDED read sets: audited, replayed exactly, append-only, revocable once', async () => {
    const ds = cleanDataset();
    const session = await connectorOf(ds).open();
    const v1 = (await readImportV1Identity(session)).fingerprint;
    await session.close();
    // Nothing recorded yet: an approval cannot name a read set NEXA never observed.
    const unrecorded = {
      v1,
      inventory: 'a'.repeat(64),
      products: 'b'.repeat(64),
      archive: 'c'.repeat(64),
    };
    await expect(cutover().approve(tenantA, owner, approveBody(unrecorded))).rejects.toMatchObject({
      code: LEGACY_CUTOVER_ERROR_CODES.READ_SET_NOT_RECORDED,
    });

    const fp = await recordReadSets(ds);
    const body = approveBody(fp);
    const approval = await cutover().approve(tenantA, owner, body);
    expect(approval).toMatchObject({
      kind: 'CUTOVER',
      sourceFingerprint: fp.v1,
      inventoryFingerprint: fp.inventory,
      productsFingerprint: fp.products,
      invoiceArchiveFingerprint: fp.archive,
      freezeProofSha256: FREEZE_SHA,
      finalDumpSha256: DUMP_SHA,
      priorSourceFingerprint: null,
      // The read sets came from the SYNTHETIC fixture: so does the approval.
      synthetic: true,
      approvedByAdminId: owner.id,
      revocation: null,
    });
    // The same binding again (another key) is refused; the same key replays the original.
    await expect(
      cutover().approve(tenantA, owner, { ...body, idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: LEGACY_CUTOVER_ERROR_CODES.ALREADY_APPROVED });
    // A re-run acknowledgement needs an earlier import of the source it names.
    await expect(
      cutover().approve(tenantA, owner, approveBody(fp, 'RERUN_OVER_PRIOR_IMPORT', 'd'.repeat(64))),
    ).rejects.toMatchObject({ code: LEGACY_CUTOVER_ERROR_CODES.NO_PRIOR_IMPORT });

    // Audited with fingerprints only.
    const audits = await db().execute<{ after: Record<string, unknown>; result: string }>(
      sql`SELECT after, result FROM audit_logs WHERE action = 'legacy.cutover.approve' AND entity_id = ${approval.id}`,
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]?.result).toBe('SUCCESS');
    expect(audits.rows[0]?.after).toMatchObject({ sourceFingerprint: fp.v1, synthetic: true });
    expect(JSON.stringify(audits.rows[0]?.after)).not.toMatch(/1000000\d\d|alice_legacy|svc_/u);

    // Append-only at the database, for every role.
    await expect(
      db().execute(
        sql`UPDATE legacy_cutover_approvals SET final_dump_sha256 = ${'e'.repeat(64)} WHERE id = ${approval.id}`,
      ),
    ).rejects.toThrow();
    await expect(
      db().execute(sql`DELETE FROM legacy_cutover_approvals WHERE id = ${approval.id}`),
    ).rejects.toThrow();

    // Revoked once, for good; the revocation is append-only too.
    const revokeBody = { idempotencyKey: key(), reason: 'the freeze was lifted' };
    const revoked = await cutover().revoke(tenantA, owner, approval.id, revokeBody);
    expect(revoked.revocation).toMatchObject({ revokedByAdminId: owner.id });
    expect(await cutover().revoke(tenantA, owner, approval.id, revokeBody)).toEqual(revoked);
    await expect(
      cutover().revoke(tenantA, owner, approval.id, { idempotencyKey: key(), reason: 'again' }),
    ).rejects.toMatchObject({ code: LEGACY_CUTOVER_ERROR_CODES.ALREADY_REVOKED });
    await expect(
      db().execute(
        sql`DELETE FROM legacy_cutover_approval_revocations WHERE approval_id = ${approval.id}`,
      ),
    ).rejects.toThrow();
    // The original answer, not today's row: the replay still shows it unrevoked.
    expect(await cutover().approve(tenantA, owner, body)).toEqual(approval);
    // After a revocation the same binding may be approved again — as a NEW row.
    const again = await cutover().approve(tenantA, owner, { ...body, idempotencyKey: key() });
    expect(again.id).not.toBe(approval.id);
  });

  it('two concurrent requests under ONE idempotency key: one approval, both get its original answer', async () => {
    const fp = await recordReadSets(cleanDataset());
    const body = approveBody(fp);
    const both = await Promise.all([
      cutover().approve(tenantA, owner, body),
      cutover().approve(tenantA, owner, body),
    ]);
    // Never ALREADY_APPROVED: the second waited on the tenant lock, then found the first's
    // stored answer and returned it.
    expect(both[1]).toEqual(both[0]);
    expect(await count('legacy_cutover_approvals')).toBe(1);
    const approval = both[0];

    const revokeBody = { idempotencyKey: key(), reason: 'withdrawn' };
    const revoked = await Promise.all([
      cutover().revoke(tenantA, owner, approval.id, revokeBody),
      cutover().revoke(tenantA, owner, approval.id, revokeBody),
    ]);
    expect(revoked[1]).toEqual(revoked[0]);
    expect(revoked[0].revocation).not.toBeNull();
    expect(await count('legacy_cutover_approval_revocations')).toBe(1);
  });

  it('approval is CRITICAL and owner-only: DENIED is audited; another tenant sees and revokes nothing', async () => {
    const fp = await recordReadSets(cleanDataset());
    const operator = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'operator-pr6',
        roleKeys: ['operator'],
      }),
    );
    await expect(cutover().approve(tenantA, operator, approveBody(fp))).rejects.toThrow();
    const denied = await db().execute(
      sql`SELECT 1 FROM audit_logs WHERE action = 'legacy.cutover.approve' AND result = 'DENIED'`,
    );
    expect(denied.rows).toHaveLength(1);
    expect(await count('legacy_cutover_approvals')).toBe(0);
    // The permission is checked BEFORE the untrusted body is parsed: a caller without it gets
    // PERMISSION_DENIED (never a validation error describing a valid body) and a DENIED row.
    await expect(
      cutover().approve(tenantA, operator, { kind: 'NOT_A_KIND', sourceFingerprint: 'x' }),
    ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
    await expect(
      cutover().revoke(tenantA, operator, '0190aaaa-0000-7000-8000-000000000001', { reason: 7 }),
    ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
    const deniedAfter = await db().execute<{ action: string; entity_id: string | null }>(
      sql`SELECT action, entity_id FROM audit_logs WHERE action LIKE 'legacy.cutover.%' AND result = 'DENIED' ORDER BY occurred_at, id`,
    );
    expect(deniedAfter.rows.map((r) => r.action)).toEqual([
      'legacy.cutover.approve',
      'legacy.cutover.approve',
      'legacy.cutover.revoke',
    ]);

    const approval = await cutover().approve(tenantA, owner, approveBody(fp));
    const otherOwner = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-b-pr6', roleKeys: ['owner'] }),
    );
    expect((await cutover().listApprovals(tenantB, otherOwner, {})).items).toEqual([]);
    expect((await cutover().listReadSets(tenantB, otherOwner, {})).items).toEqual([]);
    await expect(
      cutover().revoke(tenantB, otherOwner, approval.id, { idempotencyKey: key(), reason: 'x' }),
    ).rejects.toMatchObject({ code: LEGACY_CUTOVER_ERROR_CODES.NOT_FOUND });
    expect((await cutover().listApprovals(tenantA, owner, {})).items.map((a) => a.id)).toEqual([
      approval.id,
    ]);

    // A tenant that stopped accepting work records and revokes nothing (read inside the tx).
    await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`);
    await expect(
      cutover().revoke(tenantA, owner, approval.id, { idempotencyKey: key(), reason: 'x' }),
    ).rejects.toMatchObject({ code: LEGACY_CUTOVER_ERROR_CODES.SCOPE_STOPPED });
    await expect(
      cutover().approve(tenantA, owner, { ...approveBody(fp), finalDumpSha256: 'e'.repeat(64) }),
    ).rejects.toMatchObject({ code: LEGACY_CUTOVER_ERROR_CODES.SCOPE_STOPPED });
  });

  it('backfills the two keys into existing owner roles only, idempotently', async () => {
    await db().execute(
      sql`DELETE FROM role_permissions WHERE permission_key LIKE 'legacy.cutover.%'`,
    );
    const migration = readFileSync('apps/api/drizzle/0235_legacy_cutover_grants.sql', 'utf8');
    const backfill = migration.slice(migration.indexOf('INSERT INTO "role_permissions"'));
    await db().execute(sql.raw(backfill));
    await db().execute(sql.raw(backfill));
    const rows = await db().execute<{ role_key: string; permission_key: string }>(
      sql`SELECT r.key AS role_key, rp.permission_key FROM role_permissions rp
            JOIN roles r ON r.id = rp.role_id
           WHERE rp.permission_key LIKE 'legacy.cutover.%' AND r.tenant_id = ${tenantA.tenantId}
           ORDER BY 2`,
    );
    expect(rows.rows).toEqual([
      { role_key: 'owner', permission_key: 'legacy.cutover.approve' },
      { role_key: 'owner', permission_key: 'legacy.cutover.view' },
    ]);
  });

  // --- the gated import -----------------------------------------------------------------------

  it('a gated import refuses without a matching approval, with zero writes; a changed value voids it; revoked is refused', async () => {
    const ds = cleanDataset();
    const fp = await recordReadSets(ds);
    const snap = await snapshotOf(ds);
    const before = await businessWrites();

    expect((await refusal(apply('no-approval', snap, { gate: expectationOf(fp) }))).code).toBe(
      'APPROVAL_MISSING',
    );
    expect(
      (
        await refusal(
          apply('incomplete', snap, { gate: expectationOf(fp, { finalDumpSha256: null }) }),
        )
      ).code,
    ).toBe('EXPECTATION_INCOMPLETE');
    // Fail closed: an explicitly production-like target is gated even with no expectation.
    expect((await refusal(apply('prod-no-gate', snap, { productionLikeTarget: true }))).code).toBe(
      'EXPECTATION_INCOMPLETE',
    );

    const approval = await cutover().approve(tenantA, owner, approveBody(fp));
    // Every one of the seven values is bound: change any one and there is no approval.
    for (const field of Object.keys(CUTOVER_EXPECTED_FLAGS)) {
      const changed =
        field === 'sourceFingerprint' || field === 'panelMapFingerprint' ? null : 'f'.repeat(64);
      if (changed === null) continue;
      expect(
        (
          await refusal(
            apply(`changed-${field}`, snap, { gate: expectationOf(fp, { [field]: changed }) }),
          )
        ).code,
        field,
      ).toBe('APPROVAL_MISSING');
    }
    // A source or map other than the snapshot's is refused before any approval is consulted.
    expect(
      (
        await refusal(
          apply('other-source', snap, {
            gate: expectationOf(fp, { sourceFingerprint: 'f'.repeat(64) }),
          }),
        )
      ).code,
    ).toBe('APPROVAL_MISSING');
    expect(
      (
        await refusal(
          apply('other-map', snap, {
            gate: expectationOf(fp, { panelMapFingerprint: 'f'.repeat(64) }),
          }),
        )
      ).code,
    ).toBe('APPROVAL_MISSING');
    // The approval binds what is IMPORTED: another snapshot under this approval's values is
    // refused by the service itself, whatever the caller typed.
    const other = await snapshotOf(newerSnapshot(ds));
    const wrongSnapshot = await refusal(
      apply('other-snapshot', other, { gate: expectationOf(fp) }),
    );
    expect(wrongSnapshot.code).toBe('APPROVAL_MISSING');
    expect(wrongSnapshot.message).toContain(other.fingerprint);
    // A synthetic approval never opens a production-like target (PR3's stored-state lesson).
    expect(
      (
        await refusal(
          apply('prod-synthetic', snap, { productionLikeTarget: true, gate: expectationOf(fp) }),
        )
      ).code,
    ).toBe('APPROVAL_SYNTHETIC');
    await cutover().revoke(tenantA, owner, approval.id, {
      idempotencyKey: key(),
      reason: 'withdrawn',
    });
    expect((await refusal(apply('revoked', snap, { gate: expectationOf(fp) }))).code).toBe(
      'APPROVAL_MISSING',
    );
    expect(await businessWrites()).toEqual(before);

    const fresh = await cutover().approve(tenantA, owner, approveBody(fp));
    // aud6 F2: approved, and sales still open — refused at the start, nothing written.
    const open = await refusal(apply('sales-open', snap, { gate: expectationOf(fp) }));
    expect(open.code).toBe('STOP_SALES_NOT_ACTIVE');
    expect(open.message).toContain('Nothing was written');
    expect(await businessWrites()).toEqual(before);
    await stopSales();
    const report = await apply('approved', snap, { gate: expectationOf(fp) });
    expect(report.verdict).toMatch(/^COMPLETED/u);
    const start = await db().execute<{ after: Record<string, any> }>(
      sql`SELECT after FROM audit_logs WHERE action = 'legacy_import.run.start' ORDER BY occurred_at, id`,
    );
    expect(start.rows.at(-1)?.after['cutover']).toMatchObject({
      cutoverApprovalId: fresh.id,
      rerunApprovalIds: [],
      supersededSources: [],
    });
  });

  it('aud6 F2: sales reopened DURING a gated import: the run is never COMPLETED; a resume under a restored freeze finishes it', async () => {
    const ds = cleanDataset();
    const fp = await recordReadSets(ds);
    const snap = await snapshotOf(ds);
    await cutover().approve(tenantA, owner, approveBody(fp));
    const reopen = await stopSales();
    const gated = (
      name: string,
      mode: 'IMPORT' | 'RESUME',
      afterPhase?: (p: string) => Promise<void>,
    ) =>
      importer().apply({
        scope: tenantA,
        actor: job(name),
        snapshot: snap,
        mapping,
        productionLikeTarget: false,
        mode,
        cutoverGate: { expectation: expectationOf(fp) },
        ...(afterPhase === undefined ? {} : { afterPhase }),
      });
    // An operator resumes sales while the import runs (after its customers phase).
    const refused = await refusal(
      gated('reopened', 'IMPORT', async (phase) => {
        if (phase === 'customers') await reopen();
      }),
    );
    expect(refused.code).toBe('STOP_SALES_NOT_ACTIVE');
    expect(refused.message).toContain('stays RUNNING');
    const runs = await db().execute<{ status: string }>(
      sql`SELECT status FROM legacy_import_runs WHERE tenant_id = ${tenantA.tenantId} AND mode = 'APPLY'`,
    );
    expect(runs.rows.map((r) => r.status)).toEqual(['RUNNING']);
    // A resume while sales are still open is refused at its start, and writes nothing.
    const before = await businessWrites();
    expect((await refusal(gated('resume-open', 'RESUME'))).code).toBe('STOP_SALES_NOT_ACTIVE');
    expect(await businessWrites()).toEqual(before);
    // Freeze restored: the resume finishes the run.
    await stopSales();
    const resumed = await gated('resume', 'RESUME');
    expect(resumed.verdict).toMatch(/^COMPLETED/u);
    expect((resumed.sections as Record<string, any>)['run'].status).toBe('COMPLETED');
  });

  it("a gated import re-checks the approval's read sets at import time: one no longer recorded refuses it", async () => {
    // Defence in depth: `legacy_read_set_runs` is append-only (0220), so this state is reachable
    // only by bypassing that guard — which is exactly what this test does, as the table owner.
    // The approval was valid when it was recorded; the import must still refuse it.
    const ds = cleanDataset();
    const fp = await recordReadSets(ds);
    const snap = await snapshotOf(ds);
    await cutover().approve(tenantA, owner, approveBody(fp));
    await db().transaction(async (tx) => {
      await tx.execute(
        sql`ALTER TABLE legacy_read_set_runs DISABLE TRIGGER legacy_read_set_runs_no_delete`,
      );
      await tx.execute(sql`DELETE FROM legacy_read_set_runs WHERE read_set = 'products'`);
      await tx.execute(
        sql`ALTER TABLE legacy_read_set_runs ENABLE TRIGGER legacy_read_set_runs_no_delete`,
      );
    });
    const before = await businessWrites();
    const refused = await refusal(apply('read-set-gone', snap, { gate: expectationOf(fp) }));
    expect(refused.code).toBe('APPROVAL_MISSING');
    expect(refused.message).toContain('products read set');
    expect(await businessWrites()).toEqual(before);
  });

  it('the CLI: every value is required, an UNCLASSIFIED table blocks the cutover, both refusals exit 65 with nothing written', async () => {
    // The default fixture keeps its UNCLASSIFIED table: the inventory records it, the owner can
    // even approve it, and the gated import still refuses — nothing reads past an unknown table.
    const ds = buildSyntheticLegacyDataset();
    const fp = await recordReadSets(ds);
    await cutover().approve(tenantA, owner, approveBody(fp));
    const flags = [
      '--expected-fingerprint',
      fp.v1,
      '--expected-panel-map-fingerprint',
      mapping.fingerprint,
      '--expected-inventory-fingerprint',
      fp.inventory,
      '--expected-products-fingerprint',
      fp.products,
      '--expected-invoice-archive-fingerprint',
      fp.archive,
      '--expected-freeze-proof-sha256',
      FREEZE_SHA,
      '--expected-final-dump-sha256',
      DUMP_SHA,
    ];
    const base = [
      'import',
      '--tenant',
      'acme',
      '--source',
      'fixture:unused.json',
      '--target',
      'nexa_p6_cutover',
      '--panel-map',
      'unused.json',
      '--evidence-class',
      'synthetic',
      '--cutover-gate',
    ];
    const context = {
      tenantId: tenantA.tenantId as unknown as string,
      productionLikeTarget: false,
    };
    const before = await businessWrites();
    const run = (argv: string[]) =>
      runMode(importer(), parseArgs(argv), connectorOf(ds), mappingText, 'corr-cli', context);

    const incomplete = await refusal(run([...base, ...flags.slice(0, -2)]));
    expect(incomplete.code).toBe('EXPECTATION_INCOMPLETE');
    expect(incomplete.message).toContain('--expected-final-dump-sha256');
    expect(exitCodeForError(incomplete)).toBe(65);

    const unclassified = await refusal(run([...base, ...flags]));
    expect(unclassified.code).toBe('TABLES_UNCLASSIFIED');
    expect(exitCodeForError(unclassified)).toBe(65);
    expect(await businessWrites()).toEqual(before);
    expect(() => parseArgs(['audit', ...base.slice(1)])).toThrow(
      /--cutover-gate applies to import/u,
    );
  });

  // --- SOURCE_SUPERSEDED ------------------------------------------------------------------------

  it('SOURCE_SUPERSEDED: a newer snapshot over an earlier import is refused; acknowledged, it re-runs and duplicates nothing', async () => {
    const a = cleanDataset();
    const fpA = await recordReadSets(a);
    const snapA = await snapshotOf(a);
    // The historical snapshot, imported the staging way (no gate).
    await apply('historical', snapA);
    const after = {
      customers: await count('customers'),
      openings: await count('wallet_entries', "reason = 'MIGRATION_OPENING_BALANCE'"),
      debts: await count('legacy_wallet_debts'),
      services: await count('services'),
      candidates: await count('legacy_service_candidates'),
    };

    const b = newerSnapshot(a);
    const fpB = await recordReadSets(b);
    expect(fpB.v1).not.toBe(fpA.v1);
    const snapB = await snapshotOf(b);
    await cutover().approve(tenantA, owner, approveBody(fpB));
    const writes = await businessWrites();
    await stopSales();
    const superseded = await refusal(apply('superseded', snapB, { gate: expectationOf(fpB) }));
    expect(superseded.code).toBe('SOURCE_SUPERSEDED');
    expect(superseded.message).toContain(fpA.v1);
    expect(await businessWrites()).toEqual(writes);

    // An acknowledgement of ANOTHER prior source is no acknowledgement.
    await expect(
      cutover().approve(
        tenantA,
        owner,
        approveBody(fpB, 'RERUN_OVER_PRIOR_IMPORT', 'a'.repeat(64)),
      ),
    ).rejects.toMatchObject({ code: LEGACY_CUTOVER_ERROR_CODES.NO_PRIOR_IMPORT });
    const ack = await cutover().approve(
      tenantA,
      owner,
      approveBody(fpB, 'RERUN_OVER_PRIOR_IMPORT', fpA.v1),
    );
    const rerun = await apply('rerun', snapB, { gate: expectationOf(fpB) });
    expect(rerun.verdict).toMatch(/^COMPLETED/u);
    const start = await db().execute<{ after: Record<string, any> }>(
      sql`SELECT after FROM audit_logs WHERE action = 'legacy_import.run.start' ORDER BY occurred_at, id`,
    );
    expect(start.rows.at(-1)?.after['cutover']).toMatchObject({
      rerunApprovalIds: [ack.id],
      supersededSources: [fpA.v1],
    });
    // A re-run, never a merge: one new customer and its one opening; the changed balance is
    // SOURCE_CHANGED and never applied; nothing else is written twice.
    expect(await count('customers')).toBe(after.customers + 1);
    expect(await count('wallet_entries', "reason = 'MIGRATION_OPENING_BALANCE'")).toBe(
      after.openings + 1,
    );
    expect(await count('legacy_wallet_debts')).toBe(after.debts);
    expect(await count('services')).toBe(after.services);
    expect(await count('legacy_service_candidates')).toBe(after.candidates);
    const changed = await db().execute<{ amount: string }>(
      sql`SELECT w.amount::text AS amount FROM wallet_entries w JOIN customers c
            ON c.tenant_id = w.tenant_id AND c.id = w.customer_id
           WHERE w.tenant_id = ${tenantA.tenantId} AND c.telegram_user_id = '100000011'
             AND w.reason = 'MIGRATION_OPENING_BALANCE'`,
    );
    expect(changed.rows.map((r) => r.amount)).toEqual(['12345']);

    const report = await importer().finalReport({
      scope: tenantA,
      actor: job('report'),
      snapshot: snapB,
      mapping,
      productionLikeTarget: false,
      evidenceClass: 'synthetic',
      inventory: await takeLegacyInventory(
        connectorOf(b),
        fpB.v1,
        Object.keys(LEGACY_TABLE_CLASSIFICATION),
      ),
    });
    const v2 = report.finalV2 as Record<string, any>;
    expect(v2['sections'].usersWallets.sourceChanged.users).toBe(1);
    expect(v2['sections'].cutover.supersededSources).toEqual([
      { sourceFingerprint: fpA.v1, acknowledged: true },
    ]);
    expect(v2['invariants'].find((i: { id: string }) => i.id === 'RERUN_NO_DUPLICATES').holds).toBe(
      true,
    );

    // Revoke the acknowledgement: the report says the earlier import is superseded unacknowledged.
    await cutover().revoke(tenantA, owner, ack.id, {
      idempotencyKey: key(),
      reason: 'reconsidered',
    });
    const again = (
      await importer().finalReport({
        scope: tenantA,
        actor: job('report-2'),
        snapshot: snapB,
        mapping,
        productionLikeTarget: false,
        evidenceClass: 'synthetic',
      })
    ).finalV2 as Record<string, any>;
    expect(again['sections'].cutover.holds).toBe(false);
    expect(again['verdict'].failedSections).toContain('cutover');

    // A NEW approval pair under other values (another freeze proof) acknowledges a re-run that
    // never ran. The reported run started under the first approval, whose acknowledgement is
    // revoked: the applicable binding is that run's, so the earlier import stays unacknowledged.
    const other = { freezeProofSha256: 'c'.repeat(64) };
    await cutover().approve(tenantA, owner, { ...approveBody(fpB), ...other });
    await cutover().approve(tenantA, owner, {
      ...approveBody(fpB, 'RERUN_OVER_PRIOR_IMPORT', fpA.v1),
      ...other,
    });
    const third = (
      await importer().finalReport({
        scope: tenantA,
        actor: job('report-3'),
        snapshot: snapB,
        mapping,
        productionLikeTarget: false,
        evidenceClass: 'synthetic',
      })
    ).finalV2 as Record<string, any>;
    expect(third['sections'].cutover.supersededSources).toEqual([
      { sourceFingerprint: fpA.v1, acknowledged: false },
    ]);
    expect(third['verdict'].failedSections).toContain('cutover');
  });

  // --- report v2 --------------------------------------------------------------------------------

  it('report v2 validates against its schema, carries v1 unchanged as core, lists only facts read, names no person', async () => {
    const ds = cleanDataset();
    const fp = await recordReadSets(ds);
    const snap = await snapshotOf(ds);
    await cutover().approve(tenantA, owner, approveBody(fp));
    await stopSales();
    await apply('import', snap, { gate: expectationOf(fp) });
    const input = {
      scope: tenantA,
      actor: job('report'),
      snapshot: snap,
      mapping,
      productionLikeTarget: false,
      evidenceClass: 'synthetic' as const,
    };
    const report = await importer().finalReport({
      ...input,
      inventory: await takeLegacyInventory(
        connectorOf(ds),
        fp.v1,
        Object.keys(LEGACY_TABLE_CLASSIFICATION),
      ),
    });
    const v2 = JSON.parse(JSON.stringify(report.finalV2)) as Record<string, any>;
    const schema = JSON.parse(readFileSync(V2_SCHEMA, 'utf8'));
    expect(validate(schema, v2, schema, loadRefs(V2_SCHEMA, schema))).toEqual([]);
    // v1, unchanged, is the core — and validates against v1's own schema.
    expect(v2['core']).toEqual(JSON.parse(JSON.stringify(report.final)));
    const v1schema = JSON.parse(
      readFileSync('docs/legacy-migration/final-report.schema.json', 'utf8'),
    );
    expect(validate(v1schema, v2['core'])).toEqual([]);
    expect(v2['invariants'].map((i: { id: string }) => i.id)).toEqual([
      ...LEGACY_FINAL_REPORT_V2_INVARIANTS,
    ]);
    expect(v2['sections'].inventory).toMatchObject({
      read: true,
      verdict: 'COMPLETE',
      holds: true,
    });
    expect(v2['sections'].products.missingFromReview).toBe(0);
    expect(v2['sections'].products.sourceDistinctCodes).toBe(snap.productCodes.size);
    expect(v2['sections'].invoiceArchive.run.sourceInvoiceRows).toBe(
      String(snap.tables.invoice.rows),
    );
    expect(v2['sections'].cutover.approvals).toHaveLength(1);
    // PR5's run counters, read back from the run's finish audit row — never assumed zero.
    expect(v2['sections'].applyRun).toMatchObject({
      recorded: true,
      holds: true,
      serviceApprovals: { withdrawnDuringRun: 0, unconfirmed: 0 },
      attention: { approvalUnconfirmed: 0 },
    });
    for (const id of [
      'INVOICES_ACCOUNTED',
      'PRODUCTS_ACCOUNTED',
      'SERVICES_ONE_OUTCOME',
      'RERUN_NO_DUPLICATES',
    ]) {
      expect(v2['invariants'].find((i: { id: string }) => i.id === id).holds, id).toBe(true);
    }
    const text = JSON.stringify(v2);
    for (const word of ['alice_legacy', 'svc_a1', '100000001', SYNTHETIC_EXISTING_CUSTOMER]) {
      expect(text).not.toContain(word);
    }

    expect(report.verdict).toBe('COMPLETED');
    // Version 1 for its consumers: no v2 document, and version 1's own verdict.
    const v1only = await importer().finalReport({ ...input, reportSchema: 1 });
    expect(v1only.finalV2).toBeUndefined();
    expect((v1only.final as Record<string, unknown>)['reconciliation']).toEqual(
      (report.final as Record<string, unknown>)['reconciliation'],
    );
    expect(v1only.verdict).toBe('COMPLETED');

    // Without a fresh inventory, the section says so, and the verdict cannot hold.
    const unreadReport = await importer().finalReport(input);
    expect(unreadReport.verdict).toBe('COMPLETED_WITH_DISCREPANCY');
    const unread = unreadReport.finalV2 as Record<string, any>;
    expect(unread['sections'].inventory).toMatchObject({ read: false, holds: false });
    expect(unread['verdict'].holds).toBe(false);
    expect(unread['verdict'].failedSections).toContain('inventory');
    expect(
      validate(schema, JSON.parse(JSON.stringify(unread)), schema, loadRefs(V2_SCHEMA, schema)),
    ).toEqual([]);
  });

  // --- the gate --------------------------------------------------------------------------------

  it('the cutover gate proves every step in order, stops at the first failure, and writes nothing', async () => {
    const ds = cleanDataset();
    const fp = await recordReadSets(ds);
    const snap = await snapshotOf(ds);
    const dir = mkdtempSync(join(tmpdir(), 'nexa-pr6-'));
    const frozen = join(dir, 'freeze-step7.tsv');
    const restored = join(dir, 'freeze-step9.tsv');
    writeFileSync(frozen, FREEZE_FROZEN);
    writeFileSync(restored, FREEZE_RESTORED);
    // The final dump the owner approved (DUMP_SHA is its SHA-256): the gate hashes THIS file.
    const dump = join(dir, 'final.dump');
    writeFileSync(dump, 'the final dump');
    const args: CutoverGateArgs = {
      tenant: 'acme',
      source: 'fixture:unused.json',
      sourcePasswordEnv: null,
      target: 'nexa_p6_cutover',
      panelMap: 'unused.json',
      evidenceClass: 'synthetic',
      expectation: expectationOf(fp),
      freezeProof: frozen,
      freezeProofRestored: restored,
      freezeChecker: CHECKER,
      finalDump: dump,
      format: 'json',
      allowProductionTarget: false,
    };
    const gate = () =>
      runCutoverGate(
        {
          importer: importer(),
          stopSalesFacts: () => cutover().stopSalesFacts(tenantA),
          connector: connectorOf(ds),
          readSnapshot: () => snapshotOf(ds),
          runChecker: runFreezeChecker,
          readBytes: (path) => Promise.resolve(readFileSync(path)),
          hashFile: sha256OfFile,
          now: () => ctx.container.clock.now(),
        },
        args,
        { scope: tenantA, actor: job('gate'), mapping, productionLikeTarget: false },
      );
    const resultOf = (report: Awaited<ReturnType<typeof gate>>) =>
      Object.fromEntries(report.steps.map((s) => [s.step, s.result]));

    // 1. Sales are still open: the gate stops at once.
    const first = await gate();
    expect(first.verdict).toBe('REFUSED');
    expect(first.failedStep).toBe('STOP_SALES_ACTIVE');
    expect(first.steps.map((s) => s.step)).toEqual([...LEGACY_CUTOVER_GATE_STEPS]);
    expect(first.steps.slice(1).every((s) => s.result === 'NOT_REACHED')).toBe(true);

    // Stop sales the runbook's way: a MAINTENANCE incident ACTIVE with stop_sales, every panel
    // drained, every gateway disabled (what its effects do through the owning modules).
    await db().execute(sql`
      INSERT INTO incidents (id, tenant_id, kind, severity, status, title, stop_sales, admin_banner,
                             started_at, created_at, updated_at)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'MAINTENANCE', 'MAJOR', 'ACTIVE',
              'migration window', true, true, now(), now(), now())`);
    await db().execute(
      sql`UPDATE panels SET drained_at = now(), drain_reason = 'cutover' WHERE tenant_id = ${tenantA.tenantId}`,
    );
    await db().execute(
      sql`UPDATE payment_gateways SET status = 'DISABLED' WHERE tenant_id = ${tenantA.tenantId}`,
    );

    // 2. A restored proof that differs from the frozen one: PR1's checker says so.
    writeFileSync(restored, FREEZE_RESTORED.replace('\t22', '\t23'));
    const differ = await gate();
    expect(differ.failedStep).toBe('FREEZE_PROOF_VERIFIED');
    // A stand-in "checker" that prints EQUAL is not PR1's checker.
    writeFileSync(restored, FREEZE_RESTORED);
    const fake = join(dir, 'fake-checker.sh');
    writeFileSync(fake, 'echo "EQUAL: every base table has the same checksum in both files"\n');
    expect((await runCutoverGateWith({ ...args, freezeChecker: fake })).failedStep).toBe(
      'FREEZE_PROOF_VERIFIED',
    );

    // 3. A dump file other than the approved one: the approved hash alone proves nothing.
    writeFileSync(dump, 'the final dump, edited after approval');
    const otherDump = await gate();
    expect(otherDump.failedStep).toBe('FINAL_DUMP_VERIFIED');
    expect(otherDump.steps.find((s) => s.step === 'FINAL_DUMP_VERIFIED')?.detail).toContain(
      'not the approved',
    );
    writeFileSync(dump, 'the final dump');

    // 6. No approval yet.
    const noApproval = await gate();
    expect(resultOf(noApproval)).toMatchObject({
      STOP_SALES_ACTIVE: 'PASS',
      FREEZE_PROOF_VERIFIED: 'PASS',
      FINAL_DUMP_VERIFIED: 'PASS',
      FRESH_FINGERPRINTS: 'PASS',
      TABLES_CLASSIFIED: 'PASS',
      APPROVAL_MATCHES: 'FAIL',
    });
    // 8. Approved, not imported.
    await cutover().approve(tenantA, owner, approveBody(fp));
    const notImported = await gate();
    expect(notImported.failedStep).toBe('IMPORT_COMPLETED');

    await apply('import', snap, { gate: expectationOf(fp) });
    const tables = [
      'legacy_import_runs',
      'legacy_import_map',
      'customers',
      'wallet_entries',
      'legacy_wallet_debts',
      'services',
      'legacy_service_candidates',
      'legacy_read_set_runs',
      'legacy_invoice_archive',
      'legacy_product_reviews',
      'legacy_cutover_approvals',
    ];
    const before = await Promise.all(tables.map((t) => count(t)));
    const ready = await gate();
    // The whole checklist, on the cleaned synthetic dataset. The gate itself wrote nothing.
    expect(ready.steps.map((s) => s.result)).toEqual(LEGACY_CUTOVER_GATE_STEPS.map(() => 'PASS'));
    expect(ready).toMatchObject({
      verdict: 'CUTOVER_READY',
      failedStep: null,
      sourceFingerprint: fp.v1,
    });
    expect(await Promise.all(tables.map((t) => count(t)))).toEqual(before);

    // A changed fingerprint after approval voids it: the gate refuses at the fresh read.
    const changedArgs = {
      ...args,
      expectation: expectationOf(fp, { productsFingerprint: 'f'.repeat(64) }),
    };
    expect((await runCutoverGateWith(changedArgs)).failedStep).toBe('FRESH_FINGERPRINTS');

    // stop_sales is mutable: an operator resumes sales while the gate runs (between its first
    // sample and its last). Every other step passes; the gate still refuses at the end.
    let samples = 0;
    const resumed = await runCutoverGate(
      {
        importer: importer(),
        stopSalesFacts: async () => {
          samples += 1;
          if (samples === 2) {
            await db().execute(
              sql`UPDATE incidents SET status = 'RESOLVED', resolved_at = now() WHERE tenant_id = ${tenantA.tenantId}`,
            );
          }
          return cutover().stopSalesFacts(tenantA);
        },
        connector: connectorOf(ds),
        readSnapshot: () => snapshotOf(ds),
        runChecker: runFreezeChecker,
        readBytes: (path) => Promise.resolve(readFileSync(path)),
        hashFile: sha256OfFile,
        now: () => ctx.container.clock.now(),
      },
      args,
      { scope: tenantA, actor: job('gate-3'), mapping, productionLikeTarget: false },
    );
    expect(samples).toBe(2);
    expect(resumed).toMatchObject({ verdict: 'REFUSED', failedStep: 'STOP_SALES_STILL_ACTIVE' });
    expect(resumed.steps.slice(0, -1).every((s) => s.result === 'PASS')).toBe(true);

    function runCutoverGateWith(a: CutoverGateArgs) {
      return runCutoverGate(
        {
          importer: importer(),
          stopSalesFacts: () => cutover().stopSalesFacts(tenantA),
          connector: connectorOf(ds),
          readSnapshot: () => snapshotOf(ds),
          runChecker: runFreezeChecker,
          readBytes: (path) => Promise.resolve(readFileSync(path)),
          hashFile: sha256OfFile,
          now: () => ctx.container.clock.now(),
        },
        a,
        { scope: tenantA, actor: job('gate-2'), mapping, productionLikeTarget: false },
      );
    }
  });
});
