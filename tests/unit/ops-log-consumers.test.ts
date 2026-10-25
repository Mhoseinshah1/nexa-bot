import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_REFUND_REASON,
  money,
  templateDefinition,
  type Clock,
  type CurrencyCode,
  type DomainEvent,
  type TemplateKey,
  type TimePeriodResolver,
} from '@nexa/contracts';
import { CATALOGUE_FA, DEFAULT_TEMPLATE_PRESENTATION, renderTemplateBody } from '@nexa/i18n';
import { i18nOpsLogWords as words } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import { ServiceLogConsumer } from '../../apps/api/src/modules/commerce/ops-log/application/service-log.consumer';
import { OperationOutcomeAnnouncer } from '../../apps/api/src/modules/commerce/messaging/application/operation-outcome-announcer';
import { ticket } from '../../apps/api/src/modules/commerce/ops-log/application/presenters';
import { OperationLog } from '../../apps/api/src/modules/commerce/ops-log/application/operation-log';
import { FailureLogConsumer } from '../../apps/api/src/modules/commerce/ops-log/application/failure-log.consumer';
import { AdminLogConsumer } from '../../apps/api/src/modules/commerce/ops-log/application/admin-log.consumer';
import { ServiceAlertLog } from '../../apps/api/src/modules/commerce/ops-log/application/service-alert-log';
import {
  NightlyReportService,
  NIGHTLY_REPORT_CATCH_UP_MS,
} from '../../apps/api/src/modules/commerce/ops-log/application/nightly-report.service';
import {
  grossOf,
  netOf,
  nightlyReports,
  type NightlyReportData,
} from '../../apps/api/src/modules/commerce/ops-log/application/nightly-report';
import { IntlTimePeriodResolver } from '../../apps/api/src/infrastructure/time/report-calendar';
import type {
  AdminFact,
  BalanceAround,
  CustomerFact,
  LedgerEntryFact,
  OperationFact,
  OpsLogFacts,
  OpsLogLane,
  OrderFact,
  OrderOriginFact,
  PaymentFact,
  ServiceBeforeImage,
  ServiceFact,
} from '../../apps/api/src/modules/commerce/ops-log/application/ports';

/**
 * Round 4 PR-D — the consumers and hooks that feed the group, over an in-memory ledger and
 * synthetic facts: which message each fact becomes, the wallet before and after of a purchase,
 * the renewal's expiry before and after, that an imported row is silent, and the nightly
 * report's day, time and figures.
 *
 * MUTATION: the wallet-purchase balance read from the wrong reason (`PURCHASE`) -> the L11 and
 * L12 tests; the renewal's "before" replaced by its "after" -> the L12 test; the nightly day cut
 * in UTC instead of Tehran -> the window test; `[start, end)` closed on the right -> the same.
 */

const GIB = 1024n ** 3n;
const AT = new Date('2026-10-12T09:30:00Z');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const irt = (n: number): ReturnType<typeof money> => money(BigInt(n), 'IRT');

interface Row {
  id: string;
  customerId: string;
  signed: bigint;
  reason: string;
  orderId: string | null;
  at: number;
}

class FakeFacts {
  customers = new Map<string, CustomerFact>();
  orders = new Map<string, OrderFact>();
  services = new Map<string, ServiceFact>();
  operations = new Map<string, OperationFact>();
  payments = new Map<string, PaymentFact>();
  admins = new Map<string, AdminFact>();
  origins = new Map<string, OrderOriginFact>();
  before: ServiceBeforeImage | null = null;
  ledger: Row[] = [];
  rotations = 1;
  link: { type: string; requestedByCustomerId: string | null } | null = null;
  undeliverable: string | null = 'PANEL_REJECTED';
  failed: OperationFact | null = null;
  roleNames = new Map<string, string>();

  customer = async (_s: unknown, id: string) => this.customers.get(id) ?? null;
  admin = async (_s: unknown, id: string) => this.admins.get(id) ?? null;
  order = async (_s: unknown, id: string) => this.orders.get(id) ?? null;
  orderOrigin = async (_s: unknown, id: string) => this.origins.get(id) ?? null;
  service = async (_s: unknown, id: string) => this.services.get(id) ?? null;
  operation = async (_s: unknown, id: string) => this.operations.get(id) ?? null;
  paymentOfOrder = async (_s: unknown, orderId: string) => this.payments.get(orderId) ?? null;
  serviceBefore = async () => this.before;
  /** The operations completed by `until`, latest first: what the SQL bounds by event time. */
  linkHistory: { at: number; type: string; requestedByCustomerId: string | null }[] = [];
  latestLinkOperation = async (_s: unknown, _service: string, until: Date) =>
    this.linkHistory.length === 0
      ? this.link
      : ([...this.linkHistory]
          .filter((one) => one.at <= until.getTime())
          .sort((a, b) => b.at - a.at)[0] ?? null);
  rotationsInLast30Days = async () => this.rotations;
  undeliverableReason = async () => this.undeliverable;
  failedOperationOfOrder = async () => this.failed;
  roleNamesOf = async () => this.roleNames;
  /** Permissions per role key, for the snapshot an event carries. */
  rolePermissions = new Map<string, number>();
  permissionCountOf = async (_s: unknown, keys: readonly string[]) =>
    keys.reduce((sum, key) => sum + (this.rolePermissions.get(key) ?? 0), 0);
  entriesOfOrder = async (_s: unknown, orderId: string, reason: string) =>
    this.ledger
      .filter((row) => row.orderId === orderId && row.reason === reason)
      .map(
        (row) =>
          ({
            id: row.id,
            direction: row.signed < 0n ? 'DEBIT' : 'CREDIT',
            amount: money(row.signed < 0n ? -row.signed : row.signed, 'IRT'),
          }) as LedgerEntryFact,
      );
  /** The same arithmetic as the SQL: the wallet up to the last named entry, less their own sum. */
  balanceAround = async (
    _s: unknown,
    customerId: string,
    currency: CurrencyCode,
    ids: readonly string[],
  ): Promise<BalanceAround | null> => {
    if (ids.length === 0) return null;
    const mine = this.ledger.filter((row) => row.customerId === customerId);
    const last = Math.max(...mine.filter((row) => ids.includes(row.id)).map((row) => row.at));
    const after = mine.filter((row) => row.at <= last).reduce((sum, row) => sum + row.signed, 0n);
    const own = mine
      .filter((row) => ids.includes(row.id))
      .reduce((sum, row) => sum + row.signed, 0n);
    return { before: money(after - own, currency), after: money(after, currency) };
  };
  // Methods the consumers under test never call.
  [key: string]: unknown;
}

function asFacts(fake: FakeFacts): OpsLogFacts {
  return new Proxy(fake, {
    get(target, property) {
      if (property === 'roleNames') return target.roleNamesOf;
      return (target as never)[property];
    },
  }) as unknown as OpsLogFacts;
}

