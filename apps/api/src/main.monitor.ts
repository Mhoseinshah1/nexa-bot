import 'reflect-metadata';
import { isNexaError } from '@nexa/contracts';
import { resolveInstallationTenant } from './bootstrap.js';
import { createContainer } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import { startHeartbeat } from './infrastructure/lifecycle/heartbeat.js';
import { createShutdownCoordinator } from './infrastructure/lifecycle/shutdown.js';

/**
 * Process role: `monitor`.
 *
 * Probes panels on a schedule and writes their health. Same image, same module
 * graph, a third `main` file — the container's `command` chooses which one
 * runs. There is no second image and no flag that turns this on inside another
 * process.
 *
 * Why it is not an interval in the API. A probe is an outbound HTTPS call to
 * somebody else's machine, with a timeout measured in seconds. Run on the event
 * loop that answers the Telegram webhook, a fleet of slow panels becomes slow
 * Telegram replies and a queue of pool checkouts held by nobody's request. It
 * would also mean every API replica probing — the bounds are in the database
 * and would hold, but the process doing unattended outbound work would be the
 * one exposed to the internet.
 *
 * Why it is not the worker. The worker's jobs are internal: read the outbox,
 * send a notification, sweep a table. This one dials third-party hosts, and the
 * two want different failure isolation, different shutdown behaviour and
 * different scaling. Sharing a process would also mean a monitor stuck on a
 * hanging panel delays notification delivery, which is how a health check
 * becomes an outage.
 *
 * Shutdown is graceful: the timer stops, the tick in flight finishes writing
 * what its probes already spent budget on, and the heartbeat stops FIRST so a
 * draining monitor is never reported as alive.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const container = createContainer(config, 'monitor');
  // The installation's tenant, for the same reason the worker needs it: the
  // container resolves settings for the installation at boot.
  await resolveInstallationTenant(container);

  /**
   * The signal the container's health check reads, and it proves three things.
   *
   * The process is alive (the heartbeat timer fires), the database is reachable
   * (a real round trip, not a cached answer), and the monitoring loop has
   * COMPLETED an iteration recently. The third is the one a naive heartbeat
   * omits, and it is the one that matters: a process whose timer still fires
   * while every tick throws is not monitoring anything, and a file touched
   * regardless would report it healthy for ever.
   *
   * `startHeartbeat` writes the file only when `check` returns true, so a
   * monitor whose loop has died goes stale rather than lying — and
   * `iterationIsFresh` is keyed on tick COMPLETION, so a tick wedged on a
   * hanging query does not keep the file fresh either.
   */
  const heartbeat = startHeartbeat({
    path: config.PANEL_MONITOR_HEARTBEAT_PATH,
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
      // A disabled monitor is a healthy process that is deliberately doing
      // nothing. It must not report itself unhealthy and be restarted for ever
      // by the container runtime — the operator turned it off on purpose.
      if (!config.PANEL_MONITOR_ENABLED) return true;
      return container.panelMonitor.iterationIsFresh(container.clock.now().getTime());
    },
  });

  const { shutdown } = createShutdownCoordinator({
    name: 'monitor',
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

  if (config.PANEL_MONITOR_ENABLED) {
    container.panelMonitor.start();
    container.logger.info(
      {
        tickMs: config.PANEL_MONITOR_TICK_MS,
        batchSize: config.PANEL_MONITOR_BATCH_SIZE,
        concurrency: config.PANEL_MONITOR_CONCURRENCY,
        healthyIntervalMs: config.PANEL_MONITOR_HEALTHY_INTERVAL_MS,
      },
      'panel health monitor started',
    );
  } else {
    container.logger.warn(
      {},
      'panel health monitor is disabled; panel health will only change when an operator tests a connection',
    );
  }

  container.logger.info({ env: config.NODE_ENV }, 'monitor running');
}

main().catch((error: unknown) => {
  if (isNexaError(error) && error.kind === 'CONFIGURATION') {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
