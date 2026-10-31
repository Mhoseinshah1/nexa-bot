import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  money,
  templateDefinition,
  type BotInstanceId,
  type TemplateKey,
  type TemplateValues,
  type TenantContext,
} from '@nexa/contracts';
import {
  CATALOGUE_FA,
  LTR_ISOLATE,
  POP_DIRECTIONAL_ISOLATE,
  formatMoney,
  formatMoneyIsolated,
  renderTemplateBody,
} from '@nexa/i18n';
import type { CustomerButton } from '../../apps/api/src/modules/commerce/messaging/application/ports';
import {
  inlineDataLabel,
  inlineLabel,
} from '../../apps/api/src/modules/commerce/messaging/application/inline-buttons';
import { NO_DECORATION } from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';
import type { RichMessageMode } from '../../apps/api/src/modules/commerce/messaging/application/rich-messages';
import { TelegramCustomerMessenger } from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';
import {
  listedPrice,
  personalDiscountOf,
} from '../../apps/api/src/surfaces/telegram/runtime/listed-price';

/**
 * R11 A9 + the R11 hotfix — how a bot price list DRAWS a line the customer's personal
 * discount wins.
 *
 * The figures come from the pricing boundary (`tests/integration/r11-personal-discount-
 * listing.test.ts` holds them equal to the invoice); this pins the drawing. A Telegram button
 * is plain text — the Bot API takes no `parse_mode` and no entities for it — and A9 struck the
 * replaced price there with U+0336, which inside a right-to-left label split the figure into
 * reversed bidi runs («000,130 تومان»). So a button now carries ONE price, the discounted
 * one, its figure in a left-to-right isolate, then «(20٪ تخفیف)»
 * (`bot.pricing.personal_discount_button_suffix`). The rich plan table keeps a real
 * `strikethrough` rich text and «تخفیف شخصی N٪». A line the discount does not win is drawn
 * byte for byte as before.
 */

const scope = { tenantId: '01900000-0000-7000-8000-000000000001' } as unknown as TenantContext;
const botInstanceId = '01900000-0000-7000-8000-0000000000bb' as BotInstanceId;
const OK = { ok: true, result: { message_id: 11 } };
const LIST = money(100_000n, 'IRT');
const DISCOUNTED = money(80_000n, 'IRT');
const TAG = 'تخفیف شخصی 20٪';
/** The owner's wording for a discounted button (R11 hotfix). */
const SUFFIX = '(20٪ تخفیف)';
/** Every combining mark (U+0300–U+036F), U+0336 among them: none may reach a button. */
const COMBINING = /[\u0300-\u036f]/u;

