import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  money,
  type AppearanceSlot,
  type BotInstanceId,
  type TenantContext,
} from '@nexa/contracts';
import { CATALOGUE_FA, formatMoney } from '@nexa/i18n';
import type {
  AppearanceReader,
  CustomerButton,
  CustomerEditMessage,
  CustomerMessage,
} from '../../apps/api/src/modules/commerce/messaging/application/ports';
import {
  inlineDataLabel,
  inlineLabel,
} from '../../apps/api/src/modules/commerce/messaging/application/inline-buttons';
import { NO_DECORATION } from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';
import {
  RICH_MESSAGE_REFUSED_CODE,
  type RichMessageMode,
} from '../../apps/api/src/modules/commerce/messaging/application/rich-messages';
import { TelegramCustomerMessenger } from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';

/**
 * R4 PR-F (F1): the ONE shared sender path for inline-keyboard screens, in both modes.
 *
 * `fetch` is stubbed, as in `telegram-messenger-parts.test.ts`: the honest fixture is the
 * HTTP request the messenger makes and the answer it reads, not a fake transport.
 */

const scope = { tenantId: '01900000-0000-7000-8000-000000000001' } as unknown as TenantContext;
const botInstanceId = '01900000-0000-7000-8000-0000000000bb' as BotInstanceId;
const PLAIN_KEY = 'bot.catalog.heading' as const;
const HTML_KEY = 'bot.admin.reminder_choose' as const;
const TERMS_KEY = 'bot.terms.required' as const;
const OK = { status: 200, body: { ok: true, result: { message_id: 11 } } } as const;
const REFUSED = {
  status: 400,
  body: { ok: false, error_code: 400, description: 'Bad Request: RICH_MESSAGE_INVALID' },
} as const;
const NOT_MODIFIED = {
  status: 400,
  body: { ok: false, error_code: 400, description: 'Bad Request: message is not modified' },
} as const;

