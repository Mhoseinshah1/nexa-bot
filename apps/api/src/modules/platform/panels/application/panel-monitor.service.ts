import {
  systemJobActor,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type Logger,
  type OperationalEventInput,
  type OperationalEventRecorder,
  type PanelHealthState,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import { newCorrelationId } from '../../../../infrastructure/logging/logger.js';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../access/application/authorized-mutation.js';
import type { SessionRepository } from '../../identity/application/ports.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { attemptProbe, persistProbeResult, type ProbeCoreDeps } from './probe-core.js';
import type { DuePanel, PanelMonitorRepository, PanelView } from './ports.js';

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
  /** Panels considered in one tick. The discovery query is LIMITed by it. */
  readonly batchSize: number;
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
  readonly considered: number;
  readonly probed: number;
  readonly refused: number;
  readonly failed: number;
}

/** What an operator is told about, and nothing more often than a change. */
type HealthClass = 'OK' | 'DEGRADED' | 'FAILED';

function classOf(state: PanelHealthState | null): HealthClass | null {
  if (state === null) return null;
  if (state === 'HEALTHY') return 'OK';
  if (state === 'DEGRADED') return 'DEGRADED';
  return 'FAILED';
}

/**
 * Probing panels on a schedule, in the `monitor` process.
 *
 * Three properties are worth stating before the code, because each is a
 * decision that a simpler loop would silently get wrong.
 *
 * **It probes ACTIVE panels only.** `DISABLED` is the operator saying stop
 * using this for now and `ARCHIVED` means finished. Unattended dialling of
 * either is exactly what those states forbid, so the rule is enforced twice —
 * in the discovery query's predicate (which is also the partial index's) and
 * again in the probe core, so a panel disabled between the two is still
 * refused.
 *
 * **It never decides for itself whether a probe may happen.** The per-panel
 * claim and the tenant budget are conditional writes in PostgreSQL. Two monitor
 * replicas reaching the same panel in the same second do not coordinate; they
 * both ask, and the database grants one. There is no process-local set of
 * in-flight panels, because a process-local anything is wrong the moment there
 * are two processes — and there being two, briefly, is what a rolling update
 * is.
 *
 * **It does not hammer credentials.** A rejected login is not retried on the
 * healthy cadence: `PROVIDER_FAILURE_RETRYABLE` says an authentication failure
 * cannot be fixed by asking again, so it earns the long interval, and the
 * interval doubles with each consecutive failure to a bound. An operator who
 * fixes the credential does not wait that out — replacing one changes the
 * panel's configuration, which makes it due immediately.
 */
