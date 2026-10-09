import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { QrTemplateSection } from '../../apps/web/src/pages/qr-template';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, setting, stubApi } from './harness';
import { buildPng, ihdr, pngFromChunks } from '../support/png-build';

/**
 * Phase 2 item 4 on the Web Admin: «پس‌زمینهٔ QR اشتراک» — the background slot, the placement
 * setting validated against the background before saving, the server's own preview, and the
 * way back to the plain QR.
 */

const TEMPLATE = { x: 150, y: 120, size: 420, quietZoneModules: 4 };
const MEDIA = {
  purpose: 'QR_BACKGROUND',
  mimeType: 'image/png',
  byteLength: 52_000,
  sha256: 'a'.repeat(64),
  version: 3,
  updatedAt: '2026-10-06T10:00:00.000Z',
};

function api(
  options: {
    template?: unknown;
    version?: number | null;
    media?: unknown;
    background?: { width: number; height: number };
  } = {},
) {
  const media = options.media === undefined ? null : options.media;
  return stubApi([
    {
      url: '/settings',
      body: {
        settings: [
          setting({
            key: 'delivery.qr_template',
            value: options.template ?? null,
            source: options.template === undefined ? 'DEFAULT' : 'TENANT',
            version: options.version ?? null,
            configures: null,
          }),
        ],
      },
    },
    { url: '/media/QR_BACKGROUND', body: { media } },
    { url: '/media/QR_BACKGROUND/clear', method: 'POST', body: { media: null } },
    {
      url: '/delivery-qr/preview',
      body: {
        pngBase64: 'iVBORw0KGgo=',
        width: media === null ? 456 : 800,
        height: media === null ? 456 : 700,
        templated: media !== null && options.template !== undefined,
        fallback:
          media === null ? 'NO_BACKGROUND' : options.template === undefined ? 'NO_TEMPLATE' : null,
        moduleScale: 8,
        background: media === null ? null : (options.background ?? { width: 800, height: 700 }),
      },
    },
    {
      url: '/settings/delivery.qr_template',
      body: {
        setting: setting({
          key: 'delivery.qr_template',
          value: TEMPLATE,
          version: 2,
          configures: null,
        }),
        changed: true,
      },
    },
  ]);
}

const posts = (
  calls: { calls: { url: string; method: string; body: unknown }[] },
  suffix: string,
) => calls.calls.filter((call) => call.method === 'POST' && call.url.endsWith(suffix));

const input = (id: string) => document.getElementById(id) as HTMLInputElement;

/** A Buffer as a plain Uint8Array a Blob accepts. */
const bytes = (buffer: Buffer): Uint8Array<ArrayBuffer> => Uint8Array.from(buffer);

function pick(file: File) {
  fireEvent.change(input('qrt-file'), { target: { files: [file] } });
}

