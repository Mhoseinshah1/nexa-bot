import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SERVICE_OPERATOR_ACTIONS } from '@nexa/contracts';
import { UserDetailPage } from '../../apps/web/src/pages/users';
import { ServiceDetailPage, ServicesPage } from '../../apps/web/src/pages/services';
import { LeaveGuardHost } from '../../apps/web/src/ui/kit';
import { navigate } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import { customer, renderPage, stubApi } from './harness';

/**
 * What the commerce-A redesign ADDED, pinned where it can be reverted by accident.
 *
 * The capabilities the pages had before are asserted in their own suites and were
 * not weakened; these are the new behaviours the reference composition brought:
 * the detail head's summary strip, the block confirmation as a dialog, the leave
 * guard on forms that can lose edits, the blocker sentence as each disabled
 * action's description, and one labelled chip group per filter axis.
 */

const ROW_ID = '019210ab-cdef-7012-8345-6789abcdef01';
const SERVICE_ID = '019250ab-cdef-7012-8345-6789abcdef01';

/** Moves the router itself (not just the address bar), past any guard. */
const go = (url: string) => act(() => navigate(url, { replace: true, force: true }));

afterEach(() => {
  go('/');
});

const NO_COMMERCE = {
  mayViewOrders: false,
  mayViewServices: false,
  mayViewReferrals: false,
  mayViewReseller: false,
  mayEditReseller: false,
} as const;

const walletRoutes = (balanceAmount = '750000') => [
  { url: `/users/${ROW_ID}/wallet/entries`, body: { entries: [], nextCursor: null } },
  {
    url: `/users/${ROW_ID}/wallet`,
    body: { wallet: { customerId: ROW_ID, balanceAmount, currency: 'IRT', entryCount: 0 } },
  },
];

const trialRoute = (remaining: number) => ({
  url: `/users/${ROW_ID}/trial`,
  body: {
    trial: {
      customerId: ROW_ID,
      featureEnabled: true,
      globalLimit: 3,
      override: null,
      effectiveLimit: 3,
      used: 3 - remaining,
      remaining,
    },
  },
});

