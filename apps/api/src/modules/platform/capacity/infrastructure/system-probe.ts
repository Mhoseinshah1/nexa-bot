import { readFile, statfs } from 'node:fs/promises';
import type { OperationalEventRecorder } from '@nexa/contracts';
import { cgroupHeadroomBytes, memAvailableBytes } from '../domain/memory.js';
import type { OwnerOpsLog, SystemProbe } from '../application/ports.js';

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    // Absent is the answer for a host without this file (no cgroup v2, not Linux).
    return null;
  }
}

/**
 * The server as `/proc` and the cgroup see it. MemAvailable is the host's; the cgroup files
 * are this container's (v2 first, then v1), so inside a memory-limited container the answer
 * is the smaller of "the host has room" and "this container may still grow".
 */
export class ProcSystemProbe implements SystemProbe {
  constructor(
    private readonly paths: {
      readonly meminfo: string;
      readonly cgroupRoot: string;
    } = { meminfo: '/proc/meminfo', cgroupRoot: '/sys/fs/cgroup' },
  ) {}

  async memory(): Promise<{
    hostAvailableBytes: number | null;
    containerHeadroomBytes: number | null;
  }> {
    const meminfo = await readOrNull(this.paths.meminfo);
    const host = meminfo === null ? null : memAvailableBytes(meminfo);
    const root = this.paths.cgroupRoot;
    let headroom = cgroupHeadroomBytes(
      await readOrNull(`${root}/memory.max`),
      await readOrNull(`${root}/memory.current`),
    );
    if (headroom === null) {
      headroom = cgroupHeadroomBytes(
        await readOrNull(`${root}/memory/memory.limit_in_bytes`),
        await readOrNull(`${root}/memory/memory.usage_in_bytes`),
      );
    }
    return { hostAvailableBytes: host, containerHeadroomBytes: headroom };
  }

  async disk(path: string): Promise<{ totalBytes: number; availableBytes: number } | null> {
    try {
      const stats = await statfs(path);
      return {
        totalBytes: Number(stats.blocks) * Number(stats.bsize),
        availableBytes: Number(stats.bavail) * Number(stats.bsize),
      };
    } catch {
      // A path that does not exist on this role's filesystem is not watched here.
      return null;
    }
  }
}

/**
 * The owner's operations log: every event on the INSTALLATION tenant, so it reaches the
 * installation's group and never a hosted bot's. No installation tenant yet: nothing to tell.
 */
export class InstallationOwnerOpsLog implements OwnerOpsLog {
  constructor(
    private readonly deps: {
      readonly recorder: OperationalEventRecorder;
      readonly installationTenantId: () => string | null;
      readonly conditionIsOpen: (tenantId: string, code: string) => Promise<boolean>;
    },
  ) {}

  async record(event: Parameters<OwnerOpsLog['record']>[0]): Promise<void> {
    const tenantId = this.deps.installationTenantId();
    if (tenantId === null) return;
    await this.deps.recorder.record({ tenantId: tenantId as never, botInstanceId: null }, event);
  }

  async conditionOpen(code: string): Promise<boolean> {
    const tenantId = this.deps.installationTenantId();
    return tenantId === null ? false : this.deps.conditionIsOpen(tenantId, code);
  }
}