type Answer = { readonly status: number; readonly body: unknown };
interface Call {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

const ELIGIBLE_EMOJI = '5368324170671202286';

function harness(
  options: {
    readonly mode?: RichMessageMode | 'ABSENT';
    readonly rendered?: Partial<Record<string, string>>;
    readonly eligible?: boolean;
    readonly marked?: Partial<Record<string, string>>;
    readonly markedFails?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const events: { code: string; dedupeKey?: string; context?: Record<string, unknown> }[] = [];
  const appearance: AppearanceReader = {
    decorationFor: async () =>
      options.eligible === true
        ? {
            customEmoji: new Map<AppearanceSlot, string>([['success', ELIGIBLE_EMOJI]]),
            eligible: true,
          }
        : NO_DECORATION,
    configuredDecoration: async () => NO_DECORATION,
    recordRuntimeRefusal: async () => undefined,
  };
  const rendered = options.rendered ?? {};
  const renderer = {
    render: async (_scope: unknown, key: string) =>
      rendered[key] ?? CATALOGUE_FA[key as never] ?? key,
    ...(options.marked === undefined && options.markedFails !== true
      ? {}
      : {
          renderWithInstants: async (_scope: unknown, key: string) => {
            if (options.markedFails === true) throw new Error('resolution failed');
            return {
              text: rendered[key] ?? key,
              marked: options.marked?.[key] ?? rendered[key] ?? key,
            };
          },
        }),
  };
  const mode = options.mode ?? { enabled: false, premiumEmoji: false };
  const messenger = new TelegramCustomerMessenger(
    renderer as never,
    { tokenForBotInstance: async () => 'test-token' } as never,
    {
      record: async (_scope: unknown, event: (typeof events)[number]) => {
        events.push(event);
      },
    } as never,
    { conditionIsOpen: async () => false } as never,
    'https://telegram.invalid',
    1000,
    undefined,
    appearance,
    {
      stylesFor: async () => ({ 'payment.wallet': 'success' }),
      categoryColorsFor: async () => ({}),
      iconsFor: async () => ({}),
      categoryIconsFor: async () => ({}),
    } as never,
    undefined,
    mode === 'ABSENT'
      ? undefined
      : {
          modeFor: async () => mode,
          now: () => new Date('2026-10-19T12:30:00Z'),
        },
  );
  const respondWith = (answers: readonly Answer[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        const answer = answers[Math.min(calls.length, answers.length - 1)];
        if (answer === undefined) throw new Error('no answer scripted');
        calls.push({
          method: url.split('/').at(-1) as string,
          body: JSON.parse(init.body) as Record<string, unknown>,
        });
        return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
      }),
    );
  return { messenger, calls, events, respondWith };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const ON: RichMessageMode = { enabled: true, premiumEmoji: false };
const PREMIUM: RichMessageMode = { enabled: true, premiumEmoji: true };
/** R5C-2 B2: «نمایش پلن‌ها به‌صورت جدول» on, beside the rich-message switch. */
const TABLE: RichMessageMode = { enabled: true, premiumEmoji: false, planTable: true };

const PRICE = money(250_000n, 'IRT');

/** The plan list, as `BotRuntime.categoryPage` builds it. */
const planButtons: CustomerButton[] = [
  {
    ...inlineDataLabel('catalog.product', {
      kind: 'TEXT',
      text: 'پلن طلایی',
      amount: PRICE,
    }),
    data: 'o:01900000-0000-7000-8000-0000000000aa',
    planFacts: { trafficBytes: 53_687_091_200n, durationDays: 30 },
  },
  { ...inlineLabel('catalog.back_to_categories'), data: 'c:0' },
];

/** The card-to-card invoice's shape: two copy controls side by side above one action. */
const invoiceButtons: CustomerButton[] = [
  { ...inlineLabel('payment.copy_card'), copyText: '6037997512345678', row: 1 },
  { ...inlineLabel('payment.copy_amount'), copyText: '250000', row: 1 },
  { ...inlineLabel('payment.sent'), data: 'ps:1' },
  { ...inlineLabel('payment.gateway_pay'), url: 'https://pay.example/i/1' },
  { ...inlineLabel('payment.wallet'), data: 'pw:1' },
];

/** Every screen shape the shared sender carries, as the screen builders produce them. */
const SCREENS: readonly { readonly name: string; readonly message: CustomerMessage }[] = [
  {
    name: 'plan list (plain, data buttons, plan figures)',
    message: {
      chatId: '42',
      botInstanceId,
      templateKey: PLAIN_KEY,
      values: {},
      buttons: planButtons,
    },
  },
  {
    name: 'invoice (HTML, copy + url + callback rows)',
    message: {
      chatId: '42',
      botInstanceId,
      templateKey: HTML_KEY,
      values: {},
      buttons: invoiceButtons,
    },
  },
  {
    name: 'terms (collapsed layout)',
    message: {
      chatId: '42',
      botInstanceId,
      templateKey: TERMS_KEY,
      values: { title: 'قوانین', body: 'بند یک' },
      buttons: [{ ...inlineLabel('terms.accept'), data: 't:1' }],
    },
  },
  {
    name: 'reply to a message',
    message: {
      chatId: '42',
      botInstanceId,
      templateKey: PLAIN_KEY,
      values: {},
      buttons: planButtons,
      replyToMessageId: 5,
    },
  },
  {
    name: 'main menu (reply keyboard, never rich)',
    message: {
      chatId: '42',
      botInstanceId,
      templateKey: PLAIN_KEY,
      values: {},
      keyboard: 'MAIN_MENU',
    },
  },
  {
    name: 'buttons beside the main menu keyboard (never rich: the reply keyboard is unchanged)',
    message: {
      chatId: '42',
      botInstanceId,
      templateKey: PLAIN_KEY,
      values: {},
      buttons: planButtons,
      keyboard: 'MAIN_MENU',
    },
  },
  {
    name: 'no buttons (never rich)',
    message: { chatId: '42', botInstanceId, templateKey: PLAIN_KEY, values: {} },
  },
];

const RENDERED = {
  [PLAIN_KEY]: 'سرویس‌های قابل خرید:\n\n{icon:success} یکی را انتخاب کنید',
  [HTML_KEY]: 'مبلغ <b>۲۵۰٬۰۰۰</b>\nکارت: <code>6037</code>',
  [TERMS_KEY]: 'قوانین\nبند یک\nبند دو',
};

async function sendAll(mode: RichMessageMode | 'ABSENT', eligible = false): Promise<Call[][]> {
  const out: Call[][] = [];
  for (const screen of SCREENS) {
    const { messenger, calls, respondWith } = harness({ mode, rendered: RENDERED, eligible });
    respondWith([OK]);
    await messenger.send(scope, screen.message);
    out.push(calls);
  }
  return out;
}

describe('with every switch off, the output is byte for byte what it was', () => {
  it('sends every screen type exactly as a messenger without the rich seam does', async () => {
    for (const eligible of [false, true]) {
      const before = await sendAll('ABSENT', eligible);
      const off = await sendAll({ enabled: false, premiumEmoji: false }, eligible);
      // Premium alone, without rich messages, is inert.
      const premiumOnly = await sendAll({ enabled: false, premiumEmoji: true }, eligible);
      expect(JSON.stringify(off)).toBe(JSON.stringify(before));
      expect(JSON.stringify(premiumOnly)).toBe(JSON.stringify(before));
      for (const calls of off) for (const call of calls) expect(call.method).toBe('sendMessage');
    }
  });

  it('pins the plan list as it has always been sent', async () => {
    const [plan] = await sendAll({ enabled: false, premiumEmoji: false });
    expect(plan).toEqual([
      {
        method: 'sendMessage',
        body: {
          chat_id: '42',
          text: 'سرویس‌های قابل خرید:\n\n✅ یکی را انتخاب کنید',
          link_preview_options: { is_disabled: true },
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: `پلن طلایی — ${formatMoney(PRICE)}`,
                  callback_data: 'o:01900000-0000-7000-8000-0000000000aa',
                },
              ],
              [
                {
                  text: CATALOGUE_FA['bot.catalog.back_to_categories_button'],
                  callback_data: 'c:0',
                },
              ],
            ],
          },
        },
      },
    ]);
  });

  it('edits exactly as before', async () => {
    const edit: CustomerEditMessage = {
      chatId: '42',
      messageId: 9,
      botInstanceId,
      templateKey: PLAIN_KEY,
      values: {},
      buttons: planButtons,
    };
    const a = harness({ mode: 'ABSENT', rendered: RENDERED });
    a.respondWith([OK]);
    await a.messenger.edit(scope, edit);
    const b = harness({ rendered: RENDERED });
    b.respondWith([OK]);
    await b.messenger.edit(scope, edit);
    expect(b.calls).toEqual(a.calls);
    expect(b.calls[0]?.method).toBe('editMessageText');
    expect(b.calls[0]?.body).not.toHaveProperty('rich_message');
  });
});

