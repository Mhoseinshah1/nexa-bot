import { describe, expect, it } from 'vitest';
import {
  COUNTER_CAP,
  DASHBOARD_OPERATION_PERMISSIONS,
  DASHBOARD_SALE_KINDS,
  NAV_ATTENTION_PANEL_HEALTH_STATES,
  NAV_COUNTER_KEYS,
  NAV_COUNTER_PERMISSIONS,
  ORDER_PURPOSES,
  PANEL_HEALTH_STATES,
  PANEL_STATUSES,
  SALE_ORDER_PURPOSES,
  dashboardSaleKindOf,
  isPermissionKey,
  isRegisteredMetric,
  navCountersResponseSchema,
  orderPurposeIsSale,
  type OrderPurpose,
} from '@nexa/contracts';
import {
  OperationsOverviewService,
  fleetOf,
  type OperationsOverviewRepository,
  type PanelFleetRow,
} from '../../apps/api/src/modules/commerce/reporting/application/operations-overview.service';
import { salesKindCounts } from '../../apps/api/src/modules/commerce/reporting/application/reporting.service';
import {
  healthViewOf,
  readHealth,
} from '../../apps/api/src/modules/platform/panels/application/panel-health-view';

/**
 * Round W's dashboard aggregates (`docs/web-redesign/dashboard.md`): the pure rules the
 * integration suite relies on, each pinned where it is decided.
 */

describe('the sale kinds of the orders chart', () => {
  it('give a kind to exactly the sales, so the bars of a bucket add up to its sales', () => {
    for (const purpose of ORDER_PURPOSES) {
      expect(dashboardSaleKindOf(purpose) !== null, purpose).toBe(orderPurposeIsSale(purpose));
    }
  });

  it('keep a renewal apart from a new service and from an add-on', () => {
    expect(dashboardSaleKindOf('RENEW')).toBe('RENEWAL');
    expect(dashboardSaleKindOf('NEW_SERVICE')).toBe('NEW');
    expect(dashboardSaleKindOf('CUSTOM_SERVICE')).toBe('NEW');
    for (const addon of ['ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES', 'CHANGE_LOCATION'] as const) {
      expect(dashboardSaleKindOf(addon)).toBe('ADDON');
    }
    expect(dashboardSaleKindOf('TRIAL')).toBeNull();
  });

  it('fold one bucket by kind, dropping a purpose with no kind rather than counting it', () => {
    const bucket = new Map<OrderPurpose, number>([
      ['NEW_SERVICE', 2],
      ['CUSTOM_SERVICE', 1],
      ['RENEW', 3],
      ['ADD_TRAFFIC', 1],
      ['CHANGE_LOCATION', 4],
      ['TRIAL', 9],
    ]);
    expect(salesKindCounts(bucket)).toEqual({ NEW: 3, RENEWAL: 3, ADDON: 5 });
    expect(salesKindCounts(undefined)).toEqual({ NEW: 0, RENEWAL: 0, ADDON: 0 });
  });

  it('cover every sale purpose with one of the declared kinds', () => {
    const kinds = new Set(SALE_ORDER_PURPOSES.map((p) => dashboardSaleKindOf(p)));
    expect([...kinds].sort()).toEqual([...DASHBOARD_SALE_KINDS].sort());
  });
});

describe('the fleet', () => {
  it('projects health exactly as the panel list does, from the two stored facts', () => {
    const now = new Date('2026-09-01T00:00:00Z');
    for (const status of PANEL_STATUSES) {
      for (const stored of [null, ...PANEL_HEALTH_STATES]) {
        const snapshot =
          stored === null
            ? null
            : ({ state: stored, checkedAt: now, failure: null } as unknown as Parameters<
                typeof readHealth
              >[1]);
        expect(healthViewOf(status, stored), `${status}/${String(stored)}`).toBe(
          readHealth({ status }, snapshot, now).state,
        );
      }
    }
  });

  it('counts each panel once: totals, active, health view and provider', () => {
    const rows: PanelFleetRow[] = [
      { status: 'ACTIVE', health: 'HEALTHY', providerType: 'sanaei', count: 3 },
      { status: 'ACTIVE', health: null, providerType: 'sanaei', count: 1 },
      { status: 'ACTIVE', health: 'AUTH_FAILED', providerType: 'marzban', count: 2 },
      // A disabled panel whose last probe failed reads DISABLED, never AUTH_FAILED.
      { status: 'DISABLED', health: 'AUTH_FAILED', providerType: 'marzban', count: 1 },
    ];
    const fleet = fleetOf(rows);
    expect(fleet.total).toBe(7);
    expect(fleet.active).toBe(6);
    expect(fleet.health).toEqual([
      { state: 'HEALTHY', count: 3 },
      { state: 'AUTH_FAILED', count: 2 },
      { state: 'DISABLED', count: 1 },
      { state: 'UNCHECKED', count: 1 },
    ]);
    expect(fleet.providers.map((p) => [p.providerType, p.count])).toEqual([
      ['marzban', 3],
      ['sanaei', 4],
    ]);
    expect(fleet.health.reduce((sum, h) => sum + h.count, 0)).toBe(fleet.total);
  });
});

