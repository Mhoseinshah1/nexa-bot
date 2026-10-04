import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CONTROL_ERROR_CODES,
  type ClientAppVideoSessionResponse,
  type ClientAppVideoSessionState,
} from '@nexa/contracts';
import {
  ApiError,
  cancelClientAppVideoSession,
  fetchClientAppVideoSession,
  fetchClientAppVideos,
  openClientAppVideoSession,
} from '../api/client';
import { formatNumber, formatTimestamp } from '../format';
import { pollUnlessFinalWhile } from '../polling';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { messageFor } from './settings';
import { Badge, Banner, Card } from '../ui/kit';

/**
 * UX Batch 01 item 6 — «افزودن ویدیو از تلگرام».
 *
 * The page asks the server for a prompt bound to this administrator, this bot and this app;
 * tells the administrator to send the video to that bot from their bound Telegram account,
 * with a link that opens the chat; and polls the prompt until it closes. The stored video
 * appears here on its own — nothing is copied by hand, and the bot-scoped `file_id` never
 * reaches the page. Whether a video is accepted is decided by the server and the bot, never
 * by what this screen draws.
 */

/** How often an OPEN prompt is asked again. */
export const VIDEO_SESSION_POLL_MS = 3_000;

const CLOSED_COPY: Readonly<Record<Exclude<ClientAppVideoSessionState, 'OPEN'>, WebKey>> = {
  CONFIRMED: 'web.client_apps_video_done',
  EXPIRED: 'web.client_apps_video_expired',
  CANCELLED: 'web.client_apps_video_cancelled',
  SUPERSEDED: 'web.client_apps_video_superseded',
};

function videoFault(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === CONTROL_ERROR_CODES.CLIENT_APP_VIDEO_TELEGRAM_UNLINKED) {
      return t('web.client_apps_video_unlinked');
    }
    if (error.code === CONTROL_ERROR_CODES.CLIENT_APP_VIDEO_BOT_UNAVAILABLE) {
      return t('web.client_apps_video_bot_unavailable');
    }
    if (error.code === CONTROL_ERROR_CODES.CLIENT_APP_VIDEO_SESSION_NOT_FOUND) {
      return t('web.client_apps_video_session_missing');
    }
  }
  return messageFor(error);
}

export function TutorialVideoCard({ appId, mayEdit }: { appId: string | null; mayEdit: boolean }) {
  if (appId === null) {
    return (
      <Card title={t('web.client_apps_video_title')} hint={t('web.client_apps_video_hint')}>
        <p className="muted">{t('web.client_apps_video_save_first')}</p>
      </Card>
    );
  }
  return <TutorialVideoSection appId={appId} mayEdit={mayEdit} />;
}

