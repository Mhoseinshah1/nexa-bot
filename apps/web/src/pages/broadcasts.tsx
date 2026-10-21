import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { keepPageWhileTurning } from '../ui/paging';
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
  BROADCAST_ACTIONS,
  BROADCAST_PLACEHOLDER_TOKENS,
  broadcastMediaType,
  broadcastOutcome,
  isBroadcastActionButton,
  isSourcedBroadcastKind,
  type AudiencePreview,
  type BroadcastAction,
  type BroadcastButton,
  type BroadcastPlaceholderToken,
  type BroadcastOutcome,
  type BroadcastContentKind,
  type BroadcastHistoryAction,
  type BroadcastPinState,
  type BroadcastPresentation,
  type BroadcastPurpose,
  type BroadcastRecipientState,
  type BroadcastResponseItem,
  type BroadcastState,
  type BroadcastTestResponse,
} from '@nexa/contracts';
import { renderTemplateBody } from '@nexa/i18n';
import {
  ApiError,
  createBroadcast,
  fetchBroadcast,
  fetchBroadcastBots,
  fetchBroadcastFailures,
  fetchBroadcastHistory,
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
import { ListFilterBar } from '../ui/filter-bar';
import { jalaliDatesIn } from './editor-layout';
import { FilePicker } from '../ui/file-picker';
import { DateField } from '../ui/date-field';
import { t, type WebKey } from '../i18n/web.fa';
import { RecordLink, recordHref } from '../ui/record-ref';
import { navigate, setQuery, useLinkHandler, type Route } from '../router';
import { useSubmissionKey } from '../submission-key';
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  CursorPager,
  LIST_PAGE_SIZE,
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
  PermissionDeniedState,
} from '../ui/kit';
import { Icon } from '../ui/icons';
import { insertTable } from '../table-text';
import { TextWithTables } from '../ui/text-with-tables';
import { CheckField, FormSection, SaveBar } from './editor-layout';
import { messageFor } from './settings';
import {
  AudienceBuilder,
  EMPTY_AUDIENCE,
  audienceMessage,
  describeAudience,
  useCachedBotNames,
  draftOf,
  wireAudience,
  type AudienceDraft,
} from './audience-builder';
import { ErrorRef } from '../ui/technical-details';

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

/*
 * Roadmap C2 (failure visibility): what a recipient's transport code means, in words. The code
 * itself is always shown beside it — the sentence explains, the code is what a log names. A
 * code this table does not know is shown as it is.
 */
const REASON_LABELS: Readonly<Record<string, WebKey>> = {
  'telegram.rejected.403': 'web.bcx_reason_blocked_bot',
  'telegram.rejected.400': 'web.bcx_reason_bad_request',
  'telegram.rejected.401': 'web.bcx_reason_bot_token',
  'telegram.rejected.404': 'web.bcx_reason_bot_token',
  'telegram.rate_limited': 'web.bcx_reason_rate_limited',
  'telegram.unreachable': 'web.bcx_reason_unknown_outcome',
  'telegram.unreadable_response': 'web.bcx_reason_unknown_outcome',
  'broadcast.send_interrupted': 'web.bcx_reason_unknown_outcome',
  'broadcast.no_bot': 'web.bcx_reason_bot_unavailable',
  'broadcast.no_bot_recorded': 'web.bcx_reason_no_bot_recorded',
  'broadcast.customer_blocked': 'web.bcx_reason_customer_blocked',
  'broadcast.marketing_opted_out': 'web.bcx_reason_opted_out',
  'broadcast.media_unavailable': 'web.bcx_reason_media_unavailable',
  'broadcast.pin_interrupted': 'web.bcx_reason_unknown_outcome',
};

/** The sentence for a transport code, or null when the code is not one this page knows. */
export function broadcastReasonLabel(code: string): string | null {
  const key =
    REASON_LABELS[code] ??
    (code.startsWith('telegram.server_error.') ? 'web.bcx_reason_unknown_outcome' : undefined);
  return key === undefined ? null : t(key);
}

/** A code with its sentence, the code always kept beside it. */
function Reason({ code }: { code: string }) {
  const label = broadcastReasonLabel(code);
  return (
    <span className="bcx-reason">
      {label !== null && <span>{label}</span>} <Ltr>{code}</Ltr>
    </span>
  );
}

const TEST_OUTCOME_LABELS: Readonly<Record<BroadcastTestResponse['outcome'], WebKey>> = {
  SENT: 'web.bc_test_sent',
  NOT_SENT: 'web.bc_test_not_sent',
  UNCONFIRMED: 'web.bcx_test_unconfirmed',
  RATE_LIMITED: 'web.bcx_test_rate_limited',
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
  const list = useQuery(
    keepPageWhileTurning({
      queryKey: ['broadcasts', cursor],
      queryFn: () =>
        fetchBroadcasts({ limit: LIST_PAGE_SIZE, ...(cursor === null ? {} : { cursor }) }),
      enabled: !denied,
    }),
  );
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
      <Card className="bc-list">
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
                order="newest-first"
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
    return <PermissionDeniedState />;
  }
  return (
    <>
      <PageHead title={t('web.bc_new')} subtitle={t('web.bc_page_intro')} />
      <Composer record={null} />
    </>
  );
}

