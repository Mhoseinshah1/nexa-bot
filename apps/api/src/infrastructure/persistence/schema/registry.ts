/**
 * Database schema — registry: the drizzle `schema` object and the append-only table list.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import { botInstances, tenants } from './tenancy.js';
import {
  aggregateSequences,
  auditLogs,
  operationalEvents,
  outboxMessages,
  processedMessages,
  requestIdempotency,
} from './eventing.js';
import {
  adminLoginThrottle,
  adminPermissionOverrides,
  adminRoles,
  adminSessions,
  admins,
  rolePermissions,
  roles,
} from './identity.js';
import {
  featureFlagStates,
  settingValues,
  templateOverrides,
  templateRevisions,
} from './control-plane.js';
import {
  notificationDeliveryAttempts,
  notificationReleasedClaims,
  notifications,
} from './notifications.js';
import {
  panelCredentials,
  panelHealth,
  panelMonitorSchedule,
  panelMonitorTenants,
  panelProbeBudgets,
  panelProbeClaims,
  panels,
} from './panels.js';
import { backupRuns, processRuns, recoveryRequests } from './backup-recovery.js';

export const schema = {
  processRuns,
  tenants,
  botInstances,
  admins,
  roles,
  rolePermissions,
  adminRoles,
  adminPermissionOverrides,
  adminSessions,
  adminLoginThrottle,
  outboxMessages,
  processedMessages,
  requestIdempotency,
  auditLogs,
  operationalEvents,
  aggregateSequences,
  templateOverrides,
  templateRevisions,
  settingValues,
  featureFlagStates,
  notifications,
  notificationDeliveryAttempts,
  notificationReleasedClaims,
  panels,
  panelCredentials,
  panelHealth,
  panelProbeClaims,
  panelProbeBudgets,
  panelMonitorSchedule,
  panelMonitorTenants,
  backupRuns,
  recoveryRequests,
};

/** Tables the database itself refuses to UPDATE or DELETE. */
export const APPEND_ONLY_TABLES = [
  'audit_logs',
  'processed_messages',
  'template_revisions',
  'notification_delivery_attempts',
  // Load-bearing accounting, not just evidence: spend is `attempt_count` minus
  // these rows, so deleting one silently spends an attempt that was handed
  // back and adding one silently returns an attempt that was not.
  'notification_released_claims',
] as const;
