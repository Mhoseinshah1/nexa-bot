import type { TestContext } from './harness';

/**
 * Round N: rows written straight in, for the AUDIENCE suites — which measure the audience
 * query, not the flows that produce these facts. Every NOT NULL column and CHECK the schema
 * declares is satisfied, so each fixture is a state the product could have produced. The
 * Broadcast, mass-action and Campaign suites share these so they describe customers the same
 * way the audience does.
 */
export class AudienceFixtures {
  constructor(
    private readonly ctx: TestContext,
    private readonly tenantId: string,
  ) {}

  private id(): string {
    return this.ctx.container.ids.uuid();
  }

  private async q(text: string, values: unknown[]): Promise<void> {
    await this.ctx.container.database.withClient((client) => client.query(text, values));
  }

  async panel(name = 'panel', status = 'ACTIVE'): Promise<string> {
    const id = this.id();
    await this.q(
      `INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
         VALUES ($1::uuid, $2::uuid, $3, 'marzban', 'https://aud.example.test', $4)`,
      [id, this.tenantId, `${name}-${id.slice(-6)}`, status],
    );
    return id;
  }

  async product(panelId: string, title = 'plan'): Promise<string> {
    const id = this.id();
    await this.q(
      `INSERT INTO products
         (id, tenant_id, title, status, audience, sort_order, panel_id, duration_days,
          traffic_bytes, price_amount, price_currency)
         VALUES ($1::uuid, $2::uuid, $3, 'ACTIVE', 'EVERYONE', 0, $4::uuid, 30,
                 53687091200, 250000, 'IRT')`,
      [id, this.tenantId, title, panelId],
    );
    return id;
  }

  async customer(input: {
    readonly telegramUserId: string;
    readonly botInstanceId?: string | null;
    readonly status?: 'ACTIVE' | 'BLOCKED';
    readonly firstSeenAt?: Date;
    readonly firstName?: string;
    readonly username?: string;
  }): Promise<string> {
    const id = this.id();
    const blocked = input.status === 'BLOCKED';
    await this.q(
      `INSERT INTO customers (id, tenant_id, telegram_user_id, status, first_bot_instance_id,
                              first_seen_at, first_name, username, blocked_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::timestamptz, $7, $8,
                 CASE WHEN $4 = 'BLOCKED' THEN now() END, $6::timestamptz)`,
      [
        id,
        this.tenantId,
        input.telegramUserId,
        blocked ? 'BLOCKED' : 'ACTIVE',
        input.botInstanceId ?? null,
        (input.firstSeenAt ?? new Date('2026-01-01T00:00:00Z')).toISOString(),
        input.firstName ?? null,
        input.username ?? null,
      ],
    );
    return id;
  }

  /** A settled order; `purpose` TRIAL is free, REFUNDED is money that came back. */
  async order(input: {
    readonly customerId: string;
    readonly panelId: string;
    readonly productId?: string | null;
    readonly state?: 'PAID' | 'REFUNDED' | 'AWAITING_PAYMENT';
    readonly purpose?: 'NEW_SERVICE' | 'TRIAL';
    readonly settledAt?: Date;
  }): Promise<string> {
    const id = this.id();
    const state = input.state ?? 'PAID';
    const purpose = input.purpose ?? 'NEW_SERVICE';
    // A sale names its product (`orders_product_purpose_check`); a trial may name none.
    const productId =
      input.productId ?? (purpose === 'TRIAL' ? null : await this.product(input.panelId));
    const total = purpose === 'TRIAL' ? 0 : 250000;
    const settled = state === 'AWAITING_PAYMENT' ? null : (input.settledAt ?? new Date());
    await this.q(
      `INSERT INTO orders
         (id, tenant_id, customer_id, state, purpose, product_id, panel_id, line_title,
          line_duration_days, line_traffic_bytes, line_unit_price_amount, line_quantity,
          subtotal_amount, discount_amount, total_amount, currency, quote, settled_at,
          refunded_at, confirmed_at, expires_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::uuid, 'plan', 30,
                 53687091200, $8, 1, $8, 0, $8, 'IRT', '{}'::jsonb, $9::timestamptz,
                 CASE WHEN $4 = 'REFUNDED' THEN $9::timestamptz END,
                 now(), CASE WHEN $4 = 'AWAITING_PAYMENT' THEN now() + interval '1 hour' END)`,
      [
        id,
        this.tenantId,
        input.customerId,
        state,
        purpose,
        productId,
        input.panelId,
        total,
        settled === null ? null : settled.toISOString(),
      ],
    );
    return id;
  }

