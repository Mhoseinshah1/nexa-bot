import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ReferralsPage } from '../../apps/web/src/pages/referrals';
import { renderPage, stubApi, type Api } from './harness';

/**
 * The referral banner card on the Referrals page (customer UX §I, §L).
 *
 * Every response goes through the real client and `tenantMediaStateSchema`, so a fixture
 * that drifts from the contract fails here. What these cases hold: the card shows what
 * is STORED (type, size, version, digest — never bytes); a picked file is read in the
 * browser and sent as base64 under its declared type; clearing posts to the clear route;
 * and without `settings.edit` no control is drawn, without `settings.view` nothing is
 * even asked.
 */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_BYTES = new Uint8Array([...PNG_MAGIC, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString('base64');

const banner = (overrides: Record<string, unknown> = {}) => ({
  purpose: 'REFERRAL_BANNER',
  mimeType: 'image/png',
  byteLength: 24_576,
  sha256: 'a'.repeat(64),
  version: 3,
  updatedAt: '2026-09-10T12:30:00.000Z',
  ...overrides,
});

const routes = (media: Record<string, unknown> | null) => [
  { url: '/referrals', body: { referrals: [], nextCursor: null } },
  { url: '/referral-commissions', body: { commissions: [], nextCursor: null } },
  { url: '/media/REFERRAL_BANNER', body: { media } },
];

const render = (props: { mayViewBanner?: boolean; mayEditBanner?: boolean } = {}) =>
  renderPage(
    <ReferralsPage
      route={{ path: '/referrals', query: new URLSearchParams('') }}
      denied={false}
      mayViewBanner={props.mayViewBanner ?? true}
      mayEditBanner={props.mayEditBanner ?? true}
    />,
  );

const card = async () =>
  (await screen.findByRole('heading', { name: 'بنر معرفی' })).closest('section') as HTMLElement;

const posts = (api: Api, path: string) =>
  api.calls.filter((call) => call.method === 'POST' && call.url.endsWith(path));

describe('the referral banner card', () => {
  it('renders the stored metadata and never asks for the bytes', async () => {
    const api = stubApi(routes(banner()));
    render();
    const section = await card();
    expect(await within(section).findByText('PNG')).toBeInTheDocument();
    expect(within(section).getByText('3')).toBeInTheDocument();
    expect(within(section).getByText('a'.repeat(64))).toBeInTheDocument();
    // 24,576 bytes is 24 KiB, shown in the unit the contract's splitter chooses.
    expect(section.textContent).toContain('24');
    expect(api.calls.filter((call) => call.url.includes('/media/')).map((c) => c.method)).toEqual([
      'GET',
    ]);
  });

  it('says there is no banner rather than drawing an empty description list', async () => {
    stubApi(routes(null));
    render();
    const section = await card();
    expect(
      await within(section).findByText('بنری تنظیم نشده است؛ صفحهٔ معرفی بدون تصویر ارسال می‌شود.'),
    ).toBeInTheDocument();
    // Nothing to clear, so no clear button.
    expect(within(section).queryByRole('button', { name: 'حذف بنر' })).toBeNull();
  });

  it('reads the picked file in the browser and uploads it as base64 under its declared type', async () => {
    const api = stubApi(routes(null));
    render();
    const section = await card();
    const input = within(section).getByLabelText('فایل بنر') as HTMLInputElement;
    const upload = within(section).getByRole('button', { name: 'بارگذاری بنر' });
    expect(upload).toBeDisabled();

    const file = new File([PNG_BYTES], 'banner.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(upload).not.toBeDisabled());
    fireEvent.click(upload);

    await waitFor(() => expect(posts(api, '/media/REFERRAL_BANNER')).toHaveLength(1));
    const body = posts(api, '/media/REFERRAL_BANNER')[0]?.body as Record<string, unknown>;
    expect(body.mimeType).toBe('image/png');
    expect(body.contentBase64).toBe(PNG_BASE64);
    expect(typeof body.idempotencyKey).toBe('string');
    expect(await screen.findByText('بنر ذخیره شد.')).toBeInTheDocument();
  });

  it('refuses a file of another type before reading it, and sends nothing', async () => {
    const api = stubApi(routes(null));
    render();
    const section = await card();
    const input = within(section).getByLabelText('فایل بنر') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [new File([new Uint8Array([0x47, 0x49, 0x46])], 'x.gif', { type: 'image/gif' })],
      },
    });
    expect(await within(section).findByText('فقط PNG یا JPEG پذیرفته می‌شود.')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'بارگذاری بنر' })).toBeDisabled();
    expect(posts(api, '/media/REFERRAL_BANNER')).toHaveLength(0);
  });

  it('clears through the clear route', async () => {
    const api = stubApi(routes(banner()));
    render();
    const section = await card();
    fireEvent.click(await within(section).findByRole('button', { name: 'حذف بنر' }));
    await waitFor(() => expect(posts(api, '/media/REFERRAL_BANNER/clear')).toHaveLength(1));
    const body = posts(api, '/media/REFERRAL_BANNER/clear')[0]?.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['idempotencyKey']);
    expect(await screen.findByText('بنر حذف شد.')).toBeInTheDocument();
  });

  it('draws no control without settings.edit, and says why', async () => {
    const api = stubApi(routes(banner()));
    render({ mayEditBanner: false });
    const section = await card();
    expect(await within(section).findByText('PNG')).toBeInTheDocument();
    expect(within(section).queryByLabelText('فایل بنر')).toBeNull();
    expect(within(section).queryByRole('button', { name: 'حذف بنر' })).toBeNull();
    expect(
      within(section).getByText('برای تغییر بنر به مجوز ویرایش تنظیمات نیاز است.'),
    ).toBeInTheDocument();
    expect(posts(api, '/media/REFERRAL_BANNER')).toHaveLength(0);
  });

  it('asks nothing about the banner without settings.view', async () => {
    const api = stubApi(routes(banner()));
    render({ mayViewBanner: false, mayEditBanner: false });
    await screen.findByRole('heading', { name: 'قاعده‌هایی که این صفحه رعایت می‌کند' });
    expect(screen.queryByRole('heading', { name: 'بنر معرفی' })).toBeNull();
    expect(api.calls.filter((call) => call.url.includes('/media/'))).toHaveLength(0);
  });
});
