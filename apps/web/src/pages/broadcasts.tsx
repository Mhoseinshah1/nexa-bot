import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BROADCAST_BODY_DEFINITION,
  BROADCAST_BUTTONS_MAX,
  BROADCAST_BUTTON_LABEL_MAX_LENGTH,
  BROADCAST_CAPTION_MAX_LENGTH,
  BROADCAST_CONTENT_KINDS,
  BROADCAST_LARGE_AUDIENCE,
  BROADCAST_MEDIA_TYPES,
  BROADCAST_RECIPIENT_STATES,
  BROADCAST_TEXT_MAX_LENGTH,
  BROADCAST_TITLE_MAX_LENGTH,
  broadcastMediaType,
  type AudiencePreview,
  type BroadcastContentKind,
  type BroadcastRecipientState,
  type BroadcastResponseItem,
  type BroadcastState,
} from '@nexa/contracts';
import { renderTemplateBody } from '@nexa/i18n';
import {
  ApiError,
  createBroadcast,
  fetchBroadcast,
  fetchBroadcastRecipients,
  fetchBroadcasts,
  launchBroadcast,
  previewBroadcast,
  removeBroadcastMedia,
  steerBroadcast,
  testBroadcast,
  updateBroadcast,
  uploadBroadcastMedia,
} from '../api/client';
import { formatNumber, formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { navigate, setQuery, useLinkHandler, type Route } from '../router';
import { useSubmissionKey } from '../submission-key';
import {
  Badge,
  Banner,
  Card,
  CursorPager,
  DataTable,
  Empty,
  Field,
  KV,
  PageHead,
  StateSwitch,
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';
import { messageFor } from './settings';
import {
  AudienceBuilder,
  EMPTY_AUDIENCE,
  audienceMessage,
  describeAudience,
  draftOf,
  type AudienceDraft,
} from './audience-builder';

/**
 * «ارسال همگانی» — Broadcast (round N, B1).
 *
 * The list, a composer that is also the draft's editor, the confirmation and the delivery
 * report. Everything the server charges is drawn on the same key: `broadcasts.view` reads,
 * `broadcasts.send` composes, launches and steers. The preview is the operator's own text
 * rendered by the SAME renderer and placeholder catalogue the bot uses; the real preview is a
 * test sent to the operator's own Telegram.
 */

export const BROADCAST_STATE_LABELS: Readonly<Record<BroadcastState, WebKey>> = {
  DRAFT: 'web.bc_state_draft',
  SCHEDULED: 'web.bc_state_scheduled',
  SENDING: 'web.bc_state_sending',
  PAUSED: 'web.bc_state_paused',
  COMPLETED: 'web.bc_state_completed',
  CANCELLED: 'web.bc_state_cancelled',
};
const STATE_TONES: Readonly<Record<BroadcastState, Tone>> = {
  DRAFT: 'neutral',
  SCHEDULED: 'info',
  SENDING: 'warn',
  PAUSED: 'warn',
  COMPLETED: 'ok',
  CANCELLED: 'neutral',
};
const KIND_LABELS: Readonly<Record<BroadcastContentKind, WebKey>> = {
  TEXT: 'web.bc_kind_text',
  PHOTO: 'web.bc_kind_photo',
  VIDEO: 'web.bc_kind_video',
  DOCUMENT: 'web.bc_kind_document',
};
const RECIPIENT_LABELS: Readonly<Record<BroadcastRecipientState, WebKey>> = {
  PENDING: 'web.bc_r_pending',
  SENDING: 'web.bc_r_sending',
  SENT: 'web.bc_r_sent',
  UNCONFIRMED: 'web.bc_r_unconfirmed',
  FAILED: 'web.bc_r_failed',
  UNREACHABLE: 'web.bc_r_unreachable',
  SKIPPED: 'web.bc_r_skipped',
  CANCELLED: 'web.bc_r_cancelled',
};

/** This page's error sentences, for the codes the broadcast routes answer with. */
export function broadcastMessage(error: unknown): string {
  const audience = audienceMessage(error);
  if (audience !== null) return audience;
  if (error instanceof ApiError) {
    const known: Record<string, WebKey> = {
      'broadcast.state_conflict': 'web.bc_error_state',
      'broadcast.version_conflict': 'web.bc_error_version',
      'broadcast.body_invalid': 'web.bc_error_body',
      'broadcast.media_required': 'web.bc_error_media_required',
      'broadcast.media_refused': 'web.bc_error_media_refused',
      'broadcast.media_storage_full': 'web.bc_error_media_full',
      'broadcast.media_expired': 'web.bc_error_media_expired',
      'broadcast.confirmation_required': 'web.bc_error_confirmation',
      'broadcast.schedule_invalid': 'web.bc_error_schedule',
      'broadcast.test_target_unavailable': 'web.bc_error_test_target',
    };
    const key = known[error.code];
    if (key !== undefined) return t(key);
  }
  return messageFor(error);
}

export function BroadcastsPage({
  route,
  denied,
  maySend,
}: {
  route: Route;
  denied: boolean;
  maySend: boolean;
}) {
  const onLink = useLinkHandler();
  const cursor = route.query.get('cursor');
  const list = useQuery({
    queryKey: ['broadcasts', cursor],
    queryFn: () => fetchBroadcasts(cursor === null ? {} : { cursor }),
    enabled: !denied,
  });
  const columns: readonly Column<BroadcastResponseItem>[] = [
    {
      key: 'title',
      header: t('web.bc_title'),
      render: (row) => (
        <a href={`/broadcasts/${encodeURIComponent(row.id)}`} onClick={onLink}>
          {row.title}
        </a>
      ),
    },
    {
      key: 'state',
      header: t('web.bc_state'),
      render: (row) => (
        <Badge tone={STATE_TONES[row.state]}>{t(BROADCAST_STATE_LABELS[row.state])}</Badge>
      ),
    },
    { key: 'kind', header: t('web.bc_kind'), render: (row) => t(KIND_LABELS[row.contentKind]) },
    {
      key: 'recipients',
      header: t('web.bc_recipients'),
      render: (row) => (row.recipientCount === null ? '—' : formatNumber(row.recipientCount)),
    },
    {
      key: 'progress',
      header: t('web.bc_progress'),
      render: (row) =>
        row.progressPercent === null ? '—' : `${formatNumber(row.progressPercent)}%`,
    },
    {
      key: 'created',
      header: t('web.bc_created'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.createdAt)}</span>,
    },
  ];
  return (
    <>
      <PageHead
        title={t('web.bc_page_title')}
        subtitle={t('web.bc_page_intro')}
        maturity="now"
        actions={
          maySend ? (
            <a className="btn primary sm" href="/broadcasts/new" onClick={onLink}>
              {t('web.bc_new')}
            </a>
          ) : undefined
        }
      />
      <Card>
        <StateSwitch query={list} denied={denied}>
          {list.data === undefined ? null : list.data.broadcasts.length === 0 ? (
            <Empty title={t('web.bc_empty')} />
          ) : (
            <>
              <DataTable
                caption={t('web.bc_page_title')}
                columns={columns}
                rows={list.data.broadcasts}
                rowKey={(row) => row.id}
              />
              <CursorPager
                shown={list.data.broadcasts.length}
                hasPrevious={cursor !== null}
                hasNext={list.data.nextCursor !== null}
                onPrevious={() => setQuery(route, 'cursor', null)}
                onNext={() => setQuery(route, 'cursor', list.data?.nextCursor ?? null)}
              />
            </>
          )}
        </StateSwitch>
      </Card>
    </>
  );
}

/** A new broadcast: the composer with nothing in it. */
export function BroadcastNewPage({ maySend }: { maySend: boolean }) {
  if (!maySend) {
    return (
      <Card>
        <Banner tone="info">{t('web.no_permission')}</Banner>
      </Card>
    );
  }
  return (
    <>
      <PageHead title={t('web.bc_new')} subtitle={t('web.bc_page_intro')} />
      <Composer record={null} />
    </>
  );
}

interface ComposerState {
  title: string;
  contentKind: BroadcastContentKind;
  body: string;
  buttons: { label: string; url: string }[];
  audience: AudienceDraft;
}

function initial(record: BroadcastResponseItem | null): ComposerState {
  return record === null
    ? { title: '', contentKind: 'TEXT', body: '', buttons: [], audience: EMPTY_AUDIENCE }
    : {
        title: record.title,
        contentKind: record.contentKind,
        body: record.body,
        buttons: record.buttons.map((button) => ({ ...button })),
        audience: draftOf(record.audience),
      };
}

/** The operator's own text, rendered by the bot's renderer for a sample recipient. */
export function renderBroadcastPreview(body: string): string {
  return renderTemplateBody(BROADCAST_BODY_DEFINITION, body, {
    firstName: t('web.bc_sample_name'),
    username: 'sample_user',
  });
}

function Composer({
  record,
  onDirtyChange,
}: {
  record: BroadcastResponseItem | null;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [state, setState] = useState<ComposerState>(() => initial(record));
  // Unsaved edits, compared with what the saved draft holds. The detail page blocks media
  // actions while this is true: a media change bumps the version, the composer remounts on
  // it, and the edits would be dropped (Codex R5 on PR #117).
  const dirty = JSON.stringify(state) !== JSON.stringify(initial(record));
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  const toast = useToast();
  const client = useQueryClient();
  const submission = useSubmissionKey();
  const set = (patch: Partial<ComposerState>) => setState((current) => ({ ...current, ...patch }));
  const max =
    state.contentKind === 'TEXT' ? BROADCAST_TEXT_MAX_LENGTH : BROADCAST_CAPTION_MAX_LENGTH;

  const save = useMutation({
    mutationFn: () => {
      const content = {
        title: state.title,
        contentKind: state.contentKind,
        body: state.body,
        buttons: state.buttons.filter(
          (button) => button.label.trim() !== '' || button.url.trim() !== '',
        ),
        audience: state.audience,
      };
      return record === null
        ? createBroadcast({ ...content, idempotencyKey: submission.current(content) })
        : updateBroadcast(record.id, { ...content, expectedVersion: record.version });
    },
    onSuccess: (response) => {
      submission.settle();
      toast({ tone: 'ok', message: t('web.bc_saved') });
      void client.invalidateQueries({ queryKey: ['broadcasts'] });
      void client.invalidateQueries({ queryKey: ['broadcast', response.broadcast.id] });
      if (record === null) navigate(`/broadcasts/${encodeURIComponent(response.broadcast.id)}`);
    },
    onError: (error) => submission.settleOn(error),
  });

  return (
    <Card title={t('web.bc_composer')}>
      <div className="grid-2">
        <Field label={t('web.bc_title')} htmlFor="bc-title" hint={t('web.bc_title_hint')}>
          <input
            id="bc-title"
            value={state.title}
            maxLength={BROADCAST_TITLE_MAX_LENGTH}
            onChange={(event) => set({ title: event.target.value })}
          />
        </Field>
        <Field label={t('web.bc_kind')} htmlFor="bc-kind">
          <select
            id="bc-kind"
            value={state.contentKind}
            onChange={(event) => set({ contentKind: event.target.value as BroadcastContentKind })}
          >
            {BROADCAST_CONTENT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(KIND_LABELS[kind])}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field
        label={state.contentKind === 'TEXT' ? t('web.bc_body') : t('web.bc_caption')}
        htmlFor="bc-body"
        hint={t('web.bc_placeholders_hint')}
      >
        <textarea
          id="bc-body"
          rows={6}
          dir="auto"
          value={state.body}
          maxLength={max}
          onChange={(event) => set({ body: event.target.value })}
        />
      </Field>
      <p className="muted small">
        {t('web.bc_placeholders')}: <code>{'{firstName}'}</code> {t('web.bc_ph_first_name')} ·{' '}
        <code>{'{username}'}</code> {t('web.bc_ph_username')} · <code>{'{walletBalance}'}</code>{' '}
        {t('web.bc_ph_wallet')}
      </p>
      <h3>{t('web.bc_buttons')}</h3>
      {state.buttons.map((button, index) => (
        <div className="grid-2" key={index}>
          <Field label={t('web.bc_button_label')} htmlFor={`bc-btn-label-${String(index)}`}>
            <input
              id={`bc-btn-label-${String(index)}`}
              value={button.label}
              maxLength={BROADCAST_BUTTON_LABEL_MAX_LENGTH}
              onChange={(event) =>
                set({
                  buttons: state.buttons.map((item, at) =>
                    at === index ? { ...item, label: event.target.value } : item,
                  ),
                })
              }
            />
          </Field>
          <Field label={t('web.bc_button_url')} htmlFor={`bc-btn-url-${String(index)}`}>
            <input
              id={`bc-btn-url-${String(index)}`}
              dir="ltr"
              value={button.url}
              onChange={(event) =>
                set({
                  buttons: state.buttons.map((item, at) =>
                    at === index ? { ...item, url: event.target.value } : item,
                  ),
                })
              }
            />
          </Field>
        </div>
      ))}
      <div className="toolbar">
        <button
          type="button"
          className="btn sm"
          disabled={state.buttons.length >= BROADCAST_BUTTONS_MAX}
          onClick={() => set({ buttons: [...state.buttons, { label: '', url: 'https://' }] })}
        >
          {t('web.bc_button_add')}
        </button>
        {state.buttons.length > 0 && (
          <button
            type="button"
            className="btn sm"
            onClick={() => set({ buttons: state.buttons.slice(0, -1) })}
          >
            {t('web.bc_button_remove')}
          </button>
        )}
      </div>

      <h3>{t('web.bc_preview')}</h3>
      <div className="broadcast-preview" dir="auto">
        {state.body.trim() === '' ? (
          <span className="faint">{t('web.bc_preview_empty')}</span>
        ) : (
          <pre className="preview-text">{renderBroadcastPreview(state.body)}</pre>
        )}
        {state.buttons
          .filter((button) => button.label.trim() !== '')
          .map((button, index) => (
            <div className="btn sm" key={index}>
              {button.label}
            </div>
          ))}
      </div>
      <p className="muted small">{t('web.bc_preview_hint')}</p>

      <h3>{t('web.bc_audience')}</h3>
      <AudienceBuilder value={state.audience} onChange={(audience) => set({ audience })} />

      <div className="toolbar">
        <button
          type="button"
          className="btn primary"
          disabled={save.isPending || state.title.trim() === ''}
          onClick={() => save.mutate()}
        >
          {record === null ? t('web.bc_create') : t('web.bc_save')}
        </button>
      </div>
      {save.error !== null && <Banner tone="danger">{broadcastMessage(save.error)}</Banner>}
    </Card>
  );
}

/** Reads the picked file as base64, checked against the same allow-list the server uses. */
function readMedia(
  file: File,
): Promise<{ mimeType: string; fileName: string; contentBase64: string } | null> {
  const type = broadcastMediaType(file.type);
  if (type === undefined || file.size > type.maxBytes) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      const comma = url.indexOf(',');
      resolve(
        comma < 0
          ? null
          : { mimeType: file.type, fileName: file.name, contentBase64: url.slice(comma + 1) },
      );
    };
    reader.readAsDataURL(file);
  });
}

