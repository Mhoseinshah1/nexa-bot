import {
  COMMERCE_ERROR_CODES,
  errors,
  isNexaError,
  money,
  serviceIdSchema,
  type ActorContext,
  type AuditWriter,
  type AutoRenewPreferenceSource,
  type AutoRenewRefusal,
  type Clock,
  type CorrelationId,
  type CustomerNotificationKind,
  type FeatureFlagKey,
  type IdGenerator,
  type IdempotencyStore,
  type Money,
  type OperationalEventRecorder,
  type PermissionKey,
  type ScopeContext,
  type TemplateValues,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import { walletCoverage } from '../../checkout/application/checkout.service.js';
import {
  AUTO_RENEW_COMMERCIAL_AUTHORITY,
  renewsFromPanelPlans,
  type CommercialActionService,
} from '../../commercial/application/commercial-action.service.js';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
import {
  AUTO_RENEW_ORDER_AUTHORITY,
  type OrderService,
} from '../../orders/application/order.service.js';
import type { OrderRecord } from '../../orders/application/ports.js';
import {
  AUTO_RENEW_WALLET_SETTLEMENT,
  type PaymentService,
} from '../../payments/application/payment.service.js';
import type { ServiceRecord, ServiceRepository } from './ports.js';
import type {
  AutoRenewRepository,
  AutoRenewRun,
  AutoRenewWalletReader,
} from './service-auto-renew.ports.js';

/** The flag and the setting (Round 10, D1). */
export const AUTO_RENEW_FEATURE: FeatureFlagKey = 'service_auto_renew';
export const AUTO_RENEW_LEAD_HOURS_SETTING = 'auto_renew.lead_hours';

/**
 * What a customer's switch and the worker act under: `maintenance.run`, as every
 * customer-triggered commercial command does (`COMMERCIAL_ACTION_PERMISSION`). The check is
 * still MADE for both, because `docs/conventions.md` forbids exempting an actor type.
 */
const AUTO_RENEW_PERMISSION: PermissionKey = 'maintenance.run';

/** How long one pass holds a claimed period before another pass may take it over. */
export const AUTO_RENEW_LEASE_MS = 10 * 60_000;

/** At most this many periods per pass: the sweep runs every fifteen minutes. */
export const AUTO_RENEW_BATCH_LIMIT = 50;

const HOUR_MS = 3_600_000;

/** The worker's actor: a `SYSTEM_JOB` on the `SCHEDULER` surface, one correlation per run. */
export function autoRenewActor(runId: string): ActorContext {
  return {
    type: 'SYSTEM_JOB',
    id: 'auto-renew',
    label: 'job:auto-renew',
    surface: 'SCHEDULER',
    correlationId: `auto-renew:${runId}` as CorrelationId,
  };
}

/**
 * Whether a service can be offered automatic renewal at all, from its own row: a native
 * (non-imported) service with a product to renew and a deadline to renew before. Whether it
 * can be renewed RIGHT NOW is the renewal's own decision (`renewalQuote`).
 */
export function autoRenewEligible(
  service: Pick<ServiceRecord, 'source' | 'productId' | 'expiresAt' | 'state'>,
): boolean {
  return (
    !renewsFromPanelPlans(service) &&
    service.productId !== null &&
    service.expiresAt !== null &&
    service.state === 'ACTIVE'
  );
}

/**
 * Whether a service is due: its deadline is ahead, and no further ahead than the lead time.
 * Half-open on the deadline — `[expiresAt - lead, expiresAt)` — so a pass at the deadline
 * itself does not renew a service that has already expired (it lapses as it would have).
 */
export function autoRenewDue(expiresAt: Date | null, now: Date, leadHours: number): boolean {
  if (expiresAt === null) return false;
  const at = now.getTime();
  return at < expiresAt.getTime() && at >= expiresAt.getTime() - leadHours * HOUR_MS;
}

/** What a surface draws for one service. */
export interface AutoRenewState {
  /** The switch can be turned ON now. */
  readonly offered: boolean;
  readonly enabled: boolean;
  /** The quote when offered, the consented total when enabled; else null. */
  readonly price: Money | null;
  readonly leadHours: number;
}

export interface AutoRenewReport {
  readonly renewed: number;
  readonly short: number;
  readonly refused: number;
}

export interface ServiceAutoRenewDeps {
  readonly repository: AutoRenewRepository;
  readonly services: Pick<ServiceRepository, 'findForCustomer'>;
  readonly commercial: Pick<CommercialActionService, 'renewalQuote' | 'draft' | 'confirm'>;
  readonly orders: Pick<OrderService, 'cancelByCustomer'>;
  readonly payments: Pick<PaymentService, 'settleFromWallet'>;
  readonly wallet: AutoRenewWalletReader;
  /** Readers, not services, for the reason `ServiceReminderService` gives. */
  readonly features: {
    isEnabled(scope: ScopeContext, key: FeatureFlagKey, tx?: unknown): Promise<boolean>;
  };
  readonly settings: {
    valueOf<T>(scope: ScopeContext, key: string, tx?: unknown): Promise<T>;
  };
  readonly notifier: Pick<CustomerNotifier, 'notify'>;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly outbox: OutboxWriter;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger?: {
    error: (context: Record<string, unknown>, message: string) => void;
  };
}

/** A decided refusal: a 4xx the server chose, never a transport failure or a 5xx. */
function isRefusal(error: unknown): boolean {
  return isNexaError(error) && error.httpStatus >= 400 && error.httpStatus < 500;
}

function sameOrBelow(total: Money, ceiling: Money): boolean {
  return total.currency === ceiling.currency && total.amountMinor <= ceiling.amountMinor;
}

/** Raised inside the settling transaction when the consent or the switch went away. */
function consentWithdrawn(): Error {
  return errors.conflict(
    COMMERCE_ERROR_CODES.AUTO_RENEW_DISABLED,
    'Automatic renewal is no longer switched on for this service.',
  );
}

/**
 * Round 10, D1 — «تمدید خودکار».
 *
 * ## The customer's switch
 *
 * `set` records the OWNER's consent for one service — on, with the renewal total quoted now
 * (`CommercialActionService.renewalQuote`, i.e. `PricingService.price` for a RENEW), or off.
 * Seven steps, as every write: authorised, validated, idempotent under the surface's key, in
 * one transaction with its scope-activity check, its audit row and its outbox event. ON needs
 * the feature switched on; OFF is always accepted.
 *
 * ## The sweep
 *
 * Not a new money path. A due period is CLAIMED (one run row per service per deadline), and
 * then the worker runs the customer's own three commands — the RENEW draft, its confirmation
 * and `settleFromWallet` — as a `SYSTEM_JOB` in the `SCHEDULER` namespace, exactly as
 * `ManualOrderService.place` runs them for an operator. The same quote, the same `PURCHASE`
 * debit, the same provisioning and the same `SERVICE_RENEWED` lane follow.
 *
 * - Every key is derived from the run's id and attempt; the debit's reference is unique on the
 *   settlement key. A pass that takes over a lapsed claim does so as the next attempt.
 * - `RENEWED` is written by the settlement's `inTransaction` hook, which also re-reads the
 *   switch, the consent and its ceiling INSIDE the settling transaction: a debit and its run's
 *   state commit together, and a consent withdrawn a moment before is a refusal, not a charge.
 * - A wallet that cannot pay is found BEFORE any order is created; it is told once per period
 *   (`notified_at`), and a later pass of the same period renews it once the wallet covers the
 *   last quote. A refusal at settlement withdraws the confirmed order, as the manual order
 *   does — never a refund (a wallet purchase is refused, not refunded).
 * - A quote above the consented total is not renewed (`PRICE_ROSE`) and told once.
 */
export class ServiceAutoRenewService {
  constructor(private readonly deps: ServiceAutoRenewDeps) {}

  // --- reads for the surfaces ------------------------------------------------------------

  /** Whether the feature is on for this tenant. */
  async featureOn(scope: TenantContext, tx?: unknown): Promise<boolean> {
    return this.deps.features.isEnabled(scope, AUTO_RENEW_FEATURE, tx);
  }

  private async leadHours(scope: TenantContext, tx?: unknown): Promise<number> {
    return this.deps.settings.valueOf<number>(scope, AUTO_RENEW_LEAD_HOURS_SETTING, tx);
  }

  /**
   * Whether this customer's consent is recorded for this service. Only the OWNER's consent
   * counts: a row another customer left behind reads as off.
   */
  async enabledFor(scope: TenantContext, customerId: UserId, serviceId: string): Promise<boolean> {
    const preference = await this.deps.repository.preferenceOf(scope, serviceId);
    return preference !== null && preference.enabled && preference.customerId === customerId;
  }

  /**
   * What the service screen draws, cheaply: the OFF switch while it is on; the ON switch while
   * the feature is on, the service is eligible by its row and a renewal is on offer (`renewable`,
   * the card's own `availableFor` answer). The tap decides again.
   */
  async switchFor(
    scope: TenantContext,
    customerId: UserId,
    service: ServiceRecord,
    renewable: boolean,
  ): Promise<'ENABLE' | 'DISABLE' | null> {
    if (await this.enabledFor(scope, customerId, service.id)) return 'DISABLE';
    if (!renewable || !autoRenewEligible(service)) return null;
    return (await this.featureOn(scope)) ? 'ENABLE' : null;
  }

  /**
   * The full state for one service, with the figure the customer would agree to: the quote now
   * when it can be switched on, the consented total while it is on.
   */
  async stateFor(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    service: ServiceRecord,
  ): Promise<AutoRenewState> {
    const leadHours = await this.leadHours(scope);
    const preference = await this.deps.repository.preferenceOf(scope, service.id);
    if (preference !== null && preference.enabled && preference.customerId === customerId) {
      return { offered: false, enabled: true, price: preference.consented, leadHours };
    }
    const quote = await this.offerQuote(scope, actor, customerId, service);
    return { offered: quote !== null, enabled: false, price: quote, leadHours };
  }

  /** The renewal total switching ON would agree to, or null when it cannot be switched on. */
  private async offerQuote(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    service: ServiceRecord,
  ): Promise<Money | null> {
    if (!autoRenewEligible(service) || !(await this.featureOn(scope))) return null;
    try {
      return (await this.deps.commercial.renewalQuote(scope, actor, customerId, service.id)).total;
    } catch (error) {
      if (isRefusal(error)) return null;
      throw error;
    }
  }

  // --- the customer's switch -------------------------------------------------------------

  async set(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    input: {
      readonly serviceId: string;
      readonly enabled: boolean;
      readonly idempotencyKey: string;
    },
  ): Promise<AutoRenewState> {
    const parsed = serviceIdSchema.safeParse(input.serviceId);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid service identifier.',
      );
    }
    const serviceId = parsed.data;
    const action = input.enabled ? 'service.auto_renew_on' : 'service.auto_renew_off';
    const denial = { action, entityType: 'Service', entityId: serviceId };
    try {
      await this.deps.guard.check(scope, actor, AUTO_RENEW_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        AUTO_RENEW_PERMISSION,
        denial,
        error,
      );
      throw error;
    }

    const namespace = actor.surface;
    const requestHash = hashRequest({ customerId, serviceId, autoRenew: input.enabled });
    const replay = await this.deps.idempotency.find<{ serviceId: string }>(
      scope,
      namespace,
      input.idempotencyKey,
      requestHash,
    );
    const owned = async (tx?: unknown): Promise<ServiceRecord> => {
      const service = await this.deps.services.findForCustomer(scope, customerId, serviceId, tx);
      if (service === null) {
        throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
      }
      return service;
    };
    if (replay !== null) return this.stateFor(scope, actor, customerId, await owned());

    /*
     * ON: the figure the customer agrees to, quoted by the renewal's own pricing before the
     * write. A refusal of the quote (not renewable now, a tier that does not grant it, the
     * panel unable) is one answer to the customer: not available.
     */
    let consented: Money | null = null;
    if (input.enabled) {
      const service = await owned();
      if (!autoRenewEligible(service)) throw this.notAvailable();
      if (!(await this.featureOn(scope))) throw this.featureOff();
      try {
        consented = (await this.deps.commercial.renewalQuote(scope, actor, customerId, serviceId))
          .total;
      } catch (error) {
        if (isRefusal(error)) throw this.notAvailable();
        throw error;
      }
    }

    const now = this.deps.clock.now();
    const source: AutoRenewPreferenceSource =
      actor.surface === 'MINI_APP' ? 'MINI_APP' : 'TELEGRAM';
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      AUTO_RENEW_PERMISSION,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        // Authoritative: the switch and the row, read inside the write's transaction.
        if (input.enabled && !(await this.featureOn(scope, tx))) throw this.featureOff();
        const service = await owned(tx);
        if (input.enabled && !autoRenewEligible(service)) throw this.notAvailable();
        const before = await this.deps.repository.preferenceOf(scope, serviceId, tx);
        const changed = await this.deps.repository.savePreference(
          scope,
          { serviceId, customerId, enabled: input.enabled, consented, source, now },
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: 'Service',
            entityId: serviceId,
            before:
              before === null
                ? null
                : {
                    enabled: before.enabled,
                    customerId: before.customerId,
                    consentedTotalMinor: before.consented?.amountMinor.toString() ?? null,
                    currency: before.consented?.currency ?? null,
                  },
            after: {
              enabled: input.enabled,
              customerId,
              consentedTotalMinor: consented?.amountMinor.toString() ?? null,
              currency: consented?.currency ?? null,
              changed,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        if (changed) {
          await this.deps.outbox.write(tx, actor, {
            eventType: 'ServiceAutoRenewChanged',
            aggregateType: 'Service',
            aggregateId: serviceId,
            payload: {
              serviceId,
              customerId,
              enabled: input.enabled,
              consentedTotalMinor: consented?.amountMinor.toString() ?? null,
              currency: consented?.currency ?? null,
              source,
            },
          });
        }
        await rememberOnce(
          this.deps.idempotency,
          scope,
          namespace,
          input.idempotencyKey,
          requestHash,
          { serviceId },
          tx,
        );
      },
    );
    return {
      offered: false,
      enabled: input.enabled,
      price: consented,
      leadHours: await this.leadHours(scope),
    };
  }

  private notAvailable(): Error {
    return errors.conflict(
      COMMERCE_ERROR_CODES.AUTO_RENEW_NOT_AVAILABLE,
      'This service cannot be renewed automatically.',
    );
  }

  private featureOff(): Error {
    return errors.conflict(
      COMMERCE_ERROR_CODES.AUTO_RENEW_DISABLED,
      'Automatic renewal is switched off for this installation.',
    );
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }

  // --- the sweep -------------------------------------------------------------------------

  /**
   * One pass over one tenant: claim the due periods (one transaction, with the scope and the
   * switch read inside it), then renew each claimed period in turn. A stopped tenant, or the
   * switch off, is a pass that did nothing — not a failure.
   */
  async runOnce(scope: TenantContext): Promise<AutoRenewReport> {
    const now = this.deps.clock.now();
    const claimed = await this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return [];
      if (!(await this.featureOn(scope, tx))) return [];
      const leadHours = await this.leadHours(scope, tx);
      const dueBefore = new Date(now.getTime() + leadHours * HOUR_MS);
      const leaseUntil = new Date(now.getTime() + AUTO_RENEW_LEASE_MS);
      const candidates = await this.deps.repository.listDue(
        scope,
        { now, dueBefore },
        AUTO_RENEW_BATCH_LIMIT,
        tx,
      );
      const runs: AutoRenewRun[] = [];
      for (const candidate of candidates) {
        if (candidate.run === null) {
          const run = await this.deps.repository.claimNew(
            scope,
            {
              id: this.deps.ids.uuid(),
              serviceId: candidate.serviceId,
              customerId: candidate.customerId,
              serviceLabel: candidate.serviceLabel,
              consented: candidate.consented,
              now,
              dueBefore,
              leaseUntil,
            },
            tx,
          );
          if (run !== null) runs.push(run);
          continue;
        }
        if (candidate.run.state === 'FUNDS_SHORT') {
          /*
           * A short period is tried again only once the wallet covers what was last quoted —
           * the customer was already told, and a pass that drafted an order every fifteen
           * minutes for money that is still not there would be work for nothing.
           */
          const quoted = candidate.run.quoted;
          if (quoted === null) continue;
          const balance = await this.deps.wallet.balanceOf(
            scope,
            candidate.customerId,
            quoted.currency,
            tx,
          );
          if (!walletCoverage(money(balance.amountMinor, balance.currency), quoted).sufficient) {
            continue;
          }
        }
        const run = await this.deps.repository.reclaim(
          scope,
          {
            runId: candidate.run.id,
            from: candidate.run.state,
            attempt: candidate.run.attempt,
            consented: candidate.consented,
            now,
            leaseUntil,
          },
          tx,
        );
        if (run !== null) runs.push(run);
      }
      return runs;
    });

    let renewed = 0;
    let short = 0;
    let refused = 0;
    for (const run of claimed) {
      try {
        const outcome = await this.renew(scope, run);
        if (outcome === 'RENEWED') renewed += 1;
        else if (outcome === 'FUNDS_SHORT') short += 1;
        else if (outcome === 'REFUSED') refused += 1;
      } catch (error) {
        // Left CLAIMED, nothing debited: the lease lapses and a later pass takes it over.
        this.deps.logger?.error({ error, runId: run.id }, 'automatic renewal failed');
      }
    }
    return { renewed, short, refused };
  }

  /**
   * One claimed period, renewed or not. Returns where it ended, or `null` when it was left
   * `CLAIMED` (the scope stopped, or another pass moved it).
   */
  private async renew(
    scope: TenantContext,
    run: AutoRenewRun,
  ): Promise<'RENEWED' | 'FUNDS_SHORT' | 'REFUSED' | null> {
    const actor = autoRenewActor(run.id);
    const customerId = run.customerId;
    const stem = `autorenew:${run.id}:${String(run.attempt)}`;

    // 1. The quote, read: refused before anything is written for a period that cannot renew.
    let quote: Money;
    try {
      quote = (await this.deps.commercial.renewalQuote(scope, actor, customerId, run.serviceId))
        .total;
    } catch (error) {
      if (!isRefusal(error)) throw error;
      return this.finish(scope, run, 'REFUSED', 'NOT_RENEWABLE', null);
    }
    if (!sameOrBelow(quote, run.consented)) {
      return this.finish(scope, run, 'REFUSED', 'PRICE_ROSE', quote);
    }
    // 2. The wallet, read: no order is created for money that is not there.
    const balance = await this.deps.wallet.balanceOf(scope, customerId, quote.currency);
    if (!walletCoverage(money(balance.amountMinor, balance.currency), quote).sufficient) {
      return this.finish(scope, run, 'FUNDS_SHORT', null, quote);
    }

    // 3. The customer's own commands, under keys derived from this run and attempt.
    let order: OrderRecord;
    try {
      ({ order } = await this.deps.commercial.draft(
        scope,
        actor,
        customerId,
        { serviceId: run.serviceId, kind: 'RENEW', idempotencyKey: `${stem}:draft` },
        AUTO_RENEW_COMMERCIAL_AUTHORITY,
      ));
    } catch (error) {
      if (!isRefusal(error)) throw error;
      return this.finish(scope, run, 'REFUSED', 'NOT_RENEWABLE', quote);
    }
    const total = order.totals.total;
    // The order's own quote is the one that counts; above the consent, it lapses as a DRAFT.
    if (!sameOrBelow(total, run.consented)) {
      return this.finish(scope, run, 'REFUSED', 'PRICE_ROSE', total);
    }
    let confirmed = order;
    if (order.state === 'DRAFT') {
      const now = await this.deps.wallet.balanceOf(scope, customerId, total.currency);
      if (!walletCoverage(money(now.amountMinor, now.currency), total).sufficient) {
        return this.finish(scope, run, 'FUNDS_SHORT', null, total);
      }
      try {
        confirmed = await this.deps.commercial.confirm(
          scope,
          actor,
          customerId,
          { orderId: order.id, idempotencyKey: `${stem}:confirm` },
          AUTO_RENEW_COMMERCIAL_AUTHORITY,
        );
      } catch (error) {
        if (!isRefusal(error)) throw error;
        return this.finish(scope, run, 'REFUSED', 'NOT_RENEWABLE', total);
      }
    }

    try {
      await this.deps.payments.settleFromWallet(
        scope,
        actor,
        customerId,
        { idempotencyKey: `${stem}:settle`, orderId: confirmed.id },
        {
          ...AUTO_RENEW_WALLET_SETTLEMENT,
          inTransaction: async (tx, done) => {
            /*
             * Decided again WHERE THE MONEY MOVES: the switch, the owner's consent and its
             * ceiling. A refusal here rolls the debit back with it.
             */
            if (!(await this.featureOn(scope, tx))) throw consentWithdrawn();
            const preference = await this.deps.repository.preferenceOf(scope, run.serviceId, tx);
            if (
              preference === null ||
              !preference.enabled ||
              preference.customerId !== customerId ||
              preference.consented === null ||
              !sameOrBelow(done.order.totals.total, preference.consented)
            ) {
              throw consentWithdrawn();
            }
            const now = this.deps.clock.now();
            const marked = await this.deps.repository.markRenewed(
              scope,
              {
                runId: run.id,
                attempt: run.attempt,
                orderId: done.order.id,
                quoted: done.order.totals.total,
                now,
              },
              tx,
            );
            if (!marked) {
              // Not this attempt's claim any more: nothing may be debited for it.
              throw new Error(
                `auto-renew run ${run.id} attempt ${String(run.attempt)} lost its claim`,
              );
            }
            await this.deps.audit.record(
              scope,
              actor,
              {
                action: 'service.auto_renew_run',
                entityType: 'Service',
                entityId: run.serviceId,
                before: { runState: 'CLAIMED' },
                after: {
                  runState: 'RENEWED',
                  runId: run.id,
                  attempt: run.attempt,
                  orderId: done.order.id,
                  paymentId: done.payment.id,
                  totalMinor: done.order.totals.total.amountMinor.toString(),
                  currency: done.order.totals.currency,
                },
                result: 'SUCCESS',
              },
              tx,
            );
            await this.deps.outbox.write(tx, actor, {
              eventType: 'ServiceAutoRenewRunSettled',
              aggregateType: 'Service',
              aggregateId: run.serviceId,
              payload: {
                serviceId: run.serviceId,
                customerId,
                runId: run.id,
                outcome: 'RENEWED',
                refusal: null,
                orderId: done.order.id,
              },
            });
          },
        },
      );
    } catch (error) {
      if (!isRefusal(error)) throw error;
      /*
       * A decided refusal rolled back with nothing debited: withdraw the order it was for,
       * releasing what its confirmation held, so nothing is left awaiting a payment nobody
       * chose to make. Never a refund: a wallet purchase is refused, not refunded.
       */
      await this.withdraw(scope, actor, customerId, confirmed.id, stem);
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS) {
        return this.finish(scope, run, 'FUNDS_SHORT', null, total);
      }
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.AUTO_RENEW_DISABLED) {
        return this.finish(scope, run, 'REFUSED', 'CONSENT_WITHDRAWN', total);
      }
      return this.finish(scope, run, 'REFUSED', 'NOT_RENEWABLE', total);
    }
    return 'RENEWED';
  }

  /** The withdrawal of a refused order; its own failure is logged, never the run's outcome. */
  private async withdraw(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    orderId: string,
    stem: string,
  ): Promise<void> {
    try {
      await this.deps.orders.cancelByCustomer(
        scope,
        actor,
        { idempotencyKey: `${stem}:cancel`, customerId, orderId },
        AUTO_RENEW_ORDER_AUTHORITY,
      );
    } catch (error) {
      this.deps.logger?.error({ error, orderId }, 'automatic renewal could not withdraw its order');
    }
  }

  /**
   * A period that was not renewed: `CLAIMED -> FUNDS_SHORT | REFUSED`, its event, and — for a
   * short wallet or a price above the consent — the period's ONE notice, all in one
   * transaction with its scope-activity check.
   */
  private async finish(
    scope: TenantContext,
    run: AutoRenewRun,
    to: 'FUNDS_SHORT' | 'REFUSED',
    refusal: AutoRenewRefusal | null,
    quoted: Money | null,
  ): Promise<'FUNDS_SHORT' | 'REFUSED' | null> {
    const actor = autoRenewActor(run.id);
    const notice: CustomerNotificationKind | null =
      to === 'FUNDS_SHORT'
        ? 'SERVICE_AUTO_RENEW_FUNDS_SHORT'
        : refusal === 'PRICE_ROSE'
          ? 'SERVICE_AUTO_RENEW_PRICE_CHANGED'
          : null;
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return null;
      const now = this.deps.clock.now();
      const moved = await this.deps.repository.markUnrenewed(
        scope,
        { runId: run.id, attempt: run.attempt, to, refusal, quoted, now },
        tx,
      );
      if (!moved) return null;
      await this.deps.outbox.write(tx, actor, {
        eventType: 'ServiceAutoRenewRunSettled',
        aggregateType: 'Service',
        aggregateId: run.serviceId,
        payload: {
          serviceId: run.serviceId,
          customerId: run.customerId,
          runId: run.id,
          outcome: to,
          refusal,
          orderId: null,
        },
      });
      // One notice per period, of either kind: the run row is stamped once.
      if (notice !== null && (await this.deps.repository.markNotified(scope, run.id, now, tx))) {
        await this.deps.notifier.notify(scope, run.customerId, notice, run.id, now, tx);
      }
      return to;
    });
  }

  // --- the notices -----------------------------------------------------------------------

  /**
   * What a notice about one run renders, read at send time from the run's own snapshot (ADR
   * 0030 §1). Null when the run does not state the kind's fact — a short-wallet notice about a
   * run that is not `FUNDS_SHORT`, a price notice about one not refused for its price.
   */
  async noticeFacts(
    scope: TenantContext,
    kind: CustomerNotificationKind,
    runId: string,
  ): Promise<{ readonly values: TemplateValues; readonly serviceId: string } | null> {
    const facts = await this.deps.repository.noticeFacts(scope, runId);
    if (facts === null || facts.quoted === null) return null;
    if (kind === 'SERVICE_AUTO_RENEW_FUNDS_SHORT' && facts.state === 'FUNDS_SHORT') {
      return {
        values: {
          service: facts.serviceLabel,
          price: facts.quoted,
          expiresAt: facts.basisExpiresAt,
        },
        serviceId: facts.serviceId,
      };
    }
    if (kind === 'SERVICE_AUTO_RENEW_PRICE_CHANGED' && facts.refusal === 'PRICE_ROSE') {
      return {
        values: { service: facts.serviceLabel, price: facts.quoted, consented: facts.consented },
        serviceId: facts.serviceId,
      };
    }
    return null;
  }
}
