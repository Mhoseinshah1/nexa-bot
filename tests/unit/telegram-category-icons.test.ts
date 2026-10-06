import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AppearanceSlot,
  BotInstanceId,
  CategoryColors,
  CategoryIcons,
  InlineButtonIcons,
  TenantContext,
} from '@nexa/contracts';
import type {
  AppearanceReader,
  CustomerButton,
} from '../../apps/api/src/modules/commerce/messaging/application/ports';
import {
  inlineDataLabel,
  inlineLabel,
} from '../../apps/api/src/modules/commerce/messaging/application/inline-buttons';
import { NO_DECORATION } from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';
import {
  APPEARANCE_DECORATION_FAILED_CODE,
  TelegramCustomerMessenger,
} from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';

/**
 * Phase 2 UX wave, Item 2 — a product category's decorations (`bot.category_icons`) on the
 * wire: a premium icon BEFORE the name (`icon_custom_emoji_id`, Item 3's transport) and an
 * ordinary emoji AFTER it (plain text). `fetch` is stubbed: what is under test is what reaches
 * the wire and how many times. A real-bot acceptance of the inline icon is still owed
 * (`OQ-P2-ICON-01`).
 */

const tenantA = {
  tenantId: '01900000-0000-7000-8000-000000000001',
  botInstanceId: null,
} as TenantContext;
const tenantB = {
  tenantId: '01900000-0000-7000-8000-000000000002',
  botInstanceId: null,
} as TenantContext;
const eligibleBot = '01900000-0000-7000-8000-0000000000aa' as BotInstanceId;
const untestedBot = '01900000-0000-7000-8000-0000000000bb' as BotInstanceId;
const CAT_A = '0190a5d6-1c2b-7e3f-8a4b-5c6d7e8f9a0b';
const CAT_B = '0190a5d6-1c2b-7e3f-8a4b-5c6d7e8f9a0c';
const ICON = '5368324170671202286';
const GENERIC_ICON = '5368324170671202287';
const OK = { status: 200, body: { ok: true, result: { message_id: 7 } } };
const DENIAL = {
  status: 400,
  body: { ok: false, error_code: 400, description: 'Bad Request: CUSTOM_EMOJI_INVALID' },
};
type Answer = { status: number; body: unknown } | 'TIMEOUT';

function harness(
  options: {
    readonly categoryIcons?: (scope: TenantContext) => CategoryIcons;
    readonly inlineIcons?: InlineButtonIcons;
    readonly colors?: CategoryColors;
    readonly noCategoryIconReader?: boolean;
  } = {},
) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const events: { code: string; context?: Record<string, unknown> }[] = [];
  const refused: BotInstanceId[] = [];
  let categoryIconReads = 0;
  const appearance: AppearanceReader = {
    decorationFor: async (_scope, botInstanceId) =>
      botInstanceId === eligibleBot
        ? { customEmoji: new Map<AppearanceSlot, string>(), eligible: true }
        : NO_DECORATION,
    configuredDecoration: async () => ({ customEmoji: new Map(), eligible: true }),
    recordRuntimeRefusal: async (_scope, botInstanceId) => {
      refused.push(botInstanceId);
    },
  };
  const messenger = new TelegramCustomerMessenger(
    { render: async (_scope: unknown, key: string) => `label:${key}` } as never,
    { tokenForBotInstance: async () => 'test-token' } as never,
    { record: async (_scope: unknown, event: { code: string }) => events.push(event) } as never,
    { conditionIsOpen: async () => false } as never,
    'https://telegram.invalid',
    1000,
    undefined,
    appearance,
    {
      stylesFor: async () => ({}),
      categoryColorsFor: async () => options.colors ?? {},
      iconsFor: async () => options.inlineIcons ?? {},
      ...(options.noCategoryIconReader === true
        ? {}
        : {
            categoryIconsFor: async (scope: TenantContext) => {
              categoryIconReads += 1;
              return options.categoryIcons?.(scope) ?? {};
            },
          }),
    } as never,
  );
  const respondWith = (answers: readonly Answer[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        const answer = answers[Math.min(calls.length, answers.length - 1)];
        if (answer === undefined) throw new Error('no answer scripted');
        calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
        if (answer === 'TIMEOUT') throw new Error('The operation was aborted due to timeout');
        return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
      }),
    );
  return { messenger, calls, events, refused, respondWith, reads: () => categoryIconReads };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The catalogue keyboard exactly as `BotRuntime.catalogue` builds it (bot-runtime.ts). */
const category = (id: string, label: string): CustomerButton => ({
  ...inlineDataLabel('catalog.category', { kind: 'TEXT', text: label }),
  data: `cat:${id}.0`,
  category: id,
});
const CATALOGUE: readonly CustomerButton[] = [
  category(CAT_A, '🌐 بین‌الملل'),
  category(CAT_B, 'ایران'),
  { ...inlineLabel('catalog.next_page'), data: 'catp:1' },
];

