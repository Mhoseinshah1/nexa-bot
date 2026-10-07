import { createHash } from 'node:crypto';
import {
  AUDIENCE_ERROR_CODES,
  BROADCAST_BODY_DEFINITION,
  BROADCAST_CAPTION_MAX_LENGTH,
  BROADCAST_ERROR_CODES,
  BROADCAST_HISTORY_ACTIONS,
  BROADCAST_HISTORY_MAX,
  BROADCAST_LARGE_AUDIENCE,
  BROADCAST_STATES,
  BROADCAST_MEDIA_STAGED_MAX_BYTES,
  BROADCAST_TEXT_MAX_LENGTH,
  COMMERCE_ERROR_CODES,
  broadcastMediaRefusal,
  broadcastMediaType,
  errors,
  isSourcedBroadcastKind,
  placeholderTokensIn,
  validateTemplateBody,
  type ActorContext,
  type AudiencePreview,
  type AuditWriter,
  type BroadcastButton,
  type BroadcastContentKind,
  type BroadcastHistoryAction,
  type BroadcastPurpose,
  type BroadcastRecipientState,
  type BroadcastSource,
  type BroadcastState,
  type BroadcastTestResponse,
  type AuditResult,
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
import {
  excludesMarketingOptOuts,
  type MarketingOptOutPolicy,
} from './marketing-opt-out-policy.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  freezeAudience,
  toPreview,
  type AudienceService,
} from '../../audience/application/audience.service.js';
import type { FrozenAudienceRecord } from '../../audience/application/ports.js';
import {
  AUDIT_VIEW_PERMISSION,
  type AuditHistoryReader,
} from '../../../platform/audit/application/ports.js';
import type {
  BotDeliveryRow,
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
  /**
   * Broadcast V2: the same switch the dispatcher's stamp reads, used here ONLY for the
   * preview's opted-out estimate. It never narrows what is counted or materialised.
   */
  readonly marketingOptOut?: MarketingOptOutPolicy;
  /**
   * Roadmap C2: the broadcast's own audit rows, for its history card. Absent in a harness
   * that does not read history; `history` then answers an empty list.
   */
  readonly auditHistory?: AuditHistoryReader;
}

/** Roadmap C2: one row of a broadcast's history, with only the facts the contract names. */
export interface BroadcastHistoryRecord {
  readonly id: string;
  readonly action: BroadcastHistoryAction;
  readonly result: AuditResult;
  readonly actorLabel: string | null;
  readonly occurredAt: Date;
  readonly testOutcome: BroadcastTestResponse['outcome'] | null;
  readonly requeued: number | null;
  readonly fromState: BroadcastState | null;
  readonly toState: BroadcastState | null;
}

const TEST_OUTCOMES: readonly string[] = ['SENT', 'NOT_SENT', 'UNCONFIRMED', 'RATE_LIMITED'];
const isHistoryAction = (value: string): value is BroadcastHistoryAction =>
  (BROADCAST_HISTORY_ACTIONS as readonly string[]).includes(value);
const stateOf = (value: unknown): BroadcastState | null =>
  typeof value === 'string' && (BROADCAST_STATES as readonly string[]).includes(value)
    ? (value as BroadcastState)
    : null;

/**
 * Spec §9 (Codex review of #143): the promotional opt-out is decided at ONE point — the
 * dispatcher's stamp, in its own transaction, under the customer's lock, against the
 * `customer_marketing_opt_out` policy in force THEN. The preview and the launch therefore
 * count and materialise every member of the audience, opted out or not, so the confirmed
 * count is the audience the frozen-audience design already confirms (a frozen draft has
 * always counted an opted-out member and resolved it apart). A customer who has opted out
 * is written PENDING and resolved SKIPPED at the send while the policy honours the opt-out,
 * and SENT while it does not — so switching the policy between the launch and the send
 * changes the outcome both ways, and the stored preference is never touched.
 */
const MATERIALISE_OPTED_OUT = { excludeMarketingOptOuts: false } as const;

/** The composer's fields. */
export interface BroadcastContentInput {
  readonly title: string;
  readonly contentKind: BroadcastContentKind;
  readonly body: string;
  readonly buttons: readonly BroadcastButton[];
  /** Any audience definition; frozen to its canonical form here. */
  readonly audience: unknown;
  /** Round N close (§D); promotional unless said otherwise. */
  readonly purpose?: BroadcastPurpose;
  /** Round N close (§C); required for FORWARD and COPY, refused for the rest. */
  readonly source?: BroadcastSource | null;
  /** Round N close (§C); pin each delivered message once. */
  readonly pin?: boolean;
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
  // A FORWARD or COPY renders nothing: its body must be empty, which `checkedContent` holds.
  if (isSourcedBroadcastKind(kind)) return [];
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