describe('«پس‌زمینهٔ QR اشتراک»', () => {
  it('says the plain QR is in force by default, and shows the server preview', async () => {
    api();
    renderPage(<QrTemplateSection mayEdit />);
    expect(await screen.findByText(t('web.qrt_status_default'))).toBeTruthy();
    expect(await screen.findByTestId('qrt-preview')).toBeTruthy();
    expect(screen.getByText(t('web.qrt_fallback_no_background'))).toBeTruthy();
    expect(screen.getByText(t('web.qrt_no_background'))).toBeTruthy();
  });

  it('shows the stored background, its dimensions, and the active state', async () => {
    api({ template: TEMPLATE, version: 4, media: MEDIA });
    renderPage(<QrTemplateSection mayEdit />);
    expect(await screen.findByText(t('web.qrt_status_active'))).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('qrt-background').textContent).toContain('800 × 700'),
    );
    expect(input('qrt-x').value).toBe('150');
    expect(input('qrt-size').value).toBe('420');
  });

  it('refuses a JPEG, an interlaced PNG and an oversized side before uploading anything', async () => {
    const calls = api();
    renderPage(<QrTemplateSection mayEdit />);
    await screen.findByTestId('qrt-preview');

    pick(
      new File([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])], 'bg.jpg', {
        type: 'image/jpeg',
      }),
    );
    expect(await screen.findByText(t('web.qrt_problem_not_png'))).toBeTruthy();

    pick(
      new File([bytes(pngFromChunks(ihdr(400, 400, 6, { interlace: 1 })))], 'i.png', {
        type: 'image/png',
      }),
    );
    expect(await screen.findByText(t('web.qrt_problem_format'))).toBeTruthy();

    pick(new File([bytes(pngFromChunks(ihdr(4000, 400, 2)))], 'big.png', { type: 'image/png' }));
    expect(await screen.findByText(t('web.qrt_problem_dimensions'))).toBeTruthy();

    const button = screen.getByRole('button', { name: t('web.qrt_upload') }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(posts(calls, '/media/QR_BACKGROUND')).toHaveLength(0);
  });

  it('uploads a valid PNG as base64, PNG declared', async () => {
    const calls = api();
    renderPage(<QrTemplateSection mayEdit />);
    await screen.findByTestId('qrt-preview');
    const png = buildPng({ width: 300, height: 200, colourType: 2, pixel: () => [1, 2, 3] });
    pick(new File([bytes(png)], 'bg.png', { type: 'image/png' }));
    expect((await screen.findByTestId('qrt-picked')).textContent).toBe('300 × 200');
    fireEvent.click(screen.getByRole('button', { name: t('web.qrt_upload') }));
    await waitFor(() => expect(posts(calls, '/media/QR_BACKGROUND')).toHaveLength(1));
    const body = posts(calls, '/media/QR_BACKGROUND')[0]?.body as Record<string, unknown>;
    expect(body['mimeType']).toBe('image/png');
    expect(Buffer.from(String(body['contentBase64']), 'base64').equals(png)).toBe(true);
  });

  it('validates the region against the background before saving, then saves it once', async () => {
    const calls = api({ media: MEDIA });
    renderPage(<QrTemplateSection mayEdit />);
    await waitFor(() =>
      expect(screen.getByTestId('qrt-background').textContent).toContain('800 × 700'),
    );
    const save = () => screen.getByRole('button', { name: t('web.qrt_save') }) as HTMLButtonElement;

    fireEvent.change(input('qrt-x'), { target: { value: '500' } });
    fireEvent.change(input('qrt-size'), { target: { value: '301' } });
    expect((await screen.findByTestId('qrt-field-error')).textContent).toBe(t('web.qrt_outside'));
    expect(save().disabled).toBe(true);

    fireEvent.change(input('qrt-size'), { target: { value: '300' } });
    fireEvent.change(input('qrt-quiet'), { target: { value: '17' } });
    expect(screen.getByTestId('qrt-field-error').textContent).toBe(t('web.qrt_invalid_fields'));
    expect(save().disabled).toBe(true);

    fireEvent.change(input('qrt-quiet'), { target: { value: '۴' } });
    await waitFor(() => expect(screen.queryByTestId('qrt-field-error')).toBeNull());
    fireEvent.click(save());
    await waitFor(() => expect(posts(calls, '/settings/delivery.qr_template')).toHaveLength(1));
    expect(posts(calls, '/settings/delivery.qr_template')[0]?.body).toMatchObject({
      value: { x: 500, y: 0, size: 300, quietZoneModules: 4 },
      expectedVersion: null,
    });
  });

  /*
   * FIX-06 (2026-10-09): the white margin is 0..16 whole modules, and 0 is a value the form
   * accepts, previews and saves as 0 — with a warning that never blocks it.
   */
  it('accepts a white margin of 0: warns, previews and saves 0, never the default', async () => {
    const calls = api({ media: MEDIA });
    renderPage(<QrTemplateSection mayEdit />);
    await waitFor(() =>
      expect(screen.getByTestId('qrt-background').textContent).toContain('800 × 700'),
    );
    const save = () => screen.getByRole('button', { name: t('web.qrt_save') }) as HTMLButtonElement;
    // A new template starts at the recommended 4: no warning.
    expect(input('qrt-quiet').value).toBe('4');
    expect(screen.queryByTestId('qrt-quiet-warning')).toBeNull();

    fireEvent.change(input('qrt-x'), { target: { value: '100' } });
    fireEvent.change(input('qrt-quiet'), { target: { value: '0' } });
    await waitFor(() => expect(screen.queryByTestId('qrt-field-error')).toBeNull());
    expect(screen.getByTestId('qrt-quiet-warning').textContent).toBe(
      t('web.qrt_quiet_low').replace('{recommended}', '4'),
    );
    expect(save().disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: t('web.qrt_preview_draft') }));
    await waitFor(() =>
      expect(
        posts(calls, '/delivery-qr/preview').some(
          (call) =>
            (call.body as { template: { quietZoneModules: number } | null }).template
              ?.quietZoneModules === 0,
        ),
      ).toBe(true),
    );
    // The draft's preview answered (it re-reads the background); 0 is still accepted.
    await waitFor(() => expect(save().disabled).toBe(false));
    expect(screen.queryByTestId('qrt-field-error')).toBeNull();

    fireEvent.click(save());
    await waitFor(() => expect(posts(calls, '/settings/delivery.qr_template')).toHaveLength(1));
    expect(posts(calls, '/settings/delivery.qr_template')[0]?.body).toMatchObject({
      value: { x: 100, y: 0, size: 400, quietZoneModules: 0 },
    });
  });

  it('accepts 16 and Persian ۰, refuses -1, 17 and 1.5 before saving', async () => {
    api({ media: MEDIA });
    renderPage(<QrTemplateSection mayEdit />);
    await waitFor(() =>
      expect(screen.getByTestId('qrt-background').textContent).toContain('800 × 700'),
    );
    const save = () => screen.getByRole('button', { name: t('web.qrt_save') }) as HTMLButtonElement;
    fireEvent.change(input('qrt-x'), { target: { value: '100' } });
    for (const refused of ['-1', '17', '1.5', '']) {
      fireEvent.change(input('qrt-quiet'), { target: { value: refused } });
      expect(screen.getByTestId('qrt-field-error').textContent, refused).toBe(
        t('web.qrt_invalid_fields'),
      );
      expect(save().disabled, refused).toBe(true);
      expect(screen.queryByTestId('qrt-quiet-warning'), refused).toBeNull();
    }
    for (const accepted of ['16', '1', '۰']) {
      fireEvent.change(input('qrt-quiet'), { target: { value: accepted } });
      await waitFor(() => expect(screen.queryByTestId('qrt-field-error'), accepted).toBeNull());
      expect(save().disabled, accepted).toBe(false);
    }
    expect(screen.getByTestId('qrt-quiet-warning')).toBeTruthy();
    fireEvent.change(input('qrt-quiet'), { target: { value: '16' } });
    expect(screen.queryByTestId('qrt-quiet-warning')).toBeNull();
  });

  it('shows a stored 0 as 0, and «وسط تصویر» proposes the recommended 4', async () => {
    api({ media: MEDIA, template: { ...TEMPLATE, quietZoneModules: 0 }, version: 2 });
    renderPage(<QrTemplateSection mayEdit />);
    await waitFor(() => expect(input('qrt-quiet').value).toBe('0'));
    expect(screen.getByTestId('qrt-quiet-warning')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('qrt-background').textContent).toContain('800 × 700'),
    );
    fireEvent.click(screen.getByRole('button', { name: t('web.qrt_centre') }));
    expect(input('qrt-quiet').value).toBe('4');
  });

  it('refuses a region whose modules Telegram would shrink under 4 px, before saving', async () => {
    api({ media: MEDIA, background: { width: 2048, height: 2048 } });
    renderPage(<QrTemplateSection mayEdit />);
    await waitFor(() =>
      expect(screen.getByTestId('qrt-background').textContent).toContain('2048 × 2048'),
    );
    // A typical link: 41 modules + 8 quiet. 294 px → 6 px modules → 3.75 px at 1280.
    fireEvent.change(input('qrt-size'), { target: { value: '294' } });
    expect((await screen.findByTestId('qrt-field-error')).textContent).toBe(t('web.qrt_too_small'));
    expect(
      (screen.getByRole('button', { name: t('web.qrt_save') }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(input('qrt-size'), { target: { value: '343' } });
    await waitFor(() => expect(screen.queryByTestId('qrt-field-error')).toBeNull());
  });

  it('refuses a region while there is no background to place it on', async () => {
    api();
    renderPage(<QrTemplateSection mayEdit />);
    await screen.findByTestId('qrt-preview');
    fireEvent.change(input('qrt-x'), { target: { value: '10' } });
    expect((await screen.findByTestId('qrt-field-error')).textContent).toBe(
      t('web.qrt_needs_background'),
    );
  });

  it('reverts to the default: the template cleared, then the background removed', async () => {
    const calls = api({ template: TEMPLATE, version: 4, media: MEDIA });
    renderPage(<QrTemplateSection mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.qrt_revert') }));
    await waitFor(() => expect(posts(calls, '/media/QR_BACKGROUND/clear')).toHaveLength(1));
    expect(posts(calls, '/settings/delivery.qr_template')[0]?.body).toMatchObject({
      value: null,
      expectedVersion: 4,
    });
    const order = calls.calls
      .filter((call) => call.method === 'POST' && !call.url.endsWith('/delivery-qr/preview'))
      .map((call) => call.url.replace(/^.*\/v1/u, ''));
    expect(order).toEqual(['/settings/delivery.qr_template', '/media/QR_BACKGROUND/clear']);
  });

  it('is read-only without settings.edit', async () => {
    api({ template: TEMPLATE, version: 4, media: MEDIA });
    renderPage(<QrTemplateSection mayEdit={false} />);
    expect(await screen.findByText(t('web.qrt_read_only'))).toBeTruthy();
    expect(document.getElementById('qrt-file')).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.qrt_save') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.qrt_revert') })).toBeNull();
  });
});
