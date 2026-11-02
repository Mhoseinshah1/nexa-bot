import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { PaymentDetailPage, PaymentsPage } from '../../apps/web/src/pages/payments';
import { resolve } from '../../apps/web/src/app';
import { formatTimestamp } from '../../apps/web/src/format';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';
import { openFilterPanel } from './ui-helpers';
import { PAYMENT_ROUTES, type PermissionKey } from '@nexa/contracts';
import * as client from '../../apps/web/src/api/client';
import { leaveGuarded } from '../../apps/web/src/router';
import { LeaveGuardHost } from '../../apps/web/src/ui/kit';
import { sourceFilterAbsent, rowHasBadge } from './source-helpers';

/** The button of that name inside the open dialog (a row button of the same name opens it). */
const inDialog = (name: string): HTMLElement =>
  within(screen.getByRole('dialog')).getByRole('button', { name });

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
 *   - there is NO card-to-card write. Payment File 02 §10 puts review in Telegram only,
 *     and the page says so for a pending transfer instead of drawing a control the
 *     server has no route for (D3).
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
    // FIX-02: the page shows the PUBLIC code — this reference without its `:manual` suffix.
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

    expect(await screen.findByText('a1b2c3d4e5f60718')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('a1b2c3d4e5f60718:manual');
    // Inside the TABLE, not the filter pills above it — both carry these labels, and a
    // loose query would pass on a page whose rows rendered nothing at all.
    const table = screen.getByRole('table');
    expect(within(table).getByText('در انتظار')).toBeInTheDocument();
    expect(within(table).getByText('کارت به کارت')).toBeInTheDocument();
    // The formatted amount, from the decimal STRING on the wire.
    expect(within(table).getByText(/۲۵۰٬۰۰۰|250,000/u)).toBeInTheDocument();
  });

  it('tells a credited receipt from a rejected one on the list, and filters by it (WP10 follow-up §5)', async () => {
    const CREDITED = '019240ab-cdef-7012-8345-6789abcdef02';
    const REJECTED = '019240ab-cdef-7012-8345-6789abcdef03';
    stubApi(
      list([
        payment({
          id: CREDITED,
          reference: 'credited:manual',
          state: 'FAILED',
          receiptDisposition: 'CREDITED_TO_WALLET',
        }),
        payment({
          id: REJECTED,
          reference: 'rejected:manual',
          state: 'FAILED',
          receiptDisposition: 'REJECTED',
        }),
      ]),
    );
    renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('credited:manual');
    const table = screen.getByRole('table');
    const creditedRow = within(table).getByText('credited:manual').closest('tr');
    const rejectedRow = within(table).getByText('rejected:manual').closest('tr');
    expect(creditedRow?.textContent).toContain('واریز به کیف پول');
    expect(creditedRow?.textContent).not.toContain('رد شد');
    expect(rejectedRow?.textContent).toContain('رد شد');
    // The disposition is offered as a filter, over the frozen vocabulary.
    const panel = openFilterPanel();
    expect(
      within(panel).getAllByRole('button', { name: 'واریز به کیف پول' }).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('carries an amount past 2^53 without losing a unit', async () => {
    // The wire form is a string precisely because `Number` would round this. A balance
    // can reach it by summing many movements even though one is bounded below it.
    stubApi(list([payment({ amount: '9007199254740993' })]));
    const { container } = renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718');
    expect(container.textContent).not.toContain('9007199254740992');
  });

  it('offers every FROZEN state and method as a filter', async () => {
    stubApi(list([payment()]));
    renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718');
    const container = openFilterPanel();

    // Including the ones nothing reaches yet: a state in the contract with no filter is
    // an option nobody notices is missing.
    for (const label of ['در انتظار', 'تأیید شده', 'ناموفق', 'لغو شده', 'منقضی شده', 'نامشخص']) {
      expect(container.textContent, label).toContain(label);
    }
    for (const label of ['کیف پول', 'کارت به کارت', 'درگاه']) {
      expect(container.textContent, label).toContain(label);
    }
  });

  /*
   * The Payment Operations Center (program §10) replaced the old "no gateway is defined"
   * note — gateways ship now — with the rule the page holds: nothing here marks a payment
   * paid, and where reconciling and refunding live instead.
   */
  it('says that nothing on the page marks a payment paid, and where the real actions are', async () => {
    stubApi(list([payment()]));
    const { container } = renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718');
    expect(container.textContent).toContain('تأیید یک پرداخت فقط از راه تسویه و با مدرک');
    expect(container.textContent).not.toContain('هیچ درگاه پرداختی ثبت یا تعریف نشده است');
  });

  /*
   * Spec §10: ONE search box. What used to be three single-purpose boxes — two of them
   * wanting an internal uuid — is one `q` the server classifies, and the non-text
   * filters stay their own controls. The PAGE's use of `setQueries` is what is under
   * test: a new search must start at the first page and keep the other filters.
   */
  it('applies the one search in ONE navigation, keeps the filters, and drops the cursor', async () => {
    stubApi(list([payment()]));
    window.history.replaceState(null, '', '/payments?cursor=stale-page&state=PENDING');
    const route = {
      path: '/payments',
      query: new URLSearchParams({ cursor: 'stale-page', state: 'PENDING' }),
    };
    renderPage(<PaymentsPage route={route} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718');

    fireEvent.change(screen.getByLabelText('جست‌وجو'), { target: { value: '5550001234' } });
    fireEvent.click(screen.getByRole('button', { name: 'جست‌وجو' }));

    await waitFor(() => {
      const applied = new URLSearchParams(window.location.search);
      expect(applied.get('q')).toBe('5550001234');
      expect(applied.get('state'), 'the state filter was dropped').toBe('PENDING');
      // A new search starts at the first page: carrying the old cursor pages through a
      // list that no longer exists.
      expect(applied.get('cursor'), 'a stale cursor survived a new search').toBeNull();
      // None of the retired single-purpose parameters.
      expect(applied.get('customerId')).toBeNull();
      expect(applied.get('reference')).toBeNull();
    });
  });

  /*
   * PR #285 review, A1: «پاک کردن همه» once called each chip's own `setQueries` against the
   * same stale `route.query`, so only the LAST removal survived. The page's clear-all is
   * one navigation that also drops the search and the cursor.
   */
  it('«پاک کردن همه» drops every URL filter, the search and the cursor in one go', async () => {
    stubApi(list([payment()]));
    const query = new URLSearchParams({
      state: 'PENDING',
      method: 'MANUAL_TRANSFER',
      q: 'abc',
      cursor: 'stale-page',
    });
    window.history.replaceState(null, '', `/payments?${query.toString()}`);
    renderPage(<PaymentsPage route={{ path: '/payments', query }} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718');

    const line = screen.getByRole('search', { name: t('web.payment_ops_title') });
    fireEvent.click(within(line).getByRole('button', { name: t('web.filters_clear_all') }));

    const applied = new URLSearchParams(window.location.search);
    expect(window.location.pathname).toBe('/payments');
    expect(applied.get('state'), 'the state filter survived «پاک کردن همه»').toBeNull();
    expect(applied.get('method'), 'the method filter survived «پاک کردن همه»').toBeNull();
    expect(applied.get('q'), 'the search survived «پاک کردن همه»').toBeNull();
    expect(applied.get('cursor')).toBeNull();
  });

  it('sends the search as q, beside the non-text filters', async () => {
    const api = stubApi(list([payment()]));
    const route = {
      path: '/payments',
      query: new URLSearchParams({ q: 'abc:manual', method: 'MANUAL_TRANSFER' }),
    };
    renderPage(<PaymentsPage route={route} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718');
    // The list request, not the queue counts read beside it.
    const url = [...api.calls].reverse().find((call) => call.url.includes('/payments?'))?.url ?? '';
    expect(url).toContain('q=abc%3Amanual');
    expect(url).toContain('method=MANUAL_TRANSFER');
  });

  it('keeps the evidence note off the LIST', async () => {
    // An operator's own text about somebody's bank transfer. Detail only, and the list
    // is the thing most likely to end up on a shared screen.
    stubApi(list([payment()]));
    const { container } = renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718');
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
  /*
   * Demo parity X9: the claim moved from a column into the row's DETAIL (one toggle on the
   * row), so this opens the detail and reads the VALUE beside the claim's label — still the
   * only place a customer's claim can appear on the list, and still not the header.
   */
  const signalCell = (): string => {
    const table = screen.getByRole('table');
    fireEvent.click(within(table).getByRole('button', { name: t('web.payment_row_detail') }));
    const term = within(table)
      .getAllByRole('term')
      .find((cell) => cell.textContent === 'مشتری گفته پرداخت کرده');
    expect(term, 'no customer-signal fact in the row detail').toBeDefined();
    return term?.nextElementSibling?.textContent ?? '';
  };

  it('shows that a customer said they paid, and still calls the payment pending', async () => {
    stubApi(list([payment({ customerSignalledAt: '2026-09-10T13:00:00.000Z' })]));
    renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718');

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
    await screen.findByText('a1b2c3d4e5f60718');

    // The dash, in the same cell — so the case above cannot pass by rendering a
    // constant, and this one cannot pass by rendering nothing at all.
    expect(signalCell()).toBe('—');
  });
});

describe('the payment detail', () => {
  const render = (overrides: Record<string, unknown> = {}) => {
    stubApi(detail(overrides));
    return renderPage(
      <PaymentDetailPage
        id={ROW_ID}
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
    // W5: named in Persian, the machine key kept in the title.
    expect(screen.getByText('بررسی مدیر')).toHaveAttribute('title', 'OPERATOR_REVIEW');
    expect(screen.getByText('تأییدکننده')).toBeInTheDocument();
    expect(screen.getByText('زمان تأیید')).toBeInTheDocument();
  });

  it('draws no approve, reject or credit for a viewer without receipts.review, and says what is needed', async () => {
    /*
     * R12 F3 item 8 supersedes Payment File 02 §10 (D3): the decision is also taken here, but
     * only by who holds `receipts.review`. This page is handed neither permission, so it
     * draws no control and says which permission it would take.
     */
    const view = render({ state: 'PENDING', method: 'MANUAL_TRANSFER' });
    await screen.findByText('بررسی رسید');
    expect(view.container.textContent).toContain(t('web.receipt_denied'));
    expect(view.container.querySelector('#payment-note')).toBeNull();
    expect(view.container.querySelector('#payment-reason')).toBeNull();
    for (const label of ['تأیید دریافت', 'رد رسید', 'واریز به کیف پول']) {
      expect(screen.queryByRole('button', { name: label }), label).toBeNull();
    }
  });

  it('says nothing about review for a payment that is not a pending transfer', async () => {
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
      await screen.findAllByText('a1b2c3d4e5f60718');
      expect(
        view.container.textContent,
        `a review notice was drawn for ${JSON.stringify(overrides)}`,
      ).not.toContain('بررسی رسید');
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
      await screen.findAllByText('a1b2c3d4e5f60718');
      const text = view.container.textContent ?? '';
      for (const claim of ['در حال آماده‌سازی', 'سرویس ساخته', 'تحویل شد', 'در حال ساخت']) {
        expect(text, `the payment page claims "${claim}"`).not.toContain(claim);
      }
      /*
       * And it says where that state IS, rather than merely omitting it.
       *
       * This assertion used to pin the sentence «ساخت یا تحویل سرویس در این نسخه
       * انجام نمی‌شود». That stopped being true at Phase 4D and was still on the
       * screen in v0.2.8 while order `01a0c54b` was provisioned, failed and
       * refunded — so the test was holding a false claim in place. What the page
       * owes a reader is unchanged: it must not assert anything about a service it
       * did not read. It now points at the two pages that did read one.
       */
      expect(text).toContain('وضعیت ساخت و تحویل سرویس در صفحهٔ سفارش');
      view.unmount();
    }
  });

  /*
   * NO controls, and the list is exhaustive: no confirm and no reject (Payment File 02
   * §10 — review is Telegram's), no cancel (a withdrawal is the CUSTOMER's act and
   * arrives through the bot), no retry (`payments.retry` is a permission for a gateway
   * that does not ship). A refund is its own card, under its own permission, and is not
   * drawn here with `refunds.view` off.
   */
  it('draws no control that could confirm, reject, cancel, retry or refund a payment', async () => {
    const view = render();
    await screen.findAllByText('a1b2c3d4e5f60718');
    const labels = [...view.container.querySelectorAll('button')]
      .map((b) => b.textContent?.trim())
      // The history's refresh only reads again; it is not a control over the payment.
      .filter((label) => label !== '' && label !== t('web.refresh'));
    expect(labels, 'the payment page draws a control').toEqual([]);
  });
});

describe('the payments route', () => {
  const ALL: readonly PermissionKey[] = ['payments.view', 'receipts.review'];
  const NONE: readonly PermissionKey[] = [];

  it('resolves to the real page, not the planned placeholder', () => {
    stubApi(list([payment()]));
    const resolved = resolve({ path: '/payments', query: new URLSearchParams() }, ALL);
    const view = renderPage(resolved.element as ReactElement);
    // The placeholder's own heading, which must NOT be here any more.
    expect(view.container.textContent).not.toContain('چرا هنوز فعال نیست');
    expect(view.container.textContent).toContain('پرداخت‌ها');
  });

  /*
   * The ROUTE, not a page handed props (R12 F3 item 8): an operator holding `receipts.review`
   * is offered the decision, and the credit only with `users.wallet.credit` too.
   */
  it('offers the card-to-card decision to receipts.review, the credit only with the wallet permission', async () => {
    stubApi(detail(payment({ state: 'PENDING', method: 'MANUAL_TRANSFER' })));
    const approver = resolve({ path: `/payments/${ROW_ID}`, query: new URLSearchParams() }, [
      'payments.view',
      'receipts.review',
    ]);
    const view = renderPage(approver.element as ReactElement);
    await screen.findByText('بررسی رسید');
    expect(view.queryByRole('button', { name: t('web.receipt_approve') })).not.toBeNull();
    expect(view.queryByRole('button', { name: t('web.receipt_reject') })).not.toBeNull();
    expect(view.queryByRole('button', { name: t('web.receipt_credit') })).toBeNull();
    view.unmount();

    stubApi(detail(payment({ state: 'PENDING', method: 'MANUAL_TRANSFER' })));
    const both = resolve({ path: `/payments/${ROW_ID}`, query: new URLSearchParams() }, [
      'payments.view',
      'receipts.review',
      'users.wallet.credit',
    ]);
    const full = renderPage(both.element as ReactElement);
    await screen.findByText('بررسی رسید');
    expect(full.queryByRole('button', { name: t('web.receipt_credit') })).not.toBeNull();
  });

  it('offers no decision to payments.view alone', async () => {
    stubApi(detail(payment({ state: 'PENDING', method: 'MANUAL_TRANSFER' })));
    const viewer = resolve({ path: `/payments/${ROW_ID}`, query: new URLSearchParams() }, [
      'payments.view',
    ]);
    const view = renderPage(viewer.element as ReactElement);
    await screen.findByText('بررسی رسید');
    for (const name of [
      'web.receipt_approve',
      'web.receipt_reject',
      'web.receipt_credit',
    ] as const) {
      expect(view.queryByRole('button', { name: t(name) }), name).toBeNull();
    }
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
describe('a Telegram Stars payment on the detail (Codex review of #85, C6)', () => {
  const INVOICE = {
    provider: 'TELEGRAM_STARS',
    providerOrderId: 'a'.repeat(32),
    providerInvoiceId: 'message:910910:42',
    creationState: 'CREATED',
    creationErrorCode: null,
    providerStatus: 'successful_payment',
    providerPaid: true,
    lastInquiryAt: null,
    lastInquiryErrorCode: null,
    webhookStatusHint: null,
    lastWebhookAt: null,
    webhookCount: 0,
    providerUnit: 'XTR',
    sentAmount: '200',
    conversionRateMinor: '1300',
    providerChargeId: 'stars-charge-0001',
    requestAmount: '200',
    finalAmount: null,
    creditAmount: null,
    outcome: 'SETTLED',
    lateCompletionObservedAt: null,
    createdAt: '2026-09-10T12:30:00.000Z',
  };
  const render = (invoice: Record<string, unknown>) => {
    stubApi(
      detail({
        state: 'CONFIRMED',
        method: 'GATEWAY',
        evidenceKind: 'GATEWAY_CALLBACK',
        gatewayInvoice: invoice,
      }),
    );
    return renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayViewReceipts={false}
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
  };

  it('shows the charge id an operator reconciles and refunds by', async () => {
    render(INVOICE);
    expect(await screen.findByText('stars-charge-0001')).toBeInTheDocument();
    expect(screen.getByText('شناسهٔ پرداخت درگاه')).toBeInTheDocument();
  });

  it('draws no charge row for an attempt nothing has paid', async () => {
    render({ ...INVOICE, providerChargeId: null, providerPaid: null, outcome: null });
    await screen.findByText('message:910910:42');
    expect(screen.queryByText('شناسهٔ پرداخت درگاه')).not.toBeInTheDocument();
  });
});

describe('the frozen destination on a payment detail', () => {
  it('names the account the instructions pointed at', async () => {
    stubApi(detail({ destination: DESTINATION }));
    const { container } = renderPage(
      <PaymentDetailPage
        id={ROW_ID}
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
    // The REVIEW NOTICE, which renders only once the detail has arrived and only for a
    // pending manual transfer. Waiting on the page heading instead asserts against a
    // skeleton, and this case passed with the permission gate deleted when it did.
    await screen.findByText('بررسی رسید');

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
      expect(view.container.textContent).toContain('a1b2c3d4e5f60718');
    });
    // Holding review without view draws no evidence — and, since D3, no decision either.
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
    // Who asked for it. `/admin/logs` could not answer this, which is the point. The table
    // draws the id short (X7/X9: no copy icon, no sideways scroll) with the whole id as its
    // title.
    expect(view.container.textContent).toContain(ADMIN_ID.slice(0, 8));
    expect(view.container.querySelector(`[title="${ADMIN_ID}"]`)).not.toBeNull();
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
        mayViewReceipts={false}
        mayViewRefunds
        mayIssueRefunds
        denied={false}
      />,
    );
    // The CARD's title appears before its query settles, so waiting on it proves
    // nothing. This label renders only once the ledger has arrived.
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');

    fireEvent.click(screen.getByRole('button', { name: 'ثبت بازگشت وجه' }));
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

    fireEvent.click(screen.getByRole('button', { name: 'ثبت بازگشت وجه' }));
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

  /*
   * Codex review of #81: the payment's history card sits on this same page, and a refund
   * answered here is a row in it. Without re-reading it the card kept the history from
   * before the answer until the page was reloaded — a timeline that omits what the
   * operator just did, on the page where they did it.
   */
  it('re-reads the payment history after a refund is answered', async () => {
    const api = stubApi([
      ...withRefunds([refundRow()], { consumedMinor: '100000', refundableMinor: '150000' }),
      {
        url: `/payments/${ROW_ID}/timeline`,
        // Agrees with the CONFIRMED detail, so the only second read is the refund's.
        body: {
          paymentId: ROW_ID,
          entries: [
            {
              kind: 'PAYMENT_CONFIRMED',
              at: '2026-09-10T12:45:00.000Z',
              evidenceKind: 'OPERATOR_REVIEW',
              adminId: ADMIN_ID,
            },
          ],
          withheld: [],
          truncated: false,
        },
      },
      {
        url: `/refunds/${REFUND_ID}/completion`,
        body: { refund: refundRow({ state: 'COMPLETED', completedByAdminId: ADMIN_ID }) },
      },
    ] as never);
    renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayViewReceipts={false}
        mayViewRefunds
        mayIssueRefunds
        denied={false}
      />,
    );
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');
    const timelineReads = () =>
      api.calls.filter((call) => call.method === 'GET' && call.url.includes('/timeline')).length;
    await waitFor(() => expect(timelineReads()).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: 'واریز انجام شد' }));
    fireEvent.change(screen.getByLabelText('توضیح'), { target: { value: 'واریز شد' } });
    fireEvent.click(inDialog('واریز انجام شد'));

    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes('/completion'))).toBe(true);
    });
    await waitFor(() => expect(timelineReads()).toBe(2));
  });

  /*
   * Codex review of #81: completing or abandoning a refund is as ambiguous behind a 5xx as
   * requesting one, so both re-read the ledger and the history on an error answer too.
   */
  it.each([
    ['completion', `/refunds/${REFUND_ID}/completion`, 'واریز انجام شد'],
    ['abandonment', `/refunds/${REFUND_ID}/failure`, 'منصرف شدم'],
  ])(
    're-reads the ledger and the history after a %s answered with a 5xx',
    async (_, url, button) => {
      const api = stubApi([
        ...withRefunds([refundRow()], { consumedMinor: '100000', refundableMinor: '150000' }),
        {
          url: `/payments/${ROW_ID}/timeline`,
          body: {
            paymentId: ROW_ID,
            entries: [
              {
                kind: 'PAYMENT_CONFIRMED',
                at: '2026-09-10T12:45:00.000Z',
                evidenceKind: 'OPERATOR_REVIEW',
                adminId: ADMIN_ID,
              },
            ],
            withheld: [],
            truncated: false,
          },
        },
        {
          url,
          status: 500,
          body: {
            error: { kind: 'internal', code: 'internal', message: 'lost', correlationId: 't' },
          },
        },
      ] as never);
      renderPage(
        <PaymentDetailPage
          id={ROW_ID}
          mayViewReceipts={false}
          mayViewRefunds
          mayIssueRefunds
          denied={false}
        />,
      );
      await screen.findByText('باقی‌ماندهٔ قابل بازگشت');
      const reads = (part: string) =>
        api.calls.filter((call) => call.method === 'GET' && call.url.endsWith(part)).length;
      await waitFor(() => expect(reads('/timeline')).toBe(1));
      const ledgerBefore = reads('/refunds');

      fireEvent.click(screen.getByRole('button', { name: button }));
      fireEvent.change(screen.getByLabelText('توضیح'), { target: { value: 'پاسخ گم شد' } });
      fireEvent.click(inDialog(button));

      await waitFor(() => expect(api.calls.some((call) => call.url.endsWith(url))).toBe(true));
      await waitFor(() => expect(reads('/timeline')).toBe(2));
      await waitFor(() => expect(reads('/refunds')).toBeGreaterThan(ledgerBefore));
    },
  );

  it('re-reads the ledger and the history after a completion whose response was lost', async () => {
    const api = stubApi([
      ...withRefunds([refundRow()], { consumedMinor: '100000', refundableMinor: '150000' }),
      {
        url: `/payments/${ROW_ID}/timeline`,
        // Agrees with the CONFIRMED detail, so the only second read is the error's.
        body: {
          paymentId: ROW_ID,
          entries: [
            {
              kind: 'PAYMENT_CONFIRMED',
              at: '2026-09-10T12:45:00.000Z',
              evidenceKind: 'OPERATOR_REVIEW',
              adminId: ADMIN_ID,
            },
          ],
          withheld: [],
          truncated: false,
        },
      },
    ] as never);
    // No HTTP answer at all: the network failed after the request may have landed.
    const routed = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown, init?: RequestInit) => {
        if (String(input).endsWith('/completion')) {
          api.calls.push({ url: String(input), method: 'POST', body: null });
          return Promise.reject(new TypeError('network error'));
        }
        return routed(input as RequestInfo, init);
      }),
    );
    renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayViewReceipts={false}
        mayViewRefunds
        mayIssueRefunds
        denied={false}
      />,
    );
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');
    const reads = (part: string) =>
      api.calls.filter((call) => call.method === 'GET' && call.url.endsWith(part)).length;
    await waitFor(() => expect(reads('/timeline')).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: 'واریز انجام شد' }));
    fireEvent.change(screen.getByLabelText('توضیح'), { target: { value: 'پاسخ گم شد' } });
    fireEvent.click(inDialog('واریز انجام شد'));

    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith('/completion'))).toBe(true),
    );
    await waitFor(() => expect(reads('/timeline')).toBe(2));
  });

  /*
   * Codex review of #81: a refund request answered with a 5xx may have COMMITTED — that is
   * why the retry keeps its key. The ledger beside it is re-read, and so must the history
   * be, or the refund card shows a refund the history on the same page omits.
   */
  it('re-reads the payment history after a refund request is answered with a 5xx', async () => {
    const api = stubApi([
      ...withRefunds([], {}),
      {
        url: `/payments/${ROW_ID}/timeline`,
        body: {
          paymentId: ROW_ID,
          entries: [
            {
              kind: 'PAYMENT_CONFIRMED',
              at: '2026-09-10T12:45:00.000Z',
              evidenceKind: 'OPERATOR_REVIEW',
              adminId: ADMIN_ID,
            },
          ],
          withheld: [],
          truncated: false,
        },
      },
    ] as never);
    // The request and the ledger share one URL; only the POST is answered 500.
    const routed = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown, init?: RequestInit) => {
        if (init?.method === 'POST' && String(input).endsWith(`/payments/${ROW_ID}/refunds`)) {
          api.calls.push({ url: String(input), method: 'POST', body: null });
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  kind: 'internal',
                  code: 'internal',
                  message: 'lost',
                  correlationId: 'test',
                },
              }),
              { status: 500, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return routed(input as RequestInfo, init);
      }),
    );
    renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayViewReceipts={false}
        mayViewRefunds
        mayIssueRefunds
        denied={false}
      />,
    );
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');
    const timelineReads = () =>
      api.calls.filter((call) => call.method === 'GET' && call.url.includes('/timeline')).length;
    await waitFor(() => expect(timelineReads()).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: 'ثبت بازگشت وجه' }));
    fireEvent.change(screen.getByLabelText('مبلغ (به کوچک‌ترین یکای پول)'), {
      target: { value: '1000' },
    });
    fireEvent.change(screen.getByLabelText('دلیل'), { target: { value: 'مشتری منصرف شد' } });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت درخواست' }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    await waitFor(() => expect(timelineReads()).toBe(2));
  });
});

