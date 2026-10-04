import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { CONTROL_ERROR_CODES } from '@nexa/contracts';
import { TutorialVideoCard } from '../../apps/web/src/pages/client-app-video';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * UX Batch 01 item 6 — «افزودن ویدیو از تلگرام» on the client app's editor: the bots and
 * their videos, the button, the waiting instructions with the bot's chat link, the poll that
 * shows the stored video without any copying, cancel, and the server's refusals in Persian.
 */
const APP_ID = '019250ab-cdef-7012-8345-6789abcdef21';
const BOT_ID = '01900000-0000-7000-8000-00000000a001';
const STOPPED_BOT = '01900000-0000-7000-8000-00000000a002';
const SESSION_ID = '019250ab-cdef-7012-8345-6789abcdef99';

const bots = (linked: boolean, video: Record<string, unknown> | null = null) => ({
  telegramLinked: linked,
  bots: [
    {
      botInstanceId: BOT_ID,
      username: 'acme_store_bot',
      chatUrl: 'https://t.me/acme_store_bot',
      active: true,
      video,
    },
    {
      botInstanceId: STOPPED_BOT,
      username: 'acme_support_bot',
      chatUrl: 'https://t.me/acme_support_bot',
      active: false,
      video: null,
    },
  ],
});
const VIDEO = {
  fileUniqueId: 'AgADuniq',
  mimeType: 'video/mp4',
  durationSeconds: 42,
  fileSize: '1048576',
  updatedAt: '2026-10-04T10:00:00.000Z',
};
const session = (state: string, video: Record<string, unknown> | null = null) => ({
  sessionId: SESSION_ID,
  botInstanceId: BOT_ID,
  username: 'acme_store_bot',
  chatUrl: 'https://t.me/acme_store_bot',
  state,
  openedAt: '2026-10-04T10:00:00.000Z',
  expiresAt: '2026-10-04T10:15:00.000Z',
  video,
});

afterEach(() => {
  vi.restoreAllMocks();
});

const base = `/client-apps/${APP_ID}`;

describe('the tutorial video card', () => {
  it('asks to save the entry first when it is new', () => {
    renderPage(<TutorialVideoCard appId={null} mayEdit />);
    expect(screen.getByText(t('web.client_apps_video_save_first'))).toBeInTheDocument();
  });

  it('lists each bot with its video, and offers the button only for an active bot', async () => {
    stubApi([{ url: `${base}/videos`, body: bots(true) }]);
    renderPage(<TutorialVideoCard appId={APP_ID} mayEdit />);
    expect(await screen.findByText('@acme_store_bot')).toBeInTheDocument();
    expect(screen.getByText('@acme_support_bot')).toBeInTheDocument();
    expect(screen.getByText(t('web.client_apps_video_bot_stopped'))).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: t('web.client_apps_video_add') })).toHaveLength(1);
  });

  it('tells an administrator with no Telegram binding why, and offers no button', async () => {
    stubApi([{ url: `${base}/videos`, body: bots(false) }]);
    renderPage(<TutorialVideoCard appId={APP_ID} mayEdit />);
    expect(await screen.findByText(t('web.client_apps_video_unlinked'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.client_apps_video_add') })).toBeNull();
  });

  it('offers nothing to a view-only administrator', async () => {
    stubApi([{ url: `${base}/videos`, body: bots(true) }]);
    renderPage(<TutorialVideoCard appId={APP_ID} mayEdit={false} />);
    await screen.findByText('@acme_store_bot');
    expect(screen.queryByRole('button', { name: t('web.client_apps_video_add') })).toBeNull();
  });

  it('opens a prompt, shows the bot’s chat link, and shows the stored video once the poll sees it', async () => {
    const videosRoute = { url: `${base}/videos`, body: bots(true) as unknown };
    const sessionRoute = {
      url: `${base}/video-sessions/${SESSION_ID}`,
      body: session('OPEN') as unknown,
    };
    const api = stubApi([
      videosRoute,
      { url: `${base}/video-sessions`, body: session('OPEN') },
      sessionRoute,
    ]);
    renderPage(<TutorialVideoCard appId={APP_ID} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_video_add') }));

    expect(await screen.findByText(t('web.client_apps_video_waiting'))).toBeInTheDocument();
    const link = screen.getByRole('link', {
      name: new RegExp(t('web.client_apps_video_open_bot')),
    });
    expect(link).toHaveAttribute('href', 'https://t.me/acme_store_bot');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    const opened = api.calls.find(
      (call) => call.method === 'POST' && call.url.endsWith(`${base}/video-sessions`),
    );
    expect(opened?.body).toMatchObject({ botInstanceId: BOT_ID });
    expect(typeof (opened?.body as { idempotencyKey?: unknown }).idempotencyKey).toBe('string');
    // While waiting, no second prompt can be opened.
    expect(screen.getByRole('button', { name: t('web.client_apps_video_add') })).toBeDisabled();

    // The administrator sends the video in Telegram; the server now reads it CONFIRMED.
    sessionRoute.body = session('CONFIRMED', VIDEO);
    videosRoute.body = bots(true, VIDEO);
    expect(
      await screen.findByText(t('web.client_apps_video_done'), {}, { timeout: 8_000 }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(t('web.client_apps_video_set'))).toBeInTheDocument(),
    );
    // Nothing to copy: no Telegram identifier is shown.
    expect(document.body.textContent).not.toContain('AgADuniq');
    expect(screen.queryByText(t('web.client_apps_video_waiting'))).toBeNull();
  }, 15_000);

  it('cancels the prompt and says nothing was stored', async () => {
    const api = stubApi([
      { url: `${base}/videos`, body: bots(true) },
      { url: `${base}/video-sessions`, body: session('OPEN') },
      { url: `${base}/video-sessions/${SESSION_ID}`, body: session('OPEN') },
      { url: `${base}/video-sessions/${SESSION_ID}/cancel`, body: session('CANCELLED') },
    ]);
    renderPage(<TutorialVideoCard appId={APP_ID} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_video_add') }));
    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_video_cancel') }));
    expect(await screen.findByText(t('web.client_apps_video_cancelled'))).toBeInTheDocument();
    expect(api.calls.some((call) => call.method === 'POST' && call.url.endsWith('/cancel'))).toBe(
      true,
    );
  });

  it('says when the prompt timed out', async () => {
    stubApi([
      { url: `${base}/videos`, body: bots(true) },
      { url: `${base}/video-sessions`, body: session('OPEN') },
      { url: `${base}/video-sessions/${SESSION_ID}`, body: session('EXPIRED') },
    ]);
    renderPage(<TutorialVideoCard appId={APP_ID} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_video_add') }));
    expect(
      await screen.findByText(t('web.client_apps_video_expired'), {}, { timeout: 8_000 }),
    ).toBeInTheDocument();
  }, 15_000);

  it('shows the server’s refusal in Persian', async () => {
    stubApi([
      { url: `${base}/videos`, body: bots(true) },
      {
        url: `${base}/video-sessions`,
        status: 409,
        body: {
          error: {
            kind: 'conflict',
            code: CONTROL_ERROR_CODES.CLIENT_APP_VIDEO_TELEGRAM_UNLINKED,
            message: 'This administrator has no Telegram account bound.',
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(<TutorialVideoCard appId={APP_ID} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.client_apps_video_add') }));
    expect(await screen.findByText(t('web.client_apps_video_unlinked'))).toBeInTheDocument();
    expect(screen.queryByText(/no Telegram account/)).toBeNull();
  });
});
