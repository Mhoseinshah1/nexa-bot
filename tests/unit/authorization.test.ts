import { describe, expect, it, vi } from 'vitest';
import {
  isPermissionKey,
  SYSTEM_JOB_PERMISSIONS,
  systemContext,
  systemJobActor,
  type ActorContext,
  type CorrelationId,
  type OperationalEventInput,
  type OperationalEventRecorder,
  type PermissionKey,
  type RecordedOperationalEvent,
  type ScopeContext,
} from '@nexa/contracts';
import {
  PermissionGuard,
  type PermissionResolver,
} from '../../apps/api/src/modules/platform/access/application/permission-guard';

/**
 * A resolver that grants nothing, so these tests measure the GUARD rather than
 * a resolver's data. Phase 1 deleted the placeholder resolver from production
 * code; the empty behaviour it stood for still belongs here, where it is a test
 * fixture and cannot be wired into an application by accident.
 */
class GrantsNothingResolver implements PermissionResolver {
  async resolve(): Promise<ReadonlySet<PermissionKey>> {
    return new Set<PermissionKey>();
  }

  async permissionsIfActive(): Promise<ReadonlySet<PermissionKey>> {
    return new Set<PermissionKey>();
  }
}

const CORRELATION = 'corr-authz' as CorrelationId;
const FIXED_RECORDED_AT = new Date('2026-01-01T00:00:00.000Z');

class RecordingOpsLog implements OperationalEventRecorder {
  readonly events: OperationalEventInput[] = [];
  async record(
    _scope: ScopeContext,
    event: OperationalEventInput,
  ): Promise<RecordedOperationalEvent> {
    this.events.push(event);
    return {
      id: `recorded-${this.events.length}`,
      code: event.code,
      severity: event.severity,
      message: event.message,
      occurrenceCount: 1,
      firstSeenAt: FIXED_RECORDED_AT,
      lastSeenAt: FIXED_RECORDED_AT,
      isNew: true,
      reopened: false,
    };
  }
}

function guard() {
  const opsLog = new RecordingOpsLog();
  return { guard: new PermissionGuard(new GrantsNothingResolver(), opsLog), opsLog };
}

const scope = systemContext('test');

const customer: ActorContext = {
  type: 'CUSTOMER',
  id: 'customer-1',
  label: 'A customer',
  surface: 'TELEGRAM',
  correlationId: CORRELATION,
};

const webAdmin: ActorContext = {
  type: 'WEB_ADMIN',
  id: 'admin-1',
  label: 'An admin',
  surface: 'WEB',
  correlationId: CORRELATION,
};

describe('SYSTEM_JOB is no longer a bypass', () => {
  it('holds only the permissions the contract grants background work', async () => {
    const { guard: g } = guard();
    const job = systemJobActor('nightly', CORRELATION);

    for (const permission of SYSTEM_JOB_PERMISSIONS) {
      expect(await g.has(scope, job, permission)).toBe(true);
    }
  });

  it('is denied a permission outside that set', async () => {
    // The old guard returned early for SYSTEM_JOB, so a job — or anything that
    // could construct a SYSTEM_JOB actor — held every permission in the catalog.
    const { guard: g, opsLog } = guard();
    const job = systemJobActor('nightly', CORRELATION);

    expect(await g.has(scope, job, 'refunds.issue')).toBe(false);
    await expect(g.check(scope, job, 'refunds.issue')).rejects.toThrowError(/refunds.issue/);
    expect(opsLog.events.map((e) => e.code)).toContain('access.permission_denied');
  });

  it('grants background work only permissions that exist in the catalog', () => {
    for (const permission of SYSTEM_JOB_PERMISSIONS) {
      expect(isPermissionKey(permission)).toBe(true);
    }
  });

  it('keeps the background grant narrow', () => {
    // A growing list here should be loud. If this fails, the diff that widened
    // background work's powers is the thing to look at.
    expect([...SYSTEM_JOB_PERMISSIONS]).toEqual(['maintenance.run']);
  });
});

describe('deny by default', () => {
  it('denies a human actor everything while there are no admins', async () => {
    const { guard: g } = guard();
    for (const actor of [customer, webAdmin]) {
      expect(await g.has(scope, actor, 'users.view')).toBe(false);
      expect(await g.has(scope, actor, 'maintenance.run')).toBe(false);
    }
  });

  it('records every denial as a WARN operational event naming the actor', async () => {
    const { guard: g, opsLog } = guard();
    await expect(g.check(scope, customer, 'users.view')).rejects.toThrow();

    const [event] = opsLog.events;
    expect(event?.severity).toBe('WARN');
    expect(event?.context).toMatchObject({
      permission: 'users.view',
      actorType: 'CUSTOMER',
      surface: 'TELEGRAM',
    });
    expect(event?.correlationId).toBe(CORRELATION);
  });

  it('consults the resolver for human actors', async () => {
    const opsLog = new RecordingOpsLog();
    const resolve = vi.fn(async () => new Set<PermissionKey>(['users.view']));
    const permissionsIfActive = vi.fn(async () => new Set<PermissionKey>());
    const g = new PermissionGuard({ resolve, permissionsIfActive }, opsLog);

    expect(await g.has(scope, webAdmin, 'users.view')).toBe(true);
    expect(await g.has(scope, webAdmin, 'refunds.issue')).toBe(false);
    expect(resolve).toHaveBeenCalled();
  });

  it('does not consult the resolver for background work', async () => {
    const opsLog = new RecordingOpsLog();
    const resolve = vi.fn(async () => new Set<PermissionKey>());
    const permissionsIfActive = vi.fn(async () => new Set<PermissionKey>());
    const g = new PermissionGuard({ resolve, permissionsIfActive }, opsLog);

    await g.has(scope, systemJobActor('job', CORRELATION), 'maintenance.run');
    expect(resolve).not.toHaveBeenCalled();
  });
});
