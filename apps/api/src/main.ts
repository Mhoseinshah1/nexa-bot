import 'reflect-metadata';
import { isNexaError } from '@nexa/contracts';
import { createApiApp, startProcessRestartWatch } from './bootstrap.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import { createShutdownCoordinator } from './infrastructure/lifecycle/shutdown.js';
import { installProcessBackstop } from './infrastructure/lifecycle/process-backstop.js';

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
  // R11 A3: a role that is restarted over and over is reported once (see ProcessRestartWatch).
  const restartWatch = await startProcessRestartWatch(container, 'api');
  // A dropped promise is logged and survived; an uncaught exception is logged and exits.
  installProcessBackstop({
    role: 'api',
    logger: container.logger,
    exit: (code) => process.exit(code),
  });

  const { shutdown } = createShutdownCoordinator({
    name: 'api',
    logger: container.logger,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    exit: (code) => process.exit(code),
    close: async () => {
      // Nest first, so no new request is accepted and in-flight ones finish;
      // then the container, which owns the pool those requests are using.
      await app.close();
      // A clean stop is an operator's, not a crash: it must not count towards a storm.
      await restartWatch.stop();
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
