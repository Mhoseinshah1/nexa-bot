import {
  COMMERCE_ERROR_CODES,
  CUSTOMER_SYNC_MIN_INTERVAL_MS,
  customerActionVerdict,
  effectiveCooldownMs,
  isNexaError,
  type ActorContext,
  type Clock,
  type ProviderAdapter,
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
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SafeHttpClient } from '../../../../infrastructure/net/safe-http.js';
import { checkUrl, type UrlPolicyOptions } from '../../../../infrastructure/net/url-policy.js';
import { decideOperability } from './panel-operability.js';
import { OPERATION_LEGAL_FROM, providerRefFor, usageSyncCall } from './provision-executor.js';
import type { ServiceRecord, ServiceRepository } from './ports.js';
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
  readonly rows: Pick<ServiceRepository, 'recordUsage'> & UsageRefreshReservations;
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
  readonly guard: PermissionGuard;
  readonly scopeActivity: ScopeActivityReader;
  readonly panelPolicy: PanelPolicyGate;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
}

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
  constructor(private readonly deps: ServiceRefreshDeps) {}

  async refresh(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly customerId: UserId; readonly serviceId: string },
  ): Promise<ServiceRefreshResult> {
    await this.deps.guard.check(scope, actor, CUSTOMER_ROTATION_PERMISSION);

    let service: ServiceRecord;
    try {
      service = await this.deps.services.getForCustomer(scope, input.customerId, input.serviceId);
    } catch (error) {
      // Only "not yours / not there" is an answer; an unreadable database propagates.
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND) {
        return { outcome: 'NOT_FOUND' };
      }
      throw error;
    }
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
    const operable = decideOperability({
      panel:
        view === null
          ? null
          : {
              status: view.panel.status,
              providerType: view.panel.providerType,
              baseUrl: view.panel.baseUrl,
              archivedAt: view.panel.archivedAt,
              activation: view.panel.activation,
            },
      credentials: view?.credentials ?? null,
      type: 'SYNC_USAGE',
      serviceAdapterExists:
        view !== null && this.deps.implementedProviderTypes.includes(view.panel.providerType),
    });
    if (!operable.ok) return { outcome: 'FAILED' };
    if (!checkUrl(operable.baseUrl, this.deps.urlPolicy).allowed) return { outcome: 'FAILED' };
    const adapter = this.deps.adapters(operable.providerType as ProviderType);
    const stored = await this.deps.credentials.read(scope, service.panelId);
    const credentials = toProviderCredentials(stored, adapter.descriptor.credentialShape);
    if (credentials === null) return { outcome: 'FAILED' };

    /*
     * The tenant gate, the reservation and the budget, in ONE transaction, before anything
     * leaves. The interval check above read a row that two taps (or a redelivered update)
     * can both have read; this conditional UPDATE is the check that holds, because the
     * second waits on the first's row lock and then finds the reservation taken. A budget
     * refused throws, so the reservation rolls back with it and the next tap may try.
     */
    const startedAt = this.deps.clock.now();
    let admission: 'ADMITTED' | 'INACTIVE' | 'HELD';
    try {
      admission = await this.deps.uow.run(scope, async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 'INACTIVE' as const;
        const reserved = await this.deps.rows.reserveUsageRefresh(
          scope,
          service.id,
          {
            now: startedAt,
            syncedBefore: new Date(startedAt.getTime() - interval),
            inFlightBefore: new Date(startedAt.getTime() - this.deps.inFlightMs),
          },
          tx,
        );
        if (!reserved) return 'HELD' as const;
        const budget = await this.deps.panels.takeProbeBudget(
          scope,
          this.deps.probeBudget,
          startedAt,
          tx,
          0,
        );
        if (!budget.permitted) throw new RefreshBudgetRefused();
        return 'ADMITTED' as const;
      });
    } catch (error) {
      if (error instanceof RefreshBudgetRefused) return { outcome: 'FAILED' };
      throw error;
    }
    if (admission === 'INACTIVE') return { outcome: 'FAILED' };
    // Another tap is reading, or has just read: the card is redrawn from what is stored.
    if (admission === 'HELD') return { outcome: 'RECENT' };

    let ended = false;
    try {
      const read = await usageSyncCall(
        adapter,
        { baseUrl: operable.baseUrl, credentials, activation: operable.activation },
        this.deps.http.forBase(operable.baseUrl),
        providerRefFor(service),
      );
      if (!read.ok) return { outcome: 'FAILED' };

      const now = this.deps.clock.now();
      const written = await this.deps.uow.run(scope, async (tx) => {
        await this.deps.rows.endUsageRefresh(scope, service.id, startedAt, tx);
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return false;
        await this.deps.rows.recordUsage(
          scope,
          service.id,
          { usedBytes: read.usage.usedBytes, syncedAt: now, lastSeen: read.usage.lastSeen },
          tx,
        );
        return true;
      });
      ended = true;
      return { outcome: written ? 'REFRESHED' : 'FAILED' };
    } finally {
      // A read that failed or threw gives the reservation back, so the next tap may try.
      if (!ended) {
        await this.deps.uow.run(scope, async (tx) =>
          this.deps.rows.endUsageRefresh(scope, service.id, startedAt, tx),
        );
      }
    }
  }
}
