import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  customerOverviewSchema,
  type PaymentGatewayConfig,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import {
  TOPUP_MENU_CALLBACK_PREFIX,
  TOPUP_ROUTE_CALLBACK_PREFIX,
} from '../../apps/api/src/surfaces/telegram/runtime/callbacks';
import { SUPPORT_CALLBACK_DATA } from '../../apps/api/src/modules/commerce/provisioning/application/delivery.service';
import { toOverview } from '../../apps/api/src/surfaces/web/customer-360.controller';
import { tenantA } from './harness';
import {
  BOT_A,
  TG,
  lastKeyboard,
  lastReply,
  receiptFixture,
  rows,
  say,
  systemActor,
  tap,
  type ReceiptFixture,
} from './receipt-review-fixture';

/**
 * NEXA v099 (owner): with `phone_verification.allowed_numbers = IRAN_ONLY`, a customer's OWN
 * non-+98 contact is STORED, marked not accepted (`phone_not_accepted_at`), never verified.
 * The gate stops asking for the contact and says `bot.phone.not_accepted` instead; support and
 * /help stay reachable; nobody is blocked. A route's verified-phone rule refuses it with the
 * same sentence. An operator's exemption or verification opens everything; switching the
 * setting to ALL makes it count as verified at read time, and back again.
 *
 * Mutation-checked (recorded in the PR): `notAcceptedPhoneCounts` made to accept the
 * not-accepted number under IRAN_ONLY -> the gate, route and mini app tests here go red.
 */
