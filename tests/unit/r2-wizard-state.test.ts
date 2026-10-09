import { describe, expect, it } from 'vitest';
import { money, TELEGRAM_WIZARD_STEPS } from '@nexa/contracts';
import {
  BOT_INTENTS,
  gatewayAttemptScreen,
} from '../../apps/api/src/surfaces/telegram/bot-runtime';
import {
  REVIEW_TAP_INTENTS,
  WIZARD_GATES,
  callbackOriginOf,
  typedMessageOf,
} from '../../apps/api/src/surfaces/telegram/wizard-state';

/**
 * R2 (v0.3.5 real-test items 4 and 5): the pieces of edit-in-place that decide WHICH message
 * a reply changes, which taps a wizard still honours, and what an invoice screen says.
 */

describe('the message a tap came from', () => {
  const tapIn = (message: Record<string, unknown>) => ({
    update_id: 1,
    callback_query: { id: 'q', data: 'x', message },
  });

  it('is read from a private chat, with its file-ness', () => {
    expect(callbackOriginOf(tapIn({ message_id: 7, chat: { id: 42, type: 'private' } }))).toEqual({
      chatId: '42',
      messageId: 7,
      media: false,
    });
    expect(
      callbackOriginOf(
        tapIn({ message_id: 8, chat: { id: 42, type: 'private' }, photo: [{ file_id: 'f' }] }),
      ),
    ).toEqual({ chatId: '42', messageId: 8, media: true });
    // A4: a bare tutorial video (no caption) is a file message too.
    expect(
      callbackOriginOf(
        tapIn({ message_id: 9, chat: { id: 42, type: 'private' }, video: { file_id: 'v' } }),
      ),
    ).toEqual({ chatId: '42', messageId: 9, media: true });
  });

  it('is nothing for a group, a missing or malformed id, or an ordinary message', () => {
    expect(callbackOriginOf(tapIn({ message_id: 7, chat: { id: -5, type: 'group' } }))).toBeNull();
    expect(callbackOriginOf(tapIn({ chat: { id: 42, type: 'private' } }))).toBeNull();
    expect(
      callbackOriginOf(tapIn({ message_id: '7', chat: { id: 42, type: 'private' } })),
    ).toBeNull();
    expect(
      callbackOriginOf({ message: { message_id: 1, chat: { id: 1, type: 'private' } } }),
    ).toBeNull();
  });

  it('a typed answer is the customer’s own message, which a wizard step may remove', () => {
    expect(
      typedMessageOf({
        message: { message_id: 9, chat: { id: 42, type: 'private' }, text: 'myname' },
      }),
    ).toEqual({ chatId: '42', messageId: 9 });
    expect(
      typedMessageOf({ message: { message_id: 9, chat: { id: 42, type: 'private' } } }),
    ).toBeNull();
  });
});

describe('the wizard gates', () => {
  it('name only intents the runtime parses, and only real screens', () => {
    for (const [intent, gate] of WIZARD_GATES) {
      expect(BOT_INTENTS as readonly string[], intent).toContain(intent);
      expect(gate.from.length, intent).toBeGreaterThan(0);
      for (const step of gate.from) expect(TELEGRAM_WIZARD_STEPS, intent).toContain(step);
      /*
       * A CLOSED wizard honours nothing: no button of a paid, withdrawn or finalised wizard
       * may move it again. A gate listing CLOSED would reopen one.
       */
      expect(gate.from, intent).not.toContain('CLOSED');
    }
    for (const intent of REVIEW_TAP_INTENTS) {
      expect(BOT_INTENTS as readonly string[], intent).toContain(intent);
    }
  });

  it('never honours a purchase step from a LATER screen: a product only from the product list, payment only from the pre-invoice or its successors', () => {
    expect(WIZARD_GATES.get('ORDER')?.from).toEqual(['PRODUCTS']);
    expect(WIZARD_GATES.get('USERNAME_AUTOMATIC')?.from).toEqual(['USERNAME']);
    expect(WIZARD_GATES.get('PAY_WALLET')?.from).toEqual(['PREINVOICE', 'AWAITING_PAYMENT']);
    expect(WIZARD_GATES.get('CATEGORY')?.from).not.toContain('PREINVOICE');
    expect(WIZARD_GATES.get('TOPUP_PICK')?.from).toEqual(['AMOUNT']);
    expect(WIZARD_GATES.get('TOPUP_ROUTE')?.from).toEqual(['METHODS']);
  });
});

