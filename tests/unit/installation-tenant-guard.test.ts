import { describe, expect, it } from 'vitest';
import {
  InstallationTenantGuard,
  isTenantForeignKeyViolation,
} from '../../apps/api/src/infrastructure/lifecycle/installation-tenant-guard';

/**
 * A Disaster Recovery restore replaces the database under every long-running role, whose
 * cached installation tenant then names nothing. The guard is what makes that survivable.
 */
const OLD = 'tenant-old' as never;
const NEW = 'tenant-new' as never;

function world(opts: {
  cached: string | null;
  existing: string[];
  primary: string | null;
  /** Each existing tenant's kind; PRIMARY unless named here. */
  kinds?: Record<string, 'PRIMARY' | 'RESELLER_BOT'>;
}) {
  const state = {
    current: opts.cached as never as string | null,
    exists: new Set(opts.existing),
    kinds: { ...opts.kinds },
    primary: opts.primary,
    existsCalls: 0,
    primaryCalls: 0,
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
    exit: (code) => {
      state.exits.push(code);
    },
    logger: {
      warn: (c) => state.warns.push(c),
      error: (c) => state.errors.push(c),
    },
  });
  return { guard, state };
}

const fk = (extra: Record<string, unknown> = {}) =>
  Object.assign(new Error('insert or update violates foreign key constraint'), {
    code: '23503',
    constraint: 'admin_login_throttle_tenant_id_tenants_id_fk',
    ...extra,
  });

describe('InstallationTenantGuard.verify', () => {
  it('does nothing while the cached tenant still exists', async () => {
    const { guard, state } = world({ cached: OLD, existing: [OLD], primary: NEW });
    await guard.verify();
    expect(state.current).toBe(OLD);
    expect(state.primaryCalls).toBe(0);
    expect(state.exits).toEqual([]);
  });

  it('adopts the new primary, once, and says so, when the cached tenant is gone', async () => {
    const { guard, state } = world({ cached: OLD, existing: [NEW], primary: NEW });
    await expect(guard.verify()).resolves.toBe(NEW);
    expect(state.current).toBe(NEW);
    expect(state.primaryCalls).toBe(1);
    expect(state.warns[0]).toMatchObject({ previousTenantId: OLD, tenantId: NEW });
    expect(state.exits).toEqual([]);
  });

  it('never swaps a cached tenant it saw as another kind for the installation tenant', async () => {
    // One install hosts many tenants (ADR-0037); "the primary" is the owner's. A reseller or
    // hosted tenant that disappears must not have its work moved into the owner's tenant.
    const CHILD = 'tenant-child';
    const { guard, state } = world({
      cached: CHILD,
      existing: [CHILD, NEW],
      primary: NEW,
      kinds: { [CHILD]: 'RESELLER_BOT' },
    });
    await expect(guard.verify()).resolves.toBe(CHILD);
    state.exists.delete(CHILD);
    await expect(guard.verify()).resolves.toBe(CHILD);
    expect(state.current).toBe(CHILD);
    expect(state.primaryCalls).toBe(0);
    expect(state.exits).toEqual([]);
    expect(state.errors[0]).toMatchObject({ cachedTenantId: CHILD, kind: 'RESELLER_BOT' });
  });

  it('still adopts the primary when the cached tenant it saw WAS the installation tenant', async () => {
    const { guard, state } = world({ cached: OLD, existing: [OLD, NEW], primary: NEW });
    await expect(guard.verify()).resolves.toBe(OLD);
    state.exists.delete(OLD);
    await expect(guard.verify()).resolves.toBe(NEW);
    expect(state.current).toBe(NEW);
  });

  it('exits 1 when the cached tenant is gone and the database has no primary', async () => {
    const { guard, state } = world({ cached: OLD, existing: [], primary: null });
    await guard.verify();
    expect(state.exits).toEqual([1]);
    expect(state.errors).toHaveLength(1);
  });

  it('leaves a role that never had a tenant alone (fresh, unprovisioned install)', async () => {
    const { guard, state } = world({ cached: null, existing: [], primary: null });
    await guard.verify();
    expect(state.existsCalls).toBe(0);
    expect(state.exits).toEqual([]);
    expect(state.current).toBeNull();
  });

  it('changes nothing when the database cannot answer', async () => {
    const { guard, state } = world({ cached: OLD, existing: [], primary: NEW });
    const broken = new InstallationTenantGuard({
      getCurrent: () => state.current as never,
      setCurrent: () => undefined,
      tenantKind: async () => {
        throw new Error('connection terminated');
      },
      findPrimary: async () => NEW,
      exit: (c) => state.exits.push(c),
      logger: { warn: (c) => state.warns.push(c), error: (c) => state.errors.push(c) },
    });
    await broken.verify();
    expect(state.exits).toEqual([]);
    expect(state.current).toBe(OLD);
    void guard;
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