type Cell = Record<string, unknown>;
const cellsOf = (body: Record<string, unknown> | undefined): Cell[] =>
  (
    (body?.['reply_markup'] as { inline_keyboard: Cell[][] } | undefined)?.inline_keyboard ?? []
  ).flat();
const callbacksOf = (body: Record<string, unknown> | undefined) =>
  cellsOf(body).map((cell) => cell['callback_data']);

const send = (
  messenger: TelegramCustomerMessenger,
  botInstanceId: BotInstanceId = eligibleBot,
  scope: TenantContext = tenantA,
) =>
  messenger.send(scope, {
    chatId: '42',
    botInstanceId,
    templateKey: 'bot.catalog.categories_heading',
    values: {},
    buttons: CATALOGUE,
  });

/** The legacy wire: the same keyboard from a messenger with no category-icon reader at all. */
async function legacyBody(botInstanceId: BotInstanceId = eligibleBot) {
  const legacy = harness({ noCategoryIconReader: true });
  legacy.respondWith([OK]);
  await send(legacy.messenger, botInstanceId);
  vi.unstubAllGlobals();
  return legacy.calls[0]?.body;
}

describe('a category button with its decorations', () => {
  it('BEFORE only: the premium icon on that category, the text unchanged', async () => {
    const legacy = await legacyBody();
    const { messenger, calls, respondWith, reads } = harness({
      categoryIcons: () => ({ [CAT_A]: { before: ICON } }),
    });
    respondWith([OK]);
    expect(await send(messenger)).toEqual({ outcome: 'DELIVERED', messageId: 7 });
    expect(cellsOf(calls[0]?.body)).toEqual([
      { text: '🌐 بین‌الملل', callback_data: `cat:${CAT_A}.0`, icon_custom_emoji_id: ICON },
      { text: 'ایران', callback_data: `cat:${CAT_B}.0` },
      { text: 'label:bot.catalog.next_page_button', callback_data: 'catp:1' },
    ]);
    expect(callbacksOf(calls[0]?.body)).toEqual(callbacksOf(legacy));
    expect(reads()).toBe(1);
  });

  it('AFTER only: an ordinary emoji after the name, no icon, from ANY bot', async () => {
    for (const bot of [eligibleBot, untestedBot]) {
      const { messenger, calls, respondWith } = harness({
        categoryIcons: () => ({ [CAT_B]: { after: '🔥' } }),
      });
      respondWith([OK]);
      await send(messenger, bot);
      expect(cellsOf(calls[0]?.body).slice(0, 2)).toEqual([
        { text: '🌐 بین‌الملل', callback_data: `cat:${CAT_A}.0` },
        { text: 'ایران 🔥', callback_data: `cat:${CAT_B}.0` },
      ]);
      vi.unstubAllGlobals();
    }
  });

  it('BOTH: the icon before and the emoji after, on the same button, colour kept', async () => {
    const { messenger, calls, respondWith } = harness({
      categoryIcons: () => ({ [CAT_A]: { before: ICON, after: '⭐' } }),
      colors: { [CAT_A]: 'success' },
    });
    respondWith([OK]);
    await send(messenger);
    expect(cellsOf(calls[0]?.body)[0]).toEqual({
      text: '🌐 بین‌الملل ⭐',
      callback_data: `cat:${CAT_A}.0`,
      style: 'success',
      icon_custom_emoji_id: ICON,
    });
  });

  it('NEITHER: the request is byte for byte the legacy one', async () => {
    const legacy = await legacyBody();
    for (const icons of [{}, { '0190a5d6-0000-7e3f-8a4b-5c6d7e8f9a0b': { before: ICON } }]) {
      const { messenger, calls, respondWith } = harness({ categoryIcons: () => icons });
      respondWith([OK]);
      await send(messenger);
      expect(JSON.stringify(calls[0]?.body)).toBe(JSON.stringify(legacy));
      expect(JSON.stringify(calls[0]?.body)).not.toContain('icon_custom_emoji_id');
      vi.unstubAllGlobals();
    }
  });

  it('every callback is unchanged by any decoration', async () => {
    const legacy = await legacyBody();
    const { messenger, calls, respondWith } = harness({
      categoryIcons: () => ({
        [CAT_A]: { before: ICON, after: '🔥' },
        [CAT_B]: { before: GENERIC_ICON, after: '🇮🇷' },
      }),
    });
    respondWith([OK]);
    await send(messenger);
    expect(callbacksOf(calls[0]?.body)).toEqual(callbacksOf(legacy));
    expect(callbacksOf(calls[0]?.body)).toEqual([`cat:${CAT_A}.0`, `cat:${CAT_B}.0`, 'catp:1']);
  });

  it("the category's own icon wins over the generic category icon, and the others keep the generic", async () => {
    const { messenger, calls, respondWith } = harness({
      categoryIcons: () => ({ [CAT_A]: { before: ICON } }),
      inlineIcons: { 'catalog.category': GENERIC_ICON },
    });
    respondWith([OK]);
    await send(messenger);
    expect(cellsOf(calls[0]?.body).map((cell) => cell['icon_custom_emoji_id'] ?? null)).toEqual([
      ICON,
      GENERIC_ICON,
      null,
    ]);
  });

  it('an INELIGIBLE bot draws no premium icon, but keeps the ordinary after emoji', async () => {
    const legacy = await legacyBody(untestedBot);
    const { messenger, calls, respondWith } = harness({
      categoryIcons: () => ({ [CAT_A]: { before: ICON }, [CAT_B]: { before: ICON, after: '🔥' } }),
      inlineIcons: { 'catalog.category': GENERIC_ICON },
    });
    respondWith([OK]);
    await send(messenger, untestedBot);
    expect(JSON.stringify(calls[0]?.body)).not.toContain('icon_custom_emoji_id');
    expect(cellsOf(calls[0]?.body)[0]).toEqual(cellsOf(legacy)[0]);
    expect(cellsOf(calls[0]?.body)[1]).toEqual({
      text: 'ایران 🔥',
      callback_data: `cat:${CAT_B}.0`,
    });
  });

  it("is each tenant's own: tenant B's keyboard never carries tenant A's decorations", async () => {
    const { messenger, calls, respondWith } = harness({
      categoryIcons: (scope) =>
        scope.tenantId === tenantA.tenantId ? { [CAT_A]: { before: ICON, after: '🔥' } } : {},
    });
    respondWith([OK, OK]);
    await send(messenger, eligibleBot, tenantA);
    await send(messenger, eligibleBot, tenantB);
    expect(cellsOf(calls[0]?.body)[0]).toMatchObject({
      text: '🌐 بین‌الملل 🔥',
      icon_custom_emoji_id: ICON,
    });
    expect(cellsOf(calls[1]?.body)[0]).toEqual({
      text: '🌐 بین‌الملل',
      callback_data: `cat:${CAT_A}.0`,
    });
  });

  it('a keyboard that lists no category never reads the decorations', async () => {
    const { messenger, respondWith, reads } = harness({
      categoryIcons: () => ({ [CAT_A]: { after: '🔥' } }),
    });
    respondWith([OK]);
    await messenger.send(tenantA, {
      chatId: '42',
      botInstanceId: eligibleBot,
      templateKey: 'bot.catalog.categories_heading',
      values: {},
      buttons: [{ ...inlineLabel('catalog.next_page'), data: 'catp:1' }],
    });
    expect(reads()).toBe(0);
  });
});

