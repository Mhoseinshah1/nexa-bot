import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { NAV, navPermitted } from '../../apps/web/src/app';
import { ClientAppsPage, formProblems } from '../../apps/web/src/pages/client-apps';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * The apps & connection guides page (WP-A10): the table, the create/edit form with its
 * link and content checks, the preview, and the view-only and denied states — through the
 * real API client, so a fixture that drifts from `clientAppSchema` fails here.
 */

const APP_ID = '019250ab-cdef-7012-8345-6789abcdef21';

function app(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: APP_ID,
    platform: 'ANDROID',
    name: 'برنامهٔ نمونه',
    icon: '🟢',
    description: 'سازگار با لینک اشتراک',
    officialUrl: 'https://downloads.example.com/app.apk',
    alternativeUrl: null,
    helpUrl: null,
    guide: '1. نصب کنید\n2. لینک را وارد کنید',
    deliveryKinds: [],
    protocols: [],
    providerTypes: [],
    status: 'ENABLED',
    sortOrder: 10,
    version: 2,
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-10T12:30:00.000Z',
    ...overrides,
  };
}

/** The list and a write share `/client-apps`; one body parses as both shapes. */
const listAndRow = (rows: Record<string, unknown>[], row: Record<string, unknown>) => ({
  url: '/client-apps',
  body: { items: rows, ...row },
});

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the apps navigation entry', () => {
  it('is shown for client_apps.view and for nothing else', () => {
    const entry = NAV.find((candidate) => candidate.id === 'client-apps');
    if (entry === undefined) throw new Error('no nav entry client-apps');
    expect(entry.path).toBe('/client-apps');
    expect(navPermitted(entry, ['client_apps.view'])).toBe(true);
    expect(navPermitted(entry, ['client_apps.edit'])).toBe(false);
    expect(navPermitted(entry, ['settings.view', 'templates.view'])).toBe(false);
  });
});

describe('formProblems', () => {
  const valid = {
    platform: 'ANDROID' as const,
    name: 'نمونه',
    icon: '',
    description: 'توضیح',
    officialUrl: 'https://downloads.example.com/a.apk',
    alternativeUrl: '',
    helpUrl: '',
    guide: '- یک',
    deliveryKinds: [],
    protocols: [],
    providerTypes: [],
    sortOrder: '0',
  };

  it('accepts a complete entry', () => {
    expect(formProblems(valid)).toEqual({});
  });

  it.each([
    ['officialUrl', 'http://downloads.example.com/a.apk'],
    ['officialUrl', 'javascript:alert(1)'],
    ['officialUrl', 'https://store.example.com@evil.example/'],
    ['alternativeUrl', 'data:text/html,<script>alert(1)</script>'],
    ['helpUrl', 'https://10.0.0.1/video'],
  ])('refuses %s = %j as a link', (field, value) => {
    expect(formProblems({ ...valid, [field]: value })[field as 'officialUrl']).toBe(
      t('web.client_apps_url_invalid'),
    );
  });

  it('refuses markup and unsafe links in the guide, and names why', () => {
    expect(formProblems({ ...valid, guide: '<script>alert(1)</script>' }).guide).toBe(
      t('web.client_apps_problem_markup'),
    );
    expect(formProblems({ ...valid, guide: '[دانلود](http://x.example.com)' }).guide).toBe(
      t('web.client_apps_problem_link'),
    );
    expect(formProblems({ ...valid, name: 'a\nb' }).name).toBe(t('web.client_apps_one_line'));
  });
});