interface Call {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

/** The real renderer over the shipped catalogue, so the tag is the template's own text. */
function harness(mode: RichMessageMode) {
  const calls: Call[] = [];
  const renderer = {
    render: async (_scope: unknown, key: TemplateKey, values: TemplateValues = {}) =>
      renderTemplateBody(templateDefinition(key), CATALOGUE_FA[key], values),
  };
  const messenger = new TelegramCustomerMessenger(
    renderer as never,
    { tokenForBotInstance: async () => 'test-token' } as never,
    { record: async () => undefined } as never,
    { conditionIsOpen: async () => false } as never,
    'https://telegram.invalid',
    1000,
    undefined,
    {
      decorationFor: async () => NO_DECORATION,
      configuredDecoration: async () => NO_DECORATION,
      recordRuntimeRefusal: async () => undefined,
    } as never,
    {
      stylesFor: async () => ({}),
      categoryColorsFor: async () => ({}),
      iconsFor: async () => ({}),
      categoryIconsFor: async () => ({}),
    } as never,
    undefined,
    { modeFor: async () => mode, now: () => new Date('2026-10-27T12:00:00Z') } as never,
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      calls.push({
        method: url.split('/').at(-1) as string,
        body: JSON.parse(init.body) as Record<string, unknown>,
      });
      return { ok: true, status: 200, json: async () => OK };
    }),
  );
  return { messenger, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The plan list and the renewal menu as the bot flows build them, one line each kind. */
function buttons(discounted: boolean): CustomerButton[] {
  const line = {
    price: LIST,
    personalDiscount: discounted ? { percent: 20, price: DISCOUNTED } : null,
  };
  return [
    {
      ...inlineDataLabel('catalog.product', {
        kind: 'TEXT',
        text: 'پلن طلایی',
        amount: listedPrice(line),
      }),
      data: 'p:01900000-0000-7000-8000-0000000000aa',
      planFacts: { trafficBytes: 53_687_091_200n, durationDays: 30 },
      ...personalDiscountOf(line),
    },
    {
      ...inlineLabel('service.renew_option', { title: 'پلن طلایی', price: listedPrice(line) }),
      data: 'nr:01900000-0000-7000-8000-0000000000cc',
      ...personalDiscountOf(line),
    },
    // A time package in the renewal menu, and an extra-volume package list's line.
    {
      ...inlineLabel('service.addon_option', { title: 'ده روز', price: listedPrice(line) }),
      data: 'a:01900000-0000-7000-8000-0000000000dd',
      ...personalDiscountOf(line),
    },
    { ...inlineLabel('catalog.back_to_categories'), data: 'ck:0' },
  ];
}

const OFF: RichMessageMode = { enabled: false, premiumEmoji: false };
const TABLE: RichMessageMode = { enabled: true, premiumEmoji: false, planTable: true };

async function keyboardOf(discounted: boolean): Promise<string[]> {
  const { messenger, calls } = harness(OFF);
  await messenger.send(scope, {
    chatId: '42',
    botInstanceId,
    templateKey: 'bot.catalog.heading',
    values: {},
    buttons: buttons(discounted),
  });
  const markup = calls[0]?.body.reply_markup as { inline_keyboard: { text: string }[][] };
  return markup.inline_keyboard.flat().map((button) => button.text);
}

describe('R11 A9: a personally discounted line in a bot price list', () => {
  it('formatMoneyIsolated: the same figure and unit as formatMoney, the figure in LRI…PDI', () => {
    expect(formatMoneyIsolated(DISCOUNTED)).toBe('\u206680,000\u2069 تومان');
    expect(formatMoneyIsolated(money(-1_234_567n, 'IRT'))).toBe('\u2066-1,234,567\u2069 تومان');
    expect([LTR_ISOLATE, POP_DIRECTIONAL_ISOLATE]).toEqual(['\u2066', '\u2069']);
    for (const value of [DISCOUNTED, money(-1_234_567n, 'IRT'), money(12_345n, 'USD')]) {
      expect(formatMoneyIsolated(value).replace(/[\u2066\u2069]/gu, '')).toBe(formatMoney(value));
    }
  });

  it('a button: one price — the discounted one, isolated — and «(20٪ تخفیف)»', async () => {
    const isolated = formatMoneyIsolated(DISCOUNTED);
    expect(await keyboardOf(true)).toEqual([
      `پلن طلایی — ${isolated} ${SUFFIX}`,
      `🔄 تمدید پلن طلایی — ${isolated} ${SUFFIX}`,
      `ده روز — ${isolated} ${SUFFIX}`,
      CATALOGUE_FA['bot.catalog.back_to_categories_button'],
    ]);
  });

  it('a discounted button: no strike mark, the struck list price never, the amount once', async () => {
    const labels = (await keyboardOf(true)).slice(0, 3);
    for (const label of labels) {
      expect(label).not.toMatch(COMBINING);
      expect(label).not.toContain('\u0336');
      expect(label).not.toContain('100,000');
      expect(label).not.toContain(TAG);
      expect(label.split('80,000').length - 1).toBe(1);
      expect(label.split('تومان').length - 1).toBe(1);
      expect(label.endsWith(` ${SUFFIX}`)).toBe(true);
    }
  });

  it('a discounted button: the price stays in logical order, one isolated run, unit after', async () => {
    const labels = (await keyboardOf(true)).slice(0, 3);
    for (const label of labels) {
      // Exactly one isolate, holding only the figure — its digits and separators, in order.
      expect(label.split('\u2066').length - 1).toBe(1);
      expect(label.split('\u2069').length - 1).toBe(1);
      const inside = /\u2066([^\u2069]*)\u2069/u.exec(label)?.[1];
      expect(inside).toBe('80,000');
      // The unit and the suffix follow the isolate, in reading order, nothing in between.
      expect(label).toMatch(/ — \u206680,000\u2069 تومان \(20٪ تخفیف\)$/u);
    }
  });

  it("the owner's screenshot line: «20 گیگ 60 روزه», 130,000 at 20 % → one price, 104,000", async () => {
    const { messenger, calls } = harness(OFF);
    const line = {
      price: money(130_000n, 'IRT'),
      personalDiscount: { percent: 20, price: money(104_000n, 'IRT') },
    };
    await messenger.send(scope, {
      chatId: '42',
      botInstanceId,
      templateKey: 'bot.catalog.heading',
      values: {},
      buttons: [
        {
          ...inlineDataLabel('catalog.product', {
            kind: 'TEXT',
            text: '20 گیگ 60 روزه',
            amount: listedPrice(line),
          }),
          data: 'p:01900000-0000-7000-8000-0000000000ee',
          ...personalDiscountOf(line),
        },
      ],
    });
    const markup = calls[0]?.body.reply_markup as { inline_keyboard: { text: string }[][] };
    expect(markup.inline_keyboard.flat().map((button) => button.text)).toEqual([
      '20 گیگ 60 روزه — \u2066104,000\u2069 تومان (20٪ تخفیف)',
    ]);
  });

  it('a renewal title holding a longer number keeps it whole; only the price is isolated', async () => {
    const { messenger, calls } = harness(OFF);
    const line = { price: LIST, personalDiscount: { percent: 20, price: DISCOUNTED } };
    await messenger.send(scope, {
      chatId: '42',
      botInstanceId,
      templateKey: 'bot.catalog.heading',
      values: {},
      buttons: [
        {
          ...inlineLabel('service.renew_option', {
            title: 'ویژهٔ 180,000 تومان',
            price: listedPrice(line),
          }),
          data: 'nr:01900000-0000-7000-8000-0000000000cc',
          ...personalDiscountOf(line),
        },
      ],
    });
    const markup = calls[0]?.body.reply_markup as { inline_keyboard: { text: string }[][] };
    expect(markup.inline_keyboard.flat().map((button) => button.text)).toEqual([
      `🔄 تمدید ویژهٔ 180,000 تومان — \u206680,000\u2069 تومان ${SUFFIX}`,
    ]);
  });

  it('a line the discount does not win is drawn byte for byte as before', async () => {
    const labels = await keyboardOf(false);
    expect(labels).toEqual([
      `پلن طلایی — ${formatMoney(LIST)}`,
      `🔄 تمدید پلن طلایی — ${formatMoney(LIST)}`,
      `ده روز — ${formatMoney(LIST)}`,
      CATALOGUE_FA['bot.catalog.back_to_categories_button'],
    ]);
    for (const label of labels) expect(label).not.toMatch(/[\u2066\u2069]/u);
    expect(personalDiscountOf({ price: LIST, personalDiscount: null })).toEqual({});
    expect(listedPrice({ price: LIST, personalDiscount: null })).toEqual(LIST);
  });

  it('the rich plan table: a real strikethrough, the discounted price and the tag', async () => {
    const { messenger, calls } = harness(TABLE);
    await messenger.send(scope, {
      chatId: '42',
      botInstanceId,
      templateKey: 'bot.catalog.heading',
      values: {},
      buttons: buttons(true),
    });
    const blocks = (calls[0]?.body.rich_message as { blocks: Record<string, unknown>[] }).blocks;
    const table = blocks.find((block) => block.type === 'table') as {
      cells: { text: unknown }[][];
    };
    expect(table.cells[1]?.[3]?.text).toEqual([
      { type: 'strikethrough', text: formatMoney(LIST) },
      ` ${formatMoney(DISCOUNTED)} `,
      TAG,
    ]);
  });

  it('the rich plan table without a discount keeps the plain price cell', async () => {
    const { messenger, calls } = harness(TABLE);
    await messenger.send(scope, {
      chatId: '42',
      botInstanceId,
      templateKey: 'bot.catalog.heading',
      values: {},
      buttons: buttons(false),
    });
    const blocks = (calls[0]?.body.rich_message as { blocks: Record<string, unknown>[] }).blocks;
    const table = blocks.find((block) => block.type === 'table') as {
      cells: { text: unknown }[][];
    };
    expect(table.cells[1]?.[3]?.text).toBe(formatMoney(LIST));
  });
});
