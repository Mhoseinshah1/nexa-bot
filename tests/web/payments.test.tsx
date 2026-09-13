import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { PaymentDetailPage, PaymentsPage } from '../../apps/web/src/pages/payments';
import { resolve } from '../../apps/web/src/app';
import { renderPage, stubApi } from './harness';

/**
 * Payments, rendered against the shapes the server actually returns.
 *
 * Every fixture goes through the real API client and is parsed by
 * `paymentSummarySchema` / `paymentDetailSchema` — the same schemas the server validates
 * against — so a fixture that drifted from the contract fails here rather than in
 * production.
 *
 * The two things this file exists to defend, beyond rendering:
 *
 *   - the ONE write is a confirmation, and it carries a NOTE and nothing else. A case
 *     below enumerates the body the page actually sends and requires no amount, no
 *     currency and no customer in it.
 *   - PAID means the money arrived. Several cases assert a PROHIBITION — that no string
 *     on the page claims a service was created, prepared or delivered — because a later
 *     phase adding such a claim is the failure this codebase is organised around.
 */

const LIST_ROUTE = { path: '/payments', query: new URLSearchParams() };
const ROW_ID = '019240ab-cdef-7012-8345-6789abcdef01';
const ORDER_ID = '019230ab-cdef-7012-8345-6789abcdef01';
const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef01';

function payment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ROW_ID,
    customerId: CUSTOMER_ID,
    orderId: ORDER_ID,
    state: 'PENDING',
    method: 'MANUAL_TRANSFER',
    amount: '250000',
    currency: 'IRT',
    reference: 'a1b2c3d4e5f60718:manual',
    evidenceKind: null,
    confirmedAt: null,
    confirmedByAdminId: null,
    expiresAt: null,
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T12:30:00.000Z',
    ...overrides,
  };
}

const detail = (overrides: Record<string, unknown> = {}) => [
  { url: `/payments/${ROW_ID}`, body: { payment: { ...payment(overrides), evidenceNote: null } } },
];

const list = (payments: unknown[], nextCursor: string | null = null) => [
  { url: '/payments', body: { payments, nextCursor } },
];

describe('the payment list', () => {
  it('renders a payment with its state, method, amount and reference', async () => {
    stubApi(list([payment()]));
    renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);

    expect(await screen.findByText('a1b2c3d4e5f60718:manual')).toBeInTheDocument();
    // Inside the TABLE, not the filter pills above it — both carry these labels, and a
    // loose query would pass on a page whose rows rendered nothing at all.
    const table = screen.getByRole('table');
    expect(within(table).getByText('در انتظار')).toBeInTheDocument();
    expect(within(table).getByText('کارت به کارت')).toBeInTheDocument();
    // The formatted amount, from the decimal STRING on the wire.
    expect(within(table).getByText(/۲۵۰٬۰۰۰|250,000/u)).toBeInTheDocument();
  });

  it('carries an amount past 2^53 without losing a unit', async () => {
    // The wire form is a string precisely because `Number` would round this. A balance
    // can reach it by summing many movements even though one is bounded below it.
    stubApi(list([payment({ amount: '9007199254740993' })]));
    const { container } = renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718:manual');
    expect(container.textContent).not.toContain('9007199254740992');
  });

  it('offers every FROZEN state and method as a filter', async () => {
    stubApi(list([payment()]));
    const { container } = renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718:manual');

    // Including the ones nothing reaches yet: a state in the contract with no filter is
    // an option nobody notices is missing.
    for (const label of ['در انتظار', 'تأیید شده', 'ناموفق', 'لغو شده', 'منقضی شده', 'نامشخص']) {
      expect(container.textContent, label).toContain(label);
    }
    for (const label of ['کیف پول', 'کارت به کارت', 'درگاه']) {
      expect(container.textContent, label).toContain(label);
    }
  });

  it('says why a gateway never appears, rather than leaving it unexplained', async () => {
    stubApi(list([payment()]));
    const { container } = renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718:manual');
    expect(container.textContent).toContain('هیچ درگاه پرداختی ثبت یا تعریف نشده است');
  });

  /*
   * The PAGE's use of `setQueries`, not the helper's behaviour.
   *
   * `router.test.tsx` proves the helper applies every parameter; nothing would prove
   * this page calls it. On the 4B branch that exact gap let a falsification survive:
   * the reverted handler applied the last field and silently dropped the others, so an
   * operator saw the ids they typed and a list that ignored them.
   */
  it('applies all three filters in ONE navigation, and drops the cursor', async () => {
    stubApi(list([payment()]));
    window.history.replaceState(null, '', '/payments?cursor=stale-page');
    const route = { path: '/payments', query: new URLSearchParams({ cursor: 'stale-page' }) };
    renderPage(<PaymentsPage route={route} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718:manual');

    fireEvent.change(screen.getByLabelText('مشتری'), { target: { value: CUSTOMER_ID } });
    fireEvent.change(screen.getByLabelText('سفارش'), { target: { value: ORDER_ID } });
    fireEvent.change(screen.getByLabelText('کد پیگیری'), { target: { value: 'abc:manual' } });
    fireEvent.click(screen.getByText('جست‌وجو'));

    await waitFor(() => {
      const applied = new URLSearchParams(window.location.search);
      expect(applied.get('customerId'), 'customerId was dropped').toBe(CUSTOMER_ID);
      expect(applied.get('orderId'), 'orderId was dropped').toBe(ORDER_ID);
      expect(applied.get('reference'), 'reference was dropped').toBe('abc:manual');
      // A new filter starts at the first page: carrying the old cursor pages through a
      // list that no longer exists.
      expect(applied.get('cursor'), 'a stale cursor survived a new filter').toBeNull();
    });
  });

  it('refuses a partial id at the field rather than sending it', async () => {
    const api = stubApi(list([payment()]));
    renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718:manual');
    const before = api.calls.length;

    fireEvent.change(screen.getByLabelText('مشتری'), { target: { value: '0192' } });
    fireEvent.click(screen.getByText('جست‌وجو'));

    expect(await screen.findByText(/شناسه معتبر نیست/u)).toBeInTheDocument();
    expect(api.calls.length, 'a partial id was sent to the server').toBe(before);
  });

  it('keeps the evidence note off the LIST', async () => {
    // An operator's own text about somebody's bank transfer. Detail only, and the list
    // is the thing most likely to end up on a shared screen.
    stubApi(list([payment()]));
    const { container } = renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718:manual');
    expect(container.textContent).not.toContain('یادداشت بررسی');
  });
});

