import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BROADCAST_BODY_DEFINITION,
  BROADCAST_BUTTONS_MAX,
  BROADCAST_BUTTON_LABEL_MAX_LENGTH,
  BROADCAST_CAPTION_MAX_LENGTH,
  BROADCAST_CONTENT_KINDS,
  BROADCAST_LARGE_AUDIENCE,
  BROADCAST_MEDIA_TYPES,
  BROADCAST_PURPOSES,
  BROADCAST_RECIPIENT_STATES,
  BROADCAST_TEXT_MAX_LENGTH,
  BROADCAST_TITLE_MAX_LENGTH,
  broadcastMediaType,
  isSourcedBroadcastKind,
  type AudiencePreview,
  type BroadcastContentKind,
  type BroadcastPinState,
  type BroadcastPurpose,
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
  Button,
  Card,
  ConfirmDialog,
  CursorPager,
  DataTable,
  Empty,
  Field,
  KV,
  Ltr,
  PageHead,
  Progress,
  StatCard,
  StateSwitch,
  TwoColumn,
  useToast,
  useUnsavedChanges,
  type Column,
  type Tone,
} from '../ui/kit';
import { Icon } from '../ui/icons';
import { CheckField, FormSection, SaveBar } from './editor-layout';
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
/** A broadcast's state, with a moving dot while it is sending. */
function BroadcastStateBadge({ value }: { value: BroadcastState }) {
  return (
    <Badge tone={STATE_TONES[value]} dot pulse={value === 'SENDING'}>
      {t(BROADCAST_STATE_LABELS[value])}
    </Badge>
  );
}

