import { describe, expect, it } from 'vitest';
import { templateDefinition } from '@nexa/contracts';
import {
  INSTANT_MARK_CLOSE,
  INSTANT_MARK_OPEN,
  INSTANT_MARK_TEXT,
  renderTemplateBody,
} from '@nexa/i18n';
import {
  RICH_INSTANT_CLOSE,
  RICH_INSTANT_OPEN,
  RICH_INSTANT_TEXT,
  editRichMessageBody,
  richBlocksFromText,
  richButtonLayout,
  richMessageBody,
  richTableBlock,
  withoutInstantMarks,
} from '../../apps/api/src/infrastructure/telegram/rich-message';
import { telegramButtonMarkup } from '../../apps/api/src/infrastructure/telegram/send-message';
import { TemplateResolver } from '../../apps/api/src/modules/control/templates/application/template-resolver';
import { I18nTemplateCatalogue } from '../../apps/api/src/modules/control/templates/infrastructure/i18n-template-catalogue';

/**
 * R4 PR-F: the rich-message builders, one screen shape at a time. Every expected block is
 * the Bot API 10.3 shape (`docs/r4-telegram-rich-audit.md` §1).
 */

const mark = (unix: number, shown: string) =>
  `${RICH_INSTANT_OPEN}${String(unix)}${RICH_INSTANT_TEXT}${shown}${RICH_INSTANT_CLOSE}`;

describe('the text of a screen as blocks', () => {
  it('draws one paragraph per line and drops the empty lines between paragraphs', () => {
    expect(
      richBlocksFromText({ text: 'سلام\n\nخط دوم\nخط سوم', html: false, customEmoji: false }),
    ).toEqual([
      { type: 'paragraph', text: 'سلام' },
      { type: 'paragraph', text: 'خط دوم' },
      { type: 'paragraph', text: 'خط سوم' },
    ]);
  });

  it('turns bullet lines into one list and a rule line into a divider', () => {
    expect(
      richBlocksFromText({
        text: 'عنوان\n• یک\n• دو\n———\nپایان',
        html: false,
        customEmoji: false,
      }),
    ).toEqual([
      { type: 'paragraph', text: 'عنوان' },
      {
        type: 'list',
        items: [
          { blocks: [{ type: 'paragraph', text: 'یک' }] },
          { blocks: [{ type: 'paragraph', text: 'دو' }] },
        ],
      },
      { type: 'divider' },
      { type: 'paragraph', text: 'پایان' },
    ]);
  });

  it('makes the first line a heading, or folds the rest into a details block, by layout', () => {
    expect(
      richBlocksFromText({
        text: 'سرویس‌ها:',
        html: false,
        customEmoji: false,
        layout: { heading: true },
      }),
    ).toEqual([{ type: 'heading', text: 'سرویس‌ها:', size: 3 }]);
    expect(
      richBlocksFromText({
        text: 'قوانین\nبند یک\nبند دو',
        html: false,
        customEmoji: false,
        layout: { collapse: true },
      }),
    ).toEqual([
      {
        type: 'details',
        summary: 'قوانین',
        blocks: [
          { type: 'paragraph', text: 'بند یک' },
          { type: 'paragraph', text: 'بند دو' },
        ],
      },
    ]);
  });

  it('converts the Telegram HTML subset the templates use, entities decoded', () => {
    expect(
      richBlocksFromText({
        text: 'مبلغ <b>۱۰۰</b>\nکد: <code>A&amp;B</code> <a href="https://x.example/a">لینک</a>',
        html: true,
        customEmoji: false,
      }),
    ).toEqual([
      { type: 'paragraph', text: ['مبلغ ', { type: 'bold', text: '۱۰۰' }] },
      {
        type: 'paragraph',
        text: [
          'کد: ',
          { type: 'code', text: 'A&B' },
          ' ',
          { type: 'url', text: 'لینک', url: 'https://x.example/a' },
        ],
      },
    ]);
  });

  it('refuses what it cannot convert exactly, so the ordinary message is sent instead', () => {
    for (const text of [
      '<b>spans\nlines</b>',
      '<blockquote>q</blockquote>',
      '<b>unclosed',
      'stray </b>',
      'bad &nbsp; entity',
      '<a href="javascript:x">x</a>',
      `${RICH_INSTANT_OPEN}12${RICH_INSTANT_TEXT}no close`,
    ]) {
      expect(richBlocksFromText({ text, html: true, customEmoji: false }), text).toBeNull();
    }
    expect(
      richBlocksFromText({
        text: 'x',
        html: false,
        customEmoji: false,
        entities: [{ type: 'bold', offset: 0, length: 1 }],
      }),
    ).toBeNull();
    expect(richBlocksFromText({ text: '', html: false, customEmoji: false })).toBeNull();
  });
});

