import {
  BUSINESS_BOT_RIGHTS,
  BUSINESS_MESSAGE_TEXT_MAX,
  type BusinessBotRight,
  type BusinessMessageKind,
} from '@nexa/contracts';
import { z } from 'zod';

/**
 * TB1 — Telegram's Business objects, read STRICTLY.
 *
 * The webhook's own update schema is deliberately minimal (`telegramUpdateSchema`), and
 * the rest of an update is read through casts. These shapes are not read that way: the
 * connection's owner and a message's sender are IDENTITY, and a field that is not the
 * documented type is not quietly coerced into one. Anything malformed is `null`, and the
 * caller reports it rather than acting on it.
 *
 * Field names are the Bot API's (10.3; `docs/support-agent/tb0-audit.md` §1.2). The one
 * place they are the shared vocabulary is here, so both the webhook and the
 * `getBusinessConnection` gateway read a connection identically.
 */

/** A `BusinessConnection`, as Telegram reported it, already read strictly. */
export interface BusinessConnectionReport {
  readonly connectionId: string;
  readonly ownerTelegramUserId: string;
  readonly ownerUserChatId: string;
  readonly isEnabled: boolean;
  readonly rights: readonly BusinessBotRight[];
  readonly connectedAt: Date;
}

const telegramId = z.number().int().safe();
const positiveId = telegramId.refine((value) => value > 0);

const businessConnectionSchema = z.object({
  id: z.string().min(1).max(256),
  user: z.object({ id: positiveId }).passthrough(),
  user_chat_id: telegramId.refine((value) => value !== 0),
  date: z.number().int().nonnegative(),
  is_enabled: z.boolean(),
  rights: z.record(z.string(), z.unknown()).optional(),
});

/**
 * A `BusinessConnection`, or null. `rights` keeps only the documented rights that are
 * `true`; a right Telegram adds later is dropped (it cannot change any decision NEXA makes,
 * and the column's CHECK names the documented list). An absent `rights` object is NO rights
 * — the safe reading of an optional field that grants authority.
 */
export function parseBusinessConnection(raw: unknown): BusinessConnectionReport | null {
  const parsed = businessConnectionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const granted = parsed.data.rights ?? {};
  const rights = BUSINESS_BOT_RIGHTS.filter(
    (right): right is BusinessBotRight => granted[right] === true,
  );
  return {
    connectionId: parsed.data.id,
    ownerTelegramUserId: String(parsed.data.user.id),
    ownerUserChatId: String(parsed.data.user_chat_id),
    isEnabled: parsed.data.is_enabled,
    rights,
    connectedAt: new Date(parsed.data.date * 1000),
  };
}

const userRefSchema = z.object({ id: telegramId, is_bot: z.boolean().optional() }).passthrough();

const businessMessageSchema = z
  .object({
    message_id: z.number().int().positive(),
    business_connection_id: z.string().min(1).max(256),
    chat: z.object({ id: telegramId, type: z.string() }).passthrough(),
    from: userRefSchema.optional(),
    sender_business_bot: userRefSchema.optional(),
    is_from_offline: z.boolean().optional(),
    date: z.number().int().nonnegative(),
    edit_date: z.number().int().nonnegative().optional(),
    text: z.string().optional(),
    caption: z.string().optional(),
    photo: z.array(z.unknown()).optional(),
    document: z.unknown().optional(),
  })
  .passthrough();

/**
 * Phase 4 PR-2: the image types a DOCUMENT may carry and still be read as a photo — a customer
 * who sends a screenshot «as a file» sends the same picture. The declared type only selects the
 * candidate: the support AI's image source still decides by the magic bytes (JPEG, PNG, WEBP).
 */
export const BUSINESS_IMAGE_DOCUMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const imageDocumentSchema = z.object({
  file_id: z.string().min(1).max(256),
  file_unique_id: z.string().min(1).max(128),
  file_size: z.number().int().nonnegative().safe().optional(),
  mime_type: z.enum(BUSINESS_IMAGE_DOCUMENT_TYPES),
});

