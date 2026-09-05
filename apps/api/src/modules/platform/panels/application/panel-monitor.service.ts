import {
  systemJobActor,
  isNexaError,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type Logger,
  type MonitorDeferralReason,
  type OperationalEventInput,
  type OperationalEventRecorder,
  type PanelHealthState,
  type ProviderFailureKind,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import { newCorrelationId } from '../../../../infrastructure/logging/logger.js';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../access/application/authorized-mutation.js';
import type { SessionRepository } from '../../identity/application/ports.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  attemptProbe,
  configurationOf,
  persistProbeResult,
  type ProbeCoreDeps,
} from './probe-core.js';
import {
  deferralIntervalMs,
  effectivePreviousFailures,
  scheduleAfterProbe,
} from '../domain/monitor-cadence.js';
import type { DuePanel, PanelHealthRecord, PanelMonitorRepository, PanelView } from './ports.js';

/**
 * The permission the monitor acts under.
 *
 * `maintenance.run` is what `SYSTEM_JOB_PERMISSIONS` grants, and it is checked
 * through the guard like anybody else's. Deliberately NOT `panels.edit`: that
 * is an operator's permission, and the way to make a job pass an operator's
 * check is to fabricate an operator — a `WEB_ADMIN` actor with no
 * administrator behind it, which is the "fake actor" this codebase refuses. A
 * job is a job, it holds a job's permission, and narrowing what a job may do
 * later stops this loop rather than being quietly bypassed by it.
 */
const MAINTENANCE_RUN = 'maintenance.run' as const;

/**
 * The stable job identity every background probe acts as.
 *
 * Stable across ticks, restarts and replicas, so an operator reading the audit
 * log sees one actor doing this work rather than a new one per process. The
 * correlation id is per tick, which is the part that should vary: it is what
 * ties one sweep's rows together.
 */
export const PANEL_MONITOR_JOB_ID = 'panel-health-monitor';

export interface PanelMonitorDeps {
  readonly discovery: PanelMonitorRepository;
  readonly probe: ProbeCoreDeps;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  /** Panels considered in one tick, across all tenants. */
  readonly batchSize: number;
  /**
   * Tenants given a turn in one tick.
   *
   * The fairness dial. With `d` tenants due and `t` claimed per tick, no tenant
   * waits longer than `ceil(d / t)` ticks — a bound that holds however deep any
   * one tenant's backlog is, which is exactly what a global "oldest first"
   * ordering cannot offer.
   */
  readonly tenantsPerTick: number;
  /** Probes in flight at once. Bounds outbound sockets and pool checkouts. */
  readonly concurrency: number;
  /**
   * Tokens of each tenant's probe budget the monitor must leave behind.
   *
   * Absolute, computed once from the configured percentage and the bucket's
   * capacity, so the reserve is the same number in every process.
   */
  readonly budgetReserve: number;
}

export interface MonitorTickResult {
  readonly tenants: number;
  readonly considered: number;
  readonly probed: number;
  readonly deferred: number;
  readonly failed: number;
}

const EMPTY_TICK: MonitorTickResult = {
  tenants: 0,
  considered: 0,
  probed: 0,
  deferred: 0,
  failed: 0,
};

/**
 * Probing panels on a schedule, in the `monitor` process.
 *
 * Four properties are worth stating before the code, because each is a decision
 * a simpler loop gets wrong in a way that looks fine in testing.
 *
 * **Authorization comes before any side effect.** The job's permission is
 * checked before a credential is decrypted, before a claim or a budget token is
 * spent, and before a socket is opened. A permission checked after the network
 * call is not authorization, it is a log entry — and the earlier version of this
 * file checked it in the transaction that STORED the result, by which time the
 * operator's panel had already been dialled with their password.
 *
 * **It probes ACTIVE panels only.** `DISABLED` is the operator saying stop using
 * this for now and `ARCHIVED` means finished. The rule is enforced in the
 * schedule — a panel that is not ACTIVE is eligible at `'infinity'`, written in
 * the same transaction as the status change — and again in the probe core
 * against the row it just read, so a panel disabled between the two is refused.
 *
 * **It never decides for itself whether a probe may happen.** The per-panel
 * claim, the tenant budget and the tenant rotation are conditional writes in
 * PostgreSQL. Two monitor replicas do not coordinate; they both ask, and the
 * database grants one. There is no process-local set of in-flight panels,
 * because a process-local anything is wrong the moment there are two processes
 * — and there being two, briefly, is what a rolling update is.
 *
 * **A refusal still moves the schedule.** A panel with no credential produces no
 * probe and no health, but it must not be rediscovered every thirty seconds for
 * ever: it would spend its tenant's fairness slot to learn nothing, and starve
 * the panels a probe could actually help. Every refusal defers, and every
 * operator fix un-defers.
 */
