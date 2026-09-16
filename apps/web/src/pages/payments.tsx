import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PAYMENT_METHODS,
  PAYMENT_STATES,
  uuidV7Schema,
  type PaymentMethod,
  type PaymentState,
  type PaymentSummaryResponse,
} from '@nexa/contracts';
import { confirmPayment, fetchPayment, fetchPayments, rejectPayment } from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { mayRequest, queryState } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { setQueries, setQuery, useLinkHandler, type Route } from '../router';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Card,
  Copyable,
  CursorPager,
  DataTable,
  Empty,
  Field,
  KV,
  Ltr,
  Money,
  PageHead,
  Pills,
  StateSwitch,
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';

/**
 * Payments — the money, and where it came from.
 *
 * This page has exactly ONE write: confirming that an out-of-band transfer arrived.
 * There is no create, no fail, no cancel, no retry and no refund, and each absence is
 * deliberate rather than unfinished. A payment is created by a CUSTOMER choosing how to
 * pay; `payments.retry` is a frozen permission for a gateway that does not ship; and a
 * retry button with nothing behind it is the legacy silent-success pattern.
 *
 * **PAID means the money arrived and nothing else.** Nothing on this page says a
 * service was created, is being prepared or is on its way, because nothing in this
 * release does any of that. The banner at the bottom of the detail says so in words,
 * which is what `planned.tsx` argues for: an operator who confirms a payment and sees
 * no service needs to know that is the design rather than a failure.
 *
 * `UNKNOWN` is rendered as what it is — an ABSENCE of an outcome. `payment.ts` leaves
 * it non-terminal precisely so reconciliation is legal, and the banner tells an operator
 * that it is neither a success nor a failure until somebody establishes which.
 */

const STATE_LABELS: Readonly<Record<PaymentState, WebKey>> = {
  PENDING: 'web.payment_state_pending',
  CONFIRMED: 'web.payment_state_confirmed',
  FAILED: 'web.payment_state_failed',
  CANCELLED: 'web.payment_state_cancelled',
  EXPIRED: 'web.payment_state_expired',
  UNKNOWN: 'web.payment_state_unknown',
};

const STATE_TONES: Readonly<Record<PaymentState, Tone>> = {
  PENDING: 'warn',
  CONFIRMED: 'ok',
  FAILED: 'danger',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
  // Not danger and not ok: it is neither, and a tone that implied either would be
  // this page taking a position the system explicitly does not hold.
  UNKNOWN: 'warn',
};

const METHOD_LABELS: Readonly<Record<PaymentMethod, WebKey>> = {
  WALLET: 'web.payment_method_wallet',
  MANUAL_TRANSFER: 'web.payment_method_manual',
  GATEWAY: 'web.payment_method_gateway',
};

function StateBadge({ value }: { value: PaymentState }) {
  return <Badge tone={STATE_TONES[value]}>{t(STATE_LABELS[value])}</Badge>;
}

function Dash() {
  return <span className="faint">—</span>;
}

