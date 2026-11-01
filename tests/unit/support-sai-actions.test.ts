import { describe, expect, it } from 'vitest';
import {
  BUSINESS_MESSAGE_TEXT_MAX,
  SUPPORT_AI_TOOL_CALL_LIMIT,
  businessOutboundButtonsSchema,
  parseSupportAiCallbackData,
  parseSupportAiStartPayload,
  supportAiCallbackData,
  supportAiStartPayload,
} from '@nexa/contracts';
import {
  composeAiMessage,
  composeButtons,
  deepLinkUrl,
  paymentCheckBranch,
  paymentCheckSummary,
  planAction,
  toolCallLimitReached,
  type ActionContext,
  type PaymentCheckFact,
} from '../../apps/api/src/modules/control/support-ai/domain/actions';
import {
  autoPreflight,
  moneyMatterOf,
} from '../../apps/api/src/modules/control/support-ai/domain/auto-reply-guards';
import {
  checkOutputPolicy,
  outputPolicyAllowanceFromContext,
} from '../../apps/api/src/modules/control/support-ai/domain/output-policy';
import {
  businessUpdateOf,
  parseBusinessCallback,
} from '../../apps/api/src/modules/commerce/business-chats/domain/telegram-business';
import { businessTextMessageBody } from '../../apps/api/src/infrastructure/telegram/send-message';
import { intentOf } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import { KNOWLEDGE_GAP_REASONS } from '../../apps/api/src/modules/control/support-ai/domain/support-gaps';

/**
 * Phase 4 PR-3 — the support AI's tools, deep links and check-before-handoff, pure: tool scoping
 * (cross-cutting item 1), the tool-call limit (item 7), the validator's link allowance, the
 * deep-link and callback codecs, the bot's routing of a deep link, the money matter, the payment
 * branches and the Persian summary.
 */

const SERVICE_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const OTHER_SERVICE_ID = '0190a1b2-c3d4-7e5f-8a9b-ffffffffffff';
const PRODUCT_ID = '0190a1b2-c3d4-7e5f-8a9b-111111111111';

const linked: ActionContext = {
  linked: true,
  services: new Map([['S1', SERVICE_ID]]),
  catalogue: new Map([['C1', PRODUCT_ID]]),
  botUsername: 'nexa_test_bot',
};

