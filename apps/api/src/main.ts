import 'reflect-metadata';
import { isNexaError } from '@nexa/contracts';
import { createApiApp, startProcessRestartWatch } from './bootstrap.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import { createShutdownCoordinator } from './infrastructure/lifecycle/shutdown.js';
import { installProcessBackstop } from './infrastructure/lifecycle/process-backstop.js';
import { startLivenessWatchdog } from './infrastructure/lifecycle/liveness-watchdog.js';

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

  /*
   * R12 F2: the API has no heartbeat file — its container check asks `/health/ready` — but a
   * BLOCKED event loop is the hang that check can only mark unhealthy, and Docker never
   * restarts an unhealthy container. So the event loop itself is watched: a timer touches
   * the watchdog every interval, and if N intervals pass without one the process is asked
   * to exit and, if it cannot (the loop is blocked), killed — and Docker restarts it.
   * Deliberately NOT the database: an API that cannot reach PostgreSQL is reported not
   * ready and keeps answering; restarting it would fix nothing.
   */
  const watchdog =
    config.HEARTBEAT_EXIT_AFTER_MISSED > 0
      ? startLivenessWatchdog({
          role: 'api',
          maxSilenceMs: config.HEARTBEAT_EXIT_AFTER_MISSED * config.WORKER_HEARTBEAT_INTERVAL_MS,
          graceMs: config.WORKER_HEARTBEAT_INTERVAL_MS,
          logger: container.logger,
          exit: (code) => process.exit(code),
        })
      : null;
  watchdog?.touch();
  const eventLoopBeat = setInterval(() => watchdog?.touch(), config.WORKER_HEARTBEAT_INTERVAL_MS);
  eventLoopBeat.unref();

  const { shutdown } = createShutdownCoordinator({
    name: 'api',
    logger: container.logger,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    exit: (code) => process.exit(code),
    close: async () => {
      // A draining API goes quiet on purpose; it must not be killed for it.
      clearInterval(eventLoopBeat);
      watchdog?.stop();
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
