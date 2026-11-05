import {
  CAPACITY_DISK_CRITICAL_CLEARED_CODE,
  CAPACITY_DISK_CRITICAL_CODE,
  CAPACITY_DISK_CRITICAL_PERCENT,
  CAPACITY_DISK_WARNING_CLEARED_CODE,
  CAPACITY_DISK_WARNING_CODE,
  CAPACITY_DISK_WARNING_PERCENT,
  CAPACITY_MEMORY_LOW_CODE,
  CAPACITY_MEMORY_OK_CODE,
  CAPACITY_WORKER_LAG_CODE,
  CAPACITY_WORKER_LAG_OK_CODE,
  type OperationalSeverity,
} from '@nexa/contracts';
import { diskUsedPercent } from '../domain/memory.js';
import type { CapacityLimitResolver } from './capacity-limit-resolver.js';
import type { OwnerOpsLog, SystemProbe } from './ports.js';

/** A breach must be seen this many checks in a row before the owner is told (debounce). */
export const CAPACITY_ALERT_CONSECUTIVE = 2;

export interface CapacityMonitorReport {
  readonly diskUsedPercent: Readonly<Record<string, number | null>>;
  readonly availableMemoryBytes: number | null;
  readonly workerLagMs: number | null;
}

/**
 * Phase 6A PR-2: the server's own health, for the OWNER only — disk at 80 % and at 90 %,
 * free memory below `INSTALLATION_ALERT_MIN_FREE_MEMORY_MB`, the worker's queue lag above
 * `INSTALLATION_ALERT_WORKER_LAG_SECONDS`.
 *
 * Every condition is recorded on the INSTALLATION tenant (`OwnerOpsLog`), so it reaches the
 * owner's operations group and no hosted bot's: a hosted bot's operators never see the
 * server they share. Debounced twice — a breach must persist for
 * `CAPACITY_ALERT_CONSECUTIVE` checks before it opens, and an open condition is one row
 * (CONDITION dedupe, announced once) until a check finds it gone and records its recovery.
 */
export class CapacityMonitor {
  private readonly streaks = new Map<string, number>();

  constructor(
    private readonly deps: {
      readonly probe: SystemProbe;
      readonly ownerOpsLog: OwnerOpsLog;
      readonly limits: Pick<CapacityLimitResolver, 'numberOf'>;
      readonly installationTenantId: () => string | null;
      /** The volumes to watch: the data directory and the backup directory. */
      readonly diskPaths: readonly string[];
      /** The worker's queue lag now (the outbox's oldest unpublished age), or null. */
      readonly workerLagMs: () => Promise<number | null>;
    },
  ) {}

  async check(): Promise<CapacityMonitorReport> {
    const installation = this.deps.installationTenantId();
    if (installation === null) {
      return { diskUsedPercent: {}, availableMemoryBytes: null, workerLagMs: null };
    }
    const disks: Record<string, number | null> = {};
    for (const path of this.deps.diskPaths) {
      const disk = await this.deps.probe.disk(path);
      const used = disk === null ? null : diskUsedPercent(disk.totalBytes, disk.availableBytes);
      disks[path] = used;
      if (used === null) continue;
      await this.condition(
        `disk-critical:${path}`,
        used >= CAPACITY_DISK_CRITICAL_PERCENT,
        CAPACITY_DISK_CRITICAL_CODE,
        CAPACITY_DISK_CRITICAL_CLEARED_CODE,
        'CRITICAL',
        `دیسک سرور (${path}) ${used.toFixed(0)}٪ پر است؛ از ${String(CAPACITY_DISK_CRITICAL_PERCENT)}٪ گذشته.`,
        `دیسک سرور (${path}) دوباره زیر ${String(CAPACITY_DISK_CRITICAL_PERCENT)}٪ است.`,
        { path, usedPercent: Math.round(used) },
      );
      await this.condition(
        `disk-warning:${path}`,
        used >= CAPACITY_DISK_WARNING_PERCENT,
        CAPACITY_DISK_WARNING_CODE,
        CAPACITY_DISK_WARNING_CLEARED_CODE,
        'WARN',
        `دیسک سرور (${path}) ${used.toFixed(0)}٪ پر است؛ از ${String(CAPACITY_DISK_WARNING_PERCENT)}٪ گذشته.`,
        `دیسک سرور (${path}) دوباره زیر ${String(CAPACITY_DISK_WARNING_PERCENT)}٪ است.`,
        { path, usedPercent: Math.round(used) },
      );
    }

    // The HOST's reserve: the owner is told when the server runs short, not when this
    // worker's own container nears its limit.
    const available = (await this.deps.probe.memory()).hostAvailableBytes;
    if (available !== null) {
      const floorMb = await this.deps.limits.numberOf(
        installation,
        'INSTALLATION_ALERT_MIN_FREE_MEMORY_MB',
      );
      const freeMb = Math.floor(available / 1024 / 1024);
      await this.condition(
        'memory',
        Number.isFinite(floorMb) && freeMb < floorMb,
        CAPACITY_MEMORY_LOW_CODE,
        CAPACITY_MEMORY_OK_CODE,
        'WARN',
        `حافظهٔ آزاد سرور ${String(freeMb)} مگابایت است؛ کمتر از ${String(floorMb)} مگابایت.`,
        `حافظهٔ آزاد سرور دوباره ${String(freeMb)} مگابایت است.`,
        { availableMb: freeMb, floorMb },
      );
    }

    const lag = await this.deps.workerLagMs();
    if (lag !== null) {
      const limitSeconds = await this.deps.limits.numberOf(
        installation,
        'INSTALLATION_ALERT_WORKER_LAG_SECONDS',
      );
      const lagSeconds = Math.floor(lag / 1000);
      await this.condition(
        'worker-lag',
        Number.isFinite(limitSeconds) && lagSeconds > limitSeconds,
        CAPACITY_WORKER_LAG_CODE,
        CAPACITY_WORKER_LAG_OK_CODE,
        'WARN',
        `صف کارهای پس‌زمینه ${String(lagSeconds)} ثانیه عقب است؛ بیش از ${String(limitSeconds)} ثانیه.`,
        'صف کارهای پس‌زمینه دوباره به‌روز است.',
        { lagSeconds, limitSeconds },
      );
    }
    return { diskUsedPercent: disks, availableMemoryBytes: available, workerLagMs: lag };
  }

  private async condition(
    subject: string,
    breached: boolean,
    code: string,
    recoveryCode: string,
    severity: OperationalSeverity,
    message: string,
    recoveryMessage: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    const dedupeKey = `${code}:${subject}`;
    if (breached) {
      const streak = (this.streaks.get(subject) ?? 0) + 1;
      this.streaks.set(subject, streak);
      if (streak < CAPACITY_ALERT_CONSECUTIVE) return;
      await this.deps.ownerOpsLog.record({ code, severity, message, dedupeKey, context });
      return;
    }
    this.streaks.delete(subject);
    if (!(await this.deps.ownerOpsLog.conditionOpen(code))) return;
    await this.deps.ownerOpsLog.record({
      code: recoveryCode,
      severity: 'INFO',
      message: recoveryMessage,
      context,
      recoversCode: code,
      recoversDedupeKey: dedupeKey,
    });
  }
}
