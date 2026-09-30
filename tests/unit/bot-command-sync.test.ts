import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ONLY_COMMANDS,
  BOT_COMMANDS,
  type DomainEvent,
  type TenantContext,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  BOT_COMMAND_SYNC_BACKOFF_BASE_MS,
  BOT_COMMAND_SYNC_BACKOFF_MAX_MS,
  commandSyncBackoffMs,
  commandSyncLeaseMs,
  commandSyncStateOf,
} from '../../apps/api/src/modules/platform/tenancy/domain/bot-command-sync';
import {
  CommandMenu,
  boundDescription,
  commandMenuHash,
  sameCommandMenu,
} from '../../apps/api/src/modules/platform/tenancy/application/command-menu';
import { BotCommandSyncConsumer } from '../../apps/api/src/modules/platform/tenancy/application/bot-command-sync.consumer';
import { BotCommandSyncLoop } from '../../apps/api/src/modules/platform/tenancy/application/bot-command-sync-loop';

/**
 * Round P (COMMAND-MENU): the pure rules of the slash-command sync lane, and the one
 * evaluator of what a tenant wants registered. The lane against a real database and the
 * HTTP fake of Telegram is `tests/integration/bot-command-sync.test.ts`.
 */

const scope: TenantContext = {
  tenantId: '01900000-0000-7000-8000-0000000000aa',
  botInstanceId: null,
} as unknown as TenantContext;

describe('the desired command menu (CommandMenu)', () => {
  const menuWith = (overrides: Partial<Record<string, string>> = {}) =>
    new CommandMenu({
      templates: {
        render: async (_scope, key) =>
          overrides[key] ?? (CATALOGUE_FA as Record<string, string>)[key] ?? '',
      },
    });

  it('sends exactly the customer scope — BOT_COMMANDS, in order — and never an admin command', async () => {
    const desired = await menuWith().desiredFor(scope);
    expect(desired.entries.map((entry) => entry.command)).toEqual(
      BOT_COMMANDS.map((entry) => entry.command),
    );
    for (const admin of ADMIN_ONLY_COMMANDS) {
      expect(
        desired.entries.some((entry) => entry.command === admin),
        admin,
      ).toBe(false);
    }
    // And the two lists are disjoint at the contract, whatever the renderer does.
    for (const entry of BOT_COMMANDS) {
      expect((ADMIN_ONLY_COMMANDS as readonly string[]).includes(entry.command)).toBe(false);
    }
  });

  it("describes each command with the TENANT's own text, trimmed and bounded to Telegram's 256", async () => {
    const reworded = await menuWith({
      'bot.command.help': '  راهنما و پشتیبانی  ',
      'bot.command.apps': 'x'.repeat(300),
    }).desiredFor(scope);
    expect(reworded.entries.find((entry) => entry.command === 'help')?.description).toBe(
      'راهنما و پشتیبانی',
    );
    expect(reworded.entries.find((entry) => entry.command === 'apps')?.description).toHaveLength(
      256,
    );
    // A rewording is a different menu; the same words are the same menu.
    const shared = await menuWith().desiredFor(scope);
    expect(reworded.hash).not.toBe(shared.hash);
    expect((await menuWith().desiredFor(scope)).hash).toBe(shared.hash);
  });

  /** No lone surrogate: every high one is followed by a low one, and no low one stands alone. */
  const wellFormed = (text: string) =>
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

  it('bounds a description at 256 units without splitting a surrogate pair (Codex #5)', async () => {
    // 255 units then an emoji (two units): a code-unit cut at 256 would keep only the high
    // surrogate — a string Telegram refuses, digested and re-sent for ever.
    const straddling = 'x'.repeat(255) + '😀';
    const bounded = boundDescription(straddling);
    expect(bounded).toHaveLength(255);
    expect(wellFormed(bounded)).toBe(true);
    expect(wellFormed('x'.repeat(255) + '😀'.slice(0, 1))).toBe(false);
    // A pair that fits is kept whole; text within the bound is untouched.
    expect(boundDescription('x'.repeat(254) + '😀')).toHaveLength(256);
    expect(boundDescription('x'.repeat(256) + 'y')).toBe('x'.repeat(256));
    expect(boundDescription('کوتاه')).toBe('کوتاه');
    // And the evaluator applies it to what the tenant wrote.
    const desired = await menuWith({ 'bot.command.apps': straddling }).desiredFor(scope);
    expect(
      wellFormed(desired.entries.find((entry) => entry.command === 'apps')?.description ?? ''),
    ).toBe(true);
  });

  it('digests the list with the recipe the bootstrap gateway used before round P, so an upgrade re-registers nothing', async () => {
    /*
     * The gateway computed `sha256(JSON.stringify(BOT_COMMANDS.map(command, CATALOGUE_FA
     * description))).slice(0, 32)`. An installation whose stored `commands_revision` came
     * from that recipe must still read CURRENT after the upgrade when nothing was reworded.
     */
    const legacy = createHash('sha256')
      .update(
        JSON.stringify(
          BOT_COMMANDS.map((entry) => ({
            command: entry.command,
            description: CATALOGUE_FA[entry.description],
          })),
        ),
      )
      .digest('hex')
      .slice(0, 32);
    expect((await menuWith().desiredFor(scope)).hash).toBe(legacy);
    expect(commandMenuHash([{ command: 'a', description: 'b', extra: 1 } as never])).toBe(
      commandMenuHash([{ command: 'a', description: 'b' }]),
    );
    expect(
      sameCommandMenu([{ command: 'a', description: 'b' }], [{ command: 'a', description: 'c' }]),
    ).toBe(false);
  });
});

