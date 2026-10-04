import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SERVICE_OPERATOR_ACTIONS } from '@nexa/contracts';
import { ServiceDetailPage } from '../../apps/web/src/pages/services';
import {
  deleteRefundAmountOf,
  deleteRefundOutcome,
} from '../../apps/web/src/pages/service-delete-modal';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Item 11 — «حذف سرویس» offers «فقط حذف سرویس» or «حذف سرویس و بازگشت وجه». Fixtures go
 * through the real client and are parsed by the contract's schemas.
 *
 * What this file defends: the modal's two options; the refund amount validated against the
 * server's bound before anything can be sent; a summary naming service, customer, amount and
 * destination wallet; nothing sent until the explicit final confirmation is ticked; one
 * stable idempotency key across a double click; and a result that says "pending" — never
 * "done" — while the deletion has not been confirmed, and "blocked" while it is UNKNOWN.
 */

const SERVICE_ID = '019250ab-cdef-7012-8345-6789abcdef01';
const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef01';
const REFUND_ID = '019290ab-cdef-7012-8345-6789abcdef01';

const actions = SERVICE_OPERATOR_ACTIONS.map((action) =>
  action === 'TERMINATE'
    ? { action, available: true, blocker: null }
    : { action, available: false, blocker: 'STATE' as const },
);

const detailRoutes = [
  {
    url: `/services/${SERVICE_ID}/operations`,
    body: { operations: [], limit: 50, hasMore: false },
  },
  {
    url: `/services/${SERVICE_ID}`,
    method: 'GET',
    body: {
      service: {
        id: SERVICE_ID,
        customerId: CUSTOMER_ID,
        orderId: '019230ab-cdef-7012-8345-6789abcdef01',
        panelId: '019220ab-cdef-7012-8345-6789abcdef01',
        productId: null,
        state: 'ACTIVE',
        providerUsername: 'nx-7f3a91',
        providerUserId: '4821',
        hasSubscription: true,
        isTrial: false,
        expiresAt: '2026-12-01T00:00:00.000Z',
        trafficLimitBytes: '53687091200',
        trafficUsedBytes: '1073741824',
        deviceLimit: null,
        usageSyncedAt: null,
        deliveryState: 'DELIVERED',
        deliveredAt: null,
        provisionedAt: null,
        terminatedAt: null,
        createdAt: '2026-09-10T12:30:00.000Z',
        updatedAt: '2026-09-10T12:35:00.000Z',
        deliveryAttempts: 1,
        deliveryNextAttemptAt: null,
        actions,
      },
    },
  },
  { url: `/services/${SERVICE_ID}/refund-requests`, body: { requests: [], nextCursor: null } },
];

const quote = (over: Record<string, unknown> = {}) => ({
  url: `/services/${SERVICE_ID}/delete-with-refund`,
  method: 'GET',
  body: {
    serviceId: SERVICE_ID,
    serviceUsername: 'nx-7f3a91',
    customerId: CUSTOMER_ID,
    customerTelegramUserId: '910911',
    customerUsername: 'mary',
    customerDisplayName: 'مریم',
    eligible: true,
    reason: null,
    principalMinor: '250000',
    remainingMinor: '200000',
    currency: 'IRT',
    paymentId: '019270ab-cdef-7012-8345-6789abcdef01',
    ...over,
  },
});

const executed = (over: Record<string, unknown> = {}) => ({
  url: `/services/${SERVICE_ID}/delete-with-refund`,
  method: 'POST',
  body: {
    request: {
      id: '019250ab-cdef-7012-8345-6789abcdef09',
      serviceId: SERVICE_ID,
      serviceUsername: 'nx-7f3a91',
      customerId: CUSTOMER_ID,
      customerTelegramUserId: '910911',
      customerUsername: 'mary',
      paymentId: '019270ab-cdef-7012-8345-6789abcdef01',
      orderId: '019230ab-cdef-7012-8345-6789abcdef01',
      state: 'EXECUTING',
      origin: 'OPERATOR',
      reason: null,
      principalMinor: '250000',
      remainingMinor: '50000',
      currency: 'IRT',
      approvedAmountMinor: '150000',
      refundId: REFUND_ID,
      operationId: '019250cd-cdef-7012-8345-6789abcdef01',
      operationState: 'PLANNED',
      decidedByAdminId: '019200ab-cdef-7012-8345-6789abcdef01',
      decidedAt: '2026-10-04T10:00:00.000Z',
      rejectionReason: null,
      failureKind: null,
      createdAt: '2026-10-04T10:00:00.000Z',
      updatedAt: '2026-10-04T10:00:00.000Z',
      resolvedAt: null,
      ...over,
    },
  },
});

