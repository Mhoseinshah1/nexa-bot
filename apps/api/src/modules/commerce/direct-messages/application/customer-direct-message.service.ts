import { createHash } from 'node:crypto';
import {
  COMMERCE_ERROR_CODES,
  DIRECT_MESSAGE_CAPTION_MAX_LENGTH,
  DIRECT_MESSAGE_ERROR_CODES,
  DIRECT_MESSAGE_FILE_STAGED_MAX_BYTES,
  DIRECT_MESSAGE_MAX_PER_ADMIN,
  DIRECT_MESSAGE_MAX_PER_CUSTOMER,
  DIRECT_MESSAGE_RATE_WINDOW_MS,
  DIRECT_MESSAGE_TEXT_MAX_LENGTH,
  NexaError,
  PLATFORM_ERROR_CODES,
  errors,
  normalizeDirectMessageText,
  ticketReplyFileNameOf,
  ticketReplyFileRefusal,
  ticketReplyFileTypeOf,
  userIdSchema,
  type ActorContext,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type CustomerNotificationKind,
  type DirectMessageContentKind,
  type DirectMessageFile,
  type DirectMessageFileMimeType,
  type DirectMessageTargetRefusal,
  type IdGenerator,
  type OperationalEventRecorder,
  type PermissionKey,
  type TemplateValues,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
import type { NotificationFile } from '../../messaging/application/customer-notification.service.js';
import type {
  DirectMessageHistoryRow,
  DirectMessageRecord,
  DirectMessageRepository,
} from './ports.js';

export const DIRECT_MESSAGE_SEND_PERMISSION: PermissionKey = 'users.message.send';
export const DIRECT_MESSAGE_VIEW_PERMISSION: PermissionKey = 'users.message.view';

export interface CustomerDirectMessageServiceDeps {
  readonly repository: DirectMessageRepository;
  readonly notifier: Pick<CustomerNotifier, 'notifyThrough'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface SendDirectMessageInput {
  readonly customerId: string;
  readonly idempotencyKey: string;
  /** The message, or the caption when a file is attached. */
  readonly text: string;
  readonly file: DirectMessageFile | null;
}

export interface DirectMessageSent {
  readonly row: DirectMessageHistoryRow;
  readonly replayed: boolean;
}

/** The lane kind each content kind travels as. */
function laneKindOf(kind: DirectMessageContentKind): CustomerNotificationKind {
  return kind === 'TEXT' ? 'DIRECT_MESSAGE' : 'DIRECT_MESSAGE_MEDIA';
}

/** The operator's file, judged by the ONE rule support's ticket files are held to. */
function judgedFile(file: DirectMessageFile): {
  readonly kind: 'PHOTO' | 'DOCUMENT';
  readonly mimeType: DirectMessageFileMimeType;
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
} {
  const decoded = Buffer.from(file.contentBase64, 'base64');
  const bytes = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  const refusal = ticketReplyFileRefusal({
    fileName: file.fileName,
    mimeType: file.mimeType,
    bytes,
  });
  const type = ticketReplyFileTypeOf(file.mimeType);
  if (refusal !== null || type === undefined) {
    throw errors.validation(DIRECT_MESSAGE_ERROR_CODES.FILE_REFUSED, 'This file cannot be sent.', {
      refusal: refusal ?? 'TYPE_NOT_ALLOWED',
    });
  }
  return {
    kind: type.kind,
    mimeType: type.mimeType,
    fileName: ticketReplyFileNameOf(file.fileName, type),
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * «ارسال پیام» from Customer 360 — Phase A2 (`docs/direct-message-audit.md`).
 *
 * The write is ONE transaction, in this order, and every step is load-bearing:
 *
 * 1. `users.message.send` through the guard — independent of `broadcasts.send` — and again
 *    inside the transaction (`runAuthorizedMutation`), with the scope's activity read there.
 * 2. The tenant's direct-message lock, FIRST, so the idempotency lookup, both rate-limit
 *    counts and the staging bound are decided by one writer at a time.
 * 3. A replay of the same key and content answers with the first message and queues
 *    nothing: a double click, a retried request or a lost response never sends twice.
 * 4. The target, revalidated NOW under its row lock: this tenant's, not blocked, and with
 *    an ACTIVE bot it wrote to — the bot the message is sent through.
 * 5. The row, the lane row naming it (`notifyThrough`), the outbox event and the audit
 *    record commit together, or none of them do.
 *
 * Nothing here talks to Telegram. The customer notification lane sends it, with that lane's
 * rules: a 429 waits and spends nothing, a refusal is retried to the ceiling, and an UNKNOWN
 * outcome is final — never re-sent, by the lane or by anything here.
 */
export class CustomerDirectMessageService {
  constructor(private readonly deps: CustomerDirectMessageServiceDeps) {}

  async send(
    scope: TenantContext,
    actor: ActorContext,
    input: SendDirectMessageInput,
  ): Promise<DirectMessageSent> {
    const customerId = this.customerIdOf(input.customerId);
    const denial = {
      action: 'customer.direct_message',
      entityType: 'Customer',
      entityId: customerId,
    };
    await this.authorize(scope, actor, DIRECT_MESSAGE_SEND_PERMISSION, denial);
    const adminId = actor.type === 'WEB_ADMIN' || actor.type === 'TELEGRAM_ADMIN' ? actor.id : null;
    if (adminId === null) {
      throw errors.permissionDenied(
        PLATFORM_ERROR_CODES.PERMISSION_DENIED,
        'Only an administrator can send a direct message.',
      );
    }

    // Judged before anything is written: a refused file or text writes nothing at all.
    const file = input.file === null ? null : judgedFile(input.file);
    const body = normalizeDirectMessageText(input.text);
    const bound =
      file === null ? DIRECT_MESSAGE_TEXT_MAX_LENGTH : DIRECT_MESSAGE_CAPTION_MAX_LENGTH;
    if ((file === null && body === null) || (body !== null && Array.from(body).length > bound)) {
      throw errors.validation(
        DIRECT_MESSAGE_ERROR_CODES.BODY_INVALID,
        file === null ? 'Write a message to send.' : 'The caption is too long.',
        { maxLength: bound },
      );
    }
    const contentKind: DirectMessageContentKind = file === null ? 'TEXT' : file.kind;

    // Namespaced by surface and administrator: two surfaces, or two people, never share a key.
    const key = `${actor.surface}:${adminId}:${input.idempotencyKey}`;
    // The file's digest, never its bytes: the same key with another file is another command.
    const requestHash = hashRequest({
      op: 'direct-message',
      customerId,
      body,
      ...(file === null
        ? {}
        : { file: { sha256: file.sha256, mimeType: file.mimeType, fileName: file.fileName } }),
    });

    const sent = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      DIRECT_MESSAGE_SEND_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.deps.repository.lockTenant(scope, tx);

        const first = await this.deps.repository.findByKey(scope, key, tx);
        if (first !== null) {
          if (first.customerId !== customerId || first.requestHash !== requestHash) {
            throw errors.conflict(
              PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
              'That idempotency key already sent a different message.',
            );
          }
          return { id: first.id, replayed: true };
        }

        const target = await this.deps.repository.target(scope, customerId, tx);
        if (target === null) throw this.customerNotFound();
        if (target.status !== 'ACTIVE') throw this.targetUnavailable('BLOCKED');
        if (target.activeBotInstanceId === null) throw this.targetUnavailable('NO_BOT');

        const now = this.deps.clock.now();
        const since = new Date(now.getTime() - DIRECT_MESSAGE_RATE_WINDOW_MS);
        if (
          (await this.deps.repository.countByAdminSince(scope, adminId, since, tx)) >=
          DIRECT_MESSAGE_MAX_PER_ADMIN
        ) {
          throw this.rateLimited('ADMIN', DIRECT_MESSAGE_MAX_PER_ADMIN);
        }
        if (
          (await this.deps.repository.countByCustomerSince(scope, customerId, since, tx)) >=
          DIRECT_MESSAGE_MAX_PER_CUSTOMER
        ) {
          throw this.rateLimited('CUSTOMER', DIRECT_MESSAGE_MAX_PER_CUSTOMER);
        }
        if (file !== null) {
          const staged = await this.deps.repository.stagedBytes(scope, tx);
          if (staged + file.bytes.byteLength > DIRECT_MESSAGE_FILE_STAGED_MAX_BYTES) {
            throw errors.conflict(
              DIRECT_MESSAGE_ERROR_CODES.FILE_STORAGE_FULL,
              'Too many files are still waiting for Telegram.',
              { maxBytes: DIRECT_MESSAGE_FILE_STAGED_MAX_BYTES },
            );
          }
        }

        const id = this.deps.ids.uuid();
        await this.deps.repository.insert(
          scope,
          {
            id,
            customerId,
            botInstanceId: target.activeBotInstanceId,
            authorAdminId: adminId,
            contentKind,
            body,
            file:
              file === null
                ? null
                : {
                    mimeType: file.mimeType,
                    fileName: file.fileName,
                    bytes: file.bytes,
                    sha256: file.sha256,
                  },
            idempotencyKey: key,
            requestHash,
            now,
          },
          tx,
        );
        const queued = await this.deps.notifier.notifyThrough(
          scope,
          customerId as UserId,
          target.activeBotInstanceId as BotInstanceId,
          laneKindOf(contentKind),
          id,
          now,
          tx,
        );
        /* istanbul ignore next -- the id is new, so its subject key cannot be taken. */
        if (!queued)
          throw errors.internal(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID, 'Not queued.');
        await this.deps.outbox.write(tx, actor, {
          eventType: 'CustomerDirectMessageQueued',
          aggregateType: 'Customer',
          aggregateId: customerId,
          payload: { messageId: id, customerId, contentKind },
        });
        /*
         * The audit names the operator (the actor), the target (the entity) and the kind.
         * The TEXT IS NOT HERE — not in `after`, not in `reason`: the audit log is
         * append-only and read by people the customer never wrote to. Its length and the
         * file's digest are, so the record still identifies what was sent.
         */
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'customer.direct_message',
            entityType: 'Customer',
            entityId: customerId,
            before: null,
            after: {
              messageId: id,
              contentKind,
              textLength: body === null ? 0 : Array.from(body).length,
              ...(file === null
                ? {}
                : {
                    file: {
                      mimeType: file.mimeType,
                      byteLength: file.bytes.byteLength,
                      sha256: file.sha256,
                    },
                  }),
            },
            result: 'SUCCESS',
          },
          tx,
        );
        return { id, replayed: false };
      },
    );
    const row = await this.deps.repository.historyRow(scope, sent.id);
    /* istanbul ignore next -- committed above, and messages are never deleted. */
    if (row === null) throw this.customerNotFound();
    return { row, replayed: sent.replayed };
  }

  /** The customer's direct messages, newest first. Charged `users.message.view`. */
  async history(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly customerId: string;
      readonly limit: number;
      readonly before: { readonly at: Date; readonly id: string } | null;
    },
  ): Promise<readonly DirectMessageHistoryRow[]> {
    await this.deps.guard.check(scope, actor, DIRECT_MESSAGE_VIEW_PERMISSION);
    const customerId = this.customerIdOf(input.customerId);
    // A read, never a write path: no lock, no unit of work.
    if (!(await this.deps.repository.customerExists(scope, customerId))) {
      throw this.customerNotFound();
    }
    return this.deps.repository.history(scope, customerId, {
      limit: input.limit,
      before: input.before,
    });
  }

  // --- the lane's half: unguarded, its one caller acts on a row a guarded write queued ---

  /**
   * What the lane sends for `kind`, read from the MESSAGE ROW at send time: the text, or the
   * file and its optional caption. Null when the row is not that kind's, or a file's bytes
   * are already gone — the lane then FAILS the row rather than send anything else.
   */
  async notificationFacts(
    scope: TenantContext,
    kind: 'DIRECT_MESSAGE' | 'DIRECT_MESSAGE_MEDIA',
    messageId: string,
  ): Promise<{ readonly values: TemplateValues; readonly file?: NotificationFile } | null> {
    const message = await this.deps.repository.find(scope, messageId);
    if (message === null || laneKindOf(message.contentKind) !== kind) return null;
    if (message.contentKind === 'TEXT') {
      return message.body === null ? null : { values: { text: message.body } };
    }
    return this.fileFacts(scope, message);
  }

  /** Telegram took the file: its handle stamped and its bytes cleared, in the record's tx. */
  fileDelivered(
    scope: TenantContext,
    messageId: string,
    file: { readonly fileId: string; readonly fileUniqueId: string },
    at: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    return this.deps.repository.markFileDelivered(scope, messageId, file, at, tx);
  }

  private async fileFacts(
    scope: TenantContext,
    message: DirectMessageRecord,
  ): Promise<{ readonly values: TemplateValues; readonly file: NotificationFile } | null> {
    if (message.file === null || !message.file.staged) return null;
    const bytes = await this.deps.repository.fileContent(scope, message.id);
    if (bytes === null) return null;
    return {
      values: message.body === null ? {} : { caption: message.body },
      file: {
        kind: message.file.kind,
        bytes,
        fileName: message.file.fileName,
        mimeType: message.file.mimeType,
      },
    };
  }

  // --- helpers ----------------------------------------------------------------------------

  private customerIdOf(raw: string): string {
    const parsed = userIdSchema.safeParse(raw);
    if (!parsed.success) throw this.customerNotFound();
    return parsed.data;
  }

  private customerNotFound() {
    return errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
  }

  private targetUnavailable(reason: DirectMessageTargetRefusal) {
    return errors.preconditionFailed(
      DIRECT_MESSAGE_ERROR_CODES.TARGET_UNAVAILABLE,
      reason === 'BLOCKED'
        ? 'This customer is blocked; unblock them to write to them.'
        : 'This customer has no active bot conversation to write into.',
      { reason },
    );
  }

  private rateLimited(scopeName: 'ADMIN' | 'CUSTOMER', max: number) {
    return new NexaError({
      kind: 'RATE_LIMITED',
      code: DIRECT_MESSAGE_ERROR_CODES.RATE_LIMITED,
      message:
        scopeName === 'ADMIN'
          ? 'You have sent too many direct messages recently; wait a few minutes.'
          : 'This customer was sent too many direct messages recently; wait a few minutes.',
      details: { scope: scopeName, max, windowMs: DIRECT_MESSAGE_RATE_WINDOW_MS },
    });
  }

  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(this.mutationDeps(), scope, actor, permission, denial, error);
      throw error;
    }
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
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