/** Every route a body carries, in order: what a tap sends back, or opens, or copies. */
function routesOf(body: unknown): string[] {
  const routes: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.callback_data === 'string') routes.push(`data:${record.callback_data}`);
    if (typeof record.url === 'string' && record.type === undefined)
      routes.push(`url:${record.url}`);
    if (record.copy_text !== undefined) routes.push(`copy:${JSON.stringify(record.copy_text)}`);
    Object.entries(record).forEach(([key, inner]) => {
      if (key !== 'copy_text') visit(inner);
    });
  };
  visit(body);
  return routes;
}

describe('with «دکمه‌های داخل پیام» on', () => {
  it('sends an inline-button screen as a rich message with its buttons inside it', async () => {
    const { messenger, calls, respondWith } = harness({ mode: TABLE, rendered: RENDERED });
    respondWith([OK]);
    const result = await messenger.send(scope, SCREENS[0]?.message as CustomerMessage);
    expect(result).toEqual({ outcome: 'DELIVERED', messageId: 11 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('sendRichMessage');
    const body = calls[0]?.body as {
      rich_message: { blocks: { type: string }[]; is_rtl: boolean };
    };
    expect(body).not.toHaveProperty('reply_markup');
    expect(body.rich_message.is_rtl).toBe(true);
    expect(body.rich_message.blocks.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'table',
      'buttons',
      'buttons',
    ]);
    // Premium off: the marker is its plain emoji, never a custom emoji node.
    expect(JSON.stringify(body)).not.toContain('custom_emoji');
  });

  it('routes every tap exactly as the ordinary keyboard does', async () => {
    const off = await sendAll({ enabled: false, premiumEmoji: false });
    const on = await sendAll(ON);
    SCREENS.forEach((screen, index) => {
      const routesOff = (off[index] ?? []).flatMap((call) => routesOf(call.body));
      const routesOn = (on[index] ?? []).flatMap((call) => routesOf(call.body));
      expect(routesOn, screen.name).toEqual(routesOff);
    });
    // Rich where it applies, ordinary where it does not.
    expect(on.map((calls) => calls.map((call) => call.method))).toEqual([
      ['sendRichMessage'],
      ['sendRichMessage'],
      ['sendRichMessage'],
      ['sendRichMessage'],
      ['sendMessage'],
      ['sendMessage'],
      ['sendMessage'],
    ]);
  });

  it('keeps the styles of the ordinary keyboard on the buttons inside the message', async () => {
    const on = await sendAll(ON);
    expect(JSON.stringify(on[1])).toContain('"style":"success"');
  });

  it('draws the plan table — name, traffic, days, price — compact', async () => {
    const { messenger, calls, respondWith } = harness({ mode: TABLE, rendered: RENDERED });
    respondWith([OK]);
    await messenger.send(scope, SCREENS[0]?.message as CustomerMessage);
    const blocks = (calls[0]?.body.rich_message as { blocks: Record<string, unknown>[] }).blocks;
    const table = blocks.find((block) => block.type === 'table') as {
      cells: { text: string }[][];
      is_compact: boolean;
    };
    expect(table.is_compact).toBe(true);
    expect(table.cells.map((row) => row.map((cell) => cell.text))).toEqual([
      [
        CATALOGUE_FA['bot.catalog.table_name_header'],
        CATALOGUE_FA['bot.catalog.table_traffic_header'],
        CATALOGUE_FA['bot.catalog.table_days_header'],
        CATALOGUE_FA['bot.catalog.table_price_header'],
      ],
      // The stand-in renderer returns each cell template's raw default body.
      ['پلن طلایی', '{traffic}', '{durationDays}', formatMoney(PRICE)],
    ]);
  });

  /**
   * R5C-2 B2. The owner does not want the plan list as a table automatically. With the rich
   * switch on and «نمایش پلن‌ها به‌صورت جدول» off, the plan list is the table-less blocks.
   * MUTATION: drawing the table whenever rich messages are on fails this test.
   */
  it('R5C-2 B2: draws NO table with the table switch off, and is otherwise the same screen', async () => {
    const send = async (mode: RichMessageMode) => {
      const { messenger, calls, respondWith } = harness({ mode, rendered: RENDERED });
      respondWith([OK]);
      await messenger.send(scope, SCREENS[0]?.message as CustomerMessage);
      return (calls[0]?.body.rich_message as { blocks: { type: string }[] }).blocks;
    };
    const off = await send(ON);
    const on = await send(TABLE);
    expect(off.map((block) => block.type)).not.toContain('table');
    expect(on.map((block) => block.type)).toContain('table');
    expect(off).toEqual(on.filter((block) => block.type !== 'table'));
    // Inert without the rich switch: the ordinary message is untouched by the table switch.
    const plain = harness({
      mode: { enabled: false, premiumEmoji: false, planTable: true },
      rendered: RENDERED,
    });
    plain.respondWith([OK]);
    await plain.messenger.send(scope, SCREENS[0]?.message as CustomerMessage);
    expect(plain.calls[0]?.method).toBe('sendMessage');
  });

  it('collapses the rules into a details block', async () => {
    const on = await sendAll(ON);
    const blocks = (on[2]?.[0]?.body.rich_message as { blocks: Record<string, unknown>[] }).blocks;
    expect(blocks[0]).toEqual({
      type: 'details',
      summary: 'قوانین',
      blocks: [
        { type: 'paragraph', text: 'بند یک' },
        { type: 'paragraph', text: 'بند دو' },
      ],
    });
  });

  it('puts each expiry date in a date_time rich text (F6)', async () => {
    const { messenger, calls, respondWith } = harness({
      mode: ON,
      rendered: { [PLAIN_KEY]: 'انقضا: ۱۴۰۵/۰۸/۱۰' },
      marked: { [PLAIN_KEY]: 'انقضا: 1700000000۱۴۰۵/۰۸/۱۰' },
    });
    respondWith([OK]);
    await messenger.send(scope, SCREENS[0]?.message as CustomerMessage);
    expect(JSON.stringify(calls[0]?.body)).toContain(
      '{"type":"date_time","text":"۱۴۰۵/۰۸/۱۰","unix_time":1700000000,"date_time_format":""}',
    );
  });
});

describe('the fallback: Telegram refuses the rich message', () => {
  it('resends the screen ONCE the old way, byte for byte, and logs one ERROR', async () => {
    const [ordinary] = await sendAll({ enabled: false, premiumEmoji: false });
    const { messenger, calls, events, respondWith } = harness({ mode: ON, rendered: RENDERED });
    respondWith([REFUSED, OK]);
    const result = await messenger.send(scope, SCREENS[0]?.message as CustomerMessage);
    expect(result).toEqual({ outcome: 'DELIVERED', messageId: 11 });
    expect(calls.map((call) => call.method)).toEqual(['sendRichMessage', 'sendMessage']);
    expect(calls[1]).toEqual(ordinary?.[0]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      code: RICH_MESSAGE_REFUSED_CODE,
      severity: 'ERROR',
      dedupeKey: `${RICH_MESSAGE_REFUSED_CODE}:${botInstanceId}@${String(
        Math.floor(Date.parse('2026-10-19T12:30:00Z') / 3_600_000),
      )}`,
      context: {
        botInstanceId,
        templateKey: PLAIN_KEY,
        method: 'sendRichMessage',
        errorCode: 'telegram.rejected.400',
      },
    });
  });

  it('deduplicates: every refusal in the same hour names the same row', async () => {
    const { messenger, events, respondWith } = harness({ mode: ON, rendered: RENDERED });
    respondWith([REFUSED, OK, REFUSED, OK]);
    await messenger.send(scope, SCREENS[0]?.message as CustomerMessage);
    await messenger.send(scope, SCREENS[0]?.message as CustomerMessage);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.dedupeKey)).size).toBe(1);
  });

  it('answers the old way when the resend is refused too, with no third request', async () => {
    const { messenger, calls, respondWith } = harness({ mode: ON, rendered: RENDERED });
    respondWith([REFUSED, REFUSED]);
    expect(await messenger.send(scope, SCREENS[0]?.message as CustomerMessage)).toEqual({
      outcome: 'REFUSED',
    });
    expect(calls).toHaveLength(2);
  });

  it('never resends after an UNKNOWN answer or a rate limit', async () => {
    const unknown = harness({ mode: ON, rendered: RENDERED });
    unknown.respondWith([{ status: 502, body: { ok: false } }, OK]);
    expect(await unknown.messenger.send(scope, SCREENS[0]?.message as CustomerMessage)).toEqual({
      outcome: 'UNKNOWN',
    });
    expect(unknown.calls).toHaveLength(1);
    expect(unknown.events.map((event) => event.code)).not.toContain(RICH_MESSAGE_REFUSED_CODE);

    const limited = harness({ mode: ON, rendered: RENDERED });
    limited.respondWith([{ status: 429, body: { ok: false, parameters: { retry_after: 3 } } }, OK]);
    expect(await limited.messenger.send(scope, SCREENS[0]?.message as CustomerMessage)).toEqual({
      outcome: 'RATE_LIMITED',
      retryAfterMs: 3000,
    });
    expect(limited.calls).toHaveLength(1);
  });

  it('sends the old way, with no request and no log, a text it cannot convert exactly', async () => {
    const { messenger, calls, events, respondWith } = harness({
      mode: ON,
      rendered: { [HTML_KEY]: '<blockquote>نقل</blockquote>' },
    });
    respondWith([OK]);
    await messenger.send(scope, SCREENS[1]?.message as CustomerMessage);
    expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
    expect(events).toEqual([]);
  });

  it('falls back on an edit too, and reads "not modified" as done', async () => {
    const edit: CustomerEditMessage = {
      chatId: '42',
      messageId: 9,
      botInstanceId,
      templateKey: PLAIN_KEY,
      values: {},
      buttons: planButtons,
    };
    const ordinary = harness({ rendered: RENDERED });
    ordinary.respondWith([OK]);
    await ordinary.messenger.edit(scope, edit);

    const refused = harness({ mode: ON, rendered: RENDERED });
    refused.respondWith([REFUSED, OK]);
    expect(await refused.messenger.edit(scope, edit)).toEqual({ outcome: 'DELIVERED' });
    expect(refused.calls[0]?.body).toMatchObject({ chat_id: '42', message_id: 9 });
    expect(refused.calls[0]?.body).toHaveProperty('rich_message');
    expect(refused.calls[0]?.body).not.toHaveProperty('text');
    expect(refused.calls[1]).toEqual(ordinary.calls[0]);
    expect(refused.events.map((event) => event.context?.method)).toEqual(['editMessageText']);

    const same = harness({ mode: ON, rendered: RENDERED });
    same.respondWith([NOT_MODIFIED, OK]);
    expect(await same.messenger.edit(scope, edit)).toEqual({ outcome: 'DELIVERED' });
    expect(same.calls).toHaveLength(1);
    expect(same.events).toEqual([]);
  });
});

