import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, type TenantContext } from '@nexa/contracts';
import {
  classify,
  classifyPin,
  TelegramBroadcastTransport,
} from '../../apps/api/src/modules/commerce/broadcasts/infrastructure/telegram-broadcast.transport';

/**
 * The broadcast transport (round N): the operator's RAW body rendered against the explicit
 * placeholder catalogue, wrapped in the tenant's template, and Telegram's answers kept apart
 * — a 429 is not an unknown outcome, a blocked chat is not a refusal, a dead token is the bot.
 */

const scope = {
  tenantId: '01900000-0000-7000-8000-000000000001',
  botInstanceId: null,
} as never as TenantContext;

describe('classify', () => {
  it('keeps the four outcomes apart', () => {
    expect(
      classify({ outcome: 'SUCCEEDED', messageId: 1, file: { fileId: 'F', fileUniqueId: 'U' } }),
    ).toEqual({
      outcome: 'SENT',
      fileId: 'F',
      // Round N close: the delivered message's id, kept for the pin.
      messageId: 1,
    });
    expect(
      classify({
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'telegram.rate_limited',
        errorMessage: 'Too Many Requests',
        retryAfterMs: 7000,
      }),
    ).toEqual({ outcome: 'RATE_LIMITED', retryAfterMs: 7000 });
    // A 429 without retry_after is still a rate limit, never an unknown outcome.
    expect(
      classify({
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'telegram.rate_limited',
        errorMessage: 'x',
      }),
    ).toEqual({ outcome: 'RATE_LIMITED' });
    expect(
      classify({
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'telegram.server_error.502',
        errorMessage: 'x',
      }),
    ).toEqual({ outcome: 'UNKNOWN', errorCode: 'telegram.server_error.502' });
    expect(
      classify({
        outcome: 'FAILED_PERMANENT',
        errorCode: 'telegram.rejected.403',
        errorMessage: 'Forbidden: bot was blocked by the user',
      }),
    ).toEqual({ outcome: 'UNREACHABLE', errorCode: 'telegram.rejected.403' });
    expect(
      classify({
        outcome: 'FAILED_PERMANENT',
        errorCode: 'telegram.rejected.400',
        errorMessage: 'Bad Request: chat not found',
      }),
    ).toEqual({ outcome: 'UNREACHABLE', errorCode: 'telegram.rejected.400' });
    expect(
      classify({
        outcome: 'FAILED_PERMANENT',
        errorCode: 'telegram.rejected.400',
        errorMessage: 'Bad Request: wrong file identifier',
      }),
    ).toEqual({ outcome: 'REFUSED', errorCode: 'telegram.rejected.400' });
    expect(
      classify({
        outcome: 'FAILED_PERMANENT',
        errorCode: 'telegram.rejected.401',
        errorMessage: 'x',
      }),
    ).toEqual({ outcome: 'BOT_UNAVAILABLE', errorCode: 'telegram.rejected.401' });
  });
});