describe('tool scoping: a tool takes no id from the model, only an alias of THIS payload', () => {
  it('resolves an alias the payload showed to the server-side row', () => {
    expect(planAction({ kind: 'SEND_SUBSCRIPTION_LINK', target: 'S1' }, linked)).toEqual({
      kind: 'subscription_link',
      serviceId: SERVICE_ID,
    });
    expect(planAction({ kind: 'RENEW', target: 'S1' }, linked)).toEqual({
      kind: 'deep_link',
      action: 'RENEW',
      flow: 'renew',
      id: SERVICE_ID,
    });
    expect(planAction({ kind: 'BUY', target: 'C1' }, linked)).toMatchObject({
      kind: 'deep_link',
      productId: PRODUCT_ID,
    });
  });

  it.each([
    ['an alias the payload did not show', { kind: 'SEND_SUBSCRIPTION_LINK', target: 'S2' }],
    ['a UUID prefix', { kind: 'SEND_SUBSCRIPTION_LINK', target: OTHER_SERVICE_ID.slice(0, 4) }],
    ['a payment alias for a service tool', { kind: 'SEND_SUBSCRIPTION_LINK', target: 'P1' }],
    ['a lower-case alias', { kind: 'SEND_SUBSCRIPTION_LINK', target: 's1' }],
    ['an empty target for a service tool', { kind: 'ROTATE_LINK', target: '' }],
    ['a target for the payment tool', { kind: 'PAYMENT_STATUS', target: 'P1' }],
    ['a plan alias the payload did not show', { kind: 'BUY', target: 'C9' }],
    ['a target for the trial', { kind: 'TRIAL', target: 'S1' }],
    ['a target for the top-up', { kind: 'WALLET_TOPUP', target: '1' }],
  ] as const)('refuses %s', (_label, action) => {
    expect(planAction(action, linked)).toMatchObject({ kind: 'refused', why: 'target' });
  });

  it('an unlinked customer gets no account tool; a service action opens the bot instead', () => {
    const unlinked = { ...linked, linked: false, services: new Map<string, string>() };
    expect(planAction({ kind: 'SEND_SUBSCRIPTION_LINK', target: 'S1' }, unlinked)).toMatchObject({
      kind: 'refused',
      why: 'unlinked',
    });
    expect(planAction({ kind: 'PAYMENT_STATUS', target: '' }, unlinked)).toMatchObject({
      kind: 'refused',
      why: 'unlinked',
    });
    expect(planAction({ kind: 'RENEW', target: 'S1' }, unlinked)).toEqual({
      kind: 'open_bot',
      action: 'RENEW',
    });
    // A trial for an unlinked customer: the bot's claim decides (no customer to read yet).
    expect(planAction({ kind: 'TRIAL', target: '' }, unlinked)).toEqual({
      kind: 'deep_link',
      action: 'TRIAL',
      flow: 'trial',
      id: null,
    });
    expect(planAction({ kind: 'TRIAL', target: '' }, linked)).toMatchObject({ trialCheck: true });
  });

  it('no bot to open: every deep link is refused; NONE and an absent action are nothing', () => {
    const noBot = { ...linked, botUsername: null };
    for (const kind of ['RENEW', 'BUY', 'TRIAL', 'WALLET_TOPUP'] as const) {
      expect(planAction({ kind, target: kind === 'RENEW' ? 'S1' : '' }, noBot)).toMatchObject({
        kind: 'refused',
        why: 'no_bot',
      });
    }
    expect(planAction(undefined, linked)).toEqual({ kind: 'none' });
    expect(planAction({ kind: 'NONE', target: 'S1' }, linked)).toEqual({ kind: 'none' });
  });
});

describe('the tool-call limit (cross-cutting item 7)', () => {
  it(`allows ${String(SUPPORT_AI_TOOL_CALL_LIMIT)} calls in an epoch and stops the next`, () => {
    expect(toolCallLimitReached(SUPPORT_AI_TOOL_CALL_LIMIT - 1)).toBe(false);
    expect(toolCallLimitReached(SUPPORT_AI_TOOL_CALL_LIMIT)).toBe(true);
    expect(toolCallLimitReached(0, 0)).toBe(true);
  });
});

describe('the validator allows a customer’s own link only when the tool sends it', () => {
  const link = 'https://sub.example.test/s/abcdef123456';
  const context = JSON.stringify({ services: [{ alias: 'S1', label: 'nx1234567890' }] });
  const now = new Date('2026-11-01T10:00:00Z');
  const text = `لینک شما:\n🔗 لینک اشتراک سرویس nx1234567890:\n${link}`;

  it('refuses the link with no allowance (a reply that merely names it)', () => {
    expect(checkOutputPolicy(text, outputPolicyAllowanceFromContext(context), now).ok).toBe(false);
  });

  it('lets it through when the allowance holds that one link', () => {
    expect(
      checkOutputPolicy(text, outputPolicyAllowanceFromContext(context, { links: [link] }), now).ok,
    ).toBe(true);
  });

  it('another link beside it is still refused', () => {
    expect(
      checkOutputPolicy(
        `${text}\nhttps://evil.example/x`,
        outputPolicyAllowanceFromContext(context, { links: [link] }),
        now,
      ).ok,
    ).toBe(false);
  });
});

