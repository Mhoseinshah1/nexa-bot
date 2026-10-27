import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import { TargetRefused } from '../../apps/api/src/cutover-reconcile.cli';
import {
  parseRehearseArgs,
  runCutoverRehearsal,
  type RehearsalContext,
  type RehearsalResult,
  type RehearsalSeams,
} from '../../apps/api/src/cutover-rehearse.cli';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import {
  generateDataset,
  mirzaAgentRecords,
  writeMigrationPackage,
  type GeneratedDataset,
  type MigrationPackage,
} from '../support/legacy-migration-rig';
import { TEST_KEK, createTestContext, type TestContext } from './harness';

/**
 * `pnpm cutover-rehearse` end to end, against this PostgreSQL server: a synthetic Mirza
 * `.nxpkg` with a KNOWN reconciliation (every balance, every live service on the read-only
 * stand-ins, two agents, one with a credit cap), rehearsed into a disposable database the run
 * creates and drops. Then the same package with ONE deliberate mismatch put in after the
 * import (one Toman credited by hand, one adopted service handed to another customer): the
 * report must name both and say NO_GO.
 *
 * Throughout, the "live" database is this suite's own test database (`DATABASE_URL`): the
 * rehearsal must refuse it by name, and must leave it exactly as it was. And nothing may
 * reach anyone: no customer notification, no outbox publication, no fetch (Telegram's
 * included), no panel write. SYNTHETIC data only. NOT EVIDENCE.
 */

const USERS = 30;
const INVOICES = 12;
const AGENTS = [
  { i: 1, tier: 'n', cap: '5000000' },
  { i: 4, tier: 'n2', cap: null },
] as const;
const OWNER_TELEGRAM_ID = '900000001';
const KEY_ENV = 'REHEARSAL_TEST_PACKAGE_KEY';

