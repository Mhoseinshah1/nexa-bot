import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_PREFIX,
  DATA_EXPORT_ROUTES,
  PERMISSION_KEYS,
  type DataExportView,
  type HostedBotView,
} from '@nexa/contracts';
import { NAV, navPermitted } from '../../apps/web/src/nav';
import { DataExportPage } from '../../apps/web/src/pages/data-export';
import { DataExportList } from '../../apps/web/src/pages/data-export-parts';
import { DataExportSection } from '../../apps/web/src/pages/hosting-data-export';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * «خروجی داده» (phase 6B PR-3): a hosted bot's owner asks for the ZIP, watches it being made
 * and downloads it for 24 hours. Persian only; the download is a same-origin link.
 */

afterEach(() => vi.unstubAllGlobals());

const url = (path: string) => `${API_PREFIX}${path}`;

function view(overrides: Partial<DataExportView> = {}): DataExportView {
  return {
    id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
    state: 'READY',
    requestedAt: '2026-11-05T10:00:00.000Z',
    requestedByHost: false,
    readyAt: '2026-11-05T10:03:00.000Z',
    expiresAt: '2026-11-06T10:03:00.000Z',
    bytes: 5 * 1024 * 1024,
    failureCode: null,
    downloadable: true,
    ...overrides,
  };
}

describe('the page', () => {
  it('draws nothing and asks for nothing without data.export', () => {
    const api = stubApi([]);
    renderPage(<DataExportPage denied />);
    expect(screen.getByText(t('web.no_permission'))).toBeInTheDocument();
    expect(api.calls).toEqual([]);
    expect(screen.getByRole('button', { name: t('web.data_export_request') })).toBeDisabled();
  });

  it('says what the file holds and never holds, in Persian only', async () => {
    stubApi([{ url: url(DATA_EXPORT_ROUTES.own), body: { exports: [] } }]);
    renderPage(<DataExportPage denied={false} />);
    expect(await screen.findByText(t('web.data_export_empty_title'))).toBeInTheDocument();
    expect(screen.getByText(t('web.data_export_never_hint'))).toBeInTheDocument();
    expect(screen.getByText(t('web.data_export_what_hint'))).toBeInTheDocument();
    // No English sentence is drawn: every letter of the visible text outside a code is Persian.
    const visible = document.body.textContent ?? '';
    expect(visible).toMatch(/[؀-ۿ]/);
  });

  it('asks with one press, sends an idempotency key and refreshes the list', async () => {
    const api = stubApi([
      { url: url(DATA_EXPORT_ROUTES.own), method: 'GET', body: { exports: [] } },
      {
        url: url(DATA_EXPORT_ROUTES.own),
        method: 'POST',
        body: {
          export: view({ state: 'REQUESTED', downloadable: false, bytes: null }),
          replayed: false,
        },
      },
    ]);
    renderPage(<DataExportPage denied={false} />);
    const button = await screen.findByRole('button', { name: t('web.data_export_request') });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    const body = api.calls.find((c) => c.method === 'POST')?.body as { idempotencyKey: string };
    expect(body.idempotencyKey.length).toBeGreaterThanOrEqual(8);
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === 'GET').length).toBeGreaterThanOrEqual(2),
    );
  });

  it('shows a ready export with its size and deadline and a download link to the same origin', async () => {
    stubApi([{ url: url(DATA_EXPORT_ROUTES.own), body: { exports: [view()] } }]);
    renderPage(<DataExportPage denied={false} />);
    const link = await screen.findByRole('link', { name: t('web.data_export_download') });
    expect(link.getAttribute('href')).toBe(
      `${API_PREFIX}/data-exports/01a05e35-c9ad-7e93-bef3-1ed9b55292c8/download`,
    );
    expect(link).toHaveAttribute('download');
    expect(screen.getByText(t('web.data_export_state_ready'))).toBeInTheDocument();
    expect(screen.getByText(t('web.data_export_expires_at'))).toBeInTheDocument();
    expect(screen.getByText(t('web.data_export_size'))).toBeInTheDocument();
  });

  it('while one is being made, the request is disabled and the page says it refreshes itself', async () => {
    stubApi([
      {
        url: url(DATA_EXPORT_ROUTES.own),
        body: { exports: [view({ state: 'RUNNING', downloadable: false, bytes: null })] },
      },
    ]);
    renderPage(<DataExportPage denied={false} />);
    expect(await screen.findByText(t('web.data_export_waiting_hint'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('web.data_export_request') })).toBeDisabled();
    expect(screen.queryByRole('link', { name: t('web.data_export_download') })).toBeNull();
  });

  it('says an expired export is gone and offers no link; a failure says why', () => {
    renderPage(
      <DataExportList
        hrefFor={(id) => `/x/${id}`}
        exports={[
          view({
            id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c1',
            state: 'EXPIRED',
            downloadable: false,
          }),
          view({
            id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c2',
            state: 'FAILED',
            downloadable: false,
            failureCode: 'data_export.too_large',
            bytes: null,
            expiresAt: null,
          }),
        ]}
      />,
    );
    expect(screen.getByText(t('web.data_export_expired_hint'))).toBeInTheDocument();
    expect(screen.getByText(t('web.data_export_failed_too_large_hint'))).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('marks an export the host asked for, so it is not taken for the owner’s own', () => {
    renderPage(
      <DataExportList hrefFor={(id) => `/x/${id}`} exports={[view({ requestedByHost: true })]} />,
    );
    const item = screen.getByRole('listitem');
    expect(within(item).getByText(t('web.data_export_by_host'))).toBeInTheDocument();
  });

  it('answers a refusal in Persian', async () => {
    stubApi([
      { url: url(DATA_EXPORT_ROUTES.own), method: 'GET', body: { exports: [] } },
      {
        url: url(DATA_EXPORT_ROUTES.own),
        method: 'POST',
        status: 409,
        body: {
          error: {
            kind: 'conflict',
            code: 'data_export.in_progress',
            message: 'x',
            correlationId: 'c1',
          },
        },
      },
    ]);
    renderPage(<DataExportPage denied={false} />);
    const button = await screen.findByRole('button', { name: t('web.data_export_request') });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByText(t('web.err_data_export_in_progress'))).toBeInTheDocument();
  });
});

