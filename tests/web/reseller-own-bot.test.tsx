import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { PanelShell } from '../../apps/web/src/reseller/shell';
import { requestSteps } from '../../apps/web/src/reseller/pages/own-bot';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';
import { irt, problem, signedIn } from './reseller-fixtures';

/**
 * «ربات اختصاصی» (PR-6) on the reseller panel: every state the screen has — not offered, the
 * request form, a pending request with its steps and cancel, a running subscription, one stopped
 * for its fee with «پرداخت و فعال‌سازی دوباره», and the earlier, closed requests. The real API
 * client and contract schemas run; only `fetch` is stubbed.
 */
const API = '/api/reseller/v1';
const TOKEN = '7200000001:AAH-the-whole-secret-token-value-xyz';

function visit(path: string) {
  act(() => {
    window.history.replaceState(null, '', path);
    window.dispatchEvent(new Event('popstate'));
  });
}

beforeEach(() => visit('/r/bot'));
afterEach(() => {
  vi.unstubAllGlobals();
  visit('/');
});

const offer = (overrides: Record<string, unknown> = {}) => ({
  offered: true,
  fee: irt('500000'),
  graceDays: 3,
  canRequest: true,
  ...overrides,
});

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: '0190a0b0-0000-7000-8000-0000000000aa',
    number: 'RB-00012',
    state: 'PENDING',
    botUsername: 'arian_shop_bot',
    tokenMasked: '7200000001:AAH…xyz',
    domain: null,
    fee: irt('500000'),
    createdAt: '2026-11-10T09:00:00.000Z',
    decidedAt: null,
    rejectReason: null,
    cancelledAt: null,
    hostedBot: { linked: false, state: null },
    billing: { state: 'NONE', paidThrough: null, stopsAt: null },
    timeline: [{ event: 'SUBMITTED', at: '2026-11-10T09:00:00.000Z', amount: null, period: null }],
    ...overrides,
  };
}

const approved = (billing: Record<string, unknown>) =>
  request({
    state: 'APPROVED',
    decidedAt: '2026-11-10T10:00:00.000Z',
    hostedBot: { linked: true, state: billing['state'] === 'STOPPED' ? 'EXPIRED' : 'ACTIVE' },
    billing,
    timeline: [
      { event: 'SUBMITTED', at: '2026-11-10T09:00:00.000Z', amount: null, period: null },
      { event: 'APPROVED', at: '2026-11-10T10:00:00.000Z', amount: null, period: null },
      { event: 'CHARGED', at: '2026-11-10T10:00:00.000Z', amount: irt('500000'), period: 1 },
      { event: 'BOT_CREATED', at: '2026-11-10T11:00:00.000Z', amount: null, period: null },
      { event: 'LINK_SENT', at: '2026-11-10T11:05:00.000Z', amount: null, period: null },
    ],
  });

