import {
  CLIENT_APP_VIDEO_CAPTURE_TTL_MS,
  COMMERCE_ERROR_CODES,
  CONTROL_ERROR_CODES,
  errors,
  type ActorContext,
  type Admin,
  type AdminId,
  type AuditWriter,
  type BotInstance,
  type BotInstanceId,
  type ClientAppVideoSessionState,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type ScopeContext,
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
import type {
  AdminAmountCaptureRecord,
  AdminAmountCaptureRepository,
} from '../../../commerce/payments/application/admin-amount-capture-ports.js';
import { CLIENT_APP_EDIT_PERMISSION, CLIENT_APP_VIEW_PERMISSION } from './client-app.service.js';
import type { ClientAppVideoRecord, ClientAppVideoRepository } from './client-app-video.service.js';
import type { ClientAppRecord, ClientAppRepository } from './ports.js';

/**
 * UX Batch 01 item 6 — «افزودن ویدیو از تلگرام»: the Web Admin's half of spec §7's tutorial
 * video (`docs/ux-batch-01-tutorial-video-web.md`).
 *
 * There is no second session system. The web opens the SAME `CLIENT_APP_VIDEO` prompt the
 * Telegram panel's «تنظیم ویدیو» opens — a row in `admin_amount_captures` naming the tenant,
 * ONE administrator (the web session's), ONE bot and ONE app, with a deadline — and the bot's
 * existing `ClientAppVideoService.receiveVideo` completes it. So everything that makes the
 * Telegram prompt safe holds here unchanged: the one-open-prompt index, the per-administrator
 * advisory lock, single use (it closes `CONFIRMED` on the first video), the deadline, and
 * the identity of the sender — the bot resolves the Telegram account to an administrator
 * through `admins.telegram_user_id`, the binding this product already has, and offers the
 * video only to THAT administrator's prompt on THAT bot. A video from anyone else, to any
 * other bot, or any message that is not a video, matches nothing.
 *
 * What is new is only the web's view of it: open, poll, cancel — each charging
 * `client_apps.edit` or `.view`, each prompt readable and cancellable only by the
 * administrator it names, and each change audited.
 */
export interface ClientAppVideoWebDeps {
  readonly videos: Pick<ClientAppVideoRepository, 'find'>;
  readonly apps: Pick<ClientAppRepository, 'find'>;
  readonly captures: Pick<
    AdminAmountCaptureRepository,
    'lockForAdmin' | 'open' | 'findById' | 'close'
  >;
  readonly bots: { listForTenant(scope: ScopeContext): Promise<BotInstance[]> };
  readonly admins: {
    findById(scope: ScopeContext, id: AdminId, tx?: unknown): Promise<Admin | null>;
  };
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

export interface WebVideoBot {
  readonly botInstanceId: BotInstanceId;
  readonly username: string;
  readonly chatUrl: string;
  readonly active: boolean;
}

export interface WebVideoSession {
  readonly sessionId: string;
  readonly bot: WebVideoBot;
  readonly state: ClientAppVideoSessionState;
  readonly openedAt: Date;
  readonly expiresAt: Date;
  readonly video: ClientAppVideoRecord | null;
}

/** `https://t.me/<username>` — the chat the administrator opens to send the video. */
export function botChatUrl(username: string): string {
  return `https://t.me/${encodeURIComponent(username.replace(/^@/u, ''))}`;
}

/** A prompt's state as of `now`: an open one past its deadline is EXPIRED already. */
export function sessionStateOf(
  capture: Pick<AdminAmountCaptureRecord, 'closedAt' | 'closeReason' | 'expiresAt'>,
  now: Date,
): ClientAppVideoSessionState {
  if (capture.closedAt === null) {
    return capture.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'OPEN';
  }
  return capture.closeReason ?? 'EXPIRED';
}

export class ClientAppVideoWebService {
  constructor(private readonly deps: ClientAppVideoWebDeps) {}

  /** This app's video on each of the tenant's bots, and whether the viewer can send one. */
  async overview(
    scope: TenantContext,
    actor: ActorContext,
    appId: string,
  ): Promise<{
    readonly app: ClientAppRecord;
    readonly telegramLinked: boolean;
    readonly bots: readonly {
      readonly bot: WebVideoBot;
      readonly video: ClientAppVideoRecord | null;
    }[];
  }> {
    await this.deps.guard.check(scope, actor, CLIENT_APP_VIEW_PERMISSION);
    const app = await this.requireApp(scope, appId);
    const [admin, bots] = await Promise.all([
      this.deps.admins.findById(scope, actor.id as AdminId),
      this.deps.bots.listForTenant(scope),
    ]);
    const rows = await Promise.all(
      bots.map(async (bot) => ({
        bot: botView(bot),
        video: await this.deps.videos.find(scope, app.id, bot.id),
      })),
    );
    return { app, telegramLinked: admin?.telegramUserId != null, bots: rows };
  }

  /**
   * Opens the prompt for one bot. Supersedes this administrator's open VIDEO prompt on that
   * bot — from the web or from Telegram — and nothing else: an amount or reason they are
   * typing in Telegram is left open (PR #185 review).
   */
  async open(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly appId: string;
      readonly botInstanceId: string;
    },
  ): Promise<WebVideoSession> {
    await this.deps.guard.check(scope, actor, CLIENT_APP_EDIT_PERMISSION);
    const requestHash = hashRequest({
      appId: input.appId,
      botInstanceId: input.botInstanceId,
      webVideoSession: true,
    });
    const found = await this.deps.idempotency.find<{ sessionId: string }>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (found !== null) return this.read(scope, actor, input.appId, found.result.sessionId);

    const now = this.deps.clock.now();
    const bot = await this.requireActiveBot(scope, input.botInstanceId);
    const opened = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CLIENT_APP_EDIT_PERMISSION,
      {
        action: 'client_app.video_session_open',
        entityType: 'ClientApp',
        entityId: UUID_SHAPE.test(input.appId) ? input.appId : null,
      },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const app = await this.requireApp(scope, input.appId, tx);
        // The binding is what lets the bot know the video is this administrator's. Without
        // it nothing they send could ever complete the prompt, so none is opened.
        const admin = await this.deps.admins.findById(scope, actor.id as AdminId, tx);
        if (admin?.telegramUserId == null) {
          throw errors.conflict(
            CONTROL_ERROR_CODES.CLIENT_APP_VIDEO_TELEGRAM_UNLINKED,
            'This administrator has no Telegram account bound.',
          );
        }
        await this.deps.captures.lockForAdmin(scope, bot.id, admin.id, tx);
        const capture = await this.deps.captures.open(
          scope,
          {
            id: this.deps.ids.uuid(),
            botInstanceId: bot.id,
            adminId: admin.id,
            clientAppId: app.id,
            purpose: 'CLIENT_APP_VIDEO',
            openedAt: now,
            expiresAt: new Date(now.getTime() + CLIENT_APP_VIDEO_CAPTURE_TTL_MS),
            // Only an earlier video prompt: an amount or reason the administrator is typing
            // in Telegram stays open (PR #185 review).
            supersede: 'SAME_PURPOSE',
          },
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'client_app.video_session_open',
            entityType: 'ClientApp',
            entityId: app.id,
            before: null,
            after: {
              sessionId: capture.id,
              botInstanceId: bot.id,
              expiresAt: capture.expiresAt.toISOString(),
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          { sessionId: capture.id },
          tx,
        );
        return capture;
      },
    );
    return { ...this.view(opened, botView(bot), now), video: null };
  }

  /**
   * One prompt, as the page polls it. Only the administrator it names may read it, and only
   * under the app it was opened for; anything else is "no such prompt". A read writes
   * nothing: an open prompt past its deadline is reported EXPIRED by the clock.
   */
  async read(
    scope: TenantContext,
    actor: ActorContext,
    appId: string,
    sessionId: string,
  ): Promise<WebVideoSession> {
    await this.deps.guard.check(scope, actor, CLIENT_APP_VIEW_PERMISSION);
    const capture = await this.requireOwnSession(scope, actor, appId, sessionId);
    // A read writes nothing (PR #185 review): a passed deadline is EXPIRED by the clock
    // (`sessionStateOf`). The row is stamped by a write path — the bot's late video, or a
    // cancel — never by a poll.
    return this.withVideo(scope, capture, this.deps.clock.now());
  }

  /** Cancels the prompt. A prompt already closed is answered as it is, and nothing is audited. */
  async cancel(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly appId: string; readonly sessionId: string },
  ): Promise<WebVideoSession> {
    await this.deps.guard.check(scope, actor, CLIENT_APP_EDIT_PERMISSION);
    const requestHash = hashRequest({
      appId: input.appId,
      sessionId: input.sessionId,
      cancelWebVideoSession: true,
    });
    const found = await this.deps.idempotency.find<{ sessionId: string }>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (found !== null) return this.read(scope, actor, input.appId, found.result.sessionId);

    const now = this.deps.clock.now();
    const capture = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      CLIENT_APP_EDIT_PERMISSION,
      {
        action: 'client_app.video_session_cancel',
        entityType: 'ClientApp',
        entityId: UUID_SHAPE.test(input.appId) ? input.appId : null,
      },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const mine = await this.requireOwnSession(scope, actor, input.appId, input.sessionId, tx);
        await this.deps.captures.lockForAdmin(scope, mine.botInstanceId, mine.adminId, tx);
        // A prompt whose deadline has passed is closed for what it is, EXPIRED, and that is
        // the timeout's audit row — written here, on a write path, never by a read.
        const expired = mine.expiresAt.getTime() <= now.getTime();
        const to = expired ? 'EXPIRED' : 'CANCELLED';
        if (await this.deps.captures.close(scope, mine.id, to, now, tx)) {
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: expired
                ? 'client_app.video_session_expired'
                : 'client_app.video_session_cancel',
              entityType: 'ClientApp',
              entityId: mine.clientAppId,
              before: { sessionId: mine.id, state: 'OPEN' },
              after: { sessionId: mine.id, state: to },
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
          { sessionId: mine.id },
          tx,
        );
        return (await this.deps.captures.findById(scope, mine.id, tx)) ?? mine;
      },
    );
    return this.withVideo(scope, capture, now);
  }

  // -------------------------------------------------------------------------------------

  private async withVideo(
    scope: TenantContext,
    capture: AdminAmountCaptureRecord,
    now: Date,
  ): Promise<WebVideoSession> {
    const bots = await this.deps.bots.listForTenant(scope);
    const bot = bots.find((one) => one.id === capture.botInstanceId);
    const view = this.view(capture, bot === undefined ? null : botView(bot), now);
    const video =
      view.state === 'CONFIRMED' && capture.clientAppId !== null
        ? await this.deps.videos.find(scope, capture.clientAppId, capture.botInstanceId)
        : null;
    return { ...view, video };
  }

  private view(
    capture: AdminAmountCaptureRecord,
    bot: WebVideoBot | null,
    now: Date,
  ): Omit<WebVideoSession, 'video'> {
    return {
      sessionId: capture.id,
      bot: bot ?? {
        botInstanceId: capture.botInstanceId,
        username: '',
        chatUrl: '',
        active: false,
      },
      state: sessionStateOf(capture, now),
      openedAt: capture.openedAt,
      expiresAt: capture.expiresAt,
    };
  }

  private async requireOwnSession(
    scope: TenantContext,
    actor: ActorContext,
    appId: string,
    sessionId: string,
    tx?: unknown,
  ): Promise<AdminAmountCaptureRecord> {
    const capture = UUID_SHAPE.test(sessionId)
      ? await this.deps.captures.findById(scope, sessionId, tx)
      : null;
    if (
      capture === null ||
      capture.purpose !== 'CLIENT_APP_VIDEO' ||
      capture.adminId !== actor.id ||
      capture.clientAppId !== appId
    ) {
      throw errors.notFound(
        CONTROL_ERROR_CODES.CLIENT_APP_VIDEO_SESSION_NOT_FOUND,
        'No such video prompt.',
      );
    }
    return capture;
  }

  private async requireActiveBot(
    scope: TenantContext,
    botInstanceId: string,
  ): Promise<BotInstance> {
    const bots = await this.deps.bots.listForTenant(scope);
    const bot = bots.find((one) => one.id === botInstanceId);
    if (bot === undefined || bot.status !== 'ACTIVE') {
      throw errors.conflict(
        CONTROL_ERROR_CODES.CLIENT_APP_VIDEO_BOT_UNAVAILABLE,
        'That bot is not one of this tenant’s active bots.',
      );
    }
    return bot;
  }

  private async requireApp(
    scope: TenantContext,
    appId: string,
    tx?: TransactionScope,
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

function botView(bot: BotInstance): WebVideoBot {
  return {
    botInstanceId: bot.id,
    username: bot.username,
    chatUrl: botChatUrl(bot.username),
    active: bot.status === 'ACTIVE',
  };
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