describe('NEXA v099 — a non-Iranian number under IRAN_ONLY is stored, not accepted', () => {
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

  const OWN = Number(TG.customer);
  const FOREIGN = '+15551234567';
  const key = (label: string) => {
    seq += 1;
    return `v099-${label}-${String(seq)}-${String(Date.now())}`;
  };

  async function setFlag(flag: string, enabled: boolean): Promise<void> {
    const current = await f.ctx.container.featureFlagResolver.resolve(tenantA, flag as never);
    await f.ctx.container.featureFlags.set(tenantA, f.owner, {
      key: flag as never,
      enabled,
      expectedVersion: current.version,
      idempotencyKey: key(`flag-${flag}`),
      reason: 'NEXA v099 integration test.',
    });
  }

  async function setAllowedNumbers(value: 'ALL' | 'IRAN_ONLY'): Promise<void> {
    const before = await f.ctx.container.settingsService.get(
      tenantA,
      f.owner,
      'phone_verification.allowed_numbers',
    );
    await f.ctx.container.settingsService.set(tenantA, f.owner, {
      idempotencyKey: key('allowed'),
      key: 'phone_verification.allowed_numbers',
      value,
      expectedVersion: before.version,
    });
  }

  function shareContact(phone: string) {
    seq += 1;
    f.sent = [];
    return f.ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: key('contact'),
      botInstanceId: BOT_A,
      update: {
        update_id: 81_000_000 + seq,
        message: {
          message_id: 9700 + seq,
          date: 0,
          chat: { id: OWN, type: 'private' },
          from: { id: OWN, is_bot: false, first_name: 'زهرا' },
          contact: { first_name: 'زهرا', phone_number: phone, user_id: OWN },
        },
      },
      telegramUserId: TG.customer,
      from: { id: OWN, first_name: 'زهرا' },
    });
  }

  const phoneRow = async () =>
    (
      await rows<{
        phone_number: string | null;
        phone_verified_at: Date | null;
        phone_not_accepted_at: Date | null;
        status: string;
      }>(
        f,
        sql`SELECT phone_number, phone_verified_at, phone_not_accepted_at, status
              FROM customers WHERE id = ${f.customer}`,
      )
    )[0];

  /** The reply keyboard's buttons, flattened; [] when the reply set none. */
  const replyButtons = () =>
    (
      (
        lastReply(f)['reply_markup'] as
          { keyboard?: { text: string; request_contact?: boolean }[][] } | undefined
      )?.keyboard ?? []
    ).flat();

  const expectNotAcceptedScreen = (replyKey: unknown, label: string) => {
    expect(replyKey, label).toBe('bot.phone.not_accepted');
    expect(String(lastReply(f)['text']), label).toBe(CATALOGUE_FA['bot.phone.not_accepted']);
    // No «📞 Share Contact»: the customer is not asked again.
    expect(
      replyButtons().some((button) => button.request_contact === true),
      label,
    ).toBe(false);
  };

  const paymentCount = async () =>
    Number(
      (
        await rows<{ n: string }>(
          f,
          sql`SELECT count(*)::text AS n FROM payments WHERE tenant_id = ${tenantA.tenantId}`,
        )
      )[0]?.n ?? '0',
    );

  const OPEN: PaymentGatewayConfig = {
    displayName: null,
    instructions: null,
    minAmountMinor: 0n,
    maxAmountMinor: 0n,
    eligibility: {
      activateAfterPayments: 0,
      deactivateAfterPayments: 0,
      activateAfterAccountDays: 0,
    },
    sortOrder: 0,
    topupCashbackPercent: 0,
    allowServicePurchase: true,
    allowWalletTopup: true,
  };

  const requirePhoneOnTransfer = () =>
    f.ctx.container.paymentGateways.configure(tenantA, f.owner, {
      idempotencyKey: key('cfg'),
      provider: 'MANUAL_TRANSFER',
      config: { ...OPEN, requiresVerifiedPhone: true },
    });

  async function topupChooser(): Promise<string> {
    await tap(f, TOPUP_MENU_CALLBACK_PREFIX, TG.customer);
    await say(f, '200000', TG.customer);
    const route = lastKeyboard(f)
      .map((button) => String(button.callback_data ?? ''))
      .find((data) => data.startsWith(TOPUP_ROUTE_CALLBACK_PREFIX));
    expect(route, JSON.stringify(f.sent)).toBeDefined();
    return route as string;
  }

  const routeRefuses = () =>
    f.ctx.container.paymentGateways.phoneVerificationRequired(
      tenantA,
      f.customer,
      'MANUAL_TRANSFER',
    );

  async function miniAppGate() {
    const customer = await new DrizzleCustomerRepository(f.ctx.container.database.db).findById(
      tenantA,
      f.customer,
    );
    if (customer === null) throw new Error('fixture customer missing');
    const context = {
      scope: tenantA,
      botInstanceId: BOT_A,
      sessionId: 'v099-session',
      customer,
      telegramUserId: TG.customer,
    };
    const sessions = f.ctx.container.miniApp.sessions;
    return {
      gate: await sessions.gateFor(context, systemActor('miniapp').correlationId),
      notAccepted: await sessions.phoneNotAccepted(context),
    };
  }

  const exempt = (exemptIt: boolean) =>
    f.ctx.container.customerControls.setPhoneExemption(tenantA, f.owner, {
      idempotencyKey: key('exempt'),
      customerId: f.customer,
      exempt: exemptIt,
      reason: 'پشتیبانی بررسی کرد',
    });

  it('stores the foreign number not verified, answers with the sentence, keeps support open and blocks nobody', async () => {
    await setFlag('phone_verification', true);
    await setAllowedNumbers('IRAN_ONLY');
    const shared = await shareContact('15551234567');
    expectNotAcceptedScreen(shared.replyKey, 'the share');

    const row = await phoneRow();
    expect(row?.phone_number).toBe(FOREIGN);
    expect(row?.phone_verified_at).toBeNull();
    expect(row?.phone_not_accepted_at).not.toBeNull();
    expect(row?.status).toBe('ACTIVE');

    // Audited like any share, masked, and marked not accepted; no verification event.
    const audits = await rows<{ action: string; after: Record<string, unknown> }>(
      f,
      sql`SELECT action, after FROM audit_logs WHERE entity_id = ${f.customer}
           AND action LIKE 'customer.phone.%' ORDER BY occurred_at`,
    );
    expect(audits).toEqual([
      {
        action: 'customer.phone.self_verify',
        after: { phoneNumber: '…4567', changed: true, accepted: false },
      },
    ]);
    const events = await rows<{ n: string }>(
      f,
      sql`SELECT count(*)::text AS n FROM outbox_messages WHERE aggregate_id = ${f.customer}
           AND event_type = 'CustomerPhoneVerificationChanged'`,
    );
    expect(events[0]?.n).toBe('0');

    // Every held turn: the same sentence, never the contact prompt again.
    for (const turn of [
      () => say(f, '/start', TG.customer),
      () => say(f, '/wallet', TG.customer),
      () => tap(f, TOPUP_MENU_CALLBACK_PREFIX, TG.customer),
    ]) {
      expectNotAcceptedScreen((await turn()).replyKey, 'held turn');
    }
    // «پشتیبانی» and /help stay reachable, as for the other gates.
    const support = new Set(['bot.support.contact', 'bot.support.unconfigured', 'bot.faq.page']);
    for (const turn of [
      () => say(f, CATALOGUE_FA['bot.menu.help'], TG.customer),
      () => say(f, '/help', TG.customer),
      () => tap(f, SUPPORT_CALLBACK_DATA, TG.customer),
    ]) {
      const result = await turn();
      expect(support.has(String(result.replyKey)), String(result.replyKey)).toBe(true);
    }
    // The same number again changes nothing and keeps its first time.
    const first = row?.phone_not_accepted_at;
    expectNotAcceptedScreen((await shareContact('+15551234567')).replyKey, 'again');
    expect((await phoneRow())?.phone_not_accepted_at).toEqual(first);
    expect((await phoneRow())?.status).toBe('ACTIVE');
  });

  it('a route that needs a verified number refuses it, with the same sentence and no payment', async () => {
    await setAllowedNumbers('IRAN_ONLY');
    await requirePhoneOnTransfer();
    await shareContact(FOREIGN);
    expect(await routeRefuses()).toBe(true);
    const route = await topupChooser();
    const picked = await tap(f, route, TG.customer);
    expectNotAcceptedScreen(picked.replyKey, 'gateway pick');
    expect(await paymentCount()).toBe(0);
    // Nothing was remembered behind it.
    const resume = await rows<{ phone_resume: string | null }>(
      f,
      sql`SELECT phone_resume FROM customers WHERE id = ${f.customer}`,
    );
    expect(resume[0]?.phone_resume ?? null).toBeNull();
  });

  it('an operator’s exemption opens the gate and the route', async () => {
    await setFlag('phone_verification', true);
    await setAllowedNumbers('IRAN_ONLY');
    await requirePhoneOnTransfer();
    await shareContact(FOREIGN);
    await exempt(true);
    expect((await say(f, '/start', TG.customer)).replyKey).not.toBe('bot.phone.not_accepted');
    expect(await routeRefuses()).toBe(false);
    const route = await topupChooser();
    const paid = await tap(f, route, TG.customer);
    expect(paid.replyKey).not.toBe('bot.phone.not_accepted');
    expect(await paymentCount()).toBe(1);
    expect((await miniAppGate()).gate).toBeNull();
    // Still the stored, not-accepted number: the exemption verifies nothing.
    expect((await phoneRow())?.phone_verified_at).toBeNull();
  });

  it('an operator’s verification of that same number verifies it', async () => {
    await setFlag('phone_verification', true);
    await setAllowedNumbers('IRAN_ONLY');
    await shareContact(FOREIGN);
    const verified = await f.ctx.container.customerControls.setVerifiedPhone(tenantA, f.owner, {
      idempotencyKey: key('verify'),
      customerId: f.customer,
      phoneNumber: FOREIGN,
      reason: 'پشتیبانی تأیید کرد',
    });
    expect(verified.changed).toBe(true);
    const row = await phoneRow();
    expect(row?.phone_number).toBe(FOREIGN);
    expect(row?.phone_verified_at).not.toBeNull();
    expect(row?.phone_not_accepted_at).toBeNull();
    expect((await say(f, '/start', TG.customer)).replyKey).not.toBe('bot.phone.not_accepted');
  });

  it('switching to ALL makes it count as verified at read time, and back again', async () => {
    await setFlag('phone_verification', true);
    await setAllowedNumbers('IRAN_ONLY');
    await requirePhoneOnTransfer();
    await shareContact(FOREIGN);
    await setAllowedNumbers('ALL');
    // Nothing was migrated: the row is what the share stored.
    const row = await phoneRow();
    expect(row?.phone_verified_at).toBeNull();
    expect(row?.phone_not_accepted_at).not.toBeNull();
    const start = await say(f, '/start', TG.customer);
    expect(start.replyKey).not.toBe('bot.phone.not_accepted');
    expect(start.replyKey).not.toBe('bot.phone.required');
    expect(await routeRefuses()).toBe(false);
    expect(await miniAppGate()).toEqual({ gate: null, notAccepted: false });
    const route = await topupChooser();
    await tap(f, route, TG.customer);
    expect(await paymentCount()).toBe(1);
    // Reversible: IRAN_ONLY again holds it again.
    await setAllowedNumbers('IRAN_ONLY');
    expectNotAcceptedScreen((await say(f, '/start', TG.customer)).replyKey, 'back to IRAN_ONLY');
    expect(await routeRefuses()).toBe(true);
  });

  it('an Iranian share is unchanged: verified, nothing not accepted', async () => {
    await setFlag('phone_verification', true);
    await setAllowedNumbers('IRAN_ONLY');
    const shared = await shareContact('989121234567');
    expect(shared.replyKey).not.toBe('bot.phone.not_accepted');
    const row = await phoneRow();
    expect(row?.phone_number).toBe('+989121234567');
    expect(row?.phone_verified_at).not.toBeNull();
    expect(row?.phone_not_accepted_at).toBeNull();
  });

  it('an Iranian share after the not-accepted one replaces it and verifies', async () => {
    await setFlag('phone_verification', true);
    await setAllowedNumbers('IRAN_ONLY');
    await shareContact(FOREIGN);
    await shareContact('+989121234567');
    const row = await phoneRow();
    expect(row?.phone_number).toBe('+989121234567');
    expect(row?.phone_verified_at).not.toBeNull();
    expect(row?.phone_not_accepted_at).toBeNull();
    expect((await say(f, '/wallet', TG.customer)).replyKey).not.toBe('bot.phone.not_accepted');
  });

  it('a customer verified earlier keeps the verification; a foreign share stores nothing', async () => {
    await setAllowedNumbers('IRAN_ONLY');
    await shareContact('+989121234567');
    const refused = await shareContact(FOREIGN);
    expect(refused.replyKey).toBe('bot.phone.iran_only');
    const row = await phoneRow();
    expect(row?.phone_number).toBe('+989121234567');
    expect(row?.phone_verified_at).not.toBeNull();
    expect(row?.phone_not_accepted_at).toBeNull();
    await expect(
      (
        f.ctx.container.botRuntime.deps.phoneVerification as NonNullable<
          typeof f.ctx.container.botRuntime.deps.phoneVerification
        >
      ).verifyOwnContact(tenantA, systemActor('direct'), {
        idempotencyKey: key('direct'),
        customerId: f.customer,
        contact: { phoneNumber: FOREIGN, userId: TG.customer, forwarded: false },
      }),
    ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.PHONE_NOT_IRANIAN });
  });

  it('the mini app: the same gate state, and /me says so for a route refusal', async () => {
    await setAllowedNumbers('IRAN_ONLY');
    await shareContact(FOREIGN);
    // The bot-wide switch off: no gate, but a route's rule would refuse — /me tells the app.
    expect(await miniAppGate()).toEqual({ gate: null, notAccepted: true });
    await setFlag('phone_verification', true);
    expect(await miniAppGate()).toEqual({
      gate: { kind: 'PHONE_NOT_ACCEPTED' },
      notAccepted: true,
    });
    // A customer with no number at all is still asked for one.
    await f.ctx.container.database.db.execute(
      sql`UPDATE customers SET phone_number = NULL, phone_not_accepted_at = NULL
           WHERE id = ${f.customer}`,
    );
    expect(await miniAppGate()).toEqual({ gate: { kind: 'PHONE' }, notAccepted: false });
  });

  it('the admin overview exposes the stored number and its not-accepted state, read-only', async () => {
    await setAllowedNumbers('IRAN_ONLY');
    const empty = customerOverviewSchema.parse(
      toOverview(await f.ctx.container.customerControls.overview(tenantA, f.owner, f.customer)),
    );
    expect(empty.phoneNotAccepted).toBeNull();
    await shareContact(FOREIGN);
    const overview = customerOverviewSchema.parse(
      toOverview(await f.ctx.container.customerControls.overview(tenantA, f.owner, f.customer)),
    );
    // `phone` is the VERIFIED number only.
    expect(overview.phone).toBeNull();
    expect(overview.phoneNotAccepted).toMatchObject({
      number: FOREIGN,
      masked: '…4567',
      countsAsVerified: false,
    });
    expect(overview.phoneNotAccepted?.sharedAt).toEqual(expect.any(String));
    await setAllowedNumbers('ALL');
    const all = customerOverviewSchema.parse(
      toOverview(await f.ctx.container.customerControls.overview(tenantA, f.owner, f.customer)),
    );
    expect(all.phoneNotAccepted?.countsAsVerified).toBe(true);
    // The CHECK: a number is verified or not accepted, never both.
    await expect(
      f.ctx.container.database.db.execute(
        sql`UPDATE customers SET phone_verified_at = now() WHERE id = ${f.customer}`,
      ),
    ).rejects.toThrow();
  });
});
