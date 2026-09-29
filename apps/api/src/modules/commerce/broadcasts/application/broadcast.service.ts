import { createHash } from 'node:crypto';
import {
  AUDIENCE_ERROR_CODES,
  BROADCAST_BODY_DEFINITION,
  BROADCAST_CAPTION_MAX_LENGTH,
  BROADCAST_ERROR_CODES,
  BROADCAST_LARGE_AUDIENCE,
  BROADCAST_MEDIA_STAGED_MAX_BYTES,
  BROADCAST_TEXT_MAX_LENGTH,
  COMMERCE_ERROR_CODES,
  broadcastMediaRefusal,
  broadcastMediaType,
  errors,
  placeholderTokensIn,
  validateTemplateBody,
  type ActorContext,
  type AudiencePreview,
  type AuditWriter,
  type BroadcastButton,
  type BroadcastContentKind,
  type BroadcastRecipientState,
  type BroadcastState,
  type BroadcastTestResponse,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
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
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  freezeAudience,
  toPreview,
  type AudienceService,
} from '../../audience/application/audience.service.js';
import type {
  BroadcastRecord,
  BroadcastRepository,
  BroadcastTransport,
  RecipientFactsReader,
  RecipientPageRow,
} from './ports.js';

export const BROADCAST_VIEW: PermissionKey = 'broadcasts.view';
export const BROADCAST_SEND: PermissionKey = 'broadcasts.send';

const NAMESPACE = 'WEB' as const;
/** A schedule at least this far ahead, so "schedule" is never a slower "now". */
const SCHEDULE_MIN_LEAD_MS = 60_000;
/** And no further ahead than this. */
const SCHEDULE_MAX_LEAD_MS = 60 * 86_400_000;

export interface BroadcastServiceDeps {
  readonly repository: BroadcastRepository;
  readonly audience: AudienceService;
  readonly transport: BroadcastTransport;
  readonly facts: RecipientFactsReader;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** The composer's fields. */
export interface BroadcastContentInput {
  readonly title: string;
  readonly contentKind: BroadcastContentKind;
  readonly body: string;
  readonly buttons: readonly BroadcastButton[];
  /** Any audience definition; frozen to its canonical form here. */
  readonly audience: unknown;
}

export interface LaunchBroadcastInput {
  readonly idempotencyKey: string;
  readonly mode: 'NOW' | 'SCHEDULE';
  readonly scheduledAt: Date | null;
  readonly expectedVersion: number;
  readonly expectedDefinitionHash: string;
  readonly expectedRecipients: number;
  readonly expectedFingerprint: string;
  readonly typedCount: number | null;
}

function adminIdOf(actor: ActorContext): string | null {
  return actor.type === 'WEB_ADMIN' || actor.type === 'TELEGRAM_ADMIN' ? actor.id : null;
}

/**
 * The raw body against the placeholder catalogue and its kind's bound — the same
 * `validateTemplateBody` every template is held to. A media broadcast may have no caption.
 */
export function broadcastBodyIssues(kind: BroadcastContentKind, body: string): readonly string[] {
  const max = kind === 'TEXT' ? BROADCAST_TEXT_MAX_LENGTH : BROADCAST_CAPTION_MAX_LENGTH;
  return validateTemplateBody({ ...BROADCAST_BODY_DEFINITION, maxLength: max }, body)
    .filter((issue) => !(kind !== 'TEXT' && issue.kind === 'EMPTY'))
    .map((issue) => (issue.token === undefined ? issue.kind : `${issue.kind}:${issue.token}`));
}

/**
 * Broadcast — «ارسال همگانی» (round N, B1) — as an operator drives it: compose, preview,
 * test on their own Telegram, confirm, and then pause, resume, cancel or re-queue refusals.
 *
 * Every write takes the operator's `ScopeContext` and `ActorContext`, checks
 * `broadcasts.send` through the guard, reads scope activity inside its transaction and is
 * idempotent (a key, or a conditional UPDATE). Nothing here sends to the audience: the
 * dispatcher does, from the rows the launch froze. The one send made here is the operator's
 * own test.
 */
export class BroadcastService {
  constructor(private readonly deps: BroadcastServiceDeps) {}

  // --- reads ---------------------------------------------------------------------------

  async get(scope: TenantContext, actor: ActorContext, id: string): Promise<BroadcastRecord> {
    await this.deps.guard.check(scope, actor, BROADCAST_VIEW);
    return this.require(scope, id);
  }

