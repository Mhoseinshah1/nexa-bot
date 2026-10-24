import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_KEYS,
  money,
  templateDefinition,
  type Money,
  type TemplateKey,
} from '@nexa/contracts';
import { CATALOGUE_FA, DEFAULT_TEMPLATE_PRESENTATION, renderTemplateBody } from '@nexa/i18n';
import { i18nOpsLogWords as words } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import {
  adminChanged,
  linkChanged,
  operationFailure,
  provisionFailure,
  referralCommission,
  resellerChanged,
  serviceAlert,
  serviceChanged,
  serviceCreated,
  signupGift,
  ticket,
  trialCreated,
  userBlocked,
  userNew,
  massCredited,
  walletAdjusted,
  type Built,
} from '../../apps/api/src/modules/commerce/ops-log/application/presenters';
import type {
  AdminFact,
  CustomerFact,
  LedgerEntryFact,
  OperationFact,
  OrderFact,
  PaymentFact,
  ServiceFact,
} from '../../apps/api/src/modules/commerce/ops-log/application/ports';

/**
 * Round 4 PR-D — every message of Appendix L, rendered from SYNTHETIC facts.
 *
 * The facts below are invented: no name, id, amount or date is copied from the owner's
 * appendix samples. What is asserted is the shape the DECISIONS require.
 */

const AT = new Date('2026-10-12T09:30:00Z'); // 13:00 in Tehran
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const GIB = 1024n ** 3n;

const RENDERED: { readonly name: string; readonly text: string }[] = [];

function render(name: string, built: Built): string {
  const text = renderTemplateBody(
    templateDefinition(built.templateKey),
    CATALOGUE_FA[built.templateKey],
    built.values,
    'fa',
    DEFAULT_TEMPLATE_PRESENTATION,
  );
  RENDERED.push({ name, text });
  if (process.env['DUMP']) appendFileSync(process.env['DUMP'], `--- ${name}\n${text}\n`);
  return text;
}

const irt = (n: number): Money => money(BigInt(n), 'IRT');

function customer(overrides: Partial<CustomerFact> = {}): CustomerFact {
  return {
    id: 'cust-a',
    telegramUserId: '700100200',
    username: 'nima_t',
    firstName: 'نیما',
    lastName: 'تست',
    phone: null,
    source: 'NEXA',
    status: 'ACTIVE',
    blockedReason: null,
    ...overrides,
  };
}

function admin(overrides: Partial<AdminFact> = {}): AdminFact {
  return {
    id: 'adm-a',
    username: 'ops_lead',
    displayName: 'مدیر آزمایشی',
    telegramUserId: '700900100',
    roleNames: ['پشتیبان'],
    roleKeys: ['support'],
    permissionCount: 12,
    ...overrides,
  };
}

function order(overrides: Partial<OrderFact> = {}): OrderFact {
  return {
    id: 'ord-a',
    code: 'KQ7M2X9T',
    customerId: 'cust-a',
    purpose: 'NEW_SERVICE',
    origin: 'STANDARD',
    source: 'NEXA',
    state: 'FULFILLED',
    title: 'پلن آزمایشی ۵۰ گیگ',
    durationDays: 30,
    trafficBytes: 50n * GIB,
    panelId: 'pan-a',
    panelName: 'پنل آزمایشی ۱',
    locationLabel: 'آلمان',
    subtotal: irt(250_000),
    discount: irt(0),
    total: irt(250_000),
    settledAt: AT,
    isFirstPurchase: false,
    reseller: false,
    resellerListPrice: null,
    ...overrides,
  };
}

function payment(overrides: Partial<PaymentFact> = {}): PaymentFact {
  return {
    id: 'pay-a',
    code: 'RT4W8N2B',
    reference: 'ref-0001',
    method: 'WALLET',
    gatewayProvider: null,
    amount: irt(250_000),
    state: 'CONFIRMED',
    ...overrides,
  };
}