const customerFact = (overrides: Partial<CustomerFact> = {}): CustomerFact => ({
  id: 'cust-1',
  telegramUserId: '700100200',
  username: 'nima_t',
  firstName: 'نیما',
  lastName: null,
  phone: null,
  source: 'NEXA',
  status: 'ACTIVE',
  blockedReason: null,
  ...overrides,
});
const orderFact = (overrides: Partial<OrderFact> = {}): OrderFact => ({
  id: 'ord-1',
  code: 'KQ7M2X9T',
  customerId: 'cust-1',
  purpose: 'NEW_SERVICE',
  origin: 'STANDARD',
  source: 'NEXA',
  state: 'FULFILLED',
  title: 'پلن آزمایشی',
  durationDays: 30,
  trafficBytes: 50n * GIB,
  panelId: 'pan-1',
  panelName: 'پنل آزمایشی',
  locationLabel: null,
  subtotal: irt(250_000),
  discount: irt(0),
  total: irt(250_000),
  settledAt: AT,
  isFirstPurchase: false,
  reseller: false,
  resellerListPrice: null,
  ...overrides,
});
const serviceFact = (overrides: Partial<ServiceFact> = {}): ServiceFact => ({
  id: 'svc-1',
  code: 'SV3H5J7K',
  customerId: 'cust-1',
  orderId: 'ord-1',
  panelId: 'pan-1',
  panelName: 'پنل آزمایشی',
  providerUsername: 'nxtest01',
  isTrial: false,
  state: 'ACTIVE',
  expiresAt: new Date('2026-11-11T00:00:00Z'),
  trafficLimitBytes: 50n * GIB,
  trafficUsedBytes: 10n * GIB,
  lastSeenAt: null,
  source: 'NEXA',
  ...overrides,
});
const paymentFact = (method: string): PaymentFact => ({
  id: 'pay-1',
  code: 'RT4W8N2B',
  reference: 'ref-1',
  method,
  gatewayProvider: null,
  amount: irt(250_000),
  state: 'CONFIRMED',
});

function setup() {
  const facts = new FakeFacts();
  facts.customers.set('cust-1', customerFact());
  facts.orders.set('ord-1', orderFact());
  facts.services.set('svc-1', serviceFact());
  const queued: Parameters<OpsLogLane['queue']>[1][] = [];
  const lane: OpsLogLane = {
    queue: async (_scope, input) => {
      queued.push(input);
      return undefined;
    },
  };
  return { facts, queued, lane, ofFacts: asFacts(facts) };
}

const event = (eventType: string, aggregateId: string, payload: unknown = {}): DomainEvent =>
  ({
    eventId: `evt-${eventType}-${aggregateId}`,
    eventType,
    eventVersion: 1,
    tenantId: '01900000-0000-7000-8000-000000000001',
    aggregateType: 'Test',
    aggregateId,
    sequence: 1,
    correlationId: 'corr',
    causationId: null,
    actor: { type: 'SYSTEM_JOB', id: null },
    occurredAt: AT.toISOString(),
    payload,
  }) as unknown as DomainEvent;

const TX = {} as never;
const SCOPE = { tenantId: '01900000-0000-7000-8000-000000000001' as never, botInstanceId: null };

const render = (input: Parameters<OpsLogLane['queue']>[1]): string =>
  renderTemplateBody(
    templateDefinition(input.templateKey as TemplateKey),
    CATALOGUE_FA[input.templateKey as TemplateKey],
    input.values as never,
    'fa',
    DEFAULT_TEMPLATE_PRESENTATION,
  );

describe('L10 / L11 / L16 / L15 — the services log', () => {
  it('a wallet purchase prints the wallet before → after of THIS order’s purchase debit', () => {
    const { facts, queued, lane, ofFacts } = setup();
    facts.payments.set('ord-1', paymentFact('WALLET'));
    facts.ledger = [
      {
        id: 'l1',
        customerId: 'cust-1',
        signed: 600_000n,
        reason: 'ADMIN_CREDIT',
        orderId: null,
        at: 1,
      },
      {
        id: 'l2',
        customerId: 'cust-1',
        signed: -250_000n,
        reason: 'PURCHASE',
        orderId: 'ord-1',
        at: 2,
      },
      // A later top-up: after the figure being asked for, so not in it.
      {
        id: 'l3',
        customerId: 'cust-1',
        signed: 900_000n,
        reason: 'ADMIN_CREDIT',
        orderId: null,
        at: 3,
      },
    ];
    const consumer = new ServiceLogConsumer({ lane, facts: ofFacts, words });
    return consumer.handle(event('ServiceProvisioned', 'svc-1'), TX).then(() => {
      expect(queued).toHaveLength(1);
      expect(queued[0]!.logType).toBe('SERVICE_CREATED_WALLET');
      expect(queued[0]!.values).toMatchObject({
        balanceBefore: irt(600_000),
        balanceAfter: irt(350_000),
      });
      expect(render(queued[0]!)).toContain('۶۰۰٬۰۰۰ تومان ← ۳۵۰٬۰۰۰ تومان');
    });
  });

  it('a purchase by another method is the plain message, and a trial its own', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    facts.payments.set('ord-1', paymentFact('MANUAL_TRANSFER'));
    const consumer = new ServiceLogConsumer({ lane, facts: ofFacts, words });
    await consumer.handle(event('ServiceProvisioned', 'svc-1'), TX);
    expect(queued.map((one) => one.logType)).toEqual(['SERVICE_CREATED']);

    facts.orders.set('ord-1', orderFact({ purpose: 'TRIAL', total: irt(0) }));
    await consumer.handle(event('ServiceProvisioned', 'svc-1'), TX);
    expect(queued.map((one) => one.logType)).toEqual(['SERVICE_CREATED', 'TRIAL_CREATED']);
  });

  it('a link change names who asked, from the operation that did it', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    const consumer = new ServiceLogConsumer({ lane, facts: ofFacts, words });
    facts.link = { type: 'ROTATE_SUBSCRIPTION', requestedByCustomerId: 'cust-1' };
    await consumer.handle(
      event('ServiceSubscriptionRotated', 'svc-1', { customerId: 'cust-1' }),
      TX,
    );
    facts.link = { type: 'ROTATE_SUBSCRIPTION', requestedByCustomerId: null };
    await consumer.handle(
      event('ServiceSubscriptionRotated', 'svc-1', { customerId: 'cust-1' }),
      TX,
    );
    expect(queued.map((one) => one.values['byWhom'])).toEqual([
      words.byWhom('CUSTOMER'),
      words.byWhom('ADMIN'),
    ]);
  });

  it('a link change is attributed to ITS operation, never to a later one the consumer finds first', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    const consumer = new ServiceLogConsumer({ lane, facts: ofFacts, words });
    // The customer's rotation completed at AT.
    facts.operations.set('op-customer', {
      id: 'op-customer',
      type: 'ROTATE_SUBSCRIPTION',
      state: 'SUCCEEDED',
      serviceId: 'svc-1',
      orderId: null,
      requestedByCustomerId: 'cust-1',
      panelId: 'pan-1',
      failureKind: null,
      failureMessage: null,
      targetExpiresAt: null,
      targetTrafficLimitBytes: null,
      completedAt: AT,
    });
    // The history the fallback reads: an operator's rotation just before the event's time, and
    // a customer's an hour after it (later than the event, so never its author).
    facts.linkHistory = [
      { at: AT.getTime() - 1, type: 'ROTATE_SUBSCRIPTION', requestedByCustomerId: null },
      {
        at: AT.getTime() + 3_600_000,
        type: 'ROTATE_SUBSCRIPTION',
        requestedByCustomerId: 'cust-1',
      },
    ];
    // The event names its operation…
    await consumer.handle(
      event('ServiceSubscriptionRotated', 'svc-1', {
        customerId: 'cust-1',
        operationId: 'op-customer',
      }),
      TX,
    );
    // …and an event from before the field is bounded by its own time.
    await consumer.handle(
      event('ServiceSubscriptionRotated', 'svc-1', { customerId: 'cust-1' }),
      TX,
    );
    expect(queued.map((one) => one.values['byWhom'])).toEqual([
      // The named operation: the customer's, whatever the history says.
      words.byWhom('CUSTOMER'),
      // No name: the last one completed by the event's time, the operator's — not the later one.
      words.byWhom('ADMIN'),
    ]);
  });

  it('an adopted or imported ORDER is silent; an imported customer or service buying now is not', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    facts.payments.set('ord-1', paymentFact('WALLET'));
    const consumer = new ServiceLogConsumer({ lane, facts: ofFacts, words });
    facts.orders.set('ord-1', orderFact({ origin: 'ADOPTED' }));
    await consumer.handle(event('ServiceProvisioned', 'svc-1'), TX);
    facts.orders.set('ord-1', orderFact({ source: 'MIRZA' }));
    await consumer.handle(event('ServiceProvisioned', 'svc-1'), TX);
    expect(queued).toEqual([]);

    /*
     * Hotfix v0.8.2-e: the order is the purchase's provenance. A customer (or a service) the
     * import wrote who buys through this installation is this installation's sale — every
     * customer of an installation migrated by the one-click import is `MIRZA`, and refusing
     * them silenced every purchase while the payment log still arrived.
     */
    facts.orders.set('ord-1', orderFact());
    facts.customers.set('cust-1', customerFact({ source: 'MIRZA' }));
    await consumer.handle(event('ServiceProvisioned', 'svc-1'), TX);
    facts.services.set('svc-1', serviceFact({ source: 'MIRZA' }));
    await consumer.handle(event('ServiceProvisioned', 'svc-1'), TX);
    // (No ledger in this fixture, so the wallet figures are unknown and the plain L10 is built.)
    expect(queued.map((one) => one.logType)).toEqual(['SERVICE_CREATED', 'SERVICE_CREATED']);
  });
});

