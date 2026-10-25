import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  templateDefinition,
  type OperationalEventInput,
  type TenantContext,
} from '@nexa/contracts';
import {
  CATALOGUE_FA,
  DEFAULT_TEMPLATE_PRESENTATION,
  LOOP_LABELS_FA,
  PROCESS_ROLE_LABELS_FA,
  renderTemplateBody,
} from '@nexa/i18n';
import { OperationalEventPresenter } from '../../apps/api/src/modules/commerce/ops-log/application/event-presenter';
import { i18nOpsLogWords } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import { NotifyingOperationalEventRecorder } from '../../apps/api/src/modules/control/notifications/application/operational-event-projector';
import { LoopStallReporter } from '../../apps/api/src/modules/platform/opslog/application/loop-stall-reporter';
import { PROVISIONER_LANES } from '../../apps/api/src/modules/commerce/provisioning/application/provisioner-loop';

/**
 * v0.8.2 hotfix, item 4: the watchdog's two messages are Persian from the first line to the
 * last, and every loop that can reach them has a Persian name.
 */

const src = join(__dirname, '../../apps/api/src');
const mainFiles = readdirSync(src).filter((name) => /^main\.\w+\.ts$/.test(name));

/**
 * The loops each process role watches, READ FROM THE SOURCES rather than listed: the
 * worker's list is inline in `main.worker.ts`, the other roles name theirs in a constant
 * (`PANEL_MONITOR_LOOP`, …), and the provisioner's are `PROVISIONER_LANES`.
 */
