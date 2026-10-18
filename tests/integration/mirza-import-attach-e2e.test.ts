import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { createTestContext, SEED_IDS, tenantA, type TestContext } from './harness';
import {
  MigrationRig,
  TENANT,
  generateDataset,
  rigExecutor,
  writeMigrationPackage,
  type GeneratedInvoice,
} from '../support/legacy-migration-rig';

/**
 * Owner rule 2026-10-18 — the one-click Web Admin import ATTACHES every Mirza service whose
 * account is on a connected panel, whatever its product says, in the same APPLY; and an
 * attached service renews from the CURRENT sellable plans of its own panel.
 *
 * The real backup imported on v0.7.1 attached nothing: every on-panel account was held back
 * as PRODUCT_UNRESOLVED (a named Mirza product nobody mapped, or a shape with no current
 * public tariff), and every empty-`code_panel` invoice was NO_PANEL. This package reproduces
 * that shape on the synthetic rig — every invoice is 45 GB / 20 days, which the tenant's one
 * public plan (30 GB / 30 days) does not match, so NO shape has a current tariff — with one
 * invoice per case the owner named:
 *
 * - `svc_0` (rp1) names a Mirza product nobody mapped (`p1`)               → attached on rp1
 * - `svc_1` (rp2) names a product the Mirza table no longer has (`p404`)   → attached on rp2
 * - `svc_5` names NO panel; its account is on rp2 alone                    → attached on rp2
 * - `svc_6` (rp1) is live but its account is not on the panel              → ENDED (TERMINATED)
 * - `svc_10` names NO panel and is on no connected panel                   → never attached
 * - the removed invoices, whose accounts are gone                          → ENDED
 *
 * SYNTHETIC data only. NOT EVIDENCE.
 */
