import { describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { PaymentDetailPage, PaymentsPage } from '../../apps/web/src/pages/payments';
import { resolve } from '../../apps/web/src/app';
import { formatTimestamp } from '../../apps/web/src/format';
import { order, renderPage, stubApi } from './harness';

/**
 * The late-review lane and the refund consequences, on the Web Admin (WP10 §10-A).
 *
 * `docs/wp10-payments-audit.md` P1 and P3 are the design. Every fixture goes through the
 * real API client and is parsed by the contract's schemas, so a fixture that drifted
 * from what the server sends fails here rather than in production.
 *
 * What this file defends:
 *
 *   - the lane is the SERVER's filter (`lateReview=true`), and the list draws nothing
 *     that would contradict it;
 *   - the two decisions are drawn only for `receipts.review` and only where the server
 *     says the payment is in the lane; the credit asks first and names the exact amount;
 *     the dismissal cannot be sent without a reason; each sends exactly its contract body;
 *   - a standing decision is read-only;
 *   - a refund refused for `DELIVERY_IN_PROGRESS` says so, and a refunded order is said
 *     to be REFUNDED — from the ORDER — with the service explicitly untouched.
 */

const ROW_ID = '019240ab-cdef-7012-8345-6789abcdef01';
const ORDER_ID = '019230ab-cdef-7012-8345-6789abcdef01';
const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef01';
const ADMIN_ID = '019270ab-cdef-7012-8345-6789abcdef01';

/** An EXPIRED manual transfer the customer signalled: in the lane, undecided. */
function payment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ROW_ID,
    customerId: CUSTOMER_ID,
    orderId: ORDER_ID,
    state: 'EXPIRED',
    method: 'MANUAL_TRANSFER',
    amount: '250000',
    currency: 'IRT',
    reference: 'a1b2c3d4e5f60718:manual',
    evidenceKind: null,
    confirmedAt: null,
    confirmedByAdminId: null,
    resolvedAt: '2026-09-10T13:30:00.000Z',
    resolvedByAdminId: null,
    customerSignalledAt: '2026-09-10T13:00:00.000Z',
    expiresAt: '2026-09-10T13:30:00.000Z',
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T13:30:00.000Z',
    lateDecision: null,
    lateReviewEligible: true,
    ...overrides,
  };
}

const detailBody = (overrides: Record<string, unknown> = {}) => ({
  payment: {
    ...payment(overrides),
    evidenceNote: null,
    resolutionNote: null,
    destination: null,
  },
});

const detail = (overrides: Record<string, unknown> = {}) => [
  { url: `/payments/${ROW_ID}`, body: detailBody(overrides) },
];

const CREDITED = {
  decision: 'CREDITED',
  reason: null,
  decidedAt: '2026-09-11T08:00:00.000Z',
  decidedByAdminId: ADMIN_ID,
};

const DISMISSED = {
  decision: 'DISMISSED',
  reason: 'AMOUNT_UNDERPAID',
  decidedAt: '2026-09-11T08:00:00.000Z',
  decidedByAdminId: ADMIN_ID,
};

const refusal = (code: string, details: Record<string, unknown> = {}) => ({
  error: { kind: 'conflict', code, message: 'refused', details, correlationId: 'test' },
});

function detailPage(props: { mayReview?: boolean; mayViewRefunds?: boolean } = {}) {
  return (
    <PaymentDetailPage
      id={ROW_ID}
      mayReview={props.mayReview ?? true}
      mayViewReceipts={false}
      mayViewRefunds={props.mayViewRefunds ?? false}
      mayIssueRefunds={false}
      denied={false}
    />
  );
}

const CREDIT_LABEL = 'واریز به کیف پول مشتری';
const CREDIT_CONFIRM_LABEL = 'بله، واریز شود';
const DISMISS_LABEL = 'رد پرداخت';
const LANE_TITLE = 'بررسی دیرهنگام';

