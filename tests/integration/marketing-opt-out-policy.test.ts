import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isNexaError } from '@nexa/contracts';
import { MARKETING_OPT_OUT_DISABLED_REASON } from '../../apps/api/src/modules/commerce/customers/application/customer.service';
import { tenantA } from './harness';
import {
  MARKETING_OPT_IN_CALLBACK_DATA,
  MARKETING_OPT_OUT_CALLBACK_DATA,
} from '../../apps/api/src/surfaces/telegram/bot-runtime';
import {
  TG,
  lastKeyboard,
  receiptFixture,
  rows,
  say,
  systemActor,
  tap,
  type ReceiptFixture,
} from './receipt-review-fixture';

/**
 * Spec §9 — «اجازه قطع پیام‌های تبلیغاتی توسط مشتری», the `customer_marketing_opt_out` switch.
 *
 * ON (the default) is the behaviour before the switch existed. OFF: the opt-out button is not
 * drawn, `/stop` and every old opt-out / opt-in button change nothing, and the stored
 * `marketing_opt_out_at` is kept untouched, so turning the switch back on restores it. The
 * broadcast half (MARKETING ignores the stored value while OFF) is in `round-n-close.test.ts`.
 */
describe('the marketing opt-out policy (spec §9)', () => {
  let f: ReceiptFixture;
  let seq = 0;

  beforeAll(async () => {
    f = await receiptFixture();
  }, 120_000);

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  const optOutAt = async (): Promise<Date | null> =>
    (
      await rows<{ at: Date | null }>(
        f,
        sql`SELECT marketing_opt_out_at AS at FROM customers WHERE id = ${f.customer}`,
      )
    )[0]?.at ?? null;

  async function setPolicy(enabled: boolean) {
    const current = await f.ctx.container.featureFlagResolver.resolve(
      tenantA,
      'customer_marketing_opt_out',
    );
    return f.ctx.container.featureFlags.set(tenantA, f.owner, {
      key: 'customer_marketing_opt_out',
      enabled,
      expectedVersion: current.version,
      idempotencyKey: `policy-${String((seq += 1))}`,
      reason: 'Spec §9 integration test.',
    });
  }

  const callbacks = () => lastKeyboard(f).map((button) => button.callback_data);

  it('is ON by default: /stop and the buttons work exactly as before', async () => {
    expect(
      (await f.ctx.container.featureFlagResolver.resolve(tenantA, 'customer_marketing_opt_out'))
        .enabled,
    ).toBe(true);
    expect((await say(f, '/paysupport', TG.customer)).replyKey).toBeDefined();
    expect(callbacks()).toContain(MARKETING_OPT_OUT_CALLBACK_DATA);
    expect((await say(f, '/stop', TG.customer)).replyKey).toBe('bot.marketing.opted_out');
    expect(await optOutAt()).not.toBeNull();
    expect((await tap(f, MARKETING_OPT_IN_CALLBACK_DATA, TG.customer)).replyKey).toBe(
      'bot.marketing.opted_in',
    );
    expect(await optOutAt()).toBeNull();
  });

  it('OFF: the button is hidden, /stop and stale buttons mutate nothing, and the stored opt-out is kept; ON again restores it', async () => {
    // The customer opted out while it was allowed.
    expect((await say(f, '/stop', TG.customer)).replyKey).toBe('bot.marketing.opted_out');
    const stored = await optOutAt();
    expect(stored).not.toBeNull();

    await setPolicy(false);
    // The policy change is audited like every flag change.
    const audits = await rows<{ action: string; entity_id: string }>(
      f,
      sql`SELECT action, entity_id FROM audit_logs
           WHERE entity_id = 'customer_marketing_opt_out' ORDER BY occurred_at`,
    );
    expect(audits.length).toBeGreaterThan(0);

    // The support screen no longer offers either button.
    await say(f, '/paysupport', TG.customer);
    expect(callbacks()).not.toContain(MARKETING_OPT_OUT_CALLBACK_DATA);
    expect(callbacks()).not.toContain(MARKETING_OPT_IN_CALLBACK_DATA);

    // An old opt-in button (stale callback) cannot bypass the policy: nothing changes.
    expect((await tap(f, MARKETING_OPT_IN_CALLBACK_DATA, TG.customer)).replyKey).toBe(
      'bot.marketing.unavailable',
    );
    expect(await optOutAt()).toEqual(stored);
    // Nor can /stop or an old opt-out button.
    expect((await say(f, '/stop', TG.customer)).replyKey).toBe('bot.marketing.unavailable');
    expect((await tap(f, MARKETING_OPT_OUT_CALLBACK_DATA, TG.customer)).replyKey).toBe(
      'bot.marketing.unavailable',
    );
    expect(await optOutAt()).toEqual(stored);

    // Back ON: the earlier choice is effective again, and the customer may change it.
    await setPolicy(true);
    expect(await optOutAt()).toEqual(stored);
    await say(f, '/paysupport', TG.customer);
    expect(callbacks()).toContain(MARKETING_OPT_IN_CALLBACK_DATA);
    expect((await tap(f, MARKETING_OPT_IN_CALLBACK_DATA, TG.customer)).replyKey).toBe(
      'bot.marketing.opted_in',
    );
    expect(await optOutAt()).toBeNull();
  });

  it('OFF: the service refuses the write itself, whichever surface asks — the surface is not the only gate', async () => {
    await setPolicy(false);
    for (const optedOut of [true, false]) {
      const refused = await f.ctx.container.customers
        .setMarketingOptOut(tenantA, systemActor(`direct-${String(optedOut)}`), {
          idempotencyKey: `direct-${String(optedOut)}`,
          customerId: f.customer,
          optedOut,
        })
        .catch((error: unknown) => error);
      expect(isNexaError(refused) && refused.details['reason']).toBe(
        MARKETING_OPT_OUT_DISABLED_REASON,
      );
    }
    expect(await optOutAt()).toBeNull();
    const writes = await rows<{ n: string }>(
      f,
      sql`SELECT count(*)::text AS n FROM outbox_messages
           WHERE event_type = 'CustomerMarketingOptOutChanged'`,
    );
    expect(writes[0]?.n).toBe('0');
  });
});