/*
 * Codex review on PR #125: a refusal re-reads the ledger, and the answer can take a
 * refund form off the screen — `refundable: false`, or the refund being answered no
 * longer AWAITING_EXTERNAL. The typed strings stayed in state, so the leave guard kept
 * asking about edits in a form the operator could no longer see.
 */
describe('the refund leave guard', () => {
  const refusal = {
    error: { kind: 'conflict', code: 'refund.not_refundable', message: 'no', correlationId: 't' },
  };
  const ledger = (refunds: readonly unknown[], overrides: Record<string, unknown> = {}) => ({
    refunds,
    paidMinor: '250000',
    consumedMinor: '100000',
    refundableMinor: '150000',
    currency: 'IRT',
    refundable: true,
    ...overrides,
  });

  /**
   * The ledger answers `before` until the first POST, and `after` from then on; every
   * POST is refused with a 409. Everything else is the ordinary stub.
   */
  const stubStaleRefusal = (before: unknown, after: unknown) => {
    stubApi([...detail({ state: 'CONFIRMED' })] as never);
    const routed = globalThis.fetch;
    let refused = false;
    const json = (body: unknown, status = 200) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') {
          refused = true;
          return json(refusal, 409);
        }
        if (url.endsWith(`/payments/${ROW_ID}/refunds`)) return json(refused ? after : before);
        return routed(input as RequestInfo, init);
      }),
    );
  };

  const renderGuarded = () =>
    renderPage(
      <>
        <PaymentDetailPage
          id={ROW_ID}
          mayViewReceipts={false}
          mayViewRefunds
          mayIssueRefunds
          denied={false}
        />
        <LeaveGuardHost />
      </>,
    );

  it('releases the guard when a refusal re-reads the payment as not refundable', async () => {
    stubStaleRefusal(ledger([]), ledger([], { refundable: false }));
    renderGuarded();
    fireEvent.click(await screen.findByRole('button', { name: 'ثبت بازگشت وجه' }));
    fireEvent.change(screen.getByLabelText('مبلغ (به کوچک‌ترین یکای پول)'), {
      target: { value: '1000' },
    });
    fireEvent.change(screen.getByLabelText('دلیل'), { target: { value: 'مشتری منصرف شد' } });
    expect(leaveGuarded()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'ثبت درخواست' }));
    await screen.findByText(t('web.refund_unavailable'));
    expect(screen.queryByLabelText('دلیل')).toBeNull();
    expect(leaveGuarded()).toBe(false);
  });

  it('releases the guard when a refusal re-reads the answered refund as no longer awaiting', async () => {
    stubStaleRefusal(
      ledger([refundRow()]),
      // Somebody else answered it: COMPLETED, and nothing is refundable any more.
      ledger([refundRow({ state: 'COMPLETED', completedByAdminId: ADMIN_ID })], {
        consumedMinor: '250000',
        refundableMinor: '0',
      }),
    );
    renderGuarded();
    fireEvent.click((await screen.findAllByRole('button', { name: 'واریز انجام شد' }))[0]!);
    fireEvent.change(screen.getByLabelText('توضیح'), { target: { value: 'واریز شد' } });
    expect(leaveGuarded()).toBe(true);

    fireEvent.click(inDialog('واریز انجام شد'));
    await waitFor(() => expect(screen.queryByLabelText('توضیح')).toBeNull());
    expect(leaveGuarded()).toBe(false);
  });

  it('hides the answer form, and releases the guard, when only the answered refund stopped awaiting', async () => {
    // A SECOND refund is still AWAITING_EXTERNAL, so the answer section stays drawn —
    // but the one selected is gone, and a note for it has nowhere to go.
    const other = refundRow({ id: '019260ab-cdef-7012-8345-6789abcdef02' });
    stubStaleRefusal(
      ledger([refundRow(), other]),
      ledger([refundRow({ state: 'COMPLETED', completedByAdminId: ADMIN_ID }), other]),
    );
    renderGuarded();
    fireEvent.click((await screen.findAllByRole('button', { name: 'واریز انجام شد' }))[0]!);
    fireEvent.change(screen.getByLabelText('توضیح'), { target: { value: 'واریز شد' } });
    expect(leaveGuarded()).toBe(true);

    fireEvent.click(inDialog('واریز انجام شد'));
    await waitFor(() => expect(screen.queryByLabelText('توضیح')).toBeNull());
    // The other awaiting refund still carries its own answers.
    expect(screen.getAllByRole('button', { name: 'واریز انجام شد' })).toHaveLength(1);
    expect(leaveGuarded()).toBe(false);
  });

  it('keeps the guard while the answer form stays on screen after a refusal', async () => {
    // The same refusal, but the refund is still AWAITING_EXTERNAL: the form and what
    // was typed into it are both still there, so leaving would still lose it.
    stubStaleRefusal(ledger([refundRow()]), ledger([refundRow()]));
    renderGuarded();
    fireEvent.click((await screen.findAllByRole('button', { name: 'واریز انجام شد' }))[0]!);
    fireEvent.change(screen.getByLabelText('توضیح'), { target: { value: 'واریز شد' } });
    fireEvent.click(inDialog('واریز انجام شد'));
    await waitFor(() => expect(inDialog('واریز انجام شد')).toBeEnabled());
    expect(screen.getByLabelText('توضیح')).toHaveValue('واریز شد');
    expect(leaveGuarded()).toBe(true);
  });
});

