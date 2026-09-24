import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeMultipart } from '../../apps/api/src/infrastructure/telegram/multipart';
import {
  fileMessageBody,
  fileUploadBody,
  telegramButtonMarkup,
  telegramSend,
  type TelegramRequest,
} from '../../apps/api/src/infrastructure/telegram/send-message';

/**
 * The upload path of the ONE Telegram call.
 *
 * Three things are pinned: what bytes the encoder puts on the wire, that the upload
 * request inherits the JSON path's outcome taxonomy unchanged, and that the JSON path
 * itself is the same call it was before an upload existed.
 */
describe('encodeMultipart', () => {
  it('writes each field as a text part and the file with its filename and content type', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0xff]);
    const { contentType, body } = encodeMultipart(
      { chat_id: '42', caption: 'facts\nline two', reply_markup: '{"inline_keyboard":[]}' },
      { field: 'photo', fileName: 'qr.png', mimeType: 'image/png', bytes },
    );

    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(contentType)?.[1];
    expect(boundary).toBeDefined();
    expect(boundary?.length).toBeLessThanOrEqual(70);

    const text = Buffer.from(body).toString('latin1');
    const delimiter = `--${boundary}\r\n`;
    expect(text.startsWith(delimiter)).toBe(true);
    expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);

    // The parts, in insertion order, each closed by CRLF.
    const parts = text.split(delimiter).slice(1);
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('Content-Disposition: form-data; name="chat_id"\r\n\r\n42\r\n');
    expect(parts[1]).toBe(
      'Content-Disposition: form-data; name="caption"\r\n\r\nfacts\nline two\r\n',
    );
    expect(parts[2]).toBe(
      'Content-Disposition: form-data; name="reply_markup"\r\n\r\n{"inline_keyboard":[]}\r\n',
    );
    expect(
      parts[3]?.startsWith(
        'Content-Disposition: form-data; name="photo"; filename="qr.png"\r\nContent-Type: image/png\r\n\r\n',
      ),
    ).toBe(true);

    // The bytes are copied through verbatim, including a NUL and a CRLF inside them.
    const start = body.length - (`\r\n--${boundary}--\r\n`.length + bytes.length);
    expect(Buffer.from(body.subarray(start, start + bytes.length))).toEqual(Buffer.from(bytes));
  });

  it('uses a fresh boundary per request that no field contains', () => {
    const file = {
      field: 'photo',
      fileName: 'x.png',
      mimeType: 'image/png',
      bytes: new Uint8Array(1),
    };
    const a = encodeMultipart({ chat_id: '1' }, file);
    const b = encodeMultipart({ chat_id: '1' }, file);
    expect(a.contentType).not.toBe(b.contentType);
  });

  it('escapes a quote or a line break in a filename rather than closing the header', () => {
    const { body } = encodeMultipart(
      {},
      {
        field: 'document',
        fileName: 'a"b\r\nc.png',
        mimeType: 'image/png',
        bytes: new Uint8Array(0),
      },
    );
    const text = Buffer.from(body).toString('utf8');
    expect(text).toContain('filename="a%22b%0d%0ac.png"');
    expect(text).not.toContain('filename="a"b');
  });
});

describe('fileUploadBody', () => {
  it('serialises the keyboard and carries the caption, with the file under the media field', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const upload = fileUploadBody({
      chatId: '42',
      kind: 'PHOTO',
      bytes,
      fileName: 'qr.png',
      mimeType: 'image/png',
      caption: '<code>x</code>',
      html: true,
      buttons: [{ text: 'open', url: 'https://example.net/s' }],
    });
    expect(upload.fields).toEqual({
      chat_id: '42',
      caption: '<code>x</code>',
      parse_mode: 'HTML',
      reply_markup: JSON.stringify({
        inline_keyboard: [[{ text: 'open', url: 'https://example.net/s' }]],
      }),
    });
    expect(upload.file).toEqual({
      field: 'photo',
      fileName: 'qr.png',
      mimeType: 'image/png',
      bytes,
    });

    const document = fileUploadBody({
      chatId: '42',
      kind: 'DOCUMENT',
      bytes,
      fileName: 'a.png',
      mimeType: 'image/png',
    });
    expect(document.fields).toEqual({ chat_id: '42' });
    expect(document.file.field).toBe('document');
  });

  it('bounds a plain caption exactly as the file_id body does', () => {
    const long = 'a'.repeat(2000);
    const upload = fileUploadBody({
      chatId: '1',
      kind: 'PHOTO',
      bytes: new Uint8Array(0),
      fileName: 'q.png',
      mimeType: 'image/png',
      caption: long,
    });
    const byId = fileMessageBody({ chatId: '1', kind: 'PHOTO', fileId: 'f', caption: long });
    expect(upload.fields.caption).toBe(byId.caption);
    expect(upload.fields).not.toHaveProperty('parse_mode');
  });
});