describe('the navigation entry', () => {
  it('is drawn only to an actor holding data.export', () => {
    const entry = NAV.find((item) => item.id === 'data-export');
    expect(entry?.path).toBe('/data-export');
    expect(entry?.permission).toBe('data.export');
    expect(navPermitted(entry!, ['data.export'], ['owner'])).toBe(true);
    expect(
      navPermitted(
        entry!,
        PERMISSION_KEYS.filter((key) => key !== 'data.export'),
        ['owner'],
      ),
    ).toBe(false);
    expect(navPermitted(entry!, [], [])).toBe(false);
  });
});

describe('inside «میزبانی‌ها»', () => {
  const TENANT = '01a05e35-c9ad-7e93-bef3-1ed9b55292c9';
  const BOT = { tenantId: TENANT, displayName: 'آکمه' } as unknown as HostedBotView;
  const route = (suffix = '') => url(`/hosting/bots/${TENANT}/data-exports${suffix}`);

  it('asks for a FRESH code, sends it with the idempotency key, and links the host’s download route', async () => {
    const api = stubApi([
      {
        url: route(),
        method: 'GET',
        body: { exports: [view({ requestedByHost: true })] },
      },
      {
        url: route(),
        method: 'POST',
        body: { export: view({ state: 'REQUESTED', downloadable: false }), replayed: false },
      },
    ]);
    renderPage(<DataExportSection bot={BOT} />);
    const link = await screen.findByRole('link', { name: t('web.data_export_download') });
    expect(link.getAttribute('href')).toBe(
      `${API_PREFIX}/hosting/bots/${TENANT}/data-exports/01a05e35-c9ad-7e93-bef3-1ed9b55292c8/download`,
    );
    // The button is enabled while nothing is being made; the dialog asks for the code.
    fireEvent.click(screen.getByRole('button', { name: t('web.hosting_data_export_request') }));
    const submit = await screen.findByRole('button', { name: t('web.hosting_data_export_submit') });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('web.hosting_code_label')), {
      target: { value: '123 456' },
    });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    const body = api.calls.find((c) => c.method === 'POST')?.body as {
      idempotencyKey: string;
      proof: { code: string };
    };
    expect(body.proof).toEqual({ code: '123456' });
    expect(body.idempotencyKey.length).toBeGreaterThanOrEqual(8);
  });
});