// ---------------------------------------------------------------------------
// The lane on the list
// ---------------------------------------------------------------------------

describe('the late-review lane on the payment list', () => {
  const laneRoute = (extra: Record<string, string> = {}) => ({
    path: '/payments',
    query: new URLSearchParams({ lateReview: 'true', ...extra }),
  });

  it('asks the server for the lane, and nothing that would contradict it', async () => {
    const api = stubApi([{ url: '/payments', body: { payments: [payment()], nextCursor: null } }]);
    // A stale state and method carried in the URL: the lane IS a state and a method, so
    // sending these would be a filter that empties it.
    renderPage(
      <PaymentsPage route={laneRoute({ state: 'PENDING', method: 'WALLET' })} denied={false} />,
    );
    await screen.findByText('a1b2c3d4e5f60718:manual');

    const read = api.calls.find((call) => call.url.includes('/payments'));
    const params = new URL(read?.url ?? '', 'http://x').searchParams;
    expect(params.get('lateReview')).toBe('true');
    expect(params.get('state'), 'the lane sent a state').toBeNull();
    expect(params.get('method'), 'the lane sent a method').toBeNull();

    // The row says where it stands in the lane, from the server's own field.
    expect(within(screen.getByRole('table')).getByText('در انتظار تصمیم')).toBeInTheDocument();
    // And the lane explains itself.
    expect(screen.getByText(/پرداخت و سفارش بسته می‌مانند/u)).toBeInTheDocument();
  });

  it('never sends lateReview from the ordinary list', async () => {
    const api = stubApi([{ url: '/payments', body: { payments: [payment()], nextCursor: null } }]);
    renderPage(
      <PaymentsPage route={{ path: '/payments', query: new URLSearchParams() }} denied={false} />,
    );
    await screen.findByText('a1b2c3d4e5f60718:manual');
    const read = api.calls.find((call) => call.url.includes('/payments'));
    expect(read?.url).not.toContain('lateReview');
  });

  it('switches to the lane in one navigation, dropping state, method and cursor', async () => {
    stubApi([{ url: '/payments', body: { payments: [payment()], nextCursor: null } }]);
    window.history.replaceState(null, '', '/payments?state=PENDING&method=WALLET&cursor=stale');
    const route = {
      path: '/payments',
      query: new URLSearchParams({ state: 'PENDING', method: 'WALLET', cursor: 'stale' }),
    };
    renderPage(<PaymentsPage route={route} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718:manual');

    fireEvent.click(screen.getByRole('button', { name: LANE_TITLE }));

    await waitFor(() => {
      const applied = new URLSearchParams(window.location.search);
      expect(applied.get('lateReview')).toBe('true');
      expect(applied.get('state')).toBeNull();
      expect(applied.get('method')).toBeNull();
      expect(applied.get('cursor')).toBeNull();
    });
  });

  it('says the lane is empty in its own words', async () => {
    stubApi([{ url: '/payments', body: { payments: [], nextCursor: null } }]);
    renderPage(<PaymentsPage route={laneRoute()} denied={false} />);
    expect(
      await screen.findByText('هیچ پرداختی در انتظار بررسی دیرهنگام نیست.'),
    ).toBeInTheDocument();
  });

  it('marks a decided row with its decision rather than as waiting', async () => {
    stubApi([
      {
        url: '/payments',
        body: {
          payments: [payment({ lateReviewEligible: false, lateDecision: CREDITED })],
          nextCursor: null,
        },
      },
    ]);
    renderPage(
      <PaymentsPage route={{ path: '/payments', query: new URLSearchParams() }} denied={false} />,
    );
    await screen.findByText('a1b2c3d4e5f60718:manual');
    const table = screen.getByRole('table');
    expect(within(table).getByText('به کیف پول واریز شد')).toBeInTheDocument();
    expect(within(table).queryByText('در انتظار تصمیم')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The two decisions on the detail
// ---------------------------------------------------------------------------

describe('a late-review decision on the payment detail', () => {
  it('draws both decisions for a reviewer on a payment the server says is in the lane', async () => {
    stubApi(detail());
    renderPage(detailPage());
    expect(await screen.findByRole('button', { name: CREDIT_LABEL })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: DISMISS_LABEL })).toBeInTheDocument();
  });

  it('names receipts.review instead of drawing either decision without it', async () => {
    stubApi(detail());
    const view = renderPage(detailPage({ mayReview: false }));
    // The lane's own explanation renders once the detail has arrived.
    await screen.findByText(/پرداخت و سفارش آن منقضی می‌مانند/u);

    expect(screen.queryByRole('button', { name: CREDIT_LABEL })).toBeNull();
    expect(screen.queryByRole('button', { name: DISMISS_LABEL })).toBeNull();
    expect(view.container.textContent).toContain('receipts.review');
  });

  it('draws nothing for an expired transfer the server says is not in the lane', async () => {
    // Expired and signalled, which a surface recomputing the predicate might admit; the
    // server's `lateReviewEligible` is the answer, and it says no.
    stubApi(detail({ lateReviewEligible: false }));
    const view = renderPage(detailPage());
    await screen.findByText('منقضی شده');
    expect(view.container.textContent).not.toContain(LANE_TITLE);
    expect(screen.queryByRole('button', { name: CREDIT_LABEL })).toBeNull();
  });

  it('asks before crediting, naming the exact amount and that payment and order stay expired', async () => {
    const api = stubApi([
      ...detail(),
      {
        url: `/payments/${ROW_ID}/late-credit`,
        body: detailBody({ lateReviewEligible: false, lateDecision: CREDITED }),
      },
    ]);
    const view = renderPage(detailPage());

    fireEvent.click(await screen.findByRole('button', { name: CREDIT_LABEL }));
    // The first press ASKS. Nothing has been sent.
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
    const text = view.container.textContent ?? '';
    expect(text).toContain('مبلغی که به کیف پول مشتری واریز می‌شود');
    expect(text).toMatch(/۲۵۰٬۰۰۰|250,000/u);
    expect(text).toContain('این پرداخت و سفارش آن منقضی می‌مانند');

    // Cancelling sends nothing either.
    fireEvent.click(screen.getByRole('button', { name: 'انصراف' }));
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: CREDIT_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: CREDIT_CONFIRM_LABEL }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.url.endsWith('/late-credit'))).toBe(true);
    });
    const sent = api.calls.find((call) => call.url.endsWith('/late-credit'));
    expect(sent?.method).toBe('POST');
    const body = sent?.body as Record<string, unknown>;
    // A KEY and nothing else: an amount on this request would be an operator able to
    // credit a figure the customer never transferred.
    expect(Object.keys(body)).toEqual(['idempotencyKey']);
    expect(String(body['idempotencyKey']).length).toBeGreaterThanOrEqual(8);

    // The answer carries the decision, and the page now shows it instead of the forms.
    expect(await screen.findByText('به کیف پول واریز شد')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: DISMISS_LABEL })).toBeNull();
  });

  it('cannot dismiss without a reason', async () => {
    const api = stubApi(detail());
    renderPage(detailPage());
    const button = await screen.findByRole('button', { name: DISMISS_LABEL });

    expect(button).toBeDisabled();
    fireEvent.click(button);
    // A note alone is not a reason.
    fireEvent.change(screen.getByLabelText('توضیح (اختیاری)'), { target: { value: 'نرسید' } });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('sends the reason and the note to late-dismiss, and a null note when it is empty', async () => {
    const api = stubApi([
      ...detail(),
      {
        url: `/payments/${ROW_ID}/late-dismiss`,
        body: detailBody({ lateReviewEligible: false, lateDecision: DISMISSED }),
      },
    ]);
    renderPage(detailPage());
    await screen.findByRole('button', { name: DISMISS_LABEL });

    fireEvent.change(screen.getByLabelText('دلیل رد'), { target: { value: 'NOT_RECEIVED' } });
    fireEvent.change(screen.getByLabelText('توضیح (اختیاری)'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: DISMISS_LABEL }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.url.endsWith('/late-dismiss'))).toBe(true);
    });
    const body = api.calls.find((call) => call.url.endsWith('/late-dismiss'))?.body as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual(['idempotencyKey', 'note', 'reason']);
    expect(body['reason']).toBe('NOT_RECEIVED');
    expect(body['note']).toBeNull();
    // And NOT to the credit route: the two decisions are different commands.
    expect(api.calls.some((call) => call.url.endsWith('/late-credit'))).toBe(false);
  });

  it('carries a written note to late-dismiss, trimmed', async () => {
    const api = stubApi([
      ...detail(),
      {
        url: `/payments/${ROW_ID}/late-dismiss`,
        body: detailBody({ lateReviewEligible: false, lateDecision: DISMISSED }),
      },
    ]);
    renderPage(detailPage());
    await screen.findByRole('button', { name: DISMISS_LABEL });

    fireEvent.change(screen.getByLabelText('دلیل رد'), { target: { value: 'AMOUNT_UNDERPAID' } });
    fireEvent.change(screen.getByLabelText('توضیح (اختیاری)'), {
      target: { value: '  فقط نیمی رسید  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: DISMISS_LABEL }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.url.endsWith('/late-dismiss'))).toBe(true);
    });
    const body = api.calls.find((call) => call.url.endsWith('/late-dismiss'))?.body as Record<
      string,
      unknown
    >;
    expect(body['reason']).toBe('AMOUNT_UNDERPAID');
    expect(body['note']).toBe('فقط نیمی رسید');
  });

  it('renders a credit that was decided read-only, with its amount, reviewer and time', async () => {
    stubApi(detail({ lateReviewEligible: false, lateDecision: CREDITED }));
    const view = renderPage(detailPage());
    await screen.findByText('به کیف پول واریز شد');

    const text = view.container.textContent ?? '';
    expect(text).toContain('مبلغ واریزشده به کیف پول');
    expect(text).toContain(ADMIN_ID);
    expect(text).toContain(formatTimestamp('2026-09-11T08:00:00.000Z'));
    // No control could make a second decision.
    expect(screen.queryByRole('button', { name: CREDIT_LABEL })).toBeNull();
    expect(screen.queryByRole('button', { name: DISMISS_LABEL })).toBeNull();
    expect(screen.queryByLabelText('دلیل رد')).toBeNull();
  });

  it('renders a dismissal read-only, with its reason and nothing moved', async () => {
    stubApi(detail({ lateReviewEligible: false, lateDecision: DISMISSED }));
    const view = renderPage(detailPage());
    await screen.findByText('رد شد');

    const text = view.container.textContent ?? '';
    expect(text).toContain('مبلغ واریزی کمتر از مبلغ پرداخت است');
    expect(text).toContain('هیچ مبلغی جابه‌جا نشد');
    expect(text).toContain(ADMIN_ID);
    expect(text).not.toContain('مبلغ واریزشده به کیف پول');
    expect(screen.queryByRole('button', { name: DISMISS_LABEL })).toBeNull();
  });

  it('says ALREADY_DECIDED in words and re-reads the payment', async () => {
    const api = stubApi([
      ...detail(),
      {
        url: `/payments/${ROW_ID}/late-credit`,
        status: 409,
        body: refusal('commerce.late_transfer_already_decided', { decision: 'DISMISSED' }),
      },
    ]);
    renderPage(detailPage());
    fireEvent.click(await screen.findByRole('button', { name: CREDIT_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: CREDIT_CONFIRM_LABEL }));

    // In the banner and in a toast — the toast survives a re-read that replaces the form.
    expect((await screen.findAllByText(/پیش‌تر تصمیمی ثبت شده است/u)).length).toBeGreaterThan(0);
    // The detail was asked for again, so the standing decision is what renders next.
    await waitFor(() => {
      const reads = api.calls.filter(
        (call) => call.method === 'GET' && call.url.endsWith(`/payments/${ROW_ID}`),
      );
      expect(reads.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('disables both decisions while the credit is in flight', async () => {
    stubApi(detail());
    // A credit that never answers, so the in-flight state is observable.
    const pending = new Promise<Response>(() => undefined);
    const original = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) =>
      String(input).endsWith('/late-credit')
        ? pending
        : original(input as RequestInfo, init)) as typeof fetch;
    renderPage(detailPage());

    fireEvent.change(await screen.findByLabelText('دلیل رد'), {
      target: { value: 'NOT_RECEIVED' },
    });
    fireEvent.click(screen.getByRole('button', { name: CREDIT_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: CREDIT_CONFIRM_LABEL }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: DISMISS_LABEL })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: CREDIT_CONFIRM_LABEL })).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// The route decides the gate, not the page
// ---------------------------------------------------------------------------

describe('the late-review decisions through the route', () => {
  const at = { path: `/payments/${ROW_ID}`, query: new URLSearchParams() };

  it('draws the decisions from receipts.review, not from payments.view', async () => {
    stubApi(detail());
    const reader = resolve(at, ['payments.view']);
    const view = renderPage(reader.element as ReactElement);
    await waitFor(() => {
      expect(view.container.textContent).toContain('a1b2c3d4e5f60718:manual');
    });
    expect(screen.queryByRole('button', { name: CREDIT_LABEL })).toBeNull();
    expect(screen.queryByRole('button', { name: DISMISS_LABEL })).toBeNull();
    cleanup();

    stubApi(detail());
    const reviewer = resolve(at, ['payments.view', 'receipts.review']);
    renderPage(reviewer.element as ReactElement);
    expect(await screen.findByRole('button', { name: CREDIT_LABEL })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: DISMISS_LABEL })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Refunds: the delivery refusal, and what a full refund did and did not do (P3)
// ---------------------------------------------------------------------------

describe('the refund consequences', () => {
  const confirmed = { state: 'CONFIRMED', lateReviewEligible: false, resolvedAt: null };
  const ledger = (overrides: Record<string, unknown> = {}) => ({
    url: `/payments/${ROW_ID}/refunds`,
    body: {
      refunds: [],
      paidMinor: '250000',
      consumedMinor: '0',
      refundableMinor: '250000',
      currency: 'IRT',
      refundable: true,
      ...overrides,
    },
  });

  const refundPage = (mayViewOrders: boolean) => (
    <PaymentDetailPage
      id={ROW_ID}
      mayReview
      mayViewReceipts={false}
      mayViewRefunds
      mayIssueRefunds
      mayViewOrders={mayViewOrders}
      denied={false}
    />
  );

  it('names DELIVERY_IN_PROGRESS when the server refuses a refund for it', async () => {
    stubApi([
      ...detail(confirmed),
      ledger(),
      { url: `/orders/${ORDER_ID}`, body: { order: order({ state: 'PAID' }) } },
    ]);
    /*
     * The ledger GET and the refund POST share a URL, so the refusal is routed by method —
     * and every ledger read AFTER it answers `refundable: false`, which is what the server
     * says while the delivery is undecided. The sentence must survive that re-read.
     */
    const original = globalThis.fetch;
    let refused = false;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/refunds') && init?.method !== 'POST' && refused) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refunds: [],
              paidMinor: '250000',
              consumedMinor: '0',
              refundableMinor: '250000',
              currency: 'IRT',
              refundable: false,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (String(input).endsWith('/refunds') && init?.method === 'POST') {
        refused = true;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              refusal('commerce.refund_not_permitted', { reason: 'DELIVERY_IN_PROGRESS' }),
            ),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch;
    renderPage(refundPage(true));
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');

    fireEvent.change(screen.getByLabelText('مبلغ (به کوچک‌ترین یکای پول)'), {
      target: { value: '100000' },
    });
    fireEvent.change(screen.getByLabelText('دلیل'), { target: { value: 'مشتری منصرف شد' } });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت درخواست' }));

    expect(
      await screen.findByText(/تا وقتی ساخت سرویس این سفارش به نتیجهٔ قطعی نرسیده/u),
    ).toBeInTheDocument();
    // The ledger was re-read and now says unrefundable: the form is gone, the reason stays.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'ثبت درخواست' })).toBeNull();
    });
    expect(
      screen.getByText(/تا وقتی ساخت سرویس این سفارش به نتیجهٔ قطعی نرسیده/u),
    ).toBeInTheDocument();
  });

  it('keeps the server’s own message for a refusal that is not about delivery', async () => {
    stubApi([...detail(confirmed), ledger()]);
    const original = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/refunds') && init?.method === 'POST') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                kind: 'conflict',
                code: 'commerce.refund_not_permitted',
                message: 'This payment has refunds in another currency.',
                details: { reason: 'CURRENCY_MISMATCH' },
                correlationId: 'test',
              },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch;
    renderPage(refundPage(false));
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');

    fireEvent.change(screen.getByLabelText('مبلغ (به کوچک‌ترین یکای پول)'), {
      target: { value: '100000' },
    });
    fireEvent.change(screen.getByLabelText('دلیل'), { target: { value: 'مشتری منصرف شد' } });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت درخواست' }));

    expect(
      await screen.findByText('This payment has refunds in another currency.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/تا وقتی ساخت سرویس این سفارش/u)).toBeNull();
  });

  it('says the order is REFUNDED, from the order, and that the service was not touched', async () => {
    const api = stubApi([
      ...detail(confirmed),
      ledger({ consumedMinor: '250000', refundableMinor: '0' }),
      { url: `/orders/${ORDER_ID}`, body: { order: order({ state: 'REFUNDED' }) } },
    ]);
    const view = renderPage(refundPage(true));

    expect(await screen.findByText('سفارش این پرداخت بازگشت خورده است')).toBeInTheDocument();
    const text = view.container.textContent ?? '';
    expect(text).toContain('بازگشت وجه هیچ سرویسی را تعلیق یا حذف نمی‌کند');
    // It READ the order rather than inferring the state from the refund rows.
    expect(api.calls.some((call) => call.url.endsWith(`/orders/${ORDER_ID}`))).toBe(true);
    // And points at the order, where its service is shown and acted on.
    const link = screen.getByRole('link', { name: 'مشاهدهٔ سفارش و سرویس آن' });
    expect(link.getAttribute('href')).toBe(`/orders/${ORDER_ID}`);
  });

  it('says nothing about the order while it is still PAID', async () => {
    stubApi([
      ...detail(confirmed),
      ledger({ consumedMinor: '100000', refundableMinor: '150000' }),
      { url: `/orders/${ORDER_ID}`, body: { order: order({ state: 'PAID' }) } },
    ]);
    const view = renderPage(refundPage(true));
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');
    // Let the order query settle before asserting its absence.
    await waitFor(() => {
      expect(view.container.textContent).toContain('ثبت بازگشت وجه');
    });
    expect(view.container.textContent).not.toContain('سفارش این پرداخت بازگشت خورده است');
  });

  it('neither asks for nor describes the order without orders.view', async () => {
    const api = stubApi([
      ...detail(confirmed),
      ledger({ consumedMinor: '250000', refundableMinor: '0' }),
      { url: `/orders/${ORDER_ID}`, body: { order: order({ state: 'REFUNDED' }) } },
    ]);
    const view = renderPage(refundPage(false));
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');

    expect(api.calls.some((call) => call.url.includes('/orders/'))).toBe(false);
    expect(view.container.textContent).not.toContain('سفارش این پرداخت بازگشت خورده است');
  });
});
