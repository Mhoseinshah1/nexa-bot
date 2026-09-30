import {
  FX_POLICY_VERSION,
  FX_QUOTE_SIDE,
  PAYMENT_GATEWAY_DESCRIPTORS,
  PAYMENT_GATEWAY_PROVIDERS,
  conversionPolicyFor,
  effectiveMinorPerUnit,
  fxQuoteId,
  fxQuoteStateFor,
  isSettingKey,
  normaliseRate,
  parseUnitRatio,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type FxBaseAsset,
  type FxFallbackSource,
  type FxQuote,
  type FxQuoteState,
  type FxSource,
  type GatewayConversionPolicy,
  type OperationalEventRecorder,
  type PaymentGatewayProvider,
  type PermissionKey,
  type SalesCurrencyCode,
  type SettingKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PaymentGatewayRepository } from '../../payments/application/gateway-ports.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { FeatureFlagResolver } from '../../../control/features/application/feature-flags.service.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { OperationalConditionReader } from '../../../platform/opslog/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import {
  chooseQuote,
  judgeCandidate,
  toCandidate,
  verdictCode,
  type FxCandidate,
  type JudgedCandidate,
} from '../domain/fx-quote.js';
import type {
  FxPair,
  FxQuoteAnswer,
  FxQuoteRepository,
  FxQuoteRow,
  FxSourceAdapter,
  FxSourceStateRow,
} from './ports.js';

/** The flag the whole layer sits behind. Off: nothing is fetched and nothing is quoted. */
export const CENTRAL_FX_FLAG = 'central_fx' as const;

/** Reading the FX section and pressing refresh are the finance keys the routes already use. */
export const FX_VIEW_PERMISSION = 'payments.gateways.view' satisfies PermissionKey;
export const FX_REFRESH_PERMISSION = 'payments.gateways.edit' satisfies PermissionKey;

/**
 * The operational codes of the central rate. Part of the schema once shipped (Phase 3C
 * rule: `operational_events` dedupes and recovers by code). Each is deduped per SUBJECT
 * and recovered explicitly, so an outage is one row with a counter, never a flood.
 */
/** A source did not answer usably. Per source; recovered by that source's next success. */
export const FX_SOURCE_UNAVAILABLE_CODE = 'fx.source_unavailable';
/** A source answered a figure that was refused (not positive, out of rails, outlier). Per source. */
export const FX_QUOTE_REJECTED_CODE = 'fx.quote_rejected';
/** The pair is priced by the fallback. Per pair; recovered when the primary prices it again. */
export const FX_FALLBACK_IN_USE_CODE = 'fx.fallback_in_use';
/** No usable quote: NEW central-rate invoices are refused. Per pair; recovered by the next stored quote. */
export const FX_QUOTE_UNAVAILABLE_CODE = 'fx.quote_unavailable';
/** A NEW invoice was priced by a quote past its TTL. Per pair; recovered by the next stored quote. */
export const FX_STALE_QUOTE_USED_CODE = 'fx.stale_quote_used';

/** A source that answered "rate limited" is left alone for this long, on every replica. */
export const FX_RATE_LIMIT_COOLDOWN_MS = 60_000;
/** The lease one refresh holds: two sources, each allowed its whole timeout, and slack. */
export const FX_REFRESH_LEASE_MS = 20_000;

export interface FxServiceDeps {
  readonly repository: FxQuoteRepository;
  readonly sources: ReadonlyMap<FxSource, FxSourceAdapter>;
  readonly settings: SettingsResolver;
  readonly features: FeatureFlagResolver;
  /** The ONE read: a route's stored fixed rate, for the status block beside the central figure. */
  readonly gateways: Pick<PaymentGatewayRepository, 'find'>;
  readonly conditions: Pick<OperationalConditionReader, 'openConditions'>;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly logger: {
    info: (context: Record<string, unknown>, message: string) => void;
    warn: (context: Record<string, unknown>, message: string) => void;
  };
}

/** What one refresh did. `NOT_DUE` and `BUSY` mean nothing was dialled. */
export type FxRefreshOutcome =
  | 'REFRESHED'
  | 'REFRESHED_BY_FALLBACK'
  | 'FAILED'
  | 'DISABLED'
  | 'BUSY'
  | 'NOT_DUE';

/** The settings the service reads, resolved once per call inside the caller's transaction. */
interface FxSettings {
  readonly enabled: boolean;
  readonly primary: FxSource;
  readonly fallback: FxFallbackSource;
  readonly freshTtlSeconds: number;
  readonly maxStaleSeconds: number;
  readonly quoteCurrency: SalesCurrencyCode;
}

