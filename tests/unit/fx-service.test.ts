import { describe, expect, it } from 'vitest';
import type {
  ActorContext,
  FxBaseAsset,
  FxSource,
  OperationalEventInput,
  TenantContext,
} from '@nexa/contracts';
import {
  FX_FALLBACK_IN_USE_CODE,
  FX_QUOTE_REJECTED_CODE,
  FX_QUOTE_UNAVAILABLE_CODE,
  FX_RATE_LIMIT_COOLDOWN_MS,
  FX_SOURCE_UNAVAILABLE_CODE,
  FX_STALE_QUOTE_USED_CODE,
  FxService,
  type FxServiceDeps,
} from '../../apps/api/src/modules/commerce/fx/application/fx.service';
import {
  FX_REFRESH_INTERVAL_MS,
  FxRefreshLoop,
} from '../../apps/api/src/modules/commerce/fx/application/fx-refresh-loop';
import type {
  FxPair,
  FxQuoteRepository,
  FxQuoteRow,
  FxSourceAdapter,
  FxSourceOutcome,
  FxSourceStateRow,
  FxStoredQuote,
} from '../../apps/api/src/modules/commerce/fx/application/ports';

/**
 * Package FX — the service over fakes (`docs/fx-audit.md` §5): primary success, primary
 * down → fallback, both down with the last-known-good inside the stale limit, beyond the
 * stale limit → UNAVAILABLE, the outlier rule, the rate-limit cooldown, the lease, and
 * the operational conditions that are recorded once and recovered explicitly.
 *
 * The repository is an in-memory copy of the conditional writes the Drizzle one makes;
 * the sources are scripted; the clock is a number the test moves.
 */

const scope: TenantContext = { tenantId: 'tenant-a' as never, botInstanceId: null };
const actor = {
  type: 'ADMIN',
  id: 'admin-1',
  label: 'owner',
  surface: 'WEB',
} as unknown as ActorContext;
const T0 = 1_700_000_000_000;
let tokenSeq = 0;

class FakeRepository implements FxQuoteRepository {
  row: FxQuoteRow | null = null;
  states = new Map<FxSource, FxSourceStateRow>();

  find(): Promise<FxQuoteRow | null> {
    return Promise.resolve(this.row);
  }

  claimRefresh(
    _scope: TenantContext,
    pair: FxPair,
    input: { now: Date; leaseUntil: Date; dueBefore: Date | null; claimToken: string },
  ): Promise<boolean> {
    if (this.row === null) {
      this.row = {
        ...pair,
        quote: null,
        refreshClaimedUntil: input.leaseUntil,
        refreshClaimToken: input.claimToken,
        lastAttemptAt: null,
        lastErrorCode: null,
      };
      return Promise.resolve(true);
    }
    const free = this.row.refreshClaimedUntil === null || this.row.refreshClaimedUntil <= input.now;
    const due =
      input.dueBefore === null ||
      this.row.quote === null ||
      this.row.quote.fetchedAt <= input.dueBefore;
    if (!free || !due) return Promise.resolve(false);
    this.row = {
      ...this.row,
      refreshClaimedUntil: input.leaseUntil,
      refreshClaimToken: input.claimToken,
    };
    return Promise.resolve(true);
  }

  storeQuote(
    _scope: TenantContext,
    _pair: FxPair,
    quote: FxStoredQuote,
    now: Date,
    claimToken: string,
  ): Promise<boolean> {
    if (this.row === null || this.row.refreshClaimToken !== claimToken)
      return Promise.resolve(false);
    if (this.row.quote !== null && !(this.row.quote.fetchedAt < quote.fetchedAt))
      return Promise.resolve(false);
    this.row = {
      ...this.row,
      quote,
      refreshClaimedUntil: null,
      refreshClaimToken: null,
      lastAttemptAt: now,
      lastErrorCode: null,
    };
    return Promise.resolve(true);
  }

