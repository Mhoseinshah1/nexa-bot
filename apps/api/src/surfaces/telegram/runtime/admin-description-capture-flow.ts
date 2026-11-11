import type { ActorContext, BotInstanceId, CapturedEntity, TenantContext } from '@nexa/contracts';
import { messageSentAt } from '../admin-tutorial-video.js';
import type { BotRuntime } from '../bot-runtime.js';
import { privateChatIdOf } from './intent-of.js';
import type { BotCommand } from './intents.js';
import type { PendingReply } from './replies.js';

/**
 * «ارسال توضیح از تلگرام» — the bot's half. An administrator with an open description request
 * (opened from the product page in the Web Admin) sends or forwards the description; the
 * message is offered to `ProductDescriptionCaptureService.receive`, which stores nothing on
 * the product and answers one of five things. This file only decides WHICH messages are
 * offered and WHICH template answers; whether anything is captured is the service's call.
 *
 * Offered: a text message the router read as plain text (not a command, not a menu tap, not a
 * wizard answer it recognises), or any message with a caption. Everything else — and every
 * message from someone with no open request — goes on to the ordinary routing untouched.
 */
const NO_REPLY_KEYS = {
  EXPIRED: 'bot.admin.description_capture_expired',
  DENIED: 'bot.admin.description_capture_denied',
  REJECTED: 'bot.admin.description_capture_rejected',
} as const;

/** The text and entities of a message: its `text`, else its `caption`. Null when it has neither. */
export function capturableTextOf(
  message: unknown,
): { readonly text: string; readonly entities: readonly CapturedEntity[] } | null {
  if (typeof message !== 'object' || message === null) return null;
  const record = message as Record<string, unknown>;
  const isText = typeof record['text'] === 'string';
  const text = isText ? (record['text'] as string) : record['caption'];
  if (typeof text !== 'string' || text.trim() === '') return null;
  const raw = isText ? record['entities'] : record['caption_entities'];
  const entities: CapturedEntity[] = [];
  if (Array.isArray(raw)) {
    for (const entity of raw as unknown[]) {
      if (typeof entity !== 'object' || entity === null) continue;
      const one = entity as Record<string, unknown>;
      if (
        typeof one['type'] !== 'string' ||
        typeof one['offset'] !== 'number' ||
        typeof one['length'] !== 'number'
      ) {
        continue;
      }
      entities.push({
        type: one['type'],
        offset: one['offset'],
        length: one['length'],
        ...(typeof one['custom_emoji_id'] === 'string'
          ? { custom_emoji_id: one['custom_emoji_id'] }
          : {}),
      });
    }
  }
  return { text, entities };
}

export async function descriptionCaptureTurn(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  command: BotCommand,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly update: unknown;
    readonly telegramUserId: string;
  },
): Promise<PendingReply | null> {
  const captures = rt.deps.productDescriptionCapture;
  const admins = rt.deps.telegramAdmins;
  if (captures === undefined || admins === undefined) return null;
  const message = (input.update as { message?: unknown } | null)?.message;
  const readable = capturableTextOf(message);
  if (readable === null || privateChatIdOf(input.update) === null) return null;
  // A command or a menu tap is never a description; a captioned file may be.
  const isPlainText = typeof (message as { text?: unknown }).text === 'string';
  if (
    isPlainText &&
    (command.intent !== 'USERNAME_TEXT' || readable.text.trimStart().startsWith('/'))
  ) {
    return null;
  }
  // One cheap read: almost every message belongs to nobody's request and stops here.
  if ((await captures.pendingFor(scope, input.telegramUserId)) === null) return null;
  const identity = await admins.resolve(scope, input.telegramUserId, actor.correlationId);
  if (identity === null) return null;
  const receipt = await captures.receive(scope, identity.actor, {
    idempotencyKey: `${input.idempotencyKey}:description-capture`,
    text: readable.text,
    entities: readable.entities,
    sentAt: messageSentAt(message),
  });
  switch (receipt.outcome) {
    case 'NONE':
      return null;
    case 'CAPTURED':
      return {
        key: 'bot.admin.description_capture_done',
        values: { product: receipt.productTitle },
        buttons: [],
        orderId: null,
      };
    default:
      return { key: NO_REPLY_KEYS[receipt.outcome], values: {}, buttons: [], orderId: null };
  }
}
