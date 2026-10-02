import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotInstanceId, InlineButtonStyles, TenantContext } from '@nexa/contracts';
import { TelegramCustomerMessenger } from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';
import {
  inlineDataLabel,
  inlineLabel,
} from '../../apps/api/src/modules/commerce/messaging/application/inline-buttons';
import type { CustomerButton } from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { telegramButtonMarkup } from '../../apps/api/src/infrastructure/telegram/send-message';
import { money } from '@nexa/contracts';

/**
 * Owner spec §6: a registry button's label is the tenant's template and its style the
 * tenant's `bot.inline_buttons`, and NEITHER touches the route — `callback_data`, the URL
 * and the copied text are byte for byte the same whatever the label reads or looks like.
 */

const scope = {
  tenantId: '01900000-0000-7000-8000-000000000001',
  botInstanceId: null,
} as TenantContext;
const bot = '01900000-0000-7000-8000-0000000000aa' as BotInstanceId;
const OK = { status: 200, body: { ok: true, result: { message_id: 7 } } };

function harness(rendered: Record<string, string>, styles?: InlineButtonStyles) {
  const bodies: Record<string, unknown>[] = [];
  let reads = 0;
  const messenger = new TelegramCustomerMessenger(
    { render: async (_scope: unknown, key: string) => rendered[key] ?? `label:${key}` } as never,
    { tokenForBotInstance: async () => 'test-token' } as never,
    { record: async () => undefined } as never,
    { conditionIsOpen: async () => false } as never,
    'https://telegram.invalid',
    1000,
    undefined,
    undefined,
    styles === undefined
      ? undefined
      : {
          stylesFor: async () => {
            reads += 1;
            return styles;
          },
        },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return { ok: true, status: 200, json: async () => OK.body };
    }),
  );
  return { messenger, bodies, reads: () => reads };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const KEYBOARD: readonly CustomerButton[] = [
  { ...inlineLabel('payment.sent'), data: 'i:payment', row: 0 },
  { ...inlineLabel('payment.copy_card'), copyText: '6037991234567890', row: 1 },
  { ...inlineLabel('payment.gateway_pay'), url: 'https://pay.example/x' },
  { ...inlineLabel('main_menu'), data: 'mm:' },
];

function keyboardOf(body: Record<string, unknown> | undefined) {
  return (body?.reply_markup as { inline_keyboard: Record<string, unknown>[][] }).inline_keyboard;
}

async function send(
  messenger: TelegramCustomerMessenger,
  buttons: readonly CustomerButton[] = KEYBOARD,
) {
  await messenger.send(scope, {
    chatId: '42',
    botInstanceId: bot,
    templateKey: 'bot.payment.receipt_prompt',
    values: { minutes: 5 },
    buttons,
  });
}

describe('inline button styles on the wire', () => {
  it('sends the tenant style per button and omits `default`', async () => {
    const { messenger, bodies, reads } = harness(
      {},
      { 'payment.sent': 'success', 'payment.copy_card': 'primary', main_menu: 'default' },
    );
    await send(messenger);
    const rows = keyboardOf(bodies[0]);
    expect(rows[0]?.[0]).toMatchObject({ callback_data: 'i:payment', style: 'success' });
    expect(rows[1]?.[0]).toMatchObject({
      copy_text: { text: '6037991234567890' },
      style: 'primary',
    });
    expect(rows[2]?.[0]).not.toHaveProperty('style');
    expect(rows[3]?.[0]).toEqual({ text: 'label:bot.menu.main_button', callback_data: 'mm:' });
    // One read per keyboard, however many buttons it has.
    expect(reads()).toBe(1);
  });

  it('draws every button unstyled for a tenant with no override, or without a reader', async () => {
    for (const styles of [{}, undefined]) {
      const { messenger, bodies } = harness({}, styles);
      await send(messenger);
      for (const row of keyboardOf(bodies[0])) {
        for (const cell of row) expect(cell).not.toHaveProperty('style');
      }
    }
  });

  it('keeps every route byte for byte when the label and the style change', async () => {
    const before = harness({});
    await send(before.messenger);
    const after = harness(
      {
        'bot.payment.sent_button': 'رسید را فرستادم',
        'bot.payment.copy_card_button': 'کپی',
        'bot.payment.gateway_pay_button': 'برو',
        'bot.menu.main_button': 'خانه',
      },
      { 'payment.sent': 'danger', 'payment.gateway_pay': 'primary', main_menu: 'success' },
    );
    await send(after.messenger);
    const route = (body: Record<string, unknown> | undefined) =>
      keyboardOf(body).map((row) =>
        row.map((cell) => ({ data: cell.callback_data, url: cell.url, copy: cell.copy_text })),
      );
    expect(route(after.bodies[0])).toEqual(route(before.bodies[0]));
    const texts = keyboardOf(after.bodies[0])
      .flat()
      .map((cell) => cell.text);
    expect(texts).toEqual(['رسید را فرستادم', 'کپی', 'برو', 'خانه']);
  });

  it('styles a data-labelled button by its key and leaves an unregistered one alone', async () => {
    const { messenger, bodies } = harness({}, { 'catalog.product': 'primary' });
    await send(messenger, [
      {
        ...inlineDataLabel('catalog.product', {
          kind: 'TEXT',
          text: 'پلن طلایی',
          amount: money(250_000n, 'IRT'),
        }),
        data: 'p:x',
      },
      // An administrator button carries no registry key: never styled.
      { label: { kind: 'TEXT', text: 'admin' }, data: 'A:' },
    ]);
    const cells = keyboardOf(bodies[0]).flat();
    expect(cells[0]).toMatchObject({ callback_data: 'p:x', style: 'primary' });
    expect(cells[1]).toEqual({ text: 'admin', callback_data: 'A:' });
  });
});

describe('the markup builder', () => {
  it('puts only a Telegram style on the wire', () => {
    expect(
      telegramButtonMarkup([
        { text: 'a', data: 'x', style: 'danger' },
        { text: 'b', data: 'y', style: 'magenta' as never },
      ]),
    ).toEqual([
      [{ text: 'a', callback_data: 'x', style: 'danger' }],
      [{ text: 'b', callback_data: 'y' }],
    ]);
  });
});

describe('the registry helpers', () => {
  it('refuse the wrong kind of label for a button', () => {
    expect(() => inlineLabel('catalog.product')).toThrow(/inlineDataLabel/);
    expect(() => inlineDataLabel('wallet.topup', { kind: 'TEXT', text: 'x' })).toThrow(
      /inlineLabel/,
    );
    expect(inlineLabel('services.page', { page: 1, pages: 3 })).toEqual({
      label: { kind: 'TEMPLATE', key: 'bot.service.page_button', values: { page: 1, pages: 3 } },
      inline: 'services.page',
    });
  });
});
