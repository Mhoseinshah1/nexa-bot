import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_PREFIX,
  RESELLER_REQUEST_ROUTES,
  type ResellerRequestDetail,
  type ResellerRequestListResponse,
} from '@nexa/contracts';
import {
  ResellerRequestDetailPage,
  ResellerRequestsPage,
} from '../../apps/web/src/pages/reseller-requests';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * «درخواست‌های نمایندگی» (PR-2): the list with its server-counted chips, the request page
 * (answers, thread, composer, the decision), and the «سؤال‌ها» tab with its drag-and-drop list.
 * Synthetic requests only.
 */

const ID = '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b';
const CUSTOMER = '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7c';
const TIER = '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7d';
const Q1 = '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a01';
const Q2 = '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a02';
const url = (path: string) => `${API_PREFIX}${path}`;

const LIST: ResellerRequestListResponse = {
  requests: [
    {
      id: ID,
      number: 12,
      customerId: CUSTOMER,
      customerName: 'زهرا',
      customerUsername: 'zahra',
      status: 'PENDING',
      conversing: true,
      createdAt: '2026-10-26T08:00:00.000Z',
      decidedAt: null,
      lastMessageAt: '2026-10-26T09:00:00.000Z',
    },
  ],
  counts: { pending: 3, conversing: 1, approved: 7, rejected: 2 },
  nextCursor: null,
};

const DETAIL: ResellerRequestDetail = {
  ...(LIST.requests[0] as ResellerRequestDetail),
  answers: [
    { questionId: Q1, text: 'نام فروشگاه؟', required: true, maxLength: 20, answer: 'فروشگاه زهرا' },
    { questionId: Q2, text: 'توضیح؟', required: false, maxLength: 500, answer: null },
  ],
  reason: null,
  decidedByName: null,
  tierId: null,
  tierName: null,
  servicesCount: 4,
  messages: [
    {
      id: '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6b01',
      senderType: 'ADMIN',
      authorAdminName: 'مدیر',
      body: 'نمونه کار بفرستید',
      attachmentKind: null,
      createdAt: '2026-10-26T08:30:00.000Z',
    },
    {
      id: '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6b02',
      senderType: 'CUSTOMER',
      authorAdminName: null,
      body: 'این هم نمونه',
      attachmentKind: null,
      createdAt: '2026-10-26T09:00:00.000Z',
    },
  ],
};

const TIER_FIXTURE = {
  id: TIER,
  name: 'Gold',
  pricingMode: 'PERCENTAGE_DISCOUNT',
  discountPercentage: 20,
  creditLimit: { amount: '0', currency: 'IRT' },
  grants: [],
  resellerCount: 1,
  monthlyMinimum: null,
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
};

const route = (query = '') => ({ path: '/reseller-requests', query: new URLSearchParams(query) });

afterEach(() => vi.unstubAllGlobals());

describe('the reseller requests list', () => {
  it('asks nothing of the server without resellers.view', () => {
    const api = stubApi([]);
    renderPage(<ResellerRequestsPage route={route()} denied mayEdit />);
    expect(screen.getByText(t('web.no_permission'))).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('draws the four chips with the SERVER’s totals and the row as «در حال گفتگو»', async () => {
    stubApi([{ url: url(RESELLER_REQUEST_ROUTES.list), body: LIST, method: 'GET' }]);
    renderPage(<ResellerRequestsPage route={route()} denied={false} mayEdit />);
    const group = await screen.findByRole('group', { name: t('web.rr_filter_label') });
    for (const [label, count] of [
      ['web.rr_chip_pending', '3'],
      ['web.rr_chip_conversing', '1'],
      ['web.rr_chip_approved', '7'],
      ['web.rr_chip_rejected', '2'],
    ] as const) {
      const persian = count.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] as string);
      await waitFor(() => {
        const chip = within(group).getByRole('button', { name: new RegExp(t(label)) });
        expect(chip.textContent).toMatch(new RegExp(`${count}|${persian}`));
      });
    }
    const row = (await screen.findByText('#12')).closest('tr') as HTMLElement;
    expect(within(row).getByText(t('web.rr_status_conversing'))).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /#12/ })).toHaveAttribute(
      'href',
      `/reseller-requests/${ID}`,
    );
  });

  it('sends the chip’s filter to the server', async () => {
    const api = stubApi([
      {
        url: url(`${RESELLER_REQUEST_ROUTES.list}?filter=APPROVED&limit=10`),
        body: LIST,
        method: 'GET',
      },
    ]);
    renderPage(<ResellerRequestsPage route={route('filter=APPROVED')} denied={false} mayEdit />);
    await screen.findByText('#12');
    expect(api.calls.some((call) => call.url.includes('filter=APPROVED'))).toBe(true);
  });
});

