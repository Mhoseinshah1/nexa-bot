import { describe, expect, it } from 'vitest';
import {
  InstallationTenantGuard,
  isTenantForeignKeyViolation,
} from '../../apps/api/src/infrastructure/lifecycle/installation-tenant-guard';

/**
 * A Disaster Recovery restore replaces the database under every long-running role, whose
 * cached installation tenant then names nothing. The guard is what makes that survivable.
 *
 * PR #411, fail closed: the kind is recorded where the scope is set (`record`), and only a
 * vanished tenant recorded as PRIMARY is re-resolved. MUTATIONS, each run and each red here:
 * drop the `failClosed` branch (hosted before/after, unknown, dedupe cases); fall back on an
 * UNKNOWN kind; drop the `stopScope` call; drop the `alerted` dedupe; drop the UNKNOWN exit;
 * drop re-recording the adopted primary; never fall back (the #413 restore cases); record
 * every kind as UNKNOWN in `record`; drop the catch in `run` (an exit that throws rejects).
 */
const OLD = 'tenant-old' as never;
const NEW = 'tenant-new' as never;
/** A hosted (reseller) tenant: one install hosts many (ADR-0037). */
const HOSTED = 'tenant-hosted';

type Kind = 'PRIMARY' | 'RESELLER_BOT' | 'HOSTED';

function world(opts: {
  cached: string | null;
  existing: string[];
  primary: string | null;
  /** Each existing tenant's kind; PRIMARY unless named here. */
  kinds?: Record<string, Kind>;
  /**
   * The kind the role recorded when it set `cached` (what `resolveInstallationTenant` does at
   * boot). Default PRIMARY, the boot case; `'none'` records nothing (never recorded).
   */
  recorded?: Kind | null | 'none';
  alertFails?: boolean;
  stopFails?: boolean;
}) {
  const state = {
    current: opts.cached as never as string | null,
    exists: new Set(opts.existing),
    kinds: { ...opts.kinds },
    primary: opts.primary,
    existsCalls: 0,
    primaryCalls: 0,
    stops: [] as string[],
    alerts: [] as { code: string; severity: string; dedupeKey?: string; context?: unknown }[],
    exits: [] as number[],
    warns: [] as Record<string, unknown>[],
    errors: [] as Record<string, unknown>[],
    gate: null as Promise<void> | null,
  };
  const guard = new InstallationTenantGuard({
    getCurrent: () => state.current as never,
    setCurrent: (id) => {
      state.current = id as unknown as string;
    },
    stopScope: (id) => {
      if (opts.stopFails === true) throw new Error('cannot stop');
      state.stops.push(id as unknown as string);
      state.current = null;
    },
    tenantKind: async (id) => {
      state.existsCalls += 1;
      if (state.gate) await state.gate;
      const key = id as unknown as string;
      return state.exists.has(key) ? (state.kinds[key] ?? 'PRIMARY') : null;
    },
    findPrimary: async () => {
      state.primaryCalls += 1;
      return state.primary as never;
    },
    alertOwner: async (event) => {
      if (opts.alertFails === true) throw new Error('ops log down');
      state.alerts.push(event as never);
      return true;
    },
    exit: (code) => {
      state.exits.push(code);
    },
    logger: {
      warn: (c) => state.warns.push(c),
      error: (c) => state.errors.push(c),
    },
  });
  const recorded = opts.recorded === undefined ? 'PRIMARY' : opts.recorded;
  if (recorded !== 'none') guard.record(opts.cached as never, recorded);
  return { guard, state };
}

const fk = (extra: Record<string, unknown> = {}) =>
  Object.assign(new Error('insert or update violates foreign key constraint'), {
    code: '23503',
    constraint: 'admin_login_throttle_tenant_id_tenants_id_fk',
    ...extra,
  });

/** The fail-closed outcome: never the owner's tenant, scope stopped, one owner alert. */
function expectFailedClosed(
  state: ReturnType<typeof world>['state'],
  tenant: string,
  kind: string,
): void {
  expect(state.current).toBeNull();
  expect(state.current).not.toBe(NEW);
  expect(state.primaryCalls).toBe(0);
  expect(state.stops).toEqual([tenant]);
  expect(state.alerts).toHaveLength(1);
  expect(state.alerts[0]).toMatchObject({
    code: 'tenancy.cached_tenant_vanished',
    severity: 'CRITICAL',
    dedupeKey: `tenancy.cached_tenant_vanished:${tenant}`,
    context: { tenantId: tenant, kind },
  });
  expect(state.errors[0]).toMatchObject({ cachedTenantId: tenant, recordedKind: kind });
}

