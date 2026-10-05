import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BUSINESS_CONVERSATION_STATES,
  BUSINESS_MESSAGE_TEXT_MAX,
  businessTextSchema,
  type BusinessChatDetailResponse,
  type BusinessConnectionStatus,
  type BusinessConversationState,
  type BusinessConversationSummary,
  type BusinessEscalationTicketOutcome,
  type BusinessMessageKind,
  type BusinessMessageOrigin,
  type BusinessOutboundOrigin,
  type BusinessOutboundState,
  type BusinessTakeoverReason,
} from '@nexa/contracts';
import {
  ApiError,
  fetchBusinessChat,
  fetchBusinessChats,
  fetchBusinessConnections,
  resumeBusinessChat,
  sendBusinessChatMessage,
  takeOverBusinessChat,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { pollUnlessFinal } from '../polling';
import { setQuery, useLinkHandler, type Route } from '../router';
import { HANDOFF_LABELS } from './handoff-labels';
import { useSubmissionKey } from '../submission-key';
import { mayRequest } from '../view-state';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Card,
  ChipDivider,
  ConfirmDialog,
  DataTable,
  Empty,
  Field,
  FilterBar,
  FilterChip,
  FilterChips,
  IdentityCell,
  KV,
  Ltr,
  Num,
  PageHead,
  StateSwitch,
  useToast,
  useUnsavedChanges,
  type Column,
  type Tone,
} from '../ui/kit';
import { Icon, type IconName } from '../ui/icons';
import { AssistCard } from './support-assist';
import { ProposeKnowledgeButton } from './support-knowledge';

/**
 * TB2 — Telegram Business conversations (ADR-0033): the inbox, the connections it arrives
 * through, and one conversation with the operator's three controls (take over, hand back,
 * reply).
 *
 * Nothing here decides anything. The server charges `business_chats.view` to read and
 * `business_chats.reply` for every write, inside its own transactions; the `may*` props
 * only decide what is DRAWN. Who holds the conversation is the server's `state`, read back
 * after every write and on a short poll while the page is open — never inferred here from
 * which button was pressed.
 *
 * Sending is itself a takeover (ADR-0033 §4): the composer says so before the operator
 * presses send, because the AI then stays silent until somebody hands the conversation
 * back.
 */

/** How often an open conversation is read again: new messages, and the lane's outcomes. */
export const BUSINESS_CHAT_REFRESH_MS = 10_000;

export const BUSINESS_STATE_LABELS: Readonly<Record<BusinessConversationState, WebKey>> = {
  AI_ACTIVE: 'web.bchat_state_ai_active',
  HUMAN_ACTIVE: 'web.bchat_state_human_active',
  HANDOFF_REQUIRED: 'web.bchat_state_handoff_required',
  PAUSED: 'web.bchat_state_paused',
};

const STATE_TONES: Readonly<Record<BusinessConversationState, Tone>> = {
  AI_ACTIVE: 'ok',
  HUMAN_ACTIVE: 'info',
  HANDOFF_REQUIRED: 'danger',
  PAUSED: 'neutral',
};

/** One sentence per state: who answers the customer now, and what the AI does. */
const STATE_EXPLAINED: Readonly<Record<BusinessConversationState, WebKey>> = {
  AI_ACTIVE: 'web.bchat_explain_ai_active',
  HUMAN_ACTIVE: 'web.bchat_explain_human_active',
  HANDOFF_REQUIRED: 'web.bchat_explain_handoff_required',
  PAUSED: 'web.bchat_explain_paused',
};

const ESCALATION_TICKET_LABELS: Readonly<Record<BusinessEscalationTicketOutcome, WebKey>> = {
  CREATED: 'web.bchat_escalation_ticket_created',
  LINKED: 'web.bchat_escalation_ticket_linked',
  NO_CUSTOMER: 'web.bchat_escalation_no_customer',
  CUSTOMER_BLOCKED: 'web.bchat_escalation_customer_blocked',
  NO_CATEGORY: 'web.bchat_escalation_no_category',
  SCOPE_INACTIVE: 'web.bchat_escalation_scope_inactive',
};