function service(overrides: Partial<ServiceFact> = {}): ServiceFact {
  return {
    id: 'svc-a',
    code: 'SV3H5J7K',
    customerId: 'cust-a',
    orderId: 'ord-a',
    panelId: 'pan-a',
    panelName: 'پنل آزمایشی ۱',
    providerUsername: 'nxtest01',
    isTrial: false,
    state: 'ACTIVE',
    expiresAt: new Date('2026-11-11T00:00:00Z'),
    trafficLimitBytes: 50n * GIB,
    trafficUsedBytes: 10n * GIB,
    lastSeenAt: new Date('2026-10-12T08:00:00Z'),
    source: 'NEXA',
    ...overrides,
  };
}

function entry(overrides: Partial<LedgerEntryFact> = {}): LedgerEntryFact {
  return {
    id: 'led-a',
    customerId: 'cust-a',
    direction: 'CREDIT',
    reason: 'ADMIN_CREDIT',
    amount: irt(100_000),
    reference: 'adm:1',
    orderId: null,
    paymentId: null,
    actorAdminId: 'adm-a',
    note: 'جبران نارضایتی',
    createdAt: AT,
    ...overrides,
  };
}

function operation(overrides: Partial<OperationFact> = {}): OperationFact {
  return {
    id: 'op-a',
    type: 'RENEW',
    state: 'SUCCEEDED',
    serviceId: 'svc-a',
    orderId: 'ord-a',
    requestedByCustomerId: 'cust-a',
    panelId: 'pan-a',
    failureKind: null,
    failureMessage: null,
    targetExpiresAt: new Date('2026-12-11T00:00:00Z'),
    targetTrafficLimitBytes: 50n * GIB,
    completedAt: AT,
    ...overrides,
  };
}

describe('L7 — an administrator raised or lowered a wallet', () => {
  it('shows the admin, the customer, the signed amount, balance before → after, the reason and a user button', () => {
    const credit = walletAdjusted({
      entry: entry(),
      balance: { before: irt(40_000), after: irt(140_000) },
      customer: customer(),
      admin: admin(),
      at: AT,
      words,
    });
    const text = render('L7 credit', credit);
    expect(text).toContain('@ops_lead');
    expect(text).toContain('700900100');
    expect(text).toContain('@nima_t');
    expect(text).toContain('700100200');
    expect(text).toContain('۴۰٬۰۰۰');
    expect(text).toContain('۱۴۰٬۰۰۰');
    expect(text).toContain('جبران نارضایتی');
    // R8 A4: «پروفایل کاربر» and «تراکنش», the time in Jalali, and no notice line unless known.
    expect(credit.buttons).toEqual([
      { kind: 'USER', ref: 'cust-a' },
      { kind: 'WALLET', ref: 'cust-a' },
    ]);
    expect(text).toContain('افزایش');
    expect(text).toContain('۱۴۰۵');
    expect(text).not.toContain('اطلاع به کاربر');

    const debit = walletAdjusted({
      entry: entry({ direction: 'DEBIT', reason: 'ADMIN_DEBIT', amount: irt(30_000) }),
      balance: { before: irt(140_000), after: irt(110_000) },
      customer: customer(),
      admin: admin(),
      at: AT,
      words,
    });
    const debitText = render('L7 debit', debit);
    expect(debitText).toContain('۱۴۰٬۰۰۰');
    expect(debitText).toContain('۱۱۰٬۰۰۰');
    expect(debitText).not.toEqual(text);
    expect(debitText).toContain('کاهش');
  });

  it('R8 A4: says whether the customer is told, both ways', () => {
    const told = render(
      'L7 told',
      walletAdjusted({
        entry: entry(),
        balance: { before: irt(0), after: irt(100_000) },
        customer: customer({ source: 'MIRZA' }),
        admin: admin(),
        at: AT,
        words,
        customerNotified: true,
      }),
    );
    expect(told).toContain('🔔 اطلاع به کاربر: بله');
    const silent = render(
      'L7 silent',
      walletAdjusted({
        entry: entry(),
        balance: { before: irt(0), after: irt(100_000) },
        customer: customer(),
        admin: admin(),
        at: AT,
        words,
        customerNotified: false,
      }),
    );
    expect(silent).toContain('🔔 اطلاع به کاربر: خیر');
  });

  it('R8 A4: a mass credit is one summary — amount each, credited, skipped, the ledger total', () => {
    const built = massCredited({
      fact: {
        id: 'bulk-a',
        amount: irt(20_000),
        note: 'هدیهٔ نوروزی',
        notify: true,
        createdByAdminId: 'adm-a',
        credited: 3,
        skipped: 1,
        total: irt(60_000),
      },
      admin: admin(),
      at: AT,
      words,
    });
    const text = render('L7 mass credit', built);
    expect(built.templateKey).toBe('ops.log.wallet_mass_credited');
    expect(built.logType).toBe('ADMIN_WALLET');
    expect(text).toContain('۲۰٬۰۰۰');
    expect(text).toContain('۶۰٬۰۰۰');
    expect(text).toContain('👥 شارژشده: ۳ کاربر');
    expect(text).toContain('⏭ ردشده: ۱ کاربر');
    expect(text).toContain('هدیهٔ نوروزی');
    expect(text).toContain('@ops_lead');
    expect(text).toContain('🔔 اطلاع به کاربران: بله');
    expect(built.buttons).toEqual([{ kind: 'BULK_OPERATION', ref: 'bulk-a' }]);
  });
});