describe('the gateway invoice screen', () => {
  const at = new Date('2026-09-29T10:00:00Z');
  const payment = (overrides: Record<string, unknown> = {}) =>
    ({
      id: '01900000-0000-7000-8000-00000000aaaa',
      orderId: '01900000-0000-7000-8000-00000000bbbb',
      state: 'PENDING',
      amount: money(250_000n, 'IRT'),
      expiresAt: new Date(at.getTime() + 60 * 60_000),
      customerFee: null,
      ...overrides,
    }) as never;
  const invoice = (overrides: Record<string, unknown> = {}) =>
    ({
      provider: 'TONPAYS',
      creationState: 'CREATING',
      webInvoiceUrl: null,
      invoiceUrl: null,
      sentAmount: 0n,
      ...overrides,
    }) as never;
  const data = (screen: ReturnType<typeof gatewayAttemptScreen>) =>
    screen.buttons.map((button) =>
      'data' in button ? button.data : 'url' in button ? `url:${button.url}` : 'copy',
    );

  it('is a loading screen, landed at INVOICE_LOADING and marked pending, while the worker creates the invoice', () => {
    const screen = gatewayAttemptScreen({ payment: payment(), invoice: invoice() }, null, at);
    expect(screen.key).toBe('bot.payment.gateway_preparing');
    /*
     * NOT `INVOICE`: the worker's end-of-attempt move names `INVOICE`, and a loading screen
     * landed there could be claimed by the worker between the landing and the loading edit.
     */
    expect(screen.wizard).toMatchObject({ step: 'INVOICE_LOADING', invoicePending: true });
    // Its check button is the customer's way past a worker edit that did not land.
    expect(data(screen)).toEqual(['gc:01900000-0000-7000-8000-00000000aaaa', 'mm:']);
    expect(WIZARD_GATES.get('GATEWAY_CHECK')?.from).toEqual(
      expect.arrayContaining(['INVOICE_LOADING', 'INVOICE_PENDING', 'INVOICE']),
    );
  });

  it('is the invoice — amount, deadline, the pay link, status check, main menu — once created', () => {
    const screen = gatewayAttemptScreen(
      {
        payment: payment(),
        invoice: invoice({
          creationState: 'CREATED',
          webInvoiceUrl: 'https://pay.tonpays.online/i/1',
          invoiceUrl: 'https://t.me/x',
        }),
      },
      null,
      at,
    );
    expect(screen.key).toBe('bot.payment.gateway_invoice');
    // FIX-02: the invoice carries the payment's public tracking code before anything is paid.
    expect(Object.keys(screen.values).sort()).toEqual(['expiresAt', 'reference', 'total']);
    expect(data(screen)).toEqual([
      'url:https://pay.tonpays.online/i/1',
      'gc:01900000-0000-7000-8000-00000000aaaa',
      'mm:',
    ]);
    expect(screen.wizard).toMatchObject({ step: 'INVOICE' });
    expect(screen.wizard?.invoicePending).toBeUndefined();
  });

  it('a refused or lost create is a truthful end with a way back to the methods, never a retry of the attempt', () => {
    const refused = gatewayAttemptScreen(
      {
        payment: payment({ state: 'FAILED' }),
        invoice: invoice({ creationState: 'CREATE_FAILED' }),
      },
      null,
      at,
    );
    expect(refused.key).toBe('bot.payment.gateway_unavailable');
    expect(data(refused)).toEqual(['pm:01900000-0000-7000-8000-00000000bbbb', 'mm:']);
    expect(refused.wizard?.step).toBe('NOTICE');

    const lost = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice({ creationState: 'CREATE_UNKNOWN' }) },
      null,
      at,
    );
    expect(lost.key).toBe('bot.payment.gateway_unknown');
    expect(data(lost).some((d) => d.startsWith('gc:'))).toBe(false);

    const topup = gatewayAttemptScreen(
      {
        payment: payment({ orderId: null, state: 'FAILED' }),
        invoice: invoice({ creationState: 'CREATE_FAILED' }),
      },
      null,
      at,
    );
    expect(data(topup)).toEqual(['o:', 'mm:']);
    expect(topup.wizard?.kind).toBe('TOPUP');
  });

  /*
   * F3 (round N): the lost-answer sentence is for a lost answer only. A refusal whose
   * payment is still PENDING (its failure write did not land) and an invoice the gateway
   * reported created WITHOUT a link each say what happened, never "the answer was lost".
   */
  it('F3: a refusal with its payment still pending is unavailable, and a created invoice without a link says so', () => {
    const refusedPending = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice({ creationState: 'CREATE_FAILED' }) },
      null,
      at,
    );
    expect(refusedPending.key).toBe('bot.payment.gateway_unavailable');
    expect(data(refusedPending)).toEqual(['pm:01900000-0000-7000-8000-00000000bbbb', 'mm:']);

    const linkless = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice({ creationState: 'CREATED' }) },
      null,
      at,
    );
    expect(linkless.key).toBe('bot.payment.gateway_no_link');
    // Never a URL button it does not have, and a way on that opens a new attempt.
    expect(data(linkless)).toEqual(['pm:01900000-0000-7000-8000-00000000bbbb', 'mm:']);
    expect(linkless.wizard?.step).toBe('NOTICE');
  });

  it('a confirmed attempt CLOSES the wizard, and nothing on it can pay again', () => {
    const done = gatewayAttemptScreen(
      { payment: payment({ state: 'CONFIRMED' }), invoice: invoice({ creationState: 'CREATED' }) },
      null,
      at,
    );
    expect(done.key).toBe('bot.payment.gateway_confirmed');
    expect(done.wizard?.step).toBe('CLOSED');
    expect(data(done)).toEqual(['mm:']);
  });
});