  async list(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly limit: number;
      readonly cursor: { readonly createdAt: Date; readonly id: string } | null;
    },
  ): Promise<readonly BroadcastRecord[]> {
    await this.deps.guard.check(scope, actor, BROADCAST_VIEW);
    return this.deps.repository.list(scope, input.limit, input.cursor);
  }

  /** Per-state recipient counts for the given broadcasts, for a list or a detail view. */
  async counts(scope: TenantContext, actor: ActorContext, ids: readonly string[]) {
    await this.deps.guard.check(scope, actor, BROADCAST_VIEW);
    return this.deps.repository.counts(scope, ids);
  }

  async recipients(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    input: {
      readonly state: BroadcastRecipientState | null;
      readonly limit: number;
      readonly after: string | null;
    },
  ): Promise<readonly RecipientPageRow[]> {
    await this.deps.guard.check(scope, actor, BROADCAST_VIEW);
    await this.require(scope, id);
    return this.deps.repository.recipients(scope, id, input);
  }

  // --- composing -----------------------------------------------------------------------

  async create(
    scope: TenantContext,
    actor: ActorContext,
    input: BroadcastContentInput & { readonly idempotencyKey: string },
  ): Promise<BroadcastRecord> {
    const content = this.checkedContent(input);
    const denial = { action: 'broadcast.create', entityType: 'Broadcast', entityId: null };
    await this.authorize(scope, actor, denial);
    const requestHash = hashRequest({
      title: content.title,
      contentKind: content.contentKind,
      body: content.body,
      buttons: content.buttons,
      audienceHash: content.audience.hash,
    });
    const replay = await this.deps.idempotency.find<{ broadcastId: string }>(
      scope,
      NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return this.require(scope, replay.result.broadcastId);

    const id = this.deps.ids.uuid();
    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      BROADCAST_SEND,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.deps.repository.create(
          scope,
          {
            id,
            title: content.title,
            contentKind: content.contentKind,
            body: content.body,
            buttons: content.buttons,
            audienceJson: content.audience.json,
            audienceHash: content.audience.hash,
            createdByAdminId: adminIdOf(actor),
            now,
          },
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'broadcast.create',
            entityType: 'Broadcast',
            entityId: id,
            before: null,
            after: {
              title: content.title,
              contentKind: content.contentKind,
              audienceHash: content.audience.hash,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          NAMESPACE,
          input.idempotencyKey,
          requestHash,
          { broadcastId: id },
          tx,
        );
      },
    );
    return this.require(scope, id);
  }

