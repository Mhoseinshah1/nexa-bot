import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MoneyWire } from '@nexa/contracts';
import { approveReceipt, creditReceipt, rejectReceipt } from '../api/client';
import { t } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import {
  Banner,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  KV,
  Money,
  useToast,
  useUnsavedChanges,
} from '../ui/kit';
import { Modal } from '../ui/overlays';
import { ErrorRef } from '../ui/technical-details';
import { messageFor } from './settings';

/**
 * R12 F3 item 8: the Web Admin's half of card-to-card receipt review (owner decision: review
 * happens in BOTH places; Payment File 02 §10 had it Telegram-only).
 *
 * Nothing here is a second money path. The three buttons call the three routes that call the
 * SAME application methods the Telegram panel calls — approve and reject
 * (`PaymentService.confirmManualTransfer` / `rejectManualTransfer`) and the credit
 * (`ReceiptDispositionService.creditToWallet`) — which hold the permissions, the scope-activity
 * check, the conditional PENDING edge, the audit and the idempotency key. So a decision here and
 * one in Telegram exclude each other, and the loser is told so (`PAYMENT_STATE_INVALID`).
 *
 * What this card adds is the ASKING: approve opens a dialog that names the amount that will be
 * settled and needs an explicit tick before it sends; reject needs its reason (the customer is
 * told it); the credit asks for the amount and names the wallet it goes to. Each dialog says the
 * server's refusal inside it. The server decides every permission; the two flags only decide
 * whether the controls are drawn.
 */
type Dialog = 'APPROVE' | 'REJECT' | 'CREDIT' | null;

/** Whole digits only (Latin; an operator's Persian or Arabic-Indic digits are read as digits). */
export function creditAmountOf(typed: string): string | null {
  const digits = typed
    .trim()
    .replace(/[\u06F0-\u06F9]/gu, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660));
  if (!/^[0-9]{1,19}$/u.test(digits)) return null;
  return BigInt(digits) > 0n ? BigInt(digits).toString() : null;
}

