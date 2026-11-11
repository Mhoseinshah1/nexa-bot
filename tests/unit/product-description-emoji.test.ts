import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  customEmojiMarker,
  descriptionFromTelegramText,
  descriptionPlainText,
  descriptionToEditable,
  editableToDescription,
  parseCustomEmojiMarkerBody,
  type BotInstanceId,
  type CapturedEntity,
  type TenantContext,
} from '@nexa/contracts';
import {
  NO_DECORATION,
  appearanceFallbackText,
  decorateAppearance,
  undoHtmlDecoration,
  type AppearanceDecoration,
} from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';
import type { AppearanceReader } from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { TelegramCustomerMessenger } from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';
import { richBlocksFromText } from '../../apps/api/src/infrastructure/telegram/rich-message';
import { capturableTextOf } from '../../apps/api/src/surfaces/telegram/runtime/admin-description-capture-flow';

/**
 * «ارسال توضیح از تلگرام»: a product description typed in Telegram with premium emoji, stored
 * as ONE form — the text with `{icon:<id>:<fallback>}` where each custom emoji was — and drawn
 * by the existing appearance renderer: a `custom_emoji` entity for a bot that may carry one,
 * the covered fallback emoji for every other.
 */
const ID_1 = '5368324170671202286';
const ID_2 = '5307996024738395492';

/** The entity Telegram would send for `covered` found at its first occurrence in `text`. */
function entityFor(text: string, covered: string, id: string, from = 0): CapturedEntity {
  // `indexOf` is in UTF-16 code units — exactly what the Bot API counts.
  return {
    type: 'custom_emoji',
    offset: text.indexOf(covered, from),
    length: covered.length,
    custom_emoji_id: id,
  };
}

const eligible: AppearanceDecoration = { customEmoji: new Map(), eligible: true };

// Persian letters, an ordinary (astral) emoji BEFORE the first custom one, a newline, digits.
const MESSAGE = 'سلام 👋 به فروشگاه ما خوش آمدید 😀\nقیمت ۱۲۰ هزار تومان 🔥 ویژه';

