import { describe, expect, it } from 'vitest';
import {
  GATEWAY_HEALTH_OPERATIONAL_CODES,
  MANAGEMENT_CONDITION_RECOVERY_CODES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_PERMISSIONS,
  NOTIFICATION_ENTITY_LINKS,
  NOTIFICATION_RULES,
  PERMISSION_KEYS,
  ROLE_SEEDS,
  inboxListQuerySchema,
  isNotification,
  notificationRuleFor,
  visibleNotificationCategories,
} from '@nexa/contracts';
import { linkFor } from '../../apps/api/src/modules/platform/opslog/application/notification-center.service';

/**
 * Phase B3: the rule table that turns operational events into notifications — the
 * extension point other phases plug into — and the rules the inbox derives from it.
 */
describe('the notification rules', () => {
  it('admits each category by an existing view permission', () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(PERMISSION_KEYS).toContain(NOTIFICATION_CATEGORY_PERMISSIONS[category]);
    }
  });

  it('declares each rule by exactly one of code or prefix, and no code twice', () => {
    const codes = new Set<string>();
    for (const rule of NOTIFICATION_RULES) {
      expect((rule.code === undefined) !== (rule.prefix === undefined)).toBe(true);
      if (rule.code !== undefined) {
        expect(codes.has(rule.code), rule.code).toBe(false);
        codes.add(rule.code);
      }
    }
  });

  it('routes every gateway health code to the inbox (Gateway Health × Notification Center)', () => {
    // The two phases meet here: a code Gateway Health watches (B2) with no rule would show on
    // the gateway's card and never reach an operator's inbox.
    for (const code of GATEWAY_HEALTH_OPERATIONAL_CODES) {
      const rule = notificationRuleFor(code);
      expect(rule, code).not.toBeNull();
      expect(['PAYMENTS', 'GATEWAYS'], code).toContain(rule?.category);
      expect(rule?.minSeverity, code).toBe('WARN');
    }
  });

  it('never makes a recovery a notification, whatever its code', () => {
    for (const code of MANAGEMENT_CONDITION_RECOVERY_CODES) {
      expect(isNotification({ code, severity: 'CRITICAL', recoversCode: null })).toBe(false);
    }
    expect(
      isNotification({
        code: 'panel.health.unreachable',
        severity: 'ERROR',
        recoversCode: 'panel.health.unreachable',
      }),
    ).toBe(false);
  });

  it('applies the minimum severity, and does not mirror routine events or denials', () => {
    expect(
      isNotification({ code: 'panel.health.degraded', severity: 'WARN', recoversCode: null }),
    ).toBe(true);
    expect(
      isNotification({ code: 'panel.health.restored', severity: 'INFO', recoversCode: null }),
    ).toBe(false);
    expect(
      isNotification({ code: 'access.permission_denied', severity: 'WARN', recoversCode: null }),
    ).toBe(false);
    expect(
      isNotification({ code: 'panel.monitor.probe', severity: 'ERROR', recoversCode: null }),
    ).toBe(false);
    expect(isNotification({ code: 'system.ping', severity: 'CRITICAL', recoversCode: null })).toBe(
      false,
    );
  });

  it('prefers an exact rule to a prefix, and routes the incident hook by prefix', () => {
    expect(notificationRuleFor('panel.monitor.tenant_budget_exceeded')?.link).toBe('PANELS');
    expect(notificationRuleFor('panel.health.tls_failed')?.category).toBe('PANELS');
    expect(notificationRuleFor('incident.opened')?.category).toBe('INCIDENTS');
    expect(notificationRuleFor('maintenance.scheduled')?.category).toBe('INCIDENTS');
  });

  it('shows each seeded role the categories its permissions open, and the owner all of them', () => {
    const role = (key: string) => ROLE_SEEDS.find((seed) => seed.key === key)?.permissions ?? [];
    expect(visibleNotificationCategories(role('owner'))).toEqual([...NOTIFICATION_CATEGORIES]);
    expect(visibleNotificationCategories(role('finance'))).toContain('PAYMENTS');
    expect(visibleNotificationCategories(role('finance'))).not.toContain('PANELS');
    expect(visibleNotificationCategories([])).toEqual([]);
  });
});

describe('the deep link', () => {
  it('carries the subject’s id for an entity target, and only when it is a UUID', () => {
    const id = '019210ab-cdef-7012-8345-6789abcdef01';
    expect(linkFor('payments.gateway_review_unresolved', { paymentId: id })).toEqual({
      target: 'PAYMENT',
      id,
    });
    expect(linkFor('payments.gateway_review_unresolved', { paymentId: '../../x' })).toEqual({
      target: 'PAYMENTS',
      id: null,
    });
    expect(linkFor('panel.health.unreachable', null)).toEqual({ target: 'PANELS', id: null });
    expect(linkFor('backup.run_failed', { backupId: id })).toEqual({
      target: 'RECOVERY',
      id: null,
    });
  });

  it('falls back from every entity target to a list target', () => {
    for (const [target, entity] of Object.entries(NOTIFICATION_ENTITY_LINKS)) {
      expect(NOTIFICATION_ENTITY_LINKS[entity.fallback], target).toBeUndefined();
    }
  });
});

describe('the inbox page cursor', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const id = '01900000-0000-7000-8000-0000000000aa';

  it('is both halves or neither: half a cursor is refused, never read as page 1', () => {
    expect(inboxListQuerySchema.safeParse({}).success).toBe(true);
    expect(inboxListQuerySchema.safeParse({ beforeAt: at, beforeId: id }).success).toBe(true);
    expect(inboxListQuerySchema.safeParse({ beforeAt: at }).success).toBe(false);
    expect(inboxListQuerySchema.safeParse({ beforeId: id }).success).toBe(false);
  });
});
