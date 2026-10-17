import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { UserDetailPage } from '../../apps/web/src/pages/users';
import { SettingsPage } from '../../apps/web/src/pages/settings';
import { settingDraftProblems } from '../../apps/web/src/setting-checks';
import { settingPresentation } from '../../apps/web/src/settings-presentation';
import { navigate } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import { customer, renderPage, setting, stubApi } from './harness';
import { openWalletDialog } from './c360-helpers';

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
    const dialog = await openWalletDialog('CREDIT');
    const amount = await screen.findByLabelText(t('web.wallet_adjust_amount'));
    fireEvent.change(amount, { target: { value: '12abc' } });
    expect(
      await screen.findByText('مبلغ باید یک عدد صحیح بزرگ‌تر از صفر باشد.'),
    ).toBeInTheDocument();
    const credit = within(dialog).getByRole('button', { name: t('web.wallet_credit') });
    expect(credit).toBeDisabled();
    fireEvent.click(credit);
    expect(api.calls.some((call) => call.url.includes('/wallet/adjust'))).toBe(false);

    fireEvent.change(amount, { target: { value: '0' } });
    expect(within(dialog).getByRole('button', { name: t('web.wallet_credit') })).toBeDisabled();
    fireEvent.change(amount, { target: { value: '5000' } });
    expect(within(dialog).getByRole('button', { name: t('web.wallet_credit') })).not.toBeDisabled();
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
      const dialog = await openWalletDialog('CREDIT');
      fireEvent.change(await screen.findByLabelText(t('web.wallet_adjust_amount')), {
        target: { value: '5000' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: t('web.wallet_credit') }));
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
        expect(
          within(dialog).getByRole('button', { name: t('web.wallet_credit') }),
        ).not.toBeDisabled(),
      );
    },
  );
});

describe('a setting refused before it is sent', () => {
  const problems = (key: string, draft: unknown) =>
    settingDraftProblems(key, settingPresentation(key as never)?.control ?? null, draft);

  it('says each kind of mistake in Persian, by the registry schema', () => {
    expect(problems('support.accounts', ['@Support1'])).toEqual([]);
    expect(problems('support.accounts', ['support'])).toEqual(['web.err_setting_handle']);
    expect(problems('support.accounts', ['@Support1', '@support1'])).toEqual([
      'web.err_setting_duplicate',
    ]);
    expect(problems('telegram.channels', [{ chatId: '12ab', mandatory: false }])).toEqual([
      'web.err_setting_chat_id',
    ]);
    expect(
      problems('telegram.channels', [
        { handle: '@channel1', joinUrl: 'http://x', mandatory: true },
      ]),
    ).toEqual(['web.err_setting_join_url']);
    expect(problems('telegram.channels', [{ mandatory: true }])).toEqual([
      'web.err_setting_channel_identity',
    ]);
    expect(problems('ops.notifications.max_per_minute', 'ten')).toEqual([
      'web.err_setting_integer',
    ]);
    expect(problems('ops.notifications.max_per_minute', 100000)).toEqual(['web.err_setting_range']);
  });

  it('refuses letters in an amount with the money sentence, never by throwing', () => {
    // These schemas refine with BigInt(amountMinor); a non-digit amount makes safeParse throw.
    for (const key of ['wallet.topup.minimum', 'referral.minimum_order_amount']) {
      expect(problems(key, { amountMinor: '12a', currency: 'IRT' }), key).toEqual([
        'web.err_setting_money',
      ]);
    }
  });

  it('shows the Persian sentence and sends nothing', async () => {
    const api = stubApi([
      {
        url: '/settings',
        body: {
          settings: [
            setting({
              key: 'support.accounts',
              value: ['@Support1'],
              zeroMeaning: 'DISABLES',
              configures: null,
              version: 3,
              source: 'TENANT',
            }),
          ],
        },
      },
    ]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findByRole('heading', { name: t('web.setting_support_accounts') });
    fireEvent.change(screen.getByLabelText('شناسهٔ پشتیبانی 1'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));
    expect(await screen.findByText(t('web.err_setting_handle'))).toBeInTheDocument();
    expect(api.calls.some((call) => call.method !== 'GET')).toBe(false);
  });
});