describe('deep links: each payload names an EXISTING bot flow', () => {
  it('round-trips and stays inside Telegram’s 64 characters', () => {
    const payload = supportAiStartPayload('renew', SERVICE_ID);
    expect(payload).toBe(`sai-rn-${SERVICE_ID}`);
    expect(payload.length).toBeLessThanOrEqual(64);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(parseSupportAiStartPayload(payload)).toEqual({ flow: 'renew', id: SERVICE_ID });
    expect(parseSupportAiStartPayload('sai-t')).toEqual({ flow: 'trial', id: null });
    expect(deepLinkUrl('nexa_test_bot', 'topup', null)).toBe(
      'https://t.me/nexa_test_bot?start=sai-w',
    );
  });

  it('refuses a flow with the wrong id shape, an unknown flow, and anything else', () => {
    expect(() => supportAiStartPayload('renew', null)).toThrow();
    expect(() => supportAiStartPayload('trial', SERVICE_ID)).toThrow();
    expect(() => supportAiStartPayload('renew', 'not-a-uuid')).toThrow();
    for (const bad of ['sai-rn', 'sai-t-' + SERVICE_ID, 'sai-zz', 'sai-rn-XYZ', 'ref123', null]) {
      expect(parseSupportAiStartPayload(bad)).toBeNull();
    }
  });

  const startUpdate = (payload: string) => ({
    update_id: 1,
    message: { message_id: 1, chat: { id: 7, type: 'private' }, text: `/start ${payload}` },
  });

  it.each([
    ['b', 'CATALOG', null],
    [`c-${SERVICE_ID}`, 'REORDER_CATEGORY', SERVICE_ID],
    [`rn-${SERVICE_ID}`, 'SERVICE_RENEW', SERVICE_ID],
    [`at-${SERVICE_ID}`, 'SERVICE_ADD_TRAFFIC', SERVICE_ID],
    [`am-${SERVICE_ID}`, 'SERVICE_ADD_TIME', SERVICE_ID],
    [`lc-${SERVICE_ID}`, 'SERVICE_CHANGE_LOCATION', SERVICE_ID],
    [`ro-${SERVICE_ID}`, 'SERVICE_ROTATE_ASK', SERVICE_ID],
    [`sv-${SERVICE_ID}`, 'SERVICE', SERVICE_ID],
    // Review of PR #369 (D12): the main menu, never the claim itself.
    ['t', 'MAIN_MENU', null],
    ['w', 'TOPUP_MENU', null],
  ])('the bot routes /start sai-%s to its own %s', (code, intent, target) => {
    expect(intentOf(startUpdate(`sai-${code}`))).toMatchObject({ intent, targetId: target });
  });

  it('an ordinary /start, a referral code or a malformed link is the start screen', () => {
    for (const payload of ['support', 'ref_ABC123', 'sai-zz', `sai-rn-${SERVICE_ID}x`]) {
      expect(intentOf(startUpdate(payload))).toMatchObject({ intent: 'START', targetId: null });
    }
  });
});