describe('the sidebar counters and the operations sections', () => {
  it('name a real permission for every counter and every section', () => {
    for (const key of NAV_COUNTER_KEYS) {
      expect(isPermissionKey(NAV_COUNTER_PERMISSIONS[key]), key).toBe(true);
    }
    for (const permission of Object.values(DASHBOARD_OPERATION_PERMISSIONS)) {
      expect(isPermissionKey(permission)).toBe(true);
    }
  });

  it('never count a healthy panel as one needing attention', () => {
    expect(NAV_ATTENTION_PANEL_HEALTH_STATES).not.toContain('HEALTHY');
    expect([...NAV_ATTENTION_PANEL_HEALTH_STATES].sort()).toEqual(
      PANEL_HEALTH_STATES.filter((s) => s !== 'HEALTHY').sort(),
    );
  });

  it('register every figure they report', () => {
    for (const name of [
      'sales.by_kind',
      'services.expiring',
      'panels.fleet',
      'provisioning.queue',
      'nav.counters',
    ]) {
      expect(isRegisteredMetric(name), name).toBe(true);
    }
  });
});

describe('the unreconciled-services figure', () => {
  /**
   * The sidebar badge is bounded by `COUNTER_CAP` and drawn as "or more"; the dashboard's
   * gauge sits beside uncapped queued and unknown totals and is read as exact. A backlog
   * past the cap must reach the gauge in full, and the badge still stops at the cap.
   */
  it('is counted in full on the dashboard and bounded only in the sidebar', async () => {
    const backlog = COUNTER_CAP + 234;
    const bounded = (total: number, cap: number) => Math.min(total, cap);
    const repository: OperationsOverviewRepository = {
      panelFleet: async () => [],
      provisioningQueue: async () => ({ queued: 5000, unknown: 3000 }),
      unreconciledServices: async (...args: unknown[]) =>
        typeof args[1] === 'number' ? bounded(backlog, args[1]) : backlog,
      expiringServices: async () => 0,
      navCounter: async (_scope, key, cap) =>
        key === 'unreconciledServices' ? bounded(backlog, cap) : 0,
    };
    const service = new OperationsOverviewService({
      permissions: {
        permissionsOf: async () =>
          new Set([
            DASHBOARD_OPERATION_PERMISSIONS.provisioning,
            NAV_COUNTER_PERMISSIONS.unreconciledServices,
          ]),
      },
      repository,
      clock: { now: () => new Date('2026-09-06T08:00:00.000Z') },
      counterCap: COUNTER_CAP,
    });
    const scope = { tenantId: '019210ab-cdef-7012-8345-6789abcdef01' } as never;
    const actor = { type: 'WEB_ADMIN' } as never;

    const operations = await service.operations(scope, actor);
    expect(operations.provisioning).toEqual({
      queued: 5000,
      unknown: 3000,
      unreconciledServices: backlog,
    });
    const counters = await service.navCounters(scope, actor);
    expect(counters.counters.unreconciledServices).toBe(COUNTER_CAP);
  });
});

/*
 * Roadmap B6, review B1: a new bundle reading an API released before `businessHandoffs`.
 * During a rolling update a poll can reach an old replica; a required key would make its
 * six-key answer unparseable, which polling treats as final and never asks again.
 */
describe('the sidebar counters across a rolling update', () => {
  it('parses an old API’s six-key answer, reading the missing counter as not counted', () => {
    const old = navCountersResponseSchema.parse({
      generatedAt: '2026-10-07T10:00:00.000Z',
      counters: {
        openConditions: 1,
        ticketsAwaitingSupport: 2,
        unhealthyPanels: null,
        unreconciledServices: 0,
        refundRequestsAwaiting: null,
        paymentsUnknown: 3,
      },
    });
    expect(old.counters.businessHandoffs).toBeNull();
    expect(old.counters.paymentsUnknown).toBe(3);
  });

  it('still reads the counter when the API sends it, and still refuses a malformed one', () => {
    const base = {
      openConditions: null,
      ticketsAwaitingSupport: null,
      unhealthyPanels: null,
      unreconciledServices: null,
      refundRequestsAwaiting: null,
      paymentsUnknown: null,
    };
    const parse = (businessHandoffs: unknown) =>
      navCountersResponseSchema.safeParse({
        generatedAt: '2026-10-07T10:00:00.000Z',
        counters: { ...base, businessHandoffs },
      });
    const sent = parse(4);
    expect(sent.success && sent.data.counters.businessHandoffs).toBe(4);
    expect(parse(-1).success).toBe(false);
  });
});