/**
 * One button as the composer edits it (R4 A6): a LINK (`url`) or an IN-BOT action (`action`),
 * one row each, mixed freely. Only the field of its own kind is sent.
 */
export interface ComposerButton {
  kind: 'URL' | 'ACTION';
  label: string;
  url: string;
  action: BroadcastAction;
}

/** A composer button as the API takes it. */
export function wireButton(button: ComposerButton): BroadcastButton {
  return button.kind === 'ACTION'
    ? { label: button.label.trim(), action: button.action }
    : { label: button.label.trim(), url: button.url.trim() };
}

function composerButton(button: BroadcastButton): ComposerButton {
  return isBroadcastActionButton(button)
    ? { kind: 'ACTION', label: button.label, url: 'https://', action: button.action }
    : { kind: 'URL', label: button.label, url: button.url, action: 'CATALOG' };
}

/** R4 A6: the Persian name of each in-bot action — also the label a new action button gets. */
export const BROADCAST_ACTION_LABELS: Readonly<Record<BroadcastAction, WebKey>> = {
  START: 'web.bc_action_start',
  CATALOG: 'web.bc_action_catalog',
  TRIAL: 'web.bc_action_trial',
  WALLET_TOPUP: 'web.bc_action_wallet_topup',
  REFERRAL: 'web.bc_action_referral',
  SERVICES: 'web.bc_action_services',
  RENEW: 'web.bc_action_renew',
  SUPPORT: 'web.bc_action_support',
  TUTORIAL: 'web.bc_action_tutorial',
};

/**
 * R4 A6: the variable chips — every token the bot's catalogue (`BROADCAST_BODY_DEFINITION`)
 * declares, with its Persian name. A chip inserts the token; it never invents one.
 */
export const BROADCAST_PLACEHOLDER_LABELS: Readonly<Record<BroadcastPlaceholderToken, WebKey>> = {
  firstName: 'web.bc_ph_first_name',
  username: 'web.bc_ph_username',
  walletBalance: 'web.bc_ph_wallet',
  telegramId: 'web.bc_ph_telegram_id',
  phone: 'web.bc_ph_phone',
  servicesTotal: 'web.bc_ph_services_total',
  servicesActive: 'web.bc_ph_services_active',
  today: 'web.bc_ph_today',
};

/**
 * The recipient the composer's preview is drawn for — typed into the composer's own sample
 * fields, shown in the preview and nowhere else, never sent and never stored.
 */
export interface SampleRecipient {
  firstName: string;
  username: string;
  telegramId: string;
  phone: string;
  servicesTotal: string;
  servicesActive: string;
}

const DIGITS = /^[0-9]{1,9}$/u;

const SAMPLE_FIELDS: readonly (readonly [keyof SampleRecipient, WebKey])[] = [
  ['firstName', 'web.bc_ph_first_name'],
  ['username', 'web.bc_ph_username'],
  ['telegramId', 'web.bc_ph_telegram_id'],
  ['phone', 'web.bc_ph_phone'],
  ['servicesTotal', 'web.bc_ph_services_total'],
  ['servicesActive', 'web.bc_ph_services_active'],
];