describe('«ربات اختصاصی»', () => {
  it('says «فعلاً ارائه نمی‌شود» and shows no form while the fee is unset', async () => {
    stubApi(
      signedIn([
        {
          url: `${API}/own-bot`,
          body: { offer: offer({ offered: false, fee: null, canRequest: false }), requests: [] },
        },
      ]),
    );
    renderPage(<PanelShell />);
    expect(await screen.findByText(t('web.rp_bot_not_offered_title'))).toBeInTheDocument();
    expect(screen.queryByLabelText(t('web.rp_bot_token_label'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.rp_bot_submit') })).toBeNull();
    // The feature list is still there; nothing else is invented.
    expect(screen.getByText(t('web.rp_bot_feature_panel'))).toBeInTheDocument();
  });

  it('shows the fee and the form; filing sends the token once, then shows it only masked', async () => {
    let filed = false;
    const routes = signedIn([
      {
        url: `${API}/own-bot`,
        method: 'GET',
        get body() {
          return filed
            ? { offer: offer({ canRequest: false }), requests: [request()] }
            : { offer: offer(), requests: [] };
        },
      },
      {
        url: `${API}/own-bot/requests`,
        method: 'POST',
        get body() {
          filed = true;
          return request();
        },
      },
    ]);
    const api = stubApi(routes);
    renderPage(<PanelShell />);
    const token = await screen.findByLabelText(t('web.rp_bot_token_label'));
    expect(screen.getByText('500,000 تومان')).toBeInTheDocument();
    expect(screen.getByText(t('web.rp_bot_grace_value').replace('{n}', '3'))).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: t('web.rp_bot_submit') });
    expect(submit).toBeDisabled();
    fireEvent.change(token, { target: { value: TOKEN } });
    fireEvent.change(screen.getByLabelText(t('web.rp_bot_domain_label')), {
      target: { value: ' shop.example.com ' },
    });
    fireEvent.click(submit);
    await screen.findByText(t('web.rp_bot_request_title').replace('{number}', 'RB-00012'));
    const posts = api.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ botToken: TOKEN, domain: 'shop.example.com' });
    // After the save: the masked form only, and no form left to hold the token.
    expect(screen.getByText('7200000001:AAH…xyz')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(screen.queryByLabelText(t('web.rp_bot_token_label'))).toBeNull();
  });

  it('shows a refusal in Persian and keeps the form', async () => {
    stubApi(
      signedIn([
        { url: `${API}/own-bot`, method: 'GET', body: { offer: offer(), requests: [] } },
        {
          ...problem(`${API}/own-bot/requests`, 409, 'reseller_bot.token_rejected'),
          method: 'POST',
        },
      ]),
    );
    renderPage(<PanelShell />);
    fireEvent.change(await screen.findByLabelText(t('web.rp_bot_token_label')), {
      target: { value: TOKEN },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_bot_submit') }));
    expect(await screen.findByText(t('web.err_reseller_bot_token_rejected'))).toBeInTheDocument();
    expect(screen.getByLabelText(t('web.rp_bot_token_label'))).toBeInTheDocument();
  });

  it('a pending request shows its steps and can be cancelled', async () => {
    let cancelled = false;
    const api = stubApi(
      signedIn([
        {
          url: `${API}/own-bot`,
          method: 'GET',
          get body() {
            return cancelled
              ? {
                  offer: offer(),
                  requests: [
                    request({ state: 'CANCELLED', cancelledAt: '2026-11-10T09:30:00.000Z' }),
                  ],
                }
              : { offer: offer({ canRequest: false }), requests: [request()] };
          },
        },
        {
          url: `${API}/own-bot/requests/0190a0b0-0000-7000-8000-0000000000aa/cancel`,
          method: 'POST',
          get body() {
            cancelled = true;
            return request({ state: 'CANCELLED' });
          },
        },
      ]),
    );
    renderPage(<PanelShell />);
    expect(await screen.findByText(t('web.rp_bot_step_approve'))).toBeInTheDocument();
    expect(screen.getByText(t('web.rp_bot_state_pending'))).toBeInTheDocument();
    expect(screen.queryByLabelText(t('web.rp_bot_token_label'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.rp_bot_pay') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_bot_cancel') }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith('/cancel') && call.method === 'POST')).toBe(
        true,
      ),
    );
    // The cancelled request moves to the earlier ones; the form is back.
    expect(await screen.findByText(t('web.rp_bot_past_title'))).toBeInTheDocument();
    expect(await screen.findByLabelText(t('web.rp_bot_token_label'))).toBeInTheDocument();
  });

  it('a running subscription shows paid-through, its history, and neither cancel nor pay', async () => {
    stubApi(
      signedIn([
        {
          url: `${API}/own-bot`,
          body: {
            offer: offer({ canRequest: false }),
            requests: [
              approved({ state: 'PAID', paidThrough: '2026-12-11T10:00:00.000Z', stopsAt: null }),
            ],
          },
        },
      ]),
    );
    renderPage(<PanelShell />);
    expect(await screen.findByText(t('web.rp_bot_billing_paid'))).toBeInTheDocument();
    expect(screen.getByText(t('web.rp_bot_history_title'))).toBeInTheDocument();
    expect(screen.getByText(t('web.rp_bot_event_link_sent'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.rp_bot_cancel') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.rp_bot_pay') })).toBeNull();
    // Every step done: the steps list is gone.
    expect(screen.queryByText(t('web.rp_bot_step_approve'))).toBeNull();
  });

  it('a bot stopped for its fee offers «پرداخت و فعال‌سازی دوباره», and a short wallet is refused in Persian', async () => {
    const api = stubApi(
      signedIn([
        {
          url: `${API}/own-bot`,
          body: {
            offer: offer({ canRequest: false }),
            requests: [
              approved({
                state: 'STOPPED',
                paidThrough: '2026-11-01T10:00:00.000Z',
                stopsAt: null,
              }),
            ],
          },
        },
        {
          ...problem(
            `${API}/own-bot/requests/0190a0b0-0000-7000-8000-0000000000aa/pay`,
            409,
            'reseller_bot.insufficient_funds',
          ),
          method: 'POST',
        },
      ]),
    );
    renderPage(<PanelShell />);
    expect(await screen.findByText(t('web.rp_bot_stopped_banner'))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_bot_pay') }));
    expect(
      await screen.findByText(t('web.err_reseller_bot_insufficient_funds')),
    ).toBeInTheDocument();
    expect(api.calls.filter((call) => call.url.endsWith('/pay'))).toHaveLength(1);
  });

  it('lists a rejected request with its reason among the earlier ones', async () => {
    stubApi(
      signedIn([
        {
          url: `${API}/own-bot`,
          body: {
            offer: offer(),
            requests: [
              request({
                state: 'REJECTED',
                rejectReason: 'توکن ربات دیگری است',
                decidedAt: '2026-11-10T10:00:00.000Z',
              }),
            ],
          },
        },
      ]),
    );
    renderPage(<PanelShell />);
    expect(await screen.findByText(t('web.rp_bot_state_rejected'))).toBeInTheDocument();
    expect(
      screen.getByText(t('web.rp_bot_reject_reason').replace('{reason}', 'توکن ربات دیگری است')),
    ).toBeInTheDocument();
    // A closed request does not hold the form back.
    expect(screen.getByLabelText(t('web.rp_bot_token_label'))).toBeInTheDocument();
  });
});

describe('the request steps', () => {
  it('are read from the history: the first undone step waits, the rest are next', () => {
    const steps = (value: Record<string, unknown>) =>
      requestSteps(request(value) as never).map((step) => step.state);
    expect(steps({})).toEqual(['done', 'waiting', 'next', 'next']);
    expect(
      steps({
        state: 'APPROVED',
        timeline: [
          { event: 'SUBMITTED', at: 'x', amount: null, period: null },
          { event: 'APPROVED', at: 'x', amount: null, period: null },
        ],
      }),
    ).toEqual(['done', 'done', 'waiting', 'next']);
  });
});
