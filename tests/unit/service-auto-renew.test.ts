import { describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  errors,
  isNexaError,
  money,
  serviceCardSlotOf,
  type ActorContext,
  type Money,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import {
  autoRenewDue,
  autoRenewEligible,
  ServiceAutoRenewService,
  type ServiceAutoRenewDeps,
} from '../../apps/api/src/modules/commerce/provisioning/application/service-auto-renew.service';
import type {
  AutoRenewCandidate,
  AutoRenewPreference,
  AutoRenewRepository,
  AutoRenewRun,
} from '../../apps/api/src/modules/commerce/provisioning/application/service-auto-renew.ports';
import { sourceOf } from '../../apps/api/src/modules/commerce/ops-log/application/presenters';
import { notificationButtons } from '../../apps/api/src/surfaces/telegram/runtime/keyboards';
import {
  decodeAutoRenewConfirm,
  encodeAutoRenewConfirm,
  SERVICE_AUTO_RENEW_ASK_CALLBACK_PREFIX,
  SERVICE_AUTO_RENEW_CONFIRM_CALLBACK_PREFIX,
  SERVICE_AUTO_RENEW_OFF_CALLBACK_PREFIX,
} from '../../apps/api/src/surfaces/telegram/runtime/callbacks';

/**
 * Round 10, D1 — automatic renewal, the rules that need no database: the due window, who is
 * offered it, the sweep's decisions over fakes of the very services it calls (the renewal's
 * quote, draft, confirmation and wallet settlement), the customer's switch, and the
 * «منبع: تمدید خودکار» source line. The database half (the unique period, the SQL candidate
 * filter, two concurrent passes) is `tests/integration/service-auto-renew.test.ts`.
 *
 * MUTATIONS, each turns a named case red:
 * - `autoRenewDue` `at < expires` -> `<=`: "is due inside [deadline − lead, deadline) only".
 * - `markRenewed` dropped from the settlement hook: "renews a covered period …".
 * - the `marked` check ignored: "a pass that lost its claim debits nothing".
 * - `markNotified` gate removed in `finish`: "tells a short wallet once per period".
 * - the quote-above-consent check removed: "does not renew above the consented total".
 * - the in-settlement flag re-read removed: "a switch turned off before the money moves …".
 * - the in-settlement ceiling removed: "a consent lowered below the order …".
 * - the in-settlement owner test removed: "another customer’s consent is not this owner’s".
 *   (`!preference.enabled` alone is an equivalent mutant: the table's consent CHECK makes a
 *   disabled row carry no total, which the `consented === null` test refuses.)
 * - the flag read removed from `runOnce`: "claims nothing while the feature is off".
 * - `autoRenewEligible` MIRZA test removed: "imported services are never offered it".
 *
 * Codex review of PR 338 (each run and seen red, then restored):
 * - `set`'s shown-total check removed: "records nothing above the total the confirmation
 *   showed …".
 * - `runOnce` reading one page only (`break` after the first): "a short wallet still short does
 *   not starve a covered service behind it".
 * - `withdrawLeftBehind` not called: "a takeover withdraws the order its stopped pass left …".
 * - its ORDER_STATE_INVALID pass-through removed: "… an order no longer awaiting payment is
 *   nothing to withdraw".
 * - the in-settlement `periodCurrent` check removed: "a period renewed by hand since the claim
 *   is never bought again".
 */

const scope = { tenantId: 't-1', botInstanceId: null } as unknown as TenantContext;
const SERVICE = '01900000-0000-7000-8000-0000000000a1';
const CUSTOMER = '01900000-0000-7000-8000-0000000000c1' as UserId;
const IRT = (amount: bigint): Money => money(amount, 'IRT');
const HOUR = 3_600_000;
const NOW = new Date('2026-10-26T10:00:00Z');

describe('the due window and who is offered it', () => {
  const deadline = new Date(NOW.getTime() + 24 * HOUR);
  it('is due inside [deadline − lead, deadline) only', () => {
    expect(autoRenewDue(deadline, new Date(deadline.getTime() - 24 * HOUR), 24)).toBe(true);
    expect(autoRenewDue(deadline, new Date(deadline.getTime() - 24 * HOUR - 1), 24)).toBe(false);
    expect(autoRenewDue(deadline, new Date(deadline.getTime() - 1), 24)).toBe(true);
    // At the deadline itself the service has lapsed: it is not renewed after the fact.
    expect(autoRenewDue(deadline, deadline, 24)).toBe(false);
    expect(autoRenewDue(null, NOW, 24)).toBe(false);
  });

  const service = {
    source: 'NEXA' as const,
    productId: 'p-1' as never,
    expiresAt: NOW,
    state: 'ACTIVE' as const,
  };
  it('imported services are never offered it; neither is one with no product or deadline', () => {
    expect(autoRenewEligible(service)).toBe(true);
    expect(autoRenewEligible({ ...service, source: 'MIRZA' })).toBe(false);
    expect(autoRenewEligible({ ...service, productId: null })).toBe(false);
    expect(autoRenewEligible({ ...service, expiresAt: null })).toBe(false);
    expect(autoRenewEligible({ ...service, state: 'SUSPENDED' })).toBe(false);
  });
});

describe('the surfaces', () => {
  it('names a renewal the worker made «تمدید خودکار», decided by the run, not the surface', () => {
    const words = { sourceName: (source: string) => source } as never;
    expect(sourceOf('SCHEDULER', words, true)).toBe('AUTO_RENEW');
    expect(sourceOf('MINI_APP', words, true)).toBe('AUTO_RENEW');
    expect(sourceOf('SCHEDULER', words)).toBe('BOT');
    expect(sourceOf('MINI_APP', words)).toBe('MINI_APP');
  });

  it('places both switches in one card slot, named by the ON button', () => {
    expect(serviceCardSlotOf('service.auto_renew_enable')).toBe('service.auto_renew_enable');
    expect(serviceCardSlotOf('service.auto_renew_disable')).toBe('service.auto_renew_enable');
    expect(serviceCardSlotOf('service.auto_renew_confirm')).toBeNull();
  });

  it('uses three distinct prefixes, none a prefix of another', () => {
    const prefixes = [
      SERVICE_AUTO_RENEW_ASK_CALLBACK_PREFIX,
      SERVICE_AUTO_RENEW_CONFIRM_CALLBACK_PREFIX,
      SERVICE_AUTO_RENEW_OFF_CALLBACK_PREFIX,
    ];
    expect(new Set(prefixes).size).toBe(3);
    for (const a of prefixes) {
      for (const b of prefixes) if (a !== b) expect(b.startsWith(a)).toBe(false);
    }
  });

  it('offers the wallet on a short-wallet notice and the service on a price notice', () => {
    expect(notificationButtons('SERVICE_AUTO_RENEW_FUNDS_SHORT', { serviceId: SERVICE })).toEqual([
      expect.objectContaining({ inline: 'wallet.open' }),
    ]);
    const price = notificationButtons('SERVICE_AUTO_RENEW_PRICE_CHANGED', { serviceId: SERVICE });
    expect(price).toHaveLength(1);
    expect(price[0]).toMatchObject({ data: expect.stringContaining(SERVICE) as unknown });
  });
});

// ---------------------------------------------------------------------------
// The sweep and the switch, over fakes of the services it calls
// ---------------------------------------------------------------------------

interface World {
  balance: bigint;
  quote: bigint;
  /** What the draft's own quote says; the renewal quote unless set. */
  draftTotal: bigint | null;
  flag: boolean;
  preference: AutoRenewPreference | null;
  runs: AutoRenewRun[];
  notified: Set<string>;
  notices: { kind: string; subject: string }[];
  debits: { orderId: string; key: string }[];
  calls: string[];
  keys: string[];
  namespaces: string[];
  cancels: string[];
  events: { eventType: string; payload: Record<string, unknown> }[];
  /** Hook run when the order is confirmed: a race the test arranges. */
  onConfirm: (() => void) | null;
  settleError: Error | null;
  serviceSource: 'NEXA' | 'MIRZA';
  saved: { enabled: boolean; consented: Money | null }[];
  ignoreMarked: boolean;
  /** Whether the service's deadline is still the claimed period's (`periodCurrent`). */
  periodCurrent: boolean;
  /** This lane's unpaid orders for the service, left by a pass that stopped. */
  leftOrders: string[];
  /** What withdrawing an order answers; null is success. */
  cancelError: ((orderId: string) => Error | null) | null;
}

function world(overrides: Partial<World> = {}): World {
  return {
    balance: 200_000n,
    quote: 100_000n,
    draftTotal: null,
    flag: true,
    preference: {
      serviceId: SERVICE,
      customerId: CUSTOMER,
      enabled: true,
      consented: IRT(100_000n),
      source: 'TELEGRAM',
      updatedAt: NOW,
    },
    runs: [],
    notified: new Set(),
    notices: [],
    debits: [],
    calls: [],
    keys: [],
    namespaces: [],
    cancels: [],
    events: [],
    onConfirm: null,
    settleError: null,
    serviceSource: 'NEXA',
    saved: [],
    ignoreMarked: false,
    periodCurrent: true,
    leftOrders: [],
    cancelError: null,
    ...overrides,
  };
}

function repository(w: World): AutoRenewRepository {
  const find = (id: string) => w.runs.find((run) => run.id === id);
  const replace = (next: AutoRenewRun) => {
    w.runs = w.runs.map((run) => (run.id === next.id ? next : run));
  };
  return {
    preferenceOf: async () => w.preference,
    savePreference: async (_scope, input) => {
      w.saved.push({ enabled: input.enabled, consented: input.consented });
      w.preference = {
        serviceId: input.serviceId,
        customerId: input.customerId,
        enabled: input.enabled,
        consented: input.consented,
        source: input.source,
        updatedAt: input.now,
      };
      return true;
    },
    listDue: async (_scope, bounds) => {
      w.calls.push('listDue');
      // One service: a second page is empty.
      if (bounds.after !== undefined && bounds.after !== null) return [];
      if (w.preference === null || !w.preference.enabled || w.preference.consented === null) {
        return [];
      }
      const run = w.runs[0];
      // A final period (RENEWED, REFUSED) is no candidate; a short or lapsed one is.
      if (run !== undefined && run.state !== 'FUNDS_SHORT' && run.state !== 'CLAIMED') return [];
      const candidate: AutoRenewCandidate = {
        cursor: { expiresAt: 'basis', serviceId: SERVICE },
        serviceId: SERVICE,
        customerId: CUSTOMER,
        serviceLabel: 'nx-auto',
        consented: w.preference.consented,
        run:
          run === undefined
            ? null
            : {
                id: run.id,
                state: run.state as 'FUNDS_SHORT' | 'CLAIMED',
                attempt: run.attempt,
                quoted: run.quoted,
              },
      };
      return [candidate];
    },
    claimNew: async (_scope, input) => {
      if (w.runs.length > 0) return null;
      const run: AutoRenewRun = {
        id: input.id,
        serviceId: input.serviceId,
        customerId: input.customerId,
        attempt: 1,
        state: 'CLAIMED',
        consented: input.consented,
        quoted: null,
        serviceLabel: input.serviceLabel,
        basisExpiresAt: new Date(NOW.getTime() + 12 * HOUR),
      };
      w.runs.push(run);
      return run;
    },
    reclaim: async (_scope, input) => {
      const run = find(input.runId);
      if (run === undefined || run.state !== input.from || run.attempt !== input.attempt) {
        return null;
      }
      const next = { ...run, state: 'CLAIMED' as const, attempt: run.attempt + 1 };
      replace(next);
      return next;
    },
    markRenewed: async (_scope, input) => {
      const run = find(input.runId);
      if (run === undefined || run.state !== 'CLAIMED' || run.attempt !== input.attempt) {
        return false;
      }
      replace({ ...run, state: 'RENEWED', quoted: input.quoted });
      return true;
    },
    markUnrenewed: async (_scope, input) => {
      const run = find(input.runId);
      if (run === undefined || run.state !== 'CLAIMED' || run.attempt !== input.attempt) {
        return false;
      }
      replace({ ...run, state: input.to, quoted: input.quoted ?? run.quoted });
      return true;
    },
    markNotified: async (_scope, runId) => {
      if (w.notified.has(runId)) return false;
      w.notified.add(runId);
      return true;
    },
    noticeFacts: async () => null,
    renewedOrder: async () => false,
    periodCurrent: async () => w.periodCurrent,
    unpaidLaneOrders: async () => w.leftOrders,
  };
}

let seq = 0;
function sweep(w: World, extra: Partial<ServiceAutoRenewDeps> = {}): ServiceAutoRenewService {
  const order = (id: string, state: string, total: bigint) => ({
    id,
    state,
    customerId: CUSTOMER,
    purpose: 'RENEW',
    totals: { total: IRT(total), currency: 'IRT' },
  });
  return new ServiceAutoRenewService({
    repository: repository(w),
    services: {
      findForCustomer: async () =>
        ({
          id: SERVICE,
          customerId: CUSTOMER,
          source: w.serviceSource,
          productId: 'p-1',
          expiresAt: new Date(NOW.getTime() + 12 * HOUR),
          state: 'ACTIVE',
        }) as never,
    },
    commercial: {
      renewalQuote: async () => {
        w.calls.push('quote');
        return { total: IRT(w.quote), productId: 'p-1' as never };
      },
      draft: async (_scope, _actor, _customer, input, authority) => {
        w.calls.push('draft');
        w.keys.push(input.idempotencyKey);
        w.namespaces.push(authority?.namespace ?? 'TELEGRAM');
        return {
          order: order(`order:${input.idempotencyKey}`, 'DRAFT', w.draftTotal ?? w.quote),
        } as never;
      },
      confirm: async (_scope, _actor, _customer, input, authority) => {
        w.calls.push('confirm');
        w.keys.push(input.idempotencyKey);
        w.namespaces.push(authority?.namespace ?? 'TELEGRAM');
        w.onConfirm?.();
        return order(input.orderId, 'AWAITING_PAYMENT', w.draftTotal ?? w.quote) as never;
      },
    },
    orders: {
      cancelByCustomer: async (_scope, _actor, input) => {
        w.calls.push(`cancel:${input.idempotencyKey}`);
        const refused = w.cancelError?.(input.orderId) ?? null;
        if (refused !== null) throw refused;
        w.cancels.push(input.orderId);
        return {} as never;
      },
    },
    payments: {
      settleFromWallet: async (_scope, _actor, _customer, intent, authority) => {
        w.calls.push('settle');
        w.keys.push(intent.idempotencyKey);
        w.namespaces.push(authority?.namespace ?? 'TELEGRAM');
        if (w.settleError !== null) throw w.settleError;
        const total = w.draftTotal ?? w.quote;
        if (w.balance < total) {
          throw errors.conflict(COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS, 'short');
        }
        const settled = {
          order: order(intent.orderId, 'PAID', total),
          payment: { id: `pay:${intent.orderId}` },
        } as never;
        // The hook runs in the settling transaction: a throw rolls the debit back.
        await authority?.inTransaction?.({} as never, settled);
        w.debits.push({ orderId: intent.orderId, key: intent.idempotencyKey });
        w.balance -= total;
        return settled;
      },
    },
    wallet: { balanceOf: async () => ({ amountMinor: w.balance, currency: 'IRT' }) },
    features: { isEnabled: async () => w.flag },
    settings: { valueOf: async <T>() => 24 as T },
    notifier: {
      notify: async (_scope, _customer, kind, subject) => {
        w.notices.push({ kind, subject });
        return true;
      },
    },
    guard: { check: async () => undefined } as never,
    audit: { record: async () => undefined } as never,
    opsLog: { record: async () => undefined } as never,
    sessions: {} as never,
    idempotency: { find: async () => null, remember: async () => true } as never,
    outbox: {
      write: async (_tx: unknown, _actor: unknown, event: never) => {
        w.events.push(event);
      },
    } as never,
    scopeActivity: { scopeIsActive: async () => true },
    uow: {
      run: async (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}),
    } as never,
    clock: { now: () => NOW },
    ids: { uuid: () => `run-${String(++seq)}` } as never,
    ...extra,
  });
}