describe('L8 — a referral commission', () => {
  it('names the referrer and the buyer, the service bought with its codes, and the referrer’s balance before → after', () => {
    const built = referralCommission({
      entry: entry({
        reason: 'REFERRAL_COMMISSION',
        customerId: 'cust-r',
        amount: irt(12_500),
        orderId: 'ord-a',
        paymentId: 'pay-a',
      }),
      balance: { before: irt(5_000), after: irt(17_500) },
      referrer: customer({
        id: 'cust-r',
        firstName: 'رضا',
        username: 'reza_r',
        telegramUserId: '700300400',
      }),
      buyer: customer({ phone: '+989120000000' }),
      order: order(),
      payment: payment(),
      at: AT,
      words,
    });
    const text = render('L8', built);
    expect(text).toContain('@reza_r');
    expect(text).toContain('700300400');
    expect(text).toContain('@nima_t');
    expect(text).toContain('989120000000');
    expect(text).toContain('KQ7M2X9T');
    expect(text).toContain('RT4W8N2B');
    expect(text).toContain('پلن آزمایشی ۵۰ گیگ');
    expect(text).toContain('۵٬۰۰۰');
    expect(text).toContain('۱۷٬۵۰۰');
    expect(built.buttons[0]).toEqual({ kind: 'USER', ref: 'cust-r' });
  });
});

describe('L9 — the signup gift', () => {
  it('shows the REAL balance for both sides, never the same figure before and after', () => {
    const built = signupGift({
      referee: { customer: customer(), balance: { before: irt(0), after: irt(20_000) } },
      referrer: {
        customer: customer({
          id: 'cust-r',
          firstName: 'رضا',
          username: 'reza_r',
          telegramUserId: '700300400',
        }),
        balance: { before: irt(7_000), after: irt(27_000) },
      },
      at: AT,
      words,
    });
    const text = render('L9', built);
    expect(text).toContain('۲۰٬۰۰۰');
    expect(text).toContain('۷٬۰۰۰');
    expect(text).toContain('۲۷٬۰۰۰');
    expect(built.values['refereeBefore']).not.toEqual(built.values['refereeAfter']);
    expect(built.values['referrerBefore']).not.toEqual(built.values['referrerAfter']);
    expect(built.buttons).toHaveLength(2);
  });

  it('omits the balance of a side that has not received its gift, instead of printing a guess', () => {
    const built = signupGift({
      referee: { customer: customer(), balance: { before: irt(0), after: irt(20_000) } },
      referrer: { customer: customer({ id: 'cust-r' }), balance: null },
      at: AT,
      words,
    });
    expect(built.values).not.toHaveProperty('referrerBefore');
    expect(built.values).not.toHaveProperty('referrerAfter');
    render('L9 one side', built);
  });
});