describe('L12 / L13 / L14 — a renewal, extra traffic, extra time', () => {
  const op = (overrides: Partial<OperationFact> = {}): OperationFact => ({
    id: 'op-1',
    type: 'RENEW',
    state: 'SUCCEEDED',
    serviceId: 'svc-1',
    orderId: 'ord-1',
    requestedByCustomerId: 'cust-1',
    panelId: 'pan-1',
    failureKind: null,
    failureMessage: null,
    targetExpiresAt: new Date('2026-12-11T00:00:00Z'),
    targetTrafficLimitBytes: 60n * GIB,
    completedAt: AT,
    ...overrides,
  });
  const clock: Clock = { now: () => AT };

  it('a renewal paid from the wallet shows the expiry before ≠ after, the used volume and the wallet', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    facts.orders.set('ord-1', orderFact({ purpose: 'RENEW' }));
    facts.operations.set('op-1', op());
    facts.payments.set('ord-1', paymentFact('WALLET'));
    facts.before = {
      expiresAt: new Date('2026-11-11T00:00:00Z'),
      trafficLimitBytes: 50n * GIB,
      trafficUsedBytes: 42n * GIB,
    };
    facts.ledger = [
      {
        id: 'l1',
        customerId: 'cust-1',
        signed: 500_000n,
        reason: 'ADMIN_CREDIT',
        orderId: null,
        at: 1,
      },
      {
        id: 'l2',
        customerId: 'cust-1',
        signed: -250_000n,
        reason: 'PURCHASE',
        orderId: 'ord-1',
        at: 2,
      },
    ];
    const hook = new OperationLog({ lane, facts: ofFacts, words, clock });
    await hook.operationSucceeded(SCOPE, 'op-1', TX);

    expect(queued).toHaveLength(1);
    const message = queued[0]!;
    expect(message.logType).toBe('SERVICE_RENEWED');
    expect(message.values['expiresBefore']).toEqual(new Date('2026-11-11T00:00:00Z'));
    expect(message.values['expiresAfter']).toEqual(new Date('2026-12-11T00:00:00Z'));
    expect(message.values['expiresBefore']).not.toEqual(message.values['expiresAfter']);
    expect(message.values).toMatchObject({
      balanceBefore: irt(500_000),
      balanceAfter: irt(250_000),
      usedBytes: 42n * GIB,
    });
    const text = render(message);
    const dates = text.match(/📅 انقضا: (\S+) ← (\S+)/u);
    expect(dates?.[1]).not.toBe(dates?.[2]);
  });

  it('with no audit row for the "before", the expiry lines are left out rather than guessed', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    facts.orders.set('ord-1', orderFact({ purpose: 'RENEW' }));
    facts.operations.set('op-1', op());
    facts.payments.set('ord-1', paymentFact('MANUAL_TRANSFER'));
    facts.before = null;
    await new OperationLog({ lane, facts: ofFacts, words, clock }).operationSucceeded(
      SCOPE,
      'op-1',
      TX,
    );
    expect(queued[0]!.values).not.toHaveProperty('expiresBefore');
    expect(queued[0]!.values).not.toHaveProperty('balanceBefore');
    expect(render(queued[0]!)).not.toContain('📅');
  });

  it('extra traffic shows the limit before → after, and extra time the days and the expiry', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    facts.payments.set('ord-1', paymentFact('MANUAL_TRANSFER'));
    const hook = new OperationLog({ lane, facts: ofFacts, words, clock });
    facts.orders.set('ord-1', orderFact({ purpose: 'ADD_TRAFFIC', trafficBytes: 10n * GIB }));
    facts.operations.set('op-1', op({ type: 'ADD_TRAFFIC' }));
    facts.before = { expiresAt: null, trafficLimitBytes: 50n * GIB, trafficUsedBytes: 5n * GIB };
    await hook.operationSucceeded(SCOPE, 'op-1', TX);
    expect(queued[0]!.logType).toBe('TRAFFIC_ADDED');
    expect(queued[0]!.values).toMatchObject({ limitBefore: 50n * GIB, limitAfter: 60n * GIB });

    facts.orders.set('ord-1', orderFact({ purpose: 'ADD_TIME', durationDays: 15 }));
    facts.operations.set('op-2', op({ id: 'op-2', type: 'ADD_TIME', orderId: 'ord-1' }));
    facts.before = {
      expiresAt: new Date('2026-11-11T00:00:00Z'),
      trafficLimitBytes: null,
      trafficUsedBytes: null,
    };
    await hook.operationSucceeded(SCOPE, 'op-2', TX);
    expect(queued[1]!.logType).toBe('TIME_ADDED');
    expect(queued[1]!.values['addedDays']).toBe(15);
  });

  it('says nothing for an operation that did not succeed, one the import made, or another kind', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    const hook = new OperationLog({ lane, facts: ofFacts, words, clock });
    facts.operations.set('op-f', op({ id: 'op-f', state: 'FAILED' }));
    facts.operations.set('op-s', op({ id: 'op-s', type: 'SUSPEND' }));
    facts.operations.set('op-i', op({ id: 'op-i' }));
    facts.orders.set('ord-1', orderFact({ purpose: 'RENEW', origin: 'ADOPTED' }));
    await hook.operationSucceeded(SCOPE, 'op-f', TX);
    await hook.operationSucceeded(SCOPE, 'op-s', TX);
    await hook.operationSucceeded(SCOPE, 'op-i', TX);
    expect(queued).toEqual([]);
  });
});