describe('the sweep', () => {
  it('renews a covered period through the customer’s own commands, in the SCHEDULER namespace', async () => {
    const w = world();
    expect(await sweep(w).runOnce(scope)).toEqual({ renewed: 1, short: 0, refused: 0 });
    const run = w.runs[0];
    expect(run?.state).toBe('RENEWED');
    expect(w.debits).toHaveLength(1);
    expect(w.keys).toEqual([
      `autorenew:${run?.id}:1:draft`,
      `autorenew:${run?.id}:1:confirm`,
      `autorenew:${run?.id}:1:settle`,
    ]);
    expect(new Set(w.namespaces)).toEqual(new Set(['SCHEDULER']));
    expect(w.events.map((event) => event.payload['outcome'])).toEqual(['RENEWED']);
    expect(w.notices).toEqual([]);
    // A later pass finds the period final: nothing more is bought.
    await sweep(w).runOnce(scope);
    expect(w.debits).toHaveLength(1);
  });

  it('claims nothing while the feature is off', async () => {
    const w = world({ flag: false });
    expect(await sweep(w).runOnce(scope)).toEqual({ renewed: 0, short: 0, refused: 0 });
    expect(w.calls).not.toContain('listDue');
    expect(w.runs).toEqual([]);
  });

  it('tells a short wallet once per period, creates no order, and renews once it is topped up', async () => {
    const w = world({ balance: 40_000n });
    expect((await sweep(w).runOnce(scope)).short).toBe(1);
    expect(w.calls).not.toContain('draft');
    expect(w.runs[0]?.state).toBe('FUNDS_SHORT');
    expect(w.notices).toEqual([{ kind: 'SERVICE_AUTO_RENEW_FUNDS_SHORT', subject: w.runs[0]?.id }]);

    // Still short: not even re-tried, and nobody is told again.
    await sweep(w).runOnce(scope);
    expect(w.calls.filter((call) => call === 'quote')).toHaveLength(1);
    expect(w.notices).toHaveLength(1);

    // Topped up, then the money goes elsewhere between the pre-check and the settlement:
    // short again, the order withdrawn, still ONE notice for the period.
    w.balance = 100_000n;
    w.onConfirm = () => {
      w.balance = 10_000n;
    };
    expect((await sweep(w).runOnce(scope)).short).toBe(1);
    expect(w.runs[0]?.attempt).toBe(2);
    expect(w.cancels).toHaveLength(1);
    expect(w.notices).toHaveLength(1);
    expect(w.debits).toEqual([]);

    // Topped up for real: the next attempt renews, with keys of its own.
    w.onConfirm = null;
    w.balance = 150_000n;
    expect((await sweep(w).runOnce(scope)).renewed).toBe(1);
    expect(w.runs[0]?.attempt).toBe(3);
    expect(w.debits).toEqual([
      expect.objectContaining({ key: `autorenew:${w.runs[0]?.id}:3:settle` }),
    ]);
    expect(w.notices).toHaveLength(1);
  });

  it('does not renew above the consented total, and says so once', async () => {
    const w = world({ quote: 130_000n });
    expect((await sweep(w).runOnce(scope)).refused).toBe(1);
    expect(w.calls).not.toContain('draft');
    expect(w.runs[0]?.state).toBe('REFUSED');
    expect(w.notices).toEqual([
      { kind: 'SERVICE_AUTO_RENEW_PRICE_CHANGED', subject: w.runs[0]?.id },
    ]);
    expect(w.events.map((event) => event.payload['refusal'])).toEqual(['PRICE_ROSE']);
  });

  it('honours the order’s own quote: above the consent, the draft is never confirmed', async () => {
    const w = world({ draftTotal: 100_001n });
    expect((await sweep(w).runOnce(scope)).refused).toBe(1);
    expect(w.calls).not.toContain('confirm');
    expect(w.calls).not.toContain('settle');
    expect(w.debits).toEqual([]);
  });

  it('a consent withdrawn before the money moves is a refusal, never a charge', async () => {
    const w = world();
    w.onConfirm = () => {
      w.preference = { ...(w.preference as AutoRenewPreference), enabled: false, consented: null };
    };
    expect((await sweep(w).runOnce(scope)).refused).toBe(1);
    expect(w.debits).toEqual([]);
    expect(w.cancels).toHaveLength(1);
    expect(w.events.map((event) => event.payload['refusal'])).toEqual(['CONSENT_WITHDRAWN']);
    expect(w.notices).toEqual([]);
  });

  it('a consent lowered below the order before the money moves is a refusal, never a charge', async () => {
    const w = world();
    // Switched off and on again at a lower price while this pass was between its steps.
    w.onConfirm = () => {
      w.preference = { ...(w.preference as AutoRenewPreference), consented: IRT(90_000n) };
    };
    expect((await sweep(w).runOnce(scope)).refused).toBe(1);
    expect(w.debits).toEqual([]);
    expect(w.runs[0]?.state).toBe('REFUSED');
  });

  it('another customer’s consent is not this owner’s: no charge', async () => {
    const w = world();
    w.onConfirm = () => {
      w.preference = {
        ...(w.preference as AutoRenewPreference),
        customerId: '01900000-0000-7000-8000-0000000000c2' as UserId,
      };
    };
    await sweep(w).runOnce(scope);
    expect(w.debits).toEqual([]);
  });

  it('a switch turned off before the money moves is a refusal too', async () => {
    const w = world();
    w.onConfirm = () => {
      w.flag = false;
    };
    await sweep(w).runOnce(scope);
    expect(w.debits).toEqual([]);
    expect(w.runs[0]?.state).toBe('REFUSED');
  });

  it('a pass that lost its claim debits nothing; the period is left for a later pass', async () => {
    const w = world();
    // Another pass takes the claim over while this one is between confirm and settle.
    w.onConfirm = () => {
      w.runs = w.runs.map((run) => ({ ...run, attempt: run.attempt + 1 }));
    };
    const report = await sweep(w).runOnce(scope);
    expect(report).toEqual({ renewed: 0, short: 0, refused: 0 });
    expect(w.debits).toEqual([]);
    expect(w.runs[0]?.state).toBe('CLAIMED');
    // The order it confirmed is withdrawn, not left awaiting a payment nobody chose to make.
    expect(w.cancels).toHaveLength(1);
    expect(w.events).toEqual([]);
  });

  // --- Codex review of PR 338 ----------------------------------------------------------

  it('a period renewed by hand since the claim is never bought again', async () => {
    // The customer's own renewal was applied between the claim and the settlement.
    const w = world({ periodCurrent: false });
    expect((await sweep(w).runOnce(scope)).refused).toBe(1);
    expect(w.calls).toContain('settle');
    expect(w.debits).toEqual([]);
    expect(w.cancels).toHaveLength(1);
    expect(w.runs[0]?.state).toBe('REFUSED');
    expect(w.events.map((event) => event.payload['refusal'])).toEqual(['NOT_RENEWABLE']);
    expect(w.notices).toEqual([]);
  });

  it('a short wallet still short does not starve a covered service behind it', async () => {
    const OTHER = '01900000-0000-7000-8000-0000000000a2';
    const w = world({ balance: 150_000n });
    const candidates: AutoRenewCandidate[] = [
      {
        cursor: { expiresAt: 'first', serviceId: OTHER },
        serviceId: OTHER,
        customerId: CUSTOMER,
        serviceLabel: 'nx-short',
        consented: IRT(1_000_000n),
        // Told last pass; the wallet still does not cover what was quoted then.
        run: { id: 'run-short', state: 'FUNDS_SHORT', attempt: 1, quoted: IRT(999_999n) },
      },
      {
        cursor: { expiresAt: 'second', serviceId: SERVICE },
        serviceId: SERVICE,
        customerId: CUSTOMER,
        serviceLabel: 'nx-auto',
        consented: IRT(100_000n),
        run: null,
      },
    ];
    const pages: (string | null)[] = [];
    const listDue: AutoRenewRepository['listDue'] = async (_scope, bounds, limit) => {
      const after = bounds.after ?? null;
      pages.push(after?.expiresAt ?? null);
      const from =
        after === null
          ? 0
          : candidates.findIndex((one) => one.cursor.expiresAt === after.expiresAt) + 1;
      return candidates.slice(from, from + limit);
    };
    const report = await sweep(w, {
      repository: { ...repository(w), listDue },
      batchLimit: 1,
    }).runOnce(scope);
    expect(report.renewed).toBe(1);
    expect(pages).toEqual([null, 'first']);
    expect(w.runs.map((run) => [run.serviceId, run.state])).toEqual([[SERVICE, 'RENEWED']]);
  });

  it('a takeover withdraws the order its stopped pass left, before drafting its own', async () => {
    const w = world({ leftOrders: ['order-left'] });
    // A pass claimed the period, confirmed its order and stopped; its lease lapsed.
    w.runs = [
      {
        id: 'run-left',
        serviceId: SERVICE,
        customerId: CUSTOMER,
        attempt: 1,
        state: 'CLAIMED',
        consented: IRT(100_000n),
        quoted: null,
        serviceLabel: 'nx-auto',
        basisExpiresAt: new Date(NOW.getTime() + 12 * HOUR),
      },
    ];
    expect((await sweep(w).runOnce(scope)).renewed).toBe(1);
    expect(w.cancels).toEqual(['order-left']);
    const withdrawn = w.calls.indexOf('cancel:autorenew:run-left:2:withdraw:order-left');
    expect(withdrawn).toBeGreaterThan(-1);
    expect(withdrawn).toBeLessThan(w.calls.indexOf('draft'));
    expect(w.debits).toEqual([expect.objectContaining({ key: 'autorenew:run-left:2:settle' })]);
  });

  it('… an order no longer awaiting payment is nothing to withdraw', async () => {
    const w = world({
      leftOrders: ['order-paid'],
      cancelError: () => errors.conflict(COMMERCE_ERROR_CODES.ORDER_STATE_INVALID, 'paid'),
    });
    expect((await sweep(w).runOnce(scope)).renewed).toBe(1);
  });

  it('… one the customer is paying right now stops the attempt: nothing drafted, nothing debited', async () => {
    const w = world({
      leftOrders: ['order-transfer'],
      cancelError: () =>
        errors.conflict(COMMERCE_ERROR_CODES.ORDER_TRANSFER_UNDER_REVIEW, 'under review'),
    });
    expect(await sweep(w).runOnce(scope)).toEqual({ renewed: 0, short: 0, refused: 0 });
    expect(w.calls).not.toContain('quote');
    expect(w.calls).not.toContain('draft');
    expect(w.debits).toEqual([]);
    // Left CLAIMED: a later pass takes it over once the payment is decided.
    expect(w.runs[0]?.state).toBe('CLAIMED');
  });

  it('a renewal the service refuses is not retried as a renewal and sends no extra message', async () => {
    const w = world({
      settleError: errors.conflict(COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED, 'no'),
    });
    expect((await sweep(w).runOnce(scope)).refused).toBe(1);
    expect(w.cancels).toHaveLength(1);
    expect(w.notices).toEqual([]);
    expect(w.events.map((event) => event.payload['refusal'])).toEqual(['NOT_RENEWABLE']);
  });
});

