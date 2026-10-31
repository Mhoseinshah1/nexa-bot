import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PAYMENT_ROUTES, navCountersResponseSchema } from '@nexa/contracts';
import { ReceiptReviewCard, creditAmountOf } from '../../apps/web/src/pages/payment-receipt-review';
import { navCountersFrom } from '../../apps/web/src/nav-counters';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * R12 F3 item 8 — card-to-card receipt review in the Web Admin, as the reviewer meets it.
 * Rendered against the real client over a stubbed `fetch`; the money moves in the server's
 * services (`tests/integration/wallet-payments-http.test.ts`), so what is held here is the ASKING:
 * approve names the amount and needs a tick, reject needs its reason, the credit names the wallet
 * amount, and the controls are drawn only for whoever may use them.
 */

const PAYMENT = '019240ab-cdef-7012-8345-6789abcdef01';
const decided = { payment: { id: PAYMENT, state: 'CONFIRMED' } };

const card = (over: { mayReview?: boolean; mayCredit?: boolean } = {}) =>
  renderPage(
    <ReceiptReviewCard
      paymentId={PAYMENT}
      amountMinor="250000"
      currency="IRT"
      mayReview={over.mayReview ?? true}
      mayCredit={over.mayCredit ?? true}
    />,
  );

describe('the receipt review card', () => {
  it('draws no decision for a viewer without receipts.review, and says what is needed', () => {
    stubApi([]);
    card({ mayReview: false });
    expect(screen.queryByRole('button', { name: t('web.receipt_approve') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.receipt_reject') })).toBeNull();
    expect(screen.getByText(t('web.receipt_denied'))).toBeTruthy();
  });

  it('draws the credit only for who also holds users.wallet.credit', () => {
    stubApi([]);
    card({ mayCredit: false });
    expect(screen.getByRole('button', { name: t('web.receipt_approve') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('web.receipt_credit') })).toBeNull();
    expect(screen.getByText(t('web.receipt_credit_denied'))).toBeTruthy();
  });

  it('APPROVE asks first: nothing is sent until the amount is acknowledged, then one request', async () => {
    const api = stubApi([
      { url: `/payments/${PAYMENT}/receipt/approve`, body: decided, status: 201 },
    ]);
    card();
    fireEvent.click(screen.getByRole('button', { name: t('web.receipt_approve') }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(t('web.receipt_approve_body'))).toBeTruthy();
    // The amount that will be settled is on the dialog.
    expect(dialog.textContent).toContain('250');
    const confirm = within(dialog).getByRole('button', { name: t('web.receipt_approve_confirm') });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm);
    expect(api.calls.filter((call) => call.method === 'POST')).toEqual([]);

    fireEvent.click(within(dialog).getByRole('checkbox'));
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    const post = api.calls.find((call) => call.method === 'POST');
    expect(post?.url).toContain(PAYMENT_ROUTES.receiptApprove(PAYMENT));
    expect(post?.body).toMatchObject({ confirm: true });
    expect((post?.body as { idempotencyKey: string }).idempotencyKey.length).toBeGreaterThanOrEqual(
      8,
    );
  });

  it('REJECT needs its reason — the customer is told it — and sends it', async () => {
    const api = stubApi([
      { url: `/payments/${PAYMENT}/receipt/reject`, body: decided, status: 201 },
    ]);
    card();
    fireEvent.click(screen.getByRole('button', { name: t('web.receipt_reject') }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: t('web.receipt_reject_confirm') });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(t('web.receipt_reject_reason')), {
      target: { value: 'مبلغ نمی‌خواند' },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(api.calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      reason: 'مبلغ نمی‌خواند',
    });
  });

  it('CREDIT reads whole digits only, shows the wallet amount, and sends minor units', async () => {
    const api = stubApi([
      { url: `/payments/${PAYMENT}/receipt/credit`, body: decided, status: 201 },
    ]);
    card();
    fireEvent.click(screen.getByRole('button', { name: t('web.receipt_credit') }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: t('web.receipt_credit_confirm') });
    const amount = within(dialog).getByLabelText(new RegExp(t('web.receipt_credit_amount')));
    for (const bad of ['0', '12.5', '-5', 'abc', '']) {
      fireEvent.change(amount, { target: { value: bad } });
      expect((confirm as HTMLButtonElement).disabled, bad).toBe(true);
    }
    fireEvent.change(amount, { target: { value: '240000' } });
    expect(within(dialog).getByText(t('web.receipt_credit_will_add'))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(confirm);
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(api.calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      amountMinor: '240000',
      confirm: true,
    });
  });

  it('says the server’s refusal inside the dialog, and keeps it open', async () => {
    stubApi([
      {
        url: `/payments/${PAYMENT}/receipt/approve`,
        status: 409,
        body: {
          error: {
            kind: 'CONFLICT',
            code: 'commerce.payment_state_invalid',
            message: 'x',
            correlationId: 'c',
          },
        },
      },
    ]);
    card();
    fireEvent.click(screen.getByRole('button', { name: t('web.receipt_approve') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.receipt_approve_confirm') }));
    await waitFor(() => expect(within(dialog).queryByRole('alert')).not.toBeNull());
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });
});

describe('creditAmountOf', () => {
  it('accepts whole positive digits (Persian digits read as digits) and refuses the rest', () => {
    expect(creditAmountOf(' 240000 ')).toBe('240000');
    expect(creditAmountOf('۲۴۰۰۰۰')).toBe('240000');
    for (const bad of ['', '0', '00', '1.5', '-1', '1e3', '12 34', 'x'.repeat(5), '9'.repeat(20)]) {
      expect(creditAmountOf(bad), bad).toBeNull();
    }
  });
});

describe('the sidebar badge for payments', () => {
  const counters = (values: Record<string, number | null>) =>
    navCountersResponseSchema.parse({
      generatedAt: '2026-10-31T10:00:00.000Z',
      counters: {
        openConditions: null,
        ticketsAwaitingSupport: null,
        unhealthyPanels: null,
        unreconciledServices: null,
        refundRequestsAwaiting: null,
        paymentsUnknown: null,
        ...values,
      },
    });

  it('adds the receipts awaiting review to the unknown outcomes, and draws nothing for none', () => {
    expect(navCountersFrom(counters({ paymentsUnknown: 2, receiptsAwaitingReview: 3 }))).toEqual({
      payments: { count: 5, tone: 'warn' },
    });
    expect(navCountersFrom(counters({ receiptsAwaitingReview: 4 }))).toEqual({
      payments: { count: 4, tone: 'warn' },
    });
    expect(navCountersFrom(counters({ paymentsUnknown: 0, receiptsAwaitingReview: 0 }))).toEqual(
      {},
    );
    // An old server that does not send the counter reads as "not counted".
    expect(navCountersFrom(counters({ paymentsUnknown: 1 }))).toEqual({
      payments: { count: 1, tone: 'warn' },
    });
  });

  it('a capped counter makes the sum a floor', () => {
    expect(
      navCountersFrom(counters({ paymentsUnknown: 1, receiptsAwaitingReview: 1000 })).payments,
    ).toMatchObject({ atLeast: true });
  });
});
