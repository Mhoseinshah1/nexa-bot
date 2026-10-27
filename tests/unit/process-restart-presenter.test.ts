import { describe, expect, it } from 'vitest';
import { templateDefinition, type OperationalEventInput } from '@nexa/contracts';
import {
  CATALOGUE_FA,
  DEFAULT_TEMPLATE_PRESENTATION,
  PROCESS_ROLE_LABELS_FA,
  renderTemplateBody,
} from '@nexa/i18n';
import { OperationalEventPresenter } from '../../apps/api/src/modules/commerce/ops-log/application/event-presenter';
import { i18nOpsLogWords } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import { NotifyingOperationalEventRecorder } from '../../apps/api/src/modules/control/notifications/application/operational-event-projector';
import { ProcessRestartWatch } from '../../apps/api/src/modules/platform/opslog/application/process-restart-watch';
import type { ProcessRunRecord } from '../../apps/api/src/modules/platform/opslog/application/process-run-state';

/**
 * R11 A3: the message the ops group receives. «سرویس … پی‌درپی ری‌استارت می‌شود», the role in
 * Persian, the count and window beneath it, and — like the stalled-loop messages — no Latin
 * letter outside the one technical line.
 */

const tenant = { tenantId: '01900000-0000-7000-8000-000000000001', botInstanceId: null };
const START = Date.parse('2026-10-27T08:00:00Z');

async function rendered(role: string, extraBoots = 4): Promise<string[]> {
  const queued: { templateKey: string; values: Record<string, never> }[] = [];
  const clock = { now: START };
  const open = new Set<string>();
  const projector = new NotifyingOperationalEventRecorder(
    {
      record: async (
        _scope: unknown,
        input: { code: string; severity: string; message: string; dedupeKey?: string },
      ) => {
        const key = input.dedupeKey ?? '';
        const isNew = !open.has(key);
        if (key !== '') open.add(key);
        return {
          id: 'ev-1',
          code: input.code,
          severity: input.severity,
          message: input.message,
          occurrenceCount: 1,
          firstSeenAt: new Date(clock.now),
          lastSeenAt: new Date(clock.now),
          isNew,
          reopened: false,
        };
      },
    } as never,
    { queue: async (_scope: unknown, input: never) => queued.push(input) } as never,
    {
      runNested: async (_s: unknown, _tx: unknown, fn: (tx: unknown) => unknown) => fn({}),
    } as never,
    { error: () => undefined } as never,
    new OperationalEventPresenter({ facts: {} as never, words: i18nOpsLogWords }),
  );
  let row: ProcessRunRecord | null = null;
  let runs = 0;
  const lives = (): ProcessRestartWatch =>
    new ProcessRestartWatch({
      role,
      store: {
        transact: async (_r, change) => {
          const next = change(row);
          if (next !== null) row = next;
          return next;
        },
      },
      recorder: {
        record: (scope: never, event: OperationalEventInput) =>
          projector.record(scope, event, {} as never),
      } as never,
      conditions: {
        openConditions: async (_s, keys) =>
          keys.every((k) => open.has(k)) ? ['process.restart_storm'] : [],
      },
      scope: () => tenant as never,
      clock: { now: () => new Date(clock.now) },
      newRunId: () => `run-${String((runs += 1))}`,
      logger: { warn: () => undefined },
      every: () => ({ stop: () => undefined }),
    });
  for (let boot = 0; boot < extraBoots; boot += 1) {
    await lives().start();
    clock.now += 13_000;
  }
  const last = lives();
  await last.start();
  clock.now += 60_000;
  await last.check();
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

describe('the restart-storm message', () => {
  it('is ONE announcement for the whole loop, then one recovery', async () => {
    const messages = await rendered('worker', 12);
    expect(messages).toHaveLength(2);
  });

  it('reads «سرویس … پی‌درپی ری‌استارت می‌شود» with the role in Persian and the count beneath', async () => {
    const [storm, ended] = await rendered('worker');
    expect(storm).toContain('سرویس کارگر پس‌زمینه پی‌درپی ری‌استارت می‌شود');
    expect(storm).toContain('فرایند: کارگر پس‌زمینه');
    expect(storm).toContain('۳ بار ری‌استارت در ۵ دقیقه');
    expect(storm).toContain('🔧 process.restart_storm · worker');
    expect(ended).toContain('سرویس کارگر پس‌زمینه دوباره پایدار شد');
    expect(ended).toContain('🔧 process.restart_storm_ended · worker');
  });

  it('has no Latin letter outside the technical line, for every role', async () => {
    for (const role of [...Object.keys(PROCESS_ROLE_LABELS_FA), 'not-a-known-role']) {
      const messages = await rendered(role);
      expect(messages, role).toHaveLength(2);
      for (const message of messages) {
        const prose = message
          .split('\n')
          .filter((line) => !line.startsWith('🔧'))
          .join('\n');
        expect(prose, `${role}\n${message}`).not.toMatch(/[A-Za-z]/);
        expect(prose, role).not.toMatch(/processRole|restarts|state:/);
      }
    }
  });

  it('names the api, which reports no loops, in Persian too', async () => {
    const [storm] = await rendered('api');
    expect(storm).toContain('سرویس سرور وب و وب‌هوک تلگرام پی‌درپی ری‌استارت می‌شود');
  });
});
