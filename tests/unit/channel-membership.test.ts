import { describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_MEMBERSHIP_RECOVERED_CODE,
  CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE,
  parseSettingValue,
  telegramChannelIdentity,
  telegramChannelJoinUrl,
  type TelegramChannel,
  type TenantContext,
} from '@nexa/contracts';
import {
  ChannelMembershipService,
  membershipOf,
  type ChannelMembershipAnswer,
} from '../../apps/api/src/modules/commerce/customers/application/channel-membership.service';
import { TelegramChatMemberReader } from '../../apps/api/src/modules/commerce/customers/infrastructure/telegram-chat-member.reader';

/**
 * Package B — mandatory channel membership, the rules without Telegram or a database
 * (`docs/package-b-channel-membership-audit.md`).
 */

const TENANT = { tenantId: 'tenant-a' } as TenantContext;
const OTHER_TENANT = { tenantId: 'tenant-b' } as TenantContext;
const PUBLIC: TelegramChannel = { handle: '@nexa_news', mandatory: true };
const PRIVATE: TelegramChannel = {
  chatId: '-1001234567890',
  joinUrl: 'https://t.me/+AbCdEf',
  mandatory: true,
};
const OPTIONAL: TelegramChannel = { handle: '@nexa_extra', mandatory: false };

function harness(
  channels: readonly TelegramChannel[],
  answer: (chatId: string) => ChannelMembershipAnswer,
) {
  let now = 1_000_000;
  const read = vi.fn(async (_scope: TenantContext, input: { chatId: string }) =>
    answer(input.chatId),
  );
  const record = vi.fn(async (_scope: unknown, _event: { code: string }) => ({}) as never);
  const openConditions = vi.fn(async (_scope: unknown, _keys: readonly string[]) => [] as string[]);
  const service = new ChannelMembershipService({
    reader: { read },
    channels: async () => channels,
    opsEvents: { record },
    conditions: { openConditions },
    clock: { now: () => new Date(now) },
    logger: { warn: () => undefined, info: () => undefined, error: () => undefined } as never,
  });
  const ask = (
    options: { fresh?: boolean; bot?: string; user?: string; scope?: TenantContext } = {},
  ) =>
    service.missingRequired(options.scope ?? TENANT, {
      botInstanceId: options.bot ?? 'bot-1',
      telegramUserId: options.user ?? '910910',
      fresh: options.fresh ?? false,
    });
  return { service, read, record, openConditions, ask, advance: (ms: number) => (now += ms) };
}

describe('membershipOf (brief B2)', () => {
  it('reads creator, administrator and member as members', () => {
    for (const status of ['creator', 'administrator', 'member']) {
      expect(membershipOf({ status, isMember: null })).toEqual({ kind: 'MEMBER' });
    }
  });

  it('reads restricted as a member only when Telegram says is_member', () => {
    expect(membershipOf({ status: 'restricted', isMember: true })).toEqual({ kind: 'MEMBER' });
    expect(membershipOf({ status: 'restricted', isMember: false })).toEqual({
      kind: 'NOT_MEMBER',
    });
    expect(membershipOf({ status: 'restricted', isMember: null })).toEqual({
      kind: 'NOT_MEMBER',
    });
  });

  it('reads left and kicked as not a member, and an undocumented status as unknown', () => {
    expect(membershipOf({ status: 'left', isMember: null })).toEqual({ kind: 'NOT_MEMBER' });
    expect(membershipOf({ status: 'kicked', isMember: null })).toEqual({ kind: 'NOT_MEMBER' });
    expect(membershipOf({ status: 'banned_forever', isMember: null }).kind).toBe('UNKNOWN');
  });
});

