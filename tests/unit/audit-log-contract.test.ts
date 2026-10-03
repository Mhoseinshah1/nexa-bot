import { describe, expect, it } from 'vitest';
import {
  AUDIT_CRITICAL_ACTIONS,
  auditLogExportQuerySchema,
  auditLogListQuerySchema,
  auditSecurityClasses,
  permissionDefinition,
  PERMISSION_REQUIRES,
  ROLE_SEEDS,
} from '@nexa/contracts';

/**
 * Phase D1: the audit log browser's contract (`docs/audit-log.md`).
 */
describe('the CRITICAL action table', () => {
  it('names only CRITICAL permissions, so a downgrade takes its actions out loudly', () => {
    for (const [action, keys] of Object.entries(AUDIT_CRITICAL_ACTIONS)) {
      expect(keys.length, action).toBeGreaterThan(0);
      for (const key of keys) {
        expect(permissionDefinition(key).riskLevel, `${action} -> ${key}`).toBe('CRITICAL');
      }
    }
  });

  it('does not call an ordinary wallet credit critical (its key depends on the amount)', () => {
    expect(Object.hasOwn(AUDIT_CRITICAL_ACTIONS, 'wallet.credit')).toBe(false);
    expect(auditSecurityClasses({ action: 'wallet.credit', result: 'SUCCESS' })).toEqual([]);
  });
});

describe('auditSecurityClasses', () => {
  it('classifies a denial, an authentication event and a critical action', () => {
    expect(auditSecurityClasses({ action: 'product.update', result: 'DENIED' })).toEqual([
      'DENIED',
    ]);
    expect(auditSecurityClasses({ action: 'auth.login', result: 'SUCCESS' })).toEqual(['AUTH']);
    expect(auditSecurityClasses({ action: 'admin.password_change', result: 'SUCCESS' })).toEqual([
      'AUTH',
    ]);
    expect(auditSecurityClasses({ action: 'wallet.debit', result: 'DENIED' })).toEqual([
      'DENIED',
      'CRITICAL',
    ]);
    expect(auditSecurityClasses({ action: 'payment.confirm', result: 'SUCCESS' })).toEqual([]);
  });

  it('does not read an inherited property as a critical action', () => {
    expect(auditSecurityClasses({ action: 'constructor', result: 'SUCCESS' })).toEqual([]);
  });
});

describe('audit.export', () => {
  it('is HIGH, requires audit.view, and is seeded to the owner alone', () => {
    expect(permissionDefinition('audit.export').riskLevel).toBe('HIGH');
    expect(PERMISSION_REQUIRES['audit.export']).toBe('audit.view');
    const holders = ROLE_SEEDS.filter((role) => role.permissions.includes('audit.export')).map(
      (role) => role.key,
    );
    expect(holders).toEqual(['owner']);
  });
});

describe('the filter schemas', () => {
  it('refuses an entity id without its type, and a range that is not ordered', () => {
    expect(auditLogListQuerySchema.safeParse({ entityId: 'x' }).success).toBe(false);
    expect(auditLogListQuerySchema.safeParse({ entityType: 'Order', entityId: 'x' }).success).toBe(
      true,
    );
    const at = '2026-10-01T00:00:00.000Z';
    expect(auditLogListQuerySchema.safeParse({ from: at, to: at }).success).toBe(false);
    expect(auditLogExportQuerySchema.safeParse({ from: at, to: at }).success).toBe(false);
  });

  it('accepts an action code or a family, and nothing a LIKE could misread', () => {
    expect(auditLogListQuerySchema.safeParse({ action: 'payment.' }).success).toBe(true);
    expect(auditLogListQuerySchema.safeParse({ action: 'payment.confirm' }).success).toBe(true);
    expect(auditLogListQuerySchema.safeParse({ action: 'payment%' }).success).toBe(false);
    expect(auditLogListQuerySchema.safeParse({ action: '' }).success).toBe(false);
  });

  it('bounds the page size, and refuses a year PostgreSQL cannot store', () => {
    expect(auditLogListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(auditLogListQuerySchema.safeParse({ limit: '100' }).success).toBe(true);
    expect(auditLogListQuerySchema.safeParse({ from: '0000-01-01T00:00:00Z' }).success).toBe(false);
  });
});