describe('InstallationTenantGuard.verify', () => {
  it('does nothing while the cached tenant still exists', async () => {
    const { guard, state } = world({ cached: OLD, existing: [OLD], primary: NEW });
    await guard.verify();
    expect(state.current).toBe(OLD);
    expect(state.primaryCalls).toBe(0);
    expect(state.exits).toEqual([]);
  });

  it('adopts the new primary, once, and says so, when the recorded PRIMARY is gone (#413)', async () => {
    const { guard, state } = world({ cached: OLD, existing: [NEW], primary: NEW });
    await expect(guard.verify()).resolves.toBe(NEW);
    expect(state.current).toBe(NEW);
    expect(state.primaryCalls).toBe(1);
    expect(state.warns[0]).toMatchObject({ previousTenantId: OLD, tenantId: NEW });
    expect(state.exits).toEqual([]);
    expect(state.alerts).toEqual([]);
    expect(state.stops).toEqual([]);
  });

  it('records the re-resolved tenant as PRIMARY, so a second restore re-resolves too', async () => {
    const NEWER = 'tenant-newer';
    const { guard, state } = world({ cached: OLD, existing: [NEW], primary: NEW });
    await expect(guard.verify()).resolves.toBe(NEW);
    state.exists = new Set([NEWER]);
    state.primary = NEWER;
    await expect(guard.verify()).resolves.toBe(NEWER);
    expect(state.alerts).toEqual([]);
  });

  it('a HOSTED tenant deleted BEFORE the first check never resolves to the owner and is stopped', async () => {
    // Recorded at boot as RESELLER_BOT; gone before the guard ever looked at it.
    const { guard, state } = world({
      cached: HOSTED,
      existing: [NEW],
      primary: NEW,
      recorded: 'RESELLER_BOT',
    });
    await expect(guard.verify()).resolves.toBeNull();
    expectFailedClosed(state, HOSTED, 'RESELLER_BOT');
    expect(state.exits).toEqual([]);
  });

  it('a HOSTED tenant deleted AFTER the first check gives the same result', async () => {
    const { guard, state } = world({
      cached: HOSTED,
      existing: [HOSTED, NEW],
      primary: NEW,
      kinds: { [HOSTED]: 'RESELLER_BOT' },
      recorded: 'RESELLER_BOT',
    });
    await expect(guard.verify()).resolves.toBe(HOSTED);
    state.exists.delete(HOSTED);
    await expect(guard.verify()).resolves.toBeNull();
    expectFailedClosed(state, HOSTED, 'RESELLER_BOT');
    expect(state.exits).toEqual([]);
  });

  it('a tenant recorded as kind HOSTED (phase 6A PR-3) fails closed the same way', async () => {
    // The creator panel's own kind: never PRIMARY, so its disappearance never re-resolves.
    const { guard, state } = world({
      cached: HOSTED,
      existing: [HOSTED, NEW],
      primary: NEW,
      kinds: { [HOSTED]: 'HOSTED' },
      recorded: 'HOSTED',
    });
    await expect(guard.verify()).resolves.toBe(HOSTED);
    state.exists.delete(HOSTED);
    await expect(guard.verify()).resolves.toBeNull();
    expectFailedClosed(state, HOSTED, 'HOSTED');
    expect(state.exits).toEqual([]);
  });

  it('a periodic check that saw the row as PRIMARY does not overrule an UNKNOWN record', async () => {
    // The kind is what the role recorded when it set the scope, never learnt from a tick.
    const { guard, state } = world({
      cached: OLD,
      existing: [OLD, NEW],
      primary: NEW,
      recorded: null,
    });
    await expect(guard.verify()).resolves.toBe(OLD);
    state.exists.delete(OLD);
    await guard.verify();
    expectFailedClosed(state, OLD, 'UNKNOWN');
    expect(state.exits).toEqual([1]);
  });

  it('a tenant of UNKNOWN kind fails closed and exits non-zero rather than guess', async () => {
    const { guard, state } = world({ cached: OLD, existing: [NEW], primary: NEW, recorded: null });
    await guard.verify();
    expectFailedClosed(state, OLD, 'UNKNOWN');
    expect(state.exits).toEqual([1]);
  });

  it('a kind never recorded (or recorded for another tenant) fails closed the same way', async () => {
    const never = world({ cached: OLD, existing: [NEW], primary: NEW, recorded: 'none' });
    await never.guard.verify();
    expectFailedClosed(never.state, OLD, 'UNKNOWN');
    expect(never.state.exits).toEqual([1]);

    // The PRIMARY record was for another id: the cached one was set without recording.
    const other = world({ cached: NEW, existing: [NEW], primary: NEW });
    other.state.current = OLD;
    await other.guard.verify();
    expectFailedClosed(other.state, OLD, 'UNKNOWN');
  });

  it('one disappearance is one alert, however often the guard is asked', async () => {
    const { guard, state } = world({
      cached: HOSTED,
      existing: [NEW],
      primary: NEW,
      recorded: 'RESELLER_BOT',
    });
    await guard.verify();
    guard.onWriteError(fk());
    await guard.verify();
    // Even if something put the same vanished id back, the owner is not told twice.
    state.current = HOSTED;
    await guard.verify();
    expect(state.alerts).toHaveLength(1);
    expect(state.primaryCalls).toBe(0);
  });

  it('an alert that cannot be sent still stops the scope, and is logged', async () => {
    const { guard, state } = world({
      cached: HOSTED,
      existing: [NEW],
      primary: NEW,
      recorded: 'RESELLER_BOT',
      alertFails: true,
    });
    await expect(guard.verify()).resolves.toBeNull();
    expect(state.stops).toEqual([HOSTED]);
    expect(state.primaryCalls).toBe(0);
    expect(state.errors.some((e) => e.err === 'ops log down')).toBe(true);
  });

  it('a scope that cannot be stopped exits non-zero', async () => {
    const { guard, state } = world({
      cached: HOSTED,
      existing: [NEW],
      primary: NEW,
      recorded: 'RESELLER_BOT',
      stopFails: true,
    });
    await guard.verify();
    expect(state.current).toBe(HOSTED);
    expect(state.primaryCalls).toBe(0);
    expect(state.exits).toEqual([1]);
  });

  it('exits 1 when the recorded PRIMARY is gone and the database has no primary', async () => {
    const { guard, state } = world({ cached: OLD, existing: [], primary: null });
    await guard.verify();
    expect(state.exits).toEqual([1]);
    expect(state.errors).toHaveLength(1);
  });

  it('never rejects when exit throws (a runner stub), on either exit path', async () => {
    for (const recorded of ['PRIMARY', null] as const) {
      const { state } = world({ cached: OLD, existing: [], primary: null });
      const guard = new InstallationTenantGuard({
        getCurrent: () => state.current as never,
        setCurrent: () => undefined,
        stopScope: () => {
          state.current = null;
        },
        tenantKind: async () => null,
        findPrimary: async () => null,
        alertOwner: async () => false,
        exit: (code) => {
          state.exits.push(code);
          throw new Error('process.exit unexpectedly called');
        },
        logger: { warn: (c) => state.warns.push(c), error: (c) => state.errors.push(c) },
      });
      guard.record(OLD, recorded);
      await expect(guard.verify()).resolves.not.toBe(NEW);
      expect(state.exits).toEqual([1]);
      expect(state.errors.some((e) => e.err === 'process.exit unexpectedly called')).toBe(true);
    }
  });

  it('leaves a role that never had a tenant alone (fresh, unprovisioned install)', async () => {
    const { guard, state } = world({ cached: null, existing: [], primary: null });
    await guard.verify();
    expect(state.existsCalls).toBe(0);
    expect(state.exits).toEqual([]);
    expect(state.current).toBeNull();
  });

  it('changes nothing when the database cannot answer', async () => {
    const { state } = world({ cached: OLD, existing: [], primary: NEW });
    const broken = new InstallationTenantGuard({
      getCurrent: () => state.current as never,
      setCurrent: () => undefined,
      stopScope: () => state.stops.push('x'),
      tenantKind: async () => {
        throw new Error('connection terminated');
      },
      findPrimary: async () => NEW,
      alertOwner: async () => true,
      exit: (c) => state.exits.push(c),
      logger: { warn: (c) => state.warns.push(c), error: (c) => state.errors.push(c) },
    });
    await broken.verify();
    expect(state.exits).toEqual([]);
    expect(state.stops).toEqual([]);
    expect(state.current).toBe(OLD);
  });

  it('coalesces concurrent verifications into one check', async () => {
    const { guard, state } = world({ cached: OLD, existing: [NEW], primary: NEW });
    let release!: () => void;
    state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = [guard.verify(), guard.verify(), guard.verify()];
    release();
    await Promise.all(calls);
    expect(state.existsCalls).toBe(1);
    expect(state.primaryCalls).toBe(1);
    // and a later one is a fresh check
    await guard.verify();
    expect(state.existsCalls).toBe(2);
  });
});

