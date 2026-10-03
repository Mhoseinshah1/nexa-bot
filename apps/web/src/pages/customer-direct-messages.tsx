import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DIRECT_MESSAGE_CAPTION_MAX_LENGTH,
  DIRECT_MESSAGE_ERROR_CODES,
  DIRECT_MESSAGE_TEXT_MAX_LENGTH,
  type DirectMessageContentKind,
  type DirectMessageDeliveryState,
  type DirectMessageResponseItem,
} from '@nexa/contracts';
import { ApiError, fetchDirectMessages, sendDirectMessage } from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { messageFor } from './settings';
import { readReplyFile, type PickedReplyFile } from './tickets';
import {
  Badge,
  Banner,
  Button,
  Card,
  CursorPager,
  Empty,
  Field,
  Ltr,
  Modal,
  StateSwitch,
  Textarea,
  Timeline,
  useToast,
  useUnsavedChanges,
  type Tone,
} from '../ui/kit';

/*
 * Phase A2 — «ارسال پیام» from Customer 360 (`docs/direct-message-audit.md`).
 *
 * Two pieces, kept in their own file so the customer page only mounts them: the compose
 * modal (write → preview → explicit confirmation) and the history card. The server holds
 * every rule — the permission, the target check, the rate limit, the file allow-list — and
 * the page only spares the operator a request it would refuse. Nothing here shows a chat id,
 * a bot or a Telegram file handle, and nothing claims a message was delivered or read.
 */

export const DELIVERY_LABELS: Readonly<Record<DirectMessageDeliveryState, WebKey>> = {
  QUEUED: 'web.dm_state_queued',
  SENDING: 'web.dm_state_sending',
  SENT: 'web.dm_state_sent',
  FAILED: 'web.dm_state_failed',
  UNKNOWN: 'web.dm_state_unknown',
  EXPIRED: 'web.dm_state_expired',
};

export const DELIVERY_TONES: Readonly<Record<DirectMessageDeliveryState, Tone>> = {
  QUEUED: 'neutral',
  SENDING: 'info',
  SENT: 'ok',
  FAILED: 'danger',
  UNKNOWN: 'warn',
  EXPIRED: 'neutral',
};

const KIND_LABELS: Readonly<Record<DirectMessageContentKind, WebKey>> = {
  TEXT: 'web.dm_kind_text',
  PHOTO: 'web.dm_kind_photo',
  DOCUMENT: 'web.dm_kind_document',
};

/** The Persian sentence for a refusal this feature's server can send. */
export function directMessageFault(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === DIRECT_MESSAGE_ERROR_CODES.TARGET_UNAVAILABLE) {
      return error.details?.reason === 'BLOCKED' ? t('web.dm_err_blocked') : t('web.dm_err_no_bot');
    }
    if (error.code === DIRECT_MESSAGE_ERROR_CODES.RATE_LIMITED) {
      return error.details?.scope === 'ADMIN'
        ? t('web.dm_err_rate_admin')
        : t('web.dm_err_rate_customer');
    }
    if (error.code === DIRECT_MESSAGE_ERROR_CODES.FILE_STORAGE_FULL) {
      return t('web.dm_err_storage_full');
    }
    if (error.code === DIRECT_MESSAGE_ERROR_CODES.BODY_INVALID) return t('web.dm_err_body');
  }
  return messageFor(error);
}

/** Code points, as the server counts them: a DOM `maxLength` counts UTF-16 units. */
const lengthOf = (text: string) => Array.from(text.trim()).length;

// ---------------------------------------------------------------------------------------
// Compose → preview → confirm
// ---------------------------------------------------------------------------------------

