import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { PanelSummaryResponse } from '@nexa/contracts';
import { t } from '../../apps/web/src/i18n/web.fa';
import { PanelDeliveryOptionsCard } from '../../apps/web/src/pages/panel-delivery-options';
import { panel, renderPage, stubApi } from './harness';

/**
 * R11 A4 on the Web Admin: «فقط فایل، بدون لینک ساب» is drawn only for a provider that hands
 * over files, «نوع بارکد» only for a RickPanel, and a save sends only what changed. The server
 * refuses both elsewhere in Persian; this holds that the form never offers them there.
 */
const ID = '019210ab-cdef-7012-8345-6789abcdef09';
const as = (providerType: string, extra: Record<string, unknown> = {}) =>
  panel({ id: ID, providerType, ...extra }) as unknown as PanelSummaryResponse;

const filesOnlySwitch = () => screen.queryByRole('switch', { name: t('web.files_only_title') });
const kindSelect = () => screen.queryByLabelText(t('web.qr_kind_label'));

describe('the panel delivery options card', () => {
  it('RickPanel: shows both the files-only switch and the QR kind', () => {
    stubApi([]);
    renderPage(<PanelDeliveryOptionsCard panel={as('rickpanel')} mayEdit />);
    expect(filesOnlySwitch()).toBeInTheDocument();
    expect(kindSelect()).toBeInTheDocument();
  });

  it.each(['marzban', 'sanaei', 'custom'])('%s: draws neither control (nothing at all)', (type) => {
    stubApi([]);
    const { container } = renderPage(<PanelDeliveryOptionsCard panel={as(type)} mayEdit />);
    expect(filesOnlySwitch()).toBeNull();
    expect(kindSelect()).toBeNull();
    expect(screen.queryByText(t('web.delivery_options_title'))).toBeNull();
    expect(container.querySelector('.card')).toBeNull();
  });

  it('shows the sing-box interval only for a kind that includes sing-box', () => {
    stubApi([]);
    renderPage(<PanelDeliveryOptionsCard panel={as('rickpanel')} mayEdit />);
    expect(screen.queryByLabelText(t('web.singbox_interval_label'))).toBeNull();
    fireEvent.change(kindSelect() as HTMLElement, { target: { value: 'BOTH' } });
    expect((screen.getByLabelText(t('web.singbox_interval_label')) as HTMLInputElement).value).toBe(
      '360',
    );
  });

  it('sends only what changed, with an idempotency key', async () => {
    const api = stubApi([
      { url: `/panels/${ID}`, method: 'POST', body: { panel: as('rickpanel') } },
    ]);
    renderPage(<PanelDeliveryOptionsCard panel={as('rickpanel')} mayEdit />);
    fireEvent.click(filesOnlySwitch() as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    const body = api.calls.find((call) => call.method === 'POST')?.body as Record<string, unknown>;
    expect(body).toMatchObject({ filesOnlyDelivery: true });
    expect(Object.keys(body).sort()).toEqual(['filesOnlyDelivery', 'idempotencyKey']);
  });

  it('sends the kind and a custom interval together', async () => {
    const api = stubApi([
      { url: `/panels/${ID}`, method: 'POST', body: { panel: as('rickpanel') } },
    ]);
    renderPage(<PanelDeliveryOptionsCard panel={as('rickpanel')} mayEdit />);
    fireEvent.change(kindSelect() as HTMLElement, { target: { value: 'SINGBOX' } });
    fireEvent.change(screen.getByLabelText(t('web.singbox_interval_label')), {
      target: { value: '90' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(api.calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      qrKind: 'SINGBOX',
      singboxIntervalMinutes: 90,
    });
  });

  it('refuses an interval outside the bounds before sending anything', () => {
    const api = stubApi([]);
    renderPage(<PanelDeliveryOptionsCard panel={as('rickpanel', { qrKind: 'BOTH' })} mayEdit />);
    for (const bad of ['0', '10081', '1.5', '']) {
      fireEvent.change(screen.getByLabelText(t('web.singbox_interval_label')), {
        target: { value: bad },
      });
      expect(screen.getByRole('button', { name: t('web.save') })).toBeDisabled();
      expect(screen.getByText(t('web.singbox_interval_invalid'))).toBeInTheDocument();
    }
    expect(api.calls).toHaveLength(0);
  });

  it('read-only without panels.edit: no save button, controls disabled', () => {
    stubApi([]);
    renderPage(<PanelDeliveryOptionsCard panel={as('rickpanel')} mayEdit={false} />);
    expect(screen.queryByRole('button', { name: t('web.save') })).toBeNull();
    expect(filesOnlySwitch()).toBeDisabled();
    expect(kindSelect()).toBeDisabled();
  });
});