describe('the payment detail', () => {
  const render = (overrides: Record<string, unknown> = {}, mayReview = true) => {
    stubApi(detail(overrides));
    return renderPage(<PaymentDetailPage id={ROW_ID} mayReview={mayReview} denied={false} />);
  };

  it('shows the reviewer and the time a confirmation rests on', async () => {
    render({
      state: 'CONFIRMED',
      evidenceKind: 'OPERATOR_REVIEW',
      confirmedAt: '2026-09-10T13:00:00.000Z',
      confirmedByAdminId: '019200ab-cdef-7012-8345-6789abcdef01',
    });
    await screen.findByText('تأیید شده');

    // `UNK-PR-010` records the legacy receipt review as storing NEITHER, which is why
    // "was this approved by a human" is unanswerable there.
    expect(screen.getByText('OPERATOR_REVIEW')).toBeInTheDocument();
    expect(screen.getByText('تأییدکننده')).toBeInTheDocument();
    expect(screen.getByText('زمان تأیید')).toBeInTheDocument();
  });

  it('sends a NOTE and nothing else when confirming', async () => {
    const api = stubApi([
      ...detail(),
      {
        url: `/payments/${ROW_ID}/confirm`,
        body: {
          payment: {
            ...payment({
              state: 'CONFIRMED',
              evidenceKind: 'OPERATOR_REVIEW',
              confirmedAt: '2026-09-10T13:00:00.000Z',
            }),
            evidenceNote: 'received',
          },
        },
      },
    ]);
    renderPage(<PaymentDetailPage id={ROW_ID} mayReview denied={false} />);
    await screen.findByText('تأیید دریافت وجه');

    fireEvent.change(screen.getByLabelText('یادداشت بررسی'), { target: { value: 'received' } });
    fireEvent.click(screen.getByText('تأیید دریافت'));

    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes('/confirm'))).toBe(true);
    });
    const body = api.calls.find((one) => one.url.includes('/confirm'))?.body as Record<
      string,
      unknown
    >;
    expect(body['evidenceNote']).toBe('received');
    expect(String(body['idempotencyKey']).length).toBeGreaterThanOrEqual(8);
    /*
     * The whole invariant, enumerated.
     *
     * An operator able to restate the amount at approval time is an operator able to
     * approve a different payment from the one the customer made. Three layers refuse
     * it — the schema, the repository and a database trigger — and this is the one that
     * proves the page never tries.
     */
    for (const forbidden of ['amount', 'currency', 'customerId', 'orderId', 'method', 'state']) {
      expect(body, `the confirmation carries ${forbidden}`).not.toHaveProperty(forbidden);
    }
  });

  it('names the permission instead of drawing a disabled button', async () => {
    render({}, false);
    await screen.findByText('تأیید دریافت وجه');

    expect(screen.getByText(/receipts.review/u)).toBeInTheDocument();
    expect(screen.queryByText('تأیید دریافت')).toBeNull();
  });

  it('offers no confirmation for a payment the machine cannot confirm', async () => {
    // A CONFIRMED payment has no `CONFIRM` edge, and a WALLET payment was confirmed by
    // its own debit in the same transaction — there is nothing for an operator to
    // approve in either.
    for (const overrides of [
      {
        state: 'CONFIRMED',
        evidenceKind: 'OPERATOR_REVIEW',
        confirmedAt: '2026-09-10T13:00:00.000Z',
      },
      { method: 'WALLET' },
      { state: 'FAILED' },
      { state: 'EXPIRED' },
    ]) {
      const view = render(overrides);
      await screen.findAllByText('a1b2c3d4e5f60718:manual');
      expect(
        view.container.textContent,
        `a confirmation form was drawn for ${JSON.stringify(overrides)}`,
      ).not.toContain('تأیید دریافت وجه');
      view.unmount();
    }
  });

  it('says an UNKNOWN outcome is neither a success nor a failure', async () => {
    render({ state: 'UNKNOWN' });
    await screen.findByText('نامشخص');
    // `payment.ts` leaves UNKNOWN non-terminal precisely so reconciliation is legal, and
    // the banner tells an operator that rather than inviting them to guess.
    expect(screen.getByText(/نه موفق است و نه ناموفق/u)).toBeInTheDocument();
  });

  it('claims nothing about a service, in any state', async () => {
    for (const overrides of [
      { state: 'PENDING' },
      { state: 'CONFIRMED', evidenceKind: 'WALLET_DEBIT', confirmedAt: '2026-09-10T13:00:00.000Z' },
    ]) {
      const view = render(overrides);
      // The REFERENCE, which only exists once the query settled. `جزئیات پرداخت` is the
      // page head and renders before the fetch, so awaiting it asserts against a
      // loading screen — which contains none of the forbidden strings either, and would
      // pass no matter what the page said.
      await screen.findAllByText('a1b2c3d4e5f60718:manual');
      const text = view.container.textContent ?? '';
      for (const claim of ['در حال آماده‌سازی', 'سرویس ساخته', 'تحویل شد', 'در حال ساخت']) {
        expect(text, `the payment page claims "${claim}"`).not.toContain(claim);
      }
      // And it says so outright, rather than merely omitting it.
      expect(text).toContain('ساخت یا تحویل سرویس در این نسخه انجام نمی‌شود');
      view.unmount();
    }
  });

  it('draws no control that could fail, cancel, retry or refund a payment', async () => {
    const view = render();
    await screen.findAllByText('a1b2c3d4e5f60718:manual');
    const labels = [...view.container.querySelectorAll('button')].map((b) => b.textContent?.trim());
    for (const label of labels) {
      expect(
        label === 'تأیید دریافت' || label === '',
        `the payment page draws an unexpected control: ${String(label)}`,
      ).toBe(true);
    }
  });
});

describe('the payments route', () => {
  const ALL = ['payments.view', 'receipts.review'];
  const NONE: readonly string[] = [];

  it('resolves to the real page, not the planned placeholder', () => {
    stubApi(list([payment()]));
    const resolved = resolve({ path: '/payments', query: new URLSearchParams() }, ALL);
    const view = renderPage(resolved.element as ReactElement);
    // The placeholder's own heading, which must NOT be here any more.
    expect(view.container.textContent).not.toContain('چرا هنوز فعال نیست');
    expect(view.container.textContent).toContain('پرداخت‌ها');
  });

  it('refuses the page to an operator without payments.view', async () => {
    const api = stubApi(list([payment()]));
    const resolved = resolve({ path: '/payments', query: new URLSearchParams() }, NONE);
    renderPage(resolved.element as ReactElement);

    // Denied is not merely hidden: the query is disabled, so the page does not log a
    // 403 on every render.
    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes('/payments'))).toBe(false);
    });
  });
});
