import {
  canAddTime,
  canAddVolume,
  canDeleteUser,
  canDisableUser,
  canRenewUser,
  canEnableUser,
  canRotateSubscription,
  isIdempotentMutation,
  isMutatingOperation,
  nextState,
  OPERATION_MAX_ATTEMPTS,
  SAFE_TO_REPLAY_FAILURE_KINDS,
  SERVICE_MACHINE,
  PROVIDER_FAILURE_RETRYABLE,
  USAGE_SYNC_PLAN_LIMIT,
  systemJobActor,
  type ActorContext,
  type Clock,
  type CorrelationId,
  type Hasher,
  type IdGenerator,
  type OperationalEventRecorder,
  type OperationId,
  type OperationState,
  type OperationTarget,
  type OperationType,
  type OrderId,
  type OrderPurpose,
  type ProviderAdapter,
  type ProviderFailureDetail,
  type ProviderFailureKind,
  type ProviderRemovalOutcome,
  type ProviderRotationOutcome,
  type ProviderStateChangeOutcome,
  type ProviderType,
  type ProviderUsage,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { AuditWriter } from '@nexa/contracts';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
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
import type { OrderRecord, OrderRepository } from '../../orders/application/ports.js';
import {
  isFreeTrial,
  type UndeliverableOrderRefunder,
} from '../../orders/application/undeliverable-order-refunder.js';
import type { PaymentRepository } from '../../payments/application/ports.js';
import {
  ALLOWANCE_VERIFICATION_READS,
  BACKOFF_BASE_MS,
  RECONCILE_ROUNDS,
  backoffMs,
  expiryFor,
  exhausted,
  failureNote,
  outcomeFor,
  providerRefFor,
  isPerformableOperation,
  MANAGEMENT_TARGET_STATE,
  OPERATION_LEGAL_FROM,
  ROTATION_STORE_STATES,
  provisionCall,
  resumeCall,
  rotateCall,
  allowanceCall,
  suspendCall,
  terminateCall,
  usageSyncCall,
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
 * Which refusals are DETERMINISTIC — the same answer on the next attempt, and on
 * the fifth.
 *
 * ## What this used to be, and what it cost
 *
 * It used to return true for `PROVIDER_NOT_OPERABLE` and `CAPABILITY_UNSUPPORTED`
 * only, on the argument that "the other four are configuration, and configuration
 * can change in the minute after the refusal — a panel re-enabled, a credential
 * set, an activation completed".
 *
 * That argument is true and it is not a reason to retry. Order `01a0c54b` on
 * v0.2.8 refused `ACTIVATION_INCOMPLETE` five times over roughly seven minutes —
 * 30s, 60s, 120s, 240s of backoff — because nobody completes a panel's activation
 * inside four minutes without knowing they need to, and the thing that would tell
 * them is the operational event this delays. So the customer waited seven minutes
 * for an answer that was fully determined at the first attempt, and the operator
 * got the alert four minutes late.
 *
 * A refusal is not a failure to be ridden out. NOTHING WAS CONTACTED: these are
 * decisions this installation made about its own rows, before any socket was
 * opened. A retry re-reads the same rows and reaches the same verdict.
 *
 * ## The six that are deterministic
 *
 * Two are about CODE — no operator action fixes them at all:
 *   - `PROVIDER_NOT_OPERABLE`: no adapter for this provider in this release.
 *   - `CAPABILITY_UNSUPPORTED`: the adapter does not declare what this needs.
 *
 * Four are about CONFIGURATION — an operator fixes them on a screen, and the
 * remedy is the operational event, not the wait:
 *   - `ACTIVATION_INCOMPLETE`: a required provider field is unset or invalid.
 *   - `CREDENTIALS_MISSING`: the credentials this provider needs are not set.
 *   - `PANEL_DISABLED`: the operator said stop using this panel.
 *   - `PANEL_ABSENT`: archived, or gone.
 *
 * `PANEL_DISABLED` deserves its own sentence, because "they might re-enable it"
 * is the tempting objection. An operator who disabled a panel made a decision;
 * quietly retrying against it for seven minutes in the hope they change their
 * mind is the system second-guessing an instruction. Refunding at once and
 * telling them a paid order hit a disabled panel is the honest answer, and it is
 * the one that reaches them while they are still at the keyboard.
 *
 * ## What still backs off, and why that list is exactly right
 *
 * `PANEL_NOT_REACHABLE` is the URL policy refusing an address, which a DNS change
 * can genuinely flip. `BUDGET_EXHAUSTED`, `TENANT_STOPPED` and `LEASE_LOST` are
 * about US rather than the panel and are not failures at all — `holdOff` refunds
 * their attempt so they do not even count. `SERVICE_ABSENT` terminalises by its
 * own path.
 *
 * The invariant worth stating: a deterministic refusal is answered by a REFUND and
 * an operational event, both within one tick. Nothing about the panel is recorded,
 * because nothing about the panel was learned.
 */
export function refusalIsPermanent(reason: ExecutionRefusal): boolean {
  return DETERMINISTIC_REFUSALS.has(reason);
}

/**
 * The set, as data, so a test can enumerate it and a reader can count it.
 *
 * A `switch` would be equally correct and would not let
 * `tests/unit/refusal-classification.test.ts` assert the WHOLE partition — that
 * every `ExecutionRefusal` is in exactly one of these two groups, so a refusal
 * added later cannot silently default to being retried five times.
 */
const DETERMINISTIC_REFUSALS: ReadonlySet<ExecutionRefusal> = new Set([
  'PROVIDER_NOT_OPERABLE',
  'CAPABILITY_UNSUPPORTED',
  'ACTIVATION_INCOMPLETE',
  'CREDENTIALS_MISSING',
  'PANEL_DISABLED',
  'PANEL_ABSENT',
]);

/** The complement, exported for the partition test. Never used to decide. */
export const RETRYABLE_REFUSALS: readonly ExecutionRefusal[] = [
  'PANEL_NOT_REACHABLE',
  'BUDGET_EXHAUSTED',
  'TENANT_STOPPED',
  'SERVICE_ABSENT',
  'LEASE_LOST',
  'PROVISION_IN_FLIGHT',
];

/** How many abandoned leases one tick may return to the pool. */
export const LEASE_SWEEP_LIMIT = 20;

/**
 * How many reconciles one tick may plan.
 *
 * Small, because planning is not the bottleneck: each planned reconcile still has to
 * be claimed and executed one per tick, so a large batch would only queue work the
 * same loop then drains at its own pace. Five is enough that an outage which lost a
 * handful of answers is fully queued within seconds.
 */
export const RECONCILE_PLAN_LIMIT = 5;

/**
 * How many services one tick may expire.
 *
 * Larger than the two above because expiry costs no provider call and no claim: it is
 * one conditional UPDATE, and the only reason to bound it at all is so that a tenant
 * whose plans all lapse on the same midnight does not turn one tick into one
 * statement over a hundred thousand rows holding locks the rest of the loop needs.
 *
 * Here rather than in `packages/contracts` alongside `USAGE_SYNC_PLAN_LIMIT`, and the
 * difference is not arbitrary: that one bounds a sweep whose CADENCE is an operator
 * setting, so its bound belongs beside the schema that checks the setting. This sweep
 * has no setting — a service expires when its own `expires_at` says so — so its bound
 * is an implementation detail of the loop, like `LEASE_SWEEP_LIMIT` above.
 */
export const SERVICE_EXPIRY_SWEEP_LIMIT = 200;

/**
 * How many times one service may go round create → unknown → reconcile → absent.
 *
 * The cycle is legitimate ONCE: a create whose answer was lost, a panel that proves it
 * has no such account, and a fresh create that is therefore safe. It is a bug twice
 * over in a row, and left unbounded it is a loop with no ceiling at all — each round
 * derives a NEW operation id from the round before, so nothing collides, the per-
 * operation attempt ceiling never applies, and a panel that fails every create while
 * answering every lookup "absent" would be dialled for ever at the tenant's budget.
 *
 * The bound is on the SERVICE rather than on an operation, because an operation is
 * what the cycle keeps making. At the ceiling the reconcile stops re-planning and opens
 * `provisioning.stalled` instead: nothing is left claimable, nothing is left in the
 * reconcile queue, and an operator has a row to act on with `retryProvisioning` as the
 * deliberate way back in.
 */
export const SERVICE_PROVISION_CYCLE_LIMIT = 3;

export interface ProvisionerDeps {
  readonly operations: OperationRepository;
  readonly services: ServiceRepository;
  readonly purchases: PurchaseSnapshotReader;
  /**
   * The ORDER a failed operation was bought by, read to decide whether money is owed
   * back. `findById` alone: this lane never manages an order, it asks one question.
   */
  readonly orders: Pick<OrderRepository, 'findById'>;
  /**
   * The confirmed payment behind that order, which is what bounds the refund.
   *
   * One read, narrowed. A provisioner that could write a payment would be a
   * provisioner that could confirm one, and nothing on a panel is evidence that
   * money arrived.
   */
  readonly payments: Pick<PaymentRepository, 'findConfirmedForOrder'>;
  /**
   * Gives the customer their money back when a paid operation definitively failed.
   *
   * The SAME collaborator the settlement lane uses, so there is one implementation of
   * "the order is refunded and closed" and one wallet credit path. See
   * `UndeliverableOrderRefunder`.
   */
  readonly undeliverable: UndeliverableOrderRefunder;
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
  /**
   * Where `provisioning.usage_sync_minutes` is read from.
   *
   * The resolver rather than a number, for the reason `OrderService` takes it: the
   * cadence is a PER-TENANT setting and a worker serves several tenants, so a value
   * read once at construction would apply one tenant's answer to all of them. Read on
   * every tick, which is also what makes the key's declared RUNTIME mutability true —
   * a change takes effect without a restart.
   */
  readonly settings: SettingsResolver;
}

/**
 * What each order purpose BOUGHT, as the operation that delivers it.
 *
 * Module-level and exported since WP8, so the one other reader — the cashback earner,
 * which pays out when this operation SUCCEEDS — asks the same table rather than a copy
 * of it. The rule and its reasoning are on `ProvisionerService.PURCHASED_AS`, below.
 */
export const PURCHASED_AS: Readonly<Record<OrderPurpose, OperationType>> = {
  NEW_SERVICE: 'PROVISION',
  RENEW: 'RENEW',
  ADD_TRAFFIC: 'ADD_TRAFFIC',
  ADD_TIME: 'ADD_TIME',
  // A trial is a create nobody paid for, and it is given back on the same lane: it
  // stops counting against the customer's limit. `docs/wp6-audit.md` A4.
  TRIAL: 'PROVISION',
};

/**
 * The service states in which a lost commercial write is still worth a READ (WP15 G2).
 *
 * Wider than `OPERATION_LEGAL_FROM`, which decides whether a write may START: a service
 * that expired or was suspended while its renewal's answer was lost still has the account,
 * and the read can still say whether the renewal landed.
 */
const VERIFIABLE_STATES: readonly ServiceRecord['state'][] = ['ACTIVE', 'SUSPENDED', 'EXPIRED'];

/**
 * Whether what a panel reports holds at least the absolute target a commercial operation
 * persisted (WP15 G2). Pure, and exported for the table test that pins it.
 *
 * "At least", not "equal": a panel showing a later expiry or a larger allowance than the
 * target has what the customer paid for, whoever else extended it. A panel with NO limit
 * on a field (null) holds any finite target on it. A target of `0n` traffic is the
 * schema's "unlimited" and is reached only by a panel reporting no limit.
 */
export function allowanceReached(target: OperationTarget, usage: ProviderUsage | null): boolean {
  if (usage === null) return false;
  if (target.expiresAt !== null) {
    /*
     * In whole SECONDS. Panels store `expire` as epoch seconds and the adapters send
     * `floor(ms / 1000)`, while a target counted from "now" carries milliseconds — so
     * a renewal the panel applied exactly reads up to 999 ms short. Comparing in ms
     * called every such renewal "not applied" and refunded it.
     */
    if (
      usage.expiresAt !== null &&
      Math.floor(usage.expiresAt.getTime() / 1000) < Math.floor(target.expiresAt.getTime() / 1000)
    ) {
      return false;
    }
  }
  if (target.trafficLimitBytes !== null) {
    if (target.trafficLimitBytes === 0n) {
      if (usage.totalBytes !== null) return false;
    } else if (usage.totalBytes !== null && usage.totalBytes < target.trafficLimitBytes) {
      return false;
    }
  }
  return true;
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
     * The tenant kill switch FIRST, before any write in this tick.
     *
     * It used to be consulted after `retireExhausted`, `planReconciles`, the lease
     * release and the claim — so a tenant an operator had stopped went on acquiring
     * reconcile rows, terminal transitions and operational events, and the hold-off
     * below refunded only the claim's attempt. CLAUDE.md names panels as the module
     * that skipped this check; doing it late is the same defect wearing a check.
     *
     * The per-operation check further down STAYS. A stop can commit between this
     * transaction and that one, and the one that must not be skipped is the one
     * immediately before a provider is dialled with the operator's credentials.
     */
    if (
      !(await this.deps.uow.run(scope, async (tx) =>
        this.deps.scopeActivity.scopeIsActive(scope, tx),
      ))
    ) {
      return { kind: 'IDLE' };
    }

    /*
     * Abandoned leases first, so a crashed worker's work is reclaimable before this one
     * looks for its own. Bounded, and it only touches rows where NO provider call was
     * started — the guard `OPERATION_MACHINE` names, enforced as a WHERE clause.
     */
    await this.retireExhausted(scope, now);
    /*
     * Then the rows a crash stranded mid-call, which that guard deliberately refuses.
     *
     * BEFORE `planReconciles`, so a stranded create becomes `UNKNOWN` and is given its
     * reconcile in the SAME tick rather than waiting for the next one. That ordering is
     * the whole reason this is a separate step rather than part of the release sweep.
     */
    await this.reapStrandedCalls(scope, now);
    await this.planReconciles(scope, now);
    /*
     * AFTER the reconciles, so a tick whose budget is tight spends it on a paid order
     * that has not been delivered before it spends it refreshing a figure. `claimDue`
     * is oldest-first across all types, so this is about which rows EXIST, not about
     * which is claimed — but a reconcile planned in the same tick is already older than
     * a sync planned after it.
     */
    await this.planUsageSyncs(scope, now);
    /*
     * And the services whose window has closed, which needs no panel at all.
     *
     * After the sweeps that plan work and before the claim, so a service that expires
     * in this tick is `EXPIRED` before anything else in the tick reads it — which is
     * what stops a usage sync being planned for a service that has just stopped being
     * one, and spending an outbound request on a figure that cannot move again.
     */
    await this.expireDue(scope, now);
    /*
     * WP15 G2: at most ONE verification read of an ambiguous commercial write per tick.
     * Before the claim, so a tick whose budget is tight answers a customer who already
     * paid before it starts new work — and it is one read, so it cannot starve the claim.
     */
    await this.verifyOneAllowance(scope, now);

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
      return this.refusedAbandoned(operation, 'SERVICE_ABSENT');
    }

    /*
     * An operation this release cannot perform is refused HERE, before anything else.
     *
     * The Phase 4E audit calls the type dispatch "the single most dangerous edit in
     * this phase", and names the property to preserve: an operation whose type has no
     * implementation is refused before any provider is contacted, not defaulted to the
     * one call the function used to make. `provisionCall` calls `createUser`
     * unconditionally and its own docblock records that a future type routed through it
     * "would silently create a user on somebody's panel".
     *
     * So the check is a membership test against `PERFORMABLE_OPERATION_TYPES` and it
     * runs before the state check, the tenant check, the panel read, the credential
     * decryption and the budget — because every one of those is work, and none of it is
     * owed to an operation nobody can carry out.
     *
     * ABANDONED rather than FAILED. `FAILED` is retried, and no number of retries
     * teaches this release an operation type; `OPERATION_MACHINE` provides ABANDONED
     * for exactly the situation nothing else can resolve. A row planned by a version
     * that could perform it and claimed by one that cannot is a rollback, and the
     * honest answer to a rollback is to stop, not to loop.
     */
    if (!isPerformableOperation(operation.type)) {
      await this.deps.uow.run(scope, async (tx) => {
        await this.deps.operations.transition(
          scope,
          operation.id,
          'IN_FLIGHT',
          'ABANDONED',
          { failureMessage: `this release does not perform ${operation.type} operations` },
          now,
          tx,
        );
      });
      return this.refused(operation, 'CAPABILITY_UNSUPPORTED');
    }

    /*
     * The service must still be in a state this operation is legal from.
     *
     * `SERVICE_MACHINE`'s edges, checked before anything is spent rather than discovered
     * afterwards by a conditional UPDATE that quietly did nothing. Without this the
     * executor would dial a panel for a service that is already ACTIVE, and the
     * collision on the derived username comes back as a `PROVIDER_ERROR`, which
     * classifies UNKNOWN on a mutating call, which moves a working service to
     * `UNRECONCILED`.
     *
     * A TABLE, `OPERATION_LEGAL_FROM`, rather than the ternary this used to be. The
     * ternary read "RECONCILE from UNRECONCILED, everything else from
     * PENDING_PROVISION", which answers confidently for a type nobody has thought
     * about: `SYNC_USAGE` would have been declared legal only from the one state where
     * there is no account to read.
     *
     * ABANDONED rather than failed or retried: nothing about a stale operation improves
     * by trying it again.
     */
    const legalFrom = OPERATION_LEGAL_FROM[operation.type];
    if (!legalFrom.includes(service.state)) {
      await this.deps.uow.run(scope, async (tx) => {
        await this.deps.operations.transition(
          scope,
          operation.id,
          'IN_FLIGHT',
          'ABANDONED',
          {
            failureMessage: `the service is ${service.state}, not ${legalFrom.join(' or ')}`,
          },
          now,
          tx,
        );
      });
      return this.refusedAbandoned(operation, 'SERVICE_ABSENT');
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
      return this.refusedAndHeld(operation, 'TENANT_STOPPED');
    }

    /*
     * WP15 G1: a TERMINATE never issues a DELETE merely because a username exists.
     *
     * Decided before any panel is read, credential decrypted or budget spent, because in
     * the case it exists for none of that is owed.
     */
    if (operation.type === 'TERMINATE') {
      const decided = await this.terminateWithoutProvider(scope, operation, service, now);
      if (decided !== null) return decided;
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
      return this.refused(operation, operable.reason);
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
      return this.refused(operation, 'PANEL_NOT_REACHABLE');
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
      return this.refused(operation, 'CREDENTIALS_MISSING');
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
      return this.refusedAndHeld(operation, 'BUDGET_EXHAUSTED');
    }

    const target = { baseUrl: operable.baseUrl, credentials, activation: operable.activation };
    const ref = providerRefFor(service);
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
    const stamped = await this.deps.uow.run(scope, async (tx) => {
      /*
       * WP15 G1: a CREATE is stamped under the service's row lock, and only while the
       * service is still waiting for it.
       *
       * A TERMINATE decides under the same lock whether any create ever reached the
       * panel. Without this, a terminate could find no stamp, end the service Nexa-side
       * with no DELETE, commit — and the create claimed a moment earlier would then
       * stamp and make the account for a service that no longer exists. With it, one of
       * them waits for the other and each sees what the other wrote.
       */
      if (operation.type === 'PROVISION') {
        const locked = await this.deps.services.lockForUpdate(scope, service.id, tx);
        if (locked === null || locked.state !== 'PENDING_PROVISION') {
          await this.deps.operations.transition(
            scope,
            operation.id,
            'IN_FLIGHT',
            'ABANDONED',
            { failureMessage: `the service is ${locked?.state ?? 'gone'}, not PENDING_PROVISION` },
            this.deps.clock.now(),
            tx,
          );
          return 'STALE' as const;
        }
      }
      return (await this.deps.operations.markCallStarted(
        scope,
        operation.id,
        this.deps.workerId,
        this.deps.clock.now(),
        tx,
      ))
        ? ('STAMPED' as const)
        : ('LOST' as const);
    });
    if (stamped === 'STALE') return this.refusedAbandoned(operation, 'SERVICE_ABSENT');
    if (stamped === 'LOST') {
      /*
       * The claim is no longer this worker's, so no provider is contacted.
       *
       * The stamp asserts the whole claim — still `IN_FLIGHT`, still ours, lease still
       * in the future — and a `false` means this process stalled past its own lease.
       * Another replica may have released and reclaimed the operation in that window,
       * and calling anyway would be the second create for one paid order that this
       * phase exists to prevent.
       *
       * Nothing is written. The row belongs to whoever holds it now, or to the next
       * lease sweep; either way this worker has no standing to record an outcome for
       * it, and the attempt the claim counted is the honest cost of having stalled.
       */
      return this.refused(operation, 'LEASE_LOST');
    }

    /*
     * The dispatch. Exhaustive over what this release performs, and nothing else.
     *
     * `isPerformableOperation` above already refused every other member of
     * `OPERATION_TYPES`, so the switch below has no reachable default — and it is
     * written as a switch on the type rather than as two ifs and a fall-through,
     * because a fall-through is how `provisionCall` came to be the thing an unhandled
     * type does.
     */
    switch (operation.type) {
      case 'RECONCILE':
        return this.finishReconcile(scope, operation, service, adapter, target, http, ref);
      case 'SYNC_USAGE':
        return this.finishUsageSync(scope, operation, service, adapter, target, http, ref);
      /*
       * The three management branches, each narrowing the adapter at the point of call.
       *
       * The guards are what make the calls type-safe — `suspendUser` and its siblings
       * are OPTIONAL on the port, so nothing else would stop this line calling
       * `undefined`. They ask two questions and require both: the method exists AND the
       * descriptor declares the capability.
       *
       * A `false` here is UNREACHABLE as the code stands, and is written out rather
       * than asserted away. `decideOperability` already refused this operation above,
       * because `OPERATION_REQUIRED_CAPABILITIES` names the same capability and it is
       * read from the same descriptor — so a 3X-UI-backed service never arrives here at
       * all. The branch earns its place against one specific future edit: a change that
       * relaxed the operability check, or a descriptor that gained a capability without
       * the method behind it. `tests/unit/registries.test.ts` asserts the second cannot
       * happen; this is what happens if it does anyway, and it is a refusal rather than
       * a TypeError, which is not a `ProviderFailureKind` and would leave a mutating
       * operation unable to say whether it took effect.
       */
      case 'SUSPEND': {
        if (!canDisableUser(adapter)) {
          await this.refuse(scope, operation, service, 'CAPABILITY_UNSUPPORTED', now);
          return this.refused(operation, 'CAPABILITY_UNSUPPORTED');
        }
        return this.finishStateChange(
          scope,
          operation,
          service,
          'SUSPEND',
          await suspendCall(adapter, target, http, ref),
        );
      }
      case 'RESUME': {
        if (!canEnableUser(adapter)) {
          await this.refuse(scope, operation, service, 'CAPABILITY_UNSUPPORTED', now);
          return this.refused(operation, 'CAPABILITY_UNSUPPORTED');
        }
        return this.finishStateChange(
          scope,
          operation,
          service,
          'RESUME',
          await resumeCall(adapter, target, http, ref),
        );
      }
      case 'TERMINATE': {
        if (!canDeleteUser(adapter)) {
          await this.refuse(scope, operation, service, 'CAPABILITY_UNSUPPORTED', now);
          return this.refused(operation, 'CAPABILITY_UNSUPPORTED');
        }
        return this.finishTerminate(
          scope,
          operation,
          service,
          await terminateCall(adapter, target, http, ref),
        );
      }
      /*
       * A new subscription link. The guard is the same two-question guard as the three
       * above, for the same reason, and the previous link travels with the call because
       * it is what the adapter's read-back compares against.
       */
      case 'ROTATE_SUBSCRIPTION': {
        if (!canRotateSubscription(adapter)) {
          await this.refuse(scope, operation, service, 'CAPABILITY_UNSUPPORTED', now);
          return this.refused(operation, 'CAPABILITY_UNSUPPORTED');
        }
        return this.finishRotation(
          scope,
          operation,
          service,
          await rotateCall(adapter, target, http, ref, service.subscriptionUrl),
        );
      }
      /*
       * The three commercial branches, each narrowing the adapter through its OWN
       * predicate.
       *
       * One `allowanceCall` behind three guards, and the guards are not
       * interchangeable: `canAddVolume` asks for `ADD_VOLUME` and `canAddTime` for
       * `ADD_TIME`, so a panel that declares one and not the other performs one and not
       * the other. Collapsing them into a single check would let a descriptor that
       * advertised a renewal be used to sell extra traffic.
       *
       * `operation.target` is asserted rather than defaulted. The database refuses a
       * commercial operation with neither field — `provisioning_operations_target_present_check`
       * — so a null here means the constraint is gone, and the safe answer is a refusal
       * rather than a PUT that asks the panel for nothing and is recorded as a renewal
       * that succeeded.
       */
      case 'RENEW': {
        if (!canRenewUser(adapter) || operation.target === null) {
          await this.refuse(scope, operation, service, 'CAPABILITY_UNSUPPORTED', now);
          return this.refused(operation, 'CAPABILITY_UNSUPPORTED');
        }
        return this.finishAllowance(
          scope,
          operation,
          service,
          operation.target,
          await allowanceCall(adapter, target, http, ref, operation.target),
        );
      }
      case 'ADD_TRAFFIC': {
        if (!canAddVolume(adapter) || operation.target === null) {
          await this.refuse(scope, operation, service, 'CAPABILITY_UNSUPPORTED', now);
          return this.refused(operation, 'CAPABILITY_UNSUPPORTED');
        }
        return this.finishAllowance(
          scope,
          operation,
          service,
          operation.target,
          await allowanceCall(adapter, target, http, ref, operation.target),
        );
      }
      case 'ADD_TIME': {
        if (!canAddTime(adapter) || operation.target === null) {
          await this.refuse(scope, operation, service, 'CAPABILITY_UNSUPPORTED', now);
          return this.refused(operation, 'CAPABILITY_UNSUPPORTED');
        }
        return this.finishAllowance(
          scope,
          operation,
          service,
          operation.target,
          await allowanceCall(adapter, target, http, ref, operation.target),
        );
      }
      case 'PROVISION':
        break;
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
      return this.refused(operation, 'ACTIVATION_INCOMPLETE');
    }

    /*
     * A device limit the panel cannot enforce is refused, not quietly dropped.
     *
     * A product freezes `deviceLimit` for whichever panel it names, and nothing checked
     * that the panel could apply it. `MarzbanAdapter.createUser` builds its body from
     * `username`, `expire`, `data_limit` and `data_limit_reset_strategy` and never reads
     * the field at all — so a customer buying a two-device plan on a Marzban panel got
     * an account with no device limit, and the operation was recorded SUCCEEDED. The
     * value a customer paid for disappeared between the order snapshot and the panel,
     * with nothing anywhere saying so.
     *
     * Refusing costs the operator a configuration fix before that order completes.
     * Proceeding costs them a customer who was sold something they did not receive, and
     * a service this installation believes is correct. `CAPABILITY_UNSUPPORTED` is
     * PERMANENT (`refusalIsPermanent`), which is right: no number of retries teaches an
     * adapter a field, and the operator's remedy is a panel that supports it or a
     * product that does not promise it.
     *
     * Checked here rather than at product creation because here is where the ORDER's
     * frozen snapshot and the resolved adapter are both in hand. A product-time check is
     * worth adding too and is not a substitute: a product may be re-pointed at another
     * panel, and the snapshot outlives the product.
     */
    if (bought.deviceLimit !== null && !adapter.supports('LIMIT_DEVICES')) {
      await this.refuse(scope, operation, service, 'CAPABILITY_UNSUPPORTED', now);
      return this.refused(operation, 'CAPABILITY_UNSUPPORTED');
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
    const created = await provisionCall(adapter, target, http, {
      serviceId: service.id,
      ref,
      // Zero is the schema's unlimited and null is the adapter's. One translation, here.
      volumeBytes: service.trafficLimitBytes === 0n ? null : service.trafficLimitBytes,
      durationDays: bought.durationDays,
      expiresAt: expiryFor(now, bought.durationDays),
      deviceLimit: bought.deviceLimit,
    });
    const finishedAt = this.deps.clock.now();

    if (!created.ok) {
      /*
       * WP15 G7: a 409 is the NAME taken, and that is a refusal — unless this service has
       * durable provenance from an EARLIER create the panel accepted, in which case the
       * name is very probably held by our own account and a READ must decide. Refunding
       * then would give money back for an account the customer is holding.
       */
      const conflictOnOwnName =
        created.failure === 'PROVIDER_REFUSED' &&
        created.status === 409 &&
        (await this.deps.operations.hasCreateProvenance(scope, service.id));
      const outcome = conflictOnOwnName ? 'UNKNOWN' : outcomeFor(created.failure, operation.type);
      await this.persistFailure(
        scope,
        operation,
        service,
        outcome,
        created.failure,
        created.status,
        finishedAt,
        {
          ...(created.detail === undefined ? {} : { detail: created.detail }),
          ...(created.accepted === true ? { accepted: true } : {}),
        },
      );
      return this.attempted(operation, service.id, outcome, created.failure);
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
    return this.attempted(operation, service.id, 'SUCCEEDED', null);
  }

  /**
   * Puts an operation back and REFUNDS the attempt the claim counted.
   *
   * For the two refusals that are about US rather than about the panel — a stopped
   * tenant and an exhausted outbound budget. Neither is a failure of anything and
   * neither is the operator's to fix, so no operational event is opened and no failure
   * kind is recorded.
   *
   * The refund is the part that matters, and it replaced the opposite rule. The
   * comment here used to argue that the attempt was "spent either way, which is the
   * honest accounting: the row WAS claimed". That is the wrong accounting: the counter
   * bounds PROVIDER CALLS — which is why `claimDue` spends one in the same statement
   * as the claim — and a hold-off contacted nothing.
   *
   * With it spent, and `claimDue` refusing a row at the ceiling, an operator stopping
   * a tenant for twenty-five seconds retired every operation planned before the stop:
   * five ticks at the default interval, each claiming and holding off, leaving the row
   * PLANNED at the ceiling, unclaimable for ever, with no stalled event and no
   * `completed_at`. Restarting the tenant did nothing, and nothing said so.
   */
  private async holdOff(
    scope: TenantContext,
    operation: OperationRecord,
    retryAt: Date,
    note: string,
  ): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.operations.holdOff(scope, operation.id, retryAt, note, now, tx);
    });
  }

  /**
   * Plans a RECONCILE for every service still waiting on an unknown outcome.
   *
   * ## Why this exists at all
   *
   * `UNRECONCILED` had no exit. `SERVICE_MACHINE` leaves it only through
   * `RECONCILED_ACTIVE` or `RECONCILED_ABSENT`, both produced by `finishReconcile`,
   * which runs only for an operation of type `RECONCILE` — and nothing planned one.
   * So a create whose answer was lost took the customer's money, probably left an
   * account on the panel, and put the service somewhere no code path in the product
   * could resolve. `retryProvisioning` refuses `UNRECONCILED` by design, which was the
   * right refusal pointing at a remedy that did not exist.
   *
   * Both adapters are written on the assumption that it does. 3X-UI answers a
   * duplicate email with a message, and Marzban a 409 — both `PROVIDER_ERROR`, which
   * `failureOutcome` classifies UNKNOWN on a mutating call, "which sends the operation
   * to reconciliation, and reconciliation ASKS the panel". This is the half that asks.
   *
   * ## Why it plans rather than acts
   *
   * A reconcile is a provider call, so it goes through the same claim, the same
   * budget, the same lease and the same `call_started_at` stamp as a create. Planning
   * it is a row; doing it is the executor's job on a later tick. Nothing here dials
   * anything.
   *
   * The id is DERIVED from the unknown operation, so two replicas planning the same
   * reconcile converge on one row with no lookup — the property the whole module rests
   * on — and `provisioning_operations_tenant_operation_key` refuses the second.
   */
  private async planReconciles(scope: TenantContext, now: Date): Promise<void> {
    await this.deps.uow.run(scope, async (tx) => {
      const unresolved = await this.deps.operations.listUnknown(scope, RECONCILE_PLAN_LIMIT, tx);
      for (const unknown of unresolved) {
        /*
         * WP15 G4: which ROUND this is, from the count on the unknown row itself.
         *
         * `listUnknown` returns a row only while it has rounds left and no reconcile is
         * open, so reaching here with one round spent means that round ended FAILED —
         * every attempt in it failed to read the panel — and ONE more is allowed. The
         * round-1 id is the id every earlier release derived, so a row that was already
         * stuck behind a failed reconcile before this release converges: its old
         * reconcile is found, counted, and the next tick plans round 2.
         */
        const round = unknown.verificationAttempts + 1;
        const key = `${unknown.serviceId}:RECONCILE:${unknown.operationId}`;
        await this.deps.operations.plan(
          scope,
          {
            id: this.deps.ids.uuid(),
            operationId: this.deps.operationId(round === 1 ? key : `${key}:round${round}`),
            serviceId: unknown.serviceId,
            orderId: unknown.orderId,
            /* This installation asking a panel what it did. Nobody requested it. */
            requestedByCustomerId: null,
            panelId: unknown.panelId,
            type: 'RECONCILE',
            /*
             * WP15 G3: never asked the instant the create lost track. A panel that
             * accepted a create may not show it on the very next read, so the first
             * read waits one ordinary backoff and a second round waits the longest one
             * the attempt ladder uses.
             */
            notBefore: new Date(
              now.getTime() + (round === 1 ? BACKOFF_BASE_MS : backoffMs(OPERATION_MAX_ATTEMPTS)),
            ),
          },
          now,
          tx,
        );
        await this.deps.operations.countReconcileRound(
          scope,
          unknown.id,
          unknown.verificationAttempts,
          now,
          tx,
        );
      }
    });
  }

  /**
   * Resolves the operations a crash stranded after the provider call began.
   *
   * `releaseExpiredLeases` refuses these rows on purpose — releasing one would repeat a
   * mutation that may have taken effect — and its comment said they waited for "a person
   * or the reconciler". Neither had a path: the reconciler scans `UNKNOWN`,
   * `retireExhausted` scans `PLANNED`, and `retryProvisioning` returns the open
   * operation unchanged. So an installation that lost a worker mid-create left the
   * customer's paid order in `PENDING_PROVISION` for ever, silently.
   *
   * `UNKNOWN` is where such an operation belongs, and the service follows it to
   * `UNRECONCILED` — the same pair `persistFailure` writes when a create times out,
   * because it is the same fact: this installation does not know whether an account
   * exists, and the only way to find out is to look.
   *
   * ONE transaction for the operation, the service and the operator's condition, for
   * the reason `retireExhausted` now gives: a commit boundary between a terminal state
   * and the event that reports it is a way to strand an order in silence.
   */
  private async reapStrandedCalls(scope: TenantContext, now: Date): Promise<void> {
    await this.deps.uow.run(scope, async (tx) => {
      const stranded = await this.deps.operations.reapStrandedCalls(
        scope,
        now,
        LEASE_SWEEP_LIMIT,
        tx,
      );
      for (const operation of stranded) {
        if (!isMutatingOperation(operation.type)) continue;
        /*
         * A replayable mutation is not a stall, so it gets neither of the two things
         * below.
         *
         * The repository returned it to `PLANNED` rather than `UNKNOWN`, because sending
         * a suspend, a resume or a terminate again is sending it once — the property
         * `docs/providers/marzban.md` measured against the panel. Moving its service to
         * `UNRECONCILED` would announce that this installation does not know what exists
         * when it does, and would hand the service to a reconcile that has no question to
         * ask; opening `PROVISIONING_STALLED_CODE` would tell an operator to look into
         * something the next tick simply does. If the retries run out, `retireExhausted`
         * raises the condition then, which is when it is true.
         */
        if (isIdempotentMutation(operation.type)) continue;
        /*
         * The service moves only from `PENDING_PROVISION`.
         *
         * A conditional UPDATE naming its `from`, so a service that has since been
         * adopted, terminated or provisioned by another replica is left exactly where it
         * is. There is no `setState` here for the same reason ADR-0028 gives.
         */
        await this.deps.services.transition(
          scope,
          operation.serviceId,
          'PENDING_PROVISION',
          'UNRECONCILED',
          null,
          now,
          tx,
        );
        await this.deps.opsLog.record(
          scope,
          {
            code: PROVISIONING_STALLED_CODE,
            severity: 'ERROR',
            message: 'A provider call was cut off and this installation does not know its outcome.',
            context: {
              serviceId: operation.serviceId,
              panelId: operation.panelId,
              reason: 'CALL_STRANDED',
            },
            dedupeKey: provisioningConditionKey(operation.serviceId),
          },
          tx,
        );
      }
    });
  }

  /**
   * Fails operations whose attempts are spent, and tells an operator about each.
   *
   * Every path that spends the LAST attempt moves the row to a terminal state itself —
   * except a crash. A worker that died holding the last attempt leaves the row
   * `IN_FLIGHT`; the lease sweep returns it to `PLANNED`; and `claimDue` will never
   * select it again, because its predicate refuses a row at the ceiling. Before this
   * the row simply sat there: a paid order, uncompleted, with nothing that would ever
   * look at it again and no operational event to find it by.
   *
   * Runs before the claim rather than after, so the tick that discovers a stalled row
   * is the tick that reports it, and the report does not wait on there being other
   * work to do.
   */
  private async retireExhausted(scope: TenantContext, now: Date): Promise<void> {
    /*
     * ONE transaction for the retirement AND its report.
     *
     * They were two, and the gap between them was a way to lose a paid order in
     * silence. The first commit makes the rows terminal, which is exactly what stops
     * the next tick selecting them — this sweep looks for `PLANNED` at the ceiling. So
     * a process that exited between the two commits left an order stalled for ever with
     * the one operational event that would have found it never written. The condition
     * and the state it describes are the same fact, so they commit together or not
     * at all.
     */
    await this.deps.uow.run(scope, async (tx) => {
      const retired = await this.deps.operations.retireExhausted(scope, now, LEASE_SWEEP_LIMIT, tx);
      for (const operation of retired) {
        await this.deps.opsLog.record(
          scope,
          {
            code: PROVISIONING_STALLED_CODE,
            severity: 'ERROR',
            message: 'A paid service could not be created on its panel.',
            context: {
              serviceId: operation.serviceId,
              panelId: operation.panelId,
              reason: 'ATTEMPTS_SPENT',
            },
            dedupeKey: provisioningConditionKey(operation.serviceId),
          },
          tx,
        );
      }
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
    /*
     * How many creates this service has already been through.
     *
     * Read before the transaction because it bounds a DECISION rather than guarding a
     * write: the re-plan below is refused at the ceiling, and a count that is one stale
     * either way changes only which round is the last.
     */
    const history = await this.deps.operations.listForService(scope, serviceId, 50);
    const cycles = history.filter((candidate) => candidate.type === 'PROVISION').length;
    /*
     * WP15 G4: whether this is the LAST round. The lost create's own row counts the
     * rounds planned for it, so this is a read of durable state, not of this process.
     */
    const lastRound = history.some(
      (candidate) =>
        candidate.state === 'UNKNOWN' &&
        candidate.type === 'PROVISION' &&
        candidate.verificationAttempts >= RECONCILE_ROUNDS,
    );

    if (verdict.kind === 'UNDECIDED') {
      const retried = await this.persistFailure(
        scope,
        operation,
        service,
        'FAILED',
        verdict.failure,
        verdict.status,
        now,
        {
          ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
          reconcileExhausted: lastRound,
        },
      );
      return this.attempted(operation, serviceId, retried ? 'PLANNED' : 'FAILED', verdict.failure);
    }

    if (verdict.kind === 'ABSENT' && operation.absenceObservedAt === null) {
      /*
       * WP15 G3: ONE EARLY 404 AFTER AN ACCEPTED CREATE IS NOT ENOUGH TO RE-CREATE.
       *
       * A panel that accepted a create can answer the very next read with "no such user"
       * while the account propagates. Taken at its word, that absence re-planned the
       * create; the create met the account and answered 409; and the paid order went
       * round a create-409 loop or was refunded while the account sat on the panel.
       *
       * So the first absence is UNDECIDED: stamped on this reconcile, and the same
       * reconcile asked again one backoff later. Only the second absence is the
       * `providerUserProvablyAbsent` that makes a fresh create legal. If this attempt was
       * the last this reconcile has, the round ends undecided and the next round asks.
       */
      if (exhausted(operation.attempts)) {
        const retried = await this.persistFailure(
          scope,
          operation,
          service,
          'FAILED',
          'PROVIDER_ERROR',
          null,
          now,
          { reconcileExhausted: lastRound, note: 'the account was absent once; not yet twice' },
        );
        return this.attempted(operation, serviceId, retried ? 'PLANNED' : 'FAILED', null);
      }
      await this.deps.uow.run(scope, async (tx) => {
        await this.deps.operations.transition(
          scope,
          operation.id,
          'IN_FLIGHT',
          'PLANNED',
          {
            absenceObservedAt: now,
            failureMessage: 'the account was not visible; asking once more before any create',
            nextAttemptAt: new Date(now.getTime() + backoffMs(operation.attempts + 1)),
          },
          now,
          tx,
        );
      });
      return this.attempted(operation, serviceId, 'PLANNED', null);
    }

    if (
      verdict.kind === 'ADOPT' &&
      !(await this.deps.operations.hasCreateProvenance(scope, serviceId))
    ) {
      /*
       * WP15 G7: NO BLIND ADOPTION.
       *
       * The panel holds an account with this service's username, and nothing durable
       * says this installation made it: no create of this service was ever answered 2xx.
       * A 409, a duplicate email, a timeout and a pre-existing account all look exactly
       * like this to a lookup — adopting would hand a paying customer somebody else's
       * account, or bind this service to one an operator created by hand.
       *
       * So nothing moves: the service stays `UNRECONCILED`, the lost create stays
       * `UNKNOWN` (never refunded — it may be ours), its remaining rounds are spent
       * because another read cannot change the answer, and an operator is told.
       */
      await this.deps.uow.run(scope, async (tx) => {
        await this.deps.operations.transition(
          scope,
          operation.id,
          'IN_FLIGHT',
          'FAILED',
          {
            failureMessage: 'an account with this username exists and nothing shows it is ours',
            nextAttemptAt: null,
          },
          now,
          tx,
        );
        await this.deps.operations.exhaustReconcileRounds(
          scope,
          serviceId,
          RECONCILE_ROUNDS,
          now,
          tx,
        );
        await this.deps.opsLog.record(
          scope,
          {
            code: PROVISIONING_STALLED_CODE,
            severity: 'ERROR',
            message:
              'An account with this service’s username is on the panel and nothing shows this installation created it.',
            context: {
              serviceId,
              panelId: service.panelId,
              reason: 'FOUND_WITHOUT_PROVENANCE',
            },
            dedupeKey: provisioningConditionKey(serviceId),
          },
          tx,
        );
      });
      return this.attempted(operation, serviceId, 'FAILED', null);
    }

    const actor = this.actor();
    await this.deps.uow.run(scope, async (tx) => {
      // The service row first: the lock order a TERMINATE and a PROVISION stamp take, so
      // this transaction queues behind them instead of deadlocking with them.
      await this.deps.services.lockForUpdate(scope, serviceId, tx);
      await this.deps.operations.transition(
        scope,
        operation.id,
        'IN_FLIGHT',
        'SUCCEEDED',
        {},
        now,
        tx,
      );
      /*
       * The unknowns this read just answered, closed in the same transaction.
       *
       * `UNKNOWN` had no exit. `OPERATION_MACHINE` has declared `RECONCILE_SUCCEEDED`
       * and `RECONCILE_FAILED` out of it since it was written, both guarded by
       * `providerStateRead`, and nothing used either — so a reconcile resolved the
       * SERVICE and left the operation that lost track sitting in the queue.
       *
       * That is not tidiness. `listUnknown` is oldest-first and filtered on the service
       * being `UNRECONCILED`, which becomes true again the moment a SECOND create loses
       * track. The sweep then hands back the FIRST, already-reconciled operation;
       * `planReconciles` derives its reconcile id from that row, finds the terminal
       * reconcile that already ran, and plans nothing. The service sits `UNRECONCILED`
       * with no open work for ever, and `SERVICE_PROVISION_CYCLE_LIMIT` is never
       * reached because the cycle dies in round two — a paid order lost to a queue that
       * had been jammed by its own history.
       *
       * ABSENT means no create took effect, so each is `FAILED`. ADOPT means one of
       * them did and a read cannot say which, so each is `SUCCEEDED`: the state they
       * were trying to reach is the state the panel is in.
       */
      await this.deps.operations.resolveUnknownForService(
        scope,
        serviceId,
        verdict.kind === 'ADOPT' ? 'SUCCEEDED' : 'FAILED',
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
        if (cycles >= SERVICE_PROVISION_CYCLE_LIMIT) {
          /*
           * The cycle has gone round enough times to be a pattern, not an accident.
           *
           * Re-planning here is what makes the loop a loop: each round derives a new
           * operation id from the round before, so nothing ever collides and the
           * per-operation attempt ceiling never applies. A panel that fails every
           * create while answering every lookup "absent" would be dialled for ever.
           *
           * So the service is left `PENDING_PROVISION` with NOTHING claimable — no
           * open operation, and not in the reconcile queue, because that queue asks
           * for `UNRECONCILED` services. An operator gets the stalled condition and
           * `retryProvisioning` is the deliberate way back in.
           */
          await this.deps.opsLog.record(
            scope,
            {
              code: PROVISIONING_STALLED_CODE,
              severity: 'ERROR',
              message: 'A paid service could not be created on its panel.',
              context: {
                serviceId,
                panelId: service.panelId,
                reason: 'PROVISION_CYCLE_EXHAUSTED',
              },
              dedupeKey: provisioningConditionKey(serviceId),
            },
            tx,
          );
          /*
           * And the money goes back, because nothing else will move this order.
           *
           * The other two lanes refund from a terminal FAILED. This one has no such
           * row: the cycle deliberately leaves the service `PENDING_PROVISION` with
           * nothing claimable, which is what makes it a dead end rather than a loop.
           * A dead end that keeps the customer's money is the state this product
           * removed, so the create the reconcile just proved absent is settled here
           * as the definitive failure it is. `purchasedAs` says PROVISION because
           * that is what the customer bought; the operation in hand is a read.
           */
          await this.refundPurchase(
            scope,
            {
              orderId: operation.orderId,
              purchasedAs: 'PROVISION',
              // The row as this transaction has just left it, so the TERMINATE below
              // transitions from the state actually written rather than from the
              // `UNRECONCILED` it held on entry.
              service: { ...service, state: 'PENDING_PROVISION' },
              reason: 'PROVISION_CYCLE_EXHAUSTED',
              now,
            },
            tx,
          );
        } else {
          await this.deps.operations.plan(
            scope,
            {
              id: this.deps.ids.uuid(),
              operationId: this.deps.operationId(
                `${serviceId}:PROVISION:after:${operation.operationId}`,
              ),
              serviceId,
              orderId: operation.orderId,
              /* Re-planned by the reconcile that proved the account absent. */
              requestedByCustomerId: null,
              panelId: service.panelId,
              type: 'PROVISION',
            },
            now,
            tx,
          );
        }
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

    return this.attempted(operation, serviceId, 'SUCCEEDED', null);
  }

  /**
   * One service's usage, read back from its panel and written to the row.
   *
   * The narrowest operation this executor performs, and deliberately so: it is a READ,
   * `isMutatingOperation` says so, and `failureOutcome` therefore never produces
   * `UNKNOWN` for it. A sync that did not answer changed nothing by definition, so
   * there is nothing to reconcile and nothing that needs asking about — it is simply
   * `FAILED`, retried by the ordinary attempt machinery, and the figure on the row
   * stays the last one somebody actually read.
   *
   * ## Three things it must not do
   *
   * **It must not move the service.** `SERVICE_MACHINE` has no edge for a usage read
   * and this writes none. A panel that has lost the account answers `PROVIDER_ERROR`
   * through `readUsage`, which is a real divergence an operator has to see — but
   * "the panel does not have it" arriving on a READ is not the same evidence as a
   * reconcile's `providerUserProvablyAbsent`, which is a lookup made for exactly that
   * question from a service that is `UNRECONCILED`. Turning a failed usage read into a
   * state change would let a rate limit or a rewritten body move a working service.
   *
   * **It must not invent a figure.** `recordUsage` is only called on `ok`, and only
   * with what the panel returned. A sync that failed leaves `usage_synced_at` alone, so
   * the row keeps saying how stale it is rather than claiming a refresh that did not
   * happen — and the planner below, which orders by exactly that column, keeps the
   * service at the front of the queue instead of resetting its place.
   *
   * **It must not overwrite a service that moved underneath it.** `recordUsage` is a
   * conditional UPDATE naming `ACTIVE`, so a service suspended, expired or terminated
   * during the provider call keeps whatever that transition wrote. There is no
   * `setUsage`.
   */
  private async finishUsageSync(
    scope: TenantContext,
    operation: OperationRecord,
    service: ServiceRecord,
    adapter: ProviderAdapter,
    target: Parameters<ProviderAdapter['readUsage']>[0],
    http: Parameters<ProviderAdapter['readUsage']>[1],
    ref: Parameters<ProviderAdapter['readUsage']>[2],
  ): Promise<ExecutionResult> {
    const read = await usageSyncCall(adapter, target, http, ref);
    const now = this.deps.clock.now();
    const serviceId = service.id;

    if (!read.ok) {
      /*
       * `FAILED`, never `UNKNOWN`. `failureOutcome(kind, false)` would say the same;
       * it is passed explicitly here so that a future change to `isMutatingOperation`
       * cannot silently make a read reconcilable.
       */
      await this.persistFailure(
        scope,
        operation,
        service,
        'FAILED',
        read.failure,
        read.status,
        now,
      );
      return this.attempted(operation, serviceId, 'FAILED', read.failure);
    }

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
      await this.deps.services.recordUsage(
        scope,
        serviceId,
        { usedBytes: read.usage.usedBytes, syncedAt: now, lastSeen: read.usage.lastSeen },
        tx,
      );
    });

    /*
     * No audit record and no operational event.
     *
     * An audit row is a MUTATION record with a before and an after, and this changed
     * nothing an operator decided; `docs/conventions.md` keeps the two apart precisely
     * so an audit trail does not become the activity feed `/admin/logs` was. The
     * operation row itself carries who ran it, when, and what it found, and the
     * service row carries the figure — which is the whole of what happened.
     */
    return this.attempted(operation, serviceId, 'SUCCEEDED', null);
  }

  /**
   * Records what a SUSPEND or a RESUME did. One method, because the two differ only in
   * which edge of `SERVICE_MACHINE` they take.
   *
   * ## Why this does not go through `persistFailure`
   *
   * That helper writes `provisioning.stalled`, whose message is "A paid service could
   * not be created on its panel." — true for a create and false here — and whose
   * `PROVISION_LOST_TRACK` branch moves a service out of `PENDING_PROVISION`, a state
   * neither of these operations is ever attempted from. Reusing it would put a false
   * sentence into an operator's conditions log under a dedupe key that already means
   * something else.
   *
   * ## No operational event at all, and that is deliberate
   *
   * `provisioning.stalled` is specifically about a PAID service a customer is waiting
   * for, which is why it is ERROR and why it deduplicates per service. A suspend that
   * did not take is not that: nothing in this release plans one unattended — a customer
   * or an operator asked for it, in a surface, moments ago — so the person who needs to
   * know is looking at the operation, and the operation row carries the failure kind,
   * the status and the attempt count. Opening a condition here would fill the
   * operations log with the outcomes of actions somebody is already watching, which is
   * how `/admin/logs` became an activity feed.
   *
   * Adding a code later is cheap; splitting or renaming one is not (CLAUDE.md), so the
   * decision is to add none until something plans these unattended.
   */
  private async finishStateChange(
    scope: TenantContext,
    operation: OperationRecord,
    service: ServiceRecord,
    kind: 'SUSPEND' | 'RESUME',
    changed: ProviderStateChangeOutcome,
  ): Promise<ExecutionResult> {
    const now = this.deps.clock.now();
    const serviceId = service.id;
    const from = service.state;
    const to = MANAGEMENT_TARGET_STATE[kind];

    if (!changed.ok) {
      /*
       * `FAILED`, and `outcomeFor` is what says so — because `SUSPEND` and `RESUME` are
       * in `IDEMPOTENT_MUTATIONS`, so even a TIMEOUT is retried as the same call rather
       * than routed to a reconciliation that could not answer the question anyway
       * (`lookupUser` reports whether an account EXISTS, never what state it is in).
       *
       * The service is left exactly where it was. A suspend that did not certainly
       * happen must not move the service to SUSPENDED: the customer would be told their
       * service is paused while the panel keeps serving it.
       */
      const outcome = outcomeFor(changed.failure, operation.type);
      await this.recordManagementFailure(
        scope,
        operation,
        service,
        outcome,
        changed.failure,
        failureNote(changed.failure, changed.status),
        now,
      );
      return this.attempted(operation, serviceId, outcome, changed.failure);
    }

    if (!changed.found) {
      /*
       * The panel answered, authenticated, that it does not have this account.
       *
       * A divergence, not a failure to reach anything: Nexa believes this service has
       * an account on this panel and the panel says otherwise. The operation FAILS with
       * a message naming exactly that, and the SERVICE IS NOT MOVED — reporting a
       * suspend that suspended nothing would be the "fake external success" this
       * codebase refuses, and reporting a resume would tell a customer their service is
       * back when there is nothing to come back.
       *
       * No service state exists for this. `SERVICE_MACHINE` has no edge from `ACTIVE`
       * or `SUSPENDED` to `UNRECONCILED` — that state is reachable only from
       * `PENDING_PROVISION`, for a create whose answer was lost — and adding one is a
       * contract change this phase has no evidence to justify. So the divergence is
       * recorded where an operator reads it and the service keeps saying what it has
       * always said, which is the honest of the two options.
       */
      await this.recordManagementFailure(
        scope,
        operation,
        service,
        'FAILED',
        null,
        'the panel does not have this service’s account',
        now,
      );
      return this.attempted(operation, serviceId, 'FAILED', null);
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
      /*
       * The service moves only if it is still where the state check found it.
       *
       * A conditional UPDATE naming `from`, so a service that expired or was terminated
       * while this call was on the wire keeps whatever that transition wrote. The
       * operation still SUCCEEDED, because the panel really did apply the change and
       * saying otherwise would be a lie about an external effect.
       */
      const moved = await this.deps.services.transition(scope, serviceId, from, to, null, now, tx);
      if (!moved) return;
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: kind === 'SUSPEND' ? 'service.suspend' : 'service.resume',
          entityType: 'Service',
          entityId: serviceId,
          before: { state: from },
          after: { state: to },
          result: 'SUCCESS',
        },
        tx,
      );
      await this.deps.outbox.write(tx, actor, {
        eventType: 'ServiceStateChanged',
        aggregateType: 'Service',
        aggregateId: serviceId,
        payload: { customerId: service.customerId, from, to },
      });
    });

    return this.attempted(operation, serviceId, 'SUCCEEDED', null);
  }

  /**
   * Records what a ROTATE_SUBSCRIPTION did. `docs/rickpanel-rotate-audit.md` D4 and D5.
   *
   * ## A failure changes nothing on the service
   *
   * The adapter returns a failure only when the panel provably still serves the link
   * Nexa holds, or when it could not tell. Either way the stored link stays: replacing
   * it with anything not read from the panel would give the customer a link nobody
   * minted. `ROTATE_SUBSCRIPTION` is in `IDEMPOTENT_MUTATIONS`, so `outcomeFor`
   * answers `FAILED` and a retryable kind is tried again — which converges, because
   * the goal is "a link minted after the request", not "exactly one new token".
   *
   * ## A success stores the link and re-arms delivery, in one transaction
   *
   * `recordRotation` writes the new link, puts delivery back to a fresh `PENDING` and
   * clears any send in progress. The delivery writes are conditional on the link they
   * sent, so a send of the OLD link still in flight records nothing when it lands, and
   * the sweep sends the new one. The service must still have an account —
   * `ROTATION_STORE_STATES`, which includes `EXPIRED` because an expiry can commit while
   * the call is on the wire and a renewal would bring the stale link back. A service
   * terminated meanwhile keeps what the terminate wrote, and the operation still
   * SUCCEEDED, because the panel really did rotate.
   *
   * The audit row and the event carry no link. Both links are bearer capabilities, and
   * neither the audit log nor the outbox is a place for one.
   */
  private async finishRotation(
    scope: TenantContext,
    operation: OperationRecord,
    service: ServiceRecord,
    rotated: ProviderRotationOutcome,
  ): Promise<ExecutionResult> {
    const now = this.deps.clock.now();
    const serviceId = service.id;

    if (!rotated.ok) {
      const outcome = outcomeFor(rotated.failure, operation.type);
      await this.recordManagementFailure(
        scope,
        operation,
        service,
        outcome,
        rotated.failure,
        failureNote(rotated.failure, rotated.status),
        now,
      );
      return this.attempted(operation, serviceId, outcome, rotated.failure);
    }

    if (!rotated.found) {
      // The divergence `finishStateChange` describes: recorded, and the service untouched.
      await this.recordManagementFailure(
        scope,
        operation,
        service,
        'FAILED',
        null,
        'the panel does not have this service’s account',
        now,
      );
      return this.attempted(operation, serviceId, 'FAILED', null);
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
      const moved = await this.deps.services.recordRotation(
        scope,
        serviceId,
        rotated.subscriptionUrl,
        ROTATION_STORE_STATES,
        now,
        tx,
      );
      if (!moved) return;
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'service.rotate_subscription',
          entityType: 'Service',
          entityId: serviceId,
          // No state: it may have moved while the call was on the wire, and this row
          // records what the rotation changed, which is the delivery and nothing else.
          before: { deliveryState: service.deliveryState },
          after: { deliveryState: 'PENDING' },
          result: 'SUCCESS',
        },
        tx,
      );
      await this.deps.outbox.write(tx, actor, {
        eventType: 'ServiceSubscriptionRotated',
        aggregateType: 'Service',
        aggregateId: serviceId,
        payload: { customerId: service.customerId },
      });
    });

    return this.attempted(operation, serviceId, 'SUCCEEDED', null);
  }

  /**
   * Records what a RENEW, an ADD_TRAFFIC or an ADD_TIME did.
   *
   * One method for the three, because they differ in what they BOUGHT and not in what
   * they leave behind: the target says which fields moved, and the service picks up
   * exactly those.
   *
   * ## The service state
   *
   * `EXPIRED -> ACTIVE` is the only move any of them makes, and only a `RENEW` from an
   * `EXPIRED` service makes it — `SERVICE_MACHINE`'s own frozen edge, given a caller at
   * last. Everything else keeps the state it had: renewing an `ACTIVE` service buys it
   * more time and leaves it active, and `SERVICE_MACHINE` has no `ACTIVE -> ACTIVE`
   * edge to take.
   *
   * `SUSPENDED` never appears here at all. `OPERATION_LEGAL_FROM` excludes it for all
   * three, because the pinned Marzban leaves a `disabled` account disabled through both
   * an expiry and a data limit — so a renewal there would take a customer's money and
   * change nothing they could see.
   *
   * ## Why a failure leaves the service exactly where it was
   *
   * These three are in `IDEMPOTENT_MUTATIONS`, so `outcomeFor` answers `FAILED` even
   * for a TIMEOUT and the next attempt is the SAME call with the SAME stored target.
   * That is the whole reason the target is written once when the order settles: a
   * replay reproduces it, and a service that had its allowance raised by an attempt
   * whose answer was lost gets the same two numbers again rather than a second
   * increment.
   *
   * Nothing here writes an operational event, for the reason `finishStateChange` gives
   * at length: `provisioning.stalled` is about a paid service that could not be
   * CREATED, and nothing in this release plans a commercial action unattended — a
   * customer asked for it, in a surface, moments ago.
   */
  private async finishAllowance(
    scope: TenantContext,
    operation: OperationRecord,
    service: ServiceRecord,
    target: OperationTarget,
    changed: ProviderStateChangeOutcome,
  ): Promise<ExecutionResult> {
    const now = this.deps.clock.now();
    const serviceId = service.id;

    if (!changed.ok) {
      /*
       * WP15 G2: an AMBIGUOUS write is verified, never refunded on the spot.
       *
       * A timeout or a socket lost after sending, a 5xx, a 2xx whose record could not be
       * read or did not carry the target — each may mean the panel APPLIED the renewal.
       * Refunding then gives the customer their money and their thirty days. So the row
       * goes to `UNKNOWN` and a bounded number of READS compare the account with the
       * absolute target this operation persisted (`verifyOneAllowance`). The write is
       * never sent again by that path.
       *
       * Only a failure that says nothing reached the panel — unreachable, refused, rate
       * limited, the kinds `SAFE_TO_REPLAY_FAILURE_KINDS` names — keeps the ordinary
       * retry-then-refund path, because there the refund is for money that bought nothing.
       */
      if (!(SAFE_TO_REPLAY_FAILURE_KINDS as readonly string[]).includes(changed.failure)) {
        await this.deferToVerification(
          scope,
          operation,
          changed.failure,
          failureNote(changed.failure, changed.status, changed.detail),
          now,
        );
        return this.attempted(operation, serviceId, 'UNKNOWN', changed.failure);
      }
      const outcome = outcomeFor(changed.failure, operation.type);
      await this.recordManagementFailure(
        scope,
        operation,
        service,
        outcome,
        changed.failure,
        failureNote(changed.failure, changed.status, changed.detail),
        now,
      );
      return this.attempted(operation, serviceId, outcome, changed.failure);
    }

    if (!changed.found) {
      /*
       * The panel answered, authenticated, that it does not hold this account.
       *
       * The service keeps its old allowance, and it must: writing the target anyway
       * would tell a customer they had thirty more days on an account that does not
       * exist. The divergence is recorded on the operation, where an operator reads it.
       */
      await this.recordManagementFailure(
        scope,
        operation,
        service,
        'FAILED',
        null,
        'the panel does not have this service’s account',
        now,
      );
      return this.attempted(operation, serviceId, 'FAILED', null);
    }

    await this.recordAllowanceApplied(
      scope,
      operation,
      service,
      target,
      changed.usage,
      'IN_FLIGHT',
      now,
    );
    return this.attempted(operation, serviceId, 'SUCCEEDED', null);
  }

  /**
   * The allowance an operation made true, written to the service with its audit row.
   *
   * Shared by the write that was answered (`IN_FLIGHT`) and by the verification READ
   * that found the target already reached (`UNKNOWN`, WP15 G2): one account of "the
   * renewal took effect", whichever of the two established it.
   */
  private async recordAllowanceApplied(
    scope: TenantContext,
    operation: OperationRecord,
    service: ServiceRecord,
    target: OperationTarget,
    usage: ProviderUsage | null,
    fromOperationState: 'IN_FLIGHT' | 'UNKNOWN',
    now: Date,
  ): Promise<void> {
    const serviceId = service.id;
    const from = service.state;
    /*
     * `EXPIRED -> ACTIVE` for a renewal that revived one; otherwise stay put.
     *
     * Read off the machine rather than written as a literal, so an edge removed from
     * `SERVICE_MACHINE` fails here instead of silently activating a service the machine
     * no longer says may be activated.
     */
    const to =
      operation.type === 'RENEW' && from === 'EXPIRED'
        ? (nextState(SERVICE_MACHINE, 'EXPIRED', 'RENEW') ?? from)
        : from;

    const actor = this.actor();
    await this.deps.uow.run(scope, async (tx) => {
      const moved = await this.deps.operations.transition(
        scope,
        operation.id,
        fromOperationState,
        'SUCCEEDED',
        // The verification's lease date must not outlive the verdict.
        fromOperationState === 'UNKNOWN' ? { nextAttemptAt: null } : {},
        now,
        tx,
      );
      // A verification that lost its row to another reader records nothing twice. The
      // answered write keeps its old behaviour: the panel applied it either way.
      if (!moved && fromOperationState === 'UNKNOWN') return;
      /*
       * Conditional on the state the operation was planned from.
       *
       * A service terminated or expired while this call was on the wire keeps what that
       * transition wrote, and this returns false. The OPERATION still succeeded — the
       * panel really did apply the change — and saying otherwise would be a lie about
       * an external effect.
       */
      const applied = await this.deps.services.recordAllowance(
        scope,
        serviceId,
        from,
        to,
        target,
        now,
        tx,
      );
      if (!applied) return;

      /*
       * The usage the panel reported while it was answering, when it reported any.
       *
       * Marzban returns the whole user record from a modify, so a renewal refreshes the
       * consumption figure for free. Written only when the service is ACTIVE, which is
       * what `recordUsage` requires — and after `recordAllowance`, so a service the
       * renewal has just revived is already ACTIVE by the time this runs.
       */
      if (usage !== null && to === 'ACTIVE') {
        await this.deps.services.recordUsage(
          scope,
          serviceId,
          { usedBytes: usage.usedBytes, syncedAt: now, lastSeen: usage.lastSeen },
          tx,
        );
      }

      await this.deps.audit.record(
        scope,
        actor,
        {
          action: `service.${operation.type.toLowerCase()}`,
          entityType: 'Service',
          entityId: serviceId,
          before: {
            state: from,
            expiresAt: service.expiresAt?.toISOString() ?? null,
            trafficLimitBytes: service.trafficLimitBytes.toString(),
          },
          after: {
            state: to,
            /*
             * What was actually written, which is the old value where the target left a
             * field alone. An audit row saying `null` for a window this operation did
             * not buy would read as "the window was cleared".
             */
            expiresAt: (target.expiresAt ?? service.expiresAt)?.toISOString() ?? null,
            trafficLimitBytes: (target.trafficLimitBytes ?? service.trafficLimitBytes).toString(),
            orderId: operation.orderId,
          },
          result: 'SUCCESS',
        },
        tx,
      );

      /*
       * The event follows the STATE change, and there is only one that can happen here.
       *
       * A renewal that revived an expired service is a fact other parts of the system
       * care about; a renewal that added thirty days to a live one changes no state and
       * has no `ServiceStateChanged` to announce. Writing one with `from === to` would
       * put a transition into the outbox that `SERVICE_MACHINE` does not have.
       */
      if (to !== from) {
        await this.deps.outbox.write(tx, actor, {
          eventType: 'ServiceStateChanged',
          aggregateType: 'Service',
          aggregateId: serviceId,
          payload: { customerId: service.customerId, from, to },
        });
      }
    });
  }

  /**
   * An ambiguous commercial write, parked for verification (WP15 G2).
   *
   * `IN_FLIGHT -> UNKNOWN`, the first read one backoff away. No money moves and no
   * operator is paged yet: the reads are the next step, and only their running out is
   * news. `provisioning_operations_open_commercial_key` counts `UNKNOWN` as open, so no
   * second purchase can be priced from the allowance this write may already have changed.
   */
  private async deferToVerification(
    scope: TenantContext,
    operation: OperationRecord,
    failure: ProviderFailureKind,
    message: string,
    now: Date,
  ): Promise<void> {
    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.operations.transition(
        scope,
        operation.id,
        'IN_FLIGHT',
        'UNKNOWN',
        {
          failureKind: failure,
          failureMessage: message,
          nextAttemptAt: new Date(now.getTime() + BACKOFF_BASE_MS),
        },
        now,
        tx,
      );
    });
  }

  /**
   * ONE verification READ of an ambiguous commercial write, if one is due (WP15 G2).
   *
   * Bounded three ways: one row per tick, `ALLOWANCE_VERIFICATION_READS` reads per row,
   * on the ordinary backoff — no global scan and no tight loop. The claim bumps the row's
   * `next_attempt_at` to a lease, so two replicas never read one row twice and a crash
   * costs one lease, never the row.
   *
   * The READ is compared with the ABSOLUTE target the operation persisted:
   *
   * - reached or exceeded → `UNKNOWN -> SUCCEEDED`, the allowance recorded, no refund;
   * - the account answered and is below it, or is gone → definitive: `UNKNOWN -> FAILED`
   *   and the ordinary refund rule;
   * - no answer, or an incomplete one → read again later; after the last read the row
   *   stays `UNKNOWN`, nothing is refunded, and an operator is told.
   */
  private async verifyOneAllowance(scope: TenantContext, now: Date): Promise<void> {
    const leaseUntil = new Date(now.getTime() + this.deps.leaseMs);
    const operation = await this.deps.uow.run(scope, async (tx) =>
      // The tenant must still accept work, checked in the claim's own transaction.
      (await this.deps.scopeActivity.scopeIsActive(scope, tx))
        ? this.deps.operations.claimDueVerification(
            scope,
            now,
            leaseUntil,
            ALLOWANCE_VERIFICATION_READS,
            tx,
          )
        : null,
    );
    if (operation === null) return;
    /*
     * One verification must never abort the tick that claims the next paid operation.
     * A throw here is not evidence about the write, so it costs this read and nothing
     * else: the row comes back at its next date, or stops for an operator after the last.
     */
    try {
      await this.verifyClaimed(scope, operation, now);
    } catch {
      const lastRead = operation.verificationAttempts >= ALLOWANCE_VERIFICATION_READS;
      await this.rescheduleVerification(
        scope,
        operation,
        lastRead,
        'the verification read did not complete',
        now,
      );
    }
  }

  private async verifyClaimed(
    scope: TenantContext,
    operation: OperationRecord,
    now: Date,
  ): Promise<void> {
    const target = operation.target;
    /*
     * A row claimed past its last read is one whose last read never finished — a crash
     * between the claim and the answer. It is stopped here, with the operator condition
     * the finished read would have written, instead of vanishing from the queue.
     */
    if (operation.verificationAttempts > ALLOWANCE_VERIFICATION_READS) {
      return this.rescheduleVerification(
        scope,
        operation,
        true,
        'the last verification read did not finish',
        now,
      );
    }
    const service = await this.deps.services.findById(scope, operation.serviceId);
    const lastRead = operation.verificationAttempts >= ALLOWANCE_VERIFICATION_READS;
    const again = (note: string, release = false): Promise<void> =>
      this.rescheduleVerification(scope, operation, lastRead && !release, note, now, release);

    if (target === null || service === null) {
      return this.rescheduleVerification(scope, operation, true, 'nothing to verify against', now);
    }
    if (!VERIFIABLE_STATES.includes(service.state)) {
      // The account is gone from Nexa's side — terminated, or never delivered. What the
      // purchase is owed is no longer a comparison a read can make; a person decides.
      return this.rescheduleVerification(
        scope,
        operation,
        true,
        `the service is ${service.state}; an operator must decide`,
        now,
      );
    }

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
      type: 'RECONCILE',
      serviceAdapterExists:
        view !== null && this.deps.implementedProviderTypes.includes(view.panel.providerType),
    });
    if (!operable.ok) return again(`the panel cannot be read: ${operable.reason}`);
    if (!checkUrl(operable.baseUrl, this.deps.urlPolicy).allowed) {
      return again('the panel address is refused by policy');
    }
    const adapter = this.deps.adapters(operable.providerType as ProviderType);
    const stored = await this.deps.credentials.read(scope, operation.panelId);
    const credentials = toProviderCredentials(stored, adapter.descriptor.credentialShape);
    if (credentials === null) return again('CREDENTIALS_MISSING');
    const budget = await this.deps.uow.run(scope, async (tx) =>
      this.deps.panels.takeProbeBudget(scope, this.deps.probeBudget, now, tx, 0),
    );
    // Nothing was read, so the read is given back: a busy budget is not evidence.
    if (!budget.permitted) return again('the tenant outbound budget had no capacity', true);

    const found = await adapter.lookupUser(
      { baseUrl: operable.baseUrl, credentials, activation: operable.activation },
      this.deps.http.forBase(operable.baseUrl),
      providerRefFor(service),
    );
    const readAt = this.deps.clock.now();
    if (!found.ok) {
      return again(failureNote(found.failure, found.status, found.detail));
    }
    // A record without its figures is an incomplete answer, not a verdict (G5).
    if (found.found && found.usage === null) return again('the account answered without usage');
    if (found.found && allowanceReached(target, found.usage)) {
      await this.recordAllowanceApplied(
        scope,
        operation,
        service,
        target,
        found.usage,
        'UNKNOWN',
        readAt,
      );
      return;
    }
    // Definitive: the account is gone, or it answered and does not hold the target.
    await this.deps.uow.run(scope, async (tx) => {
      const moved = await this.deps.operations.transition(
        scope,
        operation.id,
        'UNKNOWN',
        'FAILED',
        {
          failureMessage: found.found
            ? 'verified: the panel does not hold what this operation asked for'
            : 'verified: the panel does not have this service’s account',
          // Cleared, or the announcer reads a FAILED row with a date as one still retrying
          // and the customer is never told.
          nextAttemptAt: null,
        },
        readAt,
        tx,
      );
      if (!moved) return;
      await this.refundPurchase(
        scope,
        {
          orderId: operation.orderId,
          purchasedAs: operation.type,
          service,
          reason: 'ALLOWANCE_NOT_APPLIED',
          now: readAt,
        },
        tx,
      );
    });
  }

  /** The next read of an ambiguous write, or none and an operator condition. */
  private async rescheduleVerification(
    scope: TenantContext,
    operation: OperationRecord,
    stop: boolean,
    note: string,
    now: Date,
    release = false,
  ): Promise<void> {
    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.operations.rescheduleVerification(
        scope,
        operation.id,
        stop ? null : new Date(now.getTime() + backoffMs(operation.verificationAttempts + 1)),
        note,
        now,
        tx,
        release,
      );
      if (!stop) return;
      await this.deps.opsLog.record(
        scope,
        {
          code: PROVISIONING_STALLED_CODE,
          severity: 'ERROR',
          message:
            'A paid renewal or add-on could not be confirmed on the panel; nothing was refunded and an operator must decide.',
          context: {
            serviceId: operation.serviceId,
            panelId: operation.panelId,
            reason: 'ALLOWANCE_UNVERIFIED',
            operationType: operation.type,
          },
          dedupeKey: provisioningConditionKey(operation.serviceId),
        },
        tx,
      );
    });
  }

  /**
   * Ends a service Nexa-side, with no DELETE, when nothing shows its account is ours.
   *
   * ## The rule (WP15 G1)
   *
   * A service in `PENDING_PROVISION` or `UNRECONCILED` has a username and may have no
   * account behind it — or an account somebody else made under the same name. A DELETE by
   * that name removes whatever holds it. So, under the service's row lock:
   *
   * - a create ON THE WIRE for this service (stamped, still `IN_FLIGHT`) → put back; the
   *   create's answer is what decides, and it is seconds away;
   * - durable evidence one of its creates was accepted (`hasCreateProvenance`) → null, and
   *   the ordinary DELETE path runs: the account is ours to remove;
   * - otherwise → the operation SUCCEEDS and the service is `TERMINATED` here, no provider
   *   contacted. The audit row says which of two cases it was: no create ever started, or
   *   one started and nothing proves what it did (its account, if any, is left for an
   *   operator — never deleted by name).
   *
   * The PROVISION side stamps its call under the SAME lock and only from
   * `PENDING_PROVISION`, so a create claimed a moment before this commits finds the
   * service `TERMINATED` and makes no call.
   *
   * `ACTIVE`, `SUSPENDED` and `EXPIRED` return null at once: a service reached them only
   * through a create that succeeded or an adoption that required provenance, which is
   * the durable binding a DELETE may act on.
   */
  private async terminateWithoutProvider(
    scope: TenantContext,
    operation: OperationRecord,
    service: ServiceRecord,
    now: Date,
  ): Promise<ExecutionResult | null> {
    if (service.state !== 'PENDING_PROVISION' && service.state !== 'UNRECONCILED') return null;
    const actor = this.actor();
    const decision = await this.deps.uow.run(scope, async (tx) => {
      const locked = await this.deps.services.lockForUpdate(scope, service.id, tx);
      if (locked === null) return 'PROVIDER' as const;
      if (locked.state !== 'PENDING_PROVISION' && locked.state !== 'UNRECONCILED') {
        // Moved while this was claimed — provisioned, say. The ordinary path decides.
        return 'PROVIDER' as const;
      }
      const history = await this.deps.operations.listForService(scope, service.id, 50, tx);
      const provisions = history.filter((candidate) => candidate.type === 'PROVISION');
      if (
        provisions.some(
          (candidate) => candidate.state === 'IN_FLIGHT' && candidate.callStartedAt !== null,
        )
      ) {
        return 'HOLD' as const;
      }
      if (await this.deps.operations.hasCreateProvenance(scope, service.id, tx)) {
        return 'PROVIDER' as const;
      }
      const createEverStarted = provisions.some((candidate) => candidate.callStartedAt !== null);
      const moved = await this.deps.operations.transition(
        scope,
        operation.id,
        'IN_FLIGHT',
        'SUCCEEDED',
        {},
        now,
        tx,
      );
      if (!moved) return 'LOST' as const;
      await this.deps.services.transition(
        scope,
        service.id,
        locked.state,
        'TERMINATED',
        null,
        now,
        tx,
      );
      /*
       * A lost create of this service is answered by the decision to end it: nothing will
       * ever read the panel for it again, so it leaves `UNKNOWN` for `ABANDONED` — the
       * state `OPERATION_MACHINE` keeps for what nothing else can resolve. Left `UNKNOWN`
       * it would hold the order "in delivery" for ever and refuse the operator's refund
       * (`DELIVERY_IN_PROGRESS`). No money moves here; the refund stays the operator's.
       */
      const abandoned = await this.deps.operations.resolveUnknownForService(
        scope,
        service.id,
        'ABANDONED',
        now,
        tx,
      );
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'service.terminate',
          entityType: 'Service',
          entityId: service.id,
          before: { state: locked.state },
          after: {
            state: 'TERMINATED',
            providerDelete: 'SKIPPED',
            reason: createEverStarted ? 'NO_PROVENANCE' : 'NEVER_CREATED',
            abandonedUnknownCreates: abandoned,
          },
          result: 'SUCCESS',
        },
        tx,
      );
      await this.deps.outbox.write(tx, actor, {
        eventType: 'ServiceStateChanged',
        aggregateType: 'Service',
        aggregateId: service.id,
        payload: { customerId: service.customerId, from: locked.state, to: 'TERMINATED' },
      });
      /*
       * No create ever left for the panel, so nothing can exist there: this terminate is
       * the transaction that discovers the order cannot be delivered, and CLAUDE.md's
       * first money rule says the refund is automatic and happens HERE, through the one
       * credit path. A create that was sent and never answered is different — UNKNOWN is
       * never refunded automatically; the operator who ended it refunds it, which the
       * lost create's ABANDONED state now allows.
       */
      if (!createEverStarted) {
        await this.refundPurchase(
          scope,
          {
            orderId: operation.orderId,
            purchasedAs: 'PROVISION',
            service: { ...service, state: 'TERMINATED' },
            reason: 'TERMINATED_BEFORE_PROVISION',
            now,
          },
          tx,
        );
      }
      return 'TERMINATED' as const;
    });
    switch (decision) {
      case 'PROVIDER':
        return null;
      case 'HOLD':
        await this.holdOff(
          scope,
          operation,
          new Date(now.getTime() + BACKOFF_BASE_MS),
          'a create for this service is on the wire; its answer decides what to terminate',
        );
        return this.refusedAndHeld(operation, 'PROVISION_IN_FLIGHT');
      case 'LOST':
        return this.refused(operation, 'LEASE_LOST');
      case 'TERMINATED':
        return this.attempted(operation, service.id, 'SUCCEEDED', null);
    }
  }

  /**
   * Records what a TERMINATE did.
   *
   * Separate from `finishStateChange` because its success is a different shape: there is
   * no `found`, the target state is `TERMINATED` from any of five, and an account the
   * panel does not have is a SUCCESS rather than a divergence.
   *
   * That last one is the whole reason `wasPresent` exists. A delete replayed after a
   * lost answer finds nothing the second time, and the goal — this account is not on
   * this panel — holds either way. Treating the 404 as a failure would strand every
   * terminate whose response went missing; treating it as `wasPresent: true` would let
   * the record imply the second call did the work.
   */
  private async finishTerminate(
    scope: TenantContext,
    operation: OperationRecord,
    service: ServiceRecord,
    removed: ProviderRemovalOutcome,
  ): Promise<ExecutionResult> {
    const now = this.deps.clock.now();
    const serviceId = service.id;
    const from = service.state;

    if (!removed.ok) {
      const outcome = outcomeFor(removed.failure, operation.type);
      await this.recordManagementFailure(
        scope,
        operation,
        service,
        outcome,
        removed.failure,
        failureNote(removed.failure, removed.status),
        now,
      );
      return this.attempted(operation, serviceId, outcome, removed.failure);
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
      const moved = await this.deps.services.transition(
        scope,
        serviceId,
        from,
        'TERMINATED',
        null,
        now,
        tx,
      );
      if (!moved) return;
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'service.terminate',
          entityType: 'Service',
          entityId: serviceId,
          before: { state: from },
          /*
           * `accountWasPresent` is recorded because the two cases are different facts
           * about the world and an audit row is where the difference belongs: `false`
           * says this installation ended a service whose provider account was already
           * gone, which an operator investigating a customer complaint needs to know.
           */
          after: { state: 'TERMINATED', accountWasPresent: removed.wasPresent },
          result: 'SUCCESS',
        },
        tx,
      );
      await this.deps.outbox.write(tx, actor, {
        eventType: 'ServiceStateChanged',
        aggregateType: 'Service',
        aggregateId: serviceId,
        payload: { customerId: service.customerId, from, to: 'TERMINATED' },
      });
    });

    return this.attempted(operation, serviceId, 'SUCCEEDED', null);
  }

  /**
   * The operation row for a management call that did not succeed, and nothing else.
   *
   * It shares `persistFailure`'s retry decision deliberately — both axes, the same way
   * round — and shares nothing else with it. `PROVIDER_FAILURE_RETRYABLE` answers
   * "would trying again plausibly help", which is a different question from the one
   * `outcomeFor` answered, and conflating them is what once made the provisioner log in
   * wrongly five times against a panel that locks accounts.
   *
   * `failure` is null for the one outcome that is not a provider failure at all — the
   * panel answering that it does not have the account. There is no
   * `ProviderFailureKind` for that and inventing one would put a fact about Nexa's
   * bookkeeping into a vocabulary that describes wires.
   */
  private async recordManagementFailure(
    scope: TenantContext,
    operation: OperationRecord,
    service: ServiceRecord,
    outcome: OperationState,
    failure: ProviderFailureKind | null,
    message: string,
    now: Date,
  ): Promise<void> {
    const retryable =
      outcome === 'FAILED' &&
      failure !== null &&
      PROVIDER_FAILURE_RETRYABLE[failure] &&
      !exhausted(operation.attempts);
    await this.deps.uow.run(scope, async (tx) => {
      await this.deps.operations.transition(
        scope,
        operation.id,
        'IN_FLIGHT',
        retryable ? 'PLANNED' : outcome,
        {
          ...(failure === null ? {} : { failureKind: failure }),
          failureMessage: message,
          nextAttemptAt: retryable ? new Date(now.getTime() + backoffMs(operation.attempts)) : null,
        },
        now,
        tx,
      );
      /*
       * Three of the five types that reach here are nobody's purchase — a `SUSPEND`,
       * a `RESUME` and a `TERMINATE` are operator or customer decisions about a
       * service that has already been paid for, and every one of them carries the
       * `order_id` of the purchase that created it. `PURCHASED_AS` is what stops that
       * id being read as "refund this": it refunds only when the failed operation is
       * the operation the order was BOUGHT as, which for this method means the three
       * commercial kinds and nothing else.
       *
       * `FAILED` and not `UNKNOWN`, for the reason `persistFailure` states at length.
       */
      if (!retryable && outcome === 'FAILED') {
        await this.refundPurchase(
          scope,
          {
            orderId: operation.orderId,
            purchasedAs: operation.type,
            service,
            reason: failure ?? message,
            now,
          },
          tx,
        );
      }
    });
  }

  /**
   * Moves services whose window has closed to `EXPIRED`. No provider is contacted.
   *
   * ## Why this is a Nexa-side transition and not an operation
   *
   * The panel already stopped serving the account: `expiryTime` was written into the
   * client at creation and 3X-UI enforces it, as Marzban enforces `expire`. Nothing
   * needs to be asked and nothing needs to be told. What was missing was Nexa AGREEING
   * — `services.expires_at` was written by the create and by the adopt path,
   * `services_expiry_idx` existed, and no code read either, so a service whose window
   * had closed stayed `ACTIVE` here for ever while the panel refused it. Two
   * authorities disagreeing is the shape `SERVICE_MACHINE`'s own comment about the
   * provider being "not the authority, and not ignored either" exists to prevent.
   *
   * So this is not a `SYNC_USAGE`-style operation with a claim, a lease and an
   * attempt counter. There is no external call to fail, nothing to be uncertain about,
   * and no budget to spend. It is one conditional UPDATE.
   *
   * ## What it must not do
   *
   * **It must not expire a service the panel might still be serving.** Only rows whose
   * own `expires_at` has passed, and `expires_at` is NULL for an unlimited plan — which
   * `provisionCall` writes as the panel's own unlimited rather than as an epoch.
   *
   * **It must not move a service that is not ACTIVE or SUSPENDED.** `SERVICE_MACHINE`
   * has `EXPIRE` from exactly those two. A `PENDING_PROVISION` service has no account
   * to have expired, and `TERMINATED` is terminal — a terminated service that could
   * come back would make "terminate" a word an operator could not rely on.
   *
   * **It must not run for a tenant that has stopped accepting work.** `runOnce` checks
   * that first, and this is a durable write inside `uow.run`, which is also where
   * ADR-0028's quiesce gate lives.
   */
  private async expireDue(scope: TenantContext, now: Date): Promise<void> {
    const actor = this.actor();
    await this.deps.uow.run(scope, async (tx) => {
      const expired = await this.deps.services.expireDue(
        scope,
        now,
        SERVICE_EXPIRY_SWEEP_LIMIT,
        tx,
      );
      for (const service of expired) {
        /*
         * An AUDIT record and no operational event.
         *
         * `docs/conventions.md` keeps the two apart: an audit row is a mutation with a
         * before and an after, which this is, and an operational event is a condition
         * an operator has to act on, which this is not. A service reaching the end of
         * the window somebody bought is the product working. Recording it as an
         * operator condition would fill the operations log with the ordinary passage
         * of time, which is how `/admin/logs` became an activity feed.
         */
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'service.expire',
            entityType: 'Service',
            entityId: service.id,
            before: { state: service.state, expiresAt: service.expiresAt?.toISOString() ?? null },
            after: { state: 'EXPIRED' },
            result: 'SUCCESS',
          },
          tx,
        );
      }
    });
  }

  /**
   * Plans a usage sync for the services whose figure has gone stale.
   *
   * Bounded by `USAGE_SYNC_PLAN_LIMIT` and ordered by how stale the figure is, for the
   * reason the panel monitor's discovery is bounded and ordered: a tenant with ten
   * thousand services must not turn one tick into ten thousand rows, and the next tick
   * has to pick up where this one stopped rather than starting again at the top.
   *
   * The operation id is DERIVED from the service and the window it belongs to, not
   * random. `plan` is `ON CONFLICT DO NOTHING` on `(tenant_id, operation_id)`, so two
   * replicas planning in the same window produce one row — two replicas is the normal
   * case on every rolling update — and a tick that runs twice inside one window does
   * not queue a second read of the same figure.
   */
  private async planUsageSyncs(scope: TenantContext, now: Date): Promise<void> {
    await this.deps.uow.run(scope, async (tx) => {
      const minutes = await this.deps.settings.valueOf<number>(
        scope,
        'provisioning.usage_sync_minutes',
        tx,
      );
      const staleBefore = new Date(now.getTime() - minutes * 60_000);
      /*
       * The window an operation id belongs to, as a whole number of cadences since the
       * epoch. Two ticks inside one window derive the SAME id and therefore plan once;
       * the next window derives a different one, so a sync that failed and was retired
       * is planned again rather than being suppressed for ever by its own history.
       */
      const window = Math.floor(now.getTime() / (minutes * 60_000));
      const stale = await this.deps.services.listUsageSyncDue(
        scope,
        staleBefore,
        USAGE_SYNC_PLAN_LIMIT,
        tx,
      );
      for (const candidate of stale) {
        await this.deps.operations.plan(
          scope,
          {
            id: this.deps.ids.uuid(),
            operationId: this.deps.operationId(`${candidate.id}:SYNC_USAGE:${String(window)}`),
            serviceId: candidate.id,
            orderId: candidate.orderId,
            /* Housekeeping: a figure read back on a schedule, asked for by nobody. */
            requestedByCustomerId: null,
            panelId: candidate.panelId,
            type: 'SYNC_USAGE',
          },
          now,
          tx,
        );
      }
    });
  }

  /**
   * The operation type each order purpose is bought as, and nothing else.
   *
   * Written out rather than inferred, because the question this answers decides
   * whether MONEY moves and getting it wrong in either direction is expensive. An
   * operation carries `order_id` whenever the service it acts on has one — a failed
   * `SUSPEND` on a two-year-old service names the order that bought it — so "this
   * operation has an order" is emphatically not "this operation is what that order
   * bought". Refunding on the first reading would give a customer their original
   * purchase price back because an operator's suspend button hit a 403.
   *
   * `SYNC_USAGE`, `RECONCILE`, `SUSPEND`, `RESUME` and `TERMINATE` are absent, which
   * is the whole content of this table: none of them is something a customer paid
   * for, so none of them failing is something to refund.
   */
  private static readonly PURCHASED_AS = PURCHASED_AS;

  /**
   * A paid operation has definitively failed, so the customer gets their money back.
   *
   * The second lane into `UndeliverableOrderRefunder`. The first is settlement
   * discovering it cannot deliver before it commits; this one is the provisioner
   * discovering it afterwards, once the panel has answered for the last time.
   *
   * ## Only on a DEFINITIVE failure, never on an unknown one
   *
   * Callers reach this from the branches that write a terminal `FAILED`, and never
   * from `UNKNOWN`. That separation is the load-bearing part: an `UNKNOWN` create may
   * have taken effect on the panel, so refunding it would give back money for an
   * account the customer is holding. `UNKNOWN` goes to `UNRECONCILED` and is resolved
   * by a READ first; whichever way that lands is a definitive answer, and a
   * `RECONCILE_FAILED` reaches here through the ordinary terminal path.
   *
   * ## What it changes, in order
   *
   * A `PROVISION` that never produced an account leaves a `PENDING_PROVISION`
   * service, and that row occupies a slot (`SERVICE_CAPACITY_STATES` counts every
   * non-terminal state). So it is TERMINATED first: the customer has no account, has
   * their money back, and the panel has its slot. A commercial operation touches no
   * service state at all — the service is alive and keeps exactly the allowance it
   * had, because the renewal that was not applied is the thing being refunded.
   *
   * Then `UndeliverableOrderRefunder` does the rest, in this same transaction.
   *
   * ## Why a missing payment declines rather than throws
   *
   * `settlementIsFunded` makes a settled order imply a confirmed payment, so null
   * here is a broken database — for every order except a trial, which reached `PAID`
   * through `GRANT` with nothing to pay and is handed on with no payment. Throwing would roll back the operation's own terminal
   * transition, leaving the row claimable and the same impossible state to be met
   * again on the next tick, for ever. Declining leaves the `provisioning.stalled`
   * ERROR the caller already recorded, which is the right place for an operator to
   * meet it.
   */
  private async refundPurchase(
    scope: TenantContext,
    input: {
      readonly orderId: OrderId | null;
      /**
       * The operation the order was BOUGHT as, named by the caller.
       *
       * Passed rather than read off the operation, because one caller is a
       * `RECONCILE` that has just proved the account absent for the last time: the
       * operation in hand is a read, and what failed is the create it was
       * reconciling. A method that inferred this from `operation.type` would decline
       * exactly the case that needs it, silently.
       */
      readonly purchasedAs: OperationType;
      readonly service: ServiceRecord;
      readonly reason: string;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<void> {
    const { orderId, purchasedAs, service, reason, now } = input;
    if (orderId === null) return;

    const order: OrderRecord | null = await this.deps.orders.findById(scope, orderId, tx);
    /*
     * `PAID` and nothing else. A refunded order is a replay and writes nothing twice;
     * an order in any other state did not pay for this operation.
     */
    if (order === null || order.state !== 'PAID') return;
    if (ProvisionerService.PURCHASED_AS[order.purpose] !== purchasedAs) return;

    /*
     * A trial has no payment and must not be asked for one: `isFreeTrial` is the
     * refunder's own test, and the refunder declines a null payment for anything else.
     * Every other order keeps the rule below.
     */
    const payment = isFreeTrial(order)
      ? null
      : await this.deps.payments.findConfirmedForOrder(scope, orderId, tx);
    if (payment === null && !isFreeTrial(order)) return;

    if (purchasedAs === 'PROVISION') {
      /*
       * Conditional on the state actually read, like every transition here. A service
       * that moved on between the claim and this — terminated by its customer, or
       * adopted by a reconcile — is not this transaction's to end, and `refund`
       * below is still conditional on the ORDER, so the money side stays correct.
       */
      await this.deps.services.transition(
        scope,
        service.id,
        service.state,
        'TERMINATED',
        null,
        now,
        tx,
      );
    }

    /*
     * And the stalled condition closes WITH the refund, because nothing else can ever
     * close it.
     *
     * Both callers open `provisioning.stalled:<serviceId>` before they get here — an
     * ERROR telling an operator a paid service could not be created. Its only two
     * recoveries are `PROVISIONING_DELIVERED_CODE` events: a service adopted on its
     * panel, or a service created on it. A service this method has just TERMINATED,
     * for an order it has just REFUNDED, can produce neither. So every definitive
     * failure left an open ERROR keyed on a dead service, unresolvable by fixing the
     * panel (the key is the service, not the panel) and unresolvable by retrying
     * (there is nothing left to retry) — an ever-growing operator queue, which is the
     * exact thing the two-outcome decision was made to delete. Found by Codex.
     *
     * Passed to the refunder rather than recorded here, so the recovery rides on the
     * ONE `order.refunded_undeliverable` row that already states this outcome. A
     * second row under the same code would be the same fact twice, and the refunder
     * writes nothing at all when another transaction moved the order first — which is
     * precisely when the condition must stay open.
     *
     * The panel problem itself is not lost: it has its own health condition with its
     * own recovery.
     */
    await this.deps.undeliverable.refund(
      scope,
      this.actor(),
      {
        order,
        from: 'PAID',
        payment,
        reason,
        now,
        recovers: {
          code: PROVISIONING_STALLED_CODE,
          dedupeKey: provisioningConditionKey(service.id),
        },
      },
      tx,
    );
  }

  /**
   * A refusal, carrying the four ids and the one bit somebody debugging a stuck
   * order actually needs.
   *
   * One helper rather than the same object literal at eleven return sites, and
   * that is the reason the fields were missing before: a literal repeated eleven
   * times gains a field in one of them. The production report for order
   * `01a0c54b` says the provisioner logs "contained no useful per-operation
   * failure entry" — they contained nothing at all for a refusal, because a
   * refusal returns a value and the value carried an id and a reason.
   *
   * `terminal` is what this tick actually DID to the row, and it is the one field
   * a helper must not compute for itself. Codex C3 on PR #58: recomputing it from
   * the reason and the claimed attempt count was wrong in both directions.
   *
   *   - `SERVICE_ABSENT` is classified retryable, and both of its paths transition
   *     the row to `ABANDONED` first. The line said "will retry" about a row that
   *     can never run again.
   *   - `holdOff` refunds the attempt the claim counted, and `operation.attempts`
   *     was read BEFORE that. A hold-off at the ceiling said "terminal" about a
   *     row whose next tick will pick it up.
   *
   * Both are reachable — a tenant stopped mid-tick, an exhausted outbound budget,
   * a service that left a legal state between the plan and the claim — and both
   * hand an operator the opposite of the truth in the one field they are reading
   * the line for. So the three shapes are named and each caller says which it is:
   * `refusedAbandoned` for a row just made terminal, `refusedAndHeld` for one whose
   * attempt was given back, and this for the ordinary accounted refusal where the
   * classification IS the answer.
   *
   * Every field is an id or an enum. Nothing here can carry a credential, a
   * subscription URL or a provider's response body.
   */
  private refused(operation: OperationRecord, reason: ExecutionRefusal): ExecutionResult {
    return this.refusal(
      operation,
      reason,
      refusalIsPermanent(reason) || exhausted(operation.attempts),
    );
  }

  /**
   * A refusal whose row this tick transitioned to `ABANDONED`.
   *
   * Terminal regardless of how the reason is classified, because the row is: the
   * state exists for situations nothing else can resolve, and no later tick will
   * claim it. `SERVICE_ABSENT` is the only reason that reaches here today and it
   * is in `RETRYABLE_REFUSALS`, which is exactly the disagreement this separates.
   */
  private refusedAbandoned(operation: OperationRecord, reason: ExecutionRefusal): ExecutionResult {
    return this.refusal(operation, reason, true);
  }

  /**
   * A refusal whose attempt `holdOff` gave back.
   *
   * Never terminal, and that is not a judgement about the reason — it is what the
   * UPDATE did. `holdOff` sets `attempts = GREATEST(attempts - 1, 0)` and a
   * `retry_at`, so the row is queued for a later tick with its count restored.
   * These refusals are about US rather than the panel — a stopped tenant, an
   * exhausted outbound budget — and are deliberately not charged as failures.
   */
  private refusedAndHeld(operation: OperationRecord, reason: ExecutionRefusal): ExecutionResult {
    return this.refusal(operation, reason, false);
  }

  /** The shared shape. `terminal` is always supplied by a caller that knows. */
  private refusal(
    operation: OperationRecord,
    reason: ExecutionRefusal,
    terminal: boolean,
  ): ExecutionResult {
    return {
      kind: 'REFUSED',
      operationId: operation.id,
      reason,
      serviceId: operation.serviceId,
      orderId: operation.orderId,
      panelId: operation.panelId,
      attempt: operation.attempts,
      terminal,
    };
  }

  /** An attempt that reached a provider, with the same context attached. */
  private attempted(
    operation: OperationRecord,
    serviceId: string,
    outcome: OperationState,
    failureKind: ProviderFailureKind | null,
  ): ExecutionResult {
    return {
      kind: 'ATTEMPTED',
      operationId: operation.id,
      serviceId,
      outcome,
      failureKind,
      orderId: operation.orderId,
      panelId: operation.panelId,
      attempt: operation.attempts,
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
        /*
         * Nothing was contacted, so nothing can be uncertain: a permanent refusal is
         * as definitive as an answer from the panel, and the customer's money goes
         * back. The condition above stays open — it names the panel an operator has
         * to fix so the next purchase does not land here too.
         */
        await this.refundPurchase(
          scope,
          { orderId: operation.orderId, purchasedAs: operation.type, service, reason, now },
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
    extras: {
      /** The adapter's closed-vocabulary case, recorded with the failure (G5, G6). */
      readonly detail?: ProviderFailureDetail;
      /** The panel answered THIS create 2xx: durable provenance (G7). PROVISION only. */
      readonly accepted?: boolean;
      /** A RECONCILE's last round is ending, so an operator must now decide (G4). */
      readonly reconcileExhausted?: boolean;
      /** What to record instead of the failure kind, where the kind is not the story. */
      readonly note?: string;
    } = {},
  ): Promise<boolean> {
    /*
     * `UNKNOWN` is never retried as the same mutation.
     *
     * A `FAILED` with attempts left goes back to PLANNED with a backoff; one without
     * becomes terminal. An `UNKNOWN` does neither — it waits for a READ, and the
     * service moves to `UNRECONCILED` so nothing can issue a second create.
     *
     * ## Two different questions, and this needs BOTH answers
     *
     * `outcome` comes from `failureOutcome`, which answers "did the request certainly
     * not take effect". That is a fact about the wire and it is what decides `FAILED`
     * versus `UNKNOWN`. It is NOT the question "would trying again plausibly help",
     * which `PROVIDER_FAILURE_RETRYABLE` answers and which this used to ignore.
     *
     * Conflating them re-planned every definitive failure until the ceiling, including
     * the two the contract marks non-retryable with the reason written beside them:
     * `AUTHENTICATION_FAILED` and `AUTHENTICATION_REQUIRES_INTERACTION` — "retrying
     * cannot conjure a second factor, and each attempt counts against the panel's own
     * login limiter". So a mistyped panel password made the provisioner log in wrongly
     * five times on a 30/60/120-second backoff, unattended, and a 3X-UI panel that locks
     * an account after repeated failures would have locked the operator out of their own
     * panel while trying to fulfil an order.
     *
     * The monitor lane has always consulted this table. Provisioning was the one lane
     * that did not, which is why the wrong behaviour looked normal.
     *
     * A non-retryable failure therefore becomes terminal `FAILED` immediately, with the
     * operator condition `persistFailure` already records. That is the same end state a
     * spent attempt count produces, reached without spending four more attempts on a
     * password that will not change by itself.
     */
    /*
     * A RECONCILE is a READ, and a read that came back incomplete — a record without its
     * usage figure, a value that is not a number — changed nothing and may read whole
     * next time (WP15 G5). So for a reconcile `MALFORMED_RESPONSE` is retried within the
     * same ceiling; for a write it stays terminal, because there it can mean "applied".
     */
    const retryableKind =
      PROVIDER_FAILURE_RETRYABLE[failure] ||
      (operation.type === 'RECONCILE' && failure === 'MALFORMED_RESPONSE');
    const retryable = outcome === 'FAILED' && retryableKind && !exhausted(operation.attempts);
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
          failureMessage: extras.note ?? failureNote(failure, status, extras.detail),
          nextAttemptAt: retryable ? new Date(now.getTime() + backoffMs(operation.attempts)) : null,
          ...(extras.accepted === true && operation.type === 'PROVISION'
            ? { createAcceptedAt: now }
            : {}),
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

      /*
       * A reconcile round that ends undecided is not news while another round is due:
       * the service's `UNRECONCILED` condition is already open and says what matters.
       * The LAST round ending is, and it says so in its own words (WP15 G4).
       */
      const roundEnding = operation.type === 'RECONCILE' && extras.reconcileExhausted !== true;
      if (!retryable && !roundEnding) {
        const reconcileSpent = operation.type === 'RECONCILE';
        await this.deps.opsLog.record(
          scope,
          {
            code: PROVISIONING_STALLED_CODE,
            severity: 'ERROR',
            message: reconcileSpent
              ? 'This installation could not learn from the panel whether a paid service was created; an operator must decide.'
              : 'A paid service could not be created on its panel.',
            context: {
              serviceId,
              panelId: service.panelId,
              reason: reconcileSpent
                ? 'RECONCILE_EXHAUSTED'
                : outcome === 'UNKNOWN'
                  ? 'UNRECONCILED'
                  : 'EXHAUSTED',
              failureKind: failure,
              ...(extras.detail === undefined ? {} : { detail: extras.detail }),
            },
            dedupeKey: provisioningConditionKey(serviceId),
          },
          tx,
        );
        /*
         * `FAILED` and not `UNKNOWN`, and the two are never folded together here.
         *
         * A definitive failure changed nothing on the panel, so the customer has no
         * account and is owed their money. An `UNKNOWN` create may have taken
         * effect — that is the whole reason the service went to `UNRECONCILED` two
         * statements up — and refunding it would give money back for an account the
         * customer is holding. The reconcile answers first; whichever way it lands
         * comes back through this same branch with a definitive outcome.
         */
        if (outcome === 'FAILED') {
          await this.refundPurchase(
            scope,
            {
              orderId: operation.orderId,
              purchasedAs: operation.type,
              service,
              reason: failure,
              now,
            },
            tx,
          );
        }
      }
    });
    return retryable;
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