  releaseRefresh(
    _scope: TenantContext,
    _pair: FxPair,
    input: { now: Date; errorCode: string | null; claimToken: string },
  ): Promise<void> {
    if (this.row !== null && this.row.refreshClaimToken === input.claimToken) {
      this.row = {
        ...this.row,
        refreshClaimedUntil: null,
        refreshClaimToken: null,
        lastAttemptAt: input.now,
        lastErrorCode: input.errorCode,
      };
    }
    return Promise.resolve();
  }

  sourceStates(): Promise<FxSourceStateRow[]> {
    return Promise.resolve([...this.states.values()]);
  }

  recordSourceSuccess(_scope: TenantContext, source: FxSource, now: Date): Promise<void> {
    const before = this.states.get(source);
    this.states.set(source, {
      source,
      lastSuccessAt: now,
      lastFailureAt: before?.lastFailureAt ?? null,
      lastFailureCode: before?.lastFailureCode ?? null,
      retryAfter: null,
      consecutiveFailures: 0,
    });
    return Promise.resolve();
  }

  recordSourceFailure(
    _scope: TenantContext,
    source: FxSource,
    input: { now: Date; code: string; retryAfter: Date | null },
  ): Promise<void> {
    const before = this.states.get(source);
    this.states.set(source, {
      source,
      lastSuccessAt: before?.lastSuccessAt ?? null,
      lastFailureAt: input.now,
      lastFailureCode: input.code,
      retryAfter: input.retryAfter,
      consecutiveFailures: (before?.consecutiveFailures ?? 0) + 1,
    });
    return Promise.resolve();
  }
}

function scripted(
  source: FxSource,
  answers: () => FxSourceOutcome,
): FxSourceAdapter & { calls: number } {
  const adapter = {
    source,
    calls: 0,
    read: (_asset: FxBaseAsset) => {
      adapter.calls += 1;
      return Promise.resolve(answers());
    },
  };
  return adapter;
}

const reading = (
  source: FxSource,
  mantissa: bigint,
  currency: 'IRR' | 'IRT',
  sourceAt: Date | null = null,
): FxSourceOutcome => ({
  kind: 'READ',
  reading: { source, rate: { mantissa, scale: 0 }, currency, sourceAt },
});
const down = (code = 'timeout'): FxSourceOutcome => ({ kind: 'UNAVAILABLE', code });

interface World {
  /** Assigned once the deps that close over the world exist. */
  service: FxService;
  readonly repository: FakeRepository;
  readonly events: OperationalEventInput[];
  readonly nobitex: FxSourceAdapter & { calls: number };
  readonly wallex: FxSourceAdapter & { calls: number };
  clockMs: number;
  settings: Record<string, unknown>;
  enabled: boolean;
  open: Set<string>;
  audited: unknown[];
}

