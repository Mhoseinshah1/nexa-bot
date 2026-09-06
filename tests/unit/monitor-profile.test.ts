import { describe, expect, it } from 'vitest';
import { PANEL_HEALTH_FRESH_FOR_MS } from '@nexa/contracts';
import { loadConfig } from '../../apps/api/src/infrastructure/config/load-config';
import {
  MonitorProfileService,
  type MonitorProfileConfig,
} from '../../apps/api/src/modules/platform/panels/application/monitor-profile.service';
import {
  maxHealthyIntervalMs,
  schedulerFreshPanelUpperBound,
  tenantBudgetFreshPanelUpperBound,
  tenantTurnFreshTenantUpperBound,
} from '../../apps/api/src/modules/platform/panels/domain/monitor-cadence';

/**
 * The smallest environment the schema accepts, so the assertions below are
 * about DEFAULTS rather than about whatever this file happened to set.
 */
const BASE_ENV = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  SECRETS_KEK: Buffer.alloc(32, 7).toString('base64'),
  SECRETS_KEK_ID: 'dev-1',
  TRUSTED_PROXY_IPS: '127.0.0.1,::1',
} satisfies NodeJS.ProcessEnv;

/**
 * Owner revision 18 — health checks about every three minutes.
 *
 * The cadence is a default in the config schema, so the assertion is against
 * the schema rather than against a constant somebody could change in one place
 * and forget in the other.
 */
describe('the shipped monitor cadence', () => {
  const config = loadConfig(BASE_ENV);

  it('probes a healthy panel every three minutes', () => {
    expect(config.PANEL_MONITOR_HEALTHY_INTERVAL_MS).toBe(3 * 60 * 1000);
  });

  it('still refreshes inside the freshness window, worst case', () => {
    // Worst case is the interval PLUS the anti-herd spread PLUS however long a
    // due panel waits for a tick. Three minutes is comfortably inside it; the
    // check exists because a cadence that fits ON AVERAGE still leaves the last
    // panel in the fleet displayed as stale.
    expect(config.PANEL_MONITOR_HEALTHY_INTERVAL_MS).toBeLessThanOrEqual(
      maxHealthyIntervalMs(config.PANEL_MONITOR_TICK_MS),
    );
    expect(config.PANEL_MONITOR_HEALTHY_INTERVAL_MS).toBeLessThan(PANEL_HEALTH_FRESH_FOR_MS);
  });

  /**
   * The part that is easy to get wrong, and the reason the budget moved with
   * the cadence.
   *
   * `n` panels at interval `i` need `n / i` probes per unit time, so cutting
   * the interval by 3.3x cuts what a FIXED budget can keep fresh by the same
   * factor. At the old limit of 30 this default alone would have taken a tenant
   * from 60 panels to 18 — silently, with the capacity conditions firing on
   * fleets that were comfortable the release before.
   */
  it('carries a probe budget sized for the faster cadence', () => {
    const tenantCeiling = tenantBudgetFreshPanelUpperBound(
      config.PANEL_PROBE_TENANT_LIMIT,
      config.PANEL_PROBE_TENANT_WINDOW_MS,
      config.PANEL_MONITOR_HEALTHY_INTERVAL_MS,
    );
    expect(tenantCeiling).toBe(60);

    // What it would have been had only the cadence changed.
    expect(
      tenantBudgetFreshPanelUpperBound(30, config.PANEL_PROBE_TENANT_WINDOW_MS, 3 * 60 * 1000),
    ).toBe(18);
  });

  it('carries a batch size sized for the faster cadence', () => {
    const installationCeiling = schedulerFreshPanelUpperBound(
      config.PANEL_MONITOR_BATCH_SIZE,
      config.PANEL_MONITOR_TICK_MS,
      config.PANEL_MONITOR_HEALTHY_INTERVAL_MS,
    );
    expect(installationCeiling).toBe(900);
    // And what it would have been at the old batch size.
    expect(schedulerFreshPanelUpperBound(50, config.PANEL_MONITOR_TICK_MS, 3 * 60 * 1000)).toBe(
      300,
    );
  });

  it('keeps the same single probe bucket rather than giving background work its own', () => {
    // The reserve holds tokens back for the operator INSIDE one allowance. A
    // second bucket would raise the tenant's total outbound rate, which is the
    // bound's whole purpose.
    expect(config.PANEL_MONITOR_BUDGET_RESERVE_PERCENT).toBeGreaterThan(0);
    expect(config.PANEL_MONITOR_BUDGET_RESERVE_PERCENT).toBeLessThan(100);
  });

  /**
   * The reserve floor rounds UP, and this proves it by BEHAVIOUR.
   *
   * The check here used to re-derive the floor with `Math.floor` while the
   * schema used `Math.ceil`, and asserted the two agreed — which they do at
   * the shipped defaults (both give 40), so the divergence was invisible. A
   * test that re-implements the rule it is checking, differently, is checking
   * nothing. This drives `loadConfig` at the one pair where the two rules
   * disagree about ACCEPTANCE: a bucket of 2 with a 51% reserve is `ceil`
   * → 2, leaving the monitor no token and refused; `floor` → 1, accepted.
   */
  it('rounds the reserve floor up, so a positive reserve is never silently zero', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        PANEL_PROBE_TENANT_LIMIT: '2',
        PANEL_MONITOR_BUDGET_RESERVE_PERCENT: '51',
      }),
    ).toThrow(/reserves all 2 token/);

    // And one token lower in percentage is accepted, so the refusal above is
    // the rounding and not the pair being rejected for some other reason.
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        PANEL_PROBE_TENANT_LIMIT: '2',
        PANEL_MONITOR_BUDGET_RESERVE_PERCENT: '50',
      }),
    ).not.toThrow();
  });

  it('still refuses a cadence that cannot keep a panel fresh', () => {
    // The cross-field refusal is what makes the number above safe to change.
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        PANEL_MONITOR_HEALTHY_INTERVAL_MS: String(12 * 60 * 1000),
        PANEL_MONITOR_TICK_MS: String(10 * 60 * 1000),
      }),
    ).toThrow();
  });
});