describe('telegramButtonMarkup with a URL button', () => {
  it('renders a url cell beside the other two kinds', () => {
    expect(
      telegramButtonMarkup([
        { text: 'open', url: 'https://example.net', row: 0 },
        { text: 'copy', copyText: 'abc', row: 0 },
        { text: 'go', data: 'x:1' },
      ]),
    ).toEqual([
      [
        { text: 'open', url: 'https://example.net' },
        { text: 'copy', copy_text: { text: 'abc' } },
      ],
      [{ text: 'go', callback_data: 'x:1' }],
    ]);
  });
});

describe('telegramSend with an upload', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: status < 400, status, json: async () => body };
      }),
    );

  afterEach(() => {
    vi.unstubAllGlobals();
    calls.length = 0;
  });

  const upload: TelegramRequest = {
    token: 'tok',
    apiBaseUrl: 'https://telegram.invalid',
    timeoutMs: 1000,
    method: 'sendPhoto',
    multipart: {
      fields: { chat_id: '42', caption: 'c' },
      file: {
        field: 'photo',
        fileName: 'qr.png',
        mimeType: 'image/png',
        bytes: new Uint8Array([7]),
      },
    },
  };

  it('posts multipart to the named method and reads the message id', async () => {
    respond(200, { ok: true, result: { message_id: 9 } });
    expect(await telegramSend(upload)).toEqual({ outcome: 'SUCCEEDED', messageId: 9 });
    expect(calls[0]?.url).toBe('https://telegram.invalid/bottok/sendPhoto');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(calls[0]?.init.redirect).toBe('error');
    expect(calls[0]?.init.signal).toBeDefined();
    const body = Buffer.from(calls[0]?.init.body as Uint8Array).toString('latin1');
    expect(body).toContain('name="chat_id"\r\n\r\n42\r\n');
    expect(body).toContain('filename="qr.png"\r\nContent-Type: image/png\r\n\r\n\u0007\r\n');
  });

  it('maps the outcomes for an upload exactly as for a JSON body', async () => {
    respond(429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 3 } });
    expect(await telegramSend(upload)).toMatchObject({
      outcome: 'FAILED_RETRYABLE',
      errorCode: 'telegram.rate_limited',
      retryAfterMs: 3000,
    });

    respond(503, { ok: false, description: 'Service Unavailable' });
    expect(await telegramSend(upload)).toMatchObject({
      outcome: 'FAILED_RETRYABLE',
      errorCode: 'telegram.server_error.503',
    });

    respond(400, { ok: false, description: 'PHOTO_INVALID_DIMENSIONS', error_code: 400 });
    expect(await telegramSend(upload)).toMatchObject({
      outcome: 'FAILED_PERMANENT',
      errorCode: 'telegram.rejected.400',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      })),
    );
    expect(await telegramSend(upload)).toMatchObject({
      outcome: 'FAILED_RETRYABLE',
      errorCode: 'telegram.unreadable_response',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    );
    expect(await telegramSend(upload)).toMatchObject({
      outcome: 'FAILED_RETRYABLE',
      errorCode: 'telegram.unreachable',
    });
  });

  it('never quotes the caption or the bytes in an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    );
    const secret: TelegramRequest = {
      ...upload,
      multipart: {
        fields: { chat_id: '1', caption: 'SECRET-CAPTION' },
        file: {
          field: 'photo',
          fileName: 'q.png',
          mimeType: 'image/png',
          bytes: Buffer.from('SECRET-BYTES'),
        },
      },
    };
    const result = await telegramSend(secret);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('leaves the JSON path exactly as it was', async () => {
    respond(200, { ok: true, result: { message_id: 1 } });
    await telegramSend({
      token: 'tok',
      apiBaseUrl: 'https://telegram.invalid',
      timeoutMs: 1000,
      body: { chat_id: '42', photo: 'file-1' },
      method: 'sendPhoto',
    });
    expect(calls[0]?.init.headers).toEqual({ 'content-type': 'application/json' });
    expect(calls[0]?.init.body).toBe(JSON.stringify({ chat_id: '42', photo: 'file-1' }));
  });
});