function world(
  options: {
    nobitex?: () => FxSourceOutcome;
    wallex?: () => FxSourceOutcome;
    settings?: Record<string, unknown>;
    enabled?: boolean;
  } = {},
): World {
  const repository = new FakeRepository();
  const events: OperationalEventInput[] = [];
  const nobitex = scripted(
    'NOBITEX',
    options.nobitex ?? (() => reading('NOBITEX', 1_035_500n, 'IRR', new Date(T0 - 500))),
  );
  const wallex = scripted('WALLEX', options.wallex ?? (() => reading('WALLEX', 103_500n, 'IRT')));
  const state: World = {
    service: null as unknown as FxService,
    repository,
    events,
    nobitex,
    wallex,
    clockMs: T0,
    settings: {
      'fx.primary_source': 'NOBITEX',
      'fx.fallback_source': 'WALLEX',
      'fx.fresh_ttl_seconds': 45,
      'fx.max_stale_seconds': 900,
      'sales.currency': 'IRT',
      'stars.pricing_mode': 'FIXED_RATE',
      'stars.per_usdt': '100',
      ...options.settings,
    },
    enabled: options.enabled ?? true,
    open: new Set<string>(),
    audited: [],
  };
  const deps: FxServiceDeps = {
    repository,
    sources: new Map<FxSource, FxSourceAdapter>([
      ['NOBITEX', nobitex],
      ['WALLEX', wallex],
    ]),
    settings: {
      valueOf: (_s: unknown, key: string) => Promise.resolve(state.settings[key]),
    } as never,
    features: { isEnabled: () => Promise.resolve(state.enabled) } as never,
    gateways: { find: () => Promise.resolve({ providerUnitRateMinor: 1_300n }) } as never,
    conditions: {
      openConditions: (_s: unknown, keys: readonly string[]) =>
        Promise.resolve(keys.filter((key) => state.open.has(key))),
    },
    guard: { check: () => Promise.resolve() } as never,
    audit: {
      record: (_s: unknown, _a: unknown, entry: unknown) => void state.audited.push(entry),
    } as never,
    opsLog: {
      record: (_s: unknown, event: OperationalEventInput) => {
        events.push(event);
        // The in-memory ops log: a deduped condition opens; a recovery closes its subject.
        if (event.dedupeKey !== undefined) state.open.add(event.dedupeKey);
        if (event.recoversDedupeKey !== undefined) state.open.delete(event.recoversDedupeKey);
        return Promise.resolve({} as never);
      },
    },
    scopeActivity: { scopeIsActive: () => Promise.resolve(true) },
    uow: { run: (_s: unknown, fn: (tx: unknown) => unknown) => Promise.resolve(fn({})) } as never,
    clock: { now: () => new Date(state.clockMs) },
    ids: { uuid: () => `token-${String((tokenSeq += 1))}` },
    logger: { info: () => undefined, warn: () => undefined },
  };
  state.service = new FxService(deps);
  return state;
}

const codes = (w: World) => w.events.map((event) => event.code);

