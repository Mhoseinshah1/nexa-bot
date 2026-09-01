import { describe, expect, it } from 'vitest';
import {
  isPermissionKey,
  PERMISSIONS,
  PERMISSION_KEYS,
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
