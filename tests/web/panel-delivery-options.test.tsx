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

  it.each(['marzban', 'sanaei'])('%s: draws neither control (nothing at all)', (type) => {
    stubApi([]);
    const { container } = renderPage(<PanelDeliveryOptionsCard panel={as(type)} mayEdit />);
    expect(filesOnlySwitch()).toBeNull();
    expect(kindSelect()).toBeNull();
    expect(screen.queryByText(t('web.delivery_options_title'))).toBeNull();
    expect(container.querySelector('.card')).toBeNull();
  });

  it('warns on a legacy files-only panel without file support and lets the operator switch it off', async () => {
    const api = stubApi([{ url: `/panels/${ID}`, method: 'POST', body: { panel: as('sanaei') } }]);
    renderPage(
      <PanelDeliveryOptionsCard panel={as('sanaei', { filesOnlyDelivery: true })} mayEdit />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(t('web.err_panel_files_only_unsupported'));
    fireEvent.click(filesOnlySwitch() as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() =>
      expect(api.calls.find((one) => one.method === 'POST')?.body).toMatchObject({
        filesOnlyDelivery: false,
      }),
    );
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

  it('profile name: shown only for a sing-box kind, with a one-line preview', () => {
    stubApi([]);
    renderPage(<PanelDeliveryOptionsCard panel={as('rickpanel')} mayEdit />);
    expect(screen.queryByLabelText(t('web.singbox_name_label'))).toBeNull();
    fireEvent.change(kindSelect() as HTMLElement, { target: { value: 'SINGBOX' } });
    const mode = screen.getByLabelText(t('web.singbox_name_label')) as HTMLSelectElement;
    expect(mode.value).toBe('DEFAULT');
    expect(screen.getByTestId('singbox-name-preview').textContent).toContain(
      t('web.singbox_name_preview_default'),
    );
    fireEvent.change(mode, { target: { value: 'USERNAME' } });
    expect(screen.getByTestId('singbox-name-preview').textContent).toContain('nx7k2m9q');
    fireEvent.change(kindSelect() as HTMLElement, { target: { value: 'SUB_LINK' } });
    expect(screen.queryByLabelText(t('web.singbox_name_label'))).toBeNull();
  });

  it('profile name: a custom text previews with {username} and is sent trimmed', async () => {
    const api = stubApi([
      { url: `/panels/${ID}`, method: 'POST', body: { panel: as('rickpanel') } },
    ]);
    renderPage(<PanelDeliveryOptionsCard panel={as('rickpanel', { qrKind: 'BOTH' })} mayEdit />);
    fireEvent.change(screen.getByLabelText(t('web.singbox_name_label')), {
      target: { value: 'CUSTOM' },
    });
    fireEvent.change(screen.getByLabelText(t('web.singbox_name_custom_label')), {
      target: { value: '  اشتراک {username}  ' },
    });
    expect(screen.getByTestId('singbox-name-preview').textContent).toContain('اشتراک nx7k2m9q');
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(api.calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      singboxNameMode: 'CUSTOM',
      singboxNameCustom: 'اشتراک {username}',
    });
  });

  it('profile name: a line break or more than 64 characters blocks the save', () => {
    const api = stubApi([]);
    renderPage(<PanelDeliveryOptionsCard panel={as('rickpanel', { qrKind: 'BOTH' })} mayEdit />);
    fireEvent.change(screen.getByLabelText(t('web.singbox_name_label')), {
      target: { value: 'CUSTOM' },
    });
    for (const bad of ['x'.repeat(65), 'a\u2028b']) {
      fireEvent.change(screen.getByLabelText(t('web.singbox_name_custom_label')), {
        target: { value: bad },
      });
      expect(screen.getByRole('button', { name: t('web.save') })).toBeDisabled();
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

/**
 * v0.9.5 PR-3: the custom panel's three delivery options (approved demo, `panel()`). The
 * two file options are enabled only while the bridge's latest health check announced
 * `files`; the choice is written over the two settings that already exist — «فقط فایل» and
 * the policy's SUBSCRIPTION_FILES switch — with «فقط فایل» off first and on last.
 */
describe('the custom panel delivery options', () => {
  const advanced = (filesSwitch: boolean | null, readable = true) => ({
    panelId: ID,
    providerType: 'custom',
    providerName: 'Custom (Nexa bridge v1)',
    status: 'ACTIVE',
    health: 'HEALTHY',
    registry: [],
    policy: {
      policy: {
        delivery: { mode: 'CARD_WITH_QR' },
        actions: {
          RENEW: { customerEnabled: false },
          ...(filesSwitch === null ? {} : { SUBSCRIPTION_FILES: { customerEnabled: filesSwitch } }),
        },
      },
      readable,
      revision: 4,
      updatedAt: null,
    },
    providerRules: {
      trafficReset: 'NEVER',
      protocols: 'PANEL_ASSIGNED',
      inbounds: 'PANEL_ASSIGNED',
      subscriptionLink: 'PANEL_ISSUED',
      deviceLimitOnCreate: 'NOT_SENT',
    },
    diagnostics: {
      overall: 'OK',
      checks: [],
      failure: null,
      httpStatus: 200,
      providerVersion: null,
      lastCheckedAt: null,
      lastSuccessfulCheckAt: null,
      stale: false,
      requiredCapabilities: [],
      missingActivationFields: [],
    },
  });
  const custom = (announced: boolean, extra: Record<string, unknown> = {}) => {
    const base = panel({ id: ID, providerType: 'custom' }) as unknown as Record<string, unknown>;
    return {
      ...base,
      health: {
        ...(base['health'] as Record<string, unknown>),
        announcedCapabilities: announced ? ['SUBSCRIPTION_FILES'] : [],
      },
      ...extra,
    } as unknown as PanelSummaryResponse;
  };
  const option = (key: Parameters<typeof t>[0]) => screen.findByRole('radio', { name: t(key) });

  it('WITHOUT `files` announced: both file options disabled with the reason; «فقط لینک ساب» stays', async () => {
    stubApi([{ url: '/advanced', body: advanced(null) }]);
    renderPage(<PanelDeliveryOptionsCard panel={custom(false)} mayEdit />);
    expect(await option('web.delivery_choice_both')).toBeDisabled();
    expect(await option('web.delivery_choice_files')).toBeDisabled();
    expect(await option('web.delivery_choice_link')).toBeEnabled();
    expect(screen.getByText(t('web.delivery_files_not_announced'))).toBeInTheDocument();
    expect(filesOnlySwitch()).toBeNull();
    expect(kindSelect()).toBeNull();
  });

  it('WITH `files` announced: all three enabled, the stored choice selected, no reason', async () => {
    stubApi([{ url: '/advanced', body: advanced(null) }]);
    renderPage(<PanelDeliveryOptionsCard panel={custom(true)} mayEdit />);
    expect(await option('web.delivery_choice_both')).toBeEnabled();
    expect(await option('web.delivery_choice_both')).toBeChecked();
    expect(await option('web.delivery_choice_files')).toBeEnabled();
    expect(screen.queryByText(t('web.delivery_files_not_announced'))).toBeNull();
  });

  it('a stranded «فقط فایل» (announcement lost) says so', async () => {
    stubApi([{ url: '/advanced', body: advanced(null) }]);
    renderPage(
      <PanelDeliveryOptionsCard panel={custom(false, { filesOnlyDelivery: true })} mayEdit />,
    );
    expect(await option('web.delivery_choice_files')).toBeChecked();
    expect(screen.getByText(t('web.delivery_files_only_stranded'))).toBeInTheDocument();
  });

  it('repairs disabled files on a files-only bridge without changing the link setting', async () => {
    const api = stubApi([
      { url: '/advanced', body: advanced(false) },
      { url: '/policy', method: 'POST', body: { advanced: advanced(true), changed: true } },
    ]);
    renderPage(
      <PanelDeliveryOptionsCard panel={custom(true, { filesOnlyDelivery: true })} mayEdit />,
    );
    expect(await option('web.delivery_choice_files')).toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent(
      t('web.err_panel_files_only_policy_conflict'),
    );
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => expect(api.calls.filter((one) => one.method === 'POST')).toHaveLength(1));
    expect(api.calls.find((one) => one.method === 'POST')?.body).toMatchObject({
      policy: { actions: { SUBSCRIPTION_FILES: { customerEnabled: true } } },
    });
  });

  it('«فقط فایل» from «فقط لینک ساب»: the policy switch ON first, then files only ON', async () => {
    const api = stubApi([
      { url: '/advanced', body: advanced(false) },
      {
        url: `/panels/${ID}/policy`,
        method: 'POST',
        body: { advanced: advanced(true), changed: true },
      },
      { url: `/panels/${ID}`, method: 'POST', body: { panel: custom(true) } },
    ]);
    renderPage(<PanelDeliveryOptionsCard panel={custom(true)} mayEdit />);
    expect(await option('web.delivery_choice_link')).toBeChecked();
    fireEvent.click(await option('web.delivery_choice_files'));
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(2));
    const posts = api.calls.filter((call) => call.method === 'POST');
    expect(posts[0]?.url).toContain('/policy');
    expect(posts[0]?.body).toMatchObject({
      expectedRevision: 4,
      policy: {
        actions: {
          RENEW: { customerEnabled: false },
          SUBSCRIPTION_FILES: { customerEnabled: true },
        },
      },
    });
    expect(posts[1]?.body).toMatchObject({ filesOnlyDelivery: true });
  });

  it('«فقط لینک ساب» from «فقط فایل»: files only OFF first, then the policy switch OFF', async () => {
    const api = stubApi([
      { url: '/advanced', body: advanced(null) },
      {
        url: `/panels/${ID}/policy`,
        method: 'POST',
        body: { advanced: advanced(false), changed: true },
      },
      { url: `/panels/${ID}`, method: 'POST', body: { panel: custom(true) } },
    ]);
    renderPage(
      <PanelDeliveryOptionsCard panel={custom(true, { filesOnlyDelivery: true })} mayEdit />,
    );
    fireEvent.click(await option('web.delivery_choice_link'));
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(2));
    const posts = api.calls.filter((call) => call.method === 'POST');
    expect(posts[0]?.body).toMatchObject({ filesOnlyDelivery: false });
    expect(posts[1]?.url).toContain('/policy');
    expect(posts[1]?.body).toMatchObject({
      policy: { actions: { SUBSCRIPTION_FILES: { customerEnabled: false } } },
    });
  });

  it('an unreadable stored policy: nothing editable, and the reason', async () => {
    stubApi([{ url: '/advanced', body: advanced(null, false) }]);
    renderPage(<PanelDeliveryOptionsCard panel={custom(true)} mayEdit />);
    expect(await option('web.delivery_choice_link')).toBeDisabled();
    expect(screen.getByText(t('web.delivery_policy_unreadable'))).toBeInTheDocument();
  });
});
