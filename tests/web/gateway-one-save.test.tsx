import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { PaymentGatewaysPage } from '../../apps/web/src/pages/payment-gateways';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * One «ذخیره» for a dialog with several write-only secrets (BATCH PR-4 B): the API key and the
 * IPN secret of NOWPayments. Each is still sent through its own endpoint (same permission,
 * audit and idempotency as before); the dialog is one form.
 */
const NOWPAYMENTS = {
  provider: 'NOWPAYMENTS',
  status: 'DISABLED',
  displayName: null,
  instructions: null,
  minAmountMinor: '0',
  maxAmountMinor: '0',
  currency: 'IRT',
  eligibility: {
    activateAfterPayments: 0,
    deactivateAfterPayments: 0,
    activateAfterAccountDays: 0,
  },
  sortOrder: 0,
  topupCashbackPercent: 0,
  allowServicePurchase: true,
  allowWalletTopup: true,
  credential: {
    required: true,
    setAt: '2026-09-20T08:00:00.000Z',
    webhookSecretRequired: true,
    webhookSecretSetAt: '2026-09-20T08:00:00.000Z',
    lastCheckAt: null,
    lastCheckOk: null,
    lastCheckDetail: null,
  },
  createdAt: '2026-09-10T12:30:00.000Z',
  updatedAt: '2026-09-10T12:30:00.000Z',
};

const API_KEY = 'کلید API جدید';
const IPN = 'کلید IPN جدید (IPN Secret)';

const open = async () => {
  renderPage(<PaymentGatewaysPage provider="NOWPAYMENTS" denied={false} mayEdit />);
  fireEvent.click(await screen.findByRole('button', { name: 'تنظیم کلید API' }));
  return {
    apiKey: (await screen.findByLabelText(API_KEY)) as HTMLInputElement,
    ipn: (await screen.findByLabelText(IPN)) as HTMLInputElement,
  };
};

const posts = (api: ReturnType<typeof stubApi>) => api.calls.filter((c) => c.method === 'POST');

