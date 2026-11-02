import 'reflect-metadata';
import { isNexaError } from '@nexa/contracts';
import { loopStallReporterFor, resolveInstallationTenant } from './bootstrap.js';
import { createContainer } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import { startHeartbeat } from './infrastructure/lifecycle/heartbeat.js';
import { createShutdownCoordinator } from './infrastructure/lifecycle/shutdown.js';
import { installProcessBackstop } from './infrastructure/lifecycle/process-backstop.js';
import { stalledAfterGrace } from './modules/platform/opslog/application/loop-stall-reporter.js';

/** The executor's name in the operations log: `job.loop_stalled:migration-executor`. */
const MIGRATION_EXECUTOR_LOOP = 'migration-executor';

/**
 * Process role: `migration`.
 *
 * Runs the Mirza `.nxpkg` Fresh Migration (`docs/legacy-migration/nxpkg-importer.md` §4):
 * verifies an uploaded package, runs its dry run, and — once the owner has approved THAT dry
 * run's digest — runs the existing legacy importer over it, archives its history, reconciles,
 * writes the final report and requests the standard backup. Same image, same module graph,
 * its own `main`; the Web Admin only records what this role is asked to do.
 *
 * WHY ITS OWN ROLE, the recovery role's two reasons applied once more. An HTTP request cannot
 * outlive an import that writes a whole tenant's customers, and a process serving the operator
 * who watches the progress page must not be the process doing the work. And the worker's
 * outbox relay and notification dispatcher must not queue behind a job that can take an hour.
 *
 * IDLE IS THE NORMAL STATE, and OFF is too: with `LEGACY_MIGRATION_ENABLED=false` (the
 * default) the loop ticks, reports healthy and claims nothing.
 *
 * A CRASH IS RESUMED. The lease (`claimed_by`, `lease_until`) is heartbeated while a step
 * runs; a lease that expires is released and the next tick — here or on another replica —
 * runs the step again, and an apply RESUMES the importer's own run. See
 * `LegacyMigrationExecutor`.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const container = createContainer(config, 'migration');
  // A dropped promise is logged and survived; an uncaught exception is logged and exits.
  installProcessBackstop({
    role: 'migration',
    logger: container.logger,
    exit: (code) => process.exit(code),
  });
  // The installation's tenant and the imported Recovery Kit keys, as every role loads them:
  // the package key is sealed under this installation's keyring.
  await resolveInstallationTenant(container);

  /*
   * Every background role reports its stalled loop to the operations group (FIX-03, batch
   * 2026-10-10), this one included: an executor whose tick throws every time is a package the
   * operator approved and a progress page that will never move. The grace is the same three
   * ticks the recovery role allows, and a disabled loop still ticks, so it is never stalled.
   */
  const loopStalls = loopStallReporterFor(container, 'migration');
  let executorStartedAt: number | null = null;

  /**
   * The heartbeat: alive, the database answers, and the LOOP has ticked recently. A step in
   * flight counts as fresh — its own lease heartbeat is what proves the step alive.
   */
  const heartbeat = startHeartbeat({
    path: config.LEGACY_MIGRATION_HEARTBEAT_PATH,
    intervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
    // R12 F2: N missed beats and the role leaves, so Docker restarts it (liveness-watchdog.ts).
    exitAfterMissed: config.HEARTBEAT_EXIT_AFTER_MISSED,
    role: 'migration',
    now: () => container.clock.now().getTime(),
    logger: container.logger,
    check: async () => {
      try {
        await container.database.withClient((client) => client.query('SELECT 1'), {
          deadlineAt: Date.now() + config.WORKER_HEARTBEAT_INTERVAL_MS,
        });
      } catch {
        return false;
      }
      const now = container.clock.now().getTime();
      const fresh = container.migrationExecutor.isFresh(now);
      // Not awaited, and it never throws: reporting must not slow or fail the heartbeat.
      void loopStalls.observe([
        {
          name: MIGRATION_EXECUTOR_LOOP,
          stalled: stalledAfterGrace({
            fresh,
            startedAtMs: executorStartedAt,
            nowMs: now,
            graceMs: config.LEGACY_MIGRATION_TICK_MS * 3,
          }),
        },
      ]);
      return fresh;
    },
  });

  /**
   * Shutdown stops the TIMER; a step in flight runs to its end or is resumed after its lease
   * expires. There is nothing to roll back: every write the step made is idempotent and the
   * next attempt continues from the phase bookmark.
   */
  const { shutdown } = createShutdownCoordinator({
    name: 'migration',
    logger: container.logger,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    exit: (code) => process.exit(code),
    close: async () => {
      heartbeat.stop();
      container.migrationExecutor.stop();
      await container.shutdown();
    },
  });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  container.migrationExecutor.start();
  executorStartedAt = container.clock.now().getTime();
  if (!config.LEGACY_MIGRATION_ENABLED) {
    container.logger.warn(
      {},
      'legacy migration is disabled (LEGACY_MIGRATION_ENABLED=false); no package will be processed',
    );
  }
  container.logger.info(
    { env: config.NODE_ENV, tickMs: config.LEGACY_MIGRATION_TICK_MS },
    'legacy migration executor running',
  );
}

main().catch((error: unknown) => {
  if (isNexaError(error) && error.kind === 'CONFIGURATION') {
    console.error(error.message);
  } else if (
    error instanceof Error &&
    typeof (error as { syscall?: unknown }).syscall === 'string'
  ) {
    // A filesystem or socket error's message names a path (under LEGACY_MIGRATION_WORK_DIR):
    // its type and code say what failed without it.
    const code = (error as { code?: unknown }).code;
    console.error(`${error.name} ${typeof code === 'string' ? code : ''}`.trim());
  } else {
    console.error(error);
  }
  process.exit(1);
});