const TAKEOVER_LABELS: Readonly<Record<BusinessTakeoverReason, WebKey>> = {
  HUMAN_MESSAGE: 'web.bchat_takeover_human_message',
  OTHER_BOT: 'web.bchat_takeover_other_bot',
  OPERATOR_TAKEOVER: 'web.bchat_takeover_operator',
  OPERATOR_SEND: 'web.bchat_takeover_operator_send',
};

export const BUSINESS_CONNECTION_LABELS: Readonly<Record<BusinessConnectionStatus, WebKey>> = {
  ACTIVE: 'web.bchat_connection_active',
  DISABLED: 'web.bchat_connection_disabled',
  RIGHTS_INSUFFICIENT: 'web.bchat_connection_rights_insufficient',
  SUPERSEDED: 'web.bchat_connection_superseded',
};

const CONNECTION_TONES: Readonly<Record<BusinessConnectionStatus, Tone>> = {
  ACTIVE: 'ok',
  DISABLED: 'neutral',
  RIGHTS_INSUFFICIENT: 'danger',
  SUPERSEDED: 'neutral',
};

export const BUSINESS_ORIGIN_LABELS: Readonly<Record<BusinessMessageOrigin, WebKey>> = {
  INBOUND: 'web.bchat_origin_inbound',
  HUMAN: 'web.bchat_origin_human',
  OWN_ECHO: 'web.bchat_origin_own_echo',
  OTHER_BOT: 'web.bchat_origin_other_bot',
  OFFLINE: 'web.bchat_origin_offline',
};

/** The glyph beside each origin; the words say it too, so colour and side only repeat it. */
const ORIGIN_ICONS: Readonly<Record<BusinessMessageOrigin, IconName>> = {
  INBOUND: 'user',
  HUMAN: 'edit',
  OWN_ECHO: 'send',
  OTHER_BOT: 'bots',
  OFFLINE: 'clock',
};

const KIND_LABELS: Readonly<Record<Exclude<BusinessMessageKind, 'TEXT'>, WebKey>> = {
  PHOTO: 'web.bchat_kind_photo',
  OTHER: 'web.bchat_kind_other',
};

export const BUSINESS_OUTBOUND_LABELS: Readonly<Record<BusinessOutboundState, WebKey>> = {
  PENDING: 'web.bchat_outbound_pending',
  DELIVERED: 'web.bchat_outbound_delivered',
  UNCONFIRMED: 'web.bchat_outbound_unconfirmed',
  FAILED: 'web.bchat_outbound_failed',
  SUPERSEDED: 'web.bchat_outbound_superseded',
};

const OUTBOUND_TONES: Readonly<Record<BusinessOutboundState, Tone>> = {
  PENDING: 'warn',
  DELIVERED: 'ok',
  UNCONFIRMED: 'warn',
  FAILED: 'danger',
  SUPERSEDED: 'neutral',
};

const OUTBOUND_ORIGIN_LABELS: Readonly<Record<BusinessOutboundOrigin, WebKey>> = {
  OPERATOR: 'web.bchat_outbound_origin_operator',
  ASSIST: 'web.bchat_outbound_origin_assist',
  AUTO: 'web.bchat_outbound_origin_auto',
};

/** The refusals this page can name better than the server's English sentence. */
const FAULTS: Readonly<Record<string, WebKey>> = {
  'business_chats.not_found': 'web.bchat_fault_not_found',
  'business_chats.connection_unusable': 'web.bchat_fault_connection',
  'business_chats.not_in_state': 'web.bchat_fault_not_in_state',
  'business_chats.idempotency_payload_mismatch': 'web.bchat_fault_retry',
  'platform.idempotency_payload_mismatch': 'web.bchat_fault_retry',
};

