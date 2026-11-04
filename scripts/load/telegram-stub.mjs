// A local stand-in for the Telegram Bot API, for the load harness. The API and worker
// processes are pointed at it with TELEGRAM_API_BASE_URL, so no request leaves the machine.
//
// Every call is `POST /bot<token>/<method>`; the answer is `{ ok: true, result }`. A method
// that returns a Message (send*, edit*, copy*) gets one; `getMe` gets a bot user; everything
// else (`answerCallbackQuery`, `setWebhook`, `deleteMessage`, ...) answers `true`.
//
// What the harness reads back from it:
//   - the inline keyboard of the last message each chat was shown, so a virtual customer
//     taps the buttons the bot really drew (no callback_data is hard-coded in the driver);
//   - counters per method, and the service time it added (the configured latency stands in
//     for the round trip to Telegram, which the webhook response time includes: the bot
//     replies before it answers 200).
import { createServer } from 'node:http';

const MESSAGE_METHODS = new Set([
  'sendMessage',
  'sendPhoto',
  'sendVideo',
  'sendDocument',
  'sendAnimation',
  'copyMessage',
  'forwardMessage',
  'editMessageText',
  'editMessageCaption',
  'editMessageReplyMarkup',
]);

export async function startTelegramStub({
  latencyMs = 40,
  jitterMs = 20,
  port = 0,
  host = '127.0.0.1',
} = {}) {
  const lastKeyboard = new Map(); // chat_id -> inline_keyboard rows of the last message drawn
  const replyKeyboard = new Map(); // chat_id -> the persistent reply keyboard (rows of labels)
  const lastText = new Map();
  const calls = new Map(); // method -> count
  const perBotSends = new Map(); // token -> count of message-creating calls
  const recent = []; // the last few calls, for debugging a flow
  let messageSeq = 1000;
  let total = 0;
  let unknownTokenShapes = 0;

  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(request.url ?? '');
      if (request.method !== 'POST' || match === null) {
        unknownTokenShapes += 1;
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }));
        return;
      }
      const token = decodeURIComponent(match[1]);
      const method = match[2];
      let body = {};
      const raw = Buffer.concat(chunks).toString('utf8');
      if ((request.headers['content-type'] ?? '').includes('json')) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = {};
        }
      }
      total += 1;
      recent.push({ method, body });
      if (recent.length > 40) recent.shift();
      calls.set(method, (calls.get(method) ?? 0) + 1);

      let result = true;
      const chatId = body.chat_id !== undefined ? String(body.chat_id) : null;
      if (method === 'getMe') {
        result = {
          id: Number(token.split(':')[0]) || 1,
          is_bot: true,
          first_name: 'Load',
          username: 'load_bot',
        };
      } else if (MESSAGE_METHODS.has(method)) {
        messageSeq += 1;
        if (!method.startsWith('edit')) perBotSends.set(token, (perBotSends.get(token) ?? 0) + 1);
        result = {
          message_id:
            method.startsWith('edit') && body.message_id ? Number(body.message_id) : messageSeq,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId === null ? 0 : Number(chatId), type: 'private' },
          text: typeof body.text === 'string' ? body.text : undefined,
        };
        if (chatId !== null) {
          const markup = body.reply_markup;
          if (markup && Array.isArray(markup.keyboard)) {
            replyKeyboard.set(
              chatId,
              markup.keyboard.map((row) => row.map((b) => (typeof b === 'string' ? b : b.text))),
            );
          }
          if (markup && Array.isArray(markup.inline_keyboard))
            lastKeyboard.set(chatId, markup.inline_keyboard);
          else if (method !== 'editMessageText' && method !== 'editMessageReplyMarkup')
            lastKeyboard.delete(chatId);
          if (typeof body.text === 'string') lastText.set(chatId, body.text);
        }
      }
      const delay = Math.max(0, latencyMs + (Math.random() * 2 - 1) * jitterMs);
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result }));
      }, delay);
    });
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  return {
    url: `http://${host}:${address.port}`,
    recent: () => recent,
    replyKeyboardOf: (chatId) => replyKeyboard.get(String(chatId)) ?? null,
    keyboardOf: (chatId) => lastKeyboard.get(String(chatId)) ?? null,
    textOf: (chatId) => lastText.get(String(chatId)) ?? null,
    stats: () => ({
      total,
      unknownRequests: unknownTokenShapes,
      byMethod: Object.fromEntries(calls),
      messageCreatingCallsByBot: perBotSends.size,
    }),
    messagesCreated: () => [...perBotSends.values()].reduce((a, b) => a + b, 0),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}