describe('the telegram.channels setting (audit §2.1)', () => {
  const parse = (value: unknown) => parseSettingValue('telegram.channels', value);

  it('still accepts every value stored before Package B', () => {
    expect(parse([{ handle: '@legacy_channel', mandatory: true }]).ok).toBe(true);
  });

  it('accepts a private channel by id and invite link', () => {
    expect(parse([PRIVATE]).ok).toBe(true);
  });

  it('refuses a channel with nothing to ask Telegram about', () => {
    expect(parse([{ joinUrl: 'https://t.me/+AbCdEf', mandatory: false }]).ok).toBe(false);
  });

  it('refuses a required channel a customer could not open', () => {
    expect(parse([{ chatId: '-1001234567890', mandatory: true }]).ok).toBe(false);
    // Optional is allowed: nobody is told to join it.
    expect(parse([{ chatId: '-1001234567890', mandatory: false }]).ok).toBe(true);
  });

  it('refuses a join link that is not Telegram, and two channels with one id', () => {
    expect(
      parse([{ chatId: '-1001234567890', joinUrl: 'https://evil.example/join', mandatory: true }])
        .ok,
    ).toBe(false);
    expect(parse([PRIVATE, { ...PRIVATE, joinUrl: 'https://t.me/+Other' }]).ok).toBe(false);
    expect(parse([PUBLIC, { handle: '@NEXA_NEWS', mandatory: false }]).ok).toBe(false);
  });

  it('opens the join link when there is one, else the public handle', () => {
    expect(telegramChannelJoinUrl(PUBLIC)).toBe('https://t.me/nexa_news');
    expect(telegramChannelJoinUrl(PRIVATE)).toBe('https://t.me/+AbCdEf');
  });

  it('asks about a channel by its chat id whenever it has one, even beside a handle', () => {
    // A handle can be renamed or given away; the numeric id is the channel (audit §2.1).
    expect(telegramChannelIdentity({ ...PUBLIC, chatId: '-1009876543210' })).toBe(
      '-1009876543210',
    );
    expect(telegramChannelIdentity(PUBLIC)).toBe('@nexa_news');
    expect(telegramChannelIdentity(PRIVATE)).toBe('-1001234567890');
  });
});

