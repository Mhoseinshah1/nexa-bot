/**
 * Which kind of Telegram chat an update came from — the one place that decides whether an
 * update may be a CUSTOMER contact.
 *
 * A customer is somebody who talks to the bot in their own private chat. A person who joins,
 * leaves or posts in a group the bot sits in (the operations log group included) is not a
 * customer, and a row created for them blocks the legacy import's "no customers yet" check
 * and shows on the Web Admin's customer list.
 *
 * Read through the passthrough fields, as the rest of the surface does: the schema models only
 * what this installation depends on.
 */

/** The update keys that carry a `chat` of their own (a message-shaped payload). */
const CHAT_CARRYING_KEYS = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'my_chat_member',
  'chat_member',
  'chat_join_request',
  'message_reaction',
  'message_reaction_count',
  'chat_boost',
  'removed_chat_boost',
] as const;

/**
 * The `chat.type` of the update, or null when it carries no chat at all (`inline_query`,
 * `pre_checkout_query`, `chosen_inline_result`, a callback on an inline message, ...).
 *
 * A tapped button carries the message it was attached to, and that message carries the chat.
 */
export function chatTypeOf(update: unknown): string | null {
  const shaped = update as Record<string, unknown> | null | undefined;
  if (typeof shaped !== 'object' || shaped === null) return null;
  const typeIn = (holder: unknown): string | null => {
    const chat = (holder as { chat?: { type?: unknown } } | null | undefined)?.chat;
    return typeof chat?.type === 'string' ? chat.type : null;
  };
  for (const key of CHAT_CARRYING_KEYS) {
    const type = typeIn(shaped[key]);
    if (type !== null) return type;
  }
  const callback = shaped['callback_query'] as { message?: unknown } | null | undefined;
  return typeIn(callback?.message);
}

/**
 * Whether the update belongs to a group, supergroup or channel — a chat that is never a
 * customer's own.
 *
 * Decided by exclusion, deliberately: a chat-less update (a pre-checkout from a private
 * purchase, an inline query) and an unknown type keep today's behaviour, and only the three
 * types that can never be a customer's conversation are shut out.
 */
export function isGroupChatUpdate(update: unknown): boolean {
  const type = chatTypeOf(update);
  return type === 'group' || type === 'supergroup' || type === 'channel';
}
