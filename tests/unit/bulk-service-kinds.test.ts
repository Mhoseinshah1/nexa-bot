import { describe, expect, it } from 'vitest';
import {
  BULK_OPERATION_KINDS,
  BULK_SERVICE_KINDS,
  PERMISSION_REQUIRES,
  bulkGrantSchema,
  isPermissionKey,
} from '@nexa/contracts';
import {
  BULK_KIND_OPERATION,
  companionPermissionFor,
  permissionFor,
} from '../../apps/api/src/modules/commerce/bulk-operations/application/bulk-operation.service.js';
import { BULK_KIND_LEGAL_STATE } from '../../apps/api/src/modules/commerce/bulk-operations/infrastructure/drizzle-bulk-operation.repository.js';
import { OPERATION_LEGAL_FROM } from '../../apps/api/src/modules/commerce/provisioning/application/provision-executor.js';

/**
 * Program §13 — the mass service kinds, as data. The SQL eligibility predicate is built from
 * `BULK_KIND_LEGAL_STATE`; this pins it to the executor's own legal states, so the preview,
 * the frozen set and the planner cannot disagree about which services a kind may touch.
 */
describe('mass service kinds', () => {
  it('select exactly the state the planned operation is legal from', () => {
    for (const kind of BULK_SERVICE_KINDS) {
      expect([BULK_KIND_LEGAL_STATE[kind]], kind).toEqual([
        ...OPERATION_LEGAL_FROM[BULK_KIND_OPERATION[kind]],
      ]);
    }
  });

  it('charge the mass key AND the one-service key for a status change, never one alone', () => {
    expect(permissionFor('SERVICE_SUSPEND')).toBe('services.mass.status');
    expect(permissionFor('SERVICE_RESUME')).toBe('services.mass.status');
    expect(companionPermissionFor('SERVICE_SUSPEND')).toBe('services.edit');
    expect(companionPermissionFor('SERVICE_RESUME')).toBe('services.edit');
    // The kinds that existed before keep exactly their keys.
    expect(permissionFor('WALLET_CREDIT')).toBe('users.wallet.mass');
    expect(permissionFor('SERVICE_TRAFFIC')).toBe('services.mass.grant');
    expect(permissionFor('SERVICE_TIME')).toBe('services.mass.grant');
    for (const kind of BULK_OPERATION_KINDS) {
      expect(isPermissionKey(permissionFor(kind))).toBe(true);
    }
    expect(PERMISSION_REQUIRES['services.mass.status']).toBe('bulk_operations.view');
    expect(PERMISSION_REQUIRES['services.grant']).toBe('services.view');
  });

  it('offers no terminate in bulk, and a status change carries no amount', () => {
    expect(BULK_OPERATION_KINDS as readonly string[]).not.toContain('SERVICE_TERMINATE');
    expect(bulkGrantSchema.safeParse({ kind: 'SERVICE_SUSPEND' }).success).toBe(true);
    expect(bulkGrantSchema.safeParse({ kind: 'SERVICE_SUSPEND', durationDays: 3 }).success).toBe(
      false,
    );
  });
});