function MediaCard({
  record,
  blocked,
}: {
  record: BroadcastResponseItem;
  /** The composer holds unsaved edits: changing the file now would discard them. */
  blocked: boolean;
}) {
  const client = useQueryClient();
  const [rejected, setRejected] = useState(false);
  const refresh = () => void client.invalidateQueries({ queryKey: ['broadcast', record.id] });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const picked = await readMedia(file);
      if (picked === null) {
        setRejected(true);
        return null;
      }
      setRejected(false);
      return uploadBroadcastMedia(record.id, picked);
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => removeBroadcastMedia(record.id),
    onSuccess: refresh,
  });
  if (record.contentKind === 'TEXT') return null;
  const accept = BROADCAST_MEDIA_TYPES.filter((type) => type.kind === record.contentKind)
    .map((type) => type.mimeType)
    .join(',');
  return (
    <Card title={t('web.bc_media')} hint={t('web.bc_media_hint')}>
      {record.media === null ? (
        <Banner tone="warn">{t('web.bc_media_missing')}</Banner>
      ) : (
        <KV
          items={[
            [t('web.bc_media_name'), record.media.fileName],
            [t('web.bc_media_size'), formatNumber(record.media.byteLength)],
            [
              t('web.bc_media_available'),
              record.media.available ? t('web.bc_yes') : t('web.bc_media_expired'),
            ],
          ]}
        />
      )}
      {blocked && <Banner tone="warn">{t('web.bc_media_save_first')}</Banner>}
      <input
        type="file"
        aria-label={t('web.bc_media_pick')}
        accept={accept}
        disabled={blocked || upload.isPending}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) upload.mutate(file);
        }}
      />
      {record.media !== null && (
        <button
          type="button"
          className="btn sm"
          disabled={blocked || remove.isPending}
          onClick={() => remove.mutate()}
        >
          {t('web.bc_media_remove')}
        </button>
      )}
      {rejected && <Banner tone="danger">{t('web.bc_error_media_refused')}</Banner>}
      {upload.error !== null && <Banner tone="danger">{broadcastMessage(upload.error)}</Banner>}
    </Card>
  );
}

