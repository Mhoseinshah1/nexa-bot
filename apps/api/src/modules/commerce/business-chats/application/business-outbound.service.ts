import {
  BUSINESS_MESSAGE_TEXT_RETENTION_DAYS,
  SUPPORT_AI_AUTO_STALE_SECONDS,
  businessOutboundSendable,
  deliveryRetryDelayMs,
  systemJobActor,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type Logger,
  type ScopeContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { BusinessConversationService } from './business-conversation.service.js';
import type { BusinessTransport } from './business-transport.js';
import type {
  AutoReplyModeReader,
  BusinessConversationRepository,
  BusinessEscalationRepository,
  BusinessMessageRepository,
  BusinessOutboundRecord,
  BusinessOutboundRepository,
} from './ports.js';

/** How long a claimed row is leased before another pass may claim it. */
export const BUSINESS_OUTBOUND_LEASE_MS = 60_000;
/** A stamped row older than this, never recorded, is resolved UNCONFIRMED. */
export const BUSINESS_OUTBOUND_STRANDED_MS = 5 * 60_000;
export const BUSINESS_OUTBOUND_BATCH = 25;
/** The retention purge runs at most this often. */
export const BUSINESS_RETENTION_INTERVAL_MS = 10 * 60_000;
const RETENTION_BATCH = 500;

export interface BusinessOutboundServiceDeps {
  readonly outbound: BusinessOutboundRepository;
  readonly conversations: BusinessConversationRepository;
  readonly messages: BusinessMessageRepository;
  readonly control: Pick<BusinessConversationService, 'handOff'>;
  readonly transport: Pick<BusinessTransport, 'sendText'>;
  /**
   * TB7: an AUTO row is sent only while the tenant's mode still allows automatic replies,
   * read inside the stamp's transaction — leaving AUTO_REPLY_SAFE silences what is queued.
   */
  readonly autoMode: AutoReplyModeReader;
  /** TB7: the AI's escalation notes are purged with the transcript. */
  readonly escalations: Pick<BusinessEscalationRepository, 'purgeText'>;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Pick<Logger, 'warn' | 'error'>;
}

export interface BusinessOutboundReport {
  readonly claimed: number;
  readonly delivered: number;
  readonly superseded: number;
  readonly unconfirmed: number;
  readonly failed: number;
  readonly rateLimited: number;
  readonly stranded: number;
  readonly purged: number;
}

type Outcome = 'delivered' | 'superseded' | 'unconfirmed' | 'failed' | 'rateLimited' | 'lost';

/**
 * TB2 — the business outbound lane (ADR-0033 §4, §6; ADR-0030's discipline).
 *
 * Per row, three transactions and never a network call inside one:
 *
 *   1. THE FINAL CHECK + STAMP — lock the conversation, read scope activity, and apply
 *      `businessOutboundSendable` (equal epoch; and `AI_ACTIVE` for an `AUTO` row). A row that
 *      fails it is `SUPERSEDED` and nothing is sent. One that passes is stamped
 *      `send_started_at` — from this commit on, its outcome is the send's, never a retry's.
 *   2. THE SEND — `BusinessTransport.sendText`, outside any transaction.
 *   3. THE OUTCOME — `DELIVERED` (Telegram's message id kept: it proves the echo is ours);
 *      `RATE_LIMITED` back to due at Telegram's wait, no attempt spent; `REFUSED` → `FAILED`;
 *      `UNKNOWN` → `UNCONFIRMED`, NEVER resent. An `AUTO` row that failed or is unconfirmed
 *      hands the conversation to a person (`TRANSPORT_REFUSED` / `SEND_OUTCOME_UNKNOWN`); a
 *      person's own send that failed is shown to them and changes nothing about control.
 */
export class BusinessOutboundService {
  private lastRetentionAt = 0;

  constructor(private readonly deps: BusinessOutboundServiceDeps) {}

  async deliverDue(
    scope: ScopeContext,
    limit = BUSINESS_OUTBOUND_BATCH,
  ): Promise<BusinessOutboundReport> {
    const counts: Record<Outcome, number> = {
      delivered: 0,
      superseded: 0,
      unconfirmed: 0,
      failed: 0,
      rateLimited: 0,
      lost: 0,
    };
    const empty = { claimed: 0, ...counts, stranded: 0, purged: 0 };
    // A stopped tenant is a healthy pass that did nothing (the notification lane's rule).
    if (!(await this.deps.scopeActivity.scopeIsActive(scope))) return empty;
    const now = this.deps.clock.now();

    const stranded = await this.reapStranded(scope, now, limit);

    const purged = await this.purgeIfDue(scope, now);

    const claimed = await this.deps.outbound.claimDue(
      scope,
      now,
      new Date(now.getTime() + BUSINESS_OUTBOUND_LEASE_MS),
      limit,
    );
    for (const row of claimed) {
      // One row's failure — a handoff that threw, say — is that row's alone: it is logged, its
      // transaction rolled back (a stamped row is reaped later), and the pass goes on, so one
      // conversation never stalls the tenant's lane (substitute review of PR #202, finding 3).
      try {
        const outcome = await this.deliverOne(scope, row);
        counts[outcome] += 1;
      } catch (error: unknown) {
        this.rowFailed(row, 'deliver', error);
      }
    }
    return {
      claimed: claimed.length,
      delivered: counts.delivered,
      superseded: counts.superseded,
      unconfirmed: counts.unconfirmed,
      failed: counts.failed,
      rateLimited: counts.rateLimited,
      stranded,
      purged,
    };
  }

  /**
   * Stamped rows whose lease ran out are resolved UNCONFIRMED, each in ITS OWN transaction with
   * its handoff (an AUTO row's). A handoff that throws rolls back only its own row, which stays
   * stamped and is retried on the next pass; every other row is reaped, and the lane goes on to
   * deliver (substitute review of PR #202, finding 3: one transaction for all of them let one
   * conversation's failure stall the tenant's operator sends, every pass).
   */
  private async reapStranded(scope: ScopeContext, now: Date, limit: number): Promise<number> {
    const staleBefore = new Date(now.getTime() - BUSINESS_OUTBOUND_STRANDED_MS);
    const ids = await this.deps.outbound.strandedIds(scope, staleBefore, limit);
    let reaped = 0;
    for (const id of ids) {
      try {
        const done = await this.deps.uow.run(scope, async (tx) => {
          if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return false;
          const row = await this.deps.outbound.reapStrandedRow(scope, id, staleBefore, now, tx);
          if (row === null) return false;
          if (row.origin === 'AUTO') {
            await this.deps.control.handOff(
              scope,
              row.conversationId,
              'SEND_OUTCOME_UNKNOWN',
              now,
              tx,
            );
          }
          return true;
        });
        if (done) reaped += 1;
      } catch (error: unknown) {
        this.rowFailed({ id, conversationId: null }, 'reap', error);
      }
    }
    return reaped;
  }

  private rowFailed(
    row: { readonly id: string; readonly conversationId: string | null },
    step: 'deliver' | 'reap',
    error: unknown,
  ): void {
    this.deps.logger.error(
      { outboundId: row.id, conversationId: row.conversationId, step, err: error },
      'business outbound: one row failed; the pass continues with the others',
    );
  }

  /** Exposed for the race tests: one row, start to finish. */
  async deliverOne(scope: ScopeContext, row: BusinessOutboundRecord): Promise<Outcome> {
    const decision = await this.deps.uow.run(scope, async (tx) => {
      const now = this.deps.clock.now();
      const conversation = await this.deps.conversations.lockById(scope, row.conversationId, tx);
      const active = await this.deps.scopeActivity.scopeIsActive(scope, tx);
      const modeAllows =
        row.origin !== 'AUTO' || (await this.deps.autoMode.autoReplyEnabled(scope, tx));
      const sendable =
        conversation !== null &&
        active &&
        modeAllows &&
        row.body !== null &&
        businessOutboundSendable({
          origin: row.origin,
          rowEpoch: row.controlEpoch,
          conversationEpoch: conversation.controlEpoch,
          conversationState: conversation.state,
        });
      // TB7: an automatic reply that waited too long (the tenant was stopped and resumed, or the
      // lane was down) is never sent late; a person answers instead (`REPLY_STALE`).
      const stale =
        sendable &&
        row.origin === 'AUTO' &&
        now.getTime() - row.createdAt.getTime() > SUPPORT_AI_AUTO_STALE_SECONDS * 1000;
      if (stale) {
        await this.deps.outbound.resolve(
          scope,
          row.id,
          {
            state: 'SUPERSEDED',
            fromStamped: false,
            failureCode: 'support_ai.reply_stale',
            attempted: false,
            now,
          },
          tx,
        );
        await this.deps.control.handOff(scope, row.conversationId, 'REPLY_STALE', now, tx);
        return null;
      }
      if (!sendable) {
        await this.deps.outbound.resolve(
          scope,
          row.id,
          {
            state: 'SUPERSEDED',
            fromStamped: false,
            failureCode: !active
              ? 'scope.inactive'
              : modeAllows
                ? 'conversation.moved_on'
                : 'support_ai.mode_off',
            attempted: false,
            now,
          },
          tx,
        );
        return null;
      }
      const stamped = await this.deps.outbound.markSendStarted(
        scope,
        row.id,
        row.nextAttemptAt,
        now,
        tx,
      );
      return stamped ? conversation : null;
    });
    if (decision === null) {
      const current = await this.deps.outbound.findById(scope, row.id);
      return current?.state === 'SUPERSEDED' ? 'superseded' : 'lost';
    }

    const actor = systemJobActor(`business-outbound:${row.id}`, row.id as CorrelationId);
    const sent = await this.deps.transport.sendText(scope, actor, {
      connectionRowId: decision.connectionRowId,
      chatId: decision.chatId,
      text: row.body ?? '',
    });

    return this.deps.uow.run(scope, async (tx): Promise<Outcome> => {
      const now = this.deps.clock.now();
      // The conversation lock first: `recordMessage` classifies under the same lock, so an echo
      // is classified either after this delivery's message id commits, or before it — and is
      // then relabelled below (TB2 review F2).
      await this.deps.conversations.lockById(scope, row.conversationId, tx);
      switch (sent.outcome) {
        case 'DELIVERED': {
          const resolved = await this.deps.outbound.resolve(
            scope,
            row.id,
            {
              state: 'DELIVERED',
              fromStamped: true,
              telegramMessageId: sent.messageId,
              attempted: true,
              now,
            },
            tx,
          );
          if (!resolved) return this.lost(row, 'DELIVERED');
          if (sent.messageId !== null) {
            await this.deps.messages.relabelOwnEcho(
              scope,
              { conversationId: row.conversationId, telegramMessageId: sent.messageId },
              tx,
            );
          }
          /*
           * The reply is stamped on TELEGRAM's clock — the `date` Telegram returned for this
           * message, the same date its OWN_ECHO row carries — because the customer's messages
           * are stamped on that clock and the inbox compares the two (PR #205 review, S1). The
           * server's `now` would mix clocks: a VPS running ahead would mark a customer who
           * wrote after the reply as answered. Only an answer with no date falls back to `now`,
           * and the comparison's whole-second grain bounds that case to the skew.
           */
          const repliedAt = sent.sentAt ?? now;
          await this.deps.conversations.touch(
            scope,
            row.conversationId,
            row.origin === 'AUTO'
              ? { lastMessageAt: repliedAt, lastAiAt: repliedAt, now }
              : { lastMessageAt: repliedAt, lastHumanAt: repliedAt, now },
            tx,
          );
          return 'delivered';
        }
        case 'RATE_LIMITED': {
          const wait = deliveryRetryDelayMs(row.attempts, sent.retryAfterMs ?? undefined);
          const requeued = await this.deps.outbound.requeue(
            scope,
            row.id,
            new Date(now.getTime() + wait),
            now,
            tx,
          );
          return requeued ? 'rateLimited' : this.lost(row, 'RATE_LIMITED');
        }
        case 'UNKNOWN': {
          const resolved = await this.deps.outbound.resolve(
            scope,
            row.id,
            {
              state: 'UNCONFIRMED',
              fromStamped: true,
              failureCode: sent.errorCode,
              attempted: true,
              now,
            },
            tx,
          );
          if (!resolved) return this.lost(row, 'UNKNOWN');
          if (row.origin === 'AUTO') {
            await this.deps.control.handOff(
              scope,
              row.conversationId,
              'SEND_OUTCOME_UNKNOWN',
              now,
              tx,
            );
          }
          return 'unconfirmed';
        }
        case 'REFUSED': {
          const resolved = await this.deps.outbound.resolve(
            scope,
            row.id,
            {
              state: 'FAILED',
              fromStamped: true,
              failureCode: sent.errorCode ?? `business.${sent.reason.toLowerCase()}`,
              attempted: true,
              now,
            },
            tx,
          );
          if (!resolved) return this.lost(row, 'REFUSED');
          if (row.origin === 'AUTO') {
            await this.deps.control.handOff(
              scope,
              row.conversationId,
              'TRANSPORT_REFUSED',
              now,
              tx,
            );
          }
          return 'failed';
        }
      }
    });
  }

  /**
   * The row had already left PENDING when the answer came back — the stranded-stamp reaper
   * resolved it meanwhile. Its outcome stands; this one is logged, never counted as delivered
   * (TB2 review N8).
   */
  private lost(row: BusinessOutboundRecord, outcome: string): Outcome {
    this.deps.logger.warn(
      { outboundId: row.id, conversationId: row.conversationId, outcome },
      'business outbound: an outcome arrived for a row no longer pending',
    );
    return 'lost';
  }

  /** The 30-day text retention (ADR-0033 §8), at most every ten minutes. */
  private async purgeIfDue(scope: ScopeContext, now: Date): Promise<number> {
    if (now.getTime() - this.lastRetentionAt < BUSINESS_RETENTION_INTERVAL_MS) return 0;
    const cutoff = new Date(now.getTime() - BUSINESS_MESSAGE_TEXT_RETENTION_DAYS * 86_400_000);
    const purged = await this.deps.uow.run(scope, async (tx) => {
      const texts = await this.deps.messages.purgeText(scope, cutoff, now, RETENTION_BATCH, tx);
      const bodies = await this.deps.outbound.purgeBodies(scope, cutoff, now, RETENTION_BATCH, tx);
      const notes = await this.deps.escalations.purgeText(scope, cutoff, now, RETENTION_BATCH, tx);
      return texts + bodies + notes;
    });
    this.lastRetentionAt = now.getTime();
    return purged;
  }
}
