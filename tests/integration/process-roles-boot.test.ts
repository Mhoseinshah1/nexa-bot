import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActorContext } from '@nexa/contracts';
import { createApiApp, resolveInstallationTenant } from '../../apps/api/src/bootstrap';
import { createContainer, type Container, type ProcessRole } from '../../apps/api/src/container';
import type { AppConfig } from '../../apps/api/src/infrastructure/config/config.schema';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  testConfig,
} from './harness';

/**
 * Every process role's composition root, booted the way its `main*.ts` boots it, and one
 * pass of every loop that role runs — v0.8.2 hotfix.
 *
 * v0.8.2's worker crash-looped on a bug no test could see: `FxRefreshLoop` was only ever
 * driven with plain-object loggers, and no test built the WORKER from `createContainer`
 * and ran its loops with the container's own logger against a failing source. This does:
 * the FX sources answer 403 or refuse the connection, the loop backs off through the real
 * logger, and nothing may throw, reject, or reach `unhandledRejection`.
 *
 * Loops are driven through their own `tick()` (or the one method their timer calls),
 * never by waiting on a timer, so a pass is deterministic and a failure names its loop.
 */

type Tick = readonly [name: string, run: () => Promise<unknown>];

/** The private tick a timer calls, for the three loops that do not expose it. */
const privateTick = (loop: unknown) => () => (loop as { tick(): Promise<unknown> }).tick();

/** The Docker-name trick `fx-stars.test.ts` explains: the fakes' literal is not the data host. */
function byName(connectionString: string): string {
  const url = new URL(connectionString);
  if (url.hostname === '127.0.0.1') url.hostname = 'localhost';
  return url.toString();
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return address.port;
}