describe('L23 / L24 — each error is its own message, and an unknown outcome is never a refund', () => {
  const failure = (overrides: Partial<OperationFact> = {}): OperationFact => ({
    id: 'op-1',
    type: 'CREATE_USER',
    state: 'FAILED',
    serviceId: 'svc-1',
    orderId: 'ord-1',
    requestedByCustomerId: 'cust-1',
    panelId: 'pan-1',
    failureKind: 'REJECTED',
    failureMessage: 'HTTP 422 invalid username',
    targetExpiresAt: null,
    targetTrafficLimitBytes: null,
    completedAt: AT,
    ...overrides,
  });

  it('an automatic refund is reported with the customer, the Persian cause, one technical line and the refunded amount', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    facts.payments.set('ord-1', paymentFact('MANUAL_TRANSFER'));
    facts.failed = failure();
    // What the refund wrote: the figure comes from here, never from the order's total.
    facts.ledger.push({
      id: 'refund-1',
      customerId: 'cust-1',
      signed: 250_000n,
      reason: 'REFUND',
      orderId: 'ord-1',
      at: 1,
    });
    const consumer = new FailureLogConsumer({ lane, facts: ofFacts, words });
    await consumer.handle(
      event('OrderRefunded', 'ord-1', {
        customerId: 'cust-1',
        amountMinor: '250000',
        currency: 'IRT',
        reason: AUTOMATIC_REFUND_REASON,
      }),
      TX,
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]!.logType).toBe('ERROR_PROVISION');
    const text = render(queued[0]!);
    expect(text).toContain('@nima_t');
    expect(text).toContain('🔧 کد: REJECTED · PANEL_REJECTED · HTTP 422');
    expect(text).toContain('↩️ برای مشتری: مبلغ به کیف پولش برگشت (۲۵۰٬۰۰۰ تومان)');
    expect(text).not.toMatch(UUID);
    // The optional roll-up input is always supplied; whether it applies is the lane's to say.
    expect(queued[0]!.storm).toMatchObject({ customer: '700100200' });
  });

  it('an automatic refund with no REFUND credit on the ledger says nothing was refunded, never the order’s total', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    facts.payments.set('ord-1', paymentFact('MANUAL_TRANSFER'));
    facts.failed = failure();
    // A partial credit of 100 000 on a 250 000 order: the message names the 100 000.
    const consumer = new FailureLogConsumer({ lane, facts: ofFacts, words });
    const refunded = event('OrderRefunded', 'ord-1', {
      customerId: 'cust-1',
      amountMinor: '250000',
      currency: 'IRT',
      reason: AUTOMATIC_REFUND_REASON,
    });
    await consumer.handle(refunded, TX);
    expect(render(queued[0]!)).toContain(words.impact('notRefunded'));
    expect(render(queued[0]!)).not.toContain('۲۵۰٬۰۰۰ تومان)');
    facts.ledger.push({
      id: 'refund-p',
      customerId: 'cust-1',
      signed: 100_000n,
      reason: 'REFUND',
      orderId: 'ord-1',
      at: 1,
    });
    await consumer.handle(refunded, TX);
    expect(render(queued[1]!)).toContain('(۱۰۰٬۰۰۰ تومان)');
  });

  it('an UNKNOWN outcome is not refunded and not called a failure of money: the panel is being asked', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    facts.payments.set('ord-1', paymentFact('MANUAL_TRANSFER'));
    facts.orders.set('ord-1', orderFact({ purpose: 'RENEW' }));
    const consumer = new FailureLogConsumer({ lane, facts: ofFacts, words });
    await consumer.handle(
      event('ProvisioningOutcomeUnknown', 'svc-1', {
        serviceId: 'svc-1',
        panelId: 'pan-1',
        operationType: 'RENEW',
        failureKind: 'TIMEOUT',
      }),
      TX,
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]!.logType).toBe('ERROR_OPERATION');
    const text = render(queued[0]!);
    expect(text).toContain(words.impact('pending'));
    expect(text).not.toContain(words.impact('refundedToWallet'));
    expect(queued[0]!.values).toHaveProperty('retry');
  });

  it('an operator’s refund of a delivered order, and an imported order, are not error reports', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    const consumer = new FailureLogConsumer({ lane, facts: ofFacts, words });
    await consumer.handle(
      event('OrderRefunded', 'ord-1', {
        customerId: 'cust-1',
        amountMinor: '1',
        currency: 'IRT',
        reason: 'OPERATOR',
      }),
      TX,
    );
    facts.orders.set('ord-1', orderFact({ origin: 'ADOPTED' }));
    await consumer.handle(
      event('OrderRefunded', 'ord-1', {
        customerId: 'cust-1',
        amountMinor: '1',
        currency: 'IRT',
        reason: AUTOMATIC_REFUND_REASON,
      }),
      TX,
    );
    expect(queued).toEqual([]);
  });
});

describe('L19 / L21 — administrators and a service alert', () => {
  it('a role change shows the old role → the new role, from the added and removed keys', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    facts.admins.set('adm-1', {
      id: 'adm-1',
      username: 'finance_lead',
      displayName: 'مدیر مالی',
      telegramUserId: '700900100',
      roleNames: ['مدیر مالی'],
      roleKeys: ['finance'],
      permissionCount: 30,
    });
    facts.roleNames = new Map([['support', 'پشتیبان']]);
    const consumer = new AdminLogConsumer({ lane, facts: ofFacts, words });
    await consumer.handle(
      event('AdminRolesChanged', 'adm-1', { added: ['finance'], removed: ['support'] }),
      TX,
    );
    const text = render(queued[0]!);
    expect(text).toContain('پشتیبان ← مدیر مالی');
    expect(text).toContain('۳۰ مجوز');
  });

  it('renders the roles AS OF THE EVENT, not the roles a later change left by the time it runs', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    // When the consumer runs the admin is already an owner — a LATER change.
    facts.admins.set('adm-1', {
      id: 'adm-1',
      username: 'finance_lead',
      displayName: 'مدیر مالی',
      telegramUserId: '700900100',
      roleNames: ['مالک'],
      roleKeys: ['owner'],
      permissionCount: 99,
    });
    facts.roleNames = new Map([
      ['support', 'پشتیبان'],
      ['finance', 'مدیر مالی'],
      ['owner', 'مالک'],
    ]);
    facts.rolePermissions = new Map([
      ['support', 4],
      ['finance', 30],
    ]);
    const consumer = new AdminLogConsumer({ lane, facts: ofFacts, words });
    await consumer.handle(
      event('AdminRolesChanged', 'adm-1', {
        added: ['finance'],
        removed: ['support'],
        before: ['support'],
        after: ['finance'],
      }),
      TX,
    );
    await consumer.handle(
      event('AdminStatusChanged', 'adm-1', {
        from: 'ACTIVE',
        to: 'DISABLED',
        roleKeys: ['finance'],
      }),
      TX,
    );
    const changed = render(queued[0]!);
    expect(changed).toContain('پشتیبان ← مدیر مالی');
    expect(changed).toContain('۳۰ مجوز');
    expect(changed).not.toContain('مالک');
    const disabled = render(queued[1]!);
    expect(disabled).toContain('مدیر مالی');
    expect(disabled).not.toContain('مالک');
    expect(disabled).toContain('۳۰ مجوز');
  });

  it('one alert per reminder, with the customer’s service; an imported service is silent', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    const hook = new ServiceAlertLog({ lane, facts: ofFacts, words, clock: { now: () => AT } });
    const input = {
      reminderId: 'rem-1',
      serviceId: 'svc-1',
      kind: 'USAGE_FINAL' as const,
      remainingDays: 3,
    };
    await hook.serviceAlerted(SCOPE, input, TX);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.dedupeKey).toBe('oplog:alert:rem-1');
    facts.services.set('svc-1', serviceFact({ source: 'MIRZA' }));
    await hook.serviceAlerted(SCOPE, { ...input, reminderId: 'rem-2' }, TX);
    expect(queued).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------