/** A document that is a JPEG, PNG or WEBP image, as a photo reference; null for anything else. */
export function imageDocumentReference(raw: unknown): BusinessPhotoReference | null {
  const parsed = imageDocumentSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    fileId: parsed.data.file_id,
    fileUniqueId: parsed.data.file_unique_id,
    fileSize: parsed.data.file_size ?? null,
  };
}

/** One business message: its routing facts, and (TB2) its bounded text and kind. */
export interface ParsedBusinessMessage {
  readonly connectionId: string;
  readonly chatId: string;
  readonly chatType: string;
  readonly messageId: number;
  readonly fromUserId: string | null;
  readonly senderBusinessBotId: string | null;
  readonly isFromOffline: boolean;
  readonly sentAt: Date;
  readonly editedAt: Date | null;
  readonly kind: BusinessMessageKind;
  /** `text`, or a photo's `caption`, cut to the stored bound; null when there is none. */
  readonly text: string | null;
  /**
   * TB6: the reference to a PHOTO's largest size — never bytes, never a URL. Null for any
   * other kind, and for a photo whose sizes are not the documented shape.
   */
  readonly photo: BusinessPhotoReference | null;
}

/** One `PhotoSize`, as stored: what `getFile` takes, its stable id, and the declared size. */
export interface BusinessPhotoReference {
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly fileSize: number | null;
}

const photoSizeSchema = z.object({
  file_id: z.string().min(1).max(256),
  file_unique_id: z.string().min(1).max(128),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  file_size: z.number().int().nonnegative().safe().optional(),
});

/**
 * The LARGEST size of a photo (Bot API `Message.photo`: "available sizes of the photo"). By
 * pixel area, then by declared size, then the later entry — Telegram lists them smallest
 * first. Every entry must be the documented shape, or there is no reference at all: an array
 * that is partly malformed is not one this code trusts to pick from.
 */
export function largestPhotoSize(raw: readonly unknown[]): BusinessPhotoReference | null {
  let best: z.infer<typeof photoSizeSchema> | null = null;
  for (const entry of raw) {
    const parsed = photoSizeSchema.safeParse(entry);
    if (!parsed.success) return null;
    const size = parsed.data;
    if (best === null) {
      best = size;
      continue;
    }
    const area = size.width * size.height;
    const bestArea = best.width * best.height;
    if (area > bestArea || (area === bestArea && (size.file_size ?? 0) >= (best.file_size ?? 0))) {
      best = size;
    }
  }
  if (best === null) return null;
  return {
    fileId: best.file_id,
    fileUniqueId: best.file_unique_id,
    fileSize: best.file_size ?? null,
  };
}

export function parseBusinessMessage(raw: unknown): ParsedBusinessMessage | null {
  const parsed = businessMessageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const message = parsed.data;
  // Phase 4 PR-2: an image sent as a document (jpg/png/webp) counts as a photo.
  const imageDocument =
    message.photo === undefined && message.document !== undefined
      ? imageDocumentReference(message.document)
      : null;
  return {
    connectionId: message.business_connection_id,
    chatId: String(message.chat.id),
    chatType: message.chat.type,
    messageId: message.message_id,
    fromUserId: message.from === undefined ? null : String(message.from.id),
    senderBusinessBotId:
      message.sender_business_bot === undefined ? null : String(message.sender_business_bot.id),
    isFromOffline: message.is_from_offline === true,
    sentAt: new Date(message.date * 1000),
    editedAt: message.edit_date === undefined ? null : new Date(message.edit_date * 1000),
    kind:
      message.photo !== undefined || imageDocument !== null
        ? 'PHOTO'
        : message.text !== undefined
          ? 'TEXT'
          : 'OTHER',
    text: boundedText(message.text ?? message.caption),
    photo: message.photo !== undefined ? largestPhotoSize(message.photo) : imageDocument,
  };
}

