import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SERVICE_TERMINATE_CONFIRMATION,
  type CurrencyCode,
  type ServiceDeleteRefundQuote,
  type ServiceRefundIneligibilityReason,
  type ServiceRefundRequestView,
} from '@nexa/contracts';
import { deleteServiceWithRefund, fetchDeleteRefundQuote } from '../api/client';
import { currencyLabel } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import {
  Banner,
  Button,
  Checkbox,
  Field,
  Input,
  KV,
  Ltr,
  Money,
  Radio,
  useUnsavedChanges,
} from '../ui/kit';
import { Modal } from '../ui/overlays';
import { messageFor } from './settings';

/**
 * Item 11 — «حذف سرویس» as a modal with two options (`docs/ux1-delete-service-refund.md`).
 *
 * 1. «فقط حذف سرویس»: the existing terminate, with its typed phrase. No money moves.
 * 2. «حذف سرویس و بازگشت وجه»: an amount, a summary (service, customer, amount, destination
 *    wallet), an explicit final confirmation, then the server's answer — which is the request
 *    as it stands. The credit waits for the provider deletion, so the result says "pending"
 *    until it has happened, and "blocked" while the deletion's answer is unknown.
 *
 * Nothing here decides anything: the bound shown is the server's quote, and the command
 * decides it again under the payment's lock.
 */

const REASON_LABELS: Readonly<Record<ServiceRefundIneligibilityReason, WebKey>> = {
  DISABLED: 'web.service_delete_reason_disabled',
  SERVICE_STATE: 'web.service_delete_reason_service_state',
  ALREADY_REQUESTED: 'web.service_delete_reason_already_requested',
  NO_PAID_SOURCE: 'web.service_delete_reason_no_paid_source',
  SOURCE_UNRESOLVED: 'web.service_delete_reason_source_unresolved',
  NOTHING_REFUNDABLE: 'web.service_delete_reason_nothing_refundable',
  CANNOT_DELETE: 'web.service_delete_reason_cannot_delete',
};

/**
 * The typed amount as a decimal string of minor units, or why it is not one. Sales
 * currencies (Toman, Rial) have no minor unit in this product, so the figure typed IS the
 * minor-unit figure; anything but whole digits (Latin, Persian or Arabic-Indic) is refused
 * rather than rounded.
 */
export function deleteRefundAmountOf(
  typed: string,
  remainingMinor: string,
): { readonly ok: true; readonly minor: string } | { readonly ok: false; readonly error: WebKey } {
  // Persian and Arabic-Indic digits are what an operator's keyboard types; read them as digits.
  const trimmed = typed
    .trim()
    .replace(/[\u06F0-\u06F9]/gu, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660));
  if (!/^[0-9]{1,19}$/u.test(trimmed)) {
    return { ok: false, error: 'web.service_delete_amount_invalid' };
  }
  const value = BigInt(trimmed);
  if (value <= 0n) return { ok: false, error: 'web.service_delete_amount_invalid' };
  if (value > BigInt(remainingMinor)) {
    return { ok: false, error: 'web.service_delete_amount_too_large' };
  }
  return { ok: true, minor: value.toString() };
}

/** What the server's answer means to the operator: never "done" before it is. */
export function deleteRefundOutcome(request: ServiceRefundRequestView): {
  readonly tone: 'ok' | 'warn' | 'danger' | 'info';
  readonly message: WebKey;
} {
  if (request.state === 'COMPLETED') {
    return { tone: 'ok', message: 'web.service_delete_result_completed' };
  }
  if (request.state === 'FAILED') {
    return { tone: 'danger', message: 'web.service_delete_result_failed' };
  }
  if (request.operationState === 'UNKNOWN') {
    return { tone: 'warn', message: 'web.service_delete_result_blocked' };
  }
  return { tone: 'info', message: 'web.service_delete_result_pending' };
}

type Mode = 'DELETE_ONLY' | 'DELETE_REFUND';
type Step = 'CHOOSE' | 'SUMMARY' | 'RESULT';

export function ServiceDeleteModal({
  open,
  onClose,
  serviceId,
  serviceUsername,
  mayRefund,
  deleteOnly,
}: {
  open: boolean;
  onClose: () => void;
  serviceId: string;
  serviceUsername: string;
  /** `refunds.issue` AND `services.terminate`. A courtesy; the server decides. */
  mayRefund: boolean;
  /** The existing terminate, with its typed phrase; its caller closes the modal on success. */
  deleteOnly: { readonly pending: boolean; readonly run: (phrase: string) => void };
}) {
  return (
    <Modal open={open} onClose={onClose} title={t('web.service_delete_title')} danger>
      <DeleteBody
        onClose={onClose}
        serviceId={serviceId}
        serviceUsername={serviceUsername}
        mayRefund={mayRefund}
        deleteOnly={deleteOnly}
      />
    </Modal>
  );
}

