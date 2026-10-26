import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { keepPageWhileTurning } from '../ui/paging';
import {
  GIFT_CARD_BATCH_MAX_CODES,
  GIFT_CARD_LABEL_MAX_LENGTH,
  GIFT_CARD_PER_CUSTOMER_LIMIT_MAX,
  GIFT_CARD_REASON_MAX_LENGTH,
  type CurrencyCode,
  type GiftCardBatchState,
  type GiftCardBatchWire,
} from '@nexa/contracts';
import {
  createGiftCardBatch,
  disableGiftCardBatch,
  fetchGiftCardBatches,
  fetchGiftCardDisablePreview,
  giftCardExportUrl,
} from '../api/client';
import { t, type WebKey } from '../i18n/web.fa';
import { errorText } from '../error-text';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import {
  Badge,
  Banner,
  Button,
  Card,
  CursorPager,
  DataTable,
  Field,
  Money,
  Num,
  PageHead,
  PermissionDeniedState,
  StateSwitch,
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';
import { Modal } from '../ui/overlays';
import { DateField } from '../ui/date-field';
import { ErrorRef } from '../ui/technical-details';
import { useUnsavedChanges } from '../ui/unsaved';
import { fromLocalInput } from './incidents';

/**
 * «کارت‌های هدیه» — R10 D4: wallet top-up codes.
 *
 * A client of `/gift-card-batches` and nothing else decides here: the server charges
 * `gift_cards.view`, `.create`, `.export` and `.disable` itself, checks the confirmation, and
 * mints, hashes and seals the codes. The page never holds a code: the batch's codes are
 * downloaded once as a CSV through a URL, within 24 hours of the batch, and are then gone.
 *
 * Every count and total on the page is the server's; the one figure computed here is the face
 * total the operator confirms (amount × count), which the server recomputes and compares.
 */

const STATE_LABEL: Readonly<Record<GiftCardBatchState, WebKey>> = {
  ACTIVE: 'web.gift_cards_state_active',
  DISABLED: 'web.gift_cards_state_disabled',
};

const STATE_TONE: Readonly<Record<GiftCardBatchState, Tone>> = {
  ACTIVE: 'ok',
  DISABLED: 'neutral',
};

const QUERY_KEY = 'gift-card-batches';

export function GiftCardsPage({
  denied,
  mayCreate,
  mayExport,
  mayDisable,
}: {
  /** `gift_cards.view`: without it the page issues no request at all. */
  denied: boolean;
  mayCreate: boolean;
  mayExport: boolean;
  mayDisable: boolean;
}) {
  const [cursors, setCursors] = useState<readonly string[]>([]);
  const cursor = cursors.length > 0 ? cursors[cursors.length - 1] : undefined;
  const list = useQuery(
    keepPageWhileTurning({
      queryKey: [QUERY_KEY, cursor ?? null],
      queryFn: () => fetchGiftCardBatches(cursor),
      enabled: !denied,
    }),
  );
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<GiftCardBatchWire | null>(null);
  const [disabling, setDisabling] = useState<GiftCardBatchWire | null>(null);

  if (denied) {
    return (
      <>
        <PageHead title={t('web.gift_cards_title')} subtitle={t('web.gift_cards_intro')} />
        <PermissionDeniedState />
      </>
    );
  }

  const enabled = list.data?.enabled ?? false;
  const currency = list.data?.walletCurrency ?? null;
  const rows = list.data?.batches ?? [];
  const nextCursor = list.data?.nextCursor ?? null;

  const columns: Column<GiftCardBatchWire>[] = [
    { key: 'label', header: t('web.gift_cards_col_label'), render: (row) => row.label, wrap: true },
    {
      key: 'amount',
      header: t('web.gift_cards_col_amount'),
      render: (row) => <Money value={row.amount} />,
      align: 'end',
    },
    {
      key: 'count',
      header: t('web.gift_cards_col_count'),
      render: (row) => <Num value={row.count} />,
      align: 'end',
    },
    {
      key: 'redeemed',
      header: t('web.gift_cards_col_redeemed'),
      render: (row) => <Num value={row.redeemedCount} />,
      align: 'end',
    },
    {
      key: 'remaining',
      header: t('web.gift_cards_col_remaining'),
      render: (row) => <Num value={row.unredeemedCount} />,
      align: 'end',
    },
    {
      key: 'credited',
      header: t('web.gift_cards_col_credited'),
      render: (row) => <Money value={row.redeemedTotal} />,
      align: 'end',
    },
    {
      key: 'expires',
      header: t('web.gift_cards_col_expires'),
      render: (row) => formatTimestamp(row.expiresAt),
      wrap: 'tight',
    },
    {
      key: 'state',
      header: t('web.gift_cards_col_state'),
      render: (row) => <Badge tone={STATE_TONE[row.state]}>{t(STATE_LABEL[row.state])}</Badge>,
    },
    {
      key: 'actions',
      header: t('web.gift_cards_col_actions'),
      render: (row) => (
        <div className="btn-group">
          {mayExport && row.exportAvailableUntil !== null && (
            <a className="btn sm" href={giftCardExportUrl(row.id)} download>
              {t('web.gift_cards_download')}
            </a>
          )}
          {mayDisable && row.state === 'ACTIVE' && (
            <Button size="sm" variant="danger" onClick={() => setDisabling(row)}>
              {t('web.gift_cards_disable')}
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHead
        title={t('web.gift_cards_title')}
        subtitle={t('web.gift_cards_intro')}
        actions={
          mayCreate ? (
            <Button
              variant="primary"
              icon="plus"
              disabled={!enabled || currency === null}
              onClick={() => setCreating(true)}
            >
              {t('web.gift_cards_new')}
            </Button>
          ) : undefined
        }
      />
      {list.data !== undefined && !enabled && (
        <Banner tone="warn">{t('web.gift_cards_feature_off')}</Banner>
      )}
      {created !== null && (
        <Banner tone="ok" title={t('web.gift_cards_created_title')}>
          <p>{t('web.gift_cards_created_hint')}</p>
          {mayExport && created.exportAvailableUntil !== null && (
            <a className="btn primary sm" href={giftCardExportUrl(created.id)} download>
              {t('web.gift_cards_download')}
            </a>
          )}
        </Banner>
      )}
      <Card title={t('web.gift_cards_list_title')} hint={t('web.gift_cards_list_hint')}>
        <StateSwitch
          query={list}
          isEmpty={rows.length === 0 && cursors.length === 0}
          empty={<p className="muted">{t('web.gift_cards_empty')}</p>}
        >
          <DataTable
            caption={t('web.gift_cards_list_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
          />
          {/* `GET /gift-card-batches` pages newest to oldest. */}
          <CursorPager
            order="newest-first"
            shown={rows.length}
            hasPrevious={cursors.length > 0}
            hasNext={nextCursor !== null}
            onPrevious={() => setCursors(cursors.slice(0, -1))}
            onNext={() => nextCursor !== null && setCursors([...cursors, nextCursor])}
          />
        </StateSwitch>
      </Card>
      {creating && currency !== null && (
        <CreateDialog
          currency={currency}
          onClose={() => setCreating(false)}
          onCreated={(batch) => {
            setCreating(false);
            setCreated(batch);
            setCursors([]);
          }}
        />
      )}
      {disabling !== null && <DisableDialog batch={disabling} onClose={() => setDisabling(null)} />}
    </>
  );
}

/** The face total the operator confirms: amount × count, in minor units, or null when unset. */
function faceTotal(amount: string, count: string): bigint | null {
  if (!/^[1-9][0-9]{0,17}$/u.test(amount) || !/^[1-9][0-9]{0,3}$/u.test(count)) return null;
  return BigInt(amount) * BigInt(count);
}

function CreateDialog({
  currency,
  onClose,
  onCreated,
}: {
  currency: CurrencyCode;
  onClose: () => void;
  onCreated: (batch: GiftCardBatchWire) => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const submission = useSubmissionKey();
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [count, setCount] = useState('');
  const [expires, setExpires] = useState('');
  const [limit, setLimit] = useState('');
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const dirty = label !== '' || amount !== '' || count !== '' || reason !== '';
  useUnsavedChanges(dirty);

  const total = faceTotal(amount, count);
  const countValue = Number(count);
  const expiresAt = fromLocalInput(expires);
  const limitValue = limit.trim() === '' ? null : Number(limit);
  const limitValid =
    limitValue === null ||
    (Number.isInteger(limitValue) &&
      limitValue >= 1 &&
      limitValue <= GIFT_CARD_PER_CUSTOMER_LIMIT_MAX);
  const ready =
    label.trim() !== '' &&
    total !== null &&
    countValue <= GIFT_CARD_BATCH_MAX_CODES &&
    expiresAt !== null &&
    limitValid &&
    reason.trim() !== '' &&
    typed.trim() === String(countValue);

  const create = useMutation({
    mutationFn: () => {
      if (total === null || expiresAt === null) throw new Error('form');
      const body = {
        label: label.trim(),
        amountMinor: amount,
        currency,
        count: countValue,
        expiresAt,
        perCustomerLimit: limitValue,
        reason: reason.trim(),
        expectedTotalMinor: total.toString(),
        typedCount: Number(typed.trim()),
      };
      return createGiftCardBatch({ ...body, idempotencyKey: submission.current(body) });
    },
    onSuccess: (response) => {
      submission.settle();
      toast({ tone: 'ok', message: t('web.gift_cards_created_title') });
      void client.invalidateQueries({ queryKey: [QUERY_KEY] });
      onCreated(response.batch);
    },
    onError: (error) => submission.settleOn(error),
  });

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (ready && !create.isPending) create.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('web.gift_cards_new')}
      size="lg"
      foot={
        <div className="btn-group">
          <Button
            type="submit"
            form="gift-card-create"
            variant="primary"
            disabled={!ready || create.isPending}
          >
            {t('web.gift_cards_create_submit')}
          </Button>
          <Button onClick={onClose}>{t('web.gift_cards_cancel')}</Button>
        </div>
      }
    >
      <form id="gift-card-create" className="stack" onSubmit={onSubmit} autoComplete="off">
        <div className="form-grid">
          <Field label={t('web.gift_cards_label')} htmlFor="gc-label" required>
            <input
              id="gc-label"
              maxLength={GIFT_CARD_LABEL_MAX_LENGTH}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
          <Field
            label={t('web.gift_cards_amount')}
            htmlFor="gc-amount"
            hint={t('web.gift_cards_amount_hint')}
            required
          >
            <input
              id="gc-amount"
              inputMode="numeric"
              dir="ltr"
              value={amount}
              onChange={(event) => setAmount(event.target.value.trim())}
            />
          </Field>
          <Field
            label={t('web.gift_cards_count')}
            htmlFor="gc-count"
            hint={t('web.gift_cards_count_hint')}
            required
          >
            <input
              id="gc-count"
              inputMode="numeric"
              dir="ltr"
              value={count}
              onChange={(event) => setCount(event.target.value.trim())}
            />
          </Field>
          <Field
            label={t('web.gift_cards_expires')}
            htmlFor="gc-expires"
            hint={t('web.gift_cards_expires_hint')}
            required
          >
            <DateField id="gc-expires" mode="datetime" value={expires} onChange={setExpires} />
          </Field>
          <Field
            label={t('web.gift_cards_limit')}
            htmlFor="gc-limit"
            hint={t('web.gift_cards_limit_hint')}
          >
            <input
              id="gc-limit"
              inputMode="numeric"
              dir="ltr"
              value={limit}
              onChange={(event) => setLimit(event.target.value.trim())}
            />
          </Field>
          <Field label={t('web.gift_cards_reason')} htmlFor="gc-reason" required>
            <input
              id="gc-reason"
              maxLength={GIFT_CARD_REASON_MAX_LENGTH}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
        {total !== null && (
          <Banner tone="warn" title={t('web.gift_cards_total_title')}>
            <p>
              <Num value={countValue} /> × <Money value={{ amountMinor: amount, currency }} /> ={' '}
              <strong>
                <Money value={{ amountMinor: total.toString(), currency }} />
              </strong>
            </p>
            <p className="small">{t('web.gift_cards_total_hint')}</p>
          </Banner>
        )}
        <Field
          label={t('web.gift_cards_type_count')}
          htmlFor="gc-typed"
          hint={t('web.gift_cards_type_count_hint')}
          required
        >
          <input
            id="gc-typed"
            inputMode="numeric"
            dir="ltr"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </Field>
        {create.error !== null && (
          <Banner tone="danger">
            {errorText(create.error)}
            <ErrorRef error={create.error} />
          </Banner>
        )}
      </form>
    </Modal>
  );
}

/** Disable: the counted dry run first, then a confirmation bound to that count. */
function DisableDialog({ batch, onClose }: { batch: GiftCardBatchWire; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const submission = useSubmissionKey();
  const [reason, setReason] = useState('');
  const preview = useQuery({
    queryKey: ['gift-card-disable-preview', batch.id],
    queryFn: () => fetchGiftCardDisablePreview(batch.id),
  });
  const disable = useMutation({
    mutationFn: () => {
      if (preview.data === undefined) throw new Error('preview');
      const body = {
        reason: reason.trim(),
        expectedUnredeemed: preview.data.unredeemedCount,
        confirmed: true as const,
      };
      return disableGiftCardBatch(batch.id, { ...body, idempotencyKey: submission.current(body) });
    },
    onSuccess: (response) => {
      submission.settle();
      toast({
        tone: 'ok',
        message: response.changed
          ? t('web.gift_cards_disabled_done')
          : t('web.gift_cards_disabled_already'),
      });
      void client.invalidateQueries({ queryKey: [QUERY_KEY] });
      onClose();
    },
    onError: (error) => {
      submission.settleOn(error);
      void preview.refetch();
    },
  });
  return (
    <Modal
      open
      danger
      onClose={onClose}
      title={t('web.gift_cards_disable_title')}
      foot={
        <div className="btn-group">
          <Button
            variant="danger-solid"
            disabled={preview.data === undefined || reason.trim() === '' || disable.isPending}
            onClick={() => disable.mutate()}
          >
            {t('web.gift_cards_disable')}
          </Button>
          <Button onClick={onClose}>{t('web.gift_cards_cancel')}</Button>
        </div>
      }
    >
      <StateSwitch query={preview}>
        <div className="stack">
          <p>
            {t('web.gift_cards_disable_count')}{' '}
            <strong>
              {preview.data === undefined ? '—' : <Num value={preview.data.unredeemedCount} />}
            </strong>
          </p>
          <p className="muted small">{t('web.gift_cards_disable_hint')}</p>
          <Field label={t('web.gift_cards_reason')} htmlFor="gc-disable-reason" required>
            <input
              id="gc-disable-reason"
              maxLength={GIFT_CARD_REASON_MAX_LENGTH}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          {disable.error !== null && (
            <Banner tone="danger">
              {errorText(disable.error)}
              <ErrorRef error={disable.error} />
            </Banner>
          )}
        </div>
      </StateSwitch>
    </Modal>
  );
}
