import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { SETTINGS, TELEGRAM_CAPTION_MAX_LENGTH, settingScope } from '@nexa/contracts';
import {
  CAPTION_LENGTH_WARN_AT,
  PanelConnectionFilesTab,
  previewValues,
} from '../../apps/web/src/pages/panel-connection-files';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Track 3 §2 on the Web Admin: one panel's «فایل‌های اتصال» tab.
 *
 * The server decides (its schema runs the same validator); these tests hold what the screen
 * does: show what is stored, refuse a template with an unknown variable in Persian and send
 * nothing, write only the key that changed with the version it was read at, preview with
 * the bot's own renderer over variable NAMES (never invented values), and warn near
 * Telegram's caption bound.
 */
const PANEL = '019210ab-cdef-7012-8345-6789abcdef01';
const list = `/panels/${PANEL}/settings`;
const one = (key: string) => `/panels/${PANEL}/settings/${encodeURIComponent(key)}`;

function row(key: string, value: unknown, version: number | null) {
  const definition = SETTINGS.find((setting) => setting.key === key);
  if (definition === undefined || settingScope(definition.key) !== 'PANEL') {
    throw new Error(`not a panel key: ${key}`);
  }
  return {
    key,
    panelId: PANEL,
    value,
    source: version === null ? 'DEFAULT' : 'PANEL',
    version,
    updatedAt: version === null ? null : '2026-10-17T10:00:00.000Z',
    updatedByAdminId: null,
    description: definition.description,
    zeroMeaning: definition.zeroMeaning,
    mutability: definition.mutability,
    classification: definition.classification,
    configures: definition.configures,
    consumer: definition.consumer,
    storedValueInvalid: false,
  };
}

const stored = (template: string | null = null, templateVersion: number | null = null) => ({
  settings: [
    row('panel.connection_files.caption_mode', 'CUSTOM', null),
    row('panel.connection_files.caption_template', template, templateVersion),
    row('panel.connection_files.caption_placement', 'LAST_FILE', null),
  ],
});

const templateField = () =>
  screen.getByLabelText(new RegExp(t('web.connection_files_template'))) as HTMLTextAreaElement;

