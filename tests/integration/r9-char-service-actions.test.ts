import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  isNexaError,
  money,
  type ActorContext,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import { SEED_IDS, tenantA, validatePanelConnection } from './harness';
import { makePin, makeRig, systemActor, viewOf, type View } from './r9-char-support';

/**
 * Characterization of the service-actions flow group of `bot-runtime.ts` (Round 9,
 * Phase B): what a customer is shown to renew a service, to buy extra traffic, extra time
 * or extra users for it, to see the quote and to confirm it, and what a service that is not
 * theirs is answered. The existing suites (`extra-packages-web-to-bot`, `extra-devices`,
 * `r3-service-card`) drive these paths and assert keys, rows and money; this file pins the
 * rendered text and the buttons in order.
 *
 * Not covered here: the location change (needs the scripted location adapter of
 * `location-change.test.ts`, which pins its own screens) and the rotate-link action, whose
 * rendered replies `customer-rotate-link.test.ts` already pins.
 *
 * Pinned as it answers today: intent, template key, rendered text, buttons in order.
 */

const CUSTOMER = '951301';
const OTHER = '951302';
const GIB = 1024n ** 3n;

const pin = makePin(expectedViews(), (actual, expected, label) =>
  expect(actual, label).toEqual(expected),
);

/** The order code, the service username and the deadline are per-run values. */
const stable = (view: View, username: string): View => ({
  ...view,
  text: view.text
    .replaceAll(username, '<username>')
    .replace(/کد سفارش: [A-Z0-9]{8}/g, 'کد سفارش: <code>')
    .replace(/\d{4}\/\d{2}\/\d{2}( \d{2}:\d{2})?/g, '<date>'),
});

