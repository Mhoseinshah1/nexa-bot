import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNexaError } from '@nexa/contracts';
import {
  TELEGRAM_CAPTION_MAX,
  TELEGRAM_MESSAGE_MAX,
} from '../../apps/api/src/modules/commerce/messaging/application/message-split';
import { TelegramCustomerMessenger } from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';

/**
 * What the customer messenger does with a body Telegram would refuse for its length, a
 * caption it would refuse for the same, a URL button, and a file that is bytes.
 *
 * `fetch` is stubbed the way `telegram-transport.test.ts` does it: the thing under
 * test is what the messenger asks the transport to send and how it reads what comes
 * back, so the honest fixture is a fake HTTP answer, not a fake transport.
 */

/**
 * Two keys the messenger reads the FORMAT of from the frozen catalogue: one HTML, one
 * plain. The fake renderer below returns whatever the test wants for either.
 */
const HTML_KEY = 'bot.admin.reminder_choose' as const;
const PLAIN_KEY = 'bot.admin.receipt' as const;

interface Call {
  readonly url: string;
  readonly body: Record<string, unknown> | null;
  readonly multipart: string | null;
}

function harness(rendered: Partial<Record<string, string>>, opsRecords: unknown[] = []) {
  const calls: Call[] = [];
  const messenger = new TelegramCustomerMessenger(
    {
      render: async (_scope: unknown, key: string) => rendered[key] ?? `label:${key}`,
    } as never,
    { tokenForBotInstance: async () => 'test-token' } as never,
    {
      record: async (_scope: unknown, event: unknown) => {
        opsRecords.push(event);
      },
    } as never,
    { conditionIsOpen: async () => false } as never,
    'https://telegram.invalid',
    1000,
  );
  /** Answers per call, in order; the last one repeats. */
  const respondWith = (answers: { status: number; body: unknown }[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string | Uint8Array }) => {
        const answer = answers[Math.min(calls.length, answers.length - 1)];
        if (answer === undefined) throw new Error('no answer scripted');
        calls.push({
          url,
          body:
            typeof init.body === 'string'
              ? (JSON.parse(init.body) as Record<string, unknown>)
              : null,
          multipart:
            typeof init.body === 'string' ? null : Buffer.from(init.body).toString('latin1'),
        });
        return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
      }),
    );
  return { messenger, calls, respondWith };
}

const scope = { tenantId: '01900000-0000-7000-8000-000000000001' } as never;
const botInstanceId = '01900000-0000-7000-8000-0000000000bb' as never;
const OK = { status: 200, body: { ok: true, result: { message_id: 1 } } };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a message over the Telegram bound', () => {
  const paragraphs = Array.from({ length: 6 }, (_, i) => `${i}-${'x'.repeat(1500)}`);
  const long = paragraphs.join('\n\n');

  it('goes out as several parts in order, buttons and keyboard on the last only', async () => {
    const { messenger, calls, respondWith } = harness({ [PLAIN_KEY]: long });
    respondWith([OK]);
    const result = await messenger.send(scope, {
      chatId: '42',
      botInstanceId,
      templateKey: PLAIN_KEY,
      values: {},
      buttons: [{ label: { kind: 'TEXT', text: 'go' }, data: 'g:1' }],
      keyboard: 'MAIN_MENU',
    });
    expect(result).toEqual({ outcome: 'DELIVERED' });
    expect(calls.length).toBeGreaterThan(1);
    const texts = calls.map((call) => call.body?.text as string);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX);
    expect(texts.join('\n\n')).toBe(long);
    calls.slice(0, -1).forEach((call) => expect(call.body).not.toHaveProperty('reply_markup'));
    expect(calls.at(-1)?.body).toMatchObject({
      reply_markup: { inline_keyboard: [[{ text: 'go', callback_data: 'g:1' }]] },
    });
  });

  it('stops after a part that did not certainly arrive and answers with the worst outcome', async () => {
    const { messenger, calls, respondWith } = harness({ [PLAIN_KEY]: long });
    respondWith([OK, { status: 502, body: { ok: false, description: 'Bad Gateway' } }, OK]);
    const message = { chatId: '42', botInstanceId, templateKey: PLAIN_KEY, values: {} } as const;
    expect(await messenger.send(scope, message)).toEqual({ outcome: 'UNKNOWN' });
    expect(calls).toHaveLength(2);

    calls.length = 0;
    respondWith([OK, { status: 429, body: { ok: false, parameters: { retry_after: 4 } } }, OK]);
    expect(await messenger.send(scope, message)).toEqual({
      outcome: 'RATE_LIMITED',
      retryAfterMs: 4000,
    });
    expect(calls).toHaveLength(2);

    calls.length = 0;
    respondWith([
      { status: 400, body: { ok: false, description: 'chat not found', error_code: 400 } },
    ]);
    expect(await messenger.send(scope, message)).toEqual({ outcome: 'REFUSED' });
    expect(calls).toHaveLength(1);
  });

  it('records one failure condition for the part that failed, and none for a rate limit', async () => {
    const records: { code: string; context: { reason: string } }[] = [];
    const { messenger, respondWith } = harness({ [PLAIN_KEY]: long }, records);
    respondWith([OK, { status: 502, body: { ok: false } }]);
    await messenger.send(scope, {
      chatId: '42',
      botInstanceId,
      templateKey: PLAIN_KEY,
      values: {},
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.context.reason).toBe('UNCERTAIN');

    records.length = 0;
    respondWith([{ status: 429, body: { ok: false } }]);
    await messenger.send(scope, {
      chatId: '42',
      botInstanceId,
      templateKey: PLAIN_KEY,
      values: {},
    });
    expect(records).toHaveLength(0);
  });

  it('sends a body within the bound as the one message it always was', async () => {
    const { messenger, calls, respondWith } = harness({ [PLAIN_KEY]: 'short' });
    respondWith([OK]);
    await messenger.send(scope, {
      chatId: '42',
      botInstanceId,
      templateKey: PLAIN_KEY,
      values: {},
      buttons: [{ label: { kind: 'TEXT', text: 'go' }, data: 'g:1' }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ text: 'short', reply_markup: expect.anything() });
  });
});

