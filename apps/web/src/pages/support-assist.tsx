import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BUSINESS_MESSAGE_TEXT_MAX,
  SUPPORT_AI_DRAFT_UNCLAIMED_SECONDS,
  supportAiDraftSendRequestSchema,
  type SupportAiDecisionKind,
  type SupportAiDraftView,
  type SupportAiJobState,
  type SupportAiTopic,
} from '@nexa/contracts';
import {
  ApiError,
  discardSupportAiDraft,
  fetchSupportAiDrafts,
  newIdempotencyKey,
  requestSupportAiDraft,
  sendSupportAiDraft,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { pollUnlessFinalWhile } from '../polling';
import { useSubmissionKey } from '../submission-key';
import { messageFor } from './settings';
import { SUPPORT_AI_PROVIDER_LABELS } from './support-ai';
import {
  Badge,
  Banner,
  Card,
  Field,
  KV,
  Ltr,
  Num,
  StateSwitch,
  useToast,
  type Tone,
} from '../ui/kit';
import { Icon } from '../ui/icons';

/**
 * TB5 — Assist Mode on one business conversation (ADR-0034 §6).
 *
 * The AI DRAFTS; the operator decides. Requesting a draft sends nothing to the customer,
 * and neither does a draft becoming ready: the only path from a draft to the customer is
 * the operator pressing «send», and what is sent is the text in the box as they left it.
 *
 * The server charges `support_ai.assist` for every read and write here and also
 * `business_chats.reply` for a send; the `mayReply` prop only decides whether the send
 * button is drawn. The draft's state is the server's, read back after every write and on a
 * short poll while a draft is still being written.
 */

/** How often the drafts are read again while one is still QUEUED. */
export const ASSIST_POLL_MS = 3_000;

/**
 * How long the screen waits on a QUEUED draft: the server's unclaimed bound plus two polls'
 * grace, so the poll that reads the server's own `job.unclaimed` verdict still happens (PR #200
 * review, finding 6). After it the screen stops polling and offers a new request — which the
 * server answers by ending the old draft. The server decides; this only bounds the polling.
 */
export const ASSIST_WAIT_MS = SUPPORT_AI_DRAFT_UNCLAIMED_SECONDS * 1_000 + 2 * ASSIST_POLL_MS;

/** A QUEUED draft the screen is still waiting on. */
export function awaitingDraft(draft: SupportAiDraftView, nowMs: number = Date.now()): boolean {
  return draft.state === 'QUEUED' && nowMs - Date.parse(draft.createdAt) < ASSIST_WAIT_MS;
}

export const ASSIST_STATE_LABELS: Readonly<Record<SupportAiJobState, WebKey>> = {
  QUEUED: 'web.assist_state_queued',
  READY: 'web.assist_state_ready',
  FAILED: 'web.assist_state_failed',
  SENT: 'web.assist_state_sent',
  DISCARDED: 'web.assist_state_discarded',
};

const STATE_TONES: Readonly<Record<SupportAiJobState, Tone>> = {
  QUEUED: 'warn',
  READY: 'info',
  FAILED: 'neutral',
  SENT: 'ok',
  DISCARDED: 'neutral',
};

const DECISION_LABELS: Readonly<Record<SupportAiDecisionKind, WebKey>> = {
  REPLY: 'web.assist_decision_reply',
  ASK_CLARIFYING_QUESTION: 'web.assist_decision_ask',
  HANDOFF: 'web.assist_decision_handoff',
  CREATE_OR_LINK_TICKET: 'web.assist_decision_ticket',
  NO_ACTION: 'web.assist_decision_no_action',
};

const CONFIDENCE_LABELS: Readonly<Record<'LOW' | 'MEDIUM' | 'HIGH', WebKey>> = {
  LOW: 'web.assist_confidence_low',
  MEDIUM: 'web.assist_confidence_medium',
  HIGH: 'web.assist_confidence_high',
};

const CONFIDENCE_TONES: Readonly<Record<'LOW' | 'MEDIUM' | 'HIGH', Tone>> = {
  LOW: 'danger',
  MEDIUM: 'warn',
  HIGH: 'ok',
};

export const ASSIST_TOPIC_LABELS: Readonly<Record<SupportAiTopic, WebKey>> = {
  CONNECTION_TROUBLESHOOTING: 'web.assist_topic_connection_troubleshooting',
  APP_SETUP: 'web.assist_topic_app_setup',
  SUBSCRIPTION_UPDATE: 'web.assist_topic_subscription_update',
  SERVICE_INFO: 'web.assist_topic_service_info',
  TRAFFIC_AND_EXPIRY: 'web.assist_topic_traffic_and_expiry',
  PLAN_INFO: 'web.assist_topic_plan_info',
  KNOWN_ERROR: 'web.assist_topic_known_error',
  GREETING: 'web.assist_topic_greeting',
  REFUND: 'web.assist_topic_refund',
  WALLET: 'web.assist_topic_wallet',
  PAYMENT_DISPUTE: 'web.assist_topic_payment_dispute',
  PAYMENT_STATUS: 'web.assist_topic_payment_status',
  RECEIPT_REVIEW: 'web.assist_topic_receipt_review',
  SERVICE_DELETE_OR_TERMINATE: 'web.assist_topic_service_delete',
  OWNERSHIP_OR_ACCOUNT_TRANSFER: 'web.assist_topic_ownership_transfer',
  ACCOUNT_SECURITY: 'web.assist_topic_account_security',
  CREDENTIALS: 'web.assist_topic_credentials',
  PROVIDER_CHANGE: 'web.assist_topic_provider_change',
  FRAUD_OR_CHARGEBACK: 'web.assist_topic_fraud',
  LEGAL_OR_SAFETY: 'web.assist_topic_legal',
  HUMAN_REQUESTED: 'web.assist_topic_human_requested',
  OTHER: 'web.assist_topic_other',
};

const FAULTS: Readonly<Record<string, WebKey>> = {
  'support_ai.off': 'web.assist_fault_off',
  'support_ai.draft_not_found': 'web.assist_fault_not_found',
  'support_ai.draft_not_ready': 'web.assist_fault_not_ready',
  'business_chats.not_found': 'web.bchat_fault_not_found',
  'business_chats.connection_unusable': 'web.bchat_fault_connection',
  'business_chats.idempotency_payload_mismatch': 'web.bchat_fault_retry',
  'platform.idempotency_payload_mismatch': 'web.bchat_fault_retry',
};

export function assistFault(error: unknown): string {
  if (error instanceof ApiError) {
    const key = FAULTS[error.code];
    if (key !== undefined) return t(key);
  }
  return messageFor(error);
}

function draftsKey(conversationId: string) {
  return ['support-ai-drafts', conversationId] as const;
}

export function AssistCard({
  conversationId,
  mayReply,
  connected,
}: {
  conversationId: string;
  mayReply: boolean;
  connected: boolean;
}) {
  const queries = useQueryClient();
  const drafts = useQuery({
    queryKey: draftsKey(conversationId),
    queryFn: () => fetchSupportAiDrafts(conversationId),
    refetchInterval: pollUnlessFinalWhile<{ drafts: SupportAiDraftView[] }>(
      ASSIST_POLL_MS,
      (data) => data.drafts.some((draft) => awaitingDraft(draft)),
    ),
  });
  const request = useMutation({
    // One key per CLICK, passed as the variable, so react-query's retry reuses it and a
    // second press is a second request.
    mutationFn: (idempotencyKey: string) =>
      requestSupportAiDraft({ conversationId, idempotencyKey }),
    onSettled: () => void queries.invalidateQueries({ queryKey: draftsKey(conversationId) }),
  });
  const rows = [...(drafts.data?.drafts ?? [])].sort((a, b) =>
    b.createdAt === a.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt),
  );
  const queued = rows.some((draft) => awaitingDraft(draft));

  return (
    <Card
      title={t('web.assist_title')}
      hint={t('web.assist_hint')}
      actions={
        <button
          type="button"
          className="btn primary sm"
          disabled={request.isPending || queued}
          onClick={() => request.mutate(newIdempotencyKey())}
        >
          <Icon name="zap" />
          {t('web.assist_request')}
        </button>
      }
    >
      <Banner tone="info" icon="info">
        {t('web.assist_nothing_sent')}
      </Banner>
      {request.error !== null && (
        <Banner tone="danger" role="alert">
          {assistFault(request.error)}
        </Banner>
      )}
      <StateSwitch
        query={drafts}
        isEmpty={rows.length === 0}
        empty={<p className="muted small">{t('web.assist_empty')}</p>}
      >
        <ol className="plain stack" aria-label={t('web.assist_drafts')}>
          {rows.map((draft) => (
            <li key={draft.id} data-draft={draft.state}>
              <DraftItem
                draft={draft}
                conversationId={conversationId}
                mayReply={mayReply}
                connected={connected}
              />
            </li>
          ))}
        </ol>
      </StateSwitch>
    </Card>
  );
}

