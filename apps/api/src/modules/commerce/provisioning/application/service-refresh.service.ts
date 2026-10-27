import {
  COMMERCE_ERROR_CODES,
  CUSTOMER_SYNC_MIN_INTERVAL_MS,
  customerActionVerdict,
  effectiveCooldownMs,
  isNexaError,
  servicePanelAccountMissingKey,
  SERVICE_PANEL_ACCOUNT_MISSING_CODE,
  type ActorContext,
  type Clock,
  type OperationalEventRecorder,
  type ProviderAdapter,
  type ProviderFailureKind,
  type ProviderLastSeen,
  type ProviderLookupOutcome,
  type ProviderServiceTarget,
  type ProviderType,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type {
  PanelCredentialStore,
  PanelRepository,
  ProbeBudget,
} from '../../../platform/panels/application/ports.js';
import { toProviderCredentials } from '../../../platform/panels/application/probe-core.js';
import type { PanelPolicyGate } from '../../../platform/panels/application/panel-policy.js';
import { isConfirmedUnusable } from '../../../platform/panels/application/panel-eligibility.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { UsageSnapshotService } from './usage-snapshots.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SafeHttpClient } from '../../../../infrastructure/net/safe-http.js';
import { panelClient } from '../../../platform/panels/application/panel-http.js';
import { checkUrl, type UrlPolicyOptions } from '../../../../infrastructure/net/url-policy.js';
import { decideOperability } from './panel-operability.js';
import { OPERATION_LEGAL_FROM, providerRefFor, usageSyncCall } from './provision-executor.js';
import type { ServiceRecord, ServiceRepository } from './ports.js';
import { closePanelAccountMissing, type ServiceConditionReader } from './panel-account-recovery.js';
import { CUSTOMER_ROTATION_PERMISSION, type ProvisioningService } from './provisioning.service.js';

/**
 * How one refresh ended. The surface redraws the card from the database for every answer
 * but `FAILED` and `NOT_FOUND`.
 *
 * - `REFRESHED`: the panel was read and the figure written.
 * - `RECENT`: read within the minimum interval; the stored figure IS the fresh one, and
 *   the panel is not asked again (a tapped button must not dial a panel in a loop).
 * - `NOT_READ`: nothing to read in this state (a service suspended or expired since the
 *   card was drawn), or the operator no longer offers the read on this panel — the card
 *   is redrawn as it now stands, which also removes the button.
 * - `FAILED`: the panel could not be read, or no read could be made (budget, tenant
 *   stopped, panel not operable). Nothing was written; the card must stay as it is.
 */
export type ServiceRefreshResult =
  | { readonly outcome: 'REFRESHED' | 'RECENT' | 'NOT_READ' | 'FAILED' }
  | { readonly outcome: 'NOT_FOUND' };

/**
 * Track 3 §1: how long a live check's answer stands before a card opened again asks the
 * panel again — a found account (through `usage_synced_at`, the same column the «♻️»
 * button's interval reads, lengthened by the panel's policy) and a missing one alike. So
 * repeated taps on one card do not dial a panel in a loop.
 */
export const SERVICE_LIVE_CHECK_CACHE_MS = 30_000;

/**
 * Track 3 §1: the hard bound on the whole live check a card's opening waits for — every
 * request of both reads, log-in included. Past it the stored card is drawn with when it
 * was last read; the customer never waits out the panel client's own, longer, timeout.
 */
export const SERVICE_LIVE_CHECK_TIMEOUT_MS = 1_500;

