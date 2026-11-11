import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ServiceDrawer } from '../../apps/web/src/reseller/pages/service-drawer';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi, type Route } from './harness';
import { irt, problem, serviceDetail } from './reseller-fixtures';

/**
 * The «مدیریت» drawer: connection (link, QR, files), renewal and extra traffic, the note.
 * The connection-files rules (OWNER: «خیلی مهم») are pinned here at the screen: offered or not,
 * files-only hides link and QR, downloads are plain links to the API (nothing is read or kept by
 * the page), and every state-changing call carries an idempotency key.
 */
const API = '/api/reseller/v1';
const SVC = `${API}/services/svc-1`;

afterEach(() => vi.unstubAllGlobals());

/** Wraps the stubbed fetch to remember each request's headers. */
function watchHeaders() {
  const seen: { url: string; method: string; headers: Record<string, string> }[] = [];
  const inner = globalThis.fetch;
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return inner(input as RequestInfo, init);
  });
  return seen;
}

function open(detail: Record<string, unknown>, extra: readonly Route[] = []) {
  const api = stubApi([{ url: SVC, body: detail }, ...extra]);
  const view = renderPage(<ServiceDrawer serviceId="svc-1" onClose={() => undefined} />);
  return { api, view };
}

describe('connection: link and QR', () => {
  it('shows the QR (the bot’s renderer, through the API), the link, send and «لینک تازه»', async () => {
    open(serviceDetail());
    const qr = await screen.findByAltText(t('web.rp_qr_alt'));
    expect(qr).toHaveAttribute('src', `${SVC}/qr/SINGBOX`);
    expect(
      screen.getByText(t('web.rp_singbox_profile').replace('{name}', 'nexa-ar_1043')),
    ).toBeInTheDocument();
    expect(screen.getByText('https://sub.example.com/s/ar_1043-7f3a9c')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.rp_send_connection') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.rp_rotate') })).toBeInTheDocument();
    // The other QR kind is one click away.
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_qr_sublink') }));
    expect(screen.getByAltText(t('web.rp_qr_alt'))).toHaveAttribute('src', `${SVC}/qr/SUB_LINK`);
  });

  it('offers «لینک تازه» only when the provider supports it', async () => {
    open(serviceDetail({ canRotateLink: false }));
    await screen.findByAltText(t('web.rp_qr_alt'));
    expect(screen.queryByRole('button', { name: t('web.rp_rotate') })).toBeNull();
    expect(screen.queryByText(t('web.rp_rotate_hint'))).toBeNull();
  });

  it('send to Telegram and rotate are POSTs, rotate with an idempotency key', async () => {
    const { api } = open(serviceDetail(), [
      { url: `${SVC}/send-connection`, method: 'POST', body: { sent: 2 } },
      { url: `${SVC}/rotate-link`, method: 'POST', body: { ok: true } },
    ]);
    const seen = watchHeaders();
    fireEvent.click(await screen.findByRole('button', { name: t('web.rp_send_connection') }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.url.endsWith('/send-connection'))).toBe(true),
    );
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_rotate') }));
    await waitFor(() => expect(seen.some((c) => c.url.endsWith('/rotate-link'))).toBe(true));
    const rotate = seen.find((c) => c.url.endsWith('/rotate-link'));
    expect(rotate?.method).toBe('POST');
    expect(rotate?.headers['idempotency-key']).toMatch(/^[A-Za-z0-9-]{16,64}$/u);
  });

  it('a link that cannot be had says so instead of drawing an empty box', async () => {
    open(serviceDetail({ subscriptionUrl: null, qrKinds: [], canRotateLink: false }));
    expect(await screen.findByText(t('web.rp_no_link'))).toBeInTheDocument();
    expect(screen.queryByAltText(t('web.rp_qr_alt'))).toBeNull();
  });
});