describe('the service-actions flow of the Telegram bot, as it answers today', () => {
  const rig = makeRig();
  let panel: FakeMarzban | undefined;
  let panelId: string;
  let customer: UserId;
  let owner: ActorContext;
  let service: { id: string; username: string };

  beforeAll(async () => {
    await rig.start();
  }, 120_000);
  afterAll(async () => {
    await rig.stop();
  });
  afterEach(async () => {
    await panel?.close();
  });
  beforeEach(async () => {
    await rig.reset();
    const container = rig.ctx().container;
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = await rig.owner();
    const created = await container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'r9-panel-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(container, tenantA, panelId);
    customer = await rig.resolveCustomer(CUSTOMER);
    await rig.resolveCustomer(OTHER, 'رضا');
    service = await activeService();
    rig.sent.length = 0;
  });

  async function activeService(): Promise<{ id: string; username: string }> {
    const container = rig.ctx().container;
    const products = new DrizzleProductRepository(container.database.db);
    const created = await products.create(tenantA, {
      id: container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ماهانه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 50n * GIB, deviceLimit: null },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', container.clock.now());
    const draft = await container.orders.createDraft(tenantA, systemActor('r9-svc'), {
      idempotencyKey: 'r9-svc-draft',
      customerId: customer,
      productId: created.id,
    });
    const confirmed = await container.orders.confirm(tenantA, systemActor('r9-svc'), {
      idempotencyKey: 'r9-svc-confirm',
      customerId: customer,
      orderId: draft.id,
    });
    await container.wallet.adjust(tenantA, owner, customer, {
      idempotencyKey: 'r9-svc-credit',
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await container.payments.settleFromWallet(tenantA, systemActor('r9-svc'), customer, {
      idempotencyKey: 'r9-svc-pay',
      orderId: confirmed.id,
    });
    await container.provisionerLoop.tick();
    const found = await new DrizzleServiceRepository(container.database.db).findByOrderId(
      tenantA,
      confirmed.id,
    );
    if (found === undefined || found === null) throw new Error('no service');
    expect(found.state, 'the fixture must start ACTIVE').toBe('ACTIVE');
    // As `extra-devices.test.ts` fixtures its service: a per-user limit the offer can raise.
    await container.database.db.execute(
      sql`UPDATE services SET device_limit = 2 WHERE id = ${found.id}`,
    );
    return { id: found.id, username: found.providerUsername };
  }

  /** An ACTIVE extra-package offer of the given kind. */
  async function offer(
    key: string,
    kind: 'ADD_TRAFFIC' | 'ADD_TIME' | 'ADD_DEVICES',
  ): Promise<string> {
    const container = rig.ctx().container;
    const created = await container.serviceAddons.create(tenantA, owner, {
      idempotencyKey: `r9-${key}-create`,
      draft: {
        kind,
        title:
          kind === 'ADD_TRAFFIC' ? '۱۰ گیگابایت' : kind === 'ADD_TIME' ? '۳۰ روز' : 'کاربر اضافه',
        sortOrder: 10,
        specification: {
          kind,
          trafficBytes: kind === 'ADD_TRAFFIC' ? 10n * GIB : null,
          durationDays: kind === 'ADD_TIME' ? 30 : null,
          ...(kind === 'ADD_DEVICES' ? { maxQuantity: 3 } : {}),
        } as never,
        price: money(kind === 'ADD_DEVICES' ? 50_000n : 80_000n, 'IRT'),
        panelId: null,
        productId: null,
      },
    });
    await container.serviceAddons.activate(tenantA, owner, {
      idempotencyKey: `r9-${key}-on`,
      addonId: created.id,
    });
    return created.id;
  }

  /**
   * One turn as a view. A turn that REJECTS - `refusal` rethrows an error code that has no
   * sentence, and the webhook layer answers it - is pinned as a pseudo-view carrying the
   * error code, so that a split cannot start answering (or throwing) differently.
   */
  const turn = async (update: ReturnType<typeof rig.tap>): Promise<View> => {
    rig.sent.length = 0;
    try {
      const result = await rig.handle(update);
      return stable(viewOf(result, rig.lastDrawn()?.body), service.username);
    } catch (error) {
      if (!isNexaError(error)) throw error;
      return { intent: 'THROWN', key: null, text: `${error.kind} ${error.code}`, buttons: [] };
    }
  };
  const rawButtons = (): string[] => {
    const markup = rig.lastDrawn()?.body['reply_markup'] as
      { inline_keyboard?: { callback_data?: string }[][] } | undefined;
    return (markup?.inline_keyboard ?? []).flat().map((button) => button.callback_data ?? '');
  };
  const buttonWith = (prefix: string): string => {
    const found = rawButtons().find((data) => data.startsWith(prefix));
    if (found === undefined) throw new Error(`no ${prefix} button in ${rawButtons().join(' ')}`);
    return found;
  };

  it('answers the renew menu: a renewal of the same plan and, when offered, time packages', async () => {
    pin('renew.menu_plan_only', await turn(rig.tap(`n:${service.id}`, CUSTOMER)));
    await offer('time', 'ADD_TIME');
    pin('renew.menu_with_time_package', await turn(rig.tap(`n:${service.id}`, CUSTOMER)));
  });

  it('walks an extra-traffic purchase: choice, quote, confirm', async () => {
    await offer('traffic', 'ADD_TRAFFIC');
    pin('traffic.choice', await turn(rig.tap(`v:${service.id}`, CUSTOMER)));
    const quote = await turn(rig.tap(buttonWith('a:'), CUSTOMER));
    pin('traffic.quote', quote);
    const orderId = buttonWith('pm:').slice('pm:'.length);
    pin('traffic.confirm', await turn(rig.tap(`q:${orderId}`, CUSTOMER)));
  });

  it('walks an extra-time purchase: choice and quote', async () => {
    await offer('time', 'ADD_TIME');
    pin('time.choice', await turn(rig.tap(`h:${service.id}`, CUSTOMER)));
    pin('time.quote', await turn(rig.tap(buttonWith('b:'), CUSTOMER)));
  });

  it('answers an extra-users offer on a provider that cannot raise a per-user limit', async () => {
    await offer('devices', 'ADD_DEVICES');
    // Marzban cannot set a per-user limit: the offer exists, the capability does not.
    pin('devices.choice_unsupported', await turn(rig.tap(`dv:${service.id}`, CUSTOMER)));
  });

  it('says nothing is offered when the operator configured no package', async () => {
    pin('traffic.none_configured', await turn(rig.tap(`v:${service.id}`, CUSTOMER)));
    pin('time.none_configured', await turn(rig.tap(`h:${service.id}`, CUSTOMER)));
    pin('devices.none_configured', await turn(rig.tap(`dv:${service.id}`, CUSTOMER)));
  });

  it("answers a service that is not the customer's exactly as one that does not exist, whichever action asks", async () => {
    await offer('traffic', 'ADD_TRAFFIC');
    const unknown = rig.ctx().container.ids.uuid();
    pin('foreign.renew', await turn(rig.tap(`n:${service.id}`, OTHER)));
    pin('foreign.traffic', await turn(rig.tap(`v:${service.id}`, OTHER)));
    pin('foreign.time', await turn(rig.tap(`h:${service.id}`, OTHER)));
    pin('foreign.devices', await turn(rig.tap(`dv:${service.id}`, OTHER)));
    pin('unknown.renew', await turn(rig.tap(`n:${unknown}`, CUSTOMER)));
    pin('unknown.traffic', await turn(rig.tap(`v:${unknown}`, CUSTOMER)));
    pin('unknown.time', await turn(rig.tap(`h:${unknown}`, CUSTOMER)));
    pin('unknown.devices', await turn(rig.tap(`dv:${unknown}`, CUSTOMER)));
    pin('unknown.rotate_ask', await turn(rig.tap(`rc:${unknown}`, CUSTOMER)));
  });
});

function expectedViews(): Record<string, View> {
  return {
    'renew.menu_plan_only': {
      intent: 'SERVICE_RENEW',
      key: 'bot.service.renew_choose',
      text: '💊 یکی از گزینه\u200cهای تمدید یا افزایش زمان را انتخاب کنید:',
      buttons: [
        [['🔄 تمدید پلن ماهانه — 250,000 تومان', 'nr:<id>']],
        [['🔙 بازگشت به مشخصات سرویس', 'sv:<id>']],
      ],
    },
    'renew.menu_with_time_package': {
      intent: 'SERVICE_RENEW',
      key: 'bot.service.renew_choose',
      text: '💊 یکی از گزینه\u200cهای تمدید یا افزایش زمان را انتخاب کنید:',
      buttons: [
        [['🔄 تمدید پلن ماهانه — 250,000 تومان', 'nr:<id>']],
        [['۳۰ روز — 80,000 تومان', 'b:<pair>']],
        [['🔙 بازگشت به مشخصات سرویس', 'sv:<id>']],
      ],
    },
    'traffic.choice': {
      intent: 'SERVICE_ADD_TRAFFIC',
      key: 'bot.service.addon_choice',
      text: 'یکی از بسته\u200cهای زیر را انتخاب کنید:',
      buttons: [
        [['۱۰ گیگابایت — 80,000 تومان', 'a:<pair>']],
        [['🔙 بازگشت به مشخصات سرویس', 'sv:<id>']],
      ],
    },
    'traffic.quote': {
      intent: 'SERVICE_BUY_TRAFFIC',
      key: 'bot.order.preinvoice',
      text: '🧾 پیش\u200cفاکتور\n🔖 کد سفارش: <code>\n\n📦 سرویس: ۱۰ گیگابایت\n👤 نام کاربری: <username>\n➕ حجم افزوده: 10 گیگابایت\n💵 مبلغ سفارش: 80,000 تومان\n\n💰 موجودی کیف پول: 750,000 تومان\n\n🛒 سفارش شما آماده پرداخت است؛ روش پرداخت را با دکمه\u200cهای زیر انتخاب کنید. اگر روشی کارمزد داشته باشد، کارمزد و مبلغ قابل پرداخت در فاکتور همان روش جداگانه نمایش داده می\u200cشود.',
      buttons: [
        [['💰 پرداخت از کیف پول', 'w:<id>']],
        [['🧾 ثبت پرداخت', 'pm:<id>']],
        [['🏠 بازگشت به منوی اصلی', 'mm:']],
      ],
    },
    'traffic.confirm': {
      intent: 'SERVICE_ACTION_CONFIRM',
      key: 'bot.order.awaiting_payment',
      text: 'سفارش ثبت شد و در انتظار پرداخت است.\nمبلغ: 80,000 تومان\nاعتبار تا: <date>',
      buttons: [
        [['💰 پرداخت از کیف پول', 'w:<id>']],
        [['🧾 ثبت پرداخت', 'pm:<id>']],
        [['لغو سفارش', 'd:<id>']],
      ],
    },
    'time.choice': {
      intent: 'SERVICE_ADD_TIME',
      key: 'bot.service.addon_choice',
      text: 'یکی از بسته\u200cهای زیر را انتخاب کنید:',
      buttons: [
        [['۳۰ روز — 80,000 تومان', 'b:<pair>']],
        [['🔙 بازگشت به مشخصات سرویس', 'sv:<id>']],
      ],
    },
    'time.quote': {
      intent: 'SERVICE_BUY_TIME',
      key: 'bot.order.preinvoice',
      text: '🧾 پیش\u200cفاکتور\n🔖 کد سفارش: <code>\n\n📦 سرویس: ۳۰ روز\n👤 نام کاربری: <username>\n📅 مدت: 30 روز\n💵 مبلغ سفارش: 80,000 تومان\n\n💰 موجودی کیف پول: 750,000 تومان\n\n🛒 سفارش شما آماده پرداخت است؛ روش پرداخت را با دکمه\u200cهای زیر انتخاب کنید. اگر روشی کارمزد داشته باشد، کارمزد و مبلغ قابل پرداخت در فاکتور همان روش جداگانه نمایش داده می\u200cشود.',
      buttons: [
        [['💰 پرداخت از کیف پول', 'w:<id>']],
        [['🧾 ثبت پرداخت', 'pm:<id>']],
        [['🏠 بازگشت به منوی اصلی', 'mm:']],
      ],
    },
    'devices.choice_unsupported': {
      intent: 'SERVICE_ADD_DEVICES',
      key: 'bot.service.capability_unsupported',
      text: 'این قابلیت برای سرویس شما در دسترس نیست.',
      buttons: [[['🔙 بازگشت به مشخصات سرویس', 'sv:<id>']]],
    },
    'traffic.none_configured': {
      intent: 'SERVICE_ADD_TRAFFIC',
      key: 'bot.service.action_unavailable',
      text: '⚠️ این امکان در حال حاضر برای این سرویس در دسترس نیست.',
      buttons: [[['🔙 بازگشت به مشخصات سرویس', 'sv:<id>']]],
    },
    'time.none_configured': {
      intent: 'SERVICE_ADD_TIME',
      key: 'bot.service.action_unavailable',
      text: '⚠️ این امکان در حال حاضر برای این سرویس در دسترس نیست.',
      buttons: [[['🔙 بازگشت به مشخصات سرویس', 'sv:<id>']]],
    },
    'devices.none_configured': {
      intent: 'SERVICE_ADD_DEVICES',
      key: 'bot.service.capability_unsupported',
      text: 'این قابلیت برای سرویس شما در دسترس نیست.',
      buttons: [[['🔙 بازگشت به مشخصات سرویس', 'sv:<id>']]],
    },
    'foreign.renew': {
      intent: 'SERVICE_RENEW',
      key: 'bot.service.not_found',
      text: 'این سرویس در دسترس شما نیست.',
      buttons: [[['🏠 بازگشت به لیست سرویس ها', 'sl:1']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'foreign.traffic': {
      intent: 'SERVICE_ADD_TRAFFIC',
      key: 'bot.service.not_found',
      text: 'این سرویس در دسترس شما نیست.',
      buttons: [[['🏠 بازگشت به لیست سرویس ها', 'sl:1']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'foreign.time': {
      intent: 'SERVICE_ADD_TIME',
      key: 'bot.service.not_found',
      text: 'این سرویس در دسترس شما نیست.',
      buttons: [[['🏠 بازگشت به لیست سرویس ها', 'sl:1']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'foreign.devices': {
      intent: 'SERVICE_ADD_DEVICES',
      key: 'bot.service.not_found',
      text: 'این سرویس در دسترس شما نیست.',
      buttons: [[['🏠 بازگشت به لیست سرویس ها', 'sl:1']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'unknown.renew': {
      intent: 'SERVICE_RENEW',
      key: 'bot.service.not_found',
      text: 'این سرویس در دسترس شما نیست.',
      buttons: [[['🏠 بازگشت به لیست سرویس ها', 'sl:1']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'unknown.traffic': {
      intent: 'SERVICE_ADD_TRAFFIC',
      key: 'bot.service.not_found',
      text: 'این سرویس در دسترس شما نیست.',
      buttons: [[['🏠 بازگشت به لیست سرویس ها', 'sl:1']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'unknown.time': {
      intent: 'SERVICE_ADD_TIME',
      key: 'bot.service.not_found',
      text: 'این سرویس در دسترس شما نیست.',
      buttons: [[['🏠 بازگشت به لیست سرویس ها', 'sl:1']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'unknown.devices': {
      intent: 'SERVICE_ADD_DEVICES',
      key: 'bot.service.not_found',
      text: 'این سرویس در دسترس شما نیست.',
      buttons: [[['🏠 بازگشت به لیست سرویس ها', 'sl:1']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'unknown.rotate_ask': {
      intent: 'SERVICE_ROTATE_ASK',
      key: 'bot.service.not_found',
      text: 'این سرویس در دسترس شما نیست.',
      buttons: [[['🏠 بازگشت به لیست سرویس ها', 'sl:1']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
  };
}
