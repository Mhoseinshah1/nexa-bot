import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_PREFIX,
  GIFT_CARD_ROUTES,
  type GiftCardBatchListResponse,
  type GiftCardBatchWire,
} from '@nexa/contracts';
import { GiftCardsPage } from '../../apps/web/src/pages/gift-cards';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';
import { setDateField } from './ui-helpers';

/**
 * R10 D4 — the gift cards page. Synthetic batches only; the page never holds a code. What is
 * pinned: a denied page issues no request; the server's counts and money are drawn as sent;
 * downloading and disabling are offered only to the keys that allow them; creating is refused
 * up front while the feature is off; a creation sends the face total and the count typed back;
 * a disable is confirmed against the count its preview returned.
 */

const BATCH: GiftCardBatchWire = {
  id: '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b',
  label: 'نوروز',
  amount: { amountMinor: '50000', currency: 'IRT' },
  count: 10,
  perCustomerLimit: 1,
  expiresAt: '2027-03-20T20:30:00.000Z',
  state: 'ACTIVE',
  createdAt: '2026-10-26T08:00:00.000Z',
  createdByAdminId: null,
  disabledAt: null,
  redeemedCount: 3,
  disabledCount: 0,
  unredeemedCount: 7,
  redeemedTotal: { amountMinor: '150000', currency: 'IRT' },
  exportAvailableUntil: '2026-10-27T08:00:00.000Z',
};

const list = (overrides: Partial<GiftCardBatchListResponse> = {}): GiftCardBatchListResponse => ({
  batches: [BATCH],
  nextCursor: null,
  walletCurrency: 'IRT',
  enabled: true,
  ...overrides,
});

const LIST_URL = `${API_PREFIX}${GIFT_CARD_ROUTES.batches}`;

/** A field of the dialog by its id; each is labelled, and two labels share a word. */
function byId(scope: HTMLElement, id: string): HTMLElement {
  const node = scope.querySelector<HTMLElement>(`#${id}`);
  if (node === null) throw new Error(`no #${id}`);
  return node;
}

afterEach(() => vi.unstubAllGlobals());