  /** A service with its own paid order, as `services.order_id` requires. */
  async service(input: {
    readonly customerId: string;
    readonly panelId: string;
    readonly productId?: string | null;
    readonly state?: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | 'TERMINATED';
    readonly expiresAt?: Date | null;
    readonly trafficLimitBytes?: bigint;
    readonly orderPurpose?: 'NEW_SERVICE' | 'TRIAL';
  }): Promise<string> {
    const productId =
      input.productId ??
      (input.orderPurpose === 'TRIAL' ? null : await this.product(input.panelId));
    const orderId = await this.order({
      customerId: input.customerId,
      panelId: input.panelId,
      productId,
      purpose: input.orderPurpose ?? 'NEW_SERVICE',
    });
    const id = this.id();
    await this.q(
      `INSERT INTO services
         (id, tenant_id, customer_id, order_id, panel_id, product_id, provider_username,
          state, delivery_state, traffic_limit_bytes, traffic_used_bytes, expires_at,
          provisioned_at, delivered_at, is_trial, terminated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8,
                 'DELIVERED', $9, 0, $10::timestamptz, now(), now(), $11,
                 CASE WHEN $8 = 'TERMINATED' THEN now() END)`,
      [
        id,
        this.tenantId,
        input.customerId,
        orderId,
        input.panelId,
        productId,
        `nx${id.replace(/-/g, '').slice(-10)}`,
        input.state ?? 'ACTIVE',
        (input.trafficLimitBytes ?? 53_687_091_200n).toString(),
        input.expiresAt === undefined
          ? new Date(Date.now() + 30 * 86_400_000).toISOString()
          : input.expiresAt === null
            ? null
            : input.expiresAt.toISOString(),
        input.orderPurpose === 'TRIAL',
      ],
    );
    return id;
  }

  async tier(name: string): Promise<string> {
    const id = this.id();
    await this.q(
      `INSERT INTO reseller_tiers (id, tenant_id, name, pricing_mode, credit_limit_currency)
         VALUES ($1::uuid, $2::uuid, $3, 'LIST_PRICE', 'IRT')`,
      [id, this.tenantId, name],
    );
    return id;
  }

  async reseller(customerId: string, tierId: string, status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
    await this.q(
      `INSERT INTO resellers (id, tenant_id, customer_id, tier_id, status, credit_limit_amount)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, NULL)`,
      [this.id(), this.tenantId, customerId, tierId, status],
    );
  }

  async trialGrant(customerId: string, panelId: string): Promise<void> {
    const orderId = await this.order({ customerId, panelId, purpose: 'TRIAL' });
    await this.q(
      `INSERT INTO trial_grants (id, tenant_id, customer_id, order_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      [this.id(), this.tenantId, customerId, orderId],
    );
  }

  async referral(referrerId: string, refereeId: string): Promise<void> {
    await this.q(
      `INSERT INTO referrals (id, tenant_id, referrer_id, referee_id, trigger)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ON_FIRST_PAID_ORDER')`,
      [this.id(), this.tenantId, referrerId, refereeId],
    );
  }

  async walletEntry(
    customerId: string,
    direction: 'CREDIT' | 'DEBIT',
    amount: bigint,
    currency = 'IRT',
  ): Promise<void> {
    const id = this.id();
    await this.q(
      `INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount, currency,
                                   reference, note)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, 'fixture')`,
      [
        id,
        this.tenantId,
        customerId,
        direction,
        direction === 'CREDIT' ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT',
        amount.toString(),
        currency,
        `fixture:${id}`,
      ],
    );
  }

  /** Broadcast V2: a tenant customer tag (program §8); archived when asked. */
  async tag(label: string, archived = false): Promise<string> {
    const id = this.id();
    await this.q(
      `INSERT INTO customer_tags (id, tenant_id, label, archived_at)
         VALUES ($1::uuid, $2::uuid, $3, CASE WHEN $4::boolean THEN now() END)`,
      [id, this.tenantId, label, archived],
    );
    return id;
  }

  async tagCustomer(customerId: string, tagId: string): Promise<void> {
    await this.q(
      `INSERT INTO customer_tag_assignments (tenant_id, customer_id, tag_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [this.tenantId, customerId, tagId],
    );
  }

  async optOutOfMarketing(customerId: string): Promise<void> {
    await this.q(
      `UPDATE customers SET marketing_opt_out_at = now()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [this.tenantId, customerId],
    );
  }
}