export function ReceiptReviewCard({
  paymentId,
  amountMinor,
  currency,
  mayReview,
  mayCredit,
}: {
  paymentId: string;
  /** The payment's own amount: what an approval settles. */
  amountMinor: string;
  currency: MoneyWire['currency'];
  /** `receipts.review`. */
  mayReview: boolean;
  /** `users.wallet.credit` — the credit needs it as well as `receipts.review`. */
  mayCredit: boolean;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const approval = useSubmissionKey();
  const rejection = useSubmissionKey();
  const credit = useSubmissionKey();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [sure, setSure] = useState(false);

  const close = () => {
    setDialog(null);
    setSure(false);
  };
  const refresh = () => {
    for (const key of [
      'payment',
      'payments',
      'payment-timeline',
      'payment-receipts',
      'nav-counters',
    ]) {
      void queries.invalidateQueries({ queryKey: [key] });
    }
    void queries.invalidateQueries({ queryKey: ['order'] });
    void queries.invalidateQueries({ queryKey: ['wallet'] });
  };

  const approve = useMutation({
    mutationFn: () =>
      approveReceipt({
        paymentId,
        idempotencyKey: approval.current({ paymentId, note }),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      }),
    onSuccess: () => {
      approval.settle();
      notify({ tone: 'ok', message: t('web.receipt_done_approved') });
      setNote('');
      close();
      refresh();
    },
    onError: (error) => {
      approval.settleOn(error);
      refresh();
    },
  });
  const reject = useMutation({
    mutationFn: () =>
      rejectReceipt({
        paymentId,
        idempotencyKey: rejection.current({ paymentId, reason }),
        reason: reason.trim(),
      }),
    onSuccess: () => {
      rejection.settle();
      notify({ tone: 'ok', message: t('web.receipt_done_rejected') });
      setReason('');
      close();
      refresh();
    },
    onError: (error) => {
      rejection.settleOn(error);
      refresh();
    },
  });
  const parsedAmount = creditAmountOf(amount);
  const creditMutation = useMutation({
    mutationFn: (minor: string) =>
      creditReceipt({
        paymentId,
        idempotencyKey: credit.current({ paymentId, minor, note }),
        amountMinor: minor,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      }),
    onSuccess: () => {
      credit.settle();
      notify({ tone: 'ok', message: t('web.receipt_done_credited') });
      setAmount('');
      setNote('');
      close();
      refresh();
    },
    onError: (error) => {
      credit.settleOn(error);
      refresh();
    },
  });

  useUnsavedChanges(
    mayReview && (note.trim() !== '' || reason.trim() !== '' || amount.trim() !== ''),
  );
  const busy = approve.isPending || reject.isPending || creditMutation.isPending;
  const errorOf = (error: unknown) => (
    <Banner tone="danger">
      {messageFor(error)}
      <ErrorRef error={error} />
    </Banner>
  );

  if (!mayReview) {
    return (
      <Card title={t('web.payment_confirm_title')}>
        <Banner tone="info">{t('web.receipt_denied')}</Banner>
      </Card>
    );
  }

  const settled: MoneyWire = { amountMinor, currency };
  return (
    <Card title={t('web.payment_confirm_title')} hint={t('web.receipt_review_hint')}>
      <KV items={[[t('web.receipt_amount'), <Money key="m" value={settled} />]]} />
      <div className="form-actions">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => setDialog('APPROVE')}>
          {t('web.receipt_approve')}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => setDialog('REJECT')}>
          {t('web.receipt_reject')}
        </Button>
        {mayCredit && (
          <Button size="sm" disabled={busy} onClick={() => setDialog('CREDIT')}>
            {t('web.receipt_credit')}
          </Button>
        )}
      </div>
      {!mayCredit && <p className="muted small">{t('web.receipt_credit_denied')}</p>}

      {/* Approve: the amount that will be settled, and an explicit tick before it sends. */}
      <Modal
        open={dialog === 'APPROVE'}
        onClose={close}
        title={t('web.receipt_approve_title')}
        foot={
          <>
            <Button size="sm" onClick={close}>
              {t('web.money_cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !sure}
              onClick={() => approve.mutate()}
            >
              {t('web.receipt_approve_confirm')}
            </Button>
          </>
        }
      >
        <p className="muted small">{t('web.receipt_approve_body')}</p>
        <KV items={[[t('web.receipt_amount'), <Money key="m" value={settled} />]]} />
        <Checkbox label={t('web.receipt_approve_check')} checked={sure} onChange={setSure} />
        <Field label={t('web.receipt_note')} htmlFor="receipt-approve-note">
          <Input
            id="receipt-approve-note"
            size="sm"
            value={note}
            maxLength={400}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        {approve.error !== null && errorOf(approve.error)}
      </Modal>

      {/* Reject: the reason is mandatory — the customer is told it. */}
      <Modal
        open={dialog === 'REJECT'}
        onClose={close}
        title={t('web.receipt_reject_title')}
        danger
        foot={
          <>
            <Button size="sm" onClick={close}>
              {t('web.money_cancel')}
            </Button>
            <Button
              size="sm"
              disabled={busy || reason.trim() === ''}
              onClick={() => reject.mutate()}
            >
              {t('web.receipt_reject_confirm')}
            </Button>
          </>
        }
      >
        <p className="muted small">{t('web.receipt_reject_body')}</p>
        <Field label={t('web.receipt_reject_reason')} htmlFor="receipt-reject-reason">
          <Input
            id="receipt-reject-reason"
            size="sm"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        {reject.error !== null && errorOf(reject.error)}
      </Modal>

      {/* Credit: what actually arrived, into the wallet — and nothing else. */}
      <Modal
        open={dialog === 'CREDIT'}
        onClose={close}
        title={t('web.receipt_credit_title')}
        foot={
          <>
            <Button size="sm" onClick={close}>
              {t('web.money_cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || parsedAmount === null || !sure}
              onClick={() => {
                if (parsedAmount !== null) creditMutation.mutate(parsedAmount);
              }}
            >
              {t('web.receipt_credit_confirm')}
            </Button>
          </>
        }
      >
        <p className="muted small">{t('web.receipt_credit_hint')}</p>
        <Field
          label={`${t('web.receipt_credit_amount')} (${currency})`}
          htmlFor="receipt-credit-amount"
          {...(amount.trim() !== '' && parsedAmount === null
            ? { error: t('web.receipt_credit_invalid') }
            : {})}
        >
          <Input
            id="receipt-credit-amount"
            size="sm"
            dir="ltr"
            inputMode="numeric"
            value={amount}
            maxLength={19}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        {parsedAmount !== null && (
          <KV
            items={[
              [
                t('web.receipt_credit_will_add'),
                <Money key="c" value={{ amountMinor: parsedAmount, currency }} />,
              ],
            ]}
          />
        )}
        <Checkbox label={t('web.receipt_credit_check')} checked={sure} onChange={setSure} />
        <Field label={t('web.receipt_note')} htmlFor="receipt-credit-note">
          <Input
            id="receipt-credit-note"
            size="sm"
            value={note}
            maxLength={400}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        {creditMutation.error !== null && errorOf(creditMutation.error)}
      </Modal>
    </Card>
  );
}
