import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CUSTOMER_CONTROL_REASON_MAX_LENGTH,
  WALLET_REPORT_GROUP_OF,
  type CurrencyCode,
  type CustomerOverviewResponse,
  type CustomerSummaryResponse,
  type CustomerTransferBlocker,
  type CustomerTransferPreviewResponse,
  type CustomerTransferWarning,
  type ServiceState,
  type WalletReportGroup,
} from '@nexa/contracts';
import {
  ApiError,
  fetchCustomerFinancialSummary,
  fetchCustomerOverview,
  fetchCustomerTimeline,
  fetchProducts,
  placeManualOrder,
  previewCustomerTransfer,
  setCustomerChannelExemption,
  setCustomerLocationOverride,
  setCustomerNotifications,
  setCustomerPhone,
  toggleCustomerServices,
  transferCustomer,
} from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import { messageFor } from './settings';
import { WALLET_GROUP_LABELS } from './business';
import { STATE_LABELS as SERVICE_STATE_LABELS } from './services';
import { Dash } from './customer-parts';
import {
  Badge,
  Banner,
  Button,
  Card,
  Copyable,
  Disclosure,
  Empty,
  Field,
  Input,
  KV,
  Ltr,
  Modal,
  Money,
  Num,
  Select,
  StateSwitch,
  Timeline,
  useToast,
  type Tone,
} from '../ui/kit';

/**
 * Customer 360 — the sections the redesigned customer page adds (spec §11).
 *
 * Every figure is the server's: the controls are read from `/users/:id/overview`, the
 * aggregates from `/users/:id/financial-summary` (exact sums of stored rows, null where the
 * reader may not see them), the timeline from the audit log. Every action sends an
 * idempotency key bound to its payload (`useSubmissionKey`) and a reason, and the server
 * charges its own permission — a control this page does not draw is a courtesy.
 */

/** The overview query, shared by the head, the general card and the controls. */
export function useCustomerOverview(customerId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['customer-overview', customerId],
    queryFn: () => fetchCustomerOverview(customerId),
    enabled,
  });
}

/** Persian for the refusals this page's own commands can meet; else the shared mapping. */
export function c360Message(error: unknown): string {
  if (error instanceof ApiError) {
    const known = C360_ERRORS[error.code];
    if (known !== undefined) return t(known);
  }
  return messageFor(error);
}

const C360_ERRORS: Readonly<Record<string, WebKey>> = {
  'commerce.customer_transfer_refused': 'web.c360_error_transfer_refused',
  'commerce.customer_transfer_preview_stale': 'web.c360_error_transfer_stale',
  'commerce.customer_transfer_confirmation_mismatch': 'web.c360_error_transfer_confirm',
  'commerce.customer_phone_invalid': 'web.c360_error_phone_invalid',
  'commerce.wallet_insufficient_funds': 'web.c360_error_wallet_insufficient',
  'commerce.service_username_required': 'web.c360_error_username_required',
};

// ---------------------------------------------------------------------------
// General information (§11.3)
// ---------------------------------------------------------------------------