describe('the central rate: refreshing', () => {
  it('primary success: stores the Rial best bid as an exact Toman quote, with the book time', async () => {
    const w = world();
    expect(await w.service.refreshIfDue(scope, 'USDT')).toBe('REFRESHED');
    expect(w.nobitex.calls).toBe(1);
    // The fallback is not dialled when the primary answered and was accepted.
    expect(w.wallex.calls).toBe(0);
    expect(w.repository.row?.quote).toEqual({
      rate: { mantissa: 103_550n, scale: 0 },
      source: 'NOBITEX',
      sourceAt: new Date(T0 - 500),
      fetchedAt: new Date(T0),
      quoteId: `v1:NOBITEX:USDT-IRT:103550e-0:${String(T0 - 500)}:${String(T0)}`,
      policyVersion: 1,
    });
    expect(codes(w)).toEqual([]);
    const answer = await w.service.quoteFor(scope, 'USDT', new Date(T0 + 10_000));
    expect(answer.kind === 'QUOTE' && answer.quote).toMatchObject({
      state: 'FRESH',
      ageSeconds: 10,
      side: 'SELL_USDT_TO_RECEIVE_FIAT',
      quoteCurrency: 'IRT',
    });
  });

  it('primary down → fallback prices the pair, and the two conditions are recorded once each', async () => {
    const w = world({ nobitex: () => down('timeout') });
    expect(await w.service.refreshIfDue(scope, 'USDT')).toBe('REFRESHED_BY_FALLBACK');
    expect(w.repository.row?.quote).toMatchObject({
      rate: { mantissa: 103_500n, scale: 0 },
      source: 'WALLEX',
    });
    expect(codes(w)).toEqual([FX_SOURCE_UNAVAILABLE_CODE, FX_FALLBACK_IN_USE_CODE]);
    expect(w.events[0]).toMatchObject({
      dedupeKey: `${FX_SOURCE_UNAVAILABLE_CODE}:NOBITEX`,
      context: { source: 'NOBITEX', reason: 'timeout' },
    });
    // Both are deduped by subject: a second failing pass adds no new code.
    w.clockMs += 60_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toBe('REFRESHED_BY_FALLBACK');
    expect(codes(w)).toEqual([
      FX_SOURCE_UNAVAILABLE_CODE,
      FX_FALLBACK_IN_USE_CODE,
      FX_SOURCE_UNAVAILABLE_CODE,
      FX_FALLBACK_IN_USE_CODE,
    ]);
    expect(new Set(w.events.map((event) => event.dedupeKey)).size).toBe(2);
  });

  it('recovers "source unavailable" and "fallback in use" the moment the primary prices the pair again', async () => {
    let primaryUp = false;
    const w = world({
      nobitex: () => (primaryUp ? reading('NOBITEX', 1_035_500n, 'IRR') : down()),
    });
    await w.service.refreshIfDue(scope, 'USDT');
    expect([...w.open]).toEqual([
      `${FX_SOURCE_UNAVAILABLE_CODE}:NOBITEX`,
      `${FX_FALLBACK_IN_USE_CODE}:USDT-IRT`,
    ]);
    primaryUp = true;
    w.clockMs += 60_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toBe('REFRESHED');
    const recoveries = w.events.filter((event) => event.recoversCode !== undefined);
    expect(recoveries.map((event) => [event.recoversCode, event.recoversDedupeKey])).toEqual([
      [FX_SOURCE_UNAVAILABLE_CODE, `${FX_SOURCE_UNAVAILABLE_CODE}:NOBITEX`],
      [FX_FALLBACK_IN_USE_CODE, `${FX_FALLBACK_IN_USE_CODE}:USDT-IRT`],
    ]);
    expect(w.open.size).toBe(0);
    // Nothing recovers what was never open: a third healthy pass records no recovery.
    w.clockMs += 60_000;
    await w.service.refreshIfDue(scope, 'USDT');
    expect(w.events.filter((event) => event.recoversCode !== undefined)).toHaveLength(2);
  });

  it('both down + last-known-good inside the stale limit: the quote is STALE_ALLOWED and no "unavailable" is raised', async () => {
    let up = true;
    const w = world({
      nobitex: () => (up ? reading('NOBITEX', 1_035_500n, 'IRR') : down()),
      wallex: () => (up ? reading('WALLEX', 103_500n, 'IRT') : down('http_502')),
    });
    await w.service.refreshIfDue(scope, 'USDT');
    up = false;
    w.clockMs += 120_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toBe('FAILED');
    expect(w.repository.row?.quote?.source).toBe('NOBITEX');
    expect(w.repository.row?.lastErrorCode).toBe('nobitex:timeout');
    expect(codes(w)).toEqual([FX_SOURCE_UNAVAILABLE_CODE, FX_SOURCE_UNAVAILABLE_CODE]);
    const answer = await w.service.quoteFor(scope, 'USDT', new Date(w.clockMs));
    expect(answer.kind === 'QUOTE' && answer.quote).toMatchObject({
      state: 'STALE_ALLOWED',
      ageSeconds: 120,
    });
  });

  it('beyond the stale limit: UNAVAILABLE, the "quote unavailable" condition opens, and the next stored quote closes it', async () => {
    let up = true;
    const w = world({
      nobitex: () => (up ? reading('NOBITEX', 1_035_500n, 'IRR') : down()),
      wallex: () => (up ? reading('WALLEX', 103_500n, 'IRT') : down()),
    });
    await w.service.refreshIfDue(scope, 'USDT');
    up = false;
    w.clockMs += 901_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toBe('FAILED');
    expect(codes(w)).toContain(FX_QUOTE_UNAVAILABLE_CODE);
    const answer = await w.service.quoteFor(scope, 'USDT', new Date(w.clockMs));
    expect(answer).toMatchObject({ kind: 'UNAVAILABLE', reason: 'TOO_STALE' });
    expect(answer.kind === 'UNAVAILABLE' && answer.stale?.state).toBe('UNAVAILABLE');
    up = true;
    w.clockMs += 60_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toBe('REFRESHED');
    expect(w.events.at(-1)).toMatchObject({
      recoversCode: FX_QUOTE_UNAVAILABLE_CODE,
      recoversDedupeKey: `${FX_QUOTE_UNAVAILABLE_CODE}:USDT-IRT`,
    });
  });

  it('never fetched: UNAVAILABLE with NEVER_FETCHED; feature off: UNAVAILABLE with DISABLED and nothing dialled', async () => {
    const fresh = world();
    expect(await fresh.service.quoteFor(scope, 'USDT', new Date(T0))).toEqual({
      kind: 'UNAVAILABLE',
      reason: 'NEVER_FETCHED',
      stale: null,
    });
    const off = world({ enabled: false });
    expect(await off.service.refreshIfDue(scope, 'USDT')).toBe('DISABLED');
    expect(off.nobitex.calls + off.wallex.calls).toBe(0);
    expect(await off.service.quoteFor(scope, 'USDT', new Date(T0))).toMatchObject({
      kind: 'UNAVAILABLE',
      reason: 'DISABLED',
    });
    // And an operator's manual refresh dials nothing while it is off either.
    const manual = await off.service.refresh(scope, actor, 'USDT');
    expect(manual.outcome).toBe('DISABLED');
    expect(off.nobitex.calls).toBe(0);
    expect(off.audited).toHaveLength(1);
  });

  it('refreshes only when the quote is older than the TTL, and never past another replica lease', async () => {
    const w = world();
    expect(await w.service.refreshIfDue(scope, 'USDT')).toBe('REFRESHED');
    w.clockMs += 30_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toBe('NOT_DUE');
    expect(w.nobitex.calls).toBe(1);
    w.clockMs += 16_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toBe('REFRESHED');
    expect(w.nobitex.calls).toBe(2);
    // Another replica holds the lease: the operator's refresh answers BUSY and dials nothing.
    w.repository.row = {
      ...w.repository.row!,
      refreshClaimedUntil: new Date(w.clockMs + 10_000),
      refreshClaimToken: 'another-replica',
    };
    expect((await w.service.refresh(scope, actor, 'USDT')).outcome).toBe('BUSY');
    expect(w.nobitex.calls).toBe(2);
    // The operator's refresh ignores the TTL once the lease is free.
    w.repository.row = { ...w.repository.row, refreshClaimedUntil: null, refreshClaimToken: null };
    expect((await w.service.refresh(scope, actor, 'USDT')).outcome).toBe('REFRESHED');
    expect(w.nobitex.calls).toBe(3);
  });

  it('never moves the stored quote backwards: an older fetch loses to a newer one', async () => {
    const w = world();
    await w.service.refreshIfDue(scope, 'USDT');
    const stored = w.repository.row!.quote!;
    // A replica whose clock is behind claims and stores "earlier": refused, the newer stays.
    w.clockMs -= 1;
    w.repository.row = { ...w.repository.row!, refreshClaimedUntil: null, refreshClaimToken: null };
    expect((await w.service.refresh(scope, actor, 'USDT')).outcome).toBe('REFRESHED');
    expect(w.repository.row?.quote).toEqual(stored);
  });

  it('rejects zero, negative-looking and absurd figures, records the rejection per source, and asks the fallback', async () => {
    const w = world({ nobitex: () => reading('NOBITEX', 0n, 'IRR') });
    expect(await w.service.refreshIfDue(scope, 'USDT')).toBe('REFRESHED_BY_FALLBACK');
    expect(w.events[0]).toMatchObject({
      code: FX_QUOTE_REJECTED_CODE,
      dedupeKey: `${FX_QUOTE_REJECTED_CODE}:NOBITEX`,
      context: { reason: 'not_positive' },
    });
    const absurd = world({
      nobitex: () => reading('NOBITEX', 10n, 'IRR'),
      wallex: () => reading('WALLEX', 5_000_000_000n, 'IRT'),
    });
    expect(await absurd.service.refreshIfDue(scope, 'USDT')).toBe('FAILED');
    expect(absurd.events.map((event) => event.context?.['reason'])).toEqual([
      'out_of_rails',
      'out_of_rails',
      'nobitex:out_of_rails',
    ]);
    expect(absurd.repository.row?.quote).toBeNull();
  });

  it('refuses an outlier against a trusted last-known-good unless the other source agrees', async () => {
    let primary = 1_035_500n;
    let fallback = 103_500n;
    const w = world({
      nobitex: () => reading('NOBITEX', primary, 'IRR'),
      wallex: () => reading('WALLEX', fallback, 'IRT'),
    });
    await w.service.refreshIfDue(scope, 'USDT');
    // A ten-fold unit mistake on the primary: refused, the fallback prices the pair.
    primary = 10_355_000n;
    w.clockMs += 60_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toBe('REFRESHED_BY_FALLBACK');
    expect(w.repository.row?.quote).toMatchObject({
      source: 'WALLEX',
      rate: { mantissa: 103_500n, scale: 0 },
    });
    expect(w.events.map((event) => event.code)).toEqual([
      FX_QUOTE_REJECTED_CODE,
      FX_FALLBACK_IN_USE_CODE,
    ]);
    // The market really moved 30 % and both sources say so: the primary's figure is stored.
    primary = 1_346_150n;
    fallback = 134_000n;
    w.clockMs += 60_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toBe('REFRESHED');
    expect(w.repository.row?.quote).toMatchObject({
      source: 'NOBITEX',
      rate: { mantissa: 134_615n, scale: 0 },
    });
    // Only one source stands behind a 30 % move: nothing is stored, the previous quote stays.
    primary = 1_750_000n;
    fallback = 134_000n;
    w.clockMs += 60_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toBe('REFRESHED_BY_FALLBACK');
    expect(w.repository.row?.quote).toMatchObject({
      source: 'WALLEX',
      rate: { mantissa: 134_000n, scale: 0 },
    });
  });

  it('a source that corroborated a move is a success, never a rejected outlier: nothing opens against it (Codex #122)', async () => {
    let primary = 1_035_500n;
    let fallback = 103_500n;
    const w = world({
      nobitex: () => reading('NOBITEX', primary, 'IRR'),
      wallex: () => reading('WALLEX', fallback, 'IRT'),
    });
    await w.service.refreshIfDue(scope, 'USDT');
    // Both say the market moved 30 %: the primary's figure is stored, and the fallback
    // — an outlier against the last-known-good on its own — was right too.
    primary = 1_346_150n;
    fallback = 134_000n;
    w.clockMs += 60_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toBe('REFRESHED');
    expect(w.repository.row?.quote).toMatchObject({ source: 'NOBITEX' });
    expect(codes(w)).toEqual([]);
    expect(w.repository.states.get('WALLEX')).toMatchObject({
      lastSuccessAt: new Date(w.clockMs),
      lastFailureAt: null,
      consecutiveFailures: 0,
    });
    expect(w.repository.states.get('NOBITEX')).toMatchObject({
      lastSuccessAt: new Date(w.clockMs),
      consecutiveFailures: 0,
    });
  });

  it('a rate-limited source is left alone for the cooldown, on every replica, and the fallback answers meanwhile', async () => {
    const w = world({ nobitex: () => ({ kind: 'RATE_LIMITED', code: 'nobitex.rate_limited' }) });
    expect(await w.service.refreshIfDue(scope, 'USDT')).toBe('REFRESHED_BY_FALLBACK');
    expect(w.repository.states.get('NOBITEX')).toMatchObject({
      lastFailureCode: 'nobitex.rate_limited',
      retryAfter: new Date(T0 + FX_RATE_LIMIT_COOLDOWN_MS),
      consecutiveFailures: 1,
    });
    w.clockMs += 46_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toBe('REFRESHED_BY_FALLBACK');
    // Inside the cooldown the primary was not dialled again.
    expect(w.nobitex.calls).toBe(1);
    w.clockMs += 46_000;
    await w.service.refreshIfDue(scope, 'USDT');
    expect(w.nobitex.calls).toBe(2);
  });

  it('with no fallback (NONE, or the same source), a primary failure keeps the last-known-good and dials nothing else', async () => {
    let up = true;
    const w = world({
      nobitex: () => (up ? reading('NOBITEX', 1_035_500n, 'IRR') : down()),
      settings: { 'fx.fallback_source': 'NONE' },
    });
    await w.service.refreshIfDue(scope, 'USDT');
    up = false;
    w.clockMs += 60_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toBe('FAILED');
    expect(w.wallex.calls).toBe(0);
    const same = world({ nobitex: () => down(), settings: { 'fx.fallback_source': 'NOBITEX' } });
    expect(await same.service.refreshIfDue(scope, 'USDT')).toBe('FAILED');
    expect(same.wallex.calls).toBe(0);
    expect(same.nobitex.calls).toBe(1);
  });

  it('a Rial installation keeps Nobitex as is and reads Wallex ten times larger', async () => {
    const w = world({ nobitex: () => down(), settings: { 'sales.currency': 'IRR' } });
    await w.service.refreshIfDue(scope, 'USDT');
    expect(w.repository.row).toMatchObject({
      quoteCurrency: 'IRR',
      quote: { rate: { mantissa: 1_035_000n, scale: 0 } },
    });
  });

  it('records a stale use once per pair, in the caller transaction', async () => {
    const w = world();
    await w.service.refreshIfDue(scope, 'USDT');
    const answer = await w.service.quoteFor(scope, 'USDT', new Date(T0 + 100_000));
    if (answer.kind !== 'QUOTE') throw new Error('expected a quote');
    expect(answer.quote.state).toBe('STALE_ALLOWED');
    await w.service.recordStaleUse(scope, answer.quote, {});
    expect(w.events.at(-1)).toMatchObject({
      code: FX_STALE_QUOTE_USED_CODE,
      dedupeKey: `${FX_STALE_QUOTE_USED_CODE}:USDT-IRT`,
      context: { quoteId: answer.quote.quoteId, ageSeconds: 100 },
    });
  });

  it('the status names the Stars route generically from the descriptor: mode, ratio, fixed rate and the central figure per Star', async () => {
    const w = world({ settings: { 'stars.pricing_mode': 'CENTRAL_FX_RATIO' } });
    await w.service.refreshIfDue(scope, 'USDT');
    const status = await w.service.status(scope, actor, 'USDT');
    expect(status.state).toBe('FRESH');
    expect(status.routes).toEqual([
      {
        provider: 'TELEGRAM_STARS',
        mode: 'CENTRAL_FX',
        unitRatioText: '100',
        fixedRateMinor: 1_300n,
        // 103,550 Toman per USDT over 100 Stars: 1,035.5 Toman per Star, as 2,071 / 2.
        centralRatePerUnit: { numerator: 2_071n, denominator: 2n },
      },
    ]);
    w.settings['stars.per_usdt'] = '';
    expect((await w.service.status(scope, actor, 'USDT')).routes[0]?.centralRatePerUnit).toBeNull();
  });
});

describe('the refresh loop', () => {
  it('records progress on a pass that was not due, and none on a pass that threw', async () => {
    let now = T0;
    let fail = false;
    const loop = new FxRefreshLoop(
      {
        refreshIfDue: () => {
          if (fail) return Promise.reject(new Error('boom'));
          return Promise.resolve('NOT_DUE' as const);
        },
      },
      {
        scope: () => scope,
        baseAsset: 'USDT',
        intervalMs: FX_REFRESH_INTERVAL_MS,
        passBoundMs: 10_000,
        now: () => now,
        logger: { info: () => undefined, error: () => undefined },
      },
    );
    loop.start();
    await loop.tick();
    expect(loop.isFresh(now)).toBe(true);
    // Four intervals of failing passes: stale, even though the loop is alive.
    fail = true;
    for (let i = 0; i < 5; i += 1) {
      now += FX_REFRESH_INTERVAL_MS;
      await loop.tick();
    }
    expect(loop.isFresh(now)).toBe(false);
    fail = false;
    await loop.tick();
    expect(loop.isFresh(now)).toBe(true);
    await loop.stop();
  });
});