describe('a refused category icon (owner rule B5, through Item 3’s retry)', () => {
  it('a custom-emoji DENIAL: ONE retry without the icon, after emoji and callbacks kept, the bot NEVER switched off', async () => {
    const { messenger, calls, events, refused, respondWith } = harness({
      categoryIcons: () => ({ [CAT_A]: { before: ICON, after: '🔥' } }),
    });
    respondWith([DENIAL, OK]);
    expect(await send(messenger)).toEqual({ outcome: 'DELIVERED', messageId: 7 });
    expect(calls).toHaveLength(2);
    expect(cellsOf(calls[0]?.body)[0]?.['icon_custom_emoji_id']).toBe(ICON);
    expect(JSON.stringify(calls[1]?.body)).not.toContain('icon_custom_emoji_id');
    expect(cellsOf(calls[1]?.body)[0]).toEqual({
      text: '🌐 بین‌الملل 🔥',
      callback_data: `cat:${CAT_A}.0`,
    });
    expect(callbacksOf(calls[1]?.body)).toEqual(callbacksOf(calls[0]?.body));
    // Review B1 of PR #215: a category's `before` is an operator-typed id, never proven by the
    // appearance probe, so a refusal of it may only mean a wrong id: the bot stays eligible.
    expect(refused).toEqual([]);
    expect(events.map((event) => event.code)).toEqual([APPEARANCE_DECORATION_FAILED_CODE]);
    expect(events[0]?.context).toMatchObject({
      keyboardIcons: true,
      iconSource: 'RAW',
      eligibilityChanged: false,
      inlineButtons: ['catalog.category'],
    });
  });

  it('an after emoji alone is plain text: a refusal is one call, never an icon-less retry', async () => {
    const { messenger, calls, refused, respondWith } = harness({
      categoryIcons: () => ({ [CAT_A]: { after: '🔥' } }),
    });
    respondWith([DENIAL, OK]);
    expect(await send(messenger)).toEqual({ outcome: 'REFUSED' });
    expect(calls).toHaveLength(1);
    expect(refused).toEqual([]);
  });

  it('a timeout with an iconed category keyboard is never re-sent', async () => {
    const { messenger, calls, respondWith } = harness({
      categoryIcons: () => ({ [CAT_A]: { before: ICON } }),
    });
    respondWith(['TIMEOUT', OK]);
    expect((await send(messenger)).outcome).toBe('UNKNOWN');
    expect(calls).toHaveLength(1);
  });
});
