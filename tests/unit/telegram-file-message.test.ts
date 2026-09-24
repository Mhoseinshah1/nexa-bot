import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundCaption,
  fileMessageBody,
  TELEGRAM_CAPTION_MAX,
} from '../../apps/api/src/infrastructure/telegram/send-message';
import { TelegramCustomerMessenger } from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';

/**
 * A receipt, its context and its decisions as ONE Telegram message (Payment File 02 §10).
 *
 * Before this the media path could carry neither a caption nor a keyboard, so a review
 * was an image and a separate text message that scrolled apart. These pin the body the
 * transport builds and what the messenger puts in it.
 */
describe('a file sent with a caption and buttons', () => {
  it('carries the caption and an inline keyboard on a photo', () => {
    expect(
      fileMessageBody({
        chatId: '42',
        kind: 'PHOTO',
        fileId: 'file-1',
        caption: 'facts',
        buttons: [
          { text: 'yes', data: 'D:x', row: 0 },
          { text: 'no', data: 'E:x', row: 0 },
          { text: 'credit', data: 'wa:x', row: 1 },
        ],
      }),
    ).toEqual({
      chat_id: '42',
      photo: 'file-1',
      caption: 'facts',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'yes', callback_data: 'D:x' },
            { text: 'no', callback_data: 'E:x' },
          ],
          [{ text: 'credit', callback_data: 'wa:x' }],
        ],
      },
    });
  });

  it('sends a bare document with no caption, no parse mode and no empty keyboard', () => {
    const body = fileMessageBody({ chatId: '42', kind: 'DOCUMENT', fileId: 'f', buttons: [] });
    expect(body).toEqual({ chat_id: '42', document: 'f' });
  });

  it('sets a parse mode only for an HTML caption', () => {
    expect(
      fileMessageBody({ chatId: '1', kind: 'PHOTO', fileId: 'f', caption: '<b>x</b>', html: true }),
    ).toMatchObject({ caption: '<b>x</b>', parse_mode: 'HTML' });
    expect(
      fileMessageBody({ chatId: '1', kind: 'PHOTO', fileId: 'f', caption: '<b>x</b>' }),
    ).not.toHaveProperty('parse_mode');
  });

  it('cuts a plain caption to Telegram’s bound, never splitting a surrogate pair', () => {
    expect(boundCaption('short')).toBe('short');
    const exact = 'a'.repeat(TELEGRAM_CAPTION_MAX);
    expect(boundCaption(exact)).toBe(exact);

    const long = 'a'.repeat(TELEGRAM_CAPTION_MAX + 50);
    const cut = boundCaption(long);
    expect(cut.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_MAX);
    expect(cut.endsWith('…')).toBe(true);

    // An emoji straddling the cut is dropped whole rather than halved.
    const straddling = `${'a'.repeat(TELEGRAM_CAPTION_MAX - 2)}😀${'b'.repeat(10)}`;
    const safe = boundCaption(straddling);
    expect(safe.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_MAX);
    expect(safe).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
  });
});

describe('the messenger’s file send', () => {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const rendered: { key: string; values: unknown }[] = [];
  const templates = {
    render: async (_scope: unknown, key: string, values: unknown) => {
      rendered.push({ key, values });
      return key === 'bot.admin.approve_button' ? 'APPROVE' : `caption for ${key}`;
    },
  };
  const messenger = new TelegramCustomerMessenger(
    templates as never,
    { tokenForBotInstance: async () => 'test-token' } as never,
    { record: async () => undefined } as never,
    { conditionIsOpen: async () => false } as never,
    'https://telegram.invalid',
    1000,
  );
  const scope = { tenantId: '01900000-0000-7000-8000-000000000001' } as never;

  afterEach(() => {
    vi.unstubAllGlobals();
    bodies.length = 0;
    urls.length = 0;
    rendered.length = 0;
  });

  const accept = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        urls.push(url);
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
      }),
    );

  it('renders the caption from its template and labels the buttons, on sendPhoto', async () => {
    accept();
    const result = await messenger.sendFile(scope, {
      chatId: '42',
      botInstanceId: '01900000-0000-7000-8000-0000000000bb' as never,
      kind: 'PHOTO',
      fileId: 'file-1',
      caption: { templateKey: 'bot.admin.receipt', values: { reference: 'R1' } as never },
      buttons: [{ label: { kind: 'TEMPLATE', key: 'bot.admin.approve_button' }, data: 'D:x' }],
    });

    expect(result).toEqual({ outcome: 'DELIVERED' });
    expect(urls[0]).toContain('/sendPhoto');
    expect(bodies[0]).toEqual({
      chat_id: '42',
      photo: 'file-1',
      caption: 'caption for bot.admin.receipt',
      reply_markup: { inline_keyboard: [[{ text: 'APPROVE', callback_data: 'D:x' }]] },
    });
    expect(rendered[0]).toEqual({ key: 'bot.admin.receipt', values: { reference: 'R1' } });
  });

  it('still sends a bare file, unchanged, when there is no caption', async () => {
    accept();
    await messenger.sendFile(scope, {
      chatId: '42',
      botInstanceId: '01900000-0000-7000-8000-0000000000bb' as never,
      kind: 'DOCUMENT',
      fileId: 'file-2',
    });
    expect(urls[0]).toContain('/sendDocument');
    expect(bodies[0]).toEqual({ chat_id: '42', document: 'file-2' });
    expect(rendered).toEqual([]);
  });
});