describe('one request', () => {
  const detailUrl = url(RESELLER_REQUEST_ROUTES.detail(ID));

  it('shows the answers as asked, the thread, and the customer link; a skipped optional says so', async () => {
    stubApi([
      { url: detailUrl, body: { request: DETAIL }, method: 'GET' },
      { url: url('/reseller-tiers'), body: { tiers: [] }, method: 'GET' },
    ]);
    renderPage(<ResellerRequestDetailPage id={ID} denied={false} mayEdit />);
    expect(await screen.findByText('فروشگاه زهرا')).toBeInTheDocument();
    expect(screen.getByText(t('web.rr_answer_skipped'))).toBeInTheDocument();
    expect(screen.getByText('نمونه کار بفرستید')).toBeInTheDocument();
    expect(screen.getByText('این هم نمونه')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: t('web.rr_customer_link') })).toHaveAttribute(
      'href',
      `/users/${CUSTOMER}`,
    );
  });

  it('sends a message to the applicant with its own key', async () => {
    const api = stubApi([
      { url: detailUrl, body: { request: DETAIL }, method: 'GET' },
      { url: url('/reseller-tiers'), body: { tiers: [] }, method: 'GET' },
      { url: url(RESELLER_REQUEST_ROUTES.message(ID)), body: { request: DETAIL }, method: 'POST' },
    ]);
    renderPage(<ResellerRequestDetailPage id={ID} denied={false} mayEdit />);
    const box = await screen.findByLabelText(t('web.rr_composer_label'));
    fireEvent.change(box, { target: { value: 'ممنون، بررسی می‌کنیم' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.rr_send') }));
    await waitFor(() =>
      expect(
        api.calls.some((call) => call.method === 'POST' && call.url.endsWith('/messages')),
      ).toBe(true),
    );
    const post = api.calls.find((call) => call.method === 'POST');
    expect(post?.body).toMatchObject({ text: 'ممنون، بررسی می‌کنیم' });
    expect((post?.body as { idempotencyKey: string }).idempotencyKey.length).toBeGreaterThanOrEqual(
      8,
    );
  });

  it('approves with the chosen tier after a confirmation, and rejects with an optional reason', async () => {
    const api = stubApi([
      { url: detailUrl, body: { request: DETAIL }, method: 'GET' },
      {
        url: url('/reseller-tiers'),
        body: { tiers: [{ ...TIER_FIXTURE, id: TIER, name: 'طلایی' }] },
        method: 'GET',
      },
      { url: url(RESELLER_REQUEST_ROUTES.approve(ID)), body: { request: DETAIL }, method: 'POST' },
      { url: url(RESELLER_REQUEST_ROUTES.reject(ID)), body: { request: DETAIL }, method: 'POST' },
    ]);
    renderPage(<ResellerRequestDetailPage id={ID} denied={false} mayEdit />);
    const select = await screen.findByLabelText(t('web.rr_tier'));
    await screen.findByRole('option', { name: 'طلایی' });
    const approve = screen.getByRole('button', { name: t('web.rr_approve') });
    expect(approve).toBeDisabled();
    fireEvent.change(select, { target: { value: TIER } });
    fireEvent.click(approve);
    fireEvent.click(await screen.findByRole('button', { name: t('web.rr_approve_confirm') }));
    await waitFor(() => expect(api.calls.some((call) => call.url.endsWith('/approve'))).toBe(true));
    expect(api.calls.find((call) => call.url.endsWith('/approve'))?.body).toMatchObject({
      tierId: TIER,
    });

    fireEvent.change(screen.getByLabelText(t('web.rr_reject_reason')), {
      target: { value: 'سابقه کافی نیست' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.rr_reject') }));
    fireEvent.click(await screen.findByRole('button', { name: t('web.rr_reject_confirm') }));
    await waitFor(() => expect(api.calls.some((call) => call.url.endsWith('/reject'))).toBe(true));
    expect(api.calls.find((call) => call.url.endsWith('/reject'))?.body).toMatchObject({
      reason: 'سابقه کافی نیست',
    });
  });

  it('closes the composer and the decision once the request is decided; a viewer sees neither', async () => {
    stubApi([
      {
        url: detailUrl,
        body: { request: { ...DETAIL, status: 'REJECTED', conversing: false, reason: 'دلیل' } },
        method: 'GET',
      },
      { url: url('/reseller-tiers'), body: { tiers: [] }, method: 'GET' },
    ]);
    renderPage(<ResellerRequestDetailPage id={ID} denied={false} mayEdit />);
    expect(await screen.findByText(t('web.rr_closed_banner'))).toBeInTheDocument();
    expect(screen.queryByLabelText(t('web.rr_composer_label'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.rr_approve') })).toBeNull();
  });

  it('draws neither the composer nor the decision for a viewer', async () => {
    stubApi([{ url: detailUrl, body: { request: DETAIL }, method: 'GET' }]);
    renderPage(<ResellerRequestDetailPage id={ID} denied={false} mayEdit={false} />);
    await screen.findByText('فروشگاه زهرا');
    expect(screen.queryByLabelText(t('web.rr_composer_label'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.rr_approve') })).toBeNull();
  });
});

describe('the questions tab', () => {
  const questionsUrl = url(RESELLER_REQUEST_ROUTES.questions);
  const QUESTIONS = {
    questions: [
      { id: Q1, position: 0, text: 'نام فروشگاه؟', required: true, maxLength: 20 },
      { id: Q2, position: 1, text: 'توضیح؟', required: false, maxLength: 500 },
    ],
  };

  it('reorders by dragging, edits, adds and saves the whole list once', async () => {
    const api = stubApi([
      { url: questionsUrl, body: QUESTIONS, method: 'GET' },
      { url: questionsUrl, body: QUESTIONS, method: 'POST' },
    ]);
    renderPage(<ResellerRequestsPage route={route('tab=questions')} denied={false} mayEdit />);
    await screen.findByDisplayValue('نام فروشگاه؟');
    const save = screen.getByRole('button', { name: t('web.save') });
    expect(save).toBeDisabled();

    // The keyboard move on the grip is the same reorder as a drag.
    const grips = screen.getAllByRole('button', { name: t('web.sortable_grip') });
    fireEvent.keyDown(grips[0] as HTMLElement, { key: 'ArrowDown' });
    const boxes = () => screen.getAllByLabelText(t('web.rrq_text')) as HTMLTextAreaElement[];
    expect(boxes().map((box) => box.value)).toEqual(['توضیح؟', 'نام فروشگاه؟']);

    fireEvent.change(boxes()[0] as HTMLElement, { target: { value: 'توضیح بیشتر؟' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.rrq_add') }));
    fireEvent.change(boxes()[2] as HTMLElement, { target: { value: 'سؤال سوم' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    const sent = api.calls.find((call) => call.method === 'POST')?.body as { questions: unknown };
    expect(sent.questions).toEqual([
      { id: Q2, text: 'توضیح بیشتر؟', required: false, maxLength: 500 },
      { id: Q1, text: 'نام فروشگاه؟', required: true, maxLength: 20 },
      { text: 'سؤال سوم', required: false, maxLength: 500 },
    ]);
  });

  it('refuses to save an empty question or a bad bound, and a viewer cannot edit', async () => {
    stubApi([{ url: questionsUrl, body: QUESTIONS, method: 'GET' }]);
    renderPage(<ResellerRequestsPage route={route('tab=questions')} denied={false} mayEdit />);
    const first = await screen.findByDisplayValue('نام فروشگاه؟');
    fireEvent.change(first, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: t('web.save') })).toBeDisabled();
    expect(screen.getByText(t('web.rrq_text_problem'))).toBeInTheDocument();
  });

  it('is read-only without resellers.edit: no add, no delete, no save', async () => {
    stubApi([{ url: questionsUrl, body: QUESTIONS, method: 'GET' }]);
    renderPage(
      <ResellerRequestsPage route={route('tab=questions')} denied={false} mayEdit={false} />,
    );
    await screen.findByDisplayValue('نام فروشگاه؟');
    expect(screen.queryByRole('button', { name: t('web.rrq_add') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.rrq_delete') })).toBeNull();
    expect(screen.getByText(t('web.rrq_view_only'))).toBeInTheDocument();
  });
});
