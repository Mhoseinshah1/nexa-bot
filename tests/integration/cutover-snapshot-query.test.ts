import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  validatePanelConnection,
  type TestContext,
} from './harness';
import { paidOrder, resolveCustomer, rickPanel, systemActor } from './usage-sync-fixtures';

/**
 * The cutover's snapshot query (`docs/cutover/07-background-roles.md`, "The snapshot query"),
 * run AS THE PAGE PRINTS IT — the heredoc is read out of the markdown, `:since` substituted
 * the way psql substitutes it — against the real schema.
 *
 * B3, B5, H5 and R1's loss list all send the operator here to establish that no order and no
 * service was created or changed. The query once read neither table, although
 * `OrderService.createDraft` stores an order before any payment, so each of those steps
 * "verified" an absence it could not see. These cases put each change into the database
 * through the product and require the query to show it — and require a usage-sync touch,
 * which the provisioner makes on every service once it is on, NOT to move a fingerprint.
 */

const DOC = 'docs/cutover/07-background-roles.md';

function snapshotSql(): string {
  const page = readFileSync(DOC, 'utf8');
  const section = page.slice(page.indexOf('## The snapshot query'));
  const match = /<<'SQL'\n([\s\S]*?)\nSQL\n/.exec(section);
  if (match === null) throw new Error(`no snapshot heredoc in ${DOC}`);
  return match[1]!;
}

type Snapshot = Map<string, string>;

describe('the cutover snapshot query', () => {
  let ctx: TestContext;
  let panel: FakeRickpanel;
  let owner: ActorContext;
  let panelId: string;
  let buyer: UserId;

  /** One `name|detail` -> count entry per line, as `psql -At` would print them. */
  async function snapshot(since: Date): Promise<Snapshot> {
    // psql replaces `:since` with the variable's text, which the page sets to a quoted literal.
    const text = snapshotSql().replaceAll(':since', `'${since.toISOString()}'`);
    const results = await ctx.container.database.withClient(async (client) => {
      const out = await client.query({ text, rowMode: 'array' });
      return (Array.isArray(out) ? out : [out]) as { command: string; rows: unknown[][] }[];
    });
    const select = results.find((r) => r.command === 'SELECT');
    if (select === undefined) throw new Error('the snapshot query returned no rows');
    const lines: Snapshot = new Map();
    for (const [name, detail, count] of select.rows) {
      lines.set(`${String(name)}|${String(detail)}`, String(count));
    }
    return lines;
  }

  const fingerprint = (s: Snapshot, table: 'orders' | 'services'): string => {
    const entry = [...s.entries()].find(([key]) => key.startsWith(`${table}_fingerprint|`));
    if (entry === undefined) throw new Error(`no ${table}_fingerprint line`);
    return `${entry[0]}|${entry[1]}`;
  };
  const sinceLines = (s: Snapshot, name: string): string[] =>
    [...s.entries()].filter(([key]) => key.startsWith(`${name}|`)).map(([k, v]) => `${k}|${v}`);

  beforeAll(async () => {
    ctx = await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-snap', roleKeys: ['owner'] }),
    );
    panelId = await rickPanel(ctx, tenantA, owner, panel, 'snap');
    await validatePanelConnection(ctx.container, tenantA, panelId);
    buyer = await resolveCustomer(ctx, tenantA, '940941');
  });

  it('runs read-only: the block is one READ ONLY transaction, rolled back', () => {
    const text = snapshotSql().trim();
    expect(text.startsWith('BEGIN READ ONLY;')).toBe(true);
    expect(text.endsWith('ROLLBACK;')).toBe(true);
  });

  it('shows a DRAFT order created after `since`, and the orders fingerprint moves', async () => {
    const since = new Date();
    const before = await snapshot(since);
    expect(sinceLines(before, 'orders_since')).toEqual([]);

    const products = new DrizzleProductRepository(ctx.container.database.db);
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    // No payment, no service: only the draft — the row the query used to miss.
    await ctx.container.orders.createDraft(tenantA, systemActor('snap-draft'), {
      idempotencyKey: 'snap-draft',
      customerId: buyer,
      productId: product.id,
    });

    const after = await snapshot(since);
    expect(sinceLines(after, 'orders_since')).toEqual(['orders_since|DRAFT|1']);
    expect(fingerprint(after, 'orders')).not.toBe(fingerprint(before, 'orders'));
    expect(fingerprint(after, 'services')).toBe(fingerprint(before, 'services'));
  });

  it('shows a settled order and its new service, then a changed service, but not a usage touch', async () => {
    const since = new Date();
    const before = await snapshot(since);
    expect(sinceLines(before, 'services_since')).toEqual([]);

    await paidOrder(ctx, tenantA, owner, { panelId, customerId: buyer, key: 'snap-paid' });
    const settled = await snapshot(since);
    expect(sinceLines(settled, 'orders_since')).toHaveLength(1);
    expect(sinceLines(settled, 'services_since')).toHaveLength(1);
    expect(fingerprint(settled, 'orders')).not.toBe(fingerprint(before, 'orders'));
    expect(fingerprint(settled, 'services')).not.toBe(fingerprint(before, 'services'));

    // A later window: the order and the service now predate `since`.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const later = new Date();
    const baseline = await snapshot(later);
    expect(sinceLines(baseline, 'services_since')).toEqual([]);
    expect(sinceLines(baseline, 'services_changed_since')).toEqual([]);

    // What the usage sync writes on every tick once the provisioner is on: counters and
    // `updated_at`. Counted as a touch, but the fingerprint — the B3/B5 test — stays put.
    await ctx.container.database.withClient((client) =>
      client.query(
        `UPDATE services SET traffic_used_bytes = traffic_used_bytes + 1, usage_synced_at = now(),
                updated_at = now()
          WHERE tenant_id = $1::uuid`,
        [tenantA.tenantId],
      ),
    );
    const touched = await snapshot(later);
    expect(sinceLines(touched, 'services_changed_since')).toHaveLength(1);
    expect(fingerprint(touched, 'services')).toBe(fingerprint(baseline, 'services'));

    // A renewal's effect on the row: the expiry moves. The fingerprint must see it.
    await ctx.container.database.withClient((client) =>
      client.query(
        `UPDATE services SET expires_at = coalesce(expires_at, now()) + interval '30 days',
                updated_at = now()
          WHERE tenant_id = $1::uuid`,
        [tenantA.tenantId],
      ),
    );
    const renewed = await snapshot(later);
    expect(fingerprint(renewed, 'services')).not.toBe(fingerprint(baseline, 'services'));
    expect(fingerprint(renewed, 'orders')).toBe(fingerprint(baseline, 'orders'));
  });
});