/**
 * Payment File 02 §21 (D7): the diagnostics an operator reconciles against, on the list
 * and the detail — and §10 again: none of it is a control.
 */
describe('the payment diagnostics (§21)', () => {
  const diagnosed = payment({
    gatewayProvider: 'MANUAL_TRANSFER',
    externalReference: 'BANK-778899',
    customerTelegramUserId: '5550001234',
    customerUsername: 'zahra_pay',
    updatedAt: '2026-09-11T08:15:00.000Z',
  });

  it('lists the tracking code with «کپی شناسه», the Telegram id and username, the gateway, the external reference and updated-at', async () => {
    stubApi(list([diagnosed]));
    renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718');

    const table = screen.getByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent);
    // Demo parity X9: the gateway is a column; who paid, the external reference and updated-at
    // are the row's detail, one toggle away on the same row. PR-C: the payment's uuid is no
    // longer a column — the tracking code is the payment's name, the uuid is «کپی شناسه».
    expect(headers).not.toContain('شناسهٔ پرداخت');
    for (const header of ['درگاه']) {
      expect(headers, header).toContain(header);
    }
    fireEvent.click(within(table).getByRole('button', { name: t('web.payment_row_detail') }));
    const terms = within(table)
      .getAllByRole('term')
      .map((cell) => cell.textContent);
    for (const term of ['مشتری', 'شناسهٔ پیگیری بیرونی', 'آخرین تغییر']) {
      expect(terms, term).toContain(term);
    }
    expect(table.textContent).not.toContain(ROW_ID.slice(0, 8));
    expect(
      within(table)
        .getAllByRole('button', { name: 'کپی کد' })
        .some((button) => button.getAttribute('data-copy-value') === 'a1b2c3d4e5f60718'),
    ).toBe(true);
    // The uuid is not offered beside the code any more (D1).
    expect(
      within(table)
        .queryAllByRole('button')
        .some((button) => button.getAttribute('data-copy-value') === ROW_ID),
    ).toBe(false);
    /*
     * Spec §10: the customer IS the Telegram id — the link to their page — and the
     * internal uuid is not drawn. This used to be two columns, a uuid prefix headed
     * «مشتری» and the Telegram id beside it.
     */
    const who = within(table).getByText('5550001234');
    expect(who.closest('a')?.getAttribute('href')).toBe(`/users/${CUSTOMER_ID}`);
    expect(table.textContent).not.toContain(CUSTOMER_ID.slice(0, 8));
    expect(headers).not.toContain('تلگرام مشتری');
    expect(within(table).getByText('@zahra_pay')).toBeInTheDocument();
    expect(within(table).getByText('BANK-778899')).toBeInTheDocument();
    expect(within(table).getAllByText('کارت به کارت').length).toBeGreaterThan(0);
    expect(table.textContent).toContain(formatTimestamp('2026-09-11T08:15:00.000Z'));
  });

  it('shows a dash, never a guess, for a payment with no gateway, reference or username', async () => {
    stubApi(
      list([
        payment({
          method: 'WALLET',
          gatewayProvider: null,
          externalReference: null,
          customerTelegramUserId: '5550001234',
          customerUsername: null,
        }),
      ]),
    );
    renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('a1b2c3d4e5f60718');
    const table = screen.getByRole('table');
    fireEvent.click(within(table).getByRole('button', { name: t('web.payment_row_detail') }));
    expect(within(table).getByText('5550001234')).toBeInTheDocument();
    expect(table.textContent).not.toContain('@');
  });

  const renderDetail = (overrides: Record<string, unknown>) => {
    stubApi(detail({ ...diagnosed, ...overrides }));
    return renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayViewReceipts={false}
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
  };

  it('shows a receipt’s credit-to-wallet disposition read-only: amount, admin, time and note', async () => {
    const view = renderDetail({
      state: 'FAILED',
      resolvedAt: '2026-09-11T08:15:00.000Z',
      resolvedByAdminId: '019200ab-cdef-7012-8345-6789abcdef01',
      receiptCredit: {
        amountMinor: '240000',
        currency: 'IRT',
        walletEntryId: '019260ab-cdef-7012-8345-6789abcdef01',
        decidedByAdminId: '019200ab-cdef-7012-8345-6789abcdef01',
        decidedAt: '2026-09-11T08:15:00.000Z',
        note: 'ده هزار تومان کمتر رسید',
      },
    });
    await screen.findByText('واریز رسید به کیف پول');
    const card = screen.getByText('واریز رسید به کیف پول').closest('section') ?? view.container;
    expect(card.textContent).toMatch(/۲۴۰٬۰۰۰|240,000/u);
    expect(card.textContent).toContain('ده هزار تومان کمتر رسید');
    expect(card.textContent).toContain(formatTimestamp('2026-09-11T08:15:00.000Z'));
    expect(card.textContent).toContain('پرداخت سفارش حساب نمی‌شود');
    // Read-only: the only buttons on the page are copy controls with no label.
    const labels = [...view.container.querySelectorAll('button')]
      .map((b) => b.textContent?.trim())
      // The history's refresh only reads again; it is not a control over the payment.
      .filter((label) => label !== '' && label !== t('web.refresh'));
    expect(labels, 'the disposition card draws a control').toEqual([]);
  });

  it('names a credited receipt as credited on the detail, not as a bare failure (WP10 follow-up §5)', async () => {
    const view = renderDetail({
      state: 'FAILED',
      resolvedAt: '2026-09-11T08:15:00.000Z',
      resolvedByAdminId: '019200ab-cdef-7012-8345-6789abcdef01',
      receiptDisposition: 'CREDITED_TO_WALLET',
      receiptCredit: {
        amountMinor: '240000',
        currency: 'IRT',
        walletEntryId: '019260ab-cdef-7012-8345-6789abcdef01',
        decidedByAdminId: '019200ab-cdef-7012-8345-6789abcdef01',
        decidedAt: '2026-09-11T08:15:00.000Z',
        note: null,
      },
    });
    await screen.findByText('واریز رسید به کیف پول');
    expect(view.container.textContent).toContain('نتیجهٔ رسید');
    expect(screen.getAllByText('واریز به کیف پول').length).toBeGreaterThanOrEqual(1);
    expect(view.container.textContent).not.toContain('رد شد');
  });

  it('shows the gift a top-up promised, and no gift card for an order payment', async () => {
    const topup = renderDetail({ orderId: null, topupCashbackPercent: 10 });
    await screen.findByText('هدیهٔ شارژ این پرداخت');
    expect(topup.container.textContent).toContain('10%');
    topup.unmount();

    const order = renderDetail({ topupCashbackPercent: null });
    await screen.findAllByText('a1b2c3d4e5f60718');
    expect(order.container.textContent).not.toContain('هدیهٔ شارژ این پرداخت');
  });

  it('shows a gateway fee beside the principal, never inside it, and no fee card elsewhere (WP18)', async () => {
    const amounts = (bps: number | null, fee: string, payable: string) => ({
      currency: 'IRT',
      principal: '200000',
      customerFee: fee,
      customerFeeBasisPoints: bps,
      payable,
      received: payable,
      walletCredit: '0',
      walletDebit: '0',
      merchantNet: null,
      merchantNetReason: 'NOT_RECORDED',
    });
    const gateway = renderDetail({
      method: 'GATEWAY',
      amount: '200000',
      customerFee: { basisPoints: 525, fee: '10500', payable: '210500' },
      amounts: amounts(525, '10500', '210500'),
    });
    await screen.findByText('نرخ کارمزد مشتری');
    expect(gateway.container.textContent).toContain('5.25%');
    expect(gateway.container.textContent).toContain('مبلغ قابل پرداخت');
    expect(gateway.container.textContent).toContain('قابل بازگشت نیست');
    // ONE card shows the fee (review of PR #247): the rate, the fee and the payable once each.
    expect(screen.getAllByText('نرخ کارمزد مشتری')).toHaveLength(1);
    expect(screen.getAllByText(t('web.payment_customer_fee_amount'))).toHaveLength(1);
    expect(screen.getAllByText('مبلغ قابل پرداخت')).toHaveLength(1);
    gateway.unmount();

    const manual = renderDetail({ customerFee: null, amounts: amounts(null, '0', '200000') });
    await screen.findAllByText('a1b2c3d4e5f60718');
    expect(manual.container.textContent).not.toContain('نرخ کارمزد مشتری');
  });

  it('R6 item 4: a card-to-card payment with a fee shows what the customer had to transfer, a feeless one does not', async () => {
    const withFee = renderDetail({
      method: 'MANUAL_TRANSFER',
      amount: '200000',
      customerFee: { basisPoints: 1000, fee: '20000', payable: '220000' },
    });
    await screen.findByText(t('web.payment_transfer_payable'));
    expect(withFee.container.textContent).toContain('220,000');
    withFee.unmount();
    const none = renderDetail({ method: 'MANUAL_TRANSFER', customerFee: null });
    await screen.findAllByText('a1b2c3d4e5f60718');
    expect(none.container.textContent).not.toContain(t('web.payment_transfer_payable'));
  });
});

