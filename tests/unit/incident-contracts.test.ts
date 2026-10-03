import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_NOTIFICATION_KINDS,
  INCIDENT_KINDS,
  NOTIFICATION_CATEGORY_PERMISSIONS,
  NOTIFICATION_RULES,
  PERMISSION_REQUIRES,
  ROLE_SEEDS,
  createIncidentRequestSchema,
  incidentConditionKey,
  incidentOpsCode,
  isNotification,
  isValidIncidentTarget,
  notificationRuleFor,
} from '@nexa/contracts';

/**
 * Phase E3: the incident vocabulary's small rules — that every code an incident records
 * lands in the Notification Center's INCIDENTS category, that a recovery never becomes a
 * notification, and that a target is checked for its shape before any module is asked.
 */
describe('the incident operational codes', () => {
  it('routes every code an incident records to INCIDENTS, linked to the incident', () => {
    for (const kind of INCIDENT_KINDS) {
      for (const what of ['scheduled', 'started', 'cancelled', 'effects_pending'] as const) {
        const code = incidentOpsCode(kind, what);
        const rule = notificationRuleFor(code);
        expect(rule?.category, code).toBe('INCIDENTS');
        expect(rule?.link, code).toBe('INCIDENT');
        expect(isNotification({ code, severity: 'INFO', recoversCode: null }), code).toBe(true);
      }
    }
  });

  it('never makes the resolution a notification: it closes the started condition', () => {
    const code = incidentOpsCode('INCIDENT', 'resolved');
    expect(
      isNotification({
        code,
        severity: 'INFO',
        recoversCode: incidentOpsCode('INCIDENT', 'started'),
      }),
    ).toBe(false);
  });

  it('names one condition per incident', () => {
    expect(incidentConditionKey('abc')).toBe('incident:abc');
    expect(incidentOpsCode('MAINTENANCE', 'started')).toBe('maintenance.started');
  });
});

describe('the incident targets', () => {
  it('accepts a UUID for entities and a provider code for a gateway, and nothing crossed', () => {
    const uuid = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
    expect(isValidIncidentTarget({ kind: 'PANEL', ref: uuid })).toBe(true);
    expect(isValidIncidentTarget({ kind: 'GATEWAY', ref: 'TONPAYS' })).toBe(true);
    expect(isValidIncidentTarget({ kind: 'GATEWAY', ref: uuid })).toBe(false);
    expect(isValidIncidentTarget({ kind: 'PRODUCT', ref: 'TONPAYS' })).toBe(false);
  });

  it('defaults to no stop of sales and no targets', () => {
    const parsed = createIncidentRequestSchema.parse({
      idempotencyKey: 'key-12345',
      kind: 'INCIDENT',
      severity: 'MINOR',
      title: 'x',
    });
    expect(parsed.stopSales).toBe(false);
    expect(parsed.targets).toEqual([]);
    expect(parsed.scheduledStartAt).toBeNull();
  });
});

describe('the incident permissions and notice kind', () => {
  it('requires view for manage and notify, and gives support view only', () => {
    expect(PERMISSION_REQUIRES['incidents.manage']).toBe('incidents.view');
    expect(PERMISSION_REQUIRES['incidents.notify']).toBe('incidents.view');
    const support = ROLE_SEEDS.find((role) => role.key === 'support');
    expect(support?.permissions).toContain('incidents.view');
    expect(support?.permissions).not.toContain('incidents.manage');
    expect(support?.permissions).not.toContain('incidents.notify');
  });

  it('declares the notice as a closed lane kind', () => {
    expect(CUSTOMER_NOTIFICATION_KINDS).toContain('INCIDENT_NOTICE');
  });
});

describe('the notification links (review of #162)', () => {
  /** The key each entity page — and the compensation list — charges for reading it. */
  const PAGE_PERMISSION: Readonly<Record<string, string>> = {
    PAYMENT: 'payments.view',
    PANEL: 'panels.view',
    SERVICE: 'services.view',
    ORDER: 'orders.view',
    INCIDENT: 'incidents.view',
    COMPENSATIONS: 'payments.view',
  };

  it('links each rule only where its category key reaches', () => {
    for (const rule of NOTIFICATION_RULES) {
      const needed = PAGE_PERMISSION[rule.link];
      if (needed === undefined) continue;
      expect(NOTIFICATION_CATEGORY_PERMISSIONS[rule.category], rule.code ?? rule.prefix).toBe(
        needed,
      );
    }
  });

  it('files an undeliverable refund under payments, linked to the compensation list', () => {
    expect(notificationRuleFor('order.refunded_undeliverable')).toMatchObject({
      category: 'PAYMENTS',
      link: 'COMPENSATIONS',
    });
  });
});
