import { describe, expect, it } from 'vitest';
import {
  incoherentPermissionGrants,
  isPermissionKey,
  PERMISSIONS,
  PERMISSION_KEYS,
  PERMISSION_REQUIRES,
  permissionDefinition,
  resolveEffectivePermissions,
  ROLE_SEEDS,
  type PermissionKey,
  type PermissionOverride,
} from '@nexa/contracts';

const NOW = new Date('2026-06-01T00:00:00Z');

describe('permission catalog', () => {
  it('has unique keys', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  it('parses every key into a resource and an action', () => {
    for (const definition of PERMISSIONS) {
      expect(definition.resource.length).toBeGreaterThan(0);
      expect(definition.action.length).toBeGreaterThan(0);
      expect(definition.key).toBe(`${definition.resource}.${definition.action}`);
    }
  });

  it('rejects an unknown key rather than inventing a definition', () => {
    expect(isPermissionKey('users.view')).toBe(true);
    expect(isPermissionKey('users.obliterate')).toBe(false);
    expect(() => permissionDefinition('users.obliterate' as PermissionKey)).toThrow();
  });

  it('separates the high-blast-radius money operations from ordinary ones', () => {
    // Crediting a wallet and crediting a large amount are different powers.
    expect(permissionDefinition('users.wallet.credit').riskLevel).toBe('HIGH');
    expect(permissionDefinition('users.wallet.credit.large').riskLevel).toBe('CRITICAL');
    expect(permissionDefinition('users.wallet.debit').riskLevel).toBe('CRITICAL');
  });

  it('keeps payment, receipt and refund as separate permissions', () => {
    for (const key of ['payments.view', 'receipts.review', 'refunds.issue'] as PermissionKey[]) {
      expect(isPermissionKey(key)).toBe(true);
    }
  });

  it('seeds every role from real catalog keys', () => {
    for (const role of ROLE_SEEDS) {
      for (const key of role.permissions) {
        expect(isPermissionKey(key)).toBe(true);
      }
    }
  });

  it('gives the observer role read-only permissions only', () => {
    const observer = ROLE_SEEDS.find((r) => r.key === 'observer');
    expect(observer).toBeDefined();
    for (const key of observer!.permissions) {
      expect(permissionDefinition(key).riskLevel).toBe('LOW');
    }
  });
});

describe('effective permission resolution', () => {
  it('denies anything not granted', () => {
    const effective = resolveEffectivePermissions([], [], NOW);
    expect(effective.has('users.view')).toBe(false);
  });

  it('adds GRANT overrides on top of the role', () => {
    const overrides: PermissionOverride[] = [
      { permissionKey: 'refunds.issue', effect: 'GRANT', reason: 'on call', expiresAt: null },
    ];
    const effective = resolveEffectivePermissions(['users.view'], overrides, NOW);
    expect(effective.has('refunds.issue')).toBe(true);
  });

  it('lets DENY win over both the role and a GRANT for the same key', () => {
    // "This admin, but not the refunds tool" is the first thing a real
    // deployment needs, and a role enum cannot express it.
    const overrides: PermissionOverride[] = [
      { permissionKey: 'refunds.issue', effect: 'GRANT', reason: 'a', expiresAt: null },
      { permissionKey: 'refunds.issue', effect: 'DENY', reason: 'b', expiresAt: null },
    ];
    const effective = resolveEffectivePermissions(['refunds.issue'], overrides, NOW);
    expect(effective.has('refunds.issue')).toBe(false);
  });

  it('ignores an expired override', () => {
    const overrides: PermissionOverride[] = [
      {
        permissionKey: 'refunds.issue',
        effect: 'DENY',
        reason: 'temporary',
        expiresAt: new Date('2026-05-01T00:00:00Z'),
      },
    ];
    const effective = resolveEffectivePermissions(['refunds.issue'], overrides, NOW);
    expect(effective.has('refunds.issue')).toBe(true);
  });
});

describe('a permission that cannot be held alone', () => {
  /*
   * The shape Codex found on PR #50: `orders.fulfil` decides what happens to money
   * already taken, the page that decides it is gated on `orders.view`, and nothing
   * stopped an administrator holding the first without the second. Four states, and
   * three of them are the boring ones — they are here because a rule that only ever
   * fires is indistinguishable from a rule that fires too often.
   */
  it('drops orders.fulfil from an administrator who cannot view orders', () => {
    const effective = resolveEffectivePermissions(['orders.fulfil'], [], NOW);
    expect(effective.has('orders.fulfil')).toBe(false);
    expect(effective.has('orders.view')).toBe(false);
  });

  it('keeps orders.view for an administrator who cannot fulfil', () => {
    const effective = resolveEffectivePermissions(['orders.view'], [], NOW);
    expect(effective.has('orders.view')).toBe(true);
    expect(effective.has('orders.fulfil')).toBe(false);
  });

  it('keeps both when both were granted', () => {
    const effective = resolveEffectivePermissions(['orders.view', 'orders.fulfil'], [], NOW);
    expect(effective.has('orders.view')).toBe(true);
    expect(effective.has('orders.fulfil')).toBe(true);
  });

  it('grants neither to an administrator given neither', () => {
    const effective = resolveEffectivePermissions(['users.view'], [], NOW);
    expect(effective.has('orders.view')).toBe(false);
    expect(effective.has('orders.fulfil')).toBe(false);
  });

  /*
   * The case a check in a role editor could never have caught, and the reason this
   * rule is applied at RESOLUTION: the role is coherent and the override is what
   * breaks it. Finance holds both keys by seed; denying the read has to take the
   * write with it.
   */
  it('takes orders.fulfil with it when an override DENIES the read', () => {
    const overrides: PermissionOverride[] = [
      { permissionKey: 'orders.view', effect: 'DENY', reason: 'under review', expiresAt: null },
    ];
    const effective = resolveEffectivePermissions(['orders.view', 'orders.fulfil'], overrides, NOW);
    expect(effective.has('orders.view')).toBe(false);
    expect(effective.has('orders.fulfil')).toBe(false);
  });

  it('gives orders.fulfil back when that DENY expires', () => {
    const overrides: PermissionOverride[] = [
      {
        permissionKey: 'orders.view',
        effect: 'DENY',
        reason: 'was temporary',
        expiresAt: new Date('2026-05-01T00:00:00Z'),
      },
    ];
    const effective = resolveEffectivePermissions(['orders.view', 'orders.fulfil'], overrides, NOW);
    expect(effective.has('orders.fulfil')).toBe(true);
  });

  /* A GRANT override is a composed permission set too, and is narrowed the same way. */
  it('drops a GRANTED orders.fulfil when the role cannot read orders', () => {
    const overrides: PermissionOverride[] = [
      { permissionKey: 'orders.fulfil', effect: 'GRANT', reason: 'on call', expiresAt: null },
    ];
    const effective = resolveEffectivePermissions(['users.view'], overrides, NOW);
    expect(effective.has('orders.fulfil')).toBe(false);
  });

  it('honours a GRANT of both halves', () => {
    const overrides: PermissionOverride[] = [
      { permissionKey: 'orders.fulfil', effect: 'GRANT', reason: 'on call', expiresAt: null },
      { permissionKey: 'orders.view', effect: 'GRANT', reason: 'on call', expiresAt: null },
    ];
    const effective = resolveEffectivePermissions(['users.view'], overrides, NOW);
    expect(effective.has('orders.fulfil')).toBe(true);
  });

  it('names a real permission on both sides of every dependency', () => {
    for (const [dependent, prerequisite] of Object.entries(PERMISSION_REQUIRES)) {
      expect(isPermissionKey(dependent)).toBe(true);
      expect(isPermissionKey(prerequisite)).toBe(true);
    }
  });

  /*
   * `resolveEffectivePermissions` makes ONE pass, and says so. That is only correct
   * while no prerequisite is itself dependent — otherwise a two-level chain would be
   * resolved or not depending on `Object.entries` ordering, which is the kind of rule
   * that works until somebody adds the third entry.
   */
  it('has no dependency that is itself dependent on another', () => {
    for (const prerequisite of Object.values(PERMISSION_REQUIRES)) {
      expect(PERMISSION_REQUIRES[prerequisite]).toBeUndefined();
    }
  });

  /*
   * A seed shipping in the state this rule silently repairs would be the catalogue
   * promising something the role cannot do — the `receipt_reviewer` defect, which
   * reached a release and needed migration 0055 to undo. This is the guard that
   * would have caught it.
   */
  it('seeds no role that would lose a permission to this rule', () => {
    for (const seed of ROLE_SEEDS) {
      expect({ role: seed.key, incoherent: incoherentPermissionGrants(seed.permissions) }).toEqual({
        role: seed.key,
        incoherent: [],
      });
    }
  });

  it('reports the missing prerequisite to whoever is composing the grant', () => {
    expect(incoherentPermissionGrants(['orders.fulfil' as PermissionKey])).toEqual([
      { permission: 'orders.fulfil', requires: 'orders.view' },
    ]);
    expect(
      incoherentPermissionGrants(['orders.fulfil', 'orders.view'] as PermissionKey[]),
    ).toEqual([]);
  });
});