describe('the apps page', () => {
  it('lists the entries with platform, compatibility and status, and a view-only role gets no controls', async () => {
    stubApi([
      listAndRow(
        [
          app(),
          app({
            id: 'second',
            platform: 'OTHER',
            name: 'Files client',
            icon: null,
            deliveryKinds: ['CONNECTION_FILES'],
            providerTypes: ['rickpanel'],
            status: 'DISABLED',
          }),
        ],
        app(),
      ),
    ]);
    renderPage(<ClientAppsPage denied={false} mayEdit={false} />);

    expect(await screen.findByText('🟢 برنامهٔ نمونه')).toBeInTheDocument();
    expect(screen.getByText('Files client')).toBeInTheDocument();
    expect(screen.getByText(t('web.client_apps_platform_other'))).toBeInTheDocument();
    expect(screen.getByText(t('web.client_apps_compat_any'))).toBeInTheDocument();
    expect(
      screen.getByText(`${t('web.client_apps_delivery_files')} · RickPanel`),
    ).toBeInTheDocument();
    expect(screen.getByText(t('web.client_apps_disabled'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.client_apps_new') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.client_apps_edit') })).toBeNull();
  });

  it('creates an entry, refusing a javascript: link before any request is made', async () => {
    const api = stubApi([listAndRow([], app({ id: 'created' }))]);
    renderPage(<ClientAppsPage denied={false} mayEdit />);

    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_new') }));
    fill(t('web.client_apps_name'), 'برنامهٔ تازه');
    fill(t('web.client_apps_description'), 'توضیح کوتاه');
    fill(t('web.client_apps_guide'), '- نصب\n- ورود لینک');
    fill(t('web.client_apps_official_url'), 'javascript:alert(1)');
    fireEvent.click(screen.getByRole('button', { name: t('web.client_apps_save') }));

    expect(await screen.findByText(t('web.client_apps_url_invalid'))).toBeInTheDocument();
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);

    fill(t('web.client_apps_official_url'), 'https://downloads.example.com/new.apk');
    fill(t('web.client_apps_alternative_url'), 'https://store.example.com/app');
    fireEvent.click(screen.getByLabelText(t('web.client_apps_delivery_link')));
    fireEvent.click(screen.getByRole('button', { name: t('web.client_apps_save') }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const posted = api.calls.find((call) => call.method === 'POST');
    expect(posted?.url.endsWith('/client-apps')).toBe(true);
    expect(posted?.body).toEqual({
      platform: 'ANDROID',
      name: 'برنامهٔ تازه',
      icon: null,
      description: 'توضیح کوتاه',
      officialUrl: 'https://downloads.example.com/new.apk',
      alternativeUrl: 'https://store.example.com/app',
      helpUrl: null,
      guide: '- نصب\n- ورود لینک',
      deliveryKinds: ['SUBSCRIPTION_LINK'],
      protocols: [],
      providerTypes: [],
      sortOrder: 0,
      idempotencyKey: expect.any(String) as unknown,
    });
  });

  it('previews an injection attempt as text, never as markup', async () => {
    stubApi([listAndRow([], app())]);
    renderPage(<ClientAppsPage denied={false} mayEdit />);

    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_new') }));
    fill(t('web.client_apps_name'), 'نمونه');
    fill(t('web.client_apps_description'), 'توضیح');
    fill(
      t('web.client_apps_guide'),
      '<img src=x onerror="alert(1)">\n- گام\n[باز کن](javascript:alert(1))\n[دانلود](https://downloads.example.com/a)',
    );

    const preview = screen.getByTestId('client-app-preview');
    // Rendered as a text node: the tag is visible characters, and no element was created.
    expect(preview.querySelector('img')).toBeNull();
    expect(preview.querySelector('a')).toBeNull();
    expect(preview.textContent).toContain('<img src=x onerror="alert(1)">');
    // The guide's subset, as the bot sends it: a bullet, a safe link spelled out, and the
    // unsafe link reduced to its label.
    expect(preview.textContent).toContain('• گام');
    expect(preview.textContent).toContain('دانلود: https://downloads.example.com/a');
    expect(preview.textContent).toContain('باز کن');
    expect(preview.textContent).not.toContain('javascript:');

    // And the form will not send it.
    fireEvent.click(screen.getByRole('button', { name: t('web.client_apps_save') }));
    expect(await screen.findByText(t('web.client_apps_problem_markup'))).toBeInTheDocument();
  });

  it('edits with the version it read, and deletes only after confirmation', async () => {
    const api = stubApi([
      listAndRow([app()], app({ version: 3 })),
      { url: `/client-apps/${APP_ID}/delete`, body: { id: APP_ID, deleted: true } },
    ]);
    renderPage(<ClientAppsPage denied={false} mayEdit />);

    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_edit') }));
    fill(t('web.client_apps_description'), 'توضیح تازه');
    fireEvent.click(screen.getByRole('button', { name: t('web.client_apps_save') }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const edit = api.calls.find((call) => call.method === 'POST');
    expect(edit?.url.endsWith(`/client-apps/${APP_ID}`)).toBe(true);
    expect(edit?.body).toMatchObject({ description: 'توضیح تازه', expectedVersion: 2 });

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_delete') }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(api.calls.some((call) => call.url.endsWith('/delete'))).toBe(false);

    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: t('web.client_apps_delete') }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.url.endsWith('/delete'))).toBe(true);
    });
    expect(api.calls.find((call) => call.url.endsWith('/delete'))?.body).toMatchObject({
      expectedVersion: 2,
    });
  });

  it('does not carry one entry’s conflict to another (C3)', async () => {
    const OTHER_ID = '019250ab-cdef-7012-8345-6789abcdef22';
    stubApi([
      listAndRow([app(), app({ id: OTHER_ID, name: 'دومی' })], app()),
      {
        url: `/client-apps/${APP_ID}`,
        status: 409,
        body: {
          error: {
            kind: 'conflict',
            code: 'control.client_app_version_conflict',
            message: 'changed',
            correlationId: 'test',
            details: { currentVersion: 3 },
          },
        },
      },
    ]);
    renderPage(<ClientAppsPage denied={false} mayEdit />);

    const [editA] = await screen.findAllByRole('button', { name: t('web.client_apps_edit') });
    fireEvent.click(editA as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: t('web.client_apps_save') }));
    expect(await screen.findByText(t('web.client_apps_conflict'))).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: t('web.client_apps_cancel') }));
    const [, editB] = await screen.findAllByRole('button', { name: t('web.client_apps_edit') });
    fireEvent.click(editB as HTMLElement);
    expect(screen.getByLabelText(t('web.client_apps_name'))).toHaveValue('دومی');
    expect(screen.queryByText(t('web.client_apps_conflict'))).toBeNull();
    expect(screen.queryByText(t('web.changed_elsewhere'), { exact: false })).toBeNull();
  });

  it('previews a stored bare unsafe link in the name and description as the bot sends it (C6)', async () => {
    stubApi([
      listAndRow(
        [app({ name: 'App http://x.example/a.apk', description: 'از www.x.example بگیرید' })],
        app(),
      ),
    ]);
    renderPage(<ClientAppsPage denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_edit') }));
    const preview = screen.getByTestId('client-app-preview');
    expect(preview.textContent).toContain('🟢 App');
    expect(preview.textContent).not.toContain('http://');
    expect(preview.textContent).not.toContain('www.');
    // And the form refuses to save it back.
    fireEvent.click(screen.getByRole('button', { name: t('web.client_apps_save') }));
    expect((await screen.findAllByText(t('web.client_apps_problem_link'))).length).toBe(2);
  });

  it('asks for nothing it may not see', () => {
    const api = stubApi([listAndRow([app()], app())]);
    renderPage(<ClientAppsPage denied mayEdit={false} />);
    expect(api.calls).toHaveLength(0);
  });
});
