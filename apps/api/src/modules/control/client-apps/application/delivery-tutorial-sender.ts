import {
  deliveryTutorialSendsText,
  deliveryTutorialSendsVideo,
  renderClientAppGuide,
  type BotInstanceId,
  type IdempotencyStore,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CustomerMessenger,
  CustomerSendOutcome,
} from '../../../commerce/messaging/application/ports.js';
import type { DeliveryTutorialRepository } from './delivery-tutorial.service.js';

/** The template every tutorial text reaches a customer through: `{text}`, PLAIN_TEXT. */
export const DELIVERY_TUTORIAL_TEMPLATE_KEY = 'bot.service.delivery_tutorial' as const;

/** The idempotency key that makes the tutorial at-most-once per service. */
export function deliveryTutorialClaimKey(serviceId: string): string {
  return `delivery_tutorial:${serviceId}`;
}

/** What one call did — for a log line and for the tests, never for a retry. */
export type DeliveryTutorialOutcome =
  /** No row, DISABLED, not for this kind of service, or nothing this bot can send. */
  | { readonly kind: 'NONE' }
  /** The tenant stopped accepting work: nothing claimed, nothing sent. */
  | { readonly kind: 'STOPPED' }
  /** Already claimed — a replay, a second replica, a second delivery of the same service. */
  | { readonly kind: 'DUPLICATE' }
  | {
      readonly kind: 'SENT';
      readonly arrangement: 'TEXT' | 'VIDEO' | 'VIDEO_CAPTIONED' | 'VIDEO_THEN_TEXT';
      readonly outcome: CustomerSendOutcome;
    };

export interface DeliveryTutorialSenderDeps {
  readonly tutorials: Pick<DeliveryTutorialRepository, 'find'>;
  /**
   * The client app's tutorial video THIS bot can send — `ClientAppVideoService.videoFor`:
   * an ENABLED app's `file_id` for exactly this bot, or null. A `file_id` is bot-scoped.
   */
  readonly videos: {
    videoFor(
      scope: TenantContext,
      appId: string,
      botInstanceId: BotInstanceId,
    ): Promise<{ readonly fileId: string } | null>;
  };
  readonly messenger: Pick<CustomerMessenger, 'send' | 'sendFile'>;
  readonly idempotency: Pick<IdempotencyStore, 'remember'>;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
}

/**
 * Phase 2 item 5: the panel's tutorial, sent ONCE after a service on it was delivered.
 *
 * Called by `DeliveryService.deliverDue` only for the sweep that recorded the FIRST
 * delivery of a purchase or a trial — never for a rotation's new link, never for a
 * customer's «resend». On top of that, the service's claim (`delivery_tutorial:<id>`, in the
 * WORKER namespace) is committed BEFORE anything is sent, in a transaction that reads the
 * tenant's activity, so a replay, a second replica, or any later path that reached here
 * finds the claim and sends nothing. A sender that dies mid-send leaves the claim standing:
 * a tutorial that may already be on the customer's screen is never sent twice.
 *
 * The outcomes are never retried. UNKNOWN may have arrived; RATE_LIMITED is Telegram
 * declining a message that is a courtesy, not a delivery — neither is worth a duplicate.
 *
 * VIDEO + TEXT is A4a's arrangement: one video with the text as its caption when the
 * rendered text fits a caption WHOLE (the messenger's `captionWhole` refuses it otherwise,
 * without a request); else the bare video, then the text as its own message. Never a cut
 * caption. A video Telegram refuses still lets the text go.
 *
 * Never throws for a send; whatever else throws is swallowed by the delivery sweep, which
 * has already recorded the delivery and must not be touched by a tutorial.
 */
export class DeliveryTutorialSender {
  constructor(private readonly deps: DeliveryTutorialSenderDeps) {}

