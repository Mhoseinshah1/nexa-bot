import { describe, expect, it } from 'vitest';
import { FX_MAX_STALE_SECONDS_DEFAULT, settingDefinition } from '@nexa/contracts';
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
  FX_SINGLE_SOURCE_CODE,
  FX_RATE_LIMIT_COOLDOWN_MS,
  FX_SOURCE_BACKOFF_MS,
  FX_SOURCE_UNAVAILABLE_CODE,
  FX_STALE_QUOTE_USED_CODE,
  FxService,
  type FxServiceDeps,
} from '../../apps/api/src/modules/commerce/fx/application/fx.service';
import {
  FX_REFRESH_BACKOFF_MS,
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
    input: { now: Date; code: string; retryAfter: Date | null; consecutiveFailures: number },
  ): Promise<void> {
    const before = this.states.get(source);
    this.states.set(source, {
      source,
      lastSuccessAt: before?.lastSuccessAt ?? null,
      lastFailureAt: input.now,
      lastFailureCode: input.code,
      retryAfter: input.retryAfter,
      consecutiveFailures: input.consecutiveFailures,
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
  readonly tabdeal: FxSourceAdapter & { calls: number };
  readonly bitpin: FxSourceAdapter & { calls: number };
  readonly ramzinex: FxSourceAdapter & { calls: number };
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
    tabdeal?: () => FxSourceOutcome;
    bitpin?: () => FxSourceOutcome;
    ramzinex?: () => FxSourceOutcome;
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
  const tabdeal = scripted(
    'TABDEAL',
    options.tabdeal ?? (() => reading('TABDEAL', 103_500n, 'IRT')),
  );
  const bitpin = scripted('BITPIN', options.bitpin ?? (() => reading('BITPIN', 103_500n, 'IRT')));
  const ramzinex = scripted(
    'RAMZINEX',
    options.ramzinex ?? (() => reading('RAMZINEX', 103_500n, 'IRT')),
  );
  const state: World = {
    service: null as unknown as FxService,
    repository,
    events,
    nobitex,
    wallex,
    tabdeal,
    bitpin,
    ramzinex,
    clockMs: T0,
    settings: {
      'fx.primary_source': 'NOBITEX',
      'fx.fallback_source': 'WALLEX',
      'fx.fresh_ttl_seconds': 45,
      'fx.max_stale_seconds': 900,
      'fx.source_nobitex_enabled': true,
      'fx.source_wallex_enabled': true,
      // The Round 8 sources are off here so the two-source cases above stay two-source.
      'fx.source_tabdeal_enabled': false,
      'fx.source_bitpin_enabled': false,
      'fx.source_ramzinex_enabled': false,
      'fx.sanity_band_bps': 200,
      'fx.min_agreeing_sources': 2,
      'fx.accept_single_source': false,
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
      ['TABDEAL', tabdeal],
      ['BITPIN', bitpin],
      ['RAMZINEX', ramzinex],
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

/** The owner's opt-in: store a rate from ONE healthy source (Round 6, default off). */
const SINGLE = { 'fx.accept_single_source': true };

const codes = (w: World) => w.events.map((event) => event.code);

describe('the central rate: refreshing', () => {
  it('primary success: stores the Rial best bid as an exact Toman quote, with the book time', async () => {
    const w = world();
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'REFRESHED' });
    // Every enabled source is read; the two agree and the primary's figure is stored.
    expect(w.nobitex.calls).toBe(1);
    expect(w.wallex.calls).toBe(1);
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

  it('primary down + single source accepted → fallback prices the pair; the conditions are recorded once each', async () => {
    const w = world({ nobitex: () => down('timeout'), settings: SINGLE });
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({
      outcome: 'REFRESHED_BY_FALLBACK',
    });
    expect(w.repository.row?.quote).toMatchObject({
      rate: { mantissa: 103_500n, scale: 0 },
      source: 'WALLEX',
    });
    expect(codes(w)).toEqual([
      FX_SOURCE_UNAVAILABLE_CODE,
      FX_SINGLE_SOURCE_CODE,
      FX_FALLBACK_IN_USE_CODE,
    ]);
    expect(w.events[0]).toMatchObject({
      dedupeKey: `${FX_SOURCE_UNAVAILABLE_CODE}:NOBITEX`,
      context: { source: 'NOBITEX', reason: 'timeout' },
    });
    // Both are deduped by subject: a second failing pass adds no new code.
    w.clockMs += 60_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({
      outcome: 'REFRESHED_BY_FALLBACK',
    });
    expect(codes(w)).toEqual([
      FX_SOURCE_UNAVAILABLE_CODE,
      FX_SINGLE_SOURCE_CODE,
      FX_FALLBACK_IN_USE_CODE,
      FX_SOURCE_UNAVAILABLE_CODE,
      FX_SINGLE_SOURCE_CODE,
      FX_FALLBACK_IN_USE_CODE,
    ]);
    expect(new Set(w.events.map((event) => event.dedupeKey)).size).toBe(3);
  });

  it('recovers "source unavailable" and "fallback in use" the moment the primary prices the pair again', async () => {
    let primaryUp = false;
    const w = world({
      nobitex: () => (primaryUp ? reading('NOBITEX', 1_035_500n, 'IRR') : down()),
      settings: SINGLE,
    });
    await w.service.refreshIfDue(scope, 'USDT');
    expect([...w.open]).toEqual([
      `${FX_SOURCE_UNAVAILABLE_CODE}:NOBITEX`,
      `${FX_SINGLE_SOURCE_CODE}:USDT-IRT`,
      `${FX_FALLBACK_IN_USE_CODE}:USDT-IRT`,
    ]);
    primaryUp = true;
    w.clockMs += 60_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'REFRESHED' });
    const recoveries = w.events.filter((event) => event.recoversCode !== undefined);
    expect(recoveries.map((event) => [event.recoversCode, event.recoversDedupeKey])).toEqual([
      [FX_SOURCE_UNAVAILABLE_CODE, `${FX_SOURCE_UNAVAILABLE_CODE}:NOBITEX`],
      [FX_SINGLE_SOURCE_CODE, `${FX_SINGLE_SOURCE_CODE}:USDT-IRT`],
      [FX_FALLBACK_IN_USE_CODE, `${FX_FALLBACK_IN_USE_CODE}:USDT-IRT`],
    ]);
    expect(w.open.size).toBe(0);
    // Nothing recovers what was never open: a third healthy pass records no recovery.
    w.clockMs += 60_000;
    await w.service.refreshIfDue(scope, 'USDT');
    expect(w.events.filter((event) => event.recoversCode !== undefined)).toHaveLength(3);
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
    // The outcome names WHY, so a FAILED is a diagnosis: the first failure of the pass.
    expect(await w.service.refreshIfDue(scope, 'USDT')).toEqual({
      outcome: 'FAILED',
      reason: 'nobitex:timeout',
    });
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
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'FAILED' });
    expect(codes(w)).toContain(FX_QUOTE_UNAVAILABLE_CODE);
    const answer = await w.service.quoteFor(scope, 'USDT', new Date(w.clockMs));
    expect(answer).toMatchObject({ kind: 'UNAVAILABLE', reason: 'TOO_STALE' });
    expect(answer.kind === 'UNAVAILABLE' && answer.stale?.state).toBe('UNAVAILABLE');
    up = true;
    w.clockMs += 60_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'REFRESHED' });
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
    expect(await off.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'DISABLED' });
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
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'REFRESHED' });
    w.clockMs += 30_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'NOT_DUE' });
    expect(w.nobitex.calls).toBe(1);
    w.clockMs += 16_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'REFRESHED' });
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
    const w = world({ nobitex: () => reading('NOBITEX', 0n, 'IRR'), settings: SINGLE });
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({
      outcome: 'REFRESHED_BY_FALLBACK',
    });
    expect(w.events[0]).toMatchObject({
      code: FX_QUOTE_REJECTED_CODE,
      dedupeKey: `${FX_QUOTE_REJECTED_CODE}:NOBITEX`,
      context: { reason: 'not_positive' },
    });
    const absurd = world({
      nobitex: () => reading('NOBITEX', 10n, 'IRR'),
      wallex: () => reading('WALLEX', 5_000_000_000n, 'IRT'),
    });
    expect(await absurd.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'FAILED' });
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
    // A ten-fold unit mistake on the primary: the two healthy sources DISAGREE, so nothing
    // is stored and the last stored rate keeps pricing. Nobody picks a winner.
    primary = 10_355_000n;
    w.clockMs += 60_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toEqual({
      outcome: 'FAILED',
      reason: 'nobitex:outlier',
    });
    expect(w.repository.row?.quote).toMatchObject({
      source: 'NOBITEX',
      rate: { mantissa: 103_550n, scale: 0 },
    });
    expect(w.events.map((event) => event.code)).toEqual([
      FX_QUOTE_REJECTED_CODE,
      FX_QUOTE_REJECTED_CODE,
    ]);
    // The market really moved 30 % and both sources say so: the primary's figure is stored.
    primary = 1_346_150n;
    fallback = 134_000n;
    w.clockMs += 60_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'REFRESHED' });
    expect(w.repository.row?.quote).toMatchObject({
      source: 'NOBITEX',
      rate: { mantissa: 134_615n, scale: 0 },
    });
    // Only one source stands behind a further 30 % move: nothing is stored, the quote stays.
    primary = 1_750_000n;
    fallback = 134_000n;
    w.clockMs += 60_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'FAILED' });
    expect(w.repository.row?.quote).toMatchObject({
      source: 'NOBITEX',
      rate: { mantissa: 134_615n, scale: 0 },
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
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'REFRESHED' });
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
    const w = world({
      nobitex: () => ({ kind: 'RATE_LIMITED', code: 'nobitex.rate_limited' }),
      settings: SINGLE,
    });
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({
      outcome: 'REFRESHED_BY_FALLBACK',
    });
    expect(w.repository.states.get('NOBITEX')).toMatchObject({
      lastFailureCode: 'nobitex.rate_limited',
      retryAfter: new Date(T0 + FX_RATE_LIMIT_COOLDOWN_MS),
      consecutiveFailures: 1,
    });
    w.clockMs += 46_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({
      outcome: 'REFRESHED_BY_FALLBACK',
    });
    // Inside the cooldown the primary was not dialled again.
    expect(w.nobitex.calls).toBe(1);
    w.clockMs += 46_000;
    await w.service.refreshIfDue(scope, 'USDT');
    expect(w.nobitex.calls).toBe(2);
  });

  it('a Rial installation keeps Nobitex as is and reads Wallex ten times larger', async () => {
    const w = world({
      nobitex: () => down(),
      settings: { ...SINGLE, 'sales.currency': 'IRR' },
    });
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

  it('the status names the Stars route generically from the descriptor: always central, the ratio and the central figure per Star — a retired fixed rate on the row is not reported (spec §8)', async () => {
    // A stored legacy mode cannot bring the manual rate back.
    const w = world({ settings: { 'stars.pricing_mode': 'FIXED_RATE' } });
    await w.service.refreshIfDue(scope, 'USDT');
    const status = await w.service.status(scope, actor, 'USDT');
    expect(status.state).toBe('FRESH');
    expect(status.routes).toEqual([
      {
        provider: 'TELEGRAM_STARS',
        mode: 'CENTRAL_FX',
        unitRatioText: '100',
        fixedRateMinor: null,
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
          return Promise.resolve({ outcome: 'NOT_DUE' as const, reason: null });
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
    // Past the backoff the next pass dials, succeeds, and the loop is fresh again.
    now += 600_000;
    await loop.tick();
    expect(loop.isFresh(now)).toBe(true);
    await loop.stop();
  });
});

describe('the refresh loop backs off', () => {
  type Outcome = 'FAILED' | 'REFRESHED_BY_FALLBACK' | 'NOT_DUE';
  function harness(outcome: () => Outcome) {
    let now = T0;
    const dials: number[] = [];
    const warnings: Record<string, unknown>[] = [];
    const loop = new FxRefreshLoop(
      {
        refreshIfDue: () => {
          dials.push((now - T0) / 1_000);
          const o = outcome();
          return Promise.resolve({
            outcome: o,
            reason: o === 'FAILED' ? 'nobitex:http_403' : null,
          });
        },
      },
      {
        scope: () => scope,
        baseAsset: 'USDT',
        intervalMs: FX_REFRESH_INTERVAL_MS,
        passBoundMs: 10_000,
        now: () => now,
        logger: {
          info: () => undefined,
          error: () => undefined,
          warn: (context) => void warnings.push(context),
        },
      },
    );
    const advance = async (seconds: number) => {
      for (let i = 0; i < seconds / 10; i += 1) {
        now += FX_REFRESH_INTERVAL_MS;
        await loop.tick();
      }
    };
    return { loop, dials, warnings, advance, clock: () => now };
  }

  it('spaces the dials 10 s, 30 s, 1 m, 5 m, 10 m and holds at the cap', async () => {
    expect(FX_REFRESH_BACKOFF_MS).toEqual([10_000, 30_000, 60_000, 300_000, 600_000]);
    const h = harness(() => 'FAILED');
    await h.loop.tick();
    await h.advance(2_500);
    // 0, +10, +30, +60, +300, +600, +600 ...
    expect(h.dials).toEqual([0, 10, 40, 100, 400, 1_000, 1_600, 2_200]);
  });

  it('a stored quote resets the interval, and the next failure starts the ladder again', async () => {
    let outcome: Outcome = 'FAILED';
    const h = harness(() => outcome);
    await h.loop.tick();
    await h.advance(100);
    expect(h.dials).toEqual([0, 10, 40, 100]);
    outcome = 'REFRESHED_BY_FALLBACK';
    await h.advance(300); // the 300 s wait after the 4th failure ends at t = 400
    expect(h.dials).toEqual([0, 10, 40, 100, 400]);
    outcome = 'FAILED';
    await h.advance(10);
    await h.advance(10);
    // Reset: dialled again at the normal interval, then back to the first step.
    expect(h.dials.slice(-2)).toEqual([410, 420]);
    await h.advance(20);
    expect(h.dials.at(-1)).toBe(420);
    await h.advance(10);
    expect(h.dials.at(-1)).toBe(450);
  });

  it('a pass that THROWS backs off like a FAILED one and logs once per step', async () => {
    let now = T0;
    const dials: number[] = [];
    const warnings: Record<string, unknown>[] = [];
    const errors: unknown[] = [];
    const loop = new FxRefreshLoop(
      {
        refreshIfDue: () => {
          dials.push((now - T0) / 1_000);
          return Promise.reject(new Error('db is down'));
        },
      },
      {
        scope: () => scope,
        baseAsset: 'USDT',
        intervalMs: FX_REFRESH_INTERVAL_MS,
        passBoundMs: 10_000,
        now: () => now,
        logger: {
          info: () => undefined,
          error: (context) => void errors.push(context),
          warn: (context) => void warnings.push(context),
        },
      },
    );
    loop.start();
    await loop.tick();
    for (let i = 0; i < 250; i += 1) {
      now += FX_REFRESH_INTERVAL_MS;
      await loop.tick();
    }
    // 0, +10, +30, +60, +300, +600 ... not a dial every 10 s.
    expect(dials).toEqual([0, 10, 40, 100, 400, 1_000, 1_600, 2_200]);
    expect(warnings.map((w) => w['nextAttemptInMs'])).toEqual([
      10_000, 30_000, 60_000, 300_000, 600_000,
    ]);
    expect(errors).toEqual([]);
    // A throwing loop still reads as stale while it waits out the backoff.
    expect(loop.isFresh(now)).toBe(false);
    await loop.stop();
  });

  it('warns once per backoff step, not on every failed pass', async () => {
    const h = harness(() => 'FAILED');
    await h.loop.tick();
    await h.advance(3_000);
    expect(h.warnings.map((w) => w['nextAttemptInMs'])).toEqual([
      10_000, 30_000, 60_000, 300_000, 600_000,
    ]);
  });
});

describe('the central rate: a source that keeps failing', () => {
  const blocked = () => down('nobitex.http_403');

  it('is skipped while its backoff runs, and the fallback answers meanwhile', async () => {
    const w = world({ nobitex: blocked, settings: { ...SINGLE, 'fx.fresh_ttl_seconds': 10 } });
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({
      outcome: 'REFRESHED_BY_FALLBACK',
    });
    expect(w.repository.states.get('NOBITEX')).toMatchObject({
      consecutiveFailures: 1,
      retryAfter: new Date(T0 + (FX_SOURCE_BACKOFF_MS[0] ?? 0)),
    });
    // Inside the 30 s wait the quote is due again (10 s TTL), but only the fallback is dialled.
    w.clockMs += 15_000;
    await w.service.refreshIfDue(scope, 'USDT');
    expect(w.nobitex.calls).toBe(1);
    expect(w.wallex.calls).toBe(2);
  });

  it('waits longer after each consecutive failure and holds at the cap', async () => {
    const w = world({ nobitex: blocked });
    const waits: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const dialledAt = w.clockMs;
      await w.service.refreshIfDue(scope, 'USDT');
      const state = w.repository.states.get('NOBITEX');
      waits.push((state?.retryAfter?.getTime() ?? 0) - dialledAt);
      // Past the backoff and past the quote's TTL, so the next pass is due and may dial.
      w.clockMs = Math.max(state?.retryAfter?.getTime() ?? 0, dialledAt + 46_000);
    }
    expect(waits).toEqual([30_000, 60_000, 300_000, 600_000, 600_000, 600_000]);
  });

  it('counts only transport failures in the step: rejected quotes before an outage do not skip ahead', async () => {
    let mode: 'rejected' | 'down' = 'rejected';
    const w = world({
      nobitex: () => (mode === 'rejected' ? reading('NOBITEX', 0n, 'IRR') : blocked()),
    });
    for (let i = 0; i < 3; i += 1) {
      await w.service.refreshIfDue(scope, 'USDT');
      w.clockMs += 46_000;
    }
    expect(w.repository.states.get('NOBITEX')).toMatchObject({
      retryAfter: null,
      consecutiveFailures: 0,
    });
    mode = 'down';
    const dialledAt = w.clockMs;
    await w.service.refreshIfDue(scope, 'USDT');
    const state = w.repository.states.get('NOBITEX');
    // The FIRST transport failure waits the first step, not the third (5 minutes).
    expect(state?.retryAfter).toEqual(new Date(dialledAt + (FX_SOURCE_BACKOFF_MS[0] ?? 0)));
    expect(state?.consecutiveFailures).toBe(1);
  });

  it('raises one alert per outage and one recovery, however many passes run', async () => {
    let primaryUp = false;
    const w = world({
      nobitex: () => (primaryUp ? reading('NOBITEX', 1_035_500n, 'IRR') : blocked()),
    });
    // Ten minutes of 46 s passes against a blocked primary.
    for (let i = 0; i < 13; i += 1) {
      await w.service.refreshIfDue(scope, 'USDT');
      w.clockMs += 46_000;
    }
    const alerts = w.events.filter((e) => e.code === FX_SOURCE_UNAVAILABLE_CODE);
    // Dialled only when the backoff allowed it; every dial is the same deduped condition.
    expect(alerts.length).toBe(w.nobitex.calls);
    expect(w.nobitex.calls).toBeLessThan(13);
    expect(new Set(alerts.map((e) => e.dedupeKey))).toEqual(
      new Set([`${FX_SOURCE_UNAVAILABLE_CODE}:NOBITEX`]),
    );
    expect(alerts[0]?.context).toMatchObject({ source: 'NOBITEX', reason: 'nobitex.http_403' });
    primaryUp = true;
    w.clockMs += 700_000;
    await w.service.refreshIfDue(scope, 'USDT');
    await w.service.refreshIfDue(scope, 'USDT');
    w.clockMs += 46_000;
    await w.service.refreshIfDue(scope, 'USDT');
    const recoveries = w.events.filter((e) => e.recoversCode === FX_SOURCE_UNAVAILABLE_CODE);
    expect(recoveries).toHaveLength(1);
    expect(w.open.has(`${FX_SOURCE_UNAVAILABLE_CODE}:NOBITEX`)).toBe(false);
  });

  it('with every source backing off, dials nothing, warns nothing, and keeps the failure as the reason', async () => {
    const w = world({ nobitex: blocked, wallex: () => down('wallex.not_json') });
    const warnings: unknown[] = [];
    (w.service as unknown as { deps: FxServiceDeps }).deps.logger.warn = (c) =>
      void warnings.push(c);
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'FAILED' });
    expect(warnings).toHaveLength(1);
    w.clockMs += 20_000;
    const again = await w.service.refreshIfDue(scope, 'USDT');
    expect(again).toEqual({ outcome: 'FAILED', reason: 'nobitex:nobitex.http_403' });
    expect(w.nobitex.calls).toBe(1);
    expect(w.wallex.calls).toBe(1);
    expect(warnings).toHaveLength(1);
  });

  it("an operator's refresh ignores a failure backoff but not a rate-limit cooldown", async () => {
    const w = world({ nobitex: blocked });
    await w.service.refreshIfDue(scope, 'USDT');
    await w.service.refresh(scope, actor, 'USDT');
    expect(w.nobitex.calls).toBe(2);
    const limited = world({
      nobitex: () => ({ kind: 'RATE_LIMITED', code: 'nobitex.rate_limited' }),
    });
    await limited.service.refreshIfDue(scope, 'USDT');
    await limited.service.refresh(scope, actor, 'USDT');
    expect(limited.nobitex.calls).toBe(1);
  });
});