/**
 * Why a live check drew the STORED card. Each is a different fact and they are never
 * collapsed (CLAUDE.md): a timeout is not a rate limit, and neither is "the panel says
 * the account is not there" — that one is `MISSING_ON_PANEL`, never a reason here.
 *
 * - `TIMEOUT`: the panel did not answer inside `SERVICE_LIVE_CHECK_TIMEOUT_MS`, or the
 *   client's own timeout fired first.
 * - `RATE_LIMITED`: the PANEL answered 429.
 * - `BUDGET`: this installation's own outbound budget for the tenant is spent (above the
 *   background floor); nothing was sent.
 * - `PANEL_UNAVAILABLE`: unreachable, refused, malformed, a 5xx, a credential that cannot
 *   be used, a panel the monitor has confirmed unusable, a panel not operable now.
 * - `UNSUPPORTED`: the panel's provider declares no proven read (`READ_USAGE`): there is
 *   nothing this release may ask it, so the stored card is the answer.
 * - `IN_FLIGHT`: another read of this service is in flight; it will write what it finds.
 * - `INACTIVE`: the tenant stopped accepting work between the tap and the read.
 */
export type ServiceLiveCheckStaleReason =
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'BUDGET'
  | 'PANEL_UNAVAILABLE'
  | 'UNSUPPORTED'
  | 'IN_FLIGHT'
  | 'INACTIVE';

/**
 * How the live check made on opening a card ended (Track 3 §1).
 *
 * - `NOT_FOUND`: not theirs, or not there — the card's own not-found answer.
 * - `NOT_READ`: nothing to read in this state (suspended, expired…), or the operator does
 *   not offer customer reads on this panel: the stored card, as it stands.
 * - `FRESH`: `PANEL` — read now and written; `CACHE` — read within the cache window.
 * - `MISSING_ON_PANEL`: the panel answered, twice, that the account does not exist
 *   (`PANEL`), or said so within the cache window (`CACHE`). Nothing about the service was
 *   changed; an operational condition was opened for an operator.
 * - `STALE`: no answer now; the stored card is drawn with when it was last read.
 */
export type ServiceLiveCheckResult =
  | { readonly outcome: 'NOT_FOUND' | 'NOT_READ' }
  | { readonly outcome: 'FRESH' | 'MISSING_ON_PANEL'; readonly source: 'PANEL' | 'CACHE' }
  | { readonly outcome: 'STALE'; readonly reason: ServiceLiveCheckStaleReason };

export type { ServiceConditionReader } from './panel-account-recovery.js';

/**
 * The one-at-a-time rule for the refresh button, as the database holds it
 * (`services.usage_refresh_started_at`). Both are conditional UPDATEs; neither is a setter.
 */
export interface UsageRefreshReservations {
  /**
   * Marks a read in flight, at `now`, only when none is (or the one there started before
   * `inFlightBefore`, and so is dead) AND usage was not read after `syncedBefore`, and the
   * service is ACTIVE. `false` means another tap holds it, or the figure is fresh: either
   * way nothing is dialled.
   */
  reserveUsageRefresh(
    scope: TenantContext,
    id: string,
    at: { readonly now: Date; readonly syncedBefore: Date; readonly inFlightBefore: Date },
    tx: TransactionScope,
  ): Promise<boolean>;
  /** Clears THIS reservation (the one started at `startedAt`), and no later one. */
  endUsageRefresh(
    scope: TenantContext,
    id: string,
    startedAt: Date,
    tx: TransactionScope,
  ): Promise<void>;
}

/** Thrown inside the admission transaction to roll the reservation back with it. */
class RefreshBudgetRefused extends Error {}