describe('cutover-rehearse: the runbook against a disposable database', () => {
  let ctx: TestContext;
  let work: string;
  let generated: GeneratedDataset;
  let pkg: MigrationPackage;
  let liveUrl: string;
  let inventoryPath: string;
  const progress: string[] = [];

  function env(): NodeJS.ProcessEnv {
    return {
      NODE_ENV: 'development',
      LOG_LEVEL: 'error',
      DATABASE_URL: liveUrl,
      REDIS_URL: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
      SECRETS_KEK: TEST_KEK,
      SECRETS_KEK_ID: 'test-1',
      AUTH_MODE: 'password',
      PASSWORD_HASH_PROFILE: 'fast',
      DEPLOYMENT_TOPOLOGY: 'direct',
      OUTBOX_RELAY_ENABLED: 'false',
      RICKPANEL_INVENTORY_REQUEST_INTERVAL_MS: '0',
      // Outside production a stand-in on loopback is allowed; on a host it is a private address.
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      // The installation's own channels, all ON, as a live nexa.env has them: the rehearsal
      // must switch every one of them off for itself.
      NOTIFICATION_DISPATCH_ENABLED: 'true',
      PROVISIONER_ENABLED: 'true',
      LEGACY_MIGRATION_ENABLED: 'false',
      [KEY_ENV]: pkg.keyFileText,
    };
  }

  /** Every name this file uses, so the cleanup drops these and nobody else's. */
  const names: string[] = [];
  const rehearsalName = (tag: string) => {
    const name = `nexa_cutover_rehearsal_it_${tag}_${String(process.pid)}_${String(Date.now() % 1_000_000)}`;
    names.push(name);
    return name;
  };

  /** The rehearsal databases on this server, this file's or not (a refusal creates none). */
  async function databases(): Promise<string[]> {
    const client = new Client({ connectionString: liveUrl });
    await client.connect();
    try {
      const r = await client.query<{ datname: string }>(
        `SELECT datname FROM pg_database WHERE datname LIKE 'nexa_cutover_rehearsal%'`,
      );
      return r.rows.map((row) => row.datname).sort();
    } finally {
      await client.end();
    }
  }

  async function dropIfExists(name: string): Promise<void> {
    const client = new Client({ connectionString: liveUrl });
    await client.connect();
    try {
      await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await client.end();
    }
  }

  /** What the "live" database holds: the rehearsal must not change any of it. */
  async function liveFootprint(): Promise<string> {
    const r = await ctx.container.database.db.execute(sql`
      SELECT (SELECT count(*) FROM tenants)::text || '|' ||
             (SELECT count(*) FROM admins)::text || '|' ||
             (SELECT count(*) FROM customers)::text || '|' ||
             (SELECT count(*) FROM wallet_entries)::text || '|' ||
             (SELECT count(*) FROM panels)::text || '|' ||
             (SELECT count(*) FROM legacy_nxpkg_imports)::text || '|' ||
             (SELECT count(*) FROM audit_logs)::text || '|' ||
             (SELECT count(*) FROM outbox_messages)::text || '|' ||
             (SELECT count(*) FROM customer_notifications)::text AS v`);
    return String((r.rows[0] as { v: string }).v);
  }

  /** The tariff product the owner creates before the migration (runbook P10, 0.3). */
  async function tariffProduct(
    context: RehearsalContext,
    panels: readonly { readonly codePanel: string; readonly panelId: string }[],
  ): Promise<void> {
    const { container, scope } = context;
    const category = await container.database.db.execute<{ id: string }>(
      sql`SELECT id FROM product_categories WHERE tenant_id = ${scope.tenantId} LIMIT 1`,
    );
    const products = new DrizzleProductRepository(container.database.db);
    const now = container.clock.now();
    const product = await products.create(scope, {
      id: container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ۳۰',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 1,
        panelId: panels[0]?.panelId as PanelId,
        categoryId: category.rows[0]?.id as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 30n * 1024n ** 3n, deviceLimit: null },
        price: money(200_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now,
    });
    await products.setStatus(scope, product.id, 'INACTIVE', 'ACTIVE', now);
  }

  async function rehearse(
    extra: readonly string[],
    seams: RehearsalSeams = {},
  ): Promise<{ result: RehearsalResult; report: Record<string, any>; text: string }> {
    const args = parseRehearseArgs([
      '--package',
      pkg.path,
      '--package-key-env',
      KEY_ENV,
      '--owner-telegram-id',
      OWNER_TELEGRAM_ID,
      '--panel-inventory',
      inventoryPath,
      '--work-dir',
      work,
      '--json',
      '--list-differences',
      ...extra,
    ]);
    let text = '';
    const result = await runCutoverRehearsal(
      args,
      env(),
      {
        out: (t) => {
          text += t;
        },
        progress: (t) => progress.push(t),
      },
      { afterPanels: tariffProduct, ...seams },
    );
    return { result, report: JSON.parse(text) as Record<string, any>, text };
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.reset();
    liveUrl = String(process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']);
    work = await mkdtemp(join(tmpdir(), 'cutover-rehearsal-'));
    generated = generateDataset({ users: USERS, invoices: INVOICES });
    for (const a of AGENTS) (generated.users[a.i] as Record<string, unknown>)['agent'] = a.tier;
    const agents = mirzaAgentRecords(generated.users, AGENTS);
    pkg = await writeMigrationPackage(join(work, 'mirza.nxpkg'), {
      dataset: generated.dataset,
      invoices: generated.invoices,
      history: {
        'records/agents/profiles.jsonl': agents.profiles,
        'records/agents/state.jsonl': agents.states,
      },
    });
    // Every live Mirza service is on its panel, in the shape the tariff product matches.
    // `created_at` in Marzban's naive-UTC rendering, oldest first: what lets the walk prove it
    // saw every account (without it the inventory is INCOMPLETE and nothing is adopted).
    let created = 0;
    const account = (username: string) => ({
      username,
      status: 'active',
      created_at: new Date(Date.UTC(2026, 0, 1) + (created += 1) * 1000).toISOString().slice(0, 19),
      data_limit_reset_strategy: 'no_reset',
      expire: Math.floor(Date.UTC(2027, 0, 1) / 1000),
      data_limit: 30 * 1024 ** 3,
      used_traffic: 1024 ** 3,
      proxies: { vless: { id: `standin-${username}` } },
    });
    inventoryPath = join(work, 'inventory.json');
    await writeFile(
      inventoryPath,
      JSON.stringify({
        rp1: generated.liveAccounts.rp1.map(account),
        rp2: generated.liveAccounts.rp2.map(account),
      }),
    );
  }, 300_000);

  afterAll(async () => {
    for (const name of names) await dropIfExists(name);
    await ctx?.close();
    await rm(work, { recursive: true, force: true });
  });

  /** Σ of the generated `user.Balance` cells: the figure every wallet must add up to. */
  const mirzaSum = () =>
    generated.users.reduce((sum, u) => sum + BigInt(String(u['Balance'])), 0n).toString();
  const liveInvoices = () => generated.invoices.filter((i) => i.live).length;

  it('a clean package: the known reconciliation, nothing sent, the live database untouched, the copy dropped', async () => {
    const before = await liveFootprint();
    const name = rehearsalName('clean');
    const { result, report } = await rehearse(['--database', name]);

    // The steps of the runbook it ran, and the two it must never run.
    const status = Object.fromEntries(result.steps.map((s) => [s.name, s.status]));
    expect(
      result.steps.filter((s) => s.status === 'FAIL'),
      JSON.stringify(result.steps),
    ).toEqual([]);
    expect(status).toMatchObject({
      target: 'PASS',
      messaging: 'PASS',
      package: 'PASS',
      database: 'PASS',
      'fresh-target': 'PASS',
      verify: 'PASS',
      panels: 'PASS',
      'dry-run': 'PASS',
      import: 'PASS',
      reconciliation: 'PASS',
      'token-handover': 'SKIP',
      'no-messages': 'PASS',
      'background-roles': 'SKIP',
      'package-unchanged': 'PASS',
      cleanup: 'PASS',
    });

    // Balances: every Mirza row matched exactly; agent credit listed, never credited.
    expect(report['balances'].verdict).toBe('RECONCILED');
    expect(report['balances'].mirza.rows).toBe(USERS);
    expect(report['balances'].mirza.readable.sumMinor).toBe(mirzaSum());
    expect(report['balances'].matched).toEqual({ rows: USERS, sumMinor: mirzaSum() });
    expect(report['balances'].nexa.wallets.sumMinor).toBe(mirzaSum());
    expect(report['balances'].nexa.nonOpeningEntries).toBe(0);
    expect(report['balances'].differences).toEqual([]);
    // Reseller credit: every Mirza agent is a reseller with NO credit of any kind.
    expect(report['balances'].agents).toEqual({
      mirzaAgents: AGENTS.length,
      agentsMatched: AGENTS.length,
      creditListedNotCredited: { rows: 1, sumMinor: '5000000' },
      creditUnreadable: 0,
      resellers: AGENTS.length,
      resellersFromMirza: AGENTS.length,
    });
    for (const kind of [
      'AGENT_CREDIT_IN_WALLET',
      'RESELLER_CREDIT_LIMIT',
      'RESELLER_TIER_CREDIT_LIMIT',
      'RESELLER_PURCHASE_CAP',
      'RESELLER_NOT_A_MIRZA_AGENT',
    ]) {
      expect(report['balances'].differenceCounts[kind], kind).toBe(0);
    }

    // Services: every live one adopted from the stand-in, every removed one held as history.
    expect(report['services']).toMatchObject({
      verdict: 'RECONCILED_WITH_HELD',
      mirzaServices: INVOICES,
      nexaServices: INVOICES,
      matched: liveInvoices(),
      held: [{ outcome: 'PROVIDER_MISSING', invoices: INVOICES - liveInvoices() }],
      heldTotal: INVOICES - liveInvoices(),
      heldAsHistory: INVOICES - liveInvoices(),
      differences: [],
    });

    // Held rows are signed off by name: GO_WITH_HELD, exit 2.
    expect(result.outcome).toEqual({
      verdict: 'GO_WITH_HELD',
      reasons: ['services held for review'],
    });
    expect(result.exitCode).toBe(2);

    // Nothing reached anyone, and the run's own channels were off whatever the env said.
    expect(result.quiet).toEqual({
      customerNotifications: 0,
      broadcastRecipients: 0,
      operatorNotificationsSent: 0,
      outboxPublished: 0,
      provisioningOperations: 0,
      botInstances: 0,
      outboundRefused: 0,
      telegramRefused: 0,
      panelWritesRefused: 0,
    });
    expect(result.messaging).toMatchObject({
      NOTIFICATION_DISPATCH_ENABLED: 'false',
      TELEGRAM_WEBHOOK_ENABLED: 'false',
      BACKUP_TELEGRAM_BOT_TOKEN: '',
      PROVISIONER_ENABLED: 'false',
      PANEL_MONITOR_ENABLED: 'false',
      LEGACY_MIGRATION_ENABLED: 'true',
    });

    // The copy is gone; the live database is exactly as it was.
    expect(result.kept).toBe(false);
    expect(await databases()).not.toContain(name);
    expect(await liveFootprint()).toBe(before);
  }, 600_000);

  it('one deliberate mismatch is reported (a balance, a service), a send attempt is caught: NO_GO; --keep-database keeps it', async () => {
    const before = await liveFootprint();
    const name = rehearsalName('mismatch');
    let plain = '';
    let attempt: unknown = null;
    const { result, report } = await rehearse(['--database', name, '--keep-database'], {
      afterImport: async ({ container, scope }) => {
        const db = container.database.db;
        const customer = await db.execute<{ id: string }>(
          sql`SELECT id FROM customers WHERE tenant_id = ${scope.tenantId}
               AND telegram_user_id = ${String(generated.users[10]?.['id'])}`,
        );
        plain = String(customer.rows[0]?.id);
        // One Toman more than Mirza ever held.
        await db.execute(sql`
          INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount,
                                      currency, reference, created_at)
          VALUES (${container.ids.uuid()}, ${scope.tenantId}, ${plain}, 'CREDIT', 'ADMIN_CREDIT',
                  1, 'IRT', 'test:one-toman', ${container.clock.now()})`);
        // One adopted Mirza service that is no longer there as a live service.
        await db.execute(sql`
          UPDATE services SET state = 'TERMINATED', terminated_at = ${container.clock.now()}
           WHERE id = (SELECT id FROM services WHERE tenant_id = ${scope.tenantId}
                         AND state = 'ACTIVE' ORDER BY id LIMIT 1)`);
        // And something tries to reach Telegram: refused, and counted.
        attempt = await fetch('https://api.telegram.org/bot000:x/sendMessage').then(
          () => 'SENT',
          (error: unknown) => error,
        );
      },
    });

    expect(attempt, JSON.stringify(result.steps)).toBeInstanceOf(TypeError);
    expect(String((attempt as Error).message)).toContain('the cutover rehearsal sends nothing');

    expect(report['balances'].verdict).toBe('DIFFERENCES');
    expect(report['balances'].differenceCounts.BALANCE_DIFFERS).toBe(1);
    expect(report['balances'].differences).toContainEqual(
      expect.objectContaining({ kind: 'BALANCE_DIFFERS', customerId: plain }),
    );
    expect(report['services'].verdict).toBe('DIFFERENCES');
    expect(report['services'].differenceCounts.SERVICE_ADOPTED_MISSING).toBe(1);
    expect(report['services'].matched).toBe(liveInvoices() - 1);

    expect(result.quiet?.telegramRefused).toBe(1);
    expect(result.quiet?.outboundRefused).toBe(1);
    const failed = result.steps.filter((s) => s.status === 'FAIL').map((s) => s.name);
    expect(failed).toEqual(['reconciliation', 'no-messages']);
    expect(result.outcome.verdict).toBe('NO_GO');
    expect(result.outcome.reasons).toEqual([
      'step reconciliation failed',
      'step no-messages failed',
      'balances: 1 difference(s)',
      'services: 1 difference(s)',
    ]);
    expect(result.exitCode).toBe(3);

    // Kept on request, and only the copy: the live database is exactly as it was.
    expect(result.kept).toBe(true);
    expect(await databases()).toContain(name);
    expect(await liveFootprint()).toBe(before);
    await dropIfExists(name);
  }, 600_000);

  it('refuses the live database itself, whatever word its name carries — and creates nothing', async () => {
    const live = new URL(liveUrl).pathname.slice(1);
    expect(live).toMatch(/test/u); // a name the production-word rule alone would accept
    const before = await databases();
    const footprint = await liveFootprint();
    // Refused by THIS rule, not only by "it already exists": a live database that had just
    // been dropped and recreated would pass that one.
    const refusal = rehearse(['--database', live]);
    await expect(refusal).rejects.toBeInstanceOf(TargetRefused);
    await expect(refusal).rejects.toThrow(/is the live database DATABASE_URL names/u);
    expect(await databases()).toEqual(before);
    expect(await liveFootprint()).toBe(footprint);
  });

  it('refuses a production-like name, and a database that already exists (never reused, never dropped)', async () => {
    await expect(rehearse(['--database', 'nexa'])).rejects.toBeInstanceOf(TargetRefused);
    const existing = rehearsalName('exists');
    const client = new Client({ connectionString: liveUrl });
    await client.connect();
    try {
      await client.query(`CREATE DATABASE "${existing}"`);
    } finally {
      await client.end();
    }
    await expect(rehearse(['--database', existing])).rejects.toBeInstanceOf(TargetRefused);
    expect(await databases()).toContain(existing);
    await dropIfExists(existing);
  });
});
