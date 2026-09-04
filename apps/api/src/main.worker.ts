import 'reflect-metadata';
import { isNexaError } from '@nexa/contracts';
import { resolveInstallationTenant } from './bootstrap.js';
import { createContainer } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import { startHeartbeat } from './infrastructure/lifecycle/heartbeat.js';
import { createShutdownCoordinator } from './infrastructure/lifecycle/shutdown.js';

/**
 * Process role: `worker`.
 *
 * Runs the outbox relay, the retention sweeps and the notification dispatcher.
 * Provisioning, reporting projections, broadcasts and backups join them in later
 * phases. Same image, same module graph, different entrypoint — so splitting
 * per-queue deployments later is a config change, not a rewrite.
 *
 * Shutdown is graceful: the relay stops claiming new work and the current batch
 * either completes or is left unpublished for the next process to redeliver.
 * An outbox message is never lost, only ever redelivered.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const container = createContainer(config, 'worker');
  // The worker needs the installation's tenant for the same reason the API does,
  // and for one more: the notification dispatcher runs for the installation
  // while its rate ceiling is a tenant setting.
  await resolveInstallationTenant(container);

  // The same coordinator as the API. The worker's own boolean guard was the
  // better half of the two and still had no deadline; one policy is easier to
  // reason about than two that differ in which failure they survive.
  // The signal the container's health check reads. Written only after a real
  // round trip to the database, so "healthy" means the worker can do its job,
  // not merely that its process exists. Stopped first on shutdown, so a worker
  // that is draining is not reported as alive after it has stopped taking
  // work.
  const heartbeat = startHeartbeat({
    path: config.WORKER_HEARTBEAT_PATH,
    intervalMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
    now: () => container.clock.now().getTime(),
    logger: container.logger,
    check: async () => {
      try {
        await container.database.withClient((client) => client.query('SELECT 1'), {
          deadlineAt: Date.now() + config.WORKER_HEARTBEAT_INTERVAL_MS,
        });
        return true;
      } catch {
        return false;
      }
    },
  });

  const { shutdown } = createShutdownCoordinator({
    name: 'worker',
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

  if (config.OUTBOX_RELAY_ENABLED) {
    container.relay.start();
    container.logger.info(
      { pollIntervalMs: config.OUTBOX_RELAY_POLL_INTERVAL_MS },
      'outbox relay started',
    );
  } else {
    container.logger.warn({}, 'outbox relay is disabled; domain events will not be published');
  }

  // Housekeeping neither table does for itself. The throttle resets an expired
  // row only when that exact subject returns, so distinct usernames and
  // rotating addresses accumulate for good; sessions are only ever marked
  // revoked, never removed, so one valid credential signed in repeatedly grows
  // the table for the life of the installation.
  container.throttleSweeper.start();
  container.sessionSweeper.start();

  // Notification delivery. A poller rather than an outbox consumer, because the
  // relay runs its consumers inside the claim transaction and a send must not
  // hold one open across a call to Telegram (ADR-0018).
  if (config.NOTIFICATION_DISPATCH_ENABLED) {
    container.notificationDispatcher.start();
    container.logger.info(
      {
        pollIntervalMs: config.NOTIFICATION_DISPATCH_INTERVAL_MS,
        transport: container.notificationTransport.kind,
      },
      'notification dispatcher started',
    );
  } else {
    container.logger.warn(
      {},
      'notification dispatcher is disabled; operational notifications will queue and not send',
    );
  }

  container.logger.info({ env: config.NODE_ENV }, 'worker running');
}

main().catch((error: unknown) => {
  if (isNexaError(error) && error.kind === 'CONFIGURATION') {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
