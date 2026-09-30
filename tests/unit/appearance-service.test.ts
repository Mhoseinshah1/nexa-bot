import { describe, expect, it } from 'vitest';
import type {
  ActorContext,
  AppearanceSlot,
  AuditEntry,
  BotInstanceId,
  IdempotencyStore,
  OperationalEventInput,
  TenantContext,
} from '@nexa/contracts';
import {
  APPEARANCE_DECORATION_FAILED_CODE,
  APPEARANCE_DECORATION_OK_CODE,
  appearanceDecorationConditionKey,
} from '../../apps/api/src/modules/commerce/messaging/application/appearance-conditions';
import type { AppearanceProbeResult } from '../../apps/api/src/modules/commerce/messaging/application/ports';
import {
  AppearanceService,
  type AppearanceServiceDeps,
} from '../../apps/api/src/modules/control/appearance/application/appearance.service';
import type {
  AppearanceBotRecord,
  StoredAppearanceSlot,
} from '../../apps/api/src/modules/control/appearance/application/ports';

/**
 * Two rules of `AppearanceService` that a real database cannot show and a wire test cannot
 * see (Codex review of PR #121, findings 7 and 8): the verdict a test's audit row names as
 * `before` is the one read UNDER THE LOCK in the result transaction, not the one read before
 * the claim and the Telegram call; and removing the last custom emoji closes every bot's open
 * refused-decoration condition, since nothing is left to re-test.
 */

const scope = {
  tenantId: '01900000-0000-7000-8000-000000000001',
  botInstanceId: null,
} as TenantContext;
const botA = '01900000-0000-7000-8000-0000000000aa' as BotInstanceId;
const actor: ActorContext = {
  type: 'WEB_ADMIN',
  id: '01900000-0000-7000-8000-00000000ad01',
  label: 'owner',
  surface: 'WEB',
  correlationId: 'c' as never,
};
const at = new Date('2026-09-30T09:00:00.000Z');

