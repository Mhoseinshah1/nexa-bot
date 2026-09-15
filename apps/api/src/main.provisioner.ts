import 'reflect-metadata';
import { isNexaError } from '@nexa/contracts';
import { resolveInstallationTenant } from './bootstrap.js';
import { createContainer } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import { startHeartbeat } from './infrastructure/lifecycle/heartbeat.js';
import { createShutdownCoordinator } from './infrastructure/lifecycle/shutdown.js';

/**
 * Process role: `provisioner`.
 *
 * Creates the services customers have paid for, on the panels their orders name. Same
 * image, same module graph, a fifth `main` file — the container's `command` chooses
 * which one runs. There is no second image and no flag that turns this on inside
 * another process.
 *
 * Why it is not the API. A provider create is an outbound HTTPS call to somebody
 * else's machine with a timeout measured in seconds. Run on the event loop that
 * answers the Telegram webhook, a fleet of slow panels becomes slow Telegram replies
 * and a queue of pool checkouts held by nobody's request. It would also mean every API
 * replica provisioning, and the process doing unattended outbound work with an
 * operator's panel credentials would be the one exposed to the internet.
 *
 * Why it is not the monitor. The monitor's own file gives the argument and it applies
 * in mirror: a monitor stuck on a hanging panel would delay notification delivery, so
 * the two were separated. A customer waiting for the configuration they bought must
 * not queue behind a sweep of every panel in the installation, and a sweep must not
 * wait behind a create. Different urgency, different failure isolation.
 *
 * Why it is not the worker. The worker's jobs are internal: read the outbox, send a
 * notification, sweep a table. This one dials third-party hosts with decrypted
 * credentials, and sharing a process would mean a wedged panel delays every
 * notification the installation owes.
 *
 * Shutdown is graceful: the timer stops, the tick in flight finishes persisting what
 * its provider call already did, and the heartbeat stops FIRST so a draining
 * provisioner is never reported as alive.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const container = createContainer(config, 'provisioner');
  // The installation's tenant, for the same reason the worker and the monitor need it:
  // the container resolves settings for the installation at boot, and the loop refuses
  // to invent a tenant id when there is none.
  await resolveInstallationTenant(container);

  /**
   * The signal the container's health check reads, and it proves three things.
   *
   * The process is alive (the heartbeat timer fires), the database is reachable (a
   * real round trip, not a cached answer), and the provisioning loop has made PROGRESS
   * recently. The third is the one a naive heartbeat omits and the one that matters: a
   * process whose timer still fires while every claim query throws is not provisioning
   * anything, and a file touched regardless would report it healthy for ever.
   *
   * There is no startup grace. Before the first successful tick this process has never
   * done its job, so it is not healthy and readiness does not pass. An installation
   * whose provisioner is broken must fail its release rather than report ready for the
   * first few minutes and then quietly stop creating the services people are paying
   * for.
   */
  const heartbeat = startHeartbeat({
    path: config.PROVISIONER_HEARTBEAT_PATH,
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
      // A disabled provisioner is a healthy process deliberately doing nothing. It
      // must not report itself unhealthy and be restarted for ever by the container
      // runtime — the operator turned it off on purpose. The same rule the monitor has.
      if (!config.PROVISIONER_ENABLED) return true;
      return container.provisionerLoop.iterationIsFresh(container.clock.now().getTime());
    },
  });

  const { shutdown } = createShutdownCoordinator({
    name: 'provisioner',
    logger: container.logger,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    exit: (code) => process.exit(code),
    close: async () => {
      heartbeat.stop();
      container.provisionerLoop.stop();
      await container.shutdown();
    },
  });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  if (config.PROVISIONER_ENABLED) {
    container.provisionerLoop.start();
    container.logger.info({ tickMs: config.PROVISIONER_TICK_MS }, 'provisioner started');
  } else {
    container.logger.warn(
      {},
      'provisioner is disabled; paid orders will not become services until it is enabled',
    );
  }

  container.logger.info({ env: config.NODE_ENV }, 'provisioner running');
}

main().catch((error: unknown) => {
  if (isNexaError(error) && error.kind === 'CONFIGURATION') {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
