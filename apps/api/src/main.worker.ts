import 'reflect-metadata';
import { isNexaError } from '@nexa/contracts';
import { resolveInstallationTenant } from './bootstrap.js';
import { createContainer } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import { startHeartbeat } from './infrastructure/lifecycle/heartbeat.js';
import { stalledLoops, type LoopHealth } from './infrastructure/lifecycle/loop-health.js';
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
      // "The process exists" is not the claim this file is making, and until
      // now it very nearly was: a database round trip plus the backup
      // scheduler, while the three loops that do most of this role's work —
      // the relay, the two sweepers and the dispatcher — were invisible to it.
      //
      // Each is consulted only when it is actually running, so a disabled
      // relay or dispatcher is not reported as a broken one. The sweepers have
      // no flag; they always run.
      //
      // The dispatcher is the one that matters most. It drains the queue by
      // which this installation reports anything being wrong, so a dispatcher
      // that is alive and achieving nothing means the system has lost its
      // ability to say it is broken — and the only symptom is silence, which
      // looks exactly like nothing being wrong.
      //
      // The aggregation is `stalledLoops`, in its own file, because as a closure
      // here it could not be called by any test: replacing its `filter` with an
      // empty array — a worker that reports healthy whatever its loops are
      // doing — left the whole suite green.
      const now = container.clock.now().getTime();
      const loops: readonly LoopHealth[] = [
        ['relay', config.OUTBOX_RELAY_ENABLED, () => container.relay.isFresh(now)],
        // No flag: the sweepers always run.
        ['throttle-sweeper', true, () => container.throttleSweeper.isFresh(now)],
        ['session-sweeper', true, () => container.sessionSweeper.isFresh(now)],
        // The backup run table's retention. No flag: it bounds a table that
        // gains rows from manual backups whether the schedule is on or not.
        ['backup-run-sweeper', true, () => container.backupRunSweeper.isFresh(now)],
        // The recovery request table's retention. No flag, for the same reason as
        // the line above: it bounds a table that gains rows whenever an operator
        // uploads an archive, which has nothing to do with any schedule.
        ['recovery-request-sweeper', true, () => container.recoveryRequestSweeper.isFresh(now)],
        // The lane that closes an unpaid payment and the order it was against.
        // No flag: a payment nothing expires is the defect it exists to close, and an
        // installation that could switch it off would be one whose orders say they
        // are awaiting payment for ever. A pass that finds nothing still counts as
        // progress — see `PaymentExpiryLoop`, where "nothing was due" is the healthy
        // answer most of the time.
        ['payment-expiry', true, () => container.paymentExpiryLoop.isFresh(now)],
        // The lane that tells a customer something they did not ask for. No flag, for
        // the same reason as the line above: before Phase 4H an operator's rejection and
        // the expiry sweep both happened while the customer was not looking and nothing
        // told them, and an installation that could switch this off would be one that
        // silently went back to that. Its failure mode is the dispatcher's — silence
        // that looks exactly like nothing being wrong — so it is health-checked rather
        // than trusted.
        ['customer-notifications', true, () => container.customerNotificationLoop.isFresh(now)],
        [
          'notification-dispatcher',
          config.NOTIFICATION_DISPATCH_ENABLED,
          () => container.notificationDispatcher.isFresh(now),
        ],
        [
          'backup-scheduler',
          config.BACKUP_SCHEDULE_ENABLED,
          () => container.backupScheduler.isFresh(now),
        ],
      ];
      const stalled = stalledLoops(loops);
      if (stalled.length > 0) {
        // Named, because "the worker is unhealthy" sends an operator looking at
        // the whole process when one loop is the answer.
        container.logger.error({ stalled }, 'worker loops have stopped making progress');
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
  // And the backup run table's, whose policy is ADR-0027. Started here beside the
  // others rather than with the backup scheduler: the rows it bounds exist on an
  // installation with the schedule switched off too.
  container.backupRunSweeper.start();
  container.recoveryRequestSweeper.start();
  // And the payment/order expiry lane. OQ-4C-01's answer: until this release the
  // deadline a customer was shown was only ever a refusal, so a month-old order still
  // read as awaiting payment and an operator could not tell it from this morning's.
  container.paymentExpiryLoop.start();
  // And the customer notification lane. `docs/phase4h-audit.md` §1 measured what it
  // replaces: exactly one thing could be said to a customer who was not looking.
  container.customerNotificationLoop.start();

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