function harness(options: {
  readonly slots?: StoredAppearanceSlot[];
  readonly bots?: AppearanceBotRecord[];
  /** What `lockBot` answers, when it should differ from `listBots`. */
  readonly locked?: AppearanceBotRecord | null;
  readonly probe?: AppearanceProbeResult;
  readonly openConditions?: string[];
}) {
  const slots = options.slots ?? [];
  const bots = options.bots ?? [];
  const audits: AuditEntry[] = [];
  const events: OperationalEventInput[] = [];
  const remembered = new Map<string, unknown>();
  const idempotency: IdempotencyStore = {
    find: async <T>(_scope: unknown, _ns: unknown, key: string) =>
      remembered.has(key)
        ? ({ key, requestHash: '', result: remembered.get(key) as T, createdAt: at } as never)
        : null,
    remember: async (_scope, _ns, key, _hash, result) => {
      if (remembered.has(key)) return false;
      remembered.set(key, result);
      return true;
    },
  };
  const deps: AppearanceServiceDeps = {
    repository: {
      listSlots: async () => slots,
      findSlot: async (_scope, slot) => slots.find((one) => one.slot === slot) ?? null,
      insertSlot: async (_scope, input) => {
        const row = { ...input, version: 1, updatedAt: at };
        slots.push(row);
        return row;
      },
      updateSlot: async (_scope, input) => {
        const index = slots.findIndex((one) => one.slot === input.slot);
        const current = slots[index];
        if (current === undefined || current.version !== input.expectedVersion) return null;
        const row = { ...current, ...input, version: current.version + 1, updatedAt: at };
        slots[index] = row;
        return row;
      },
      deleteSlot: async (_scope, slot, expectedVersion) => {
        const index = slots.findIndex(
          (one) => one.slot === slot && one.version === expectedVersion,
        );
        if (index === -1) return false;
        slots.splice(index, 1);
        return true;
      },
      listBots: async () => bots,
      lockBot: async (_scope, id) =>
        options.locked === undefined ? (bots.find((one) => one.id === id) ?? null) : options.locked,
      recordTest: async () => true,
    },
    probe: {
      sendAppearanceProbe: async () =>
        options.probe ?? { outcome: 'SENT', errorCode: null, decoratedSlots: 1 },
    },
    admins: { telegramUserIdOf: async () => '42' },
    guard: { check: async () => undefined } as never,
    uow: { run: async (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({}) } as never,
    audit: { record: async (_scope, _actor, entry) => void audits.push(entry) },
    opsLog: { record: async (_scope, event) => (events.push(event), { isNew: true } as never) },
    sessions: {} as never,
    idempotency,
    scopeActivity: { scopeIsActive: async () => true },
    conditions: {
      conditionIsOpen: async (_scope, key) => (options.openConditions ?? []).includes(key),
    },
    clock: { now: () => at },
    ids: { uuid: () => '01900000-0000-7000-8000-00000000c0de' } as never,
  };
  return { service: new AppearanceService(deps), audits, events, slots };
}

const stored = (
  slot: AppearanceSlot,
  customEmojiId: string | null,
  version = 1,
): StoredAppearanceSlot => ({
  slot,
  customEmojiId,
  enabled: true,
  version,
  updatedAt: at,
  updatedByAdminId: null,
});
const bot = (test: AppearanceBotRecord['test']): AppearanceBotRecord => ({
  id: botA,
  username: 'acme_store_bot',
  status: 'ACTIVE',
  test,
});

describe('the test’s audit row', () => {
  it('names as `before` the verdict read under the lock, not the one read before the send', async () => {
    const earlier = {
      testedAt: new Date('2026-09-01T00:00:00.000Z'),
      outcome: 'SENT' as const,
      errorCode: null,
    };
    const moved = {
      testedAt: new Date('2026-09-30T08:59:00.000Z'),
      outcome: 'REJECTED' as const,
      errorCode: 'appearance.custom_emoji_refused' as const,
    };
    const { service, audits } = harness({
      slots: [stored('payment', '5368324170671202286')],
      bots: [bot(earlier)],
      locked: bot(moved),
    });
    const answer = await service.sendTest(scope, actor, {
      idempotencyKey: 'test-key-0001',
      botInstanceId: botA,
    });
    expect(answer.bot.customEmojiTest?.outcome).toBe('SENT');
    const audit = audits.find((entry) => entry.action === 'appearance.test');
    expect(audit?.before).toEqual({
      outcome: 'REJECTED',
      errorCode: 'appearance.custom_emoji_refused',
      testedAt: moved.testedAt.toISOString(),
    });
  });
});

describe('the refused-decoration condition', () => {
  it('is closed for every bot when the last custom emoji is removed, and only then', async () => {
    const key = appearanceDecorationConditionKey(botA);
    const { service, events } = harness({
      slots: [stored('payment', '1', 1), stored('success', '2', 1)],
      bots: [
        bot({ testedAt: at, outcome: 'REJECTED', errorCode: 'appearance.custom_emoji_refused' }),
      ],
      openConditions: [key],
    });
    // One custom emoji still configured: the condition stays open.
    await service.resetSlot(scope, actor, 'payment', {
      idempotencyKey: 'reset-key-0001',
      expectedVersion: 1,
    });
    expect(events).toEqual([]);
    // The last one goes, by a save that clears the id: closed, naming the bot's own key.
    await service.saveSlot(scope, actor, 'success', {
      idempotencyKey: 'save-key-0001',
      customEmojiId: null,
      enabled: true,
      expectedVersion: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      code: APPEARANCE_DECORATION_OK_CODE,
      recoversCode: APPEARANCE_DECORATION_FAILED_CODE,
      recoversDedupeKey: key,
    });
  });

  it('is left alone when no condition is open', async () => {
    const { service, events } = harness({
      slots: [stored('payment', '1', 1)],
      bots: [bot(null)],
    });
    await service.resetSlot(scope, actor, 'payment', {
      idempotencyKey: 'reset-key-0002',
      expectedVersion: 1,
    });
    expect(events).toEqual([]);
  });
});
