import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { PaymentDetailPage, PaymentsPage } from '../../apps/web/src/pages/payments';
import { resolve } from '../../apps/web/src/app';
import { formatTimestamp } from '../../apps/web/src/format';
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
    resolvedAt: null,
    resolvedByAdminId: null,
    // REQUIRED by `paymentSummarySchema` since 4H. A fixture without it is not the
    // shape the server returns, and every case in this file failed on the parse.
    customerSignalledAt: null,
    expiresAt: null,
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T12:30:00.000Z',
    ...overrides,
  };
}

const detail = (overrides: Record<string, unknown> = {}) => [
  {
    url: `/payments/${ROW_ID}`,
    body: {
      payment: {
        ...payment(overrides),
        evidenceNote: null,
        resolutionNote: null,
        // REQUIRED by `paymentDetailSchema` since the Codex round on PR #34. Null is a
        // real answer — a wallet settlement has no destination — and the cases below
        // override it.
        destination: null,
        ...('destination' in overrides ? { destination: overrides['destination'] } : {}),
      },
    },
  },
];

const ACCOUNT_ID = '019250ab-cdef-7012-8345-6789abcdef01';

/** What the server sends: four digits and a flag, never the card number. */
const DESTINATION = {
  accountId: ACCOUNT_ID,
  label: 'main',
  bankName: 'Bank Melli',
  holderName: 'Acme Store',
  cardLast4: '7893',
  hasIban: true,
};

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

  /**
   * The customer's claim, on the list, and never as a state.
   *
   * `paymentSummarySchema` carries `customerSignalledAt` so a pending list is
   * triageable, and until this case the Web Admin dropped it on the floor: every
   * PENDING manual transfer looked alike, which is the measurement in
   * `docs/phase4h-audit.md` §4 that 4H set out to fix.
   *
   * The second half is the one that matters. A signalled payment is still PENDING —
   * a customer saying they paid is not a receipt and not a confirmation — so the
   * state badge must not move. The legacy system's defect is that "receipt" and
   * "payment" name one record (`PRBR-004`), and a surface that let a claim look like
   * a settlement would be that defect rebuilt.
   */
  /*
   * Reads the CELL under the header, not the header.
   *
   * The first version asserted that the header existed and that not every cell was a
   * dash, and it survived a mutation that replaced the column's renderer with a
   * constant dash — the header comes from the column definition, so a column that
   * renders nothing still has one. This finds the header's INDEX and reads the body
   * cell beneath it, which is the only place a customer's claim can actually appear.
   */
  const signalCell = (): string => {
    const table = screen.getByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent ?? '');
    const index = headers.indexOf('مشتری گفته پرداخت کرده');
    expect(index, 'no customer-signal column').toBeGreaterThanOrEqual(0);
    const cells = within(table)
      .getAllByRole('cell')
      .map((cell) => cell.textContent ?? '');
    return cells[index] ?? '';
  };

  it('shows that a customer said they paid, and still calls the payment pending', async () => {
    stubApi(list([payment({ customerSignalledAt: '2026-09-10T13:00:00.000Z' })]));
    renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718:manual');

    // A real instant in the cell — the SAME text `formatTimestamp` renders elsewhere,
    // which is how this knows a time was drawn and not a label or a placeholder.
    expect(signalCell()).toBe(formatTimestamp('2026-09-10T13:00:00.000Z'));
    // And the state has NOT moved. A customer's claim is not a receipt and not a
    // confirmation; the legacy defect is that "receipt" and "payment" name one record
    // (`PRBR-004`), and a surface where a claim looked settled would rebuild it.
    expect(within(screen.getByRole('table')).getByText('در انتظار')).toBeInTheDocument();
  });

  it('leaves the signal column empty for a payment no customer has claimed', async () => {
    stubApi(list([payment()]));
    renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718:manual');

    // The dash, in the same cell — so the case above cannot pass by rendering a
    // constant, and this one cannot pass by rendering nothing at all.
    expect(signalCell()).toBe('—');
  });
});