export function businessChatFault(error: unknown): string {
  if (error instanceof ApiError) {
    const key = FAULTS[error.code];
    if (key !== undefined) return t(key);
  }
  return messageFor(error);
}

function stateOf(raw: string | null): BusinessConversationState | null {
  return raw !== null && (BUSINESS_CONVERSATION_STATES as readonly string[]).includes(raw)
    ? (raw as BusinessConversationState)
    : null;
}

function StateBadge({ value }: { value: BusinessConversationState }) {
  return <Badge tone={STATE_TONES[value]}>{t(BUSINESS_STATE_LABELS[value])}</Badge>;
}

function ConnectionBadge({ status }: { status: BusinessConnectionStatus }) {
  return <Badge tone={CONNECTION_TONES[status]}>{t(BUSINESS_CONNECTION_LABELS[status])}</Badge>;
}

function Dash() {
  return <span className="faint">—</span>;
}

/** The customer's name as the operator should read it, or the unknown-customer label. */
function customerName(conversation: BusinessConversationSummary): string {
  const customer = conversation.customer;
  if (customer?.firstName !== null && customer?.firstName !== undefined) return customer.firstName;
  if (customer?.username !== null && customer?.username !== undefined) {
    return `@${customer.username}`;
  }
  return t('web.bchat_unknown_customer');
}

function detailPath(id: string): string {
  return `/business-chats/${encodeURIComponent(id)}`;
}

/**
 * TB10 — how long the customer has waited, in the one unit an operator reads at a glance:
 * minutes under an hour, hours under two days, days beyond. Floors, so «۵۹ دقیقه» never
 * reads as an hour; under a minute is «همین حالا». The instant is the server's
 * (`unansweredSince`); only the subtraction happens here.
 */
export function waitParts(
  sinceIso: string,
  nowMs: number,
): { readonly value: number; readonly unit: WebKey } | null {
  const elapsed = nowMs - Date.parse(sinceIso);
  if (Number.isNaN(elapsed) || elapsed < 60_000) return null;
  if (elapsed < 3_600_000) return { value: Math.floor(elapsed / 60_000), unit: 'web.unit_minutes' };
  if (elapsed < 172_800_000) {
    return { value: Math.floor(elapsed / 3_600_000), unit: 'web.unit_hours' };
  }
  return { value: Math.floor(elapsed / 86_400_000), unit: 'web.unit_days' };
}

/** The customer's wait, or a dash when nobody owes them an answer. */
function WaitAge({ since }: { since: string | null }) {
  if (since === null) return <Dash />;
  const parts = waitParts(since, Date.now());
  return (
    <span className="nowrap bchat-wait" title={formatTimestamp(since)}>
      {parts === null ? (
        t('web.bchat_wait_just_now')
      ) : (
        <>
          <Num value={parts.value} /> {t(parts.unit)}
        </>
      )}
    </span>
  );
}

function ticketPath(id: string): string {
  return `/tickets/${encodeURIComponent(id)}`;
}

// ---------------------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------------------

/**
 * The inbox's pages, flattened, each conversation ONCE (PR #205 review, N2).
 *
 * The keyset's first key is mutable: a conversation handed back to the AI between two pages
 * drops from the handoffs above the cursor to the rest below it, and the next page carries it
 * a second time. It is drawn once, where it was first drawn, with the later (fresher) read.
 * The opposite move is a SKIP, not a repeat: a conversation handed off, or with new activity,
 * after its page was read moves above the cursor, and «load more» does not show it until the
 * list is read again from the top. The handoffs-first order is what that costs; the
 * notification inbox still announces every handoff (`support.handoff_required`).
 */