describe('InstallationTenantGuard.onWriteError', () => {
  it('a tenant foreign-key violation triggers a verification', async () => {
    const { guard, state } = world({ cached: OLD, existing: [NEW], primary: NEW });
    guard.onWriteError(fk());
    await guard.verify();
    expect(state.current).toBe(NEW);
  });

  it('finds the violation through a wrapped cause (drizzle)', () => {
    expect(isTenantForeignKeyViolation(new Error('Failed query', { cause: fk() }))).toBe(true);
    expect(
      isTenantForeignKeyViolation(
        Object.assign(new Error('x'), {
          code: '23503',
          detail: 'Key (tenant_id)=(a) is not present in table "tenants".',
        }),
      ),
    ).toBe(true);
  });

  it('ignores every other error, including a foreign key on something else', async () => {
    const { guard, state } = world({ cached: OLD, existing: [NEW], primary: NEW });
    guard.onWriteError(new Error('boom'));
    guard.onWriteError(
      Object.assign(new Error('unique'), { code: '23505', constraint: 'tenant_x' }),
    );
    guard.onWriteError(
      Object.assign(new Error('fk'), { code: '23503', constraint: 'orders_customer_id_fk' }),
    );
    guard.onWriteError(undefined);
    await Promise.resolve();
    expect(state.existsCalls).toBe(0);
    expect(state.current).toBe(OLD);
  });
});
