import {
  BUSINESS_CHAT_DETAIL_MESSAGES,
  BUSINESS_TAKEOVER_ORIGINS,
  BUSINESS_UPDATE_FAILED_CODE,
  businessChatSendRequestSchema,
  errors,
  PLATFORM_ERROR_CODES,
  type ActorContext,
  type AuditWriter,
  type BusinessConversationState,
  type BusinessHandoffReason,
  type BusinessMessageOrigin,
  type BusinessOutboundOrigin,
  type BusinessTakeoverReason,
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
import type { ParsedBusinessDeletion, ParsedBusinessMessage } from '../domain/telegram-business.js';
import type { BusinessConnectionService } from './business-connection.service.js';
import { BUSINESS_CONNECTION_SYSTEM_PERMISSION } from './business-connection.service.js';
import type {
  BusinessConnectionRecord,
  BusinessConversationListItem,
  BusinessConversationRecord,
  BusinessConversationRepository,
  BusinessCustomerLookup,
  BusinessMessageRecord,
  BusinessMessageRepository,
  BusinessOutboundRecord,
  BusinessOutboundRepository,
} from './ports.js';

export const BUSINESS_CHATS_VIEW_PERMISSION = 'business_chats.view' satisfies PermissionKey;
export const BUSINESS_CHATS_REPLY_PERMISSION = 'business_chats.reply' satisfies PermissionKey;

export const BUSINESS_CHAT_ERROR_CODES = {
  NOT_FOUND: 'business_chats.not_found',
  CONNECTION_UNUSABLE: 'business_chats.connection_unusable',
  IDEMPOTENCY_MISMATCH: 'business_chats.idempotency_payload_mismatch',
  NOT_IN_STATE: 'business_chats.not_in_state',
} as const;

export interface BusinessConversationServiceDeps {
  readonly conversations: BusinessConversationRepository;
  readonly messages: BusinessMessageRepository;
  readonly outbound: BusinessOutboundRepository;
  readonly customers: BusinessCustomerLookup;
  readonly connections: BusinessConnectionService;
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

/** What one recorded business message did to its conversation. */
export interface RecordedBusinessMessage {
  readonly conversationId: string;
  readonly origin: BusinessMessageOrigin;
  /** False when the message was already recorded (a redelivery). */
  readonly inserted: boolean;
  /** True when this message moved the conversation to HUMAN_ACTIVE. */
  readonly tookOver: boolean;
}

/** The states a human signal takes a conversation FROM — every state that is not human. */
const NOT_HUMAN: readonly BusinessConversationState[] = ['AI_ACTIVE', 'HANDOFF_REQUIRED', 'PAUSED'];

/**
 * TB2 — Telegram Business conversations and who holds them (ADR-0033 §4–§8).
 *
 * The control rule, stated once because every method here applies it:
 *
 *   A HUMAN SIGNAL — the owner typing (`HUMAN`), another business bot (`OTHER_BOT`), an
 *   operator taking over, or an operator/assist send — moves the conversation INTO
 *   `HUMAN_ACTIVE` and increments `control_epoch`, under the conversation's lock, in the
 *   transaction that records it. Every PENDING lane row created under an older epoch is
 *   superseded in the same transaction, and the send lane re-checks the epoch under the same
 *   lock before stamping any send. A further human signal while the conversation is ALREADY
 *   human does not move the epoch: nothing the AI queued can be sending then (an `AUTO` row
 *   also needs `AI_ACTIVE`), and moving it would supersede the operator's own queued replies.
 *
 *   Resuming the AI is the other epoch move: `HUMAN_ACTIVE`/`HANDOFF_REQUIRED`/`PAUSED` →
 *   `AI_ACTIVE`, so nothing queued while a human held the conversation sends afterwards.
 */
export class BusinessConversationService {
  constructor(private readonly deps: BusinessConversationServiceDeps) {}

  // -------------------------------------------------------------------------
  // From the webhook (SYSTEM_JOB)
  // -------------------------------------------------------------------------

  /**
   * Records one business message (new or edited) and applies what its origin means.
   * Idempotent on the update key. Null when the message cannot be attributed to a stored
   * connection (already reported by the connection service).
   */
  async recordMessage(
    scope: ScopeContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: string;
      readonly message: ParsedBusinessMessage;
      readonly edited: boolean;
    },
  ): Promise<RecordedBusinessMessage | null> {
    const message = input.message;
    if (message.chatType !== 'private') {
      await this.reportUnhandled(scope, input.botInstanceId, 'NOT_PRIVATE');
      return null;
    }
    const connection = await this.deps.connections.ensureKnown(scope, actor, {
      idempotencyKey: `${input.idempotencyKey}:connection`,
      botInstanceId: input.botInstanceId,
      connectionId: message.connectionId,
    });
    if (connection === null) return null;

    await this.authorizeSystem(scope, actor, 'business_chat.message');
    // The update's own facts only. The ORIGIN is derived, and can legitimately change between
    // a delivery and its redelivery (the echo proof below resolves), so it is not hashed (TB2
    // review N5): a redelivery replays rather than failing as a payload mismatch.
    const requestHash = hashRequest({
      command: 'business_chat.message',
      connectionId: message.connectionId,
      chatId: message.chatId,
      messageId: message.messageId,
      edited: input.edited,
      editedAt: message.editedAt?.toISOString() ?? null,
    });
    const replay = await this.deps.idempotency.find<RecordedBusinessMessage>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (replay) return replay.result;

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      BUSINESS_CONNECTION_SYSTEM_PERMISSION,
      { action: 'business_chat.message', entityType: 'BusinessConversation', entityId: null },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const now = this.deps.clock.now();
        const conversation = await this.deps.conversations.upsertLocked(
          scope,
          {
            id: this.deps.ids.uuid(),
            botInstanceId: input.botInstanceId,
            ownerTelegramUserId: connection.ownerTelegramUserId,
            chatId: message.chatId,
            connectionRowId: connection.id,
            // A private business chat's id IS the customer's Telegram id.
            peerTelegramUserId: message.chatId,
            now,
          },
          tx,
        );

        // Classified UNDER the conversation lock, which the lane also takes before it records
        // a delivery: the send-record proof (ADR-0033 §3) reads a committed state, never one
        // the lane is about to write (TB2 review F2). An EDIT is never proved ours by the send
        // record: that proves the message id, not the edit, and NEXA never edits, so an edit
        // without `sender_business_bot` is the owner's act (TB2 review F3).
        const knownOwnMessage = input.edited
          ? false
          : await this.deps.outbound.isOwnMessage(
              scope,
              {
                botInstanceId: input.botInstanceId,
                ownerTelegramUserId: connection.ownerTelegramUserId,
                chatId: message.chatId,
                telegramMessageId: message.messageId,
              },
              tx,
            );
        const origin = await this.deps.connections.classify(
          scope,
          connection,
          message,
          knownOwnMessage,
        );

        let inserted = false;
        if (input.edited) {
          const version = await this.deps.messages.applyEdit(
            scope,
            {
              conversationId: conversation.id,
              telegramMessageId: message.messageId,
              text: message.text,
              editedAt: message.editedAt ?? message.sentAt,
            },
            tx,
          );
          // An edit of a message we never saw is stored as the message it now is.
          if (version === null) {
            inserted = await this.insertMessage(scope, conversation.id, message, origin, now, tx);
          }
        } else {
          inserted = await this.insertMessage(scope, conversation.id, message, origin, now, tx);
        }

        let tookOver = false;
        if (inserted || input.edited) {
          tookOver = await this.applyOrigin(scope, actor, conversation, origin, message, now, tx);
        }

        const result: RecordedBusinessMessage = {
          conversationId: conversation.id,
          origin,
          inserted,
          tookOver,
        };
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          result,
          tx,
        );
        return result;
      },
    );
  }

  /** Telegram deleted messages: text purged, nothing about control changes (ADR-0033 §7). */
  async recordDeletion(
    scope: ScopeContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: string;
      readonly deletion: ParsedBusinessDeletion;
    },
  ): Promise<number> {
    const connection = await this.deps.connections.find(
      scope,
      input.botInstanceId,
      input.deletion.connectionId,
    );
    if (connection === null) return 0;
    await this.authorizeSystem(scope, actor, 'business_chat.deletion');
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      BUSINESS_CONNECTION_SYSTEM_PERMISSION,
      { action: 'business_chat.deletion', entityType: 'BusinessConversation', entityId: null },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const now = this.deps.clock.now();
        // A conversation NEXA never recorded has nothing to purge; none is created for it.
        const listed = await this.findConversation(scope, connection, input.deletion.chatId, tx);
        if (listed === null) return 0;
        return this.deps.messages.markDeleted(
          scope,
          { conversationId: listed.id, telegramMessageIds: input.deletion.messageIds, now },
          tx,
        );
      },
    );
  }

  // -------------------------------------------------------------------------
  // From the Web Admin (an operator)
  // -------------------------------------------------------------------------

  async list(
    scope: ScopeContext,
    actor: ActorContext,
    input: {
      readonly state?: BusinessConversationState;
      readonly before?: { readonly at: Date; readonly id: string };
      readonly limit: number;
    },
  ): Promise<readonly BusinessConversationListItem[]> {
    await this.deps.guard.check(scope, actor, BUSINESS_CHATS_VIEW_PERMISSION);
    return this.deps.conversations.list(scope, input);
  }

  /** The tenant's business connections and their projected status (`business_chats.view`). */
  async connections(scope: ScopeContext, actor: ActorContext) {
    await this.deps.guard.check(scope, actor, BUSINESS_CHATS_VIEW_PERMISSION);
    return this.deps.connections.list(scope);
  }

  async detail(
    scope: ScopeContext,
    actor: ActorContext,
    conversationId: string,
  ): Promise<{
    readonly item: BusinessConversationListItem;
    readonly messages: readonly BusinessMessageRecord[];
    readonly outbound: readonly BusinessOutboundRecord[];
  }> {
    await this.deps.guard.check(scope, actor, BUSINESS_CHATS_VIEW_PERMISSION);
    const conversation = await this.deps.conversations.findById(scope, conversationId);
    if (conversation === null) throw this.notFound();
    const [item, messages, outbound] = await Promise.all([
      this.listItemFor(scope, conversation),
      this.deps.messages.recent(scope, conversationId, BUSINESS_CHAT_DETAIL_MESSAGES),
      this.deps.outbound.recent(scope, conversationId, BUSINESS_CHAT_DETAIL_MESSAGES),
    ]);
    return { item, messages, outbound };
  }

  /** The operator takes the conversation: HUMAN_ACTIVE, epoch+1 (a no-op when already human). */
  async takeOver(
    scope: ScopeContext,
    actor: ActorContext,
    input: { readonly conversationId: string; readonly idempotencyKey: string },
  ): Promise<{ readonly state: BusinessConversationState; readonly controlEpoch: number }> {
    return this.control(
      scope,
      actor,
      input,
      'business_chat.takeover',
      async (conversation, now, tx) => {
        const moved = await this.humanSignal(scope, conversation, 'OPERATOR_TAKEOVER', now, tx);
        return moved ?? conversation;
      },
    );
  }

  /**
   * «سپردن دوباره به هوش مصنوعی» — the ONLY way back to AI_ACTIVE (ADR-0033 §5). Advances the
   * epoch, so nothing queued while a person held the conversation sends afterwards.
   */
  async resume(
    scope: ScopeContext,
    actor: ActorContext,
    input: { readonly conversationId: string; readonly idempotencyKey: string },
  ): Promise<{ readonly state: BusinessConversationState; readonly controlEpoch: number }> {
    return this.control(
      scope,
      actor,
      input,
      'business_chat.resume',
      async (conversation, now, tx) => {
        if (conversation.state === 'AI_ACTIVE') return conversation;
        const moved = await this.deps.conversations.transition(
          scope,
          conversation.id,
          {
            from: ['HUMAN_ACTIVE', 'HANDOFF_REQUIRED', 'PAUSED'],
            to: 'AI_ACTIVE',
            bumpEpoch: true,
            takeoverReason: null,
            now,
          },
          tx,
        );
        if (moved === null) throw this.notInState();
        await this.deps.outbound.supersedeStale(scope, moved.id, moved.controlEpoch, now, tx);
        return moved;
      },
    );
  }

  /**
   * An operator writes as the business account. The insert is itself a human signal
   * (TB0 review F7): the operator's message echoes back attributed to our own bot, so
   * without this the AI could answer over them.
   */
  async send(
    scope: ScopeContext,
    actor: ActorContext,
    input: {
      readonly conversationId: string;
      readonly idempotencyKey: string;
      readonly text: string;
    },
  ): Promise<BusinessOutboundRecord> {
    const command = businessChatSendRequestSchema.parse({
      idempotencyKey: input.idempotencyKey,
      text: input.text,
    });
    return this.enqueueHumanSend(scope, actor, {
      conversationId: input.conversationId,
      idempotencyKey: command.idempotencyKey,
      text: command.text,
      origin: 'OPERATOR',
    });
  }

  /**
   * The lane's handoff, inside its own transaction: AI_ACTIVE → HANDOFF_REQUIRED with a typed
   * reason, epoch+1. A conversation a human already holds is left with the human.
   */
  async handOff(
    scope: ScopeContext,
    conversationId: string,
    reason: BusinessHandoffReason,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const moved = await this.deps.conversations.transition(
      scope,
      conversationId,
      {
        from: ['AI_ACTIVE', 'PAUSED'],
        to: 'HANDOFF_REQUIRED',
        bumpEpoch: true,
        handoffReason: reason,
        now,
      },
      tx,
    );
    if (moved === null) return false;
    await this.deps.outbound.supersedeStale(scope, conversationId, moved.controlEpoch, now, tx);
    return true;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Shared by the operator's send and (TB5) an assist send. */
  async enqueueHumanSend(
    scope: ScopeContext,
    actor: ActorContext,
    input: {
      readonly conversationId: string;
      readonly idempotencyKey: string;
      readonly text: string;
      readonly origin: Extract<BusinessOutboundOrigin, 'OPERATOR' | 'ASSIST'>;
    },
  ): Promise<BusinessOutboundRecord> {
    if (actor.id === null) {
      throw errors.permissionDenied(
        PLATFORM_ERROR_CODES.PERMISSION_DENIED,
        'Only an administrator writes as the business account.',
      );
    }
    const adminId = actor.id;
    const key = `${actor.surface}:${adminId}:${input.idempotencyKey}`;
    const requestHash = hashRequest({
      command: 'business_chat.send',
      conversationId: input.conversationId,
      origin: input.origin,
      text: input.text,
    });
    const denial = {
      action: 'business_chat.send',
      entityType: 'BusinessConversation',
      entityId: input.conversationId,
    };
    try {
      await this.deps.guard.check(scope, actor, BUSINESS_CHATS_REPLY_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        BUSINESS_CHATS_REPLY_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
    const existing = await this.deps.outbound.findByIdempotencyKey(scope, key);
    if (existing !== null) return this.replayOf(existing, requestHash);

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      BUSINESS_CHATS_REPLY_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const now = this.deps.clock.now();
        const raced = await this.deps.outbound.findByIdempotencyKey(scope, key, tx);
        if (raced !== null) return this.replayOf(raced, requestHash);
        const conversation = await this.deps.conversations.lockById(
          scope,
          input.conversationId,
          tx,
        );
        if (conversation === null) throw this.notFound();
        // Refused up front rather than queued to fail: the operator is looking at the screen.
        const connection = await this.deps.connections.findById(
          scope,
          conversation.connectionRowId,
        );
        if (connection === null || connection.status !== 'ACTIVE') {
          throw errors.conflict(
            BUSINESS_CHAT_ERROR_CODES.CONNECTION_UNUSABLE,
            'The Telegram Business connection for this conversation cannot send right now.',
          );
        }
        const reason: BusinessTakeoverReason = 'OPERATOR_SEND';
        const held = (await this.humanSignal(scope, conversation, reason, now, tx)) ?? conversation;
        const row = await this.deps.outbound.insert(
          scope,
          {
            id: this.deps.ids.uuid(),
            conversationId: held.id,
            origin: input.origin,
            body: input.text,
            createdByAdminId: adminId,
            controlEpoch: held.controlEpoch,
            idempotencyKey: key,
            requestHash,
            now,
          },
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'business_chat.send',
            entityType: 'BusinessConversation',
            entityId: held.id,
            // What was sent is the customer's conversation, not audit material.
            before: { state: conversation.state, controlEpoch: conversation.controlEpoch },
            after: {
              state: held.state,
              controlEpoch: held.controlEpoch,
              outboundId: row.id,
              origin: input.origin,
              characters: input.text.length,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        return row;
      },
    );
  }

  /**
   * A human signal: into HUMAN_ACTIVE with epoch+1 when the conversation was not human, and
   * every older PENDING lane row superseded. Null when it was already human (no move).
   */
  private async humanSignal(
    scope: ScopeContext,
    conversation: BusinessConversationRecord,
    reason: BusinessTakeoverReason,
    now: Date,
    tx: unknown,
  ): Promise<BusinessConversationRecord | null> {
    if (conversation.state === 'HUMAN_ACTIVE') return null;
    const moved = await this.deps.conversations.transition(
      scope,
      conversation.id,
      { from: NOT_HUMAN, to: 'HUMAN_ACTIVE', bumpEpoch: true, takeoverReason: reason, now },
      tx,
    );
    if (moved === null) return null;
    await this.deps.outbound.supersedeStale(scope, moved.id, moved.controlEpoch, now, tx);
    return moved;
  }

  /** Applies a recorded message's origin. Returns whether it took the conversation over. */
  private async applyOrigin(
    scope: ScopeContext,
    actor: ActorContext,
    conversation: BusinessConversationRecord,
    origin: BusinessMessageOrigin,
    message: ParsedBusinessMessage,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const at = message.editedAt ?? message.sentAt;
    if (origin === 'INBOUND') {
      const customer = await this.deps.customers.byTelegramUserId(
        scope,
        conversation.peerTelegramUserId,
        tx,
      );
      await this.deps.conversations.touch(
        scope,
        conversation.id,
        {
          lastMessageAt: at,
          lastInboundAt: at,
          ...(customer === null || customer.id === conversation.customerId
            ? {}
            : { customerId: customer.id }),
          now,
        },
        tx,
      );
      return false;
    }
    if ((BUSINESS_TAKEOVER_ORIGINS as readonly string[]).includes(origin)) {
      const moved = await this.humanSignal(
        scope,
        conversation,
        origin === 'OTHER_BOT' ? 'OTHER_BOT' : 'HUMAN_MESSAGE',
        now,
        tx,
      );
      await this.deps.conversations.touch(
        scope,
        conversation.id,
        { lastMessageAt: at, lastHumanAt: at, now },
        tx,
      );
      if (moved !== null) {
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'business_chat.human_takeover',
            entityType: 'BusinessConversation',
            entityId: conversation.id,
            before: { state: conversation.state, controlEpoch: conversation.controlEpoch },
            after: { state: moved.state, controlEpoch: moved.controlEpoch, origin },
            result: 'SUCCESS',
          },
          tx,
        );
      }
      return moved !== null;
    }
    // OWN_ECHO and OFFLINE: recorded, and nothing about control changes.
    await this.deps.conversations.touch(scope, conversation.id, { lastMessageAt: at, now }, tx);
    return false;
  }

  private async insertMessage(
    scope: ScopeContext,
    conversationId: string,
    message: ParsedBusinessMessage,
    origin: BusinessMessageOrigin,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    return this.deps.messages.insertIfAbsent(
      scope,
      {
        id: this.deps.ids.uuid(),
        conversationId,
        telegramMessageId: message.messageId,
        origin,
        kind: message.kind,
        text: message.text,
        sentAt: message.sentAt,
        now,
      },
      tx,
    );
  }

  private async control(
    scope: ScopeContext,
    actor: ActorContext,
    input: { readonly conversationId: string; readonly idempotencyKey: string },
    action: 'business_chat.takeover' | 'business_chat.resume',
    apply: (
      conversation: BusinessConversationRecord,
      now: Date,
      tx: TransactionScope,
    ) => Promise<BusinessConversationRecord>,
  ): Promise<{ readonly state: BusinessConversationState; readonly controlEpoch: number }> {
    const denial = { action, entityType: 'BusinessConversation', entityId: input.conversationId };
    try {
      await this.deps.guard.check(scope, actor, BUSINESS_CHATS_REPLY_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        BUSINESS_CHATS_REPLY_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
    const requestHash = hashRequest({ command: action, conversationId: input.conversationId });
    type Result = { readonly state: BusinessConversationState; readonly controlEpoch: number };
    const replay = await this.deps.idempotency.find<Result>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (replay) return replay.result;
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      BUSINESS_CHATS_REPLY_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const now = this.deps.clock.now();
        const conversation = await this.deps.conversations.lockById(
          scope,
          input.conversationId,
          tx,
        );
        if (conversation === null) throw this.notFound();
        const after = await apply(conversation, now, tx);
        if (
          after.controlEpoch !== conversation.controlEpoch ||
          after.state !== conversation.state
        ) {
          await this.deps.audit.record(
            scope,
            actor,
            {
              action,
              entityType: 'BusinessConversation',
              entityId: conversation.id,
              before: { state: conversation.state, controlEpoch: conversation.controlEpoch },
              after: { state: after.state, controlEpoch: after.controlEpoch },
              result: 'SUCCESS',
            },
            tx,
          );
        }
        const result: Result = { state: after.state, controlEpoch: after.controlEpoch };
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          result,
          tx,
        );
        return result;
      },
    );
  }

  private async findConversation(
    scope: ScopeContext,
    connection: BusinessConnectionRecord,
    chatId: string,
    tx: unknown,
  ): Promise<{ readonly id: string } | null> {
    // A deletion only applies to an existing conversation; the upsert would create one.
    const item = await this.deps.conversations.findByChat(
      scope,
      {
        botInstanceId: connection.botInstanceId,
        ownerTelegramUserId: connection.ownerTelegramUserId,
        chatId,
      },
      tx,
    );
    return item;
  }

  private async listItemFor(
    scope: ScopeContext,
    conversation: BusinessConversationRecord,
  ): Promise<BusinessConversationListItem> {
    const item = await this.deps.conversations.listItem(scope, conversation.id);
    if (item === null) throw this.notFound();
    return item;
  }

  private replayOf(existing: BusinessOutboundRecord, requestHash: string): BusinessOutboundRecord {
    if (existing.requestHash !== requestHash) {
      throw errors.conflict(
        BUSINESS_CHAT_ERROR_CODES.IDEMPOTENCY_MISMATCH,
        'This idempotency key was already used for a different message.',
      );
    }
    return existing;
  }

  private async reportUnhandled(
    scope: ScopeContext,
    botInstanceId: string,
    reason: string,
  ): Promise<void> {
    await this.deps.opsLog.record(scope, {
      code: BUSINESS_UPDATE_FAILED_CODE,
      severity: 'WARN',
      message: 'A Telegram Business message NEXA does not handle was received and ignored.',
      dedupeKey: `${BUSINESS_UPDATE_FAILED_CODE}:${reason.toLowerCase()}:${botInstanceId}`,
      context: { botInstanceId, reason },
    });
  }

  private async authorizeSystem(
    scope: ScopeContext,
    actor: ActorContext,
    action: string,
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, BUSINESS_CONNECTION_SYSTEM_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        BUSINESS_CONNECTION_SYSTEM_PERMISSION,
        { action, entityType: 'BusinessConversation', entityId: null },
        error,
      );
      throw error;
    }
  }

  private async assertScopeActive(scope: ScopeContext, tx: TransactionScope): Promise<void> {
    if (await this.deps.scopeActivity.scopeIsActive(scope, tx)) return;
    throw errors.notFound(
      PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
      'This scope is not accepting work.',
    );
  }

  private notFound() {
    return errors.notFound(BUSINESS_CHAT_ERROR_CODES.NOT_FOUND, 'No such business conversation.');
  }

  private notInState() {
    return errors.conflict(
      BUSINESS_CHAT_ERROR_CODES.NOT_IN_STATE,
      'The conversation changed state; reload it and try again.',
    );
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