describe('the stored form of a captured description', () => {
  const entities = [entityFor(MESSAGE, '😀', ID_1), entityFor(MESSAGE, '🔥', ID_2)];

  it('replaces each custom_emoji entity by its marker, keeping every other character', () => {
    const stored = descriptionFromTelegramText(MESSAGE, entities);
    expect(stored).toBe(
      `سلام 👋 به فروشگاه ما خوش آمدید ${customEmojiMarker(ID_1, '😀')}\nقیمت ۱۲۰ هزار تومان ${customEmojiMarker(ID_2, '🔥')} ویژه`,
    );
    expect(descriptionPlainText(stored)).toBe(MESSAGE);
  });

  it('keeps UTF-16 offsets right: an astral emoji before the entity counts two units', () => {
    // 👋 is TWO code units, so the first custom emoji sits at a larger offset than the code
    // point count says. An entity read by code points would cut the wrong characters.
    const wrongOffset = { ...entities[0]!, offset: [...MESSAGE].indexOf('😀') };
    expect(wrongOffset.offset).not.toBe(entities[0]!.offset);
    const stored = descriptionFromTelegramText(MESSAGE, [wrongOffset]);
    expect(stored).not.toContain(customEmojiMarker(ID_1, '😀'));
    expect(descriptionFromTelegramText(MESSAGE, [entities[0]!])).toContain(
      customEmojiMarker(ID_1, '😀'),
    );
  });

  it('round trip: the same entities come back out of the renderer, on the same text', () => {
    const stored = descriptionFromTelegramText(MESSAGE, entities);
    const out = decorateAppearance(stored, 'PLAIN_TEXT', eligible);
    expect(out.text).toBe(MESSAGE);
    expect(out.entities).toEqual(entities);
    expect(out.decorated).toBe(2);
  });

  it('falls back to the covered plain emoji when the bot may not carry custom emoji', () => {
    const stored = descriptionFromTelegramText(MESSAGE, entities);
    for (const decoration of [NO_DECORATION, { customEmoji: new Map() }]) {
      const out = decorateAppearance(stored, 'PLAIN_TEXT', decoration);
      expect(out.text).toBe(MESSAGE);
      expect(out.entities).toEqual([]);
      expect(out.decorated).toBe(0);
    }
    expect(appearanceFallbackText(stored)).toBe(MESSAGE);
  });

  it('an HTML body gets the <tg-emoji> tag with the fallback inside, and undoes cleanly', () => {
    const stored = descriptionFromTelegramText(MESSAGE, entities);
    const out = decorateAppearance(stored, 'TELEGRAM_HTML', eligible);
    expect(out.text).toContain(`<tg-emoji emoji-id="${ID_1}">😀</tg-emoji>`);
    expect(out.text).toContain(`<tg-emoji emoji-id="${ID_2}">🔥</tg-emoji>`);
    expect(undoHtmlDecoration(out.text)).toBe(MESSAGE);
  });

  it('draws through the rich message path: custom_emoji nodes, or plain emoji when off', () => {
    const stored = descriptionFromTelegramText('نیم‌بها 😀 تمام', [
      entityFor('نیم‌بها 😀 تمام', '😀', ID_1),
    ]);
    const out = decorateAppearance(stored, 'PLAIN_TEXT', eligible);
    const on = richBlocksFromText({
      text: out.text,
      html: false,
      entities: out.entities,
      customEmoji: true,
    });
    expect(JSON.stringify(on)).toContain(`"custom_emoji_id":"${ID_1}"`);
    expect(JSON.stringify(on)).toContain('"alternative_text":"😀"');
    const off = richBlocksFromText({
      text: out.text,
      html: false,
      entities: out.entities,
      customEmoji: false,
    });
    expect(JSON.stringify(off)).not.toContain('custom_emoji');
    expect(JSON.stringify(off)).toContain('😀');
  });

  it('drops formatting entities with their text kept, and leaves a bad entity as plain text', () => {
    const text = 'متن 😀 پررنگ';
    const stored = descriptionFromTelegramText(text, [
      { type: 'bold', offset: 7, length: 5 },
      entityFor(text, '😀', ID_1),
      // out of range, overlapping the one above, no id, and covering ordinary words:
      { type: 'custom_emoji', offset: 90, length: 2, custom_emoji_id: ID_2 },
      { type: 'custom_emoji', offset: 4, length: 2, custom_emoji_id: ID_2 },
      { type: 'custom_emoji', offset: 0, length: 3 },
      { type: 'custom_emoji', offset: 0, length: 3, custom_emoji_id: 'abc' },
    ]);
    expect(stored).toBe(`متن ${customEmojiMarker(ID_1, '😀')} پررنگ`);
  });

  it('refuses a covered text that is not one short emoji, and ids that are not digits', () => {
    expect(parseCustomEmojiMarkerBody(`${ID_1}:😀`)).toEqual({ id: ID_1, fallback: '😀' });
    expect(parseCustomEmojiMarkerBody(`${ID_1}:❤️`)).toEqual({ id: ID_1, fallback: '❤️' });
    for (const bad of [
      `${ID_1}:`,
      `${ID_1}:ab cd`,
      `${ID_1}:{x}`,
      `${ID_1}:<b>`,
      `x:😀`,
      `${ID_1}:😀😀😀`,
    ]) {
      expect(parseCustomEmojiMarkerBody(bad), bad).toBeNull();
    }
    // A slot marker is not a custom emoji, and stays the renderer's business.
    expect(parseCustomEmojiMarkerBody('payment')).toBeNull();
  });

  it('a slot marker and a typed custom emoji live side by side', () => {
    const out = decorateAppearance(
      `{icon:success} ${customEmojiMarker(ID_1, '😀')}`,
      'PLAIN_TEXT',
      {
        customEmoji: new Map([['success', ID_2]]),
        eligible: true,
      },
    );
    expect(out.text).toBe('✅ 😀');
    expect(
      out.entities.map((entity) => [entity.offset, entity.length, entity.custom_emoji_id]),
    ).toEqual([
      [0, 1, ID_2],
      [2, 2, ID_1],
    ]);
  });
});

