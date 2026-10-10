import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  JOB_LOOP_RECOVERED_CODE,
  JOB_LOOP_STALLED_CODE,
  type OperationalEventInput,
  type TenantContext,
} from '@nexa/contracts';
import {
  LoopStallReporter,
  loopStallConditionKey,
  stalledAfterGrace,
} from '../../apps/api/src/modules/platform/opslog/application/loop-stall-reporter';
import {
  PROVISIONER_LANES,
  ProvisionerLoop,
  STALE_TICK_MULTIPLE,
} from '../../apps/api/src/modules/commerce/provisioning/application/provisioner-loop';
import { operationalEventDetails } from '../../apps/api/src/modules/control/notifications/application/event-details';
import type { ProvisionerService } from '../../apps/api/src/modules/commerce/provisioning/application/provisioner.service';
import type { DeliveryService } from '../../apps/api/src/modules/commerce/provisioning/application/delivery.service';
import type { OperationOutcomeAnnouncer } from '../../apps/api/src/modules/commerce/messaging/application/operation-outcome-announcer';

/**
 * FIX-03 (batch 2026-10-10): the provisioner, monitor and recovery roles report a stalled
 * loop to the operations log, as the worker has since FIX-05. Before this, a provisioner
 * whose refund lane threw on every tick logged an error line and went stale in its own
 * container's health check — and nothing reached an operator.
 */

const scope = { tenantId: 'tenant-1', botInstanceId: null } as unknown as TenantContext;
const TICK_MS = 5_000;
const WINDOW = TICK_MS * STALE_TICK_MULTIPLE;

function provisionerWith(failing: Set<string>, clock: { now: number }) {
  const lane = (name: string) => ({
    settleDue: async () => {
      if (failing.has(name)) throw new Error(`${name} row failed`);
      return 0;
    },
  });
  const executor = {
    runOnce: async () => {
      if (failing.has('drain')) throw new Error('drain failed');
      return { kind: 'IDLE' };
    },
  } as unknown as ProvisionerService;
  return new ProvisionerLoop(
    executor,
    { deliverDue: async () => undefined } as unknown as DeliveryService,
    {
      announce: async () => undefined,
      announceDue: async () => undefined,
    } as unknown as OperationOutcomeAnnouncer,
    {
      scope: () => scope,
      cashback: lane('cashback'),
      referrals: lane('referrals'),
      serviceRefunds: lane('serviceRefunds'),
      tickMs: TICK_MS,
      now: () => clock.now,
      logger: { info: () => undefined, error: () => undefined },
    },
  );
}

function reporterFor(role: 'provisioner' | 'monitor' | 'recovery', clock: { now: number }) {
  const events: OperationalEventInput[] = [];
  const reporter = new LoopStallReporter({
    recorder: {
      record: async (_scope: unknown, event: OperationalEventInput) => {
        events.push(event);
        return {} as never;
      },
    },
    conditions: { openConditions: async () => [] },
    scope: () => scope,
    clock: { now: () => new Date(clock.now) },
    logger: { warn: vi.fn() },
    role,
  });
  return { reporter, events };
}

