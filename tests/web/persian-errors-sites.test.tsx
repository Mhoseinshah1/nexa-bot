import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { UserDetailPage } from '../../apps/web/src/pages/users';
import { navigate } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import { customer, renderPage, stubApi } from './harness';

/**
 * W6, per rewired site: a `request.invalid`, an unmapped 4xx and a 5xx all render Persian,
 * and no English sentence the server wrote reaches the page.
 */

const ROW_ID = '019210ab-cdef-7012-8345-6789abcdef01';
const ENGLISH = /[A-Za-z]{2,}[\s,.:;]+[A-Za-z]{2,}[\s,.:;]+[A-Za-z]{2,}/u;

const go = (url: string) => act(() => navigate(url, { replace: true, force: true }));
afterEach(() => go('/'));

const walletRoutes = [
  { url: `/users/${ROW_ID}/wallet/entries`, body: { entries: [], nextCursor: null } },
  {
    url: `/users/${ROW_ID}/wallet`,
    body: {
      wallet: { customerId: ROW_ID, balanceAmount: '750000', currency: 'IRT', entryCount: 0 },
    },
  },
  {
    url: `/users/${ROW_ID}/trial`,
    body: {
      trial: {
        customerId: ROW_ID,
        featureEnabled: true,
        globalLimit: 3,
        override: null,
        effectiveLimit: 3,
        used: 0,
        remaining: 3,
      },
    },
  },
];

function renderWallet(refusal?: { status: number; error: Record<string, unknown> }) {
  go(`/users/${ROW_ID}`);
  const api = stubApi([
    { url: `/users/${ROW_ID}`, body: { customer: customer() } },
    ...walletRoutes,
    ...(refusal === undefined
      ? []
      : [
          {
            url: `/users/${ROW_ID}/wallet/adjust`,
            method: 'POST',
            status: refusal.status,
            body: { error: { correlationId: 'corr-w6', ...refusal.error } },
          },
        ]),
  ]);
  renderPage(
    <UserDetailPage
      id={ROW_ID}
      mayBlock={false}
      mayEditTrial={false}
      mayViewWallet
      mayCredit
      mayDebit={false}
      mayViewOrders={false}
      mayViewServices={false}
      mayViewReferrals={false}
      mayViewReseller={false}
      mayEditReseller={false}
      denied={false}
    />,
  );
  return api;
}

describe('Customer 360 wallet adjustment', () => {
  it('refuses letters in the amount in Persian, before anything is sent', async () => {
    const api = renderWallet();
    const amount = await screen.findByLabelText(t('web.wallet_adjust_amount'));
    fireEvent.change(amount, { target: { value: '12abc' } });
    expect(
      await screen.findByText('مبلغ باید یک عدد صحیح بزرگ‌تر از صفر باشد.'),
    ).toBeInTheDocument();
    const credit = screen.getByRole('button', { name: t('web.wallet_credit') });
    expect(credit).toBeDisabled();
    fireEvent.click(credit);
    expect(api.calls.some((call) => call.url.includes('/wallet/adjust'))).toBe(false);

    fireEvent.change(amount, { target: { value: '0' } });
    expect(screen.getByRole('button', { name: t('web.wallet_credit') })).toBeDisabled();
    fireEvent.change(amount, { target: { value: '5000' } });
    expect(screen.getByRole('button', { name: t('web.wallet_credit') })).not.toBeDisabled();
    expect(screen.queryByText('مبلغ باید یک عدد صحیح بزرگ‌تر از صفر باشد.')).toBeNull();
  });

  it.each([
    [
      'request.invalid',
      400,
      {
        kind: 'VALIDATION',
        code: 'request.invalid',
        message: 'The request payload is invalid.',
        details: {
          issues: [{ path: 'amount', message: 'expected a positive whole number of minor units' }],
        },
      },
      'web.err_request_invalid',
    ],
    [
      'an unmapped 4xx',
      422,
      { kind: 'VALIDATION', code: 'wallet.something_new', message: 'Something new went wrong.' },
      'web.err_status_400',
    ],
    [
      'a 5xx',
      500,
      { kind: 'INTERNAL', code: 'internal.unhandled', message: 'An internal error occurred.' },
      'web.err_internal_unhandled',
    ],
  ] as const)(
    'says %s in Persian, with the code and correlation id LTR',
    async (_, status, error, key) => {
      renderWallet({ status, error });
      fireEvent.change(await screen.findByLabelText(t('web.wallet_adjust_amount')), {
        target: { value: '5000' },
      });
      fireEvent.click(screen.getByRole('button', { name: t('web.wallet_credit') }));
      const banner = await screen.findByText(t(key));
      expect(banner).toBeInTheDocument();
      expect(screen.getByText('corr-w6')).toHaveAttribute('dir', 'ltr');
      expect(screen.getByText(error.code)).toHaveAttribute('dir', 'ltr');
      expect(screen.queryByText(error.message)).toBeNull();
      // The banner's own sentence is Persian; no English sentence beside it.
      expect(banner.textContent ?? '').not.toMatch(ENGLISH);
      if (error.code === 'request.invalid') {
        expect(screen.getByText('مبلغ باید یک عدد صحیح بزرگ‌تر از صفر باشد.')).toBeInTheDocument();
        const raw = screen.getByText('amount: expected a positive whole number of minor units');
        expect(raw.closest('details')).not.toBeNull();
      }
      await waitFor(() =>
        expect(screen.getByRole('button', { name: t('web.wallet_credit') })).not.toBeDisabled(),
      );
    },
  );
});