// The nightly reports
// ---------------------------------------------------------------------------------------

const tally = (count: number, sum: number) => ({ count, sum: BigInt(sum) });
function reportData(overrides: Partial<NightlyReportData> = {}): NightlyReportData {
  return {
    day: new Date('2026-10-11T20:30:00Z'),
    currency: 'IRT',
    newPurchases: tally(4, 1_000_000),
    firstPurchases: 2,
    renewals: tally(3, 600_000),
    traffic: tally(2, 100_000),
    time: tally(1, 50_000),
    other: tally(0, 0),
    previousGross: 1_500_000n,
    bestHour: 21,
    newCustomers: 5,
    activeCustomers: 9,
    trials: 2,
    activeServices: 120,
    customersWithService: 90,
    customersWithoutService: 30,
    errors: 1,
    failedPayments: 2,
    openTickets: 3,
    expiredPayments: 7,
    refunds: tally(1, 80_000),
    commissions: tally(2, 30_000),
    giftSum: 20_000n,
    methods: [
      { key: 'WALLET', sum: 700_000n },
      { key: 'TONPAYS', sum: 300_000n },
    ],
    panels: [
      {
        name: 'پنل ۱',
        orders: 6,
        sum: 1_200_000n,
        soldBytes: 300n * GIB,
        health: 'HEALTHY',
        used: 40,
        capacity: 100,
      },
      {
        name: 'پنل ۲',
        orders: 0,
        sum: 0n,
        soldBytes: 0n,
        health: 'HEALTHY',
        used: 0,
        capacity: null,
      },
    ],
    resellers: {
      active: 2,
      salesSum: 500_000n,
      top: { username: 'agent1', name: 'نماینده', sum: 400_000n },
      topList: [],
    },
    ...overrides,
  };
}

describe('L27 / L28 / L29 / L30 — the figures of the nightly reports', () => {
  it('gross, net and the change are arithmetic over the day; the summary and the financial report agree', () => {
    const data = reportData();
    expect(grossOf(data)).toBe(1_750_000n);
    expect(netOf(data)).toBe(1_750_000n - 80_000n - 30_000n - 20_000n);
    const [summary, financial, panels] = nightlyReports(data, words);
    expect(summary!.values['sales']).toEqual(irt(1_750_000));
    expect(financial!.values['gross']).toEqual(summary!.values['sales']);
    expect(financial!.values['net']).toEqual(irt(1_620_000));
    const text = render(summary as never);
    expect(text).toContain('۱٬۷۵۰٬۰۰۰ تومان');
    expect(text).toContain('۲۱ تا ۲۲');
    for (const built of [summary!, financial!, panels!]) {
      const rendered = render(built as never);
      expect(rendered).not.toMatch(/NaN|undefined|Infinity/);
      expect(rendered).not.toMatch(UUID);
    }
    expect(summary!.logType).toBe('REPORT_SUMMARY');
    expect(financial!.logType).toBe('REPORT_FINANCIAL');
    expect(panels!.logType).toBe('REPORT_PANELS');
  });

  it('the cleanup (L30) is one line in the summary, absent when nothing expired, and never a message of its own', () => {
    const withCleanup = nightlyReports(reportData(), words);
    expect(withCleanup).toHaveLength(3);
    expect(withCleanup[0]!.values).toHaveProperty('cleanup');
    expect(render(withCleanup[0] as never)).toMatch(/۷/);
    const without = nightlyReports(reportData({ expiredPayments: 0 }), words);
    expect(without[0]!.values).not.toHaveProperty('cleanup');
    expect(without.map((built) => built.logType)).toEqual([
      'REPORT_SUMMARY',
      'REPORT_FINANCIAL',
      'REPORT_PANELS',
    ]);
  });

  it('a quiet day has no NaN: no sales, no previous day, no best hour', () => {
    const quiet = reportData({
      newPurchases: tally(0, 0),
      renewals: tally(0, 0),
      traffic: tally(0, 0),
      time: tally(0, 0),
      firstPurchases: 0,
      previousGross: 0n,
      bestHour: null,
      refunds: tally(0, 0),
      commissions: tally(0, 0),
      giftSum: 0n,
      methods: [],
      panels: [],
      expiredPayments: 0,
      resellers: { active: 0, salesSum: 0n, top: null, topList: [] },
    });
    for (const built of nightlyReports(quiet, words)) {
      const text = render(built as never);
      expect(text).not.toMatch(/NaN|undefined|Infinity/);
    }
  });
});