interface ComposerState {
  title: string;
  contentKind: BroadcastContentKind;
  body: string;
  buttons: ComposerButton[];
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
        buttons: record.buttons.map(composerButton),
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

/**
 * The operator's own text, rendered by the bot's renderer (`renderTemplateBody` over the same
 * `BROADCAST_BODY_DEFINITION`) for a sample recipient. Without `sample` it is the composer's
 * default sample. A sample field left empty is absent, so its line drops exactly as it would
 * for a recipient without that fact — except `{phone}`, which renders empty, as the bot does.
 * `{today}` is `now` in the TENANT's zone and calendar — the presentation the sender renders
 * with, as the list answers it — never the product default; `{walletBalance}` is never sampled.
 */
export function renderBroadcastPreview(
  body: string,
  presentation: BroadcastPresentation,
  sample: SampleRecipient = defaultSample(),
  now: Date = new Date(),
): string {
  const values: Record<string, string | number | Date> = { today: now, phone: sample.phone.trim() };
  if (sample.firstName.trim() !== '') values.firstName = sample.firstName.trim();
  if (sample.username.trim() !== '') values.username = sample.username.trim();
  if (sample.telegramId.trim() !== '') values.telegramId = sample.telegramId.trim();
  if (DIGITS.test(sample.servicesTotal.trim())) values.servicesTotal = Number(sample.servicesTotal);
  if (DIGITS.test(sample.servicesActive.trim())) {
    values.servicesActive = Number(sample.servicesActive);
  }
  return renderTemplateBody(BROADCAST_BODY_DEFINITION, body, values, undefined, presentation);
}

/**
 * The tenant's zone and calendar, as the broadcast list answers them. The preview is not drawn
 * without them: a default in the meantime would show a date the recipient may not be sent.
 */
function useBroadcastPresentation() {
  return useQuery({
    queryKey: ['broadcasts', 'presentation'],
    queryFn: async () => (await fetchBroadcasts({ limit: 1 })).presentation,
    staleTime: 60_000,
  });
}

/** The composer's starting sample: a name and a handle, plainly a sample, nothing else. */
export function defaultSample(): SampleRecipient {
  return {
    firstName: t('web.bc_sample_name'),
    username: 'sample_user',
    telegramId: '',
    phone: '',
    servicesTotal: '',
    servicesActive: '',
  };
}

function Composer({
  record,
  onDirtyChange,
}: {
  record: BroadcastResponseItem | null;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [state, setState] = useState<ComposerState>(() => initial(record));
  const presentation = useBroadcastPresentation();
  /*
   * The saved draft the edits are based on, and whose version a save names. PR #245 (Codex
   * CX2, review M1): when the server's draft moves on — a 409 re-read, another operator's
   * save, a media change — the composer is NOT remounted from it. With no unsaved edits it
   * simply follows the new version; with unsaved edits it keeps them and says the draft
   * changed, and the operator chooses: load the latest (dropping theirs) or keep theirs on
   * top of it. Nothing is discarded silently, and save waits for that choice.
   */
  const [base, setBase] = useState<BroadcastResponseItem | null>(record);
  const [stale, setStale] = useState(false);
  // Unsaved edits, compared with the saved draft they are based on. The detail page blocks
  // media actions while this is true (Codex R5 on PR #117).
  const dirty = JSON.stringify(state) !== JSON.stringify(initial(base));
  useEffect(() => {
    // Only a NEWER server version moves the base: a save already took its own answer as base.
    if (record === null || base === null || record.version <= base.version) return;
    if (dirty) {
      setStale(true);
    } else {
      setBase(record);
      setState(initial(record));
    }
  }, [record, base, dirty]);
  const loadLatest = () => {
    setBase(record);
    setState(initial(record));
    setStale(false);
  };
  const keepMine = () => {
    setBase(record);
    setStale(false);
  };
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useUnsavedChanges(dirty);
  const toast = useToast();
  const client = useQueryClient();
  const submission = useSubmissionKey();
  const set = (patch: Partial<ComposerState>) => setState((current) => ({ ...current, ...patch }));
  const max =
    state.contentKind === 'TEXT' ? BROADCAST_TEXT_MAX_LENGTH : BROADCAST_CAPTION_MAX_LENGTH;
  // R4 A6: the preview's sample recipient, and the chips' insertion at the caret.
  const [sample, setSample] = useState<SampleRecipient>(defaultSample);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const insertToken = (token: BroadcastPlaceholderToken) => {
    const text = `{${token}}`;
    const area = bodyRef.current;
    const at = area?.selectionStart ?? state.body.length;
    const end = area?.selectionEnd ?? at;
    const next = `${state.body.slice(0, at)}${text}${state.body.slice(end)}`;
    if (next.length > max) return;
    set({ body: next });
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(at + text.length, at + text.length);
    });
  };