describe('premium emoji inside a rich message (F3)', () => {
  const plain = {
    text: 'پرداخت ✅ شد',
    html: false,
    entities: [
      { type: 'custom_emoji', offset: 7, length: 1, custom_emoji_id: '5368324170671202286' },
    ],
  } as const;

  it('draws a custom emoji entity as RichTextCustomEmoji with its emoji as the alternative', () => {
    expect(richBlocksFromText({ ...plain, customEmoji: true })).toEqual([
      {
        type: 'paragraph',
        text: [
          'پرداخت ',
          { type: 'custom_emoji', custom_emoji_id: '5368324170671202286', alternative_text: '✅' },
          ' شد',
        ],
      },
    ]);
  });

  it('falls back to the plain emoji when premium emoji are off — the same text, no node', () => {
    expect(richBlocksFromText({ ...plain, customEmoji: false })).toEqual([
      { type: 'paragraph', text: 'پرداخت ✅ شد' },
    ]);
    expect(
      richBlocksFromText({
        text: 'ok <tg-emoji emoji-id="99">✅</tg-emoji>',
        html: true,
        customEmoji: false,
      }),
    ).toEqual([{ type: 'paragraph', text: ['ok ', '✅'] }]);
    expect(
      richBlocksFromText({
        text: 'ok <tg-emoji emoji-id="99">✅</tg-emoji>',
        html: true,
        customEmoji: true,
      }),
    ).toEqual([
      {
        type: 'paragraph',
        text: ['ok ', { type: 'custom_emoji', custom_emoji_id: '99', alternative_text: '✅' }],
      },
    ]);
  });
});

describe('date values as date_time rich text (F6)', () => {
  it('wraps exactly the rendered date, with its Unix time and an as-is format', () => {
    expect(
      richBlocksFromText({
        text: `انقضا: ${mark(1700000000, '۱۴۰۲/۰۸/۲۴')}`,
        html: false,
        customEmoji: false,
      }),
    ).toEqual([
      {
        type: 'paragraph',
        text: [
          'انقضا: ',
          { type: 'date_time', text: '۱۴۰۲/۰۸/۲۴', unix_time: 1700000000, date_time_format: '' },
        ],
      },
    ]);
  });

  it('uses the same three marks as the renderer, and the marked render IS the plain render', () => {
    expect([RICH_INSTANT_OPEN, RICH_INSTANT_TEXT, RICH_INSTANT_CLOSE]).toEqual([
      INSTANT_MARK_OPEN,
      INSTANT_MARK_TEXT,
      INSTANT_MARK_CLOSE,
    ]);
    const definition = templateDefinition('bot.service.detail');
    const body = 'پلن {productTitle}\nانقضا: {expiresAt}\nهمگام: {syncedAt}';
    const values = {
      productTitle: 'A',
      state: 'فعال',
      expiresAt: new Date('2026-11-01T10:00:00Z'),
      syncedAt: new Date('2026-10-19T10:00:00Z'),
    };
    const presentation = { timezone: 'Asia/Tehran', calendar: 'jalali' } as const;
    const plain = renderTemplateBody(definition, body, values, 'fa', presentation);
    const marked = renderTemplateBody(definition, body, values, 'fa', presentation, {
      markInstants: true,
    });
    expect(marked).not.toBe(plain);
    expect(withoutInstantMarks(marked)).toBe(plain);
    const blocks = richBlocksFromText({ text: marked, html: false, customEmoji: false }) ?? [];
    expect(JSON.stringify(blocks)).toContain(
      `"unix_time":${String(Date.UTC(2026, 10, 1, 10) / 1000)}`,
    );
  });

  it('never marks a body or a value that already carries a mark character', () => {
    const definition = templateDefinition('bot.service.detail');
    const values = {
      productTitle: `x${RICH_INSTANT_OPEN}`,
      state: 's',
      expiresAt: new Date('2026-11-01T10:00:00Z'),
    };
    const once = renderTemplateBody(definition, '{productTitle} {expiresAt}', values, 'fa');
    expect(
      renderTemplateBody(definition, '{productTitle} {expiresAt}', values, 'fa', undefined, {
        markInstants: true,
      }),
    ).toBe(once);
  });
});

