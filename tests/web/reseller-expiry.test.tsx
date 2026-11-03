import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ResellerExpiryCard } from '../../apps/web/src/pages/reseller-expiry';
import { t } from '../../apps/web/src/i18n/web.fa';
import { ResellersPage } from '../../apps/web/src/pages/resellers';
import { renderPage, stubApi } from './harness';
import { confirmSensitiveReason, openResellerTab } from './reseller-helpers';

/**
 * Round 11, C2 on the Web Admin: the expiry card of one reseller. Every response goes through
 * the real client and the real zod schema. What is held here: nothing is drawn to edit
 * without `resellers.edit`; the card says WHICH kind of suspension this is (only the expiry's
 * own is lifted by a date); clearing sends a null date under an idempotency key.
 */

const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef01';
const TIER_ID = '019290ab-cdef-7012-8345-6789abcdef01';

function reseller(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customerId: CUSTOMER_ID,
    telegramUserId: '5551234567',
    displayName: 'Reza Reseller',
    tier: { id: TIER_ID, name: 'Gold' },
    status: 'ACTIVE',
    pricingMode: 'TIER',
    discountPercentage: null,
    creditLimit: null,
    effectiveCreditLimit: { amount: '0', currency: 'IRT' },
    source: 'NEXA',
    expiresAt: '2030-01-01T10:00:00.000Z',
    suspendedByExpiry: false,
    createdAt: '2026-09-02T08:00:00.000Z',
    updatedAt: '2026-09-02T08:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('the reseller expiry card (round 11, C2)', () => {
  it('draws no editing without resellers.edit', async () => {
    stubApi([{ url: `/resellers/${CUSTOMER_ID}`, body: { reseller: reseller() } }]);
    renderPage(<ResellerExpiryCard customerId={CUSTOMER_ID} mayEdit={false} />);
    await screen.findByText(t('web.reseller_expiry_title'));
    expect(screen.queryByRole('button', { name: t('web.reseller_expiry_save') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.reseller_expiry_clear') })).toBeNull();
  });

  it('says a suspension was made by the expiry, and that an administrator’s is not lifted by a date', async () => {
    stubApi([
      {
        url: `/resellers/${CUSTOMER_ID}`,
        body: { reseller: reseller({ status: 'SUSPENDED', suspendedByExpiry: true }) },
      },
    ]);
    const first = renderPage(<ResellerExpiryCard customerId={CUSTOMER_ID} mayEdit />);
    expect(await screen.findByText(t('web.reseller_expiry_reactivates'))).toBeInTheDocument();
    first.unmount();

    stubApi([
      {
        url: `/resellers/${CUSTOMER_ID}`,
        body: { reseller: reseller({ status: 'SUSPENDED', suspendedByExpiry: false }) },
      },
    ]);
    renderPage(<ResellerExpiryCard customerId={CUSTOMER_ID} mayEdit />);
    expect(await screen.findByText(t('web.reseller_expiry_manual_suspended'))).toBeInTheDocument();
    expect(screen.queryByText(t('web.reseller_expiry_reactivates'))).toBeNull();
  });

  it('clears the date with a null expiresAt and an idempotency key', async () => {
    const api = stubApi([
      {
        url: `/resellers/${CUSTOMER_ID}/expiry`,
        method: 'POST',
        body: { reseller: reseller({ expiresAt: null }) },
      },
      { url: `/resellers/${CUSTOMER_ID}`, method: 'GET', body: { reseller: reseller() } },
    ]);
    renderPage(<ResellerExpiryCard customerId={CUSTOMER_ID} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.reseller_expiry_clear') }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === 'POST' && c.url.endsWith('/expiry'))).toBe(true),
    );
    const post = api.calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({ expiresAt: null });
    expect((post?.body as { idempotencyKey: string }).idempotencyKey.length).toBeGreaterThanOrEqual(
      8,
    );
    await waitFor(() =>
      expect(
        screen.getByText(t('web.reseller_expiry_current'), { exact: false }),
      ).toHaveTextContent(t('web.reseller_expiry_none')),
    );
  });

  it('shows the new standing in the expiry card after the reseller form saves a status', async () => {
    const tier = {
      id: TIER_ID,
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
    stubApi([
      { url: '/resellers', body: { resellers: [reseller()], nextCursor: null } },
      { url: '/reseller-tiers', body: { tiers: [tier] } },
      {
        url: `/resellers/${CUSTOMER_ID}`,
        method: 'POST',
        body: { reseller: reseller({ status: 'SUSPENDED', suspendedByExpiry: false }) },
      },
      {
        url: `/resellers/${CUSTOMER_ID}`,
        method: 'GET',
        body: { reseller: reseller() },
      },
    ]);
    renderPage(
      <ResellersPage
        route={{ path: '/resellers', query: new URLSearchParams() }}
        denied={false}
        mayEdit
        mayViewWallet={false}
        mayViewOrders={false}
        mayViewAudit={false}
      />,
    );
    await screen.findByText('Reza Reseller');
    fireEvent.click(screen.getByRole('button', { name: 'وضعیت' }));
    await openResellerTab('expiry');
    await screen.findByText(t('web.reseller_expiry_title'));
    expect(screen.queryByText(t('web.reseller_expiry_manual_suspended'))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ویرایش' }));
    await openResellerTab('danger');
    fireEvent.change(screen.getByLabelText('وضعیت'), { target: { value: 'SUSPENDED' } });
    const save = screen.getByRole('button', { name: 'ذخیره' });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);
    await confirmSensitiveReason();
    await openResellerTab('expiry');
    expect(await screen.findByText(t('web.reseller_expiry_manual_suspended'))).toBeInTheDocument();
  });
});