describe('the support AI’s callbacks and the Business keyboard', () => {
  it('callback data names a row and an action, nothing else', () => {
    const data = supportAiCallbackData('human', SERVICE_ID);
    expect(data).toBe(`sai:h:${SERVICE_ID}`);
    expect(data.length).toBeLessThanOrEqual(64);
    expect(parseSupportAiCallbackData(data)).toEqual({ action: 'human', rowId: SERVICE_ID });
    for (const bad of ['sai:x:' + SERVICE_ID, 'sai:h:nope', 'r:' + SERVICE_ID, null]) {
      expect(parseSupportAiCallbackData(bad)).toBeNull();
    }
  });

  it('a tap on a business message is a business update, never the customer turn', () => {
    const tap = {
      update_id: 5,
      callback_query: {
        id: 'cq-1',
        data: supportAiCallbackData('yes', SERVICE_ID),
        from: { id: 7000001 },
        message: { message_id: 901, chat: { id: 7000001 }, business_connection_id: 'conn-1' },
      },
    };
    expect(businessUpdateOf(tap)).toMatchObject({ kind: 'CALLBACK' });
    expect(parseBusinessCallback(tap.callback_query)).toEqual({
      callbackQueryId: 'cq-1',
      data: supportAiCallbackData('yes', SERVICE_ID),
      fromUserId: '7000001',
      chatId: '7000001',
      messageId: 901,
      connectionId: 'conn-1',
    });
    // A tap in the bot's own chat (no business connection) stays the customer turn.
    const own = {
      ...tap,
      callback_query: { ...tap.callback_query, message: { message_id: 1, chat: { id: 7 } } },
    };
    expect(businessUpdateOf(own)).toBeNull();
  });

  it('the keyboard is validated and goes out as reply_markup', () => {
    const buttons = composeButtons({
      action: {
        label: '💊 تمدید',
        url: deepLinkUrl('nexa_test_bot', 'renew', SERVICE_ID),
        callbackData: null,
      },
      feedback: [
        { label: '👍', url: null, callbackData: supportAiCallbackData('yes', SERVICE_ID) },
        { label: '👎', url: null, callbackData: supportAiCallbackData('no', SERVICE_ID) },
      ],
      human: { label: '👤', url: null, callbackData: supportAiCallbackData('human', SERVICE_ID) },
    });
    expect(businessOutboundButtonsSchema.safeParse(buttons).success).toBe(true);
    const body = businessTextMessageBody({
      businessConnectionId: 'conn-1',
      chatId: '7',
      text: 'x',
      buttons,
    });
    expect(body.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '💊 تمدید', url: `https://t.me/nexa_test_bot?start=sai-rn-${SERVICE_ID}` }],
        [
          { text: '👍', callback_data: `sai:y:${SERVICE_ID}` },
          { text: '👎', callback_data: `sai:n:${SERVICE_ID}` },
        ],
        [{ text: '👤', callback_data: `sai:h:${SERVICE_ID}` }],
      ],
    });
    expect(
      businessTextMessageBody({ businessConnectionId: 'c', chatId: '7', text: 'x' }),
    ).not.toHaveProperty('reply_markup');
    // A URL outside t.me, or a button that is both, is refused before it is stored.
    expect(
      businessOutboundButtonsSchema.safeParse([
        [{ label: 'x', url: 'https://evil.example', callbackData: null }],
      ]).success,
    ).toBe(false);
  });

  it('the message is label, reply, tool text, question — and refused past one Telegram message', () => {
    expect(composeAiMessage({ label: 'L', reply: ' R ', extra: 'E', feedbackQuestion: 'Q' })).toBe(
      'L\n\nR\n\nE\n\nQ',
    );
    expect(composeAiMessage({ label: null, reply: 'R', extra: null, feedbackQuestion: null })).toBe(
      'R',
    );
    expect(
      composeAiMessage({
        label: null,
        reply: 'x'.repeat(BUSINESS_MESSAGE_TEXT_MAX),
        extra: 'link',
        feedbackQuestion: null,
      }),
    ).toBeNull();
  });
});

describe('voice, stickers and files with the tools on', () => {
  const base = {
    customerBlocked: false,
    sessionReplies: 0,
    autoInWindow: 0,
    sessionReplyBudget: 6,
    maxPerWindow: 20,
  };
  const voice = { origin: 'INBOUND' as const, kind: 'OTHER' as const, text: null, deleted: false };
  it('pass the content check only when the tools answer them; the other guards still apply', () => {
    expect(autoPreflight({ ...base, trigger: voice })).toMatchObject({
      pass: false,
      guard: 'content',
    });
    expect(autoPreflight({ ...base, trigger: voice, otherIsAnswerable: true })).toMatchObject({
      pass: true,
    });
    expect(
      autoPreflight({ ...base, trigger: voice, otherIsAnswerable: true, customerBlocked: true }),
    ).toMatchObject({ pass: false, guard: 'customer_blocked' });
  });
});

