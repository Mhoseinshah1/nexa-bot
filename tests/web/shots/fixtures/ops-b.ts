import {
  SETTINGS,
  operationalEventListResponseSchema,
  settingListResponseSchema,
} from '@nexa/contracts';
import { ago, fixture, type ShotFixture } from '../fixture.ts';

/*
 * Page family OPS-B: settings, features, reminders, content, support, tickets,
 * the ops group, alerts, notifications, system, recovery. The OPS-B agent adds
 * the fixtures its pages need here.
 */

/** Every registered setting at its default — the real settings page, unedited. */
const SETTINGS_AT_DEFAULT = SETTINGS.map((definition) => ({
  key: definition.key,
  value: definition.defaultValue,
  source: 'DEFAULT',
  version: null,
  updatedAt: null,
  updatedByAdminId: null,
  description: definition.description,
  zeroMeaning: definition.zeroMeaning,
  mutability: definition.mutability,
  classification: definition.classification,
  configures: definition.configures,
  consumer: definition.consumer,
  storedValueInvalid: false,
}));

export const EVENTS = [
  {
    id: '01a05e35-c9ad-7e93-bef3-1ed9b5529e01',
    code: 'admin.roles_changed',
    severity: 'WARN',
    message: 'Roles for administrator "sara" changed from [support] to [operator].',
    context: null,
    occurrenceCount: 1,
    firstSeenAt: ago(45),
    lastSeenAt: ago(45),
    correlationId: 'c1',
    recoversCode: null,
    resolvedAt: null,
    resolvedByEventId: null,
  },
  {
    id: '01a05e35-c9ad-7e93-bef3-1ed9b5529e02',
    code: 'panel.monitor.tenant_budget_exceeded',
    severity: 'ERROR',
    message: 'The tenant probe budget cannot keep 84 panels inside the freshness window.',
    context: null,
    occurrenceCount: 12,
    firstSeenAt: ago(600),
    lastSeenAt: ago(4),
    correlationId: 'c2',
    recoversCode: null,
    resolvedAt: null,
    resolvedByEventId: null,
  },
];

export const OPS_B: readonly ShotFixture[] = [
  fixture('/settings', settingListResponseSchema, { settings: SETTINGS_AT_DEFAULT }),
  fixture('/ops-log', operationalEventListResponseSchema, { events: EVENTS, nextCursor: null }),
];