function DeleteBody({
  onClose,
  serviceId,
  serviceUsername,
  mayRefund,
  deleteOnly,
}: {
  onClose: () => void;
  serviceId: string;
  serviceUsername: string;
  mayRefund: boolean;
  deleteOnly: { readonly pending: boolean; readonly run: (phrase: string) => void };
}) {
  const [mode, setMode] = useState<Mode>('DELETE_ONLY');
  const [step, setStep] = useState<Step>('CHOOSE');
  const [phrase, setPhrase] = useState('');
  const [amount, setAmount] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<ServiceRefundRequestView | null>(null);
  const submission = useSubmissionKey();
  const queries = useQueryClient();

  const quote = useQuery({
    queryKey: ['service-delete-refund-quote', serviceId],
    queryFn: () => fetchDeleteRefundQuote(serviceId),
    enabled: mayRefund,
  });

  const refund = useMutation({
    mutationFn: (minor: string) =>
      deleteServiceWithRefund({
        serviceId,
        // One command per (service, amount): a double click or a retry after a lost answer
        // replays it rather than deleting and refunding twice.
        idempotencyKey: submission.current({ command: 'services.delete_refund', serviceId, minor }),
        amountMinor: minor,
      }),
    onSuccess: ({ request }) => {
      submission.settle();
      setResult(request);
      setStep('RESULT');
      void queries.invalidateQueries({ queryKey: ['service', serviceId] });
      void queries.invalidateQueries({ queryKey: ['service-operations', serviceId] });
      void queries.invalidateQueries({ queryKey: ['service-refund-requests'] });
      void queries.invalidateQueries({ queryKey: ['services'] });
    },
    // A 5xx may have committed: the retry keeps its key rather than refunding twice.
    onError: (error) => submission.settleOn(error),
  });

  const data: ServiceDeleteRefundQuote | undefined = quote.data;
  const parsed =
    data?.remainingMinor === null || data?.remainingMinor === undefined
      ? null
      : deleteRefundAmountOf(amount, data.remainingMinor);
  const dirty = step !== 'RESULT' && (phrase !== '' || amount.trim() !== '' || confirmed);
  useUnsavedChanges(dirty);

  if (step === 'RESULT' && result !== null) {
    const outcome = deleteRefundOutcome(result);
    return (
      <div className="ca-delete-modal">
        <Banner tone={outcome.tone}>{t(outcome.message)}</Banner>
        <KV
          items={[
            [t('web.service_delete_summary_service'), <Ltr key="s">{serviceUsername}</Ltr>],
            [
              t('web.service_delete_summary_amount'),
              result.approvedAmountMinor === null ? (
                '—'
              ) : (
                <Money
                  key="a"
                  value={{ amountMinor: result.approvedAmountMinor, currency: result.currency }}
                />
              ),
            ],
            [
              t('web.service_delete_result_reference'),
              <Ltr key="r">{result.refundId ?? result.id}</Ltr>,
            ],
          ]}
        />
        <div className="form-actions">
          <Button onClick={onClose}>{t('web.service_delete_close')}</Button>
        </div>
      </div>
    );
  }

  if (step === 'SUMMARY' && data !== undefined && parsed !== null && parsed.ok) {
    const currency = data.currency as CurrencyCode;
    const who = [
      data.customerDisplayName,
      data.customerUsername === null ? null : `@${data.customerUsername}`,
      data.customerTelegramUserId,
    ]
      .filter((part): part is string => part !== null)
      .join(' · ');
    return (
      <div className="ca-delete-modal">
        <h3>{t('web.service_delete_summary')}</h3>
        <KV
          items={[
            [t('web.service_delete_summary_service'), <Ltr key="s">{data.serviceUsername}</Ltr>],
            [t('web.service_delete_summary_customer'), <Ltr key="c">{who || data.customerId}</Ltr>],
            [
              t('web.service_delete_summary_amount'),
              <Money key="a" value={{ amountMinor: parsed.minor, currency }} />,
            ],
            [
              t('web.service_delete_summary_destination'),
              t('web.service_delete_destination_wallet'),
            ],
          ]}
        />
        <Banner tone="warn">{t('web.service_delete_summary_note')}</Banner>
        <Checkbox
          label={t('web.service_delete_confirm_check')}
          checked={confirmed}
          onChange={setConfirmed}
        />
        {refund.error !== null && <Banner tone="danger">{messageFor(refund.error)}</Banner>}
        <div className="form-actions">
          <Button
            disabled={refund.isPending}
            onClick={() => {
              setConfirmed(false);
              setStep('CHOOSE');
            }}
          >
            {t('web.service_delete_back')}
          </Button>
          <Button
            variant="danger-solid"
            icon="trash"
            disabled={!confirmed || refund.isPending}
            onClick={() => refund.mutate(parsed.minor)}
          >
            {t('web.service_delete_refund_submit')}
          </Button>
        </div>
      </div>
    );
  }

  const phraseMatches = phrase.trim() === SERVICE_TERMINATE_CONFIRMATION;
  return (
    <div className="ca-delete-modal">
      <p className="muted small">{t('web.service_delete_choose')}</p>
      <div
        className="ca-delete-options"
        role="radiogroup"
        aria-label={t('web.service_delete_title')}
      >
        <Radio
          name="service-delete-mode"
          value="DELETE_ONLY"
          selected={mode}
          onChange={setMode}
          label={
            <span>
              <strong>{t('web.service_delete_only')}</strong>
              <span className="muted small ca-delete-hint">
                {t('web.service_delete_only_hint')}
              </span>
            </span>
          }
        />
        <Radio
          name="service-delete-mode"
          value="DELETE_REFUND"
          selected={mode}
          onChange={setMode}
          disabled={!mayRefund}
          label={
            <span>
              <strong>{t('web.service_delete_refund')}</strong>
              <span className="muted small ca-delete-hint">
                {t('web.service_delete_refund_hint')}
              </span>
            </span>
          }
        />
      </div>
      {!mayRefund && <p className="muted small">{t('web.service_delete_refund_denied')}</p>}

      {mode === 'DELETE_ONLY' ? (
        <>
          <Field
            label={t('web.service_terminate_confirm_label')}
            htmlFor="service-terminate-phrase"
            {...(phrase !== '' && !phraseMatches
              ? { error: t('web.service_terminate_confirm_wrong') }
              : {})}
          >
            <span className="ca-phrase">
              <Ltr>{SERVICE_TERMINATE_CONFIRMATION}</Ltr>
            </span>
            <Input
              id="service-terminate-phrase"
              type="text"
              value={phrase}
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={phrase !== '' && !phraseMatches}
              onChange={(event) => setPhrase(event.currentTarget.value)}
            />
          </Field>
          <div className="form-actions">
            <Button onClick={onClose}>{t('web.service_delete_cancel')}</Button>
            <Button
              variant="danger-solid"
              icon="trash"
              disabled={!phraseMatches || deleteOnly.pending}
              onClick={() => deleteOnly.run(phrase)}
            >
              {t('web.service_terminate_button')}
            </Button>
          </div>
        </>
      ) : quote.isPending ? (
        <p className="muted small">{t('web.service_delete_refund_loading')}</p>
      ) : quote.error !== null ? (
        <Banner tone="danger">{messageFor(quote.error)}</Banner>
      ) : data === undefined ? null : !data.eligible ||
        data.remainingMinor === null ||
        data.currency === null ? (
        <Banner tone="neutral">
          {t('web.service_delete_refund_unavailable')}{' '}
          {data.reason === null ? null : t(REASON_LABELS[data.reason])}
        </Banner>
      ) : (
        <>
          <KV
            inline
            items={[
              [
                t('web.service_delete_amount_paid'),
                <Money
                  key="p"
                  value={{ amountMinor: data.principalMinor ?? '0', currency: data.currency }}
                />,
              ],
              [
                t('web.service_delete_amount_max'),
                <Money
                  key="m"
                  value={{ amountMinor: data.remainingMinor, currency: data.currency }}
                />,
              ],
            ]}
          />
          <Field
            label={`${t('web.service_delete_amount')} (${currencyLabel(data.currency)})`}
            htmlFor="service-delete-amount"
            {...(amount.trim() !== '' && parsed !== null && !parsed.ok
              ? { error: t(parsed.error) }
              : {})}
          >
            <Input
              id="service-delete-amount"
              value={amount}
              inputMode="numeric"
              dir="ltr"
              autoComplete="off"
              maxLength={19}
              aria-invalid={amount.trim() !== '' && parsed !== null && !parsed.ok}
              onChange={(event) => setAmount(event.currentTarget.value)}
            />
          </Field>
          <div className="form-actions">
            <Button onClick={onClose}>{t('web.service_delete_cancel')}</Button>
            <Button
              variant="danger"
              disabled={parsed === null || !parsed.ok}
              onClick={() => {
                setConfirmed(false);
                setStep('SUMMARY');
              }}
            >
              {t('web.service_delete_continue')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
