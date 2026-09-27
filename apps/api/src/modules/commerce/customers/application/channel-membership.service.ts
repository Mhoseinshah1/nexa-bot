import {
  CHANNEL_MEMBER_CACHE_MS,
  CHANNEL_MEMBERSHIP_CACHE_MAX,
  CHANNEL_MEMBERSHIP_RECORD_INTERVAL_MS,
  CHANNEL_MEMBERSHIP_RECOVERED_CODE,
  CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE,
  CHANNEL_NOT_MEMBER_CACHE_MS,
  CHANNEL_UNKNOWN_CACHE_MS,
  telegramChannelIdentity,
  type Clock,
  type Logger,
  type OperationalEventRecorder,
  type TelegramChannel,
  type TenantContext,
} from '@nexa/contracts';
import type { OpenConditionReader } from './anti-spam.service.js';

/**
 * Mandatory channel membership (Package B, `docs/package-b-channel-membership-audit.md`).
 *
 * One question — which REQUIRED channels is this customer deterministically not in — asked
 * of Telegram through the receiving bot, cached briefly, and failing OPEN: a check that
 * could not be answered never stops a customer, and says so in the operations log.
 */

/** What one membership question came to. */
export type ChannelMembershipAnswer =
  | { readonly kind: 'MEMBER' }
  | { readonly kind: 'NOT_MEMBER' }
  /** Telegram could not say. `code` is its error code, for the operator; never a verdict. */
  | { readonly kind: 'UNKNOWN'; readonly code: string };

/**
 * Telegram's `ChatMember.status` as a membership answer (audit §2.2, brief B2).
 *
 * `restricted` is a member only when Telegram says so explicitly (`is_member: true`); a
 * status Telegram has not documented is UNKNOWN, never a guess in either direction.
 */
export function membershipOf(member: {
  readonly status: string;
  readonly isMember: boolean | null;
}): ChannelMembershipAnswer {
  switch (member.status) {
    case 'creator':
    case 'administrator':
    case 'member':
      return { kind: 'MEMBER' };
    case 'restricted':
      return member.isMember === true ? { kind: 'MEMBER' } : { kind: 'NOT_MEMBER' };
    case 'left':
    case 'kicked':
      return { kind: 'NOT_MEMBER' };
    default:
      return { kind: 'UNKNOWN', code: 'telegram.chat_member_status' };
  }
}

/** The port: one `getChatMember`, through the named bot's own token. Never throws. */
export interface ChatMemberReader {
  read(
    scope: TenantContext,
    input: {
      readonly botInstanceId: string;
      readonly chatId: string;
      readonly telegramUserId: string;
    },
  ): Promise<ChannelMembershipAnswer>;
}

export interface ChannelMembershipDeps {
  readonly reader: ChatMemberReader;
  /** The tenant's `telegram.channels`, read through the settings resolver. */
  readonly channels: (scope: TenantContext) => Promise<readonly TelegramChannel[]>;
  readonly opsEvents: Pick<OperationalEventRecorder, 'record'>;
  /** Optional so a unit test of the rule need not model the log. */
  readonly conditions?: OpenConditionReader;
  readonly clock: Clock;
  readonly logger: Logger;
}

interface CachedAnswer {
  readonly answer: ChannelMembershipAnswer;
  readonly until: number;
}

export class ChannelMembershipService {
  /**
   * Answers, keyed `tenant:bot:channel:user` (brief B6). A Map iterates in insertion
   * order, so deleting before setting keeps the oldest entry first and eviction is one
   * `keys().next()`. Per process on purpose: a second replica costs a second call, never a
   * wrong answer.
   */
  private readonly cache = new Map<string, CachedAnswer>();
  /** When each bot+channel outage was last written here, keyed `tenant:bot:channel`. */
  private readonly unavailableRecordedAt = new Map<string, number>();
  /** When each bot+channel's open outage was last looked for, keyed the same way. */
  private readonly outageLookedForAt = new Map<string, number>();

  constructor(private readonly deps: ChannelMembershipDeps) {}

  /**
   * The REQUIRED channels Telegram says this customer is not in, in configured order.
   *
   * Optional channels are never asked about (B1). UNKNOWN counts as satisfied (B5). With
   * `fresh`, a cached NOT_MEMBER or UNKNOWN is asked again — the check button — while a
   * cached MEMBER still stands.
   */
  async missingRequired(
    scope: TenantContext,
    input: {
      readonly botInstanceId: string;
      readonly telegramUserId: string;
      readonly fresh: boolean;
    },
  ): Promise<TelegramChannel[]> {
    const required = (await this.deps.channels(scope)).filter((channel) => channel.mandatory);
    if (required.length === 0) return [];
    const answers = await Promise.all(
      required.map((channel) => this.answerFor(scope, input, channel)),
    );
    return required.filter((_, index) => answers[index]?.kind === 'NOT_MEMBER');
  }