function DraftItem({
  draft,
  conversationId,
  mayReply,
  connected,
}: {
  draft: SupportAiDraftView;
  conversationId: string;
  mayReply: boolean;
  connected: boolean;
}) {
  return (
    <div className="stack-sm bchat-outbound-row">
      <div className="bchat-message-head">
        <Badge tone={STATE_TONES[draft.state]}>{t(ASSIST_STATE_LABELS[draft.state])}</Badge>
        <span className="muted small">{formatTimestamp(draft.createdAt)}</span>
        {draft.provider !== null && (
          <span className="muted small">
            {t(SUPPORT_AI_PROVIDER_LABELS[draft.provider])}
            {draft.model === null ? null : (
              <>
                {' '}
                <Ltr>{draft.model}</Ltr>
              </>
            )}
          </span>
        )}
      </div>
      {draft.state === 'QUEUED' && (
        <p className="muted small">
          {t(awaitingDraft(draft) ? 'web.assist_queued' : 'web.assist_queued_overdue')}
        </p>
      )}
      {draft.state === 'FAILED' && <p className="muted">{t('web.assist_failed')}</p>}
      {draft.state !== 'QUEUED' && draft.state !== 'FAILED' && <DraftFacts draft={draft} />}
      {draft.state === 'READY' && (
        <DraftEditor
          draft={draft}
          conversationId={conversationId}
          mayReply={mayReply}
          connected={connected}
        />
      )}
      {(draft.state === 'SENT' || draft.state === 'DISCARDED') && draft.suggestedReply !== null && (
        <p className="bchat-body muted">{draft.suggestedReply}</p>
      )}
      {draft.state === 'SENT' && <p className="small muted">{t('web.assist_sent_note')}</p>}
      {draft.state === 'DISCARDED' && (
        <p className="small muted">{t('web.assist_discarded_note')}</p>
      )}
    </div>
  );
}