/**
 * One route priced by this base asset, as the FX section shows it: the policy its mode
 * setting selects right now, its unit ratio, its fixed rate, and the sales-currency
 * figure per provider unit the CENTRAL rate would produce. Decided generically from the
 * descriptors — the service names no provider.
 */
export interface FxRouteStatus {
  readonly provider: PaymentGatewayProvider;
  readonly mode: GatewayConversionPolicy;
  readonly unitRatioText: string;
  readonly fixedRateMinor: bigint | null;
  /** Informational; an attempt decides its own figure in its own transaction. */
  readonly centralRatePerUnit: { readonly numerator: bigint; readonly denominator: bigint } | null;
}

/** The FX section's facts, as the service hands them to the controller. */
export interface FxStatus {
  readonly settings: FxSettings;
  readonly pair: FxPair;
  readonly state: FxQuoteState;
  readonly quote: FxQuote | null;
  readonly row: FxQuoteRow | null;
  readonly sources: readonly FxSourceStateRow[];
  readonly routes: readonly FxRouteStatus[];
  readonly policyVersion: number;
}

/**
 * The central exchange rate (package FX, `docs/fx-audit.md` §3).
 *
 * Three responsibilities and one rule for each:
 *
 * - **Quoting** (`quoteFor`) reads the stored last-known-good inside the CALLER's
 *   transaction and decides its state from its age against the tenant's TTL and stale
 *   limit. It never dials anything: a payment attempt runs inside a transaction, and no
 *   network call belongs there.
 * - **Refreshing** (`refreshIfDue`, `refresh`) dials the primary and then the fallback,
 *   OUTSIDE any transaction, under a lease taken by one conditional write so two worker
 *   replicas do not both dial. A figure is stored only when it is positive, inside the
 *   pair's rails, and not an outlier against a trusted last-known-good — unless two
 *   sources agree the market moved. A stored quote only ever replaces an OLDER one.
 * - **Telling the operator** through deduped operational conditions with explicit
 *   recoveries, so a two-hour outage is one row with a counter, and "fallback in use"
 *   closes the moment the primary prices the pair again.
 *
 * The side is fixed by the domain (`FX_QUOTE_SIDE`): every source reads its best bid.
 */
export class FxService {
  constructor(private readonly deps: FxServiceDeps) {}

  /**
   * The quote for a pair as of `now`, from the stored row, inside the caller's
   * transaction. `UNAVAILABLE` names why: the feature is off, nothing was ever fetched,
   * or the last quote is past the stale limit. The caller decides what that means for
   * it — the payment core refuses a NEW invoice and touches no existing one.
   */
  async quoteFor(
    scope: TenantContext,
    baseAsset: FxBaseAsset,
    now: Date,
    tx?: unknown,
  ): Promise<FxQuoteAnswer> {
    const settings = await this.settingsFor(scope, tx);
    const pair: FxPair = { baseAsset, quoteCurrency: settings.quoteCurrency };
    const row = await this.deps.repository.find(scope, pair, tx);
    return this.answerFrom(settings, pair, row, now);
  }

  /**
   * Records that a NEW invoice was priced by a quote past its TTL, inside the pricing
   * transaction so the record and the invoice commit together. One row per pair.
   */
  async recordStaleUse(scope: TenantContext, quote: FxQuote, tx: unknown): Promise<void> {
    await this.deps.opsLog.record(
      scope,
      {
        code: FX_STALE_QUOTE_USED_CODE,
        severity: 'WARN',
        message:
          'A new invoice was priced by the last-known-good exchange rate because no source has ' +
          'answered since it went stale. The rate is inside the stale limit; new invoices are ' +
          'refused once it is not.',
        dedupeKey: `${FX_STALE_QUOTE_USED_CODE}:${pairKey(quote)}`,
        context: {
          pair: pairKey(quote),
          source: quote.source,
          quoteId: quote.quoteId,
          ageSeconds: quote.ageSeconds,
        },
      },
      tx,
    );
  }

  /** The FX section's facts. Charges `payments.gateways.view`. */
  async status(scope: TenantContext, actor: ActorContext, baseAsset: FxBaseAsset): Promise<FxStatus> {
    await this.deps.guard.check(scope, actor, FX_VIEW_PERMISSION);
    return this.statusUnchecked(scope, baseAsset);
  }

