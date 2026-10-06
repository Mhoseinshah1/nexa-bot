import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type OrderId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { FixedClock } from '../../apps/api/src/infrastructure/clock';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import {
  ProvisionerService,
  type ProvisionerDeps,
} from '../../apps/api/src/modules/commerce/provisioning/application/provisioner.service';
import { ProvisionerLoop } from '../../apps/api/src/modules/commerce/provisioning/application/provisioner-loop';
import type { ExecutionResult } from '../../apps/api/src/modules/commerce/provisioning/application/provision-executor';
import type { FakeRickpanel, FakeRickpanelUser } from '../support/fake-rickpanel';
import { AudienceFixtures } from './audience-fixtures';
import { SEED_IDS, type TestContext } from './harness';

/**
 * Migration P1 (H5) fixtures, shared by the priority suite and the load suite.
 *
 * The executor is the PRODUCTION `ProvisionerService`, built from the container's own
 * dependencies — the same repositories, budget repository, URL policy, HTTP client,
 * RickPanel adapter and settings — with exactly two things replaced: the clock, so the
 * token bucket's refill is a function of simulated ticks rather than of how fast this
 * machine happens to be, and the worker id. The loop is the PRODUCTION `ProvisionerLoop`
 * (its drain limit, its break-on-refusal), with delivery and announcements stubbed: they
 * are what happens AFTER a claim, and the subject here is which claim happens.
 */

export const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

export function executorDeps(ctx: TestContext): ProvisionerDeps {
  return (ctx.container.provisioner as unknown as { deps: ProvisionerDeps }).deps;
}

export interface Harness {
  readonly clock: FixedClock;
  readonly executor: ProvisionerService;
  readonly loop: ProvisionerLoop;
  /** Every result the loop logged, in order — the observable claim sequence. */
  readonly results: ExecutionResult[];
}

export function harnessFor(
  ctx: TestContext,
  scope: TenantContext,
  start: Date,
  overrides: Partial<ProvisionerDeps> = {},
): Harness {
  const clock = new FixedClock(start);
  const executor = new ProvisionerService({
    ...executorDeps(ctx),
    clock,
    workerId: 'provisioner:p1-test',
    ...overrides,
  });
  const results: ExecutionResult[] = [];
  const settleNothing = { settleDue: async () => 0 };
  const loop = new ProvisionerLoop(
    executor,
    { deliverDue: async () => 0 } as never,
    { announce: async () => undefined, announceDue: async () => 0 } as never,
    {
      scope: () => scope,
      cashback: settleNothing,
      referrals: settleNothing,
      serviceRefunds: settleNothing,
      tickMs: 5_000,
      now: () => clock.now().getTime(),
      logger: {
        info: (context) => results.push(context as unknown as ExecutionResult),
        error: () => undefined,
      },
    },
  );
  return { clock, executor, loop, results };
}

/** Seeds the fake panel's own record of an account, as a legacy RickPanel would hold it. */
export function seedPanelUser(panel: FakeRickpanel, username: string, usedTraffic: number): void {
  (panel.users as Map<string, FakeRickpanelUser>).set(username, {
    username,
    status: 'active',
    expire: 0,
    dataLimit: 0,
    usedTraffic,
    onlineAt: null,
    proxies: { vless: { id: `internal-vless-${username}` } },
    subToken: `subtoken-${username}`,
  });
}

/**
 * `count` ACTIVE services on `panelId`, written as rows — the shape an adopted legacy
 * fleet has: an account keyed by its USERNAME, `provider_user_id` NULL (RickPanel and
 * Marzban answer null by contract), a stale figure never synced, created long ago.
 *
 * One customer and one order carry them all; `services.order_id` is not unique and a
 * usage read never consults the order. Returns the usernames, oldest first.
 */
let fleetCustomers = 0;