const USERS = 12;
const INVOICES = 10;
const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const botActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('the one-time Mirza import attaches every on-panel service (owner rule 2026-10-18)', () => {
  let ctx: TestContext;
  let work: string;
  let migrationRoot: string;
  let rig: MigrationRig;
  let importId: string;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[] = [];
  let updateSeq = 0;
  const invoices: GeneratedInvoice[] = [];

  const db = () => ctx.container.database.db;
  const rows = async <T>(query: ReturnType<typeof sql>) =>
    (await db().execute(query)).rows as unknown as T[];

  /** The NEXA service an invoice became, by the invoice's source ref. */
  async function serviceOf(invoiceKey: string) {
    const [row] = await rows<{
      id: string;
      state: string;
      panel_id: string;
      customer_id: string;
      product_id: string;
      telegram_user_id: string;
    }>(sql`
      SELECT s.id, s.state, s.panel_id, s.customer_id, s.product_id,
             c.telegram_user_id::text AS telegram_user_id
        FROM services s JOIN customers c ON c.id = s.customer_id
       WHERE s.tenant_id = ${TENANT} AND s.source_ref = ${`invoice:${invoiceKey}`}`);
    return row ?? null;
  }

  const keyOf = (username: string): string => {
    const found = invoices.find((i) => i.username === username);
    if (found === undefined) throw new Error(`no invoice ${username}`);
    return found.id;
  };

  const tap = (data: string, telegramUserId: string) => {
    updateSeq += 1;
    return {
      idempotencyKey: `attach-e2e-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: {
        update_id: updateSeq,
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'مریم' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: Number(telegramUserId), type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'مریم' },
    };
  };

  /** Every inline button the last message carrying a keyboard drew: [text, callback_data]. */
  const lastKeyboard = (): [string, string][] => {
    for (let i = sent.length - 1; i >= 0; i -= 1) {
      const markup = sent[i]?.body['reply_markup'] as
        { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined;
      if (markup?.inline_keyboard !== undefined) {
        return markup.inline_keyboard.flat().map((b) => [b.text, b.callback_data ?? '']);
      }
    }
    return [];
  };

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      let raw = '';
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      request.on('end', () => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = {};
        }
        sent.push({ url: request.url ?? '', body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');

    work = await mkdtemp(join(tmpdir(), 'mirza-attach-'));
    migrationRoot = await mkdtemp(join(tmpdir(), 'mirza-attach-root-'));
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      LEGACY_MIGRATION_ENABLED: 'true',
      LEGACY_MIGRATION_WORK_DIR: migrationRoot,
      BACKUP_WORK_DIR: work,
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
    rig = new MigrationRig(ctx, migrationRoot);

    const generated = generateDataset({ users: USERS, invoices: INVOICES });
    const tables = generated.dataset.tables as unknown as Record<string, Record<string, unknown>[]>;
    const invoiceRows = tables['invoice'] as Record<string, string | null>[];
    // Every invoice 45 GB / 20 days: no public plan matches, so no shape has a current tariff.
    for (const row of invoiceRows) {
      row['Volume'] = '45';
      row['Service_time'] = '20';
    }
    const at = (j: number) => invoiceRows[j] as Record<string, string | null>;
    at(0)['code_product'] = 'p1'; // a Mirza product nobody mapped
    at(1)['code_product'] = 'p404'; // a product the Mirza table no longer has
    at(5)['code_panel'] = ''; // no panel; the account is on rp2 alone
    // A live invoice naming no panel, on no connected panel either.
    const nowhere: Record<string, string | null> = {
      ...at(5),
      id_invoice: (0xd0000000 + INVOICES).toString(16),
      username: 'svc_10',
    };
    invoiceRows.push(nowhere);
    for (const inv of generated.invoices) invoices.push(inv);
    invoices.push({
      id: String(nowhere['id_invoice']),
      idUser: String(nowhere['id_user']),
      username: 'svc_10',
      codePanel: 'rp1',
      live: true,
    });
    expect(invoices.find((i) => i.username === 'svc_0')?.live).toBe(true);
    expect(invoices.find((i) => i.username === 'svc_1')?.live).toBe(true);
    expect(invoices.find((i) => i.username === 'svc_5')?.live).toBe(true);
    expect(invoices.find((i) => i.username === 'svc_6')?.live).toBe(true);

    const pkg = await writeMigrationPackage(join(work, 'mirza.nxpkg'), {
      dataset: generated.dataset,
      invoices,
    });
    // svc_6's account is NOT on its panel; svc_5 (no panel) is on rp2; svc_10 is nowhere.
    await rig.freshTenant({ rp1: ['svc_0'], rp2: ['svc_1', 'svc_5'] });
    ctx.container.setInstallationTenant(tenantA.tenantId);
    const executor = rigExecutor(ctx);
    importId = await rig.prepare(pkg, executor);
    await executor.tick();
  }, 900_000);

  afterAll(async () => {
    await rig?.closePanels();
    await ctx?.close();
    await new Promise<void>((resolve) => telegram?.close(() => resolve()));
    for (const dir of [work, migrationRoot]) await rm(dir, { recursive: true, force: true });
  });

  it('the dry run already says how many services the import will attach', async () => {
    const dry = (await rig.detail(importId)).dryRunReport;
    // The three on-panel accounts are what the plan the owner approves will import.
    const services = dry?.sections.find((s) => s.section === 'services');
    expect(services).toMatchObject({ source: invoices.length, imported: 3, quarantined: 0 });
  });

  it('COMPLETES with the exact match holding, and attaches every on-panel account — no product blocks', async () => {
    const detail = await rig.detail(importId);
    const report = detail.applyReport;
    expect(report?.exactMatch?.unexplained, JSON.stringify(report?.exactMatch)).toBe(0);
    expect(report?.exactMatch?.holds).toBe(true);
    expect(detail.status).toBe('COMPLETED');

    // An unmapped named product, a deleted one, and an account found by name on one panel.
    for (const [username, code] of [
      ['svc_0', 'rp1'],
      ['svc_1', 'rp2'],
      ['svc_5', 'rp2'],
    ] as const) {
      const service = await serviceOf(keyOf(username));
      expect(service, username).not.toBeNull();
      expect(service?.state, username).toBe('ACTIVE');
      expect(service?.panel_id, username).toBe(rig.panels[code].id);
    }
    expect(await rig.count('services', "source = 'MIRZA' AND state <> 'TERMINATED'")).toBe(3);
    // Not one candidate is held back for a product any more.
    expect(await rig.count('legacy_service_candidates', "outcome = 'PRODUCT_UNRESOLVED'")).toBe(0);
    expect(rig.providerWrites()).toEqual([]);
    expect(await rig.count('provisioning_operations')).toBe(0);
    expect(await rig.count('customer_notifications')).toBe(0);
  });

  it('an account missing from its panel is ENDED; a panel-less one on no panel is never attached', async () => {
    const missing = await serviceOf(keyOf('svc_6'));
    expect(missing?.state).toBe('TERMINATED');
    expect(missing?.panel_id).toBe(rig.panels.rp1.id);
    for (const removed of invoices.filter((i) => !i.live)) {
      expect((await serviceOf(removed.id))?.state, removed.username).toBe('TERMINATED');
    }
    // No connected panel holds it: it is not a live service, and no panel is guessed for it.
    expect(await serviceOf(keyOf('svc_10'))).toBeNull();
    const [candidate] = await rows<{ outcome: string }>(sql`
      SELECT outcome FROM legacy_service_candidates
       WHERE tenant_id = ${TENANT} AND invoice_key = ${keyOf('svc_10')}`);
    // Ended and archived exactly as an unmapped code is (owner rule 2026-10-18): the same map
    // row, the invoice archive, no service — and the exact match explains it.
    expect(candidate?.outcome).toBe('NO_PANEL');
    const [mapRow] = await rows<{ status: string; reason_code: string }>(sql`
      SELECT status, reason_code FROM legacy_import_map
       WHERE tenant_id = ${TENANT} AND legacy_table = 'invoice' AND legacy_id = ${keyOf('svc_10')}`);
    expect(mapRow).toEqual({ status: 'MANUAL_REVIEW', reason_code: 'PANEL_UNMAPPED' });
    expect(
      await rig.count('legacy_invoice_archive', `invoice_key = '${keyOf('svc_10')}'`),
    ).toBeGreaterThan(0);
    const report = (await rig.detail(importId)).applyReport;
    const servicesRow = report?.exactMatch?.rows.find(
      (r) => r.mirzaTable === 'invoice' && r.nexaTable === 'services',
    );
    expect(servicesRow?.explained.find((e) => e.reason === 'NO_PANEL')?.rows).toBe(1);
  });

  it('an attached service keeps its original purchase: date on the order, product name and price on the detail', async () => {
    for (const username of ['svc_0', 'svc_1', 'svc_5']) {
      const service = await serviceOf(keyOf(username));
      if (service === null) throw new Error(`${username} not attached`);
      const j = Number(username.slice('svc_'.length));
      // The order is settled when the customer bought it (the archive's `time_sell`), not at
      // the import: the services list orders imported services by this date.
      const [order] = await rows<{ settled: string; created: string }>(sql`
        SELECT o.settled_at::text AS settled, o.created_at::text AS created
          FROM orders o JOIN services s ON s.order_id = o.id WHERE s.id = ${service.id}`);
      expect(new Date(order?.settled ?? '').getTime(), username).toBe((1_700_000_000 + j) * 1000);
      expect(order?.settled, username).not.toBe(order?.created);
      // The service detail an operator reads shows the original product and price.
      const detail = await ctx.container.serviceAdmin.detail(tenantA, rig.owner, service.id);
      expect(detail.original, username).toEqual({
        productName: 'synthetic',
        price: { amountMinor: 150_000n, currency: 'IRT' },
      });
    }
  });

  it('a renewal of an imported service offers its panel’s CURRENT plans, never its own product', async () => {
    const service = await serviceOf(keyOf('svc_0'));
    if (service === null) throw new Error('svc_0 not attached');
    const actor = botActor('renew-offer');
    const offer = await ctx.container.commercialActions.offer(
      tenantA,
      actor,
      service.customer_id as UserId,
      service.id,
      'RENEW',
    );
    expect(offer.product).toBeNull();
    const plans = offer.plans ?? [];
    // rp1's one sellable plan (the rig's «پلن ۳۰»), and not the hidden product the adoption
    // order names for navigation.
    expect(plans.map((p) => p.title)).toEqual(['پلن ۳۰']);
    expect(plans.map((p) => p.id)).not.toContain(service.product_id);

    // The bot draws it as a renewal option…
    sent = [];
    const menu = await ctx.container.botRuntime.handle(
      tenantA,
      actor,
      tap(`n:${service.id}`, service.telegram_user_id),
    );
    expect(menu.replyKey).toBe('bot.service.renew_choose');
    const options = lastKeyboard().filter(([, data]) => data.startsWith('rq:'));
    expect(options).toHaveLength(1);
    expect(options[0]?.[0]).toContain('پلن ۳۰');

    // …and the tap quotes THAT plan at its current price, for this service.
    const quoted = await ctx.container.botRuntime.handle(
      tenantA,
      actor,
      tap(options[0]?.[1] ?? '', service.telegram_user_id),
    );
    expect(quoted.replyKey).toBe('bot.order.preinvoice');
    const [order] = await rows<{ product_id: string; total: string; purpose: string }>(sql`
      SELECT product_id, total_amount::text AS total, purpose FROM orders
       WHERE id = ${quoted.orderId}`);
    expect(order).toEqual({ product_id: plans[0]?.id, total: '200000', purpose: 'RENEW' });
  });

  it('a plan of ANOTHER panel never renews an imported service', async () => {
    const service = await serviceOf(keyOf('svc_1'));
    if (service === null) throw new Error('svc_1 not attached');
    const [rp1Plan] = await rows<{ id: string }>(sql`
      SELECT id FROM products WHERE tenant_id = ${TENANT} AND panel_id = ${rig.panels.rp1.id}
         AND status = 'ACTIVE' LIMIT 1`);
    await expect(
      ctx.container.commercialActions.draft(
        tenantA,
        botActor('renew-other'),
        service.customer_id as UserId,
        {
          serviceId: service.id,
          kind: 'RENEW',
          productId: rp1Plan?.id ?? '',
          idempotencyKey: 'renew-other-panel',
        },
      ),
    ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE });
  });

  it('a panel with no plan is a clear sentence, never an error; a plan added later is offered', async () => {
    const service = await serviceOf(keyOf('svc_1'));
    if (service === null) throw new Error('svc_1 not attached');
    sent = [];
    const menu = await ctx.container.botRuntime.handle(
      tenantA,
      botActor('renew-none'),
      tap(`n:${service.id}`, service.telegram_user_id),
    );
    expect(menu.replyKey).toBe('bot.service.renew_no_plan');
    expect(lastKeyboard().some(([, data]) => data.startsWith('rq:'))).toBe(false);

    // The operator puts a plan on sale on rp2: the same screen now offers it.
    const products = new DrizzleProductRepository(db());
    const now = ctx.container.clock.now();
    const plan = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ۶۰',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 2,
        panelId: rig.panels.rp2.id as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 60, trafficBytes: 60n * 1024n ** 3n, deviceLimit: null },
        price: money(350_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now,
    });
    await products.setStatus(tenantA, plan.id, 'INACTIVE', 'ACTIVE', now);
    const again = await ctx.container.botRuntime.handle(
      tenantA,
      botActor('renew-added'),
      tap(`n:${service.id}`, service.telegram_user_id),
    );
    expect(again.replyKey).toBe('bot.service.renew_choose');
    const options = lastKeyboard().filter(([, data]) => data.startsWith('rq:'));
    expect(options.map(([text]) => text.includes('پلن ۶۰'))).toEqual([true]);
  });
});