export interface ServiceRefreshDeps {
  readonly services: Pick<ProvisioningService, 'getForCustomer'>;
  readonly rows: Pick<
    ServiceRepository,
    'recordUsage' | 'markMissingOnPanel' | 'clearMissingOnPanel'
  > &
    UsageRefreshReservations;
  /**
   * How long an on-tap read may be in flight before its reservation is presumed dead
   * (the process that held it crashed): longer than the read can take — the panel client's
   * timeout for each request the read makes, plus a margin.
   */
  readonly inFlightMs: number;
  readonly panels: Pick<PanelRepository, 'find' | 'takeProbeBudget'>;
  readonly credentials: Pick<PanelCredentialStore, 'read'>;
  readonly adapters: (type: ProviderType) => ProviderAdapter;
  readonly implementedProviderTypes: readonly ProviderType[];
  readonly http: Pick<SafeHttpClient, 'forBase'>;
  readonly urlPolicy: UrlPolicyOptions;
  readonly probeBudget: ProbeBudget;
  /**
   * Pre-support A2: the floor an OPPORTUNISTIC read (a card being opened) must leave in the
   * tenant's bucket — the background floor the scheduled usage sweep already uses
   * (`usageSyncBudgetReserveFor`), on the SAME bucket. A tapped «♻️» takes from the floor
   * as it always did (reserve 0); an open is housekeeping and is outranked by the monitor,
   * a paid create and an operator's test.
   */
  readonly backgroundBudgetReserve: number;
  readonly guard: PermissionGuard;
  readonly scopeActivity: ScopeActivityReader;
  /** R11 B2: the figure a live check just wrote, kept for the usage chart. */
  readonly usageSnapshots: Pick<UsageSnapshotService, 'record'>;
  readonly panelPolicy: PanelPolicyGate;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  /**
   * Track 3 §1: where a live check's verdict is told to an operator — the missing-account
   * condition, and its recovery when a later read finds the account.
   */
  readonly opsEvents: Pick<OperationalEventRecorder, 'record'>;
  readonly conditions: ServiceConditionReader;
  /**
   * The client the live check on opening dials through: the same URL policy and size cap
   * as `http`, with a per-request timeout no longer than `liveCheckTimeoutMs`, so a read
   * the deadline gave up on does not outlive it by the panel client's full timeout.
   * Defaults to `http`.
   */
  readonly liveHttp?: Pick<SafeHttpClient, 'forBase'>;
  /** Defaults to `SERVICE_LIVE_CHECK_TIMEOUT_MS`. */
  readonly liveCheckTimeoutMs?: number;
  /** Defaults to `SERVICE_LIVE_CHECK_CACHE_MS`. */
  readonly liveCheckCacheMs?: number;
}

/** What `prepare` resolved: everything a read needs, and nothing has left yet. */
interface PreparedRead {
  readonly adapter: ProviderAdapter;
  readonly target: ProviderServiceTarget;
  readonly baseUrl: string;
}

type Admission = 'ADMITTED' | 'INACTIVE' | 'HELD' | 'BUDGET';

/** A deadline passed before the panel answered. A value, never a thrown error. */
const DEADLINE_PASSED = Symbol('deadline-passed');

/**
 * `work`, or `DEADLINE_PASSED` if `ms` elapses first. The work is not cancelled — the
 * client bounds it — but its late answer (or late rejection) is dropped, never raised.
 */
