import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { DeliveryTutorialTab, draftErrors } from '../../apps/web/src/pages/delivery-tutorial';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Phase 2 item 5 on the Web Admin: one panel's post-delivery tutorial tab.
 *
 * The server decides; these tests hold what the screen does with it — show the stored
 * values, refuse a draft the server's schema would refuse before sending it, and send the
 * WHOLE tutorial (text and video kept even while the mode does not use them) with the
 * revision it was drawn from and an idempotency key.
 */
const PANEL = '019210ab-cdef-7012-8345-6789abcdef01';
const APP = '019210ab-cdef-7012-8345-6789abcdef0a';
const TEXT = 'کاربر گرامی، اتصال سرویس فقط از طریق Sing-box امکان‌پذیر است.';

const stored = (overrides: Record<string, unknown> = {}) => ({
  tutorial: {
    panelId: PANEL,
    mode: 'TEXT',
    text: TEXT,
    videoClientAppId: APP,
    appliesToPurchase: true,
    appliesToTrial: false,
    revision: 3,
    updatedAt: '2026-10-06T10:00:00.000Z',
    ...overrides,
  },
  videoOptions: [
    { clientAppId: APP, name: 'Sing-box', platform: 'ANDROID', enabled: true, botsWithVideo: 2 },
  ],
});

const route = `/panels/${PANEL}/delivery-tutorial`;

describe('the post-delivery tutorial tab', () => {
  it('shows what is stored and sends a partial edit whole, keeping the text and video', async () => {
    const api = stubApi([
      { url: route, method: 'GET', body: stored() },
      {
        url: route,
        method: 'POST',
        body: { ...stored({ mode: 'DISABLED', revision: 4 }), changed: true },
      },
    ]);
    renderPage(<DeliveryTutorialTab panelId={PANEL} mayEdit />);

    const text = (await screen.findByLabelText(
      new RegExp(t('web.delivery_tutorial_text')),
    )) as HTMLTextAreaElement;
    expect(text.value).toBe(TEXT);
    expect(
      (screen.getByLabelText(t('web.delivery_tutorial_mode')) as HTMLSelectElement).value,
    ).toBe('TEXT');

    fireEvent.change(screen.getByLabelText(t('web.delivery_tutorial_mode')), {
      target: { value: 'DISABLED' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    const sent = api.calls.find((call) => call.method === 'POST');
    expect(sent?.body).toMatchObject({
      expectedRevision: 3,
      mode: 'DISABLED',
      text: TEXT,
      videoClientAppId: APP,
      appliesToPurchase: true,
      appliesToTrial: false,
    });
    expect(typeof (sent?.body as { idempotencyKey?: unknown }).idempotencyKey).toBe('string');
  });

  it('refuses a draft without what its mode sends, and sends nothing', async () => {
    const api = stubApi([
      { url: route, method: 'GET', body: stored({ text: null, videoClientAppId: null }) },
    ]);
    renderPage(<DeliveryTutorialTab panelId={PANEL} mayEdit />);
    await screen.findByLabelText(t('web.delivery_tutorial_mode'));
    fireEvent.change(screen.getByLabelText(t('web.delivery_tutorial_mode')), {
      target: { value: 'VIDEO_TEXT' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    expect(await screen.findByText(t('web.delivery_tutorial_text_required'))).toBeInTheDocument();
    expect(screen.getByText(t('web.delivery_tutorial_video_required'))).toBeInTheDocument();
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('warns of the caption fallback by the length the server measures, markers as one emoji', async () => {
    // 1000 letters and ten markers: 1140 characters as typed, 1020 as drawn — it fits.
    const fits = `${'ا'.repeat(1000)}${'{icon:warning}'.repeat(10)}`;
    stubApi([{ url: route, method: 'GET', body: stored({ mode: 'VIDEO_TEXT', text: fits }) }]);
    const view = renderPage(<DeliveryTutorialTab panelId={PANEL} mayEdit />);
    await screen.findByLabelText(t('web.delivery_tutorial_mode'));
    expect(screen.queryByText(t('web.delivery_tutorial_caption_fallback'))).toBeNull();

    // Over the bound once drawn: the notice is shown.
    fireEvent.change(screen.getByLabelText(new RegExp(t('web.delivery_tutorial_text'))), {
      target: { value: `${fits}${'ب'.repeat(10)}` },
    });
    expect(screen.getByText(t('web.delivery_tutorial_caption_fallback'))).toBeInTheDocument();
    view.unmount();
  });

  it('a reader without panels.edit sees the tutorial and no save button', async () => {
    stubApi([{ url: route, method: 'GET', body: stored() }]);
    renderPage(<DeliveryTutorialTab panelId={PANEL} mayEdit={false} />);
    await screen.findByLabelText(t('web.delivery_tutorial_mode'));
    expect(screen.queryByRole('button', { name: t('web.save') })).toBeNull();
  });

  it('validates with the contract’s text rule: raw <tg-emoji> and unknown markers are refused', () => {
    const draft = {
      mode: 'TEXT' as const,
      videoClientAppId: '',
      appliesToPurchase: true,
      appliesToTrial: true,
    };
    expect(draftErrors({ ...draft, text: '<tg-emoji emoji-id="1">🔥</tg-emoji>' }).text).toBe(
      'web.delivery_tutorial_text_markup',
    );
    expect(draftErrors({ ...draft, text: '{icon:paymnt}' }).text).toBe(
      'web.delivery_tutorial_text_unknown_icon',
    );
    expect(draftErrors({ ...draft, text: '{icon:payment} ok' })).toEqual({});
    expect(
      draftErrors({ ...draft, appliesToPurchase: false, appliesToTrial: false, text: 'x' }).applies,
    ).toBe('web.delivery_tutorial_applies_required');
  });
});