async function openModal(mayRefund = true) {
  renderPage(
    <ServiceDetailPage
      id={SERVICE_ID}
      denied={false}
      mayEdit
      mayTerminate
      mayDecideRefundRequests={mayRefund}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'حذف سرویس…' }));
  return screen.findByRole('dialog');
}

describe('the delete modal', () => {
  it('offers the two options, delete-only first, and refuses the refund to a session without both keys', async () => {
    stubApi([...detailRoutes, quote()]);
    const dialog = await openModal(false);
    const only = within(dialog).getByRole('radio', { name: /فقط حذف سرویس/ });
    const refund = within(dialog).getByRole('radio', { name: /حذف سرویس و بازگشت وجه/ });
    expect(only).toBeChecked();
    expect(refund).toBeDisabled();
    expect(within(dialog).getByText(t('web.service_delete_refund_denied'))).toBeInTheDocument();
  });

  it('validates the amount against the server’s bound, then summarises before the final confirmation', async () => {
    const api = stubApi([...detailRoutes, quote(), executed()]);
    const dialog = await openModal();
    fireEvent.click(within(dialog).getByRole('radio', { name: /حذف سرویس و بازگشت وجه/ }));
    const amount = await within(dialog).findByLabelText(/مبلغ بازگشت \(تومان\)/);
    const next = within(dialog).getByRole('button', { name: 'ادامه' });
    expect(next).toBeDisabled();

    fireEvent.change(amount, { target: { value: '0' } });
    expect(within(dialog).getByText(t('web.service_delete_amount_invalid'))).toBeInTheDocument();
    expect(next).toBeDisabled();
    fireEvent.change(amount, { target: { value: '12.5' } });
    expect(next).toBeDisabled();
    fireEvent.change(amount, { target: { value: '200001' } });
    expect(within(dialog).getByText(t('web.service_delete_amount_too_large'))).toBeInTheDocument();
    expect(next).toBeDisabled();
    fireEvent.change(amount, { target: { value: '150000' } });
    expect(next).toBeEnabled();
    fireEvent.click(next);

    // The summary: service, customer, amount, destination wallet.
    expect(await within(dialog).findByText(t('web.service_delete_summary'))).toBeInTheDocument();
    expect(within(dialog).getByText('nx-7f3a91')).toBeInTheDocument();
    expect(within(dialog).getByText(/مریم · @mary · 910911/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(t('web.service_delete_destination_wallet')),
    ).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: 'حذف و بازگشت وجه' });
    expect(submit, 'nothing is sent before the explicit confirmation').toBeDisabled();
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);

    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(submit);
    fireEvent.click(submit);
    await within(dialog).findByText(t('web.service_delete_result_pending'));
    const posts = api.calls.filter((call) => call.method === 'POST');
    expect(posts.length).toBeGreaterThanOrEqual(1);
    for (const post of posts) {
      expect(post.url).toContain(`/services/${SERVICE_ID}/delete-with-refund`);
      expect(post.body).toMatchObject({ amountMinor: '150000', confirm: true });
    }
    expect(
      new Set(posts.map((post) => (post.body as { idempotencyKey: string }).idempotencyKey)).size,
    ).toBe(1);
    expect(within(dialog).getByText(REFUND_ID)).toBeInTheDocument();
  });

  it('re-reads the quote and the requests after an ALREADY_REQUESTED refusal and shows the standing request', async () => {
    const api = stubApi([...detailRoutes, quote()]);
    const inner = globalThis.fetch;
    let refused = false;
    const quoteReads: string[] = [];
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/delete-with-refund') && method === 'POST') {
        refused = true;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                kind: 'conflict',
                code: 'commerce.service_refund_not_eligible',
                message: 'This service cannot carry a refund request now.',
                correlationId: 'test',
                details: { reason: 'ALREADY_REQUESTED' },
              },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (url.includes('/delete-with-refund')) {
        quoteReads.push(refused ? 'after' : 'before');
        if (refused) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                ...quote().body,
                eligible: false,
                reason: 'ALREADY_REQUESTED',
                principalMinor: null,
                remainingMinor: null,
                currency: null,
                paymentId: null,
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
      }
      return (inner as (i: unknown, n?: RequestInit) => Promise<Response>)(input, init);
    });
    const dialog = await openModal();
    fireEvent.click(within(dialog).getByRole('radio', { name: /حذف سرویس و بازگشت وجه/ }));
    fireEvent.change(await within(dialog).findByLabelText(/مبلغ بازگشت/), {
      target: { value: '1000' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'ادامه' }));
    fireEvent.click(await within(dialog).findByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'حذف و بازگشت وجه' }));

    // Back at the options, with the quote read again and its reason shown — not a bare error.
    expect(
      await within(dialog).findByText(
        new RegExp(t('web.service_delete_reason_already_requested').slice(0, 25)),
      ),
    ).toBeInTheDocument();
    expect(quoteReads).toContain('after');
    expect(within(dialog).queryByRole('button', { name: 'حذف و بازگشت وجه' })).toBeNull();
    // The page's own reads were refreshed too.
    await waitFor(() =>
      expect(
        api.calls.filter(
          (call) => call.method === 'GET' && call.url.endsWith(`/services/${SERVICE_ID}`),
        ).length,
      ).toBeGreaterThan(1),
    );
  });

  it('says why a refund cannot be offered, and still allows delete-only', async () => {
    stubApi([
      ...detailRoutes,
      quote({
        eligible: false,
        reason: 'NO_PAID_SOURCE',
        principalMinor: null,
        remainingMinor: null,
        currency: null,
        paymentId: null,
      }),
    ]);
    const dialog = await openModal();
    fireEvent.click(within(dialog).getByRole('radio', { name: /حذف سرویس و بازگشت وجه/ }));
    expect(
      await within(dialog).findByText(
        new RegExp(t('web.service_delete_reason_no_paid_source').slice(0, 20)),
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'ادامه' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('radio', { name: /فقط حذف سرویس/ }));
    expect(within(dialog).getByRole('button', { name: 'پایان بده' })).toBeDisabled();
  });

  it('sends delete-only to the plain terminate, with no amount and no refund route', async () => {
    const api = stubApi([
      ...detailRoutes,
      quote(),
      {
        url: `/services/${SERVICE_ID}/terminate`,
        method: 'POST',
        body: {
          service: { ...(detailRoutes[1]?.body as { service: object }).service },
          operation: {
            id: '019250cd-cdef-7012-8345-6789abcdef02',
            type: 'TERMINATE',
            state: 'PLANNED',
            attempts: 0,
            failureMessage: null,
            scheduledAt: null,
            startedAt: null,
            completedAt: null,
            createdAt: '2026-10-04T10:00:00.000Z',
          },
        },
      },
    ]);
    const dialog = await openModal();
    const input = dialog.querySelector('input[dir="ltr"]');
    if (input === null) throw new Error('no phrase input');
    fireEvent.change(input, { target: { value: 'TERMINATE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'پایان بده' }));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    const posts = api.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toContain('/terminate');
    expect(posts[0]?.url).not.toContain('delete-with-refund');
  });
});

describe('the result the operator is shown', () => {
  const view = (over: Record<string, unknown>) =>
    executed(over).body.request as Parameters<typeof deleteRefundOutcome>[0];

  it('never says done before the deletion is confirmed, and says blocked while it is unknown', () => {
    expect(deleteRefundOutcome(view({})).message).toBe('web.service_delete_result_pending');
    expect(deleteRefundOutcome(view({ operationState: 'IN_FLIGHT' })).message).toBe(
      'web.service_delete_result_pending',
    );
    expect(deleteRefundOutcome(view({ operationState: 'UNKNOWN' }))).toEqual({
      tone: 'warn',
      message: 'web.service_delete_result_blocked',
    });
    expect(deleteRefundOutcome(view({ state: 'FAILED', operationState: 'FAILED' })).message).toBe(
      'web.service_delete_result_failed',
    );
    expect(
      deleteRefundOutcome(view({ state: 'COMPLETED', operationState: 'SUCCEEDED' })).message,
    ).toBe('web.service_delete_result_completed');
  });

  it('accepts only whole positive amounts within the bound', () => {
    expect(deleteRefundAmountOf('150000', '200000')).toEqual({ ok: true, minor: '150000' });
    expect(deleteRefundAmountOf(' 0200000 ', '200000')).toEqual({ ok: true, minor: '200000' });
    expect(deleteRefundAmountOf('۱۵۰۰۰۰', '200000'), 'Persian digits').toEqual({
      ok: true,
      minor: '150000',
    });
    for (const bad of ['', '0', '۰', '-1', '1.5', '1e5', '1,000', 'abc']) {
      expect(deleteRefundAmountOf(bad, '200000').ok, bad).toBe(false);
    }
    expect(deleteRefundAmountOf('200001', '200000')).toEqual({
      ok: false,
      error: 'web.service_delete_amount_too_large',
    });
  });
});
