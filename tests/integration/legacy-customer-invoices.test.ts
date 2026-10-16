import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE_NAME,
  legacyCustomerAdoptionsResponseSchema,
  legacyCustomerInvoicesResponseSchema,
  type CorrelationId,
} from '@nexa/contracts';
import { LegacyHistoryController } from '../../apps/api/src/surfaces/web/legacy-history.controller';
import { AudienceFixtures } from './audience-fixtures';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type SeededAdmin,
  type TestContext,
} from './harness';

/**
 * Customer 360 — a customer's Mirza invoices (`legacy_invoice_archive`, latest VISIBLE
 * revision) beside the importer's one outcome for each (`legacy_service_candidates`), and
 * the adoption lookup the Services card uses. SYNTHETIC rows only, written straight in with
 * every CHECK satisfied; the reads are what is measured, not the importer that writes them.
 */

const TG_A = '7000000101';
const TG_B = '7000000102';
const HASH = 'a'.repeat(64);

type WebRequest = Parameters<LegacyHistoryController['invoices']>[0];

describe('Customer 360: legacy invoices and adoptions', () => {
  let ctx: TestContext;
  let fx: AudienceFixtures;
  let owner: SeededAdmin;
  let customerA: string;
  let customerB: string;
  let serviceA: string;
  let serviceB: string;
  const db = () => ctx.container.database.db;
  const id = () => ctx.container.ids.uuid();

  async function q<T extends Record<string, unknown>>(query: ReturnType<typeof sql>) {
    return (await db().execute<T>(query)).rows;
  }

  async function archiveRun(tenantId: string, state: 'COMPLETED' | 'STAGING'): Promise<string> {
    const run = id();
    const done = state === 'COMPLETED';
    await db().execute(sql`
      INSERT INTO legacy_invoice_archive_runs (id, tenant_id, state, read_set_version,
        read_set_fingerprint, source_fingerprint, source_schema_hash, source_engine, synthetic,
        source_invoice_rows, source_user_rows, source_product_rows, promoted_rows, inserted_new,
        missing_in_snapshot, archive_invoices_after, started_at, verified_at, finished_at,
        updated_at)
      VALUES (${run}, ${tenantId}, ${state}, 1, ${HASH}, ${HASH}, ${HASH}, 'SYNTHETIC_FIXTURE',
        true, ${done ? 0 : null}, ${done ? 0 : null}, ${done ? 0 : null}, 0, 0,
        ${done ? 0 : null}, ${done ? 0 : null}, now(),
        ${done ? sql`now()` : null}, ${done ? sql`now()` : null}, now())`);
    return run;
  }

  async function archive(input: {
    tenantId: string;
    run: string;
    key: string;
    revision?: number;
    status: string;
    live: boolean;
    user: string;
    username?: string;
  }): Promise<string> {
    const row = id();
    const revision = input.revision ?? 1;
    await db().execute(sql`
      INSERT INTO legacy_invoice_archive (id, tenant_id, run_id, invoice_key, revision,
        revision_reason, key_shape_evidenced, raw_row, row_checksum, archive_checksum,
        classification, live, status, is_test, legacy_user_id, owner_present, username,
        panel_code, product_code, product_ref, product_name, price_raw, price_minor,
        price_currency, price_note, sold_at_raw, sold_at, sold_at_note, read_set_fingerprint,
        source_fingerprint, normalization_version, archived_at)
      VALUES (${row}, ${input.tenantId}, ${input.run}, ${input.key}, ${revision},
        ${revision === 1 ? 'FIRST_SEEN' : 'ROW_CHANGED'}, true,
        jsonb_build_object('id_invoice', ${input.key}::text), ${HASH}, ${HASH},
        ${input.live ? 'LIVE_CANDIDATE' : 'NOT_LIVE'}, ${input.live}, ${input.status}, false,
        ${input.user}, true, ${input.username ?? 'syn_user'}, 'rp1', NULL, 'NONE', 'synthetic',
        '150000', 150000, 'IRT', NULL, '1700000000', to_timestamp(1700000000), NULL, ${HASH},
        ${HASH}, 'legacy-invoice-archive:v1', now())`);
    return row;
  }

  async function importRun(tenantId: string): Promise<string> {
    const run = id();
    await db().execute(sql`
      INSERT INTO legacy_import_runs (id, tenant_id, mode, status, source_fingerprint,
        started_at, last_progress_at, finished_at)
      VALUES (${run}, ${tenantId}, 'APPLY', 'COMPLETED', ${HASH}, now(), now(), now())`);
    return run;
  }

  async function candidate(input: {
    tenantId: string;
    run: string;
    key: string;
    archiveId: string;
    outcome: string;
    serviceId?: string;
    blocker?: string;
  }): Promise<string> {
    const row = id();
    const adopted = input.serviceId !== undefined;
    await db().execute(sql`
      INSERT INTO legacy_service_candidates (id, tenant_id, invoice_key, run_id,
        source_fingerprint, synthetic, invoice_checksum, outcome, blocker, evidence,
        evidence_hash, panel_code, product_code, archive_id, service_id, review_state,
        first_decided_at, updated_at)
      VALUES (${row}, ${input.tenantId}, ${input.key}, ${input.run}, ${HASH}, true, ${HASH},
        ${input.outcome}, ${input.blocker ?? null}, '{}'::jsonb, ${HASH}, 'rp1', NULL,
        ${input.archiveId}, ${input.serviceId ?? null}, ${adopted ? 'ADOPTED' : 'OPEN'},
        now(), now())`);
    return row;
  }

  async function requestAs(admin: SeededAdmin): Promise<WebRequest> {
    const { token } = await ctx.container.auth.login(
      tenantA,
      {
        type: 'API',
        id: null,
        label: null,
        surface: 'WEB',
        correlationId: 'lci-web' as CorrelationId,
      },
      { username: admin.username, password: admin.password },
      { ip: '203.0.113.11', userAgent: 'vitest' },
    );
    return {
      method: 'GET',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
      ip: '203.0.113.11',
    } as unknown as WebRequest;
  }

  async function grant(admin: SeededAdmin, ...keys: string[]) {
    for (const key of keys) {
      await db().execute(sql`
        INSERT INTO admin_permission_overrides (tenant_id, admin_id, permission_key, effect, reason)
        VALUES (${tenantA.tenantId}, ${admin.id}, ${key}, 'GRANT', 'test')`);
    }
  }

  const piiViews = async () =>
    Number(
      (
        await q<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM audit_logs WHERE action = 'legacy.invoice_archive.pii_view'`,
        )
      )[0]?.n,
    );

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    fx = new AudienceFixtures(ctx, tenantA.tenantId as string);
    owner = await createAdmin(ctx.container, tenantA, {
      username: 'owner-lci',
      roleKeys: ['owner'],
    });
    customerA = await fx.customer({ telegramUserId: TG_A });
    customerB = await fx.customer({ telegramUserId: TG_B });
    const panel = await fx.panel();
    serviceA = await fx.service({ customerId: customerA, panelId: panel });
    serviceB = await fx.service({ customerId: customerB, panelId: panel });

    const t = tenantA.tenantId as string;
    const done = await archiveRun(t, 'COMPLETED');
    const run = await importRun(t);
    // A1: live, adopted onto serviceA.
    const a1 = await archive({
      tenantId: t,
      run: done,
      key: 'inv-a1',
      status: 'active',
      live: true,
      user: TG_A,
      username: 'syn_a1',
    });
    await candidate({
      tenantId: t,
      run,
      key: 'inv-a1',
      archiveId: a1,
      outcome: 'ADOPTED',
      serviceId: serviceA,
    });
    // A2: live, held for review — the panel's inventory was incomplete.
    const a2 = await archive({
      tenantId: t,
      run: done,
      key: 'inv-a2',
      status: 'disablebyadmin',
      live: true,
      user: TG_A,
    });
    await candidate({
      tenantId: t,
      run,
      key: 'inv-a2',
      archiveId: a2,
      outcome: 'INVENTORY_INCOMPLETE',
      blocker: 'TOTAL_CHANGED',
    });
    // A3: two visible revisions; the latest (removed by the user) is the one shown.
    await archive({
      tenantId: t,
      run: done,
      key: 'inv-a3',
      status: 'active',
      live: true,
      user: TG_A,
    });
    await archive({
      tenantId: t,
      run: done,
      key: 'inv-a3',
      revision: 2,
      status: 'removebyuser',
      live: false,
      user: TG_A,
    });
    // A4: its newer revision belongs to a run that never completed: invisible.
    await archive({
      tenantId: t,
      run: done,
      key: 'inv-a4',
      status: 'end_of_time',
      live: false,
      user: TG_A,
    });
    const staging = await archiveRun(t, 'STAGING');
    await archive({
      tenantId: t,
      run: staging,
      key: 'inv-a4',
      revision: 2,
      status: 'active',
      live: true,
      user: TG_A,
    });
    // Another customer's invoice, and another tenant's invoice under the SAME Telegram id.
    await archive({
      tenantId: t,
      run: done,
      key: 'inv-b1',
      status: 'active',
      live: true,
      user: TG_B,
    });
    const b = tenantB.tenantId as string;
    await archive({
      tenantId: b,
      run: await archiveRun(b, 'COMPLETED'),
      key: 'inv-x1',
      status: 'active',
      live: true,
      user: TG_A,
    });
  });

  it('joins each latest visible invoice to its outcome: adopted, held for review, history', async () => {
    const controller = new LegacyHistoryController(ctx.container);
    const page = legacyCustomerInvoicesResponseSchema.parse(
      await controller.invoices(await requestAs(owner), customerA, {}),
    );
    expect(page.invoices.map((row) => [row.invoiceKey, row.revision, row.status])).toEqual([
      ['inv-a1', 1, 'active'],
      ['inv-a2', 1, 'disablebyadmin'],
      ['inv-a3', 2, 'removebyuser'],
      ['inv-a4', 1, 'end_of_time'],
    ]);
    const [a1, a2, a3, a4] = page.invoices;
    expect(a1?.candidate).toMatchObject({
      outcome: 'ADOPTED',
      reviewState: 'ADOPTED',
      serviceId: serviceA,
    });
    expect(a2?.candidate).toMatchObject({
      outcome: 'INVENTORY_INCOMPLETE',
      blocker: 'TOTAL_CHANGED',
      reviewState: 'OPEN',
      serviceId: null,
    });
    expect(a3).toMatchObject({ classification: 'NOT_LIVE', live: false, candidate: null });
    expect(a4).toMatchObject({ classification: 'NOT_LIVE', candidate: null });
    expect(a1).toMatchObject({ priceMinor: '150000', priceCurrency: 'IRT', username: 'syn_a1' });
    expect(page).toMatchObject({ piiRedacted: false, candidatesVisible: true, nextCursor: null });
    // The owner's unredacted page is a reveal, audited once (ids and a count, no value).
    expect(await piiViews()).toBe(1);
    const audit = await q<{ after: Record<string, unknown> }>(
      sql`SELECT after FROM audit_logs WHERE action = 'legacy.invoice_archive.pii_view'`,
    );
    expect(audit[0]?.after).toMatchObject({ customerId: customerA, count: 4 });
    expect(JSON.stringify(audit[0]?.after)).not.toContain(TG_A);
    expect(JSON.stringify(audit[0]?.after)).not.toContain('syn_a1');
  });

  it('pages by keyset and refuses a forged cursor or an oversized page', async () => {
    const controller = new LegacyHistoryController(ctx.container);
    const request = await requestAs(owner);
    const first = legacyCustomerInvoicesResponseSchema.parse(
      await controller.invoices(request, customerA, { limit: '3' }),
    );
    expect(first.invoices.map((row) => row.invoiceKey)).toEqual(['inv-a1', 'inv-a2', 'inv-a3']);
    expect(first.nextCursor).not.toBeNull();
    const second = legacyCustomerInvoicesResponseSchema.parse(
      await controller.invoices(request, customerA, { limit: '3', after: first.nextCursor }),
    );
    expect(second.invoices.map((row) => row.invoiceKey)).toEqual(['inv-a4']);
    expect(second.nextCursor).toBeNull();
    await expect(
      controller.invoices(request, customerA, { after: 'not-a-cursor' }),
    ).rejects.toMatchObject({ kind: 'VALIDATION' });
    await expect(controller.invoices(request, customerA, { limit: '51' })).rejects.toThrow();
    await expect(controller.invoices(request, customerA, { other: '1' })).rejects.toThrow();
  });

  it('is charged on users.view and legacy.invoices.view; redacts the username and hides the outcomes without their keys', async () => {
    const controller = new LegacyHistoryController(ctx.container);
    // Without users.view the customer page itself is refused.
    const stranger = await createAdmin(ctx.container, tenantA, { username: 'stranger-lci' });
    await grant(stranger, 'legacy.invoices.view');
    await expect(
      controller.invoices(await requestAs(stranger), customerA, {}),
    ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
    const viewer = await createAdmin(ctx.container, tenantA, { username: 'viewer-lci' });
    const request = await requestAs(viewer);
    await grant(viewer, 'users.view');
    await expect(controller.invoices(request, customerA, {})).rejects.toMatchObject({
      kind: 'PERMISSION_DENIED',
    });
    await grant(viewer, 'legacy.invoices.view');
    const redacted = legacyCustomerInvoicesResponseSchema.parse(
      await controller.invoices(request, customerA, {}),
    );
    expect(redacted).toMatchObject({ piiRedacted: true, candidatesVisible: false });
    expect(redacted.invoices).toHaveLength(4);
    for (const row of redacted.invoices) {
      expect(row.username).toBeNull();
      expect(row.candidate).toBeNull();
    }
    expect(await piiViews()).toBe(0);
    await grant(viewer, 'legacy.services.view');
    const withOutcomes = legacyCustomerInvoicesResponseSchema.parse(
      await controller.invoices(request, customerA, {}),
    );
    expect(withOutcomes.candidatesVisible).toBe(true);
    expect(withOutcomes.invoices[0]?.candidate?.serviceId).toBe(serviceA);
    expect(withOutcomes.invoices[0]?.username).toBeNull();
    expect(await piiViews()).toBe(0);
  });

  it('is tenant-scoped: another tenant neither sees the customer nor lends its invoices', async () => {
    // Tenant B holds an invoice under customer A's Telegram id; tenant A's read never shows it.
    const page = await ctx.container.legacyHistoryRead.invoicesForCustomer(
      tenantA,
      adminActorFor(owner),
      customerA,
      {},
    );
    expect(page.rows.map((row) => row.invoiceKey)).not.toContain('inv-x1');
    const ownerB = await createAdmin(ctx.container, tenantB, {
      username: 'owner-lci-b',
      roleKeys: ['owner'],
    });
    await expect(
      ctx.container.legacyHistoryRead.invoicesForCustomer(
        tenantB,
        adminActorFor(ownerB),
        customerA,
        {},
      ),
    ).rejects.toMatchObject({ kind: 'NOT_FOUND' });
    await expect(
      ctx.container.legacyHistoryRead.adoptionsForCustomer(
        tenantB,
        adminActorFor(ownerB),
        customerA,
        {
          serviceIds: [serviceA],
        },
      ),
    ).rejects.toMatchObject({ kind: 'NOT_FOUND' });
  });

  it("answers which of the customer's services were adopted, and nothing about another's", async () => {
    const controller = new LegacyHistoryController(ctx.container);
    const request = await requestAs(owner);
    const answer = legacyCustomerAdoptionsResponseSchema.parse(
      await controller.adoptions(request, customerA, { serviceIds: `${serviceA},${serviceB}` }),
    );
    expect(answer.adoptions).toEqual([{ serviceId: serviceA, invoiceKey: 'inv-a1' }]);
    // Customer B's service is not adopted, and customer A's is not B's.
    const forB = legacyCustomerAdoptionsResponseSchema.parse(
      await controller.adoptions(request, customerB, { serviceIds: `${serviceA},${serviceB}` }),
    );
    expect(forB.adoptions).toEqual([]);
    await expect(
      controller.adoptions(request, customerA, { serviceIds: 'nope' }),
    ).rejects.toThrow();
    await expect(controller.adoptions(request, customerA, {})).rejects.toThrow();

    const viewer = await createAdmin(ctx.container, tenantA, { username: 'viewer-lci-2' });
    await grant(viewer, 'users.view');
    const viewerRequest = await requestAs(viewer);
    await expect(
      controller.adoptions(viewerRequest, customerA, { serviceIds: serviceA }),
    ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
    await grant(viewer, 'legacy.services.view');
    const granted = legacyCustomerAdoptionsResponseSchema.parse(
      await controller.adoptions(viewerRequest, customerA, { serviceIds: serviceA }),
    );
    expect(granted.adoptions).toHaveLength(1);
  });
});
