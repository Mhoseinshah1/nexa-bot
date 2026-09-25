import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COMMERCE_ERROR_CODES,
  PAYMENT_METHODS,
  PAYMENT_STATES,
  RECEIPT_DISPOSITIONS,
  uuidV7Schema,
  type RefundChannel,
  type RefundResponse,
  type RefundState,
  type RefundView,
  type PaymentMethod,
  type PaymentReceiptView,
  type PaymentState,
  type PaymentSummaryResponse,
  type ReceiptDisposition,
} from '@nexa/contracts';
import {
  ApiError,
  completeRefund,
  failRefund,
  fetchOrder,
  fetchPayment,
  fetchPaymentReceipts,
  fetchPaymentReceiptBytes,
  fetchPayments,
  fetchRefunds,
  requestRefund,
} from '../api/client';
import { formatMoneyText, formatTimestamp, splitBytes } from '../format';
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
 * The one write here is a REFUND. Card-to-card review — approve, reject, or credit to the
 * wallet — is performed in Telegram only (Payment File 02 §10, D3), and this page shows
 * what it decided and never offers to decide it. There is no create, no fail, no cancel
 * and no retry, and each absence is deliberate rather than unfinished. A payment is
 * created by a CUSTOMER choosing how to pay; `payments.retry` is a frozen permission for
 * a gateway that does not ship; and a retry button with nothing behind it is the legacy
 * silent-success pattern.
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

const REFUND_STATE_LABELS: Readonly<Record<RefundState, WebKey>> = {
  REQUESTED: 'web.refund_state_requested',
  AWAITING_EXTERNAL: 'web.refund_state_awaiting',
  COMPLETED: 'web.refund_state_completed',
  FAILED: 'web.refund_state_failed',
};

/*
 * `AWAITING_EXTERNAL` is `warn` and `FAILED` is neutral, which is the opposite of the
 * payment table's instinct and is correct here. A refund awaiting an external transfer
 * is money somebody still owes and a thing an operator must act on; a FAILED refund is
 * a decision that was cleanly abandoned and released its amount, which is not an
 * error — it is the honest alternative to deleting the row.
 */
const REFUND_STATE_TONES: Readonly<Record<RefundState, Tone>> = {
  REQUESTED: 'warn',
  AWAITING_EXTERNAL: 'warn',
  COMPLETED: 'ok',
  FAILED: 'neutral',
};

const REFUND_CHANNEL_LABELS: Readonly<Record<RefundChannel, WebKey>> = {
  WALLET_CREDIT: 'web.refund_channel_wallet',
  EXTERNAL_MANUAL: 'web.refund_channel_manual',
  PROVIDER: 'web.refund_channel_provider',
};

/**
 * A refund refusal, naming P3's delivery reason when — and only when — the SERVER named
 * it. `REFUND_NOT_PERMITTED` carries its reason as a detail; any other reason keeps the
 * server's own message, which names what to change.
 */
function refundMessageFor(error: unknown): string {
  if (
    error instanceof ApiError &&
    error.code === COMMERCE_ERROR_CODES.REFUND_NOT_PERMITTED &&
    error.details?.['reason'] === 'DELIVERY_IN_PROGRESS'
  ) {
    return t('web.refund_delivery_in_progress');
  }
  return messageFor(error);
}

/**
 * Digits only, as a decimal STRING of minor units.
 *
 * Never parsed to a number: JSON has no bigint and a `number` is the float the money
 * model refuses, silently, above 2^53. Anything that is not digits collapses to `'0'`,
 * which the button below reads as "nothing to submit" — the server's own schema is what
 * refuses a malformed amount, and this only stops the form offering to send one.
 */
function digitsOf(value: string): string {
  const trimmed = value.trim();
  return /^[0-9]{1,19}$/u.test(trimmed) ? trimmed.replace(/^0+(?=[0-9])/u, '') : '0';
}

function StateBadge({ value }: { value: PaymentState }) {
  return <Badge tone={STATE_TONES[value]}>{t(STATE_LABELS[value])}</Badge>;
}

/**
 * How a card-to-card receipt left review (WP10 follow-up §5), derived by the server.
 *
 * The point is the credited one: a receipt credited to the wallet is FAILED by state, and a
 * state badge alone reads exactly like a rejection. `ok` for the credit because money DID
 * reach the customer; the state badge beside it still says the order was not paid by it.
 */
const DISPOSITION_LABELS: Readonly<Record<ReceiptDisposition, WebKey>> = {
  APPROVED: 'web.payment_disposition_approved',
  REJECTED: 'web.payment_disposition_rejected',
  CREDITED_TO_WALLET: 'web.payment_disposition_credited',
};

const DISPOSITION_TONES: Readonly<Record<ReceiptDisposition, Tone>> = {
  APPROVED: 'ok',
  REJECTED: 'danger',
  CREDITED_TO_WALLET: 'ok',
};

function DispositionBadge({ value }: { value: ReceiptDisposition | null }) {
  if (value === null) return <Dash />;
  return <Badge tone={DISPOSITION_TONES[value]}>{t(DISPOSITION_LABELS[value])}</Badge>;
}

