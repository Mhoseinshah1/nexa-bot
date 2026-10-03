import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_SCHEDULE_SETTING_KEYS, isNexaError, type ActorContext } from '@nexa/contracts';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Spec §13.2 — the automatic backup schedule is configured from the Web Admin, without
 * editing the environment, against a real database.
 *
 * The environment here says ON, every 24 hours: the case that matters most is a stored
 * value overriding it, because an operator switching backups OFF from the Web Admin on
 * an installation whose `nexa.env` says on must actually stop them.
 */
describe('the automatic backup schedule (spec 13.2)', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let ownerB: ActorContext;
  let workRoot: string;
  let keys = 0;
  const key = () => `schedule-${(keys += 1)}-${Date.now()}`;

  beforeAll(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'nexa-schedule-backups-'));
    ctx = await createTestContext({
      BACKUP_SCHEDULE_ENABLED: 'true',
      BACKUP_INTERVAL_MS: String(24 * 3_600_000),
      BACKUP_WORK_DIR: workRoot,
    });
  });

  afterAll(async () => {
    await ctx?.close();
    await rm(workRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner', roleKeys: ['owner'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-b', roleKeys: ['owner'] }),
    );
  });

  const status = () => ctx.container.backupAdmin.status(tenantA as never, owner);
  const set = (value: unknown, which: 'enabled' | 'intervalMinutes', version: number | null) =>
    ctx.container.settingsService.set(tenantA, owner, {
      key: BACKUP_SCHEDULE_SETTING_KEYS[which],
      value,
      expectedVersion: version,
      idempotencyKey: key(),
    });

  it('is the environment until the Web Admin stores a value', async () => {
    const before = await status();
    expect(before).toMatchObject({
      scheduleEnabled: true,
      intervalMs: 24 * 3_600_000,
      scheduleSource: { enabled: 'ENVIRONMENT', interval: 'ENVIRONMENT' },
      deliveryDestination: 'NONE',
    });
  });

  it('takes the stored switch and interval over the environment, and back again on null', async () => {
    const off = await set(false, 'enabled', null);
    await set(180, 'intervalMinutes', null);
    expect(await status()).toMatchObject({
      scheduleEnabled: false,
      intervalMs: 3 * 3_600_000,
      scheduleSource: { enabled: 'SETTING', interval: 'SETTING' },
    });

    await set(null, 'enabled', off.setting.version);
    expect(await status()).toMatchObject({
      scheduleEnabled: true,
      scheduleSource: { enabled: 'ENVIRONMENT', interval: 'SETTING' },
    });
  });

  it('keeps the bounds: fifteen minutes to thirty days', async () => {
    for (const value of [14, 30 * 24 * 60 + 1, 0, 1.5]) {
      const refused = await set(value, 'intervalMinutes', null).catch((error: unknown) => error);
      expect(isNexaError(refused), String(value)).toBe(true);
    }
    await expect(set(15, 'intervalMinutes', null)).resolves.toMatchObject({ changed: true });
  });

  it('reads the INSTALLATION tenant only: another tenant’s value changes nothing', async () => {
    await ctx.container.settingsService.set(tenantB, ownerB, {
      key: BACKUP_SCHEDULE_SETTING_KEYS.enabled,
      value: false,
      expectedVersion: null,
      idempotencyKey: key(),
    });
    expect((await status()).scheduleEnabled).toBe(true);
  });

  it('stops the scheduler when switched off here, whatever the environment says', async () => {
    await set(false, 'enabled', null);
    await ctx.container.backupScheduler.tick();
    // The environment says on and nothing has ever been backed up, so without the
    // setting this tick would take a backup at once.
    expect(await ctx.container.backupRuns.latest(5)).toHaveLength(0);
    // A disabled schedule is a tick that completed, not a stalled loop.
    expect(ctx.container.backupScheduler.isFresh(ctx.container.clock.now().getTime())).toBe(true);
  });
});