  // R5C-2 B2: a table skeleton at the caret, on lines of its own.
  const insertTableBlock = () => {
    const area = bodyRef.current;
    const at = area?.selectionStart ?? state.body.length;
    const end = area?.selectionEnd ?? at;
    const inserted = insertTable(state.body, at, end, t('web.table_block_skeleton'), max);
    if (inserted === null) return;
    set({ body: inserted.next });
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(inserted.caret, inserted.caret);
    });
  };

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
            : state.buttons
                .filter(
                  (button) =>
                    button.label.trim() !== '' ||
                    (button.kind === 'URL' && button.url.trim() !== ''),
                )
                .map(wireButton),
        audience: wireAudience(state.audience),
        purpose: state.purpose,
        source: sourceOf(state),
        pin: state.pin,
      };
      return record === null
        ? createBroadcast({ ...content, idempotencyKey: submission.current(content) })
        : updateBroadcast(record.id, {
            ...content,
            expectedVersion: base?.version ?? record.version,
          });
    },
    onSuccess: (response) => {
      submission.settle();
      // The saved draft is the new base: the edits are no longer unsaved.
      setBase(response.broadcast);
      setState(initial(response.broadcast));
      setStale(false);
      toast({ tone: 'ok', message: t('web.bc_saved') });
      void client.invalidateQueries({ queryKey: ['broadcasts'] });
      void client.invalidateQueries({ queryKey: ['broadcast', response.broadcast.id] });
      // Saved, so leaving for the new draft is not leaving unsaved work.
      if (record === null) {
        navigate(`/broadcasts/${encodeURIComponent(response.broadcast.id)}`, { force: true });
      }
    },
    // A 409 (the draft moved on): read it again, so the next save is against what is there.
    onError: (error) =>
      submission.settleOn(error, {
        onConflict: () => {
          if (record !== null) {
            void client.invalidateQueries({ queryKey: ['broadcast', record.id] });
          }
        },
      }),
  });

  const saveDisabled =
    save.isPending ||
    stale ||
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
      {stale && (
        <div className="cb-form-error">
          <Banner tone="warn">
            {t('web.bcx_draft_changed')}
            <span className="form-actions">
              <Button size="sm" onClick={loadLatest}>
                {t('web.bcx_draft_load_latest')}
              </Button>
              <Button size="sm" variant="ghost" onClick={keepMine}>
                {t('web.bcx_draft_keep_mine')}
              </Button>
            </span>
          </Banner>
        </div>
      )}
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
                    ref={bodyRef}
                    rows={7}
                    dir="auto"
                    value={state.body}
                    maxLength={max}
                    onChange={(event) => set({ body: event.target.value })}
                  />
                </Field>
                {/* R4 A6: a chip inserts its token where the caret is, in the bot's syntax. */}
                <div className="bc-chips" role="group" aria-label={t('web.bc_placeholders')}>
                  <span className="muted small">{t('web.bc_placeholders')}:</span>
                  {BROADCAST_PLACEHOLDER_TOKENS.map((token) => (
                    <button
                      key={token}
                      type="button"
                      className="chip bc-chip"
                      title={`{${token}}`}
                      onClick={() => insertToken(token)}
                    >
                      {t(BROADCAST_PLACEHOLDER_LABELS[token])}
                    </button>
                  ))}
                </div>
                <div className="bc-chips" role="group" aria-label={t('web.table_block_insert')}>
                  <button type="button" className="chip bc-chip" onClick={insertTableBlock}>
                    {t('web.table_block_insert')}
                  </button>
                </div>
                <p className="muted small">{t('web.table_block_hint')}</p>
                <p className="muted small">{t('web.bc_placeholders_safe_hint')}</p>
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
                ) : presentation.data === undefined ? (
                  <span className="faint">{t('web.loading')}</span>
                ) : (
                  <TextWithTables
                    text={renderBroadcastPreview(state.body, presentation.data, sample)}
                  />
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
            {/*
              R4 A6: the sample recipient — typed here, drawn in the preview above and nowhere
              else; never saved, never sent.
            */}
            {!isSourcedBroadcastKind(state.contentKind) && (
              <fieldset className="bc-sample">
                <legend className="field-group-head">{t('web.bc_sample_title')}</legend>
                <p className="muted small">{t('web.bc_sample_hint')}</p>
                <div className="form-grid">
                  {SAMPLE_FIELDS.map(([field, label]) => (
                    <Field key={field} label={t(label)} htmlFor={`bc-sample-${field}`}>
                      <input
                        id={`bc-sample-${field}`}
                        dir={field === 'firstName' ? 'auto' : 'ltr'}
                        inputMode={
                          field === 'servicesTotal' ||
                          field === 'servicesActive' ||
                          field === 'telegramId'
                            ? 'numeric'
                            : undefined
                        }
                        value={sample[field]}
                        onChange={(event) =>
                          setSample((current) => ({ ...current, [field]: event.target.value }))
                        }
                      />
                    </Field>
                  ))}
                </div>
              </fieldset>
            )}
          </aside>
        </div>
      </FormSection>

      {state.contentKind !== 'FORWARD' && (
        <FormSection id="bc-section-buttons" title={t('web.bc_buttons')} grid={false}>
          <div className="stack-sm">
            <p className="muted small">{t('web.bc_buttons_hint')}</p>
            {state.buttons.map((button, index) => (
              <div className="form-grid" key={index}>
                {/* R4 A6: a link, or one of the bot's own actions — the main menu's route. */}
                <Field label={t('web.bc_button_kind')} htmlFor={`bc-btn-kind-${String(index)}`}>
                  <select
                    id={`bc-btn-kind-${String(index)}`}
                    value={button.kind}
                    onChange={(event) => {
                      const kind = event.target.value === 'ACTION' ? 'ACTION' : 'URL';
                      set({
                        buttons: state.buttons.map((item, at) =>
                          at === index
                            ? {
                                ...item,
                                kind,
                                label:
                                  kind === 'ACTION' && item.label.trim() === ''
                                    ? t(BROADCAST_ACTION_LABELS[item.action])
                                    : item.label,
                              }
                            : item,
                        ),
                      });
                    }}
                  >
                    <option value="URL">{t('web.bc_button_kind_url')}</option>
                    <option value="ACTION">{t('web.bc_button_kind_action')}</option>
                  </select>
                </Field>
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
                {button.kind === 'URL' ? (
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
                ) : (
                  <Field
                    label={t('web.bc_button_action')}
                    htmlFor={`bc-btn-action-${String(index)}`}
                  >
                    <select
                      id={`bc-btn-action-${String(index)}`}
                      value={button.action}
                      onChange={(event) => {
                        const action = event.target.value as BroadcastAction;
                        set({
                          buttons: state.buttons.map((item, at) =>
                            at === index
                              ? {
                                  ...item,
                                  action,
                                  // A label still the previous action's own name follows the
                                  // new one; a label the operator typed is kept.
                                  label:
                                    item.label.trim() === '' ||
                                    item.label === t(BROADCAST_ACTION_LABELS[item.action])
                                      ? t(BROADCAST_ACTION_LABELS[action])
                                      : item.label,
                                }
                              : item,
                          ),
                        });
                      }}
                    >
                      {BROADCAST_ACTIONS.map((action) => (
                        <option key={action} value={action}>
                          {t(BROADCAST_ACTION_LABELS[action])}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>
            ))}
            <div className="form-actions">
              <Button
                size="sm"
                icon="plus"
                disabled={state.buttons.length >= BROADCAST_BUTTONS_MAX}
                onClick={() =>
                  set({
                    buttons: [
                      ...state.buttons,
                      { kind: 'URL', label: '', url: 'https://', action: 'CATALOG' },
                    ],
                  })
                }
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
          <Banner tone="danger">
            {broadcastMessage(save.error)}
            <ErrorRef error={save.error} />
          </Banner>
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
  /*
   * The picker is drawn afresh after every upload attempt (PR #285 review, A5), as on
   * tickets: a refused file no longer reads as chosen, and the new native input has no
   * value, so picking the SAME file again fires its change and is tried again.
   */
  const [attempt, setAttempt] = useState(0);
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
    onSettled: () => setAttempt((current) => current + 1),
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
        <FilePicker
          key={attempt}
          label={t('web.bc_media_pick')}
          kind={
            record.contentKind === 'PHOTO'
              ? 'image'
              : record.contentKind === 'VIDEO'
                ? 'video'
                : 'any'
          }
          accept={accept}
          disabled={blocked || upload.isPending}
          onFiles={(files) => {
            const file = files[0];
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
      {upload.error !== null && (
        <Banner tone="danger">
          {broadcastMessage(upload.error)}
          <ErrorRef error={upload.error} />
        </Banner>
      )}
    </Card>
  );
}

function LaunchCard({
  record,
  blocked = false,
}: {
  record: BroadcastResponseItem;
  /** Unsaved composer edits: the test and the count read the SAVED draft, so both wait. */
  blocked?: boolean;
}) {
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
  /** The last test's answer, kept on the card: a toast is gone before it is read. */
  const [tested, setTested] = useState<BroadcastTestResponse['outcome'] | null>(null);
  const test = useMutation({
    mutationFn: () => testBroadcast(record.id),
    onSuccess: (response) => {
      setTested(response.outcome);
      toast({
        tone: response.outcome === 'SENT' ? 'ok' : 'warn',
        message: t(TEST_OUTCOME_LABELS[response.outcome]),
      });
      // A test that reached the operator verified a FORWARD/COPY source: read it back.
      void client.invalidateQueries({ queryKey: ['broadcast', record.id] });
    },
    // Every test — sent, not sent, or refused — is a row of the broadcast's history.
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['broadcast-history', record.id] });
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
      // A 409 (the draft or its audience moved on): read the draft again before a new count.
      submission.settleOn(error, {
        onConflict: () => void client.invalidateQueries({ queryKey: ['broadcast', record.id] }),
      });
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
          {record.sourceVerifiedAt === null ? (
            t('web.bc_source_verified_no')
          ) : (
            <>
              {t('web.bc_source_verified_yes')} ({formatTimestamp(record.sourceVerifiedAt)})
            </>
          )}
        </Banner>
      )}
      {sourced && <p className="muted small">{t('web.bcx_source_per_bot')}</p>}
      {blocked && <Banner tone="info">{t('web.bcx_save_before_test')}</Banner>}
      <div className="form-actions">
        <Button
          size="sm"
          icon="send"
          disabled={blocked || test.isPending}
          onClick={() => test.mutate()}
        >
          {t('web.bc_test')}
        </Button>
        <Button
          size="sm"
          icon="users"
          disabled={blocked || count.isPending}
          onClick={() => count.mutate()}
        >
          {t('web.bc_count')}
        </Button>
      </div>
      {tested !== null && (
        <p className="muted small" role="status">
          {t('web.bcx_test_last')}: {t(TEST_OUTCOME_LABELS[tested])}
        </p>
      )}
      {test.error !== null && (
        <Banner tone="danger">
          {broadcastMessage(test.error)}
          <ErrorRef error={test.error} />
        </Banner>
      )}
      {count.error !== null && (
        <Banner tone="danger">
          {broadcastMessage(count.error)}
          <ErrorRef error={count.error} />
        </Banner>
      )}
      {preview !== null && (
        <>
          <div className="stat-grid cb-stat-row">
            <StatCard label={t('web.bc_recipients')} value={formatNumber(preview.customers)} />
            <StatCard
              label={t('web.aud_count_reachable')}
              value={formatNumber(preview.reachable)}
            />
            {/* Counted and frozen, but recorded UNREACHABLE at once: no bot to send through. */}
            {preview.customers > preview.reachable && (
              <StatCard
                label={t('web.bcx_no_bot')}
                value={formatNumber(preview.customers - preview.reachable)}
                hint={t('web.bcx_no_bot_hint')}
              />
            )}
            {/* Broadcast V2: an estimate only — the send's stamp decides (since #143). */}
            {preview.optedOut !== null && preview.optedOut !== undefined && (
              <StatCard
                label={t('web.bc_estimate_opted_out')}
                value={formatNumber(preview.optedOut)}
                hint={t('web.bc_estimate_opted_out_hint')}
              />
            )}
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
                    <DateField
                      id="bc-at"
                      mode="datetime"
                      value={scheduledAt}
                      onChange={setScheduledAt}
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
                  disabled={!ready || blocked || launch.isPending}
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
      {launch.error !== null && (
        <Banner tone="danger">
          {broadcastMessage(launch.error)}
          <ErrorRef error={launch.error} />
        </Banner>
      )}
    </Card>
  );
}

function ReportCard({ record, maySend }: { record: BroadcastResponseItem; maySend: boolean }) {
  const client = useQueryClient();
  const steer = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'cancel' | 'retryFailed') =>
      steerBroadcast(record.id, action),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['broadcast', record.id] });
      // A retry on a PAUSED broadcast leaves its state — the failures' key — unchanged and
      // nothing polls while paused, so the reasons are asked again here, not left stale.
      void client.invalidateQueries({ queryKey: ['broadcast-failures', record.id] });
      // Roadmap C2: the per-bot split and the history record the steer too.
      void client.invalidateQueries({ queryKey: ['broadcast-bots', record.id] });
      void client.invalidateQueries({ queryKey: ['broadcast-history', record.id] });
    },
  });
  const [cancelAsked, setCancelAsked] = useState(false);
  const [retryAsked, setRetryAsked] = useState(false);
  const c = record.counts;
  const outcome = broadcastOutcome(record.state, c);
  return (
    <Card
      title={t('web.bc_report')}
      {...(outcome === null
        ? {}
        : {
            actions: (
              <Badge tone={OUTCOME_TONES[outcome]}>
                {t('web.bc_outcome')}: {t(OUTCOME_LABELS[outcome])}
              </Badge>
            ),
          })}
    >
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
            <Button
              size="sm"
              icon="pause"
              disabled={steer.isPending}
              onClick={() => steer.mutate('pause')}
            >
              {t('web.bc_pause')}
            </Button>
          )}
          {record.state === 'PAUSED' && (
            <Button
              size="sm"
              icon="play"
              disabled={steer.isPending}
              onClick={() => steer.mutate('resume')}
            >
              {t('web.bc_resume')}
            </Button>
          )}
          {c.failed > 0 && ['SENDING', 'PAUSED', 'COMPLETED'].includes(record.state) && (
            <Button
              size="sm"
              icon="refresh"
              disabled={steer.isPending}
              onClick={() => setRetryAsked(true)}
            >
              {t('web.bc_retry_failed')} ({formatNumber(c.failed)})
            </Button>
          )}
          <span className="spacer" />
          {['SCHEDULED', 'SENDING', 'PAUSED'].includes(record.state) && (
            <Button
              size="sm"
              variant="danger"
              disabled={steer.isPending}
              onClick={() => setCancelAsked(true)}
            >
              {t('web.bc_cancel')}
            </Button>
          )}
        </div>
      )}
      {retryAsked && (
        <ConfirmDialog
          title={record.title}
          question={t('web.bcx_retry_question').replace('{count}', formatNumber(c.failed))}
          detail={t('web.bcx_retry_detail')}
          confirmLabel={t('web.bcx_retry_confirm')}
          cancelLabel={t('web.bc_back')}
          onConfirm={() => {
            setRetryAsked(false);
            steer.mutate('retryFailed');
          }}
          onCancel={() => setRetryAsked(false)}
        />
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
      {steer.error !== null && (
        <Banner tone="danger">
          {broadcastMessage(steer.error)}
          <ErrorRef error={steer.error} />
        </Banner>
      )}
    </Card>
  );
}

