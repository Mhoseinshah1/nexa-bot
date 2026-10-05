import 'reflect-metadata';
import { isNexaError } from '@nexa/contracts';
import { resolveInstallationTenant } from './bootstrap.js';
import { createContainer } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import { startHeartbeat } from './infrastructure/lifecycle/heartbeat.js';
import { createShutdownCoordinator } from './infrastructure/lifecycle/shutdown.js';

/**
 * TB5 — the `assistant` process role (ADR-0034 §7): the ONLY role that calls an AI provider in
 * the background. One image, one module graph; this file chooses what runs.
 *
 * Its heartbeat proves what the monitor's and the provisioner's do — alive, database
 * reachable, and the loop has completed a pass recently. A tenant whose support AI is `OFF`
 * simply has no jobs: the loop still passes and the role stays healthy.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const container = createContainer(config, 'assistant');
  await resolveInstallationTenant(container);

  const heartbeat = startHeartbeat({
    path: config.ASSISTANT_HEARTBEAT_PATH,
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
      return container.assistantLoop.isFresh(container.clock.now().getTime());
    },
  });

  const { shutdown } = createShutdownCoordinator({
    name: 'assistant',
    logger: container.logger,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    exit: (code) => process.exit(code),
    close: async () => {
      heartbeat.stop();
      await container.assistantLoop.stop();
      await container.shutdown();
    },
  });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  container.assistantLoop.start();
  container.logger.info({ env: config.NODE_ENV }, 'assistant running');
}

main().catch((error: unknown) => {
  if (isNexaError(error) && error.kind === 'CONFIGURATION') {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
