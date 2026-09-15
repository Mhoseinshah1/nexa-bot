import {
  systemJobActor,
  type ActorContext,
  type Clock,
  type CorrelationId,
  type Hasher,
  type IdGenerator,
  type OperationalEventRecorder,
  type OperationId,
  type OperationState,
  type ProviderAdapter,
  type ProviderFailureKind,
  type ProviderType,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { AuditWriter } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SafeHttpClient } from '../../../../infrastructure/net/safe-http.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import { checkUrl, type UrlPolicyOptions } from '../../../../infrastructure/net/url-policy.js';
import type {
  PanelCredentialStore,
  PanelRepository,
  ProbeBudget,
} from '../../../platform/panels/application/ports.js';
import { toProviderCredentials } from '../../../platform/panels/application/probe-core.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import { decideOperability } from './panel-operability.js';
import {
  backoffMs,
  expiryFor,
  exhausted,
  failureNote,
  outcomeFor,
  providerRefFor,
  reconcileCall,
  serviceEventFor,
  type ExecutionRefusal,
  type ExecutionResult,
} from './provision-executor.js';
import type {
  OperationRecord,
  OperationRepository,
  PurchaseSnapshotReader,
  ServiceRecord,
  ServiceRepository,
} from './ports.js';

/**
 * ONE operator-facing question per service: is this customer's service being delivered?
 *
 * One code rather than three — `provisioning.unresolved`, `_exhausted`, `_blocked` —
 * for the reason `telegram.customer_send_failed` records having learned the expensive
 * way. Three deduplicated codes about one subject are three rows a single recovery
 * cannot close, because `recoversCode` is singular; the first transient failure opens
 * one and every later failure folds onto it silently.
 *
 * So the three situations become `reason` in the context, which the recorder rewrites
 * on every occurrence, and the severity is fixed at ERROR — a deduplicated row keeps
 * the severity it was first recorded with, and ERROR is the one that cannot fall under
 * an installation's notification threshold unseen.
 *
 * Introduced together with its recovery in this release, because `operational_events`
 * can never rewrite a row's code: splitting or renaming one later strands every row
 * still open under it, unresolvable, for ever.
 */
export const PROVISIONING_STALLED_CODE = 'provisioning.stalled';

/**
 * The recovery, and deliberately NOT deduplicated.
 *
 * Its whole job is to close the stalled row, and a row of its own would need closing in
 * turn — by the next failure, whose one `recoversCode` is already spent.
 * `panel.health.restored` is the same shape for the same reason.
 */
export const PROVISIONING_DELIVERED_CODE = 'provisioning.delivered';

/** The dedupe key: one condition per SERVICE. The format IS the identity. */
export function provisioningConditionKey(serviceId: string): string {
  return `${PROVISIONING_STALLED_CODE}:${serviceId}`;
}

/**
 * Which refusals can never be fixed without a new release.
 *
 * `PROVIDER_NOT_OPERABLE` and `CAPABILITY_UNSUPPORTED` are statements about CODE: no
 * amount of operator configuration makes this release able to create a user on a
 * provider it has no adapter for. Retrying them four more times spends attempts to
 * learn nothing and delays the terminal state an operator needs to see.
 *
 * The other four are configuration, and configuration can change in the minute after
 * the refusal — a panel re-enabled, a credential set, an activation completed — so
 * those back off and try again.
 */
export function refusalIsPermanent(reason: ExecutionRefusal): boolean {
  return reason === 'PROVIDER_NOT_OPERABLE' || reason === 'CAPABILITY_UNSUPPORTED';
}

/** How many abandoned leases one tick may return to the pool. */
export const LEASE_SWEEP_LIMIT = 20;

export interface ProvisionerDeps {
  readonly operations: OperationRepository;
  readonly services: ServiceRepository;
  readonly purchases: PurchaseSnapshotReader;
  readonly panels: PanelRepository;
  readonly credentials: PanelCredentialStore;
  readonly adapters: (type: ProviderType) => ProviderAdapter;
  readonly implementedProviderTypes: readonly ProviderType[];
  readonly http: SafeHttpClient;
  readonly urlPolicy: UrlPolicyOptions;
  readonly probeBudget: ProbeBudget;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly hash: Hasher;
  /**
   * Derives an operation id from a retry-stable key. Bound once in the container.
   *
   * Required here — not optional and not replaced by a generated uuid — because the
   * re-plan after a provably-absent reconcile must converge: two reconcile replicas
   * that both established absence must derive the SAME next operation id, or both
   * would plan a create and the panel would get two accounts.
   */
  readonly operationId: (key: string) => OperationId;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly outbox: OutboxWriter;
  readonly scopeActivity: ScopeActivityReader;
  readonly workerId: string;
  readonly leaseMs: number;
}