describe('L10 / L11 — a service was created', () => {
  const base = {
    order: order({
      isFirstPurchase: true,
      reseller: true,
      subtotal: irt(300_000),
      total: irt(250_000),
    }),
    service: service(),
    customer: customer({ phone: '+989120000001' }),
    at: AT,
    words,
  };

  it('L10 carries both codes, both badges, the volume and days, panel, location, username and buttons', () => {
    const built = serviceCreated({
      ...base,
      payment: payment({ method: 'MANUAL_TRANSFER' }),
      walletBalance: null,
    });
    expect(built.logType).toBe('SERVICE_CREATED');
    const text = render('L10', built);
    expect(text).toContain('اولین خرید');
    expect(text).toContain('نماینده');
    expect(text).toContain('KQ7M2X9T');
    expect(text).toContain('RT4W8N2B');
    expect(text).toContain('۵۰ گیگابایت');
    expect(text).toContain('۳۰');
    expect(text).toContain('پنل آزمایشی ۱');
    expect(text).toContain('آلمان');
    expect(text).toContain('nxtest01');
    expect(text).toContain('989120000001');
    expect(text).not.toMatch(/MANUAL_TRANSFER/);
    expect(built.buttons.map((button) => button.kind)).toEqual(['USER', 'SERVICE']);
  });

  it('omits the phone line when nobody verified a phone, and the badges when none apply', () => {
    const built = serviceCreated({
      ...base,
      order: order(),
      customer: customer({ phone: null }),
      payment: payment({ method: 'MANUAL_TRANSFER' }),
      walletBalance: null,
    });
    const text = render('L10 plain', built);
    expect(text).not.toContain('اولین خرید');
    // The title survives an absent badge: a line of only absent tokens is dropped whole.
    expect(text.split('\n')[0]).toBe('🛒 خرید جدید');
    expect(text).not.toMatch(/📱/u);
    expect(built.values).not.toHaveProperty('phone');
  });

  it('L11 (a wallet purchase) prints the wallet before → after of THIS purchase', () => {
    const built = serviceCreated({
      ...base,
      payment: payment({ method: 'WALLET' }),
      walletBalance: { before: irt(600_000), after: irt(350_000) },
    });
    expect(built.logType).toBe('SERVICE_CREATED_WALLET');
    expect(built.templateKey).toBe('ops.log.service_created_wallet');
    const text = render('L11', built);
    expect(text).toContain('۶۰۰٬۰۰۰');
    expect(text).toContain('۳۵۰٬۰۰۰');
  });

  it('does not claim a wallet type when the balance could not be derived', () => {
    const built = serviceCreated({
      ...base,
      payment: payment({ method: 'WALLET' }),
      walletBalance: null,
    });
    expect(built.logType).toBe('SERVICE_CREATED');
    expect(built.values).not.toHaveProperty('balanceBefore');
  });
});