export function DirectMessageComposeModal({
  customerId,
  open,
  blocked,
  onClose,
}: {
  customerId: string;
  open: boolean;
  /** The customer is blocked: the page says so up front instead of letting a send fail. */
  blocked: boolean;
  onClose: () => void;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<PickedReplyFile>({ kind: 'NONE' });
  const [step, setStep] = useState<'COMPOSE' | 'PREVIEW'>('COMPOSE');

  const hasFile = picked.kind === 'READY';
  const max = hasFile ? DIRECT_MESSAGE_CAPTION_MAX_LENGTH : DIRECT_MESSAGE_TEXT_MAX_LENGTH;
  const length = lengthOf(text);
  const tooLong = length > max;
  const empty = length === 0 && !hasFile;
  const fileBusy = picked.kind === 'READING' || picked.kind === 'INVALID';
  const dirty = text.trim() !== '' || picked.kind !== 'NONE';
  useUnsavedChanges(open && dirty, t('web.dm_discard'));

  const reset = () => {
    setText('');
    setPicked({ kind: 'NONE' });
    setStep('COMPOSE');
  };

  const send = useMutation({
    mutationFn: () => {
      const file = picked.kind === 'READY' ? picked.attachment : null;
      // The fingerprint is the content itself: an edit after an ambiguous failure is a NEW
      // command with a new key, and an unchanged retry carries the held one — never a second
      // message for one decision (`useSubmissionKey`).
      const idempotencyKey = submission.current({ customerId, text, file });
      return sendDirectMessage({ customerId, idempotencyKey, text, file });
    },
    onSuccess: (response) => {
      submission.settle();
      notify({
        tone: 'ok',
        message: response.replayed ? t('web.dm_replayed_toast') : t('web.dm_queued_toast'),
      });
      void queries.invalidateQueries({ queryKey: ['customer-direct-messages', customerId] });
      void queries.invalidateQueries({ queryKey: ['customer-timeline', customerId] });
      reset();
      onClose();
    },
    onError: (error) => submission.settleOn(error),
  });

  const close = () => {
    if (send.isPending) return;
    send.reset();
    setStep('COMPOSE');
    onClose();
  };

  const choose = async (file: File | undefined) => {
    if (file === undefined) {
      setPicked({ kind: 'NONE' });
      return;
    }
    setPicked({ kind: 'READING' });
    setPicked(await readReplyFile(file));
  };

  const textError = tooLong
    ? t('web.dm_text_too_long')
    : step === 'COMPOSE' && dirty && empty
      ? t('web.dm_text_required')
      : undefined;

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title={step === 'COMPOSE' ? t('web.dm_compose_title') : t('web.dm_preview_title')}
      foot={
        step === 'COMPOSE' ? (
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={blocked || empty || tooLong || fileBusy}
              onClick={() => setStep('PREVIEW')}
            >
              {t('web.dm_preview')}
            </Button>
            <Button size="sm" onClick={close}>
              {t('web.user_action_cancel')}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="primary"
              size="sm"
              icon="check"
              disabled={send.isPending || blocked}
              onClick={() => send.mutate()}
            >
              {t('web.dm_confirm')}
            </Button>
            <Button
              size="sm"
              disabled={send.isPending}
              onClick={() => {
                send.reset();
                setStep('COMPOSE');
              }}
            >
              {t('web.dm_back')}
            </Button>
          </>
        )
      }
    >
      {blocked && <Banner tone="warn">{t('web.dm_blocked_note')}</Banner>}
      {step === 'COMPOSE' ? (
        <div className="stack">
          <Field
            label={hasFile ? t('web.dm_caption_label') : t('web.dm_text_label')}
            hint={`${t('web.dm_text_hint')} (${String(length)}/${String(max)} ${t('web.dm_counter')})`}
            htmlFor="dm-text"
            {...(textError === undefined ? {} : { error: textError })}
          >
            <Textarea
              id="dm-text"
              rows={6}
              dir="auto"
              value={text}
              aria-invalid={textError !== undefined}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <Field
            label={t('web.dm_file_label')}
            hint={t('web.ticket_reply_file_hint')}
            htmlFor="dm-file"
            {...(picked.kind === 'INVALID' ? { error: t(picked.reason) } : {})}
          >
            <input
              id="dm-file"
              type="file"
              accept="image/jpeg,image/png,application/pdf,text/plain,.jpg,.jpeg,.png,.pdf,.txt"
              onChange={(event) => void choose(event.target.files?.[0])}
            />
          </Field>
          {picked.kind === 'READING' && (
            <span className="muted small">{t('web.dm_file_reading')}</span>
          )}
          {picked.kind !== 'NONE' && (
            <Button size="sm" variant="ghost" onClick={() => setPicked({ kind: 'NONE' })}>
              {t('web.ticket_reply_file_clear')}
            </Button>
          )}
        </div>
      ) : (
        <div className="stack">
          <Banner tone="info">{t('web.dm_preview_note')}</Banner>
          {/* What the customer sees: the heading the default template draws, then the words. */}
          <div className="card tight dm-preview" aria-label={t('web.dm_preview')}>
            {picked.kind === 'READY' &&
              (picked.attachment.mimeType.startsWith('image/') ? (
                <img
                  className="dm-preview-image"
                  alt={picked.attachment.fileName}
                  src={`data:${picked.attachment.mimeType};base64,${picked.attachment.contentBase64}`}
                />
              ) : (
                <p>
                  <Badge tone="neutral">{t('web.dm_kind_document')}</Badge>{' '}
                  <Ltr mono={false}>{picked.attachment.fileName}</Ltr>
                </p>
              ))}
            <p className="strong">{t('web.dm_preview_heading')}</p>
            {text.trim() !== '' && <p className="dm-text">{text.trim()}</p>}
          </div>
          {send.error !== null && <Banner tone="danger">{directMessageFault(send.error)}</Banner>}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------

export function DirectMessagesCard({
  customerId,
  mayView,
  maySend,
  onCompose,
}: {
  customerId: string;
  mayView: boolean;
  maySend: boolean;
  onCompose: () => void;
}) {
  const [cursors, setCursors] = useState<readonly { at: string; id: string }[]>([]);
  const cursor = cursors.at(-1);
  const history = useQuery({
    queryKey: ['customer-direct-messages', customerId, cursor ?? null],
    queryFn: () => fetchDirectMessages(customerId, cursor),
    enabled: mayView,
    // While something is still on its way, look again; a settled page is left alone.
    refetchInterval: (query) =>
      (query.state.data?.messages ?? []).some(
        (one) => one.delivery === 'QUEUED' || one.delivery === 'SENDING',
      )
        ? 15_000
        : false,
  });

  const actions = maySend ? (
    <Button size="sm" icon="plus" onClick={onCompose}>
      {t('web.dm_send')}
    </Button>
  ) : undefined;

  if (!mayView) {
    return (
      <Card title={t('web.dm_title')} id="c360-messages" {...(actions ? { actions } : {})}>
        <Banner tone="info">{t('web.dm_denied')}</Banner>
      </Card>
    );
  }
  const messages = history.data?.messages ?? [];
  const next = history.data?.nextCursor ?? null;
  return (
    <Card
      title={t('web.dm_title')}
      hint={t('web.dm_hint')}
      id="c360-messages"
      {...(actions ? { actions } : {})}
    >
      <StateSwitch query={history}>
        {messages.length === 0 && cursors.length === 0 ? (
          <Empty variant="compact" title={t('web.dm_empty')} />
        ) : (
          <>
            <Timeline items={messages.map(itemOf)} />
            {(next !== null || cursors.length > 0) && (
              <CursorPager
                hasPrevious={cursors.length > 0}
                hasNext={next !== null}
                onPrevious={() => setCursors(cursors.slice(0, -1))}
                onNext={() => {
                  if (next !== null) setCursors([...cursors, next]);
                }}
                shown={messages.length}
              />
            )}
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

function itemOf(message: DirectMessageResponseItem) {
  return {
    key: message.id,
    at: formatTimestamp(message.createdAt),
    tone: DELIVERY_TONES[message.delivery],
    title: (
      <span>
        <Badge tone="neutral">{t(KIND_LABELS[message.contentKind])}</Badge>{' '}
        <Badge tone={DELIVERY_TONES[message.delivery]}>
          {t(DELIVERY_LABELS[message.delivery])}
        </Badge>
        {message.attempts > 0 && message.delivery === 'QUEUED' && (
          <span className="muted small">
            {' '}
            ({t('web.dm_attempts')}: {String(message.attempts)})
          </span>
        )}
      </span>
    ),
    detail: (
      <span className="dm-detail">
        {message.file !== null && (
          <span className="muted small">
            <Ltr mono={false}>{message.file.fileName}</Ltr>
          </span>
        )}
        {message.text !== null && <span className="dm-text">{message.text}</span>}
        {message.delivery === 'UNKNOWN' && (
          <span className="muted small">{t('web.dm_state_unknown_hint')}</span>
        )}
        <span className="muted small">
          {t('web.dm_sent_by')}{' '}
          {message.sentBy === null ? <span className="faint">—</span> : message.sentBy.username}
        </span>
      </span>
    ),
  };
}
