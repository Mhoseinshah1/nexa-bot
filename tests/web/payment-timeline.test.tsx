import { describe, expect, it, vi } from 'vitest';
import type { PermissionKey } from '@nexa/contracts';
import type { ReactElement } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { resolve } from '../../apps/web/src/app';
import {
  PaymentTimelineCard,
  TIMELINE_UNSETTLED_POLL_MS,
} from '../../apps/web/src/pages/payment-timeline';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * The payment history card (WP17 D2). Fixtures go through the real client and are parsed
 * by `paymentTimelineResponseSchema`, so a fixture that drifted from the wire fails here.
 *
 * What this file defends: rows are rendered in the SERVER's order (never re-sorted), a
 * withheld section is named, a truncated history says so, and the card has no control.
 */

const PAYMENT_ID = '019240ab-cdef-7012-8345-6789abcdef01';
const ADMIN_ID = '019250ab-cdef-7012-8345-6789abcdef01';

const timeline = (overrides: Record<string, unknown> = {}) => [
  {
    url: `/payments/${PAYMENT_ID}/timeline`,
    body: {
      paymentId: PAYMENT_ID,
      entries: [
        {
          kind: 'PAYMENT_CREATED',
          at: '2026-09-10T12:30:00.000Z',
          method: 'MANUAL_TRANSFER',
          amountMinor: '250000',
          currency: 'IRT',
        },
        {
          kind: 'PAYMENT_RESOLVED',
          at: '2026-09-10T13:00:00.000Z',
          state: 'FAILED',
          adminId: ADMIN_ID,
        },
        // Deliberately EARLIER than the row above: the server's order is the order.
        {
          kind: 'CUSTOMER_NOTIFIED',
          at: '2026-09-10T12:59:00.000Z',
          notificationKind: 'PAYMENT_REJECTED',
          deliveryState: 'DELIVERED',
          resolvedAt: '2026-09-10T13:00:05.000Z',
        },
      ],
      withheld: [],
      truncated: false,
      ...overrides,
    },
  },
];

const timelineCreated = {
  kind: 'PAYMENT_CREATED',
  at: '2026-09-10T12:30:00.000Z',
  method: 'MANUAL_TRANSFER',
  amountMinor: '250000',
  currency: 'IRT',
};

function rows(): string[] {
  const table = screen.getByRole('table');
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[1]?.textContent ?? '');
}

describe('payment timeline card', () => {
  it('renders the entries in the order the server gave, with no control', async () => {
    stubApi(timeline());
    const { container } = renderPage(
      <PaymentTimelineCard paymentId={PAYMENT_ID} paymentState="FAILED" />,
    );

    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(rows()).toEqual([
      t('web.payment_timeline_created'),
      t('web.payment_timeline_resolved'),
      t('web.payment_timeline_notified'),
    ]);
    expect(
      screen.getByText(t('web.payment_timeline_delivery_delivered'), { exact: false }),
    ).toBeInTheDocument();
    // The only buttons are the copy buttons beside an administrator id and the refresh,
    // which only reads again; nothing acts.
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(0);
    expect(
      buttons.every(
        (b) => b.getAttribute('aria-label') === t('web.copy') || b.textContent === t('web.refresh'),
      ),
    ).toBe(true);
    expect(screen.queryByText(t('web.payment_timeline_withheld'), { exact: false })).toBeNull();
    expect(screen.queryByText(t('web.payment_timeline_truncated'))).toBeNull();
  });

  /*
   * Codex review of #81: a receipt credited to the wallet closes the payment FAILED while
   * the money it carried IS credited, one row below. The resolution's label may say the
   * payment closed unsettled; it may not say no money was received.
   */
  it('never labels a resolution as closed without receiving money', () => {
    expect(t('web.payment_timeline_resolved')).not.toContain('دریافت وجه');
    expect(t('web.payment_timeline_resolved')).toContain('تسویه');
  });

  it('names every section it was not allowed to show', async () => {
    stubApi(timeline({ withheld: ['REFUNDS', 'WALLET'] }));
    renderPage(<PaymentTimelineCard paymentId={PAYMENT_ID} paymentState="FAILED" />);

    const banner = await screen.findByText(t('web.payment_timeline_withheld'), { exact: false });
    expect(banner.textContent).toContain(t('web.payment_timeline_withheld_refunds'));
    expect(banner.textContent).toContain(t('web.payment_timeline_withheld_wallet'));
    expect(banner.textContent).not.toContain(t('web.payment_timeline_withheld_receipts'));
  });

  it('says a truncated history is truncated', async () => {
    stubApi(timeline({ truncated: true }));
    renderPage(<PaymentTimelineCard paymentId={PAYMENT_ID} paymentState="FAILED" />);

    expect(await screen.findByText(t('web.payment_timeline_truncated'))).toBeInTheDocument();
  });
});

