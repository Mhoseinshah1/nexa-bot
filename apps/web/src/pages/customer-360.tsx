import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { keepPageWhileTurning } from '../ui/paging';
import {
  CUSTOMER_BLOCK_REASON_MAX_LENGTH,
  TRIAL_ADMIN_REASON_MAX_LENGTH,
  type CustomerReferralResponse,
  type CustomerStatus,
  type CustomerSummaryResponse,
  type LedgerDirection,
  type OrderSummaryResponse,
  type ServiceSummaryResponse,
  type WalletEntrySummaryResponse,
} from '@nexa/contracts';
import {
  adjustWallet,
  blockCustomer,
  fetchCustomer,
  fetchOrders,
  fetchServices,
  fetchCustomerLegacyAdoptedServices,
  fetchWallet,
  fetchWalletEntries,
  fetchCustomerTrial,
  fetchCustomerReferral,
  fetchCustomerReseller,
  removeTrialOverride,
  setTrialOverride,
  unblockCustomer,
} from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import { messageFor } from './settings';
import { FormDialog } from './form-dialog';
/*
 * The OTHER two screens' badge vocabularies, borrowed rather than copied.
 *
 * A second `REFUNDED: 'violet'` here would be a second answer to what an order
 * state looks like, and the two would drift the first time one of them gained a
 * state. `panels.tsx` borrows the product and service maps for the same reason.
 */
import { STATE_LABELS as ORDER_STATE_LABELS, STATE_TONES as ORDER_STATE_TONES } from './orders';
import {
  DELIVERY_LABELS as SERVICE_DELIVERY_LABELS,
  DELIVERY_TONES as SERVICE_DELIVERY_TONES,
  STATE_LABELS as SERVICE_STATE_LABELS,
  STATE_TONES as SERVICE_STATE_TONES,
} from './services';
import { PartyCell, TriggerBadge } from './referrals';
import { OVERRIDE_LABELS, PricingText, ResellerStatusBadge } from './resellers';
import { Dash, StatusBadge, displayName, initialOf } from './customer-parts';
import { SourceBadge } from '../ui/source-badge';
import {
  CustomerControlsCard,
  FinancialSummaryCard,
  GeneralInfoCard,
  ManualOrderModal,
  ServiceCountsStrip,
  TimelineCard,
  useCustomerDangerActions,
  useCustomerOverview,
  useFinancialSummary,
} from './customer-360-sections';
import { ActionPanel } from '../ui/action-panel';
// Phase A2: «ارسال پیام» — the compose modal and the history, in their own file.
import { DirectMessageComposeModal, DirectMessagesCard } from './customer-direct-messages';
import { CustomerCrmSection } from './customer-360-crm';
import { LEDGER_REASON_LABELS } from './mirza-labels';
// Roadmap B5: the workspace — attention, the newest rows, support, shortcuts.
import {
  CustomerAttentionCard,
  CustomerLatestCard,
  CustomerTicketsCard,
  OperatorShortcutsCard,
  customerShortcuts,
} from './customer-360-workspace';
import {
  Badge,
  Banner,
  Button,
  Card,
  Copyable,
  CursorPager,
  DataTable,
  DetailHead,
  Empty,
  Field,
  Input,
  KV,
  Ltr,
  Modal,
  Money,
  Num,
  PageHead,
  StateSwitch,
  TabPanel,
  Tabs,
  TwoColumn,
  useToast,
  type Column,
  type Tone,
  LIST_PAGE_SIZE,
} from '../ui/kit';
import { ApiErrorReport, ErrorRef } from '../ui/technical-details';

// ---------------------------------------------------------------------------
// Customer 360 (spec §11)
// ---------------------------------------------------------------------------

/**
 * The customer's page: Customer 360.
 *
 * One compact head — the Telegram numeric id is the identity, never the internal uuid —
 * with the primary actions; a section list that jumps to each part; and the sections
 * themselves, every one reading its own endpoint under its own permission. Everything is
 * mounted at once rather than behind tabs, so an operator answering a support message
 * scrolls or jumps instead of hunting for the tab that holds the answer. The dangerous
 * operations — disabling every configuration, transferring the account — sit apart at
 * the bottom, each behind its own confirmation.
 */
/** W2: Customer 360's nine tabs. */
export type CustomerTab =
  | 'overview'
  | 'services'
  | 'support'
  | 'financial'
  | 'controls'
  | 'relations'
  | 'messages'
  | 'crm'
  | 'timeline';

/** The tabs in order; the messages tab only for a viewer who may read or send a message. */
export function customerTabs(messages: boolean): { id: CustomerTab; label: string }[] {
  const all: { id: CustomerTab; label: WebKey }[] = [
    { id: 'overview', label: 'web.c360_tab_overview' },
    { id: 'services', label: 'web.c360_tab_services' },
    { id: 'support', label: 'web.c360_tab_support' },
    { id: 'financial', label: 'web.c360_tab_financial' },
    { id: 'controls', label: 'web.c360_tab_controls' },
    { id: 'relations', label: 'web.c360_tab_relations' },
    { id: 'messages', label: 'web.c360_tab_messages' },
    { id: 'crm', label: 'web.c360_tab_crm' },
    { id: 'timeline', label: 'web.c360_tab_timeline' },
  ];
  return all
    .filter((item) => messages || item.id !== 'messages')
    .map((item) => ({ id: item.id, label: t(item.label) }));
}

/** The id of the page's one tab panel. */
const PANEL_ID = 'c360-tab-panel';

/** Which tab holds a card a jump names (the ids the in-page anchors used to scroll to). */
export const CARD_TABS: Readonly<Record<string, CustomerTab>> = {
  'c360-general': 'overview',
  'c360-latest': 'overview',
  'c360-services': 'services',
  'c360-support': 'support',
  'c360-wallet': 'financial',
  'c360-financial': 'financial',
  'c360-controls': 'controls',
  'c360-relations': 'relations',
  'c360-messages': 'messages',
  'c360-crm': 'crm',
  'c360-timeline': 'timeline',
};