describe('the description as the Web Admin edits it', () => {
  const stored = `مقدمه ${customEmojiMarker(ID_1, '😀')} وسط ${customEmojiMarker(ID_2, '🔥')} پایان`;

  it('shows each emoji as a readable token and keeps the ids out of the text', () => {
    const editable = descriptionToEditable(stored);
    expect(editable.text).toBe('مقدمه ⟦😀 #1⟧ وسط ⟦🔥 #2⟧ پایان');
    expect(editable.text).not.toContain(ID_1);
    expect(editable.emojis).toEqual([
      { id: ID_1, fallback: '😀' },
      { id: ID_2, fallback: '🔥' },
    ]);
    expect(editableToDescription(editable.text, editable.emojis)).toBe(stored);
  });

  it('editing the text around a token leaves the ids intact; deleting a token removes it', () => {
    const { text, emojis } = descriptionToEditable(stored);
    const edited = text.replace('وسط', 'میانه‌ی بسیار طولانی').replace('مقدمه', 'سرآغاز');
    expect(editableToDescription(edited, emojis)).toBe(
      `سرآغاز ${customEmojiMarker(ID_1, '😀')} میانه‌ی بسیار طولانی ${customEmojiMarker(ID_2, '🔥')} پایان`,
    );
    const withoutFirst = text.replace('⟦😀 #1⟧ ', '');
    expect(editableToDescription(withoutFirst, emojis)).toBe(
      `مقدمه وسط ${customEmojiMarker(ID_2, '🔥')} پایان`,
    );
  });

  it('a token that names no emoji stays the plain text it is', () => {
    expect(editableToDescription('⟦😀 #9⟧ سلام', [])).toBe('⟦😀 #9⟧ سلام');
    expect(descriptionToEditable('{icon:nonsense} {icon:12:ab cd}').emojis).toEqual([]);
  });
});

describe('what the bot reads from an update', () => {
  it('reads a text with its entities, and a caption with its caption entities', () => {
    const entity = { type: 'custom_emoji', offset: 3, length: 2, custom_emoji_id: ID_1 };
    expect(
      capturableTextOf({ text: 'abc😀', entities: [entity, 7, null, { type: 'bold' }] }),
    ).toEqual({
      text: 'abc😀',
      entities: [entity],
    });
    expect(
      capturableTextOf({ caption: 'abc😀', caption_entities: [entity], photo: [{ file_id: 'x' }] }),
    ).toEqual({ text: 'abc😀', entities: [entity] });
    expect(capturableTextOf({ text: '   ' })).toBeNull();
    expect(capturableTextOf({ photo: [] })).toBeNull();
    expect(capturableTextOf(null)).toBeNull();
  });
});

describe('on the wire', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const scope = {
    tenantId: '01900000-0000-7000-8000-000000000001',
    botInstanceId: null,
  } as TenantContext;
  const eligibleBot = '01900000-0000-7000-8000-0000000000aa' as BotInstanceId;
  const plainBot = '01900000-0000-7000-8000-0000000000bb' as BotInstanceId;
  const KEY = 'bot.admin.receipt' as const;

  async function sendTo(bot: BotInstanceId, rendered: string) {
    const calls: Record<string, unknown>[] = [];
    const appearance: AppearanceReader = {
      decorationFor: async (_scope, botInstanceId) =>
        botInstanceId === eligibleBot ? eligible : NO_DECORATION,
      configuredDecoration: async () => eligible,
      recordRuntimeRefusal: async () => undefined,
    };
    const messenger = new TelegramCustomerMessenger(
      { render: async () => rendered } as never,
      { tokenForBotInstance: async () => 'test-token' } as never,
      { record: async () => undefined } as never,
      { conditionIsOpen: async () => false } as never,
      'https://telegram.invalid',
      1000,
      undefined,
      appearance,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        calls.push(JSON.parse(init.body) as Record<string, unknown>);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 7 } }),
        };
      }),
    );
    await messenger.send(scope, { chatId: '42', botInstanceId: bot, templateKey: KEY, values: {} });
    return calls[0];
  }

  const stored = descriptionFromTelegramText(MESSAGE, [
    entityFor(MESSAGE, '😀', ID_1),
    entityFor(MESSAGE, '🔥', ID_2),
  ]);

  it('an eligible bot sends the same text and the entities the administrator sent', async () => {
    const body = await sendTo(eligibleBot, stored);
    expect(body).toMatchObject({
      text: MESSAGE,
      entities: [
        { type: 'custom_emoji', offset: MESSAGE.indexOf('😀'), length: 2, custom_emoji_id: ID_1 },
        { type: 'custom_emoji', offset: MESSAGE.indexOf('🔥'), length: 2, custom_emoji_id: ID_2 },
      ],
    });
  });

  it('any other bot sends the plain emoji and no entities', async () => {
    const body = await sendTo(plainBot, stored);
    expect(body?.['text']).toBe(MESSAGE);
    expect(body).not.toHaveProperty('entities');
  });
});
