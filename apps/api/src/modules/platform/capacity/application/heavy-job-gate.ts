import {
  CAPACITY_HEAVY_JOB_DEFERRED_CODE,
  opsAggregationKey,
  type Clock,
  type HeavyJobKind,
  type IdGenerator,
} from '@nexa/contracts';
import type { CapacityLimitResolver } from './capacity-limit-resolver.js';
import type { HeavyJobQueueRepository, OwnerOpsLog, SystemProbe } from './ports.js';

/**
 * How long a ticket lives without its holder refreshing it. Longer than the backup
 * scheduler's tick (five minutes), so a scheduled job keeps its place between two ticks; a
 * running job refreshes it every quarter of this.
 */
export const HEAVY_JOB_LEASE_MS = 10 * 60_000;
/**
 * The headroom THIS container (the one that runs the job's dump and archive subprocesses)
 * must still have below its own cgroup limit. Separate from the owner's host floor, which is
 * about the server's reserve: a container's headroom is bounded by its own limit (the worker
 * gets at least 512 MB, deploy/bin/nexa-lib.sh) and is never compared with the host floor.
 */
export const HEAVY_JOB_MIN_CONTAINER_HEADROOM_BYTES = 96 * 1024 * 1024;

/** Finished tickets are kept this long, then deleted. */
export const HEAVY_JOB_TICKET_RETENTION_MS = 7 * 86_400_000;

export type HeavyJobAdmission =
  | { readonly granted: true; readonly ticketId: string }
  | {
      readonly granted: false;
      readonly ticketId: string | null;
      readonly reason: 'LOW_MEMORY' | 'QUEUED';
      readonly availableMemoryBytes?: number;
      readonly containerHeadroomBytes?: number | null;
    };

/**
 * Phase 6A PR-2: the ONE installation-wide queue of heavy jobs — backup, import, export,
 * large report — run one at a time (`INSTALLATION_HEAVY_JOB_CONCURRENCY`, 1 or 2), the owner's
 * own bot at the front (`HEAVY_JOB_PRIORITY`), the rest in arrival order.
 *
 * Two checks, in order, at every attempt:
 *
 * 1. MEMORY. While the server's free memory (the smaller of MemAvailable and this
 *    container's cgroup headroom) is below `INSTALLATION_HEAVY_JOB_MIN_FREE_MEMORY_MB`, no
 *    heavy job starts — not even the one at the front. The job stays where it is and asks
 *    again; the owner is told (windowed). A heavy job that would push PostgreSQL into the
 *    OOM killer is the one outage this exists to prevent.
 * 2. THE QUEUE. A durable ticket (`heavy_job_tickets`), started only when it is first in line
 *    and a slot is free, under one installation-wide lock (two worker replicas are normal).
 *
 * A caller keeps its ticket id between attempts, so a scheduled job keeps its place across
 * ticks; a ticket nobody refreshes for `HEAVY_JOB_LEASE_MS` is abandoned by the next attempt
 * of anybody, so a killed process never holds the queue.
 */
export class HeavyJobGate {
  constructor(
    private readonly deps: {
      readonly repository: HeavyJobQueueRepository;
      readonly limits: Pick<CapacityLimitResolver, 'numberOf'>;
      readonly probe: Pick<SystemProbe, 'memory'>;
      readonly ownerOpsLog: OwnerOpsLog;
      readonly clock: Clock;
      readonly ids: IdGenerator;
      readonly installationTenantId: () => string | null;
    },
  ) {}

