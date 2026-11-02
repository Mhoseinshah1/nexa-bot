import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
  isNexaError,
  money,
  type PanelId,
  type PaymentGatewayConfig,
  type ProductCategoryId,
  type CorrelationId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleOpsLogFacts } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/drizzle-ops-log-facts';
import type { TransactionScope } from '../../apps/api/src/infrastructure/persistence/unit-of-work';
import {
  PHONE_VERIFY_CALLBACK_DATA,
  TOPUP_MENU_CALLBACK_PREFIX,
  TOPUP_ROUTE_CALLBACK_PREFIX,
} from '../../apps/api/src/surfaces/telegram/runtime/callbacks';
import { SEED_IDS, tenantA } from './harness';
import {
  BOT_A,
  TG,
  bindNewAdmin,
  customerNamed,
  lastKeyboard,
  lastReply,
  lastText,
  receiptFixture,
  rows,
  say,
  systemActor,
  tap,
  type ReceiptFixture,
} from './receipt-review-fixture';

/**
 * R11 B7 — phone verification by the customer's OWN Telegram contact, and a payment route
 * that requires a verified number.
 *
 * End to end through the real runtime, services and PostgreSQL, with a socket standing in
 * for Telegram: the prompt and its contact keyboard; an own contact accepted, stored as
 * E.164 with the clock's time, idempotent, replaced by a new own number; another person's,
 * a nameless and a forwarded contact refused with nothing stored; the flag off verifying
 * nothing. Then the route rule: hidden from an unverified customer (one evaluation for the
 * menu and the checkout), refused with `PHONE_VERIFICATION_REQUIRED` when reached anyway —
 * top-up and order transfer alike — offered once verified, and IGNORED while the flag is off.
 * Finally the number's privacy: masked in the audit row, the operations-log facts and the
 * Customer 360 overview for an administrator without `users.phone.verify`; and the raw
 * number absent from every log call, outbox payload, audit, idempotency and Telegram message.
 *
 * Mutation-checked (each broken alone, this file run, restored):
 *  - the `user_id` equality in `PhoneVerificationService.verifyOwnContact` dropped -> "refuses
 *    ANOTHER person's contact", "keeps two customers apart" and the privacy scan go red;
 *  - its forwarded check dropped -> "refuses a FORWARDED contact";
 *  - the order card-to-card check in `PaymentService.requestManualTransfer` dropped ->
 *    "refuses an ORDER's card to card";
 *  - `refuseUnverifiedPhone` neutralised -> "refuses a direct top-up", "the bot answers the
 *    refusal", "keeps two customers apart";
 *  - `phoneRuleRefuses` always false -> six of the route-rule tests;
 *  - the flag ignored in `PaymentGatewayService.phoneStanding` -> "IGNORES the rule while the
 *    feature is off"; in `verifyOwnContact` -> "verifies nothing while the feature is off"; in
 *    `phoneVerifyPrompt` -> "sends the contact keyboard while the feature is on, and nothing to
 *    verify while off".
 */
