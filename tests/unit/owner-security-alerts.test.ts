import { describe, expect, it } from 'vitest';
import type {
  ActorContext,
  OperationalEventInput,
  ScopeContext,
  TenantContext,
} from '@nexa/contracts';
import { OwnerSecurityAlerts } from '../../apps/api/src/modules/platform/owner-alerts/application/owner-security-alerts';
import type { KnownIpVerdict } from '../../apps/api/src/modules/platform/owner-alerts/application/ports';

/**
 * Phase 6A D0: the decisions of the owner's security alerts, without a database. Who is told
 * (the installation tenant, only), when (a NEW address — not the first, not a known one; any
 * export; a read past a threshold), and what is said (no secret, no row content).
 */

const OWNER: TenantContext = { tenantId: 'owner-tenant' as never, botInstanceId: null };
const HOSTED: TenantContext = { tenantId: 'hosted-tenant' as never, botInstanceId: null };
const NOW = new Date('2026-11-04T10:07:00.000Z');

const admin: ActorContext = {
  type: 'WEB_ADMIN',
  id: 'admin-1',
  label: 'owner',
  surface: 'WEB',
  correlationId: 'c-1' as never,
};

interface Recorded {
  readonly scope: ScopeContext;
  readonly event: OperationalEventInput;
  readonly tx: unknown;
}

function harness(
  options: {
    verdict?: KnownIpVerdict;
    settings?: Record<string, number>;
    window?: { rowsInWindow: number; claimedAlert: boolean };
    installation?: TenantContext | null;
    recordThrows?: boolean;
    windowThrows?: boolean;
  } = {},
) {
  const recorded: Recorded[] = [];
  const remembered: unknown[] = [];
  const added: { scope: TenantContext; input: Record<string, unknown> }[] = [];
  const warnings: string[] = [];
  const alerts = new OwnerSecurityAlerts({
    opsLog: {
      async record(scope, event, tx) {
        if (options.recordThrows === true) throw new Error('the ops log is down');
        recorded.push({ scope, event, tx });
        return {
          id: 'e',
          code: event.code,
          severity: event.severity,
          message: event.message,
          occurrenceCount: 1,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
          isNew: true,
          reopened: false,
        };
      },
    },
    knownIps: {
      async remember(scope, input, tx) {
        remembered.push({ scope, input, tx });
        return options.verdict ?? 'NEW';
      },
    },
    readWindows: {
      async add(scope, input) {
        if (options.windowThrows === true) throw new Error('statement timeout');
        added.push({ scope, input: { ...input } });
        return options.window ?? { rowsInWindow: input.rows, claimedAlert: false };
      },
    },
    settings: {
      async valueOf<T>(_scope: ScopeContext, key: string): Promise<T> {
        return (options.settings?.[key] ?? undefined) as T;
      },
    },
    uow: {
      run: async (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) => fn('read-tx'),
      runSnapshot: async (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) => fn('read-tx'),
    } as never,
    installationScope: () => (options.installation === undefined ? OWNER : options.installation),
    clock: { now: () => NOW },
    logger: { warn: (_context, message) => warnings.push(message) },
  });
  return { alerts, recorded, remembered, added, warnings };
}

describe('auth.login_new_ip', () => {
  it('records a NEW address in the owner scope, inside the sign-in transaction', async () => {
    const h = harness({ verdict: 'NEW' });
    await h.alerts.signedIn(
      OWNER,
      admin,
      { id: 'admin-1', username: 'owner' },
      '198.51.100.7',
      'tx-1',
    );
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]!.scope).toEqual(OWNER);
    expect(h.recorded[0]!.tx).toBe('tx-1');
    expect(h.recorded[0]!.event).toMatchObject({
      code: 'auth.login_new_ip',
      severity: 'WARN',
      context: { adminId: 'admin-1', adminUsername: 'owner', clientIp: '198.51.100.7' },
    });
  });

  it.each(['FIRST_EVER', 'KNOWN'] as const)(
    'remembers a %s address and says nothing',
    async (verdict) => {
      const h = harness({ verdict });
      await h.alerts.signedIn(
        OWNER,
        admin,
        { id: 'admin-1', username: 'owner' },
        '203.0.113.10',
        'tx',
      );
      expect(h.remembered).toHaveLength(1);
      expect(h.recorded).toEqual([]);
    },
  );

  it('does nothing for an address nobody can vouch for, a hosted tenant, or no installation', async () => {
    const unknownIp = harness();
    await unknownIp.alerts.signedIn(OWNER, admin, { id: 'a', username: 'owner' }, null, 'tx');
    const hosted = harness();
    await hosted.alerts.signedIn(HOSTED, admin, { id: 'a', username: 'x' }, '198.51.100.7', 'tx');
    const none = harness({ installation: null });
    await none.alerts.signedIn(OWNER, admin, { id: 'a', username: 'owner' }, '198.51.100.7', 'tx');
    for (const h of [unknownIp, hosted, none]) {
      expect(h.remembered).toEqual([]);
      expect(h.recorded).toEqual([]);
    }
  });

  it('lets a failing alert fail the sign-in: alert and session commit together or not at all', async () => {
    const h = harness({ verdict: 'NEW', recordThrows: true });
    await expect(
      h.alerts.signedIn(OWNER, admin, { id: 'a', username: 'owner' }, '198.51.100.7', 'tx'),
    ).rejects.toThrow('the ops log is down');
  });
});