  /**
   * One attempt. `ticketId` is the one an earlier attempt of the same job returned (null on
   * the first). Never throws for a refusal: it answers it.
   */
  async attempt(
    kind: HeavyJobKind,
    tenantId: string,
    ticketId: string | null,
  ): Promise<HeavyJobAdmission> {
    const now = this.deps.clock.now();
    const installation = this.deps.installationTenantId() ?? tenantId;
    const floorMb = await this.deps.limits.numberOf(
      installation,
      'INSTALLATION_HEAVY_JOB_MIN_FREE_MEMORY_MB',
    );
    const { hostAvailableBytes: available, containerHeadroomBytes: headroom } =
      await this.deps.probe.memory();
    const hostShort =
      available !== null && Number.isFinite(floorMb) && available < floorMb * 1024 * 1024;
    const containerShort = headroom !== null && headroom < HEAVY_JOB_MIN_CONTAINER_HEADROOM_BYTES;
    if (hostShort || containerShort) {
      if (ticketId !== null) {
        await this.deps.repository.heartbeat(
          ticketId,
          new Date(now.getTime() + HEAVY_JOB_LEASE_MS),
        );
      }
      await this.deps.ownerOpsLog
        .record({
          code: CAPACITY_HEAVY_JOB_DEFERRED_CODE,
          severity: 'WARN',
          message: hostShort
            ? `کار سنگین «${kind}» منتظر ماند: حافظهٔ آزاد سرور ` +
              `${String(Math.floor((available ?? 0) / 1024 / 1024))} مگابایت است و دست‌کم ` +
              `${String(floorMb)} مگابایت لازم است. بعداً خودکار شروع می‌شود.`
            : `کار سنگین «${kind}» منتظر ماند: کانتینر اجراکننده به سقف حافظهٔ خودش نزدیک است ` +
              `(${String(Math.floor((headroom ?? 0) / 1024 / 1024))} مگابایت جا). بعداً خودکار شروع می‌شود.`,
          dedupeKey: opsAggregationKey(`${CAPACITY_HEAVY_JOB_DEFERRED_CODE}:${kind}`, now),
          context: {
            kind,
            tenantId,
            availableBytes: available,
            containerHeadroomBytes: headroom,
            floorMb,
          },
        })
        .catch(() => undefined);
      return {
        granted: false,
        ticketId,
        reason: 'LOW_MEMORY',
        ...(available === null ? {} : { availableMemoryBytes: available }),
        containerHeadroomBytes: headroom,
      };
    }

    let id = ticketId;
    if (id === null) {
      id = this.deps.ids.uuid();
      const priority = await this.deps.limits.numberOf(tenantId, 'HEAVY_JOB_PRIORITY');
      await this.deps.repository.enqueue({
        id,
        tenantId,
        kind,
        priority: Number.isFinite(priority) ? priority : 1,
        now,
        leaseUntil: new Date(now.getTime() + HEAVY_JOB_LEASE_MS),
      });
    }
    const concurrency = await this.deps.limits.numberOf(
      installation,
      'INSTALLATION_HEAVY_JOB_CONCURRENCY',
    );
    const state = await this.deps.repository.tryStart(id, {
      now,
      leaseUntil: new Date(now.getTime() + HEAVY_JOB_LEASE_MS),
      concurrency: Number.isFinite(concurrency) ? concurrency : 1,
    });
    if (state === 'RUNNING') return { granted: true, ticketId: id };
    if (state === 'QUEUED') return { granted: false, ticketId: id, reason: 'QUEUED' };
    // Abandoned (its lease ran out between two attempts) or gone: a fresh place at the back.
    return this.attempt(kind, tenantId, null);
  }

  /** Keeps a running or queued ticket alive. */
  heartbeat(ticketId: string): Promise<void> {
    return this.deps.repository.heartbeat(
      ticketId,
      new Date(this.deps.clock.now().getTime() + HEAVY_JOB_LEASE_MS),
    );
  }

  /** Refreshes a running ticket's lease until the returned function is called. */
  hold(ticketId: string): () => void {
    const beat = setInterval(
      () => void this.heartbeat(ticketId).catch(() => undefined),
      HEAVY_JOB_LEASE_MS / 4,
    );
    beat.unref?.();
    return () => clearInterval(beat);
  }

  /** The job ended (whatever its outcome): its slot goes to the next in line. */
  async finish(ticketId: string): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.repository.finish(ticketId, now);
    await this.deps.repository.purgeFinished(
      new Date(now.getTime() - HEAVY_JOB_TICKET_RETENTION_MS),
    );
  }

  /**
   * Runs `job` once it is admitted, asking every `pollMs` for at most `maxWaitMs`, and keeps
   * the ticket alive while it runs. For a caller that can wait (a CLI command); answers
   * `null` when it was never admitted, having run nothing.
   */
  async runWhenAdmitted<T>(
    kind: HeavyJobKind,
    tenantId: string,
    job: () => Promise<T>,
    options: {
      readonly pollMs: number;
      readonly maxWaitMs: number;
      readonly sleep: (ms: number) => Promise<void>;
      readonly onWait?: (admission: HeavyJobAdmission) => void;
    },
  ): Promise<{ readonly ran: true; readonly result: T } | { readonly ran: false }> {
    const deadline = this.deps.clock.now().getTime() + options.maxWaitMs;
    let ticketId: string | null = null;
    for (;;) {
      const admission = await this.attempt(kind, tenantId, ticketId);
      ticketId = admission.ticketId;
      if (admission.granted) break;
      options.onWait?.(admission);
      if (this.deps.clock.now().getTime() + options.pollMs > deadline) {
        if (ticketId !== null) await this.finish(ticketId);
        return { ran: false };
      }
      await options.sleep(options.pollMs);
    }
    const admitted = ticketId as string;
    const release = this.hold(admitted);
    try {
      return { ran: true, result: await job() };
    } finally {
      release();
      await this.finish(admitted);
    }
  }
}