function Dash() {
  return <span className="faint">—</span>;
}

/**
 * Who paid, as Telegram knows them: the numeric id, and the username when they have one
 * (Payment File 02 §21). The id is the identity; a username is chosen by the person it
 * names, so it is shown beside the id and never instead of it.
 */
export function TelegramIdentity({
  telegramUserId,
  username,
}: {
  telegramUserId: string | null;
  username: string | null;
}) {
  if (telegramUserId === null) return <Dash />;
  return (
    <span className="nowrap">
      <Ltr>{telegramUserId}</Ltr>
      {username !== null && (
        <>
          {' '}
          <span className="muted small">
            <Ltr>{`@${username}`}</Ltr>
          </span>
        </>
      )}
    </span>
  );
}

/** The route a payment was offered through, by name, or a dash for a wallet settlement. */
function GatewayName({ provider }: { provider: string | null }) {
  if (provider === null) return <Dash />;
  if (provider === 'MANUAL_TRANSFER')
    return <>{t('web.payment_gateway_provider_manual_transfer')}</>;
  if (provider === 'TONPAYS') return <>{t('web.payment_gateway_provider_tonpays')}</>;
  return <Ltr>{provider}</Ltr>;
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
  const disposition = route.query.get('disposition');
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
    queryKey: [
      'payments',
      cursor,
      state,
      method,
      disposition,
      appliedCustomer,
      appliedOrder,
      appliedReference,
    ],
    queryFn: () =>
      fetchPayments({
        ...(cursor === null ? {} : { cursor }),
        ...(state === null ? {} : { state: state as PaymentState }),
        ...(method === null ? {} : { method: method as PaymentMethod }),
        ...(disposition === null ? {} : { disposition: disposition as ReceiptDisposition }),
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
      /*
       * The payment's own id (§21), shortened on the list and copyable whole, because it
       * is what the audit log, the ledger and a support conversation name.
       */
      key: 'id',
      header: t('web.payment_id'),
      render: (row) => <Copyable value={row.id} display={row.id.slice(0, 8)} />,
    },
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
      /*
       * How the receipt left review, beside the state rather than instead of it: the state
       * is the payment's, this is the receipt's. A credited receipt reads "credited to
       * wallet" here, never a bare FAILED (WP10 follow-up §5).
       */
      key: 'disposition',
      header: t('web.payment_disposition'),
      render: (row) => <DispositionBadge value={row.receiptDisposition} />,
    },
    {
      key: 'method',
      header: t('web.payment_method'),
      render: (row) => t(METHOD_LABELS[row.method]),
    },
    {
      key: 'gateway',
      header: t('web.payment_gateway'),
      render: (row) => <GatewayName provider={row.gatewayProvider} />,
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
      key: 'telegram',
      header: t('web.payment_telegram'),
      render: (row) => (
        <TelegramIdentity
          telegramUserId={row.customerTelegramUserId}
          username={row.customerUsername}
        />
      ),
    },
    {
      key: 'order',
      header: t('web.payment_order'),
      /*
       * No order means a WALLET TOP-UP, and saying so is the point: a dash here read as
       * missing data, and a payment whose purpose an operator cannot see is one they
       * cannot review. 5B is the phase that made these exist — nothing before it could
       * create a payment without an order.
       */
      render: (row) =>
        row.orderId === null ? (
          <span className="muted small">{t('web.payment_topup')}</span>
        ) : (
          <a href={`/orders/${encodeURIComponent(row.orderId)}`} onClick={onLink}>
            <Ltr>{row.orderId.slice(0, 8)}</Ltr>
          </a>
        ),
    },
    {
      /*
       * The customer's own claim, on the LIST.
       *
       * This is the column the field exists for: without it every PENDING manual
       * transfer looks alike, and an operator has no way to tell the one whose
       * customer says the money is sent from the one nobody has touched. It is not a
       * state and it is not evidence — both rows are still PENDING, and confirming
       * either still needs somebody to look at a bank statement.
       */
      key: 'signalled',
      header: t('web.payment_customer_signalled'),
      render: (row) =>
        row.customerSignalledAt === null ? (
          <Dash />
        ) : (
          <span className="nowrap">{formatTimestamp(row.customerSignalledAt)}</span>
        ),
    },
    {
      key: 'external',
      header: t('web.payment_external_reference'),
      render: (row) =>
        row.externalReference === null ? <Dash /> : <Ltr>{row.externalReference}</Ltr>,
    },
    {
      key: 'created',
      header: t('web.payment_created_at'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.createdAt)}</span>,
    },
    {
      key: 'updated',
      header: t('web.payment_updated_at'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.updatedAt)}</span>,
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
          <Pills
            value={disposition ?? 'ALL'}
            onChange={(next) =>
              setQueries(route, [
                ['disposition', next === 'ALL' ? null : next],
                ['cursor', null],
              ])
            }
            items={[
              { id: 'ALL', label: t('web.payments_filter_all') },
              ...RECEIPT_DISPOSITIONS.map((one) => ({
                id: one,
                label: t(DISPOSITION_LABELS[one]),
              })),
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

/**
 * What the customer SENT, and a way to look at it.
 *
 * A receipt is a claim with a file attached. Nothing here confirms a payment — the
 * confirm form below is the only thing that does, and it charges `receipts.review`
 * while this card charges `receipts.view`.
 *
 * The bytes are read through the API rather than from Telegram: the bot token stays in
 * the API process, and the file id a receipt stores is useless without it. The API
 * serves them as `application/octet-stream` with `nosniff` and `attachment`, so the
 * type shown here is decided from what the RECORD says it is and never from the
 * response — a customer's «receipt» that is really an SVG cannot become a script on
 * this origin.
 */
function ReceiptsCard({ paymentId }: { paymentId: string }) {
  const receipts = useQuery({
    queryKey: ['payment-receipts', paymentId],
    queryFn: () => fetchPaymentReceipts(paymentId),
  });
  const rows = receipts.data?.receipts ?? [];

  return (
    <Card title={t('web.payment_receipts')}>
      <StateSwitch
        query={receipts}
        isEmpty={rows.length === 0}
        empty={<Empty title={t('web.payment_receipts_empty')} />}
      >
        <p className="muted small">{t('web.payment_receipts_note')}</p>
        <div className="receipt-list">
          {rows.map((receipt) => (
            <ReceiptRow key={receipt.id} paymentId={paymentId} receipt={receipt} />
          ))}
        </div>
      </StateSwitch>
    </Card>
  );
}

/** One receipt: what it is, when it arrived, and the control that fetches its bytes. */
function ReceiptRow({ paymentId, receipt }: { paymentId: string; receipt: PaymentReceiptView }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  /*
   * An object URL is a document-lifetime handle, so it is revoked when this row goes
   * away or replaces it. Without this, every open leaks the file until the tab closes.
   */
  useEffect(
    () => () => {
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    },
    [objectUrl],
  );

  /*
   * From the RECORD, never from the response, and for a PHOTO from `kind` ALONE.
   *
   * A photo carries no mime type: Telegram re-encodes it and declares none, so
   * `receiptFileOf` stores null rather than fabricating one. Requiring `image/` here
   * therefore made every real photo a download, and the fixture claiming `image/jpeg`
   * was the only thing that said otherwise.
   *
   * Safe without one because the ELEMENT decides: an `<img>` decodes an image or shows
   * nothing, and a script inside an SVG does not run when the SVG is an `<img>` source.
   * A DOCUMENT is a download whatever it claims to be.
   */
  const renderable = receipt.kind === 'PHOTO';
  /*
   * The Blob carries the record's type when the record has one and NOTHING otherwise —
   * never a type this code invented. An untyped blob in an `<img>` is sniffed by the
   * browser, which is the one place sniffing an image is what should happen.
   */
  const photoType =
    receipt.mimeType !== null && receipt.mimeType.startsWith('image/') ? receipt.mimeType : '';

  const load = useMutation({
    mutationFn: () => fetchPaymentReceiptBytes(paymentId, receipt.id),
    onSuccess: (blob) => {
      setFailed(false);
      setObjectUrl(
        URL.createObjectURL(
          new Blob([blob], {
            type: renderable ? photoType : 'application/octet-stream',
          }),
        ),
      );
    },
    onError: () => setFailed(true),
  });

  const size = receipt.fileSize === null ? null : splitBytes(BigInt(receipt.fileSize));

  return (
    <div className="receipt">
      <KV
        items={[
          [
            t('web.payment_receipt_kind'),
            t(
              receipt.kind === 'PHOTO'
                ? 'web.payment_receipt_kind_photo'
                : 'web.payment_receipt_kind_document',
            ),
          ],
          [
            t('web.payment_receipt_file'),
            receipt.fileName === null ? <Dash key="f" /> : receipt.fileName,
          ],
          [
            t('web.payment_receipt_size'),
            size === null ? <Dash key="s" /> : `${size.value} ${t(size.unit)}`,
          ],
          [t('web.payment_receipt_sent_at'), formatTimestamp(receipt.createdAt)],
        ]}
      />
      <div className="btn-group">
        <button
          type="button"
          className="btn"
          disabled={load.isPending}
          onClick={() => load.mutate()}
        >
          {t(renderable ? 'web.payment_receipt_view' : 'web.payment_receipt_download')}
        </button>
      </div>
      {failed && (
        <Banner tone="warn" title={t('web.payment_receipt_failed')}>
          {t('web.payment_receipt_failed_hint')}
        </Banner>
      )}
      {objectUrl !== null &&
        (renderable ? (
          <img className="receipt-image" src={objectUrl} alt={t('web.payment_receipt_alt')} />
        ) : (
          <div className="btn-group">
            {/* The file the operator asked for, named as the customer sent it. */}
            <a className="btn" href={objectUrl} download={receipt.fileName ?? receipt.id}>
              {t('web.payment_receipt_save')}
            </a>
          </div>
        ))}
    </div>
  );
}

/**
 * Money going back, and how much of this payment is left to give back.
 *
 * `refundableMinor` is the SERVER's figure, rendered rather than recomputed. This tab
 * holds the rows it was handed and could subtract them, and the number it produced
 * would be a second opinion about money — the one an operator acts on if the two ever
 * disagreed. The server derives it inside a transaction under a lock on the payment,
 * which is also why a stale form here is refused rather than honoured.
 *
 * Two permissions, and they are not the same decision: `refunds.view` reads the history,
 * `refunds.issue` moves money. A reader who may see a refund does not get to make one.
 *
 * A wallet-funded refund arrives COMPLETED, because the ledger IS the wallet and its
 * credit committed in the same transaction. A manual transfer arrives
 * AWAITING_EXTERNAL and STAYS there until an operator says the money left — this
 * installation has no bank API, and a screen that reported otherwise would be the
 * silent success the whole lifecycle exists to refuse.
 */
function RefundsCard({
  paymentId,
  orderId,
  mayIssue,
  mayViewOrders,
}: {
  paymentId: string;
  /** The order this payment settled, or null for a top-up. */
  orderId: string | null;
  mayIssue: boolean;
  /** `orders.view`: whether the order's own state may be read to say it is REFUNDED. */
  mayViewOrders: boolean;
}) {
  const onLink = useLinkHandler();
  const notify = useToast();
  const queries = useQueryClient();
  const request = useSubmissionKey();
  const completion = useSubmissionKey();
  const abandonment = useSubmissionKey();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  /** Which AWAITING_EXTERNAL refund the operator is answering, and with what. */
  const [answering, setAnswering] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [externalReference, setExternalReference] = useState('');

  const refunds = useQuery({
    queryKey: ['refunds', paymentId],
    queryFn: () => fetchRefunds(paymentId),
  });
  const data = refunds.data;
  const rows = data?.refunds ?? [];

  /*
   * The ORDER, read rather than inferred (WP10 P3).
   *
   * A refund whose completed total reaches the payment moves the order PAID -> REFUNDED in
   * the same transaction. Whether that happened is the order's own state, and this reads
   * it — summing the rows above to decide it would be this tab's second opinion about
   * money, and it would be wrong for an order the automatic lane refunded. Without
   * `orders.view` nothing is said about the order at all.
   */
  const order = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => fetchOrder(orderId ?? ''),
    enabled: mayViewOrders && orderId !== null,
  });
  const orderRefunded = order.data?.order.state === 'REFUNDED';

  const refresh = (response: RefundResponse) => {
    void response;
    void queries.invalidateQueries({ queryKey: ['refunds', paymentId] });
    /*
     * The WALLET too, and not only on the wallet channel.
     *
     * A wallet refund appends a ledger entry in the same transaction, so a balance
     * rendered from a cached query would be behind by exactly the amount just returned.
     * Invalidating unconditionally is cheaper than deciding per channel and cannot be
     * wrong in the direction that matters.
     */
    void queries.invalidateQueries({ queryKey: ['wallet'] });
    /*
     * And the ORDER: the refund that completes the payment moves it to REFUNDED in the
     * same transaction (WP10 P3), so a cached order would still say PAID.
     */
    void queries.invalidateQueries({ queryKey: ['order'] });
    void queries.invalidateQueries({ queryKey: ['orders'] });
  };

  const issue = useMutation({
    mutationFn: () =>
      requestRefund({
        paymentId,
        // Bound to the amount AND the reason, so an edited figure is a new command
        // rather than a replay the store refuses as a payload mismatch.
        idempotencyKey: request.current({ paymentId, amount, reason }),
        amountMinor: digitsOf(amount),
        reason: reason.trim(),
      }),
    onSuccess: (response) => {
      request.settle();
      notify({ tone: 'ok', message: t('web.refund_requested') });
      setAmount('');
      setReason('');
      refresh(response);
    },
    /*
     * A 5xx may have committed. A fresh key on the retry would be a SECOND refund of
     * somebody's money — the one failure mode on this card that cannot be undone.
     */
    onError: (error) => {
      request.settleOn(error);
      /*
       * A refusal means the figures on this card were stale — the delivery started, or
       * another operator refunded — so they are re-read, and `refundable` becomes the
       * server's answer again rather than the one the form was drawn from.
       */
      if (error instanceof ApiError) {
        void queries.invalidateQueries({ queryKey: ['refunds', paymentId] });
      }
    },
  });

  const complete = useMutation({
    mutationFn: () => {
      if (answering === null) throw new Error('no refund is being answered');
      return completeRefund({
        refundId: answering,
        idempotencyKey: completion.current({ answering, note, externalReference }),
        note: note.trim(),
        externalReference: externalReference.trim() === '' ? null : externalReference.trim(),
      });
    },
    onSuccess: (response) => {
      completion.settle();
      notify({ tone: 'ok', message: t('web.refund_completed') });
      setAnswering(null);
      setNote('');
      setExternalReference('');
      refresh(response);
    },
    onError: (error) => completion.settleOn(error),
  });

  const abandon = useMutation({
    mutationFn: () => {
      if (answering === null) throw new Error('no refund is being answered');
      return failRefund({
        refundId: answering,
        idempotencyKey: abandonment.current({ answering, note }),
        note: note.trim(),
      });
    },
    onSuccess: (response) => {
      abandonment.settle();
      notify({ tone: 'ok', message: t('web.refund_failed_done') });
      setAnswering(null);
      setNote('');
      setExternalReference('');
      refresh(response);
    },
    onError: (error) => abandonment.settleOn(error),
  });

  const currency = data?.currency ?? 'IRT';
  const remaining = data === undefined ? 0n : BigInt(data.refundableMinor);
  const columns: readonly Column<RefundView>[] = [
    {
      key: 'amount',
      header: t('web.refund_amount'),
      render: (row) => <Money value={{ amountMinor: row.amountMinor, currency: row.currency }} />,
    },
    {
      key: 'state',
      header: t('web.refund_state'),
      render: (row) => (
        <Badge tone={REFUND_STATE_TONES[row.state]}>{t(REFUND_STATE_LABELS[row.state])}</Badge>
      ),
    },
    {
      key: 'channel',
      header: t('web.refund_channel'),
      render: (row) => t(REFUND_CHANNEL_LABELS[row.channel]),
    },
    { key: 'reason', header: t('web.refund_reason'), render: (row) => row.reason },
    {
      key: 'requested',
      header: t('web.refund_requested_by'),
      render: (row) =>
        row.requestedByAdminId === null ? <Dash /> : <Copyable value={row.requestedByAdminId} />,
    },
    {
      key: 'completed',
      header: t('web.refund_completed_by'),
      render: (row) =>
        // A SENTENCE for the one state where the absence is the point: nobody has said
        // the money left yet, which is a different fact from a missing value.
        row.state === 'AWAITING_EXTERNAL' ? (
          <span className="muted small">{t('web.refund_awaiting_hint')}</span>
        ) : row.completedByAdminId === null ? (
          <Dash />
        ) : (
          <Copyable value={row.completedByAdminId} />
        ),
    },
    {
      key: 'createdAt',
      header: t('web.refund_created_at'),
      render: (row) => formatTimestamp(row.createdAt),
    },
    {
      key: 'completedAt',
      header: t('web.refund_completed_at'),
      render: (row) => (row.completedAt === null ? <Dash /> : formatTimestamp(row.completedAt)),
    },
    {
      key: 'externalReference',
      header: t('web.refund_external_reference'),
      render: (row) =>
        row.externalReference === null ? <Dash /> : <Ltr>{row.externalReference}</Ltr>,
    },
  ];

  const awaiting = rows.filter((row) => row.state === 'AWAITING_EXTERNAL');

  return (
    <Card title={t('web.refunds')}>
      <StateSwitch query={refunds}>
        {data === undefined ? null : (
          <>
            <KV
              items={[
                [
                  t('web.refund_paid'),
                  <Money key="p" value={{ amountMinor: data.paidMinor, currency }} />,
                ],
                [
                  t('web.refund_consumed'),
                  <Money key="c" value={{ amountMinor: data.consumedMinor, currency }} />,
                ],
                [
                  t('web.refund_remaining'),
                  <Money key="r" value={{ amountMinor: data.refundableMinor, currency }} />,
                ],
              ]}
            />

            {/*
              NOT refundable at all is a different statement from nothing left, and the
              two get different sentences. A payment that never settled has no money to
              return; a GATEWAY payment has no channel in this release, and a screen
              that offered a button for it would promise a reversal nobody can perform.
            */}
            {!data.refundable && <Banner tone="info">{t('web.refund_unavailable')}</Banner>}

            {/*
              What a full refund did and did NOT do (WP10 P3). The order's state is the
              server's; the sentence about the service is the design — a refund never
              suspends or terminates one, and the operator's own service action is the
              way to do either. Linked to the order, which is where its service is shown.
            */}
            {orderRefunded && orderId !== null && (
              <Banner tone="info" title={t('web.refund_order_refunded_title')}>
                <p>{t('web.refund_order_refunded_body')}</p>
                <a href={`/orders/${encodeURIComponent(orderId)}`} onClick={onLink}>
                  {t('web.refund_order_link')}
                </a>
              </Banner>
            )}

            {rows.length === 0 ? (
              <Empty title={t('web.refunds_empty')} />
            ) : (
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(row) => row.id}
                caption={t('web.refunds')}
              />
            )}

            {data.refundable && remaining > 0n && (
              <>
                <h3 className="card-subtitle">{t('web.refund_request_title')}</h3>
                <p className="muted small">{t('web.refund_request_hint')}</p>
                {mayIssue ? (
                  <>
                    <Field label={t('web.refund_amount_minor')} htmlFor="refund-amount">
                      <input
                        id="refund-amount"
                        value={amount}
                        inputMode="numeric"
                        maxLength={19}
                        onChange={(event) => setAmount(event.target.value)}
                      />
                    </Field>
                    <div className="btn-group">
                      {/* The server's own remaining figure, not one computed here. */}
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => setAmount(data.refundableMinor)}
                      >
                        {t('web.refund_amount_all')}
                      </button>
                    </div>
                    <Field label={t('web.refund_reason')} htmlFor="refund-reason">
                      <input
                        id="refund-reason"
                        value={reason}
                        maxLength={500}
                        onChange={(event) => setReason(event.target.value)}
                      />
                    </Field>
                    <div className="toolbar">
                      <button
                        type="button"
                        className="btn primary sm"
                        disabled={
                          issue.isPending || digitsOf(amount) === '0' || reason.trim().length < 3
                        }
                        onClick={() => issue.mutate()}
                      >
                        {t('web.refund_request')}
                      </button>
                    </div>
                  </>
                ) : (
                  // No disabled button: a disabled control and this sentence make the
                  // same claim, and only one of them names the permission.
                  <Banner tone="info">{t('web.refund_denied')}</Banner>
                )}
              </>
            )}

            {/*
              OUTSIDE the form, on purpose. A refusal re-reads the ledger, and for
              DELIVERY_IN_PROGRESS the server then answers `refundable: false` — which
              hides the form. A banner inside it would vanish with it, taking the one
              sentence that said why.
            */}
            {issue.error !== null && <Banner tone="danger">{refundMessageFor(issue.error)}</Banner>}

            {/*
              The manual channel's second step, and the reason `AWAITING_EXTERNAL`
              exists. An operator says the money left, or says it never will — and
              saying the second RELEASES the amount back to the refundable balance
              rather than deleting the evidence, which is the over-refund achieved by
              destroying the record.
            */}
            {mayIssue && awaiting.length > 0 && (
              <>
                <h3 className="card-subtitle">{t('web.refund_answer_title')}</h3>
                <p className="muted small">{t('web.refund_answer_hint')}</p>
                <Field label={t('web.refund_answer_which')} htmlFor="refund-answering">
                  <select
                    id="refund-answering"
                    value={answering ?? ''}
                    onChange={(event) =>
                      setAnswering(event.target.value === '' ? null : event.target.value)
                    }
                  >
                    <option value="">{t('web.refund_answer_none')}</option>
                    {awaiting.map((row) => (
                      <option key={row.id} value={row.id}>
                        {`${formatMoneyText({ amountMinor: row.amountMinor, currency: row.currency })} — ${row.id}`}
                      </option>
                    ))}
                  </select>
                </Field>
                {answering !== null && (
                  <>
                    <Field label={t('web.refund_answer_note')} htmlFor="refund-note">
                      <input
                        id="refund-note"
                        value={note}
                        maxLength={500}
                        onChange={(event) => setNote(event.target.value)}
                      />
                    </Field>
                    <Field
                      label={t('web.refund_external_reference')}
                      htmlFor="refund-external-reference"
                    >
                      <input
                        id="refund-external-reference"
                        value={externalReference}
                        maxLength={140}
                        onChange={(event) => setExternalReference(event.target.value)}
                      />
                    </Field>
                    <div className="toolbar">
                      <button
                        type="button"
                        className="btn primary sm"
                        /*
                         * Either answer in flight disables BOTH, for the reason the
                         * confirm/reject pair carries: the two commands race one row
                         * with different keys, and the operator gets whichever the
                         * database serves second. Neither can be undone.
                         */
                        disabled={complete.isPending || abandon.isPending || note.trim().length < 3}
                        onClick={() => complete.mutate()}
                      >
                        {t('web.refund_complete')}
                      </button>
                      <button
                        type="button"
                        className="btn danger sm"
                        disabled={complete.isPending || abandon.isPending || note.trim().length < 3}
                        onClick={() => abandon.mutate()}
                      >
                        {t('web.refund_abandon')}
                      </button>
                    </div>
                    {complete.error !== null && (
                      <Banner tone="danger">{refundMessageFor(complete.error)}</Banner>
                    )}
                    {abandon.error !== null && (
                      <Banner tone="danger">{messageFor(abandon.error)}</Banner>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </StateSwitch>
    </Card>
  );
}

export function PaymentDetailPage({
  id,
  mayViewReceipts,
  mayViewRefunds,
  mayIssueRefunds,
  mayViewOrders = false,
  denied,
}: {
  id: string;
  /** `receipts.view`: reading evidence. Deciding it is Telegram's (Payment File 02 §10). */
  mayViewReceipts: boolean;
  /** `refunds.view`. Reading a refund history is not the same right as making one. */
  mayViewRefunds: boolean;
  /** `refunds.issue`. The CRITICAL half: it moves money. */
  mayIssueRefunds: boolean;
  /**
   * `orders.view`, for the one sentence the refund card says about the ORDER after a
   * full refund. Optional and false by default: without it the card says nothing about
   * an order it may not read.
   */
  mayViewOrders?: boolean;
  denied: boolean;
}) {
  const onLink = useLinkHandler();
  const payment = useQuery({
    queryKey: ['payment', id],
    queryFn: () => fetchPayment(id),
    enabled: !denied,
  });
  const row = payment.data?.payment;

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
                  [t('web.payment_id'), <Copyable key="id" value={row.id} />],
                  [t('web.payment_state'), <StateBadge key="s" value={row.state} />],
                  [
                    t('web.payment_disposition'),
                    <DispositionBadge key="d" value={row.receiptDisposition} />,
                  ],
                  [t('web.payment_method'), t(METHOD_LABELS[row.method])],
                  [
                    t('web.payment_gateway'),
                    <GatewayName key="g" provider={row.gatewayProvider} />,
                  ],
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
                    t('web.payment_telegram'),
                    <TelegramIdentity
                      key="tg"
                      telegramUserId={row.customerTelegramUserId}
                      username={row.customerUsername}
                    />,
                  ],
                  [
                    t('web.payment_order'),
                    row.orderId === null ? (
                      // A top-up, named rather than dashed. See the list column.
                      <span key="o" className="muted small">
                        {t('web.payment_topup')}
                      </span>
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
                  [
                    t('web.payment_external_reference'),
                    row.externalReference === null ? (
                      <Dash key="x" />
                    ) : (
                      <Copyable key="x" value={row.externalReference} />
                    ),
                  ],
                  [t('web.payment_created_at'), formatTimestamp(row.createdAt)],
                  [t('web.payment_updated_at'), formatTimestamp(row.updatedAt)],
                  [
                    t('web.payment_expires_at'),
                    row.expiresAt === null ? <Dash key="e" /> : formatTimestamp(row.expiresAt),
                  ],
                  [
                    t('web.payment_customer_signalled'),
                    row.customerSignalledAt === null ? (
                      // A SENTENCE, not a dash. "The customer has said nothing" is the
                      // answer here rather than a missing value, and it is the half of
                      // the picture a reviewer weighs before opening their bank.
                      <span key="cs" className="muted small">
                        {t('web.payment_customer_signalled_none')}
                      </span>
                    ) : (
                      formatTimestamp(row.customerSignalledAt)
                    ),
                  ],
                ]}
              />
              {row.customerSignalledAt !== null && (
                <p className="muted small">{t('web.payment_customer_signalled_hint')}</p>
              )}
            </Card>

            {/*
              The top-up gift this payment promised (Payment File 02 §17, D5): the
              percentage SNAPSHOTTED from its route when it was created. Null for anything
              that is not a top-up, which is why the card is absent rather than dashed.
            */}
            {row.topupCashbackPercent !== null && (
              <Card title={t('web.payment_topup_gift')}>
                <p className="strong">
                  <Ltr>{`${String(row.topupCashbackPercent)}%`}</Ltr>
                </p>
                <p className="muted small">{t('web.payment_topup_gift_hint')}</p>
              </Card>
            )}

            {/*
              The external gateway's side of this payment (WP11A): the provider's ids,
              what its INQUIRY last said, what its webhook last hinted and how the
              attempt ended. The provider's amounts are metadata only — the payment's own
              amount above is what Nexa charged — and no payment link is shown.
            */}
            {row.gatewayInvoice !== null && (
              <Card
                title={t('web.payment_gateway_invoice')}
                hint={t('web.payment_gateway_invoice_hint')}
              >
                <KV
                  items={[
                    [
                      t('web.payment_gateway_invoice_order_id'),
                      <Copyable key="po" value={row.gatewayInvoice.providerOrderId} />,
                    ],
                    [
                      t('web.payment_gateway_invoice_id'),
                      row.gatewayInvoice.providerInvoiceId === null ? (
                        <Dash key="pi" />
                      ) : (
                        <Copyable key="pi" value={row.gatewayInvoice.providerInvoiceId} />
                      ),
                    ],
                    [
                      t('web.payment_gateway_invoice_creation'),
                      <Ltr key="cs">
                        {row.gatewayInvoice.creationState}
                        {row.gatewayInvoice.creationErrorCode === null
                          ? ''
                          : ` · ${row.gatewayInvoice.creationErrorCode}`}
                      </Ltr>,
                    ],
                    [
                      t('web.payment_gateway_invoice_status'),
                      <Ltr key="st">
                        {row.gatewayInvoice.providerStatus ?? '—'}
                        {row.gatewayInvoice.providerPaid === null
                          ? ''
                          : ` · paid=${String(row.gatewayInvoice.providerPaid)}`}
                      </Ltr>,
                    ],
                    [
                      t('web.payment_gateway_invoice_last_inquiry'),
                      row.gatewayInvoice.lastInquiryAt === null ? (
                        <Dash key="li" />
                      ) : (
                        <span key="li">
                          {formatTimestamp(row.gatewayInvoice.lastInquiryAt)}
                          {row.gatewayInvoice.lastInquiryErrorCode === null ? null : (
                            <>
                              {' '}
                              <Ltr>{row.gatewayInvoice.lastInquiryErrorCode}</Ltr>
                            </>
                          )}
                        </span>
                      ),
                    ],
                    [
                      t('web.payment_gateway_invoice_webhook'),
                      <span key="wh">
                        <Ltr>{row.gatewayInvoice.webhookStatusHint ?? '—'}</Ltr>
                        {` · ${String(row.gatewayInvoice.webhookCount)}`}
                      </span>,
                    ],
                    [
                      t('web.payment_gateway_invoice_amounts'),
                      <Ltr key="am">
                        {`${row.gatewayInvoice.sentAmount} / ${row.gatewayInvoice.requestAmount ?? '—'} / ${row.gatewayInvoice.finalAmount ?? '—'} / ${row.gatewayInvoice.creditAmount ?? '—'} ${row.gatewayInvoice.providerUnit}`}
                      </Ltr>,
                    ],
                    [
                      t('web.payment_gateway_invoice_outcome'),
                      <Ltr key="oc">{row.gatewayInvoice.outcome ?? '—'}</Ltr>,
                    ],
                    [
                      t('web.payment_gateway_invoice_late'),
                      row.gatewayInvoice.lateCompletionObservedAt === null ? (
                        <Dash key="lt" />
                      ) : (
                        <Badge key="lt" tone="warn">
                          {formatTimestamp(row.gatewayInvoice.lateCompletionObservedAt)}
                        </Badge>
                      ),
                    ],
                  ]}
                />
              </Card>
            )}

            {/*
              The receipt's credit-to-wallet disposition, when that is how it was decided
              (Payment File 02 §12, D2). READ-ONLY: it was decided in Telegram, and this
              page shows what, by whom and when — never a control to make or undo one.
              The amount is the reviewer's, which may differ from the payment's own; that
              difference is the reason the disposition exists.
            */}
            {row.receiptCredit !== null && (
              <Card title={t('web.payment_receipt_credit')}>
                <KV
                  items={[
                    [
                      t('web.payment_receipt_credit_amount'),
                      <Money
                        key="ca"
                        value={{
                          amountMinor: row.receiptCredit.amountMinor,
                          currency: row.receiptCredit.currency,
                        }}
                      />,
                    ],
                    [
                      t('web.payment_receipt_credit_admin'),
                      <Copyable key="cw" value={row.receiptCredit.decidedByAdminId} />,
                    ],
                    [
                      t('web.payment_receipt_credit_at'),
                      formatTimestamp(row.receiptCredit.decidedAt),
                    ],
                    [
                      t('web.payment_receipt_credit_note'),
                      row.receiptCredit.note === null ? <Dash key="cn" /> : row.receiptCredit.note,
                    ],
                  ]}
                />
                <p className="muted small">{t('web.payment_receipt_credit_hint')}</p>
              </Card>
            )}

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
              WHERE the customer was told to send it.
              Its own card because it is neither the payment nor the evidence: it is
              what the instructions SAID, frozen when the reference was issued, so it
              still answers "which account should this have arrived in" after the
              account has been renamed, edited or disabled. That is the reconciliation
              question, and until this card existed no operator screen could answer it.

              Absent for a wallet settlement and for a manual transfer issued before
              5A — both of which genuinely have no destination, which is why the card
              is hidden rather than filled with dashes.

              Four digits, never sixteen. `paymentDestinationViewSchema` is what stops
              the rest reaching this bundle at all.
            */}
            {row.destination !== null && (
              <Card title={t('web.payment_destination')}>
                <KV
                  items={[
                    [t('web.payment_destination_label'), row.destination.label],
                    [t('web.payment_destination_bank'), row.destination.bankName],
                    [t('web.payment_destination_holder'), row.destination.holderName],
                    [
                      t('web.payment_destination_card'),
                      <Ltr key="dc">{`\u2022\u2022\u2022\u2022 ${row.destination.cardLast4}`}</Ltr>,
                    ],
                    [
                      t('web.payment_destination_sheba'),
                      t(
                        row.destination.hasIban
                          ? 'web.payment_destination_sheba_given'
                          : 'web.payment_destination_sheba_absent',
                      ),
                    ],
                    [
                      t('web.payment_destination_account'),
                      <Copyable key="da" value={row.destination.accountId} />,
                    ],
                  ]}
                />
              </Card>
            )}

            {/*
              What the customer sent, when they sent anything.
              Its own card and its own permission: `receipts.view` reads the evidence,
              `receipts.review` decides. A reader who may see a payment does not
              automatically get to open a customer's bank screenshot.
            */}
            {mayViewReceipts && <ReceiptsCard paymentId={id} />}

            {/*
              Money going BACK, under its own two permissions.
              Placed after the evidence and before the decision forms, because that is
              the order an operator reads in: what arrived, what was sent back, and only
              then what is left to decide. Hidden entirely without `refunds.view` — a
              refund history is financial evidence about a customer.
            */}
            {mayViewRefunds && (
              <RefundsCard
                paymentId={id}
                orderId={row.orderId}
                mayIssue={mayIssueRefunds}
                mayViewOrders={mayViewOrders}
              />
            )}

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
              Card-to-card review is Telegram's alone (Payment File 02 §10, D3): approve,
              reject and credit-to-wallet are decided there, and this page shows what was
              decided and offers none of them. A PENDING transfer says where to go
              rather than drawing a control the server has no route for.
            */}
            {row.state === 'PENDING' && row.method === 'MANUAL_TRANSFER' && (
              <Card title={t('web.payment_confirm_title')}>
                <p className="muted">{t('web.payment_review_in_telegram')}</p>
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