  /**
   * The worker's pass: refresh the pair when its quote is older than the TTL. Nothing is
   * dialled while the feature is off, and nothing is dialled while another replica holds
   * the lease or the quote is still fresh.
   */
  async refreshIfDue(scope: TenantContext, baseAsset: FxBaseAsset): Promise<FxRefreshOutcome> {
    const now = this.deps.clock.now();
    const settings = await this.settingsFor(scope);
    if (!settings.enabled) return 'DISABLED';
    const pair: FxPair = { baseAsset, quoteCurrency: settings.quoteCurrency };
    const claimed = await this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return false;
      return this.deps.repository.claimRefresh(
        scope,
        pair,
        {
          now,
          leaseUntil: new Date(now.getTime() + FX_REFRESH_LEASE_MS),
          dueBefore: new Date(now.getTime() - settings.freshTtlSeconds * 1_000),
        },
        tx,
      );
    });
    if (!claimed) return 'NOT_DUE';
    return this.performRefresh(scope, settings, pair);
  }

  /**
   * An operator's manual refresh (the FX section's button). Charges
   * `payments.gateways.edit`, audits who pressed it, and refreshes NOW whatever the
   * quote's age — but never past another replica's lease, and never while the feature is
   * off: a refresh that stored a quote nothing may use would be a figure on the screen
   * that no invoice can be priced by.
   */
  async refresh(
    scope: TenantContext,
    actor: ActorContext,
    baseAsset: FxBaseAsset,
  ): Promise<{ readonly outcome: FxRefreshOutcome; readonly status: FxStatus }> {
    await this.deps.guard.check(scope, actor, FX_REFRESH_PERMISSION);
    const now = this.deps.clock.now();
    const settings = await this.settingsFor(scope);
    const pair: FxPair = { baseAsset, quoteCurrency: settings.quoteCurrency };
    let outcome: FxRefreshOutcome;
    if (!settings.enabled) {
      outcome = 'DISABLED';
    } else {
      const claimed = await this.deps.uow.run(scope, async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return false;
        return this.deps.repository.claimRefresh(
          scope,
          pair,
          { now, leaseUntil: new Date(now.getTime() + FX_REFRESH_LEASE_MS), dueBefore: null },
          tx,
        );
      });
      outcome = claimed ? await this.performRefresh(scope, settings, pair) : 'BUSY';
    }
    await this.deps.audit.record(scope, actor, {
      action: 'fx.refresh',
      entityType: 'FxQuote',
      entityId: pairKey(pair),
      before: null,
      after: { pair: pairKey(pair), outcome },
      result: 'SUCCESS',
    });
    return { outcome, status: await this.statusUnchecked(scope, baseAsset) };
  }

  // ---------------------------------------------------------------------------------------

  private async statusUnchecked(scope: TenantContext, baseAsset: FxBaseAsset): Promise<FxStatus> {
    const now = this.deps.clock.now();
    const settings = await this.settingsFor(scope);
    const pair: FxPair = { baseAsset, quoteCurrency: settings.quoteCurrency };
    const [row, sources] = await Promise.all([
      this.deps.repository.find(scope, pair),
      this.deps.repository.sourceStates(scope),
    ]);
    const answer = this.answerFrom(settings, pair, row, now);
    const usable = answer.kind === 'QUOTE' ? answer.quote : null;
    const routes: FxRouteStatus[] = [];
    for (const provider of PAYMENT_GATEWAY_PROVIDERS) {
      const spec = PAYMENT_GATEWAY_DESCRIPTORS[provider].conversion;
      if (spec.fxBaseAsset !== baseAsset || spec.unitRatioSetting === null) continue;
      const mode =
        spec.modeSetting === null
          ? null
          : await this.deps.settings.valueOf<unknown>(scope, settingKeyOf(spec.modeSetting));
      const unitRatioText = await this.deps.settings.valueOf<string>(
        scope,
        settingKeyOf(spec.unitRatioSetting),
      );
      const unitRatio = parseUnitRatio(unitRatioText);
      const gateway = await this.deps.gateways.find(scope, provider);
      routes.push({
        provider,
        mode: conversionPolicyFor(spec, mode),
        unitRatioText,
        fixedRateMinor: gateway?.providerUnitRateMinor ?? null,
        centralRatePerUnit:
          usable === null || unitRatio === null ? null : effectiveMinorPerUnit(usable.rate, unitRatio),
      });
    }
    return {
      settings,
      pair,
      state: usable?.state ?? 'UNAVAILABLE',
      quote: answer.kind === 'QUOTE' ? answer.quote : answer.stale,
      row,
      sources,
      routes,
      policyVersion: FX_POLICY_VERSION,
    };
  }

  /** The lease is held. Dial, judge, store or release, and tell the operator. */
  private async performRefresh(
    scope: TenantContext,
    settings: FxSettings,
    pair: FxPair,
  ): Promise<FxRefreshOutcome> {
    const order: FxSource[] = [settings.primary];
    if (settings.fallback !== 'NONE' && settings.fallback !== settings.primary) {
      order.push(settings.fallback);
    }
    const startedAt = this.deps.clock.now();
    const [row, states] = await Promise.all([
      this.deps.repository.find(scope, pair),
      this.deps.repository.sourceStates(scope),
    ]);
    const lastKnownGood =
      row?.quote === null || row === null
        ? null
        : {
            rate: row.quote.rate,
            trusted:
              fxQuoteStateFor(
                ageSeconds(row.quote.fetchedAt, startedAt),
                settings.freshTtlSeconds,
                settings.maxStaleSeconds,
              ) !== 'UNAVAILABLE',
          };

    const judged: JudgedCandidate[] = [];
    const failures: { source: FxSource; code: string; retryAfter: Date | null }[] = [];
    const successes: FxSource[] = [];
    const rejected: { source: FxSource; code: string; deviationBps: bigint | null }[] = [];

    for (const source of order) {
      const state = states.find((entry) => entry.source === source);
      const now = this.deps.clock.now();
      if (state?.retryAfter !== null && state?.retryAfter !== undefined && state.retryAfter > now) {
        // Still inside the cooldown a rate-limit answer asked for. Not a new failure.
        continue;
      }
      const adapter = this.deps.sources.get(source);
      if (adapter === undefined) {
        failures.push({ source, code: 'nexa.no_adapter', retryAfter: null });
        continue;
      }
      const outcome = await adapter.read(pair.baseAsset);
      const answeredAt = this.deps.clock.now();
      if (outcome.kind === 'RATE_LIMITED') {
        failures.push({
          source,
          code: outcome.code,
          retryAfter: new Date(answeredAt.getTime() + FX_RATE_LIMIT_COOLDOWN_MS),
        });
        continue;
      }
      if (outcome.kind === 'UNAVAILABLE') {
        failures.push({ source, code: outcome.code, retryAfter: null });
        continue;
      }
      const candidate = toCandidate(outcome.reading, pair.quoteCurrency);
      const verdict = judgeCandidate(candidate, pair.baseAsset, pair.quoteCurrency, lastKnownGood);
      judged.push({ candidate, verdict });
      if (verdict.kind === 'ACCEPT') {
        successes.push(source);
        // The primary answered and was accepted: the fallback is not dialled.
        break;
      }
      rejected.push({
        source,
        code: verdictCode(verdict),
        deviationBps: verdict.kind === 'OUTLIER' ? verdict.deviationBps : null,
      });
    }

    const chosen = chooseQuote(judged);
    const fetchedAt = this.deps.clock.now();
    // A candidate chosen because two outliers agreed counts as that source's success too.
    if (chosen !== null && !successes.includes(chosen.source)) successes.push(chosen.source);

    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 'FAILED';
      for (const failure of failures) {
        await this.deps.repository.recordSourceFailure(
          scope,
          failure.source,
          { now: fetchedAt, code: failure.code, retryAfter: failure.retryAfter },
          tx,
        );
        await this.deps.opsLog.record(
          scope,
          {
            code: FX_SOURCE_UNAVAILABLE_CODE,
            severity: 'WARN',
            message:
              'An exchange-rate source did not answer usably. The other source, or the ' +
              'last-known-good quote inside its stale limit, prices new invoices meanwhile.',
            dedupeKey: `${FX_SOURCE_UNAVAILABLE_CODE}:${failure.source}`,
            context: { source: failure.source, reason: failure.code, pair: pairKey(pair) },
          },
          tx,
        );
      }
      for (const entry of rejected) {
        if (chosen !== null && entry.source === chosen.source) continue;
        await this.deps.repository.recordSourceFailure(
          scope,
          entry.source,
          { now: fetchedAt, code: entry.code, retryAfter: null },
          tx,
        );
        await this.deps.opsLog.record(
          scope,
          {
            code: FX_QUOTE_REJECTED_CODE,
            severity: 'WARN',
            message:
              'An exchange-rate source answered a figure this installation refused: not ' +
              'positive, outside the pair’s sanity rails, or too far from the last-known-good ' +
              'without the other source agreeing.',
            dedupeKey: `${FX_QUOTE_REJECTED_CODE}:${entry.source}`,
            context: {
              source: entry.source,
              reason: entry.code,
              deviationBps: entry.deviationBps?.toString() ?? null,
              pair: pairKey(pair),
            },
          },
          tx,
        );
      }
      for (const source of successes) {
        await this.deps.repository.recordSourceSuccess(scope, source, fetchedAt, tx);
      }
      const open = new Set(
        await this.deps.conditions.openConditions(
          scope,
          [
            ...successes.map((source) => `${FX_SOURCE_UNAVAILABLE_CODE}:${source}`),
            ...successes.map((source) => `${FX_QUOTE_REJECTED_CODE}:${source}`),
            `${FX_FALLBACK_IN_USE_CODE}:${pairKey(pair)}`,
            `${FX_QUOTE_UNAVAILABLE_CODE}:${pairKey(pair)}`,
            `${FX_STALE_QUOTE_USED_CODE}:${pairKey(pair)}`,
          ],
          tx,
        ),
      );
      for (const source of successes) {
        await this.recoverIfOpen(scope, open, FX_SOURCE_UNAVAILABLE_CODE, source, tx);
        await this.recoverIfOpen(scope, open, FX_QUOTE_REJECTED_CODE, source, tx);
      }

      if (chosen === null) {
        await this.deps.repository.releaseRefresh(
          scope,
          pair,
          { now: fetchedAt, errorCode: refreshErrorCode(failures, rejected) },
          tx,
        );
        const usable =
          row?.quote !== null &&
          row !== null &&
          fxQuoteStateFor(
            ageSeconds(row.quote.fetchedAt, fetchedAt),
            settings.freshTtlSeconds,
            settings.maxStaleSeconds,
          ) !== 'UNAVAILABLE';
        if (!usable) {
          await this.deps.opsLog.record(
            scope,
            {
              code: FX_QUOTE_UNAVAILABLE_CODE,
              severity: 'ERROR',
              message:
                'No usable exchange rate: every source failed and the last-known-good quote is ' +
                'past the stale limit (or was never fetched). New invoices through a ' +
                'central-rate route are refused until a source answers.',
              dedupeKey: `${FX_QUOTE_UNAVAILABLE_CODE}:${pairKey(pair)}`,
              context: { pair: pairKey(pair), reason: refreshErrorCode(failures, rejected) },
            },
            tx,
          );
        }
        this.deps.logger.warn(
          { pair: pairKey(pair), failures, rejected: rejected.map((r) => r.code) },
          'fx refresh stored no quote',
        );
        return 'FAILED';
      }

      const stored = await this.storeChosen(scope, pair, chosen, fetchedAt, tx);
      if (!stored) {
        // A newer quote landed meanwhile (another replica's operator refresh). Not a failure.
        return 'REFRESHED';
      }
      await this.recoverIfOpen(scope, open, FX_QUOTE_UNAVAILABLE_CODE, pairKey(pair), tx);
      await this.recoverIfOpen(scope, open, FX_STALE_QUOTE_USED_CODE, pairKey(pair), tx);
      if (chosen.source === settings.primary) {
        await this.recoverIfOpen(scope, open, FX_FALLBACK_IN_USE_CODE, pairKey(pair), tx);
        this.deps.logger.info({ pair: pairKey(pair), source: chosen.source }, 'fx quote refreshed');
        return 'REFRESHED';
      }
      await this.deps.opsLog.record(
        scope,
        {
          code: FX_FALLBACK_IN_USE_CODE,
          severity: 'WARN',
          message:
            'The primary exchange-rate source did not price the pair; the fallback did. New ' +
            'invoices are priced by the fallback until the primary answers again.',
          dedupeKey: `${FX_FALLBACK_IN_USE_CODE}:${pairKey(pair)}`,
          context: { pair: pairKey(pair), primary: settings.primary, fallback: chosen.source },
        },
        tx,
      );
      this.deps.logger.info(
        { pair: pairKey(pair), source: chosen.source },
        'fx quote refreshed by the fallback',
      );
      return 'REFRESHED_BY_FALLBACK';
    });
  }

  private async storeChosen(
    scope: TenantContext,
    pair: FxPair,
    chosen: FxCandidate,
    fetchedAt: Date,
    tx: unknown,
  ): Promise<boolean> {
    const rate = normaliseRate(chosen.rate);
    return this.deps.repository.storeQuote(
      scope,
      pair,
      {
        rate,
        source: chosen.source,
        sourceAt: chosen.sourceAt,
        fetchedAt,
        quoteId: fxQuoteId({
          source: chosen.source,
          baseAsset: pair.baseAsset,
          quoteCurrency: pair.quoteCurrency,
          rate,
          sourceAt: chosen.sourceAt,
          fetchedAt,
          policyVersion: FX_POLICY_VERSION,
        }),
        policyVersion: FX_POLICY_VERSION,
      },
      fetchedAt,
      tx,
    );
  }

  private async recoverIfOpen(
    scope: TenantContext,
    open: ReadonlySet<string>,
    code: string,
    subject: string,
    tx: unknown,
  ): Promise<void> {
    const dedupeKey = `${code}:${subject}`;
    if (!open.has(dedupeKey)) return;
    await this.deps.opsLog.record(
      scope,
      {
        code: `${code}.recovered`,
        severity: 'INFO',
        message: 'The exchange-rate condition cleared.',
        recoversCode: code,
        recoversDedupeKey: dedupeKey,
        context: { subject },
      },
      tx,
    );
  }

  private answerFrom(
    settings: FxSettings,
    pair: FxPair,
    row: FxQuoteRow | null,
    now: Date,
  ): FxQuoteAnswer {
    if (row === null || row.quote === null) {
      return { kind: 'UNAVAILABLE', reason: settings.enabled ? 'NEVER_FETCHED' : 'DISABLED', stale: null };
    }
    const age = ageSeconds(row.quote.fetchedAt, now);
    const state = settings.enabled
      ? fxQuoteStateFor(age, settings.freshTtlSeconds, settings.maxStaleSeconds)
      : 'UNAVAILABLE';
    const quote: FxQuote = {
      baseAsset: pair.baseAsset,
      quoteCurrency: pair.quoteCurrency,
      side: FX_QUOTE_SIDE,
      rate: row.quote.rate,
      source: row.quote.source,
      sourceAt: row.quote.sourceAt,
      fetchedAt: row.quote.fetchedAt,
      ageSeconds: age,
      state,
      quoteId: row.quote.quoteId,
      policyVersion: row.quote.policyVersion,
    };
    if (state === 'UNAVAILABLE') {
      return { kind: 'UNAVAILABLE', reason: settings.enabled ? 'TOO_STALE' : 'DISABLED', stale: quote };
    }
    return { kind: 'QUOTE', quote };
  }

  private async settingsFor(scope: TenantContext, tx?: unknown): Promise<FxSettings> {
    const [enabled, primary, fallback, freshTtlSeconds, maxStaleSeconds, quoteCurrency] =
      await Promise.all([
        this.deps.features.isEnabled(scope, CENTRAL_FX_FLAG, tx),
        this.deps.settings.valueOf<FxSource>(scope, 'fx.primary_source', tx),
        this.deps.settings.valueOf<FxFallbackSource>(scope, 'fx.fallback_source', tx),
        this.deps.settings.valueOf<number>(scope, 'fx.fresh_ttl_seconds', tx),
        this.deps.settings.valueOf<number>(scope, 'fx.max_stale_seconds', tx),
        this.deps.settings.valueOf<SalesCurrencyCode>(scope, 'sales.currency', tx),
      ]);
    return { enabled, primary, fallback, freshTtlSeconds, maxStaleSeconds, quoteCurrency };
  }
}

/** Whole seconds since `fetchedAt`, never negative (a clock that stepped back reads as zero). */
export function ageSeconds(fetchedAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - fetchedAt.getTime()) / 1_000));
}

export function pairKey(pair: FxPair): string {
  return `${pair.baseAsset}-${pair.quoteCurrency}`;
}

/** A descriptor names its settings as strings; the registry says whether they exist. */
function settingKeyOf(name: string): SettingKey {
  if (!isSettingKey(name)) throw new Error(`A gateway descriptor names an unknown setting: ${name}`);
  return name;
}

function refreshErrorCode(
  failures: readonly { source: FxSource; code: string }[],
  rejected: readonly { source: FxSource; code: string }[],
): string {
  const first = failures[0] ?? rejected[0];
  if (first === undefined) return 'nexa.no_source';
  return `${first.source.toLowerCase()}:${first.code}`.slice(0, 64);
}