describe('the gateway dialog saves every secret with one button', () => {
  it('has a single «ذخیره» and no per-secret save button', async () => {
    stubApi([{ url: '/payment-gateways', body: { gateways: [NOWPAYMENTS] } }]);
    await open();
    expect(screen.getAllByRole('button', { name: t('web.save') })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'ذخیرهٔ کلید' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ذخیرهٔ کلید IPN' })).toBeNull();
  });

  it('an empty field keeps its stored value: only the typed field is sent', async () => {
    const api = stubApi([
      { url: '/payment-gateways', body: { gateways: [NOWPAYMENTS] } },
      { url: '/payment-gateways/NOWPAYMENTS/credential', body: { gateway: NOWPAYMENTS } },
      { url: '/payment-gateways/NOWPAYMENTS/webhook-secret', body: { gateway: NOWPAYMENTS } },
    ]);
    const { apiKey, ipn } = await open();
    expect(screen.getByRole('button', { name: t('web.save') })).toBeDisabled();
    fireEvent.change(apiKey, { target: { value: 'np_key_1' } });
    expect(ipn.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(posts(api)[0]!.url).toContain('/credential');
    expect((posts(api)[0]!.body as Record<string, unknown>)['apiKey']).toBe('np_key_1');
    // Full success closes the dialog.
    await waitFor(() => expect(screen.queryByLabelText(API_KEY)).toBeNull());
  });

  it('sends both typed fields, each to its own endpoint, then closes', async () => {
    const api = stubApi([
      { url: '/payment-gateways', body: { gateways: [NOWPAYMENTS] } },
      { url: '/payment-gateways/NOWPAYMENTS/credential', body: { gateway: NOWPAYMENTS } },
      { url: '/payment-gateways/NOWPAYMENTS/webhook-secret', body: { gateway: NOWPAYMENTS } },
    ]);
    const { apiKey, ipn } = await open();
    fireEvent.change(apiKey, { target: { value: 'np_key_1' } });
    fireEvent.change(ipn, { target: { value: 'ipn_1' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => expect(posts(api)).toHaveLength(2));
    expect(posts(api).map((c) => c.url.split('/').pop())).toEqual(['credential', 'webhook-secret']);
    await waitFor(() => expect(screen.queryByLabelText(API_KEY)).toBeNull());
  });

  it('a partial failure names the failed field, keeps what was typed and stays open', async () => {
    const api = stubApi([
      { url: '/payment-gateways', body: { gateways: [NOWPAYMENTS] } },
      { url: '/payment-gateways/NOWPAYMENTS/credential', body: { gateway: NOWPAYMENTS } },
      {
        url: '/payment-gateways/NOWPAYMENTS/webhook-secret',
        status: 502,
        body: {
          error: { kind: 'unavailable', code: 'test.upstream', message: 'x', correlationId: 't' },
        },
      },
    ]);
    const { apiKey, ipn } = await open();
    fireEvent.change(apiKey, { target: { value: 'np_key_1' } });
    fireEvent.change(ipn, { target: { value: 'ipn_typed' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    const alert = await screen.findByText(new RegExp(`${IPN.replace(/[()]/g, '\\$&')}:`));
    expect(alert).toBeInTheDocument();
    // The dialog is still open and the failed field keeps its text; the saved one is cleared.
    expect((screen.getByLabelText(IPN) as HTMLInputElement).value).toBe('ipn_typed');
    expect((screen.getByLabelText(API_KEY) as HTMLInputElement).value).toBe('');
    // Pressing Save again sends only what is still unsaved.
    const before = posts(api).length;
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => expect(posts(api).length).toBe(before + 1));
    expect(posts(api).at(-1)!.url).toContain('/webhook-secret');
  });

  it('a failing first field does not lose its text, and the other field is still saved', async () => {
    const api = stubApi([
      { url: '/payment-gateways', body: { gateways: [NOWPAYMENTS] } },
      {
        url: '/payment-gateways/NOWPAYMENTS/credential',
        status: 502,
        body: {
          error: { kind: 'unavailable', code: 'test.upstream', message: 'x', correlationId: 't' },
        },
      },
      { url: '/payment-gateways/NOWPAYMENTS/webhook-secret', body: { gateway: NOWPAYMENTS } },
    ]);
    const { apiKey, ipn } = await open();
    fireEvent.change(apiKey, { target: { value: 'np_bad' } });
    fireEvent.change(ipn, { target: { value: 'ipn_ok' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => expect(posts(api)).toHaveLength(2));
    expect(((await screen.findByLabelText(API_KEY)) as HTMLInputElement).value).toBe('np_bad');
    expect((screen.getByLabelText(IPN) as HTMLInputElement).value).toBe('');
  });

  it('sends what was typed when Save was pressed, even if a field is edited or the drawer dismissed mid-save', async () => {
    let release: (() => void) | undefined;
    const api = stubApi([
      { url: '/payment-gateways', body: { gateways: [NOWPAYMENTS] } },
      { url: '/payment-gateways/NOWPAYMENTS/credential', body: { gateway: NOWPAYMENTS } },
      { url: '/payment-gateways/NOWPAYMENTS/webhook-secret', body: { gateway: NOWPAYMENTS } },
    ]);
    const realFetch = globalThis.fetch;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = ((input: unknown, init?: RequestInit) =>
      String(input).includes('/credential') && init?.method === 'POST'
        ? gate.then(() => (realFetch as typeof fetch)(input as string, init))
        : (realFetch as typeof fetch)(input as string, init)) as typeof fetch;
    const { apiKey, ipn } = await open();
    fireEvent.change(apiKey, { target: { value: 'np_key_1' } });
    fireEvent.change(ipn, { target: { value: 'ipn_pressed' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    // While the first step is in flight: edit the second field and try to dismiss.
    await waitFor(() => expect(screen.getByRole('button', { name: t('web.save') })).toBeDisabled());
    fireEvent.change(ipn, { target: { value: 'ipn_edited_late' } });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    release?.();
    await waitFor(() => expect(posts(api)).toHaveLength(2));
    expect((posts(api)[1]!.body as Record<string, unknown>)['secret']).toBe('ipn_pressed');
  });
});