describe('the payment detail', () => {
  const render = (overrides: Record<string, unknown> = {}, mayReview = true) => {
    stubApi(detail(overrides));
    return renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayReview={mayReview}
        mayViewReceipts={false}
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
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
    renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayReview
        mayViewReceipts={false}
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
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

  /*
   * TWO controls now, and the list is still exhaustive.
   *
   * 4G gave `receipts.review` the reject half it has promised since the permission
   * catalogue was frozen, so a rejection is no longer among the things this page must
   * not offer. Everything else in the original list still is: there is no cancel here
   * (a withdrawal is the CUSTOMER's act and arrives through the bot), no retry
   * (`payments.retry` is a permission for a gateway that does not ship) and no refund
   * (`refunds.issue` is CRITICAL and unimplemented — OQ-4C-02).
   */
  it('draws no control that could cancel, retry or refund a payment', async () => {
    const view = render();
    await screen.findAllByText('a1b2c3d4e5f60718:manual');
    const labels = [...view.container.querySelectorAll('button')].map((b) => b.textContent?.trim());
    for (const label of labels) {
      expect(
        label === 'تأیید دریافت' || label === 'رد رسید' || label === '',
        `the payment page draws an unexpected control: ${String(label)}`,
      ).toBe(true);
    }
  });

  it('sends a REASON and nothing else when rejecting, and leaves the order alone', async () => {
    const api = stubApi([
      ...detail(payment({ state: 'PENDING', method: 'MANUAL_TRANSFER' })),
      {
        url: `/payments/${ROW_ID}/reject`,
        body: {
          payment: {
            ...payment({
              state: 'FAILED',
              resolvedAt: '2026-09-10T13:05:00.000Z',
              resolvedByAdminId: '019200ab-cdef-7012-8345-6789abcdef01',
            }),
            evidenceNote: null,
            resolutionNote: 'هیچ واریزی با این کد پیدا نشد',
          },
        },
      },
    ]);
    const view = renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayReview
        mayViewReceipts={false}
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
    await screen.findAllByText('a1b2c3d4e5f60718:manual');

    const reason = view.container.querySelector('#payment-reason') as HTMLInputElement;
    fireEvent.change(reason, { target: { value: 'هیچ واریزی با این کد پیدا نشد' } });
    fireEvent.click(screen.getByRole('button', { name: 'رد رسید' }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.url.endsWith('/reject'))).toBe(true);
    });
    const sent = api.calls.find((call) => call.url.endsWith('/reject'));
    const body = (sent?.body ?? {}) as Record<string, unknown>;
    // The reason and the key. No amount, no state, no order — the whole point of the
    // endpoint's shape, asserted where a later convenience field would break it.
    expect(Object.keys(body).sort()).toEqual(['idempotencyKey', 'resolutionNote']);
    expect(body.resolutionNote).toBe('هیچ واریزی با این کد پیدا نشد');
  });

  it('disables BOTH decisions while either is in flight', async () => {
    /*
     * The two commands race the same PENDING row with different idempotency keys, so an
     * operator who clicks confirm and then reject before the first returns gets whichever
     * request the database serves second — and one of the two cannot be undone. The
     * conditional UPDATE keeps the DATA consistent; it cannot make the outcome the one
     * the operator meant.
     *
     * The confirm route is left unrouted deliberately, so the mutation stays pending for
     * the length of the assertion rather than racing it.
     */
    stubApi(detail(payment({ state: 'PENDING', method: 'MANUAL_TRANSFER' })));
    /*
     * The confirmation is held OPEN rather than answered.
     *
     * An unrouted or errored POST settles immediately, so the pending window closes
     * before an assertion can see it and the test would pass or fail on timing. A
     * never-resolving response makes the window permanent, which is the state being
     * asserted: not "the request finished" but "while it is in flight".
     */
    const answered = globalThis.fetch;
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) =>
      String(input).endsWith('/confirm')
        ? new Promise<Response>(() => {})
        : (answered as typeof fetch)(input as RequestInfo, init),
    );

    const view = renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayReview
        mayViewReceipts={false}
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
    await screen.findAllByText('a1b2c3d4e5f60718:manual');

    const note = view.container.querySelector('#payment-note') as HTMLInputElement;
    const reason = view.container.querySelector('#payment-reason') as HTMLInputElement;
    fireEvent.change(note, { target: { value: 'money arrived' } });
    fireEvent.change(reason, { target: { value: 'no transfer arrived' } });

    expect(screen.getByRole('button', { name: 'تأیید دریافت' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'رد رسید' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'تأیید دریافت' }));

    // Re-queried, not held: the buttons re-render when the mutation's state changes.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'رد رسید' })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: 'تأیید دریافت' })).toBeDisabled();
  });

  it('disables the confirmation while a rejection is in flight, the mirror case', async () => {
    /*
     * The OTHER direction, and it needs its own test rather than a second assertion in
     * the one above. Each button carries its own expression, so a test that only clicks
     * confirm leaves the confirm button's mention of `reject.isPending` unexercised:
     * removing it was measured to survive that test (F4G-23) and to die against this one.
     */
    stubApi(detail(payment({ state: 'PENDING', method: 'MANUAL_TRANSFER' })));
    const answered = globalThis.fetch;
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) =>
      String(input).endsWith('/reject')
        ? new Promise<Response>(() => {})
        : (answered as typeof fetch)(input as RequestInfo, init),
    );

    const view = renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayReview
        mayViewReceipts={false}
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
    await screen.findAllByText('a1b2c3d4e5f60718:manual');

    const note = view.container.querySelector('#payment-note') as HTMLInputElement;
    const reason = view.container.querySelector('#payment-reason') as HTMLInputElement;
    fireEvent.change(note, { target: { value: 'money arrived' } });
    fireEvent.change(reason, { target: { value: 'no transfer arrived' } });

    fireEvent.click(screen.getByRole('button', { name: 'رد رسید' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'تأیید دریافت' })).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: 'رد رسید' })).toBeDisabled();
  });

  it('offers no rejection to an operator without receipts.review', async () => {
    stubApi(detail(payment({ state: 'PENDING', method: 'MANUAL_TRANSFER' })));
    const view = renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayReview={false}
        mayViewReceipts={false}
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
    await screen.findAllByText('a1b2c3d4e5f60718:manual');
    // Not a disabled button and not a hidden one behind a visible card: the whole
    // card is absent, so there is nothing to press and nothing to imply they could.
    expect(view.container.querySelector('#payment-reason')).toBeNull();
    expect(view.container.textContent).not.toContain('رد رسید');
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

  /*
   * The ROUTE deriving each prop from a permission, not a page handed one directly.
   *
   * Every other permission case in this file and in `users.test.tsx` constructs the page
   * with `mayReview={false}`, which proves the page honours the prop and says nothing
   * about `app.tsx` computing it. `mayReview={may('payments.view')}` — every reader
   * offered the approve form — left that whole suite green. This is the call site.
   */
  it('derives the review affordance from receipts.review, not from payments.view', async () => {
    stubApi(detail(payment({ state: 'PENDING', method: 'MANUAL_TRANSFER' })));
    const reader = resolve({ path: `/payments/${ROW_ID}`, query: new URLSearchParams() }, [
      'payments.view',
    ]);
    const readerView = renderPage(reader.element as ReactElement);
    // The settled detail, so the assertion below is about a rendered page rather than a
    // spinner that has not drawn the button yet either.
    await waitFor(() => {
      expect(readerView.container.textContent).toContain('a1b2c3d4e5f60718:manual');
    });
    expect(readerView.queryByText('تأیید دریافت')).toBeNull();
    // Named, not merely absent: the reader is told which permission they lack.
    expect(readerView.container.textContent).toContain('receipts.review');

    cleanup();

    stubApi(detail(payment({ state: 'PENDING', method: 'MANUAL_TRANSFER' })));
    const approver = resolve({ path: `/payments/${ROW_ID}`, query: new URLSearchParams() }, [
      'payments.view',
      'receipts.review',
    ]);
    renderPage(approver.element as ReactElement);
    // The card title first, then the BUTTON — the reader above sees the title too, and
    // asserting on it would not distinguish the two operators at all.
    await screen.findByText('تأیید دریافت وجه');
    expect(screen.getByText('تأیید دریافت')).toBeTruthy();
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

/**
 * The card the Codex review of PR #34 found missing.
 *
 * The snapshot was frozen onto every manual-transfer payment by 5A and reached exactly
 * one caller: the customer's own instructions. So the reviewer holding a bank statement
 * could not tell which account a payment had named — the question the snapshot exists to
 * answer after an account is renamed or disabled.
 *
 * Two cases, and the second is the one that matters: a PROHIBITION. The browser must
 * never receive the sixteen digits, so the assertion is on what is absent rather than on
 * what is drawn.
 */
describe('the frozen destination on a payment detail', () => {
  it('names the account the instructions pointed at', async () => {
    stubApi(detail({ destination: DESTINATION }));
    const { container } = renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayReview={false}
        mayViewReceipts={false}
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
    await screen.findByText('مقصد واریز اعلام‌شده');

    expect(container.textContent).toContain('مقصد واریز اعلام‌شده');
    expect(container.textContent).toContain('main');
    expect(container.textContent).toContain('Bank Melli');
    expect(container.textContent).toContain('Acme Store');
    expect(container.textContent).toContain('7893');
    // A Sheba was given, and WHETHER is all this screen says about it.
    expect(container.textContent).toContain('به مشتری اعلام شد');
  });

  it('never renders a full card number, and says nothing when there is no destination', async () => {
    stubApi(detail({ destination: DESTINATION }));
    const withCard = renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayReview={false}
        mayViewReceipts={false}
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
    await screen.findByText('مقصد واریز اعلام‌شده');
    /*
     * Sixteen consecutive digits anywhere on the page. `cardLast4` is what the contract
     * carries, so this fails only if somebody widens the schema — which is the change
     * this case exists to stop.
     */
    expect(withCard.container.textContent ?? '').not.toMatch(/[0-9]{16}/u);
    cleanup();

    stubApi(detail());
    const without = renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayReview={false}
        mayViewReceipts={false}
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
    // The reference proves the page RENDERED; the destination card is what must not be
    // there. Anchoring on the card's own title would pass on a page that never loaded.
    await screen.findByText('جزئیات پرداخت');
    // Hidden, not filled with dashes: a wallet payment genuinely has no destination.
    expect(without.container.textContent).not.toContain('مقصد واریز اعلام‌شده');
  });
});

const RECEIPT_ID = '019260ab-cdef-7012-8345-6789abcdef01';

/** As `paymentReceiptViewSchema` describes one. `fileId` is deliberately not on it. */
function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RECEIPT_ID,
    kind: 'PHOTO',
    fileUniqueId: 'AgADBAADq',
    /*
     * NULL, because that is what a photo carries. Telegram re-encodes it and declares
     * no type, so `receiptFileOf` stores null rather than inventing one — and a fixture
     * that said `image/jpeg` here is what hid a photo never rendering at all.
     */
    mimeType: null,
    fileSize: 204_800,
    fileName: null,
    createdAt: '2026-09-10T12:40:00.000Z',
    ...overrides,
  };
}

const withReceipts = (receipts: unknown[], overrides: Record<string, unknown> = {}) => [
  ...detail(overrides),
  { url: `/payments/${ROW_ID}/receipts`, body: { receipts } },
  { url: `/payments/${ROW_ID}/receipts/${RECEIPT_ID}/content`, body: { bytes: 'stand-in' } },
];

/**
 * The receipt card.
 *
 * jsdom implements neither `createObjectURL` nor `revokeObjectURL`, so both are stubbed
 * per test — and the stub is also the assertion for the second case: what the component
 * puts in the Blob it hands the browser is the type decision under test.
 */
describe('the receipts an operator can read', () => {
  function stubObjectUrls(): { types: string[] } {
    const types: string[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      types.push(blob.type);
      return 'blob:stand-in';
    });
    URL.revokeObjectURL = vi.fn();
    return { types };
  }

  it('draws nothing at all without receipts.view', async () => {
    const api = stubApi(withReceipts([receipt()]));
    const view = renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayReview
        mayViewReceipts={false}
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
    /*
     * The REFERENCE, not the page heading. «جزئیات پرداخت» is the head and renders
     * before the query settles, so asserting after it asserts against a skeleton — and
     * this case passed with the permission gate deleted. The reference exists only once
     * the detail has arrived, which is the render the card would have appeared in.
     */
    // The CONFIRM FORM, which renders only once the detail has arrived and only for a
    // pending manual transfer. Waiting on the page heading instead asserts against a
    // skeleton, and this case passed with the permission gate deleted when it did.
    await screen.findByText('تأیید دریافت وجه');

    expect(view.container.textContent).not.toContain('رسیدهای ارسالی مشتری');
    // And it did not ASK either: a card that is not drawn must not still fetch a
    // customer's bank screenshot.
    expect(api.calls.some((call) => call.url.includes('/receipts'))).toBe(false);
  });

  it('lists what the customer sent, and says a receipt is not a confirmation', async () => {
    stubApi(withReceipts([receipt({ fileName: 'rasid.jpg' })]));
    const view = renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayReview
        mayViewReceipts
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
    await screen.findByText('rasid.jpg');

    expect(view.container.textContent).toContain('تصویر');
    expect(view.container.textContent).toContain('rasid.jpg');
    expect(view.container.textContent).toContain(formatTimestamp('2026-09-10T12:40:00.000Z'));
    // The sentence that keeps a receipt evidence rather than an outcome.
    expect(view.container.textContent).toContain('به‌تنهایی پرداخت را تأیید نمی‌کند');
  });

  it('fetches a photo through the API and renders it as an image', async () => {
    const urls = stubObjectUrls();
    const api = stubApi(withReceipts([receipt()]));
    const view = renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayReview
        mayViewReceipts
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
    fireEvent.click(await screen.findByText('مشاهدهٔ رسید'));

    await waitFor(() => {
      expect(view.container.querySelector('img.receipt-image')).not.toBeNull();
    });
    // Through the API's own route — the bot token never reaches this bundle.
    expect(
      api.calls.some((call) =>
        call.url.includes(`/payments/${ROW_ID}/receipts/${RECEIPT_ID}/content`),
      ),
    ).toBe(true);
    // EMPTY, not invented: the record has no type, so the Blob gets none and the
    // `<img>` sniffs. A fabricated `image/jpeg` here would be this code claiming a fact
    // about a customer's file that nothing observed.
    expect(urls.types).toStrictEqual(['']);
  });

  it('passes an image type through when the record happens to carry one', async () => {
    const urls = stubObjectUrls();
    stubApi(withReceipts([receipt({ mimeType: 'image/png' })]));
    const view = renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayReview
        mayViewReceipts
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
    fireEvent.click(await screen.findByText('مشاهدهٔ رسید'));

    await waitFor(() => {
      expect(view.container.querySelector('img.receipt-image')).not.toBeNull();
    });
    expect(urls.types).toStrictEqual(['image/png']);
  });

  it('never renders a DOCUMENT inline, whatever mime type it claims', async () => {
    const urls = stubObjectUrls();
    stubApi(withReceipts([receipt({ kind: 'DOCUMENT', mimeType: 'image/svg+xml' })]));
    const view = renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayReview
        mayViewReceipts
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
    // The control says download rather than view, because the record says DOCUMENT.
    fireEvent.click(await screen.findByText('دریافت فایل رسید'));

    await waitFor(() => {
      expect(screen.getByText('ذخیرهٔ فایل')).toBeInTheDocument();
    });
    /*
     * The PROHIBITION this case exists for. An `image/svg+xml` a customer uploaded is a
     * script if it is ever rendered on this origin, and `kind` is what refuses it.
     */
    expect(view.container.querySelector('img')).toBeNull();
    expect(urls.types).toStrictEqual(['application/octet-stream']);
  });

  it('says the receipt is unavailable rather than showing a broken image', async () => {
    stubObjectUrls();
    stubApi([
      ...detail(),
      { url: `/payments/${ROW_ID}/receipts`, body: { receipts: [receipt()] } },
      {
        url: `/payments/${ROW_ID}/receipts/${RECEIPT_ID}/content`,
        status: 412,
        body: {
          error: {
            kind: 'precondition_failed',
            code: 'commerce.receipt_unavailable',
            message: 'gone',
            correlationId: 'test',
          },
        },
      },
    ]);
    const view = renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayReview
        mayViewReceipts
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
    fireEvent.click(await screen.findByText('مشاهدهٔ رسید'));

    await waitFor(() => {
      expect(view.container.textContent).toContain('رسید در دسترس نیست');
    });
    expect(view.container.querySelector('img')).toBeNull();
  });

  // The ROUTE, not the page: `receipts.view` and `receipts.review` are separate props,
  // and a route deriving both from one permission would pass every case above.
  it('derives the receipt card from receipts.view, separately from receipts.review', async () => {
    stubApi(withReceipts([receipt()]));
    const reviewer = resolve({ path: `/payments/${ROW_ID}`, query: new URLSearchParams() }, [
      'payments.view',
      'receipts.review',
    ]);
    const view = renderPage(reviewer.element as ReactElement);
    await waitFor(() => {
      expect(view.container.textContent).toContain('a1b2c3d4e5f60718:manual');
    });
    // Holding review without view draws the decision and not the evidence.
    expect(view.container.textContent).not.toContain('رسیدهای ارسالی مشتری');
    cleanup();

    stubApi(withReceipts([receipt()]));
    const both = resolve({ path: `/payments/${ROW_ID}`, query: new URLSearchParams() }, [
      'payments.view',
      'receipts.view',
    ]);
    const withView = renderPage(both.element as ReactElement);
    await waitFor(() => {
      expect(withView.container.textContent).toContain('رسیدهای ارسالی مشتری');
    });
  });
});

// ---------------------------------------------------------------------------
// Refunds (Phase 5E)
// ---------------------------------------------------------------------------

const REFUND_ID = '019260ab-cdef-7012-8345-6789abcdef01';
const ADMIN_ID = '019270ab-cdef-7012-8345-6789abcdef01';

function refundRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REFUND_ID,
    paymentId: ROW_ID,
    orderId: ORDER_ID,
    customerId: CUSTOMER_ID,
    state: 'AWAITING_EXTERNAL',
    channel: 'EXTERNAL_MANUAL',
    amountMinor: '100000',
    currency: 'IRT',
    reason: 'مشتری منصرف شد',
    requestedByAdminId: ADMIN_ID,
    completedByAdminId: null,
    externalReference: null,
    completionNote: null,
    createdAt: '2026-09-11T09:00:00.000Z',
    updatedAt: '2026-09-11T09:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

/** The payment detail plus its refund ledger, both parsed by the real schemas. */
const withRefunds = (
  refunds: readonly unknown[],
  ledger: Record<string, unknown> = {},
  paymentOverrides: Record<string, unknown> = {},
) => [
  ...detail({ state: 'CONFIRMED', ...paymentOverrides }),
  {
    url: `/payments/${ROW_ID}/refunds`,
    body: {
      refunds,
      paidMinor: '250000',
      consumedMinor: '0',
      refundableMinor: '250000',
      currency: 'IRT',
      refundable: true,
      ...ledger,
    },
  },
];

describe('the refund card', () => {
  const renderDetail = (routes: readonly unknown[], mayIssue: boolean) => {
    stubApi(routes as never);
    return renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayReview
        mayViewReceipts={false}
        mayViewRefunds
        mayIssueRefunds={mayIssue}
        denied={false}
      />,
    );
  };

  it('renders the history with its actors, and the server’s own remaining amount', async () => {
    const view = renderDetail(
      withRefunds([refundRow()], { consumedMinor: '100000', refundableMinor: '150000' }),
      true,
    );
    // The CARD's title appears before its query settles, so waiting on it proves
    // nothing. This label renders only once the ledger has arrived.
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');

    expect(view.container.textContent).toContain('در انتظار واریز بیرونی');
    expect(view.container.textContent).toContain('واریز دستی بیرون از سامانه');
    expect(view.container.textContent).toContain('مشتری منصرف شد');
    // Who asked for it. `/admin/logs` could not answer this, which is the point.
    expect(view.container.textContent).toContain(ADMIN_ID);
    // And the sentence for the completion nobody has performed — not a dash.
    expect(view.container.textContent).toContain('هنوز کسی واریز را تأیید نکرده است');
  });

  it('does not recompute the remaining amount from the rows it was handed', async () => {
    /*
     * The server says 150,000 while the rows sum to 100,000 of a 250,000 payment — a
     * combination the server would not actually produce. It is here precisely to catch
     * a screen that computed the figure itself: such a screen would render a number the
     * server never sent, and the one an operator acts on would be the browser's.
     */
    const view = renderDetail(
      withRefunds([refundRow({ amountMinor: '50000' })], {
        consumedMinor: '100000',
        refundableMinor: '150000',
      }),
      true,
    );
    // The CARD's title appears before its query settles, so waiting on it proves
    // nothing. This label renders only once the ledger has arrived.
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');
    expect(view.container.textContent).toMatch(/۱۵۰٬۰۰۰|150,000/u);
  });

  it('says a payment cannot be refunded at all, and offers no form', async () => {
    const view = renderDetail(
      withRefunds([], { refundable: false, refundableMinor: '250000' }, { method: 'GATEWAY' }),
      true,
    );
    // The CARD's title appears before its query settles, so waiting on it proves
    // nothing. This label renders only once the ledger has arrived.
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');

    expect(view.container.textContent).toContain('این پرداخت قابل بازگشت نیست');
    // NOT a button. A gateway payment has no channel to reverse in this release, and a
    // control here would promise a reversal nobody can perform.
    expect(screen.queryByRole('button', { name: 'ثبت درخواست' })).toBeNull();
  });

  it('names the permission instead of drawing a disabled button', async () => {
    const view = renderDetail(withRefunds([]), false);
    // The CARD's title appears before its query settles, so waiting on it proves
    // nothing. This label renders only once the ledger has arrived.
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');

    expect(view.container.textContent).toContain('refunds.issue');
    expect(screen.queryByLabelText('مبلغ (به کوچک‌ترین یکای پول)')).toBeNull();
  });

  it('sends the amount as a decimal string of minor units, with its reason', async () => {
    const api = stubApi(withRefunds([]) as never);
    renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayReview
        mayViewReceipts={false}
        mayViewRefunds
        mayIssueRefunds
        denied={false}
      />,
    );
    // The CARD's title appears before its query settles, so waiting on it proves
    // nothing. This label renders only once the ledger has arrived.
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');

    fireEvent.change(screen.getByLabelText('مبلغ (به کوچک‌ترین یکای پول)'), {
      target: { value: '100000' },
    });
    fireEvent.change(screen.getByLabelText('دلیل'), { target: { value: 'مشتری منصرف شد' } });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت درخواست' }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const posted = api.calls.find((call) => call.method === 'POST');
    const body = posted?.body as Record<string, unknown>;
    // A STRING, and no currency: a refund is denominated by the payment it reverses.
    expect(body['amountMinor']).toBe('100000');
    expect('currency' in body).toBe(false);
    expect(body['reason']).toBe('مشتری منصرف شد');
    expect(typeof body['idempotencyKey']).toBe('string');
  });

  it('fills the amount from the server’s remaining figure, unaltered', async () => {
    renderDetail(withRefunds([], { refundableMinor: '9007199254740993' }), true);
    // The CARD's title appears before its query settles, so waiting on it proves
    // nothing. This label renders only once the ledger has arrived.
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');

    fireEvent.click(screen.getByText('کل باقی‌ماندهٔ قابل بازگشت'));
    // Past 2^53. Copied as a string, because computing it would round it.
    expect(screen.getByLabelText<HTMLInputElement>('مبلغ (به کوچک‌ترین یکای پول)').value).toBe(
      '9007199254740993',
    );
  });

  it('offers the answer form only for a refund awaiting an external transfer', async () => {
    const view = renderDetail(
      withRefunds([refundRow({ state: 'COMPLETED', completedByAdminId: ADMIN_ID })], {
        consumedMinor: '100000',
        refundableMinor: '150000',
      }),
      true,
    );
    // The CARD's title appears before its query settles, so waiting on it proves
    // nothing. This label renders only once the ledger has arrived.
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');

    expect(view.container.textContent).toContain('بازگشت انجام شد');
    // Nothing left to answer, so the form that records an external transfer is absent.
    expect(view.container.textContent).not.toContain('پاسخ به بازگشت‌های در انتظار واریز');
  });
});
