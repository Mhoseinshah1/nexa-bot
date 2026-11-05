import { availableParallelism, loadavg, totalmem } from 'node:os';
import type { SystemProbe } from '../../capacity/application/ports.js';
import type { HostingServerProbe } from '../application/ports.js';

/**
 * The creator panel's server card readings: cores and load from `node:os`, free memory and
 * disk from PR-2's `ProcSystemProbe` (`/proc/meminfo`, the cgroup, `statfs`) — the SAME
 * readings the owner's capacity alerts use, so the card and the alerts cannot disagree.
 */
export class OsHostingServerProbe implements HostingServerProbe {
  constructor(private readonly system: SystemProbe) {}

  cores(): number {
    return availableParallelism();
  }

  loadAverage1m(): number {
    return loadavg()[0] ?? 0;
  }

  totalMemoryBytes(): number {
    return totalmem();
  }

  async availableMemoryBytes(): Promise<number | null> {
    // The host's MemAvailable: the capacity card describes the server, not one container.
    return (await this.system.memory()).hostAvailableBytes;
  }

  disk(path: string) {
    return this.system.disk(path);
  }
}