/*
 * Broadcast V2 (program §19): how a COMPLETED broadcast went, derived from its counts by the
 * contract's one `broadcastOutcome`, and why recipients were not delivered.
 */
const OUTCOME_LABELS: Readonly<Record<BroadcastOutcome, WebKey>> = {
  DELIVERED: 'web.bc_outcome_delivered',
  PARTIAL: 'web.bc_outcome_partial',
  FAILED: 'web.bc_outcome_failed',
};
const OUTCOME_TONES: Readonly<Record<BroadcastOutcome, Tone>> = {
  DELIVERED: 'ok',
  PARTIAL: 'warn',
  FAILED: 'danger',
};

function FailuresCard({ id, broadcastState }: { id: string; broadcastState: BroadcastState }) {
  const reasons = useQuery({
    queryKey: ['broadcast-failures', id, broadcastState],
    queryFn: () => fetchBroadcastFailures(id),
    refetchInterval: broadcastState === 'SENDING' ? BROADCAST_LIVE_REFRESH_MS : false,
  });
  const rows = reasons.data?.reasons ?? [];
  return (
    <Card title={t('web.bc_failures_title')} hint={t('web.bc_failures_hint')}>
      <StateSwitch query={reasons}>
        {rows.length === 0 ? (
          <Empty variant="compact" title={t('web.bc_failures_empty')} />
        ) : (
          <DataTable
            caption={t('web.bc_failures_title')}
            dense
            rows={rows}
            rowKey={(row) => `${row.state}:${row.errorCode ?? ''}`}
            columns={[
              {
                key: 'state',
                header: t('web.bc_failures_state'),
                render: (row) => (
                  <Badge tone={RECIPIENT_TONES[row.state]}>{t(RECIPIENT_LABELS[row.state])}</Badge>
                ),
              },
              {
                key: 'reason',
                header: t('web.bc_failures_reason'),
                render: (row) =>
                  row.errorCode === null ? (
                    <span className="muted">{t('web.bc_failures_no_code')}</span>
                  ) : (
                    <Reason code={row.errorCode} />
                  ),
              },
              {
                key: 'count',
                header: t('web.bc_failures_count'),
                render: (row) => <span className="num">{formatNumber(row.count)}</span>,
              },
            ]}
          />
        )}
      </StateSwitch>
    </Card>
  );
}

