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
 * Runs the outbox relay, the retention sweeps, the notification dispatcher and
 * the scheduled backup. Provisioning, reporting projections and broadcasts join
 * them in later phases. Same image, same module graph, different entrypoint —
 * so splitting per-queue deployments later is a config change, not a rewrite.
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
      } catch {
        return false;
      }
      // "The process exists" is not the claim this file is making. When the
      // scheduler is enabled it is part of the worker's job, and a scheduler
      // whose ticks are all throwing has a live timer and does nothing — which
      // is precisely the shape of failure an unattended backup has to be able
      // to report rather than sit quietly in.
      if (config.BACKUP_SCHEDULE_ENABLED && !container.backupScheduler.isFresh(Date.now())) {
        return false;
      }
      return true;
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

  // The scheduled backup. In the worker rather than a role of its own: it is
  // one subprocess a day, it takes a database lock rather than an outbound
  // budget, and the monitor's separate role exists because unattended calls to
  // third-party panels are a different risk from anything here.
  //
  // Two replicas both running this is the normal case on a rolling update, and
  // is safe by construction: the lock is a partial unique index, so the second
  // one is told BUSY by PostgreSQL rather than by any agreement between them.
  if (config.BACKUP_SCHEDULE_ENABLED) {
    container.backupScheduler.start();
    container.logger.info(
      { intervalMs: config.BACKUP_INTERVAL_MS, tickMs: config.BACKUP_TICK_MS },
      'backup scheduler started',
    );
  } else {
    container.logger.warn(
      {},
      'the backup scheduler is disabled; no backup will be taken unless one is run by hand',
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