describe('L12 / L13 / L14 — renew, extra traffic, extra time', () => {
  const common = {
    order: order({ purpose: 'RENEW' }),
    service: service(),
    customer: customer(),
    payment: payment(),
    walletBalance: { before: irt(500_000), after: irt(250_000) },
    at: AT,
    words,
  };

  it('L12 shows the expiry before and after as DIFFERENT dates, the used volume and the wallet', () => {
    const built = serviceChanged({
      ...common,
      kind: 'RENEW',
      operation: operation(),
      before: {
        expiresAt: new Date('2026-11-11T00:00:00Z'),
        trafficLimitBytes: 50n * GIB,
        trafficUsedBytes: 42n * GIB,
      },
    });
    const text = render('L12', built);
    expect(built.values['expiresBefore']).not.toEqual(built.values['expiresAfter']);
    expect(String(text)).toContain('۴۲');
    expect(text).toContain('۵۰۰٬۰۰۰');
    expect(text).toContain('۲۵۰٬۰۰۰');
    const dates = [...text.matchAll(/[۰-۹]{4}\/[۰-۹]{2}\/[۰-۹]{2}/gu)].map((match) => match[0]);
    expect(new Set(dates).size).toBeGreaterThanOrEqual(2);
  });

  it('never invents a "before": with no audit row the expiry lines are left out, not printed twice', () => {
    const built = serviceChanged({
      ...common,
      kind: 'RENEW',
      operation: operation(),
      before: null,
    });
    expect(built.values).not.toHaveProperty('expiresBefore');
    expect(built.values).not.toHaveProperty('expiresAfter');
    render('L12 no before', built);
  });

  it('L13 shows the volume added and the limit before → after', () => {
    const built = serviceChanged({
      ...common,
      kind: 'ADD_TRAFFIC',
      order: order({ purpose: 'ADD_TRAFFIC', trafficBytes: 10n * GIB }),
      operation: operation({ type: 'ADD_TRAFFIC', targetTrafficLimitBytes: 60n * GIB }),
      before: { expiresAt: null, trafficLimitBytes: 50n * GIB, trafficUsedBytes: 5n * GIB },
    });
    const text = render('L13', built);
    expect(text).toContain('۱۰ گیگابایت');
    expect(text).toContain('۵۰ گیگابایت');
    expect(text).toContain('۶۰ گیگابایت');
    expect(built.logType).toBe('TRAFFIC_ADDED');
  });

  it('L14 shows the days added and the expiry before → after', () => {
    const built = serviceChanged({
      ...common,
      kind: 'ADD_TIME',
      order: order({ purpose: 'ADD_TIME', durationDays: 15 }),
      operation: operation({ type: 'ADD_TIME', targetExpiresAt: new Date('2026-11-26T00:00:00Z') }),
      before: {
        expiresAt: new Date('2026-11-11T00:00:00Z'),
        trafficLimitBytes: null,
        trafficUsedBytes: null,
      },
    });
    const text = render('L14', built);
    expect(built.logType).toBe('TIME_ADDED');
    expect(built.values['expiresBefore']).not.toEqual(built.values['expiresAfter']);
    expect(text).toContain('۱۵');
  });
});

describe('L15 / L16 — a link change, a trial', () => {
  it('L15 names who changed the link, the service, the panel and how many times in 30 days', () => {
    const built = linkChanged({
      service: service(),
      customer: customer(),
      by: 'CUSTOMER',
      rotations: 0,
      at: AT,
      words,
    });
    const text = render('L15', built);
    expect(text).toContain('nxtest01');
    expect(text).toContain('پنل آزمایشی ۱');
    expect(built.values['rotations']).toBe(1);
    expect(built.buttons.map((button) => button.kind)).toEqual(['USER', 'SERVICE']);
  });

  it('L16 names the product volume, duration and panel of the trial', () => {
    const built = trialCreated({
      service: service({ isTrial: true }),
      order: order({ purpose: 'TRIAL', trafficBytes: 1n * GIB, durationDays: 1, total: irt(0) }),
      customer: customer(),
      at: AT,
      words,
    });
    const text = render('L16', built);
    expect(text).toContain('۱ گیگابایت');
    expect(text).toContain('پنل آزمایشی ۱');
    expect(text).toContain('nxtest01');
  });
});