const BOT_STATUS_LABELS: Readonly<Record<string, WebKey>> = {
  ACTIVE: 'web.bcx_bot_active',
  STOPPED: 'web.bcx_bot_stopped',
  DISABLED: 'web.bcx_bot_disabled',
};

/**
 * Roadmap C2 — delivery per bot. Each recipient goes through the bot the customer first wrote
 * to, frozen at launch; each bot is paced and held on its own. So a bot that cannot reach a
 * FORWARD/COPY source, or that Telegram is holding after a 429, shows here as that bot's row,
 * and the others' rows show they are unaffected.
 */
function BotsCard({ id, broadcastState }: { id: string; broadcastState: BroadcastState }) {
  const bots = useQuery({
    queryKey: ['broadcast-bots', id, broadcastState],
    queryFn: () => fetchBroadcastBots(id),
    refetchInterval: broadcastState === 'SENDING' ? BROADCAST_LIVE_REFRESH_MS : false,
  });
  const rows = bots.data?.bots ?? [];
  return (
    <Card title={t('web.bcx_bots_title')} hint={t('web.bcx_bots_hint')}>
      <StateSwitch query={bots}>
        {rows.length === 0 ? (
          <Empty variant="compact" title={t('web.bcx_bots_empty')} />
        ) : (
          <DataTable
            caption={t('web.bcx_bots_title')}
            dense
            rows={rows}
            rowKey={(row) => row.botInstanceId ?? 'none'}
            columns={[
              {
                key: 'bot',
                header: t('web.bcx_bot'),
                render: (row) =>
                  row.botInstanceId === null ? (
                    <span className="muted">{t('web.bcx_bot_none')}</span>
                  ) : (
                    <span className="bcx-bot">
                      <Ltr>
                        {row.botUsername === null
                          ? row.botInstanceId.slice(0, 8)
                          : `@${row.botUsername}`}
                      </Ltr>
                      {row.botStatus !== null && row.botStatus !== 'ACTIVE' && (
                        <Badge tone="danger">
                          {t(BOT_STATUS_LABELS[row.botStatus] ?? 'web.bcx_bot_disabled')}
                        </Badge>
                      )}
                    </span>
                  ),
              },
              {
                key: 'sent',
                header: t('web.bc_r_sent'),
                render: (row) => (
                  <span className="num">
                    {formatNumber(row.counts.sent)} / {formatNumber(row.counts.total)}
                  </span>
                ),
              },
              {
                key: 'pending',
                header: t('web.bc_r_pending'),
                render: (row) => (
                  <span className="num">
                    {formatNumber(row.counts.pending + row.counts.sending)}
                  </span>
                ),
              },
              {
                key: 'retry',
                header: t('web.bcx_waiting_retry'),
                render: (row) => <span className="num">{formatNumber(row.waitingRetry)}</span>,
              },
              {
                key: 'failed',
                header: t('web.bc_r_failed'),
                render: (row) => (
                  <span className="num">
                    {formatNumber(row.counts.failed)}
                    {row.counts.unconfirmed > 0 &&
                      ` · ${t('web.bcx_unconfirmed_short')} ${formatNumber(row.counts.unconfirmed)}`}
                  </span>
                ),
              },
              {
                key: 'unreachable',
                header: t('web.bcx_unreachable_short'),
                render: (row) => (
                  <span className="num">
                    {formatNumber(row.counts.unreachable + row.counts.skipped)}
                  </span>
                ),
              },
              {
                key: 'held',
                header: t('web.bcx_held'),
                render: (row) =>
                  row.heldUntil === null ? (
                    '—'
                  ) : (
                    <Badge tone="warn">
                      {t('web.bcx_held_until')} {formatTimestamp(row.heldUntil)}
                    </Badge>
                  ),
              },
            ]}
          />
        )}
      </StateSwitch>
    </Card>
  );
}

