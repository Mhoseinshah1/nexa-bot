import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { CustomerLegacyMoneyCard } from '../../apps/web/src/pages/customer-360-legacy-money';
import { UserDetailPage } from '../../apps/web/src/pages/users';
import { openC360Tab } from './c360-helpers';
import { customer, renderPage, stubApi } from './harness';

/**
 * Mirza `.nxpkg` importer — «سوابق مالی میرزا» on Customer 360: not drawn (and nothing asked)
 * without `legacy.history.view`; drawn, it says first that it is view-only and never part of
 * the balance, shows the opening figure, the reconciliation line and the totals, and keeps
 * unsuccessful payments apart. SYNTHETIC values only.
 */

const ID = '019210ab-cdef-7012-8345-6789abcdef01';

const total = (count: number, amountMinor: string | null) => ({
  count,
  amounts: amountMinor === null ? [] : [{ amountMinor, currency: 'IRT' }],
  unparsedAmounts: 0,
  unrecognisedCurrency: 0,
});

const body = {
  readOnly: true,
  addedToBalance: false,
  payments: {
    succeededByPurpose: [{ purpose: 'PURPOSE_NOT_IN_SOURCE', total: total(3, '450000') }],
    excludedByOutcome: [{ outcome: 'CANCELLED', total: total(2, '90000') }],
  },
  walletTransactions: {
    moneyIn: total(1, '100000'),
    moneyOut: total(1, '40000'),
    noChange: 0,
    unparsedAmounts: 3,
  },
  wheel: { spins: 4, prizesWon: total(1, '20000') },
  referrals: { asReferee: 1, asReferrer: 2, referrerGiftsPaid: 1 },
  discountsUsed: 1,
  serviceOperations: [{ status: 'PAID', total: total(2, '310000') }],
  opening: { credit: { amountMinor: '150000', currency: 'IRT' }, debt: null },
  reconciliation: {
    status: 'HISTORY_DIFFERS_SNAPSHOT_KEPT',
    openingFigure: { amountMinor: '150000', currency: 'IRT' },
    snapshotBalance: { amountMinor: '150000', currency: 'IRT' },
    historyClosingBalance: { amountMinor: '140000', currency: 'IRT' },
    deltaSnapshotMinusHistory: { amountMinor: '10000', currency: 'IRT' },
    historyVerdict: 'DIFFERS_FROM_SNAPSHOT',
    difference: { cause: 'ACTIVITY_AFTER_HISTORY_INEXACT', certainty: 'PROBABLE' },
    openingEqualsSnapshot: true,
  },
};

describe('the Mirza money history card', () => {
  it('is not drawn, and asks for nothing, without legacy.history.view', () => {
    const api = stubApi([{ url: `/users/${ID}/legacy-money-history`, body }]);
    const { container } = renderPage(<CustomerLegacyMoneyCard customerId={ID} mayView={false} />);
    expect(container.textContent).toBe('');
    expect(api.calls).toHaveLength(0);
  });

  it('says it is view-only, and shows the opening, the reconciliation and the totals', async () => {
    const api = stubApi([{ url: `/users/${ID}/legacy-money-history`, body }]);
    renderPage(<CustomerLegacyMoneyCard customerId={ID} mayView />);
    expect(await screen.findByText('سوابق مالی میرزا')).toBeTruthy();
    expect(await screen.findByText('فقط برای مشاهده — به موجودی اضافه نمی‌شود')).toBeTruthy();
    expect(screen.getByText(/تاریخچه به رقم دیگری می‌رسد و بکاپ ملاک ماند/)).toBeTruthy();
    // A known verdict reads in Persian, its code kept beside it.
    expect(screen.getByText('DIFFERS_FROM_SNAPSHOT')).toBeTruthy();
    expect(screen.getByText('تاریخچه به رقم دیگری می‌رسد')).toBeTruthy();
    expect(screen.getByText(/کاربرد در بکاپ ثبت نشده/)).toBeTruthy();
    // Unreadable wallet-transaction amounts are counted where the totals are drawn.
    expect(screen.getByText(/مبلغ ناخوانا/)).toBeTruthy();
    expect(screen.getByText(/در جمع بالا حساب نشده/)).toBeTruthy();
    expect(screen.getByText('منقضی یا لغوشده')).toBeTruthy();
    expect(api.calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('shows a debt beside an absent credit', async () => {
    stubApi([
      {
        url: `/users/${ID}/legacy-money-history`,
        body: {
          ...body,
          opening: {
            credit: null,
            debt: { amount: { amountMinor: '30000', currency: 'IRT' }, state: 'PENDING_REVIEW' },
          },
          reconciliation: {
            ...body.reconciliation,
            status: 'NO_WALLET_HISTORY',
            historyVerdict: null,
            difference: null,
          },
        },
      },
    ]);
    renderPage(<CustomerLegacyMoneyCard customerId={ID} mayView />);
    expect(await screen.findByText('PENDING_REVIEW')).toBeTruthy();
    expect(screen.getByText('در انتظار بررسی')).toBeTruthy();
    expect(screen.getByText(/تاریخچه‌ای برای مقایسه نبود/)).toBeTruthy();
    expect(screen.getByText(/تاریخچهٔ تراکنش کیف پول برای این مشتری نداشت/)).toBeTruthy();
  });
});

/*
 * The response names the legacy wallet debt (its amount and review state), which the history
 * card withholds without `legacy.debts.view`. So Customer 360 draws the money card, and asks
 * for it, only when the viewer holds BOTH keys; the server charges both as well.
 */
/** Every required capability off: only the two legacy keys under test vary. */
const OFF = {
  mayBlock: false,
  mayViewWallet: false,
  mayCredit: false,
  mayDebit: false,
  mayViewOrders: false,
  mayViewServices: false,
  mayEditTrial: false,
  mayViewReferrals: false,
  mayViewReseller: false,
  mayEditReseller: false,
} as const;

describe('«سوابق مالی میرزا» on Customer 360 needs legacy.debts.view too', () => {
  const page = (mayViewLegacyDebts: boolean) => {
    const api = stubApi([
      { url: `/users/${ID}`, body: { customer: customer() } },
      { url: `/users/${ID}/legacy-money-history`, body },
    ]);
    renderPage(
      <UserDetailPage
        id={ID}
        {...OFF}
        denied={false}
        mayViewLegacyHistory
        mayViewLegacyDebts={mayViewLegacyDebts}
      />,
    );
    return api;
  };
  const asked = (api: ReturnType<typeof stubApi>) =>
    api.calls.some((c) => c.url.includes('/legacy-money-history'));

  it('legacy.history.view alone: no card and no request', async () => {
    const api = page(false);
    await openC360Tab('financial');
    await waitFor(() => expect(api.calls.some((c) => c.url.endsWith(`/users/${ID}`))).toBe(true));
    expect(screen.queryByText('سوابق مالی میرزا')).toBeNull();
    expect(asked(api)).toBe(false);
  });

  it('both keys: the card is drawn from the server', async () => {
    const api = page(true);
    await openC360Tab('financial');
    expect(await screen.findByText('سوابق مالی میرزا')).toBeTruthy();
    expect(asked(api)).toBe(true);
  });
});