export class PanelMonitorService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  /**
   * When the last tick RAN TO COMPLETION.
   *
   * Read by the heartbeat, and it is the completion that matters. A timestamp
   * written when a tick starts would keep reporting a healthy monitor while
   * every tick hung on the same query — the exact failure the heartbeat exists
   * to expose.
   */
  private lastCompletedTickAt: number | null = null;
  /**
   * When `start()` was called, or null if this loop was never started.
   *
   * The grace the container health check needs at boot. The heartbeat is armed
   * before the loop runs — it has to be, because it is what proves the database
   * is reachable — so its FIRST beat lands before any tick has completed. Without
   * a grace that beat writes nothing, the file does not exist for a whole
   * heartbeat interval, and the container's first check fails on a monitor that
   * is perfectly healthy and merely young. That is exactly what a real
   * deployment saw: api and worker healthy at thirteen seconds, monitor still
   * `health: starting`, and `botctl status` — whose probe is deliberately five
   * seconds — reporting the installation not ready.
   *
   * It is a grace, not an exemption. Once the window passes, a loop that has
   * never completed a tick is reported dead, which is the whole point of asking
   * about iterations rather than about the process.
   */
  private startedAt: number | null = null;

  constructor(
    private readonly deps: PanelMonitorDeps,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.stopping = false;
    this.startedAt = this.deps.clock.now().getTime();
    // The first tick runs immediately rather than one interval later. A monitor
    // that restarts more often than its interval — a crash loop, a day of
    // deploys — would otherwise never probe anything at all.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // A stopped loop has no grace: a draining monitor must not be reported as
    // alive, and `main.monitor.ts` stops the heartbeat first for the same
    // reason.
    this.startedAt = null;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Let an in-flight tick finish. Its probes have already spent claims and
    // budget; abandoning them would leave results unwritten and the panels
    // claimed.
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /**
   * Whether a tick has completed recently enough to call this loop alive.
   *
   * The heartbeat's second question, after "is the database reachable". A
   * process whose timer still fires but whose ticks all throw is not monitoring
   * anything, and a heartbeat that only proved the process existed would report
   * it healthy for ever.
   *
   * Three intervals of slack: one tick may legitimately overrun into the next,
   * and a container must not be restarted for being briefly busy.
   */
  iterationIsFresh(now: number): boolean {
    const window = this.intervalMs * 3;
    if (this.lastCompletedTickAt !== null) return now - this.lastCompletedTickAt <= window;
    // Never completed one. Healthy only while still inside the first window
    // after `start()` — a loop that has been up for three intervals without
    // finishing a tick is not starting up, it is broken. A monitor that was
    // never started at all has no grace and is not fresh.
    return this.startedAt !== null && now - this.startedAt <= window;
  }

  /** One pass. Exposed so a test can run it without waiting for the timer. */
  async tick(): Promise<MonitorTickResult> {
    // Overlapping ticks would re-discover the same panels and contend for the
    // same claims. A tick that is still running IS the current pass.
    if (this.running) return { considered: 0, probed: 0, refused: 0, failed: 0 };
    this.running = true;
    try {
      const result = await this.sweep();
      this.lastCompletedTickAt = this.deps.clock.now().getTime();
      return result;
    } catch (error) {
      // Discovery itself failed — the database is unreachable, or the query is
      // wrong. The tick does NOT count as completed, so the heartbeat goes
      // stale and the container is reported unhealthy rather than quietly
      // monitoring nothing.
      this.deps.logger.error({ err: error }, 'panel monitor tick failed');
      return { considered: 0, probed: 0, refused: 0, failed: 0 };
    } finally {
      this.running = false;
    }
  }

  private async sweep(): Promise<MonitorTickResult> {
    const now = this.deps.clock.now();
    const due = await this.deps.discovery.dueForMonitoring(now, this.deps.batchSize);
    if (due.length === 0) return { considered: 0, probed: 0, refused: 0, failed: 0 };

    const correlationId = newCorrelationId(this.deps.ids.uuid());
    const actor = systemJobActor(PANEL_MONITOR_JOB_ID, correlationId);

    let probed = 0;
    let refused = 0;
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
          else refused += 1;
        } catch (error) {
          // One panel's failure is one panel's failure. An unreachable panel,
          // a provider that returns nonsense, a conflict because somebody
          // edited the panel mid-probe — none of them may stop the sweep, or a
          // single broken panel would stop every other panel being monitored.
          failed += 1;
          this.deps.logger.error(
            { err: error, panelId: candidate.panelId, tenantId: candidate.tenantId },
            'panel monitor probe failed',
          );
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.deps.concurrency, due.length) }, () => worker()),
    );

    this.deps.logger.debug(
      { considered: due.length, probed, refused, failed },
      'panel monitor tick complete',
    );
    return { considered: due.length, probed, refused, failed };
  }

  private async probeOne(candidate: DuePanel, actor: ActorContext): Promise<'PROBED' | 'REFUSED'> {
    // The panel's OWN tenant, taken from the discovery row. This is the point at
    // which cross-tenant work stops: discovery returned a tenant id and a panel
    // id, and from here everything runs inside that tenant's scope through the
    // ordinary tenant-filtered repository. No `SystemContext` reaches the panel
    // service, so there is no path by which a bug here reads another tenant.
    const tenant: TenantContext = {
      tenantId: candidate.tenantId as TenantContext['tenantId'],
      botInstanceId: null,
    };

    const before = await this.deps.probe.repository.find(tenant, candidate.panelId);
    // Deleted, or archived and re-scoped, between discovery and now. Nothing to
    // do and nothing to report: the next tick will not see it either.
    if (before === null) return 'REFUSED';

    const attempt = await attemptProbe(this.deps.probe, tenant, before, {
      // ACTIVE only. Non-negotiable, and enforced here as well as in the query.
      probeableStatuses: ['ACTIVE'],
      budgetReserve: this.deps.budgetReserve,
    });
    if (!attempt.probed) {
      this.deps.logger.debug(
        { panelId: candidate.panelId, refusal: attempt.refusal.kind },
        'panel monitor probe refused',
      );
      return 'REFUSED';
    }

    const health = attempt.health;
    const from = classOf(before.health?.state ?? null);
    const to = classOf(health.state);
    // A change of class, and one exception: the FIRST successful check of a
    // panel that has never been probed is not a recovery. Nothing was wrong,
    // so there is nothing to announce — and announcing it would mean every
    // installation greeted its own first monitor tick with one "recovered"
    // event per panel.
    const transition = from === to || (from === null && to === 'OK') ? null : to;

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
      MAINTENANCE_RUN,
      { action: 'panel.monitor.probe', entityType: 'Panel', entityId: candidate.panelId },
      async (tx) => {
        // A probe result changes health and NOTHING else. No status, no
        // credential, no address: `persistProbeResult` writes one row, and the
        // recheck it does first refuses an answer that describes a
        // configuration the operator has since replaced.
        await persistProbeResult(
          this.deps.probe,
          tenant,
          candidate.panelId,
          attempt.configuration,
          health,
          tx,
        );

        // Audited and announced on a TRANSITION, not on every probe.
        //
        // A row per tick would be a health history table wearing the audit
        // log's name: six rows per panel per hour, for ever, in a table that
        // refuses DELETE. What an operator needs from a monitor is when
        // something changed, and the latest health row already answers "what is
        // it now". A steady state writes nothing.
        if (transition === null) return;

        await this.deps.audit.record(
          tenant,
          actor,
          {
            action: 'panel.monitor.probe',
            entityType: 'Panel',
            entityId: candidate.panelId,
            before: { state: before.health?.state ?? null },
            // The normalized outcome and nothing else. No provider message, no
            // header, no body.
            after: { state: health.state, failure: health.failure, latencyMs: health.latencyMs },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.deps.opsLog.record(
          tenant,
          transitionEvent(before, health, transition, candidate),
          tx,
        );
      },
    );

    return 'PROBED';
  }
}