export async function seedFleet(
  ctx: TestContext,
  tenantId: string,
  panelId: string,
  input: { readonly count: number; readonly prefix: string; readonly createdBefore: Date },
): Promise<string[]> {
  const fx = new AudienceFixtures(ctx, tenantId);
  fleetCustomers += 1;
  const customerId = await fx.customer({ telegramUserId: String(880_000_000 + fleetCustomers) });
  const productId = await fx.product(panelId);
  // One PAID order per service (`services_tenant_order_key`), its id derived per row.
  // $1 tenant, $2 customer, $3 panel, $4 prefix, $5 created-before, $6 count, $7 product.
  const orderIdOf = `md5($1 || ':' || $4 || ':' || g)::uuid`;
  const params = [
    tenantId,
    customerId,
    panelId,
    input.prefix,
    input.createdBefore.toISOString(),
    input.count,
    productId,
  ];
  // UUIDv7, as every service id is: the customer surfaces refuse anything else.
  const serviceIds = Array.from({ length: input.count }, () => ctx.container.ids.uuid());
  await ctx.container.database.withClient(async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, customer_id, state, purpose, product_id, panel_id, line_title,
          line_duration_days, line_traffic_bytes, line_unit_price_amount, line_quantity,
          subtotal_amount, discount_amount, total_amount, currency, quote, settled_at,
          confirmed_at, created_at, updated_at)
       SELECT ${orderIdOf}, $1::uuid, $2::uuid, 'PAID', 'NEW_SERVICE', $7::uuid, $3::uuid,
              'plan', 30, 53687091200, 250000, 1, 250000, 0, 250000, 'IRT', '{}'::jsonb,
              $5::timestamptz, $5::timestamptz, $5::timestamptz, $5::timestamptz
         FROM generate_series(1, $6::int) AS g`,
      params,
    );
    await client.query(
      `INSERT INTO services
         (id, tenant_id, customer_id, order_id, panel_id, product_id, provider_username, state,
          delivery_state, traffic_limit_bytes, traffic_used_bytes, expires_at,
          provisioned_at, delivered_at, created_at, updated_at)
       SELECT ($8::uuid[])[g], $1::uuid, $2::uuid, ${orderIdOf}, $3::uuid, $7::uuid,
              $4 || lpad(g::text, 6, '0'), 'ACTIVE', 'DELIVERED', 53687091200, 0, NULL,
              $5::timestamptz - make_interval(secs => $6 - g),
              $5::timestamptz - make_interval(secs => $6 - g),
              $5::timestamptz - make_interval(secs => $6 - g),
              $5::timestamptz
         FROM generate_series(1, $6::int) AS g`,
      [...params, serviceIds],
    );
  });
  return Array.from(
    { length: input.count },
    (_, i) => `${input.prefix}${String(i + 1).padStart(6, '0')}`,
  );
}

/**
 * A scheduled usage-read backlog written as rows: one PLANNED `background` SYNC_USAGE for
 * every service of `tenantId` whose username starts with `prefix`, all planned at
 * `plannedAt` — older than anything a customer pays for during the test.
 */
export async function seedBackgroundBacklog(
  ctx: TestContext,
  tenantId: string,
  prefix: string,
  plannedAt: Date,
  extra: { readonly attempts?: number } = {},
): Promise<number> {
  const result = await ctx.container.database.withClient((client) =>
    client.query(
      `INSERT INTO provisioning_operations
         (id, tenant_id, operation_id, service_id, order_id, panel_id, type, state, attempts,
          next_attempt_at, background, created_at, updated_at)
       SELECT gen_random_uuid(), s.tenant_id, substr(md5(s.id::text || ':bg'), 1, 16), s.id,
              s.order_id, s.panel_id, 'SYNC_USAGE', 'PLANNED', $4::int,
              $3::timestamptz, true, $3::timestamptz, $3::timestamptz
         FROM services s
        WHERE s.tenant_id = $1::uuid AND s.provider_username LIKE $2 || '%'`,
      [tenantId, prefix, plannedAt.toISOString(), extra.attempts ?? 0],
    ),
  );
  return result.rowCount ?? 0;
}

/** Sets the tenant's bucket to an exact level, refilled as of `at`. */
export async function setBucket(
  ctx: TestContext,
  tenantId: string,
  tokens: number,
  at: Date,
): Promise<void> {
  await ctx.container.database.withClient((client) =>
    client.query(
      `INSERT INTO panel_probe_budgets (tenant_id, tokens, refilled_at)
       VALUES ($1::uuid, $2, $3::timestamptz)
       ON CONFLICT (tenant_id) DO UPDATE SET tokens = EXCLUDED.tokens, refilled_at = EXCLUDED.refilled_at`,
      [tenantId, tokens, at.toISOString()],
    ),
  );
}

export async function bucketTokens(ctx: TestContext, tenantId: string): Promise<number | null> {
  const result = await ctx.container.database.withClient((client) =>
    client.query<{ tokens: number }>(
      'SELECT tokens FROM panel_probe_budgets WHERE tenant_id = $1::uuid',
      [tenantId],
    ),
  );
  return result.rows[0]?.tokens ?? null;
}

export interface OperationRow {
  readonly id: string;
  readonly type: string;
  readonly state: string;
  readonly background: boolean;
  readonly requested_by_customer_id: string | null;
  readonly attempts: number;
}

export async function operationsOf(ctx: TestContext, tenantId: string): Promise<OperationRow[]> {
  const result = await ctx.container.database.withClient((client) =>
    client.query<OperationRow>(
      `SELECT id, type, state, background, requested_by_customer_id, attempts
         FROM provisioning_operations WHERE tenant_id = $1::uuid ORDER BY created_at, id`,
      [tenantId],
    ),
  );
  return result.rows;
}

/** A RickPanel panel, created and connection-tested through the product. */
export async function rickPanel(
  ctx: TestContext,
  scope: TenantContext,
  owner: ActorContext,
  panel: FakeRickpanel,
  key: string,
): Promise<string> {
  const created = await ctx.container.panels.create(scope, owner, {
    name: `Rick ${key}`,
    providerType: 'rickpanel',
    baseUrl: panel.baseUrl,
    credentials: { username: panel.username, password: panel.password },
    activation: {},
    idempotencyKey: `panel-${key}`,
  });
  return created.view.panel.id;
}

/**
 * A NEW_SERVICE order paid from the wallet, through the product: what plans a PROVISION.
 * Planned at the REAL time, which is later than every backlog row a suite seeded.
 */
export async function paidOrder(
  ctx: TestContext,
  scope: TenantContext,
  owner: ActorContext,
  input: { readonly panelId: string; readonly customerId: UserId; readonly key: string },
): Promise<OrderId> {
  const products = new DrizzleProductRepository(ctx.container.database.db);
  const product = await products.create(scope, {
    id: ctx.container.ids.uuid() as ProductId,
    draft: {
      title: 'پلن پایه',
      description: null,
      audience: 'EVERYONE',
      sortOrder: 10,
      panelId: input.panelId as PanelId,
      categoryId: SEED_IDS.categoryA as ProductCategoryId,
      specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
      price: money(250_000n, 'IRT'),
      display: EMPTY_PRODUCT_DISPLAY,
    },
    now: ctx.container.clock.now(),
  });
  await products.setStatus(scope, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
  const actor = systemActor(input.key);
  const draft = await ctx.container.orders.createDraft(scope, actor, {
    idempotencyKey: `${input.key}-draft`,
    customerId: input.customerId,
    productId: product.id,
  });
  const confirmed = await ctx.container.orders.confirm(scope, actor, {
    idempotencyKey: `${input.key}-confirm`,
    customerId: input.customerId,
    orderId: draft.id,
  });
  await ctx.container.wallet.adjust(scope, owner, input.customerId, {
    idempotencyKey: `${input.key}-credit`,
    direction: 'CREDIT',
    amountMinor: 1_000_000n,
    currency: 'IRT',
    note: 'fixture',
  });
  await ctx.container.payments.settleFromWallet(scope, actor, input.customerId, {
    idempotencyKey: `${input.key}-pay`,
    orderId: confirmed.id,
  });
  return confirmed.id;
}

export async function resolveCustomer(
  ctx: TestContext,
  scope: TenantContext,
  telegramUserId: string,
): Promise<UserId> {
  const resolved = await ctx.container.customers.resolveFromUpdate(scope, systemActor('r'), {
    idempotencyKey: `resolve-${telegramUserId}`,
    telegramUserId,
    from: { id: Number(telegramUserId), first_name: 'مریم' },
    botInstanceId: SEED_IDS.botA1 as BotInstanceId,
  });
  return resolved.customer.id;
}

/** Writes are never sent by a usage read: every request a panel saw, by method and path. */
export function mutatingRequests(panel: FakeRickpanel): readonly string[] {
  return panel.requests
    .filter((one) => one.method !== 'GET' && one.path.split('?')[0] !== '/api/admin/token')
    .map((one) => `${one.method} ${one.path.split('?')[0] ?? ''}`);
}