describe('connection: files', () => {
  const FILES = {
    files: [
      { index: 0, fileName: 'main.json', sizeBytes: 1200 },
      { index: 1, fileName: 'backup.conf', sizeBytes: 800 },
    ],
  };

  it('is not drawn, and not requested, when the service does not offer files', async () => {
    const { api } = open(serviceDetail({ filesOffered: false }));
    await screen.findByAltText(t('web.rp_qr_alt'));
    expect(screen.queryByText(t('web.rp_files_title'))).toBeNull();
    expect(api.calls.some((call) => call.url.includes('/files'))).toBe(false);
  });

  it('lists the files fetched now, with plain download links and the ZIP', async () => {
    open(serviceDetail({ filesOffered: true }), [{ url: `${SVC}/files`, body: FILES }]);
    const block = await screen.findByRole('region', { name: t('web.rp_files_title') });
    expect(await within(block).findByText('main.json')).toBeInTheDocument();
    const links = within(block).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `${SVC}/files/0`,
      `${SVC}/files/1`,
      `${SVC}/files-zip`,
    ]);
    // Downloads are navigations the browser makes itself: the page never reads the bytes.
    expect(links[0]).toHaveAttribute('download', 'main.json');
    expect(within(block).getByText(t('web.rp_files_note'))).toBeInTheDocument();
  });

  it('sends the files to Telegram with the bot’s own send (POST files/send)', async () => {
    const { api } = open(serviceDetail({ filesOffered: true }), [
      { url: `${SVC}/files`, body: FILES },
      { url: `${SVC}/files/send`, method: 'POST', body: { sent: 2 } },
    ]);
    await screen.findByText('main.json');
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_files_send') }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === 'POST' && c.url.endsWith('/files/send'))).toBe(
        true,
      ),
    );
  });

  it('files-only: no link, no QR, no «ارسال لینک و QR», the explanation, and the files block', async () => {
    open(
      serviceDetail({
        // Even if the answer carried a link and QR kinds, a files-only panel draws neither.
        filesOnly: true,
        filesOffered: true,
        canRotateLink: true,
      }),
      [{ url: `${SVC}/files`, body: FILES }],
    );
    expect(await screen.findByText(t('web.rp_files_only'))).toBeInTheDocument();
    expect(screen.queryByAltText(t('web.rp_qr_alt'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.rp_send_connection') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.rp_rotate') })).toBeNull();
    expect(screen.queryByText(/https:\/\/sub\.example\.com/u)).toBeNull();
    expect(await screen.findByText('backup.conf')).toBeInTheDocument();
  });

  it('shows the Persian refusal when the panel cannot be reached, and nothing is stored', async () => {
    open(serviceDetail({ filesOffered: true }), [
      problem(`${SVC}/files`, 409, 'reseller_web.files_unavailable'),
    ]);
    expect(
      await screen.findByText(t('web.err_reseller_web_files_unavailable')),
    ).toBeInTheDocument();
    expect(JSON.stringify(window.localStorage)).not.toContain('main.json');
    expect(JSON.stringify(window.sessionStorage)).not.toContain('main.json');
  });
});