describe('access.data_exported', () => {
  it('records every export in the OWNER scope, naming the hosted tenant it came from', async () => {
    const h = harness();
    await h.alerts.dataExported(HOSTED, admin, { kind: 'REPORT', rows: 42, format: 'SALES csv' });
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]!.scope).toEqual(OWNER);
    expect(h.recorded[0]!.event).toMatchObject({
      code: 'access.data_exported',
      context: { exportKind: 'REPORT', rowCount: 42, scopeTenantId: 'hosted-tenant' },
    });
  });

  it('fails closed: an export that cannot be announced is not handed out', async () => {
    const h = harness({ recordThrows: true });
    await expect(
      h.alerts.dataExported(OWNER, admin, { kind: 'AUDIT_LOG', rows: 1 }),
    ).rejects.toThrow();
  });
});

describe('access.bulk_read', () => {
  it('alerts on one call above security.bulk_read_rows, and not at it', async () => {
    const at = harness({ settings: { 'security.bulk_read_rows': 100 } });
    await at.alerts.rowsRead(OWNER, admin, { resource: 'customers', rows: 100 });
    expect(at.recorded).toEqual([]);
    const above = harness({ settings: { 'security.bulk_read_rows': 100 } });
    await above.alerts.rowsRead(OWNER, admin, { resource: 'customers', rows: 101 });
    expect(above.recorded).toHaveLength(1);
    expect(above.recorded[0]!.scope).toEqual(OWNER);
    expect(above.recorded[0]!.event.context).toMatchObject({
      readResource: 'customers',
      rowCount: 101,
    });
  });

  it('alerts when the window store says this read claimed the window, keyed per admin per window', async () => {
    const h = harness({ window: { rowsInWindow: 2_100, claimedAlert: true } });
    await h.alerts.rowsRead(OWNER, admin, { resource: 'customer', rows: 1 });
    expect(h.recorded).toHaveLength(1);
    // 10:07 in 10-minute windows: the window starting 10:00.
    expect(h.added[0]!.input).toMatchObject({
      adminId: 'admin-1',
      rows: 1,
      threshold: 2_000,
      windowStart: new Date('2026-11-04T10:00:00.000Z'),
    });
    expect(h.recorded[0]!.event.dedupeKey).toBe(
      `access.bulk_read:admin-1@${String(Math.floor(NOW.getTime() / 600_000))}`,
    );
    const notClaimed = harness({ window: { rowsInWindow: 2_100, claimedAlert: false } });
    await notClaimed.alerts.rowsRead(OWNER, admin, { resource: 'customer', rows: 1 });
    expect(notClaimed.recorded).toEqual([]);
  });

  it('counts a hosted administrator in THEIR tenant and tells only the owner', async () => {
    const h = harness();
    await h.alerts.rowsRead(HOSTED, admin, { resource: 'customers', rows: 900 });
    expect(h.added[0]!.scope).toEqual(HOSTED);
    expect(h.recorded[0]!.scope).toEqual(OWNER);
  });

  it('is off at 0, ignores non-admin actors, and never throws into the read', async () => {
    const off = harness({
      settings: { 'security.bulk_read_rows': 0, 'security.bulk_read_window_rows': 0 },
    });
    await off.alerts.rowsRead(OWNER, admin, { resource: 'customers', rows: 1_000_000 });
    expect(off.recorded).toEqual([]);
    expect(off.added).toEqual([]);

    const job = harness();
    await job.alerts.rowsRead(
      OWNER,
      { ...admin, type: 'SYSTEM_JOB' },
      { resource: 'x', rows: 9_999 },
    );
    expect(job.recorded).toEqual([]);

    const broken = harness({ windowThrows: true });
    await expect(
      broken.alerts.rowsRead(OWNER, admin, { resource: 'customers', rows: 9_999 }),
    ).resolves.toBeUndefined();
    expect(broken.warnings).toHaveLength(1);
  });
});
