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
  denialEventRecorded,
  PermissionGuard,
  type PermissionResolver,
} from '../../apps/api/src/modules/platform/access/application/permission-guard';
import { recordMutationDenial } from '../../apps/api/src/modules/platform/access/application/authorized-mutation';
import type { AuditEntry, AuditWriter } from '@nexa/contracts';

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

/**
 * ONE denial, ONE event, ONE audit row — on both paths.
 *
 * OQ-3D-03: for a round, every pre-transaction denial wrote
 * `access.permission_denied` TWICE. `PermissionGuard.check` recorded it when no
 * transaction was passed, and `recordMutationDenial` recorded it again for the
 * same refusal. That code never resolves, so an operator counting denials on
 * the alerts page counted double, permanently.
 *
 * The guard is the single authority now. It marks the error it throws when it
 * wrote the event; `recordMutationDenial` writes one only when the guard could
 * not — inside a transaction, where the guard deliberately writes nothing.
 *
 * Pinned HERE, at the unit level, because this is the one place both branches
 * of that decision can be driven directly: over HTTP every early check is the
 * pre-transaction branch, and the in-transaction branch needs a revocation to
 * land between the early check and the lock. The integration suite pins the
 * first branch per route; this pins both, exactly, and the exactness is the
 * point — a floor cannot tell one recorder from two.
 */
describe('one denial is one event and one audit row', () => {
  class RecordingAudit implements AuditWriter {
    readonly entries: AuditEntry[] = [];
    async record(_scope: ScopeContext, _actor: ActorContext, entry: AuditEntry): Promise<void> {
      this.entries.push(entry);
    }
  }

  const PERMISSION = 'panels.edit' as PermissionKey;
  const denial = { action: 'panel.update', entityType: 'Panel', entityId: 'panel-1' };

  async function refusedBy(theGuard: PermissionGuard, tx: unknown): Promise<unknown> {
    try {
      await theGuard.check(scope, webAdmin, PERMISSION, tx);
    } catch (error) {
      return error;
    }
    throw new Error('the guard granted a permission the resolver does not hold');
  }

  it('PRE-transaction: the guard writes the event, the recorder writes only the audit row', async () => {
    const { guard: g, opsLog } = guard();
    const audit = new RecordingAudit();
    const error = await refusedBy(g, undefined);

    expect(denialEventRecorded(error), 'the guard says it recorded').toBe(true);
    expect(opsLog.events.map((e) => e.code)).toEqual(['access.permission_denied']);

    await recordMutationDenial(
      { guard: g, opsLog, audit },
      scope,
      webAdmin,
      PERMISSION,
      denial,
      error,
    );

    // EXACTLY one. Two is the duplicate this closes; zero is the denial
    // vanishing. Both are one edit away and both fail here.
    expect(opsLog.events.filter((e) => e.code === 'access.permission_denied')).toHaveLength(1);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      action: 'panel.update',
      entityType: 'Panel',
      entityId: 'panel-1',
      result: 'DENIED',
      after: { deniedPermission: PERMISSION },
    });
  });

  it('IN-transaction: the guard writes nothing, the recorder writes the event and the audit row', async () => {
    const { guard: g, opsLog } = guard();
    const audit = new RecordingAudit();
    const error = await refusedBy(g, { inside: 'a transaction' });

    expect(denialEventRecorded(error), 'the guard says it did NOT record').toBe(false);
    expect(opsLog.events, 'nothing from inside a transaction').toHaveLength(0);

    await recordMutationDenial(
      { guard: g, opsLog, audit },
      scope,
      webAdmin,
      PERMISSION,
      denial,
      error,
    );

    // The surviving emitter. Removing it makes this zero, not one.
    expect(opsLog.events.filter((e) => e.code === 'access.permission_denied')).toHaveLength(1);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.result).toBe('DENIED');
  });

  it('keeps the marker off the wire', async () => {
    // `details` is serialised into the 403 body. The marker is bookkeeping
    // between the guard and the recorder, and a client must not see it.
    const { guard: g } = guard();
    const error = await refusedBy(g, undefined);
    expect(denialEventRecorded(error)).toBe(true);
    expect(Object.keys(error as object)).not.toContain('recorded');
    expect(JSON.stringify(error)).not.toContain('denialEventRecorded');
    expect(JSON.stringify((error as { details: unknown }).details)).not.toContain('recorded');
  });

  it('answers false for an error the guard did not throw', () => {
    expect(denialEventRecorded(new Error('not a denial'))).toBe(false);
    expect(denialEventRecorded(null)).toBe(false);
    expect(denialEventRecorded('denied')).toBe(false);
  });

  it('writes the audit row before the event, so a failing event write cannot cost it', async () => {
    // The two writes are not atomic. The audit row is the half an operator
    // needs later; ordering it first is the only thing that keeps it when the
    // operational log is down. The write's error still propagates — a
    // recorder that swallowed it would hide an outage behind a clean 403.
    const { guard: g } = guard();
    const audit = new RecordingAudit();
    const down: OperationalEventRecorder = {
      record: async () => {
        throw new Error('the operational log is down');
      },
    };
    const error = await refusedBy(g, { inside: 'a transaction' });
    await expect(
      recordMutationDenial(
        { guard: g, opsLog: down, audit },
        scope,
        webAdmin,
        PERMISSION,
        denial,
        error,
      ),
    ).rejects.toThrow('the operational log is down');
    expect(audit.entries, 'the audit row must be written before the event').toHaveLength(1);
    expect(audit.entries[0]?.result).toBe('DENIED');
  });

  it('writes no audit row for a refusal that is not THIS permission', async () => {
    // Pre-existing rule of `recordMutationDenial`, restated here so the new
    // branch cannot widen it: a PERMISSION_DENIED for a different permission
    // is somebody else's denial, and a missing tenant context is not a denial
    // at all.
    const { guard: g, opsLog } = guard();
    const audit = new RecordingAudit();
    const error = await refusedBy(g, undefined);
    await recordMutationDenial(
      { guard: g, opsLog, audit },
      scope,
      webAdmin,
      'panels.credentials.rotate' as PermissionKey,
      denial,
      error,
    );
    expect(audit.entries).toHaveLength(0);
    expect(opsLog.events).toHaveLength(1);
  });
});