function DraftFacts({ draft }: { draft: SupportAiDraftView }) {
  const dash = <span className="faint">—</span>;
  return (
    <>
      <KV
        items={[
          [
            t('web.assist_decision'),
            draft.decision === null ? dash : t(DECISION_LABELS[draft.decision]),
          ],
          [
            t('web.assist_topic'),
            draft.topic === null ? dash : t(ASSIST_TOPIC_LABELS[draft.topic]),
          ],
          [
            t('web.assist_confidence'),
            draft.confidence === null ? (
              dash
            ) : (
              <Badge key="c" tone={CONFIDENCE_TONES[draft.confidence]}>
                {t(CONFIDENCE_LABELS[draft.confidence])}
              </Badge>
            ),
          ],
          [t('web.assist_intent'), draft.intent ?? dash],
          [t('web.assist_summary'), draft.summary ?? dash],
        ]}
      />
      <div>
        <span className="small">{t('web.assist_based_on')}</span>{' '}
        {draft.factLabels.length === 0 ? (
          <span className="muted small">{t('web.assist_based_on_none')}</span>
        ) : (
          <ul className="plain chips" aria-label={t('web.assist_based_on')}>
            {draft.factLabels.map((label, index) => (
              // The labels are the server's and may repeat; position is their identity.
              <li key={index}>
                <Badge outline>{label}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function DraftEditor({
  draft,
  conversationId,
  mayReply,
  connected,
}: {
  draft: SupportAiDraftView;
  conversationId: string;
  mayReply: boolean;
  connected: boolean;
}) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  // Seeded ONCE from the draft: a poll that re-reads the same draft must never overwrite
  // what the operator has typed.
  const [text, setText] = useState(draft.suggestedReply ?? '');
  const parsed = supportAiDraftSendRequestSchema.shape.text.safeParse(text);
  const refresh = () => {
    void queries.invalidateQueries({ queryKey: draftsKey(conversationId) });
    void queries.invalidateQueries({ queryKey: ['business-chat', conversationId] });
    void queries.invalidateQueries({ queryKey: ['business-chats'] });
  };
  const send = useMutation({
    // The text travels as the VARIABLE, so a retry sends what the key was minted for.
    mutationFn: (body: string) =>
      sendSupportAiDraft({
        draftId: draft.id,
        idempotencyKey: submission.current({ draft: draft.id, text: body }),
        text: body,
      }),
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.assist_send_done') });
      refresh();
    },
    onError: (error) => {
      submission.settleOn(error);
      refresh();
    },
  });
  const discard = useMutation({
    mutationFn: () => discardSupportAiDraft(draft.id),
    onSuccess: () => {
      notify({ tone: 'ok', message: t('web.assist_discard_done') });
      refresh();
    },
    onError: () => refresh(),
  });
  const busy = send.isPending || discard.isPending;
  const fieldId = `assist-reply-${draft.id}`;

  return (
    <form
      className="stack-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (parsed.success && mayReply && connected) send.mutate(parsed.data);
      }}
    >
      <Field
        label={t('web.assist_reply_label')}
        htmlFor={fieldId}
        hint={t('web.assist_reply_hint')}
      >
        <textarea
          dir="auto"
          id={fieldId}
          className="input"
          rows={6}
          maxLength={BUSINESS_MESSAGE_TEXT_MAX}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      {mayReply ? (
        <Banner tone="warn" icon="info">
          {t('web.assist_send_takes_over')}
        </Banner>
      ) : (
        <p className="muted small">{t('web.assist_send_needs_reply')}</p>
      )}
      {mayReply && !connected && (
        <Banner tone="warn">{t('web.bchat_reply_connection_unusable')}</Banner>
      )}
      <div className="form-actions bchat-reply-actions">
        <span className="muted small bchat-counter" aria-live="polite">
          <Num value={text.length} /> / <Num value={BUSINESS_MESSAGE_TEXT_MAX} />
        </span>
        <div className="btn-group">
          <button type="button" className="btn sm" disabled={busy} onClick={() => discard.mutate()}>
            <Icon name="x" />
            {t('web.assist_discard')}
          </button>
          {mayReply && (
            <button
              type="submit"
              className="btn primary sm"
              disabled={!parsed.success || !connected || busy}
            >
              <Icon name="send" />
              {t('web.assist_send')}
            </button>
          )}
        </div>
      </div>
      {send.error !== null && <Banner tone="danger">{assistFault(send.error)}</Banner>}
      {discard.error !== null && <Banner tone="danger">{assistFault(discard.error)}</Banner>}
    </form>
  );
}