describe('the nightly report’s time and day', () => {
  // Tehran is UTC+03:30 all year: its midnight of 2026-10-12 is 2026-10-11T20:30:00Z.
  function service(now: { current: Date }, settings: Record<string, unknown>) {
    const posted = new Set<string>();
    const queued: { dedupeKey: string; logType: string; windowStart?: Date }[] = [];
    const reads: { start: Date; end: Date; previousStart: Date; previousEnd: Date }[] = [];
    const clock: Clock = { now: () => now.current };
    const periods: TimePeriodResolver = new IntlTimePeriodResolver(clock);
    const reporter = new NightlyReportService({
      uow: {
        run: async (_scope: unknown, work: (tx: never) => Promise<number>) => work(TX),
      } as never,
      scopeActivity: { scopeIsActive: async () => true } as never,
      reader: {
        alreadyPosted: async (_s: unknown, key: string) => posted.has(key),
        read: async (_s: unknown, window: (typeof reads)[number]) => {
          reads.push(window);
          const { day: _day, ...rest } = reportData();
          return rest;
        },
      } as never,
      lane: {
        queue: async (_scope, input) => {
          posted.add(input.dedupeKey);
          queued.push({ dedupeKey: input.dedupeKey, logType: String(input.logType) });
          return undefined;
        },
      },
      words,
      settings: {
        valueOf: async (_scope: unknown, key: string) =>
          (key in settings ? settings[key] : DEFAULTS[key]) as never,
      },
      features: { isEnabled: async () => true },
      periods,
      clock,
    });
    return { reporter, queued, reads };
  }
  const DEFAULTS: Record<string, unknown> = {
    'ops.log.disabled_types': [],
    'ops.log.nightly_report_time': '00:05',
    'sales.currency': 'IRT',
  };

  it('posts nothing before 00:05 Tehran, and at 00:05 the three reports of the COMPLETED previous day', async () => {
    // 00:04 Tehran on 2026-10-13 is 2026-10-12T20:34:00Z.
    const now = { current: new Date('2026-10-12T20:34:00Z') };
    const { reporter, queued, reads } = service(now, {});
    expect(await reporter.runOnce(SCOPE)).toBe(0);
    now.current = new Date('2026-10-12T20:35:00Z'); // 00:05 Tehran, 2026-10-13
    expect(await reporter.runOnce(SCOPE)).toBe(3);
    expect(queued.map((one) => one.logType).sort()).toEqual([
      'REPORT_FINANCIAL',
      'REPORT_PANELS',
      'REPORT_SUMMARY',
    ]);
    // The day reported is 2026-10-12 Tehran, [00:00, next 00:00) — ended before the report.
    expect(reads[0]!.start.toISOString()).toBe('2026-10-11T20:30:00.000Z');
    expect(reads[0]!.end.toISOString()).toBe('2026-10-12T20:30:00.000Z');
    expect(reads[0]!.end.getTime()).toBeLessThanOrEqual(now.current.getTime());
    // Compared with the day before IT.
    expect(reads[0]!.previousStart.toISOString()).toBe('2026-10-10T20:30:00.000Z');
    expect(reads[0]!.previousEnd.toISOString()).toBe(reads[0]!.start.toISOString());
  });

  it('never reports a day that has not ended: at 23:59 the running day is not reported', async () => {
    // 23:59 Tehran on 2026-10-12, time set to 23:59: the report due now is 2026-10-11's.
    const { reporter, reads } = service(
      { current: new Date('2026-10-12T20:29:00Z') },
      { 'ops.log.nightly_report_time': '23:59' },
    );
    expect(await reporter.runOnce(SCOPE)).toBe(3);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.start.toISOString()).toBe('2026-10-10T20:30:00.000Z');
    expect(reads[0]!.end.toISOString()).toBe('2026-10-11T20:30:00.000Z');
  });

  it('posts a day once: a second pass, a second replica and a restart add nothing', async () => {
    const now = { current: new Date('2026-10-12T20:35:30Z') };
    const { reporter, queued } = service(now, {});
    expect(await reporter.runOnce(SCOPE)).toBe(3);
    expect(await reporter.runOnce(SCOPE)).toBe(0);
    expect(queued).toHaveLength(3);
  });

  it('honours a configured time, and a type switched off is not posted', async () => {
    const now = { current: new Date('2026-10-12T05:00:00Z') }; // 08:30 Tehran
    const early = service(now, { 'ops.log.nightly_report_time': '08:00' });
    expect(await early.reporter.runOnce(SCOPE)).toBe(3);
    const off = service(now, {
      'ops.log.nightly_report_time': '08:00',
      'ops.log.disabled_types': ['REPORT_FINANCIAL', 'REPORT_PANELS'],
    });
    expect(await off.reporter.runOnce(SCOPE)).toBe(1);
    expect(off.queued.map((one) => one.logType)).toEqual(['REPORT_SUMMARY']);
    const allOff = service(now, {
      'ops.log.nightly_report_time': '08:00',
      'ops.log.disabled_types': ['REPORT_SUMMARY', 'REPORT_FINANCIAL', 'REPORT_PANELS'],
    });
    expect(await allOff.reporter.runOnce(SCOPE)).toBe(0);
  });

  it('catches up a report a downed worker missed, but never posts a stale one as if it were fresh', async () => {
    // Time 23:59; at 01:00 Tehran on the 13th the 11th's report (due 23:59 on the 12th) is an
    // hour late and still posted, and the 12th's (due 23:59 on the 13th) is not due yet.
    const soon = service(
      { current: new Date('2026-10-12T21:30:00Z') },
      { 'ops.log.nightly_report_time': '23:59' },
    );
    expect(await soon.reporter.runOnce(SCOPE)).toBe(3);
    expect(soon.reads[0]!.start.toISOString()).toBe('2026-10-10T20:30:00.000Z');
    // Past the catch-up bound, the 12th's 00:05 report is not posted.
    const late = service(
      {
        current: new Date(
          Date.parse('2026-10-12T20:35:00Z') + NIGHTLY_REPORT_CATCH_UP_MS + 3_600_000,
        ),
      },
      {},
    );
    expect(await late.reporter.runOnce(SCOPE)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// Round 9 C2 — the ops-log additions
// ---------------------------------------------------------------------------------------

const origin = (overrides: Partial<OrderOriginFact> = {}): OrderOriginFact => ({
  surface: 'TELEGRAM',
  actorType: 'CUSTOMER',
  actorId: null,
  actorLabel: null,
  ...overrides,
});

const SOURCE_BOT = 'منبع: ربات';
const SOURCE_MINI_APP = 'منبع: مینی‌اپ';

describe('R9 C2 item 6 — the source line of a purchase, a renewal, extra traffic, extra time and a ticket', () => {
  const op = (type: string): OperationFact => ({
    id: 'op-1',
    type,
    state: 'SUCCEEDED',
    serviceId: 'svc-1',
    orderId: 'ord-1',
    requestedByCustomerId: 'cust-1',
    panelId: 'pan-1',
    failureKind: null,
    failureMessage: null,
    targetExpiresAt: new Date('2026-12-11T00:00:00Z'),
    targetTrafficLimitBytes: 60n * GIB,
    completedAt: AT,
  });
  const clock: Clock = { now: () => AT };

  async function textsOf(surface: string | null): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    // L10: a service created.
    {
      const { facts, queued, lane, ofFacts } = setup();
      facts.payments.set('ord-1', paymentFact('MANUAL_TRANSFER'));
      if (surface !== null) facts.origins.set('ord-1', origin({ surface }));
      await new ServiceLogConsumer({ lane, facts: ofFacts, words }).handle(
        event('ServiceProvisioned', 'svc-1'),
        TX,
      );
      out['L10'] = render(queued[0]!);
    }
    // L12 / L13 / L14: a renewal, extra traffic, extra time.
    for (const [key, purpose] of [
      ['L12', 'RENEW'],
      ['L13', 'ADD_TRAFFIC'],
      ['L14', 'ADD_TIME'],
    ] as const) {
      const { facts, queued, lane, ofFacts } = setup();
      facts.orders.set('ord-1', orderFact({ purpose }));
      facts.operations.set('op-1', op(purpose));
      facts.payments.set('ord-1', paymentFact('MANUAL_TRANSFER'));
      if (surface !== null) facts.origins.set('ord-1', origin({ surface }));
      await new OperationLog({ lane, facts: ofFacts, words, clock }).operationSucceeded(
        SCOPE,
        'op-1',
        TX,
      );
      out[key] = render(queued[0]!);
    }
    // L26: a ticket opened, and a reply.
    for (const [key, reply] of [
      ['L26 opened', false],
      ['L26 replied', true],
    ] as const) {
      const built = ticket({
        ticket: {
          id: 'tk-1',
          number: '1042',
          code: null,
          customerId: 'cust-1',
          categoryTitle: 'مشکل اتصال',
          snippetSource: 'سلام',
          surface,
        },
        customer: customerFact(),
        reply,
        at: AT,
        words,
      });
      out[key] = render({
        templateKey: built.templateKey,
        values: built.values,
      } as never);
    }
    return out;
  }

  it('says the mini app wherever the recorded source surface is the mini app', async () => {
    const texts = await textsOf('MINI_APP');
    expect(Object.keys(texts)).toHaveLength(6);
    for (const [name, text] of Object.entries(texts)) {
      expect(text, name).toContain(SOURCE_MINI_APP);
      expect(text, name).not.toContain(SOURCE_BOT);
    }
  });

  it('says the bot for a bot surface, for any other surface and for no recorded source at all', async () => {
    for (const surface of ['TELEGRAM', 'WEB', null]) {
      const texts = await textsOf(surface);
      for (const [name, text] of Object.entries(texts)) {
        expect(text, `${name} / ${String(surface)}`).toContain(SOURCE_BOT);
        expect(text, `${name} / ${String(surface)}`).not.toContain(SOURCE_MINI_APP);
      }
    }
  });

  it('puts the source line before the time line, one line, and no raw enum', async () => {
    const text = (await textsOf('MINI_APP'))['L10']!;
    const lines = text.split('\n');
    const at = lines.findIndex((line) => line.includes(SOURCE_MINI_APP));
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toMatch(/^🕒/u);
    expect(text).not.toContain('MINI_APP');
  });
});

describe('R9 C2 item 4 — the «خرید اول کاربر» line of L10 / L11', () => {
  const FIRST = 'خرید اول کاربر';

  it('is printed on L10 and on L11 for a first paid purchase, and only then', async () => {
    for (const method of ['MANUAL_TRANSFER', 'WALLET'] as const) {
      const { facts, queued, lane, ofFacts } = setup();
      facts.payments.set('ord-1', paymentFact(method));
      if (method === 'WALLET') {
        facts.ledger = [
          {
            id: 'l1',
            customerId: 'cust-1',
            signed: 600_000n,
            reason: 'ADMIN_CREDIT',
            orderId: null,
            at: 1,
          },
          {
            id: 'l2',
            customerId: 'cust-1',
            signed: -250_000n,
            reason: 'PURCHASE',
            orderId: 'ord-1',
            at: 2,
          },
        ];
      }
      const consumer = new ServiceLogConsumer({ lane, facts: ofFacts, words });
      facts.orders.set('ord-1', orderFact({ isFirstPurchase: true }));
      await consumer.handle(event('ServiceProvisioned', 'svc-1'), TX);
      facts.orders.set('ord-1', orderFact({ isFirstPurchase: false }));
      await consumer.handle(event('ServiceProvisioned', 'svc-1'), TX);

      const [first, later] = queued;
      expect(first!.logType).toBe(
        method === 'WALLET' ? 'SERVICE_CREATED_WALLET' : 'SERVICE_CREATED',
      );
      expect(render(first!), method).toContain(`🥇 ${FIRST}: ${words.firstPurchaseYes}`);
      expect(render(later!), method).not.toContain(FIRST);
      expect(later!.values).not.toHaveProperty('firstPurchase');
    }
  });

  it('is never on a renewal, extra traffic or extra time', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    facts.orders.set('ord-1', orderFact({ purpose: 'RENEW', isFirstPurchase: true }));
    facts.operations.set('op-1', {
      id: 'op-1',
      type: 'RENEW',
      state: 'SUCCEEDED',
      serviceId: 'svc-1',
      orderId: 'ord-1',
      requestedByCustomerId: 'cust-1',
      panelId: 'pan-1',
      failureKind: null,
      failureMessage: null,
      targetExpiresAt: new Date('2026-12-11T00:00:00Z'),
      targetTrafficLimitBytes: null,
      completedAt: AT,
    });
    facts.payments.set('ord-1', paymentFact('MANUAL_TRANSFER'));
    await new OperationLog({
      lane,
      facts: ofFacts,
      words,
      clock: { now: () => AT },
    }).operationSucceeded(SCOPE, 'op-1', TX);
    expect(render(queued[0]!)).not.toContain(FIRST);
  });
});

describe('R9 C2 item 1 — a service an administrator created from the Web Admin that failed on the panel', () => {
  const adminActor = origin({
    surface: 'WEB',
    actorType: 'WEB_ADMIN',
    actorId: 'adm-1',
    actorLabel: 'مدیر برچسب',
  });
  const admin1: AdminFact = {
    id: 'adm-1',
    username: 'ops_lead',
    displayName: 'مدیر آزمایشی',
    telegramUserId: '700900100',
    roleNames: [],
    roleKeys: [],
    permissionCount: 0,
  };
  const refunded = (): DomainEvent =>
    event('OrderRefunded', 'ord-1', {
      customerId: 'cust-1',
      amountMinor: '250000',
      currency: 'IRT',
      reason: AUTOMATIC_REFUND_REASON,
    });

  it('has its own L23 message naming the administrator, the customer, the panel and the cause', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    facts.payments.set('ord-1', paymentFact('WALLET'));
    facts.origins.set('ord-1', adminActor);
    facts.admins.set('adm-1', admin1);
    await new FailureLogConsumer({ lane, facts: ofFacts, words }).handle(refunded(), TX);

    expect(queued).toHaveLength(1);
    expect(queued[0]!.templateKey).toBe('ops.log.error_provision_admin');
    // The same ERRORS-topic type and switch as the customer's own L23.
    expect(queued[0]!.logType).toBe('ERROR_PROVISION');
    const text = render(queued[0]!);
    expect(text).toContain('ادمین: مدیر آزمایشی · @ops_lead · 700900100');
    expect(text).toContain('مشتری: نیما · @nima_t · 700100200');
    expect(text).toContain('🖥 پنل: پنل آزمایشی');
    expect(text).toContain(`❗ علت: ${words.refundReason('PANEL_REJECTED', null)}`);
    expect(text).not.toMatch(UUID);
  });

  it('falls back to the label the audit row captured when the administrator row is gone', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    facts.payments.set('ord-1', paymentFact('WALLET'));
    facts.origins.set('ord-1', adminActor);
    await new FailureLogConsumer({ lane, facts: ofFacts, words }).handle(refunded(), TX);
    expect(queued[0]!.templateKey).toBe('ops.log.error_provision_admin');
    expect(render(queued[0]!)).toContain(
      `ادمین: مدیر برچسب · ${words.noUsername} · ${words.noTelegram}`,
    );
  });

  it('is still the customer’s own L23 message for a purchase the customer made, and for an order with no audit row', async () => {
    for (const recorded of [origin(), origin({ surface: 'MINI_APP' }), null]) {
      const { facts, queued, lane, ofFacts } = setup();
      facts.payments.set('ord-1', paymentFact('WALLET'));
      if (recorded !== null) facts.origins.set('ord-1', recorded);
      facts.admins.set('adm-1', admin1);
      await new FailureLogConsumer({ lane, facts: ofFacts, words }).handle(refunded(), TX);
      expect(queued[0]!.templateKey).toBe('ops.log.error_provision');
      expect(render(queued[0]!)).not.toContain('ادمین:');
    }
  });

  it('an UNKNOWN outcome of an administrator’s service is the admin message too, and still refunds nothing', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    facts.payments.set('ord-1', paymentFact('WALLET'));
    facts.origins.set('ord-1', adminActor);
    facts.admins.set('adm-1', admin1);
    await new FailureLogConsumer({ lane, facts: ofFacts, words }).handle(
      event('ProvisioningOutcomeUnknown', 'svc-1', {
        serviceId: 'svc-1',
        panelId: 'pan-1',
        operationType: 'PROVISION',
        failureKind: 'TIMEOUT',
      }),
      TX,
    );
    expect(queued[0]!.templateKey).toBe('ops.log.error_provision_admin');
    expect(render(queued[0]!)).toContain(words.impact('pending'));
  });
});