/**
 * The profile a surface reads, and the reason it is computed on the server.
 */
describe('the monitor profile service', () => {
  const guard = { check: async () => undefined } as never;
  /**
   * The installation capacity condition. `false` here; the case where it is
   * open has its own assertion below, because it is the one condition that
   * reaches an operator through no other surface.
   */
  const quiet = { systemConditionIsOpen: async () => false } as never;
  const config: MonitorProfileConfig = {
    enabled: true,
    tickMs: 30_000,
    healthyIntervalMs: 180_000,
    retryableIntervalMs: 120_000,
    nonRetryableIntervalMs: 3_600_000,
    batchSize: 150,
    concurrency: 4,
    tenantsPerTick: 10,
    probeTenantLimit: 100,
    probeTenantWindowMs: 300_000,
    probeCooldownMs: 10_000,
    budgetReservePercent: 40,
  };

  it('computes the ceilings with the same functions the capacity conditions use', async () => {
    const profile = await new MonitorProfileService(guard, config, quiet).read(
      { tenantId: 't1' } as never,
      {} as never,
    );

    expect(profile.tenantFreshPanelCeiling).toBe(
      tenantBudgetFreshPanelUpperBound(100, 300_000, 180_000),
    );
    expect(profile.installationFreshPanelCeiling).toBe(
      schedulerFreshPanelUpperBound(150, 30_000, 180_000),
    );
    expect(profile.freshForMs).toBe(PANEL_HEALTH_FRESH_FOR_MS);
  });

  it('reports the configuration it was given rather than a constant', async () => {
    const slower = await new MonitorProfileService(
      guard,
      { ...config, healthyIntervalMs: 600_000 },
      quiet,
    ).read({ tenantId: 't1' } as never, {} as never);

    // A deployment that configured ten minutes must be described as ten
    // minutes. A surface printing "3" from its own bundle would be stating a
    // number this installation is not running.
    expect(slower.healthyIntervalMs).toBe(600_000);
    expect(slower.tenantFreshPanelCeiling).toBe(200);
  });

  /**
   * The installation is over its scheduler ceiling.
   *
   * `panel.monitor.scheduler_capacity_exceeded` is recorded under
   * `SYSTEM_SCOPE` with a null tenant, and `DrizzleOperationalEventReader`
   * begins with `requireTenantId`, so `GET /ops-log` cannot return it under
   * any scope. Reporting it here is the only way an operator learns of it in
   * the Web Admin.
   */
  it('reports the installation capacity condition the tenant-scoped log cannot reach', async () => {
    const over = { systemConditionIsOpen: async () => true } as never;
    const profile = await new MonitorProfileService(guard, config, over).read(
      { tenantId: 't1' } as never,
      {} as never,
    );
    expect(profile.schedulerCapacityExceeded).toBe(true);

    const calm = await new MonitorProfileService(guard, config, quiet).read(
      { tenantId: 't1' } as never,
      {} as never,
    );
    expect(calm.schedulerCapacityExceeded).toBe(false);
  });

  it('reports the tenant-turn ceiling beside the two panel ceilings', async () => {
    const profile = await new MonitorProfileService(guard, config, quiet).read(
      { tenantId: 't1' } as never,
      {} as never,
    );
    expect(profile.tenantTurnCeiling).toBe(tenantTurnFreshTenantUpperBound(10, 30_000, 180_000));
    // It is a TENANT count, not a panel count, so it is not interchangeable
    // with either of the other two — which is what a copy-paste would break.
    expect(profile.tenantTurnCeiling).not.toBe(profile.installationFreshPanelCeiling);
  });

  it('refuses a caller the permission guard rejects', async () => {
    const denying = {
      check: async () => {
        throw new Error('denied');
      },
    } as never;
    await expect(
      new MonitorProfileService(denying, config, quiet).read(
        { tenantId: 't1' } as never,
        {} as never,
      ),
    ).rejects.toThrow('denied');
  });
});