function watchedLoops(): string[] {
  const names = new Set<string>(PROVISIONER_LANES);
  for (const file of mainFiles) {
    const source = readFileSync(join(src, file), 'utf8');
    for (const match of source.matchAll(/\[\s*'([a-z0-9-]+)',\s*(?:true|config\.)/g)) {
      names.add(match[1] as string);
    }
    for (const match of source.matchAll(/const [A-Z_]+_LOOP = '([a-z0-9-]+)'/g)) {
      names.add(match[1] as string);
    }
  }
  return [...names].sort();
}

const reportingRoles = (): string[] =>
  mainFiles
    .map((name) =>
      /loopStallReporterFor\(container, '(\w+)'\)/.exec(readFileSync(join(src, name), 'utf8')),
    )
    .flatMap((match) => (match === null ? [] : [match[1] as string]))
    .sort();

describe('every watched loop has a Persian label', () => {
  it('finds the loops, so the rule below cannot pass vacuously', () => {
    const loops = watchedLoops();
    expect(loops.length).toBeGreaterThan(35);
    for (const known of [
      'backup-scheduler',
      'backup-housekeeping',
      'legacy-compaction-executor',
      'fx-refresh',
      'panel-monitor',
      'recovery-executor',
      'migration-executor',
      'provisioner-service-refunds',
    ]) {
      expect(loops).toContain(known);
    }
  });

  it('labels every loop of every role, in Persian', () => {
    const unlabelled = watchedLoops().filter((loop) => !Object.hasOwn(LOOP_LABELS_FA, loop));
    expect(unlabelled).toEqual([]);
    for (const [loop, label] of Object.entries(LOOP_LABELS_FA)) {
      expect(label, loop).toMatch(/[؀-ۿ]/);
      expect(label, loop).not.toMatch(/[A-Za-z]/);
    }
  });

  it('keeps no label for a loop nobody watches', () => {
    const watched = new Set(watchedLoops());
    expect(Object.keys(LOOP_LABELS_FA).filter((loop) => !watched.has(loop))).toEqual([]);
  });

  it('labels every process role that reports, and the assistant', () => {
    expect(reportingRoles()).toEqual(['migration', 'monitor', 'provisioner', 'recovery', 'worker']);
    for (const role of [...reportingRoles(), 'assistant']) {
      expect(PROCESS_ROLE_LABELS_FA[role], role).toMatch(/^[؀-ۿ‌ ]+$/);
    }
  });
});

describe('the rendered messages carry no English outside the one technical line', () => {
  const tenant = { tenantId: '01900000-0000-7000-8000-000000000001', botInstanceId: null };
  const at = new Date('2026-10-25T08:00:00Z');

  /** Both messages of one loop, rendered exactly as the group receives them. */
  async function render(
    loop: string,
    role: 'worker' | 'monitor' | 'recovery' | 'provisioner' | 'migration',
  ) {
    const queued: { templateKey: string; values: Record<string, never> }[] = [];
    const projector = new NotifyingOperationalEventRecorder(
      {
        record: async (
          _scope: unknown,
          input: { code: string; severity: string; message: string },
        ) => ({
          id: 'ev-1',
          code: input.code,
          severity: input.severity,
          message: input.message,
          occurrenceCount: 3,
          firstSeenAt: at,
          lastSeenAt: at,
          isNew: true,
          reopened: false,
        }),
      } as never,
      { queue: async (_scope: unknown, input: never) => queued.push(input) } as never,
      {
        runNested: async (_scope: unknown, _tx: unknown, fn: (tx: unknown) => unknown) => fn({}),
      } as never,
      { error: () => undefined } as never,
      new OperationalEventPresenter({ facts: {} as never, words: i18nOpsLogWords }),
    );
    const reporter = new LoopStallReporter({
      recorder: {
        record: (scope: TenantContext, event: OperationalEventInput) =>
          projector.record(scope, event, {} as never),
      } as never,
      conditions: { openConditions: async () => [] },
      scope: () => tenant as unknown as TenantContext,
      clock: { now: () => at },
      logger: { warn: () => undefined },
      role,
      bootGraceMs: 0,
      recoveryConfirmMs: 0,
    });
    await reporter.observe([{ name: loop, stalled: true }]);
    await reporter.observe([{ name: loop, stalled: false }]);
    return queued.map((message) =>
      renderTemplateBody(
        templateDefinition(message.templateKey as never),
        (CATALOGUE_FA as Record<string, string>)[message.templateKey] as string,
        message.values,
        'fa',
        DEFAULT_TEMPLATE_PRESENTATION,
      ),
    );
  }

  it('says the loop and the role in Persian, and keeps the loop key on the one technical line', async () => {
    const [stalled, recovered] = await render('backup-scheduler', 'worker');
    expect(stalled).toContain('کار پس‌زمینه متوقف مانده است — زمان‌بند بکاپ');
    expect(stalled).toContain('🔧 job.loop_stalled · backup-scheduler');
    expect(stalled).toContain('فرایند: کارگر پس‌زمینه');
    expect(recovered).toContain('کار پس‌زمینه دوباره راه افتاد — زمان‌بند بکاپ');
    expect(recovered).toContain('🔧 job.loop_recovered · backup-scheduler');
  });

  it('has no Latin letter on any line but the technical one, for every loop and role', async () => {
    const roleOf = (loop: string) =>
      loop === 'panel-monitor'
        ? 'monitor'
        : loop === 'recovery-executor'
          ? 'recovery'
          : loop === 'migration-executor'
            ? 'migration'
            : loop.startsWith('provisioner')
              ? 'provisioner'
              : 'worker';
    for (const loop of watchedLoops()) {
      const messages = await render(loop, roleOf(loop));
      expect(messages, loop).toHaveLength(2);
      for (const message of messages) {
        const prose = message
          .split('\n')
          .filter((line) => !line.startsWith('🔧'))
          .join('\n');
        expect(prose, `${loop}\n${message}`).not.toMatch(/[A-Za-z]/);
        expect(prose, loop).not.toMatch(/kind|processRole|state:/);
      }
    }
  });

  it('names an unlabelled loop in Persian rather than printing its key as prose', async () => {
    const [stalled] = await render('some-future-loop', 'worker');
    expect(stalled).toContain('کار پس‌زمینهٔ ناشناخته');
    expect(stalled?.split('\n').filter((line) => /[A-Za-z]/.test(line))).toEqual([
      '🔧 job.loop_stalled · some-future-loop',
    ]);
  });
});