describe('L17 / L18 / L20 — customers', () => {
  it('L17 carries the referrer when there is one and a user button', () => {
    const withReferrer = userNew({
      customer: customer({ phone: '+989120000002' }),
      referrer: customer({
        id: 'cust-r',
        firstName: 'رضا',
        username: 'reza_r',
        telegramUserId: '700300400',
      }),
      at: AT,
      words,
    });
    const text = render('L17 referrer', withReferrer);
    expect(text).toContain('@reza_r');
    expect(text).toContain('989120000002');
    expect(withReferrer.logType).toBe('USER_NEW');
    const plain = render(
      'L17 plain',
      userNew({ customer: customer(), referrer: null, at: AT, words }),
    );
    expect(plain).not.toContain('@reza_r');
  });

  it('L18 says block or unblock, who, why, and whether it was manual or automatic', () => {
    const manual = render(
      'L18 manual',
      userBlocked({
        customer: customer(),
        customerId: 'cust-a',
        blocked: true,
        automatic: false,
        admin: admin(),
        reason: 'سوءاستفاده از سرویس',
        at: AT,
        words,
      }),
    );
    expect(manual).toContain('@ops_lead');
    expect(manual).toContain('سوءاستفاده از سرویس');
    const auto = render(
      'L18 auto',
      userBlocked({
        customer: customer(),
        customerId: 'cust-a',
        blocked: true,
        automatic: true,
        admin: null,
        reason: null,
        at: AT,
        words,
      }),
    );
    expect(auto).not.toEqual(manual);
    const unblocked = render(
      'L18 unblock',
      userBlocked({
        customer: customer(),
        customerId: 'cust-a',
        blocked: false,
        automatic: false,
        admin: admin(),
        reason: null,
        at: AT,
        words,
      }),
    );
    expect(unblocked).not.toEqual(manual);
  });

  it('L20 treats a suspended reseller as an ordinary customer', () => {
    const built = resellerChanged({
      customer: customer(),
      customerId: 'cust-a',
      change: 'SUSPENDED',
      fromTier: 'طلایی',
      toTier: 'طلایی',
      suspended: true,
      admin: admin(),
      at: AT,
      words,
    });
    const text = render('L20', built);
    expect(built.values['tierAfter']).toBe(words.resellerOrdinary);
    expect(text).toContain('طلایی');
  });
});

describe('L19 — administrators', () => {
  it('shows old role → new role, the permission count, actor and target', () => {
    const built = adminChanged({
      kind: 'rolesChanged',
      target: admin({ roleNames: ['مدیر مالی'], permissionCount: 30 }),
      rolesBefore: ['پشتیبان'],
      actor: admin({ username: 'owner_x' }),
      at: AT,
      words,
    });
    const text = render('L19', built);
    expect(text).toContain('پشتیبان');
    expect(text).toContain('مدیر مالی');
    expect(text).toContain('۳۰');
    expect(text).toContain('@owner_x');
    expect(built.logType).toBe('ADMIN_CHANGED');
  });
});

describe('L21 — one message per service, never NaN', () => {
  it('shows «۰ بایت» for an empty or exhausted allowance, and never NaN', () => {
    for (const [limit, used] of [
      [0n, 0n],
      [10n * GIB, 10n * GIB],
      [10n * GIB, 12n * GIB],
    ] as const) {
      const built = serviceAlert({
        kind: 'USAGE_FINAL',
        service: service({ trafficLimitBytes: limit, trafficUsedBytes: used }),
        customer: customer(),
        remainingDays: null,
        at: AT,
        words,
      });
      const text = render(`L21 ${String(limit)}/${String(used)}`, built);
      expect(text).toContain('۰ بایت');
      expect(text.split('\n')[0]).toBe('⛔ پایان حجم');
      expect(text).not.toMatch(/NaN|undefined|null/);
    }
  });

  it('keeps the customer, the service username, the status, the remaining volume and the panel', () => {
    const built = serviceAlert({
      kind: 'USAGE_FIRST',
      service: service(),
      customer: customer(),
      remainingDays: 3,
      at: AT,
      words,
    });
    const text = render('L21', built);
    expect(text).toContain('nxtest01');
    expect(text).toContain('@nima_t');
    expect(text).toContain('۴۰ گیگابایت');
    expect(text).toContain('پنل آزمایشی ۱');
  });
});

