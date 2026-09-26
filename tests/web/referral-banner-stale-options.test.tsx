import { describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ReferralsPage } from '../../apps/web/src/pages/referrals';
import { renderPage, stubApi } from './harness';
import type * as ReactQuery from '@tanstack/react-query';

/**
 * The referral banner upload must not depend on WHEN useMutation refreshes its options.
 *
 * useMutation gives its observer a new mutationFn in an effect, not during render, so a
 * click can land after the commit that enabled the button and before that effect. On a
 * loaded CI runner that happened: the click ran the previous closure — the one that saw
 * no file — and the card reported a server error for a file the operator had picked.
 *
 * This file pins the options to the FIRST render's, which is that window held open. The
 * upload must still send the picked file, which it can only do if the file travels as
 * the mutation's variable.
 */
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useMutation: (options: Parameters<typeof actual.useMutation>[0]) => {
      const first = useRef(options);
      return actual.useMutation(first.current);
    },
  };
});

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

describe('the referral banner upload under stale mutation options', () => {
  it('sends the picked file even when the mutation still holds the first render’s options', async () => {
    const api = stubApi([
      { url: '/referrals', body: { referrals: [], nextCursor: null } },
      { url: '/referral-commissions', body: { commissions: [], nextCursor: null } },
      { url: '/media/REFERRAL_BANNER', body: { media: null } },
    ]);
    renderPage(
      <ReferralsPage
        route={{ path: '/referrals', query: new URLSearchParams('') }}
        denied={false}
        mayViewBanner
        mayEditBanner
      />,
    );
    const section = (await screen.findByRole('heading', { name: 'بنر معرفی' })).closest(
      'section',
    ) as HTMLElement;
    const input = within(section).getByLabelText('فایل بنر') as HTMLInputElement;
    const upload = within(section).getByRole('button', { name: 'بارگذاری بنر' });

    fireEvent.change(input, {
      target: { files: [new File([PNG_BYTES], 'banner.png', { type: 'image/png' })] },
    });
    await waitFor(() => expect(upload).not.toBeDisabled());
    fireEvent.click(upload);

    await waitFor(() =>
      expect(
        api.calls.filter(
          (call) => call.method === 'POST' && call.url.endsWith('/media/REFERRAL_BANNER'),
        ),
      ).toHaveLength(1),
    );
    const body = api.calls.find((call) => call.method === 'POST')?.body as Record<string, unknown>;
    expect(body.contentBase64).toBe(Buffer.from(PNG_BYTES).toString('base64'));
    expect(within(section).queryByText('خطا در ارتباط با سرور')).toBeNull();
  });
});