describe('a URL button', () => {
  it('is rendered with its label and url, unchanged', async () => {
    const { messenger, calls, respondWith } = harness({ [PLAIN_KEY]: 'body' });
    respondWith([OK]);
    const url = 'https://panel.example.net:8443/sub/ABCDEF?name=x#frag';
    await messenger.send(scope, {
      chatId: '42',
      botInstanceId,
      templateKey: PLAIN_KEY,
      values: {},
      buttons: [
        { label: { kind: 'TEXT', text: 'open' }, url, row: 0 },
        { label: { kind: 'TEXT', text: 'tg' }, url: 'tg://resolve?domain=x', row: 0 },
      ],
    });
    expect(calls[0]?.body).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'open', url },
            { text: 'tg', url: 'tg://resolve?domain=x' },
          ],
        ],
      },
    });
  });

  it('refuses any scheme but https and tg, and a string that is not a URL, before sending', async () => {
    const { messenger, calls, respondWith } = harness({ [PLAIN_KEY]: 'body' });
    respondWith([OK]);
    for (const bad of ['http://example.net/s', 'javascript:alert(1)', 'ftp://x', 'not a url', '']) {
      try {
        await messenger.send(scope, {
          chatId: '42',
          botInstanceId,
          templateKey: PLAIN_KEY,
          values: {},
          buttons: [{ label: { kind: 'TEXT', text: 'open' }, url: bad }],
        });
        expect.unreachable(`sent a button for ${bad}`);
      } catch (error) {
        expect(isNexaError(error) && error.kind === 'VALIDATION').toBe(true);
      }
    }
    expect(calls).toHaveLength(0);
  });
});

describe('a file with a caption', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  it('uploads bytes as multipart with the caption and buttons', async () => {
    const { messenger, calls, respondWith } = harness({ [HTML_KEY]: '<code>u</code>' });
    respondWith([OK]);
    const result = await messenger.sendFile(scope, {
      chatId: '42',
      botInstanceId,
      kind: 'PHOTO',
      source: { kind: 'BYTES', bytes: png, fileName: 'subscription.png', mimeType: 'image/png' },
      caption: { templateKey: HTML_KEY, values: {} },
      buttons: [{ label: { kind: 'TEXT', text: 'open' }, url: 'https://example.net/s' }],
    });
    expect(result).toEqual({ outcome: 'DELIVERED' });
    expect(calls[0]?.url).toContain('/sendPhoto');
    expect(calls[0]?.body).toBeNull();
    const wire = calls[0]?.multipart ?? '';
    expect(wire).toContain('name="chat_id"\r\n\r\n42\r\n');
    expect(wire).toContain('name="caption"\r\n\r\n<code>u</code>\r\n');
    expect(wire).toContain('name="parse_mode"\r\n\r\nHTML\r\n');
    expect(wire).toContain(
      `name="reply_markup"\r\n\r\n${JSON.stringify({ inline_keyboard: [[{ text: 'open', url: 'https://example.net/s' }]] })}\r\n`,
    );
    expect(wire).toContain(
      'name="photo"; filename="subscription.png"\r\nContent-Type: image/png\r\n\r\n',
    );
    expect(wire).toContain(Buffer.from(png).toString('latin1'));
  });

  it('refuses an HTML caption over the bound with a reason, and sends no request', async () => {
    const { messenger, calls, respondWith } = harness({
      [HTML_KEY]: `<b>${'x'.repeat(TELEGRAM_CAPTION_MAX)}</b>`,
    });
    respondWith([OK]);
    const result = await messenger.sendFile(scope, {
      chatId: '42',
      botInstanceId,
      kind: 'PHOTO',
      source: { kind: 'BYTES', bytes: png, fileName: 'q.png', mimeType: 'image/png' },
      caption: { templateKey: HTML_KEY, values: {} },
    });
    expect(result).toEqual({ outcome: 'REFUSED', reason: 'CAPTION_OVER_BOUND' });
    expect(calls).toHaveLength(0);
  });

  it('still cuts a plain caption visibly rather than refusing it', async () => {
    const { messenger, calls, respondWith } = harness({
      [PLAIN_KEY]: 'y'.repeat(TELEGRAM_CAPTION_MAX + 5),
    });
    respondWith([OK]);
    const result = await messenger.sendFile(scope, {
      chatId: '42',
      botInstanceId,
      kind: 'PHOTO',
      source: { kind: 'FILE_ID', fileId: 'f' },
      caption: { templateKey: PLAIN_KEY, values: {} },
    });
    expect(result).toEqual({ outcome: 'DELIVERED' });
    const caption = calls[0]?.body?.caption as string;
    expect(caption.length).toBe(TELEGRAM_CAPTION_MAX);
    expect(caption.endsWith('…')).toBe(true);
  });

  it('reads a 429 without retry_after as RATE_LIMITED, not UNKNOWN, on a file send', async () => {
    const { messenger, respondWith } = harness({});
    respondWith([{ status: 429, body: { ok: false, description: 'Too Many Requests' } }]);
    expect(
      await messenger.sendFile(scope, {
        chatId: '42',
        botInstanceId,
        kind: 'DOCUMENT',
        source: { kind: 'FILE_ID', fileId: 'f' },
      }),
    ).toEqual({ outcome: 'RATE_LIMITED' });
  });
});
