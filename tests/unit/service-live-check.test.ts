import { describe, expect, it, vi } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  NexaError,
  SERVICE_PANEL_ACCOUNT_FOUND_CODE,
  SERVICE_PANEL_ACCOUNT_MISSING_CODE,
  resolvePanelPolicy,
  servicePanelAccountMissingKey,
  type ActorContext,
  type CorrelationId,
  type OperationalEventInput,
  type ProviderAdapter,
  type ProviderLookupOutcome,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { RickpanelAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel.adapter';
import {
  SERVICE_LIVE_CHECK_CACHE_MS,
  ServiceRefreshService,
  type ServiceRefreshDeps,
} from '../../apps/api/src/modules/commerce/provisioning/application/service-refresh.service';

/**
 * Track 3 §1 — the live panel check made when a customer opens a service card.
 *
 * Found, missing, timeout and rate-limited are four different answers, and each is pinned
 * here by what it writes, what it records and how many times the panel is asked. The
 * Telegram half (what each answer draws) is `tests/integration/customer-ux-services.test.ts`.
 */

const scope = { tenantId: 't-1', botInstanceId: null } as unknown as TenantContext;
const actor: ActorContext = {
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: 'c' as CorrelationId,
};
const input = { customerId: 'u-1' as UserId, serviceId: 's-1' };
const T0 = new Date('2026-10-18T10:00:00Z');

const FOUND: ProviderLookupOutcome = {
  ok: true,
  found: true,
  providerUserId: null,
  delivery: { kind: 'SUBSCRIPTION_LINK', url: 'https://panel.example.test/sub/x' },
  usage: {
    usedBytes: 5_368_709_120n,
    totalBytes: null,
    expiresAt: null,
    lastSeen: { kind: 'UNSUPPORTED' },
  },
};
const MISSING: ProviderLookupOutcome = { ok: true, found: false };
const TIMEOUT: ProviderLookupOutcome = { ok: false, failure: 'TIMEOUT', status: null };
const LIMITED: ProviderLookupOutcome = { ok: false, failure: 'RATE_LIMITED', status: 429 };
const BROKEN: ProviderLookupOutcome = { ok: false, failure: 'PROVIDER_ERROR', status: 500 };

interface Harness {
  readonly service: ServiceRefreshService;
  readonly lookup: ReturnType<typeof vi.fn>;
  readonly recordUsage: ReturnType<typeof vi.fn>;
  readonly recorded: OperationalEventInput[];
  readonly budget: ReturnType<typeof vi.fn>;
  readonly clock: { at: Date };
  readonly openConditions: Set<string>;
  readonly row: { usageSyncedAt: Date | null; state: string };
}

function harness(
  answers: readonly (ProviderLookupOutcome | 'HANG' | (() => ProviderLookupOutcome))[],
  options: {
    readonly supports?: boolean;
    readonly budgetPermits?: readonly boolean[];
    readonly usageSyncedAt?: Date | null;
    readonly timeoutMs?: number;
    readonly overrides?: Partial<ServiceRefreshDeps>;
  } = {},
): Harness {
  const clock = { at: T0 };
  const row = {
    usageSyncedAt:
      options.usageSyncedAt === undefined
        ? new Date(T0.getTime() - 10 * 60_000)
        : options.usageSyncedAt,
    state: 'ACTIVE',
  };
  const serviceRow = () => ({
    id: 's-1',
    panelId: 'p-1',
    state: row.state,
    providerUsername: 'user1',
    subscriptionRef: 'ref',
    providerClientId: 'cid',
    usageSyncedAt: row.usageSyncedAt,
  });
  let answer = 0;
  const lookup = vi.fn(async () => {
    const next = answers[Math.min(answer, answers.length - 1)];
    answer += 1;
    if (next === 'HANG' || next === undefined) return new Promise<never>(() => undefined);
    return typeof next === 'function' ? next() : next;
  });
  const rick = new RickpanelAdapter();
  const adapter = Object.assign(Object.create(rick) as ProviderAdapter, {
    supports: (capability: string) =>
      capability === 'READ_USAGE' ? (options.supports ?? true) : rick.supports(capability as never),
    lookupUser: lookup,
  });
  const recordUsage = vi.fn(async (_s: unknown, _id: string, usage: { syncedAt: Date }) => {
    row.usageSyncedAt = usage.syncedAt;
  });
  const recorded: OperationalEventInput[] = [];
  const openConditions = new Set<string>();
  let budgetCall = 0;
  const budget = vi.fn(async () => {
    const permitted = options.budgetPermits?.[budgetCall] ?? true;
    budgetCall += 1;
    return permitted
      ? { permitted: true as const, remaining: 5 }
      : { permitted: false as const, retryAfterMs: 1000 };
  });
  const deps: ServiceRefreshDeps = {
    services: { getForCustomer: vi.fn(async () => serviceRow() as never) },
    rows: {
      recordUsage: recordUsage as never,
      reserveUsageRefresh: vi.fn(async () => true),
      endUsageRefresh: vi.fn(async () => undefined),
    },
    inFlightMs: 60_000,
    panels: {
      find: vi.fn(async () => ({
        panel: {
          status: 'ACTIVE',
          providerType: 'rickpanel',
          baseUrl: 'https://panel.example.test',
          archivedAt: null,
          activation: {},
        },
        credentials: { usernameSetAt: T0, passwordSetAt: T0, apiTokenSetAt: null },
        health: null,
      })) as never,
      takeProbeBudget: budget as never,
    },
    credentials: {
      read: vi.fn(async () => ({ username: 'a', password: 'b', apiToken: null })) as never,
    },
    adapters: () => adapter,
    implementedProviderTypes: ['rickpanel', 'marzban', 'sanaei'],
    http: { forBase: () => ({ send: vi.fn() }) },
    urlPolicy: { allowLoopback: false, allowPrivate: true } as never,
    probeBudget: { capacity: 10, refillPerSecond: 1 } as never,
    backgroundBudgetReserve: 2,
    guard: { check: vi.fn(async () => undefined) } as never,
    scopeActivity: { scopeIsActive: vi.fn(async () => true) } as never,
    panelPolicy: { forPanel: vi.fn(async () => resolvePanelPolicy(null)) },
    uow: { run: async (_s: unknown, fn: (tx: unknown) => unknown) => fn({}) } as never,
    clock: { now: () => clock.at },
    opsEvents: {
      record: vi.fn(async (_s: unknown, event: OperationalEventInput) => {
        recorded.push(event);
        if (event.dedupeKey !== undefined) openConditions.add(event.dedupeKey);
        if (event.recoversDedupeKey !== undefined) openConditions.delete(event.recoversDedupeKey);
        return {} as never;
      }),
    },
    conditions: { conditionIsOpen: vi.fn(async (_s, key: string) => openConditions.has(key)) },
    ...(options.timeoutMs === undefined ? {} : { liveCheckTimeoutMs: options.timeoutMs }),
    ...options.overrides,
  };
  return {
    service: new ServiceRefreshService(deps),
    lookup,
    recordUsage,
    recorded,
    budget,
    clock,
    openConditions,
    row,
  };
}

describe('opening a card checks the panel live (Track 3 §1)', () => {
  it('found: writes the fresh figure and answers FRESH from the panel, one read', async () => {
    const h = harness([FOUND]);
    expect(await h.service.liveCheck(scope, actor, input)).toEqual({
      outcome: 'FRESH',
      source: 'PANEL',
    });
    expect(h.lookup).toHaveBeenCalledTimes(1);
    expect(h.recordUsage).toHaveBeenCalledTimes(1);
    expect(h.recordUsage.mock.calls[0]?.[2]).toMatchObject({ usedBytes: 5_368_709_120n });
    expect(h.recorded).toEqual([]);
    // Above the background floor, never from it.
    expect(h.budget.mock.calls[0]?.[4]).toBe(2);
  });

  it('missing: a SECOND read must agree; then the condition is recorded and nothing else', async () => {
    const h = harness([MISSING, MISSING]);
    expect(await h.service.liveCheck(scope, actor, input)).toEqual({
      outcome: 'MISSING_ON_PANEL',
      source: 'PANEL',
    });
    expect(h.lookup, 'confirmed by a second read').toHaveBeenCalledTimes(2);
    expect(h.budget, 'each read spends its own token').toHaveBeenCalledTimes(2);
    expect(h.budget.mock.calls[1]?.[4], 'the second also above the floor').toBe(2);
    expect(
      h.recordUsage,
      'no figure is written for an account that is not there',
    ).not.toHaveBeenCalled();
    expect(h.recorded).toEqual([
      expect.objectContaining({
        code: SERVICE_PANEL_ACCOUNT_MISSING_CODE,
        severity: 'ERROR',
        dedupeKey: servicePanelAccountMissingKey('s-1'),
        context: expect.objectContaining({ serviceId: 's-1', panelId: 'p-1' }),
      }),
    ]);
    expect(h.row.state, 'the service keeps its state').toBe('ACTIVE');
  });

  it('missing once, found on the confirming read: FRESH, and no condition', async () => {
    const h = harness([MISSING, FOUND]);
    expect(await h.service.liveCheck(scope, actor, input)).toEqual({
      outcome: 'FRESH',
      source: 'PANEL',
    });
    expect(h.recorded).toEqual([]);
    expect(h.recordUsage).toHaveBeenCalledTimes(1);
  });

  it('missing once, then a timeout: STALE TIMEOUT — never a missing verdict', async () => {
    const h = harness([MISSING, TIMEOUT]);
    expect(await h.service.liveCheck(scope, actor, input)).toEqual({
      outcome: 'STALE',
      reason: 'TIMEOUT',
    });
    expect(h.recorded).toEqual([]);
  });

  it('missing once and no token for the confirming read: STALE BUDGET, one read', async () => {
    const h = harness([MISSING, MISSING], { budgetPermits: [true, false] });
    expect(await h.service.liveCheck(scope, actor, input)).toEqual({
      outcome: 'STALE',
      reason: 'BUDGET',
    });
    expect(h.lookup).toHaveBeenCalledTimes(1);
    expect(h.recorded).toEqual([]);
  });

  it('timeout (the hard deadline): STALE TIMEOUT, nothing written or recorded', async () => {
    const h = harness(['HANG'], { timeoutMs: 30 });
    const started = Date.now();
    expect(await h.service.liveCheck(scope, actor, input)).toEqual({
      outcome: 'STALE',
      reason: 'TIMEOUT',
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(h.recordUsage).not.toHaveBeenCalled();
    expect(h.recorded).toEqual([]);
  });

  it('timeout (the client’s own): STALE TIMEOUT', async () => {
    const h = harness([TIMEOUT]);
    expect(await h.service.liveCheck(scope, actor, input)).toEqual({
      outcome: 'STALE',
      reason: 'TIMEOUT',
    });
  });

  it('rate limited by the panel: STALE RATE_LIMITED, kept apart from a timeout', async () => {
    const h = harness([LIMITED]);
    expect(await h.service.liveCheck(scope, actor, input)).toEqual({
      outcome: 'STALE',
      reason: 'RATE_LIMITED',
    });
    expect(h.lookup).toHaveBeenCalledTimes(1);
    expect(h.recorded).toEqual([]);
  });

  it('a panel error is PANEL_UNAVAILABLE; a spent budget dials nothing', async () => {
    expect(await harness([BROKEN]).service.liveCheck(scope, actor, input)).toEqual({
      outcome: 'STALE',
      reason: 'PANEL_UNAVAILABLE',
    });
    const spent = harness([FOUND], { budgetPermits: [false] });
    expect(await spent.service.liveCheck(scope, actor, input)).toEqual({
      outcome: 'STALE',
      reason: 'BUDGET',
    });
    expect(spent.lookup).not.toHaveBeenCalled();
  });

  it('cache hit: a figure read inside the window answers FRESH from the cache, no read', async () => {
    const h = harness([FOUND], {
      usageSyncedAt: new Date(T0.getTime() - SERVICE_LIVE_CHECK_CACHE_MS + 1_000),
    });
    expect(await h.service.liveCheck(scope, actor, input)).toEqual({
      outcome: 'FRESH',
      source: 'CACHE',
    });
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.budget).not.toHaveBeenCalled();
  });

  it('cache hit: a missing verdict stands for the window, then the panel is asked again', async () => {
    const h = harness([MISSING, MISSING, FOUND]);
    expect((await h.service.liveCheck(scope, actor, input)).outcome).toBe('MISSING_ON_PANEL');
    expect(h.lookup).toHaveBeenCalledTimes(2);

    h.clock.at = new Date(T0.getTime() + SERVICE_LIVE_CHECK_CACHE_MS - 1_000);
    expect(await h.service.liveCheck(scope, actor, input)).toEqual({
      outcome: 'MISSING_ON_PANEL',
      source: 'CACHE',
    });
    expect(h.lookup, 'repeated taps do not hammer the panel').toHaveBeenCalledTimes(2);

    // Past the window the panel is asked again — and the account is back: the open
    // condition is closed by its recovery, about this service only.
    h.clock.at = new Date(T0.getTime() + SERVICE_LIVE_CHECK_CACHE_MS + 1_000);
    expect(await h.service.liveCheck(scope, actor, input)).toEqual({
      outcome: 'FRESH',
      source: 'PANEL',
    });
    expect(h.lookup).toHaveBeenCalledTimes(3);
    expect(h.recorded.map((event) => event.code)).toEqual([
      SERVICE_PANEL_ACCOUNT_MISSING_CODE,
      SERVICE_PANEL_ACCOUNT_FOUND_CODE,
    ]);
    expect(h.recorded[1]).toMatchObject({
      recoversCode: SERVICE_PANEL_ACCOUNT_MISSING_CODE,
      recoversDedupeKey: servicePanelAccountMissingKey('s-1'),
    });
    expect(h.openConditions.size).toBe(0);
  });

  it('a found read records no recovery when no condition is open', async () => {
    const h = harness([FOUND]);
    await h.service.liveCheck(scope, actor, input);
    expect(h.recorded).toEqual([]);
  });

  it('a provider with no proven read is not asked: STALE UNSUPPORTED', async () => {
    const h = harness([FOUND], { supports: false });
    expect(await h.service.liveCheck(scope, actor, input)).toEqual({
      outcome: 'STALE',
      reason: 'UNSUPPORTED',
    });
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.budget).not.toHaveBeenCalled();
  });

  it('a service that is not theirs is NOT_FOUND, and dials nothing', async () => {
    const h = harness([FOUND], {
      overrides: {
        services: {
          getForCustomer: vi.fn(async () => {
            throw new NexaError({
              kind: 'NOT_FOUND',
              code: COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND,
              message: 'no',
            });
          }),
        },
      },
    });
    expect(await h.service.liveCheck(scope, actor, input)).toEqual({ outcome: 'NOT_FOUND' });
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it('a suspended service is NOT_READ, and dials nothing', async () => {
    const h = harness([FOUND]);
    h.row.state = 'SUSPENDED';
    expect(await h.service.liveCheck(scope, actor, input)).toEqual({ outcome: 'NOT_READ' });
    expect(h.lookup).not.toHaveBeenCalled();
  });
  /*
   * Codex on #291 (b): a first read that used up the whole deadline must not START a
   * confirming request — the remaining time is decided before the request exists.
   */
  it('a first read that spends the deadline starts no confirming request', async () => {
    const held: { harness?: Harness } = {};
    const h = harness(
      [
        () => {
          // The panel answered «not found» just as the deadline passed.
          if (held.harness !== undefined) held.harness.clock.at = new Date(T0.getTime() + 2_000);
          return MISSING;
        },
        MISSING,
      ],
      { timeoutMs: 1_500 },
    );
    held.harness = h;
    expect(await h.service.liveCheck(scope, actor, input)).toEqual({
      outcome: 'STALE',
      reason: 'TIMEOUT',
    });
    expect(h.lookup, 'no detached second request').toHaveBeenCalledTimes(1);
    expect(h.recorded).toEqual([]);
  });

  /*
   * Codex on #291 (a): a figure some OTHER writer made fresh (the scheduled sync) is not
   * trusted while this service's missing-account condition is open — the panel is read,
   * and the read closes the condition.
   */
  it('a fresh cached figure is not trusted while the missing condition is open', async () => {
    const h = harness([FOUND], {
      usageSyncedAt: new Date(T0.getTime() - 1_000),
    });
    h.openConditions.add(servicePanelAccountMissingKey('s-1'));
    expect(await h.service.liveCheck(scope, actor, input)).toEqual({
      outcome: 'FRESH',
      source: 'PANEL',
    });
    expect(h.lookup).toHaveBeenCalledTimes(1);
    expect(h.recorded.map((event) => event.code)).toEqual([SERVICE_PANEL_ACCOUNT_FOUND_CODE]);
    expect(h.openConditions.size).toBe(0);
  });
});