describe('check-before-handoff', () => {
  it.each([
    ['«پرداخت کردم ولی نیومد»', 'PAID_NOT_RECEIVED'],
    ['پول کم شد ولی سرویس نیومد', 'PAID_NOT_RECEIVED'],
    ['خرید کردم ولی هنوز لینک نیومد', 'PAID_NOT_RECEIVED'],
    ['kart be kart kardam', 'PAID_NOT_RECEIVED'],
    ['I paid but nothing came', 'PAID_NOT_RECEIVED'],
    ['پولمو پس بدید', 'DISPUTE'],
    ['ریفاند میخوام', 'DISPUTE'],
    ['شکایت میکنم', 'DISPUTE'],
    ['refund please', 'DISPUTE'],
    ['چند تومنه؟', 'NONE'],
    ['چطوری پرداخت کنم؟', 'NONE'],
  ])('%s is %s', (text, matter) => {
    expect(moneyMatterOf([text])).toBe(matter);
  });

  it('a dispute anywhere in the window wins over «I paid»', () => {
    expect(moneyMatterOf(['پرداخت کردم', 'پولمو پس بدید'])).toBe('DISPUTE');
  });

  const fact = (overrides: Partial<PaymentCheckFact>): PaymentCheckFact => ({
    code: 'ABC23456',
    amount: '250,000 تومان',
    route: 'کارت به کارت',
    gateway: null,
    state: 'CONFIRMED',
    underReview: false,
    stateLabel: 'تأیید شده',
    createdAt: new Date('2026-11-01T09:00:00Z'),
    delivered: null,
    ...overrides,
  });
  const service = { serviceId: SERVICE_ID, username: 'nx1234567890' };

  it('decides each branch from this customer’s facts', () => {
    expect(paymentCheckBranch([])).toEqual({ kind: 'NOT_FOUND' });
    expect(paymentCheckBranch([fact({ state: 'FAILED', stateLabel: 'ناموفق' })])).toEqual({
      kind: 'NOT_FOUND',
    });
    expect(paymentCheckBranch([fact({ state: 'PENDING' })]).kind).toBe('UNDER_REVIEW');
    expect(paymentCheckBranch([fact({ state: 'UNKNOWN' })]).kind).toBe('UNDER_REVIEW');
    expect(paymentCheckBranch([fact({ underReview: true })]).kind).toBe('UNDER_REVIEW');
    expect(paymentCheckBranch([fact({})]).kind).toBe('SETTLED_PENDING');
    expect(paymentCheckBranch([fact({ delivered: service })])).toMatchObject({
      kind: 'SETTLED_DELIVERED',
      service,
    });
    // An open payment decides before a confirmed one, whatever their order.
    expect(
      paymentCheckBranch([
        fact({ delivered: service }),
        fact({ code: 'OPN23456', state: 'PENDING' }),
      ]),
    ).toMatchObject({ kind: 'UNDER_REVIEW', payment: { code: 'OPN23456' } });
  });

  it('the summary names the customer, every payment, and what the customer was told — bounded', () => {
    const summary = paymentCheckSummary({
      customerId: 'cust-1',
      payments: [fact({ gateway: 'TETRAPAY', route: 'درگاه پرداخت' })],
      told: 'پرداخت شما ثبت شده و در حال بررسی است.',
      max: 600,
    });
    expect(summary).toContain('cust-1');
    expect(summary).toContain('ABC23456');
    expect(summary).toContain('تأیید شده');
    expect(summary).toContain('250,000 تومان');
    expect(summary).toContain('TETRAPAY');
    expect(summary).toContain('به مشتری گفته شد');
    expect(
      paymentCheckSummary({ customerId: null, payments: [], told: 'x'.repeat(2000), max: 600 })
        .length,
    ).toBe(600);
  });
});

describe('👎 is a knowledge-gap entry', () => {
  it('the gaps report reads CUSTOMER_UNSATISFIED handoffs (by the answer’s topic and intent)', () => {
    expect(KNOWLEDGE_GAP_REASONS).toContain('CUSTOMER_UNSATISFIED');
  });
});