describe('R9 C2 item 2 — an extra-volume gift that failed on the panel (L24)', () => {
  const giftOp = (overrides: Partial<OperationFact> = {}): OperationFact => ({
    id: 'op-gift',
    type: 'ADD_TRAFFIC',
    state: 'FAILED',
    serviceId: 'svc-1',
    orderId: null,
    requestedByCustomerId: null,
    panelId: 'pan-1',
    failureKind: 'TIMEOUT',
    failureMessage: 'HTTP 504 gateway timeout',
    targetExpiresAt: null,
    targetTrafficLimitBytes: 60n * GIB,
    completedAt: AT,
    ...overrides,
  });
  const clock: Clock = { now: () => AT };

  it('is an L24 report with the panel, the service username and the cause — and nothing refunded', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    facts.operations.set('op-gift', giftOp());
    await new OperationLog({ lane, facts: ofFacts, words, clock }).operationFailed(
      SCOPE,
      'op-gift',
      TX,
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]!.logType).toBe('ERROR_OPERATION');
    expect(queued[0]!.templateKey).toBe('ops.log.error_operation');
    expect(queued[0]!.dedupeKey).toBe('oplog:op-failed:op-gift');
    const text = render(queued[0]!);
    expect(text).toContain('افزودن حجم هدیه انجام نشد');
    expect(text).toContain('🔑 نام سرویس: nxtest01');
    expect(text).toContain('🖥 پنل: پنل آزمایشی');
    expect(text).toContain(`❗ علت: ${words.providerFailure('TIMEOUT')}`);
    expect(text).toContain('🔧 کد: TIMEOUT · HTTP 504');
    expect(text).toContain(words.impact('giftNotApplied'));
    expect(text).not.toContain('💰');
    expect(queued[0]!.storm).toMatchObject({ customer: '700100200' });
  });

  it('an abandoned gift is reported like a failed one', async () => {
    const { facts, queued, lane, ofFacts } = setup();
    facts.operations.set('op-gift', giftOp({ state: 'ABANDONED', failureKind: null }));
    await new OperationLog({ lane, facts: ofFacts, words, clock }).operationFailed(
      SCOPE,
      'op-gift',
      TX,
    );
    expect(queued).toHaveLength(1);
    expect(render(queued[0]!)).toContain(words.providerFailure(null));
  });

  it('is silent for everything that is not a free gift', async () => {
    const cases: [string, OperationFact][] = [
      [
        'a PURCHASED extra volume (it has an order: the refund report owns it)',
        giftOp({ orderId: 'ord-1' }),
      ],
      ['a gift of time', giftOp({ type: 'ADD_TIME' })],
      ['a renewal with no order', giftOp({ type: 'RENEW' })],
      ['an operation that is not terminal', giftOp({ state: 'IN_FLIGHT' })],
      ['a gift that succeeded', giftOp({ state: 'SUCCEEDED' })],
    ];
    for (const [name, operation] of cases) {
      const { facts, queued, lane, ofFacts } = setup();
      facts.operations.set('op-gift', operation);
      await new OperationLog({ lane, facts: ofFacts, words, clock }).operationFailed(
        SCOPE,
        'op-gift',
        TX,
      );
      expect(queued, name).toEqual([]);
    }
    // An imported service or customer is history: nobody is told.
    for (const mutate of [
      (f: FakeFacts) => f.services.set('svc-1', serviceFact({ source: 'MIRZA' })),
      (f: FakeFacts) => f.customers.set('cust-1', customerFact({ source: 'MIRZA' })),
    ]) {
      const { facts, queued, lane, ofFacts } = setup();
      facts.operations.set('op-gift', giftOp());
      mutate(facts);
      await new OperationLog({ lane, facts: ofFacts, words, clock }).operationFailed(
        SCOPE,
        'op-gift',
        TX,
      );
      expect(queued).toEqual([]);
    }
  });

  it('the outcome announcer reports a TERMINAL failure to the log and not a failure that will be retried', async () => {
    const calls: string[] = [];
    const hook = {
      operationSucceeded: async (_s: unknown, id: string) => void calls.push(`ok:${id}`),
      operationFailed: async (_s: unknown, id: string) => void calls.push(`failed:${id}`),
    };
    const uow = {
      run: async <T>(_scope: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
      runNested: async <T>(
        _scope: unknown,
        tx: unknown,
        fn: (tx: unknown) => Promise<T>,
      ): Promise<T> => fn(tx),
    };
    const subject = (state: string, nextAttemptAt: Date | null) => ({
      type: 'ADD_TRAFFIC',
      state,
      serviceId: 'svc-1',
      customerId: 'cust-1',
      requestedByCustomerId: null,
      nextAttemptAt,
    });
    for (const [state, next, expected] of [
      ['FAILED', null, ['failed:op-1']],
      ['ABANDONED', null, ['failed:op-1']],
      ['SUCCEEDED', null, ['ok:op-1']],
      ['FAILED', new Date('2026-10-12T10:00:00Z'), []],
    ] as const) {
      calls.length = 0;
      const announcer = new OperationOutcomeAnnouncer({
        reader: {
          subjectFor: async () => subject(state, next),
          dueForAnnouncement: async () => [],
        } as never,
        announcements: { markAnnounced: async () => undefined },
        notifier: { notify: async () => true } as never,
        uow: uow as never,
        clock: { now: () => AT },
        opsLog: hook as never,
      });
      await announcer.announce(SCOPE, 'op-1');
      expect(calls, `${state} / ${String(next)}`).toEqual(expected);
    }
  });
});