export function inboxRows(
  pages: readonly { readonly conversations: readonly BusinessConversationSummary[] }[],
): BusinessConversationSummary[] {
  const position = new Map<string, number>();
  const rows: BusinessConversationSummary[] = [];
  for (const page of pages) {
    for (const row of page.conversations) {
      const at = position.get(row.id);
      if (at === undefined) {
        position.set(row.id, rows.length);
        rows.push(row);
      } else {
        rows[at] = row;
      }
    }
  }
  return rows;
}

export function BusinessChatsPage({ route, denied }: { route: Route; denied: boolean }) {
  const state = stateOf(route.query.get('state'));
  const chats = useInfiniteQuery({
    queryKey: ['business-chats', state],
    queryFn: ({ pageParam }) =>
      fetchBusinessChats({
        ...(state === null ? {} : { state }),
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !denied,
  });
  const rows = inboxRows(chats.data?.pages ?? []);
  const requestable = mayRequest(chats, denied);
  const onLink = useLinkHandler();

  const columns: readonly Column<BusinessConversationSummary>[] = [
    {
      key: 'customer',
      header: t('web.bchat_customer'),
      render: (row) => (
        <IdentityCell
          name={customerName(row)}
          username={row.customer?.firstName === null ? null : (row.customer?.username ?? null)}
          id={row.peerTelegramUserId}
          href={detailPath(row.id)}
        />
      ),
    },
    {
      key: 'state',
      header: t('web.status'),
      wrap: true,
      render: (row) => (
        <span className="bchat-state-cell">
          <StateBadge value={row.state} />
          {row.handoffReason !== null && (
            <span className="small muted">{t(HANDOFF_LABELS[row.handoffReason])}</span>
          )}
          {row.connectionStatus !== 'ACTIVE' && <ConnectionBadge status={row.connectionStatus} />}
          {row.ticketId !== null && (
            <a className="badge info bchat-ticket" href={ticketPath(row.ticketId)} onClick={onLink}>
              <Icon name="message" />
              {t('web.bchat_ticket_badge')}
            </a>
          )}
        </span>
      ),
    },
    {
      key: 'wait',
      header: t('web.bchat_wait'),
      render: (row) => <WaitAge since={row.unansweredSince} />,
    },
    {
      key: 'preview',
      header: t('web.bchat_preview'),
      wrap: true,
      render: (row) =>
        row.preview === null ? (
          <span className="muted small">{t('web.bchat_text_gone')}</span>
        ) : (
          <span className="bchat-preview">{row.preview}</span>
        ),
    },
    {
      key: 'last',
      header: t('web.bchat_last_message'),
      render: (row) =>
        row.lastMessageAt === null ? (
          <Dash />
        ) : (
          <span className="nowrap">{formatTimestamp(row.lastMessageAt)}</span>
        ),
    },
  ];

  return (
    <>
      <PageHead title={t('web.bchats_title')} subtitle={t('web.bchats_intro')} />

      <Card>
        <FilterBar hidden={!requestable}>
          <FilterChips label={t('web.status')}>
            <FilterChip pressed={state === null} onClick={() => setQuery(route, 'state', null)}>
              {t('web.bchat_filter_all')}
            </FilterChip>
            <ChipDivider />
            {BUSINESS_CONVERSATION_STATES.map((value) => (
              <FilterChip
                key={value}
                pressed={state === value}
                onClick={() => setQuery(route, 'state', value)}
              >
                {t(BUSINESS_STATE_LABELS[value])}
              </FilterChip>
            ))}
          </FilterChips>
        </FilterBar>

        <StateSwitch
          query={chats}
          denied={denied}
          isEmpty={rows.length === 0}
          empty={
            <Empty
              title={t(state === null ? 'web.bchats_empty' : 'web.bchats_filter_empty')}
              hint={t('web.bchats_empty_hint')}
              icon="message"
            />
          }
        >
          <DataTable
            caption={t('web.bchats_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            dense
          />
          {chats.hasNextPage && (
            <div className="bchat-more">
              <span className="muted small">
                {t('web.showing')} <Num value={rows.length} />
              </span>
              <button
                type="button"
                className="btn sm"
                disabled={chats.isFetchingNextPage}
                onClick={() => void chats.fetchNextPage()}
              >
                {t('web.bchat_load_more')}
              </button>
            </div>
          )}
        </StateSwitch>
      </Card>

      {!denied && <BusinessConnectionsCard />}
    </>
  );
}

function BusinessConnectionsCard() {
  const connections = useQuery({
    queryKey: ['business-connections'],
    queryFn: fetchBusinessConnections,
  });
  const rows = connections.data?.connections ?? [];
  type Row = (typeof rows)[number];
  const columns: readonly Column<Row>[] = [
    {
      key: 'owner',
      header: t('web.bchat_connection_owner'),
      render: (row) => <Ltr>{row.ownerTelegramUserId}</Ltr>,
    },
    {
      key: 'status',
      header: t('web.status'),
      render: (row) => <ConnectionBadge status={row.status} />,
    },
    {
      key: 'connected',
      header: t('web.bchat_connection_connected_at'),
      render: (row) => <span className="nowrap muted">{formatTimestamp(row.connectedAt)}</span>,
    },
    {
      key: 'confirmed',
      header: t('web.bchat_connection_confirmed_at'),
      render: (row) => <span className="nowrap muted">{formatTimestamp(row.lastConfirmedAt)}</span>,
    },
  ];
  return (
    <Card title={t('web.bchat_connections_title')} hint={t('web.bchat_connections_hint')}>
      <StateSwitch
        query={connections}
        isEmpty={rows.length === 0}
        empty={<Empty title={t('web.bchat_connections_empty')} icon="link" />}
      >
        <DataTable
          caption={t('web.bchat_connections_title')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          dense
        />
      </StateSwitch>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------
// One conversation
// ---------------------------------------------------------------------------------------

export function BusinessChatDetailPage({
  id,
  denied,
  mayReply,
  mayAssist = false,
  mayPropose = false,
}: {
  id: string;
  denied: boolean;
  mayReply: boolean;
  /** TB8: draws "propose as knowledge" on delivered replies. Courtesy only. */
  mayPropose?: boolean;
  /** TB5: draws the Assist panel. Courtesy only — the server charges `support_ai.assist`. */
  mayAssist?: boolean;
}) {
  const chat = useQuery({
    queryKey: ['business-chat', id],
    queryFn: () => fetchBusinessChat(id),
    enabled: !denied,
    refetchInterval: pollUnlessFinal(BUSINESS_CHAT_REFRESH_MS),
  });
  const data = denied ? undefined : chat.data;
  const conversation = data?.conversation;
  return (
    <>
      <PageHead
        title={
          conversation === undefined
            ? t('web.bchat_detail')
            : `${t('web.bchat_detail')}${t('web.list_separator')}${customerName(conversation)}`
        }
        badge={conversation === undefined ? undefined : <StateBadge value={conversation.state} />}
        subtitle={
          conversation === undefined
            ? t('web.bchat_detail_intro')
            : t(STATE_EXPLAINED[conversation.state])
        }
      />
      <StateSwitch query={chat} denied={denied}>
        {data !== undefined && (
          <div className="two-col bchat-layout">
            <div className="stack">
              <TranscriptCard detail={data} />
              {mayAssist && (
                <AssistCard
                  conversationId={data.conversation.id}
                  mayReply={mayReply}
                  connected={data.conversation.connectionStatus === 'ACTIVE'}
                />
              )}
              {mayReply && <ComposerCard detail={data} />}
            </div>
            <div className="stack">
              <ControlCard detail={data} mayReply={mayReply} />
              {data.escalations.length > 0 && <EscalationsCard detail={data} />}
              <OutboundCard detail={data} mayPropose={mayPropose} />
            </div>
          </div>
        )}
      </StateSwitch>
    </>
  );
}

/** After any write, read the conversation and the inbox again: the server's state is the answer. */
function useRefresh(id: string): () => void {
  const queries = useQueryClient();
  return () => {
    void queries.invalidateQueries({ queryKey: ['business-chat', id] });
    void queries.invalidateQueries({ queryKey: ['business-chats'] });
  };
}

function ControlCard({
  detail,
  mayReply,
}: {
  detail: BusinessChatDetailResponse;
  mayReply: boolean;
}) {
  const { conversation } = detail;
  const notify = useToast();
  const onLink = useLinkHandler();
  const refresh = useRefresh(conversation.id);
  const takeoverKey = useSubmissionKey();
  const resumeKey = useSubmissionKey();
  const [confirmingResume, setConfirmingResume] = useState(false);

  // The epoch is part of the fingerprint: the same press against a conversation that has
  // since moved is a new command, not a retry of the old one.
  const fingerprint = (action: string) => ({
    conversation: conversation.id,
    epoch: conversation.controlEpoch,
    action,
  });

  const takeover = useMutation({
    mutationFn: () =>
      takeOverBusinessChat({
        conversationId: conversation.id,
        idempotencyKey: takeoverKey.current(fingerprint('takeover')),
      }),
    onSuccess: () => {
      takeoverKey.settle();
      notify({ tone: 'ok', message: t('web.bchat_takeover_done') });
      refresh();
    },
    onError: (error) => {
      takeoverKey.settleOn(error);
      notify({ tone: 'danger', message: businessChatFault(error) });
      refresh();
    },
  });
  const resume = useMutation({
    mutationFn: () =>
      resumeBusinessChat({
        conversationId: conversation.id,
        idempotencyKey: resumeKey.current(fingerprint('resume')),
      }),
    onSuccess: () => {
      resumeKey.settle();
      notify({ tone: 'ok', message: t('web.bchat_resume_done') });
      refresh();
    },
    onError: (error) => {
      resumeKey.settleOn(error);
      notify({ tone: 'danger', message: businessChatFault(error) });
      refresh();
    },
  });
  const busy = takeover.isPending || resume.isPending;

  return (
    <Card title={t('web.bchat_control')} hint={t(STATE_EXPLAINED[conversation.state])}>
      <KV
        items={[
          [t('web.status'), <StateBadge key="s" value={conversation.state} />],
          [
            t('web.bchat_takeover_reason'),
            conversation.takeoverReason === null ? (
              <Dash key="t" />
            ) : (
              t(TAKEOVER_LABELS[conversation.takeoverReason])
            ),
          ],
          [
            t('web.bchat_handoff_reason'),
            conversation.handoffReason === null ? (
              <Dash key="h" />
            ) : (
              t(HANDOFF_LABELS[conversation.handoffReason])
            ),
          ],
          [
            t('web.bchat_connection'),
            <ConnectionBadge key="c" status={conversation.connectionStatus} />,
          ],
          [t('web.bchat_peer'), <Ltr key="p">{conversation.peerTelegramUserId}</Ltr>],
          [
            t('web.bchat_last_inbound'),
            conversation.lastInboundAt === null ? (
              <Dash key="i" />
            ) : (
              formatTimestamp(conversation.lastInboundAt)
            ),
          ],
          [
            t('web.bchat_last_human'),
            conversation.lastHumanAt === null ? (
              <Dash key="l" />
            ) : (
              formatTimestamp(conversation.lastHumanAt)
            ),
          ],
          [t('web.bchat_wait'), <WaitAge key="w" since={conversation.unansweredSince} />],
          [
            t('web.bchat_ticket'),
            conversation.ticketId === null ? (
              <Dash key="k" />
            ) : (
              <a key="k" href={ticketPath(conversation.ticketId)} onClick={onLink}>
                {t('web.bchat_ticket_open')}
              </a>
            ),
          ],
        ]}
      />
      {mayReply && (
        <div className="btn-group bchat-controls">
          {conversation.state !== 'HUMAN_ACTIVE' && (
            <button
              type="button"
              className="btn primary sm"
              disabled={busy}
              onClick={() => takeover.mutate()}
            >
              <Icon name="user" />
              {t('web.bchat_takeover')}
            </button>
          )}
          {conversation.state !== 'AI_ACTIVE' && (
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => setConfirmingResume(true)}
            >
              <Icon name="bots" />
              {t('web.bchat_resume')}
            </button>
          )}
        </div>
      )}
      {confirmingResume && (
        <ConfirmDialog
          title={t('web.bchat_resume_confirm_title')}
          question={t('web.bchat_resume_confirm_body')}
          confirmLabel={t('web.bchat_resume_confirm')}
          cancelLabel={t('web.bchat_cancel')}
          onConfirm={() => {
            setConfirmingResume(false);
            resume.mutate();
          }}
          onCancel={() => setConfirmingResume(false)}
        />
      )}
    </Card>
  );
}

function TranscriptCard({ detail }: { detail: BusinessChatDetailResponse }) {
  // Oldest first, as a chat reads; ties by id so two polls draw the same order.
  const messages = [...detail.messages].sort((a, b) =>
    a.sentAt === b.sentAt ? a.id.localeCompare(b.id) : a.sentAt.localeCompare(b.sentAt),
  );
  return (
    <Card title={t('web.bchat_transcript')} hint={t('web.bchat_transcript_hint')}>
      {messages.length === 0 ? (
        <Empty title={t('web.bchat_transcript_empty')} icon="message" />
      ) : (
        <ol className="bchat-thread" aria-label={t('web.bchat_transcript')}>
          {messages.map((message) => (
            <li
              key={message.id}
              className={`bchat-message origin-${message.origin.toLowerCase().replace('_', '-')}`}
              data-origin={message.origin}
            >
              <div className="bchat-message-head">
                <span className="avatar bchat-avatar" aria-hidden="true">
                  <Icon name={ORIGIN_ICONS[message.origin]} size={13} />
                </span>
                <strong>{t(BUSINESS_ORIGIN_LABELS[message.origin])}</strong>
                <span className="muted small">{formatTimestamp(message.sentAt)}</span>
                {message.edited && <Badge tone="info">{t('web.bchat_edited')}</Badge>}
                {message.deleted && <Badge tone="danger">{t('web.bchat_deleted')}</Badge>}
              </div>
              <MessageBody text={message.text} kind={message.kind} />
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/** TB7: each handoff — why, what became of the ticket, and the AI's note for the operator. */
function EscalationsCard({ detail }: { detail: BusinessChatDetailResponse }) {
  const onLink = useLinkHandler();
  return (
    <Card title={t('web.bchat_escalations')} hint={t('web.bchat_escalations_hint')}>
      <ol className="stack">
        {detail.escalations.map((escalation) => (
          <li key={escalation.id}>
            <div className="bchat-message-head">
              <strong>{t(HANDOFF_LABELS[escalation.reason])}</strong>
              <span className="muted small">{formatTimestamp(escalation.createdAt)}</span>
            </div>
            <div className="small">
              {escalation.ticketId === null ? (
                t(ESCALATION_TICKET_LABELS[escalation.ticketOutcome])
              ) : (
                <a href={`/tickets/${encodeURIComponent(escalation.ticketId)}`} onClick={onLink}>
                  {t(ESCALATION_TICKET_LABELS[escalation.ticketOutcome])}
                </a>
              )}
            </div>
            {escalation.summary !== null && <p className="muted small">{escalation.summary}</p>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

function MessageBody({ text, kind }: { text: string | null; kind: BusinessMessageKind }) {
  if (text !== null) return <p className="bchat-body">{text}</p>;
  if (kind !== 'TEXT') return <p className="bchat-body muted">{t(KIND_LABELS[kind])}</p>;
  return <p className="bchat-body faint">{t('web.bchat_text_gone')}</p>;
}

function OutboundCard({
  detail,
  mayPropose = false,
}: {
  detail: BusinessChatDetailResponse;
  mayPropose?: boolean;
}) {
  const rows = [...detail.outbound].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <Card title={t('web.bchat_outbound')} hint={t('web.bchat_outbound_hint')}>
      {rows.length === 0 ? (
        <p className="muted small">{t('web.bchat_outbound_empty')}</p>
      ) : (
        <ol className="bchat-outbound" aria-label={t('web.bchat_outbound')}>
          {rows.map((row) => (
            <li key={row.id} className="bchat-outbound-row" data-outbound={row.state}>
              <div className="bchat-message-head">
                <Badge tone={OUTBOUND_TONES[row.state]}>
                  {t(BUSINESS_OUTBOUND_LABELS[row.state])}
                </Badge>
                <span className="small">{t(OUTBOUND_ORIGIN_LABELS[row.origin])}</span>
                <span className="muted small">{formatTimestamp(row.createdAt)}</span>
              </div>
              {row.text === null ? (
                <p className="bchat-body faint">{t('web.bchat_text_gone')}</p>
              ) : (
                <p className="bchat-body">{row.text}</p>
              )}
              {row.failureCode !== null && (
                <span className="small muted">
                  {t('web.bchat_outbound_failure')} <Ltr>{row.failureCode}</Ltr>
                </span>
              )}
              {mayPropose &&
                row.state === 'DELIVERED' &&
                row.origin !== 'AUTO' &&
                row.text !== null && (
                  <ProposeKnowledgeButton
                    conversationId={detail.conversation.id}
                    outboundId={row.id}
                  />
                )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function ComposerCard({ detail }: { detail: BusinessChatDetailResponse }) {
  const { conversation } = detail;
  const notify = useToast();
  const refresh = useRefresh(conversation.id);
  const submission = useSubmissionKey();
  const [text, setText] = useState('');
  useUnsavedChanges(text.trim() !== '');
  const parsed = businessTextSchema.safeParse(text);
  const connected = conversation.connectionStatus === 'ACTIVE';
  const send = useMutation({
    // The text travels as the VARIABLE, so a retry sends what the key was minted for.
    mutationFn: (body: string) =>
      sendBusinessChatMessage({
        conversationId: conversation.id,
        idempotencyKey: submission.current({ conversation: conversation.id, text: body }),
        text: body,
      }),
    onSuccess: () => {
      submission.settle();
      setText('');
      notify({ tone: 'ok', message: t('web.bchat_send_done') });
      refresh();
    },
    // A 5xx may have committed: the retry keeps its key rather than sending twice.
    onError: (error) => {
      submission.settleOn(error);
      refresh();
    },
  });
  return (
    <Card title={t('web.bchat_reply')}>
      <Banner tone="info" icon="info">
        {t('web.bchat_reply_takes_over')}
      </Banner>
      {!connected && <Banner tone="warn">{t('web.bchat_reply_connection_unusable')}</Banner>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (parsed.success && connected) send.mutate(parsed.data);
        }}
      >
        <Field label={t('web.bchat_reply_text')} htmlFor="bchat-reply-text">
          <textarea
            dir="auto"
            id="bchat-reply-text"
            className="input"
            rows={5}
            value={text}
            maxLength={BUSINESS_MESSAGE_TEXT_MAX}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        <div className="form-actions bchat-reply-actions">
          <span className="muted small bchat-counter" aria-live="polite">
            <Num value={text.length} /> / <Num value={BUSINESS_MESSAGE_TEXT_MAX} />
          </span>
          <button
            type="submit"
            className="btn primary"
            disabled={!parsed.success || !connected || send.isPending}
          >
            <Icon name="send" />
            {t('web.bchat_send')}
          </button>
        </div>
      </form>
      {send.error !== null && <Banner tone="danger">{businessChatFault(send.error)}</Banner>}
    </Card>
  );
}
