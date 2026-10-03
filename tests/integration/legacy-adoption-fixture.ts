import type { TestContext } from './harness';

/**
 * Migration P3 — a legacy adoption, written straight in.
 *
 * There is NO adoption write path: P6 is HOLD. These helpers exist so the suites that
 * must prove an adoption order is invisible to sales, revenue, provisioning, cashback,
 * commission and refunds have one to look at. Every column satisfies the schema's own
 * rules — `orders_legacy_adoption_shape_check` included — so each row is a state the
 * future P6 path could produce, not a state the database would refuse.
 *
 * Test-only. Never import this from `apps/`.
 */
export interface LegacyAdoption {
  readonly orderId: string;
  readonly serviceId: string;
}

export async function insertLegacyAdoptionOrder(
  ctx: TestContext,
  input: {
    readonly tenantId: string;
    readonly customerId: string;
    readonly panelId: string;
    readonly productId: string;
    readonly settledAt?: Date;
    /** The legacy purchase snapshot's unit price, kept on the LINE only; the totals are 0. */
    readonly legacyUnitPrice?: bigint;
    /**
     * For the suites that prove the database REFUSES a malformed adoption: a total, a
     * purpose or a state other than the shape check allows. Never set to build a valid one.
     */
    readonly malformed?: { readonly total?: bigint; readonly purpose?: string };
  },
): Promise<string> {
  const id = ctx.container.ids.uuid();
  const settled = (input.settledAt ?? new Date()).toISOString();
  const total = (input.malformed?.total ?? 0n).toString();
  // A real quote document: the order repository parses it rather than casting it.
  const quote = JSON.stringify({
    productId: input.productId,
    quotedAt: settled,
    currency: 'IRT',
    finalAmount: { amountMinor: total, currency: 'IRT' },
    trace: [
      {
        step: 'BASE_PRICE',
        effect: 'REPLACES',
        ruleId: null,
        ruleLabel: 'legacy adoption',
        amountBefore: { amountMinor: total, currency: 'IRT' },
        amountAfter: { amountMinor: total, currency: 'IRT' },
      },
    ],
  });
  await ctx.container.database.withClient((client) =>
    client.query(
      `INSERT INTO orders
         (id, tenant_id, customer_id, state, purpose, origin, product_id, panel_id, line_title,
          line_duration_days, line_traffic_bytes, line_unit_price_amount, line_quantity,
          subtotal_amount, discount_amount, total_amount, currency, quote, settled_at,
          confirmed_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'PAID', $8, 'LEGACY_ADOPTION',
                 $4::uuid, $5::uuid, 'legacy plan', 30, 53687091200, $6, 1,
                 $9, 0, $9, 'IRT', $10::jsonb, $7::timestamptz, $7::timestamptz, $7::timestamptz)`,
      [
        id,
        input.tenantId,
        input.customerId,
        input.productId,
        input.panelId,
        (input.legacyUnitPrice ?? 0n).toString(),
        settled,
        input.malformed?.purpose ?? 'NEW_SERVICE',
        total,
        quote,
      ],
    ),
  );
  return id;
}

/** An adoption order and the ACTIVE service it represents, as `services.order_id` requires. */
export async function insertLegacyAdoption(
  ctx: TestContext,
  input: {
    readonly tenantId: string;
    readonly customerId: string;
    readonly panelId: string;
    readonly productId: string;
    readonly providerUsername: string;
    readonly settledAt?: Date;
  },
): Promise<LegacyAdoption> {
  const orderId = await insertLegacyAdoptionOrder(ctx, { ...input, legacyUnitPrice: 250_000n });
  const serviceId = ctx.container.ids.uuid();
  await ctx.container.database.withClient((client) =>
    client.query(
      `INSERT INTO services
         (id, tenant_id, customer_id, order_id, panel_id, product_id, provider_username,
          state, delivery_state, traffic_limit_bytes, traffic_used_bytes, expires_at,
          provisioned_at, delivered_at, is_trial)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, 'ACTIVE',
                 'DELIVERED', 53687091200, 0, now() + interval '30 days', $8::timestamptz,
                 $8::timestamptz, false)`,
      [
        serviceId,
        input.tenantId,
        input.customerId,
        orderId,
        input.panelId,
        input.productId,
        input.providerUsername,
        (input.settledAt ?? new Date()).toISOString(),
      ],
    ),
  );
  return { orderId, serviceId };
}