describe('the gift cards page', () => {
  it('asks nothing of the server without gift_cards.view', () => {
    const api = stubApi([]);
    renderPage(<GiftCardsPage denied mayCreate mayExport mayDisable />);
    expect(screen.getByText(t('web.no_permission'))).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('draws the server counts and offers download and disable only to the keys that allow them', async () => {
    stubApi([{ url: LIST_URL, body: list(), method: 'GET' }]);
    renderPage(<GiftCardsPage denied={false} mayCreate={false} mayExport mayDisable={false} />);
    const row = (await screen.findByText('نوروز')).closest('tr') as HTMLElement;
    expect(within(row).getByRole('link', { name: t('web.gift_cards_download') })).toHaveAttribute(
      'href',
      `${API_PREFIX}${GIFT_CARD_ROUTES.exportCsv(BATCH.id)}`,
    );
    expect(within(row).queryByRole('button', { name: t('web.gift_cards_disable') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.gift_cards_new') })).toBeNull();
  });

  it('hides the download once the export window has closed', async () => {
    stubApi([
      {
        url: LIST_URL,
        body: list({ batches: [{ ...BATCH, exportAvailableUntil: null }] }),
        method: 'GET',
      },
    ]);
    renderPage(<GiftCardsPage denied={false} mayCreate mayExport mayDisable />);
    const row = (await screen.findByText('نوروز')).closest('tr') as HTMLElement;
    expect(within(row).queryByRole('link', { name: t('web.gift_cards_download') })).toBeNull();
  });

  it('says the feature is off and does not offer to mint', async () => {
    stubApi([{ url: LIST_URL, body: list({ enabled: false }), method: 'GET' }]);
    renderPage(<GiftCardsPage denied={false} mayCreate mayExport mayDisable />);
    expect(await screen.findByText(t('web.gift_cards_feature_off'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.gift_cards_new') })).toBeDisabled();
  });

  it('mints a batch with the face total and the count typed back, then offers the download', async () => {
    const created: GiftCardBatchWire = {
      ...BATCH,
      id: '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7c',
      label: 'یلدا',
      count: 3,
      redeemedCount: 0,
      unredeemedCount: 3,
      redeemedTotal: { amountMinor: '0', currency: 'IRT' },
    };
    const api = stubApi([
      { url: LIST_URL, body: list(), method: 'GET' },
      { url: LIST_URL, body: { batch: created }, method: 'POST' },
    ]);
    renderPage(<GiftCardsPage denied={false} mayCreate mayExport mayDisable />);
    // Enabled once the list has said the feature is on and which currency the wallet keeps.
    await screen.findByText('نوروز');
    fireEvent.click(screen.getByRole('button', { name: t('web.gift_cards_new') }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: t('web.gift_cards_create_submit') });
    fireEvent.change(byId(dialog, 'gc-label'), {
      target: { value: 'یلدا' },
    });
    fireEvent.change(byId(dialog, 'gc-amount'), {
      target: { value: '20000' },
    });
    fireEvent.change(byId(dialog, 'gc-count'), {
      target: { value: '3' },
    });
    setDateField(byId(dialog, 'gc-expires'), '2027-01-01T12:00');
    fireEvent.change(byId(dialog, 'gc-reason'), {
      target: { value: 'کمپین یلدا' },
    });
    // The face total is shown before anything is confirmed.
    expect(within(dialog).getByText(t('web.gift_cards_total_title'))).toBeInTheDocument();
    expect(submit).toBeDisabled();
    const typed = byId(dialog, 'gc-typed');
    fireEvent.change(typed, { target: { value: '4' } });
    expect(submit).toBeDisabled();
    fireEvent.change(typed, { target: { value: '3' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await screen.findByText(t('web.gift_cards_created_hint'));
    const write = api.calls.find((call) => call.method === 'POST');
    expect(write?.body).toMatchObject({
      label: 'یلدا',
      amountMinor: '20000',
      currency: 'IRT',
      count: 3,
      perCustomerLimit: null,
      reason: 'کمپین یلدا',
      expectedTotalMinor: '60000',
      typedCount: 3,
    });
    expect(typeof (write?.body as { idempotencyKey?: unknown }).idempotencyKey).toBe('string');
    expect(
      screen
        .getAllByRole('link', { name: t('web.gift_cards_download') })
        .some(
          (link) =>
            link.getAttribute('href') === `${API_PREFIX}${GIFT_CARD_ROUTES.exportCsv(created.id)}`,
        ),
    ).toBe(true);
  });

  it('disables against the previewed count and a reason', async () => {
    const api = stubApi([
      { url: LIST_URL, body: list(), method: 'GET' },
      {
        url: GIFT_CARD_ROUTES.disablePreview(BATCH.id),
        body: { batchId: BATCH.id, state: 'ACTIVE', unredeemedCount: 7 },
      },
      {
        url: GIFT_CARD_ROUTES.disable(BATCH.id),
        body: {
          batch: { ...BATCH, state: 'DISABLED', unredeemedCount: 0, disabledCount: 7 },
          codesDisabled: 7,
          changed: true,
        },
        method: 'POST',
      },
    ]);
    renderPage(<GiftCardsPage denied={false} mayCreate mayExport mayDisable />);
    const row = (await screen.findByText('نوروز')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: t('web.gift_cards_disable') }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(t('web.gift_cards_disable_count'), { exact: false });
    const confirm = within(dialog).getByRole('button', { name: t('web.gift_cards_disable') });
    expect(confirm).toBeDisabled();
    fireEvent.change(byId(dialog, 'gc-disable-reason'), {
      target: { value: 'پایان کمپین' },
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(api.calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      reason: 'پایان کمپین',
      expectedUnredeemed: 7,
      confirmed: true,
    });
  });
});
