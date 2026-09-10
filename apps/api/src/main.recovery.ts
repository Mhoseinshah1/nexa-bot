import 'reflect-metadata';
import { isNexaError } from '@nexa/contracts';
import { resolveInstallationTenant } from './bootstrap.js';
import { createContainer } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import { startHeartbeat } from './infrastructure/lifecycle/heartbeat.js';
import { createShutdownCoordinator } from './infrastructure/lifecycle/shutdown.js';

/**
 * Process role: `recovery`.
 *
 * Executes a confirmed disaster recovery: the emergency backup, the quiesce, the
 * candidate restore, the validation, the cutover and the readiness check. Same
 * image, same module graph, a fourth `main` file — the container's `command`
 * chooses which one runs. There is no flag that turns this on inside another
 * process.
 *
 * WHY IT IS NOT THE WORKER. This loop QUIESCES the outbox relay and the
 * notification dispatcher, and both of those live in the worker. A loop that
 * shares an event loop with the things it is shutting down has to reason about
 * its own shutdown while it does so, and the one place that reasoning must be
 * simple is the place that renames the production database.
 *
 * It is also the only role that survives its own database being replaced. Every
 * process loses its connections at the cutover and reconnects — which works
 * because of the pool error listener (ADR-0028 § 3) — but this one has to keep
 * going across that moment and then write the row that says it happened.
 *
 * WHY IT IS NOT THE API. The obvious reason and the better one: an HTTP request
 * cannot outlive a restore, and a process serving the operator watching the
 * progress page must not be the process quiescing itself.
 *
 * IDLE IS THE NORMAL STATE. This process spends essentially all of its life
 * polling for a confirmed request that is not there. That is deliberate and it
 * is cheap: one indexed query per tick against a partial index over a handful of
 * states.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const container = createContainer(config, 'recovery');
  // The installation's tenant, for the same reason the worker and the monitor
  // need it: without it every operational event this role records takes the "no
  // tenant provisioned" branch and is silently dropped — and the events this
  // role records are the ones saying a restore of the whole database failed.
  await resolveInstallationTenant(container);

  /**
   * The heartbeat, and what it is allowed to claim.
   *
   * Three things, as the monitor's does: the process is alive, the database is
   * reachable, and the loop has made progress recently. The third is what a naive
   * heartbeat omits and is the one that matters, because a process whose every
   * tick throws still has a live timer.
   *
   * `isFresh` here reports that the LOOP is ticking, not that a recovery is
   * progressing — a single recovery can legitimately run for an hour, and the
   * thing that keeps its LEASE alive across that is the per-run heartbeat inside
   * the executor. Conflating the two would mean either a long restore reporting
   * the process dead, or a dead process reporting a healthy loop.
   */
  const heartbeat = startHeartbeat({
    path: config.RECOVERY_HEARTBEAT_PATH,
    intervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
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
      return container.recoveryExecutor.isFresh(container.clock.now().getTime());
    },
  });

  /**
   * Shutdown, and the one case this role has to get right.
   *
   * `container.shutdown()` stops the executor's TIMER. It deliberately does not
   * interrupt a recovery that is mid-flight: there is no safe point to stop at
   * between the two renames, and a process that abandoned one there would leave
   * the installation quiesced with a half-named pair of databases. So a recovery
   * in progress runs to its own terminal state or is taken over after its lease
   * expires — by FAILING it, never by adopting it.
   *
   * Which means SIGTERM during a cutover waits for the shutdown timeout and is
   * then killed. That is the correct trade: the alternative is a deliberate stop
   * in the middle of the only irreversible operation here, and the cutover
   * journal is what lets the next process work out where it got to.
   */
  const { shutdown } = createShutdownCoordinator({
    name: 'recovery',
    logger: container.logger,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    exit: (code) => process.exit(code),
    close: async () => {
      heartbeat.stop();
      await container.shutdown();
    },
  });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  container.recoveryExecutor.start();
  container.logger.info(
    { env: config.NODE_ENV, tickMs: config.RECOVERY_TICK_MS },
    'recovery executor running',
  );
}

main().catch((error: unknown) => {
  if (isNexaError(error) && error.kind === 'CONFIGURATION') {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
