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
  STRIKE_THROUGH_MARK,
  formatMoney,
  renderTemplateBody,
  strikeThroughText,
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
 * R11 A9 — how a bot price list DRAWS a line the customer's personal discount wins.
 *
 * The figures come from the pricing boundary (`tests/integration/r11-personal-discount-
 * listing.test.ts` holds them equal to the invoice); this pins the drawing: the discounted
 * price in the label, the price it replaces struck through after it, and «تخفیف شخصی N٪».
 * A Telegram button is plain text — the Bot API takes no `parse_mode` and no entities for
 * it — so the strike there is U+0336 (`strikeThroughText`); the rich plan table carries a
 * real `strikethrough` rich text. A line the discount does not win is drawn byte for byte
 * as before.
 */

const scope = { tenantId: '01900000-0000-7000-8000-000000000001' } as unknown as TenantContext;
const botInstanceId = '01900000-0000-7000-8000-0000000000bb' as BotInstanceId;
const OK = { ok: true, result: { message_id: 11 } };
const LIST = money(100_000n, 'IRT');
const DISCOUNTED = money(80_000n, 'IRT');
const TAG = 'تخفیف شخصی 20٪';

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
  it('strikes each character with U+0336 and nothing else', () => {
    expect(strikeThroughText('80,000')).toBe(
      ['8', '0', ',', '0', '0', '0'].map((c) => `${c}${STRIKE_THROUGH_MARK}`).join(''),
    );
    expect(STRIKE_THROUGH_MARK).toBe('̶');
  });

  it('a button: the discounted price, the old one struck through, and the tag', async () => {
    const struck = strikeThroughText(formatMoney(LIST));
    expect(await keyboardOf(true)).toEqual([
      `پلن طلایی — ${formatMoney(DISCOUNTED)} ${struck} ${TAG}`,
      `🔄 تمدید پلن طلایی — ${formatMoney(DISCOUNTED)} ${struck} ${TAG}`,
      CATALOGUE_FA['bot.catalog.back_to_categories_button'],
    ]);
  });

  it('a line the discount does not win is drawn byte for byte as before', async () => {
    expect(await keyboardOf(false)).toEqual([
      `پلن طلایی — ${formatMoney(LIST)}`,
      `🔄 تمدید پلن طلایی — ${formatMoney(LIST)}`,
      CATALOGUE_FA['bot.catalog.back_to_categories_button'],
    ]);
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