/**
 * The operational event a health transition earns.
 *
 * Deduplicated per panel and per condition, so a panel that fails, recovers and
 * fails again collapses onto one row with a counter rather than filling the
 * operations view — which is exactly what the legacy log group did, posting the
 * same expired-certificate error 60 times in a day because nothing could tell
 * the occurrences apart.
 *
 * The context carries identifiers and the normalized outcome. Never a
 * credential, never a cookie, never a CSRF token, never a provider's own
 * message: the probe outcome type has no field one could be put in, and this
 * builder only reads that type and the panel's own row.
 */
function transitionEvent(
  before: PanelView,
  health: { state: PanelHealthState; failure: string | null },
  to: HealthClass,
  candidate: DuePanel,
): OperationalEventInput {
  const context = {
    panelId: candidate.panelId,
    panelName: before.panel.name,
    providerType: before.panel.providerType,
    state: health.state,
    failure: health.failure,
    dueReason: candidate.reason,
  };
  if (to === 'FAILED') {
    return {
      code: 'panel.health.failed',
      severity: 'ERROR',
      message: `Panel "${before.panel.name}" is not answering health checks.`,
      dedupeKey: `panel.health.failed:${candidate.panelId}`,
      context,
    };
  }
  if (to === 'DEGRADED') {
    return {
      code: 'panel.health.degraded',
      severity: 'WARN',
      message: `Panel "${before.panel.name}" authenticated but could not report its own status.`,
      dedupeKey: `panel.health.degraded:${candidate.panelId}`,
      context,
    };
  }
  return {
    code: 'panel.health.recovered',
    severity: 'INFO',
    message: `Panel "${before.panel.name}" is answering health checks again.`,
    dedupeKey: `panel.health.recovered:${candidate.panelId}`,
    // Resolves whichever condition was open. A panel that went DEGRADED and
    // then FAILED has both rows; naming the one it came from leaves the other
    // open, which is honest — it did not recover from a condition it was not
    // in when it recovered.
    recoversCode:
      classOf(before.health?.state ?? null) === 'DEGRADED'
        ? 'panel.health.degraded'
        : 'panel.health.failed',
    context,
  };
}