describe('ChannelMembershipService (brief B1, B5, B6)', () => {
  it('passes a customer who is in every required channel', async () => {
    const { ask } = harness([PUBLIC, PRIVATE], () => ({ kind: 'MEMBER' }));
    expect(await ask()).toEqual([]);
  });

  it('names exactly the required channel that is missing, and never asks about an optional one', async () => {
    const { ask, read } = harness([PUBLIC, OPTIONAL, PRIVATE], (chatId) =>
      chatId === PRIVATE.chatId ? { kind: 'NOT_MEMBER' } : { kind: 'MEMBER' },
    );
    expect(await ask()).toEqual([PRIVATE]);
    expect(read.mock.calls.map(([, input]) => input.chatId)).toEqual([
      '@nexa_news',
      PRIVATE.chatId,
    ]);
  });

  it('asks about a private channel by its numeric id', async () => {
    const { ask, read } = harness([PRIVATE], () => ({ kind: 'MEMBER' }));
    await ask();
    expect(read.mock.calls[0]?.[1].chatId).toBe('-1001234567890');
  });

  it('fails open on a check Telegram could not answer, and records the condition once a minute', async () => {
    const { ask, record, advance } = harness([PUBLIC], () => ({
      kind: 'UNKNOWN',
      code: 'telegram.rejected.403',
    }));
    expect(await ask()).toEqual([]);
    advance(11_000);
    expect(await ask()).toEqual([]);
    const outages = record.mock.calls.filter(
      ([, event]) => event.code === CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE,
    );
    expect(outages).toHaveLength(1);
    expect(outages[0]?.[1]).toMatchObject({
      severity: 'WARN',
      dedupeKey: `${CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE}:bot-1:@nexa_news`,
      context: { botInstanceId: 'bot-1', channel: '@nexa_news', reason: 'telegram.rejected.403' },
    });
    advance(60_000);
    await ask();
    expect(
      record.mock.calls.filter(([, event]) => event.code === CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE),
    ).toHaveLength(2);
  });

  it('treats a reader that throws as unknown, never as not a member', async () => {
    const { service } = harness([PUBLIC], () => {
      throw new Error('network');
    });
    expect(
      await service.missingRequired(TENANT, {
        botInstanceId: 'bot-1',
        telegramUserId: '1',
        fresh: false,
      }),
    ).toEqual([]);
  });

  it('recovers the condition on the next answer Telegram gives', async () => {
    let failing = true;
    const { ask, record, advance } = harness([PUBLIC], () =>
      failing ? { kind: 'UNKNOWN', code: 'telegram.server_error.502' } : { kind: 'MEMBER' },
    );
    await ask();
    failing = false;
    advance(11_000);
    await ask();
    expect(record.mock.calls.map(([, event]) => event.code)).toEqual([
      CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE,
      CHANNEL_MEMBERSHIP_RECOVERED_CODE,
    ]);
    expect(record.mock.calls[1]?.[1]).toMatchObject({
      recoversCode: CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE,
      recoversDedupeKey: `${CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE}:bot-1:@nexa_news`,
    });
  });

  it('recovers an outage another process recorded, looking at most once a minute', async () => {
    const { ask, record, openConditions, advance } = harness([PUBLIC], () => ({ kind: 'MEMBER' }));
    openConditions.mockResolvedValue([CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE]);
    await ask({ user: '1' });
    await ask({ user: '2' });
    expect(openConditions).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[1]).toMatchObject({ code: CHANNEL_MEMBERSHIP_RECOVERED_CODE });
    advance(61_000);
    await ask({ user: '3' });
    expect(openConditions).toHaveBeenCalledTimes(2);
  });

  it('keeps a member about a minute, and a non-member only ten seconds', async () => {
    let member = true;
    const { ask, read, advance } = harness([PUBLIC], () =>
      member ? { kind: 'MEMBER' } : { kind: 'NOT_MEMBER' },
    );
    await ask();
    member = false;
    advance(59_000);
    expect(await ask()).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    advance(2_000);
    expect(await ask()).toEqual([PUBLIC]);
    expect(read).toHaveBeenCalledTimes(2);
    member = true;
    advance(9_000);
    expect(await ask()).toEqual([PUBLIC]);
    expect(read).toHaveBeenCalledTimes(2);
    advance(2_000);
    expect(await ask()).toEqual([]);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('asks again for the check button, but keeps a cached member', async () => {
    let member = false;
    const { ask, read } = harness([PUBLIC], () =>
      member ? { kind: 'MEMBER' } : { kind: 'NOT_MEMBER' },
    );
    expect(await ask()).toEqual([PUBLIC]);
    member = true;
    expect(await ask()).toEqual([PUBLIC]);
    expect(await ask({ fresh: true })).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(await ask({ fresh: true })).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('never serves one bot’s, tenant’s or customer’s answer to another', async () => {
    const { ask, read } = harness([PUBLIC], () => ({ kind: 'MEMBER' }));
    await ask();
    await ask({ bot: 'bot-2' });
    await ask({ scope: OTHER_TENANT });
    await ask({ user: '920920' });
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('asks nothing when no channel is required', async () => {
    const { ask, read } = harness([OPTIONAL], () => ({ kind: 'NOT_MEMBER' }));
    expect(await ask()).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('TelegramChatMemberReader (audit §2.2)', () => {
  const reader = (outcome: unknown, token: string | null = 'the-token') => {
    const call = vi.fn(async () => outcome as never);
    return {
      call,
      reader: new TelegramChatMemberReader({
        bots: { tokenForBotInstance: async () => token },
        apiBaseUrl: 'http://telegram.invalid',
        timeoutMs: 1_000,
        call,
      }),
    };
  };
  const input = { botInstanceId: 'bot-1', chatId: '@nexa_news', telegramUserId: '910910' };

  it('maps a ChatMember through membershipOf, with the receiving bot’s token', async () => {
    const { reader: r, call } = reader({
      outcome: 'SUCCEEDED',
      member: { status: 'left', isMember: null },
    });
    expect(await r.read(TENANT, input)).toEqual({ kind: 'NOT_MEMBER' });
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'the-token', chatId: '@nexa_news', userId: '910910' }),
    );
  });

  it('reads every failed call as unknown, carrying Telegram’s code', async () => {
    for (const errorCode of [
      'telegram.rejected.403',
      'telegram.rejected.400',
      'telegram.unreachable',
    ]) {
      const { reader: r } = reader({
        outcome: errorCode === 'telegram.unreachable' ? 'FAILED_RETRYABLE' : 'FAILED_PERMANENT',
        errorCode,
        errorMessage: 'x',
      });
      expect(await r.read(TENANT, input)).toEqual({ kind: 'UNKNOWN', code: errorCode });
    }
  });

  it('is unknown without a usable bot token, and asks Telegram nothing', async () => {
    const { reader: r, call } = reader({ outcome: 'SUCCEEDED' }, null);
    expect((await r.read(TENANT, input)).kind).toBe('UNKNOWN');
    expect(call).not.toHaveBeenCalled();
  });
});