  /**
   * Broadcast V2 (program §19): why recipients were not delivered, grouped by state and
   * reason. `broadcasts.view`, like the recipients it summarises.
   */
  async failureReasons(scope: TenantContext, actor: ActorContext, id: string) {
    await this.deps.guard.check(scope, actor, BROADCAST_VIEW);
    await this.require(scope, id);
    return this.deps.repository.failureReasons(scope, id);
  }

  /**
   * Roadmap C2: the delivery per bot — each recipient's frozen bot, its counts, the
   * recipients waiting for a retry, and the bot's 429 hold while in force. `broadcasts.view`.
   */
  async botDelivery(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<readonly BotDeliveryRow[]> {
    await this.deps.guard.check(scope, actor, BROADCAST_VIEW);
    await this.require(scope, id);
    return this.deps.repository.botDelivery(scope, id, this.deps.clock.now());
  }

  /**
   * Roadmap C2: what was done to this broadcast — its own `broadcast.*` audit rows, newest
   * first, reduced to the contract's closed facts; the raw `before`/`after` never leave.
   *
   * `broadcasts.view` reads the card. Who did what, and the attempts that were REFUSED, are
   * audit signals (PR #237 review N1, the reseller-history precedent), so without
   * `audit.view` the card carries the successful facts only and no operator identity.
   * At most `BROADCAST_HISTORY_MAX` rows; `truncated` says older ones exist (N4).
   */
  async history(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<{ readonly entries: readonly BroadcastHistoryRecord[]; readonly truncated: boolean }> {
    await this.deps.guard.check(scope, actor, BROADCAST_VIEW);
    await this.require(scope, id);
    if (this.deps.auditHistory === undefined) return { entries: [], truncated: false };
    const audited = await this.deps.guard.has(scope, actor, AUDIT_VIEW_PERMISSION);
    const rows = await this.deps.auditHistory.entityHistory(
      scope,
      { entityType: 'Broadcast', entityId: id, actionPrefix: 'broadcast.' },
      BROADCAST_HISTORY_MAX + 1,
    );
    const truncated = rows.length > BROADCAST_HISTORY_MAX;
    const entries: BroadcastHistoryRecord[] = [];
    for (const row of rows.slice(0, BROADCAST_HISTORY_MAX)) {
      if (!isHistoryAction(row.action)) continue;
      if (!audited && row.result !== 'SUCCESS') continue;
      const after = row.after ?? {};
      const before = row.before ?? {};
      const outcome = after['outcome'];
      const requeued = after['requeued'];
      entries.push({
        id: row.id,
        action: row.action,
        result: row.result,
        actorLabel: audited ? row.actorLabel : null,
        occurredAt: row.occurredAt,
        testOutcome:
          row.action === 'broadcast.test' &&
          typeof outcome === 'string' &&
          TEST_OUTCOMES.includes(outcome)
            ? (outcome as BroadcastTestResponse['outcome'])
            : null,
        requeued:
          row.action === 'broadcast.retry_failed' &&
          typeof requeued === 'number' &&
          Number.isInteger(requeued) &&
          requeued >= 0
            ? requeued
            : null,
        fromState: stateOf(before['state']),
        toState: stateOf(after['state']),
      });
    }
    return { entries, truncated };
  }

  // --- composing -----------------------------------------------------------------------

  async create(
    scope: TenantContext,
    actor: ActorContext,
    input: BroadcastContentInput & {
      readonly idempotencyKey: string;
      /** Round N close (§A): bind the draft to a frozen audience for its whole life. */
      readonly frozenAudienceId?: string | null;
    },
  ): Promise<BroadcastRecord> {
    const content = this.checkedContent(input);
    const denial = { action: 'broadcast.create', entityType: 'Broadcast', entityId: null };
    await this.authorize(scope, actor, denial);
    const frozenAudienceId = input.frozenAudienceId ?? null;
    const requestHash = hashRequest({
      title: content.title,
      contentKind: content.contentKind,
      body: content.body,
      buttons: content.buttons,
      audienceHash: content.audience.hash,
      purpose: content.purpose,
      source: content.source,
      pin: content.pin,
      frozenAudienceId,
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
        // A frozen audience is checked at creation and again at the launch: the draft is
        // bound to it, and the record it names must be this tenant's, of customers, held.
        if (frozenAudienceId !== null) {
          await this.frozenSource(scope, frozenAudienceId, content.audience.hash, tx);
        }
        await this.deps.repository.create(
          scope,
          {
            id,
            title: content.title,
            contentKind: content.contentKind,
            body: content.body,
            buttons: content.buttons,
            purpose: content.purpose,
            source: content.source,
            pin: content.pin,
            audienceJson: content.audience.json,
            audienceHash: content.audience.hash,
            frozenAudienceId,
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
              purpose: content.purpose,
              source: content.source,
              pin: content.pin,
              frozenAudienceId,
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
            purpose: content.purpose,
            source: content.source,
            pin: content.pin,
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
              purpose: content.purpose,
              source: content.source,
              pin: content.pin,
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
    if (record.frozenAudienceId !== null) {
      // A frozen draft's preview IS its frozen header: the launch copies those members.
      const frozen = await this.frozenSource(scope, record.frozenAudienceId, record.audienceHash);
      return {
        asOf: frozen.asOf.toISOString(),
        definition: frozen.definition,
        definitionHash: frozen.definitionHash,
        customers: frozen.count,
        // The reachable part is read from the rows held: a member with no bot recorded is
        // written UNREACHABLE by the launch, and the confirmation should say so first.
        reachable: frozen.reachable,
        fingerprint: frozen.fingerprint,
        sample: [],
      };
    }
    // Spec §9: every member is counted; the opt-out is decided at the send (see above), and
    // the launch materialises the same set, so the count confirmed is the count frozen.
    const options = MATERIALISE_OPTED_OUT;
    const result = await this.deps.audience.evaluate(
      scope,
      record.audienceDefinition,
      undefined,
      undefined,
      options,
    );
    const sample = await this.deps.audience.sampleOf(
      scope,
      record.audienceDefinition,
      result.asOf,
      options,
    );
    /*
     * Broadcast V2 (program §19): the estimate of who a MARKETING send would skip, shown
     * beside the count — only where the send would honour the opt-out NOW. The count itself is
     * unchanged: the stamp decides at the send.
     */
    const estimate = await excludesMarketingOptOuts(
      record.purpose,
      this.deps.marketingOptOut,
      scope,
    );
    return { ...toPreview(result, sample), optedOut: estimate ? (result.optedOut ?? 0) : null };
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
      source: record.source,
    });
    const isMedia = record.contentKind !== 'TEXT' && !isSourcedBroadcastKind(record.contentKind);
    const media = !isMedia
      ? null
      : await this.deps.repository.mediaSource(scope, id, target.botInstanceId);
    if (!rendered.ok || (isMedia && media === null)) {
      throw errors.validation(
        BROADCAST_ERROR_CODES.BODY_INVALID,
        'This broadcast cannot be sent as it stands.',
        { reason: rendered.ok ? 'broadcast.media_unavailable' : rendered.errorCode },
      );
    }
    // The FINAL authorization, before anything leaves: session live, the key held and the
    // scope still accepting work, decided in a committed transaction of its own — never with
    // the network call inside one. A stop or a revocation that lands after this point is
    // the same race any request has; one that landed before it sends nothing (Codex R2).
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      BROADCAST_SEND,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
      },
    );
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
    // Recording the result: authorised again inside its own transaction, as every write is.
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
        /*
         * Round N close (§C): the preview IS the source's validation. The Bot API offers no
         * way to read a message by id, so a `copyMessage`/`forwardMessage` that reached the
         * operator is the one proof the bot can reach the source; the launch requires it.
         * The stamp names the draft that was TESTED — version, kind and source as read
         * above — so an edit committed while the test was in flight is not verified by it;
         * and an edit of the source or the kind afterwards clears it (`updateDraft`).
         */
        if (
          result.outcome === 'SENT' &&
          isSourcedBroadcastKind(record.contentKind) &&
          record.state === 'DRAFT' &&
          record.source !== null
        ) {
          await this.deps.repository.markSourceVerified(
            scope,
            id,
            { version: record.version, contentKind: record.contentKind, source: record.source },
            this.deps.clock.now(),
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

    // Time-relative validation only AFTER the replay lookup: a committed scheduled launch
    // replayed once its lead time has shrunk below a minute is the same launch, and must be
    // answered with it rather than refused as `schedule_invalid` (Codex R3).
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
        if (isSourcedBroadcastKind(current.contentKind)) {
          if (current.source === null) {
            throw errors.preconditionFailed(
              BROADCAST_ERROR_CODES.SOURCE_REQUIRED,
              'Name the message this broadcast forwards or copies.',
            );
          }
          if (current.sourceVerifiedAt === null) {
            throw errors.preconditionFailed(
              BROADCAST_ERROR_CODES.SOURCE_UNVERIFIED,
              'Send yourself a test first: it proves the bot can reach the source message.',
            );
          }
        } else if (current.contentKind !== 'TEXT') {
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
        // Spec §9: the opt-out is the send's decision, never the launch's (see above).
        const { excludeMarketingOptOuts } = MATERIALISE_OPTED_OUT;
        /*
         * Round N close (§A): a draft bound to a frozen audience COPIES its members, and the
         * rows written must be the rows frozen (the header's count and fingerprint) as well as
         * what the operator confirmed. A live draft evaluates its definition now, as before.
         */
        const source =
          current.frozenAudienceId === null
            ? null
            : await this.frozenSource(scope, current.frozenAudienceId, current.audienceHash, tx);
        const frozen =
          source !== null
            ? await this.deps.repository.materialiseFromFrozen(
                scope,
                id,
                source.id,
                { excludeMarketingOptOuts, now },
                tx,
              )
            : await this.deps.repository.materialise(
                scope,
                id,
                {
                  tenantId: scope.tenantId as string,
                  definition: current.audienceDefinition,
                  asOf: now,
                  excludeMarketingOptOuts,
                },
                now,
                tx,
              );
        if (
          source !== null &&
          (frozen.count !== source.count || frozen.fingerprint !== source.fingerprint)
        ) {
          throw errors.conflict(
            AUDIENCE_ERROR_CODES.FROZEN_RELEASED,
            'The frozen audience no longer holds the members it was confirmed with.',
            { frozenAudienceId: source.id },
          );
        }
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
            asOf: source?.asOf ?? now,
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
    const source = input.source ?? null;
    if (isSourcedBroadcastKind(input.contentKind)) {
      if (source === null) {
        throw errors.validation(
          BROADCAST_ERROR_CODES.SOURCE_REQUIRED,
          'A forward or copy names the message it sends: its chat id and message id.',
        );
      }
      // Telegram sends the source as it is: no text of ours, and a forward takes no keyboard.
      if (
        input.body.trim().length > 0 ||
        (input.contentKind === 'FORWARD' && input.buttons.length > 0)
      ) {
        throw errors.validation(
          BROADCAST_ERROR_CODES.SOURCE_CONTENT_INVALID,
          'A forward or copy carries no text of its own, and a forward carries no buttons.',
        );
      }
    } else if (source !== null) {
      throw errors.validation(
        BROADCAST_ERROR_CODES.SOURCE_REQUIRED,
        'Only a forward or a copy names a source message.',
      );
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
      purpose: input.purpose ?? 'MARKETING',
      source,
      pin: input.pin ?? false,
    };
  }

  /** The frozen audience a draft names: this tenant's, of customers, held, by this definition. */
  private async frozenSource(
    scope: TenantContext,
    frozenAudienceId: string,
    audienceHash: string,
    tx?: TransactionScope,
  ): Promise<FrozenAudienceRecord> {
    const frozen = await this.deps.audience.frozen(scope, frozenAudienceId, tx);
    if (frozen === null) {
      throw errors.notFound(AUDIENCE_ERROR_CODES.FROZEN_NOT_FOUND, 'No such frozen audience.');
    }
    if (frozen.releasedAt !== null) {
      throw errors.conflict(
        AUDIENCE_ERROR_CODES.FROZEN_RELEASED,
        'This frozen audience was released; its members are no longer held.',
      );
    }
    if (frozen.kind !== 'CUSTOMERS') {
      throw errors.validation(
        AUDIENCE_ERROR_CODES.FROZEN_KIND_MISMATCH,
        'A broadcast is sent to a CUSTOMERS audience.',
        { kind: frozen.kind },
      );
    }
    if (frozen.definitionHash !== audienceHash) {
      throw errors.conflict(
        AUDIENCE_ERROR_CODES.CHANGED,
        'The frozen audience was not frozen by this broadcast’s definition.',
      );
    }
    return frozen;
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
