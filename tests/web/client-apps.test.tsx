import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { NAV, navPermitted } from '../../apps/web/src/app';
import { ClientAppsPage, formProblems } from '../../apps/web/src/pages/client-apps';
import { t } from '../../apps/web/src/i18n/web.fa';
import { formatNumber } from '../../apps/web/src/format';
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
    image: null,
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

// ============================================================================
// HF-A10 — an entry's picture
// ============================================================================

const SHA = 'ab'.repeat(32);

function pngFile(width: number, height: number, name = 'icon.png', type = 'image/png'): File {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return new File([bytes], name, { type });
}

const pick = (file: File) =>
  fireEvent.change(screen.getByLabelText(t('web.client_apps_image_file')), {
    target: { files: [file] },
  });

describe('an entry’s picture', () => {
  it('asks for the entry to be saved first when there is no entry yet', async () => {
    stubApi([listAndRow([], app())]);
    renderPage(<ClientAppsPage denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_new') }));
    expect(screen.getByText(t('web.client_apps_image_save_first'))).toBeInTheDocument();
    expect(screen.queryByLabelText(t('web.client_apps_image_file'))).toBeNull();
  });

  it('shows the stored copy, served from the API on this origin, with its size', async () => {
    const stored = app({
      image: {
        mimeType: 'image/png',
        byteLength: 2048,
        width: 256,
        height: 128,
        sha256: SHA,
        updatedAt: '2026-09-10T12:30:00.000Z',
      },
    });
    stubApi([listAndRow([stored], stored)]);
    renderPage(<ClientAppsPage denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_edit') }));

    const image = screen.getByTestId('client-app-image-stored');
    expect(image.getAttribute('src')).toBe(`/api/admin/v1/client-apps/${APP_ID}/image?v=${SHA}`);
    expect(screen.getByText('PNG')).toBeInTheDocument();
    expect(screen.getByText(`${formatNumber(256)}×${formatNumber(128)}`)).toBeInTheDocument();
    // The bot preview shows it too, ahead of the text, as the customer receives it.
    expect(screen.getAllByAltText(t('web.client_apps_image_alt'))).toHaveLength(2);
    expect(screen.getByRole('button', { name: t('web.client_apps_image_clear') })).toBeEnabled();
  });

  it('refuses an SVG, a file that is not a PNG inside, and a wrong size — before any request', async () => {
    const api = stubApi([listAndRow([app()], app())]);
    renderPage(<ClientAppsPage denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_edit') }));
    expect(screen.getByText(t('web.client_apps_image_none'))).toBeInTheDocument();
    const upload = () => screen.getByRole('button', { name: t('web.client_apps_image_upload') });

    pick(
      new File(['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'], 'x.svg', {
        type: 'image/svg+xml',
      }),
    );
    expect(await screen.findByText(t('web.client_apps_image_invalid_type'))).toBeInTheDocument();
    expect(upload()).toBeDisabled();

    // Declared PNG, SVG inside: the magic number decides.
    pick(new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'x.png', { type: 'image/png' }));
    expect(await screen.findByText(t('web.client_apps_image_mismatch'))).toBeInTheDocument();

    pick(pngFile(8, 8));
    expect(await screen.findByText(t('web.client_apps_image_bad_dimensions'))).toBeInTheDocument();
    expect(upload()).toBeDisabled();
    expect(screen.queryByTestId('client-app-image-picked')).toBeNull();
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('previews the picked file and uploads it with the version it read', async () => {
    const after = app({
      version: 3,
      image: {
        mimeType: 'image/png',
        byteLength: 64,
        width: 64,
        height: 32,
        sha256: SHA,
        updatedAt: '2026-09-10T12:31:00.000Z',
      },
    });
    const api = stubApi([
      listAndRow([app()], app()),
      { url: `/client-apps/${APP_ID}/image`, body: after },
    ]);
    /*
     * After the upload the list is not fetched again in time: the refetch never answers.
     * Only the page's own patch of the cached list, from the row the write returned, keeps
     * the editor from reading its own write as a colleague's.
     */
    const stubbed = globalThis.fetch;
    let uploaded = false;
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/image') && init?.method === 'POST') uploaded = true;
      else if (uploaded && url.endsWith('/client-apps') && (init?.method ?? 'GET') === 'GET') {
        return new Promise<Response>(() => undefined);
      }
      return stubbed(input as RequestInfo, init);
    });
    renderPage(<ClientAppsPage denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_edit') }));

    pick(pngFile(64, 32));
    const picked = await screen.findByTestId('client-app-image-picked');
    expect(picked.getAttribute('src')?.startsWith('data:image/png;base64,')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: t('web.client_apps_image_upload') }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.url.endsWith('/image'))).toBe(true);
    });
    const posted = api.calls.find((call) => call.url.endsWith('/image'));
    expect(posted?.method).toBe('POST');
    expect(posted?.body).toMatchObject({
      expectedVersion: 2,
      mimeType: 'image/png',
      contentBase64: expect.stringMatching(/^iVBORw0KGgo/u) as unknown,
    });
    expect(await screen.findByTestId('client-app-image-stored')).toBeInTheDocument();
    // The operator's own write is not mistaken for a colleague's.
    expect(screen.queryByText(t('web.changed_elsewhere'), { exact: false })).toBeNull();
  });

  it('names the server’s reason when it refuses the file', async () => {
    stubApi([
      listAndRow([app()], app()),
      {
        url: `/client-apps/${APP_ID}/image`,
        status: 400,
        body: {
          error: {
            kind: 'validation',
            code: 'commerce.media_invalid',
            message: 'The image is not acceptable.',
            correlationId: 'test',
            details: { reason: 'UNREADABLE' },
          },
        },
      },
    ]);
    renderPage(<ClientAppsPage denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_edit') }));
    pick(pngFile(64, 64));
    await screen.findByTestId('client-app-image-picked');
    fireEvent.click(screen.getByRole('button', { name: t('web.client_apps_image_upload') }));
    expect(await screen.findByText(t('web.client_apps_image_unreadable'))).toBeInTheDocument();
  });

  it('clears the picture with the version it read', async () => {
    const stored = app({
      image: {
        mimeType: 'image/jpeg',
        byteLength: 4096,
        width: 64,
        height: 64,
        sha256: SHA,
        updatedAt: '2026-09-10T12:30:00.000Z',
      },
    });
    const api = stubApi([
      listAndRow([stored], stored),
      { url: `/client-apps/${APP_ID}/image/clear`, body: app({ version: 3 }) },
    ]);
    renderPage(<ClientAppsPage denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_edit') }));
    fireEvent.click(screen.getByRole('button', { name: t('web.client_apps_image_clear') }));
    await waitFor(() => {
      expect(api.calls.some((call) => call.url.endsWith('/image/clear'))).toBe(true);
    });
    expect(api.calls.find((call) => call.url.endsWith('/image/clear'))?.body).toMatchObject({
      expectedVersion: 2,
    });
    expect(await screen.findByText(t('web.client_apps_image_none'))).toBeInTheDocument();
  });
  // --- Codex review of PR #104 -------------------------------------------------------

  it('does not carry a file picked for one entry over to another (R1)', async () => {
    const OTHER_ID = '019250ab-cdef-7012-8345-6789abcdef22';
    const api = stubApi([listAndRow([app(), app({ id: OTHER_ID, name: 'دومی' })], app())]);
    renderPage(<ClientAppsPage denied={false} mayEdit />);
    const [editA] = await screen.findAllByRole('button', { name: t('web.client_apps_edit') });
    fireEvent.click(editA as HTMLElement);
    pick(pngFile(64, 64));
    expect(await screen.findByTestId('client-app-image-picked')).toBeInTheDocument();

    // Straight to the other entry, without closing the editor.
    const [, editB] = screen.getAllByRole('button', { name: t('web.client_apps_edit') });
    fireEvent.click(editB as HTMLElement);
    expect(screen.getByLabelText(t('web.client_apps_name'))).toHaveValue('دومی');
    expect(screen.queryByTestId('client-app-image-picked')).toBeNull();
    const upload = screen.getByRole('button', { name: t('web.client_apps_image_upload') });
    expect(upload).toBeDisabled();
    fireEvent.click(upload);
    expect(api.calls.some((call) => call.url.includes('/image'))).toBe(false);
  });

  it('keeps the file the input shows when an earlier read finishes last (R2)', async () => {
    /*
     * A FileReader whose reads finish when the test says so, in the order it says.
     */
    const original = globalThis.FileReader;
    const pending: DeferredReader[] = [];
    class DeferredReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private file: File | null = null;
      readAsDataURL(file: File) {
        this.file = file;
        pending.push(this);
      }
      /** The real reader's answer, delivered now. */
      async finish() {
        const file = this.file as File;
        this.result = await new Promise<string>((resolve) => {
          const real = new original();
          real.onload = () => resolve(String(real.result));
          real.readAsDataURL(file);
        });
        this.onload?.();
      }
    }
    vi.stubGlobal('FileReader', DeferredReader);
    try {
      const api = stubApi([
        listAndRow([app()], app()),
        { url: `/client-apps/${APP_ID}/image`, body: app({ version: 3 }) },
      ]);
      renderPage(<ClientAppsPage denied={false} mayEdit />);
      fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_edit') }));

      pick(pngFile(64, 32, 'first.png'));
      pick(pngFile(48, 48, 'second.png'));
      expect(pending).toHaveLength(2);
      // The SECOND file's read finishes first, the first file's last.
      await act(async () => {
        await (pending[1] as DeferredReader).finish();
      });
      await act(async () => {
        await (pending[0] as DeferredReader).finish();
      });

      fireEvent.click(screen.getByRole('button', { name: t('web.client_apps_image_upload') }));
      await waitFor(() => {
        expect(api.calls.some((call) => call.url.endsWith('/image'))).toBe(true);
      });
      const body = api.calls.find((call) => call.url.endsWith('/image'))?.body as {
        contentBase64: string;
      };
      const sent = Buffer.from(body.contentBase64, 'base64');
      expect([sent.readUInt32BE(16), sent.readUInt32BE(20)]).toEqual([48, 48]);
    } finally {
      vi.stubGlobal('FileReader', original);
    }
  });

  it('lets no write on an entry start while another is in flight (R3)', async () => {
    const stored = app({
      image: {
        mimeType: 'image/png',
        byteLength: 64,
        width: 64,
        height: 64,
        sha256: SHA,
        updatedAt: '2026-09-10T12:30:00.000Z',
      },
    });
    stubApi([listAndRow([stored], stored)]);
    // Every write hangs: what matters is what can be pressed while one is in flight.
    const stubbed = globalThis.fetch;
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'POST'
        ? new Promise<Response>(() => undefined)
        : stubbed(input as RequestInfo, init),
    );
    renderPage(<ClientAppsPage denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_edit') }));
    const save = () => screen.getByRole('button', { name: t('web.client_apps_save') });
    const clear = () => screen.getByRole('button', { name: t('web.client_apps_image_clear') });
    expect(save()).toBeEnabled();

    // The picture's removal in flight: no text save, switch, delete or other entry's edit.
    fireEvent.click(clear());
    await waitFor(() => {
      expect(save()).toBeDisabled();
    });
    expect(screen.getByRole('button', { name: t('web.client_apps_edit') })).toBeDisabled();
    expect(screen.getByRole('button', { name: t('web.client_apps_delete') })).toBeDisabled();
    expect(screen.getByRole('button', { name: t('web.client_apps_cancel') })).toBeDisabled();
  });

  it('lets no picture write start while a text save is in flight (R3)', async () => {
    const stored = app({
      image: {
        mimeType: 'image/png',
        byteLength: 64,
        width: 64,
        height: 64,
        sha256: SHA,
        updatedAt: '2026-09-10T12:30:00.000Z',
      },
    });
    stubApi([listAndRow([stored], stored)]);
    const stubbed = globalThis.fetch;
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'POST'
        ? new Promise<Response>(() => undefined)
        : stubbed(input as RequestInfo, init),
    );
    renderPage(<ClientAppsPage denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_edit') }));
    pick(pngFile(64, 64));
    await screen.findByTestId('client-app-image-picked');
    const clear = () => screen.getByRole('button', { name: t('web.client_apps_image_clear') });
    const upload = () => screen.getByRole('button', { name: t('web.client_apps_image_upload') });
    expect(clear()).toBeEnabled();
    expect(upload()).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: t('web.client_apps_save') }));
    await waitFor(() => {
      expect(clear()).toBeDisabled();
    });
    expect(upload()).toBeDisabled();
    expect(screen.getByLabelText(t('web.client_apps_image_file'))).toBeDisabled();
  });

  it('gives a different file a new key after an ambiguous failure, even with the same name and size (R4)', async () => {
    const api = stubApi([
      listAndRow([app()], app()),
      {
        url: `/client-apps/${APP_ID}/image`,
        status: 503,
        body: {
          error: {
            kind: 'unavailable',
            code: 'platform.unavailable',
            message: 'try again',
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(<ClientAppsPage denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_edit') }));
    const uploads = () => api.calls.filter((call) => call.url.endsWith('/image'));
    const send = async (file: File, count: number) => {
      pick(file);
      await screen.findByTestId('client-app-image-picked');
      fireEvent.click(screen.getByRole('button', { name: t('web.client_apps_image_upload') }));
      await waitFor(() => {
        expect(uploads()).toHaveLength(count);
      });
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: t('web.client_apps_image_upload') }),
        ).toBeEnabled();
      });
    };
    const keyOf = (index: number) =>
      (uploads()[index]?.body as { idempotencyKey: string }).idempotencyKey;

    await send(pngFile(64, 32, 'icon.png'), 1);
    // The same file again is a retry of the same question: the held key.
    await send(pngFile(64, 32, 'icon.png'), 2);
    expect(keyOf(1)).toBe(keyOf(0));
    // A different file with the same name and the same size is a new command.
    await send(pngFile(32, 64, 'icon.png'), 3);
    expect(keyOf(2)).not.toBe(keyOf(0));
  });
});