/**
 * The lane that actually creates services on panels.
 *
 * ## The shape of one tick
 *
 * Release abandoned leases, claim ONE operation, resolve its panel, spend a budget
 * token, stamp that a call is starting, call the provider OUTSIDE any transaction, and
 * persist what happened. One operation per tick rather than a batch, deliberately: a
 * customer waiting for a config is waiting on wall time, and a batch means the last
 * member of it waits for every slow panel ahead of it.
 *
 * ## Why the budget is the panel probe budget
 *
 * The SAME tenant bucket the monitor spends from, never a second one. A second bucket
 * would raise a tenant's total outbound rate, which is the bound's entire purpose —
 * CLAUDE.md records this as a rule that is easy to break by accident, and provisioning
 * is exactly the kind of new outbound work that would break it.
 *
 * The RESERVE is zero here, and that is the difference from the monitor. The monitor
 * reserves capacity so background health checks cannot lock an operator out of their
 * own panel; provisioning is not background in that sense — a customer has paid and is
 * waiting — so it spends at an operator's priority, and the monitor's reserve is what
 * keeps a sweep from starving it.
 */
export class ProvisionerService {
  constructor(private readonly deps: ProvisionerDeps) {}

  private actor(): ActorContext {
    return systemJobActor('provisioner', this.deps.ids.uuid() as CorrelationId);
  }

