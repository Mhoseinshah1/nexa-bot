import { describe, expect, it } from 'vitest';
import {
  money,
  type ActorContext,
  type PaymentId,
  type PermissionKey,
  type TemplateKey,
  type UserId,
} from '@nexa/contracts';
import { createTranslator } from '@nexa/i18n';
import { ReceiptReviewCaption } from '../../apps/api/src/modules/commerce/payments/application/receipt-review-caption';
import type { PaymentRecord } from '../../apps/api/src/modules/commerce/payments/application/ports';
import { normaliseCaptureReason } from '../../apps/api/src/modules/commerce/payments/application/receipt-reason-capture.service';
import {
  blockedReply,
  receiptReviewButtons,
} from '../../apps/api/src/surfaces/telegram/bot-runtime';

/**
 * The reviewer's caption (File 01 §4, WP10 follow-up §6) — the ONE builder the pull item and
 * the push share — and the small pure rules around the follow-up: the buttons each key draws,
 * the typed reason's bound, and what a blocked customer is told.
 */

const viewer: ActorContext = {
  type: 'TELEGRAM_ADMIN',
  id: 'admin-1',
  label: 'admin',
  surface: 'TELEGRAM',
  correlationId: 'c' as never,
};

function paymentOf(orderId: string | null): PaymentRecord {
  return {
    id: 'pay-1' as PaymentId,
    customerId: 'cust-1' as UserId,
    orderId: orderId as never,
    state: 'PENDING',
    method: 'MANUAL_TRANSFER',
    amount: money(250_000n, 'IRT'),
    reference: 'REF-1',
  } as unknown as PaymentRecord;
}

function builder(granted: readonly string[]) {
  const rendered: TemplateKey[] = [];
  const caption = new ReceiptReviewCaption({
    facts: {
      factsFor: async (_scope, orderId) =>
        orderId === null
          ? {
              purpose: null,
              productTitle: null,
              durationDays: null,
              trafficBytes: null,
              serviceUsername: null,
            }
          : orderId === 'order-new'
            ? {
                purpose: 'NEW_SERVICE',
                productTitle: 'پلن پایه',
                durationDays: 30,
                trafficBytes: 53_687_091_200n,
                serviceUsername: 'zahra01',
              }
            : {
                purpose: 'RENEW',
                productTitle: 'پلن ویژه',
                durationDays: 30,
                trafficBytes: 5n,
                serviceUsername: 'zahra01',
              },
    },
    balances: { balanceOf: async () => ({ amountMinor: 70_000n }) },
    guard: { has: async (_s, _a, permission) => granted.includes(permission) },
    labels: {
      render: async (_scope, key, values) => {
        rendered.push(key);
        // The volume and duration labels render through the real catalogue, so what a
        // reviewer reads for them is the catalogue's own typed output.
        if (key === 'bot.admin.receipt_duration' || key === 'bot.admin.receipt_traffic') {
          return translator.translate(key, values);
        }
        return values['balance'] === undefined
          ? `label:${key}`
          : `balance:${String(values['balance'] && 'set')}`;
      },
    },
  });
  return { caption, rendered };
}

const translator = createTranslator();

const customer = {
  telegramUserId: '750900',
  username: 'zahra_pay',
  firstName: 'زهرا',
  lastName: 'احمدی',
} as never;