describe('Round 6: sources that agree, switches, single-source mode and the stale window', () => {
  it('Nobitex at 403: with one other source and no opt-in, nothing is stored and the old rate prices', async () => {
    let nobitexUp = true;
    const w = world({
      nobitex: () => (nobitexUp ? reading('NOBITEX', 1_035_500n, 'IRR') : down('nobitex.http_403')),
    });
    await w.service.refreshIfDue(scope, 'USDT');
    nobitexUp = false;
    w.clockMs += 60_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toEqual({
      outcome: 'FAILED',
      reason: 'nobitex:nobitex.http_403',
    });
    // Wallex answered a perfectly good figure and it was NOT stored: one source is not two.
    expect(w.wallex.calls).toBe(2);
    expect(w.repository.row?.quote?.source).toBe('NOBITEX');
    // One source down never stops pricing: the last stored rate is still a usable quote.
    const answer = await w.service.quoteFor(scope, 'USDT', new Date(w.clockMs + 1_000));
    expect(answer).toMatchObject({ kind: 'QUOTE', quote: { state: 'STALE_ALLOWED' } });
    // The healthy source is health, not a failure, and the one-source alert is open.
    expect(w.repository.states.get('WALLEX')).toMatchObject({ consecutiveFailures: 0 });
    expect(w.open.has(`${FX_SINGLE_SOURCE_CODE}:USDT-IRT`)).toBe(true);
  });

  it('single-source mode stores the lone healthy source, raises ONE alert, and recovers it when two agree again', async () => {
    let nobitexUp = false;
    const w = world({
      nobitex: () => (nobitexUp ? reading('NOBITEX', 1_035_500n, 'IRR') : down('nobitex.http_403')),
      settings: SINGLE,
    });
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({
      outcome: 'REFRESHED_BY_FALLBACK',
    });
    expect(w.repository.row?.quote).toMatchObject({ source: 'WALLEX' });
    w.clockMs += 60_000;
    await w.service.refreshIfDue(scope, 'USDT');
    const alerts = w.events.filter((event) => event.code === FX_SINGLE_SOURCE_CODE);
    // Recorded on every pass of the outage, all on ONE deduped subject.
    expect(new Set(alerts.map((event) => event.dedupeKey))).toEqual(
      new Set([`${FX_SINGLE_SOURCE_CODE}:USDT-IRT`]),
    );
    nobitexUp = true;
    w.clockMs += 700_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'REFRESHED' });
    expect(w.open.has(`${FX_SINGLE_SOURCE_CODE}:USDT-IRT`)).toBe(false);
  });

  it('single-source mode still refuses a lone figure far from the last good one', async () => {
    let wallex = 103_500n;
    let nobitexUp = true;
    const w = world({
      nobitex: () => (nobitexUp ? reading('NOBITEX', 1_035_500n, 'IRR') : down('nobitex.http_403')),
      wallex: () => reading('WALLEX', wallex, 'IRT'),
      settings: SINGLE,
    });
    await w.service.refreshIfDue(scope, 'USDT');
    nobitexUp = false;
    wallex = 1_035_000n;
    w.clockMs += 60_000;
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'FAILED' });
    expect(w.repository.row?.quote).toMatchObject({ rate: { mantissa: 103_550n, scale: 0 } });
  });

  it('the agreement count is honoured: three required, two agreeing, nothing stored', async () => {
    const w = world({ settings: { 'fx.min_agreeing_sources': 3 } });
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'FAILED' });
    expect(w.repository.row?.quote).toBeNull();
  });

  it('a disabled source is never called, whatever the primary and fallback say', async () => {
    const w = world({
      settings: { 'fx.source_nobitex_enabled': false, ...SINGLE },
    });
    await w.service.refreshIfDue(scope, 'USDT');
    await w.service.refresh(scope, actor, 'USDT');
    expect(w.nobitex.calls).toBe(0);
    expect(w.wallex.calls).toBeGreaterThan(0);
    // The owner's switch is not "the primary failed": no fallback alert.
    expect(codes(w)).not.toContain(FX_FALLBACK_IN_USE_CODE);
    const off = world({
      settings: { 'fx.source_nobitex_enabled': false, 'fx.source_wallex_enabled': false },
    });
    expect(await off.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'FAILED' });
    expect(off.nobitex.calls + off.wallex.calls).toBe(0);
  });

  it('the status lists every source with its switch, health or not', async () => {
    const w = world({ settings: { 'fx.source_wallex_enabled': false } });
    const status = await w.service.status(scope, actor, 'USDT');
    expect(status.sources.map((row) => [row.source, row.enabled])).toEqual([
      ['NOBITEX', true],
      ['WALLEX', false],
      ['TABDEAL', false],
      ['BITPIN', false],
      ['RAMZINEX', false],
    ]);
    expect(status.settings).toMatchObject({ minAgreeingSources: 2, acceptSingleSource: false });
  });

  it('the stale window: the last stored rate prices for the window and not a second longer', async () => {
    const w = world({ settings: { 'fx.max_stale_seconds': 21_600 } });
    await w.service.refreshIfDue(scope, 'USDT');
    const at = (seconds: number) => new Date(T0 + seconds * 1_000);
    expect(await w.service.quoteFor(scope, 'USDT', at(21_600))).toMatchObject({
      kind: 'QUOTE',
      quote: { state: 'STALE_ALLOWED', ageSeconds: 21_600 },
    });
    const past = await w.service.quoteFor(scope, 'USDT', at(21_601));
    expect(past).toMatchObject({ kind: 'UNAVAILABLE', reason: 'TOO_STALE' });
    // The age is still shown to the operator, and no rate is invented.
    expect(past.kind === 'UNAVAILABLE' && past.stale?.ageSeconds).toBe(21_601);
  });

  it('the registry default for that window is six hours', () => {
    expect(FX_MAX_STALE_SECONDS_DEFAULT).toBe(21_600);
    expect(settingDefinition('fx.max_stale_seconds').defaultValue).toBe(21_600);
    expect(settingDefinition('fx.min_agreeing_sources').defaultValue).toBe(2);
    expect(settingDefinition('fx.accept_single_source').defaultValue).toBe(false);
  });
});

