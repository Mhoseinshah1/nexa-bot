import {
  BUSINESS_CONNECTION_UNUSABLE_CODE,
  BUSINESS_CONNECTION_USABLE_CODE,
  BUSINESS_UPDATE_FAILED_CODE,
  businessConnectionStatus,
  classifyBusinessMessage,
  errors,
  PLATFORM_ERROR_CODES,
  type ActorContext,
  type AuditWriter,
  type BusinessConnectionStatus,
  type BusinessMessageOrigin,
  type Clock,
  type IdempotencyStore,
  type IdGenerator,
  type OperationalEventRecorder,
  type PermissionKey,
  type ScopeContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  BusinessBotTokenSource,
  BusinessConnectionRecord,
  BusinessConnectionReport,
  BusinessConnectionRepository,
  BusinessTelegramGateway,
} from './ports.js';

/**
 * Every write here is caused by Telegram, not by an operator, so it runs as SYSTEM_JOB and
 * holds the one key SYSTEM_JOB is granted — the precedent the operations group's
 * membership updates set (`OPS_GROUP_SYSTEM_PERMISSION`).
 */
export const BUSINESS_CONNECTION_SYSTEM_PERMISSION = 'maintenance.run' satisfies PermissionKey;

export interface BusinessConnectionServiceDeps {
  readonly repository: BusinessConnectionRepository;
  readonly telegram: BusinessTelegramGateway;
  readonly tokens: BusinessBotTokenSource;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** What one applied report did. */
export interface AppliedBusinessConnection {
  readonly connection: BusinessConnectionRecord;
  /** INSERTED, UPDATED (a fact changed) or CONFIRMED (the report repeated what was stored). */
  readonly change: 'INSERTED' | 'UPDATED' | 'CONFIRMED';
  readonly status: BusinessConnectionStatus;
}

/** A business message's routing facts, read from the update. */
export interface BusinessMessageFacts {
  readonly connectionId: string;
  readonly chatId: string;
  readonly messageId: number;
  readonly fromUserId: string | null;
  readonly senderBusinessBotId: string | null;
  readonly isFromOffline: boolean;
}

/**
 * TB1 — the Telegram Business connections of a tenant's bots (ADR-0033 §2).
 *
 * Three callers:
 *
 *   - the webhook, with every `business_connection` update (`applyReport`);
 *   - the webhook, with a business message whose connection it has never seen
 *     (`ensureKnown`, which asks Telegram with `getBusinessConnection` rather than
 *     guessing — a connection made before this release produced no update NEXA kept);
 *   - the transport, after Telegram refused a send (`verify`): a refusal is evidence the
 *     connection changed, and only Telegram's own answer is allowed to say how.
 *
 * Nothing here sends a message. A connection that is not ACTIVE is reported to the
 * operator once per connection (`support.business_connection.unusable`), and closed by the
 * paired recovery when it is ACTIVE again or superseded.
 */
export class BusinessConnectionService {
  constructor(private readonly deps: BusinessConnectionServiceDeps) {}

  /** The stored connection for `(bot, connection id)`, or null. Read-only. */
  async find(
    scope: ScopeContext,
    botInstanceId: string,
    connectionId: string,
  ): Promise<BusinessConnectionRecord | null> {
    return this.deps.repository.find(scope, botInstanceId, connectionId);
  }

  /** The stored connection by row id, with its projected status. Read-only. */
  async findById(
    scope: ScopeContext,
    id: string,
  ): Promise<(BusinessConnectionRecord & { readonly status: BusinessConnectionStatus }) | null> {
    const connection = await this.deps.repository.findById(scope, id);
    return connection === null
      ? null
      : { ...connection, status: businessConnectionStatus(connection) };
  }

  /** Every connection of this tenant, with its projected status. Read-only. */
  async list(
    scope: ScopeContext,
  ): Promise<
    readonly (BusinessConnectionRecord & { readonly status: BusinessConnectionStatus })[]
  > {
    const rows = await this.deps.repository.list(scope);
    return rows.map((row) => ({ ...row, status: businessConnectionStatus(row) }));
  }