  /**
   * One operation, start to finish. Returns what it did so a loop can pace itself.
   *
   * `IDLE` means there was nothing due, and it is the signal to sleep rather than to
   * spin. A tick that found nothing must not be reported as progress: the monitor's
   * readiness learned that the hard way, and a provisioner whose queue is jammed would
   * otherwise look healthy for ever.
   */
  async runOnce(scope: TenantContext): Promise<ExecutionResult> {
    const now = this.deps.clock.now();

    /*
     * Abandoned leases first, so a crashed worker's work is reclaimable before this one
     * looks for its own. Bounded, and it only touches rows where NO provider call was
     * started — the guard `OPERATION_MACHINE` names, enforced as a WHERE clause.
     */
    const leaseUntil = new Date(now.getTime() + this.deps.leaseMs);
    /*
     * Both writes inside `uow.run`, which is where ADR-0028's quiesce gate lives.
     *
     * They used to run on the pool. That put the first two durable writes of every
     * tick OUTSIDE the gate, so a restore holding the installation found the
     * provisioner still releasing leases and claiming operations in the database it
     * was replacing — and the tick then threw at the first gated write, leaving the
     * row IN_FLIGHT with an attempt spent. Five restores would have retired a paid
     * order without a single provider call.
     *
     * One transaction for both, because the release is what makes the claim's
     * candidate set correct and a reader between them would see neither state.
     */
    const operation = await this.deps.uow.run(scope, async (tx) => {
      await this.deps.operations.releaseExpiredLeases(scope, now, LEASE_SWEEP_LIMIT, tx);
      return this.deps.operations.claimDue(scope, this.deps.workerId, now, leaseUntil, tx);
    });
    if (operation === null) return { kind: 'IDLE' };

    const service = await this.deps.services.findById(scope, operation.serviceId);
    if (service === null) {
      /*
       * An operation whose service is gone.
       *
       * Unreachable through any path in this release — services are never deleted and
       * the composite foreign key would refuse an operation naming a missing one — and
       * ABANDONED rather than retried, because retrying would claim it again on every
       * tick for ever. `OPERATION_MACHINE` provides that state for exactly this: a
       * situation nothing else can resolve.
       */
      await this.deps.uow.run(scope, async (tx) => {
        await this.deps.operations.transition(
          scope,
          operation.id,
          'IN_FLIGHT',
          'ABANDONED',
          { failureMessage: 'the service this operation names does not exist' },
          now,
          tx,
        );
      });
      return { kind: 'REFUSED', operationId: operation.id, reason: 'SERVICE_ABSENT' };
    }

    /*
     * The service must still be in the state this operation was planned for.
     *
     * A `PROVISION` is only legal from `PENDING_PROVISION` and a `RECONCILE` only from
     * `UNRECONCILED` — `SERVICE_MACHINE`'s edges, checked before anything is spent
     * rather than discovered afterwards by a conditional UPDATE that quietly did
     * nothing. Without this the executor would dial a panel for a service that is
     * already ACTIVE, and the collision on the derived username comes back as a
     * `PROVIDER_ERROR`, which classifies UNKNOWN on a mutating call, which moves a
     * working service to `UNRECONCILED`.
     *
     * ABANDONED rather than failed or retried: nothing about a stale operation improves
     * by trying it again, and `OPERATION_MACHINE` provides that state for exactly the
     * situation nothing else can resolve.
     */
    const legalFrom = operation.type === 'RECONCILE' ? 'UNRECONCILED' : 'PENDING_PROVISION';
    if (service.state !== legalFrom) {
      await this.deps.uow.run(scope, async (tx) => {
        await this.deps.operations.transition(
          scope,
          operation.id,
          'IN_FLIGHT',
          'ABANDONED',
          { failureMessage: `the service is ${service.state}, not ${legalFrom}` },
          now,
          tx,
        );
      });
      return { kind: 'REFUSED', operationId: operation.id, reason: 'SERVICE_ABSENT' };
    }

    /*
     * The tenant must still be accepting work, checked INSIDE a transaction.
     *
     * CLAUDE.md names panels as the one module that skipped this, which let a tenant an
     * operator had stopped be given new panels and a background monitor. Provisioning
     * is the same shape of unattended work with money attached, so the check is here
     * and not only wherever the order was settled.
     */
    const active = await this.deps.uow.run(scope, async (tx) =>
      this.deps.scopeActivity.scopeIsActive(scope, tx),
    );
    if (!active) {
      await this.holdOff(scope, operation, now, 'the tenant has stopped accepting work');
      return { kind: 'REFUSED', operationId: operation.id, reason: 'TENANT_STOPPED' };
    }

    /*
     * ONE read for the panel and its credential SUMMARY.
     *
     * `find` returns a `PanelView`, whose `credentials` is three timestamps and not one
     * value — exactly what `decideOperability` needs and exactly what it must not be
     * given more than. The decryption below happens only after that decision passes, so
     * a panel that can never be operated never materialises a password.
     */
    const view = await this.deps.panels.find(scope, operation.panelId);
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
      type: operation.type,
      serviceAdapterExists:
        view !== null && this.deps.implementedProviderTypes.includes(view.panel.providerType),
    });
    if (!operable.ok) {
      await this.refuse(scope, operation, service, operable.reason, now);
      return { kind: 'REFUSED', operationId: operation.id, reason: operable.reason };
    }

    /*
     * The address is judged again, as written, before any capacity is spent.
     *
     * It was judged at create and at update, but the policy can have changed underneath
     * a stored panel — an installation's data subnet, say — and a refusal that costs
     * nothing is the right answer to that. The same reasoning `attemptProbe` gives.
     */
    if (!checkUrl(operable.baseUrl, this.deps.urlPolicy).allowed) {
      /*
       * The stored address is no longer one this installation will dial.
       *
       * Recorded through the same path as a panel refusal because the remedy is the
       * same screen — an operator changes the address — but with its own reason, so the
       * operations log does not say "disabled" about a panel nobody disabled.
       */
      await this.refuse(scope, operation, service, 'PANEL_NOT_REACHABLE', now);
      return { kind: 'REFUSED', operationId: operation.id, reason: 'PANEL_NOT_REACHABLE' };
    }

    const adapter = this.deps.adapters(operable.providerType as ProviderType);
    const stored = await this.deps.credentials.read(scope, operation.panelId);
    const credentials = toProviderCredentials(stored, adapter.descriptor.credentialShape);
    if (credentials === null) {
      /*
       * The summary said configured and the decryption produced nothing usable.
       *
       * A real state — a credential written under a key this installation no longer
       * holds — reported as the configuration problem it is rather than as a provider
       * failure, because no provider was contacted.
       */
      await this.refuse(scope, operation, service, 'CREDENTIALS_MISSING', now);
      return { kind: 'REFUSED', operationId: operation.id, reason: 'CREDENTIALS_MISSING' };
    }

    /*
     * The tenant's outbound bound, taken and COMMITTED before the call.
     *
     * The SAME bucket the monitor spends from, never a second one: a second bucket
     * would raise a tenant's total outbound rate, which is the bound's entire purpose.
     *
     * The reserve is ZERO, and that is the only difference from the monitor. The
     * monitor reserves capacity so a background sweep cannot lock an operator out of
     * their own panel; provisioning is not background in that sense — a customer has
     * paid and is waiting — so it spends at an operator's priority, and the monitor's
     * reserve is what stops a sweep from starving it.
     *
     * A refusal here is NOT a failure: nothing was contacted. The operation goes back
     * to PLANNED with the bound's own retry-after, so the next tick tries again.
     */
    const budget = await this.deps.uow.run(scope, async (tx) =>
      this.deps.panels.takeProbeBudget(scope, this.deps.probeBudget, now, tx, 0),
    );
    if (!budget.permitted) {
      await this.holdOff(
        scope,
        operation,
        new Date(now.getTime() + budget.retryAfterMs),
        'the tenant outbound budget had no capacity',
      );
      return { kind: 'REFUSED', operationId: operation.id, reason: 'BUDGET_EXHAUSTED' };
    }

    const target = { baseUrl: operable.baseUrl, credentials, activation: operable.activation };
    const ref = providerRefFor(service.id, this.deps.hash);
    const http = this.deps.http.forBase(operable.baseUrl);

    /*
     * The stamp that makes a crash recoverable, in a transaction of its OWN before
     * the call.
     *
     * If this process dies during the provider call, the row says a call was started
     * and the lease sweep must NOT hand it to another worker — repeating a mutation
     * that may have taken effect is the duplicate account this design exists to
     * prevent. Committing it inside a transaction that also held the result would mean
     * the crash rolled it back, which is precisely the case it records — so it gets one
     * of its own, which is also what puts it inside ADR-0028's quiesce gate.
     */
    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.operations.markCallStarted(scope, operation.id, this.deps.clock.now(), tx);
    });

    if (operation.type === 'RECONCILE') {
      return this.finishReconcile(scope, operation, service, adapter, target, http, ref);
    }

    /*
     * What was bought, from the ORDER's frozen snapshot.
     *
     * Not from the product: `nexa_orders_snapshot_guard` froze this at confirmation, so
     * it is the only copy that still says what the customer agreed to. A product
     * re-specified since would otherwise silently change the size of a service somebody
     * already paid for — which is the legacy defect where renaming a product rewrote
     * past reports, applied to something a customer can measure.
     */
    const bought = await this.deps.purchases.specificationFor(scope, service.orderId);
    if (bought === null) {
      /*
       * A service whose order has no snapshot.
       *
       * Unreachable — the composite foreign key requires the order to exist and the
       * snapshot column is NOT NULL — and refused rather than defaulted, because every
       * default available here is a lie about a purchase: an unlimited plan, or one
       * that expires today.
       */
      await this.refuse(scope, operation, service, 'ACTIVATION_INCOMPLETE', now);
      return { kind: 'REFUSED', operationId: operation.id, reason: 'ACTIVATION_INCOMPLETE' };
    }

    /*
     * The expiry is computed ONCE, here, and from the moment the service is actually
     * created rather than from when it was ordered.
     *
     * A customer whose provisioning was delayed by a panel outage must not lose that
     * time off a plan they paid for. Computed in the application layer and PASSED to
     * the adapter, never derived inside it: an adapter that called a clock would
     * compute a different expiry on every retry, so a create and the reconcile that
     * adopted it would disagree about when the service ends.
     */
    const created = await adapter.createUser(target, http, {
      username: ref.username,
      subscriptionRef: ref.subscriptionRef,
      clientId: ref.clientId,
      serviceId: service.id as never,
      // Zero is the schema's unlimited and null is the adapter's. One translation, here.
      volumeBytes: service.trafficLimitBytes === 0n ? null : service.trafficLimitBytes,
      durationDays: bought.durationDays,
      expiresAt: expiryFor(now, bought.durationDays),
      deviceLimit: bought.deviceLimit,
    });
    const finishedAt = this.deps.clock.now();

    if (!created.ok) {
      const outcome = outcomeFor(created.failure, operation.type);
      await this.persistFailure(
        scope,
        operation,
        service,
        outcome,
        created.failure,
        created.status,
        finishedAt,
      );
      return {
        kind: 'ATTEMPTED',
        operationId: operation.id,
        serviceId: service.id,
        outcome,
        failureKind: created.failure,
      };
    }

    await this.persistSuccess(
      scope,
      operation,
      service,
      {
        providerUserId: created.providerUserId,
        subscriptionUrl:
          created.delivery.kind === 'SUBSCRIPTION_LINK' ? created.delivery.url : null,
        expiresAt: created.usage?.expiresAt ?? expiryFor(now, bought.durationDays),
        trafficUsedBytes: created.usage?.usedBytes ?? null,
        usageSyncedAt: created.usage === null ? null : finishedAt,
      },
      finishedAt,
    );
    return {
      kind: 'ATTEMPTED',
      operationId: operation.id,
      serviceId: service.id,
      outcome: 'SUCCEEDED',
      failureKind: null,
    };
  }

  /**
   * Puts an operation back without counting it as an attempt against the provider.
   *
   * For the two refusals that are about US rather than about the panel — a stopped
   * tenant and an exhausted outbound budget. Neither is a failure of anything and
   * neither is the operator's to fix, so no operational event is opened and no failure
   * kind is recorded. The attempt the claim already counted is spent either way, which
   * is the honest accounting: the row WAS claimed.
   */
  private async holdOff(
    scope: TenantContext,
    operation: OperationRecord,
    retryAt: Date,
    note: string,
  ): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.operations.transition(
        scope,
        operation.id,
        'IN_FLIGHT',
        'PLANNED',
        { failureMessage: note, nextAttemptAt: retryAt },
        now,
        tx,
      );
    });
  }

  /** A reconcile: a READ, so its failure is never `UNKNOWN`. */
  private async finishReconcile(
    scope: TenantContext,
    operation: OperationRecord,
    service: ServiceRecord,
    adapter: ProviderAdapter,
    target: Parameters<ProviderAdapter['lookupUser']>[0],
    http: Parameters<ProviderAdapter['lookupUser']>[1],
    ref: Parameters<ProviderAdapter['lookupUser']>[2],
  ): Promise<ExecutionResult> {
    const verdict = await reconcileCall(adapter, target, http, ref);
    const now = this.deps.clock.now();
    const serviceId = service.id;
    /*
     * What the order froze, read for the same reason the create path reads it.
     *
     * The adopt path below used the panel's own expiry verbatim, and a 3X-UI client
     * whose `expiryTime` is 0 — or a Marzban user with no `expire` — reports NONE. That
     * is the panel's "unlimited", and adopting it meant a service somebody paid thirty
     * days for became one that never expires and never appears in `services_expiry_idx`.
     * The panel is the authority for what the account does; the ORDER is the authority
     * for what was sold, and this column is the second.
     */
    const bought = await this.deps.purchases.specificationFor(scope, service.orderId);

    if (verdict.kind === 'UNDECIDED') {
      await this.persistFailure(
        scope,
        operation,
        service,
        'FAILED',
        verdict.failure,
        verdict.status,
        now,
      );
      return {
        kind: 'ATTEMPTED',
        operationId: operation.id,
        serviceId,
        outcome: 'FAILED',
        failureKind: verdict.failure,
      };
    }

    const actor = this.actor();
    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.operations.transition(
        scope,
        operation.id,
        'IN_FLIGHT',
        'SUCCEEDED',
        {},
        now,
        tx,
      );
      if (verdict.kind === 'ADOPT') {
        /*
         * The account exists. `providerUserAdopted`, the guard SERVICE_MACHINE names.
         *
         * The create DID happen; only the answer was lost. So the service becomes
         * ACTIVE with what the panel reports, and no second create is ever issued.
         */
        await this.deps.services.transition(
          scope,
          serviceId,
          'UNRECONCILED',
          'ACTIVE',
          {
            providerUserId: verdict.providerUserId,
            subscriptionUrl: verdict.subscriptionUrl,
            // The panel's figure when it has one; otherwise what the order sold,
            // counted from the moment of adoption — the same generosity the create
            // path shows a customer whose provisioning a panel outage delayed.
            expiresAt:
              verdict.expiresAt ?? (bought === null ? null : expiryFor(now, bought.durationDays)),
            trafficUsedBytes: verdict.usedBytes,
            usageSyncedAt: verdict.usedBytes === null ? null : now,
          },
          now,
          tx,
        );
        await this.deps.opsLog.record(
          scope,
          {
            code: PROVISIONING_DELIVERED_CODE,
            severity: 'INFO',
            message: 'A service whose outcome was unknown was found on its panel and adopted.',
            context: { serviceId, adopted: true },
            recoversCode: PROVISIONING_STALLED_CODE,
            recoversDedupeKey: provisioningConditionKey(serviceId),
          },
          tx,
        );
      } else {
        /*
         * The panel answered and does not have it. `providerUserProvablyAbsent`.
         *
         * The ONLY thing that makes a fresh create legal, which is why the service goes
         * back to PENDING_PROVISION rather than anywhere else — and why an adapter is
         * forbidden from reporting absence because a request failed.
         */
        await this.deps.services.transition(
          scope,
          serviceId,
          'UNRECONCILED',
          'PENDING_PROVISION',
          null,
          now,
          tx,
        );
        /*
         * A fresh create, planned under an id DERIVED from the reconcile that
         * authorised it.
         *
         * Derived and not generated, for the reason the whole design rests on: two
         * reconcile replicas that both establish absence must agree on the next
         * operation id with no lookup, so the second `plan` loses on
         * `provisioning_operations_tenant_operation_key` instead of planning a second
         * create. A `uuid()` here would produce exactly the duplicate account this file
         * exists to prevent.
         *
         * Keyed on the RECONCILE's operation id rather than on the service alone,
         * because the service's first PROVISION already spent `<serviceId>:PROVISION`
         * and that row is terminal.
         */
        await this.deps.operations.plan(
          scope,
          {
            id: this.deps.ids.uuid(),
            operationId: this.deps.operationId(
              `${serviceId}:PROVISION:after:${operation.operationId}`,
            ),
            serviceId,
            orderId: operation.orderId,
            panelId: service.panelId,
            type: 'PROVISION',
          },
          now,
          tx,
        );
      }
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'service.reconcile',
          entityType: 'Service',
          entityId: serviceId,
          before: { state: 'UNRECONCILED' },
          after: { state: verdict.kind === 'ADOPT' ? 'ACTIVE' : 'PENDING_PROVISION' },
          result: 'SUCCESS',
        },
        tx,
      );
    });

    return {
      kind: 'ATTEMPTED',
      operationId: operation.id,
      serviceId,
      outcome: 'SUCCEEDED',
      failureKind: null,
    };
  }

  /** A refusal: nothing was contacted, so nothing about a provider is recorded. */
  private async refuse(
    scope: TenantContext,
    operation: OperationRecord,
    service: ServiceRecord,
    reason: ExecutionRefusal,
    now: Date,
  ): Promise<void> {
    const permanent = refusalIsPermanent(reason) || exhausted(operation.attempts);
    const actor = this.actor();
    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.operations.transition(
        scope,
        operation.id,
        'IN_FLIGHT',
        permanent ? 'FAILED' : 'PLANNED',
        {
          failureMessage: reason,
          nextAttemptAt: permanent ? null : new Date(now.getTime() + backoffMs(operation.attempts)),
        },
        now,
        tx,
      );
      if (permanent) {
        await this.deps.opsLog.record(
          scope,
          {
            code: PROVISIONING_STALLED_CODE,
            severity: 'ERROR',
            message: 'A paid service could not be created on its panel.',
            context: { serviceId: service.id, panelId: service.panelId, reason },
            dedupeKey: provisioningConditionKey(service.id),
          },
          tx,
        );
      }
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'service.provision',
          entityType: 'Service',
          entityId: service.id,
          before: null,
          after: { refused: reason, permanent },
          result: 'DENIED',
        },
        tx,
      );
    });
  }

  private async persistFailure(
    scope: TenantContext,
    operation: OperationRecord,
    service: ServiceRecord,
    outcome: OperationState,
    failure: ProviderFailureKind,
    status: number | null,
    now: Date,
  ): Promise<void> {
    /*
     * `UNKNOWN` is never retried as the same mutation.
     *
     * A `FAILED` with attempts left goes back to PLANNED with a backoff; one without
     * becomes terminal. An `UNKNOWN` does neither — it waits for a READ, and the
     * service moves to `UNRECONCILED` so nothing can issue a second create.
     */
    const retryable = outcome === 'FAILED' && !exhausted(operation.attempts);
    const serviceId = service.id;
    const actor = this.actor();
    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.operations.transition(
        scope,
        operation.id,
        'IN_FLIGHT',
        retryable ? 'PLANNED' : outcome,
        {
          failureKind: failure,
          failureMessage: failureNote(failure, status),
          nextAttemptAt: retryable ? new Date(now.getTime() + backoffMs(operation.attempts)) : null,
        },
        now,
        tx,
      );

      if (serviceEventFor(outcome) === 'PROVISION_LOST_TRACK') {
        await this.deps.services.transition(
          scope,
          serviceId,
          'PENDING_PROVISION',
          'UNRECONCILED',
          null,
          now,
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'ProvisioningOutcomeUnknown',
          aggregateType: 'Service',
          aggregateId: serviceId,
          payload: {
            serviceId,
            panelId: service.panelId,
            operationType: operation.type,
            failureKind: failure,
          },
        });
      }

      if (!retryable) {
        await this.deps.opsLog.record(
          scope,
          {
            code: PROVISIONING_STALLED_CODE,
            severity: 'ERROR',
            message: 'A paid service could not be created on its panel.',
            context: {
              serviceId,
              panelId: service.panelId,
              reason: outcome === 'UNKNOWN' ? 'UNRECONCILED' : 'EXHAUSTED',
              failureKind: failure,
            },
            dedupeKey: provisioningConditionKey(serviceId),
          },
          tx,
        );
      }
    });
  }

  private async persistSuccess(
    scope: TenantContext,
    operation: OperationRecord,
    service: ServiceRecord,
    outcome: {
      readonly providerUserId: string | null;
      readonly subscriptionUrl: string | null;
      readonly expiresAt: Date | null;
      readonly trafficUsedBytes: bigint | null;
      readonly usageSyncedAt: Date | null;
    },
    now: Date,
  ): Promise<void> {
    const serviceId = service.id;
    const actor = this.actor();
    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.operations.transition(
        scope,
        operation.id,
        'IN_FLIGHT',
        'SUCCEEDED',
        { providerReference: outcome.providerUserId },
        now,
        tx,
      );
      const moved = await this.deps.services.transition(
        scope,
        serviceId,
        'PENDING_PROVISION',
        'ACTIVE',
        outcome,
        now,
        tx,
      );
      if (!moved) {
        /*
         * The service left `PENDING_PROVISION` while this call was on the wire.
         *
         * The operation still SUCCEEDED — a provider account exists, and saying
         * otherwise would be a lie about an external effect — and the service is left
         * exactly as whoever moved it left it. Throwing here would roll back the
         * operation's success and invite a second create.
         */
        return;
      }
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'service.provision',
          entityType: 'Service',
          entityId: serviceId,
          before: { state: 'PENDING_PROVISION' },
          after: { state: 'ACTIVE', hasSubscription: outcome.subscriptionUrl !== null },
          result: 'SUCCESS',
        },
        tx,
      );
      await this.deps.outbox.write(tx, actor, {
        eventType: 'ServiceProvisioned',
        aggregateType: 'Service',
        aggregateId: serviceId,
        payload: {
          customerId: service.customerId,
          orderId: service.orderId,
          panelId: service.panelId,
          operationId: operation.operationId,
        },
      });
      await this.deps.opsLog.record(
        scope,
        {
          code: PROVISIONING_DELIVERED_CODE,
          severity: 'INFO',
          message: 'A paid service was created on its panel.',
          context: { serviceId },
          recoversCode: PROVISIONING_STALLED_CODE,
          recoversDedupeKey: provisioningConditionKey(serviceId),
        },
        tx,
      );
    });
  }
}