describe('the buttons of a screen', () => {
  it('keeps the rows and the routes of the inline keyboard, inside buttons blocks', () => {
    const buttons = [
      { text: 'پرداخت', data: 'p:1', style: 'success' as const },
      { text: 'کپی', copyText: '6037', row: 2 },
      { text: 'لینک', url: 'https://x.example', row: 2 },
    ];
    const layout = richButtonLayout(buttons);
    expect(layout.inline).toEqual([]);
    expect(layout.blocks).toEqual([
      { type: 'buttons', buttons: [{ text: 'پرداخت', style: 'success', callback_data: 'p:1' }] },
      {
        type: 'buttons',
        buttons: [
          { text: 'کپی', copy_text: { text: '6037' } },
          { text: 'لینک', url: 'https://x.example' },
        ],
      },
    ]);
  });

  it('leaves a row it cannot hold as an ordinary inline keyboard, whole and never dropped', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ text: `${i}`, data: `n:${i}`, row: 1 }));
    const iconed = { text: 'آیکون', data: 'i:1', iconCustomEmojiId: '42' };
    const layout = richButtonLayout([...nine, iconed, { text: 'ok', data: 'o:1' }]);
    expect(layout.blocks).toEqual([
      { type: 'buttons', buttons: [{ text: 'ok', callback_data: 'o:1' }] },
    ]);
    expect(layout.inline).toEqual([
      telegramButtonMarkup(nine)[0],
      [{ text: 'آیکون', callback_data: 'i:1', icon_custom_emoji_id: '42' }],
    ]);
  });
});

describe('the plan table (F2)', () => {
  it('draws a header row and one row per plan, compact for the phone', () => {
    expect(
      richTableBlock({ header: ['نام', 'حجم'], rows: [['A', '۱۰ گیگ']], compact: true }),
    ).toEqual({
      type: 'table',
      cells: [
        [
          { text: 'نام', is_header: true, align: 'center', valign: 'middle' },
          { text: 'حجم', is_header: true, align: 'center', valign: 'middle' },
        ],
        [
          { text: 'A', align: 'center', valign: 'middle' },
          { text: '۱۰ گیگ', align: 'center', valign: 'middle' },
        ],
      ],
      is_bordered: true,
      is_striped: true,
      is_compact: true,
    });
  });
});

describe('the two rich bodies', () => {
  const blocks = [{ type: 'paragraph', text: 'x' }];

  it('sends right-to-left, with an inline keyboard only for rows left out of the message', () => {
    expect(richMessageBody({ chatId: '42', blocks, inlineRows: [] })).toEqual({
      chat_id: '42',
      rich_message: { blocks, is_rtl: true },
    });
    expect(
      richMessageBody({
        chatId: '42',
        blocks,
        inlineRows: [[{ text: 'a', callback_data: 'a' }]],
        replyToMessageId: 7,
      }),
    ).toEqual({
      chat_id: '42',
      rich_message: { blocks, is_rtl: true },
      reply_parameters: { message_id: 7, allow_sending_without_reply: true },
      reply_markup: { inline_keyboard: [[{ text: 'a', callback_data: 'a' }]] },
    });
  });

  it('always replaces the keyboard on an edit, even with an empty one', () => {
    expect(editRichMessageBody({ chatId: '42', messageId: 9, blocks, inlineRows: [] })).toEqual({
      chat_id: '42',
      message_id: 9,
      rich_message: { blocks, is_rtl: true },
      reply_markup: { inline_keyboard: [] },
    });
  });
});

describe('the resolver renders the marked text from the SAME resolution (F6)', () => {
  it('returns render() exactly as `text`, and the same text with marks as `marked`', async () => {
    const resolver = new TemplateResolver(
      { findOverride: async () => null } as never,
      { isEnabled: async () => true } as never,
      new I18nTemplateCatalogue(),
      { presentationFor: async () => ({ timezone: 'Asia/Tehran', calendar: 'jalali' }) as never },
    );
    const scope = { tenantId: 't-1' } as never;
    const values = {
      productTitle: 'A',
      state: 'فعال',
      expiresAt: new Date('2026-11-01T10:00:00Z'),
    };
    const plain = await resolver.render(scope, 'bot.service.detail', values);
    const both = await resolver.renderWithInstants(scope, 'bot.service.detail', values);
    expect(both.text).toBe(plain);
    expect(both.marked).toContain(RICH_INSTANT_OPEN);
    expect(withoutInstantMarks(both.marked)).toBe(plain);
  });
});