describe('a stalled provisioner lane is a condition in the operations log', () => {
  it('opens job.loop_stalled naming the lane and the role, and closes it when the lane recovers', async () => {
    const clock = { now: 1_000_000 };
    const failing = new Set(['serviceRefunds']);
    const loop = provisionerWith(failing, clock);
    const { reporter, events } = reporterFor('provisioner', clock);

    await loop.tick();
    // Inside the window: nothing is stalled yet, and nothing is said.
    await reporter.observe(loop.laneStatuses(clock.now));
    expect(events).toEqual([]);

    clock.now += WINDOW + 1;
    await loop.tick();
    const statuses = loop.laneStatuses(clock.now);
    expect(statuses.filter((lane) => lane.stalled).map((lane) => lane.name)).toEqual([
      'provisioner-service-refunds',
    ]);
    await reporter.observe(statuses);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      code: JOB_LOOP_STALLED_CODE,
      severity: 'ERROR',
      dedupeKey: loopStallConditionKey('provisioner-service-refunds'),
      message: 'Provisioner loop "provisioner-service-refunds" has stopped making progress.',
      context: { kind: 'provisioner-service-refunds', processRole: 'provisioner' },
    });
    // The group message carries both names, through the allow-list.
    const details = operationalEventDetails(events[0]?.context);
    expect(details).toContain('kind: provisioner-service-refunds');
    expect(details).toContain('processRole: provisioner');

    failing.clear();
    await loop.tick();
    await reporter.observe(loop.laneStatuses(clock.now));
    expect(events.map((event) => event.code)).toEqual([
      JOB_LOOP_STALLED_CODE,
      JOB_LOOP_RECOVERED_CODE,
    ]);
    expect(events[1]).toMatchObject({
      recoversCode: JOB_LOOP_STALLED_CODE,
      recoversDedupeKey: loopStallConditionKey('provisioner-service-refunds'),
    });
  });

  it('names the drain itself when the provisioning drain is what fails', async () => {
    const clock = { now: 1_000_000 };
    const loop = provisionerWith(new Set(['drain']), clock);
    await loop.tick();
    clock.now += WINDOW + 1;
    await loop.tick();
    expect(
      loop
        .laneStatuses(clock.now)
        .filter((lane) => lane.stalled)
        .map((lane) => lane.name),
    ).toEqual(['provisioner']);
    // Readiness is unchanged: any failure in a tick still costs its progress.
    expect(loop.iterationIsFresh(clock.now)).toBe(false);
  });

  it('reports nothing stalled for a loop never started (the provisioner disabled)', () => {
    const loop = provisionerWith(new Set(), { now: 1 });
    expect(loop.laneStatuses(10 * WINDOW)).toEqual(
      PROVISIONER_LANES.map((name) => ({ name, stalled: false })),
    );
  });

  it('prefixes every lane, so none shares a dedupe key with a worker loop', () => {
    const worker = readFileSync(join(__dirname, '../../apps/api/src/main.worker.ts'), 'utf8');
    const workerLoops = [...worker.matchAll(/\[\s*'([a-z-]+)',\s*(?:true|config\.)/g)].map(
      (match) => match[1],
    );
    expect(workerLoops.length).toBeGreaterThan(10);
    for (const lane of PROVISIONER_LANES) {
      expect(lane.startsWith('provisioner')).toBe(true);
      expect(workerLoops).not.toContain(lane);
    }
  });
});

describe('stalledAfterGrace: no false alarm on the first heartbeat after a restart', () => {
  it('is stalled only once the grace since start has passed without progress', () => {
    const base = { startedAtMs: 0, graceMs: 100 };
    expect(stalledAfterGrace({ ...base, fresh: false, nowMs: 100 })).toBe(false);
    expect(stalledAfterGrace({ ...base, fresh: false, nowMs: 101 })).toBe(true);
    expect(stalledAfterGrace({ ...base, fresh: true, nowMs: 10_000 })).toBe(false);
  });

  it('never calls a loop that was not started stalled', () => {
    expect(stalledAfterGrace({ fresh: false, startedAtMs: null, nowMs: 1e12, graceMs: 1 })).toBe(
      false,
    );
  });

  it('names the monitor and the recovery executor as their own roles', async () => {
    for (const role of ['monitor', 'recovery'] as const) {
      const clock = { now: 0 };
      const { reporter, events } = reporterFor(role, clock);
      await reporter.observe([{ name: `${role}-loop`, stalled: true }]);
      expect(events[0]?.context).toMatchObject({ processRole: role });
      expect(events[0]?.message).toMatch(/^(Monitor|Recovery) loop /);
    }
  });
});

describe('every background role reports its stalled loops', () => {
  const src = join(__dirname, '../../apps/api/src');
  /**
   * Read from disk rather than listed: a role added later that starts a heartbeat and does
   * not report is the defect this batch closed for three roles. The assistant is the one
   * stated exception — its stall is raised from the worker, by the watch that sees due AI
   * work unclaimed (`support.assistant.stalled`), which a dead assistant cannot suppress.
   */
  const roles = readdirSync(src)
    .filter((name) => /^main\.\w+\.ts$/.test(name))
    .map((name) => [name, readFileSync(join(src, name), 'utf8')] as const)
    .filter(([, source]) => source.includes('startHeartbeat('));

  it('finds the roles, so the rule below cannot pass vacuously', () => {
    expect(roles.map(([name]) => name).sort()).toEqual([
      'main.assistant.ts',
      'main.monitor.ts',
      'main.provisioner.ts',
      'main.recovery.ts',
      'main.worker.ts',
    ]);
  });

  it('builds a reporter for its own role and feeds it from the heartbeat', () => {
    for (const [name, source] of roles) {
      if (name === 'main.assistant.ts') continue;
      const role = /^main\.(\w+)\.ts$/.exec(name)?.[1];
      expect(source, name).toContain(`loopStallReporterFor(container, '${role}')`);
      expect(source, name).toMatch(/void loopStalls\.observe\(/);
    }
  });
});