  async afterDelivery(
    scope: TenantContext,
    service: { readonly id: string; readonly panelId: string; readonly isTrial: boolean },
    contact: { readonly chatId: string; readonly botInstanceId: BotInstanceId },
  ): Promise<DeliveryTutorialOutcome> {
    const tutorial = await this.deps.tutorials.find(scope, service.panelId);
    if (tutorial === null || tutorial.mode === 'DISABLED') return { kind: 'NONE' };
    if (!(service.isTrial ? tutorial.appliesToTrial : tutorial.appliesToPurchase)) {
      return { kind: 'NONE' };
    }
    const text =
      deliveryTutorialSendsText(tutorial.mode) && tutorial.text !== null
        ? renderClientAppGuide(tutorial.text)
        : '';
    const video =
      deliveryTutorialSendsVideo(tutorial.mode) && tutorial.videoClientAppId !== null
        ? await this.deps.videos.videoFor(scope, tutorial.videoClientAppId, contact.botInstanceId)
        : null;
    // Nothing this bot can send (a video it does not hold, a text rendered to nothing).
    if (text === '' && video === null) return { kind: 'NONE' };

    const claimed = await this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 'STOPPED' as const;
      const fresh = await this.deps.idempotency.remember(
        scope,
        'WORKER',
        deliveryTutorialClaimKey(service.id),
        hashRequest({ command: 'service.delivery_tutorial', serviceId: service.id }),
        { claimed: true },
        tx,
      );
      return fresh ? ('CLAIMED' as const) : ('DUPLICATE' as const);
    });
    if (claimed === 'STOPPED') return { kind: 'STOPPED' };
    if (claimed === 'DUPLICATE') return { kind: 'DUPLICATE' };

    const asText = async () =>
      (
        await this.deps.messenger.send(scope, {
          chatId: contact.chatId,
          botInstanceId: contact.botInstanceId,
          templateKey: DELIVERY_TUTORIAL_TEMPLATE_KEY,
          values: { text },
        })
      ).outcome;
    const bareVideo = async (fileId: string) =>
      (
        await this.deps.messenger.sendFile(scope, {
          chatId: contact.chatId,
          botInstanceId: contact.botInstanceId,
          kind: 'VIDEO',
          source: { kind: 'FILE_ID', fileId },
        })
      ).outcome;

    if (video === null) return { kind: 'SENT', arrangement: 'TEXT', outcome: await asText() };
    if (text === '') {
      return { kind: 'SENT', arrangement: 'VIDEO', outcome: await bareVideo(video.fileId) };
    }
    const captioned = await this.deps.messenger.sendFile(scope, {
      chatId: contact.chatId,
      botInstanceId: contact.botInstanceId,
      kind: 'VIDEO',
      source: { kind: 'FILE_ID', fileId: video.fileId },
      caption: { templateKey: DELIVERY_TUTORIAL_TEMPLATE_KEY, values: { text } },
      captionWhole: true,
    });
    if (captioned.outcome !== 'REFUSED') {
      // DELIVERED, or UNKNOWN / RATE_LIMITED: the latter two are not retried.
      return { kind: 'SENT', arrangement: 'VIDEO_CAPTIONED', outcome: captioned.outcome };
    }
    if (captioned.reason === 'CAPTION_OVER_BOUND') {
      // Too long to be a caption: the video bare, then the text.
      const bare = await bareVideo(video.fileId);
      /*
       * Except after a 429 on the video: the limit is per chat, so the text would only burst
       * into a second one. Not retried either way — the tutorial is at-most-once.
       */
      if (bare === 'RATE_LIMITED') {
        return { kind: 'SENT', arrangement: 'VIDEO_THEN_TEXT', outcome: 'RATE_LIMITED' };
      }
      return { kind: 'SENT', arrangement: 'VIDEO_THEN_TEXT', outcome: await asText() };
    }
    // Telegram refused the video itself: the text still goes, whole.
    return { kind: 'SENT', arrangement: 'TEXT', outcome: await asText() };
  }
}