export function GeneralInfoCard({
  row,
  overview,
  resellerLabel,
}: {
  row: CustomerSummaryResponse;
  overview: CustomerOverviewResponse | undefined;
  /** The group, when the reseller read is allowed and answered; undefined: not known. */
  resellerLabel: ReactNode | undefined;
}) {
  const name = [row.firstName, row.lastName].filter((part) => part !== null).join(' ');
  return (
    <Card title={t('web.c360_general_title')} id="c360-general">
      <KV
        items={[
          [t('web.user_telegram_id'), <Copyable key="tg" value={row.telegramUserId} />],
          [
            t('web.user_username'),
            row.username === null ? <Dash key="u" /> : <Ltr mono={false}>{`@${row.username}`}</Ltr>,
          ],
          [t('web.c360_display_name'), name === '' ? <Dash key="n" /> : name],
          [
            t('web.c360_phone'),
            overview === undefined ? (
              <Dash key="p" />
            ) : overview.phone === null ? (
              <span key="p" className="muted">
                {t('web.c360_phone_none')}
              </span>
            ) : (
              <span key="p">
                <Ltr>{overview.phone.number}</Ltr>{' '}
                <Badge tone="ok">{t('web.c360_phone_verified')}</Badge>
              </span>
            ),
          ],
          [t('web.user_first_seen'), formatTimestamp(row.firstSeenAt)],
          [t('web.user_last_seen'), formatTimestamp(row.lastSeenAt)],
          [
            t('web.c360_terms'),
            // There is no terms domain yet: said in words, never "not accepted".
            <span key="terms" className="muted">
              {t('web.c360_terms_unavailable')}
            </span>,
          ],
          [
            t('web.c360_notifications'),
            row.marketingOptOutAt === null
              ? t('web.user_marketing_in')
              : t('web.user_marketing_out'),
          ],
          [t('web.c360_group'), resellerLabel === undefined ? <Dash key="g" /> : resellerLabel],
          [
            t('web.user_language'),
            row.languageCode === null ? (
              <Dash key="l" />
            ) : (
              <Ltr mono={false}>{row.languageCode}</Ltr>
            ),
          ],
        ]}
      />
      <p className="muted small">{t('web.c360_points_absent')}</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Controls (§11.4)
// ---------------------------------------------------------------------------

type ControlKind =
  'EXEMPT' | 'UNEXEMPT' | 'PHONE' | 'UNPHONE' | 'LOCATION' | 'UNLOCATION' | 'MKT_OUT' | 'MKT_IN';

export function CustomerControlsCard({
  customerId,
  overview,
  mayExemptChannel,
  mayVerifyPhone,
  mayEditLocation,
  mayEditNotifications,
}: {
  customerId: string;
  overview: CustomerOverviewResponse | undefined;
  mayExemptChannel: boolean;
  mayVerifyPhone: boolean;
  mayEditLocation: boolean;
  mayEditNotifications: boolean;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [open, setOpen] = useState<ControlKind | null>(null);
  const [reason, setReason] = useState('');
  const [phone, setPhone] = useState('');
  const [cooldown, setCooldown] = useState('');
  const [maxChanges, setMaxChanges] = useState('');
  const [periodDays, setPeriodDays] = useState('');

  const close = () => {
    setOpen(null);
    setReason('');
    setPhone('');
    setCooldown('');
    setMaxChanges('');
    setPeriodDays('');
    write.reset();
  };

  const optionalInt = (text: string): number | null =>
    text.trim() === '' ? null : Number(text.trim());

  const write = useMutation({
    mutationFn: (kind: ControlKind) => {
      const note = reason.trim();
      switch (kind) {
        case 'EXEMPT':
        case 'UNEXEMPT': {
          const body = { exempt: kind === 'EXEMPT', reason: note };
          return setCustomerChannelExemption(customerId, {
            ...body,
            idempotencyKey: submission.current({ kind, ...body }),
          });
        }
        case 'PHONE':
        case 'UNPHONE': {
          const body = { phoneNumber: kind === 'PHONE' ? phone.trim() : null, reason: note };
          return setCustomerPhone(customerId, {
            ...body,
            idempotencyKey: submission.current({ kind, ...body }),
          });
        }
        case 'LOCATION':
        case 'UNLOCATION': {
          const body = {
            limits:
              kind === 'LOCATION'
                ? {
                    cooldownHours: optionalInt(cooldown),
                    maxChanges: optionalInt(maxChanges),
                    periodDays: optionalInt(periodDays),
                  }
                : null,
            reason: note,
          };
          return setCustomerLocationOverride(customerId, {
            ...body,
            idempotencyKey: submission.current({ kind, ...body }),
          });
        }
        case 'MKT_OUT':
        case 'MKT_IN': {
          const body = { marketingOptedOut: kind === 'MKT_OUT', reason: note };
          return setCustomerNotifications(customerId, {
            ...body,
            idempotencyKey: submission.current({ kind, ...body }),
          });
        }
      }
    },
    onSuccess: (response) => {
      submission.settle();
      notify({
        tone: 'ok',
        message: response.changed ? t('web.c360_control_done') : t('web.c360_control_unchanged'),
      });
      queries.setQueryData(['customer-overview', customerId], { overview: response.overview });
      void queries.invalidateQueries({ queryKey: ['customer', customerId] });
      void queries.invalidateQueries({ queryKey: ['customer-timeline', customerId] });
      close();
    },
    onError: (error) => submission.settleOn(error),
  });

  const reasonTooLong = Array.from(reason.trim()).length > CUSTOMER_CONTROL_REASON_MAX_LENGTH;
  const ready =
    reason.trim() !== '' &&
    !reasonTooLong &&
    (open !== 'PHONE' || phone.trim() !== '') &&
    !write.isPending;

  const row = (
    label: string,
    value: ReactNode,
    action: { label: string; kind: ControlKind } | null,
    allowed: boolean,
  ): [ReactNode, ReactNode] => [
    label,
    <span key={label} className="c360-control">
      <span>{value}</span>
      {allowed && action !== null && (
        <Button size="sm" variant="ghost" onClick={() => setOpen(action.kind)}>
          {action.label}
        </Button>
      )}
    </span>,
  ];

  const location = overview?.locationOverride ?? null;
  const exempt = overview?.channelMembershipExemptAt ?? null;
  const verified = overview?.phone ?? null;
  const optedOut = overview?.marketingOptOutAt ?? null;
  const limitText =
    location === null
      ? t('web.c360_location_default')
      : [
          location.cooldownHours === null
            ? t('web.c360_location_no_cooldown')
            : `${t('web.c360_location_cooldown')}: ${String(location.cooldownHours)}`,
          location.maxChanges === null || location.periodDays === null
            ? t('web.c360_location_no_limit')
            : `${t('web.c360_location_limit')}: ${String(location.maxChanges)} / ${String(location.periodDays)}`,
        ].join(' — ');

  return (
    <Card
      title={t('web.c360_controls_title')}
      hint={t('web.c360_controls_hint')}
      id="c360-controls"
    >
      {overview === undefined ? (
        <Dash />
      ) : (
        <KV
          items={[
            row(
              t('web.c360_channel_exemption'),
              exempt === null ? (
                t('web.c360_channel_required')
              ) : (
                <Badge tone="violet">{t('web.c360_channel_exempt')}</Badge>
              ),
              exempt === null
                ? { label: t('web.c360_channel_exempt_action'), kind: 'EXEMPT' }
                : { label: t('web.c360_channel_unexempt_action'), kind: 'UNEXEMPT' },
              mayExemptChannel,
            ),
            row(
              t('web.c360_phone'),
              verified === null ? t('web.c360_phone_none') : <Ltr>{verified.number}</Ltr>,
              verified === null
                ? { label: t('web.c360_phone_verify_action'), kind: 'PHONE' }
                : { label: t('web.c360_phone_revoke_action'), kind: 'UNPHONE' },
              mayVerifyPhone,
            ),
            row(
              t('web.c360_location_override'),
              limitText,
              { label: t('web.c360_location_set_action'), kind: 'LOCATION' },
              mayEditLocation,
            ),
            ...(location !== null && mayEditLocation
              ? [
                  row(
                    '',
                    '',
                    { label: t('web.c360_location_remove_action'), kind: 'UNLOCATION' },
                    true,
                  ),
                ]
              : []),
            row(
              t('web.c360_notifications'),
              optedOut === null ? t('web.user_marketing_in') : t('web.user_marketing_out'),
              optedOut === null
                ? { label: t('web.c360_notifications_off_action'), kind: 'MKT_OUT' }
                : { label: t('web.c360_notifications_on_action'), kind: 'MKT_IN' },
              mayEditNotifications,
            ),
          ]}
        />
      )}
      <p className="muted small">{t('web.c360_controls_permission_hint')}</p>

      <Modal
        open={open !== null}
        onClose={() => {
          if (!write.isPending) close();
        }}
        title={t('web.c360_control_confirm_title')}
        foot={
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={!ready}
              onClick={() => open !== null && write.mutate(open)}
            >
              {t('web.c360_confirm')}
            </Button>
            <Button size="sm" disabled={write.isPending} onClick={close}>
              {t('web.user_action_cancel')}
            </Button>
          </>
        }
      >
        {open === 'PHONE' && (
          <Field
            label={t('web.c360_phone_label')}
            hint={t('web.c360_phone_hint')}
            htmlFor="c360-phone"
          >
            <Input
              id="c360-phone"
              dir="ltr"
              inputMode="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          </Field>
        )}
        {open === 'LOCATION' && (
          <div className="form-grid">
            <Field label={t('web.c360_location_cooldown')} htmlFor="c360-cooldown">
              <Input
                id="c360-cooldown"
                dir="ltr"
                inputMode="numeric"
                value={cooldown}
                onChange={(event) => setCooldown(event.target.value)}
              />
            </Field>
            <Field label={t('web.c360_location_max_changes')} htmlFor="c360-max">
              <Input
                id="c360-max"
                dir="ltr"
                inputMode="numeric"
                value={maxChanges}
                onChange={(event) => setMaxChanges(event.target.value)}
              />
            </Field>
            <Field label={t('web.c360_location_period_days')} htmlFor="c360-period">
              <Input
                id="c360-period"
                dir="ltr"
                inputMode="numeric"
                value={periodDays}
                onChange={(event) => setPeriodDays(event.target.value)}
              />
            </Field>
            <p className="muted small">{t('web.c360_location_hint')}</p>
          </div>
        )}
        <Field
          label={t('web.c360_reason_label')}
          htmlFor="c360-control-reason"
          {...(reasonTooLong ? { error: t('web.user_block_reason_too_long') } : {})}
        >
          <Input
            id="c360-control-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        {write.error !== null && <Banner tone="danger">{c360Message(write.error)}</Banner>}
      </Modal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Financial summary (§11.6, §11.7)
// ---------------------------------------------------------------------------

const money = (amount: string, currency: CurrencyCode) => (
  <Money value={{ amountMinor: amount, currency }} />
);

function PerCurrency({
  rows,
}: {
  rows: readonly { currency: CurrencyCode; count: number; amount: string }[];
}) {
  if (rows.length === 0) return <Num value={0} />;
  return (
    <span className="c360-per-currency">
      {rows.map((row) => (
        <span key={row.currency}>
          {money(row.amount, row.currency)} <span className="faint">({row.count})</span>
        </span>
      ))}
    </span>
  );
}

export function useFinancialSummary(customerId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['customer-financial', customerId],
    queryFn: () => fetchCustomerFinancialSummary(customerId),
    enabled,
  });
}

export function FinancialSummaryCard({ customerId }: { customerId: string }) {
  const summary = useFinancialSummary(customerId, true);
  const data = summary.data?.summary;

  // The ledger, grouped by what a reason MEANS — the same map the reports use.
  const groups = new Map<
    string,
    { group: WalletReportGroup; currency: CurrencyCode; credit: bigint; debit: bigint }
  >();
  for (const row of data?.ledger ?? []) {
    const group = WALLET_REPORT_GROUP_OF[row.reason];
    const keyed = `${group}:${row.currency}`;
    const held = groups.get(keyed) ?? { group, currency: row.currency, credit: 0n, debit: 0n };
    if (row.direction === 'CREDIT') held.credit += BigInt(row.amount);
    else held.debit += BigInt(row.amount);
    groups.set(keyed, held);
  }

  return (
    <Card
      title={t('web.c360_financial_title')}
      hint={t('web.c360_financial_hint')}
      id="c360-financial"
    >
      <StateSwitch query={summary}>
        {data === undefined ? null : (
          <>
            <KV
              items={[
                [
                  t('web.c360_purchases'),
                  data.orders === null ? (
                    <span className="muted">{t('web.c360_denied_orders')}</span>
                  ) : (
                    <PerCurrency rows={data.orders.purchases} />
                  ),
                ],
                [
                  t('web.c360_discounts'),
                  data.orders === null ? <Dash /> : <PerCurrency rows={data.orders.discounts} />,
                ],
                [
                  t('web.c360_refunded'),
                  data.orders === null ? <Dash /> : <PerCurrency rows={data.orders.refunded} />,
                ],
                [
                  t('web.c360_orders_pending'),
                  data.orders === null ? <Dash /> : <Num value={data.orders.awaitingPayment} />,
                ],
                [
                  t('web.c360_orders_total'),
                  data.orders === null ? <Dash /> : <Num value={data.orders.orderCount} />,
                ],
                [
                  t('web.c360_payments_confirmed'),
                  data.payments === null ? (
                    <span className="muted">{t('web.c360_denied_payments')}</span>
                  ) : (
                    <PerCurrency rows={data.payments.confirmed} />
                  ),
                ],
                [
                  t('web.c360_payments_total'),
                  data.payments === null ? <Dash /> : <Num value={data.payments.paymentCount} />,
                ],
              ]}
            />
            {groups.size > 0 && (
              <Disclosure summary={t('web.c360_ledger_groups')} size="sm">
                <KV
                  items={[...groups.values()].map((group) => [
                    t(WALLET_GROUP_LABELS[group.group]),
                    <span key={`${group.group}-${group.currency}`} className="c360-per-currency">
                      {group.credit > 0n && (
                        <span className="ca-amount credit">
                          + {money(group.credit.toString(), group.currency)}
                        </span>
                      )}
                      {group.debit > 0n && (
                        <span className="ca-amount debit">
                          − {money(group.debit.toString(), group.currency)}
                        </span>
                      )}
                    </span>,
                  ])}
                />
              </Disclosure>
            )}
            <p className="muted small">{t('web.c360_financial_exact')}</p>
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

/** Service counts by state, from the same summary. Null when `services.view` is missing. */
export function ServiceCountsStrip({ customerId }: { customerId: string }) {
  const summary = useFinancialSummary(customerId, true);
  const services = summary.data?.summary.services;
  if (services === undefined || services === null || services.byState.length === 0) return null;
  return (
    <div className="c360-chips" aria-label={t('web.c360_service_counts')}>
      {services.byState.map((row) => (
        <Badge key={row.state} tone={row.state === 'ACTIVE' ? 'ok' : 'neutral'}>
          {t(SERVICE_STATE_LABELS[row.state as ServiceState])}: {String(row.count)}
        </Badge>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline (§11.10)
// ---------------------------------------------------------------------------

const ACTION_LABELS: Readonly<Record<string, WebKey>> = {
  'customer.block': 'web.c360_action_block',
  'customer.unblock': 'web.c360_action_unblock',
  'wallet.credit': 'web.c360_action_wallet_credit',
  'wallet.debit': 'web.c360_action_wallet_debit',
  'wallet.transfer_out': 'web.c360_action_wallet_transfer_out',
  'wallet.transfer_in': 'web.c360_action_wallet_transfer_in',
  'trial.override.set': 'web.c360_action_trial_set',
  'trial.override.remove': 'web.c360_action_trial_remove',
  'customer.location_override.set': 'web.c360_action_location_set',
  'customer.location_override.remove': 'web.c360_action_location_remove',
  'customer.phone.verify': 'web.c360_action_phone_verify',
  'customer.phone.revoke': 'web.c360_action_phone_revoke',
  'customer.channel_exemption.grant': 'web.c360_action_exempt',
  'customer.channel_exemption.revoke': 'web.c360_action_unexempt',
  'customer.marketing_opt_out': 'web.c360_action_marketing_out',
  'customer.marketing_opt_in': 'web.c360_action_marketing_in',
  'reseller.register': 'web.c360_action_reseller_register',
  'reseller.update': 'web.c360_action_reseller_update',
  'customer.account_transfer': 'web.c360_action_transfer_out',
  'customer.account_transfer.received': 'web.c360_action_transfer_in',
  'customer.manual_order': 'web.c360_action_manual_order',
  'customer.services.suspend_all': 'web.c360_action_suspend_all',
  'customer.services.resume_all': 'web.c360_action_resume_all',
  'customer.registered': 'web.c360_action_registered',
  'trial.claim': 'web.c360_action_trial_claim',
};

const RESULT_TONES: Readonly<Record<string, Tone>> = {
  SUCCESS: 'ok',
  DENIED: 'warn',
  FAILED: 'danger',
};

export function TimelineCard({ customerId, mayView }: { customerId: string; mayView: boolean }) {
  const onLink = useLinkHandler();
  const timeline = useQuery({
    queryKey: ['customer-timeline', customerId],
    queryFn: () => fetchCustomerTimeline(customerId),
    enabled: mayView,
  });
  if (!mayView) {
    return (
      <Card title={t('web.c360_timeline_title')} id="c360-timeline">
        <Banner tone="info">{t('web.c360_timeline_denied')}</Banner>
      </Card>
    );
  }
  return (
    <Card
      title={t('web.c360_timeline_title')}
      hint={t('web.c360_timeline_hint')}
      id="c360-timeline"
    >
      <StateSwitch query={timeline}>
        {timeline.data === undefined ? null : timeline.data.entries.length === 0 ? (
          <Empty variant="compact" title={t('web.c360_timeline_empty')} />
        ) : (
          <Timeline
            items={timeline.data.entries.map((entry) => {
              const label = ACTION_LABELS[entry.action];
              return {
                key: entry.id,
                at: formatTimestamp(entry.occurredAt),
                title: (
                  <span>
                    {label === undefined ? <Ltr>{entry.action}</Ltr> : t(label)}
                    {entry.result !== 'SUCCESS' && (
                      <>
                        {' '}
                        <Badge tone={RESULT_TONES[entry.result] ?? 'neutral'}>
                          {entry.result === 'DENIED'
                            ? t('web.c360_result_denied')
                            : t('web.c360_result_failed')}
                        </Badge>
                      </>
                    )}
                  </span>
                ),
                detail: (
                  <span className="muted small">
                    {entry.actorLabel === null ? t('web.wallet_actor_system') : entry.actorLabel}
                    {entry.reason === null ? '' : ` — ${entry.reason}`}
                  </span>
                ),
                tone: RESULT_TONES[entry.result] ?? 'neutral',
              };
            })}
          />
        )}
      </StateSwitch>
      {/* Phase D1: the whole trail — this customer's orders, payments and services too. */}
      <p className="small">
        <a href={`/audit-log?customerId=${encodeURIComponent(customerId)}`} onClick={onLink}>
          {t('web.c360_timeline_all')}
        </a>
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Manual order (§11.6)
// ---------------------------------------------------------------------------

/** Every ACTIVE product, following the cursor to the end. */
export async function allActiveProducts(): Promise<{
  products: Awaited<ReturnType<typeof fetchProducts>>['products'];
}> {
  const products: Awaited<ReturnType<typeof fetchProducts>>['products'] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchProducts({
      status: 'ACTIVE',
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    products.push(...page.products);
    if (page.nextCursor === null) return { products };
    cursor = page.nextCursor;
  }
}

export function ManualOrderModal({
  customerId,
  open,
  onClose,
}: {
  customerId: string;
  open: boolean;
  onClose: () => void;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const onLink = useLinkHandler();
  const submission = useSubmissionKey();
  const [productId, setProductId] = useState('');
  const [username, setUsername] = useState('');
  const [reason, setReason] = useState('');
  const products = useQuery({
    queryKey: ['manual-order-products'],
    // EVERY active product, page by page — a picker that showed the first hundred would
    // hide the rest without saying so (Codex review of #146).
    queryFn: () => allActiveProducts(),
    enabled: open,
  });

  const place = useMutation({
    mutationFn: () => {
      const body = {
        productId,
        username: username.trim() === '' ? null : username.trim(),
        reason: reason.trim(),
      };
      return placeManualOrder(customerId, {
        ...body,
        idempotencyKey: submission.current(body),
      });
    },
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.c360_manual_order_done') });
      for (const key of ['customer-orders', 'wallet', 'wallet-entries', 'customer-financial']) {
        void queries.invalidateQueries({ queryKey: [key, customerId] });
      }
      void queries.invalidateQueries({ queryKey: ['customer-timeline', customerId] });
    },
    onError: (error) => submission.settleOn(error),
  });

  const close = () => {
    if (place.isPending) return;
    setProductId('');
    setUsername('');
    setReason('');
    place.reset();
    onClose();
  };

  const chosen = products.data?.products.find((product) => product.id === productId);
  return (
    <Modal
      open={open}
      onClose={close}
      title={t('web.c360_manual_order_title')}
      foot={
        place.isSuccess ? (
          <Button size="sm" onClick={close}>
            {t('web.c360_close')}
          </Button>
        ) : (
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={productId === '' || reason.trim() === '' || place.isPending}
              onClick={() => place.mutate()}
            >
              {t('web.c360_manual_order_confirm')}
            </Button>
            <Button size="sm" disabled={place.isPending} onClick={close}>
              {t('web.user_action_cancel')}
            </Button>
          </>
        )
      }
    >
      {place.isSuccess ? (
        <Banner tone="ok" title={t('web.c360_manual_order_done')}>
          <a href={`/orders/${encodeURIComponent(place.data.orderId)}`} onClick={onLink}>
            {t('web.c360_manual_order_open')}
          </a>
        </Banner>
      ) : (
        <>
          <Banner tone="info">{t('web.c360_manual_order_hint')}</Banner>
          <StateSwitch query={products}>
            {products.data === undefined ? null : (
              <Field label={t('web.c360_manual_order_product')} htmlFor="c360-product">
                <Select
                  id="c360-product"
                  value={productId}
                  onChange={(event) => setProductId(event.target.value)}
                >
                  <option value="">{t('web.c360_manual_order_pick')}</option>
                  {products.data.products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.title}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </StateSwitch>
          {chosen !== undefined && chosen.priceAmount !== null && chosen.priceCurrency !== null && (
            <p className="muted small">
              {t('web.c360_manual_order_list_price')}{' '}
              {money(chosen.priceAmount, chosen.priceCurrency)}
            </p>
          )}
          <Field
            label={t('web.c360_manual_order_username')}
            hint={t('web.c360_manual_order_username_hint')}
            htmlFor="c360-username"
          >
            <Input
              id="c360-username"
              dir="ltr"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field label={t('web.c360_reason_label')} htmlFor="c360-order-reason">
            <Input
              id="c360-order-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          {place.error !== null && <Banner tone="danger">{c360Message(place.error)}</Banner>}
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Dangerous operations: configurations and the account transfer (§11.4, §11.5)
// ---------------------------------------------------------------------------

const BLOCKER_LABELS: Readonly<Record<CustomerTransferBlocker, WebKey>> = {
  SAME_CUSTOMER: 'web.c360_blocker_same',
  DESTINATION_UNKNOWN: 'web.c360_blocker_unknown',
  DESTINATION_BLOCKED: 'web.c360_blocker_blocked',
  SOURCE_IS_RESELLER: 'web.c360_blocker_reseller',
  SOURCE_BALANCE_NEGATIVE: 'web.c360_blocker_negative',
  ORDER_IN_PROGRESS: 'web.c360_blocker_order',
  PAYMENT_PENDING: 'web.c360_blocker_payment',
  SERVICE_UNSETTLED: 'web.c360_blocker_service',
  REWARD_PENDING: 'web.c360_blocker_reward',
  BULK_OPERATION_PENDING: 'web.c360_blocker_bulk',
  NOTHING_TO_MOVE: 'web.c360_blocker_nothing',
};

const WARNING_LABELS: Readonly<Record<CustomerTransferWarning, WebKey>> = {
  DESTINATION_IS_RESELLER: 'web.c360_warning_dest_reseller',
  TRIAL_SERVICES_STAY: 'web.c360_warning_trials',
  SOURCE_OVERRIDES_STAY: 'web.c360_warning_overrides',
  OPEN_TICKETS_STAY: 'web.c360_warning_tickets',
  REFERRAL_CREDITS_STAY: 'web.c360_warning_referral_credits',
  REFUNDS_CREDIT_SOURCE: 'web.c360_warning_refunds',
};

export function DangerZoneCard({
  customerId,
  mayTransfer,
  mayEditServices,
}: {
  customerId: string;
  mayTransfer: boolean;
  mayEditServices: boolean;
}) {
  const [toggle, setToggle] = useState<'SUSPEND' | 'RESUME' | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  if (!mayTransfer && !mayEditServices) return null;
  return (
    <Card
      tone="danger"
      title={t('web.c360_danger_title')}
      hint={t('web.c360_danger_hint')}
      id="c360-danger"
    >
      <div className="form-actions">
        {mayEditServices && (
          <>
            <Button size="sm" variant="danger" onClick={() => setToggle('SUSPEND')}>
              {t('web.c360_services_disable')}
            </Button>
            <Button size="sm" onClick={() => setToggle('RESUME')}>
              {t('web.c360_services_enable')}
            </Button>
          </>
        )}
        {mayTransfer && (
          <Button size="sm" variant="danger-solid" onClick={() => setTransferOpen(true)}>
            {t('web.c360_transfer')}
          </Button>
        )}
      </div>
      {toggle !== null && (
        <ServicesToggleModal
          customerId={customerId}
          action={toggle}
          onClose={() => setToggle(null)}
        />
      )}
      {transferOpen && (
        <TransferModal customerId={customerId} onClose={() => setTransferOpen(false)} />
      )}
    </Card>
  );
}

function ServicesToggleModal({
  customerId,
  action,
  onClose,
}: {
  customerId: string;
  action: 'SUSPEND' | 'RESUME';
  onClose: () => void;
}) {
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const run = useMutation({
    mutationFn: () => {
      const body = { action };
      return toggleCustomerServices(customerId, {
        ...body,
        idempotencyKey: submission.current(body),
      });
    },
    onSuccess: () => {
      submission.settle();
      void queries.invalidateQueries({ queryKey: ['customer-services', customerId] });
      void queries.invalidateQueries({ queryKey: ['customer-financial', customerId] });
      void queries.invalidateQueries({ queryKey: ['customer-timeline', customerId] });
    },
    onError: (error) => submission.settleOn(error),
  });
  const results = run.data?.results;
  return (
    <Modal
      open
      danger={action === 'SUSPEND'}
      onClose={() => {
        if (!run.isPending) onClose();
      }}
      title={action === 'SUSPEND' ? t('web.c360_services_disable') : t('web.c360_services_enable')}
      foot={
        results !== undefined ? (
          <Button size="sm" onClick={onClose}>
            {t('web.c360_close')}
          </Button>
        ) : (
          <>
            <Button
              variant={action === 'SUSPEND' ? 'danger-solid' : 'primary'}
              size="sm"
              disabled={run.isPending}
              onClick={() => run.mutate()}
            >
              {t('web.c360_confirm')}
            </Button>
            <Button size="sm" disabled={run.isPending} onClick={onClose}>
              {t('web.user_action_cancel')}
            </Button>
          </>
        )
      }
    >
      {results === undefined ? (
        <Banner tone="warn">
          {action === 'SUSPEND'
            ? t('web.c360_services_disable_body')
            : t('web.c360_services_enable_body')}
        </Banner>
      ) : results.length === 0 ? (
        <Empty variant="compact" title={t('web.c360_services_none')} />
      ) : (
        <KV
          items={results.map((result) => [
            <Ltr key={result.serviceId}>{result.providerUsername}</Ltr>,
            result.outcome === 'PLANNED' ? (
              <Badge tone="ok">{t('web.c360_services_planned')}</Badge>
            ) : (
              <Badge tone="warn">
                {t('web.c360_services_refused')} <Ltr>{result.code ?? ''}</Ltr>
              </Badge>
            ),
          ])}
        />
      )}
      {run.error !== null && <Banner tone="danger">{c360Message(run.error)}</Banner>}
    </Modal>
  );
}

function TransferModal({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [destination, setDestination] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<CustomerTransferPreviewResponse | null>(null);

  const ask = useMutation({
    mutationFn: () =>
      previewCustomerTransfer(customerId, { destinationTelegramUserId: destination.trim() }),
    onSuccess: (response) => setPreview(response.preview),
  });
  const run = useMutation({
    mutationFn: () => {
      if (preview === null || preview.destination === null) {
        throw new Error('No destination was previewed.');
      }
      const body = {
        destinationTelegramUserId: preview.destination.telegramUserId,
        fingerprint: preview.fingerprint,
        confirmTelegramUserId: confirmation.trim(),
        reason: reason.trim(),
      };
      return transferCustomer(customerId, { ...body, idempotencyKey: submission.current(body) });
    },
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.c360_transfer_done') });
      for (const key of [
        'customer-services',
        'wallet',
        'wallet-entries',
        'customer-financial',
        'customer-timeline',
      ]) {
        void queries.invalidateQueries({ queryKey: [key, customerId] });
      }
    },
    onError: (error) => submission.settleOn(error),
  });

  const ready =
    preview !== null &&
    preview.blockers.length === 0 &&
    preview.destination !== null &&
    confirmation.trim() !== '' &&
    reason.trim() !== '' &&
    !run.isPending;

  return (
    <Modal
      open
      danger
      size="lg"
      onClose={() => {
        if (!run.isPending) onClose();
      }}
      title={t('web.c360_transfer')}
      foot={
        run.isSuccess ? (
          <Button size="sm" onClick={onClose}>
            {t('web.c360_close')}
          </Button>
        ) : (
          <>
            <Button variant="danger-solid" size="sm" disabled={!ready} onClick={() => run.mutate()}>
              {t('web.c360_transfer_confirm')}
            </Button>
            <Button size="sm" disabled={run.isPending} onClick={onClose}>
              {t('web.user_action_cancel')}
            </Button>
          </>
        )
      }
    >
      {run.isSuccess ? (
        <Banner tone="ok" title={t('web.c360_transfer_done')}>
          {t('web.c360_transfer_moved_services')}: {String(run.data.transfer.servicesMoved)} —{' '}
          {t('web.c360_transfer_moved_wallet')}:{' '}
          {money(run.data.transfer.walletMovedAmount, run.data.transfer.currency)}
        </Banner>
      ) : (
        <>
          <Banner tone="warn">{t('web.c360_transfer_body')}</Banner>
          <div className="form-grid">
            <Field label={t('web.c360_transfer_destination')} htmlFor="c360-dest">
              <Input
                id="c360-dest"
                dir="ltr"
                inputMode="numeric"
                value={destination}
                onChange={(event) => {
                  setDestination(event.target.value);
                  setPreview(null);
                }}
              />
            </Field>
          </div>
          <div className="form-actions">
            <Button
              size="sm"
              disabled={destination.trim() === '' || ask.isPending}
              onClick={() => ask.mutate()}
            >
              {t('web.c360_transfer_preview')}
            </Button>
          </div>
          {ask.error !== null && <Banner tone="danger">{c360Message(ask.error)}</Banner>}
          {preview !== null && <TransferPreview preview={preview} />}
          {preview !== null && preview.blockers.length === 0 && (
            <>
              <Field
                label={t('web.c360_transfer_type_id')}
                hint={t('web.c360_transfer_type_id_hint')}
                htmlFor="c360-confirm-id"
              >
                <Input
                  id="c360-confirm-id"
                  dir="ltr"
                  inputMode="numeric"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </Field>
              <Field label={t('web.c360_reason_label')} htmlFor="c360-transfer-reason">
                <Input
                  id="c360-transfer-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
            </>
          )}
          {run.error !== null && <Banner tone="danger">{c360Message(run.error)}</Banner>}
        </>
      )}
    </Modal>
  );
}

function TransferPreview({ preview }: { preview: CustomerTransferPreviewResponse }) {
  const destination = preview.destination;
  return (
    <div className="stack">
      <KV
        items={[
          [
            t('web.c360_transfer_to'),
            destination === null ? (
              <Dash key="d" />
            ) : (
              <span key="d">
                <Copyable value={destination.telegramUserId} />{' '}
                {[destination.firstName, destination.lastName].filter((p) => p !== null).join(' ')}
              </span>
            ),
          ],
          [
            t('web.c360_transfer_moves_services'),
            <Num key="s" value={preview.moves.services.length} />,
          ],
          [
            t('web.c360_transfer_moves_wallet'),
            money(preview.moves.walletAmount, preview.moves.currency),
          ],
          [
            t('web.c360_transfer_stays_closed'),
            <Num key="c" value={preview.stays.closedServices} />,
          ],
          [
            t('web.c360_transfer_stays_trials'),
            <Num key="t" value={preview.stays.trialServices} />,
          ],
          [t('web.c360_transfer_stays_orders'), <Num key="o" value={preview.stays.orders} />],
          [t('web.c360_transfer_stays_payments'), <Num key="p" value={preview.stays.payments} />],
          [
            t('web.c360_transfer_stays_referrals'),
            <Num key="r" value={preview.stays.referredCustomers} />,
          ],
        ]}
      />
      {preview.moves.services.length > 0 && (
        <Disclosure summary={t('web.c360_transfer_services_list')} size="sm">
          <ul className="c360-list">
            {preview.moves.services.map((service) => (
              <li key={service.id}>
                <Ltr>{service.providerUsername}</Ltr>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {preview.blockers.length > 0 && (
        <Banner tone="danger" title={t('web.c360_transfer_blocked')}>
          <ul className="c360-list">
            {preview.blockers.map((blocker) => (
              <li key={blocker}>{t(BLOCKER_LABELS[blocker])}</li>
            ))}
          </ul>
        </Banner>
      )}
      {preview.warnings.length > 0 && (
        <Banner tone="warn">
          <ul className="c360-list">
            {preview.warnings.map((warning) => (
              <li key={warning}>{t(WARNING_LABELS[warning])}</li>
            ))}
          </ul>
        </Banner>
      )}
      <p className="muted small">{t('web.c360_transfer_history_stays')}</p>
    </div>
  );
}