describe('the connection files tab', () => {
  it('shows the stored defaults: CUSTOM, the default template, the last file', async () => {
    stubApi([{ url: list, method: 'GET', body: stored() }]);
    renderPage(<PanelConnectionFilesTab panelId={PANEL} mayEdit />);
    const mode = (await screen.findByLabelText(
      t('web.connection_files_mode'),
    )) as HTMLSelectElement;
    expect(mode.value).toBe('CUSTOM');
    expect(
      (screen.getByLabelText(t('web.connection_files_use_default')) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByLabelText(t('web.connection_files_placement')) as HTMLSelectElement).value,
    ).toBe('LAST_FILE');
  });

  it('refuses an unknown variable in Persian and sends nothing', async () => {
    const api = stubApi([{ url: list, method: 'GET', body: stored('سرویس {username}', 2) }]);
    renderPage(<PanelConnectionFilesTab panelId={PANEL} mayEdit />);
    await screen.findByLabelText(t('web.connection_files_mode'));
    fireEvent.change(templateField(), { target: { value: 'سرویس {usrname} و {icon:user}' } });
    expect(
      await screen.findByText(
        new RegExp(
          t('web.connection_files_unknown_variable')
            .replace('{token}', '\\{usrname\\}')
            .replace('.', '\\.'),
        ),
      ),
    ).toBeInTheDocument();
    // The icon marker is refused too: this caption is never decorated.
    expect(screen.getByText(/متغیر ناشناخته: \{icon:user\}/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    expect(await screen.findByText(t('web.connection_files_invalid'))).toBeInTheDocument();
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('writes only the key that changed, with the version read and an idempotency key', async () => {
    const api = stubApi([
      { url: list, method: 'GET', body: stored('سرویس {username}', 2) },
      {
        url: one('panel.connection_files.caption_template'),
        method: 'POST',
        body: {
          setting: row('panel.connection_files.caption_template', '<b>{username}</b>', 3),
          changed: true,
        },
      },
    ]);
    renderPage(<PanelConnectionFilesTab panelId={PANEL} mayEdit />);
    await screen.findByLabelText(t('web.connection_files_mode'));
    fireEvent.change(templateField(), { target: { value: '<b>{username}</b>' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    const posts = api.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toContain(one('panel.connection_files.caption_template'));
    expect(posts[0]?.body).toMatchObject({ value: '<b>{username}</b>', expectedVersion: 2 });
    expect(typeof (posts[0]?.body as { idempotencyKey?: unknown }).idempotencyKey).toBe('string');
  });

  it('sends null when the panel goes back to the default template', async () => {
    const api = stubApi([
      { url: list, method: 'GET', body: stored('سرویس {username}', 2) },
      {
        url: one('panel.connection_files.caption_template'),
        method: 'POST',
        body: { setting: row('panel.connection_files.caption_template', null, 3), changed: true },
      },
    ]);
    renderPage(<PanelConnectionFilesTab panelId={PANEL} mayEdit />);
    fireEvent.click(await screen.findByLabelText(t('web.connection_files_use_default')));
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(api.calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      value: null,
      expectedVersion: 2,
    });
  });

  it('previews with the bot renderer: formatting drawn, values are variable names, tags never raw', async () => {
    stubApi([{ url: list, method: 'GET', body: stored('<b>{username}</b>\n{file_name}', 2) }]);
    renderPage(<PanelConnectionFilesTab panelId={PANEL} mayEdit />);
    const preview = await screen.findByTestId('connection-files-preview');
    expect(screen.getByText(t('web.connection_files_preview_hint'))).toBeInTheDocument();
    const values = previewValues();
    expect(preview.textContent).toBe(
      `${String(values['username'])}\n${String(values['file_name'])}`,
    );
    expect(preview.textContent).not.toContain('<b>');
    expect(preview.querySelector('strong')?.textContent).toBe(String(values['username']));
    // Names in guillemets, never an invented username, volume or date.
    for (const value of Object.values(values)) expect(String(value)).toMatch(/^«.+»$/);
  });

  it('warns near Telegram’s caption bound and counts the template', async () => {
    stubApi([{ url: list, method: 'GET', body: stored('{username}', 2) }]);
    renderPage(<PanelConnectionFilesTab panelId={PANEL} mayEdit />);
    await screen.findByTestId('connection-files-preview');
    expect(screen.queryByText(t('web.connection_files_length_warning'))).toBeNull();
    fireEvent.change(templateField(), {
      target: { value: 'ب'.repeat(CAPTION_LENGTH_WARN_AT + 1) },
    });
    expect(await screen.findByText(t('web.connection_files_length_warning'))).toBeInTheDocument();
    expect(CAPTION_LENGTH_WARN_AT).toBeLessThan(TELEGRAM_CAPTION_MAX_LENGTH);
    fireEvent.change(templateField(), {
      target: { value: 'ب'.repeat(TELEGRAM_CAPTION_MAX_LENGTH + 1) },
    });
    expect(
      await screen.findByText(
        new RegExp(t('web.connection_files_template_too_long').split('{')[0] as string),
      ),
    ).toBeInTheDocument();
  });

  it('offers no save to an operator who may not edit', async () => {
    stubApi([{ url: list, method: 'GET', body: stored() }]);
    renderPage(<PanelConnectionFilesTab panelId={PANEL} mayEdit={false} />);
    await screen.findByLabelText(t('web.connection_files_mode'));
    expect(screen.queryByRole('button', { name: t('web.save') })).toBeNull();
    expect(
      (screen.getByLabelText(t('web.connection_files_mode')) as HTMLSelectElement).disabled,
    ).toBe(true);
  });
});
