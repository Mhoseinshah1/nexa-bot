import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * A stand-in for the Telegram Bot API's bot-identity and webhook methods, over real HTTP
 * (R4, item 12). The app is pointed at it through `TELEGRAM_API_BASE_URL`, so the call
 * core, the gateway and the service all run unchanged — the same pattern as the Stars and
 * ops-group suites' recording fakes.
 *
 * FAITHFUL TO THE DOCUMENTED BOT API, and that is the point of it
 * (https://core.telegram.org/bots/api — `getMe`, `setWebhook`, `getWebhookInfo`,
 * `deleteWebhook`; CLAUDE.md: a fake this repository wrote can only prove it agrees with
 * an adapter this repository wrote, so it copies the documented shapes, not the adapter):
 *
 *  - every call is `POST /bot<token>/<method>`, answered `{ ok, result }` or
 *    `{ ok: false, error_code, description }`; an unknown or revoked token is HTTP 401
 *    `Unauthorized`, an unknown method 404 `Not Found`;
 *  - `getMe` answers a `User` with `is_bot: true`;
 *  - `setWebhook` REPLACES the registration, keeps `allowed_updates` when the field is
 *    omitted, treats an empty list as the default set, refuses a non-https URL with
 *    `Bad Request: bad webhook: An HTTPS URL must be provided for webhook`, and discards
 *    the queue only on `drop_pending_updates: true`;
 *  - `getWebhookInfo` answers `url: ""` when no webhook is set, and carries
 *    `max_connections`, `last_error_*` and `allowed_updates` only when they apply. It
 *    never reports the `secret_token` — Telegram does not — so the fake keeps it where
 *    only a test can read it (`registration`);
 *  - `deleteWebhook` answers `result: true` whether or not one was set.
 *
 * Round T (T2) adds `sendMessage`, for the customer reply keyboard. Documented and modelled:
 * a `ReplyKeyboardMarkup` of `KeyboardButton`s whose `style`, when present, is one of
 * `primary`, `success`, `danger` (Bot API 9.4, `OQ-T-API-01`), and whose
 * `icon_custom_emoji_id` is honoured only for a bot able to use custom emoji
 * (`OQ-T-API-02`; a new fake bot accepts them until `setCustomEmoji` says otherwise). NOT
 * documented, so never decided here: the exact description Telegram gives an ineligible bot's
 * icon — a PARAMETER of `setCustomEmoji` every refusing test states — and the description of
 * a malformed keyboard, which is the fake's OWN wording (`FAKE_KEYBOARD_INVALID`, marked as
 * such). Every message accepted is kept (`delivered`), so a test can count what LANDED —
 * which is the only honest way to assert "never sent twice".
 *
 * Roadmap D2 adds `sendPhoto`/`sendVideo`/`sendDocument` BY `file_id` and
 * `copyMessage`/`forwardMessage`, each answering for ONE bot: a `file_id` is valid only for
 * the bot that received it (documented: "file_id is unique for each individual bot and can't
 * be transferred from one bot to another"), and a copy reads only a chat this bot can read.
 * The refusals' sentences are the fake's own (`FAKE_WRONG_FILE`, `FAKE_SOURCE_CHAT_UNREADABLE`).
 *
 * What the Bot API does NOT document is not decided here. Whether a BotFather revocation
 * keeps the bot's webhook (`OQ-WP13-02`) is a parameter every caller of `revoke` must
 * state, never a default.
 */

interface BotState {
  readonly id: number;
  username: string;
  token: string;
  webhook: {
    url: string;
    secretToken: string | null;
    allowedUpdates: string[] | null;
    maxConnections: number;
  } | null;
  pendingUpdateCount: number;
  lastError: { readonly date: number; readonly message: string } | null;
  /**
   * Round P — the command list Telegram holds for the default scope and language, as
   * `setMyCommands` last set it. Empty until then, which is what `getMyCommands` answers
   * for a bot nobody gave a menu. Kept across `revoke`: the Bot API documents the list per
   * bot, not per token.
   */
  commands: { readonly command: string; readonly description: string }[];
  /**
   * Round T (T2): whether this bot may use custom emoji — an `icon_custom_emoji_id` on a
   * keyboard button, or a `custom_emoji` entity. `ACCEPT`, or `REFUSE` with the description
   * the test states (Telegram's exact sentence for an ineligible bot is undocumented).
   */
  customEmoji: FakeCustomEmojiAnswer;
  /** Every `sendMessage` this bot accepted, in order. */
  delivered: FakeDeliveredMessage[];
  /**
   * Roadmap D2: the `file_id`s THIS bot may send. The Bot API: "file_id is unique for each
   * individual bot and can't be transferred from one bot to another" — so a handle another
   * bot received is refused here even though it is a perfectly good handle.
   */
  files: Set<string>;
  /** Roadmap D2: the chats whose messages THIS bot can read, for `copyMessage`/`forwardMessage`. */
  readableChats: Set<string>;
  /** Roadmap D2: every media send, copy or forward this bot accepted, in order. */
  sentMedia: FakeSentMedia[];
}

/** Roadmap D2: one `sendPhoto`/`sendVideo`/`sendDocument`/`copyMessage`/`forwardMessage` accepted. */
export interface FakeSentMedia {
  readonly method: string;
  readonly messageId: number;
  readonly chatId: string;
  /** The `file_id` sent, or `<from_chat_id>:<message_id>` for a copy or forward. */
  readonly source: string;
}

/**
 * The fake's OWN wording for a `file_id` the sending bot does not hold, and for a source chat
 * the bot cannot read. The REFUSAL (a 400) is documented; these sentences are not asserted by
 * any test — they are marked as the fake's so nobody mistakes them for Telegram's.
 */
export const FAKE_WRONG_FILE = 'Bad Request: wrong file identifier/HTTP URL specified (fake)';
export const FAKE_SOURCE_CHAT_UNREADABLE = 'Bad Request: chat not found (fake)';

/** Round T (T2): how the fake answers a custom emoji from one bot. */
export type FakeCustomEmojiAnswer =
  { readonly kind: 'ACCEPT' } | { readonly kind: 'REFUSE'; readonly description: string };

/** One message the fake accepted: what the chat would now show. */
export interface FakeDeliveredMessage {
  readonly messageId: number;
  readonly chatId: string;
  readonly text: string;
  readonly replyMarkup: unknown;
  readonly entities: unknown;
}

/** `KeyboardButton.style` — exactly these (Bot API 9.4). */
const KEYBOARD_BUTTON_STYLES: readonly string[] = ['primary', 'success', 'danger'];
/** The `KeyboardButton` fields this installation may send; anything else is refused. */
const KEYBOARD_BUTTON_FIELDS: readonly string[] = ['text', 'style', 'icon_custom_emoji_id'];
/**
 * The fake's OWN wording for a malformed keyboard — a generic 400 that names no custom emoji.
 * Not Telegram's sentence; real acceptance (audit §13, R-ACC-1/2) records the real one.
 */
export const FAKE_KEYBOARD_INVALID = 'Bad Request: keyboard button is invalid (fake)';

/** The Bot API's documented bounds on a `BotCommand` (Bot API §BotCommand). */
const COMMAND_PATTERN = /^[a-z0-9_]{1,32}$/u;
const DESCRIPTION_MAX = 256;

export interface FakeTelegramCall {
  readonly method: string;
  /** Which bot the token named, or null for an unknown one. Never the token itself. */
  readonly botId: number | null;
  readonly body: Record<string, unknown>;
}

/**
 * What the next call of a method does instead of its documented answer.
 *
 *  - `server_error` — HTTP 500, nothing applied (Telegram's own outage);
 *  - `drop` — the connection is destroyed before any answer, nothing applied;
 *  - `apply_then_drop` — the change IS applied and the answer is lost: the ambiguous
 *    outcome a timeout produces;
 *  - `refuse` — HTTP 400 with the given description, nothing applied;
 *  - `rate_limit` — HTTP 429 naming `retry_after`, nothing applied;
 *  - `ok_without_applying` — `{ ok: true }` and nothing applied (a registration that
 *    something else replaced the instant after).
 */
export type FakeTelegramFault =
  | { readonly kind: 'server_error' }
  | { readonly kind: 'drop' }
  | { readonly kind: 'apply_then_drop' }
  | { readonly kind: 'refuse'; readonly description: string }
  /** HTTP 429 with `parameters.retry_after` (seconds), nothing applied. */
  | { readonly kind: 'rate_limit'; readonly retryAfter: number }
  | { readonly kind: 'ok_without_applying' }
  /**
   * Round T (T2): the change IS applied and the answer is HTTP 200 with a body that is not
   * JSON — the unreadable 2xx, which may well mean the message landed.
   */
  | { readonly kind: 'apply_then_garble' };

export interface FakeTelegramBotApi {
  readonly url: string;
  readonly calls: FakeTelegramCall[];
  /** A bot BotFather created; answers its (only) valid token. */
  createBot(input: { readonly id: number; readonly username: string }): string;
  /**
   * BotFather `/revoke`: a new token, and the old one answers 401 from now on. Whether the
   * webhook survives is the CALLER's statement (`OQ-WP13-02`).
   */
  revoke(botId: number, options: { readonly keepWebhook: boolean }): string;
  /** A registration made outside this installation (another system, a legacy install). */
  setWebhookDirectly(
    botId: number,
    webhook: { readonly url: string; readonly allowedUpdates?: string[] } | null,
  ): void;
  /** What Telegram holds, INCLUDING the secret it never reports. For assertions only. */
  registration(botId: number): BotState['webhook'];
  /** Round P: the command list Telegram holds for this bot. For assertions only. */
  registeredCommands(botId: number): readonly { command: string; description: string }[];
  setPending(botId: number, pending: number, lastError?: string): void;
  /** Round T (T2): how this bot's custom emoji are answered from now on. */
  setCustomEmoji(botId: number, answer: FakeCustomEmojiAnswer): void;
  /** Round T (T2): every message this bot accepted, in order. For assertions only. */
  delivered(botId: number): readonly FakeDeliveredMessage[];
  /** Roadmap D3: BotFather `/setusername` — same bot id and token, a new username. */
  rename(botId: number, username: string): void;
  /** Roadmap D2: this bot received the file `fileId` (and may therefore send it). */
  giveFile(botId: number, fileId: string): void;
  /** Roadmap D2: this bot can read the messages of `chatId` (a member of that channel). */
  letRead(botId: number, chatId: string): void;
  /** Roadmap D2: every media send, copy or forward this bot accepted. For assertions only. */
  sentMedia(botId: number): readonly FakeSentMedia[];
  /** The next call of `method` misbehaves once. */
  failNext(method: string, fault: FakeTelegramFault): void;
  /** Every call of `method` waits until the returned function is called. */
  hold(method: string): { readonly release: () => void; readonly reached: Promise<void> };
  /** A hook run before the next call of `method` is answered (and before it applies). */
  beforeNext(method: string, hook: () => Promise<void> | void): void;
  close(): Promise<void>;
}

const DOCUMENTED_WEBHOOK_MAX_CONNECTIONS = 40;

export async function startFakeTelegramBotApi(): Promise<FakeTelegramBotApi> {
  const bots = new Map<number, BotState>();
  const calls: FakeTelegramCall[] = [];
  const faults = new Map<string, FakeTelegramFault[]>();
  const holds = new Map<string, { readonly gate: Promise<void>; readonly arrived: () => void }>();
  const hooks = new Map<string, Array<() => Promise<void> | void>>();
  let serial = 0;
  let messageSerial = 0;

  const mint = (id: number): string => {
    serial += 1;
    return `${String(id)}:FAKE${String(serial).padStart(4, '0')}${'x'.repeat(31)}`;
  };
  const byToken = (token: string): BotState | null => {
    for (const bot of bots.values()) if (bot.token === token) return bot;
    return null;
  };
  const require = (botId: number): BotState => {
    const bot = bots.get(botId);
    if (bot === undefined) throw new Error(`no fake bot ${String(botId)}`);
    return bot;
  };

  const send = (response: ServerResponse, status: number, payload: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  };
  const ok = (response: ServerResponse, result: unknown, description?: string) =>
    send(response, 200, { ok: true, result, ...(description ? { description } : {}) });
  const fail = (response: ServerResponse, code: number, description: string) =>
    send(response, code, { ok: false, error_code: code, description });

  /** Applies a documented method to a bot, and answers what the Bot API answers. */
  const apply = (
    bot: BotState,
    method: string,
    body: Record<string, unknown>,
  ): { status: number; payload: unknown } => {
    switch (method) {
      case 'getMe':
        return {
          status: 200,
          payload: {
            ok: true,
            result: {
              id: bot.id,
              is_bot: true,
              first_name: bot.username,
              username: bot.username,
              can_join_groups: true,
              can_read_all_group_messages: false,
              supports_inline_queries: false,
              can_connect_to_business: false,
              has_main_web_app: false,
            },
          },
        };
      case 'setWebhook': {
        const url = typeof body.url === 'string' ? body.url : '';
        if (url === '') {
          // The documented way to remove one: an empty url.
          bot.webhook = null;
          return {
            status: 200,
            payload: { ok: true, result: true, description: 'Webhook was deleted' },
          };
        }
        if (!url.startsWith('https://')) {
          return {
            status: 400,
            payload: {
              ok: false,
              error_code: 400,
              description: 'Bad Request: bad webhook: An HTTPS URL must be provided for webhook',
            },
          };
        }
        const allowed = Array.isArray(body.allowed_updates)
          ? (body.allowed_updates as unknown[]).filter((v): v is string => typeof v === 'string')
          : undefined;
        const previous = bot.webhook;
        bot.webhook = {
          url,
          secretToken: typeof body.secret_token === 'string' ? body.secret_token : null,
          // Omitted: the previous list stays. Empty: the default set.
          allowedUpdates:
            allowed === undefined
              ? (previous?.allowedUpdates ?? null)
              : allowed.length === 0
                ? null
                : allowed,
          maxConnections:
            typeof body.max_connections === 'number'
              ? body.max_connections
              : DOCUMENTED_WEBHOOK_MAX_CONNECTIONS,
        };
        if (body.drop_pending_updates === true) bot.pendingUpdateCount = 0;
        return {
          status: 200,
          payload: {
            ok: true,
            result: true,
            description: previous?.url === url ? 'Webhook is already set' : 'Webhook was set',
          },
        };
      }
      case 'deleteWebhook': {
        const had = bot.webhook !== null;
        bot.webhook = null;
        if (body.drop_pending_updates === true) bot.pendingUpdateCount = 0;
        return {
          status: 200,
          payload: {
            ok: true,
            result: true,
            description: had ? 'Webhook was deleted' : 'Webhook is already deleted',
          },
        };
      }
      case 'getWebhookInfo': {
        const hook = bot.webhook;
        return {
          status: 200,
          payload: {
            ok: true,
            result: {
              url: hook?.url ?? '',
              has_custom_certificate: false,
              pending_update_count: bot.pendingUpdateCount,
              ...(hook === null
                ? {}
                : {
                    ip_address: '203.0.113.10',
                    max_connections: hook.maxConnections,
                    ...(hook.allowedUpdates === null
                      ? {}
                      : { allowed_updates: hook.allowedUpdates }),
                  }),
              ...(bot.lastError === null
                ? {}
                : {
                    last_error_date: bot.lastError.date,
                    last_error_message: bot.lastError.message,
                  }),
            },
          },
        };
      }
      case 'setMyCommands': {
        /*
         * Round P. The documented bounds: an array of at most 100 `BotCommand`s, each
         * command 1–32 lowercase letters, digits and underscores, each description 1–256
         * characters. Anything else is a 400 the way Telegram answers one, and applies
         * nothing. `scope` and `language_code` are accepted and ignored: this installation
         * sends neither, so the default scope is the only one modelled.
         */
        const list = body.commands;
        if (!Array.isArray(list) || list.length > 100) {
          return {
            status: 400,
            payload: {
              ok: false,
              error_code: 400,
              description: 'Bad Request: commands is invalid',
            },
          };
        }
        const parsed: { command: string; description: string }[] = [];
        for (const entry of list as unknown[]) {
          const { command, description } = (entry ?? {}) as Record<string, unknown>;
          if (
            typeof command !== 'string' ||
            !COMMAND_PATTERN.test(command) ||
            typeof description !== 'string' ||
            description.length === 0 ||
            description.length > DESCRIPTION_MAX
          ) {
            return {
              status: 400,
              payload: {
                ok: false,
                error_code: 400,
                description: 'Bad Request: BOT_COMMAND_INVALID',
              },
            };
          }
          parsed.push({ command, description });
        }
        bot.commands = parsed;
        return { status: 200, payload: { ok: true, result: true } };
      }
      case 'sendMessage': {
        const badRequest = (description: string) => ({
          status: 400,
          payload: { ok: false, error_code: 400, description },
        });
        const chatId = body.chat_id;
        if (typeof chatId !== 'string' && typeof chatId !== 'number') {
          return badRequest('Bad Request: chat not found');
        }
        if (typeof body.text !== 'string' || body.text.length === 0) {
          return badRequest('Bad Request: message text is empty');
        }
        let customEmoji = false;
        const markup = body.reply_markup as Record<string, unknown> | undefined;
        if (markup !== undefined && Array.isArray(markup.keyboard)) {
          for (const row of markup.keyboard as unknown[]) {
            if (!Array.isArray(row)) return badRequest(FAKE_KEYBOARD_INVALID);
            for (const cell of row as unknown[]) {
              if (typeof cell !== 'object' || cell === null) {
                return badRequest(FAKE_KEYBOARD_INVALID);
              }
              const button = cell as Record<string, unknown>;
              if (Object.keys(button).some((key) => !KEYBOARD_BUTTON_FIELDS.includes(key))) {
                return badRequest(FAKE_KEYBOARD_INVALID);
              }
              if (typeof button.text !== 'string' || button.text.length === 0) {
                return badRequest(FAKE_KEYBOARD_INVALID);
              }
              if (
                'style' in button &&
                (typeof button.style !== 'string' || !KEYBOARD_BUTTON_STYLES.includes(button.style))
              ) {
                return badRequest(FAKE_KEYBOARD_INVALID);
              }
              if ('icon_custom_emoji_id' in button) {
                if (
                  typeof button.icon_custom_emoji_id !== 'string' ||
                  !/^[0-9]{1,32}$/u.test(button.icon_custom_emoji_id)
                ) {
                  return badRequest(FAKE_KEYBOARD_INVALID);
                }
                customEmoji = true;
              }
            }
          }
        }
        /*
         * Phase 2 Item 3: an `InlineKeyboardButton` may carry `icon_custom_emoji_id` too
         * (`@grammyjs/types` `InlineKeyboardButton`, Bot API 9.4) — honoured, like the reply
         * keyboard's, only for a bot able to use custom emoji. Only the icon is modelled here;
         * the rest of an inline keyboard is passed through as before.
         */
        if (markup !== undefined && Array.isArray(markup.inline_keyboard)) {
          for (const row of markup.inline_keyboard as unknown[]) {
            if (!Array.isArray(row)) return badRequest(FAKE_KEYBOARD_INVALID);
            for (const cell of row as unknown[]) {
              const button = (cell ?? {}) as Record<string, unknown>;
              if (!('icon_custom_emoji_id' in button)) continue;
              if (
                typeof button.icon_custom_emoji_id !== 'string' ||
                !/^[0-9]{1,32}$/u.test(button.icon_custom_emoji_id)
              ) {
                return badRequest(FAKE_KEYBOARD_INVALID);
              }
              customEmoji = true;
            }
          }
        }
        if (
          Array.isArray(body.entities) &&
          (body.entities as { type?: unknown }[]).some((entity) => entity?.type === 'custom_emoji')
        ) {
          customEmoji = true;
        }
        if (customEmoji && bot.customEmoji.kind === 'REFUSE') {
          return badRequest(bot.customEmoji.description);
        }
        messageSerial += 1;
        bot.delivered.push({
          messageId: messageSerial,
          chatId: String(chatId),
          text: body.text,
          replyMarkup: body.reply_markup ?? null,
          entities: body.entities ?? null,
        });
        return {
          status: 200,
          payload: {
            ok: true,
            result: {
              message_id: messageSerial,
              date: 1_790_000_000,
              chat: { id: Number(chatId), type: 'private' },
              text: body.text,
            },
          },
        };
      }
      case 'sendPhoto':
      case 'sendVideo':
      case 'sendDocument': {
        // Roadmap D2: by `file_id` only (a JSON body); an upload is not modelled here.
        const field =
          method === 'sendPhoto' ? 'photo' : method === 'sendVideo' ? 'video' : 'document';
        const fileId = body[field];
        if (typeof body.chat_id !== 'string' && typeof body.chat_id !== 'number') {
          return {
            status: 400,
            payload: { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
          };
        }
        if (typeof fileId !== 'string' || !bot.files.has(fileId)) {
          return {
            status: 400,
            payload: { ok: false, error_code: 400, description: FAKE_WRONG_FILE },
          };
        }
        messageSerial += 1;
        bot.sentMedia.push({
          method,
          messageId: messageSerial,
          chatId: String(body.chat_id),
          source: fileId,
        });
        return {
          status: 200,
          payload: {
            ok: true,
            result: {
              message_id: messageSerial,
              date: 1_790_000_000,
              chat: { id: Number(body.chat_id), type: 'private' },
              [field]:
                field === 'photo'
                  ? [{ file_id: fileId, file_unique_id: `u-${fileId}` }]
                  : { file_id: fileId, file_unique_id: `u-${fileId}` },
            },
          },
        };
      }
      case 'copyMessage':
      case 'forwardMessage': {
        const from = String(body.from_chat_id ?? '');
        if (!bot.readableChats.has(from)) {
          return {
            status: 400,
            payload: { ok: false, error_code: 400, description: FAKE_SOURCE_CHAT_UNREADABLE },
          };
        }
        messageSerial += 1;
        bot.sentMedia.push({
          method,
          messageId: messageSerial,
          chatId: String(body.chat_id),
          source: `${from}:${String(body.message_id)}`,
        });
        // `copyMessage` answers a MessageId; `forwardMessage` the Message. Both carry the id.
        return {
          status: 200,
          payload: {
            ok: true,
            result:
              method === 'copyMessage'
                ? { message_id: messageSerial }
                : {
                    message_id: messageSerial,
                    date: 1_790_000_000,
                    chat: { id: Number(body.chat_id), type: 'private' },
                  },
          },
        };
      }
      case 'getMyCommands':
        return {
          status: 200,
          payload: { ok: true, result: bot.commands.map((entry) => ({ ...entry })) },
        };
      default:
        return { status: 404, payload: { ok: false, error_code: 404, description: 'Not Found' } };
    }
  };

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const [, tokenPart = '', method = ''] = (request.url ?? '').split('/');
        const token = tokenPart.replace(/^bot/u, '');
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
            string,
            unknown
          >;
        } catch {
          body = {};
        }
        const bot = byToken(token);
        calls.push({ method, botId: bot?.id ?? null, body });

        const hook = hooks.get(method)?.shift();
        if (hook !== undefined) await hook();
        const held = holds.get(method);
        if (held !== undefined) {
          held.arrived();
          await held.gate;
        }

        if (bot === null) {
          fail(response, 401, 'Unauthorized');
          return;
        }
        const fault = faults.get(method)?.shift();
        if (fault !== undefined) {
          switch (fault.kind) {
            case 'server_error':
              fail(response, 500, 'Internal Server Error');
              return;
            case 'drop':
              request.socket.destroy();
              return;
            case 'apply_then_drop':
              apply(bot, method, body);
              request.socket.destroy();
              return;
            case 'refuse':
              fail(response, 400, fault.description);
              return;
            case 'rate_limit':
              send(response, 429, {
                ok: false,
                error_code: 429,
                description: 'Too Many Requests: retry after ' + String(fault.retryAfter),
                parameters: { retry_after: fault.retryAfter },
              });
              return;
            case 'ok_without_applying':
              ok(response, true, 'Webhook was set');
              return;
            case 'apply_then_garble':
              apply(bot, method, body);
              response.writeHead(200, { 'content-type': 'application/json' });
              response.end('{"ok":tr');
              return;
          }
        }
        const answer = apply(bot, method, body);
        send(response, answer.status, answer.payload);
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    calls,
    createBot({ id, username }) {
      const token = mint(id);
      bots.set(id, {
        id,
        username,
        token,
        webhook: null,
        pendingUpdateCount: 0,
        lastError: null,
        commands: [],
        customEmoji: { kind: 'ACCEPT' },
        delivered: [],
        files: new Set(),
        readableChats: new Set(),
        sentMedia: [],
      });
      return token;
    },
    revoke(botId, { keepWebhook }) {
      const bot = require(botId);
      bot.token = mint(botId);
      if (!keepWebhook) bot.webhook = null;
      return bot.token;
    },
    setWebhookDirectly(botId, webhook) {
      const bot = require(botId);
      bot.webhook =
        webhook === null
          ? null
          : {
              url: webhook.url,
              secretToken: 'someone-elses-secret',
              allowedUpdates: webhook.allowedUpdates ?? null,
              maxConnections: DOCUMENTED_WEBHOOK_MAX_CONNECTIONS,
            };
    },
    registration(botId) {
      const hook = require(botId).webhook;
      return hook === null ? null : { ...hook };
    },
    registeredCommands(botId) {
      return require(botId).commands.map((entry) => ({ ...entry }));
    },
    setPending(botId, pending, lastError) {
      const bot = require(botId);
      bot.pendingUpdateCount = pending;
      bot.lastError = lastError === undefined ? null : { date: 1_790_000_000, message: lastError };
    },
    setCustomEmoji(botId, answer) {
      require(botId).customEmoji = answer;
    },
    delivered(botId) {
      return [...require(botId).delivered];
    },
    rename(botId, username) {
      require(botId).username = username;
    },
    giveFile(botId, fileId) {
      require(botId).files.add(fileId);
    },
    letRead(botId, chatId) {
      require(botId).readableChats.add(chatId);
    },
    sentMedia(botId) {
      return [...require(botId).sentMedia];
    },
    failNext(method, fault) {
      const list = faults.get(method) ?? [];
      list.push(fault);
      faults.set(method, list);
    },
    hold(method) {
      let release: () => void = () => undefined;
      let arrived: () => void = () => undefined;
      // Resolves when the first held call ARRIVES, so a test can act while it waits.
      const reached = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = () => {
          holds.delete(method);
          resolve();
        };
      });
      holds.set(method, { gate, arrived });
      return { release, reached };
    },
    beforeNext(method, hook) {
      const list = hooks.get(method) ?? [];
      list.push(hook);
      hooks.set(method, list);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