function LaunchCard({ record }: { record: BroadcastResponseItem }) {
  const client = useQueryClient();
  const toast = useToast();
  const submission = useSubmissionKey();
  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [typed, setTyped] = useState('');
  const [mode, setMode] = useState<'NOW' | 'SCHEDULE'>('NOW');
  const [scheduledAt, setScheduledAt] = useState('');
  const count = useMutation({
    mutationFn: () => previewBroadcast(record.id),
    onSuccess: (response) => {
      setPreview(response.preview);
      setConfirmed(false);
      setTyped('');
    },
  });
  const test = useMutation({
    mutationFn: () => testBroadcast(record.id),
    onSuccess: (response) =>
      toast(
        response.outcome === 'SENT'
          ? { tone: 'ok', message: t('web.bc_test_sent') }
          : { tone: 'warn', message: t('web.bc_test_not_sent') },
      ),
  });
  const large = preview !== null && preview.customers >= BROADCAST_LARGE_AUDIENCE;
  const launch = useMutation({
    mutationFn: () => {
      if (preview === null) throw new Error('no preview');
      const input = {
        mode,
        scheduledAt: mode === 'SCHEDULE' ? new Date(scheduledAt).toISOString() : null,
        expectedVersion: record.version,
        expectedDefinitionHash: preview.definitionHash,
        expectedRecipients: preview.customers,
        expectedFingerprint: preview.fingerprint,
        typedCount: large ? Number(typed) : null,
      };
      return launchBroadcast(record.id, { ...input, idempotencyKey: submission.current(input) });
    },
    onSuccess: () => {
      submission.settle();
      toast({ tone: 'ok', message: t('web.bc_launched') });
      void client.invalidateQueries({ queryKey: ['broadcast', record.id] });
      void client.invalidateQueries({ queryKey: ['broadcasts'] });
    },
    onError: (error) => {
      submission.settleOn(error);
      setPreview(null);
    },
  });
  const ready =
    preview !== null &&
    preview.customers > 0 &&
    confirmed &&
    (!large || typed.trim() === String(preview.customers)) &&
    (mode === 'NOW' || scheduledAt !== '');
  return (
    <Card title={t('web.bc_launch')} hint={t('web.bc_launch_hint')}>
      <div className="toolbar">
        <button
          type="button"
          className="btn sm"
          disabled={test.isPending}
          onClick={() => test.mutate()}
        >
          {t('web.bc_test')}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={count.isPending}
          onClick={() => count.mutate()}
        >
          {t('web.bc_count')}
        </button>
      </div>
      {test.error !== null && <Banner tone="danger">{broadcastMessage(test.error)}</Banner>}
      {count.error !== null && <Banner tone="danger">{broadcastMessage(count.error)}</Banner>}
      {preview !== null && (
        <>
          <KV
            items={[
              [t('web.bc_recipients'), formatNumber(preview.customers)],
              [t('web.aud_count_reachable'), formatNumber(preview.reachable)],
              [t('web.bc_as_of'), formatTimestamp(preview.asOf)],
            ]}
          />
          {preview.customers === 0 ? (
            <Banner tone="info">{t('web.aud_error_empty')}</Banner>
          ) : (
            <>
              <Field label={t('web.bc_mode')} htmlFor="bc-mode">
                <select
                  id="bc-mode"
                  value={mode}
                  onChange={(event) => setMode(event.target.value as 'NOW' | 'SCHEDULE')}
                >
                  <option value="NOW">{t('web.bc_mode_now')}</option>
                  <option value="SCHEDULE">{t('web.bc_mode_schedule')}</option>
                </select>
              </Field>
              {mode === 'SCHEDULE' && (
                <Field label={t('web.bc_schedule_at')} htmlFor="bc-at">
                  <input
                    id="bc-at"
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(event) => setScheduledAt(event.target.value)}
                  />
                </Field>
              )}
              <Banner tone="warn">{t('web.bc_freeze_note')}</Banner>
              <label className="checks">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={() => setConfirmed(!confirmed)}
                />{' '}
                {t('web.bc_confirm_check')}
              </label>
              {large && (
                <Field label={t('web.bc_confirm_typed')} htmlFor="bc-typed">
                  <input
                    id="bc-typed"
                    inputMode="numeric"
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                  />
                </Field>
              )}
              <div className="toolbar">
                <button
                  type="button"
                  className="btn danger"
                  disabled={!ready || launch.isPending}
                  onClick={() => launch.mutate()}
                >
                  {mode === 'NOW' ? t('web.bc_send_now') : t('web.bc_schedule')}
                </button>
              </div>
            </>
          )}
        </>
      )}
      {launch.error !== null && <Banner tone="danger">{broadcastMessage(launch.error)}</Banner>}
    </Card>
  );
}