describe('premium emoji in rich messages (F3)', () => {
  it('draws the slot as a custom emoji only with «ایموجی پریمیوم» on and an eligible bot', async () => {
    const premium = await sendAll(PREMIUM, true);
    expect(JSON.stringify(premium[0])).toContain(
      `{"type":"custom_emoji","custom_emoji_id":"${ELIGIBLE_EMOJI}","alternative_text":"✅"}`,
    );
    for (const [mode, eligible] of [
      [ON, true],
      [PREMIUM, false],
    ] as const) {
      const sent = await sendAll(mode, eligible);
      expect(JSON.stringify(sent[0])).not.toContain('custom_emoji');
      expect(JSON.stringify(sent[0])).toContain('✅ یکی را انتخاب کنید');
    }
  });

  it('never fails the screen: a refused premium rich message is sent the ordinary way', async () => {
    const [ordinary] = await sendAll({ enabled: false, premiumEmoji: false }, true);
    const { messenger, calls, respondWith } = harness({
      mode: PREMIUM,
      rendered: RENDERED,
      eligible: true,
    });
    respondWith([REFUSED, OK]);
    expect(await messenger.send(scope, SCREENS[0]?.message as CustomerMessage)).toEqual({
      outcome: 'DELIVERED',
      messageId: 11,
    });
    expect(calls[0]?.method).toBe('sendRichMessage');
    expect(calls[1]).toEqual(ordinary?.[0]);
  });
});

