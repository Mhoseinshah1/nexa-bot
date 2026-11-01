import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BUSINESS_CONVERSATION_STATES,
  BUSINESS_MESSAGE_TEXT_MAX,
  businessHandoffReasonOf,
  businessOutboundOriginOf,
  businessTextSchema,
  type BusinessChatDetailResponse,
  type BusinessConnectionStatus,
  type BusinessConversationState,
  type BusinessConversationSummary,
  type BusinessEscalationTicketOutcome,
  type BusinessHandoffKind,
  type BusinessMessageKind,
  type BusinessMessageOrigin,
  type BusinessOutboundOrigin,
  type BusinessOutboundState,
  type BusinessTakeoverReason,
  type SupportAiMode,
} from '@nexa/contracts';
import {
  ApiError,
  fetchBusinessChat,
  fetchBusinessChats,
  fetchBusinessConnections,
  newIdempotencyKey,
  resumeAllBusinessChats,
  resumeBusinessChat,
  sendBusinessChatMessage,
  takeOverBusinessChat,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { pollUnlessFinal } from '../polling';
import { setQuery, useLinkHandler, type Route } from '../router';
import { HandoffContextView } from './handoff-context';
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
  FilterChip,
  FilterChips,
  IdentityCell,
  KV,
  LIST_PAGE_SIZE,
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
import { FailureDiagnosticView } from './support-ai-failure';
import { ListFilterBar } from '../ui/filter-bar';
import { ErrorRef } from '../ui/technical-details';
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
  HANDOFF_NOTICE: 'web.bchat_outbound_origin_handoff_notice',
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

/**
 * Phase 4 PR-5: what «هوش مصنوعی فعال» really means depends on the stored mode. A conversation
 * the AI holds while the mode is ASSIST_ONLY only gets drafts; while OFF it gets nothing.
 * `mode` is undefined for a server that does not send it (then the old wording stands).
 */
export function stateLabelFor(
  state: BusinessConversationState,
  mode: SupportAiMode | undefined,
): { readonly label: WebKey; readonly tone: Tone } {
  if (state === 'AI_ACTIVE' && mode === 'ASSIST_ONLY') {
    return { label: 'web.bchat_state_ai_assist', tone: 'info' };
  }
  if (state === 'AI_ACTIVE' && mode === 'OFF') {
    return { label: 'web.bchat_state_ai_off', tone: 'warn' };
  }
  return { label: BUSINESS_STATE_LABELS[state], tone: STATE_TONES[state] };
}

function StateBadge({
  value,
  mode,
}: {
  value: BusinessConversationState;
  mode?: SupportAiMode | undefined;
}) {
  const shown = stateLabelFor(value, mode);
  return <Badge tone={shown.tone}>{t(shown.label)}</Badge>;
}

const HOLD_KIND_LABELS: Readonly<Record<BusinessHandoffKind, WebKey>> = {
  HARD: 'web.bchat_kind_hard',
  SOFT: 'web.bchat_kind_soft',
};

/**
 * Phase 4 PR-5: whether a hold returns to the AI by itself. A SOFT hold does after the quiet
 * window; HARD stays until someone returns it. A hold with no recorded kind (it predates kinds)
 * is read as HARD, exactly as the server reads it. Nothing is drawn for an AI-held conversation.
 */
function HoldKindBadge({ conversation }: { conversation: BusinessConversationSummary }) {
  if (conversation.state === 'AI_ACTIVE') return null;
  const kind: BusinessHandoffKind = conversation.handoffKind === 'SOFT' ? 'SOFT' : 'HARD';
  return (
    <Badge tone={kind === 'HARD' ? 'danger' : 'info'} outline>
      {t(HOLD_KIND_LABELS[kind])}
    </Badge>
  );
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
    <span className="nowrap strong bchat-wait" title={formatTimestamp(since)}>
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

/**
 * W5: an outbound message's failure code as a Persian name. The codes are the lane's own
 * (`business-outbound.service.ts`) and the Telegram transport's (`telegram.rejected.<n>`,
 * `telegram.server_error.<n>`); an exact code is looked up first, then its family.
 */
export const BUSINESS_FAILURE_LABELS: Readonly<Record<string, WebKey>> = {
  'support_ai.reply_stale': 'web.bchat_fc_reply_stale',
  'support_ai.notice_stale': 'web.bchat_fc_notice_stale',
  'support_ai.mode_off': 'web.bchat_fc_mode_off',
  'scope.inactive': 'web.bchat_fc_scope_inactive',
  'conversation.moved_on': 'web.bchat_fc_moved_on',
  'business.notice_template': 'web.bchat_fc_notice_template',
  'business.invalid_text': 'web.bchat_fc_invalid_text',
  'business.connection_not_found': 'web.bchat_fc_connection_not_found',
  'business.connection_unusable': 'web.bchat_fc_connection_unusable',
  'business.bot_unavailable': 'web.bchat_fc_bot_unavailable',
  'business.telegram_rejected': 'web.bchat_fc_telegram_rejected',
  'bot.not_active': 'web.bchat_fc_bot_unavailable',
  'telegram.rate_limited': 'web.bchat_fc_rate_limited',
  'telegram.unreachable': 'web.bchat_fc_unreachable',
  'telegram.unreadable_response': 'web.bchat_fc_unreadable',
  'telegram.unreadable_connection': 'web.bchat_fc_connection_mismatch',
  'telegram.connection_id_mismatch': 'web.bchat_fc_connection_mismatch',
  'telegram.rejected.403': 'web.bchat_fc_blocked',
};

const BUSINESS_FAILURE_FAMILIES: readonly (readonly [string, WebKey])[] = [
  ['telegram.rejected.', 'web.bchat_fc_telegram_rejected'],
  ['telegram.server_error.', 'web.bchat_fc_server_error'],
];

/** The Persian name of a failure code, or null when this page does not know it. */
export function businessFailureLabel(code: string): string | null {
  const exact = BUSINESS_FAILURE_LABELS[code];
  if (exact !== undefined) return t(exact);
  const family = BUSINESS_FAILURE_FAMILIES.find(([prefix]) => code.startsWith(prefix));
  return family === undefined ? null : t(family[1]);
}

/** The Persian name with the raw code in its tooltip; an unknown code is drawn as itself. */
function FailureCode({ code }: { code: string }) {
  const label = businessFailureLabel(code);
  return label === null ? <Ltr>{code}</Ltr> : <span title={code}>{label}</span>;
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

export function BusinessChatsPage({
  route,
  denied,
  mayReply = false,
}: {
  route: Route;
  denied: boolean;
  /** `business_chats.reply`: the bulk return charges what the single return charges. */
  mayReply?: boolean;
}) {
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
  const aiMode = chats.data?.pages[0]?.aiMode;
  /*
   * The demo's inbox footer: «نمایش N» and «نمایش بیشتر» (DIFFS business-chats #2). Ten
   * rows at first (W1.8); «نمایش بیشتر» shows ten more of the conversations already read,
   * and past them reads the server's next page by its cursor. The list is in priority order,
   * not a time order, so it grows downward rather than turning pages. Keyed by the filter, so
   * a new filter starts again at ten.
   */
  const [shownState, setShownState] = useState({ key: state ?? '', count: LIST_PAGE_SIZE });
  const shownCount = shownState.key === (state ?? '') ? shownState.count : LIST_PAGE_SIZE;
  const shownRows = rows.slice(0, shownCount);
  const moreLoaded = rows.length > shownCount;
  const canShowMore = moreLoaded || chats.hasNextPage;
  const showMore = () => {
    const next = { key: state ?? '', count: shownCount + LIST_PAGE_SIZE };
    if (moreLoaded) {
      setShownState(next);
      return;
    }
    if (chats.isFetchingNextPage || !chats.hasNextPage) return;
    void chats.fetchNextPage().then(() => setShownState(next));
  };
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
          <StateBadge value={row.state} mode={aiMode} />
          <HoldKindBadge conversation={row} />
          {row.handoffReason !== null && (
            <span className="small muted">
              {t(
                HANDOFF_LABELS[businessHandoffReasonOf(row.handoffReason, row.handoffReasonDetail)],
              )}
            </span>
          )}
          {row.connectionStatus !== 'ACTIVE' && <ConnectionBadge status={row.connectionStatus} />}
          {row.ticketId !== null && (
            <span className="bchat-state-sub">
              <a
                className="badge info bchat-ticket"
                href={ticketPath(row.ticketId)}
                onClick={onLink}
              >
                <Icon name="message" />
                {t('web.bchat_ticket_badge')}
              </a>
            </span>
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
      <PageHead
        title={t('web.bchats_title')}
        subtitle={t('web.bchats_intro')}
        actions={mayReply && !denied ? <ResumeAllButton /> : undefined}
      />
      {aiMode === 'OFF' && <Banner tone="warn">{t('web.bchat_mode_off_note')}</Banner>}
      {aiMode === 'ASSIST_ONLY' && <Banner tone="info">{t('web.bchat_mode_assist_note')}</Banner>}

      <Card>
        {requestable && (
          <ListFilterBar
            label={t('web.bchats_title')}
            filters={[
              {
                key: 'state',
                label: t('web.status'),
                active: state === null ? null : t(BUSINESS_STATE_LABELS[state]),
                onClear: () => setQuery(route, 'state', null),
                control: (
                  <FilterChips label={t('web.status')}>
                    <FilterChip
                      pressed={state === null}
                      onClick={() => setQuery(route, 'state', null)}
                    >
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
                ),
              },
            ]}
          />
        )}

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
          <div className="bchat-inbox">
            <DataTable
              caption={t('web.bchats_title')}
              columns={columns}
              rows={shownRows}
              rowKey={(row) => row.id}
            />
          </div>
          <div className="pager bchat-more">
            <span className="muted small">
              {t('web.showing')} <Num value={shownRows.length} />
            </span>
            <span className="spacer" />
            <button
              type="button"
              className="btn sm"
              disabled={!canShowMore || chats.isFetchingNextPage}
              onClick={showMore}
            >
              {t('web.bchat_show_more')}
            </button>
          </div>
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
        badge={
          conversation === undefined ? undefined : (
            <StateBadge value={conversation.state} mode={data?.aiMode} />
          )
        }
        subtitle={
          conversation === undefined
            ? t('web.bchat_detail_intro')
            : t(STATE_EXPLAINED[conversation.state])
        }
      />
      <StateSwitch query={chat} denied={denied}>
        {data !== undefined && (
          <div className="two-col bchat-layout ops-sticky-cols">
            <div className="stack">
              <TranscriptCard detail={data} mayPropose={mayPropose} />
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
              <ControlCard detail={data} mayReply={mayReply} aiMode={data.aiMode} />
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
  aiMode,
}: {
  detail: BusinessChatDetailResponse;
  mayReply: boolean;
  aiMode?: SupportAiMode | undefined;
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
      notify({ tone: 'danger', message: businessChatFault(error), error });
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
      notify({ tone: 'danger', message: businessChatFault(error), error });
      refresh();
    },
  });
  const busy = takeover.isPending || resume.isPending;

  return (
    <Card title={t('web.bchat_control')} hint={t(STATE_EXPLAINED[conversation.state])}>
      <KV
        items={[
          [t('web.status'), <StateBadge key="s" value={conversation.state} mode={aiMode} />],
          [
            t('web.bchat_hold_kind'),
            conversation.state === 'AI_ACTIVE' ? (
              <Dash key="k0" />
            ) : (
              <span key="k0">
                <HoldKindBadge conversation={conversation} />{' '}
                <span className="muted small">
                  {t(
                    conversation.handoffKind === 'SOFT'
                      ? 'web.bchat_kind_soft_hint'
                      : 'web.bchat_kind_hard_hint',
                  )}
                </span>
              </span>
            ),
          ],
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
              t(
                HANDOFF_LABELS[
                  businessHandoffReasonOf(
                    conversation.handoffReason,
                    conversation.handoffReasonDetail,
                  )
                ],
              )
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
          {/* Phase 4 PR-1: a person's message only pauses the AI (a SOFT hold); taking the
              conversation over makes the hold sticky. */}
          {(conversation.state !== 'HUMAN_ACTIVE' || conversation.handoffKind === 'SOFT') && (
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

function TranscriptCard({
  detail,
  mayPropose = false,
}: {
  detail: BusinessChatDetailResponse;
  /** D8: draws "propose as knowledge" on what the owner typed. Courtesy only. */
  mayPropose?: boolean;
}) {
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
              {/* D8: a reply the owner typed on the phone can feed learning; a customer's never. */}
              {mayPropose &&
                message.origin === 'HUMAN' &&
                message.kind === 'TEXT' &&
                !message.deleted &&
                message.text !== null && (
                  <ProposeKnowledgeButton
                    conversationId={detail.conversation.id}
                    messageId={message.id}
                  />
                )}
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
              <strong>
                {t(
                  HANDOFF_LABELS[
                    businessHandoffReasonOf(escalation.reason, escalation.reasonDetail)
                  ],
                )}
              </strong>
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
            <HandoffContextView
              topic={escalation.topic}
              intent={escalation.intent}
              stepsTried={escalation.stepsTried}
            />
            {escalation.aiFailure !== null && (
              <FailureDiagnosticView failure={escalation.aiFailure} />
            )}
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
          {rows.map((row) => {
            // CX1: `origin` on the wire is the old bundle's; the real one is read beside it.
            const origin = businessOutboundOriginOf(row);
            return (
              <li key={row.id} className="bchat-outbound-row" data-outbound={row.state}>
                <div className="bchat-message-head">
                  <Badge tone={OUTBOUND_TONES[row.state]}>
                    {t(BUSINESS_OUTBOUND_LABELS[row.state])}
                  </Badge>
                  <span className="small">{t(OUTBOUND_ORIGIN_LABELS[origin])}</span>
                  <span className="muted small">{formatTimestamp(row.createdAt)}</span>
                </div>
                {row.text === null ? (
                  <p className="bchat-body faint">{t('web.bchat_text_gone')}</p>
                ) : (
                  <p className="bchat-body">{row.text}</p>
                )}
                {row.failureCode !== null && (
                  <span className="small muted">
                    {t('web.bchat_outbound_failure')} <FailureCode code={row.failureCode} />
                  </span>
                )}
                {mayPropose &&
                  row.state === 'DELIVERED' &&
                  origin !== 'AUTO' &&
                  origin !== 'HANDOFF_NOTICE' &&
                  row.text !== null && (
                    <ProposeKnowledgeButton
                      conversationId={detail.conversation.id}
                      outboundId={row.id}
                    />
                  )}
              </li>
            );
          })}
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
      <Banner tone="info">{t('web.bchat_reply_takes_over')}</Banner>
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
      {send.error !== null && (
        <Banner tone="danger">
          {businessChatFault(send.error)}
          <ErrorRef error={send.error} />
        </Banner>
      )}
    </Card>
  );
}

/**
 * «بازگرداندن همه به هوش مصنوعی». One button, one confirmation that names what it will do -
 * hard holds included only if the operator ticks the box - and one request: the server returns
 * each conversation through the same single return (same permission, audit and idempotency).
 */
function ResumeAllButton() {
  const queries = useQueryClient();
  const notify = useToast();
  const [asking, setAsking] = useState(false);
  const [includeHard, setIncludeHard] = useState(false);
  const run = useMutation({
    mutationFn: () => resumeAllBusinessChats({ idempotencyKey: newIdempotencyKey(), includeHard }),
    onSuccess: (result) => {
      setAsking(false);
      setIncludeHard(false);
      notify({
        tone: result.failed > 0 ? 'warn' : 'ok',
        message: `${t('web.bchat_resume_all_done')} ${result.resumed} · ${t('web.bchat_resume_all_skipped')} ${result.skippedHard} · ${t('web.bchat_resume_all_failed')} ${result.failed}${result.more ? ` — ${t('web.bchat_resume_all_more')}` : ''}`,
      });
      void queries.invalidateQueries({ queryKey: ['business-chats'] });
    },
    onError: (error) => {
      setAsking(false);
      notify({ tone: 'danger', message: businessChatFault(error), error });
    },
  });
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={run.isPending}
        onClick={() => setAsking(true)}
      >
        <Icon name="bots" />
        {t('web.bchat_resume_all')}
      </button>
      {asking && (
        <ConfirmDialog
          title={t('web.bchat_resume_all_title')}
          question={t('web.bchat_resume_all_body')}
          detail={
            <label className="check">
              <input
                type="checkbox"
                checked={includeHard}
                onChange={(event) => setIncludeHard(event.target.checked)}
              />{' '}
              {t('web.bchat_resume_all_hard')}
            </label>
          }
          confirmLabel={t('web.bchat_resume_all_confirm')}
          cancelLabel={t('web.bchat_cancel')}
          onConfirm={() => run.mutate()}
          onCancel={() => {
            setAsking(false);
            setIncludeHard(false);
          }}
        />
      )}
    </>
  );
}
