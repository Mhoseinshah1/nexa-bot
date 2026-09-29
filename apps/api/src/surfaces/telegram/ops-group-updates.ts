import { OPS_CONNECT_COMMAND, OPS_CONNECT_START_PREFIX } from '@nexa/contracts';

/**
 * WP-A4: the two shapes of update the operations log group reacts to, read strictly.
 *
 * Kept out of the controller for the reason `stars-updates.ts` is: they are the boundary's
 * parsing, and a function can be tested where a route handler cannot.
 */

/** A group message that carries a connection code. */
export interface OpsConnectAttempt {
  readonly chat: {
    readonly id: string;
    readonly type: string;
    readonly title: string | null;
    readonly isForum: boolean;
  };
  readonly rawCode: string;
}

/**
 * `/start ops-<code>` (what the `startgroup` deep link posts) or `/connect_ops <code>`,
 * with or without `@botname`, in a GROUP or SUPERGROUP chat. Null for anything else —
 * including the same text in a private chat, which is a customer's turn.
 */
export function opsConnectAttemptOf(update: unknown): OpsConnectAttempt | null {
  const message = (update as { message?: unknown } | null)?.message as
    | {
        text?: unknown;
        chat?: { id?: unknown; type?: unknown; title?: unknown; is_forum?: unknown };
      }
    | undefined;
  if (message === undefined || message === null) return null;
  const chat = message.chat;
  if (chat === undefined || chat === null) return null;
  if (chat.type !== 'group' && chat.type !== 'supergroup') return null;
  if (typeof chat.id !== 'number' || !Number.isSafeInteger(chat.id)) return null;
  if (typeof message.text !== 'string') return null;

  const match = /^\/([a-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?\s*$/u.exec(message.text.trim());
  if (match === null) return null;
  const [, command, argument] = match;
  if (command === 'start') {
    if (argument === undefined || !argument.toLowerCase().startsWith(OPS_CONNECT_START_PREFIX)) {
      return null;
    }
  } else if (command !== OPS_CONNECT_COMMAND) {
    return null;
  }
  return {
    chat: {
      id: String(chat.id),
      type: chat.type,
      title: typeof chat.title === 'string' ? chat.title : null,
      isForum: chat.is_forum === true,
    },
    // An empty argument is still an attempt, refused like any bad code.
    rawCode: argument ?? '',
  };
}

/** The bot's own membership in a chat changed (`my_chat_member`). */
export interface OpsMembershipChange {
  readonly chatId: string;
  readonly status: string;
}

export function opsMembershipChangeOf(update: unknown): OpsMembershipChange | null {
  const change = (update as { my_chat_member?: unknown } | null)?.my_chat_member as
    { chat?: { id?: unknown }; new_chat_member?: { status?: unknown } } | undefined;
  if (change === undefined || change === null) return null;
  const id = change.chat?.id;
  const status = change.new_chat_member?.status;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || typeof status !== 'string') {
    return null;
  }
  return { chatId: String(id), status };
}