describe('R9 C2 items 3 and 5 — the nightly reports', () => {
  const reseller = (index: number) => ({
    telegramId: `7000${String(index)}`,
    username: index % 2 === 0 ? null : `shop${String(index)}`,
    name: `فروشگاه ${['صفر', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت'][index]!}`,
    sum: BigInt(1_000_000 - index * 100_000),
    count: index,
  });
  const panelsText = (data: NightlyReportData): string => {
    const panels = nightlyReports(data, words).find((one) => one.logType === 'REPORT_PANELS')!;
    return render(panels as never);
  };
  const summaryText = (data: NightlyReportData): string => {
    const summary = nightlyReports(data, words).find((one) => one.logType === 'REPORT_SUMMARY')!;
    return render(summary as never);
  };
  const withTop = (list: ReturnType<typeof reseller>[]): NightlyReportData =>
    reportData({
      resellers: { active: 3, salesSum: 900_000n, top: list[0] ?? null, topList: list },
    });

  it('L29 lists up to five resellers — id, username, total, order count — best first', () => {
    const text = panelsText(withTop([1, 2, 3, 4, 5].map(reseller)));
    expect(text).toContain(words.reportTopResellers);
    const lines = text.split('\n').filter((line) => /^[۱-۹]\./u.test(line));
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('۱. @shop1 · 70001 · ۹۰۰٬۰۰۰ تومان · ۱ سفارش');
    // No username: the name stands, the id still follows it.
    expect(lines[1]).toBe('۲. فروشگاه دو · 70002 · ۸۰۰٬۰۰۰ تومان · ۲ سفارش');
  });

  it('L29 never prints a sixth reseller, whatever it is handed', () => {
    const text = panelsText(withTop([1, 2, 3, 4, 5, 6, 7].map(reseller)));
    expect(text.split('\n').filter((line) => /^[۱-۹]\./u.test(line))).toHaveLength(5);
    expect(text).not.toContain('70006');
  });

  it('L29 leaves the block out entirely when no reseller sold — no heading, no empty line', () => {
    const built = nightlyReports(withTop([]), words).find(
      (one) => one.logType === 'REPORT_PANELS',
    )!;
    expect(built.values).not.toHaveProperty('topResellers');
    const text = render(built as never);
    expect(text).not.toContain(words.reportTopResellers);
    expect(text).not.toMatch(/\n\n\n/u);
    expect(text.trimEnd().split('\n').at(-1)).toContain(words.reportResellers);
  });

  it('L27 states the customers with and without an active service', () => {
    const text = summaryText(reportData());
    expect(text).toContain('🟢 مشتری دارای سرویس فعال: ۹۰');
    expect(text).toContain('⚪️ مشتری بدون سرویس فعال: ۳۰');
  });

  it('the L27 template description records the definition of an active customer', () => {
    const description = templateDefinition('ops.log.report_summary' as TemplateKey).description;
    expect(description).toMatch(/at least one service in the ACTIVE state now/);
    expect(description).toMatch(/INACTIVE is every other customer/);
  });
});
