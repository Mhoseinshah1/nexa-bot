import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BotInstanceId,
  CategoryColors,
  InlineButtonStyles,
  TenantContext,
} from '@nexa/contracts';
import { TelegramCustomerMessenger } from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';
import {
  inlineDataLabel,
  inlineLabel,
} from '../../apps/api/src/modules/commerce/messaging/application/inline-buttons';
import type { CustomerButton } from '../../apps/api/src/modules/commerce/messaging/application/ports';

/**
 * UX Batch 01, item 2: each category button in the bot's catalogue is drawn with its OWN
 * colour (`bot.category_colors`), else the generic category button's style, else none — and
 * the colour never touches the route.
 */

const scope = {
  tenantId: '01900000-0000-7000-8000-000000000001',
  botInstanceId: null,
} as TenantContext;
const bot = '01900000-0000-7000-8000-0000000000aa' as BotInstanceId;
const VPN = '0190a5d6-1c2b-7e3f-8a4b-5c6d7e8f9a01';
const GAMING = '0190a5d6-1c2b-7e3f-8a4b-5c6d7e8f9a02';
// Created after the colours were saved: no code change, no entry, the fallback.
const NEW = '0190a5d6-1c2b-7e3f-8a4b-5c6d7e8f9a03';

function harness(styles: InlineButtonStyles, colors: CategoryColors | undefined) {
  const bodies: Record<string, unknown>[] = [];
  let colorReads = 0;
  const messenger = new TelegramCustomerMessenger(
    { render: async (_scope: unknown, key: string) => `label:${key}` } as never,
    { tokenForBotInstance: async () => 'test-token' } as never,
    { record: async () => undefined } as never,
    { conditionIsOpen: async () => false } as never,
    'https://telegram.invalid',
    1000,
    undefined,
    undefined,
    {
      stylesFor: async () => styles,
      ...(colors === undefined
        ? {}
        : {
            categoryColorsFor: async () => {
              colorReads += 1;
              return colors;
            },
          }),
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) };
    }),
  );
  return { messenger, bodies, colorReads: () => colorReads };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const categoryButton = (id: string, name: string): CustomerButton => ({
  ...inlineDataLabel('catalog.category', { kind: 'TEXT', text: name }),
  data: `c:${id}.0`,
  category: id,
});

const CATALOGUE: readonly CustomerButton[] = [
  categoryButton(VPN, 'VPN'),
  categoryButton(GAMING, 'Gaming'),
  categoryButton(NEW, 'New'),
  { ...inlineLabel('catalog.next_page'), data: 'cp:1' },
];

async function send(messenger: TelegramCustomerMessenger, buttons = CATALOGUE) {
  await messenger.send(scope, {
    chatId: '42',
    botInstanceId: bot,
    templateKey: 'bot.catalog.categories_heading',
    values: {},
    buttons,
  });
}

function cells(body: Record<string, unknown> | undefined) {
  return (body?.reply_markup as { inline_keyboard: Record<string, unknown>[][] }).inline_keyboard
    .flat()
    .map((cell) => ({ data: cell.callback_data, style: cell.style }));
}

describe('category colours on the wire', () => {
  it("draws each category's own colour, the fallback for one with none, once per keyboard", async () => {
    const { messenger, bodies, colorReads } = harness(
      { 'catalog.category': 'primary', 'catalog.next_page': 'danger' },
      { [VPN]: 'success', [GAMING]: 'default' },
    );
    await send(messenger);
    expect(cells(bodies[0])).toEqual([
      { data: `c:${VPN}.0`, style: 'success' },
      // An explicit default is no style, whatever the generic category button says.
      { data: `c:${GAMING}.0`, style: undefined },
      // No colour of its own: the generic category button's style.
      { data: `c:${NEW}.0`, style: 'primary' },
      // Not a category: its own registry style, untouched by the colours.
      { data: 'cp:1', style: 'danger' },
    ]);
    expect(colorReads()).toBe(1);
  });

  it('draws no style at all when neither the category nor the generic button has one', async () => {
    const { messenger, bodies } = harness({}, { [VPN]: 'success' });
    await send(messenger);
    expect(cells(bodies[0])[2]).toEqual({ data: `c:${NEW}.0`, style: undefined });
  });

  it('keeps every route byte for byte whatever the colours say', async () => {
    const plain = harness({}, {});
    await send(plain.messenger);
    const coloured = harness({}, { [VPN]: 'danger', [GAMING]: 'success', [NEW]: 'primary' });
    await send(coloured.messenger);
    expect(cells(coloured.bodies[0]).map((cell) => cell.data)).toEqual(
      cells(plain.bodies[0]).map((cell) => cell.data),
    );
  });

  it('does not read the colours for a keyboard with no category on it', async () => {
    const { messenger, colorReads } = harness({}, { [VPN]: 'success' });
    await send(messenger, [{ ...inlineLabel('catalog.next_page'), data: 'cp:1' }]);
    expect(colorReads()).toBe(0);
  });

  it('falls back to the generic style in a stand-in with no colour reader', async () => {
    const { messenger, bodies } = harness({ 'catalog.category': 'success' }, undefined);
    await send(messenger);
    expect(
      cells(bodies[0])
        .slice(0, 3)
        .map((cell) => cell.style),
    ).toEqual(['success', 'success', 'success']);
  });

  it('ignores a category id on a button that is not a category button', async () => {
    const { messenger, bodies } = harness({ 'catalog.product': 'primary' }, { [VPN]: 'danger' });
    await send(messenger, [
      {
        ...inlineDataLabel('catalog.product', { kind: 'TEXT', text: 'plan' }),
        data: 'p:x',
        category: VPN,
      },
    ]);
    expect(cells(bodies[0])).toEqual([{ data: 'p:x', style: 'primary' }]);
  });
});