/**
 * R12 F3 item 8 at the wire: the Web Admin's card-to-card decisions are exactly three named
 * routes and three client functions, each through the existing services on the server. A fourth
 * (a dismiss, a bulk decide) cannot appear by accident without this failing.
 */
describe('the card-to-card decisions in the Web Admin (R12 F3 item 8)', () => {
  it('names exactly approve, reject and credit in the payment contract', () => {
    expect(
      Object.keys(PAYMENT_ROUTES)
        .filter((key) => /confirm|reject|credit|approve|dismiss/iu.test(key))
        .sort(),
    ).toEqual(['receiptApprove', 'receiptCredit', 'receiptReject']);
  });

  it('exports exactly the three client functions that decide a payment', () => {
    const deciding = Object.keys(client).filter((name) =>
      /^(confirm|reject|approve|dismiss|credit).*payment|payment.*(confirm|reject|credit)|receipt.*credit|credit.*receipt|^(approve|reject)Receipt$/iu.test(
        name,
      ),
    );
    expect(deciding.sort()).toEqual(['approveReceipt', 'creditReceipt', 'rejectReceipt']);
  });
});

/*
 * TonPays Telegram (`docs/tonpays-telegram-gateway-audit.md` §9.6, §10). A payment in the
 * provider's review is PENDING with a moved deadline: the page says "in review", never
 * paid and never failed. An UNKNOWN one is resolved from the RECORDED inquiry answer, and
 * the controls are drawn only for `payments.reconcile` — the server charges it either way.
 */