describe('the sync rules', () => {
  it('backs off exponentially from 30 s, capped at an hour, and honours a longer retry_after', () => {
    expect(commandSyncBackoffMs(1)).toBe(BOT_COMMAND_SYNC_BACKOFF_BASE_MS);
    expect(commandSyncBackoffMs(2)).toBe(2 * BOT_COMMAND_SYNC_BACKOFF_BASE_MS);
    expect(commandSyncBackoffMs(3)).toBe(4 * BOT_COMMAND_SYNC_BACKOFF_BASE_MS);
    expect(commandSyncBackoffMs(20)).toBe(BOT_COMMAND_SYNC_BACKOFF_MAX_MS);
    expect(commandSyncBackoffMs(1000)).toBe(BOT_COMMAND_SYNC_BACKOFF_MAX_MS);
    expect(commandSyncBackoffMs(1, 90_000)).toBe(90_000);
    expect(commandSyncBackoffMs(1, 1_000)).toBe(BOT_COMMAND_SYNC_BACKOFF_BASE_MS);
  });

  it('leases one call plus a minute, never under two minutes', () => {
    expect(commandSyncLeaseMs(10_000)).toBe(120_000);
    expect(commandSyncLeaseMs(5 * 60_000)).toBe(6 * 60_000);
  });

  it('answers where a bot stands, in the order the questions are asked', () => {
    const base = {
      botStatus: 'ACTIVE' as const,
      syncedHash: 'h1',
      desiredHash: 'h1',
      nextAttemptAt: null,
      attempts: 0,
    };
    expect(commandSyncStateOf(base)).toBe('CURRENT');
    expect(commandSyncStateOf({ ...base, syncedHash: 'h0' })).toBe('STALE');
    // NULL is unknown, never "matches": one sync makes it knowable.
    expect(commandSyncStateOf({ ...base, syncedHash: null })).toBe('UNKNOWN');
    // A queued sync is PENDING or FAILING whatever the hashes say — the lane decides.
    expect(commandSyncStateOf({ ...base, nextAttemptAt: new Date() })).toBe('PENDING');
    expect(commandSyncStateOf({ ...base, nextAttemptAt: new Date(), attempts: 2 })).toBe('FAILING');
    // A stopped bot is STOPPED whatever is queued: its credential is not used.
    expect(
      commandSyncStateOf({ ...base, botStatus: 'STOPPED', nextAttemptAt: new Date(), attempts: 3 }),
    ).toBe('STOPPED');
    expect(commandSyncStateOf({ ...base, botStatus: 'DISABLED' })).toBe('STOPPED');
  });
});

