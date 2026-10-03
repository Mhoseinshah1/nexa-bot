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
  refundRequestReviewButtons,
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

function builder(
  granted: readonly string[],
  movement: { moved: bigint; before: bigint; after: bigint } | null = null,
) {
  const rendered: TemplateKey[] = [];
  const movementReads: string[] = [];
  const caption = new ReceiptReviewCaption({
    movements: {
      movementOf: async (_scope, _customer, paymentId) => {
        movementReads.push(paymentId);
        return movement;
      },
    },
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
  return { caption, rendered, movementReads };
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
      // A duration is shown in its unit, never as the stored integer (pre-release §4).
      durationDays: '30 روز',
      // A byte figure is shown in a unit, never as the stored integer (pre-release §3), in GB since Package C.
      trafficBytes: '0 گیگابایت',
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
    // The duration in its unit, never the bare figure (pre-release hardening §4).
    expect(values['durationDays']).toBe('30 روز');
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

describe('the refund request card’s buttons each key draws (Codex review of #83, round 10)', () => {
  const set = (...keys: PermissionKey[]) => new Set(keys);
  const request = { id: 'r', customerId: 'c', serviceId: 's' };
  const data = (permissions: ReadonlySet<PermissionKey>) =>
    refundRequestReviewButtons(request, permissions).map((b) => ('data' in b ? b.data : null));

  it('draws the two decisions alone for a reviewer holding only the decision keys', () => {
    expect(data(set('refunds.issue', 'services.terminate'))).toEqual(['qa:r', 'qb:r']);
  });

  it('draws each view only for its own view key', () => {
    expect(data(set('refunds.issue', 'services.terminate', 'users.view'))).toEqual([
      'qa:r',
      'qb:r',
      '9:v:c',
    ]);
    expect(data(set('refunds.issue', 'services.terminate', 'services.view'))).toEqual([
      'qa:r',
      'qb:r',
      'I:s',
    ]);
    expect(data(set('refunds.issue', 'services.terminate', 'users.view', 'services.view'))).toEqual(
      ['qa:r', 'qb:r', '9:v:c', 'I:s'],
    );
  });
});

describe('the receipt buttons each key draws', () => {
  const set = (...keys: PermissionKey[]) => new Set(keys);
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
    // No sentence is reserved: the old fixed note's rows are marked not shown by migration
    // 0121, so the flag alone decides, and an operator may type any reason.
    expect(blockedReply(shown('Blocked from the Telegram management panel.'))).toMatchObject({
      key: 'bot.blocked_with_reason',
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

/*
 * F1 (round N): the final record the review message becomes. The same facts as the caption,
 * from the same readers; a fact the payment lacks is ABSENT (its template line is dropped),
 * never a dash; and the wallet movement only for a decision that moved the wallet, for a
 * viewer holding users.view, on the deciding reviewer's own message.
 */
describe('the review message’s final record (F1)', () => {
  const approved = {
    outcome: 'APPROVED',
    outcomeLabel: 'bot.admin.review_approved',
    wallet: true,
  } as const;
  const credited = {
    outcome: 'CREDITED',
    outcomeLabel: 'bot.admin.review_credited',
    wallet: true,
  } as const;
  const moved = { moved: 90_000n, before: 10_000n, after: 100_000n };

  it('leads with the outcome label and carries the decided facts, typed', async () => {
    const { caption } = builder(['users.view'], moved);
    const values = await caption.finalValuesFor(
      {} as never,
      viewer,
      paymentOf('order-new'),
      customer,
      approved,
    );
    expect(values).toEqual({
      outcome: 'label:bot.admin.review_approved',
      operation: 'label:bot.admin.operation_new_service',
      order: 'پلن پایه',
      trafficBytes: 53_687_091_200n,
      durationDays: 30,
      serviceUsername: 'zahra01',
      customer: '750900',
      username: '@zahra_pay',
      name: 'زهرا احمدی',
      total: money(250_000n, 'IRT'),
      reference: 'REF-1',
    });
  });

  it('leaves out, rather than dashes, what a top-up or a customer without a username lacks', async () => {
    const { caption } = builder([]);
    const values = await caption.finalValuesFor({} as never, viewer, paymentOf(null), null, {
      ...approved,
      wallet: false,
    });
    expect(Object.keys(values).sort()).toEqual(
      ['customer', 'operation', 'outcome', 'reference', 'total'].sort(),
    );
    expect(Object.values(values)).not.toContain('—');
  });

  it('shows the wallet movement for a credit or an approved top-up, to a users.view viewer only', async () => {
    const credit = await builder(['users.view'], moved).caption.finalValuesFor(
      {} as never,
      viewer,
      paymentOf('order-1'),
      customer,
      credited,
    );
    expect(credit).toMatchObject({
      creditedAmount: money(90_000n, 'IRT'),
      walletBefore: money(10_000n, 'IRT'),
      walletAfter: money(100_000n, 'IRT'),
    });
    const topup = await builder(['users.view'], moved).caption.finalValuesFor(
      {} as never,
      viewer,
      paymentOf(null),
      customer,
      approved,
    );
    expect(topup['walletAfter']).toEqual(money(100_000n, 'IRT'));

    // Without users.view: no balance, and the ledger is not even read.
    const blind = builder(['receipts.review'], moved);
    const hidden = await blind.caption.finalValuesFor(
      {} as never,
      viewer,
      paymentOf(null),
      customer,
      approved,
    );
    expect(hidden).not.toHaveProperty('walletBefore');
    expect(blind.movementReads).toEqual([]);

    // Another reviewer's copy: no balance whatever this viewer holds.
    const copy = builder(['users.view'], moved);
    expect(
      await copy.caption.finalValuesFor({} as never, viewer, paymentOf(null), customer, {
        ...approved,
        wallet: false,
      }),
    ).not.toHaveProperty('walletAfter');
    expect(copy.movementReads).toEqual([]);
  });

  it('shows no wallet movement for a purchase approval, a rejection or a block', async () => {
    for (const decision of [
      approved,
      { outcome: 'REJECTED', outcomeLabel: 'bot.admin.review_rejected', wallet: true },
      { outcome: 'BLOCKED', outcomeLabel: 'bot.admin.review_blocked', wallet: true },
    ] as const) {
      const built = builder(['users.view'], moved);
      const values = await built.caption.finalValuesFor(
        {} as never,
        viewer,
        paymentOf('order-1'),
        customer,
        decision,
      );
      expect(values, decision.outcome).not.toHaveProperty('creditedAmount');
      expect(built.movementReads, decision.outcome).toEqual([]);
    }
  });
});
