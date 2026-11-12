import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_PREFIX,
  CONTROL_ROUTES,
  HOSTING_ROUTES,
  RESELLER_BOT_ADMIN_ROUTES,
  type HostingStatusResponse,
  type ResellerBotRequestAdminView,
} from '@nexa/contracts';
import { HostingPage } from '../../apps/web/src/pages/hosting';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Reseller-phase PR-6: «میزبانی‌ها» → «درخواست‌های نماینده‌ها». The tab lists the requests with
 * the token only masked, approval asks for a fresh code, rejection needs a 3–500 character
 * reason, and the requests read back from the stubbed `fetch` are what would be sent.
 */

afterEach(() => vi.unstubAllGlobals());

const url = (path: string) => `${API_PREFIX}${path}`;
const REQUEST_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292d1';

const STATUS: HostingStatusResponse = {
  factor: 'ACTIVE',
  recoveryCodesRemaining: 9,
  session: { expiresAt: '2026-11-05T20:00:00.000Z' },
  lockedUntil: null,
  create: { enabled: true, refusal: null },
};

function request(
  overrides: Partial<ResellerBotRequestAdminView> = {},
): ResellerBotRequestAdminView {
  return {
    id: REQUEST_ID,
    number: '7',
    state: 'PENDING',
    botUsername: 'reseller_one_bot',
    tokenMasked: 'ab12…cd34',
    domain: 'bots.reseller-one.com',
    fee: { amountMinor: '500000', currency: 'IRT' },
    createdAt: '2026-11-01T08:00:00.000Z',
    decidedAt: null,
    rejectReason: null,
    cancelledAt: null,
    hostedBot: { linked: false, state: null },
    billing: { state: 'NONE', paidThrough: null, stopsAt: null },
    timeline: [],
    customer: { id: 'c1', displayName: 'علی', telegramUserId: '9001' },
    hostedTenantId: null,
    ...overrides,
  } as ResellerBotRequestAdminView;
}

function routes(requests: ResellerBotRequestAdminView[]) {
  return [
    { url: url(HOSTING_ROUTES.status), body: STATUS },
    { url: url(HOSTING_ROUTES.bots), method: 'GET', body: { bots: [], create: STATUS.create } },
    { url: url(HOSTING_ROUTES.server), body: { measuredAt: '2026-11-05T10:00:00.000Z' } },
    {
      url: url(RESELLER_BOT_ADMIN_ROUTES.list),
      method: 'GET',
      body: {
        requests,
        settings: { fee: { amountMinor: '500000', currency: 'IRT' }, graceDays: 3 },
      },
    },
    { url: url(CONTROL_ROUTES.settings), method: 'GET', body: { settings: [] } },
    {
      url: url(RESELLER_BOT_ADMIN_ROUTES.approve.replace(':requestId', REQUEST_ID)),
      method: 'POST',
      body: { request: request({ state: 'APPROVED' }), replayed: false },
    },
    {
      url: url(RESELLER_BOT_ADMIN_ROUTES.reject.replace(':requestId', REQUEST_ID)),
      method: 'POST',
      body: { request: request({ state: 'REJECTED' }), replayed: false },
    },
  ];
}

async function openTab() {
  renderPage(<HostingPage denied={false} />);
  fireEvent.click(await screen.findByRole('tab', { name: t('web.hosting_tab_reseller_requests') }));
}

describe('«درخواست‌های نماینده‌ها»', () => {
  it('lists a pending request with the token masked and both decisions', async () => {
    stubApi(routes([request()]));
    await openTab();
    expect(await screen.findByText('ab12…cd34')).toBeInTheDocument();
    expect(screen.getByText(t('web.rbot_state_pending'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.rbot_approve') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.rbot_reject') })).toBeInTheDocument();
  });

  it('approves with a fresh code', async () => {
    const api = stubApi(routes([request()]));
    await openTab();
    fireEvent.click(await screen.findByRole('button', { name: t('web.rbot_approve') }));
    fireEvent.change(screen.getByLabelText(t('web.hosting_code_label')), {
      target: { value: '123456' },
    });
    const confirm = screen.getAllByRole('button', { name: t('web.rbot_approve') }).at(-1);
    fireEvent.click(confirm as HTMLElement);
    await waitFor(() =>
      expect(
        api.calls.some((call) => call.method === 'POST' && call.url.endsWith('/approve')),
      ).toBe(true),
    );
    const sent = api.calls.find((call) => call.url.endsWith('/approve'));
    expect(sent?.body).toMatchObject({ proof: { code: '123456' } });
  });

  it('rejects only with a 3–500 character reason', async () => {
    const api = stubApi(routes([request()]));
    await openTab();
    fireEvent.click(await screen.findByRole('button', { name: t('web.rbot_reject') }));
    const field = screen.getByLabelText(t('web.rbot_reject_reason'), { exact: false });
    fireEvent.change(field, { target: { value: 'نه' } });
    const confirm = () => screen.getAllByRole('button', { name: t('web.rbot_reject') }).at(-1);
    expect(confirm()).toBeDisabled();
    fireEvent.change(field, { target: { value: 'دامنه مناسب نیست' } });
    expect(confirm()).not.toBeDisabled();
    fireEvent.click(confirm() as HTMLElement);
    await waitFor(() => expect(api.calls.some((call) => call.url.endsWith('/reject'))).toBe(true));
    expect(api.calls.find((call) => call.url.endsWith('/reject'))?.body).toMatchObject({
      reason: 'دامنه مناسب نیست',
    });
  });

  it('offers to create the hosted bot once approved, and to hand over the token once linked', async () => {
    stubApi(
      routes([
        request({ state: 'APPROVED' }),
        request({
          id: '01a05e35-c9ad-7e93-bef3-1ed9b55292d2',
          number: '8',
          state: 'APPROVED',
          hostedTenantId: '01a05e35-c9ad-7e93-bef3-1ed9b55292d3',
          hostedBot: { linked: true, state: 'ACTIVE' },
        }),
      ]),
    );
    await openTab();
    expect(
      await screen.findByRole('button', { name: t('web.rbot_create_bot') }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.rbot_configure') })).toBeInTheDocument();
  });
});