describe('R11 B7 — phone verification and the verified-phone route rule', () => {
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

  async function setFlag(enabled: boolean): Promise<void> {
    const current = await f.ctx.container.featureFlagResolver.resolve(
      tenantA,
      'phone_verification',
    );
    seq += 1;
    await f.ctx.container.featureFlags.set(tenantA, f.owner, {
      key: 'phone_verification',
      enabled,
      expectedVersion: current.version,
      idempotencyKey: `flag-phone-${String(seq)}-${String(Date.now())}`,
      reason: 'R11 B7 integration test.',
    });
  }

  /** A contact message from the customer, as Telegram delivers one. */
  function shareContact(
    contact: { readonly phone_number: string; readonly user_id?: number },
    extra: Record<string, unknown> = {},
    from: string = TG.customer,
  ) {
    seq += 1;
    f.sent = [];
    return f.ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: `contact-update-${String(seq)}-${String(Date.now())}`,
      botInstanceId: BOT_A,
      update: {
        update_id: 70_000_000 + seq,
        message: {
          message_id: 9000 + seq,
          date: 0,
          chat: { id: Number(from), type: 'private' },
          from: { id: Number(from), is_bot: false, first_name: 'زهرا' },
          contact: { first_name: 'زهرا', ...contact },
          ...extra,
        },
      },
      telegramUserId: from,
      from: { id: Number(from), first_name: 'زهرا' },
    });
  }

  const storedPhone = async () =>
    (
      await rows<{ phone_number: string | null; phone_verified_at: Date | null }>(
        f,
        sql`SELECT phone_number, phone_verified_at FROM customers WHERE id = ${f.customer}`,
      )
    )[0];

  const phoneAudits = () =>
    rows<{ action: string; before: unknown; after: unknown }>(
      f,
      sql`SELECT action, before, after FROM audit_logs
           WHERE entity_id = ${f.customer} AND action LIKE 'customer.phone.%'
           ORDER BY occurred_at`,
    );

  const phoneEvents = () =>
    rows<{ payload: unknown }>(
      f,
      sql`SELECT payload FROM outbox_messages
           WHERE aggregate_id = ${f.customer} AND event_type = 'CustomerPhoneVerificationChanged'`,
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

  async function requirePhoneOnTransfer(required: boolean): Promise<void> {
    seq += 1;
    await f.ctx.container.paymentGateways.configure(tenantA, f.owner, {
      idempotencyKey: `cfg-phone-${String(seq)}`,
      provider: 'MANUAL_TRANSFER',
      config: { ...OPEN, requiresVerifiedPhone: required },
    });
  }

  const providers = async (
    purpose: 'SERVICE_PURCHASE' | 'WALLET_TOPUP',
    customerId: UserId = f.customer,
  ) =>
    (await f.ctx.container.paymentGateways.routesFor(tenantA, customerId, purpose, null)).map(
      (route) => route.provider,
    );

  async function refusalOf(promise: Promise<unknown>): Promise<string | null> {
    const error = await promise.then(() => null).catch((thrown: unknown) => thrown);
    if (error === null) return null;
    expect(isNexaError(error), String(error)).toBe(true);
    return (error as { code: string }).code;
  }

  const typedTopup = (key: string, customerId: UserId = f.customer) =>
    f.ctx.container.payments.requestWalletTopupTyped(
      { ...tenantA, botInstanceId: BOT_A },
      systemActor(key),
      customerId,
      { idempotencyKey: key, amount: money(200_000n, 'IRT'), provider: 'MANUAL_TRANSFER' },
    );

  /** A confirmed order of the fixture's customer, awaiting payment. */
  async function confirmedOrder(key: string) {
    const c = f.ctx.container;
    const products = new DrizzleProductRepository(c.database.db);
    const created = await products.create(tenantA, {
      id: c.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: f.panelA as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 1n, deviceLimit: null },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: c.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', c.clock.now());
    const order = await c.orders.createDraft(tenantA, systemActor(`${key}-d`), {
      idempotencyKey: `${key}-draft`,
      customerId: f.customer,
      productId: created.id,
    });
    return c.orders.confirm(tenantA, systemActor(`${key}-c`), {
      idempotencyKey: `${key}-confirm`,
      customerId: f.customer,
      orderId: order.id,
    });
  }

  // -------------------------------------------------------------------------------------
  // The bot flow
  // -------------------------------------------------------------------------------------

  describe('the bot flow', () => {
    it('«تأیید شماره تلفن» sends the contact keyboard while the feature is on, and nothing to verify while off', async () => {
      await tap(f, PHONE_VERIFY_CALLBACK_DATA, TG.customer);
      expect(lastText(f)).toContain('تأیید شماره تلفن در حال حاضر');
      expect((lastReply(f)['reply_markup'] as { keyboard?: unknown } | undefined)?.keyboard).toBe(
        undefined,
      );

      await setFlag(true);
      await tap(f, PHONE_VERIFY_CALLBACK_DATA, TG.customer);
      const markup = lastReply(f)['reply_markup'] as {
        keyboard: { text: string; request_contact?: boolean }[][];
      };
      expect(markup.keyboard[0]?.[0]).toEqual({
        text: CATALOGUE_FA['bot.phone.share_button'],
        request_contact: true,
      });
      expect(markup.keyboard[1]?.[0]?.text).toBe(CATALOGUE_FA['bot.phone.cancel_button']);
    });

    it('accepts the customer’s OWN contact: E.164 with the clock’s time, masked everywhere it is said', async () => {
      await setFlag(true);
      const result = await shareContact({ phone_number: '989121234567', user_id: OWN });
      expect(result.replyKey).toBe('bot.phone.verified');
      const stored = await storedPhone();
      expect(stored?.phone_number).toBe('+989121234567');
      expect(stored?.phone_verified_at).not.toBeNull();
      // The reply names the last four digits only, and brings the main menu keyboard back.
      expect(lastText(f)).toContain('…4567');
      expect(lastText(f)).not.toContain('9121234567');
      expect((lastReply(f)['reply_markup'] as { keyboard?: unknown[] }).keyboard).toBeDefined();
      // The audit row and the event never carry the number.
      const audits = await phoneAudits();
      expect(audits.map((row) => row.action)).toEqual(['customer.phone.self_verify']);
      expect(JSON.stringify(audits)).not.toContain('9121234567');
      expect(audits[0]?.after).toMatchObject({ phoneNumber: '…4567', changed: true });
      expect((await phoneEvents()).map((row) => row.payload)).toEqual([{ verified: true }]);
    });

    it('is idempotent for the same number and REPLACES it with a new own number', async () => {
      await setFlag(true);
      await shareContact({ phone_number: '+98 912 123 4567', user_id: OWN });
      const first = await storedPhone();
      await shareContact({ phone_number: '989121234567', user_id: OWN });
      const again = await storedPhone();
      expect(again?.phone_number).toBe('+989121234567');
      // The same number keeps its first verification, and no second event is written.
      expect(String(again?.phone_verified_at)).toBe(String(first?.phone_verified_at));
      expect(await phoneEvents()).toHaveLength(1);

      await shareContact({ phone_number: '989351112222', user_id: OWN });
      expect((await storedPhone())?.phone_number).toBe('+989351112222');
      expect(await phoneEvents()).toHaveLength(2);
    });

    it('refuses ANOTHER person’s contact, and stores nothing', async () => {
      await setFlag(true);
      const result = await shareContact({ phone_number: '989121234567', user_id: OWN + 1 });
      expect(result.replyKey).toBe('bot.phone.not_own');
      expect(lastText(f)).toContain('فقط شمارهٔ خود حساب تلگرامتان');
      // The contact keyboard stays, so the customer can tap the right button.
      const markup = lastReply(f)['reply_markup'] as {
        keyboard: { request_contact?: boolean }[][];
      };
      expect(markup.keyboard[0]?.[0]?.request_contact).toBe(true);
      expect((await storedPhone())?.phone_number).toBeNull();
      expect(await phoneEvents()).toHaveLength(0);
    });

    it('refuses a contact that names no account (an address-book number)', async () => {
      await setFlag(true);
      const result = await shareContact({ phone_number: '989121234567' });
      expect(result.replyKey).toBe('bot.phone.not_own');
      expect((await storedPhone())?.phone_number).toBeNull();
    });

    it('refuses a FORWARDED contact, even one that names the sender', async () => {
      await setFlag(true);
      const viaOrigin = await shareContact(
        { phone_number: '989121234567', user_id: OWN },
        { forward_origin: { type: 'user', date: 0, sender_user: { id: OWN } } },
      );
      expect(viaOrigin.replyKey).toBe('bot.phone.not_own');
      const viaLegacy = await shareContact(
        { phone_number: '989121234567', user_id: OWN },
        { forward_date: 1 },
      );
      expect(viaLegacy.replyKey).toBe('bot.phone.not_own');
      expect((await storedPhone())?.phone_number).toBeNull();
    });

    it('verifies nothing while the feature is off', async () => {
      const result = await shareContact({ phone_number: '989121234567', user_id: OWN });
      expect(result.replyKey).toBe('bot.phone.unavailable');
      expect((await storedPhone())?.phone_number).toBeNull();
      expect(await phoneAudits()).toHaveLength(0);
    });

    it('the cancel label brings the main menu back and stores nothing', async () => {
      await setFlag(true);
      const result = await say(f, CATALOGUE_FA['bot.phone.cancel_button'], TG.customer);
      expect(result.replyKey).toBe('bot.phone.cancelled');
      expect((lastReply(f)['reply_markup'] as { keyboard?: unknown[] }).keyboard).toBeDefined();
    });

    it('the wallet screen offers the button only while on and only to an unverified customer', async () => {
      const verifyShown = () =>
        lastKeyboard(f).some((button) => button.callback_data === PHONE_VERIFY_CALLBACK_DATA);
      await say(f, '/wallet', TG.customer);
      expect(verifyShown()).toBe(false);
      await setFlag(true);
      await say(f, '/wallet', TG.customer);
      expect(verifyShown()).toBe(true);
      await shareContact({ phone_number: '989121234567', user_id: OWN });
      await say(f, '/wallet', TG.customer);
      expect(verifyShown()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------
  // The route rule
  // -------------------------------------------------------------------------------------

  describe('the verified-phone route rule', () => {
    it('hides the route from an unverified customer, for both purposes (one evaluation)', async () => {
      await setFlag(true);
      await requirePhoneOnTransfer(true);
      expect(await providers('WALLET_TOPUP')).toEqual([]);
      expect(await providers('SERVICE_PURCHASE')).toEqual([]);
      // The checkout's own list (the bot's and the mini app's) draws no card to card either.
      const order = await confirmedOrder('hide');
      const offered = await f.ctx.container.miniApp.checkout.orderRoutes(
        tenantA,
        f.customer,
        order.totals.total,
      );
      expect(offered.map((route) => route.kind)).not.toContain('CARD_TO_CARD');
      expect(
        await f.ctx.container.miniApp.checkout.phoneVerificationOffered(
          tenantA,
          f.customer,
          'SERVICE_PURCHASE',
          order.totals.total,
        ),
      ).toBe(true);
      expect(
        await f.ctx.container.miniApp.checkout.phoneVerificationOffered(
          tenantA,
          f.customer,
          'WALLET_TOPUP',
          null,
        ),
      ).toBe(true);
    });

    it('refuses a direct top-up through it with PHONE_VERIFICATION_REQUIRED, and writes nothing', async () => {
      await setFlag(true);
      await requirePhoneOnTransfer(true);
      expect(await refusalOf(typedTopup('typed-unverified'))).toBe(
        COMMERCE_ERROR_CODES.PHONE_VERIFICATION_REQUIRED,
      );
      const payments = await rows<{ n: number }>(
        f,
        sql`SELECT count(*)::int AS n FROM payments WHERE tenant_id = ${tenantA.tenantId}`,
      );
      expect(payments[0]?.n).toBe(0);
    });

    it('refuses an ORDER’s card to card with PHONE_VERIFICATION_REQUIRED, unlike the thresholds (OQ-5C-01)', async () => {
      await setFlag(true);
      await requirePhoneOnTransfer(true);
      const order = await confirmedOrder('order-unverified');
      expect(
        await refusalOf(
          f.ctx.container.payments.requestManualTransfer(
            tenantA,
            systemActor('order-pay'),
            f.customer,
            { idempotencyKey: 'order-pay-unverified', orderId: order.id },
          ),
        ),
      ).toBe(COMMERCE_ERROR_CODES.PHONE_VERIFICATION_REQUIRED);
    });

    it('the bot answers the refusal in Persian with the verify button', async () => {
      await setFlag(true);
      await requirePhoneOnTransfer(true);
      const { refusal } = await import('../../apps/api/src/surfaces/telegram/runtime/refusals');
      const error = await typedTopup('typed-bot').catch((thrown: unknown) => thrown);
      const reply = refusal(error);
      expect(reply.key).toBe('bot.payment.phone_required');
      expect(reply.buttons.map((button) => ('data' in button ? button.data : null))).toEqual([
        PHONE_VERIFY_CALLBACK_DATA,
      ]);
      expect(CATALOGUE_FA['bot.payment.phone_required']).toMatch(/شماره تلفن/u);
    });

    it('offers the route once the customer verified their own number', async () => {
      await setFlag(true);
      await requirePhoneOnTransfer(true);
      await shareContact({ phone_number: '989121234567', user_id: OWN });
      expect(await providers('WALLET_TOPUP')).toEqual(['MANUAL_TRANSFER']);
      expect(await providers('SERVICE_PURCHASE')).toEqual(['MANUAL_TRANSFER']);
      expect(await refusalOf(typedTopup('typed-verified'))).toBeNull();
      const order = await confirmedOrder('order-verified');
      expect(
        await refusalOf(
          f.ctx.container.payments.requestManualTransfer(
            tenantA,
            systemActor('order-pay-v'),
            f.customer,
            { idempotencyKey: 'order-pay-verified', orderId: order.id },
          ),
        ),
      ).toBeNull();
    });

    it('IGNORES the rule while the feature is off: the unverified customer is offered the route', async () => {
      await requirePhoneOnTransfer(true);
      expect(await providers('WALLET_TOPUP')).toEqual(['MANUAL_TRANSFER']);
      expect(await providers('SERVICE_PURCHASE')).toEqual(['MANUAL_TRANSFER']);
      expect(await refusalOf(typedTopup('typed-flag-off'))).toBeNull();
      expect(
        await f.ctx.container.miniApp.checkout.phoneVerificationOffered(
          tenantA,
          f.customer,
          'WALLET_TOPUP',
          null,
        ),
      ).toBe(false);
    });

    it('the bot top-up draws no route held back by the rule, says why, and draws it once verified', async () => {
      const routeButtons = () =>
        lastKeyboard(f).filter((button) =>
          String(button.callback_data ?? '').startsWith(TOPUP_ROUTE_CALLBACK_PREFIX),
        );
      await setFlag(true);
      await requirePhoneOnTransfer(true);
      const refused = await tap(f, TOPUP_MENU_CALLBACK_PREFIX, TG.customer);
      expect(refused.replyKey).toBe('bot.payment.phone_required');
      expect(lastKeyboard(f).map((button) => button.callback_data)).toContain(
        PHONE_VERIFY_CALLBACK_DATA,
      );
      expect(routeButtons()).toEqual([]);

      await shareContact({ phone_number: '989121234567', user_id: OWN });
      const offered = await tap(f, TOPUP_MENU_CALLBACK_PREFIX, TG.customer);
      expect(offered.replyKey).not.toBe('bot.payment.phone_required');
      expect(offered.replyKey).not.toBe('bot.wallet.topup_unavailable');
    });

    it('keeps two customers apart: one verified number opens the route for its owner only', async () => {
      await setFlag(true);
      await requirePhoneOnTransfer(true);
      const otherTelegramId = '750902';
      const other = await customerNamed(f, otherTelegramId, 'other_b7_iso');
      await shareContact({ phone_number: '989121234567', user_id: OWN });
      // The second customer sends the FIRST customer's own contact: it is not theirs.
      const borrowed = await shareContact(
        { phone_number: '989121234567', user_id: OWN },
        {},
        otherTelegramId,
      );
      expect(borrowed.replyKey).toBe('bot.phone.not_own');
      const phones = await rows<{ id: string; phone_number: string | null }>(
        f,
        sql`SELECT id, phone_number FROM customers WHERE id IN (${f.customer}, ${other})`,
      );
      expect(phones.find((row) => row.id === f.customer)?.phone_number).toBe('+989121234567');
      expect(phones.find((row) => row.id === other)?.phone_number).toBeNull();
      expect(await providers('WALLET_TOPUP')).toEqual(['MANUAL_TRANSFER']);
      expect(await providers('WALLET_TOPUP', other)).toEqual([]);
      expect(await refusalOf(typedTopup('typed-other', other))).toBe(
        COMMERCE_ERROR_CODES.PHONE_VERIFICATION_REQUIRED,
      );
      expect(await refusalOf(typedTopup('typed-first'))).toBeNull();
    });

    it('keeps the stored switch when an update does not mention it, and shows it on the route', async () => {
      await requirePhoneOnTransfer(true);
      const after = await f.ctx.container.paymentGateways.configure(tenantA, f.owner, {
        idempotencyKey: 'cfg-phone-silent',
        provider: 'MANUAL_TRANSFER',
        config: { ...OPEN, displayName: 'کارت به کارت' },
      });
      expect(after.requiresVerifiedPhone).toBe(true);
      const audits = await rows<{ after: { requiresVerifiedPhone?: boolean } }>(
        f,
        sql`SELECT after FROM audit_logs WHERE action = 'payment_gateway.configure'
             ORDER BY occurred_at DESC LIMIT 1`,
      );
      expect(audits[0]?.after.requiresVerifiedPhone).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------
  // Privacy
  // -------------------------------------------------------------------------------------

  describe('the number’s privacy', () => {
    it('leaves the raw number in no log line, ops fact, outbox payload, audit, idempotency or Telegram message', async () => {
      const RAW = '9121234567';
      const logged: unknown[] = [];
      const logger = f.ctx.container.logger;
      const capture = (context: Record<string, unknown>, message: string): void => {
        logged.push([context, message]);
      };
      const spies = [
        vi.spyOn(logger, 'trace').mockImplementation(capture),
        vi.spyOn(logger, 'debug').mockImplementation(capture),
        vi.spyOn(logger, 'info').mockImplementation(capture),
        vi.spyOn(logger, 'warn').mockImplementation(capture),
        vi.spyOn(logger, 'error').mockImplementation(capture),
      ];
      try {
        await setFlag(true);
        await requirePhoneOnTransfer(true);
        const result = await shareContact({ phone_number: `98${RAW}`, user_id: OWN });
        expect(result.replyKey).toBe('bot.phone.verified');
        const telegram = JSON.stringify(f.sent);
        // A refused contact and a payment through the rule, so their rows are scanned too.
        await shareContact({ phone_number: '989350001111', user_id: OWN + 1 });
        expect(await refusalOf(typedTopup('typed-privacy'))).toBeNull();
        const dump = async (table: string) =>
          JSON.stringify(
            await rows<{ r: string }>(
              f,
              sql.raw(`SELECT row_to_json(t)::text AS r FROM ${table} t`),
            ),
          );
        for (const table of [
          'outbox_messages',
          'operational_events',
          'audit_logs',
          'request_idempotency',
          'processed_messages',
        ]) {
          expect(await dump(table), table).not.toContain(RAW);
        }
        expect(await dump('outbox_messages')).toContain('CustomerPhoneVerificationChanged');
        // The scan finds the number where it IS stored, so a miss above is a real absence.
        expect(await dump('customers')).toContain(RAW);
        expect(telegram).toContain('…4567');
        expect(telegram).not.toContain(RAW);
        expect(JSON.stringify(f.sent)).not.toContain('9350001111');
        const facts = new DrizzleOpsLogFacts(f.ctx.container.database.db);
        expect(
          JSON.stringify(await facts.customer(tenantA, f.customer, {} as TransactionScope)),
        ).not.toContain(RAW);
        expect(JSON.stringify(logged)).not.toContain(RAW);
        // The stored number itself is the one place it lives.
        expect((await storedPhone())?.phone_number).toBe(`+98${RAW}`);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });

    it('the operations-log facts carry the number masked', async () => {
      await setFlag(true);
      await shareContact({ phone_number: '989121234567', user_id: OWN });
      const facts = new DrizzleOpsLogFacts(f.ctx.container.database.db);
      const fact = await facts.customer(tenantA, f.customer, {} as TransactionScope);
      expect(fact?.phone).toBe('…4567');
    });

    it('Customer 360 shows the full number only to a holder of users.phone.verify', async () => {
      await setFlag(true);
      await shareContact({ phone_number: '989121234567', user_id: OWN });
      const owner = await f.ctx.container.customerControls.overview(tenantA, f.owner, f.customer);
      expect(owner.phoneNumberVisible).toBe(true);
      const viewerId = await bindNewAdmin(f, 'viewer-b7', null, ['users.view']);
      const viewer = await f.ctx.container.customerControls.overview(
        tenantA,
        {
          type: 'WEB_ADMIN',
          id: viewerId,
          label: 'viewer-b7',
          surface: 'WEB',
          correlationId: 'b7-viewer' as CorrelationId,
        },
        f.customer,
      );
      expect(viewer.phoneNumberVisible).toBe(false);
      // A second customer, never verified, is simply unverified.
      const other = await customerNamed(f, '750901', 'other_b7');
      expect(
        (await f.ctx.container.customerControls.overview(tenantA, f.owner, other)).customer
          .phoneVerifiedAt,
      ).toBeNull();
    });
  });
});