describe("the customer page's head", () => {
  it('reads its strip through the cards’ own queries: one wallet read, one trial read', async () => {
    const api = stubApi([
      { url: `/users/${ROW_ID}`, body: { customer: customer() } },
      ...walletRoutes('750000'),
      trialRoute(2),
    ]);
    renderPage(
      <UserDetailPage
        id={ROW_ID}
        mayBlock
        mayEditTrial={false}
        mayViewWallet
        mayCredit={false}
        mayDebit={false}
        {...NO_COMMERCE}
        denied={false}
      />,
    );

    const strip = await waitFor(() => {
      const found = document.querySelector('.head-stats');
      if (!(found instanceof HTMLElement)) throw new Error('no summary strip');
      return found;
    });
    await waitFor(() => expect(within(strip).getByText(/۷۵۰٬۰۰۰|750,000/u)).toBeTruthy());
    expect(within(strip).getByText(t('web.user_stat_trial_remaining'))).toBeTruthy();
    // The strip shares the cards' query keys, so it adds no request of its own.
    const reads = (suffix: string) =>
      api.calls.filter((call) => call.method === 'GET' && call.url.endsWith(suffix));
    expect(reads(`/users/${ROW_ID}/wallet`)).toHaveLength(1);
    expect(reads(`/users/${ROW_ID}/trial`)).toHaveLength(1);
  });

  it('draws no balance, and asks for none, without the permission that reads a wallet', async () => {
    const api = stubApi([
      { url: `/users/${ROW_ID}`, body: { customer: customer() } },
      ...walletRoutes(),
      trialRoute(1),
    ]);
    renderPage(
      <UserDetailPage
        id={ROW_ID}
        mayBlock
        mayEditTrial={false}
        mayViewWallet={false}
        mayCredit={false}
        mayDebit={false}
        {...NO_COMMERCE}
        denied={false}
      />,
    );
    const strip = await waitFor(() => {
      const found = document.querySelector('.head-stats');
      if (!(found instanceof HTMLElement)) throw new Error('no summary strip');
      return found;
    });
    expect(within(strip).queryByText(t('web.wallet_balance'))).toBeNull();
    expect(api.calls.some((call) => call.url.includes('/wallet'))).toBe(false);
  });

  it('asks for the block reason in a dialog named by the confirmation, and closes on cancel', async () => {
    stubApi([{ url: `/users/${ROW_ID}`, body: { customer: customer() } }, trialRoute(1)]);
    renderPage(
      <UserDetailPage
        id={ROW_ID}
        mayBlock
        mayEditTrial={false}
        mayViewWallet={false}
        mayCredit={false}
        mayDebit={false}
        {...NO_COMMERCE}
        denied={false}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: t('web.user_block') }));
    const dialog = screen.getByRole('dialog', { name: t('web.user_block_confirm_title') });
    expect(within(dialog).getByLabelText(t('web.user_block_reason_label'))).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.user_action_cancel') }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('forms that can lose edits', () => {
  it('holds a navigation away from a typed wallet movement, and lets it go once cleared', async () => {
    go(`/users/${ROW_ID}`);
    stubApi([
      { url: `/users/${ROW_ID}`, body: { customer: customer() } },
      ...walletRoutes(),
      trialRoute(1),
    ]);
    renderPage(
      <>
        <UserDetailPage
          id={ROW_ID}
          mayBlock={false}
          mayEditTrial={false}
          mayViewWallet
          mayCredit
          mayDebit={false}
          {...NO_COMMERCE}
          denied={false}
        />
        <LeaveGuardHost />
      </>,
    );
    const amount = await screen.findByLabelText(t('web.wallet_adjust_amount'));
    fireEvent.change(amount, { target: { value: '5000' } });

    act(() => navigate('/orders'));
    expect(window.location.pathname).toBe(`/users/${ROW_ID}`);
    const ask = screen.getByRole('alertdialog', { name: t('web.unsaved_title') });
    fireEvent.click(within(ask).getByRole('button', { name: t('web.unsaved_stay') }));
    expect((amount as HTMLInputElement).value).toBe('5000');

    fireEvent.change(amount, { target: { value: '' } });
    act(() => navigate('/orders'));
    expect(window.location.pathname).toBe('/orders');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

function service(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SERVICE_ID,
    customerId: ROW_ID,
    orderId: '019230ab-cdef-7012-8345-6789abcdef01',
    panelId: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
    productId: '019220ab-cdef-7012-8345-6789abcdef01',
    state: 'ACTIVE',
    providerUsername: 'nx-7f3a91',
    providerUserId: '4821',
    hasSubscription: true,
    isTrial: false,
    expiresAt: '2026-12-01T00:00:00.000Z',
    trafficLimitBytes: '53687091200',
    trafficUsedBytes: '1073741824',
    deviceLimit: null,
    usageSyncedAt: '2026-09-15T08:00:00.000Z',
    deliveryState: 'DELIVERED',
    deliveredAt: '2026-09-10T12:35:00.000Z',
    provisionedAt: '2026-09-10T12:34:00.000Z',
    terminatedAt: null,
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T12:35:00.000Z',
    ...overrides,
  };
}

describe('the service page', () => {
  it('describes each refused action by its blocker sentence, and an available one by nothing', async () => {
    stubApi([
      {
        url: `/services/${SERVICE_ID}/operations`,
        body: { operations: [], limit: 50, hasMore: false },
      },
      {
        url: `/services/${SERVICE_ID}`,
        body: {
          service: {
            ...service(),
            deliveryAttempts: 1,
            deliveryNextAttemptAt: null,
            actions: SERVICE_OPERATOR_ACTIONS.map((action) =>
              action === 'SUSPEND'
                ? { action, available: false, blocker: 'CAPABILITY' }
                : { action, available: true, blocker: null },
            ),
          },
        },
      },
    ]);
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />);

    const suspend = await screen.findByRole('button', { name: t('web.service_action_suspend') });
    expect(suspend).toBeDisabled();
    expect(suspend).toHaveAccessibleDescription(t('web.service_blocker_capability'));
    const sync = screen.getByRole('button', { name: t('web.service_action_sync_usage') });
    expect(sync).toBeEnabled();
    expect(sync).not.toHaveAttribute('aria-describedby');
  });

  it('draws the traffic as a bar only when the service has a limit', async () => {
    const detail = (limit: string) => [
      {
        url: `/services/${SERVICE_ID}/operations`,
        body: { operations: [], limit: 50, hasMore: false },
      },
      {
        url: `/services/${SERVICE_ID}`,
        body: {
          service: {
            ...service({ trafficLimitBytes: limit }),
            deliveryAttempts: 1,
            deliveryNextAttemptAt: null,
            actions: [],
          },
        },
      },
    ];
    stubApi(detail('53687091200'));
    const limited = renderPage(
      <ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />,
    );
    expect(
      await screen.findByRole('progressbar', { name: t('web.service_traffic_used') }),
    ).toBeTruthy();
    limited.unmount();

    stubApi(detail('0'));
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate />);
    expect(await screen.findByText(t('web.product_unlimited'))).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('labels each filter axis of the list as its own group, each with its own «all»', async () => {
    stubApi([{ url: '/services', body: { services: [service()], nextCursor: null } }]);
    renderPage(
      <ServicesPage route={{ path: '/services', query: new URLSearchParams() }} denied={false} />,
    );
    await screen.findByText('nx-7f3a91');
    for (const axis of [t('web.service_state'), t('web.service_delivery')]) {
      const group = screen.getByRole('group', { name: axis });
      const all = within(group).getByRole('button', { name: t('web.services_filter_all') });
      expect(all).toHaveAttribute('aria-pressed', 'true');
    }
  });
});
