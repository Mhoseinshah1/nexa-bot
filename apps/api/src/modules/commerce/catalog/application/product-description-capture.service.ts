import {
  COMMERCE_ERROR_CODES,
  PRODUCT_DESCRIPTION_CAPTURE_TTL_MS,
  PRODUCT_DESCRIPTION_MAX_LENGTH,
  descriptionFromTelegramText,
  errors,
  type ActorContext,
  type Admin,
  type AdminId,
  type AuditWriter,
  type BotInstance,
  type CapturedEntity,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type ProductDescriptionCaptureCloseReason,
  type ProductDescriptionCaptureState,
  type ProductId,
  type ScopeContext,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import { isNexaError } from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { PRODUCT_EDIT_PERMISSION } from './product.service.js';
import type { ProductRecord, ProductRepository } from './ports.js';

/**
 * «ارسال توضیح از تلگرام»: capture a product's description — with its premium emoji — from
 * a message the administrator sends or forwards to the tenant's bot.
 *
 * The Web Admin opens a REQUEST bound to ONE administrator, tenant and product, valid for ten
 * minutes and good for ONE message. The bot's next text or caption from THAT administrator's
 * Telegram account (resolved through `admins.telegram_user_id`, the binding the product
 * already has) completes it: the text and its `custom_emoji` entities become the stored
 * description form (`descriptionFromTelegramText`) and are kept on the request. Nothing is
 * written to the product. The page reads the request, puts the text in the description field,
 * and the administrator still presses the ordinary Save — which charges `catalog.edit` itself.
 *
 * Safe by construction: a message from anyone else matches no request; an expired or already
 * used request matches nothing (the first message closes it `CAPTURED` under a conditional
 * update, so two messages arriving together change it once); a sender who has lost
 * `catalog.edit` is refused and the request stays as it was.
 */
export interface ProductDescriptionCaptureRecord {
  readonly id: string;
  readonly adminId: string;
  readonly productId: string;
  readonly openedAt: Date;
  readonly expiresAt: Date;
  readonly closedAt: Date | null;
  readonly closeReason: ProductDescriptionCaptureCloseReason | null;
  /** The captured message in its stored form, once read. */
  readonly capturedText: string | null;
}

export interface ProductDescriptionCaptureRepository {
  /** Serialises one administrator's capture work for the transaction. */
  lockForAdmin(scope: TenantContext, adminId: string, tx: unknown): Promise<void>;
  /** Closes this administrator's open request `SUPERSEDED`, then opens a new one. */
  open(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly adminId: string;
      readonly productId: string;
      readonly openedAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<ProductDescriptionCaptureRecord>;
  findById(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<ProductDescriptionCaptureRecord | null>;
  findOpenForAdmin(
    scope: TenantContext,
    adminId: string,
    tx?: unknown,
  ): Promise<ProductDescriptionCaptureRecord | null>;
  /**
   * The newest request of the administrator bound to this Telegram account that is open
   * (whatever its deadline) or was closed at or after `closedSince` — the latter so that
   * Telegram redelivering the update that closed it is answered as the first delivery was.
   */
  findCurrentByTelegramUser(
    scope: TenantContext,
    telegramUserId: string,
    closedSince: Date,
    tx?: unknown,
  ): Promise<ProductDescriptionCaptureRecord | null>;
  /** Closes an open request with a reason. False when it was no longer open. */
  close(
    scope: TenantContext,
    id: string,
    reason: Exclude<ProductDescriptionCaptureCloseReason, 'CAPTURED'>,
    at: Date,
    tx: unknown,
  ): Promise<boolean>;
  /** `open -> CAPTURED` with the text, once. False when it was no longer open. */
  capture(scope: TenantContext, id: string, text: string, at: Date, tx: unknown): Promise<boolean>;
}

export interface ProductDescriptionCaptureDeps {
  readonly captures: ProductDescriptionCaptureRepository;
  readonly products: Pick<ProductRepository, 'findById'>;
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

export interface DescriptionCaptureBot {
  readonly username: string;
  readonly chatUrl: string;
}

export interface DescriptionCaptureView {
  readonly captureId: string;
  readonly state: ProductDescriptionCaptureState;
  readonly expiresAt: Date;
  readonly bots: readonly DescriptionCaptureBot[];
  readonly description: string | null;
}

/** What the bot learns about a message it offered to a request. */
export type DescriptionCaptureReceipt =
  /** No open request for this sender: the message is an ordinary one. */
  | { readonly outcome: 'NONE' }
  | { readonly outcome: 'CAPTURED'; readonly productTitle: string }
  | { readonly outcome: 'EXPIRED' }
  | { readonly outcome: 'DENIED' }
  | { readonly outcome: 'REJECTED' };

/**
 * A message sent this long (or less) after a request's deadline still answers «expired» once.
 * Later than that the request is closed silently and the message is an ordinary one, so a
 * stale request never swallows a message sent hours later.
 */
export const DESCRIPTION_CAPTURE_EXPIRED_REPLY_WINDOW_MS = 60 * 60 * 1000;
/** How long after a request closed the update that closed it is still answered as before. */
export const DESCRIPTION_CAPTURE_REDELIVERY_WINDOW_MS = 5 * 60 * 1000;
/** The clocks' allowance when comparing a message's own `date` to the request's opening. */
export const DESCRIPTION_CAPTURE_CLOCK_SKEW_MS = 2 * 60 * 1000;

/** `https://t.me/<username>` — the chat the administrator opens to send the description. */
export function descriptionBotChatUrl(username: string): string {
  return `https://t.me/${encodeURIComponent(username.replace(/^@/u, ''))}`;
}

/** A request's state as of `now`: an open one past its deadline is EXPIRED already. */
export function descriptionCaptureStateOf(
  capture: Pick<ProductDescriptionCaptureRecord, 'closedAt' | 'closeReason' | 'expiresAt'>,
  now: Date,
): ProductDescriptionCaptureState {
  if (capture.closedAt === null) {
    return capture.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'OPEN';
  }
  return capture.closeReason ?? 'EXPIRED';
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export class ProductDescriptionCaptureService {
  constructor(private readonly deps: ProductDescriptionCaptureDeps) {}

  /** Opens a request for this administrator and product; supersedes their earlier open one. */
  async open(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly productId: string },
  ): Promise<DescriptionCaptureView> {
    await this.deps.guard.check(scope, actor, PRODUCT_EDIT_PERMISSION);
    const requestHash = hashRequest({ productId: input.productId, descriptionCapture: true });
    const found = await this.deps.idempotency.find<{ captureId: string }>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (found !== null) {
      return this.read(scope, actor, input.productId, found.result.captureId);
    }
    const now = this.deps.clock.now();
    const bots = (await this.deps.bots.listForTenant(scope)).filter(
      (bot) => bot.status === 'ACTIVE',
    );
    const opened = await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PRODUCT_EDIT_PERMISSION,
      {
        action: 'product.description_capture_open',
        entityType: 'Product',
        entityId: UUID_SHAPE.test(input.productId) ? input.productId : null,
      },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const product = await this.requireProduct(scope, input.productId, tx);
        const admin = await this.deps.admins.findById(scope, actor.id as AdminId, tx);
        // Without the binding nothing they send could ever be theirs, so none is opened.
        if (admin?.telegramUserId == null) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PRODUCT_DESCRIPTION_CAPTURE_TELEGRAM_UNLINKED,
            'This administrator has no Telegram account bound.',
          );
        }
        if (bots.length === 0) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PRODUCT_DESCRIPTION_CAPTURE_NO_BOT,
            'This tenant has no active bot to send the description to.',
          );
        }
        await this.deps.captures.lockForAdmin(scope, admin.id, tx);
        const capture = await this.deps.captures.open(
          scope,
          {
            id: this.deps.ids.uuid(),
            adminId: admin.id,
            productId: product.id,
            openedAt: now,
            expiresAt: new Date(now.getTime() + PRODUCT_DESCRIPTION_CAPTURE_TTL_MS),
          },
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'product.description_capture_open',
            entityType: 'Product',
            entityId: product.id,
            before: null,
            after: { captureId: capture.id, expiresAt: capture.expiresAt.toISOString() },
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
          { captureId: capture.id },
          tx,
        );
        return capture;
      },
    );
    return this.view(opened, bots, now);
  }

  /**
   * One request, as the page polls it. Only the administrator it names may read it, and only
   * under the product it was opened for. A read writes nothing: an open request past its
   * deadline is reported EXPIRED by the clock.
   */
  async read(
    scope: TenantContext,
    actor: ActorContext,
    productId: string,
    captureId: string,
  ): Promise<DescriptionCaptureView> {
    await this.deps.guard.check(scope, actor, PRODUCT_EDIT_PERMISSION);
    const capture = UUID_SHAPE.test(captureId)
      ? await this.deps.captures.findById(scope, captureId)
      : null;
    if (capture === null || capture.adminId !== actor.id || capture.productId !== productId) {
      throw errors.notFound(
        COMMERCE_ERROR_CODES.PRODUCT_DESCRIPTION_CAPTURE_NOT_FOUND,
        'No such description request.',
      );
    }
    const bots = (await this.deps.bots.listForTenant(scope)).filter(
      (bot) => bot.status === 'ACTIVE',
    );
    return this.view(capture, bots, this.deps.clock.now());
  }

  /**
   * One cheap read for the bot: the open — or just closed — request of the administrator
   * bound to this Telegram account, or null, which is almost every message. Nothing is written.
   */
  async pendingFor(
    scope: TenantContext,
    telegramUserId: string,
  ): Promise<ProductDescriptionCaptureRecord | null> {
    return this.deps.captures.findCurrentByTelegramUser(
      scope,
      telegramUserId,
      new Date(this.deps.clock.now().getTime() - DESCRIPTION_CAPTURE_REDELIVERY_WINDOW_MS),
    );
  }

  /**
   * A text or caption message from an administrator, offered to their open request. `actor`
   * is the administrator the Telegram account resolved to; `sentAt` is the message's own
   * `date`.
   */
  async receive(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly text: string;
      readonly entities: readonly CapturedEntity[];
      readonly sentAt: Date | null;
    },
  ): Promise<DescriptionCaptureReceipt> {
    if (actor.id === null || actor.id === undefined) return { outcome: 'NONE' };
    const adminId = actor.id;
    // A sender who no longer holds the permission is refused, and the request stays as it was.
    try {
      await this.deps.guard.check(scope, actor, PRODUCT_EDIT_PERMISSION);
    } catch (error) {
      if (isNexaError(error) && error.kind === 'PERMISSION_DENIED') {
        return (await this.deps.captures.findOpenForAdmin(scope, adminId)) === null
          ? { outcome: 'NONE' }
          : { outcome: 'DENIED' };
      }
      throw error;
    }
    const requestHash = hashRequest({ adminId, descriptionReceive: true });
    // A redelivered update is answered as its first delivery was, even after it closed the request.
    const found = await this.deps.idempotency.find<DescriptionCaptureReceipt>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (found !== null) return found.result;
    if ((await this.deps.captures.findOpenForAdmin(scope, adminId)) === null) {
      return { outcome: 'NONE' };
    }
    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PRODUCT_EDIT_PERMISSION,
      { action: 'product.description_capture', entityType: 'Product', entityId: null },
      async (tx): Promise<DescriptionCaptureReceipt> => {
        await this.assertScopeActive(scope, tx);
        await this.deps.captures.lockForAdmin(scope, adminId, tx);
        const request = await this.deps.captures.findOpenForAdmin(scope, adminId, tx);
        const answer = async (receipt: DescriptionCaptureReceipt) => {
          await rememberOnce(
            this.deps.idempotency,
            scope,
            actor.surface,
            input.idempotencyKey,
            requestHash,
            receipt,
            tx,
          );
          return receipt;
        };
        if (request === null) return answer({ outcome: 'NONE' });
        // A message sent before the button was pressed, delivered late, belongs to no request.
        if (
          input.sentAt !== null &&
          input.sentAt.getTime() < request.openedAt.getTime() - DESCRIPTION_CAPTURE_CLOCK_SKEW_MS
        ) {
          return answer({ outcome: 'NONE' });
        }
        if (request.expiresAt.getTime() <= now.getTime()) {
          await this.deps.captures.close(scope, request.id, 'EXPIRED', now, tx);
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'product.description_capture_expired',
              entityType: 'Product',
              entityId: request.productId,
              before: { captureId: request.id, state: 'OPEN' },
              after: { captureId: request.id, state: 'EXPIRED' },
              result: 'SUCCESS',
            },
            tx,
          );
          // Answered «expired» once, soon after the deadline; much later it is just silent.
          return answer(
            now.getTime() - request.expiresAt.getTime() <=
              DESCRIPTION_CAPTURE_EXPIRED_REPLY_WINDOW_MS
              ? { outcome: 'EXPIRED' }
              : { outcome: 'NONE' },
          );
        }
        const product = await this.deps.products.findById(
          scope,
          request.productId as ProductId,
          tx,
        );
        if (product === null) {
          await this.deps.captures.close(scope, request.id, 'SUPERSEDED', now, tx);
          return answer({ outcome: 'NONE' });
        }
        const stored = descriptionFromTelegramText(input.text, input.entities).trim();
        if (stored === '' || stored.length > PRODUCT_DESCRIPTION_MAX_LENGTH) {
          // The request stays open for a shorter message; nothing is stored.
          return answer({ outcome: 'REJECTED' });
        }
        if (!(await this.deps.captures.capture(scope, request.id, stored, now, tx))) {
          return answer({ outcome: 'NONE' });
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'product.description_capture',
            entityType: 'Product',
            entityId: product.id,
            before: { captureId: request.id, state: 'OPEN' },
            after: { captureId: request.id, state: 'CAPTURED', length: stored.length },
            result: 'SUCCESS',
          },
          tx,
        );
        return answer({ outcome: 'CAPTURED', productTitle: product.title });
      },
    );
  }

  // -------------------------------------------------------------------------------------

  private view(
    capture: ProductDescriptionCaptureRecord,
    bots: readonly BotInstance[],
    now: Date,
  ): DescriptionCaptureView {
    const state = descriptionCaptureStateOf(capture, now);
    return {
      captureId: capture.id,
      state,
      expiresAt: capture.expiresAt,
      bots: bots.map((bot) => ({
        username: bot.username,
        chatUrl: descriptionBotChatUrl(bot.username),
      })),
      description: state === 'CAPTURED' ? capture.capturedText : null,
    };
  }

  private async requireProduct(
    scope: TenantContext,
    productId: string,
    tx: TransactionScope,
  ): Promise<ProductRecord> {
    const product = UUID_SHAPE.test(productId)
      ? await this.deps.products.findById(scope, productId as ProductId, tx)
      : null;
    if (product === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND, 'Unknown product.');
    }
    return product;
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