/** A port nothing listens on: bound, read, and released, so a dial is refused. */
async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('every process role boots and survives one pass of each of its loops', () => {
  let forbidden: Server;
  let telegram: Server;
  let forbiddenHits: string[] = [];
  let config: AppConfig;
  let workDir: string;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeAll(async () => {
    // What Nobitex answered the production server: 403, every time.
    forbidden = createServer((request: IncomingMessage, response: ServerResponse) => {
      forbiddenHits.push(request.url ?? '');
      response.writeHead(403, { 'content-type': 'text/html' });
      response.end('<html>403 Forbidden</html>');
    });
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: true }));
      });
    });
    const [forbiddenPort, telegramPort, refusedPort] = await Promise.all([
      listen(forbidden),
      listen(telegram),
      closedPort(),
    ]);
    workDir = await mkdtemp(join(tmpdir(), 'nexa-roles-boot-'));
    const defaults = testConfig();
    const forbiddenBase = `http://127.0.0.1:${String(forbiddenPort)}`;
    config = testConfig({
      DATABASE_URL: byName(defaults.DATABASE_URL),
      REDIS_URL: byName(defaults.REDIS_URL),
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(telegramPort)}`,
      // The primary answers 403; the fallback refuses the connection (a network error);
      // the Round 8 sources answer 403 too, so no source can rescue the pass.
      FX_NOBITEX_BASE_URL: forbiddenBase,
      FX_WALLEX_BASE_URL: `http://127.0.0.1:${String(refusedPort)}`,
      FX_TABDEAL_BASE_URL: forbiddenBase,
      FX_BITPIN_BASE_URL: forbiddenBase,
      FX_RAMZINEX_BASE_URL: forbiddenBase,
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      BACKUP_WORK_DIR: join(workDir, 'backups'),
      RECOVERY_WORK_DIR: join(workDir, 'recovery'),
      LEGACY_MIGRATION_WORK_DIR: join(workDir, 'legacy-migration'),
    });
    await migrateOnce(config.DATABASE_URL);
    process.on('unhandledRejection', onUnhandled);
  }, 120_000);

  afterAll(async () => {
    process.off('unhandledRejection', onUnhandled);
    for (const server of [forbidden, telegram]) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(workDir, { recursive: true, force: true });
  });

  /** As `main*.ts`: build the root, then resolve the installation (starts the key reload). */
  async function boot(role: ProcessRole, seedFirst: boolean): Promise<Container> {
    const container = createContainer(config, role);
    if (seedFirst) {
      await resetDatabase(container.database.db);
      await seed(container.database.db, container.cipher);
    }
    await resolveInstallationTenant(container);
    if (container.installationTenantId === null) container.setInstallationTenant(tenantA.tenantId);
    return container;
  }

  /** One pass of each, in order; every one must resolve. Returns the failures by name. */
  async function passAll(ticks: readonly Tick[]): Promise<string[]> {
    const failed: string[] = [];
    for (const [name, run] of ticks) {
      try {
        await run();
      } catch (error) {
        failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // `unhandledRejection` fires after the microtask queue drains.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return failed;
  }

  it('worker: every loop main.worker.ts starts, including FX backing off on a 403 and a refused connection', async () => {
    const container = await boot('worker', true);
    try {
      const owner: ActorContext = adminActorFor(
        await createAdmin(container, tenantA, { username: 'owner', roleKeys: ['owner'] }),
      );
      // The central rate ON, so the FX pass dials and fails rather than reporting DISABLED.
      const flag = await container.featureFlagResolver.resolve(tenantA, 'central_fx');
      await container.featureFlags.set(tenantA, owner, {
        key: 'central_fx',
        enabled: true,
        expectedVersion: flag.version,
        idempotencyKey: 'roles-boot-central-fx',
        reason: 'Process-role boot test: drive the failing-source path.',
      });
      // Spied, not replaced: the spy calls through to the real method with whatever
      // receiver the call site gives it, so a detached call still reaches `this.emit`.
      const warn = vi.spyOn(container.logger, 'warn');
      forbiddenHits = [];

      // The start-up sweep main.worker.ts awaits before the backup scheduler starts.
      if (!(await container.recoveryQuiesced())) await container.backupOrphanSweep.sweep();

      const ticks: Tick[] = [
        ['relay', () => container.relay.processBatch()],
        ['throttle-sweeper', privateTick(container.throttleSweeper)],
        ['session-sweeper', privateTick(container.sessionSweeper)],
        ['backup-run-sweeper', privateTick(container.backupRunSweeper)],
        ['recovery-request-sweeper', privateTick(container.recoveryRequestSweeper)],
        ['outbox-retention-sweeper', privateTick(container.outboxRetentionSweeper)],
        ['idempotency-retention-sweeper', privateTick(container.idempotencyRetentionSweeper)],
        ['ticket-reply-file-sweeper', privateTick(container.ticketReplyFileSweeper)],
        ['direct-message-file-sweeper', privateTick(container.directMessageFileSweeper)],
        ['legacy-compaction-executor', () => container.legacyCompactionExecutor.tick()],
        ['payment-expiry', () => container.paymentExpiryLoop.tick()],
        ['gateway-payments', () => container.gatewayPaymentLoop.tick()],
        ['fx-refresh', () => container.fxRefreshLoop.tick()],
        ['service-reminders', () => container.serviceReminderLoop.tick()],
        ['nightly-reports', () => container.nightlyReportLoop.tick()],
        ['data-compaction', () => container.dataCompactionLoop.tick()],
        ['customer-reminders', () => container.customerReminderLoop.tick()],
        ['campaign-schedule', () => container.campaignScheduleLoop.tick()],
        ['telegram-message-retention', () => container.telegramMessageRetentionLoop.tick()],
        ['bot-command-sync', () => container.botCommandSyncLoop.tick()],
        ['customer-notifications', () => container.customerNotificationLoop.tick()],
        ['business-outbound', () => container.businessOutboundLoop.tick()],
        ['support-assistant-watch', () => container.supportAssistantWatchLoop.tick()],
        ['broadcasts', () => container.broadcastLoop.tick()],
        ['incident-scheduler', () => container.incidentSchedulerLoop.tick()],
        ['bulk-operations', () => container.bulkOperationLoop.tick()],
        ['receipt-review-push', () => container.receiptReviewPushLoop.tick()],
        ['ops-group', () => container.opsGroupMaintainer.tick()],
        ['notification-dispatcher', () => container.notificationDispatcher.tick()],
        ['backup-scheduler', () => container.backupScheduler.tick()],
        ['backup-housekeeping', privateTick(container.backupHousekeeping)],
        ['installation-key-refresh', () => container.installationKeyLoader.refreshQuietly()],
        // FX a second and third time: inside the back-off (no dial), and past it.
        ['fx-refresh (inside back-off)', () => container.fxRefreshLoop.tick()],
      ];
      expect(await passAll(ticks)).toEqual([]);
      expect(unhandled).toEqual([]);

      // The FX pass really took the failing path: the 403 source was dialled, and the
      // back-off warning went through the container's own logger.
      expect(forbiddenHits.length).toBeGreaterThan(0);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'FAILED' }),
        'fx refresh failing; backing off',
      );
      // A FAILED pass is a completed pass: the lane is not stale for reporting a failure.
      expect(container.fxRefreshLoop.isFresh(container.clock.now().getTime())).toBe(true);
    } finally {
      await container.shutdown();
    }
  }, 120_000);

  it('api: the composition root boots (createApiApp) and its one loop, the key reload, passes', async () => {
    const api = await createApiApp(config);
    try {
      expect(
        await passAll([
          ['installation-key-refresh', () => api.container.installationKeyLoader.refreshQuietly()],
        ]),
      ).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      await api.close();
    }
  }, 120_000);

  it('monitor: the panel monitor passes once', async () => {
    const container = await boot('monitor', false);
    try {
      expect(await passAll([['panel-monitor', () => container.panelMonitor.tick()]])).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      await container.shutdown();
    }
  }, 60_000);

  it('recovery: the recovery and legacy-migration executors pass once', async () => {
    const container = await boot('recovery', false);
    try {
      expect(
        await passAll([
          ['recovery-executor', () => container.recoveryExecutor.tick()],
          ['legacy-migration-executor', () => container.migrationExecutor.tick()],
        ]),
      ).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      await container.shutdown();
    }
  }, 60_000);

  it('migration: the legacy-migration executor passes once', async () => {
    const container = await boot('migration', false);
    try {
      expect(
        await passAll([['legacy-migration-executor', () => container.migrationExecutor.tick()]]),
      ).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      await container.shutdown();
    }
  }, 60_000);

  it('provisioner: the provisioner loop passes once, and start/stop is clean', async () => {
    const container = await boot('provisioner', false);
    try {
      expect(await passAll([['provisioner', () => container.provisionerLoop.tick()]])).toEqual([]);
      container.provisionerLoop.start();
      await container.provisionerLoop.stop();
      expect(unhandled).toEqual([]);
    } finally {
      await container.shutdown();
    }
  }, 60_000);

  it('assistant: the assistant loop passes once, and start/stop is clean', async () => {
    const container = await boot('assistant', false);
    try {
      expect(await passAll([['assistant', () => container.assistantLoop.tick()]])).toEqual([]);
      container.assistantLoop.start();
      await container.assistantLoop.stop();
      expect(unhandled).toEqual([]);
    } finally {
      await container.shutdown();
    }
  }, 60_000);
});