  /**
   * Applies one report of a connection: an insert, a change, or a confirmation.
   *
   * Idempotent on `idempotencyKey` (the Telegram update key): a redelivered update is a
   * replay that changes nothing and records nothing a second time.
   */
  async applyReport(
    scope: ScopeContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: string;
      readonly report: BusinessConnectionReport;
    },
  ): Promise<AppliedBusinessConnection> {
    const denial = {
      action: 'business_connection.report',
      entityType: 'TelegramBusinessConnection',
      entityId: null,
    };
    await this.authorize(scope, actor, denial);

    const requestHash = hashRequest({
      command: 'business_connection.report',
      botInstanceId: input.botInstanceId,
      report: { ...input.report, connectedAt: input.report.connectedAt.toISOString() },
    });
    const replay = await this.deps.idempotency.find<{
      readonly id: string;
      readonly change: AppliedBusinessConnection['change'];
    }>(scope, actor.surface, input.idempotencyKey, requestHash);
    if (replay) {
      const connection = await this.deps.repository.findById(scope, replay.result.id);
      if (connection !== null) {
        return {
          connection,
          change: replay.result.change,
          status: businessConnectionStatus(connection),
        };
      }
    }

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      BUSINESS_CONNECTION_SYSTEM_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const now = this.deps.clock.now();
        const before = await this.deps.repository.lock(
          scope,
          input.botInstanceId,
          input.report.connectionId,
          tx,
        );

        let connection: BusinessConnectionRecord;
        let change: AppliedBusinessConnection['change'];
        let superseded: readonly BusinessConnectionRecord[] = [];
        /*
         * `inserted: false` is a concurrent first report that lost the insert race (TB1
         * review S1): the row exists, written by the winner, and THIS report's facts must
         * still be applied to it — treating it as an insert would drop a later "disabled".
         */
        const fresh =
          before === null
            ? await this.deps.repository.insert(
                scope,
                {
                  id: this.deps.ids.uuid(),
                  botInstanceId: input.botInstanceId,
                  report: input.report,
                  now,
                },
                tx,
              )
            : null;
        const prior = before ?? (fresh?.inserted === false ? fresh.record : null);
        if (fresh?.inserted === true) {
          connection = fresh.record;
          change = 'INSERTED';
          /*
           * Supersession follows the connection's AGE, never the order reports arrive in
           * (TB1 review B1): a late or redelivered report about an OLDER connection must not
           * replace a newer one. A new row supersedes the owner's strictly older live rows;
           * if the owner already has a strictly NEWER live row, the new row is itself
           * superseded. Telegram's `date` — when the connection was established — is the one
           * ordering it gives (`OQ-TB-02`). A later report about a superseded id leaves it
           * superseded: it fails closed.
           */
          const newer = await this.deps.repository.hasNewerLive(
            scope,
            {
              botInstanceId: input.botInstanceId,
              ownerTelegramUserId: input.report.ownerTelegramUserId,
              connectedAt: input.report.connectedAt,
              excludeId: connection.id,
            },
            tx,
          );
          if (newer) {
            connection = await this.deps.repository.markSuperseded(scope, connection.id, now, tx);
          } else {
            superseded = await this.deps.repository.supersedeOthers(
              scope,
              {
                botInstanceId: input.botInstanceId,
                ownerTelegramUserId: input.report.ownerTelegramUserId,
                keepId: connection.id,
                olderThan: input.report.connectedAt,
                now,
              },
              tx,
            );
          }
        } else if (prior !== null && sameFacts(prior, input.report)) {
          await this.deps.repository.confirm(scope, prior.id, now, tx);
          connection = { ...prior, lastConfirmedAt: now };
          change = 'CONFIRMED';
        } else if (prior !== null) {
          connection = await this.deps.repository.update(scope, prior.id, input.report, now, tx);
          change = 'UPDATED';
        } else {
          throw new Error('business connection: neither stored nor inserted.');
        }

        const status = businessConnectionStatus(connection);
        const beforeStatus = prior === null ? null : businessConnectionStatus(prior);
        if (change !== 'CONFIRMED') {
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'business_connection.report',
              entityType: 'TelegramBusinessConnection',
              entityId: connection.id,
              before: prior === null ? null : auditFacts(prior),
              after: auditFacts(connection),
              result: 'SUCCESS',
            },
            tx,
          );
        }
        await this.recordCondition(scope, connection, beforeStatus, status, tx);
        for (const old of superseded) {
          // Its status just before it was replaced: only a connection that had an open
          // condition has one to close.
          const prior = businessConnectionStatus({ ...old, supersededAt: null });
          await this.recordCondition(scope, old, prior, 'SUPERSEDED', tx);
        }

        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          { id: connection.id, change },
          tx,
        );
        return { connection, change, status };
      },
    );
  }

  /**
   * The stored connection for a business message, asking Telegram when NEXA has never
   * seen it. Null when Telegram does not know it either, or cannot be asked right now —
   * never a guessed row. Both are reported to the operator.
   */
  async ensureKnown(
    scope: ScopeContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: string;
      readonly connectionId: string;
    },
  ): Promise<BusinessConnectionRecord | null> {
    const known = await this.deps.repository.find(scope, input.botInstanceId, input.connectionId);
    if (known !== null) return known;

    const fetched = await this.readFromTelegram(scope, input.botInstanceId, input.connectionId);
    if (fetched.outcome !== 'FOUND') {
      await this.deps.opsLog.record(scope, {
        code: BUSINESS_UPDATE_FAILED_CODE,
        severity: 'WARN',
        message:
          'A Telegram Business message arrived for a connection NEXA does not have, and Telegram ' +
          'could not confirm it. The message was not processed.',
        dedupeKey: `${BUSINESS_UPDATE_FAILED_CODE}:unknown_connection:${input.botInstanceId}`,
        context: {
          botInstanceId: input.botInstanceId,
          reason: fetched.outcome,
          errorCode: fetched.errorCode,
        },
      });
      return null;
    }
    const applied = await this.applyReport(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      botInstanceId: input.botInstanceId,
      report: fetched.report,
    });
    return applied.connection;
  }

  /**
   * Re-reads a connection from Telegram and applies what it says. Called after a refused
   * send. `NOT_FOUND` means Telegram no longer knows the id, which is recorded as the
   * connection being disabled — the only safe reading of "this id does not exist".
   * `UNAVAILABLE` changes nothing: no answer is not evidence.
   */
  async verify(
    scope: ScopeContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly connectionRowId: string },
  ): Promise<BusinessConnectionStatus | null> {
    const current = await this.deps.repository.findById(scope, input.connectionRowId);
    if (current === null) return null;
    const fetched = await this.readFromTelegram(scope, current.botInstanceId, current.connectionId);
    if (fetched.outcome === 'UNAVAILABLE') return businessConnectionStatus(current);
    const report: BusinessConnectionReport =
      fetched.outcome === 'FOUND'
        ? fetched.report
        : {
            connectionId: current.connectionId,
            ownerTelegramUserId: current.ownerTelegramUserId,
            ownerUserChatId: current.ownerUserChatId,
            isEnabled: false,
            rights: current.rights,
            connectedAt: current.connectedAt,
          };
    const applied = await this.applyReport(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      botInstanceId: current.botInstanceId,
      report,
    });
    return applied.status;
  }

  /**
   * Classifies one business message against its connection (ADR-0033 §3). Pure apart from
   * reading this bot's own Telegram id.
   *
   * `knownOwnMessage` is false in TB1: the send record that would prove a message id is
   * ours arrives with the TB2 outbound lane. Until then ownership is proven by
   * `sender_business_bot` alone, and anything unproven is HUMAN — the conservative rule.
   */
  async classify(
    scope: ScopeContext,
    connection: BusinessConnectionRecord,
    message: BusinessMessageFacts,
    knownOwnMessage = false,
  ): Promise<BusinessMessageOrigin> {
    const ownBotId = await this.deps.repository.ownBotId(scope, connection.botInstanceId);
    return classifyBusinessMessage({
      fromUserId: message.fromUserId,
      ownerUserId: connection.ownerTelegramUserId,
      senderBusinessBotId: message.senderBusinessBotId,
      ownBotId,
      isFromOffline: message.isFromOffline,
      knownOwnMessage,
    });
  }

  private async readFromTelegram(
    scope: ScopeContext,
    botInstanceId: string,
    connectionId: string,
  ): Promise<
    | { readonly outcome: 'FOUND'; readonly report: BusinessConnectionReport }
    | { readonly outcome: 'NOT_FOUND' | 'UNAVAILABLE'; readonly errorCode: string }
  > {
    const token = await this.deps.tokens.tokenForBotInstance(scope, botInstanceId);
    if (token === null) return { outcome: 'UNAVAILABLE', errorCode: 'bot.not_active' };
    return this.deps.telegram.getConnection(token, connectionId);
  }

  /**
   * One open condition per connection while it cannot send; closed by its recovery.
   *
   * Recorded on a TRANSITION (or a first report), not on every report: a disabled
   * connection reported again is the same condition, and the recorder's dedupe would
   * only count it. A connection superseded while unusable has its condition closed —
   * the operator's action is now on the connection that replaced it.
   */
  private async recordCondition(
    scope: ScopeContext,
    connection: BusinessConnectionRecord,
    before: BusinessConnectionStatus | null,
    after: BusinessConnectionStatus,
    tx: unknown,
  ): Promise<void> {
    const dedupeKey = `${BUSINESS_CONNECTION_UNUSABLE_CODE}:${connection.id}`;
    const context = {
      connectionRowId: connection.id,
      botInstanceId: connection.botInstanceId,
      status: after,
      rights: connection.rights,
    };
    const unusable = after === 'DISABLED' || after === 'RIGHTS_INSUFFICIENT';
    if (unusable && before !== after) {
      await this.deps.opsLog.record(
        scope,
        {
          code: BUSINESS_CONNECTION_UNUSABLE_CODE,
          severity: 'WARN',
          message:
            after === 'DISABLED'
              ? 'A Telegram Business connection is disabled. NEXA sends nothing through it until the account owner reconnects the bot.'
              : 'A Telegram Business connection lacks the right to reply. NEXA sends nothing through it until the owner grants it.',
          dedupeKey,
          context,
        },
        tx,
      );
      return;
    }
    const wasOpen = before === 'DISABLED' || before === 'RIGHTS_INSUFFICIENT';
    const closes = wasOpen && (after === 'ACTIVE' || after === 'SUPERSEDED');
    if (closes) {
      await this.deps.opsLog.record(
        scope,
        {
          code: BUSINESS_CONNECTION_USABLE_CODE,
          severity: 'INFO',
          message:
            after === 'ACTIVE'
              ? 'A Telegram Business connection can send again.'
              : 'A Telegram Business connection was replaced by a newer connection of the same account.',
          recoversCode: BUSINESS_CONNECTION_UNUSABLE_CODE,
          recoversDedupeKey: dedupeKey,
          context,
        },
        tx,
      );
    }
  }

  private async assertScopeActive(scope: ScopeContext, tx: TransactionScope): Promise<void> {
    if (await this.deps.scopeActivity.scopeIsActive(scope, tx)) return;
    throw errors.notFound(
      PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
      'This scope is not accepting work.',
    );
  }

  private async authorize(
    scope: ScopeContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, BUSINESS_CONNECTION_SYSTEM_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        BUSINESS_CONNECTION_SYSTEM_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}

function sameFacts(row: BusinessConnectionRecord, report: BusinessConnectionReport): boolean {
  return (
    row.ownerTelegramUserId === report.ownerTelegramUserId &&
    row.ownerUserChatId === report.ownerUserChatId &&
    row.isEnabled === report.isEnabled &&
    row.connectedAt.getTime() === report.connectedAt.getTime() &&
    sameSet(row.rights, report.rights)
  );
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const held = new Set(a);
  return b.every((value) => held.has(value));
}

/** What the audit row keeps: facts, never a token, and no customer text (there is none here). */
function auditFacts(row: BusinessConnectionRecord): Record<string, unknown> {
  return {
    connectionId: row.connectionId,
    ownerTelegramUserId: row.ownerTelegramUserId,
    isEnabled: row.isEnabled,
    rights: [...row.rights].sort(),
    supersededAt: row.supersededAt?.toISOString() ?? null,
  };
}