/** A full id, or the field's own error. The same guard `/orders` uses on its filters. */
function idProblem(value: string): string | undefined {
  if (value === '') return undefined;
  return uuidV7Schema.safeParse(value).success ? undefined : t('web.payments_filter_invalid_id');
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function PaymentsPage({ route, denied }: { route: Route; denied: boolean }) {
  const onLink = useLinkHandler();
  const cursor = route.query.get('cursor');
  const state = route.query.get('state');
  const method = route.query.get('method');
  const appliedCustomer = route.query.get('customerId') ?? '';
  const appliedOrder = route.query.get('orderId') ?? '';
  const appliedReference = route.query.get('reference') ?? '';

  /*
   * The drafts are keyed to the APPLIED values, so navigation that drops the query
   * clears the boxes. `users.tsx` records the defect this prevents: the sidebar link
   * re-renders this component with an empty query instead of remounting it, and a
   * `useState` initialiser runs once per mount — leaving criteria on screen that are no
   * longer applied.
   */
  const appliedSignature = `${appliedCustomer}|${appliedOrder}|${appliedReference}`;
  const [draft, setDraft] = useState({
    signature: appliedSignature,
    customerId: appliedCustomer,
    orderId: appliedOrder,
    reference: appliedReference,
  });
  if (draft.signature !== appliedSignature) {
    setDraft({
      signature: appliedSignature,
      customerId: appliedCustomer,
      orderId: appliedOrder,
      reference: appliedReference,
    });
  }

  const payments = useQuery({
    queryKey: ['payments', cursor, state, method, appliedCustomer, appliedOrder, appliedReference],
    queryFn: () =>
      fetchPayments({
        ...(cursor === null ? {} : { cursor }),
        ...(state === null ? {} : { state: state as PaymentState }),
        ...(method === null ? {} : { method: method as PaymentMethod }),
        ...(appliedCustomer === '' ? {} : { customerId: appliedCustomer }),
        ...(appliedOrder === '' ? {} : { orderId: appliedOrder }),
        ...(appliedReference === '' ? {} : { reference: appliedReference }),
      }),
    enabled: !denied,
  });

  const customerProblem = idProblem(draft.customerId);
  const orderProblem = idProblem(draft.orderId);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (customerProblem !== undefined || orderProblem !== undefined) return;
    // ONE navigation for all three. Separate `setQuery` calls each build from the
    // `route.query` this render captured, so the earlier ones are dropped.
    setQueries(route, [
      ['customerId', draft.customerId === '' ? null : draft.customerId],
      ['orderId', draft.orderId === '' ? null : draft.orderId],
      ['reference', draft.reference === '' ? null : draft.reference],
      // A new filter starts at the first page. Carrying a cursor from one filter to
      // another pages through a list that no longer exists.
      ['cursor', null],
    ]);
  };

  const columns: readonly Column<PaymentSummaryResponse>[] = [
    {
      key: 'reference',
      header: t('web.payment_reference'),
      render: (row) => (
        <a href={`/payments/${encodeURIComponent(row.id)}`} onClick={onLink} className="strong">
          <Ltr>{row.reference}</Ltr>
        </a>
      ),
    },
    {
      key: 'state',
      header: t('web.payment_state'),
      render: (row) => <StateBadge value={row.state} />,
    },
    {
      key: 'method',
      header: t('web.payment_method'),
      render: (row) => t(METHOD_LABELS[row.method]),
    },
    {
      key: 'amount',
      header: t('web.payment_amount'),
      render: (row) => <Money value={{ amountMinor: row.amount, currency: row.currency }} />,
    },
    {
      key: 'customer',
      header: t('web.payment_customer'),
      render: (row) => (
        <a href={`/users/${encodeURIComponent(row.customerId)}`} onClick={onLink}>
          <Ltr>{row.customerId.slice(0, 8)}</Ltr>
        </a>
      ),
    },
    {
      key: 'order',
      header: t('web.payment_order'),
      render: (row) =>
        row.orderId === null ? (
          <Dash />
        ) : (
          <a href={`/orders/${encodeURIComponent(row.orderId)}`} onClick={onLink}>
            <Ltr>{row.orderId.slice(0, 8)}</Ltr>
          </a>
        ),
    },
    {
      key: 'created',
      header: t('web.payment_created_at'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.createdAt)}</span>,
    },
  ];

  return (
    <>
      <PageHead title={t('web.payments_title')} subtitle={t('web.payments_intro')} maturity="now" />

      <Card>
        <div hidden={!mayRequest(payments, denied)}>
          <Pills
            value={state ?? 'ALL'}
            onChange={(next) =>
              setQueries(route, [
                ['state', next === 'ALL' ? null : next],
                ['cursor', null],
              ])
            }
            items={[
              { id: 'ALL', label: t('web.payments_filter_all') },
              // Over the FROZEN vocabulary, so a state added to the contract without a
              // filter here is a compile error rather than an option nobody notices is
              // missing. The same shape `/orders` uses.
              ...PAYMENT_STATES.map((one) => ({ id: one, label: t(STATE_LABELS[one]) })),
            ]}
          />
          <Pills
            value={method ?? 'ALL'}
            onChange={(next) =>
              setQueries(route, [
                ['method', next === 'ALL' ? null : next],
                ['cursor', null],
              ])
            }
            items={[
              { id: 'ALL', label: t('web.payments_filter_all') },
              ...PAYMENT_METHODS.map((one) => ({ id: one, label: t(METHOD_LABELS[one]) })),
            ]}
          />
          {/*
            Why a third method never appears in the filter above.
            `SELF_CONTAINED_PAYMENT_METHODS` is the pair this installation can
            actually perform, and a gateway has no adapter. Said out loud rather
            than left for an operator to wonder about — the same reason the
            catalogue names WHICH predicate a product fails.
          */}
          <p className="muted small">{t('web.planned_missing_gateway')}</p>
          <form className="toolbar" onSubmit={apply}>
            <Field
              label={t('web.payment_customer')}
              hint={t('web.payments_filter_customer_hint')}
              htmlFor="payments-customer"
              {...(customerProblem === undefined ? {} : { error: customerProblem })}
            >
              <input
                id="payments-customer"
                dir="ltr"
                value={draft.customerId}
                onChange={(event) => setDraft({ ...draft, customerId: event.target.value.trim() })}
              />
            </Field>
            <Field
              label={t('web.payment_order')}
              hint={t('web.payments_filter_order_hint')}
              htmlFor="payments-order"
              {...(orderProblem === undefined ? {} : { error: orderProblem })}
            >
              <input
                id="payments-order"
                dir="ltr"
                value={draft.orderId}
                onChange={(event) => setDraft({ ...draft, orderId: event.target.value.trim() })}
              />
            </Field>
            <Field
              label={t('web.payment_reference')}
              hint={t('web.payments_filter_reference_hint')}
              htmlFor="payments-reference"
            >
              <input
                id="payments-reference"
                dir="ltr"
                value={draft.reference}
                onChange={(event) => setDraft({ ...draft, reference: event.target.value.trim() })}
              />
            </Field>
            <button type="submit" className="btn sm">
              {t('web.payments_search_apply')}
            </button>
          </form>
        </div>

        <StateSwitch query={payments} denied={denied}>
          {payments.data === undefined ? null : payments.data.payments.length === 0 ? (
            <Empty title={t('web.payments_empty')} />
          ) : (
            <>
              <DataTable
                caption={t('web.payments_title')}
                columns={columns}
                rows={payments.data.payments}
                rowKey={(row) => row.id}
              />
              <CursorPager
                shown={payments.data.payments.length}
                hasPrevious={cursor !== null}
                hasNext={payments.data.nextCursor !== null}
                onPrevious={() => setQuery(route, 'cursor', null)}
                onNext={() => setQuery(route, 'cursor', payments.data?.nextCursor ?? null)}
              />
            </>
          )}
        </StateSwitch>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export function PaymentDetailPage({
  id,
  mayReview,
  denied,
}: {
  id: string;
  mayReview: boolean;
  denied: boolean;
}) {
  const onLink = useLinkHandler();
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  /*
   * A SECOND submission key, not a shared one.
   *
   * The two decisions are different commands with different payloads, and one key
   * would make a rejection typed after an approval failed look to the idempotency
   * store like a replay of that approval with a mismatched payload.
   */
  const rejection = useSubmissionKey();
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');

  const payment = useQuery({
    queryKey: ['payment', id],
    queryFn: () => fetchPayment(id),
    enabled: !denied,
  });
  const row = payment.data?.payment;

  const confirm = useMutation({
    mutationFn: () =>
      confirmPayment({
        id,
        // Bound to the note, so editing it and pressing again is a new command
        // rather than a replay the store refuses as a payload mismatch.
        idempotencyKey: submission.current({ id, note }),
        evidenceNote: note.trim(),
      }),
    onSuccess: (response) => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.payment_confirm_done') });
      setNote('');
      queries.setQueryData(['payment', id], response);
      void queries.invalidateQueries({ queryKey: ['payments'] });
      // The ORDER changed too: a confirmation settles it in the same transaction.
      void queries.invalidateQueries({ queryKey: ['orders'] });
      void queries.invalidateQueries({ queryKey: ['order'] });
    },
    // A 5xx may have committed, and a fresh key on the retry would be a second
    // confirmation of somebody's money.
    onError: (error) => submission.settleOn(error),
  });

  const reject = useMutation({
    mutationFn: () =>
      rejectPayment({
        id,
        idempotencyKey: rejection.current({ id, reason }),
        resolutionNote: reason.trim(),
      }),
    onSuccess: (response) => {
      rejection.settle();
      notify({ tone: 'ok', message: t('web.payment_reject_done') });
      setReason('');
      queries.setQueryData(['payment', id], response);
      void queries.invalidateQueries({ queryKey: ['payments'] });
      /*
       * The payments list only. The ORDER is deliberately NOT invalidated, because a
       * rejection does not touch it: it stays awaiting payment until its own deadline
       * so the customer can pay another way. Invalidating it would be this page
       * implying a change that did not happen.
       */
    },
    onError: (error) => rejection.settleOn(error),
  });

  return (
    <>
      <PageHead
        title={t('web.payment_detail')}
        {...(row === undefined ? {} : { subtitle: row.reference })}
        maturity="now"
      />

      <StateSwitch query={payment} denied={denied}>
        {row === undefined ? null : (
          <>
            {row.state === 'UNKNOWN' && (
              <Banner tone="warn">{t('web.payment_unknown_banner')}</Banner>
            )}

            <Card title={t('web.payment_detail')}>
              <KV
                items={[
                  [t('web.payment_state'), <StateBadge key="s" value={row.state} />],
                  [t('web.payment_method'), t(METHOD_LABELS[row.method])],
                  [
                    t('web.payment_amount'),
                    <Money key="a" value={{ amountMinor: row.amount, currency: row.currency }} />,
                  ],
                  [t('web.payment_reference'), <Copyable key="r" value={row.reference} />],
                  [
                    t('web.payment_customer'),
                    <a
                      key="c"
                      href={`/users/${encodeURIComponent(row.customerId)}`}
                      onClick={onLink}
                    >
                      <Ltr>{row.customerId}</Ltr>
                    </a>,
                  ],
                  [
                    t('web.payment_order'),
                    row.orderId === null ? (
                      <Dash key="o" />
                    ) : (
                      <a
                        key="o"
                        href={`/orders/${encodeURIComponent(row.orderId)}`}
                        onClick={onLink}
                      >
                        <Ltr>{row.orderId}</Ltr>
                      </a>
                    ),
                  ],
                  [t('web.payment_created_at'), formatTimestamp(row.createdAt)],
                  [
                    t('web.payment_expires_at'),
                    row.expiresAt === null ? <Dash key="e" /> : formatTimestamp(row.expiresAt),
                  ],
                ]}
              />
            </Card>

            {/*
              What a confirmation RESTS on, and who made it.
              `UNK-PR-010` records the legacy receipt review as storing neither the
              reviewer nor the time, which is why "was this approved by a human" is
              unanswerable there. Both are columns here, and both are shown.
            */}
            <Card title={t('web.payment_evidence_kind')}>
              <KV
                items={[
                  [
                    t('web.payment_evidence_kind'),
                    row.evidenceKind === null ? <Dash key="k" /> : row.evidenceKind,
                  ],
                  [
                    t('web.payment_evidence_note'),
                    row.evidenceNote === null ? <Dash key="n" /> : row.evidenceNote,
                  ],
                  [
                    t('web.payment_reviewer'),
                    row.confirmedByAdminId === null ? (
                      <Dash key="w" />
                    ) : (
                      <Copyable key="w" value={row.confirmedByAdminId} />
                    ),
                  ],
                  [
                    t('web.payment_confirmed_at'),
                    row.confirmedAt === null ? <Dash key="t" /> : formatTimestamp(row.confirmedAt),
                  ],
                ]}
              />
            </Card>

            {/*
              How it ended WITHOUT money, when it did.
              Its own card rather than three more rows in the evidence one, because
              the two are mutually exclusive by constraint — `payments_confirmed_check`
              and `payments_resolved_check` are both equalities — and a screen showing
              both sets side by side invites reading a rejection as an approval.
            */}
            {row.resolvedAt !== null && (
              <Card title={t('web.payment_resolution')}>
                <KV
                  items={[
                    [t('web.payment_resolved_at'), formatTimestamp(row.resolvedAt)],
                    [
                      t('web.payment_resolver'),
                      row.resolvedByAdminId === null ? (
                        // Null is the ANSWER, not a missing value: nobody decided an
                        // expiry and a withdrawal is the customer's own.
                        <Dash key="rw" />
                      ) : (
                        <Copyable key="rw" value={row.resolvedByAdminId} />
                      ),
                    ],
                    [
                      t('web.payment_resolution_note'),
                      row.resolutionNote === null ? <Dash key="rn" /> : row.resolutionNote,
                    ],
                  ]}
                />
              </Card>
            )}

            {/*
              The ONE write, and only where it can legally apply: a PENDING
              MANUAL_TRANSFER. A wallet payment is confirmed by its own debit in the
              same transaction and has nothing for an operator to approve; every other
              state has no `CONFIRM` edge in `PAYMENT_MACHINE`.
            */}
            {row.state === 'PENDING' && row.method === 'MANUAL_TRANSFER' && (
              <Card title={t('web.payment_confirm_title')}>
                <p className="muted">{t('web.payment_confirm_hint')}</p>
                {mayReview ? (
                  <>
                    <Field label={t('web.payment_confirm_note')} htmlFor="payment-note">
                      <input
                        id="payment-note"
                        value={note}
                        maxLength={500}
                        onChange={(event) => setNote(event.target.value)}
                      />
                    </Field>
                    <div className="toolbar">
                      <button
                        type="button"
                        className="btn primary sm"
                        disabled={confirm.isPending || note.trim() === ''}
                        onClick={() => confirm.mutate()}
                      >
                        {t('web.payment_confirm')}
                      </button>
                    </div>
                    {confirm.error !== null && (
                      <Banner tone="danger">{messageFor(confirm.error)}</Banner>
                    )}
                  </>
                ) : (
                  // No disabled button. A disabled control and this sentence make the
                  // same claim, and only one of them names the permission.
                  <Banner tone="info">{t('web.payment_confirm_denied')}</Banner>
                )}
              </Card>
            )}

            {/*
              The other half of the same decision, in its own card.
              `receipts.review` has read "Approve or reject a receipt" since the
              permission catalogue was frozen and only the approve half existed until
              4G. Same permission, same states — a PENDING MANUAL_TRANSFER — and a
              REASON rather than an evidence note, because the two answer different
              questions and `payments.resolution_note` is a different column.

              Separate from the confirm card on purpose: one card with two buttons is a
              card where the wrong one is a mis-click away, and this one is not
              reversible. `PAYMENT_MACHINE` has no edge out of FAILED.
            */}
            {row.state === 'PENDING' && row.method === 'MANUAL_TRANSFER' && mayReview && (
              <Card title={t('web.payment_reject_title')}>
                <p className="muted">{t('web.payment_reject_hint')}</p>
                <Field label={t('web.payment_reject_note')} htmlFor="payment-reason">
                  <input
                    id="payment-reason"
                    value={reason}
                    maxLength={500}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </Field>
                <div className="toolbar">
                  <button
                    type="button"
                    className="btn danger sm"
                    disabled={reject.isPending || reason.trim() === ''}
                    onClick={() => reject.mutate()}
                  >
                    {t('web.payment_reject')}
                  </button>
                </div>
                {reject.error !== null && <Banner tone="danger">{messageFor(reject.error)}</Banner>}
              </Card>
            )}

            <Card>
              <p className="muted">{t('web.payment_not_settled_here')}</p>
            </Card>
          </>
        )}
      </StateSwitch>
    </>
  );
}

/** Re-exported so the shell can read a query's state without importing the page's guts. */
export { queryState };