async function withinDeadline<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | typeof DEADLINE_PASSED> {
  if (ms <= 0) {
    work.catch(() => null);
    return DEADLINE_PASSED;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof DEADLINE_PASSED>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_PASSED), ms);
  });
  try {
    const winner = await Promise.race([work, expiry]);
    if (winner === DEADLINE_PASSED) work.catch(() => null);
    return winner;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The stale reason a provider failure is. `RATE_LIMITED` and `TIMEOUT` stay themselves. */
function staleReasonOf(failure: ProviderFailureKind): ServiceLiveCheckStaleReason {
  if (failure === 'TIMEOUT') return 'TIMEOUT';
  if (failure === 'RATE_LIMITED') return 'RATE_LIMITED';
  return 'PANEL_UNAVAILABLE';
}

/** The in-process memory of missing verdicts is bounded; the oldest is forgotten first. */
const MISSING_VERDICTS_MAX = 10_000;

/**
 * «♻️ بروزرسانی اطلاعات» (R3 item 7): one bounded usage READ, made while the customer
 * waits, so the SAME card can be redrawn with the answer — or left untouched with a short
 * notice when there is none.
 *
 * ## Why a synchronous read, and not the SYNC_USAGE operation
 *
 * Until R3 this tap queued a `SYNC_USAGE` operation and answered «request registered,
 * the result will follow», and the lane later sent a second message. The owner's rule is
 * one card, edited in place, with no such messages, and a notice on failure. Two ways to
 * do that were weighed:
 *
 * - the operation, then an edit of the stored card when it completes: the provisioner
 *   ticks every few seconds, a failed read is retried by the attempt machinery for
 *   minutes before it is terminal, and a failure could then only be told as a MESSAGE —
 *   the tap's callback is long expired, so the notice the owner asked for is impossible;
 * - a bounded read from the tap: the customer sees the refreshed card, or the notice,
 *   in the same turn.
 *
 * The second is chosen because the operation model exists for what this is NOT. It
 * orders and retries MUTATIONS, and settles an `UNKNOWN` outcome by reconciliation; a
 * usage read mutates nothing, cannot be `UNKNOWN` (`isMutatingOperation`), and a read
 * that failed changed nothing by definition. Package E already reads a panel from a
 * customer's tap under exactly these bounds (`SubscriptionFileService`), and this is the
 * same shape:
 *
 * - the network call is OUTSIDE every transaction; the budget is taken in one before it
 *   and the figure written in another after it;
 * - the tenant's outbound panel budget (`takeProbeBudget`, reserve 0) is spent, like
 *   every other panel read, so a tapping customer cannot raise a tenant's outbound rate;
 * - the address goes through `SafeHttpClient` and the URL policy, with the client's own
 *   timeout — the turn waits at most that long;
 * - the minimum interval (`CUSTOMER_SYNC_MIN_INTERVAL_MS`, lengthened by the panel's
 *   policy) is kept: inside it the panel is not asked and the stored figure is shown;
 * - the write is `recordUsage`, the SAME conditional UPDATE `SYNC_USAGE` makes: only on a
 *   successful read, only what the panel returned, and only while the service is still
 *   ACTIVE. The scheduled `SYNC_USAGE` is unchanged and still keeps every service fresh.
 *
 * Expiry, status and the traffic limit are Nexa's own records, written by the operations
 * that change them; the card shows them as the database holds them now. What the panel
 * owns and a refresh reads is usage and the last connection.
 */
export class ServiceRefreshService {
  /**
   * Track 3 §1: `tenant:service` → when the panel last answered, twice, that the account
   * is missing. A CACHE, not a decision: it only saves a panel being asked again inside
   * the window, and a replica that does not hold the entry asks the panel — still bounded
   * by the tenant's one durable budget. The durable record is the operational condition.
   */
  private readonly missingVerdicts = new Map<string, number>();

  constructor(private readonly deps: ServiceRefreshDeps) {}

  async refresh(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly customerId: UserId; readonly serviceId: string },
  ): Promise<ServiceRefreshResult> {
    await this.deps.guard.check(scope, actor, CUSTOMER_ROTATION_PERMISSION);

    const service = await this.ownService(scope, input);
    if (service === null) return { outcome: 'NOT_FOUND' };
    if (!OPERATION_LEGAL_FROM.SYNC_USAGE.includes(service.state)) return { outcome: 'NOT_READ' };

    const policy = await this.deps.panelPolicy.forPanel(scope, service.panelId);
    if (!customerActionVerdict(policy, 'USAGE_READ').allowed) return { outcome: 'NOT_READ' };
    const interval = effectiveCooldownMs(CUSTOMER_SYNC_MIN_INTERVAL_MS, policy, 'USAGE_READ');
    if (
      service.usageSyncedAt !== null &&
      this.deps.clock.now().getTime() - service.usageSyncedAt.getTime() < interval
    ) {
      return { outcome: 'RECENT' };
    }

    const view = await this.deps.panels.find(scope, service.panelId);
    const prepared = await this.prepare(scope, service, view);
    if (!('adapter' in prepared)) return { outcome: 'FAILED' };

    /*
     * The tenant gate, the reservation and the budget, in ONE transaction, before anything
     * leaves. The interval check above read a row that two taps (or a redelivered update)
     * can both have read; this conditional UPDATE is the check that holds, because the
     * second waits on the first's row lock and then finds the reservation taken. A budget
     * refused throws, so the reservation rolls back with it and the next tap may try.
     */
    const startedAt = this.deps.clock.now();
    const admission = await this.admit(scope, service.id, interval, startedAt, 0);
    if (admission === 'INACTIVE' || admission === 'BUDGET') return { outcome: 'FAILED' };
    // Another tap is reading, or has just read: the card is redrawn from what is stored.
    if (admission === 'HELD') return { outcome: 'RECENT' };

    let ended = false;
    try {
      const read = await usageSyncCall(
        prepared.adapter,
        prepared.target,
        panelClient(this.deps.http, {
          baseUrl: prepared.baseUrl,
          activation: prepared.target.activation,
        }),
        providerRefFor(service),
      );
      if (!read.ok) return { outcome: 'FAILED' };
      const written = await this.recordFound(scope, service, startedAt, read.usage);
      ended = true;
      return { outcome: written ? 'REFRESHED' : 'FAILED' };
    } finally {
      // A read that failed or threw gives the reservation back, so the next tap may try.
      if (!ended) await this.endReservation(scope, service.id, startedAt);
    }
  }

  /**
   * Track 3 §1 — the live check a card makes when the customer OPENS it: the account read
   * from the panel, bounded hard at `liveCheckTimeoutMs`, so the card shows what the panel
   * holds now rather than what the last sync wrote.
   *
   * Three answers, kept apart at every step:
   *
   * - **found**: the figure is written (`recordFound`, the same conditional UPDATE the
   *   «♻️» button and `SYNC_USAGE` make) and the card drawn fresh; an open missing-account
   *   condition for this service is closed by its recovery in the same transaction;
   * - **not found**, twice: `lookupUser`'s `found: false` is a POSITIVE statement — the
   *   panel answered, authenticated, that it does not have the account — and a SECOND read
   *   must say it again before anything is concluded. Then, and only then, the
   *   missing-account condition is recorded for an operator. The service is NOT touched:
   *   no state change, no delete, no refund — a customer's tap decides none of that;
   * - **no answer** (timeout, the panel's 429, a panel down, the budget spent): the stored
   *   card, with when it was last read. Never an error and never "not found".
   *
   * The read is `lookupUser`, and only where the provider declares `READ_USAGE`: every
   * adapter's `readUsage` IS `lookupUser` plus a check, which folds `found: false` into a
   * `PROVIDER_ERROR` and so cannot tell "missing" from "broken". Calling the lookup it
   * already makes — gated on the capability that read is declared under, evidenced by the
   * real-panel acceptance that declared it — reads nothing new and declares nothing new.
   * A provider without `READ_USAGE` is not asked at all.
   *
   * Every bound the «♻️» read has holds: the panel's customer-read policy, the panel client
   * and URL policy, the one-read-in-flight reservation, a confirmed-unusable panel left
   * alone, and the tenant's ONE outbound budget taken above the background floor — one
   * token per read, the confirming read included.
   */
  async liveCheck(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly customerId: UserId; readonly serviceId: string },
  ): Promise<ServiceLiveCheckResult> {
    await this.deps.guard.check(scope, actor, CUSTOMER_ROTATION_PERMISSION);

    const service = await this.ownService(scope, input);
    if (service === null) return { outcome: 'NOT_FOUND' };
    if (!OPERATION_LEGAL_FROM.SYNC_USAGE.includes(service.state)) return { outcome: 'NOT_READ' };

    const policy = await this.deps.panelPolicy.forPanel(scope, service.panelId);
    if (!customerActionVerdict(policy, 'USAGE_READ').allowed) return { outcome: 'NOT_READ' };

    const cacheMs = this.deps.liveCheckCacheMs ?? SERVICE_LIVE_CHECK_CACHE_MS;
    const now = this.deps.clock.now().getTime();
    const verdictKey = `${scope.tenantId}:${service.id}`;
    const missingAt = this.missingVerdicts.get(verdictKey);
    if (missingAt !== undefined) {
      if (now - missingAt < cacheMs) return { outcome: 'MISSING_ON_PANEL', source: 'CACHE' };
      this.missingVerdicts.delete(verdictKey);
    }
    const interval = effectiveCooldownMs(cacheMs, policy, 'USAGE_READ');
    if (
      service.usageSyncedAt !== null &&
      now - service.usageSyncedAt.getTime() < interval &&
      // A fresh figure from some other writer says the panel answered — but while this
      // service's missing-account condition is open, the cache is not trusted: the panel
      // is read so the answer (and the condition's recovery) comes from the panel itself.
      !(await this.deps.conditions.conditionIsOpen(
        scope,
        servicePanelAccountMissingKey(service.id),
      ))
    ) {
      return { outcome: 'FRESH', source: 'CACHE' };
    }

    /*
     * A panel the monitor has CONFIRMED unusable is not dialled: during an outage a failed
     * read writes no `usage_synced_at` and gives its reservation back, so the cache window
     * does not hold, and every open would spend a token on a panel known to be down.
     */
    const view = await this.deps.panels.find(scope, service.panelId);
    if (view !== null && isConfirmedUnusable(view.health, this.deps.clock.now())) {
      return { outcome: 'STALE', reason: 'PANEL_UNAVAILABLE' };
    }
    const http = this.deps.liveHttp ?? this.deps.http;
    const prepared = await this.prepare(scope, service, view);
    if (!('adapter' in prepared)) return { outcome: 'STALE', reason: prepared.refused };

    const startedAt = this.deps.clock.now();
    const admission = await this.admit(
      scope,
      service.id,
      interval,
      startedAt,
      this.deps.backgroundBudgetReserve,
    );
    if (admission === 'INACTIVE') return { outcome: 'STALE', reason: 'INACTIVE' };
    if (admission === 'BUDGET') return { outcome: 'STALE', reason: 'BUDGET' };
    if (admission === 'HELD') return { outcome: 'STALE', reason: 'IN_FLIGHT' };

    const timeoutMs = this.deps.liveCheckTimeoutMs ?? SERVICE_LIVE_CHECK_TIMEOUT_MS;
    const client = panelClient(http, {
      baseUrl: prepared.baseUrl,
      activation: prepared.target.activation,
    });
    const ref = providerRefFor(service);
    const lookup = async (): Promise<ProviderLookupOutcome | typeof DEADLINE_PASSED> => {
      // Decided BEFORE the request exists (Codex on #291): a first read that spent the
      // whole deadline must not start a confirming request nobody will wait for.
      const remaining = timeoutMs - (this.deps.clock.now().getTime() - startedAt.getTime());
      if (remaining <= 0) return DEADLINE_PASSED;
      return withinDeadline(prepared.adapter.lookupUser(prepared.target, client, ref), remaining);
    };

    let ended = false;
    try {
      let read = await lookup();
      if (read === DEADLINE_PASSED) return { outcome: 'STALE', reason: 'TIMEOUT' };
      if (!read.ok) return { outcome: 'STALE', reason: staleReasonOf(read.failure) };

      if (!read.found) {
        // One `found: false` is not yet a verdict: the second read must say it again,
        // and it spends its own token from the same bucket, above the same floor.
        if (!(await this.takeSecondToken(scope))) return { outcome: 'STALE', reason: 'BUDGET' };
        read = await lookup();
        if (read === DEADLINE_PASSED) return { outcome: 'STALE', reason: 'TIMEOUT' };
        if (!read.ok) return { outcome: 'STALE', reason: staleReasonOf(read.failure) };
      }

      if (!read.found) {
        const recorded = await this.recordMissing(scope, service, startedAt);
        ended = true;
        if (!recorded) return { outcome: 'STALE', reason: 'INACTIVE' };
        this.rememberMissing(verdictKey, this.deps.clock.now().getTime());
        return { outcome: 'MISSING_ON_PANEL', source: 'PANEL' };
      }

      this.missingVerdicts.delete(verdictKey);
      // The record is there and its usage could not be read: not "missing", not "fresh".
      if (read.usage === null) return { outcome: 'STALE', reason: 'PANEL_UNAVAILABLE' };
      const written = await this.recordFound(scope, service, startedAt, read.usage);
      ended = true;
      return written
        ? { outcome: 'FRESH', source: 'PANEL' }
        : { outcome: 'STALE', reason: 'INACTIVE' };
    } finally {
      if (!ended) await this.endReservation(scope, service.id, startedAt);
    }
  }

  /** The customer's own service, or null — "not yours" and "not there" are one answer. */
  private async ownService(
    scope: TenantContext,
    input: { readonly customerId: UserId; readonly serviceId: string },
  ): Promise<ServiceRecord | null> {
    try {
      return await this.deps.services.getForCustomer(scope, input.customerId, input.serviceId);
    } catch (error) {
      // Only "not yours / not there" is an answer; an unreadable database propagates.
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Everything a read of this service's panel needs, resolved before anything leaves — or
   * why no read may be made: the provider declares no proven read (`UNSUPPORTED`), or the
   * panel is not operable, its address not allowed, its credential unusable.
   */
  private async prepare(
    scope: TenantContext,
    service: ServiceRecord,
    view: Awaited<ReturnType<ServiceRefreshDeps['panels']['find']>>,
  ): Promise<PreparedRead | { readonly refused: 'UNSUPPORTED' | 'PANEL_UNAVAILABLE' }> {
    if (view === null) return { refused: 'PANEL_UNAVAILABLE' };
    const implemented = this.deps.implementedProviderTypes.includes(view.panel.providerType);
    if (!implemented || !this.deps.adapters(view.panel.providerType).supports('READ_USAGE')) {
      return { refused: 'UNSUPPORTED' };
    }
    const operable = decideOperability({
      panel: {
        status: view.panel.status,
        providerType: view.panel.providerType,
        baseUrl: view.panel.baseUrl,
        archivedAt: view.panel.archivedAt,
        activation: view.panel.activation,
      },
      credentials: view.credentials,
      type: 'SYNC_USAGE',
      serviceAdapterExists: implemented,
    });
    if (!operable.ok) return { refused: 'PANEL_UNAVAILABLE' };
    if (!checkUrl(operable.baseUrl, this.deps.urlPolicy).allowed) {
      return { refused: 'PANEL_UNAVAILABLE' };
    }
    const adapter = this.deps.adapters(operable.providerType as ProviderType);
    const stored = await this.deps.credentials.read(scope, service.panelId);
    const credentials = toProviderCredentials(stored, adapter.descriptor.credentialShape);
    if (credentials === null) return { refused: 'PANEL_UNAVAILABLE' };
    return {
      adapter,
      target: { baseUrl: operable.baseUrl, credentials, activation: operable.activation },
      baseUrl: operable.baseUrl,
    };
  }

  /** The tenant gate, the reservation and one budget token, in one transaction. */
  private async admit(
    scope: TenantContext,
    serviceId: string,
    interval: number,
    startedAt: Date,
    reserve: number,
  ): Promise<Admission> {
    try {
      return await this.deps.uow.run(scope, async (tx): Promise<Admission> => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 'INACTIVE';
        const reserved = await this.deps.rows.reserveUsageRefresh(
          scope,
          serviceId,
          {
            now: startedAt,
            syncedBefore: new Date(startedAt.getTime() - interval),
            inFlightBefore: new Date(startedAt.getTime() - this.deps.inFlightMs),
          },
          tx,
        );
        if (!reserved) return 'HELD';
        const budget = await this.deps.panels.takeProbeBudget(
          scope,
          this.deps.probeBudget,
          startedAt,
          tx,
          reserve,
        );
        if (!budget.permitted) throw new RefreshBudgetRefused();
        return 'ADMITTED';
      });
    } catch (error) {
      if (error instanceof RefreshBudgetRefused) return 'BUDGET';
      throw error;
    }
  }

  /** The confirming read's own token, above the background floor like the first. */
  private async takeSecondToken(scope: TenantContext): Promise<boolean> {
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return false;
      const budget = await this.deps.panels.takeProbeBudget(
        scope,
        this.deps.probeBudget,
        this.deps.clock.now(),
        tx,
        this.deps.backgroundBudgetReserve,
      );
      return budget.permitted;
    });
  }

  /**
   * A read that found the account: its figure written, the reservation ended, and an open
   * missing-account condition for this service closed — all in one transaction.
   */
  private async recordFound(
    scope: TenantContext,
    service: ServiceRecord,
    startedAt: Date,
    usage: { readonly usedBytes: bigint; readonly lastSeen: ProviderLastSeen },
  ): Promise<boolean> {
    const now = this.deps.clock.now();
    return this.deps.uow.run(scope, async (tx) => {
      await this.deps.rows.endUsageRefresh(scope, service.id, startedAt, tx);
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return false;
      const recorded = await this.deps.rows.recordUsage(
        scope,
        service.id,
        { usedBytes: usage.usedBytes, syncedAt: now, lastSeen: usage.lastSeen },
        tx,
      );
      // R11 B2: kept for the chart, from the figure this read already returned.
      if (recorded) {
        await this.deps.usageSnapshots.record(
          scope,
          service.id,
          { usedBytes: usage.usedBytes, at: now },
          tx,
        );
      }
      // R4 A2: found — back in the customer's list, whatever state the service is in now.
      await this.deps.rows.clearMissingOnPanel(scope, service.id, tx);
      await closePanelAccountMissing(this.deps, scope, service, tx);
      return true;
    });
  }

  /**
   * The panel answered twice that the account does not exist: the condition is recorded
   * for an operator and the reservation ended. NOTHING about the service's state, money or
   * order changes here — no state, no delete, no refund, no customer message. R4 A2 adds one
   * flag, `missing_on_panel_at`, which only takes the service out of the customer's own
   * list. `false` when the tenant stopped in between.
   */
  private async recordMissing(
    scope: TenantContext,
    service: ServiceRecord,
    startedAt: Date,
  ): Promise<boolean> {
    return this.deps.uow.run(scope, async (tx) => {
      await this.deps.rows.endUsageRefresh(scope, service.id, startedAt, tx);
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return false;
      await this.deps.rows.markMissingOnPanel(scope, service.id, this.deps.clock.now(), tx);
      await this.deps.opsEvents.record(
        scope,
        {
          code: SERVICE_PANEL_ACCOUNT_MISSING_CODE,
          severity: 'ERROR',
          message:
            'The panel answered twice that this service’s account does not exist. The ' +
            'service was left as it was; an operator decides what happens to it.',
          context: {
            serviceId: service.id,
            panelId: service.panelId,
            serviceState: service.state,
          },
          dedupeKey: servicePanelAccountMissingKey(service.id),
        },
        tx,
      );
      return true;
    });
  }

  private async endReservation(
    scope: TenantContext,
    serviceId: string,
    startedAt: Date,
  ): Promise<void> {
    await this.deps.uow.run(scope, async (tx) =>
      this.deps.rows.endUsageRefresh(scope, serviceId, startedAt, tx),
    );
  }

  private rememberMissing(key: string, at: number): void {
    this.missingVerdicts.delete(key);
    this.missingVerdicts.set(key, at);
    while (this.missingVerdicts.size > MISSING_VERDICTS_MAX) {
      const oldest = this.missingVerdicts.keys().next();
      if (oldest.done === true) break;
      this.missingVerdicts.delete(oldest.value);
    }
  }
}