/** Every `fx.*` key at the registry's own default: what an installation has before an owner touches it. */
function registryDefaults(): Record<string, unknown> {
  const keys = [
    'fx.primary_source',
    'fx.fallback_source',
    'fx.fresh_ttl_seconds',
    'fx.max_stale_seconds',
    'fx.source_nobitex_enabled',
    'fx.source_wallex_enabled',
    'fx.source_tabdeal_enabled',
    'fx.source_bitpin_enabled',
    'fx.source_ramzinex_enabled',
    'fx.sanity_band_bps',
    'fx.min_agreeing_sources',
    'fx.accept_single_source',
  ] as const;
  return Object.fromEntries(keys.map((key) => [key, settingDefinition(key).defaultValue]));
}

describe('Round 8: Tabdeal, Bitpin, Ramzinex and the sanity band', () => {
  it('the registry defaults: Tabdeal and Bitpin on, Ramzinex off, two agreeing sources, a two percent band', () => {
    const defaults = registryDefaults();
    expect(defaults['fx.source_tabdeal_enabled']).toBe(true);
    expect(defaults['fx.source_bitpin_enabled']).toBe(true);
    expect(defaults['fx.source_ramzinex_enabled']).toBe(false);
    expect(defaults['fx.min_agreeing_sources']).toBe(2);
    expect(defaults['fx.accept_single_source']).toBe(false);
    expect(defaults['fx.sanity_band_bps']).toBe(200);
  });

  it('two agreeing sources store a rate on the registry defaults, with no single-source mode', async () => {
    // Nobitex is the owner's 403; take it out and leave Wallex out too: Tabdeal + Bitpin only.
    const w = world({
      settings: {
        ...registryDefaults(),
        'fx.source_nobitex_enabled': false,
        'fx.source_wallex_enabled': false,
      },
      tabdeal: () => reading('TABDEAL', 268_671n, 'IRT'),
      bitpin: () => reading('BITPIN', 268_450n, 'IRT'),
    });
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'REFRESHED' });
    expect(w.repository.row?.quote).toMatchObject({ rate: { mantissa: 268_671n, scale: 0 } });
    // The two agree (under 0.1 percent) and nothing was stored under the single-source opt-in.
    expect(codes(w)).not.toContain(FX_SINGLE_SOURCE_CODE);
  });

  it('a disabled source is never called: Ramzinex is off by default, and a switched-off Bitpin too', async () => {
    const w = world({
      settings: {
        ...registryDefaults(),
        'fx.source_nobitex_enabled': false,
        'fx.source_wallex_enabled': false,
      },
    });
    await w.service.refreshIfDue(scope, 'USDT');
    await w.service.refresh(scope, actor, 'USDT');
    expect(w.ramzinex.calls).toBe(0);
    expect(w.nobitex.calls + w.wallex.calls).toBe(0);
    expect(w.tabdeal.calls).toBeGreaterThan(0);
    expect(w.bitpin.calls).toBeGreaterThan(0);
    const off = world({
      settings: { ...registryDefaults(), 'fx.source_bitpin_enabled': false },
    });
    await off.service.refresh(scope, actor, 'USDT');
    expect(off.bitpin.calls).toBe(0);
    expect(off.ramzinex.calls).toBe(0);
  });

  /** Three sources inside the 3 percent agreement window; the primary is the one furthest out. */
  const THREE = {
    settings: {
      'fx.source_tabdeal_enabled': true,
      'fx.source_bitpin_enabled': true,
      'fx.source_nobitex_enabled': false,
      'fx.primary_source': 'TABDEAL',
    },
    wallex: () => reading('WALLEX', 100_000n, 'IRT'),
    bitpin: () => reading('BITPIN', 101_000n, 'IRT'),
    tabdeal: () => reading('TABDEAL', 103_000n, 'IRT'),
  };

  it('the sanity band leaves out a source further than the band from the median of the others, and says so once', async () => {
    const w = world(THREE);
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({
      outcome: 'REFRESHED_BY_FALLBACK',
    });
    // Tabdeal (103,000) is 2.49 percent from the median of the others (100,500): out.
    // Without the band it is the primary AND inside the 3 percent window, so it would win.
    expect(w.repository.row?.quote).toMatchObject({
      source: 'WALLEX',
      rate: { mantissa: 100_000n, scale: 0 },
    });
    const rejected = w.events.filter((event) => event.code === FX_QUOTE_REJECTED_CODE);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      dedupeKey: `${FX_QUOTE_REJECTED_CODE}:TABDEAL`,
      context: { source: 'TABDEAL', reason: 'outside_band' },
    });
    expect(w.repository.states.get('TABDEAL')).toMatchObject({
      lastFailureCode: 'outside_band',
      consecutiveFailures: 0,
      retryAfter: null,
    });
    // A later pass repeats it on the SAME deduped subject: one condition, not a flood.
    w.clockMs += 60_000;
    await w.service.refreshIfDue(scope, 'USDT');
    const subjects = new Set(
      w.events.filter((event) => event.code === FX_QUOTE_REJECTED_CODE).map((e) => e.dedupeKey),
    );
    expect(subjects).toEqual(new Set([`${FX_QUOTE_REJECTED_CODE}:TABDEAL`]));
  });

  it('the band is the owner’s: a wider one keeps the source, and a source exactly on the band stays', async () => {
    const wide = world({ ...THREE, settings: { ...THREE.settings, 'fx.sanity_band_bps': 300 } });
    await wide.service.refreshIfDue(scope, 'USDT');
    expect(wide.repository.row?.quote).toMatchObject({ source: 'TABDEAL' });
    expect(wide.events.map((event) => event.code)).not.toContain(FX_QUOTE_REJECTED_CODE);
    // 102,510 against the others' median 100,500 is 2.0 percent to the cent: on the band, kept.
    const edge = world({ ...THREE, tabdeal: () => reading('TABDEAL', 102_510n, 'IRT') });
    await edge.service.refreshIfDue(scope, 'USDT');
    expect(edge.repository.row?.quote).toMatchObject({ source: 'TABDEAL' });
  });

  it('with two healthy sources the band does nothing: the agreement window alone decides', async () => {
    // 2.5 percent apart: more than the band, inside the 3 percent window. Both stay.
    const w = world({
      wallex: () => reading('WALLEX', 100_000n, 'IRT'),
      nobitex: () => reading('NOBITEX', 1_025_000n, 'IRR'),
    });
    expect(await w.service.refreshIfDue(scope, 'USDT')).toMatchObject({ outcome: 'REFRESHED' });
    expect(w.events.map((event) => event.code)).not.toContain(FX_QUOTE_REJECTED_CODE);
  });
});