describe('the customer’s switch', () => {
  const actor = {
    type: 'SYSTEM_JOB',
    id: null,
    label: 'telegram-update:test',
    surface: 'TELEGRAM',
    correlationId: 'c' as never,
  } satisfies ActorContext;
  const set = (w: World, enabled: boolean, expected: Money | null = IRT(w.quote)) =>
    sweep(w).set(scope, actor, CUSTOMER, {
      serviceId: SERVICE,
      enabled,
      expected,
      idempotencyKey: 'k',
    });
  const code = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return isNexaError(error) ? error.code : String(error);
    }
  };

  it('records the renewal quote as the consented total', async () => {
    const w = world({ preference: null, quote: 120_000n });
    const state = await set(w, true);
    expect(state).toMatchObject({ enabled: true, price: IRT(120_000n) });
    expect(w.saved).toEqual([{ enabled: true, consented: IRT(120_000n) }]);
    expect(w.events.map((event) => event.eventType)).toEqual(['ServiceAutoRenewChanged']);
  });

  it('records nothing above the total the confirmation showed, and offers the new price', async () => {
    // Shown 100 000; the price rose to 120 000 before the tap.
    const w = world({ preference: null, quote: 120_000n });
    expect(await set(w, true, IRT(100_000n))).toEqual({
      offered: true,
      enabled: false,
      price: IRT(120_000n),
      leadHours: 24,
    });
    expect(w.saved).toEqual([]);
    expect(w.events).toEqual([]);
    // A tap naming no figure (a card drawn before the rule), or another currency: nothing.
    expect((await set(w, true, null)).enabled).toBe(false);
    expect((await set(w, true, money(500_000n, 'IRR'))).enabled).toBe(false);
    expect(w.saved).toEqual([]);
    // Confirmed again at the new figure: recorded, at the server's quote.
    expect((await set(w, true, IRT(120_000n))).enabled).toBe(true);
    expect(w.saved).toEqual([{ enabled: true, consented: IRT(120_000n) }]);
  });

  it('a quote that fell is recorded as the lower quote, never the figure shown', async () => {
    const w = world({ preference: null, quote: 90_000n });
    expect((await set(w, true, IRT(100_000n))).price).toEqual(IRT(90_000n));
    expect(w.saved).toEqual([{ enabled: true, consented: IRT(90_000n) }]);
  });

  it('the bot’s confirm carries the figure it showed; a bare or malformed one decodes safely', () => {
    const data = encodeAutoRenewConfirm(SERVICE, IRT(123_456n));
    expect(data).toBe(`${SERVICE_AUTO_RENEW_CONFIRM_CALLBACK_PREFIX}${SERVICE}.123456.IRT`);
    expect(decodeAutoRenewConfirm(data)).toEqual({ serviceId: SERVICE, shown: IRT(123_456n) });
    // The widest figure the decoder accepts still fits Telegram's 64 bytes.
    const widest = encodeAutoRenewConfirm(SERVICE, money(999_999_999_999_999_999n, 'USDT'));
    expect(Buffer.byteLength(widest)).toBeLessThanOrEqual(64);
    expect(decodeAutoRenewConfirm(widest)?.shown).toEqual(money(999_999_999_999_999_999n, 'USDT'));
    expect(decodeAutoRenewConfirm(`ay:${SERVICE}`)).toEqual({ serviceId: SERVICE, shown: null });
    for (const bad of [
      `ay:${SERVICE}.`,
      `ay:${SERVICE}.01.IRT`,
      `ay:${SERVICE}.-1.IRT`,
      `ay:${SERVICE}.1e3.IRT`,
      `ay:${SERVICE}.1.XYZ`,
      `ay:${SERVICE}.1.IRT.9`,
      `ay:${SERVICE}.1234567890123456789.IRT`,
      'ay:not-a-service.1.IRT',
    ]) {
      expect(decodeAutoRenewConfirm(bad), bad).toBeNull();
    }
  });

  it('cannot be switched on while the feature is off, and can always be switched off', async () => {
    const w = world({ preference: null, flag: false });
    expect(await code(set(w, true))).toBe(COMMERCE_ERROR_CODES.AUTO_RENEW_DISABLED);
    expect(w.saved).toEqual([]);
    expect(await code(set(w, false))).toBeNull();
    expect(w.saved).toEqual([{ enabled: false, consented: null }]);
  });

  it('is not available for an imported service, and records nothing', async () => {
    const w = world({ preference: null, serviceSource: 'MIRZA' });
    expect(await code(set(w, true))).toBe(COMMERCE_ERROR_CODES.AUTO_RENEW_NOT_AVAILABLE);
    expect(w.saved).toEqual([]);
    expect(w.calls).not.toContain('quote');
  });
});