function ReportCard({ record, maySend }: { record: BroadcastResponseItem; maySend: boolean }) {
  const client = useQueryClient();
  const steer = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'cancel' | 'retryFailed') =>
      steerBroadcast(record.id, action),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['broadcast', record.id] }),
  });
  const [cancelAsked, setCancelAsked] = useState(false);
  const c = record.counts;
  return (
    <Card title={t('web.bc_report')}>
      <div className="stats">
        <KV
          items={[
            [t('web.bc_total'), formatNumber(c.total)],
            [t('web.bc_r_pending'), formatNumber(c.pending + c.sending)],
            [t('web.bc_r_sent'), formatNumber(c.sent)],
            [t('web.bc_r_failed'), formatNumber(c.failed)],
            [t('web.bc_r_unreachable'), formatNumber(c.unreachable)],
            [t('web.bc_r_unconfirmed'), formatNumber(c.unconfirmed)],
            [t('web.bc_r_skipped'), formatNumber(c.skipped)],
            [t('web.bc_r_cancelled'), formatNumber(c.cancelled)],
            [
              t('web.bc_progress'),
              record.progressPercent === null ? '—' : `${formatNumber(record.progressPercent)}%`,
            ],
          ]}
        />
      </div>
      <progress max={100} value={record.progressPercent ?? 0} aria-label={t('web.bc_progress')} />
      {record.state === 'PAUSED' && record.pauseReason === 'BOT_UNAVAILABLE' && (
        <Banner tone="danger">{t('web.bc_paused_bot')}</Banner>
      )}
      <p className="muted small">{t('web.bc_unconfirmed_hint')}</p>
      {maySend && (
        <div className="toolbar">
          {record.state === 'SENDING' && (
            <button type="button" className="btn sm" onClick={() => steer.mutate('pause')}>
              {t('web.bc_pause')}
            </button>
          )}
          {record.state === 'PAUSED' && (
            <button type="button" className="btn sm" onClick={() => steer.mutate('resume')}>
              {t('web.bc_resume')}
            </button>
          )}
          {c.failed > 0 && ['SENDING', 'PAUSED', 'COMPLETED'].includes(record.state) && (
            <button type="button" className="btn sm" onClick={() => steer.mutate('retryFailed')}>
              {t('web.bc_retry_failed')}
            </button>
          )}
          {['SCHEDULED', 'SENDING', 'PAUSED'].includes(record.state) &&
            (cancelAsked ? (
              <>
                <span className="small">{t('web.bc_cancel_question')}</span>
                <button
                  type="button"
                  className="btn danger sm"
                  onClick={() => {
                    setCancelAsked(false);
                    steer.mutate('cancel');
                  }}
                >
                  {t('web.bc_cancel_confirm')}
                </button>
                <button type="button" className="btn sm" onClick={() => setCancelAsked(false)}>
                  {t('web.bc_back')}
                </button>
              </>
            ) : (
              <button type="button" className="btn danger sm" onClick={() => setCancelAsked(true)}>
                {t('web.bc_cancel')}
              </button>
            ))}
        </div>
      )}
      {steer.error !== null && <Banner tone="danger">{broadcastMessage(steer.error)}</Banner>}
    </Card>
  );
}