export function UserDetailPage({
  id,
  mayBlock,
  mayViewWallet,
  mayCredit,
  mayDebit,
  mayViewOrders,
  mayViewServices,
  mayEditTrial,
  mayViewReferrals,
  mayViewReseller,
  mayEditReseller,
  mayExemptChannel = false,
  mayVerifyPhone = false,
  mayEditLocation = false,
  mayEditNotifications = false,
  mayTransfer = false,
  mayManualOrder = false,
  mayEditServices = false,
  mayViewAudit = false,
  mayMessage = false,
  mayViewMessages = false,
  mayViewNotes = false,
  mayWriteNotes = false,
  mayAssignTags = false,
  mayManageTags = false,
  mayViewPayments = false,
  mayViewTickets = false,
  mayViewBusinessChats = false,
  mayViewLegacyServices = false,
  denied,
}: {
  id: string;
  mayBlock: boolean;
  /** `users.trial.edit`: set or remove this customer's custom trial limit (WP6-B). */
  mayEditTrial: boolean;
  mayViewWallet: boolean;
  mayCredit: boolean;
  mayDebit: boolean;
  /*
   * `orders.view` and `services.view`, passed separately and never derived.
   *
   * They are not implied by `users.view`: a role that may read customers need
   * not be a role that may read what they bought or what runs on a panel for
   * them. Each card draws a denial sentence naming its own key, and the server
   * charges it regardless — the missing card is a courtesy, never the
   * enforcement.
   */
  mayViewOrders: boolean;
  mayViewServices: boolean;
  /** `referrals.view` (WP9-A): its own grant, never implied by `users.view`. */
  mayViewReferrals: boolean;
  /** `resellers.view` (WP9-B): whether this customer is a reseller, and on what terms. */
  mayViewReseller: boolean;
  /** `resellers.edit`: offer the link that registers this customer as a reseller. */
  mayEditReseller: boolean;
  /*
   * Customer 360. Each is the key its server command charges, decided at the route and
   * never derived; absent means the control is not drawn.
   */
  /** `users.channel_membership.exempt` */
  mayExemptChannel?: boolean;
  /** `users.phone.verify` */
  mayVerifyPhone?: boolean;
  /** `users.location.edit` */
  mayEditLocation?: boolean;
  /** `users.notifications.edit` */
  mayEditNotifications?: boolean;
  /** `users.transfer` — the account transfer, CRITICAL. */
  mayTransfer?: boolean;
  /** `orders.manual.create` */
  mayManualOrder?: boolean;
  /** `services.edit` — enable or disable all of the customer's configurations. */
  mayEditServices?: boolean;
  /** `audit.view` — the management timeline. */
  mayViewAudit?: boolean;
  /** `users.message.send` — the direct message (Phase A2). */
  mayMessage?: boolean;
  /** `users.message.view` — the direct-message history (Phase A2). */
  mayViewMessages?: boolean;
  /*
   * Program §8, notes and tags. Reading a customer's tags is `users.view` and needs no flag.
   */
  /** `users.notes.view` */
  mayViewNotes?: boolean;
  /** `users.notes.write` */
  mayWriteNotes?: boolean;
  /** `users.tags.assign` */
  mayAssignTags?: boolean;
  /** `users.tags.manage` */
  mayManageTags?: boolean;
  /*
   * Roadmap B5. Each decides only whether a section is ASKED for or a link drawn; the
   * server withholds the section regardless (`CUSTOMER_WORKSPACE_PERMISSIONS`).
   */
  /** `payments.view` — the payments shortcut. */
  mayViewPayments?: boolean;
  /** `tickets.view` — the support card and its shortcut. */
  mayViewTickets?: boolean;
  /** `business_chats.view` — the handoff inbox shortcut. */
  mayViewBusinessChats?: boolean;
  /** `legacy.services.view` — the «migrated from Mirza» mark on the services card. */
  mayViewLegacyServices?: boolean;
  denied: boolean;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const onLink = useLinkHandler();
  const submission = useSubmissionKey();
  /*
   * The CRM tab's note key lives on the page: only the chosen tab is drawn, so a key kept
   * after an unanswered note (a 5xx that may have saved it) must survive a tab switch, or
   * the retyped note goes out under a new key as a second note. The customer is part of the
   * key's payload, so one key never stands for two customers.
   */
  const noteSubmission = useSubmissionKey();
  const [reason, setReason] = useState('');
  const [manualOrderOpen, setManualOrderOpen] = useState(false);
  const [messageOpen, setMessageOpen] = useState(false);
  /*
   * Two steps, never one click (WP10G, closing OQ-WP10F-03). Step one chooses the direction;
   * step two is the confirmation panel — with the MANDATORY reason for a block, a plain
   * confirmation for an unblock — and only its confirm button sends anything. The server holds
   * the rule (a block without a reason is a 400); the disabled button is the courtesy.
   */
  const [pending, setPending] = useState<'BLOCK' | 'UNBLOCK' | null>(null);
  const trimmedReason = reason.trim();
  // Counted in code points, as the server counts it: a DOM `maxLength` counts UTF-16 units and
  // would stop an operator at 250 emoji of a 500-character reason (Codex review of PR #74).
  const reasonTooLong = Array.from(trimmedReason).length > CUSTOMER_BLOCK_REASON_MAX_LENGTH;

  const customer = useQuery({
    queryKey: ['customer', id],
    queryFn: () => fetchCustomer(id),
    enabled: !denied,
  });
  const row = customer.data?.customer;
  const overview = useCustomerOverview(id, !denied);
  const controls = overview.data?.overview;
  /*
   * The reseller card's own query, OBSERVED and never fetched from here: the card asks the
   * server once and this reads the same cache entry for the head badge and the group, so
   * the page adds no request and cannot disagree with the card.
   */
  const reseller = useQuery({
    queryKey: ['customer-reseller', id],
    queryFn: () => fetchCustomerReseller(id),
    enabled: false,
  });
  // Undefined while unknown (no permission, or not answered yet): the group is then not drawn.
  // `null` is the server's RESELLER_NOT_FOUND: a fact about the customer, not an error.
  const isReseller = reseller.data === undefined ? undefined : reseller.data !== null;

  const mutate = useMutation({
    mutationFn: (input: { to: CustomerStatus; reason: string }) => {
      // The payload is the fingerprint the held key is bound to, so editing the
      // reason and pressing again is a NEW command rather than a replay the
      // store would refuse as a payload mismatch. See `useSubmissionKey`.
      const idempotencyKey = submission.current({ id, to: input.to, reason: input.reason });
      // A block carries its reason, always; an unblock carries none — the server clears the
      // stored one, and a note typed into an unblock would only reach the audit row.
      return input.to === 'BLOCKED'
        ? blockCustomer({ id, idempotencyKey, reason: input.reason })
        : unblockCustomer({ id, idempotencyKey });
    },
    onSuccess: (response, variables) => {
      submission.settle();
      notify({
        tone: 'ok',
        message:
          variables.to === 'BLOCKED' ? t('web.user_blocked_done') : t('web.user_unblocked_done'),
      });
      setReason('');
      setPending(null);
      // The server's own answer, written straight into the cache: the response
      // carries the row as it now is. The list is invalidated rather than
      // patched, because a status change moves a row between the two status
      // filters and this page does not know which one is open behind it.
      queries.setQueryData(['customer', id], response);
      void queries.invalidateQueries({ queryKey: ['customers'] });
      void queries.invalidateQueries({ queryKey: ['customer-timeline', id] });
    },
    /*
     * `settleOn`, not `settle`.
     *
     * A 4xx is an answer and the next press is a new question, so the key is
     * retired. A 5xx or a dropped connection is NOT: the write may have
     * committed, and a fresh key on the retry would be a second command. Here
     * that would be a second audit row and a second outbox event for one
     * operator decision.
     */
    onError: (error) => submission.settleOn(error),
  });

  const cancelStep = () => {
    if (mutate.isPending) return;
    setPending(null);
    setReason('');
    mutate.reset();
  };

  // W3: the wallet movement is a dialog for one direction, opened from the panel or the card.
  const [walletDialog, setWalletDialog] = useState<LedgerDirection | null>(null);
  // W1.5: the sensitive actions, each under its own permission.
  const danger = useCustomerDangerActions({
    customerId: id,
    mayTransfer,
    // The toggle lists the services it planned: it reads them too.
    mayEditServices: mayEditServices && mayViewServices,
  });

  /*
   * W2: the tabs. The choice belongs to THIS customer — opening another one starts again on
   * «نمای کلی» — and a jump (a shortcut that used to scroll) switches to the tab holding the
   * card and flashes it.
   */
  const tabs = customerTabs(mayViewMessages || mayMessage);
  const [tabState, setTabState] = useState<{ id: string; tab: CustomerTab }>({
    id,
    tab: 'overview',
  });
  const chosen = tabState.id === id ? tabState.tab : 'overview';
  const tab = tabs.some((item) => item.id === chosen) ? chosen : 'overview';
  const selectTab = (next: CustomerTab) => setTabState({ id, tab: next });
  const [flash, setFlash] = useState<string | null>(null);
  const jumpTo = (cardId: string) => {
    const owner = CARD_TABS[cardId];
    if (owner === undefined) return;
    /*
     * The page does not move (W2, `pnpm web:no-scroll` at 390). The shortcut sits deep in
     * «نمای کلی», and swapping the panel's content under it let the browser's scroll
     * anchoring pick some node of the new tab and shift the page by its offset — a jump of a
     * hundred pixels in either direction. Out of anchoring until the flash ends, the new tab
     * simply opens in place; the strip brings its tab into view sideways (`ui/tab-strip.ts`).
     */
    document.getElementById(PANEL_ID)?.classList.add('no-scroll-anchor');
    selectTab(owner);
    setFlash(cardId);
  };
  useEffect(() => {
    if (flash === null) return undefined;
    const card = document.getElementById(flash);
    card?.classList.add('wb-flash');
    const timer = setTimeout(() => {
      card?.classList.remove('wb-flash');
      document.getElementById(PANEL_ID)?.classList.remove('no-scroll-anchor');
      setFlash(null);
    }, 1600);
    return () => clearTimeout(timer);
  }, [flash, tab]);

  return (
    <>
      {/*
       * The page keeps ONE level-one heading in every state. Loaded, the head
       * card carries it; loading, refused or failed, there is no row to name,
       * so the plain page head stands in — as on the order and payment pages.
       */}
      {row === undefined && <PageHead title={t('web.user_detail')} />}

      <StateSwitch query={customer} denied={denied}>
        {row === undefined ? null : (
          <div className="c360">
            <UserHead
              row={row}
              mayViewWallet={mayViewWallet}
              exempt={controls !== undefined && controls.channelMembershipExemptAt !== null}
              isReseller={isReseller === true}
            />

            {/* W1.5: every action on this customer, in one panel under the head. */}
            <ActionPanel
              title={t('web.c360_action_panel_title')}
              groups={[
                {
                  key: 'wallet',
                  title: t('web.c360_group_wallet'),
                  actions: [
                    mayCredit && mayViewWallet && (
                      <Button key="credit" icon="plus" onClick={() => setWalletDialog('CREDIT')}>
                        {t('web.c360_increase_balance')}
                      </Button>
                    ),
                    mayDebit && mayViewWallet && (
                      <Button key="debit" onClick={() => setWalletDialog('DEBIT')}>
                        {t('web.c360_decrease_balance')}
                      </Button>
                    ),
                  ],
                },
                {
                  key: 'orders',
                  title: t('web.c360_group_orders'),
                  actions: [
                    /* A manual order spends the wallet: the server also charges users.wallet.debit. */
                    mayManualOrder && mayDebit && (
                      <Button key="manual" icon="plus" onClick={() => setManualOrderOpen(true)}>
                        {t('web.c360_manual_order')}
                      </Button>
                    ),
                    mayViewOrders && (
                      <a
                        key="orders"
                        className="btn ghost"
                        href={`/orders?q=${encodeURIComponent(id)}`}
                        onClick={onLink}
                      >
                        {t('web.c360_view_orders')}
                      </a>
                    ),
                  ],
                },
                {
                  key: 'contact',
                  title: t('web.c360_group_contact'),
                  actions: [
                    mayMessage && (
                      <Button key="message" icon="send" onClick={() => setMessageOpen(true)}>
                        {t('web.dm_send')}
                      </Button>
                    ),
                    mayBlock &&
                      (row.status === 'ACTIVE' ? (
                        <Button
                          key="block"
                          variant="danger"
                          icon="lock"
                          disabled={mutate.isPending}
                          onClick={() => setPending('BLOCK')}
                        >
                          {t('web.user_block')}
                        </Button>
                      ) : (
                        <Button
                          key="unblock"
                          variant="primary"
                          icon="check"
                          disabled={mutate.isPending}
                          onClick={() => setPending('UNBLOCK')}
                        >
                          {t('web.user_unblock')}
                        </Button>
                      )),
                  ],
                },
              ]}
              sensitive={danger.buttons}
            />
            {danger.modals}

            {row.status === 'BLOCKED' && (
              <Banner tone="danger" title={t('web.user_blocked_banner_title')}>
                {t('web.user_blocked_banner_body')}
              </Banner>
            )}

            {/*
              Step two of a block or an unblock, never one click (WP10G, closing
              OQ-WP10F-03): the confirmation — with the MANDATORY reason for a
              block — and only its confirm button sends anything. The server
              holds the rule (a block without a reason is a 400); the disabled
              button is the courtesy.
            */}
            <Modal
              open={mayBlock && pending !== null}
              onClose={cancelStep}
              danger={pending === 'BLOCK'}
              title={
                pending === 'BLOCK'
                  ? t('web.user_block_confirm_title')
                  : t('web.user_unblock_confirm_title')
              }
              foot={
                pending === 'BLOCK' ? (
                  <>
                    <Button
                      variant="danger-solid"
                      size="sm"
                      disabled={mutate.isPending || trimmedReason === '' || reasonTooLong}
                      onClick={() => mutate.mutate({ to: 'BLOCKED', reason: trimmedReason })}
                    >
                      {t('web.user_block_confirm')}
                    </Button>
                    <Button size="sm" disabled={mutate.isPending} onClick={cancelStep}>
                      {t('web.user_action_cancel')}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={mutate.isPending}
                      onClick={() => mutate.mutate({ to: 'ACTIVE', reason: '' })}
                    >
                      {t('web.user_unblock_confirm')}
                    </Button>
                    <Button size="sm" disabled={mutate.isPending} onClick={cancelStep}>
                      {t('web.user_action_cancel')}
                    </Button>
                  </>
                )
              }
            >
              {pending === 'BLOCK' ? (
                <>
                  <Banner tone="warn">{t('web.user_block_confirm_body')}</Banner>
                  <Field
                    label={t('web.user_block_reason_label')}
                    hint={t('web.user_block_reason_hint')}
                    htmlFor="user-block-reason"
                    {...(reason !== '' && trimmedReason === ''
                      ? { error: t('web.user_block_reason_required') }
                      : reasonTooLong
                        ? { error: t('web.user_block_reason_too_long') }
                        : {})}
                  >
                    <Input
                      id="user-block-reason"
                      value={reason}
                      aria-invalid={(reason !== '' && trimmedReason === '') || reasonTooLong}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </Field>
                </>
              ) : (
                <Banner tone="warn">{t('web.user_unblock_confirm_body')}</Banner>
              )}
              {mutate.error !== null && (
                <Banner tone="danger">
                  {messageFor(mutate.error)}
                  <ErrorRef error={mutate.error} />
                </Banner>
              )}
            </Modal>

            <ManualOrderModal
              customerId={id}
              open={mayManualOrder && mayDebit && manualOrderOpen}
              onClose={() => setManualOrderOpen(false)}
            />

            <DirectMessageComposeModal
              customerId={id}
              open={mayMessage && messageOpen}
              blocked={row.status === 'BLOCKED'}
              onClose={() => setMessageOpen(false)}
            />

            <WalletAdjustDialog
              customerId={id}
              direction={mayViewWallet ? walletDialog : null}
              onClose={() => setWalletDialog(null)}
            />

            <CustomerAttentionCard customerId={id} />

            {/*
              W2: nine real tabs, only the chosen one drawn. A link that used to scroll to a
              card switches to the tab that holds it and flashes the card; another customer
              opens on the overview tab.
            */}
            <Tabs value={tab} onChange={selectTab} items={tabs} panelId={PANEL_ID} />
            <TabPanel id={PANEL_ID} labelledBy={`${PANEL_ID}-tab-${tab}`}>
              {tab === 'overview' && (
                <TwoColumn
                  main={
                    <>
                      <CustomerLatestCard customerId={id} />
                      <OperatorShortcutsCard
                        shortcuts={customerShortcuts(id, {
                          orders: mayViewOrders,
                          services: mayViewServices,
                          payments: mayViewPayments,
                          tickets: mayViewTickets,
                          wallet: mayViewWallet,
                          businessChats: mayViewBusinessChats,
                        })}
                        onJump={jumpTo}
                      />
                    </>
                  }
                  side={
                    <>
                      <GeneralInfoCard
                        row={row}
                        overview={controls}
                        resellerLabel={
                          isReseller === undefined
                            ? undefined
                            : isReseller
                              ? t('web.c360_group_reseller')
                              : t('web.c360_group_regular')
                        }
                      />
                      <Card title={t('web.user_access_title')}>
                        <KV
                          items={[
                            [t('web.status'), <StatusBadge key="s" status={row.status} />],
                            [
                              t('web.user_blocked_at'),
                              row.blockedAt === null ? (
                                <Dash key="b" />
                              ) : (
                                formatTimestamp(row.blockedAt)
                              ),
                            ],
                            [
                              t('web.user_blocked_reason'),
                              row.blockedReason === null ? <Dash key="r" /> : row.blockedReason,
                            ],
                            ...(row.status === 'BLOCKED' && row.blockedReason !== null
                              ? ([
                                  [
                                    t('web.user_blocked_reason_shown'),
                                    row.blockedReasonShown
                                      ? t('web.user_blocked_reason_shown_yes')
                                      : t('web.user_blocked_reason_shown_no'),
                                  ],
                                ] as [ReactNode, ReactNode][])
                              : []),
                            // Round N close (§D): the customer's own promotional opt-out.
                            [
                              t('web.user_marketing'),
                              row.marketingOptOutAt === null
                                ? t('web.user_marketing_in')
                                : t('web.user_marketing_out'),
                            ],
                            ...(row.marketingOptOutAt === null
                              ? []
                              : ([
                                  [
                                    t('web.user_marketing_since'),
                                    formatTimestamp(row.marketingOptOutAt),
                                  ],
                                ] as [ReactNode, ReactNode][])),
                          ]}
                        />
                        <p className="muted small">{t('web.user_marketing_hint')}</p>
                        {/* No disabled button. A disabled control and this sentence make
                        the same claim, and only one of them names the permission. */}
                        {!mayBlock && <Banner tone="info">{t('web.user_block_denied')}</Banner>}
                      </Card>
                    </>
                  }
                />
              )}
              {tab === 'services' && (
                <div id="c360-services" className="stack">
                  <ServiceCountsStrip customerId={id} />
                  <CustomerServicesCard
                    customerId={id}
                    mayView={mayViewServices}
                    mayViewLegacy={mayViewLegacyServices}
                  />
                  <CustomerOrdersCard customerId={id} mayView={mayViewOrders} />
                </div>
              )}
              {tab === 'support' && (
                <CustomerTicketsCard customerId={id} mayView={mayViewTickets} />
              )}
              {tab === 'financial' && (
                <div className="stack">
                  <div id="c360-wallet" className="stack">
                    <WalletCard
                      customerId={id}
                      mayView={mayViewWallet}
                      mayCredit={mayCredit}
                      mayDebit={mayDebit}
                      onAdjust={setWalletDialog}
                    />
                  </div>
                  <FinancialSummaryCard customerId={id} />
                </div>
              )}
              {tab === 'controls' && (
                <div className="stack">
                  <CustomerControlsCard
                    customerId={id}
                    overview={controls}
                    mayExemptChannel={mayExemptChannel}
                    mayVerifyPhone={mayVerifyPhone}
                    mayEditLocation={mayEditLocation}
                    mayEditNotifications={mayEditNotifications}
                  />
                  <TrialCard customerId={id} mayEdit={mayEditTrial} />
                </div>
              )}
              {tab === 'relations' && (
                <div id="c360-relations" className="stack">
                  <ResellerCard
                    customerId={id}
                    telegramUserId={row.telegramUserId}
                    mayView={mayViewReseller}
                    mayEdit={mayEditReseller}
                  />
                  <CustomerReferralCard customerId={id} mayView={mayViewReferrals} />
                </div>
              )}
              {tab === 'messages' && (
                <DirectMessagesCard
                  customerId={id}
                  mayView={mayViewMessages}
                  maySend={mayMessage}
                  onCompose={() => setMessageOpen(true)}
                />
              )}
              {tab === 'crm' && (
                <CustomerCrmSection
                  customerId={id}
                  mayViewNotes={mayViewNotes}
                  mayWriteNotes={mayWriteNotes}
                  mayAssignTags={mayAssignTags}
                  mayManageTags={mayManageTags}
                  noteSubmission={noteSubmission}
                />
              )}
              {tab === 'timeline' && (
                <div className="stack">
                  <TimelineCard customerId={id} mayView={mayViewAudit} />
                </div>
              )}
            </TabPanel>
          </div>
        )}
      </StateSwitch>
    </>
  );
}

/**
 * The head of a customer's page: who they are — the Telegram numeric id first, because
 * that is the identity a support conversation quotes — where they stand, and the primary
 * actions.
 *
 * Every figure in the strip is a field the server sent, read through the SAME query key
 * its card below uses — so the strip adds no request of its own beyond the summary the
 * financial card reads, and it can never disagree with the card beside it.
 */
function UserHead({
  row,
  mayViewWallet,
  exempt,
  isReseller,
}: {
  row: CustomerSummaryResponse;
  mayViewWallet: boolean;
  exempt: boolean;
  isReseller: boolean;
}) {
  const wallet = useQuery({
    queryKey: ['wallet', row.id],
    queryFn: () => fetchWallet(row.id),
    enabled: mayViewWallet,
  });
  const trial = useQuery({
    queryKey: ['customer-trial', row.id],
    queryFn: () => fetchCustomerTrial(row.id),
  });
  const summary = useFinancialSummary(row.id, true);
  const name = displayName(row);
  const balance = wallet.data?.wallet;
  const remaining = trial.data?.trial.remaining;
  const services = summary.data?.summary.services;
  const orders = summary.data?.summary.orders;
  const active = services?.byState.find((entry) => entry.state === 'ACTIVE')?.count ?? 0;
  const purchases = orders?.purchases.reduce((sum, entry) => sum + entry.count, 0);

  return (
    <DetailHead
      level={1}
      initial={initialOf(name ?? row.username ?? '#')}
      title={
        name ??
        (row.username === null ? (
          t('web.user_detail')
        ) : (
          <Ltr mono={false}>{`@${row.username}`}</Ltr>
        ))
      }
      badge={
        <>
          <StatusBadge status={row.status} />
          <SourceBadge source={row.source} />
          {isReseller && <Badge tone="teal">{t('web.c360_badge_reseller')}</Badge>}
          {exempt && <Badge tone="violet">{t('web.c360_channel_exempt')}</Badge>}
        </>
      }
      meta={
        <>
          <span className="ca-meta">
            <span className="faint">{t('web.user_telegram_id')}</span>
            <Copyable value={row.telegramUserId} />
          </span>
          {row.username !== null && (
            <span className="ca-meta">
              <span className="faint">{t('web.user_username')}</span>
              <Ltr mono={false}>{`@${row.username}`}</Ltr>
            </span>
          )}
          <span className="ca-meta">
            <span className="faint">{t('web.user_language')}</span>
            {row.languageCode === null ? <Dash /> : <Ltr mono={false}>{row.languageCode}</Ltr>}
          </span>
        </>
      }
      stats={[
        { label: t('web.user_first_seen'), value: formatTimestamp(row.firstSeenAt) },
        { label: t('web.user_last_seen'), value: formatTimestamp(row.lastSeenAt) },
        ...(mayViewWallet
          ? [
              {
                label: t('web.wallet_balance'),
                value:
                  balance === undefined ? (
                    <Dash />
                  ) : (
                    <Money
                      value={{ amountMinor: balance.balanceAmount, currency: balance.currency }}
                    />
                  ),
              },
            ]
          : []),
        ...(services === undefined || services === null
          ? []
          : [{ label: t('web.c360_stat_active_services'), value: <Num value={active} /> }]),
        ...(purchases === undefined
          ? []
          : [{ label: t('web.c360_stat_purchases'), value: <Num value={purchases} /> }]),
        {
          label: t('web.user_stat_trial_remaining'),
          value: remaining === undefined ? <Dash /> : <Num value={remaining} />,
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// This customer's orders and services
// ---------------------------------------------------------------------------

/**
 * How many rows either embedded list shows at a time.
 *
 * Smaller than the top-level screens' 25, because this is one card among five on
 * a detail page rather than the whole screen. The pager makes the bound
 * honest — an operator can always reach the next page — which is what a bounded
 * list owes and a "recent N" with no pager does not.
 */
const EMBEDDED_PAGE = LIST_PAGE_SIZE;

/**
 * The cursor trail both embedded cards page with.
 *
 * A single `cursor` was the first version, reset to null on Previous — which is what
 * `WalletCard` and `/services` do, and what a Codex round on this PR named: after two
 * advances, Previous jumped from page three straight to page one and page two could not
 * be reached at all. The button says "the adjacent page" in both vocabularies —
 * «تازه‌تر» on the ascending card and «قدیمی‌تر» on the descending one — so delivering
 * the FIRST page is a control that does something other than what it is labelled, which
 * is the class of thing this codebase refuses everywhere else.
 *
 * So it keeps the stack `OrdersPage` keeps, and Previous pops one. There is no filter
 * signature to key it on, unlike `OrdersPage`: an embedded card is pinned to one
 * customer for its whole life, and the page is keyed by that customer's id at the route,
 * so a different customer is a different component instance with an empty trail.
 */
function useCursorTrail(): {
  readonly cursor: string | undefined;
  readonly hasPrevious: boolean;
  readonly back: () => void;
  readonly forward: (next: string | null) => void;
} {
  const [trail, setTrail] = useState<readonly string[]>([]);
  return {
    cursor: trail.length > 0 ? trail[trail.length - 1] : undefined,
    hasPrevious: trail.length > 0,
    back: () => setTrail((current) => current.slice(0, -1)),
    /*
     * A null next cursor pushes NOTHING.
     *
     * `CursorPager` disables the button when there is no next page, so this is
     * unreachable through the UI — and it is guarded anyway, because pushing a
     * placeholder would make Previous pop a page that was never visited.
     */
    forward: (next) => {
      if (next !== null) setTrail((current) => [...current, next]);
    },
  };
}

/**
 * This customer's orders.
 *
 * ## Why this is a paged list and not a count or a "latest five"
 *
 * A count would be a number this page computes from a page of rows, and there is
 * no endpoint that returns one — inventing it from `items.length` is the legacy
 * statistics screen, which counted configured panels as connected. A "latest
 * five" would be worse: `/orders` pages ASCENDING, oldest first, and a card
 * labelled "latest" over the first page of an ascending traversal shows a
 * customer's FIRST five orders while claiming they are their last. The
 * divergence is deliberate (`drizzle-service.repository.ts` records the owner's
 * decision that `/users`, `/orders` and `/products` page one way and
 * `/services` the other), so the card states the direction in words and hands
 * the pager the same swapped labels `/orders` uses.
 *
 * ## It calls the same endpoint the screen calls
 *
 * `GET /orders?customerId=…` — the filter has existed since 4B and is charged
 * `orders.view` inside `OrderService.list`, so this card adds no read path and
 * no new authorization surface. The "all orders" link below opens the same
 * query on the full screen, which is where the state filter and the pager trail
 * live.
 */
function CustomerOrdersCard({ customerId, mayView }: { customerId: string; mayView: boolean }) {
  const onLink = useLinkHandler();
  const pages = useCursorTrail();

  const orders = useQuery(
    keepPageWhileTurning({
      queryKey: ['customer-orders', customerId, pages.cursor ?? null],
      queryFn: () =>
        fetchOrders({
          customerId,
          limit: EMBEDDED_PAGE,
          ...(pages.cursor === undefined ? {} : { cursor: pages.cursor }),
        }),
      enabled: mayView,
    }),
  );

  if (!mayView) {
    return (
      <Card title={t('web.user_orders_title')}>
        <Banner tone="info">{t('web.user_orders_denied')}</Banner>
      </Card>
    );
  }

  const columns: readonly Column<OrderSummaryResponse>[] = [
    {
      key: 'title',
      header: t('web.order_line'),
      render: (row) => (
        <a href={`/orders/${encodeURIComponent(row.id)}`} onClick={onLink} className="strong">
          {/* The SNAPSHOT title, not a lookup. What the customer bought. */}
          {row.lineTitle}
        </a>
      ),
    },
    {
      key: 'state',
      header: t('web.status'),
      render: (row) => (
        <Badge tone={ORDER_STATE_TONES[row.state]} dot>
          {t(ORDER_STATE_LABELS[row.state])}
        </Badge>
      ),
    },
    {
      key: 'total',
      header: t('web.order_total'),
      render: (row) => <Money value={{ amountMinor: row.totalAmount, currency: row.currency }} />,
    },
    {
      key: 'created',
      header: t('web.order_created_at'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.createdAt)}</span>,
    },
  ];

  return (
    <Card
      title={t('web.user_orders_title')}
      hint={t('web.user_orders_hint')}
      actions={
        <a href={`/orders?q=${encodeURIComponent(customerId)}`} onClick={onLink}>
          {t('web.user_orders_all')}
        </a>
      }
    >
      <StateSwitch query={orders}>
        {orders.data === undefined ? null : orders.data.orders.length === 0 ? (
          <Empty title={t('web.user_orders_empty')} />
        ) : (
          <>
            <DataTable
              caption={t('web.user_orders_title')}
              columns={columns}
              rows={orders.data.orders}
              rowKey={(row) => row.id}
              dense
            />
            {/* The kit's previous / next labels, as every list (W1.8); `nextCursor` walks towards newer rows. */}
            <CursorPager
              shown={orders.data.orders.length}
              hasPrevious={pages.hasPrevious}
              hasNext={orders.data.nextCursor !== null}
              onPrevious={pages.back}
              onNext={() => pages.forward(orders.data?.nextCursor ?? null)}
            />
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

/**
 * This customer's services.
 *
 * The same shape as the orders card and the same reasoning, with one difference
 * that matters: `/services` pages DESCENDING, so the pager keeps its default
 * labels and the hint says newest-first. The two cards sit one above the other
 * with pagers whose buttons mean opposite things, which is precisely why each
 * one says which way it goes rather than leaving it to be inferred.
 *
 * Two columns and not one, because `state` and `deliveryState` are two facts:
 * a provisioned account whose Telegram message bounced is `ACTIVE` and `FAILED`,
 * and a card that merged them would show it as unprovisioned — for which the
 * obvious remedy is to provision it again, on somebody's panel, a second time.
 * `services.tsx` states the rule; this card obeys it rather than restating it.
 *
 * No subscription link and no masked stand-in: `serviceSummarySchema` does not
 * carry `subscriptionUrl`, `subscriptionRef` or `providerClientId`, so there is
 * nothing here to leak and no edit to this file that could start leaking one.
 */
function CustomerServicesCard({
  customerId,
  mayView,
  mayViewLegacy = false,
}: {
  customerId: string;
  mayView: boolean;
  /** `legacy.services.view`: mark the services adopted from a Mirza invoice. */
  mayViewLegacy?: boolean;
}) {
  const onLink = useLinkHandler();
  const pages = useCursorTrail();

  const services = useQuery(
    keepPageWhileTurning({
      queryKey: ['customer-services', customerId, pages.cursor ?? null],
      queryFn: () =>
        fetchServices({
          customerId,
          limit: EMBEDDED_PAGE,
          ...(pages.cursor === undefined ? {} : { cursor: pages.cursor }),
        }),
      enabled: mayView,
    }),
  );
  // Which services on THIS page were adopted from Mirza — asked of the server for exactly
  // the ids shown, never inferred from a name or a date.
  const shownIds = (services.data?.services ?? []).map((row) => row.id);
  const adoptions = useQuery({
    queryKey: ['customer-legacy-adopted-services', customerId, shownIds],
    queryFn: () => fetchCustomerLegacyAdoptedServices(customerId, shownIds),
    enabled: mayView && mayViewLegacy && shownIds.length > 0,
  });
  const adoptedFrom = new Map(
    (adoptions.data?.adoptions ?? []).map((row) => [row.serviceId, row.invoiceKey]),
  );

  if (!mayView) {
    return (
      <Card title={t('web.user_services_title')}>
        <Banner tone="info">{t('web.user_services_denied')}</Banner>
      </Card>
    );
  }

  const columns: readonly Column<ServiceSummaryResponse>[] = [
    {
      key: 'username',
      header: t('web.service_username'),
      render: (row) => (
        <span>
          <a href={`/services/${encodeURIComponent(row.id)}`} onClick={onLink} className="strong">
            <Ltr>{row.providerUsername}</Ltr>
          </a>
          {adoptedFrom.has(row.id) && (
            <>
              {' '}
              <Badge tone="info" outline title={t('web.c360_service_from_mirza_title')}>
                {t('web.c360_service_from_mirza')}
              </Badge>
            </>
          )}
        </span>
      ),
    },
    {
      key: 'state',
      header: t('web.service_state'),
      render: (row) => (
        <Badge tone={SERVICE_STATE_TONES[row.state]} dot>
          {t(SERVICE_STATE_LABELS[row.state])}
        </Badge>
      ),
    },
    {
      key: 'delivery',
      header: t('web.service_delivery'),
      render: (row) => (
        <Badge tone={SERVICE_DELIVERY_TONES[row.deliveryState]}>
          {t(SERVICE_DELIVERY_LABELS[row.deliveryState])}
        </Badge>
      ),
    },
    {
      key: 'expires',
      header: t('web.service_expires_at'),
      render: (row) =>
        row.expiresAt === null ? (
          <Dash />
        ) : (
          <span className="nowrap">{formatTimestamp(row.expiresAt)}</span>
        ),
    },
  ];

  return (
    <Card
      title={t('web.user_services_title')}
      hint={t('web.user_services_hint')}
      actions={
        <a href={`/services?q=${encodeURIComponent(customerId)}`} onClick={onLink}>
          {t('web.user_services_all')}
        </a>
      }
    >
      <StateSwitch query={services}>
        {services.data === undefined ? null : services.data.services.length === 0 ? (
          <Empty title={t('web.user_services_empty')} />
        ) : (
          <>
            <DataTable
              caption={t('web.user_services_title')}
              columns={columns}
              rows={services.data.services}
              rowKey={(row) => row.id}
              dense
            />
            {/* Default labels: this traversal runs newest to oldest. */}
            <CursorPager
              shown={services.data.services.length}
              hasPrevious={pages.hasPrevious}
              hasNext={services.data.nextCursor !== null}
              onPrevious={pages.back}
              onNext={() => pages.forward(services.data?.nextCursor ?? null)}
            />
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

const DIRECTION_LABELS: Readonly<Record<LedgerDirection, WebKey>> = {
  CREDIT: 'web.wallet_direction_credit',
  DEBIT: 'web.wallet_direction_debit',
};

const DIRECTION_TONES: Readonly<Record<LedgerDirection, Tone>> = {
  CREDIT: 'ok',
  DEBIT: 'warn',
};

/** A positive whole number of minor units: ASCII digits, not all zeros. */
const POSITIVE_WHOLE = /^0*[1-9][0-9]*$/u;

/**
 * A customer's wallet: the derived balance, the ledger, and one way to move it.
 *
 * Three things this card deliberately does NOT offer, each of which the legacy
 * system did:
 *
 * - **No balance field to type into.** The number shown is summed from the entries
 *   below it on every read. `صفر کردن موجودی` — "zero the balance" — is a
 *   set-balance in disguise, and there is no ledger reason that could honestly
 *   describe it.
 * - **No edit and no delete on a row.** The ledger is append-only, enforced by
 *   triggers, and the copy says so rather than leaving an operator to discover it
 *   from a failed request. Correcting a mistake is a NEW entry in the other
 *   direction, which is what leaves both facts in the history.
 * - **No reason picker.** The server derives the reason from the direction, so a
 *   request cannot file a debit as a `PURCHASE` — a movement that would then read,
 *   for ever, as a customer having bought something.
 *
 * CREDIT and DEBIT are separate permissions with different risk labels, and this
 * draws them separately: an operator who may credit and not debit sees one button.
 * The service charges both itself — the missing button is a courtesy, never the
 * enforcement.
 */
/** The "from Mirza" badge: a row the one-time import carried from Mirza. */
function SourceBadgeMirza() {
  return <Badge tone="info">{t('web.source_mirza')}</Badge>;
}

function WalletCard({
  customerId,
  mayView,
  mayCredit,
  mayDebit,
  onAdjust,
}: {
  customerId: string;
  mayView: boolean;
  mayCredit: boolean;
  mayDebit: boolean;
  /** W3: opens the page's wallet dialog for one direction. */
  onAdjust: (direction: LedgerDirection) => void;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [importedCursor, setImportedCursor] = useState<string | null>(null);

  const wallet = useQuery({
    queryKey: ['wallet', customerId],
    queryFn: () => fetchWallet(customerId),
    enabled: mayView,
  });
  const entries = useQuery(
    keepPageWhileTurning({
      queryKey: ['wallet-entries', customerId, cursor, importedCursor],
      queryFn: () =>
        fetchWalletEntries(customerId, {
          limit: LIST_PAGE_SIZE,
          ...(cursor === null ? {} : { cursor }),
          ...(importedCursor === null ? {} : { importedCursor }),
        }),
      enabled: mayView,
    }),
  );

  if (!mayView) {
    return (
      <Card title={t('web.wallet_title')}>
        <Banner tone="info">{t('web.wallet_denied')}</Banner>
      </Card>
    );
  }

  const columns: Column<WalletEntrySummaryResponse>[] = [
    {
      key: 'direction',
      header: t('web.wallet_direction'),
      render: (row) => (
        <Badge tone={DIRECTION_TONES[row.direction]}>{t(DIRECTION_LABELS[row.direction])}</Badge>
      ),
    },
    {
      key: 'amount',
      header: t('web.wallet_balance'),
      // Positive, always, with the sign carried by the direction beside it — the
      // ledger's own shape, preserved to the screen.
      render: (row) => (
        <span className={row.direction === 'CREDIT' ? 'ca-amount credit' : 'ca-amount debit'}>
          <Money value={{ amountMinor: row.amount, currency: row.currency }} />
        </span>
      ),
    },
    {
      key: 'reason',
      header: t('web.wallet_reason'),
      // W5: the Persian name, the raw key in `title`; an unknown key stays raw, never blank.
      render: (row) => {
        const label = (LEDGER_REASON_LABELS as Readonly<Record<string, WebKey | undefined>>)[
          row.reason
        ];
        return label === undefined ? (
          <Ltr>{row.reason}</Ltr>
        ) : (
          <span title={row.reason}>{t(label)}</span>
        );
      },
    },
    {
      key: 'actor',
      header: t('web.wallet_actor'),
      render: (row) =>
        row.actorAdminId === null ? (
          <span className="faint">{t('web.wallet_actor_system')}</span>
        ) : (
          <Copyable value={row.actorAdminId} display={row.actorAdminId.slice(0, 8)} />
        ),
    },
    {
      key: 'note',
      header: t('web.wallet_note'),
      render: (row) => (row.note === null ? <Dash /> : row.note),
    },
    {
      key: 'createdAt',
      header: t('web.wallet_created_at'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.createdAt)}</span>,
    },
  ];

  const balance = wallet.data?.wallet;
  /*
   * BELOW ZERO is a real state, for two reasons: a reseller's legacy purchase drawn on the
   * removed credit line (`docs/wp9-reseller-audit.md` R8), and a negative Mirza balance the
   * one-time import carried over (owner decision 2026-10-17). The figure is drawn exactly
   * as derived — `Money` carries the sign — and said in words beside it, because a
   * negative balance read as a rendering glitch is a debt nobody follows up.
   */
  const negative = balance?.balanceAmount.startsWith('-') ?? false;

  return (
    <Card
      title={t('web.wallet_title')}
      hint={t('web.wallet_balance_hint')}
      actions={
        mayCredit || mayDebit ? (
          <>
            {mayCredit && (
              <Button size="sm" icon="plus" onClick={() => onAdjust('CREDIT')}>
                {t('web.c360_wallet_credit_open')}
              </Button>
            )}
            {mayDebit && (
              <Button size="sm" onClick={() => onAdjust('DEBIT')}>
                {t('web.c360_wallet_debit_open')}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      <StateSwitch query={wallet}>
        {balance === undefined ? null : (
          <>
            <div className="ca-balance">
              <KV
                inline
                items={[
                  [
                    t('web.wallet_balance'),
                    <span key="b" className={negative ? 'ca-amount negative' : 'ca-amount'}>
                      <Money
                        value={{ amountMinor: balance.balanceAmount, currency: balance.currency }}
                      />
                      {negative && (
                        <>
                          {' '}
                          <Badge tone="warn">{t('web.wallet_balance_negative')}</Badge>
                        </>
                      )}
                    </span>,
                  ],
                  [t('web.wallet_entry_count'), String(balance.entryCount)],
                ]}
              />
            </div>
            {negative && <Banner tone="warn">{t('web.wallet_balance_negative_hint')}</Banner>}
          </>
        )}
      </StateSwitch>

      <h3 className="ca-subhead">{t('web.wallet_history_title')}</h3>
      <StateSwitch query={entries}>
        {entries.data === undefined ? null : entries.data.entries.length === 0 ? (
          <Empty variant="compact" title={t('web.wallet_history_empty')} />
        ) : (
          <>
            <DataTable
              caption={t('web.wallet_history_title')}
              columns={columns}
              rows={entries.data.entries}
              rowKey={(row) => row.id}
              dense
            />
            <CursorPager
              shown={entries.data.entries.length}
              hasPrevious={cursor !== null}
              hasNext={entries.data.nextCursor !== null}
              onPrevious={() => setCursor(null)}
              onNext={() => setCursor(entries.data?.nextCursor ?? null)}
            />
          </>
        )}
      </StateSwitch>
      <p className="muted small">{t('web.wallet_immutable')}</p>

      {/*
        The one-time import's Mirza wallet history: shown beside the ledger, never part of
        it. The balance above is the ledger's alone; Mirza's own balance was carried as ONE
        opening entry, so these rows are what happened in Mirza, not money in NEXA.
      */}
      {entries.data !== undefined &&
        ((entries.data.importedEntries ?? []).length > 0 || importedCursor !== null) && (
          <>
            <h3 className="ca-subhead">
              {t('web.wallet_imported_title')} <SourceBadgeMirza />
            </h3>
            <p className="muted small">{t('web.wallet_imported_hint')}</p>
            <DataTable
              caption={t('web.wallet_imported_title')}
              columns={[
                {
                  key: 'signedAmount',
                  header: t('web.wallet_balance'),
                  render: (row) => (
                    <Money value={{ amountMinor: row.signedAmount, currency: row.currency }} />
                  ),
                },
                {
                  key: 'rawKind',
                  header: t('web.wallet_reason'),
                  render: (row) =>
                    row.origin === 'WHEEL_SPIN' ? (
                      t('web.wallet_imported_wheel')
                    ) : row.rawKind === null ? (
                      <Dash />
                    ) : (
                      <Ltr>{row.rawKind}</Ltr>
                    ),
                },
                {
                  key: 'note',
                  header: t('web.wallet_note'),
                  render: (row) => (row.note === null ? <Dash /> : row.note),
                },
                {
                  key: 'occurredAt',
                  header: t('web.wallet_created_at'),
                  render: (row) => (
                    <span className="nowrap">{formatTimestamp(row.occurredAt)}</span>
                  ),
                },
              ]}
              rows={entries.data.importedEntries ?? []}
              rowKey={(row) => row.id}
              dense
            />
            <CursorPager
              shown={(entries.data.importedEntries ?? []).length}
              hasPrevious={importedCursor !== null}
              hasNext={(entries.data.importedNextCursor ?? null) !== null}
              onPrevious={() => setImportedCursor(null)}
              onNext={() => setImportedCursor(entries.data?.importedNextCursor ?? null)}
            />
          </>
        )}

      {/*
        Named separately, because the two permissions are separate decisions with
        different risk labels. An operator who may credit and not debit is told
        which one they are missing rather than shown a card with one button and no
        explanation.
      */}
      {!mayCredit && <Banner tone="info">{t('web.wallet_credit_denied')}</Banner>}
      {!mayDebit && <Banner tone="info">{t('web.wallet_debit_denied')}</Banner>}
    </Card>
  );
}

/**
 * W3: the manual wallet movement, as a dialog for ONE direction — opened from the wallet
 * card's header and from the action panel. The rules are the ones the always-open form had:
 *
 * - DISABLED until the balance has loaded, because the balance carries the currency this
 *   movement is denominated in — there is no fallback currency.
 * - The idempotency key is bound to the NORMALISED body (trimmed amount and note, the
 *   direction and the currency), so a retry after a 5xx that differs only in whitespace is
 *   the same command, never a second movement of somebody's money.
 * - A typed amount or note asks before the dialog closes or the page is left.
 */
function WalletAdjustDialog({
  customerId,
  direction,
  onClose,
}: {
  customerId: string;
  direction: LedgerDirection | null;
  onClose: () => void;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [amount, setAmount] = useState('');
  // W6: said in Persian before anything is sent — whole minor units, digits only, above zero.
  const amountInvalid = amount.trim() !== '' && !POSITIVE_WHOLE.test(amount.trim());
  const [note, setNote] = useState('');
  const wallet = useQuery({
    queryKey: ['wallet', customerId],
    queryFn: () => fetchWallet(customerId),
    enabled: direction !== null,
  });
  const walletReady = wallet.data !== undefined;
  const close = () => {
    setAmount('');
    setNote('');
    adjust.reset();
    onClose();
  };
  const adjust = useMutation({
    mutationFn: (input: { direction: LedgerDirection }) => {
      /*
       * The key is bound to the PAYLOAD, so editing the amount and pressing again
       * is a new command rather than a replay the store would refuse as a mismatch.
       * Pressing the same button twice with the same figures is a replay, and the
       * server answers with the entry it already wrote. See `useSubmissionKey`.
       */
      /*
       * The currency comes from the LOADED balance and there is no fallback.
       *
       * There used to be `?? 'IRT'`, which is wrong twice over on an installation that
       * sells in IRR: the request carried a currency the operator never chose, and the
       * server refused a correctly entered credit with `wallet_currency_unsupported`.
       * The form is disabled until the balance resolves (see the fieldset below), so
       * this is unreachable — and it throws rather than guessing, because guessing a
       * denomination is how an amount travels without its currency.
       */
      const currency = wallet.data?.wallet.currency;
      if (currency === undefined) {
        throw new Error('The wallet balance has not loaded, so its currency is unknown.');
      }
      /*
       * The CURRENCY is part of the fingerprint too.
       *
       * The server hashes it into the request, so a key presented first with one
       * currency and then another is `platform.idempotency_payload_mismatch` — which
       * is what `useSubmissionKey` exists to avoid. Leaving it out made the two
       * fingerprints disagree about what the command was.
       */
      /*
       * The fingerprint is built from the NORMALISED body — the exact bytes sent.
       *
       * It used to hash the raw field state while the request below trimmed both
       * strings, so `«۱۰۰ »` and `«۱۰۰»` minted two different keys for one
       * server-visible command. After a 5xx or a dropped connection that had in fact
       * committed, a retry that differed only in whitespace arrived under a new key
       * and appended a SECOND credit or debit — which is the duplicate movement
       * `useSubmissionKey` exists to make impossible.
       *
       * So the trimming happens once, here, and both the key and the request read the
       * same values.
       */
      const body = {
        customerId,
        direction: input.direction,
        // A decimal STRING in minor units, straight through. Never parsed to a
        // `number` here: JSON has one numeric type and it rounds past 2^53.
        amount: amount.trim(),
        currency,
        note: note.trim(),
      } as const;
      return adjustWallet({ ...body, idempotencyKey: submission.current(body) });
    },
    onSuccess: (_response, variables) => {
      submission.settle();
      notify({
        tone: 'ok',
        message:
          variables.direction === 'CREDIT'
            ? t('web.wallet_credit_done')
            : t('web.wallet_debit_done'),
      });
      close();
      // Both are re-read rather than patched: the balance is DERIVED, so a client
      // that adjusted its own copy would be inventing the one number this whole
      // design exists to keep computed.
      void queries.invalidateQueries({ queryKey: ['wallet', customerId] });
      void queries.invalidateQueries({ queryKey: ['wallet-entries', customerId] });
    },
    // `settleOn`: a 4xx is an answer and the next press is a new question; a 5xx or
    // a dropped connection may have committed, and a fresh key on the retry would
    // be a SECOND movement of somebody's money.
    onError: (error) => submission.settleOn(error),
  });

  const credit = direction === 'CREDIT';
  return (
    <FormDialog
      open={direction !== null}
      title={t(credit ? 'web.c360_wallet_credit_open' : 'web.c360_wallet_debit_open')}
      danger={direction === 'DEBIT'}
      dirty={amount.trim() !== '' || note.trim() !== ''}
      onClose={close}
      foot={
        <Button
          variant={credit ? 'primary' : 'danger'}
          size="sm"
          {...(credit ? { icon: 'plus' as const } : {})}
          disabled={!walletReady || adjust.isPending || amount.trim() === '' || amountInvalid}
          onClick={() => direction !== null && adjust.mutate({ direction })}
        >
          {t(credit ? 'web.wallet_credit' : 'web.wallet_debit')}
        </Button>
      }
    >
      <p className="muted small">{t('web.wallet_adjust_hint')}</p>
      <div className="form-grid">
        <Field
          label={t('web.wallet_adjust_amount')}
          htmlFor="wallet-amount"
          {...(amountInvalid ? { error: t('web.err_rule_amount_positive') } : {})}
        >
          <Input
            id="wallet-amount"
            inputMode="numeric"
            dir="ltr"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <Field label={t('web.wallet_adjust_note')} htmlFor="wallet-note">
          <Input
            id="wallet-note"
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
      </div>
      {adjust.error !== null && <ApiErrorReport error={adjust.error} />}
    </FormDialog>
  );
}

// ---------------------------------------------------------------------------
// This customer's trial allowance (WP6-B)
// ---------------------------------------------------------------------------

/**
 * ADR-0015's two numbers for one customer, and the override that sets the first.
 *
 * Every figure is the SERVER's, from the evaluator a claim decides with; nothing here
 * computes an allowance. The stored override is echoed as stored, or «none» — a screen
 * that could not say which is the legacy write-only setting ADR-0015 forbids.
 */
function TrialCard({ customerId, mayEdit }: { customerId: string; mayEdit: boolean }) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [limit, setLimit] = useState('');
  const [reason, setReason] = useState('');
  // W3: the override's two writes are dialogs opened from the card's header.
  const [dialog, setDialog] = useState<'set' | 'remove' | null>(null);

  const trial = useQuery({
    queryKey: ['customer-trial', customerId],
    queryFn: () => fetchCustomerTrial(customerId),
  });

  const write = useMutation({
    mutationFn: (input: { remove: boolean }) => {
      // The fingerprint is the normalised body, as `WalletCard` explains in full.
      const note = reason.trim();
      if (input.remove) {
        const body = { customerId, remove: true, reason: note };
        return removeTrialOverride({
          customerId,
          idempotencyKey: submission.current(body),
          ...(note === '' ? {} : { reason: note }),
        });
      }
      const parsed = Number(limit.trim());
      const body = { customerId, limit: parsed, reason: note };
      return setTrialOverride({
        customerId,
        idempotencyKey: submission.current(body),
        limit: parsed,
        ...(note === '' ? {} : { reason: note }),
      });
    },
    onSuccess: (response, variables) => {
      submission.settle();
      notify({
        tone: 'ok',
        message: variables.remove ? t('web.trial_override_removed') : t('web.trial_override_done'),
      });
      setLimit('');
      setReason('');
      setDialog(null);
      queries.setQueryData(['customer-trial', customerId], response);
      void queries.invalidateQueries({ queryKey: ['trial-overrides'] });
    },
    // A 5xx may have committed; a fresh key on the retry would be a second command.
    onError: (error) => submission.settleOn(error),
  });

  const closeDialog = () => {
    setDialog(null);
    setLimit('');
    setReason('');
    write.reset();
  };

  const row = trial.data?.trial;
  const reasonField = (
    <Field label={t('web.trial_reason_label')} htmlFor="trial-reason">
      <Input
        id="trial-reason"
        value={reason}
        maxLength={TRIAL_ADMIN_REASON_MAX_LENGTH}
        onChange={(event) => setReason(event.target.value)}
      />
    </Field>
  );
  return (
    <Card
      title={t('web.trial_card_title')}
      actions={
        mayEdit && row !== undefined ? (
          <>
            <Button size="sm" icon="plus" onClick={() => setDialog('set')}>
              {t('web.c360_trial_set_open')}
            </Button>
            {row.override !== null && (
              <Button size="sm" onClick={() => setDialog('remove')}>
                {t('web.c360_trial_remove_open')}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      <StateSwitch query={trial}>
        {row === undefined ? null : (
          <>
            {!row.featureEnabled && <Banner tone="info">{t('web.trial_feature_off')}</Banner>}
            <KV
              items={[
                [t('web.trial_global_limit'), String(row.globalLimit)],
                [
                  t('web.trial_override'),
                  row.override === null ? t('web.trial_override_none') : String(row.override.limit),
                ],
                [t('web.trial_effective_limit'), String(row.effectiveLimit)],
                [t('web.trial_used'), String(row.used)],
                [t('web.trial_remaining'), String(row.remaining)],
              ]}
            />
            <p className="muted small">{t('web.trial_zero_hint')}</p>
            {mayEdit ? (
              <>
                <FormDialog
                  open={dialog === 'set'}
                  title={t('web.c360_trial_set_open')}
                  dirty={limit.trim() !== '' || reason.trim() !== ''}
                  onClose={closeDialog}
                  foot={
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={write.isPending || limit.trim() === ''}
                      onClick={() => write.mutate({ remove: false })}
                    >
                      {t('web.trial_override_set')}
                    </Button>
                  }
                >
                  <div className="form-grid">
                    <Field label={t('web.trial_override_label')} htmlFor="trial-limit">
                      <Input
                        id="trial-limit"
                        inputMode="numeric"
                        dir="ltr"
                        value={limit}
                        onChange={(event) => setLimit(event.target.value)}
                      />
                    </Field>
                    {reasonField}
                  </div>
                  <p className="muted small">{t('web.trial_zero_hint')}</p>
                  {write.error !== null && (
                    <Banner tone="danger">
                      {messageFor(write.error)}
                      <ErrorRef error={write.error} />
                    </Banner>
                  )}
                </FormDialog>
                <FormDialog
                  open={dialog === 'remove' && row.override !== null}
                  title={t('web.c360_trial_remove_open')}
                  dirty={reason.trim() !== ''}
                  onClose={closeDialog}
                  foot={
                    <Button
                      size="sm"
                      disabled={write.isPending}
                      onClick={() => write.mutate({ remove: true })}
                    >
                      {t('web.trial_override_remove')}
                    </Button>
                  }
                >
                  {reasonField}
                  {write.error !== null && (
                    <Banner tone="danger">
                      {messageFor(write.error)}
                      <ErrorRef error={write.error} />
                    </Banner>
                  )}
                </FormDialog>
              </>
            ) : (
              <Banner tone="info">{t('web.trial_override_denied')}</Banner>
            )}
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// This customer's place in the referral graph (WP9-A)
// ---------------------------------------------------------------------------

/**
 * Whether this customer is a reseller, and on what terms (WP9-B).
 *
 * `resellers.view` is decided at the route and never derived from `users.view`; without
 * it the card names the key and issues no request. "Not a reseller" is the server's own
 * `RESELLER_NOT_FOUND`, which `fetchCustomerReseller` turns into a null — a fact about the
 * customer, drawn as one, never as an error card. Every figure is the server's: the
 * effective credit limit is the reseller's own or the tier's, decided there.
 *
 * Registering and editing happen on `/resellers`, where the tiers are; this card links
 * there, carrying the customer so the form opens filled in.
 */
function ResellerCard({
  customerId,
  telegramUserId,
  mayView,
  mayEdit,
}: {
  customerId: string;
  telegramUserId: string;
  mayView: boolean;
  mayEdit: boolean;
}) {
  const onLink = useLinkHandler();
  const reseller = useQuery({
    queryKey: ['customer-reseller', customerId],
    queryFn: () => fetchCustomerReseller(customerId),
    enabled: mayView,
  });

  if (!mayView) {
    return (
      <Card title={t('web.user_reseller_title')}>
        <Banner tone="info">{t('web.user_reseller_denied')}</Banner>
      </Card>
    );
  }

  const found = reseller.data?.reseller;
  return (
    <Card
      title={t('web.user_reseller_title')}
      {...(found === undefined
        ? {}
        : {
            actions: (
              <a href={`/resellers?search=${encodeURIComponent(telegramUserId)}`} onClick={onLink}>
                {t('web.user_reseller_manage')}
              </a>
            ),
          })}
    >
      <StateSwitch query={reseller}>
        {reseller.data === undefined ? null : found === undefined ? (
          <>
            <p className="muted small">{t('web.user_reseller_none')}</p>
            {mayEdit && (
              <a href={`/resellers?register=${encodeURIComponent(customerId)}`} onClick={onLink}>
                {t('web.user_reseller_register')}
              </a>
            )}
          </>
        ) : (
          <>
            <KV
              items={[
                [t('web.reseller_tier'), found.tier.name],
                [t('web.status'), <ResellerStatusBadge key="s" value={found.status} />],
                [
                  t('web.reseller_pricing'),
                  <PricingText
                    key="p"
                    label={OVERRIDE_LABELS[found.pricingMode]}
                    percent={found.discountPercentage}
                  />,
                ],
              ]}
            />
            {found.status === 'SUSPENDED' && (
              <Banner tone="warn">{t('web.user_reseller_suspended')}</Banner>
            )}
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

/**
 * Who referred this customer, how many they have referred, and what their commissions
 * came to — per currency, because two currencies never add up to one figure.
 *
 * READ-ONLY, as every referral surface is (`docs/wp9-referral-audit.md` F10): there is no
 * reassign and no adjust, because either would change who is owed money.
 *
 * `referrals.view` is decided at the route and never derived from `users.view`. Without
 * it the card names the key and issues no request — the server charges the same key in
 * `ReferralReadService.customer`, so the missing request is a courtesy, never the
 * enforcement. The referees themselves are not listed here: the response carries a
 * COUNT, and the link opens `/referrals` filtered to this referrer, which pages them.
 */
function CustomerReferralCard({ customerId, mayView }: { customerId: string; mayView: boolean }) {
  const onLink = useLinkHandler();
  const referral = useQuery({
    queryKey: ['customer-referral', customerId],
    queryFn: () => fetchCustomerReferral(customerId),
    enabled: mayView,
  });

  if (!mayView) {
    return (
      <Card title={t('web.user_referral_title')}>
        <Banner tone="info">{t('web.user_referral_denied')}</Banner>
      </Card>
    );
  }

  const row = referral.data;
  return (
    <Card
      title={t('web.user_referral_title')}
      actions={
        <a href={`/referrals?referrerId=${encodeURIComponent(customerId)}`} onClick={onLink}>
          {t('web.user_referral_all')}
        </a>
      }
    >
      <StateSwitch query={referral}>
        {row === undefined ? null : (
          <>
            <KV
              items={[
                [
                  t('web.user_referral_referred_by'),
                  row.referredBy === null ? (
                    <span key="by" className="muted">
                      {t('web.user_referral_not_referred')}
                    </span>
                  ) : (
                    <div key="by">
                      <PartyCell party={row.referredBy.referrer} />
                      <TriggerBadge value={row.referredBy.trigger} />{' '}
                      <span className="muted small nowrap">
                        {formatTimestamp(row.referredBy.createdAt)}
                      </span>
                    </div>
                  ),
                ],
                [t('web.user_referral_referred_count'), <Num key="n" value={row.referredCount} />],
                [
                  t('web.user_referral_code'),
                  row.code === null ? (
                    <span key="code" className="muted">
                      {t('web.user_referral_no_code')}
                    </span>
                  ) : (
                    <Ltr key="code">{row.code}</Ltr>
                  ),
                ],
              ]}
            />
            {row.totals.length === 0 ? (
              <p className="muted">{t('web.user_referral_no_commissions')}</p>
            ) : (
              <DataTable
                caption={t('web.user_referral_totals')}
                columns={REFERRAL_TOTAL_COLUMNS}
                rows={row.totals}
                rowKey={(total) => total.currency}
                dense
              />
            )}
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

type ReferralTotal = CustomerReferralResponse['totals'][number];

const REFERRAL_TOTAL_COLUMNS: readonly Column<ReferralTotal>[] = [
  {
    key: 'pending',
    header: t('web.user_referral_pending'),
    render: (total) => (
      <Money value={{ amountMinor: total.pendingAmount, currency: total.currency }} />
    ),
  },
  {
    key: 'earned',
    header: t('web.user_referral_earned'),
    render: (total) => (
      <Money value={{ amountMinor: total.earnedAmount, currency: total.currency }} />
    ),
  },
  {
    key: 'reversed',
    header: t('web.user_referral_reversed'),
    render: (total) => (
      <Money value={{ amountMinor: total.reversedAmount, currency: total.currency }} />
    ),
  },
  {
    key: 'unrecovered',
    header: t('web.user_referral_unrecovered'),
    render: (total) => (
      <Money value={{ amountMinor: total.unrecoveredAmount, currency: total.currency }} />
    ),
  },
];
