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
  /**
   * The read in flight for each cache key (Codex review of #86). A burst of updates from
   * one customer — or a check button pressed twice — shares one `getChatMember` per
   * channel instead of starting one each, which would spend the bot's API quota and turn
   * later checks UNKNOWN. Removed when the read settles, whatever it answered.
   */
  private readonly inFlight = new Map<string, Promise<ChannelMembershipAnswer>>();
  /**
   * When this process last WROTE the outage for each bot, keyed `tenant:bot`. Kept apart
   * from `outageRecordedHere` (Codex review of #86): a recovery clears the latter and never
   * this, so a channel that flaps between an answer and none is written at most once a
   * minute, not once per flap.
   */
  private readonly unavailableWrittenAt = new Map<string, number>();
  /** Bots whose outage this process wrote and has not yet recovered, keyed `tenant:bot`. */
  private readonly outageRecordedHere = new Set<string>();
  /** When each bot's open outage was last looked for, keyed the same way. */
  private readonly outageLookedForAt = new Map<string, number>();

  constructor(private readonly deps: ChannelMembershipDeps) {}

  /**
   * The REQUIRED channels Telegram says this customer is not in, in configured order.
   *
   * Optional channels are never asked about (B1). UNKNOWN counts as satisfied (B5). With
   * `fresh`, a cached NOT_MEMBER or UNKNOWN is asked again — the check button — while a
   * cached MEMBER still stands.
   *
   * The operations condition is per BOT, not per channel (Codex review of #86): it names
   * the channels that could not be checked in its context, and it is recovered by the
   * first turn in which every REQUIRED channel of that bot answered. So an operator who
   * fixes the problem by correcting a channel's id or handle, or by removing it, recovers
   * the condition — a key naming the old identity would never be asked about again.
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
    const nowMs = this.deps.clock.now().getTime();
    const unknown = required.flatMap((channel, index) => {
      const answer = answers[index];
      return answer?.kind === 'UNKNOWN'
        ? [{ channel: telegramChannelIdentity(channel), reason: answer.code }]
        : [];
    });
    if (unknown.length > 0) {
      await this.unavailable(scope, input.botInstanceId, unknown, nowMs);
    } else {
      await this.available(scope, input.botInstanceId, nowMs);
    }
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
    const cached = this.cache.get(key);
    if (
      cached !== undefined &&
      cached.until > this.deps.clock.now().getTime() &&
      (!input.fresh || cached.answer.kind === 'MEMBER')
    ) {
      return cached.answer;
    }
    // A read already under way began after the cache went stale, so it is as fresh as a
    // new one would be — the check button shares it too.
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;

    const read = this.read(scope, input, identity).then((answer) => {
      this.remember(key, answer, this.deps.clock.now().getTime());
      return answer;
    });
    this.inFlight.set(key, read);
    try {
      return await read;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async read(
    scope: TenantContext,
    input: { readonly botInstanceId: string; readonly telegramUserId: string },
    identity: string,
  ): Promise<ChannelMembershipAnswer> {
    try {
      return await this.deps.reader.read(scope, {
        botInstanceId: input.botInstanceId,
        chatId: identity,
        telegramUserId: input.telegramUserId,
      });
    } catch {
      return { kind: 'UNKNOWN', code: 'nexa.reader_threw' };
    }
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

  /** B5: an operator is told a channel is not being enforced — at most once a minute. */
  private async unavailable(
    scope: TenantContext,
    botInstanceId: string,
    unknown: readonly { readonly channel: string; readonly reason: string }[],
    nowMs: number,
  ) {
    const key = `${scope.tenantId}:${botInstanceId}`;
    const last = this.unavailableWrittenAt.get(key);
    if (last !== undefined && nowMs - last < CHANNEL_MEMBERSHIP_RECORD_INTERVAL_MS) return;
    this.unavailableWrittenAt.set(key, nowMs);
    this.outageRecordedHere.add(key);
    const channels = unknown.map((item) => item.channel);
    const reasons = unknown.map((item) => item.reason);
    this.deps.logger.warn(
      { botInstanceId, channels, reasons },
      'channel membership could not be checked; failing open',
    );
    await this.recordQuietly(scope, {
      code: CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE,
      severity: 'WARN',
      message:
        'The bot could not check membership of a required channel; the channel is not being ' +
        'enforced. Make the bot an administrator of the channel, and check its id or handle.',
      context: { botInstanceId, channels, reasons },
      dedupeKey: unavailableKey(botInstanceId),
    });
  }

  /** B5: recovered when every required channel answers — here, or after another process. */
  private async available(scope: TenantContext, botInstanceId: string, nowMs: number) {
    const key = `${scope.tenantId}:${botInstanceId}`;
    if (this.outageRecordedHere.has(key)) {
      this.outageRecordedHere.delete(key);
      await this.recordRecovery(scope, botInstanceId);
      return;
    }
    const conditions = this.deps.conditions;
    if (conditions === undefined) return;
    const last = this.outageLookedForAt.get(key);
    if (last !== undefined && nowMs - last < CHANNEL_MEMBERSHIP_RECORD_INTERVAL_MS) return;
    this.outageLookedForAt.set(key, nowMs);
    let open: string[];
    try {
      open = await conditions.openConditions(scope, [unavailableKey(botInstanceId)]);
    } catch (error) {
      this.deps.logger.warn({ err: String(error) }, 'channel outage could not be looked up');
      return;
    }
    if (open.includes(CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE)) {
      await this.recordRecovery(scope, botInstanceId);
    }
  }

  private async recordRecovery(scope: TenantContext, botInstanceId: string) {
    await this.recordQuietly(scope, {
      code: CHANNEL_MEMBERSHIP_RECOVERED_CODE,
      severity: 'INFO',
      message: 'The bot can check membership of every required channel again.',
      context: { botInstanceId },
      // Its own key: the recorder dedupes on the key alone, so a recovery written under
      // the outage's key would land ON the outage row rather than resolve it.
      dedupeKey: `${CHANNEL_MEMBERSHIP_RECOVERED_CODE}:${botInstanceId}`,
      recoversCode: CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE,
      recoversDedupeKey: unavailableKey(botInstanceId),
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

/** The outage's dedupe key for one bot, named by its code. */
function unavailableKey(botInstanceId: string): string {
  return `${CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE}:${botInstanceId}`;
}