/**
 * The card in its page, through the real route.
 *
 * The receipts section is decided by the SERVER (`receipts.view`, withheld and named in
 * the response), so what the page must get right is to ask only once the payment itself
 * has been read, and to say which sections were withheld — receipts included — rather
 * than draw a history that looks complete.
 */
describe('payment timeline card on the payment detail', () => {
  const detailRoute = {
    url: `/payments/${PAYMENT_ID}`,
    body: {
      payment: {
        id: PAYMENT_ID,
        customerId: '019210ab-cdef-7012-8345-6789abcdef01',
        orderId: null,
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
        customerSignalledAt: null,
        expiresAt: null,
        createdAt: '2026-09-10T12:30:00.000Z',
        updatedAt: '2026-09-10T12:30:00.000Z',
        evidenceNote: null,
        resolutionNote: null,
        destination: null,
      },
    },
  };

  const open = (permissions: readonly PermissionKey[]) =>
    renderPage(
      resolve({ path: `/payments/${PAYMENT_ID}`, query: new URLSearchParams() }, permissions)
        .element as ReactElement,
    );

  const timelineCalls = (calls: readonly { url: string }[]) =>
    calls.filter((call) => call.url.includes('/timeline'));

  it('names the receipts section when a viewer without receipts.view is refused it', async () => {
    const api = stubApi([
      detailRoute,
      ...timeline({ withheld: ['RECEIPTS', 'REFUNDS', 'WALLET'] }),
    ]);
    open(['payments.view']);

    const banner = await screen.findByText(t('web.payment_timeline_withheld'), { exact: false });
    expect(banner.textContent).toContain(t('web.payment_timeline_withheld_receipts'));
    // And the page's own receipts card is neither drawn nor asked for.
    expect(api.calls.some((call) => call.url.includes('/receipts'))).toBe(false);
    expect(timelineCalls(api.calls)).toHaveLength(1);
  });

  it('asks for no history while the payment itself could not be read', async () => {
    const api = stubApi([
      {
        ...detailRoute,
        status: 500,
        body: {
          error: { kind: 'internal', code: 'test.boom', message: 'boom', correlationId: 'test' },
        },
      },
      ...timeline(),
    ]);
    const { container } = open(['payments.view', 'receipts.view']);

    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith(`/payments/${PAYMENT_ID}`))).toBe(true),
    );
    // The page has settled into its error state before the absence is asserted.
    expect(await screen.findByRole('button', { name: t('web.retry') })).toBeInTheDocument();
    expect(timelineCalls(api.calls)).toHaveLength(0);
    expect(container.textContent).not.toContain(t('web.payment_timeline'));
  });

  /*
   * Codex review of #81: the detail and the history are two requests, so a payment decided
   * between them reached one and not the other — a detail still PENDING beside a history
   * that records the decision. The side that still reads the payment open is the older
   * read, and it is read again, once.
   */
  const detailCalls = (calls: readonly { url: string }[]) =>
    calls.filter((call) => call.url.endsWith(`/payments/${PAYMENT_ID}`));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  it('reads the payment again when its history already records the decision', async () => {
    // The detail says PENDING; the history (the default fixture) says FAILED.
    const api = stubApi([detailRoute, ...timeline()]);
    open(['payments.view']);

    await waitFor(() => expect(detailCalls(api.calls)).toHaveLength(2));
    await settle();
    // Once: a stub that keeps answering PENDING is not read a third time.
    expect(detailCalls(api.calls)).toHaveLength(2);
    expect(timelineCalls(api.calls)).toHaveLength(1);
  });

  it('reads the history again when the payment was decided after it', async () => {
    const api = stubApi([
      {
        ...detailRoute,
        body: {
          payment: {
            ...detailRoute.body.payment,
            state: 'FAILED',
            resolvedAt: '2026-09-10T13:00:00.000Z',
            resolvedByAdminId: ADMIN_ID,
          },
        },
      },
      ...timeline({ entries: [timelineCreated] }),
    ]);
    open(['payments.view']);

    await waitFor(() => expect(timelineCalls(api.calls)).toHaveLength(2));
    await settle();
    expect(timelineCalls(api.calls)).toHaveLength(2);
    expect(detailCalls(api.calls)).toHaveLength(1);
  });

  /*
   * Codex review of #81: a customer's transfer signal leaves the payment PENDING, so the
   * state alone cannot see a signal that reached one read and not the other. The signal is
   * set once and frozen, so the side without it is the older one.
   */
  const timelineSignalled = { kind: 'CUSTOMER_SIGNALLED', at: '2026-09-10T12:40:00.000Z' };

  it('reads the payment again when its history already records the customer’s signal', async () => {
    const api = stubApi([
      detailRoute,
      ...timeline({ entries: [timelineCreated, timelineSignalled] }),
    ]);
    open(['payments.view']);

    await waitFor(() => expect(detailCalls(api.calls)).toHaveLength(2));
    await settle();
    expect(detailCalls(api.calls)).toHaveLength(2);
    expect(timelineCalls(api.calls)).toHaveLength(1);
  });

  it('reads the history again when the customer signalled after it was read', async () => {
    const api = stubApi([
      {
        ...detailRoute,
        body: {
          payment: { ...detailRoute.body.payment, customerSignalledAt: '2026-09-10T12:40:00.000Z' },
        },
      },
      ...timeline({ entries: [timelineCreated] }),
    ]);
    open(['payments.view']);

    await waitFor(() => expect(timelineCalls(api.calls)).toHaveLength(2));
    await settle();
    expect(timelineCalls(api.calls)).toHaveLength(2);
    expect(detailCalls(api.calls)).toHaveLength(1);
  });

  it('reads a history that still disagrees once, never in a loop', async () => {
    // Every answer is a NEW history that still records nothing decided, so each one
    // re-runs the comparison: only the once-per-disagreement rule stops the re-reads.
    let served = 0;
    const api = stubApi([
      {
        ...detailRoute,
        body: {
          payment: {
            ...detailRoute.body.payment,
            state: 'FAILED',
            resolvedAt: '2026-09-10T13:00:00.000Z',
            resolvedByAdminId: ADMIN_ID,
          },
        },
      },
      {
        url: `/payments/${PAYMENT_ID}/timeline`,
        get body() {
          served += 1;
          return {
            paymentId: PAYMENT_ID,
            entries: [{ ...timelineCreated, amountMinor: String(250000 + served) }],
            withheld: [],
            truncated: false,
          };
        },
      },
    ]);
    open(['payments.view']);

    await waitFor(() => expect(timelineCalls(api.calls)).toHaveLength(2));
    await settle();
    expect(timelineCalls(api.calls)).toHaveLength(2);
  });

  /*
   * Codex review of #81: the one re-read a disagreement earns can itself fail — a 5xx that
   * outlasts its retries — and a failed read is no answer. The detail is not polled and a
   * decided history stops polling, so without asking again the page would keep a PENDING
   * detail beside a history that records the decision until it was reloaded.
   */
  it('reads the payment again when the re-read failed, until it is answered (Codex review of #81)', async () => {
    let detailServed = 0;
    const decided = {
      payment: {
        ...detailRoute.body.payment,
        state: 'FAILED',
        resolvedAt: '2026-09-10T13:00:00.000Z',
        resolvedByAdminId: ADMIN_ID,
      },
    };
    const boom = {
      error: { kind: 'internal', code: 'test.boom', message: 'boom', correlationId: 'test' },
    };
    const api = stubApi([
      {
        url: `/payments/${PAYMENT_ID}`,
        get body() {
          detailServed += 1;
          if (detailServed === 1) return detailRoute.body;
          return detailServed === 2 ? boom : decided;
        },
        get status() {
          return detailServed === 2 ? 500 : 200;
        },
      },
      ...timeline(),
    ]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open(['payments.view']);
      await waitFor(() => expect(detailCalls(api.calls)).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(TIMELINE_UNSETTLED_POLL_MS + 1_000);
      await waitFor(() => expect(detailCalls(api.calls)).toHaveLength(3));
      // Answered now, and the two agree: nothing more is asked.
      await vi.advanceTimersByTimeAsync(TIMELINE_UNSETTLED_POLL_MS * 3);
      expect(detailCalls(api.calls)).toHaveLength(3);
      expect(timelineCalls(api.calls)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * Codex review of #81: the receipts card is read once and never polled, so a receipt the
   * customer sends after it was read reached the (polled) history and not the card — the
   * history saying «receipt submitted» above a card saying there are none.
   */
  const RECEIPT_ID = '019260ab-cdef-7012-8345-6789abcdef01';
  const receiptView = {
    id: RECEIPT_ID,
    kind: 'PHOTO',
    fileUniqueId: 'AQADreceipt',
    mimeType: 'image/jpeg',
    fileSize: 1024,
    fileName: null,
    createdAt: '2026-09-10T12:45:00.000Z',
  };
  const timelineReceipt = {
    kind: 'RECEIPT_SUBMITTED',
    at: '2026-09-10T12:45:00.000Z',
    receiptId: RECEIPT_ID,
    receiptKind: 'PHOTO',
  };
  const receiptCalls = (calls: readonly { url: string }[]) =>
    calls.filter((call) => call.url.endsWith(`/payments/${PAYMENT_ID}/receipts`));

  it('reads the receipts again when the history names one the card has not seen (Codex review of #81)', async () => {
    let receiptsServed = 0;
    const api = stubApi([
      detailRoute,
      ...timeline({ entries: [timelineCreated, timelineReceipt] }),
      {
        url: `/payments/${PAYMENT_ID}/receipts`,
        get body() {
          receiptsServed += 1;
          return { receipts: receiptsServed === 1 ? [] : [receiptView] };
        },
      },
    ]);
    open(['payments.view', 'receipts.view']);

    await waitFor(() => expect(receiptCalls(api.calls)).toHaveLength(2));
    await waitFor(() =>
      expect(screen.queryByText(t('web.payment_receipts_empty'))).not.toBeInTheDocument(),
    );
    await settle();
    expect(receiptCalls(api.calls)).toHaveLength(2);
  });

  it('reads the receipts again when the card’s older answer lands after the history (Codex review of #81)', async () => {
    let receiptsServed = 0;
    const api = stubApi([
      detailRoute,
      ...timeline({ entries: [timelineCreated, timelineReceipt] }),
      {
        url: `/payments/${PAYMENT_ID}/receipts`,
        get body() {
          receiptsServed += 1;
          return { receipts: receiptsServed === 1 ? [] : [receiptView] };
        },
      },
    ]);
    // The card asked first and is answered last: its answer is older than the history
    // already on screen, and it is that ARRIVAL the comparison must see.
    const stubbed = globalThis.fetch;
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) =>
      String(input).endsWith('/receipts') && receiptsServed === 0
        ? new Promise((resolve) => setTimeout(resolve, 40)).then(() =>
            stubbed(input as string, init),
          )
        : stubbed(input as string, init),
    );
    open(['payments.view', 'receipts.view']);

    await waitFor(() => expect(receiptCalls(api.calls)).toHaveLength(2));
    await settle();
    expect(receiptCalls(api.calls)).toHaveLength(2);
  });

  it('reads the receipts once when the card already holds every receipt the history names', async () => {
    const api = stubApi([
      detailRoute,
      ...timeline({ entries: [timelineCreated, timelineReceipt] }),
      { url: `/payments/${PAYMENT_ID}/receipts`, body: { receipts: [receiptView] } },
    ]);
    open(['payments.view', 'receipts.view']);

    await waitFor(() => expect(timelineCalls(api.calls)).toHaveLength(1));
    await waitFor(() => expect(receiptCalls(api.calls)).toHaveLength(1));
    await settle();
    expect(receiptCalls(api.calls)).toHaveLength(1);
  });

  it('reads nothing again when a truncated history cannot say', async () => {
    const api = stubApi([detailRoute, ...timeline({ truncated: true })]);
    open(['payments.view']);

    await screen.findByText(t('web.payment_timeline_truncated'));
    await settle();
    expect(detailCalls(api.calls)).toHaveLength(1);
    expect(timelineCalls(api.calls)).toHaveLength(1);
  });

  it('reads nothing again when the payment and its history agree', async () => {
    const api = stubApi([detailRoute, ...timeline({ entries: [timelineCreated] })]);
    open(['payments.view']);

    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    await settle();
    expect(detailCalls(api.calls)).toHaveLength(1);
    expect(timelineCalls(api.calls)).toHaveLength(1);
  });

  it('asks for the history again when a section permission is revoked on an open page', async () => {
    const api = stubApi([detailRoute, ...timeline({ entries: [timelineCreated] })]);
    const page = (permissions: readonly PermissionKey[]) =>
      resolve({ path: `/payments/${PAYMENT_ID}`, query: new URLSearchParams() }, permissions)
        .element as ReactElement;
    const { rerender } = renderPage(page(['payments.view', 'users.view']));
    await waitFor(() => expect(timelineCalls(api.calls)).toHaveLength(1));
    // The session poll drops `users.view`: the wallet section is now the server's to withhold.
    rerender(page(['payments.view']));
    await waitFor(() => expect(timelineCalls(api.calls)).toHaveLength(2));
  });

  it('draws no history for a viewer without payments.view', () => {
    const api = stubApi([detailRoute, ...timeline()]);
    const { container } = open(['receipts.view']);

    expect(api.calls).toHaveLength(0);
    expect(container.textContent).not.toContain(t('web.payment_timeline'));
  });
});

/**
 * Codex review of #81: a payment with no resolving administrator is not always the
 * system's doing. A CANCELLED one is the customer's own — a withdrawn transfer, or an
 * order paid another way — and saying "system" put their act on nobody.
 */
describe('who resolved a payment', () => {
  const resolved = (state: string) =>
    timeline({
      entries: [{ kind: 'PAYMENT_RESOLVED', at: '2026-09-10T13:00:00.000Z', state, adminId: null }],
    });

  it('says a cancelled payment was the customer’s, never the system’s', async () => {
    stubApi(resolved('CANCELLED'));
    const { container } = renderPage(
      <PaymentTimelineCard paymentId={PAYMENT_ID} paymentState="CANCELLED" />,
    );
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(container.textContent).toContain(t('web.payment_timeline_by_customer'));
    expect(container.textContent).not.toContain(t('web.payment_timeline_by_system'));
  });

  const confirmed = (evidenceKind: string) =>
    timeline({
      entries: [
        timelineCreated,
        { kind: 'PAYMENT_CONFIRMED', at: '2026-09-10T13:00:00.000Z', evidenceKind, adminId: null },
      ],
    });

  it('says a wallet purchase was confirmed by the customer, never the system', async () => {
    stubApi(confirmed('WALLET_DEBIT'));
    const { container } = renderPage(
      <PaymentTimelineCard paymentId={PAYMENT_ID} paymentState="CONFIRMED" />,
    );
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(container.textContent).toContain(t('web.payment_timeline_by_customer'));
    expect(container.textContent).not.toContain(t('web.payment_timeline_by_system'));
  });

  it('still says the system confirmed a gateway payment no administrator touched', async () => {
    stubApi(confirmed('GATEWAY_CALLBACK'));
    const { container } = renderPage(
      <PaymentTimelineCard paymentId={PAYMENT_ID} paymentState="CONFIRMED" />,
    );
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(container.textContent).toContain(t('web.payment_timeline_by_system'));
    expect(container.textContent).not.toContain(t('web.payment_timeline_by_customer'));
  });

  it('still says the system expired a payment nobody resolved', async () => {
    stubApi(resolved('EXPIRED'));
    const { container } = renderPage(
      <PaymentTimelineCard paymentId={PAYMENT_ID} paymentState="EXPIRED" />,
    );
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(container.textContent).toContain(t('web.payment_timeline_by_system'));
    expect(container.textContent).not.toContain(t('web.payment_timeline_by_customer'));
  });
});

/**
 * Codex review of #81: two ways the history went on showing an old answer while the page
 * stayed open — a delivery the notification lane was still deciding, and a section the
 * viewer had since lost the permission to see.
 */
describe('the history does not keep an answer that has moved', () => {
  /** A DECIDED payment carrying one notice, so only the notice can make it poll. */
  const notice = (deliveryState: string) =>
    timeline({
      entries: [
        timelineCreated,
        {
          kind: 'PAYMENT_RESOLVED',
          at: '2026-09-10T12:58:00.000Z',
          state: 'FAILED',
          adminId: ADMIN_ID,
        },
        {
          kind: 'CUSTOMER_NOTIFIED',
          at: '2026-09-10T12:59:00.000Z',
          notificationKind: 'PAYMENT_REJECTED',
          deliveryState,
          resolvedAt: deliveryState === 'PENDING' ? null : '2026-09-10T13:00:05.000Z',
        },
      ],
    });
  const timelineReads = (calls: readonly { url: string }[]) =>
    calls.filter((call) => call.url.includes('/timeline')).length;

  it('reads the history again while a notice it shows is still pending', async () => {
    const api = stubApi(notice('PENDING'));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPage(<PaymentTimelineCard paymentId={PAYMENT_ID} paymentState="FAILED" />);
      await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
      expect(timelineReads(api.calls)).toBe(1);
      await vi.advanceTimersByTimeAsync(TIMELINE_UNSETTLED_POLL_MS + 1_000);
      await waitFor(() => expect(timelineReads(api.calls)).toBeGreaterThanOrEqual(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll a decided payment whose notices are all resolved', async () => {
    const api = stubApi(notice('DELIVERED'));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPage(<PaymentTimelineCard paymentId={PAYMENT_ID} paymentState="FAILED" />);
      await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
      await vi.advanceTimersByTimeAsync(TIMELINE_UNSETTLED_POLL_MS * 3);
      expect(timelineReads(api.calls)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * Codex review of #81: a pending payment with no notice yet gains its decision from a
   * worker or another operator, and nothing on this page would ask for it.
   */
  /*
   * Codex review of #81: a decided payment can still gain facts nothing on this page
   * produces — an automatic refund of an undeliverable order and its notice. Polling every
   * decided payment would be heavy polling, so the card offers an explicit refresh instead.
   */
  it('reads a decided payment’s history again when asked, without polling it', async () => {
    const api = stubApi(timeline());
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPage(<PaymentTimelineCard paymentId={PAYMENT_ID} paymentState="FAILED" />);
      await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
      await vi.advanceTimersByTimeAsync(TIMELINE_UNSETTLED_POLL_MS * 3);
      expect(timelineReads(api.calls), 'a decided history is not polled').toBe(1);
      fireEvent.click(screen.getByRole('button', { name: t('web.refresh') }));
      await waitFor(() => expect(timelineReads(api.calls)).toBe(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the history of a payment still open again, to see its decision arrive', async () => {
    const api = stubApi(timeline({ entries: [timelineCreated] }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPage(<PaymentTimelineCard paymentId={PAYMENT_ID} paymentState="PENDING" />);
      await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
      expect(timelineReads(api.calls)).toBe(1);
      await vi.advanceTimersByTimeAsync(TIMELINE_UNSETTLED_POLL_MS + 1_000);
      await waitFor(() => expect(timelineReads(api.calls)).toBeGreaterThanOrEqual(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks the server again when the viewer's section permissions change", async () => {
    const api = stubApi(timeline({ entries: [timelineCreated] }));
    const { rerender } = renderPage(
      <PaymentTimelineCard
        paymentId={PAYMENT_ID}
        paymentState="PENDING"
        sections="receipts,refunds,wallet"
      />,
    );
    await waitFor(() => expect(timelineReads(api.calls)).toBe(1));
    // `users.view` is revoked while the page stays open.
    rerender(
      <PaymentTimelineCard
        paymentId={PAYMENT_ID}
        paymentState="PENDING"
        sections="receipts,refunds,"
      />,
    );
    await waitFor(() => expect(timelineReads(api.calls)).toBe(2));
  });
});