  /** A DRAFT's content, conditional on the version the editor loaded. */
  async update(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    input: BroadcastContentInput & { readonly expectedVersion: number },
  ): Promise<BroadcastRecord> {
    const content = this.checkedContent(input);
    const denial = { action: 'broadcast.update', entityType: 'Broadcast', entityId: id };
    await this.authorize(scope, actor, denial);
    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      BROADCAST_SEND,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const current = await this.deps.repository.lock(scope, id, tx);
        if (current === null) throw this.notFound();
        if (current.state !== 'DRAFT') throw this.stateConflict(current.state);
        const updated = await this.deps.repository.updateDraft(
          scope,
          id,
          input.expectedVersion,
          {
            title: content.title,
            contentKind: content.contentKind,
            body: content.body,
            buttons: content.buttons,
            audienceJson: content.audience.json,
            audienceHash: content.audience.hash,
            now,
          },
          tx,
        );
        if (!updated) throw this.versionConflict(current.version);
        // A media file of another kind than the draft now is cannot be sent with it.
        await this.deps.repository.dropMismatchedMedia(scope, id, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'broadcast.update',
            entityType: 'Broadcast',
            entityId: id,
            before: {
              title: current.title,
              contentKind: current.contentKind,
              audienceHash: current.audienceHash,
              version: current.version,
            },
            after: {
              title: content.title,
              contentKind: content.contentKind,
              audienceHash: content.audience.hash,
              version: current.version + 1,
            },
            result: 'SUCCESS',
          },
          tx,
        );
      },
    );
    return this.require(scope, id);
  }

  /**
   * The draft's media, verified by type, extension and signature, bounded per type and per
   * tenant. Replacing a file is the same call; the effect is the same state however often it
   * is repeated.
   */
  async setMedia(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    input: { readonly mimeType: string; readonly fileName: string; readonly contentBase64: string },
  ): Promise<BroadcastRecord> {
    const bytes = new Uint8Array(Buffer.from(input.contentBase64, 'base64'));
    const refusal = broadcastMediaRefusal({
      mimeType: input.mimeType,
      fileName: input.fileName,
      bytes,
    });
    const type = broadcastMediaType(input.mimeType);
    if (refusal !== null || type === undefined) {
      throw errors.validation(BROADCAST_ERROR_CODES.MEDIA_REFUSED, 'That file cannot be sent.', {
        refusal: refusal ?? 'TYPE_NOT_ALLOWED',
      });
    }
    const denial = { action: 'broadcast.media_set', entityType: 'Broadcast', entityId: id };
    await this.authorize(scope, actor, denial);
    const now = this.deps.clock.now();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      BROADCAST_SEND,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const current = await this.deps.repository.lock(scope, id, tx);
        if (current === null) throw this.notFound();
        if (current.state !== 'DRAFT') throw this.stateConflict(current.state);
        if (current.contentKind !== type.kind) {
          throw errors.validation(
            BROADCAST_ERROR_CODES.MEDIA_REFUSED,
            'That file is not the kind this broadcast sends.',
            { refusal: 'KIND_MISMATCH', expected: current.contentKind, received: type.kind },
          );
        }
        await this.deps.repository.lockStaging(scope, tx);
        const held = await this.deps.repository.stagedBytes(scope, id, tx);
        if (held + bytes.length > BROADCAST_MEDIA_STAGED_MAX_BYTES) {
          throw errors.conflict(
            BROADCAST_ERROR_CODES.MEDIA_STORAGE_FULL,
            'Too many broadcast files are waiting to be sent.',
          );
        }
        await this.deps.repository.putMedia(
          scope,
          id,
          {
            kind: type.kind,
            mimeType: type.mimeType,
            fileName: input.fileName,
            bytes,
            sha256,
            now,
          },
          tx,
        );
        await this.deps.repository.bumpVersion(scope, id, now, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'broadcast.media_set',
            entityType: 'Broadcast',
            entityId: id,
            before: null,
            after: { mimeType: type.mimeType, byteLength: bytes.length, sha256 },
            result: 'SUCCESS',
          },
          tx,
        );
      },
    );
    return this.require(scope, id);
  }

  async removeMedia(scope: TenantContext, actor: ActorContext, id: string) {
    const denial = { action: 'broadcast.media_remove', entityType: 'Broadcast', entityId: id };
    await this.authorize(scope, actor, denial);
    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      BROADCAST_SEND,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const current = await this.deps.repository.lock(scope, id, tx);
        if (current === null) throw this.notFound();
        if (current.state !== 'DRAFT') throw this.stateConflict(current.state);
        if (await this.deps.repository.removeMedia(scope, id, tx)) {
          await this.deps.repository.bumpVersion(scope, id, now, tx);
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'broadcast.media_remove',
              entityType: 'Broadcast',
              entityId: id,
              before: null,
              after: null,
              result: 'SUCCESS',
            },
            tx,
          );
        }
      },
    );
    return this.require(scope, id);
  }

  // --- previewing ----------------------------------------------------------------------

  /**
   * ADR-0010's counted preview of the DRAFT's own frozen definition: the count, the
   * reachable part, the set's fingerprint and a sample. What the launch confirmation must
   * send back.
   */
  async preview(scope: TenantContext, actor: ActorContext, id: string): Promise<AudiencePreview> {
    await this.deps.guard.check(scope, actor, BROADCAST_SEND);
    const record = await this.require(scope, id);
    const result = await this.deps.audience.evaluate(scope, record.audienceDefinition);
    const sample = await this.deps.audience.sampleOf(scope, record.audienceDefinition, result.asOf);
    return toPreview(result, sample);
  }

  /**
   * The real preview: the broadcast, rendered for the OPERATOR and sent to their own linked
   * Telegram through the bot they wrote to — the same render, template and transport the
   * dispatcher uses. Never counted in the report and never touching a recipient row.
   */
  async test(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<BroadcastTestResponse['outcome']> {
    const denial = { action: 'broadcast.test', entityType: 'Broadcast', entityId: id };
    await this.authorize(scope, actor, denial);
    const record = await this.require(scope, id);
    const adminId = adminIdOf(actor);
    const target =
      adminId === null ? null : await this.deps.repository.testTargetFor(scope, adminId);
    if (target === null) {
      throw errors.preconditionFailed(
        BROADCAST_ERROR_CODES.TEST_TARGET_UNAVAILABLE,
        'Link your Telegram account and start the bot once to receive a test.',
      );
    }
    const facts = await this.deps.facts.factsFor(scope, target.customerId, {
      withBalance: placeholderTokensIn(record.body).includes('walletBalance'),
    });
    const rendered = await this.deps.transport.render(scope, {
      contentKind: record.contentKind,
      body: record.body,
      facts,
      buttons: record.buttons,
    });
    const media =
      record.contentKind === 'TEXT'
        ? null
        : await this.deps.repository.mediaSource(scope, id, target.botInstanceId);
    if (!rendered.ok || (record.contentKind !== 'TEXT' && media === null)) {
      throw errors.validation(
        BROADCAST_ERROR_CODES.BODY_INVALID,
        'This broadcast cannot be sent as it stands.',
        { reason: rendered.ok ? 'broadcast.media_unavailable' : rendered.errorCode },
      );
    }
    const result = await this.deps.transport.deliver(scope, {
      chatId: target.chatId,
      botInstanceId: target.botInstanceId,
      rendered: rendered.rendered,
      media,
    });
    const outcome: BroadcastTestResponse['outcome'] =
      result.outcome === 'SENT'
        ? 'SENT'
        : result.outcome === 'RATE_LIMITED'
          ? 'RATE_LIMITED'
          : result.outcome === 'UNKNOWN'
            ? 'UNCONFIRMED'
            : 'NOT_SENT';
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      BROADCAST_SEND,
      denial,
      async (tx) => {
        if (result.outcome === 'SENT' && media?.kind === 'BYTES' && result.fileId !== undefined) {
          await this.deps.repository.rememberHandle(
            scope,
            id,
            target.botInstanceId,
            result.fileId,
            tx,
          );
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'broadcast.test',
            entityType: 'Broadcast',
            entityId: id,
            before: null,
            after: { outcome },
            result: 'SUCCESS',
          },
          tx,
        );
      },
    );
    return outcome;
  }

  // --- launching and steering ----------------------------------------------------------

  /**
   * The confirmation. In ONE transaction: the draft is locked at the version the operator
   * saw, its recipients are materialised from its frozen definition, and the frozen set is
   * compared with what was previewed — count AND fingerprint. Any difference rolls
   * everything back as `audience.changed`, so a preview can only authorise the send it
   * described. The recipients are frozen here whether sending starts now or at the schedule.
   */
  async launch(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    input: LaunchBroadcastInput,
  ): Promise<BroadcastRecord> {
    const denial = { action: 'broadcast.launch', entityType: 'Broadcast', entityId: id };
    await this.authorize(scope, actor, denial);
    const now = this.deps.clock.now();
    if (input.mode === 'SCHEDULE') {
      const at = input.scheduledAt?.getTime() ?? 0;
      if (at < now.getTime() + SCHEDULE_MIN_LEAD_MS || at > now.getTime() + SCHEDULE_MAX_LEAD_MS) {
        throw errors.validation(
          BROADCAST_ERROR_CODES.SCHEDULE_INVALID,
          'Schedule a broadcast at least a minute and at most sixty days ahead.',
        );
      }
    }
    if (
      input.expectedRecipients >= BROADCAST_LARGE_AUDIENCE &&
      input.typedCount !== input.expectedRecipients
    ) {
      throw this.confirmationRequired(input.expectedRecipients);
    }
    const requestHash = hashRequest({
      id,
      mode: input.mode,
      scheduledAt: input.scheduledAt?.toISOString() ?? null,
      expectedVersion: input.expectedVersion,
      expectedDefinitionHash: input.expectedDefinitionHash,
      expectedRecipients: input.expectedRecipients,
      expectedFingerprint: input.expectedFingerprint,
      typedCount: input.typedCount,
    });
    const replay = await this.deps.idempotency.find<{ broadcastId: string }>(
      scope,
      NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return this.require(scope, replay.result.broadcastId);

    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      BROADCAST_SEND,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const current = await this.deps.repository.lock(scope, id, tx);
        if (current === null) throw this.notFound();
        if (current.state !== 'DRAFT') throw this.stateConflict(current.state);
        if (current.version !== input.expectedVersion) throw this.versionConflict(current.version);
        if (current.audienceHash !== input.expectedDefinitionHash) {
          throw this.versionConflict(current.version);
        }
        const issues = broadcastBodyIssues(current.contentKind, current.body);
        if (issues.length > 0) {
          throw errors.validation(BROADCAST_ERROR_CODES.BODY_INVALID, 'The message is not valid.', {
            issues,
          });
        }
        if (current.contentKind !== 'TEXT') {
          if (current.media === null) {
            throw errors.preconditionFailed(
              BROADCAST_ERROR_CODES.MEDIA_REQUIRED,
              'Attach the file this broadcast sends.',
            );
          }
          if (!current.media.available) {
            throw errors.preconditionFailed(
              BROADCAST_ERROR_CODES.MEDIA_EXPIRED,
              'The attached file was cleared; upload it again.',
            );
          }
        }
        const frozen = await this.deps.repository.materialise(
          scope,
          id,
          { tenantId: scope.tenantId as string, definition: current.audienceDefinition, asOf: now },
          now,
          tx,
        );
        if (frozen.count === 0) {
          throw errors.preconditionFailed(
            AUDIENCE_ERROR_CODES.EMPTY,
            'This audience selects nobody.',
          );
        }
        if (
          frozen.count !== input.expectedRecipients ||
          frozen.fingerprint !== input.expectedFingerprint
        ) {
          // Thrown INSIDE the transaction: the materialised rows roll back with it.
          throw errors.conflict(
            AUDIENCE_ERROR_CODES.CHANGED,
            `The preview showed ${String(input.expectedRecipients)} recipients and the audience is ${String(
              frozen.count,
            )} now. Nothing was sent; preview again.`,
            { expected: input.expectedRecipients, current: frozen.count },
          );
        }
        if (frozen.count >= BROADCAST_LARGE_AUDIENCE && input.typedCount !== frozen.count) {
          throw this.confirmationRequired(frozen.count);
        }
        const to = input.mode === 'NOW' ? 'SENDING' : 'SCHEDULED';
        const launched = await this.deps.repository.markLaunched(
          scope,
          id,
          {
            to,
            scheduledAt: input.mode === 'NOW' ? null : input.scheduledAt,
            asOf: now,
            count: frozen.count,
            fingerprint: frozen.fingerprint,
            launchedByAdminId: adminIdOf(actor),
            now,
          },
          tx,
        );
        if (!launched) throw this.stateConflict(current.state);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'broadcast.launch',
            entityType: 'Broadcast',
            entityId: id,
            before: { state: 'DRAFT', version: current.version },
            after: {
              state: to,
              scheduledAt: input.scheduledAt?.toISOString() ?? null,
              recipients: frozen.count,
              audienceHash: current.audienceHash,
              fingerprint: frozen.fingerprint,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'BroadcastStateChanged',
          aggregateType: 'Broadcast',
          aggregateId: id,
          payload: { broadcastId: id, from: 'DRAFT', to, recipients: frozen.count },
        });
        await rememberOnce(
          this.deps.idempotency,
          scope,
          NAMESPACE,
          input.idempotencyKey,
          requestHash,
          { broadcastId: id },
          tx,
        );
      },
    );
    return this.require(scope, id);
  }

  /** SENDING → PAUSED. Sends already stamped finish; nothing new is claimed. */
  async pause(scope: TenantContext, actor: ActorContext, id: string): Promise<BroadcastRecord> {
    return this.steer(scope, actor, id, 'broadcast.pause', ['SENDING'], 'PAUSED', 'PAUSED');
  }

  /** PAUSED → SENDING, for an operator's pause and for a bot that became usable again. */
  async resume(scope: TenantContext, actor: ActorContext, id: string): Promise<BroadcastRecord> {
    return this.steer(scope, actor, id, 'broadcast.resume', ['PAUSED'], 'SENDING', 'SENDING');
  }

  /**
   * Stops for good: every recipient not yet attempted becomes CANCELLED in the same
   * transaction. A message already delivered is NOT recalled and the report keeps saying it
   * was delivered; cancelling a broadcast never touches money either.
   */
  async cancel(scope: TenantContext, actor: ActorContext, id: string): Promise<BroadcastRecord> {
    return this.steer(
      scope,
      actor,
      id,
      'broadcast.cancel',
      ['SCHEDULED', 'SENDING', 'PAUSED'],
      'CANCELLED',
      'CANCELLED',
      async (tx, now) => {
        await this.deps.repository.cancelPending(scope, id, now, tx);
      },
    );
  }

  /**
   * Re-queues the recipients Telegram REFUSED (`FAILED`) — never an UNCONFIRMED one, which may
   * have arrived, and never an UNREACHABLE one. A COMPLETED broadcast re-opens to send them.
   */
  async retryFailed(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<BroadcastRecord> {
    const denial = { action: 'broadcast.retry_failed', entityType: 'Broadcast', entityId: id };
    await this.authorize(scope, actor, denial);
    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      BROADCAST_SEND,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const current = await this.deps.repository.lock(scope, id, tx);
        if (current === null) throw this.notFound();
        if (!['SENDING', 'PAUSED', 'COMPLETED'].includes(current.state)) {
          throw this.stateConflict(current.state);
        }
        const requeued = await this.deps.repository.requeueFailed(scope, id, now, tx);
        if (requeued === 0) return;
        if (current.state === 'COMPLETED') {
          await this.deps.repository.transition(scope, id, ['COMPLETED'], 'SENDING', { now }, tx);
          await this.deps.outbox.write(tx, actor, {
            eventType: 'BroadcastStateChanged',
            aggregateType: 'Broadcast',
            aggregateId: id,
            payload: { broadcastId: id, from: 'COMPLETED', to: 'SENDING', recipients: null },
          });
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'broadcast.retry_failed',
            entityType: 'Broadcast',
            entityId: id,
            before: { state: current.state },
            after: { requeued },
            result: 'SUCCESS',
          },
          tx,
        );
      },
    );
    return this.require(scope, id);
  }

  // --- helpers -------------------------------------------------------------------------

  private async steer(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    action: string,
    from: readonly BroadcastState[],
    to: BroadcastState,
    already: BroadcastState,
    alongside?: (tx: TransactionScope, now: Date) => Promise<void>,
  ): Promise<BroadcastRecord> {
    const denial = { action, entityType: 'Broadcast', entityId: id };
    await this.authorize(scope, actor, denial);
    const now = this.deps.clock.now();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      BROADCAST_SEND,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const current = await this.deps.repository.lock(scope, id, tx);
        if (current === null) throw this.notFound();
        // Already where it was asked to go: a repeated click is answered, not refused.
        if (current.state === already) return;
        const moved = await this.deps.repository.transition(
          scope,
          id,
          from,
          to,
          { now, ...(to === 'PAUSED' ? { pauseReason: 'OPERATOR' as const } : {}) },
          tx,
        );
        if (!moved) throw this.stateConflict(current.state);
        if (alongside !== undefined) await alongside(tx, now);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: 'Broadcast',
            entityId: id,
            before: { state: current.state },
            after: { state: to },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'BroadcastStateChanged',
          aggregateType: 'Broadcast',
          aggregateId: id,
          payload: { broadcastId: id, from: current.state, to, recipients: current.recipientCount },
        });
      },
    );
    return this.require(scope, id);
  }

  private checkedContent(input: BroadcastContentInput) {
    const issues = broadcastBodyIssues(input.contentKind, input.body);
    if (issues.length > 0) {
      throw errors.validation(BROADCAST_ERROR_CODES.BODY_INVALID, 'The message is not valid.', {
        issues,
      });
    }
    return {
      title: input.title.trim(),
      contentKind: input.contentKind,
      body: input.body,
      buttons: input.buttons.map((button) => ({
        label: button.label.trim(),
        url: button.url.trim(),
      })),
      audience: freezeAudience(input.audience),
    };
  }

  private async require(scope: TenantContext, id: string): Promise<BroadcastRecord> {
    const record = await this.deps.repository.find(scope, id);
    if (record === null) throw this.notFound();
    return record;
  }

  private notFound() {
    return errors.notFound(BROADCAST_ERROR_CODES.NOT_FOUND, 'No such broadcast.');
  }

  private stateConflict(state: BroadcastState) {
    return errors.conflict(
      BROADCAST_ERROR_CODES.STATE_CONFLICT,
      'That is not possible for this broadcast now.',
      { state },
    );
  }

  private versionConflict(version: number) {
    return errors.conflict(
      BROADCAST_ERROR_CODES.VERSION_CONFLICT,
      'This broadcast changed since it was opened; reload it.',
      { version },
    );
  }

  private confirmationRequired(count: number) {
    return errors.validation(
      BROADCAST_ERROR_CODES.CONFIRMATION_REQUIRED,
      `Type the number of recipients (${String(count)}) to confirm a send this large.`,
      { recipients: count },
    );
  }

  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, BROADCAST_SEND);
    } catch (error) {
      await recordMutationDenial(this.mutationDeps(), scope, actor, BROADCAST_SEND, denial, error);
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