describe('L23 / L24 — each error is its own message with customer, cause, technical line and impact', () => {
  it('L23 (a service could not be built) says what happened to the customer’s money', () => {
    const refunded = provisionFailure({
      order: order(),
      customer: customer(),
      operation: operation({
        type: 'CREATE_USER',
        state: 'FAILED',
        failureKind: 'REJECTED',
        failureMessage: 'HTTP 422 invalid',
      }),
      reason: 'PANEL_REJECTED',
      payment: payment({ method: 'MANUAL_TRANSFER' }),
      refunded: money(250_000n, 'IRT'),
      unknown: false,
      at: AT,
      words,
    });
    const text = render('L23 refunded', refunded);
    expect(text).toContain('@nima_t');
    expect(text).toContain('HTTP 422');
    expect(text).toContain('۲۵۰٬۰۰۰ تومان');
    expect(text).toContain('برای مشتری');
    const pending = render(
      'L23 unknown',
      provisionFailure({
        order: order(),
        customer: customer(),
        operation: null,
        reason: null,
        payment: null,
        refunded: null,
        unknown: true,
        at: AT,
        words,
      }),
    );
    expect(pending).not.toEqual(text);
  });

  it('L23/L24 name the amount the LEDGER credited back, and say nothing was refunded when none was', () => {
    // A partial refund: the order cost 250 000, the ledger gave back 100 000.
    const partial = render(
      'L23 partial',
      provisionFailure({
        order: order(),
        customer: customer(),
        operation: null,
        reason: 'PANEL_REJECTED',
        payment: payment(),
        refunded: money(100_000n, 'IRT'),
        unknown: false,
        at: AT,
        words,
      }),
    );
    expect(partial).toContain(`${words.impact('refundedToWallet')} (۱۰۰٬۰۰۰ تومان)`);
    const none = operationFailure({
      order: order({ purpose: 'RENEW' }),
      service: service(),
      customer: customer(),
      operation: null,
      reason: 'PANEL_REJECTED',
      payment: payment(),
      refunded: null,
      unknown: false,
      at: AT,
      words,
    });
    expect(String(none.values['impact'])).toBe(words.impact('notRefunded'));
  });

  it('L24 (an operation on an existing service) keeps the raw reason line and the retry hint of an UNKNOWN outcome', () => {
    const built = operationFailure({
      order: order({ purpose: 'RENEW' }),
      service: service(),
      customer: customer(),
      operation: operation({ state: 'UNKNOWN', failureKind: 'TIMEOUT', failureMessage: null }),
      reason: null,
      payment: payment(),
      refunded: null,
      unknown: true,
      at: AT,
      words,
    });
    const text = render('L24 unknown', built);
    expect(text).toContain('TIMEOUT');
    expect(text).toContain('nxtest01');
    expect(built.values).toHaveProperty('retry');
    expect(built.logType).toBe('ERROR_OPERATION');
  });
});

describe('L26 — a ticket', () => {
  it('shows the first two lines of the customer’s message, and no more', () => {
    const built = ticket({
      ticket: {
        id: 'tk-a',
        number: '1042',
        code: 'TK4M8R2P',
        customerId: 'cust-a',
        categoryTitle: 'مشکل اتصال',
        snippetSource: 'سلام\nسرویس وصل نمی‌شود\nخط سوم نباید بیاید',
      },
      customer: customer(),
      reply: false,
      at: AT,
      words,
    });
    const text = render('L26', built);
    expect(text).toContain('سلام');
    expect(text).toContain('سرویس وصل نمی‌شود');
    expect(text).not.toContain('خط سوم');
    expect(text).toContain('۱۰۴۲');
  });
});

describe('every rendered message', () => {
  it('has no UUID line, no NaN, no raw enum, no unresolved placeholder and no Mirza', () => {
    expect(RENDERED.length).toBeGreaterThan(20);
    for (const { name, text } of RENDERED) {
      expect(text.split('\n')[0]?.trim(), `${name}: a title`).not.toBe('');
      expect(text, name).not.toMatch(UUID);
      expect(text, name).not.toMatch(/NaN|undefined|\[object/);
      expect(text, name).not.toMatch(/\{[A-Za-z_]+\}/);
      expect(text, name).not.toMatch(/میرزا|mirza/iu);
      expect(text, name).not.toMatch(/MANUAL_TRANSFER|TELEGRAM_STARS|NOWPAYMENTS|\(WALLET\)/);
    }
  });

  it('only uses template keys that exist', () => {
    for (const key of ['ops.log.wallet_adjusted', 'ops.log.signup_gift']) {
      expect(TEMPLATE_KEYS.includes(key as TemplateKey), key).toBe(true);
    }
  });
});