export class PanelMonitorService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  /**
   * When the loop last made real progress, and null until it has made any.
   *
   * "Progress" is deliberately not "a tick finished". A bounded batch of slow
   * providers can legitimately outlast several intervals, and a monitor working
   * through it is not a broken one — so the timestamp moves when discovery
   * succeeds AND every time a panel in the batch is finished with. What it does
   * NOT do is move because the process is alive, or because the database
   * answered `SELECT 1`, or because the loop started recently.
   *
   * Null until the first successful discovery is the load-bearing half: an
   * installation whose discovery query always throws must never report ready,
   * and a startup grace would report exactly that for its first few minutes.
   */
  private lastProgressAt: number | null = null;

  constructor(
    private readonly deps: PanelMonitorDeps,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.stopping = false;
    // The first tick runs immediately rather than one interval later. A monitor
    // that restarts more often than its interval — a crash loop, a day of
    // deploys — would otherwise never probe anything at all.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // A draining monitor is not a live one. `main.monitor.ts` stops the
    // heartbeat first for the same reason.
    this.lastProgressAt = null;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Let an in-flight tick finish. Its probes have already spent claims and
    // budget; abandoning them would leave results unwritten and panels claimed.
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /**
   * Whether the loop has made progress recently enough to call it alive.
   *
   * The heartbeat's second question, after "is the database reachable", and the
   * one that distinguishes a monitor from a process. Four states have to come
   * out differently:
   *
   *   - discovery always throws — never any progress, never healthy, and
   *     readiness never passes. There is no grace: a monitor that has never
   *     succeeded has never done its job, and a release that ships one must not
   *     be accepted.
   *   - nothing is due — discovery SUCCEEDED, which is progress. Healthy.
   *   - a bounded batch of slow panels is still running — each finished panel
   *     is progress, so a sweep that outlasts several intervals stays healthy
   *     while it is actually getting somewhere.
   *   - the loop stops getting anywhere — no progress, and the heartbeat goes
   *     stale within three intervals.
   */
  iterationIsFresh(now: number): boolean {
    if (this.lastProgressAt === null) return false;
    return now - this.lastProgressAt <= this.intervalMs * 3;
  }

  /**
   * Records that the loop got somewhere. See `lastProgressAt`.
   *
   * Silent once `stop()` has been called. A draining monitor is not a live one,
   * and the probes already in flight when SIGTERM arrives each finish and each
   * used to write a fresh mark — so `stop()` nulled the field and then waited
   * for the very ticks that put it back. The property held only because
   * `main.monitor.ts` happens to stop the heartbeat first, which is an ordering
   * in another file standing in for the rule this one states.
   */
  private noteProgress(): void {
    if (this.stopping) return;
    this.lastProgressAt = this.deps.clock.now().getTime();
  }

  /** One pass. Exposed so a test can run it without waiting for the timer. */
  async tick(): Promise<MonitorTickResult> {
    // Overlapping ticks would re-claim the same tenants and contend for the
    // same panels. A tick that is still running IS the current pass.
    if (this.running) return EMPTY_TICK;
    this.running = true;
    try {
      return await this.sweep();
    } catch (error) {
      // Discovery itself failed — the database is unreachable, or the query is
      // wrong. NO progress is recorded, so the heartbeat goes stale and the
      // container is reported unhealthy rather than quietly monitoring nothing.
      this.deps.logger.error({ err: error }, 'panel monitor tick failed');
      return EMPTY_TICK;
    } finally {
      this.running = false;
    }
  }

  private async sweep(): Promise<MonitorTickResult> {
    const now = this.deps.clock.now();

    // Phase one: take a turn for the least-recently-served due tenants. One
    // bounded statement over a table with one row per tenant.
    const tenantIds = await this.deps.discovery.claimTenants(now, this.deps.tenantsPerTick);
    if (tenantIds.length === 0) {
      // Discovery SUCCEEDED with nothing to do. That is progress: an
      // installation with no due panels is a working installation, and a
      // monitor that reported itself dead for being idle would fail every
      // release.
      this.noteProgress();
      return EMPTY_TICK;
    }

    // The per-tenant share is computed from how many tenants were ACTUALLY
    // claimed, which is what lets one dial serve both shapes: a single-tenant
    // installation gets the whole batch, and a fifty-tenant one gets fairness.
    const perTenant = Math.max(1, Math.ceil(this.deps.batchSize / tenantIds.length));

    // Phase two: one bounded index range scan per claimed tenant.
    const due = await this.deps.discovery.dueForTenants(
      tenantIds,
      now,
      perTenant,
      this.deps.batchSize,
    );

    // Discovery has now fully succeeded. That is progress ONLY when it found
    // nothing to do; otherwise the progress has to come from the work itself.
    //
    // Two ways this used to lie. The mark was set the moment tenants were
    // claimed, so a monitor whose every DUE SCAN threw reported itself healthy
    // for ever — and `dueForTenants` is the fragile one, hand-written SQL whose
    // plan depends on an index and which grows with the schedule. And a sweep
    // that discovered work and then failed every single candidate was still
    // "fresh", because discovering the work counted as doing it. A monitor that
    // finds a hundred due panels and cannot probe any of them is not healthy.
    if (due.length === 0) {
      this.noteProgress();
      return { ...EMPTY_TICK, tenants: tenantIds.length };
    }

    const correlationId = newCorrelationId(this.deps.ids.uuid());
    const actor = systemJobActor(PANEL_MONITOR_JOB_ID, correlationId);

    let probed = 0;
    let deferred = 0;
    let failed = 0;

    // A fixed pool of workers pulling from a shared cursor, NOT
    // `Promise.all(due.map(...))`. The candidate set is bounded by the batch
    // size, but the batch size is a knob and an unbounded fan-out over it would
    // open one socket and take one pool connection per panel — a configuration
    // change away from exhausting both.
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.stopping) return;
        const index = next;
        next += 1;
        const candidate = due[index];
        if (candidate === undefined) return;
        try {
          const outcome = await this.probeOne(candidate, actor);
          if (outcome === 'PROBED') probed += 1;
          else deferred += 1;
          // Finishing with a panel is progress. It is what keeps a long sweep
          // of slow providers healthy while it is still getting somewhere, and
          // what lets a sweep that WEDGES go stale.
          this.noteProgress();
        } catch (error) {
          // One panel's failure is one panel's failure. An unreachable panel, a
          // provider that returns nonsense, a conflict because somebody edited
          // the panel mid-probe — none of them may stop the sweep, or a single
          // broken panel would stop every other panel being monitored.
          //
          // But it is NOT progress, and the schedule has to move anyway.
          //
          // A candidate that throws before `defer` or `persist` — a credential
          // whose envelope is malformed, or one sealed under a key the
          // installation no longer has — leaves its row due. It is then the
          // earliest due row on the next tick, and the one after that. With a
          // per-tenant share of one it takes the tenant's only slot for ever
          // and no other panel of that tenant is monitored again; and while it
          // did that, counting it as progress kept the container healthy, so
          // nothing anywhere said the monitor had stopped working.
          failed += 1;
          this.deps.logger.error(
            { err: error, panelId: candidate.panelId, tenantId: candidate.tenantId },
            'panel monitor probe failed',
          );
          await this.deferInternalError(candidate);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.deps.concurrency, due.length) }, () => worker()),
    );

    this.deps.logger.debug(
      { tenants: tenantIds.length, considered: due.length, probed, deferred, failed },
      'panel monitor tick complete',
    );
    return { tenants: tenantIds.length, considered: due.length, probed, deferred, failed };
  }

  private async probeOne(candidate: DuePanel, actor: ActorContext): Promise<'PROBED' | 'DEFERRED'> {
    // The panel's OWN tenant, taken from the discovery row. This is the point at
    // which cross-tenant work stops: discovery returned a tenant id and a panel
    // id, and from here everything runs inside that tenant's scope through the
    // ordinary tenant-filtered repository. No `SystemContext` reaches the panel
    // service, so there is no path by which a bug here reads another tenant.
    const tenant: TenantContext = {
      tenantId: candidate.tenantId as TenantContext['tenantId'],
      botInstanceId: null,
    };

    // --- Authorization, BEFORE anything with a side effect ------------------
    //
    // Not a formality and not in the wrong place by a few lines. Everything
    // below this call decrypts a credential, spends a claim, spends a tenant's
    // outbound budget and dials somebody else's machine. A permission checked
    // after any of that has not prevented anything.
    //
    // The denial is recorded through the same helper the transactional path
    // uses, so a refused job leaves the same audit trail as a refused operator.
    if (!(await this.authorize(tenant, actor, candidate.panelId))) {
      await this.defer(tenant, candidate.panelId, 'NOT_AUTHORIZED');
      return 'DEFERRED';
    }

    const before = await this.deps.probe.repository.find(tenant, candidate.panelId);
    // Deleted between discovery and now. Nothing to do and nothing to defer —
    // there is no row to defer.
    if (before === null) return 'DEFERRED';

    const attempt = await attemptProbe(this.deps.probe, tenant, before, {
      // ACTIVE only. Non-negotiable, and enforced here as well as in the
      // schedule the query reads.
      probeableStatuses: ['ACTIVE'],
      budgetReserve: this.deps.budgetReserve,
    });

    if (!attempt.probed) {
      // A refusal is a scheduling fact, never a health fact. Nothing about the
      // provider was learned, so nothing about the provider is written — and
      // the panel steps back so it does not occupy its tenant's slot on every
      // tick for ever.
      const reason = deferralReasonOf(attempt.refusal.kind);
      await this.defer(tenant, candidate.panelId, reason, configurationOf(before));
      this.deps.logger.debug(
        { panelId: candidate.panelId, reason },
        'panel monitor deferred a panel without probing it',
      );
      return 'DEFERRED';
    }

    await this.persist(tenant, actor, candidate, before, attempt.configuration, attempt.health);
    return 'PROBED';
  }

  /**
   * The job's permission, checked on its own before any side effect.
   *
   * Runs in its own short transaction because that is where `PermissionGuard`
   * expects to be, and returns a boolean rather than throwing: a tenant this
   * job may not act for is an ordinary answer for a loop that walks every
   * tenant, not an exception that should abort the sweep.
   */
  private async authorize(
    tenant: TenantContext,
    actor: ActorContext,
    panelId: string,
  ): Promise<boolean> {
    const denial = {
      action: 'panel.monitor.probe',
      entityType: 'Panel',
      entityId: panelId,
    };
    try {
      await this.deps.uow.run(tenant, (tx) =>
        this.deps.guard.check(tenant, actor, MAINTENANCE_RUN, tx),
      );
      return true;
    } catch (error) {
      if (isNexaError(error) && error.kind === 'PERMISSION_DENIED') {
        // The same trail a refused operator leaves. `recordMutationDenial`
        // writes the denial event and the DENIED audit row, on the pool,
        // outside any transaction.
        await recordMutationDenial(
          { opsLog: this.deps.opsLog, audit: this.deps.audit, guard: this.deps.guard },
          tenant,
          actor,
          MAINTENANCE_RUN,
          denial,
          error,
        );
        return false;
      }
      throw error;
    }
  }

  /** Steps a panel back without inventing anything about the provider. */
  /**
   * Backs a candidate off after an unhandled failure, without claiming to know why.
   *
   * Deliberately NOT a health state: nothing was asked of the provider, so
   * there is nothing to report about it. `INTERNAL_ERROR` is a scheduler
   * reason like any other refusal, and the stable interval applies — an
   * envelope that will not decrypt this minute will not decrypt in the next
   * one either. A failure to write even this is swallowed: the sweep continues
   * either way, and the alternative is one corrupt row stopping the loop.
   */
  private async deferInternalError(candidate: DuePanel): Promise<void> {
    const tenant: TenantContext = {
      tenantId: candidate.tenantId as TenantContext['tenantId'],
      botInstanceId: null,
    };
    try {
      await this.defer(tenant, candidate.panelId, 'INTERNAL_ERROR');
    } catch (error) {
      this.deps.logger.error(
        { err: error, panelId: candidate.panelId, tenantId: candidate.tenantId },
        'panel monitor could not defer a failed candidate',
      );
    }
  }

  /**
   * Steps back from a panel the loop decided not to probe.
   *
   * `observed` is the configuration the refusal was derived from, and the
   * deferral is applied only if it still holds. Without it a refusal raced the
   * fix for the very thing it refused over: the monitor reads no credential,
   * the operator sets a password — which commits `ELIGIBLE_NOW` — and this
   * write lands afterwards and postpones the corrected panel by the stable
   * hour. The operator sees a panel they have just fixed sitting untested, with
   * nothing on screen explaining why.
   *
   * The re-read is inside the deferral's own transaction, so a write that
   * committed before it is visible and a write that commits after it is
   * authoritative anyway — an operator edit is not monotonic and wins on
   * arrival. Passing `null` skips the check, for the refusals that are about
   * the loop rather than the panel.
   */
  private async defer(
    tenant: TenantContext,
    panelId: string,
    reason: MonitorDeferralReason,
    observed: string | null = null,
  ): Promise<void> {
    const at = this.deps.clock.now();
    await this.deps.uow.run(tenant, async (tx) => {
      if (observed !== null) {
        const current = await this.deps.probe.repository.find(tenant, panelId, tx);
        if (current === null || configurationOf(current) !== observed) return;
      }
      return this.deps.probe.repository.scheduleNext(
        tenant,
        panelId,
        {
          nextEligibleAt: new Date(at.getTime() + deferralIntervalMs(reason)),
          // A deferral is not a failed probe. The backoff streak describes what
          // the provider said, and the provider said nothing.
          consecutiveFailures: 0,
          deferredReason: reason,
          at,
        },
        tx,
      );
    });
  }

  /**
   * Stores the result, moves the schedule, and announces a real transition.
   *
   * One transaction. The schedule moves whether or not the health write landed,
   * because a probe DID happen and re-probing this panel immediately would be
   * asking a question that was just answered.
   */
  private async persist(
    tenant: TenantContext,
    actor: ActorContext,
    candidate: DuePanel,
    before: PanelView,
    configuration: string,
    health: PanelHealthRecord,
  ): Promise<void> {
    const at = this.deps.clock.now();
    await runAuthorizedMutation(
      {
        uow: this.deps.uow,
        guard: this.deps.guard,
        audit: this.deps.audit,
        opsLog: this.deps.opsLog,
        sessions: this.deps.sessions,
        clock: this.deps.clock,
      },
      tenant,
      actor,
      // Re-checked inside the transaction that commits, which is what
      // `runAuthorizedMutation` is for: the pre-network check above prevented
      // the side effect, and this one stops a job whose permission was revoked
      // mid-probe from committing anything.
      MAINTENANCE_RUN,
      { action: 'panel.monitor.probe', entityType: 'Panel', entityId: candidate.panelId },
      async (tx) => {
        // A probe result changes health and NOTHING else. No status, no
        // credential, no address.
        const { outcome } = await persistProbeResult(
          this.deps.probe,
          tenant,
          candidate.panelId,
          configuration,
          health,
          tx,
        );

        // Only a result the database ACCEPTED may change anything downstream.
        //
        // A slow probe finishing after a faster later one describes a moment
        // that has already been superseded. Its health write was refused; its
        // schedule must be refused with it, or an AUTH_FAILED that lost the row
        // would still push the panel out by the non-retryable interval while
        // the row in front of the operator says healthy. And announcing its
        // transition would tell them their panel is broken while it is not.
        if (outcome !== 'APPLIED') return;

        // The streak the NEXT probe builds on, read from stored health rather
        // than from the counter alone — see `effectivePreviousFailures`.
        const stored = await this.deps.probe.repository.readSchedule(tenant, candidate.panelId, tx);
        const previousStreak = effectivePreviousFailures(
          before.health?.state ?? null,
          stored?.consecutiveFailures ?? 0,
        );
        const schedule = scheduleAfterProbe(this.deps.probe.cadence, candidate.panelId, {
          checkedAt: health.checkedAt,
          failure: health.failure,
          previousConsecutiveFailures: previousStreak,
        });
        await this.deps.probe.repository.scheduleNext(
          tenant,
          candidate.panelId,
          {
            nextEligibleAt: schedule.nextEligibleAt,
            consecutiveFailures: schedule.consecutiveFailures,
            deferredReason: null,
            at,
          },
          tx,
        );

        const event = transitionOf(before.health ?? null, health);
        if (event === null) return;

        await this.deps.audit.record(
          tenant,
          actor,
          {
            action: 'panel.monitor.probe',
            entityType: 'Panel',
            entityId: candidate.panelId,
            before: {
              state: before.health?.state ?? null,
              failure: before.health?.failure ?? null,
            },
            // The normalized outcome and nothing else. No provider message, no
            // header, no body.
            after: { state: health.state, failure: health.failure, latencyMs: health.latencyMs },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.deps.opsLog.record(tenant, buildEvent(before, event), tx);
      },
    );
  }
}

/** Which scheduling reason a probe-core refusal earns. */
function deferralReasonOf(kind: string): MonitorDeferralReason {
  switch (kind) {
    case 'CREDENTIALS_MISSING':
      return 'CREDENTIALS_MISSING';
    case 'TARGET_BLOCKED':
      return 'TARGET_BLOCKED';
    case 'STATUS_NOT_PROBEABLE':
      return 'STATUS_NOT_PROBEABLE';
    case 'BUDGET_EXHAUSTED':
      return 'BUDGET_EXHAUSTED';
    default:
      return 'COOLDOWN';
  }
}

/**
 * The operator-facing CONDITION a health row represents.
 *
 * Not a broad "failed / degraded / ok" class, and the difference matters. The
 * first version collapsed `UNREACHABLE` and `AUTH_FAILED` into one class, so a
 * panel that stopped being reachable and started rejecting the password
 * announced nothing at all — and those are not two shades of the same problem,
 * they are "look at the host" and "look at the credential".
 *
 * Within a state the failure KIND splits further wherever the operator's job
 * changes: a certificate to fix is not a password to replace is not an address
 * the installation refuses to call. Kinds whose remedy is the same share a
 * condition, so a host that times out and then refuses the connection is one
 * ongoing "not reachable" rather than two alarms.
 */
type Condition = {
  readonly code: string;
  readonly severity: 'ERROR' | 'WARN' | 'INFO';
  readonly summary: string;
};

function conditionOf(
  state: PanelHealthState,
  failure: ProviderFailureKind | null,
): Condition | null {
  if (state === 'HEALTHY') return null;
  if (state === 'DEGRADED') {
    return {
      code: 'panel.health.degraded',
      severity: 'WARN',
      summary: 'authenticated but could not report its own status',
    };
  }
  switch (failure) {
    case 'AUTHENTICATION_FAILED':
      return {
        code: 'panel.health.auth_failed',
        severity: 'ERROR',
        summary: 'rejected the stored credentials',
      };
    case 'AUTHENTICATION_REQUIRES_INTERACTION':
      return {
        code: 'panel.health.auth_interaction_required',
        severity: 'ERROR',
        summary: 'wants a second factor and cannot be used unattended',
      };
    case 'TLS_FAILED':
      return {
        code: 'panel.health.tls_failed',
        severity: 'ERROR',
        summary: 'presented a certificate this installation will not accept',
      };
    case 'BLOCKED_TARGET':
      return {
        code: 'panel.health.target_blocked',
        severity: 'ERROR',
        summary: 'resolves somewhere this installation refuses to call',
      };
    case 'MALFORMED_RESPONSE':
    case 'PROVIDER_ERROR':
    case 'UNSUPPORTED_CAPABILITY':
      return {
        code: 'panel.health.provider_error',
        severity: 'ERROR',
        summary: 'answered with something this provider does not produce',
      };
    default:
      return {
        code: 'panel.health.unreachable',
        severity: 'ERROR',
        summary: 'is not answering',
      };
  }
}

interface Transition {
  readonly to: Condition | null;
  readonly from: Condition | null;
}

/**
 * What changed, if anything worth telling an operator.
 *
 * Null when the condition is unchanged — a panel that has been unreachable for
 * an hour is one open condition, not one hundred and twenty events — and null
 * for the FIRST successful check of a panel that has never been probed, because
 * nothing was wrong and "recovered" would be a lie every installation heard
 * once per panel on its first tick.
 */
function transitionOf(
  before: { state: PanelHealthState; failure: ProviderFailureKind | null } | null,
  after: { state: PanelHealthState; failure: ProviderFailureKind | null },
): Transition | null {
  const from = before === null ? null : conditionOf(before.state, before.failure);
  const to = conditionOf(after.state, after.failure);
  if (from?.code === to?.code) return null;
  if (from === null && to === null) return null;
  return { from, to };
}

/**
 * The operational event a transition earns.
 *
 * Deduplicated per PANEL, so every panel-health condition of one panel shares a
 * scope and a recovery resolves exactly the condition that was open. Moving
 * between conditions resolves the one being left, which is what keeps at most
 * one panel-health condition open per panel — a panel that went unreachable and
 * then started failing authentication must not leave "unreachable" standing,
 * because an operator would go on looking at a network that is fine.
 *
 * The context carries identifiers and the normalized outcome. Never a
 * credential, never a cookie, never a CSRF token, never a provider's own
 * message: the probe outcome type has no field one could be put in, and this
 * builder reads only that type and the panel's own row.
 */
function buildEvent(before: PanelView, transition: Transition): OperationalEventInput {
  const name = before.panel.name;
  const panelId = before.panel.id;
  const context = { panelId, panelName: name, providerType: before.panel.providerType };
  // One dedupe row per PANEL AND CONDITION. Deduplication is keyed on
  // `(scope, dedupeKey)` and never rewrites a row's code, so sharing one key
  // across conditions would have the second condition reuse the first's row —
  // and then resolve itself, because the row still carried the code the
  // recovery was closing. A panel that went unreachable and then started
  // failing authentication announced nothing at all.
  const keyFor = (code: string): string => `${code}:${panelId}`;
  // Whichever condition is being left, closed by name. `recoversDedupeKey` is
  // what keeps that to THIS panel: without it, one panel recovering would
  // resolve every other panel's open row of the same code.
  const closing =
    transition.from === null
      ? {}
      : { recoversCode: transition.from.code, recoversDedupeKey: keyFor(transition.from.code) };

  if (transition.to === null) {
    return {
      code: 'panel.health.recovered',
      severity: 'INFO',
      message: `Panel "${name}" is answering health checks again.`,
      dedupeKey: keyFor('panel.health.recovered'),
      ...closing,
      context,
    };
  }
  return {
    code: transition.to.code,
    severity: transition.to.severity,
    message: `Panel "${name}" ${transition.to.summary}.`,
    dedupeKey: keyFor(transition.to.code),
    ...closing,
    context,
  };
}