  private async answerFor(
    scope: TenantContext,
    input: {
      readonly botInstanceId: string;
      readonly telegramUserId: string;
      readonly fresh: boolean;
    },
    channel: TelegramChannel,
  ): Promise<ChannelMembershipAnswer> {
    const identity = telegramChannelIdentity(channel);
    const key = `${scope.tenantId}:${input.botInstanceId}:${identity}:${input.telegramUserId}`;
    const nowMs = this.deps.clock.now().getTime();
    const cached = this.cache.get(key);
    if (
      cached !== undefined &&
      cached.until > nowMs &&
      (!input.fresh || cached.answer.kind === 'MEMBER')
    ) {
      return cached.answer;
    }

    let answer: ChannelMembershipAnswer;
    try {
      answer = await this.deps.reader.read(scope, {
        botInstanceId: input.botInstanceId,
        chatId: identity,
        telegramUserId: input.telegramUserId,
      });
    } catch {
      answer = { kind: 'UNKNOWN', code: 'nexa.reader_threw' };
    }
    this.remember(key, answer, nowMs);

    if (answer.kind === 'UNKNOWN') {
      await this.unavailable(scope, input.botInstanceId, identity, answer.code, nowMs);
    } else {
      await this.available(scope, input.botInstanceId, identity, nowMs);
    }
    return answer;
  }

  private remember(key: string, answer: ChannelMembershipAnswer, nowMs: number) {
    const ttl =
      answer.kind === 'MEMBER'
        ? CHANNEL_MEMBER_CACHE_MS
        : answer.kind === 'NOT_MEMBER'
          ? CHANNEL_NOT_MEMBER_CACHE_MS
          : CHANNEL_UNKNOWN_CACHE_MS;
    this.cache.delete(key);
    this.cache.set(key, { answer, until: nowMs + ttl });
    while (this.cache.size > CHANNEL_MEMBERSHIP_CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** B5: an operator is told the channel is not being enforced — at most once a minute. */
  private async unavailable(
    scope: TenantContext,
    botInstanceId: string,
    channel: string,
    code: string,
    nowMs: number,
  ) {
    const key = `${scope.tenantId}:${botInstanceId}:${channel}`;
    const last = this.unavailableRecordedAt.get(key);
    if (last !== undefined && nowMs - last < CHANNEL_MEMBERSHIP_RECORD_INTERVAL_MS) return;
    this.unavailableRecordedAt.set(key, nowMs);
    this.deps.logger.warn(
      { botInstanceId, channel, code },
      'channel membership could not be checked; failing open',
    );
    await this.recordQuietly(scope, {
      code: CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE,
      severity: 'WARN',
      message:
        'The bot could not check membership of a required channel; the channel is not being ' +
        'enforced. Make the bot an administrator of the channel, and check its id or handle.',
      context: { botInstanceId, channel, reason: code },
      dedupeKey: unavailableKey(botInstanceId, channel),
    });
  }

  /** B5: recovered by the next answer Telegram gives — here, or from another process. */
  private async available(
    scope: TenantContext,
    botInstanceId: string,
    channel: string,
    nowMs: number,
  ) {
    const key = `${scope.tenantId}:${botInstanceId}:${channel}`;
    if (this.unavailableRecordedAt.has(key)) {
      this.unavailableRecordedAt.delete(key);
      await this.recordRecovery(scope, botInstanceId, channel);
      return;
    }
    const conditions = this.deps.conditions;
    if (conditions === undefined) return;
    const last = this.outageLookedForAt.get(key);
    if (last !== undefined && nowMs - last < CHANNEL_MEMBERSHIP_RECORD_INTERVAL_MS) return;
    this.outageLookedForAt.set(key, nowMs);
    let open: string[];
    try {
      open = await conditions.openConditions(scope, [unavailableKey(botInstanceId, channel)]);
    } catch (error) {
      this.deps.logger.warn({ err: String(error) }, 'channel outage could not be looked up');
      return;
    }
    if (open.includes(CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE)) {
      await this.recordRecovery(scope, botInstanceId, channel);
    }
  }

  private async recordRecovery(scope: TenantContext, botInstanceId: string, channel: string) {
    await this.recordQuietly(scope, {
      code: CHANNEL_MEMBERSHIP_RECOVERED_CODE,
      severity: 'INFO',
      message: 'The bot can check membership of the required channel again.',
      context: { botInstanceId, channel },
      // Its own key: the recorder dedupes on the key alone, so a recovery written under
      // the outage's key would land ON the outage row rather than resolve it.
      dedupeKey: `${CHANNEL_MEMBERSHIP_RECOVERED_CODE}:${botInstanceId}:${channel}`,
      recoversCode: CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE,
      recoversDedupeKey: unavailableKey(botInstanceId, channel),
    });
  }

  /** The customer's turn never fails because the operations log could not be written. */
  private async recordQuietly(
    scope: TenantContext,
    event: Parameters<OperationalEventRecorder['record']>[1],
  ) {
    try {
      await this.deps.opsEvents.record(scope, event);
    } catch (error) {
      this.deps.logger.warn({ err: String(error) }, 'channel membership condition not recorded');
    }
  }
}

/** The outage's dedupe key for one bot and channel, named by its code. */
function unavailableKey(botInstanceId: string, channel: string): string {
  return `${CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE}:${botInstanceId}:${channel}`;
}