const deletedSchema = z.object({
  business_connection_id: z.string().min(1).max(256),
  chat: z.object({ id: telegramId }).passthrough(),
  message_ids: z.array(z.number().int().positive()).min(1).max(1000),
});

export interface ParsedBusinessDeletion {
  readonly connectionId: string;
  readonly chatId: string;
  readonly messageIds: readonly number[];
}

export function parseBusinessDeletion(raw: unknown): ParsedBusinessDeletion | null {
  const parsed = deletedSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    connectionId: parsed.data.business_connection_id,
    chatId: String(parsed.data.chat.id),
    messageIds: parsed.data.message_ids,
  };
}

/**
 * Which of the four business update types an update is, with its payload still raw.
 *
 * Decided by KEY PRESENCE, before any parsing: an update carrying `business_message` is a
 * business update even when its payload is malformed, and must never fall through to the
 * ordinary customer turn because it failed to parse.
 */
export type BusinessUpdate =
  | { readonly kind: 'CONNECTION'; readonly payload: unknown }
  | { readonly kind: 'MESSAGE'; readonly payload: unknown }
  | { readonly kind: 'EDITED_MESSAGE'; readonly payload: unknown }
  | { readonly kind: 'DELETED_MESSAGES'; readonly payload: unknown }
  /**
   * Phase 4 PR-3 — a tap on an inline button of a message sent ON BEHALF OF the business
   * account (its `message.business_connection_id`): the support AI's own buttons. Never the
   * customer turn: the tap is in the business account's chat, not the bot's.
   */
  | { readonly kind: 'CALLBACK'; readonly payload: unknown };

/** Phase 4 PR-3 — a tap on a business message's button, read strictly. */
export interface ParsedBusinessCallback {
  readonly callbackQueryId: string;
  readonly data: string | null;
  /** Who tapped (`callback_query.from.id`). */
  readonly fromUserId: string;
  /** The chat and message the tapped button sits on, and its business connection. */
  readonly chatId: string;
  readonly messageId: number;
  readonly connectionId: string;
}

const callbackSchema = z.object({
  id: z.string().min(1),
  data: z.string().max(64).optional(),
  from: z.object({ id: z.number().int() }),
  message: z.object({
    message_id: z.number().int(),
    chat: z.object({ id: z.number().int() }),
    business_connection_id: z.string().min(1),
  }),
});

export function parseBusinessCallback(raw: unknown): ParsedBusinessCallback | null {
  const parsed = callbackSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    callbackQueryId: parsed.data.id,
    data: parsed.data.data ?? null,
    fromUserId: String(parsed.data.from.id),
    chatId: String(parsed.data.message.chat.id),
    messageId: parsed.data.message.message_id,
    connectionId: parsed.data.message.business_connection_id,
  };
}

export function businessUpdateOf(update: unknown): BusinessUpdate | null {
  if (typeof update !== 'object' || update === null) return null;
  const shaped = update as Record<string, unknown>;
  if ('business_connection' in shaped)
    return { kind: 'CONNECTION', payload: shaped.business_connection };
  if ('business_message' in shaped) return { kind: 'MESSAGE', payload: shaped.business_message };
  if ('edited_business_message' in shaped) {
    return { kind: 'EDITED_MESSAGE', payload: shaped.edited_business_message };
  }
  if ('deleted_business_messages' in shaped) {
    return { kind: 'DELETED_MESSAGES', payload: shaped.deleted_business_messages };
  }
  // Phase 4 PR-3: a button tap on a message the bot sent for the business account.
  const callback = shaped.callback_query;
  if (typeof callback === 'object' && callback !== null) {
    const message = (callback as { message?: unknown }).message;
    if (typeof message === 'object' && message !== null && 'business_connection_id' in message) {
      return { kind: 'CALLBACK', payload: callback };
    }
  }
  return null;
}

function boundedText(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return null;
  return value.length > BUSINESS_MESSAGE_TEXT_MAX
    ? value.slice(0, BUSINESS_MESSAGE_TEXT_MAX)
    : value;
}