describe('renewal and extra traffic', () => {
  const OFFER = (kind: string) => ({
    kind,
    options: [
      {
        addonId: null,
        planId: 'plan-1',
        title: '30 روز',
        price: irt('96000'),
        personalDiscount: null,
      },
      {
        addonId: 'add-1',
        planId: null,
        title: '10 گیگ',
        price: irt('50000'),
        personalDiscount: { percent: 10, price: irt('45000') },
      },
    ],
  });
  const ORDER = { id: 'order-1', code: 'O-1', total: irt('96000') };

  it('shows only the tabs the service offers', async () => {
    open(serviceDetail({ actions: ['RENEW'] }));
    await screen.findByAltText(t('web.rp_qr_alt'));
    expect(screen.getByRole('tab', { name: t('web.rp_tab_link') })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: t('web.rp_tab_renew') })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: t('web.rp_tab_traffic') })).toBeNull();
  });

  it('quotes once and pays from the wallet, each with its own idempotency key', async () => {
    const { api } = open(serviceDetail(), [
      { url: `${SVC}/offer/RENEW`, body: OFFER('RENEW') },
      { url: `${SVC}/quote`, method: 'POST', body: orderWire() },
      {
        url: `${API}/orders/order-1/pay-wallet`,
        method: 'POST',
        body: { order: orderWire(), paymentId: 'pay-1' },
      },
    ]);
    const seen = watchHeaders();
    fireEvent.click(await screen.findByRole('tab', { name: t('web.rp_tab_renew') }));
    fireEvent.click(await screen.findByRole('radio', { name: /30 روز/u }));
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_pay_renew') }));
    await waitFor(() => expect(api.calls.some((c) => c.url.endsWith('/pay-wallet'))).toBe(true));
    const quote = api.calls.find((c) => c.url.endsWith('/quote'));
    expect(quote?.body).toEqual({ kind: 'RENEW', addonId: null, planId: 'plan-1' });
    const keys = ['/quote', '/pay-wallet'].map(
      (suffix) => seen.find((c) => c.url.endsWith(suffix))?.headers['idempotency-key'],
    );
    expect(keys[0]).toMatch(/^[A-Za-z0-9-]{16,64}$/u);
    expect(keys[1]).toMatch(/^[A-Za-z0-9-]{16,64}$/u);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('prices an option with a personal discount at the discounted price', async () => {
    open(serviceDetail(), [{ url: `${SVC}/offer/ADD_TRAFFIC`, body: OFFER('ADD_TRAFFIC') }]);
    fireEvent.click(await screen.findByRole('tab', { name: t('web.rp_tab_traffic') }));
    const option = await screen.findByRole('radio', { name: /10 گیگ/u });
    expect(option).toHaveTextContent('45,000 تومان');
    expect(option).toHaveTextContent(t('web.rp_offer_personal').replace('{n}', '10'));
  });

  it('names the shortfall and offers «شارژ کیف پول» when the wallet is short', async () => {
    open(serviceDetail(), [
      { url: `${SVC}/offer/RENEW`, body: OFFER('RENEW') },
      { url: `${SVC}/quote`, method: 'POST', body: orderWire() },
      problem(`${API}/orders/order-1/pay-wallet`, 409, 'commerce.wallet_insufficient_funds', {
        shortfallMinor: '46000',
      }),
    ]);
    fireEvent.click(await screen.findByRole('tab', { name: t('web.rp_tab_renew') }));
    fireEvent.click(await screen.findByRole('radio', { name: /30 روز/u }));
    fireEvent.click(screen.getByRole('button', { name: t('web.rp_pay_renew') }));
    expect(
      await screen.findByText(t('web.rp_pay_short').replace('{amount}', '46,000 تومان')),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.rp_pay_charge') })).toBeInTheDocument();
  });

  function orderWire() {
    return {
      id: 'order-1',
      code: 'O-1',
      state: 'DRAFT',
      purpose: 'RENEW',
      title: '30 روز',
      trafficBytes: null,
      durationDays: 30,
      subtotal: irt('96000'),
      discount: irt('0'),
      total: ORDER.total,
      discountApplied: false,
      personalDiscountPercent: null,
      discountEditable: false,
      cashback: null,
      expiresAt: null,
      serviceId: 'svc-1',
      username: 'ar_1043',
      usernameModes: [],
      locations: [],
      features: [],
      description: null,
    };
  }
});

describe('the note', () => {
  it('saves an edited note (PUT) and only then enables saving again', async () => {
    const { api } = open(serviceDetail({ note: 'رضا' }), [
      { url: `${SVC}/note`, method: 'PUT', body: { note: 'علی' } },
    ]);
    const input = await screen.findByLabelText(t('web.rp_note_label'));
    const save = screen.getByRole('button', { name: t('web.rp_note_save') });
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: 'علی' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PUT')?.body).toEqual({ note: 'علی' }),
    );
  });
});