describe('the reviewer’s caption (File 01 §4)', () => {
  it('names the operation, product, volume, duration, service name, identity, amount and note', async () => {
    const { caption } = builder(['users.view']);
    const values = await caption.valuesFor({} as never, viewer, paymentOf('order-1'), customer, [
      { caption: null } as never,
      { caption: 'یادداشت' } as never,
    ]);
    expect(values).toMatchObject({
      operation: 'label:bot.admin.operation_renew',
      order: 'پلن ویژه',
      durationDays: '30',
      // A byte figure is shown in a unit, never as the stored integer (pre-release §3).
      trafficBytes: '5 بایت',
      serviceUsername: 'zahra01',
      name: 'زهرا احمدی',
      customer: '750900',
      username: '@zahra_pay',
      reference: 'REF-1',
      total: money(250_000n, 'IRT'),
      note: 'یادداشت',
      balance: 'balance:set',
    });
  });

  it('names a wallet top-up as one, with a dash where there is no product', async () => {
    const { caption } = builder([]);
    const values = await caption.valuesFor({} as never, viewer, paymentOf(null), null, []);
    expect(values).toMatchObject({
      operation: 'label:bot.admin.operation_topup',
      order: '—',
      serviceUsername: '—',
      username: '—',
      name: '—',
      note: '—',
    });
  });

  it('shows a wallet top-up’s volume and duration as a dash, never an invented 0', async () => {
    const { caption, rendered } = builder([]);
    const values = await caption.valuesFor({} as never, viewer, paymentOf(null), null, []);
    expect(values['durationDays']).toBe('—');
    expect(values['trafficBytes']).toBe('—');
    // Neither label is asked to type a value the payment does not have.
    expect(rendered).not.toContain('bot.admin.receipt_duration');
    expect(rendered).not.toContain('bot.admin.receipt_traffic');
  });

  it('types a new service’s volume and duration through their catalogue labels', async () => {
    const { caption, rendered } = builder([]);
    const values = await caption.valuesFor({} as never, viewer, paymentOf('order-new'), null, []);
    expect(values).toMatchObject({
      operation: 'label:bot.admin.operation_new_service',
      durationDays: translator.translate('bot.admin.receipt_duration', { durationDays: 30 }),
      trafficBytes: translator.translate('bot.admin.receipt_traffic', {
        trafficBytes: 53_687_091_200n,
      }),
    });
    expect(values['durationDays']).toBe('30');
    // The frozen 53687091200 bytes, as a reviewer reads it — never the raw integer.
    expect(values['trafficBytes']).toBe('50 گیگابایت');
    expect(rendered).toContain('bot.admin.receipt_duration');
    expect(rendered).toContain('bot.admin.receipt_traffic');
  });

  it('shows the balance only to a viewer holding users.view, and reads nothing else for it', async () => {
    const { caption, rendered } = builder(['receipts.review']);
    const values = await caption.valuesFor({} as never, viewer, paymentOf('order-1'), customer, []);
    expect(values['balance']).toBe('—');
    expect(rendered).not.toContain('bot.admin.receipt_balance');
  });

  it('carries no subscription link, file id or credential among its values', async () => {
    const { caption } = builder(['users.view']);
    const values = await caption.valuesFor({} as never, viewer, paymentOf('order-1'), customer, [
      { caption: null, fileId: 'secret-file-id' } as never,
    ]);
    const flat = JSON.stringify(values, (_k, v: unknown) =>
      typeof v === 'bigint' ? String(v) : v,
    );
    expect(flat).not.toContain('secret-file-id');
    expect(Object.keys(values).sort()).toEqual(
      [
        'balance',
        'customer',
        'durationDays',
        'name',
        'note',
        'operation',
        'order',
        'reference',
        'serviceUsername',
        'total',
        'trafficBytes',
        'username',
      ].sort(),
    );
  });
});

describe('the receipt buttons each key draws', () => {
  const set = (...keys: string[]) => new Set(keys as PermissionKey[]);
  const data = (permissions: ReadonlySet<PermissionKey>) =>
    receiptReviewButtons('p', permissions, { credit: true, block: true }).map((b) =>
      'data' in b ? b.data : null,
    );

  it('draws all four for a key holder of each', () => {
    expect(data(set('receipts.review', 'users.wallet.credit', 'users.block'))).toEqual([
      'D:p',
      'E:p',
      'wa:p',
      'xa:p',
    ]);
  });

  it('draws Block for users.block alone, and decisions for receipts.review alone', () => {
    expect(data(set('users.block'))).toEqual(['xa:p']);
    expect(data(set('receipts.review'))).toEqual(['D:p', 'E:p']);
    expect(data(set('users.wallet.credit'))).toEqual([]);
  });
});

describe('the typed reason', () => {
  it('is trimmed, mandatory, and refused rather than cut past its bound', () => {
    expect(normaliseCaptureReason('  دلیل  ')).toBe('دلیل');
    expect(normaliseCaptureReason('   ')).toBeNull();
    expect(normaliseCaptureReason('ی'.repeat(500))).toHaveLength(500);
    expect(normaliseCaptureReason('ی'.repeat(501))).toBeNull();
    // Code points: 500 emoji are 1,000 UTF-16 units and still one reason.
    expect(normaliseCaptureReason('😀'.repeat(500))).not.toBeNull();
  });
});

describe('what a blocked customer is told (File 01 §9)', () => {
  const shown = (blockedReason: string | null) => ({ blockedReason, blockedReasonShown: true });

  it('names THEIR stored reason, and falls back to the whole blocked sentence without one', () => {
    expect(blockedReply(shown('دلیل'))).toMatchObject({
      key: 'bot.blocked_with_reason',
      values: { reason: 'دلیل' },
    });
    expect(blockedReply(shown(null))).toMatchObject({ key: 'bot.blocked', values: {} });
    expect(blockedReply(shown('   '))).toMatchObject({ key: 'bot.blocked' });
    expect(blockedReply(shown('Blocked from the Telegram management panel.'))).toMatchObject({
      key: 'bot.blocked',
    });
  });

  it('never shows a reason written when the operator was told it would stay private (V2)', () => {
    // A block from before WP10's follow-up: the Web Admin's copy then read "this note is for
    // the operator and is never shown to the customer".
    const reply = blockedReply({ blockedReason: 'مشکوک به تقلب', blockedReasonShown: false });
    expect(reply).toMatchObject({ key: 'bot.blocked', values: {} });
    expect(JSON.stringify(reply)).not.toContain('مشکوک');
  });
});
