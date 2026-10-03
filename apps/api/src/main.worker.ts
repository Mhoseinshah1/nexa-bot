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
        // HF-A7: support's staged reply files. No flag: the bytes it clears count against the
        // tenant's staging bound, and a stalled sweep would refuse support's next file.
        ['ticket-reply-file-sweeper', true, () => container.ticketReplyFileSweeper.isFresh(now)],
        // The lane that closes an unpaid payment and the order it was against.
        // No flag: a payment nothing expires is the defect it exists to close, and an
        // installation that could switch it off would be one whose orders say they
        // are awaiting payment for ever. A pass that finds nothing still counts as
        // progress — see `PaymentExpiryLoop`, where "nothing was due" is the healthy
        // answer most of the time.
        ['payment-expiry', true, () => container.paymentExpiryLoop.isFresh(now)],
        // The external payment gateway lane (WP11A). No flag: an attempt nobody creates
        // or asks about is a customer who paid and was never credited, and silence is
        // exactly what a stalled lane looks like.
        ['gateway-payments', true, () => container.gatewayPaymentLoop.isFresh(now)],
        // Package FX: the central exchange rate's refresh. No flag on the LOOP: a pass
        // reads the feature inside and does nothing while it is off, so a stalled lane is
        // visible whatever an operator has switched on. Its failure mode is a quote that
        // silently goes stale and then refuses every central-rate invoice.
        ['fx-refresh', true, () => container.fxRefreshLoop.isFresh(now)],
        // The lane that warns a customer before their service runs out of days or
        // traffic. No flag, and for the reason the two either side of it have none:
        // the alternative to warning them is finding out when it has already
        // happened, and an installation that could switch it off would be one whose
        // customers are told nothing until their configuration stops working. Its
        // failure mode is silence, so it is health-checked rather than trusted.
        ['service-reminders', true, () => container.serviceReminderLoop.isFresh(now)],
        // WP-A9: pending-payment and wallet low-balance reminders. Always running — each
        // sweep reads its own flag inside its transaction and does nothing when it is off —
        // so a stalled loop is visible whatever an operator has switched on.
        ['customer-reminders', true, () => container.customerReminderLoop.isFresh(now)],
        // Round N, C1: the lane that starts and completes campaigns on their window. No flag:
        // a campaign that never reads ACTIVE or COMPLETED is an operator told the wrong
        // thing, and silence is what a stalled lane looks like. Its prices do not depend on
        // it (the rules carry their own window), which is why it is watched, not trusted.
        ['campaign-schedule', true, () => container.campaignScheduleLoop.isFresh(now)],
        // Telegram message-state retention. No flag: it bounds two tables every chat grows.
        [
          'telegram-message-retention',
          true,
          () => container.telegramMessageRetentionLoop.isFresh(now),
        ],
        // Round P: the command-menu sync lane. No flag: a menu nobody registers is a bot
        // whose customers type what they should be able to tap, and silence is what a
        // stalled lane looks like. The menu is a convenience, so it is watched, not trusted.
        ['bot-command-sync', true, () => container.botCommandSyncLoop.isFresh(now)],
        // The lane that tells a customer something they did not ask for. No flag, for
        // the same reason as the line above: before Phase 4H an operator's rejection and
        // the expiry sweep both happened while the customer was not looking and nothing
        // told them, and an installation that could switch this off would be one that
        // silently went back to that. Its failure mode is the dispatcher's — silence
        // that looks exactly like nothing being wrong — so it is health-checked rather
        // than trusted.
        ['customer-notifications', true, () => container.customerNotificationLoop.isFresh(now)],
        // Round N: the broadcast lane. No flag: a confirmed broadcast nobody sends is a
        // report that says "sending" for ever, and silence is what a stalled lane looks like.
        ['broadcasts', true, () => container.broadcastLoop.isFresh(now)],
        // Round N: and the mass-operation lane, for the same reason.
        ['bulk-operations', true, () => container.bulkOperationLoop.isFresh(now)],
        // The administrators' receipt push (ADR-0031). No flag, for the customer lane's
        // reason: a receipt nobody is told about is a customer waiting on a reviewer who
        // does not know, and silence is exactly what a stalled lane looks like.
        ['receipt-review-push', true, () => container.receiptReviewPushLoop.isFresh(now)],
        // WP-A4: the operations log group's checks and topics. No flag, for the reason the
        // dispatcher below is watched: a group nobody checks is a group that silently stops
        // receiving the reports, and the symptom is silence.
        ['ops-group', true, () => container.opsGroupMaintainer.isFresh(now)],
        [
          'notification-dispatcher',
          config.NOTIFICATION_DISPATCH_ENABLED,
          () => container.notificationDispatcher.isFresh(now),
        ],
        // Always running since spec §13.2: whether a backup is TAKEN is a setting read on
        // every tick, so a stalled loop is visible whatever the schedule says. Fresh from
        // `start()` for one slack window, and an immediate first tick — so readiness no
        // longer waits on a first tick a whole `BACKUP_TICK_MS` away (spec §14).
        ['backup-scheduler', true, () => container.backupScheduler.isFresh(now)],
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
  // HF-A7: and support's reply files Telegram never took, once they are past retention.
  container.ticketReplyFileSweeper.start();
  // And the payment/order expiry lane. OQ-4C-01's answer: until this release the
  // deadline a customer was shown was only ever a refusal, so a month-old order still
  // read as awaiting payment and an operator could not tell it from this morning's.
  container.paymentExpiryLoop.start();
  // And the external payment gateway lane (WP11A): creates provider invoices and asks the
  // provider what happened, outside every transaction, never while Telegram waits.
  container.gatewayPaymentLoop.start();
  // Package FX: and the exchange-rate refresh, outside every transaction, primary then
  // fallback, under a lease so two replicas do not both dial.
  container.fxRefreshLoop.start();
  // And the reminder lane. Nothing here dials a panel: both halves read columns
  // `SYNC_USAGE` and the commercial actions already maintain.
  container.serviceReminderLoop.start();
  // WP-A9: and the reminders that are not about a service — a payment about to lapse, a
  // wallet below its threshold. Both only enqueue; the lane below sends.
  container.customerReminderLoop.start();
  // Round N, C1: and the campaign lane, which moves a campaign along its own window.
  container.campaignScheduleLoop.start();
  // And the retention of the Telegram messages edited in place (docs/telegram-retention.md):
  // presentation rows nothing live names any more, never business truth.
  container.telegramMessageRetentionLoop.start();
  // Round P: and the command-menu sync lane — per bot, by digest, with back-off.
  container.botCommandSyncLoop.start();
  // And the customer notification lane. `docs/phase4h-audit.md` §1 measured what it
  // replaces: exactly one thing could be said to a customer who was not looking.
  container.customerNotificationLoop.start();
  // Round N: and the broadcast lane — frozen recipients, paced per bot, at most once.
  container.broadcastLoop.start();
  // And the mass-operation lane: one item, one transaction, exactly once.
  container.bulkOperationLoop.start();
  // And the administrators' receipt push: a new card-to-card receipt, to every Telegram
  // administrator who may decide it (WP10 follow-up §3, ADR-0031).
  container.receiptReviewPushLoop.start();
  // And the operations log group: checks a newly connected or broken group, creates the
  // topics Nexa owns in it, and retries the preserved reports once it is healthy (WP-A4).
  container.opsGroupMaintainer.start();

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
  //
  // ALWAYS started (spec §13.2). Whether it takes backups, and how often, is the
  // Web Admin's setting, read on every tick; BACKUP_SCHEDULE_ENABLED and
  // BACKUP_INTERVAL_MS are the default when the Web Admin has set nothing. A
  // worker booted with the environment saying "off" still starts backing up the
  // tick after an operator switches it on, with no restart.
  container.backupScheduler.start();
  container.logger.info(
    {
      environmentDefault: {
        enabled: config.BACKUP_SCHEDULE_ENABLED,
        intervalMs: config.BACKUP_INTERVAL_MS,
      },
      tickMs: config.BACKUP_TICK_MS,
    },
    'backup scheduler started; the schedule is read from the backup settings on every tick',
  );

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