describe('PR #295 review', () => {
  it('edits a screen with no buttons the ordinary way even with the switch on', async () => {
    const edit: CustomerEditMessage = {
      chatId: '42',
      messageId: 9,
      botInstanceId,
      templateKey: PLAIN_KEY,
      values: {},
      buttons: [],
    };
    const ordinary = harness({ rendered: RENDERED });
    ordinary.respondWith([OK]);
    await ordinary.messenger.edit(scope, edit);
    const on = harness({ mode: ON, rendered: RENDERED });
    on.respondWith([OK]);
    expect(await on.messenger.edit(scope, edit)).toEqual({ outcome: 'DELIVERED' });
    expect(on.calls).toEqual(ordinary.calls);
    expect(on.calls[0]?.body).not.toHaveProperty('rich_message');
  });

  it('sends the ordinary message when building the rich one fails, never failing the reply', async () => {
    const [ordinary] = await sendAll({ enabled: false, premiumEmoji: false });
    const { messenger, calls, events, respondWith } = harness({
      mode: ON,
      rendered: RENDERED,
      markedFails: true,
    });
    respondWith([OK]);
    expect(await messenger.send(scope, SCREENS[0]?.message as CustomerMessage)).toEqual({
      outcome: 'DELIVERED',
      messageId: 11,
    });
    expect(calls).toEqual(ordinary);
    expect(events).toEqual([]);
  });
});