function TutorialVideoSection({ appId, mayEdit }: { appId: string; mayEdit: boolean }) {
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [sessionId, setSessionId] = useState<string | null>(null);

  const videos = useQuery({
    queryKey: ['client-app-videos', appId],
    queryFn: () => fetchClientAppVideos(appId),
  });

  const session = useQuery({
    queryKey: ['client-app-video-session', appId, sessionId],
    queryFn: () => fetchClientAppVideoSession(appId, sessionId as string),
    enabled: sessionId !== null,
    refetchInterval: pollUnlessFinalWhile<ClientAppVideoSessionResponse>(
      VIDEO_SESSION_POLL_MS,
      (data) => data.state === 'OPEN',
    ),
  });

  const open = useMutation({
    mutationFn: (botInstanceId: string) =>
      openClientAppVideoSession({
        id: appId,
        botInstanceId,
        idempotencyKey: submission.current({ videoSession: appId, botInstanceId }),
      }),
    onSuccess: (opened) => {
      submission.settle();
      queries.setQueryData(['client-app-video-session', appId, opened.sessionId], opened);
      setSessionId(opened.sessionId);
    },
    onError: (error) => submission.settleOn(error),
  });

  const cancel = useMutation({
    mutationFn: (id: string) =>
      cancelClientAppVideoSession({
        id: appId,
        sessionId: id,
        idempotencyKey: submission.current({ cancelVideoSession: id }),
      }),
    onSuccess: (closed) => {
      submission.settle();
      queries.setQueryData(['client-app-video-session', appId, closed.sessionId], closed);
    },
    onError: (error) => submission.settleOn(error),
  });

  const current = session.data;
  const state = current?.state;
  // A stored video changes the bots' list: read it again once, when the prompt closes.
  useEffect(() => {
    if (state === 'CONFIRMED') {
      void queries.invalidateQueries({ queryKey: ['client-app-videos', appId] });
    }
  }, [state, appId, queries]);

  const data = videos.data;
  const waiting = current !== undefined && current.state === 'OPEN';
  const busy = open.isPending || cancel.isPending;
  const failure = open.error ?? cancel.error ?? videos.error ?? session.error;

  return (
    <Card title={t('web.client_apps_video_title')} hint={t('web.client_apps_video_hint')}>
      {data !== undefined && !data.telegramLinked && mayEdit && (
        <Banner tone="warn">{t('web.client_apps_video_unlinked')}</Banner>
      )}

      {data !== undefined && (
        <ul className="client-app-video-bots" data-testid="client-app-video-bots">
          {data.bots.map((bot) => (
            <li key={bot.botInstanceId} className="client-app-video-bot">
              <div>
                <strong>{t('web.client_apps_video_bot')}</strong>{' '}
                <bdi dir="ltr">{`@${bot.username}`}</bdi>{' '}
                {!bot.active && (
                  <Badge tone="neutral">{t('web.client_apps_video_bot_stopped')}</Badge>
                )}
              </div>
              <div>
                <span className="muted">{t('web.client_apps_video_status')}: </span>
                {bot.video === null ? (
                  <Badge tone="neutral">{t('web.client_apps_video_none')}</Badge>
                ) : (
                  <>
                    <Badge tone="ok" dot>
                      {t('web.client_apps_video_set')}
                    </Badge>
                    {bot.video.durationSeconds !== null && (
                      <span className="muted small">
                        {' · '}
                        {t('web.client_apps_video_duration')}:{' '}
                        {formatNumber(bot.video.durationSeconds)}
                      </span>
                    )}
                    <span className="muted small">
                      {' · '}
                      {t('web.client_apps_video_updated')}: {formatTimestamp(bot.video.updatedAt)}
                    </span>
                  </>
                )}
              </div>
              {mayEdit && bot.active && data.telegramLinked && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy || waiting}
                  onClick={() => open.mutate(bot.botInstanceId)}
                >
                  {open.isPending && open.variables === bot.botInstanceId
                    ? t('web.client_apps_video_opening')
                    : bot.video === null
                      ? t('web.client_apps_video_add')
                      : t('web.client_apps_video_replace')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {current !== undefined && current.state === 'OPEN' && (
        <div
          className="client-app-video-waiting"
          role="status"
          data-testid="client-app-video-waiting"
        >
          <Banner tone="info" title={t('web.client_apps_video_waiting_title')}>
            <p>{t('web.client_apps_video_waiting')}</p>
            <p>
              <a href={current.chatUrl} target="_blank" rel="noopener noreferrer">
                {t('web.client_apps_video_open_bot')} <bdi dir="ltr">{`@${current.username}`}</bdi>
              </a>
            </p>
            <p className="muted small">
              {t('web.client_apps_video_expires')}: {formatTimestamp(current.expiresAt)}
            </p>
          </Banner>
          <div className="form-actions">
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => cancel.mutate(current.sessionId)}
            >
              {t('web.client_apps_video_cancel')}
            </button>
          </div>
        </div>
      )}

      {current !== undefined && current.state !== 'OPEN' && (
        <Banner
          tone={current.state === 'CONFIRMED' ? 'ok' : 'warn'}
          action={
            <button type="button" className="btn sm" onClick={() => setSessionId(null)}>
              {t('web.client_apps_video_close')}
            </button>
          }
        >
          {t(CLOSED_COPY[current.state])}
        </Banner>
      )}

      {failure != null && <Banner tone="danger">{videoFault(failure)}</Banner>}
    </Card>
  );
}