describe('TelegramBroadcastTransport', () => {
  let server: Server;
  let base: string;
  const received: { path: string; contentType: string; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          path: request.url ?? '',
          contentType: String(request.headers['content-type'] ?? ''),
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 9, video: { file_id: 'VID', file_unique_id: 'VU' } },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const transport = () =>
    new TelegramBroadcastTransport(
      // The tenant's wrapper: a header around the operator's own text.
      { render: async (_scope, _key, values) => `📣\n${String(values.message)}` },
      { tokenForBotInstance: async () => 'TOKEN' },
      base,
      2_000,
    );

  it('renders the catalogue placeholders for the recipient, drops what is absent, and wraps it', async () => {
    const result = await transport().render(scope, {
      contentKind: 'TEXT',
      body: 'سلام {firstName}\nموجودی: {walletBalance}\n@{username}',
      facts: { firstName: 'Sara', username: null, walletBalance: money(125_000n, 'IRT') },
      buttons: [],
      source: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rendered.text.startsWith('📣\nسلام Sara\n')).toBe(true);
    expect(result.rendered.text).not.toContain('{username}');
    expect(result.rendered.text).not.toContain('{walletBalance}');
  });

  it('refuses a caption Telegram would refuse, before any request', async () => {
    const result = await transport().render(scope, {
      contentKind: 'PHOTO',
      body: 'x'.repeat(1100),
      facts: { firstName: null, username: null, walletBalance: null },
      buttons: [],
      source: null,
    });
    expect(result).toEqual({ ok: false, errorCode: 'broadcast.caption_over_bound' });
  });

  it('sends a text with URL buttons, a video by file_id and a video by upload', async () => {
    received.length = 0;
    const t = transport();
    const text = await t.deliver(scope, {
      chatId: '42',
      botInstanceId: 'bot',
      rendered: {
        contentKind: 'TEXT',
        text: 'hi',
        buttons: [{ label: 'Go', url: 'https://example.test' }],
        source: null,
      },
      media: null,
    });
    expect(text.outcome).toBe('SENT');
    expect(received[0]?.path).toBe('/botTOKEN/sendMessage');
    expect(JSON.parse(received[0]?.body ?? '{}')).toMatchObject({
      chat_id: '42',
      text: 'hi',
      reply_markup: { inline_keyboard: [[{ text: 'Go', url: 'https://example.test' }]] },
    });
    expect(JSON.parse(received[0]?.body ?? '{}')).not.toHaveProperty('parse_mode');

    await t.deliver(scope, {
      chatId: '42',
      botInstanceId: 'bot',
      rendered: { contentKind: 'VIDEO', text: 'cap', buttons: [], source: null },
      media: { kind: 'FILE_ID', fileId: 'VID' },
    });
    expect(received[1]?.path).toBe('/botTOKEN/sendVideo');
    expect(JSON.parse(received[1]?.body ?? '{}')).toMatchObject({ video: 'VID', caption: 'cap' });

    const upload = await t.deliver(scope, {
      chatId: '42',
      botInstanceId: 'bot',
      rendered: { contentKind: 'VIDEO', text: '', buttons: [], source: null },
      media: {
        kind: 'BYTES',
        bytes: new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]),
        fileName: 'v.mp4',
        mimeType: 'video/mp4',
      },
    });
    expect(received[2]?.contentType).toContain('multipart/form-data');
    expect(received[2]?.body).toContain('name="video"; filename="v.mp4"');
    // The handle Telegram gave the uploaded video is what later recipients are sent.
    expect(upload).toEqual({ outcome: 'SENT', fileId: 'VID', messageId: 9 });
  });

  /*
   * Round N close (§C): the Bot API 10.3 shapes. `forwardMessage(chat_id, from_chat_id,
   * message_id)` takes no `reply_markup`; `copyMessage` takes the same three and an inline
   * keyboard; `pinChatMessage(chat_id, message_id, disable_notification)`.
   */
  it('forwards and copies a source message by chat id and message id, and pins by message id', async () => {
    received.length = 0;
    const t = transport();
    const source = { chatId: '-1001234567890', messageId: 42 };
    const forwarded = await t.deliver(scope, {
      chatId: '42',
      botInstanceId: 'bot',
      rendered: { contentKind: 'FORWARD', text: '', buttons: [], source },
      media: null,
    });
    expect(forwarded).toEqual({ outcome: 'SENT', fileId: 'VID', messageId: 9 });
    expect(received[0]?.path).toBe('/botTOKEN/forwardMessage');
    expect(JSON.parse(received[0]?.body ?? '{}')).toEqual({
      chat_id: '42',
      from_chat_id: '-1001234567890',
      message_id: 42,
    });

    await t.deliver(scope, {
      chatId: '42',
      botInstanceId: 'bot',
      rendered: {
        contentKind: 'COPY',
        text: '',
        buttons: [{ label: 'Go', url: 'https://example.test' }],
        source,
      },
      media: null,
    });
    expect(received[1]?.path).toBe('/botTOKEN/copyMessage');
    expect(JSON.parse(received[1]?.body ?? '{}')).toEqual({
      chat_id: '42',
      from_chat_id: '-1001234567890',
      message_id: 42,
      reply_markup: { inline_keyboard: [[{ text: 'Go', url: 'https://example.test' }]] },
    });

    const pinned = await t.pin(scope, { chatId: '42', botInstanceId: 'bot', messageId: 9 });
    expect(pinned).toEqual({ outcome: 'PINNED' });
    expect(received[2]?.path).toBe('/botTOKEN/pinChatMessage');
    expect(JSON.parse(received[2]?.body ?? '{}')).toEqual({
      chat_id: '42',
      message_id: 9,
      disable_notification: true,
    });

    // Rendering a sourced kind renders nothing and refuses buttons on a FORWARD.
    const facts = { firstName: null, username: null, walletBalance: null };
    expect(
      await t.render(scope, {
        contentKind: 'FORWARD',
        body: '',
        facts,
        buttons: [{ label: 'x', url: 'https://example.test' }],
        source,
      }),
    ).toEqual({ ok: false, errorCode: 'broadcast.source_content_invalid' });
    expect(
      await t.render(scope, { contentKind: 'COPY', body: '', facts, buttons: [], source }),
    ).toEqual({ ok: true, rendered: { contentKind: 'COPY', text: '', buttons: [], source } });
    expect(
      await t.render(scope, { contentKind: 'COPY', body: '', facts, buttons: [], source: null }),
    ).toEqual({ ok: false, errorCode: 'broadcast.source_required' });
  });

  it('keeps a pin’s three outcomes apart, and a rate-limited pin is that attempt’s failure', () => {
    expect(classifyPin({ outcome: 'SUCCEEDED', messageId: null })).toEqual({ outcome: 'PINNED' });
    expect(
      classifyPin({
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'telegram.server_error.502',
        errorMessage: 'x',
      }),
    ).toEqual({ outcome: 'UNKNOWN', errorCode: 'telegram.server_error.502' });
    // One attempt only: a 429 does not hold the bot and is never retried.
    expect(
      classifyPin({
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'telegram.rate_limited',
        errorMessage: 'x',
        retryAfterMs: 5000,
      }),
    ).toEqual({ outcome: 'FAILED', errorCode: 'telegram.rate_limited' });
    expect(
      classifyPin({
        outcome: 'FAILED_PERMANENT',
        errorCode: 'telegram.rejected.400',
        errorMessage: 'Bad Request: not enough rights',
      }),
    ).toEqual({ outcome: 'FAILED', errorCode: 'telegram.rejected.400' });
  });

  it('answers BOT_UNAVAILABLE without a request when the bot has no token', async () => {
    received.length = 0;
    const t = new TelegramBroadcastTransport(
      { render: async () => 'x' },
      { tokenForBotInstance: async () => null },
      base,
      2_000,
    );
    const result = await t.deliver(scope, {
      chatId: '42',
      botInstanceId: 'bot',
      rendered: { contentKind: 'TEXT', text: 'x', buttons: [], source: null },
      media: null,
    });
    expect(result).toEqual({ outcome: 'BOT_UNAVAILABLE', errorCode: 'broadcast.no_bot' });
    expect(received).toHaveLength(0);
  });
});