describe('a TonPays Telegram payment on the detail', () => {
  const INVOICE = {
    provider: 'TONPAYS_TELEGRAM',
    providerOrderId: 'NTAAAAAAAAAAAAAAAAAA',
    providerInvoiceId: 'TPT-1',
    creationState: 'CREATED',
    creationErrorCode: null,
    providerStatus: 'completed',
    providerPaid: true,
    lastInquiryAt: '2026-09-11T12:32:00.000Z',
    lastInquiryErrorCode: null,
    webhookStatusHint: null,
    lastWebhookAt: null,
    webhookCount: 0,
    providerUnit: 'IRT',
    sentAmount: '250000',
    conversionRateMinor: null,
    providerChargeId: null,
    requestAmount: '250000',
    finalAmount: '250037',
    creditAmount: null,
    outcome: null,
    lateCompletionObservedAt: null,
    createdAt: '2026-09-10T12:30:00.000Z',
    cardSeq: 2,
    cardReceivedAt: '2026-09-10T12:40:00.000Z',
    cardChangeShown: true,
    cardChangeCooldownUntil: null,
    cardChangeExhausted: true,
    latestCardChange: {
      state: 'APPLIED',
      errorCode: null,
      requestedAt: '2026-09-10T12:39:00.000Z',
      decidedAt: '2026-09-10T12:40:00.000Z',
    },
    receiptSubmissions: [
      {
        id: 'sub-1',
        state: 'ACCEPTED',
        errorCode: null,
        providerStatus: 'processing',
        receiptReceived: true,
        openedReview: true,
        createdAt: '2026-09-10T13:00:00.000Z',
        decidedAt: '2026-09-10T13:00:05.000Z',
      },
    ],
  };
  const REVIEW = {
    providerReviewStartedAt: '2026-09-10T13:00:05.000Z',
    providerReviewUntil: '2026-09-11T13:00:05.000Z',
  };
  const render = (
    overrides: Record<string, unknown>,
    mayReconcile: boolean,
    extra: { url: string; body: unknown; status?: number }[] = [],
  ) => {
    const api = stubApi([
      ...detail({ method: 'GATEWAY', gatewayInvoice: INVOICE, ...REVIEW, ...overrides }),
      ...extra,
    ]);
    renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayViewReceipts={false}
        mayViewRefunds={false}
        mayIssueRefunds={false}
        mayReconcile={mayReconcile}
        denied={false}
      />,
    );
    return api;
  };

  it('in review it says so and offers no decision, and shows the receipt lane by state', async () => {
    render({ state: 'PENDING' }, true);
    expect(await screen.findByText(t('web.payment_provider_review_banner'))).toBeInTheDocument();
    expect(screen.queryByText(t('web.payment_reconcile_title'))).not.toBeInTheDocument();
    expect(screen.getByText(t('web.payment_gateway_receipt_opened_review'))).toBeInTheDocument();
    expect(screen.getByText(t('web.payment_gateway_card_change_exhausted'))).toBeInTheDocument();
  });

  it('names the card change, the receipt state and the provider status in Persian (C1)', async () => {
    render({ state: 'PENDING' }, true);
    expect(await screen.findByText(t('web.gw_card_change_applied'))).toHaveAttribute(
      'title',
      'APPLIED',
    );
    expect(screen.getByText(t('web.gw_receipt_accepted'))).toHaveAttribute('title', 'ACCEPTED');
    expect(screen.getAllByText(t('web.pay_provider_processing'))[0]).toHaveAttribute(
      'title',
      'processing',
    );
    for (const raw of ['APPLIED', 'ACCEPTED', 'processing']) {
      expect(screen.queryByText(raw)).toBeNull();
    }
  });

  it('R9 C1: an underpaid invoice shows the next step, the remainder, its invoice and receipt flag, and the cancel request by who asked — never the payee card', async () => {
    render(
      {
        state: 'PENDING',
        gatewayInvoice: {
          ...INVOICE,
          providerStatus: 'action_required_less',
          providerPaid: false,
          providerNeed: {
            need: 'LESS',
            remainingAmount: '12000',
            remainingInvoiceId: 'TP-REM123XYZ0',
            remainingReceiptReceived: false,
            refundAmount: null,
            refundPending: null,
          },
          latestRefund: null,
          latestCancel: {
            state: 'REFUSED',
            errorCode: 'CANCEL_NOT_ALLOWED_NEED_ACTION_LESS',
            byNexa: false,
            requestedAt: '2026-09-10T13:10:00.000Z',
            decidedAt: '2026-09-10T13:10:02.000Z',
          },
          creditAmountDiffers: false,
        },
      },
      false,
    );
    expect(await screen.findByText(t('web.payment_gateway_need_less'))).toBeInTheDocument();
    expect(screen.getByText('12000 IRT')).toBeInTheDocument();
    expect(screen.getByText('TP-REM123XYZ0')).toBeInTheDocument();
    expect(
      screen.getByText(t('web.payment_gateway_remaining_receipt_missing')),
    ).toBeInTheDocument();
    expect(screen.getByText(t('web.gw_request_refused'))).toHaveAttribute('title', 'REFUSED');
    expect(
      screen.getByText(t('web.payment_gateway_cancel_by_customer'), { exact: false }),
    ).toBeInTheDocument();
    // The provider's refusal code reads in Persian (the code beside it is the technical detail).
    expect(
      screen.getByText(t('web.err_tonpays_cancel_not_allowed_less'), { exact: false }),
    ).toBeInTheDocument();
    // The remainder's payee card is the provider's: the detail does not carry it.
    expect(document.body.textContent).not.toContain('6219861012345678');
  });

  it('R9 C1: an overpaid invoice shows the surplus, the masked refund card and its request; a credit_amount that matches nothing is flagged', async () => {
    render(
      {
        state: 'PENDING',
        gatewayInvoice: {
          ...INVOICE,
          providerStatus: 'action_required_more',
          providerPaid: false,
          creditAmount: '99000',
          creditAmountDiffers: true,
          providerNeed: {
            need: 'MORE',
            remainingAmount: null,
            remainingInvoiceId: null,
            remainingReceiptReceived: null,
            refundAmount: '15000',
            refundPending: true,
          },
          latestRefund: {
            state: 'APPLIED',
            errorCode: null,
            refundCardMasked: '603799******7890',
            requestedAt: '2026-09-10T13:20:00.000Z',
            decidedAt: '2026-09-10T13:20:03.000Z',
          },
          latestCancel: null,
        },
      },
      false,
    );
    expect(await screen.findByText(t('web.payment_gateway_need_more'))).toBeInTheDocument();
    expect(screen.getByText('15000 IRT')).toBeInTheDocument();
    expect(screen.getByText(t('web.payment_gateway_refund_pending'))).toBeInTheDocument();
    expect(screen.getByText('603799******7890')).toBeInTheDocument();
    expect(screen.getByText(t('web.gw_request_applied'))).toHaveAttribute('title', 'APPLIED');
    expect(screen.getByText('99000 IRT')).toBeInTheDocument();
    expect(screen.getByText(t('web.payment_gateway_credit_amount_differs'))).toBeInTheDocument();
  });

  it('R9 C1: a credit_amount that matches is shown without a flag, and no next step is drawn when the provider named none', async () => {
    render(
      {
        state: 'PENDING',
        gatewayInvoice: { ...INVOICE, creditAmount: '250000', creditAmountDiffers: false },
      },
      false,
    );
    expect(await screen.findByText(t('web.payment_gateway_credit_amount'))).toBeInTheDocument();
    expect(screen.queryByText(t('web.payment_gateway_credit_amount_differs'))).toBeNull();
    expect(screen.queryByText(t('web.payment_gateway_next_step'))).toBeNull();
  });

  it('UNKNOWN with payments.reconcile: the recorded answer, then confirm sends the evidence-bound command', async () => {
    const api = render({ state: 'UNKNOWN', ...REVIEW }, true, [
      {
        url: `/payments/${ROW_ID}/reconcile`,
        body: {
          payment: {
            ...payment({ state: 'CONFIRMED', method: 'GATEWAY' }),
            evidenceNote: null,
            resolutionNote: null,
            destination: null,
          },
        },
      },
    ]);
    expect(await screen.findByText(t('web.payment_reconcile_title'))).toBeInTheDocument();
    // The recorded answer in words: the provider's status, and whether money arrived.
    expect(screen.getAllByTitle('completed')[0]).toHaveTextContent('تکمیل‌شده');
    expect(screen.getAllByText('پول رسیده').length).toBeGreaterThan(0);
    // W3: the decision opens a dialog with the rule and the evidence; nothing is sent yet.
    fireEvent.click(screen.getByText(t('web.payment_reconcile_confirm')));
    expect(api.calls.some((call) => call.url.endsWith(PAYMENT_ROUTES.reconcile(ROW_ID)))).toBe(
      false,
    );
    fireEvent.click(inDialog(t('web.payment_reconcile_confirm')));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith(PAYMENT_ROUTES.reconcile(ROW_ID)))).toBe(
        true,
      ),
    );
    const sent = api.calls.find((call) => call.url.endsWith(PAYMENT_ROUTES.reconcile(ROW_ID)));
    expect(sent?.method).toBe('POST');
    expect(sent?.body).toMatchObject({ to: 'CONFIRMED' });
    expect(typeof (sent?.body as { idempotencyKey?: unknown }).idempotencyKey).toBe('string');
  });

  it('UNKNOWN without payments.reconcile: names the permission and draws no control', async () => {
    render({ state: 'UNKNOWN' }, false);
    expect(await screen.findByText(t('web.payment_reconcile_denied'))).toBeInTheDocument();
    expect(screen.queryByText(t('web.payment_reconcile_confirm'))).not.toBeInTheDocument();
    expect(screen.queryByText(t('web.payment_reinquire'))).not.toBeInTheDocument();
  });

  it('the list marks a payment in the provider review', async () => {
    stubApi(list([payment({ method: 'GATEWAY', ...REVIEW })]));
    renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);
    expect(await screen.findByText(t('web.payment_provider_review_badge'))).toBeInTheDocument();
  });
});

describe('rows imported from Mirza', () => {
  const native = payment({
    id: '019240ab-cdef-7012-8345-6789abcdef0a',
    reference: '1111111111111111:manual',
  });
  const imported = payment({
    id: '019240ab-cdef-7012-8345-6789abcdef0b',
    reference: '2222222222222222:manual',
    source: 'MIRZA',
  });

  it('marks only the imported payment', async () => {
    stubApi(list([native, imported]));
    renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('2222222222222222');
    expect(rowHasBadge('2222222222222222')).toBe(true);
    expect(rowHasBadge('1111111111111111')).toBe(false);
  });

  it('has no «منبع» filter (Round 4 B2)', async () => {
    stubApi(list([native, imported]));
    renderPage(<PaymentsPage route={LIST_ROUTE} denied={false} />);
    await screen.findByText('1111111111111111');
    expect(sourceFilterAbsent()).toBe(true);
  });
});
