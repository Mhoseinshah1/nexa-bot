import type { ReadinessProbes, SchemaReadiness } from '../application/readiness.service.js';
import type { DatabaseHandle } from '../../../../infrastructure/persistence/database.js';
import { migrationsFolder } from '../../../../infrastructure/persistence/migrate.js';
import {
  compareMigrations,
  expectedMigrations,
  type ExpectedMigration,
} from '../../../../infrastructure/persistence/migration-state.js';

/** What the readiness probes need of the cache. */
export interface ReadinessCache {
  ping(): Promise<boolean>;
}

/** What the readiness probes need of the outbox relay. */
export interface ReadinessOutbox {
  lagMsWithin(deadlineAt: number): Promise<number>;
}

/**
 * The adapters behind `ReadinessProbes`.
 *
 * Every one of these used to be reached from `surfaces/web/readiness.probe.ts`
 * through the container — the surface holding the database handle, the Redis
 * handle and the relay. That is infrastructure on the far side of the
 * application layer, which is the direction this codebase inverts everywhere
 * else; an earlier pass moved the SQL out of the surface and left the handles,
 * which changed what a boundary check could see and nothing about the
 * dependency direction. This is where those calls belong.
 */
export class DrizzleReadinessProbes implements ReadinessProbes {
  /**
   * What this release's journal says the schema must contain. Read once: the
   * files do not change while the process runs, and a probe that read the
   * migration folder on every poll would put twenty file reads on a path a
   * load balancer hits every few seconds.
   */
  private expected: readonly ExpectedMigration[] | null = null;

  constructor(
    private readonly db: DatabaseHandle,
    private readonly cacheHandle: ReadinessCache,
    private readonly outbox: ReadinessOutbox,
  ) {}

  async database(deadlineAt: number): Promise<void> {
    await this.db.ping(deadlineAt);
  }

  async cache(): Promise<boolean> {
    return this.cacheHandle.ping();
  }

  async outboxLagMs(deadlineAt: number): Promise<number> {
    // On a bounded checkout too. This is the one probe that reads an
    // application table, and a slow scan here is exactly the query that used
    // to outlive the probe.
    return this.outbox.lagMsWithin(deadlineAt);
  }

  async schema(deadlineAt: number): Promise<SchemaReadiness> {
    this.expected ??= expectedMigrations(migrationsFolder());
    const applied = await this.db.appliedMigrations(deadlineAt);
    const verdict = compareMigrations([...applied], this.expected);
    switch (verdict.state) {
      case 'current':
        return { state: 'CURRENT', applied: verdict.applied };
      case 'ahead':
        return { state: 'AHEAD', expected: verdict.expected, extra: verdict.extra };
      case 'none':
        return { state: 'NONE' };
      case 'behind':
        return {
          state: 'BEHIND',
          applied: verdict.applied,
          expected: verdict.expected,
          next: verdict.missing[0] ?? 'unknown',
        };
      case 'diverged':
        return { state: 'DIVERGED', reason: verdict.reason };
    }
  }
}
