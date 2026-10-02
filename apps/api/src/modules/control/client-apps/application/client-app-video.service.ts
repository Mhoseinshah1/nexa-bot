import {
  CLIENT_APP_VIDEO_CAPTURE_TTL_MS,
  CLIENT_APP_VIDEO_FILE_ID_MAX_LENGTH,
  CLIENT_APP_VIDEO_FILE_UNIQUE_ID_MAX_LENGTH,
  COMMERCE_ERROR_CODES,
  CONTROL_ERROR_CODES,
  errors,
  type ActorContext,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { AdminAmountCaptureRepository } from '../../../commerce/payments/application/admin-amount-capture-ports.js';
import { CLIENT_APP_EDIT_PERMISSION, CLIENT_APP_VIEW_PERMISSION } from './client-app.service.js';
import type { ClientAppRecord, ClientAppRepository } from './ports.js';

/**
 * Spec §7: one app's tutorial video for one bot — Telegram's reference to it, never bytes.
 * `fileId` is what `sendVideo` takes and is valid only for `botInstanceId`.
 */
export interface ClientAppVideoRecord {
  readonly id: string;
  readonly clientAppId: string;
  readonly botInstanceId: BotInstanceId;
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly mimeType: string | null;
  readonly durationSeconds: number | null;
  readonly fileSize: bigint | null;
  readonly setByAdminId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A video message as the Telegram surface read it from the update. */
export interface InboundTutorialVideo {
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly mimeType: string | null;
  readonly durationSeconds: number | null;
  readonly fileSize: bigint | null;
}

export interface ClientAppVideoRepository {
  find(
    scope: TenantContext,
    clientAppId: string,
    botInstanceId: BotInstanceId,
    tx?: unknown,
  ): Promise<ClientAppVideoRecord | null>;
  /** The app ids that have a video for this bot. */
  appsWithVideo(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    tx?: unknown,
  ): Promise<ReadonlySet<string>>;
  /** Inserts, or replaces the (app, bot) row's reference with `version + 1`. */
  upsert(
    scope: TenantContext,
    draft: InboundTutorialVideo & {
      readonly id: string;
      readonly clientAppId: string;
      readonly botInstanceId: BotInstanceId;
      readonly setByAdminId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<ClientAppVideoRecord>;
  /** The removed row, or null when there was none. */
  remove(
    scope: TenantContext,
    clientAppId: string,
    botInstanceId: BotInstanceId,
    tx: unknown,
  ): Promise<ClientAppVideoRecord | null>;
}

export interface ClientAppVideoServiceDeps {
  readonly videos: ClientAppVideoRepository;
  readonly apps: Pick<ClientAppRepository, 'find' | 'list'>;
  /**
   * The administrator prompt table (`admin_amount_captures`, purpose `CLIENT_APP_VIDEO`):
   * the same table every other Telegram admin prompt uses, so the database's one-open-prompt
   * index covers this one too, and opening it supersedes whatever was open before.
   */
  readonly captures: Pick<
    AdminAmountCaptureRepository,
    'lockForAdmin' | 'open' | 'findOpenVideo' | 'findById' | 'close'
  >;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/** What a video message did. */
export type TutorialVideoReceipt =
  | { readonly outcome: 'STORED'; readonly app: ClientAppRecord; readonly replaced: boolean }
  /** No open prompt — never opened, cancelled, superseded, or older than the message. */
  | { readonly outcome: 'NO_PROMPT' }
  /** The prompt's deadline passed; it is closed EXPIRED now and nothing is stored. */
  | { readonly outcome: 'EXPIRED' };

/** The remembered result of a video message, so a redelivered update answers the same. */
interface ReceiptMemory {
  readonly outcome: TutorialVideoReceipt['outcome'];
  readonly appId: string | null;
  readonly replaced: boolean;
}

/**
 * Spec §7 — «تنظیم ویدیو»: an administrator sets, replaces or deletes a client app's tutorial
 * video from the Telegram management panel (`docs/package-h-tutorials-marketing-stars.md`).
 *
 * The wizard is a ROW, not memory: `beginCapture` opens a `CLIENT_APP_VIDEO` prompt naming
 * ONE administrator, ONE bot and ONE app, with a deadline and the `update_id` of the tap. A
 * video message is offered to it only by `receiveVideo`, which reads the prompt under the
 * administrator's advisory lock and stores the video only when the prompt is open, unexpired
 * and older than the message. So a stale state is safe by construction: an expired prompt is
 * closed EXPIRED and stores nothing; a cancelled or superseded one is not found; a video sent
 * before the tap, or by somebody else, or to another bot, matches no prompt.
 *
 * Every write charges `client_apps.edit` inside its transaction (`runAuthorizedMutation`),
 * checks scope activity, takes the update's idempotency key in the actor's surface namespace,
 * and is audited with before/after VALUES — the reference's stable id, never the bot-scoped
 * `file_id`. Reads charge `client_apps.view`. The customer's read, `videoFor`, charges nothing,
 * like `ClientAppCatalog`.
 */
export class ClientAppVideoService {
  constructor(private readonly deps: ClientAppVideoServiceDeps) {}

  /** The apps, in the customer's order, each with whether THIS bot holds its video. */
  async listForAdmin(
    scope: TenantContext,
    actor: ActorContext,
    botInstanceId: BotInstanceId,
  ): Promise<readonly { readonly app: ClientAppRecord; readonly hasVideo: boolean }[]> {
    await this.deps.guard.check(scope, actor, CLIENT_APP_VIEW_PERMISSION);
    const [apps, withVideo] = await Promise.all([
      this.deps.apps.list(scope),
      this.deps.videos.appsWithVideo(scope, botInstanceId),
    ]);
    return apps.map((app) => ({ app, hasVideo: withVideo.has(app.id) }));
  }

  /** One app and its video for this bot, or null when the app does not exist. */
  async detailForAdmin(
    scope: TenantContext,
    actor: ActorContext,
    appId: string,
    botInstanceId: BotInstanceId,
  ): Promise<{
    readonly app: ClientAppRecord;
    readonly video: ClientAppVideoRecord | null;
  } | null> {
    await this.deps.guard.check(scope, actor, CLIENT_APP_VIEW_PERMISSION);
    if (!UUID_SHAPE.test(appId)) return null;
    const app = await this.deps.apps.find(scope, appId);
    if (app === null) return null;
    return { app, video: await this.deps.videos.find(scope, appId, botInstanceId) };
  }

  /** The customer's read: the reference THIS bot can send, for an ENABLED app only. */
  async videoFor(
    scope: TenantContext,
    appId: string,
    botInstanceId: BotInstanceId,
  ): Promise<ClientAppVideoRecord | null> {
    if (!UUID_SHAPE.test(appId)) return null;
    const app = await this.deps.apps.find(scope, appId);
    if (app === null || app.status !== 'ENABLED') return null;
    return this.deps.videos.find(scope, appId, botInstanceId);
  }

  /**
   * «تنظیم ویدیو»: opens the bounded prompt. Supersedes whatever prompt this administrator
   * had open on this bot. Nothing about the app changes, so nothing is audited here — the
   * stored video is.
   */
  async beginCapture(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly appId: string;
      readonly botInstanceId: BotInstanceId;
      readonly adminId: string;
      readonly openedUpdateId: bigint | null;
    },
  ): Promise<{ readonly app: ClientAppRecord; readonly captureId: string }> {
    const denial = { action: 'client_app.video_prompt', entityType: 'ClientApp', entityId: null };
    await this.deps.guard.check(scope, actor, CLIENT_APP_EDIT_PERMISSION);
    const requestHash = hashRequest({
      appId: input.appId,
      botInstanceId: input.botInstanceId,
      adminId: input.adminId,
      prompt: true,
    });
    const found = await this.deps.idempotency.find<{ captureId: string; appId: string }>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (found !== null) {
      const app = await this.deps.apps.find(scope, found.result.appId);
      if (app !== null) return { app, captureId: found.result.captureId };
    }
    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CLIENT_APP_EDIT_PERMISSION,
      { ...denial, entityId: UUID_SHAPE.test(input.appId) ? input.appId : null },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const app = await this.requireApp(scope, input.appId, tx);
        await this.deps.captures.lockForAdmin(scope, input.botInstanceId, input.adminId, tx);
        const capture = await this.deps.captures.open(
          scope,
          {
            id: this.deps.ids.uuid(),
            botInstanceId: input.botInstanceId,
            adminId: input.adminId,
            clientAppId: app.id,
            purpose: 'CLIENT_APP_VIDEO',
            openedAt: now,
            expiresAt: new Date(now.getTime() + CLIENT_APP_VIDEO_CAPTURE_TTL_MS),
            ...(input.openedUpdateId === null ? {} : { openedUpdateId: input.openedUpdateId }),
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          { captureId: capture.id, appId: app.id },
          tx,
        );
        return { app, captureId: capture.id };
      },
    );
  }

  /**
   * Cancels THIS administrator's open video prompt on this bot. False when none was open —
   * already cancelled, expired, superseded or used: the stale button answers, nothing else.
   */
  async cancelCapture(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly botInstanceId: BotInstanceId; readonly adminId: string },
  ): Promise<boolean> {
    await this.deps.guard.check(scope, actor, CLIENT_APP_EDIT_PERMISSION);
    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CLIENT_APP_EDIT_PERMISSION,
      { action: 'client_app.video_prompt_cancel', entityType: 'ClientApp', entityId: null },
      async (tx) => {
        await this.deps.captures.lockForAdmin(scope, input.botInstanceId, input.adminId, tx);
        const open = await this.deps.captures.findOpenVideo(
          scope,
          input.botInstanceId,
          input.adminId,
          tx,
        );
        if (open === null) return false;
        return this.deps.captures.close(scope, open.id, 'CANCELLED', now, tx);
      },
    );
  }

  /**
   * A video message from an administrator. Stored as the prompted app's tutorial for THIS bot
   * only when this administrator's prompt on this bot is open, unexpired, and older than the
   * message; otherwise nothing is stored and the outcome says why.
   */
  async receiveVideo(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly adminId: string;
      readonly updateId: bigint | null;
      readonly video: InboundTutorialVideo;
    },
  ): Promise<TutorialVideoReceipt> {
    await this.deps.guard.check(scope, actor, CLIENT_APP_EDIT_PERMISSION);
    const video = parseVideo(input.video);
    const requestHash = hashRequest({
      botInstanceId: input.botInstanceId,
      adminId: input.adminId,
      fileUniqueId: video.fileUniqueId,
    });
    const found = await this.deps.idempotency.find<ReceiptMemory>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (found !== null) {
      const remembered = found.result;
      if (remembered.outcome !== 'STORED') return { outcome: remembered.outcome };
      const app =
        remembered.appId === null ? null : await this.deps.apps.find(scope, remembered.appId);
      if (app !== null) return { outcome: 'STORED', app, replaced: remembered.replaced };
    }
    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CLIENT_APP_EDIT_PERMISSION,
      { action: 'client_app.video_set', entityType: 'ClientApp', entityId: null },
      async (tx): Promise<TutorialVideoReceipt> => {
        await this.assertScopeActive(scope, tx);
        await this.deps.captures.lockForAdmin(scope, input.botInstanceId, input.adminId, tx);
        const prompt = await this.deps.captures.findOpenVideo(
          scope,
          input.botInstanceId,
          input.adminId,
          tx,
        );
        const answer = async (receipt: TutorialVideoReceipt) => {
          await rememberOnce(
            this.deps.idempotency,
            scope,
            actor.surface,
            input.idempotencyKey,
            requestHash,
            {
              outcome: receipt.outcome,
              appId: receipt.outcome === 'STORED' ? receipt.app.id : null,
              replaced: receipt.outcome === 'STORED' && receipt.replaced,
            } satisfies ReceiptMemory,
            tx,
          );
          return receipt;
        };
        // A message that is not newer than the tap belongs to no prompt (WP19's rule).
        if (
          prompt === null ||
          prompt.clientAppId === null ||
          (prompt.openedUpdateId !== null &&
            (input.updateId === null || input.updateId <= prompt.openedUpdateId))
        ) {
          return answer({ outcome: 'NO_PROMPT' });
        }
        if (prompt.expiresAt.getTime() <= now.getTime()) {
          await this.deps.captures.close(scope, prompt.id, 'EXPIRED', now, tx);
          return answer({ outcome: 'EXPIRED' });
        }
        const app = await this.deps.apps.find(scope, prompt.clientAppId, tx);
        if (app === null) {
          await this.deps.captures.close(scope, prompt.id, 'SUPERSEDED', now, tx);
          return answer({ outcome: 'NO_PROMPT' });
        }
        const before = await this.deps.videos.find(scope, app.id, input.botInstanceId, tx);
        const after = await this.deps.videos.upsert(
          scope,
          {
            ...video,
            id: this.deps.ids.uuid(),
            clientAppId: app.id,
            botInstanceId: input.botInstanceId,
            setByAdminId: input.adminId,
            now,
          },
          tx,
        );
        await this.deps.captures.close(scope, prompt.id, 'CONFIRMED', now, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'client_app.video_set',
            entityType: 'ClientApp',
            entityId: app.id,
            before: before === null ? null : videoAuditView(before),
            after: videoAuditView(after),
            result: 'SUCCESS',
          },
          tx,
        );
        return answer({ outcome: 'STORED', app, replaced: before !== null });
      },
    );
  }

  /**
   * Deletes this app's tutorial video for this bot. False when there was none — a second tap
   * of the confirm button — and then nothing is audited: a write that changed nothing does not
   * report one.
   */
  async remove(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly appId: string;
      readonly botInstanceId: BotInstanceId;
    },
  ): Promise<{ readonly app: ClientAppRecord; readonly removed: boolean }> {
    await this.deps.guard.check(scope, actor, CLIENT_APP_EDIT_PERMISSION);
    const requestHash = hashRequest({
      appId: input.appId,
      botInstanceId: input.botInstanceId,
      delete: true,
    });
    const found = await this.deps.idempotency.find<{ appId: string; removed: boolean }>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (found !== null) {
      const app = await this.deps.apps.find(scope, found.result.appId);
      if (app !== null) return { app, removed: found.result.removed };
    }
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CLIENT_APP_EDIT_PERMISSION,
      {
        action: 'client_app.video_delete',
        entityType: 'ClientApp',
        entityId: UUID_SHAPE.test(input.appId) ? input.appId : null,
      },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const app = await this.requireApp(scope, input.appId, tx);
        const removed = await this.deps.videos.remove(scope, app.id, input.botInstanceId, tx);
        if (removed !== null) {
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'client_app.video_delete',
              entityType: 'ClientApp',
              entityId: app.id,
              before: videoAuditView(removed),
              after: null,
              result: 'SUCCESS',
            },
            tx,
          );
        }
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          { appId: app.id, removed: removed !== null },
          tx,
        );
        return { app, removed: removed !== null };
      },
    );
  }

  // -------------------------------------------------------------------------------------

  private async requireApp(
    scope: TenantContext,
    appId: string,
    tx: TransactionScope,
  ): Promise<ClientAppRecord> {
    const app = UUID_SHAPE.test(appId) ? await this.deps.apps.find(scope, appId, tx) : null;
    if (app === null) {
      throw errors.notFound(CONTROL_ERROR_CODES.CLIENT_APP_NOT_FOUND, 'Unknown client app.');
    }
    return app;
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

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The identifiers within the bounds the table holds; anything else is not Telegram's. */
function parseVideo(video: InboundTutorialVideo): InboundTutorialVideo {
  const ok =
    video.fileId.length >= 1 &&
    video.fileId.length <= CLIENT_APP_VIDEO_FILE_ID_MAX_LENGTH &&
    video.fileUniqueId.length >= 1 &&
    video.fileUniqueId.length <= CLIENT_APP_VIDEO_FILE_UNIQUE_ID_MAX_LENGTH;
  if (!ok) {
    throw errors.validation(CONTROL_ERROR_CODES.INVALID_VALUE, 'The video reference is invalid.');
  }
  return {
    fileId: video.fileId,
    fileUniqueId: video.fileUniqueId,
    mimeType:
      video.mimeType !== null && video.mimeType.length >= 1 && video.mimeType.length <= 128
        ? video.mimeType
        : null,
    durationSeconds:
      video.durationSeconds !== null &&
      Number.isSafeInteger(video.durationSeconds) &&
      video.durationSeconds >= 0
        ? video.durationSeconds
        : null,
    fileSize: video.fileSize !== null && video.fileSize > 0n ? video.fileSize : null,
  };
}

/**
 * The audit's view: the stable `file_unique_id` names WHICH video it was; the bot-scoped
 * `file_id` is a sending handle and is not written to the audit log.
 */
function videoAuditView(video: ClientAppVideoRecord): Record<string, unknown> {
  return {
    botInstanceId: video.botInstanceId,
    fileUniqueId: video.fileUniqueId,
    mimeType: video.mimeType,
    durationSeconds: video.durationSeconds,
    fileSize: video.fileSize === null ? null : video.fileSize.toString(),
    setByAdminId: video.setByAdminId,
    version: video.version,
  };
}