const HISTORY_LABELS: Readonly<Record<BroadcastHistoryAction, WebKey>> = {
  'broadcast.create': 'web.bcx_h_create',
  'broadcast.update': 'web.bcx_h_update',
  'broadcast.media_set': 'web.bcx_h_media_set',
  'broadcast.media_remove': 'web.bcx_h_media_remove',
  'broadcast.test': 'web.bcx_h_test',
  'broadcast.launch': 'web.bcx_h_launch',
  'broadcast.pause': 'web.bcx_h_pause',
  'broadcast.resume': 'web.bcx_h_resume',
  'broadcast.cancel': 'web.bcx_h_cancel',
  'broadcast.retry_failed': 'web.bcx_h_retry_failed',
};

/**
 * Roadmap C2 — what was done to this broadcast: tests (with what Telegram answered), the
 * launch, every pause, resume and cancel, and every re-queue with how many it put back. A
 * refused attempt is listed as refused. Read from the broadcast's own audit rows.
 */
function HistoryCard({
  id,
  broadcastState,
  version,
}: {
  id: string;
  broadcastState: BroadcastState;
  /** A saved edit or a media change bumps it: each is a history row of its own. */
  version: number;
}) {
  const history = useQuery({
    queryKey: ['broadcast-history', id, broadcastState, version],
    queryFn: () => fetchBroadcastHistory(id),
  });
  const rows = history.data?.entries ?? [];
  const truncated = history.data?.truncated === true;
  return (
    <Card title={t('web.bcx_history_title')}>
      <StateSwitch query={history}>
        {rows.length === 0 ? (
          <Empty variant="compact" title={t('web.bcx_history_empty')} />
        ) : (
          <>
            {' '}
            <ul className="bcx-history small">
              {rows.map((row) => (
                <li key={row.id}>
                  <span className="num">{formatTimestamp(row.occurredAt)}</span>{' '}
                  <strong>{t(HISTORY_LABELS[row.action])}</strong>
                  {row.actorLabel !== null && <> · {row.actorLabel}</>}
                  {row.testOutcome !== null && <> · {t(TEST_OUTCOME_LABELS[row.testOutcome])}</>}
                  {row.requeued !== null && (
                    <> · {t('web.bcx_h_requeued').replace('{count}', formatNumber(row.requeued))}</>
                  )}
                  {row.result !== 'SUCCESS' && (
                    <>
                      {' '}
                      <Badge tone="danger">{t('web.bcx_h_refused')}</Badge>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {/* Review N4: the newest rows are shown; say so when older ones exist. */}
            {truncated && <p className="muted small">{t('web.bcx_history_truncated')}</p>}
          </>
        )}
      </StateSwitch>
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
  const rows = useQuery(
    keepPageWhileTurning({
      queryKey: ['broadcast-recipients', id, state, cursor],
      queryFn: () =>
        fetchBroadcastRecipients(id, {
          limit: LIST_PAGE_SIZE,
          ...(state === '' ? {} : { state }),
          ...(cursor === undefined ? {} : { cursor }),
        }),
      refetchInterval: broadcastState === 'SENDING' ? BROADCAST_LIVE_REFRESH_MS : false,
    }),
  );
  const seenState = useRef(broadcastState);
  useEffect(() => {
    if (seenState.current !== broadcastState) {
      void client.invalidateQueries({ queryKey: ['broadcast-recipients', id] });
    }
    seenState.current = broadcastState;
  }, [broadcastState, client, id]);
  return (
    <Card title={t('web.bc_recipients')}>
      <ListFilterBar
        label={t('web.bc_recipients')}
        filters={[
          {
            key: 'state',
            label: t('web.bc_state'),
            active: state === '' ? null : t(RECIPIENT_LABELS[state]),
            onClear: () => {
              setState('');
              setTrail([]);
            },
            control: (
              <select
                id="bc-r-state"
                className="input sm"
                aria-label={t('web.bc_state')}
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
            ),
          },
        ]}
      />
      <StateSwitch query={rows}>
        {rows.data === undefined ? null : (
          <>
            <DataTable
              caption={t('web.bc_recipients')}
              columns={[
                {
                  key: 'who',
                  header: t('web.bc_customer'),
                  render: (row) =>
                    row.firstName ??
                    row.username ?? (
                      <RecordLink
                        href={recordHref.customer(row.customerId)}
                        id={row.customerId}
                        code={null}
                      />
                    ),
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
                  render: (row) => (row.errorCode === null ? '—' : <Reason code={row.errorCode} />),
                },
                {
                  key: 'at',
                  header: t('web.bc_resolved_at'),
                  // Roadmap C2: a deferred or retried recipient says when it is due again.
                  // Absent from an older API replica during an update: no next attempt shown.
                  render: (row) => {
                    if (row.resolvedAt !== null) return formatTimestamp(row.resolvedAt);
                    const next = row.nextAttemptAt ?? null;
                    return next === null
                      ? '—'
                      : `${t('web.bcx_next_attempt')} ${formatTimestamp(next)}`;
                  },
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
                        {t(PIN_LABELS[row.pinState])}{' '}
                        {/* The pin's reason in words; the transport code in its title. */}
                        <span className="muted small" title={row.pinErrorCode}>
                          {broadcastReasonLabel(row.pinErrorCode) ?? <Ltr>{row.pinErrorCode}</Ltr>}
                        </span>
                      </>
                    ),
                },
              ]}
              rows={rows.data.recipients}
              rowKey={(row) => row.customerId}
              dense
            />
            <CursorPager
              order="sequence"
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
  const botNames = useCachedBotNames();
  const presentation = useBroadcastPresentation();
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
        {describeAudience(record.audience, botNames).map((line) => (
          <li key={line}>{jalaliDatesIn(line)}</li>
        ))}
      </ul>
      {!isSourcedBroadcastKind(record.contentKind) && (
        <>
          <h3>{t('web.bc_preview')}</h3>
          <div className="bc-phone">
            <div className="broadcast-preview bc-bubble" dir="auto">
              {presentation.data === undefined ? (
                <span className="faint">{t('web.loading')}</span>
              ) : (
                <TextWithTables text={renderBroadcastPreview(record.body, presentation.data)} />
              )}
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
                  <Composer
                    key={`composer-${record.id}`}
                    record={record}
                    onDirtyChange={setComposerDirty}
                  />
                  <MediaCard record={record} blocked={composerDirty} />
                  {/* Keyed by version: a saved edit (purpose, audience, text) voids the count
                      and its estimate, which were answers about the draft as it was. */}
                  <LaunchCard
                    key={`launch-${String(record.version)}`}
                    record={record}
                    blocked={composerDirty}
                  />
                </>
              )}
              {summary}
              <HistoryCard id={record.id} broadcastState={record.state} version={record.version} />
            </>
          ) : (
            <TwoColumn
              main={
                <>
                  <ReportCard record={record} maySend={maySend} />
                  <BotsCard id={record.id} broadcastState={record.state} />
                  <FailuresCard id={record.id} broadcastState={record.state} />
                  <RecipientsCard id={record.id} broadcastState={record.state} />
                </>
              }
              side={
                <>
                  {summary}
                  <HistoryCard
                    id={record.id}
                    broadcastState={record.state}
                    version={record.version}
                  />
                </>
              }
            />
          )}
        </>
      )}
    </StateSwitch>
  );
}