describe('what queues a sync (the consumer)', () => {
  const event = (
    eventType: string,
    payload: Record<string, unknown>,
    aggregateId = '01900000-0000-7000-8000-00000000a001',
    tenantId: string | null = scope.tenantId,
  ): DomainEvent => ({
    eventId: 'e1',
    eventType,
    eventVersion: 1,
    tenantId,
    aggregateType: 'X',
    aggregateId,
    sequence: 1,
    correlationId: 'c1',
    causationId: null,
    actor: { type: 'SYSTEM_JOB', id: 'test' } as never,
    occurredAt: '2026-09-30T00:00:00.000Z',
    payload,
  });

  function harness() {
    const requests: { botId: string | null; due: boolean }[] = [];
    const consumer = new BotCommandSyncConsumer({
      requestSync: async (_scope, botId, options) => {
        requests.push({ botId, due: options.due });
      },
    });
    return { consumer, requests, handle: (e: DomainEvent) => consumer.handle(e, {} as never) };
  }

  it('queues on a bot.command.* text change and ignores every other template', async () => {
    const { handle, requests } = harness();
    await handle(event('TemplateOverrideChanged', { key: 'bot.command.help' }));
    await handle(event('TemplateOverrideReverted', { key: 'bot.command.apps' }));
    await handle(event('TemplateOverrideChanged', { key: 'bot.menu.catalog' }));
    await handle(event('TemplateOverrideChanged', { key: 'bot.start.welcome' }));
    expect(requests).toEqual([
      { botId: null, due: false },
      { botId: null, due: false },
    ]);
  });

  it('re-derives on the menu setting and on any flag, queuing nothing when the hash is unchanged', async () => {
    const { handle, requests } = harness();
    await handle(event('SettingChanged', { key: 'bot.main_menu' }));
    await handle(event('SettingChanged', { key: 'sales.currency' }));
    await handle(event('FeatureFlagChanged', { key: 'referrals', from: false, to: true }));
    // `due: false` is what leaves the queueing to the digest comparison in the repository.
    expect(requests).toEqual([
      { botId: null, due: false },
      { botId: null, due: false },
    ]);
  });

  it('queues a bot that became ACTIVE, or was just registered, NOW — and not one that stopped', async () => {
    const { handle, requests } = harness();
    await handle(event('BotInstanceStatusChanged', { from: 'STOPPED', to: 'ACTIVE' }, 'bot-1'));
    await handle(event('BotInstanceStatusChanged', { from: 'ACTIVE', to: 'STOPPED' }, 'bot-1'));
    await handle(event('BotInstanceRegistered', { username: 'x' }, 'bot-2'));
    expect(requests).toEqual([
      { botId: 'bot-1', due: true },
      { botId: 'bot-2', due: true },
    ]);
  });

  it('ignores a platform event that belongs to no tenant', async () => {
    const { handle, requests } = harness();
    await handle(event('FeatureFlagChanged', { key: 'referrals' }, 'x', null));
    expect(requests).toEqual([]);
  });
});

describe('the lane loop', () => {
  const silent = { info: () => {}, error: () => {} };

  it('reconciles on its first tick and again only after the reconcile interval', async () => {
    let now = 0;
    const calls: string[] = [];
    const loop = new BotCommandSyncLoop(
      {
        tick: async () => {
          calls.push('tick');
          return { claimed: 0, synced: 0, failed: 0, released: 0 };
        },
        reconcile: async () => {
          calls.push('reconcile');
          return 0;
        },
      },
      { now: () => new Date(now), intervalMs: 1_000, reconcileIntervalMs: 10_000, logger: silent },
    );
    await loop.tick();
    now = 5_000;
    await loop.tick();
    now = 10_000;
    await loop.tick();
    expect(calls).toEqual(['reconcile', 'tick', 'tick', 'reconcile', 'tick']);
  });

  it('records progress only on a completed tick, and a failing pass leaves it stale', async () => {
    let fail = false;
    let now = 0;
    const loop = new BotCommandSyncLoop(
      {
        tick: async () => {
          if (fail) throw new Error('database away');
          return { claimed: 0, synced: 0, failed: 0, released: 0 };
        },
        reconcile: async () => 0,
      },
      { now: () => new Date(now), intervalMs: 1_000, reconcileIntervalMs: 60_000, logger: silent },
    );
    loop.start();
    await loop.tick();
    expect(loop.isFresh(now)).toBe(true);
    fail = true;
    now = 10_000;
    await loop.tick();
    expect(loop.isFresh(now)).toBe(false);
    await loop.stop();
  });
});
