import 'reflect-metadata';
import { isNexaError } from '@nexa/contracts';
import { createContainer } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';

/**
 * Process role: `worker`.
 *
 * Runs the outbox relay and (from Phase 2 onward) the queue consumers:
 * provisioning, notification delivery, reporting projections, broadcasts and
 * backups. Same image, same module graph, different entrypoint — so splitting
 * per-queue deployments later is a config change, not a rewrite.
 *
 * Shutdown is graceful: the relay stops claiming new work and the current batch
 * either completes or is left unpublished for the next process to redeliver.
 * An outbox message is never lost, only ever redelivered.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const container = createContainer(config, 'worker');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    container.logger.info({ signal }, 'Shutting down worker');
    await container.shutdown();
    process.exit(0);
  };

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

  // Housekeeping the login throttle cannot do for itself: it resets an expired
  // row only when that exact subject returns, so distinct usernames and
  // rotating addresses would accumulate for good.
  container.throttleSweeper.start();

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