const KIND_LABELS: Readonly<Record<BroadcastContentKind, WebKey>> = {
  TEXT: 'web.bc_kind_text',
  PHOTO: 'web.bc_kind_photo',
  VIDEO: 'web.bc_kind_video',
  DOCUMENT: 'web.bc_kind_document',
  // Round N close (§C): an existing Telegram message, with or without its attribution.
  FORWARD: 'web.bc_kind_forward',
  COPY: 'web.bc_kind_copy',
};
const RECIPIENT_TONES: Readonly<Record<BroadcastRecipientState, Tone>> = {
  PENDING: 'neutral',
  SENDING: 'info',
  SENT: 'ok',
  UNCONFIRMED: 'warn',
  FAILED: 'danger',
  UNREACHABLE: 'warn',
  SKIPPED: 'neutral',
  CANCELLED: 'neutral',
};
const PURPOSE_LABELS: Readonly<Record<BroadcastPurpose, WebKey>> = {
  MARKETING: 'web.bc_purpose_marketing',
  SERVICE_ANNOUNCEMENT: 'web.bc_purpose_service',
};
const PIN_LABELS: Readonly<Record<BroadcastPinState, WebKey>> = {
  PENDING: 'web.bc_pin_pending',
  PINNED: 'web.bc_pin_pinned',
  FAILED: 'web.bc_pin_failed_one',
  UNCONFIRMED: 'web.bc_pin_unconfirmed',
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
      'broadcast.source_required': 'web.bc_error_source_required',
      'broadcast.source_content_invalid': 'web.bc_error_source_content',
      'broadcast.source_unverified': 'web.bc_error_source_unverified',
      'audience.frozen_not_found': 'web.bc_error_frozen',
      'audience.frozen_released': 'web.bc_error_frozen',
      'audience.frozen_kind_mismatch': 'web.bc_error_frozen',
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
        <a href={`/broadcasts/${encodeURIComponent(row.id)}`} onClick={onLink} className="strong">
          {row.title}
        </a>
      ),
    },
    {
      key: 'state',
      header: t('web.bc_state'),
      render: (row) => <BroadcastStateBadge value={row.state} />,
    },
    {
      key: 'kind',
      header: t('web.bc_kind'),
      render: (row) => (
        <Badge tone="neutral" outline>
          {t(KIND_LABELS[row.contentKind])}
        </Badge>
      ),
    },
    {
      key: 'recipients',
      header: t('web.bc_recipients'),
      align: 'end',
      render: (row) => (
        <span className="num">
          {row.recipientCount === null ? '—' : formatNumber(row.recipientCount)}
        </span>
      ),
    },
    {
      key: 'progress',
      header: t('web.bc_progress'),
      render: (row) =>
        row.progressPercent === null ? (
          '—'
        ) : (
          <span className="cb-progress-cell">
            <Progress
              value={row.progressPercent}
              max={100}
              label={t('web.bc_progress')}
              tone={row.state === 'COMPLETED' ? 'ok' : 'info'}
            />
            <span className="num small">{`${formatNumber(row.progressPercent)}%`}</span>
          </span>
        ),
    },
    {
      key: 'created',
      header: t('web.bc_created'),
      render: (row) => <span className="nowrap muted small">{formatTimestamp(row.createdAt)}</span>,
    },
  ];
  return (
    <>
      <PageHead
        title={t('web.bc_page_title')}
        subtitle={t('web.bc_page_intro')}
        actions={
          maySend ? (
            <a className="btn primary" href="/broadcasts/new" onClick={onLink}>
              <Icon name="plus" />
              {t('web.bc_new')}
            </a>
          ) : undefined
        }
      />
      <Card>
        <StateSwitch query={list} denied={denied}>
          {list.data === undefined ? null : list.data.broadcasts.length === 0 ? (
            <Empty title={t('web.bc_empty')} icon="send" />
          ) : (
            <>
              <DataTable
                caption={t('web.bc_page_title')}
                columns={columns}
                rows={list.data.broadcasts}
                rowKey={(row) => row.id}
                dense
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
  purpose: BroadcastPurpose;
  /** As typed: the chat id and the message number of a FORWARD or COPY source. */
  sourceChatId: string;
  sourceMessageId: string;
  pin: boolean;
}

function initial(record: BroadcastResponseItem | null): ComposerState {
  return record === null
    ? {
        title: '',
        contentKind: 'TEXT',
        body: '',
        buttons: [],
        audience: EMPTY_AUDIENCE,
        purpose: 'MARKETING',
        sourceChatId: '',
        sourceMessageId: '',
        pin: false,
      }
    : {
        title: record.title,
        contentKind: record.contentKind,
        body: record.body,
        buttons: record.buttons.map((button) => ({ ...button })),
        audience: draftOf(record.audience),
        purpose: record.purpose,
        sourceChatId: record.source?.chatId ?? '',
        sourceMessageId: record.source === null ? '' : String(record.source.messageId),
        pin: record.pin,
      };
}

/** The source as the API takes it, or null when the kind has none or it is incomplete. */
function sourceOf(state: ComposerState): { chatId: string; messageId: number } | null {
  if (!isSourcedBroadcastKind(state.contentKind)) return null;
  const messageId = Number(state.sourceMessageId.trim());
  if (state.sourceChatId.trim() === '' || !Number.isInteger(messageId) || messageId <= 0) {
    return null;
  }
  return { chatId: state.sourceChatId.trim(), messageId };
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
  useUnsavedChanges(dirty);
  const toast = useToast();
  const client = useQueryClient();
  const submission = useSubmissionKey();
  const set = (patch: Partial<ComposerState>) => setState((current) => ({ ...current, ...patch }));
  const max =
    state.contentKind === 'TEXT' ? BROADCAST_TEXT_MAX_LENGTH : BROADCAST_CAPTION_MAX_LENGTH;

  const save = useMutation({
    mutationFn: () => {
      const sourced = isSourcedBroadcastKind(state.contentKind);
      const content = {
        title: state.title,
        contentKind: state.contentKind,
        // A forward or copy carries no text of ours; a forward takes no buttons either.
        body: sourced ? '' : state.body,
        buttons:
          state.contentKind === 'FORWARD'
            ? []
            : state.buttons.filter(
                (button) => button.label.trim() !== '' || button.url.trim() !== '',
              ),
        audience: state.audience,
        purpose: state.purpose,
        source: sourceOf(state),
        pin: state.pin,
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
      // Saved, so leaving for the new draft is not leaving unsaved work.
      if (record === null) {
        navigate(`/broadcasts/${encodeURIComponent(response.broadcast.id)}`, { force: true });
      }
    },
    onError: (error) => submission.settleOn(error),
  });

  const saveDisabled =
    save.isPending ||
    state.title.trim() === '' ||
    (isSourcedBroadcastKind(state.contentKind) && sourceOf(state) === null);
  return (
    <Card
      title={t('web.bc_composer')}
      className="cb-editor-card"
      tight
      foot={
        <SaveBar dirty={dirty}>
          <Button
            variant="primary"
            icon="check"
            disabled={saveDisabled}
            onClick={() => save.mutate()}
          >
            {record === null ? t('web.bc_create') : t('web.bc_save')}
          </Button>
        </SaveBar>
      }
    >
      <FormSection id="bc-section-content" title={t('web.cb_section_content')} grid={false}>
        <div className="bc-compose">
          <div className="stack-sm">
            <div className="form-grid">
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
                  onChange={(event) =>
                    set({ contentKind: event.target.value as BroadcastContentKind })
                  }
                >
                  {BROADCAST_CONTENT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(KIND_LABELS[kind])}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label={t('web.bc_purpose')} htmlFor="bc-purpose" hint={t('web.bc_purpose_hint')}>
              <select
                id="bc-purpose"
                value={state.purpose}
                onChange={(event) => set({ purpose: event.target.value as BroadcastPurpose })}
              >
                {BROADCAST_PURPOSES.map((purpose) => (
                  <option key={purpose} value={purpose}>
                    {t(PURPOSE_LABELS[purpose])}
                  </option>
                ))}
              </select>
            </Field>
            {isSourcedBroadcastKind(state.contentKind) ? (
              <>
                <Banner tone="info">{t('web.bc_forward_note')}</Banner>
                <div className="form-grid">
                  <Field
                    label={t('web.bc_source_chat')}
                    htmlFor="bc-source-chat"
                    hint={t('web.bc_source_hint')}
                  >
                    <input
                      id="bc-source-chat"
                      dir="ltr"
                      value={state.sourceChatId}
                      onChange={(event) => set({ sourceChatId: event.target.value })}
                    />
                  </Field>
                  <Field label={t('web.bc_source_message')} htmlFor="bc-source-message">
                    <input
                      id="bc-source-message"
                      dir="ltr"
                      inputMode="numeric"
                      value={state.sourceMessageId}
                      onChange={(event) => set({ sourceMessageId: event.target.value })}
                    />
                  </Field>
                </div>
              </>
            ) : (
              <>
                <Field
                  label={state.contentKind === 'TEXT' ? t('web.bc_body') : t('web.bc_caption')}
                  htmlFor="bc-body"
                  hint={t('web.bc_placeholders_hint')}
                >
                  <textarea
                    id="bc-body"
                    rows={7}
                    dir="auto"
                    value={state.body}
                    maxLength={max}
                    onChange={(event) => set({ body: event.target.value })}
                  />
                </Field>
                <p className="muted small">
                  {t('web.bc_placeholders')}: <code>{'{firstName}'}</code>{' '}
                  {t('web.bc_ph_first_name')} · <code>{'{username}'}</code>{' '}
                  {t('web.bc_ph_username')} · <code>{'{walletBalance}'}</code>{' '}
                  {t('web.bc_ph_wallet')}
                </p>
              </>
            )}
            <CheckField
              id="bc-pin"
              label={t('web.bc_pin')}
              hint={t('web.bc_pin_hint')}
              checked={state.pin}
              onChange={(pin) => set({ pin })}
            />
          </div>

          {/* The message as the bot will send it, through the bot's own renderer. */}
          <aside className="bc-preview-pane" aria-label={t('web.bc_preview')}>
            <h4 className="field-group-head">{t('web.bc_preview')}</h4>
            <div className="bc-phone">
              <div className="broadcast-preview bc-bubble" dir="auto">
                {isSourcedBroadcastKind(state.contentKind) ? (
                  <span className="faint">{t(KIND_LABELS[state.contentKind])}</span>
                ) : state.body.trim() === '' ? (
                  <span className="faint">{t('web.bc_preview_empty')}</span>
                ) : (
                  <pre className="preview-text">{renderBroadcastPreview(state.body)}</pre>
                )}
              </div>
              {state.buttons
                .filter((button) => button.label.trim() !== '')
                .map((button, index) => (
                  <div className="bc-inline-button" key={index}>
                    {button.label}
                  </div>
                ))}
            </div>
            <p className="muted small">{t('web.bc_preview_hint')}</p>
          </aside>
        </div>
      </FormSection>

      {state.contentKind !== 'FORWARD' && (
        <FormSection id="bc-section-buttons" title={t('web.bc_buttons')} grid={false}>
          <div className="stack-sm">
            {state.buttons.map((button, index) => (
              <div className="form-grid" key={index}>
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
            <div className="form-actions">
              <Button
                size="sm"
                icon="plus"
                disabled={state.buttons.length >= BROADCAST_BUTTONS_MAX}
                onClick={() => set({ buttons: [...state.buttons, { label: '', url: 'https://' }] })}
              >
                {t('web.bc_button_add')}
              </Button>
              {state.buttons.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => set({ buttons: state.buttons.slice(0, -1) })}
                >
                  {t('web.bc_button_remove')}
                </Button>
              )}
            </div>
          </div>
        </FormSection>
      )}

      <FormSection id="bc-section-audience" title={t('web.bc_audience')} grid={false}>
        <AudienceBuilder value={state.audience} onChange={(audience) => set({ audience })} />
      </FormSection>

      {save.error !== null && (
        <div className="cb-form-error">
          <Banner tone="danger">{broadcastMessage(save.error)}</Banner>
        </div>
      )}
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
  if (record.contentKind === 'TEXT' || isSourcedBroadcastKind(record.contentKind)) return null;
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
      <div className="form-actions">
        <input
          type="file"
          className="bc-file"
          aria-label={t('web.bc_media_pick')}
          accept={accept}
          disabled={blocked || upload.isPending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) upload.mutate(file);
          }}
        />
        {record.media !== null && (
          <Button
            size="sm"
            variant="danger"
            icon="trash"
            disabled={blocked || remove.isPending}
            onClick={() => remove.mutate()}
          >
            {t('web.bc_media_remove')}
          </Button>
        )}
      </div>
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
  /** The last question before a send: asked in a dialog, answered once. */
  const [asking, setAsking] = useState(false);
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
    onSuccess: (response) => {
      toast(
        response.outcome === 'SENT'
          ? { tone: 'ok', message: t('web.bc_test_sent') }
          : { tone: 'warn', message: t('web.bc_test_not_sent') },
      );
      // A test that reached the operator verified a FORWARD/COPY source: read it back.
      void client.invalidateQueries({ queryKey: ['broadcast', record.id] });
    },
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
    (mode === 'NOW' || scheduledAt !== '') &&
    (!isSourcedBroadcastKind(record.contentKind) || record.sourceVerifiedAt !== null);
  const sourced = isSourcedBroadcastKind(record.contentKind);
  return (
    <Card title={t('web.bc_launch')} hint={t('web.bc_launch_hint')} tone="danger">
      {sourced && (
        <Banner tone={record.sourceVerifiedAt === null ? 'warn' : 'ok'}>
          {record.sourceVerifiedAt === null
            ? t('web.bc_source_verified_no')
            : t('web.bc_source_verified_yes')}
        </Banner>
      )}
      <div className="form-actions">
        <Button size="sm" icon="send" disabled={test.isPending} onClick={() => test.mutate()}>
          {t('web.bc_test')}
        </Button>
        <Button size="sm" icon="users" disabled={count.isPending} onClick={() => count.mutate()}>
          {t('web.bc_count')}
        </Button>
      </div>
      {test.error !== null && <Banner tone="danger">{broadcastMessage(test.error)}</Banner>}
      {count.error !== null && <Banner tone="danger">{broadcastMessage(count.error)}</Banner>}
      {preview !== null && (
        <>
          <div className="stat-grid cb-stat-row">
            <StatCard label={t('web.bc_recipients')} value={formatNumber(preview.customers)} />
            <StatCard
              label={t('web.aud_count_reachable')}
              value={formatNumber(preview.reachable)}
            />
            <StatCard
              label={t('web.bc_as_of')}
              value={<span className="cb-stat-note">{formatTimestamp(preview.asOf)}</span>}
            />
          </div>
          {preview.customers === 0 ? (
            <Banner tone="info">{t('web.aud_error_empty')}</Banner>
          ) : (
            <>
              <div className="form-grid">
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
              </div>
              <Banner tone="warn">{t('web.bc_freeze_note')}</Banner>
              <label className="check">
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
              <div className="form-actions">
                <Button
                  variant="danger-solid"
                  icon="send"
                  disabled={!ready || launch.isPending}
                  onClick={() => setAsking(true)}
                >
                  {mode === 'NOW' ? t('web.bc_send_now') : t('web.bc_schedule')}
                </Button>
              </div>
              {asking && (
                <ConfirmDialog
                  title={record.title}
                  question={(mode === 'NOW'
                    ? t('web.cb_bc_send_question')
                    : t('web.cb_bc_schedule_question')
                  ).replace('{count}', formatNumber(preview.customers))}
                  detail={t('web.bc_freeze_note')}
                  confirmLabel={
                    mode === 'NOW' ? t('web.cb_bc_send_yes') : t('web.cb_bc_schedule_yes')
                  }
                  cancelLabel={t('web.cb_cancel')}
                  onConfirm={() => {
                    setAsking(false);
                    launch.mutate();
                  }}
                  onCancel={() => setAsking(false)}
                />
              )}
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
      <div className="stat-grid cb-stat-row">
        <StatCard label={t('web.bc_total')} value={formatNumber(c.total)} />
        <StatCard label={t('web.bc_r_sent')} value={formatNumber(c.sent)} />
        <StatCard label={t('web.bc_r_pending')} value={formatNumber(c.pending + c.sending)} />
        <StatCard
          label={t('web.bc_r_failed')}
          value={formatNumber(c.failed)}
          {...(c.failed > 0 ? { tone: 'alert' as const } : {})}
        />
      </div>
      <div className="cb-progress-line">
        <Progress
          value={record.progressPercent ?? 0}
          max={100}
          label={t('web.bc_progress')}
          tone={record.state === 'COMPLETED' ? 'ok' : 'info'}
          size="lg"
        />
        <span className="num">
          {record.progressPercent === null ? '—' : `${formatNumber(record.progressPercent)}%`}
        </span>
      </div>
      <KV
        inline
        items={[
          [t('web.bc_r_unreachable'), formatNumber(c.unreachable)],
          [t('web.bc_r_unconfirmed'), formatNumber(c.unconfirmed)],
          [t('web.bc_r_skipped'), formatNumber(c.skipped)],
          [t('web.bc_r_cancelled'), formatNumber(c.cancelled)],
          ...(record.pin
            ? ([
                [t('web.bc_pinned'), formatNumber(c.pinned)],
                [t('web.bc_pin_failed'), formatNumber(c.pinFailed)],
              ] as [string, string][])
            : []),
        ]}
      />
      {record.state === 'PAUSED' && record.pauseReason === 'BOT_UNAVAILABLE' && (
        <Banner tone="danger">{t('web.bc_paused_bot')}</Banner>
      )}
      <p className="muted small">{t('web.bc_unconfirmed_hint')}</p>
      {maySend && (
        <div className="form-actions">
          {record.state === 'SENDING' && (
            <Button size="sm" icon="pause" onClick={() => steer.mutate('pause')}>
              {t('web.bc_pause')}
            </Button>
          )}
          {record.state === 'PAUSED' && (
            <Button size="sm" icon="play" onClick={() => steer.mutate('resume')}>
              {t('web.bc_resume')}
            </Button>
          )}
          {c.failed > 0 && ['SENDING', 'PAUSED', 'COMPLETED'].includes(record.state) && (
            <Button size="sm" icon="refresh" onClick={() => steer.mutate('retryFailed')}>
              {t('web.bc_retry_failed')}
            </Button>
          )}
          <span className="spacer" />
          {['SCHEDULED', 'SENDING', 'PAUSED'].includes(record.state) && (
            <Button size="sm" variant="danger" onClick={() => setCancelAsked(true)}>
              {t('web.bc_cancel')}
            </Button>
          )}
        </div>
      )}
      {cancelAsked && (
        <ConfirmDialog
          title={record.title}
          question={t('web.bc_cancel_question')}
          confirmLabel={t('web.bc_cancel_confirm')}
          cancelLabel={t('web.bc_back')}
          onConfirm={() => {
            setCancelAsked(false);
            steer.mutate('cancel');
          }}
          onCancel={() => setCancelAsked(false)}
        />
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
      <div className="toolbar">
        <Field label={t('web.bc_state')} htmlFor="bc-r-state" compact>
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
      </div>
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
                  render: (row) => (
                    <Badge tone={RECIPIENT_TONES[row.state]} dot>
                      {t(RECIPIENT_LABELS[row.state])}
                    </Badge>
                  ),
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
                {
                  key: 'pin',
                  header: t('web.bc_pin_state'),
                  // The pin's own outcome, beside the send's: delivered stays delivered.
                  render: (row) =>
                    row.pinState === null ? (
                      '—'
                    ) : row.pinErrorCode === null ? (
                      t(PIN_LABELS[row.pinState])
                    ) : (
                      <>
                        {t(PIN_LABELS[row.pinState])} <code>{row.pinErrorCode}</code>
                      </>
                    ),
                },
              ]}
              rows={rows.data.recipients}
              rowKey={(row) => row.customerId}
              dense
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

/** What the broadcast is and whom it goes to, as saved. */
function BroadcastSummary({ record }: { record: BroadcastResponseItem }) {
  return (
    <Card title={t('web.bc_summary')}>
      <KV
        items={[
          [t('web.bc_state'), t(BROADCAST_STATE_LABELS[record.state])],
          [t('web.bc_kind'), t(KIND_LABELS[record.contentKind])],
          [t('web.bc_purpose'), t(PURPOSE_LABELS[record.purpose])],
          [t('web.bc_pin'), record.pin ? t('web.bc_pin_yes') : t('web.bc_pin_no')],
          ...(record.source === null
            ? []
            : ([
                [
                  t('web.bc_source'),
                  <Ltr key="src">{`${record.source.chatId} / ${String(record.source.messageId)}`}</Ltr>,
                ],
                [
                  t('web.bc_source_verified'),
                  record.sourceVerifiedAt === null
                    ? t('web.bc_source_verified_no')
                    : formatTimestamp(record.sourceVerifiedAt),
                ],
              ] as [ReactNode, ReactNode][])),
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
      {record.frozenAudienceId !== null && (
        <p className="muted small">{t('web.bc_frozen_audience')}</p>
      )}
      <ul className="small">
        {describeAudience(record.audience).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {!isSourcedBroadcastKind(record.contentKind) && (
        <>
          <h3>{t('web.bc_preview')}</h3>
          <div className="bc-phone">
            <div className="broadcast-preview bc-bubble" dir="auto">
              <pre className="preview-text">{renderBroadcastPreview(record.body)}</pre>
            </div>
          </div>
        </>
      )}
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
  const summary = record === undefined ? null : <BroadcastSummary record={record} />;
  return (
    <StateSwitch query={detail} denied={denied}>
      {record === undefined ? null : (
        <>
          <PageHead
            title={record.title}
            badge={<BroadcastStateBadge value={record.state} />}
            subtitle={
              <span className="cb-meta">
                <span>{t(KIND_LABELS[record.contentKind])}</span>
                <span>{t(PURPOSE_LABELS[record.purpose])}</span>
              </span>
            }
          />
          {record.state === 'DRAFT' ? (
            <>
              {maySend && (
                <>
                  <Composer key={record.version} record={record} onDirtyChange={setComposerDirty} />
                  <MediaCard record={record} blocked={composerDirty} />
                  <LaunchCard record={record} />
                </>
              )}
              {summary}
            </>
          ) : (
            <TwoColumn
              main={
                <>
                  <ReportCard record={record} maySend={maySend} />
                  <RecipientsCard id={record.id} broadcastState={record.state} />
                </>
              }
              side={summary}
            />
          )}
        </>
      )}
    </StateSwitch>
  );
}
