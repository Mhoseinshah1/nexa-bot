import 'reflect-metadata';
import { isNexaError } from '@nexa/contracts';
import { createApiApp } from './bootstrap.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import { createShutdownCoordinator } from './infrastructure/lifecycle/shutdown.js';

/**
 * Process role: `api`.
 *
 * Serves the admin API, the Telegram webhook and (later) gateway callbacks.
 * It does NOT run queue consumers or the outbox relay — those are the `worker`
 * role, started from the same image with a different entrypoint. A broadcast
 * saturating the event loop must not be able to take the webhook down with it.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const { app, container } = await createApiApp(config);

  const { shutdown } = createShutdownCoordinator({
    name: 'api',
    logger: container.logger,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    exit: (code) => process.exit(code),
    close: async () => {
      // Nest first, so no new request is accepted and in-flight ones finish;
      // then the container, which owns the pool those requests are using.
      await app.close();
      await container.shutdown();
    },
  });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.API_PORT, host: config.API_HOST });
  container.logger.info(
    { port: config.API_PORT, host: config.API_HOST, env: config.NODE_ENV },
    'api listening',
  );
}

main().catch((error: unknown) => {
  // Configuration failures print every problem at once and exit non-zero, so a
  // misconfigured deployment is diagnosed in one pass.
  if (isNexaError(error) && error.kind === 'CONFIGURATION') {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
