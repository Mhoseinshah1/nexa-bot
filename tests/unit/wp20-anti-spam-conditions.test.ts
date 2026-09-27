import { describe, expect, it } from 'vitest';
import {
  ANTI_SPAM_RECOVERED_CODE,
  ANTI_SPAM_UNAVAILABLE_CODE,
  type BotInstanceId,
  type Logger,
  type OperationalEventRecorder,
  type TenantContext,
  type TenantId,
} from '@nexa/contracts';
import {
  ANTI_SPAM_DEGRADED_RECORD_INTERVAL_MS,
  AntiSpamService,
  type InteractionCounter,
} from '../../apps/api/src/modules/commerce/customers/application/anti-spam.service';

/**
 * WP20 (brief §3.4): the "anti-spam is off" condition is per BOT. The recorder dedupes on
 * the key alone, so a key shared by every bot would let one bot's outage hide another's,
 * and one bot's good turn resolve another's outage while it is still failing open.
 */
const silentLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

type Recorded = Parameters<OperationalEventRecorder['record']>[1];

function harness() {
  const down = new Set<string>();
  let nowMs = Date.parse('2026-09-01T00:00:00Z');
  let updateId = 0;
  const recorded: Recorded[] = [];
  // Outages the operations log holds open, by dedupe key — written by any process.
  const openInLog = new Set<string>();
  const lookups: string[][] = [];
  const counter: InteractionCounter = {
    tally: async ({ botInstanceId }) =>
      down.has(botInstanceId)
        ? { state: 'UNAVAILABLE' }
        : { state: 'COUNTED', count: 1, duplicate: false },
  };
  const service = new AntiSpamService({
    counter,
    opsEvents: {
      record: async (_scope, event) => {
        recorded.push(event);
        return undefined as never;
      },
    },
    conditions: {
      openConditions: async (_scope, keys) => {
        lookups.push([...keys]);
        return keys.filter((key) => openInLog.has(key)).map(() => ANTI_SPAM_UNAVAILABLE_CODE);
      },
    },
    clock: { now: () => new Date(nowMs) as never },
    logger: silentLogger,
  });
  const scope: TenantContext = {
    tenantId: 'tenant-a' as TenantId,
    botInstanceId: null,
  };
  const observe = (bot: string) =>
    service.observe(scope, {
      botInstanceId: bot as BotInstanceId,
      telegramUserId: '42',
      updateId: String(++updateId),
    });
  return {
    down,
    recorded,
    openInLog,
    lookups,
    observe,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('the anti-spam degradation condition', () => {
  it('keys the outage by bot, so a second bot’s outage is written, not throttled', async () => {
    const h = harness();
    h.down.add('bot-1');
    h.down.add('bot-2');
    await h.observe('bot-1');
    await h.observe('bot-2');
    // Throttled per bot: a repeat inside the interval writes nothing more.
    await h.observe('bot-1');
    expect(h.recorded.map((e) => [e.code, e.dedupeKey])).toEqual([
      [ANTI_SPAM_UNAVAILABLE_CODE, `${ANTI_SPAM_UNAVAILABLE_CODE}:bot-1`],
      [ANTI_SPAM_UNAVAILABLE_CODE, `${ANTI_SPAM_UNAVAILABLE_CODE}:bot-2`],
    ]);
    h.advance(ANTI_SPAM_DEGRADED_RECORD_INTERVAL_MS);
    await h.observe('bot-1');
    expect(h.recorded).toHaveLength(3);
  });

  it('does not resolve one bot’s outage on another bot’s good turn', async () => {
    const h = harness();
    h.down.add('bot-1');
    await h.observe('bot-1');
    await h.observe('bot-2');
    expect(h.recorded.map((e) => e.code)).toEqual([ANTI_SPAM_UNAVAILABLE_CODE]);
  });

  it('resolves the outage under its own key, naming the outage’s key', async () => {
    const h = harness();
    h.down.add('bot-1');
    await h.observe('bot-1');
    h.down.delete('bot-1');
    await h.observe('bot-1');
    await h.observe('bot-1');
    expect(h.recorded).toHaveLength(2);
    expect(h.recorded[1]).toMatchObject({
      code: ANTI_SPAM_RECOVERED_CODE,
      dedupeKey: `${ANTI_SPAM_RECOVERED_CODE}:bot-1`,
      recoversCode: ANTI_SPAM_UNAVAILABLE_CODE,
      recoversDedupeKey: `${ANTI_SPAM_UNAVAILABLE_CODE}:bot-1`,
    });
  });

  /*
   * The review of #84: the recovery used to be written only by the process whose memory
   * held the outage. An outage recorded by a replica that a rolling update then replaced
   * stayed open for ever, telling operators the protection was off while it worked.
   */
  it('resolves an outage another process recorded, on this process’s first good count (review of #84)', async () => {
    const h = harness();
    h.openInLog.add(`${ANTI_SPAM_UNAVAILABLE_CODE}:bot-1`);
    await h.observe('bot-1');
    expect(h.recorded).toEqual([
      expect.objectContaining({
        code: ANTI_SPAM_RECOVERED_CODE,
        recoversCode: ANTI_SPAM_UNAVAILABLE_CODE,
        recoversDedupeKey: `${ANTI_SPAM_UNAVAILABLE_CODE}:bot-1`,
      }),
    ]);
  });

  it('writes nothing when no outage is open, and looks at most once a minute per bot (review of #84)', async () => {
    const h = harness();
    await h.observe('bot-1');
    await h.observe('bot-1');
    await h.observe('bot-2');
    expect(h.recorded, 'no recovery for an outage that is not open').toEqual([]);
    expect(h.lookups).toEqual([
      [`${ANTI_SPAM_UNAVAILABLE_CODE}:bot-1`],
      [`${ANTI_SPAM_UNAVAILABLE_CODE}:bot-2`],
    ]);
    h.advance(ANTI_SPAM_DEGRADED_RECORD_INTERVAL_MS);
    await h.observe('bot-1');
    expect(h.lookups).toHaveLength(3);
  });
});