/** How often a SENDING broadcast's detail and its recipients are read again. */
export const BROADCAST_LIVE_REFRESH_MS = 5_000;

function RecipientsCard({ id, broadcastState }: { id: string; broadcastState: BroadcastState }) {
  const [state, setState] = useState<BroadcastRecipientState | ''>('');
  const [trail, setTrail] = useState<string[]>([]);
  const cursor = trail[trail.length - 1];
  const client = useQueryClient();
  // Refreshed WITH the detail while sending, and once more when the broadcast leaves a
  // state, so the last page read is never the one from before it finished (Codex R6).
  const rows = useQuery({
    queryKey: ['broadcast-recipients', id, state, cursor],
    queryFn: () =>
      fetchBroadcastRecipients(id, {
        ...(state === '' ? {} : { state }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    refetchInterval: broadcastState === 'SENDING' ? BROADCAST_LIVE_REFRESH_MS : false,
  });
  const seenState = useRef(broadcastState);
  useEffect(() => {
    if (seenState.current !== broadcastState) {
      void client.invalidateQueries({ queryKey: ['broadcast-recipients', id] });
    }
    seenState.current = broadcastState;
  }, [broadcastState, client, id]);
  return (
    <Card title={t('web.bc_recipients')}>
      <Field label={t('web.bc_state')} htmlFor="bc-r-state">
        <select
          id="bc-r-state"
          value={state}
          onChange={(event) => {
            setState(event.target.value as BroadcastRecipientState | '');
            setTrail([]);
          }}
        >
          <option value="">{t('web.aud_any')}</option>
          {BROADCAST_RECIPIENT_STATES.map((option) => (
            <option key={option} value={option}>
              {t(RECIPIENT_LABELS[option])}
            </option>
          ))}
        </select>
      </Field>
      <StateSwitch query={rows}>
        {rows.data === undefined ? null : (
          <>
            <DataTable
              caption={t('web.bc_recipients')}
              columns={[
                {
                  key: 'who',
                  header: t('web.bc_customer'),
                  render: (row) => row.firstName ?? row.username ?? row.customerId.slice(0, 8),
                },
                {
                  key: 'state',
                  header: t('web.bc_state'),
                  render: (row) => t(RECIPIENT_LABELS[row.state]),
                },
                {
                  key: 'attempts',
                  header: t('web.bc_attempts'),
                  render: (row) => String(row.attempts),
                },
                {
                  key: 'error',
                  header: t('web.bc_error_code'),
                  render: (row) => (row.errorCode === null ? '—' : <code>{row.errorCode}</code>),
                },
                {
                  key: 'at',
                  header: t('web.bc_resolved_at'),
                  render: (row) =>
                    row.resolvedAt === null ? '—' : formatTimestamp(row.resolvedAt),
                },
              ]}
              rows={rows.data.recipients}
              rowKey={(row) => row.customerId}
            />
            <CursorPager
              shown={rows.data.recipients.length}
              hasPrevious={trail.length > 0}
              hasNext={rows.data.nextCursor !== null}
              onPrevious={() => setTrail(trail.slice(0, -1))}
              onNext={() =>
                rows.data?.nextCursor !== null && rows.data?.nextCursor !== undefined
                  ? setTrail([...trail, rows.data.nextCursor])
                  : undefined
              }
            />
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

export function BroadcastDetailPage({
  id,
  denied,
  maySend,
}: {
  id: string;
  denied: boolean;
  maySend: boolean;
}) {
  const detail = useQuery({
    queryKey: ['broadcast', id],
    queryFn: () => fetchBroadcast(id),
    enabled: !denied,
    refetchInterval: (query) =>
      query.state.data?.broadcast.state === 'SENDING' ? BROADCAST_LIVE_REFRESH_MS : false,
  });
  const record = detail.data?.broadcast;
  const [composerDirty, setComposerDirty] = useState(false);
  return (
    <StateSwitch query={detail} denied={denied}>
      {record === undefined ? null : (
        <>
          <PageHead
            title={record.title}
            subtitle={t(BROADCAST_STATE_LABELS[record.state])}
            maturity="now"
          />
          <Card title={t('web.bc_summary')}>
            <KV
              items={[
                [t('web.bc_state'), t(BROADCAST_STATE_LABELS[record.state])],
                [t('web.bc_kind'), t(KIND_LABELS[record.contentKind])],
                [t('web.bc_created_by'), record.createdBy?.username ?? '—'],
                [t('web.bc_launched_by'), record.launchedBy?.username ?? '—'],
                [t('web.bc_created'), formatTimestamp(record.createdAt)],
                [
                  t('web.bc_scheduled_at'),
                  record.scheduledAt === null ? '—' : formatTimestamp(record.scheduledAt),
                ],
                [
                  t('web.bc_started'),
                  record.startedAt === null ? '—' : formatTimestamp(record.startedAt),
                ],
                [
                  t('web.bc_completed'),
                  record.completedAt === null ? '—' : formatTimestamp(record.completedAt),
                ],
                [
                  t('web.bc_as_of'),
                  record.audienceAsOf === null ? '—' : formatTimestamp(record.audienceAsOf),
                ],
              ]}
            />
            <h3>{t('web.bc_filters')}</h3>
            <ul className="small">
              {describeAudience(record.audience).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <h3>{t('web.bc_preview')}</h3>
            <pre className="preview-text" dir="auto">
              {renderBroadcastPreview(record.body)}
            </pre>
          </Card>
          {record.state === 'DRAFT' ? (
            maySend ? (
              <>
                <Composer key={record.version} record={record} onDirtyChange={setComposerDirty} />
                <MediaCard record={record} blocked={composerDirty} />
                <LaunchCard record={record} />
              </>
            ) : null
          ) : (
            <>
              <ReportCard record={record} maySend={maySend} />
              <RecipientsCard id={record.id} broadcastState={record.state} />
            </>
          )}
        </>
      )}
    </StateSwitch>
  );
}
