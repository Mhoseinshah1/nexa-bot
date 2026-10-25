import { useState, type ChangeEvent } from 'react';
import {
  MINIAPP_RECEIPT_IMAGE_TYPES,
  MINIAPP_RECEIPT_MAX_BYTES,
  MINIAPP_ROUTES,
  miniAppReceiptResponseSchema,
  type MiniAppCardInstruction,
} from '@nexa/contracts';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { dateTime, money } from '../format.js';
import { Button, Card, Ltr, Row, errorText } from '../ui.js';

/**
 * کارت به کارت و رسید: the card and the EXACT amount the payment was issued for (its
 * payable, fee included), the tracking code and the deadline — from the payment's own
 * destination snapshot — then the receipt image, uploaded here and filed by the bot's own
 * receipt service (owner correction 2026-10-25).
 *
 * The design's «کارت دیگر» (switch card) arrives with its own endpoint; it is not drawn.
 * The countdown is the deadline as a time, not a ticking clock the server did not send.
 */
export function CardPay({ instruction }: { instruction: MiniAppCardInstruction }) {
  const { api, replace } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (what: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(what);
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    setError(null);
    // The server decides by the bytes; this only spares an upload that cannot pass.
    if (file.size > MINIAPP_RECEIPT_MAX_BYTES) {
      setError(t('miniapp.card_receipt_refused_TOO_LARGE'));
      return;
    }
    setBusy(true);
    try {
      const imageBase64 = await base64Of(file);
      await api.post(
        MINIAPP_ROUTES.paymentReceipt,
        { paymentId: instruction.paymentId },
        miniAppReceiptResponseSchema,
        { mimeType: file.type, imageBase64 },
      );
      replace({ name: 'pay', paymentId: instruction.paymentId });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const destination = instruction.destination;
  return (
    <main className="page">
      <h1 className="title">{t('miniapp.card_title')}</h1>
      <ol className="steps">
        <li className="step step-on">{t('miniapp.card_step_transfer')}</li>
        <li className="step">{t('miniapp.card_step_receipt')}</li>
        <li className="step">{t('miniapp.card_step_review')}</li>
      </ol>
      <Card>
        <Row label={t('miniapp.card_amount')} value={<strong>{money(instruction.amount)}</strong>} />
        {instruction.principal !== null && instruction.fee !== null && (
          <p className="muted">
            {t('miniapp.card_principal_fee', {
              principal: money(instruction.principal),
              fee: money(instruction.fee),
            })}
          </p>
        )}
        <Button onClick={() => copy('amount', instruction.copyAmount)}>
          {copied === 'amount' ? t('miniapp.copied') : t('miniapp.card_copy')}
        </Button>
      </Card>
      {destination === null ? (
        <Card>
          <p>{t('miniapp.card_no_destination')}</p>
        </Card>
      ) : (
        <Card>
          <Row label={t('miniapp.card_number')} value={<Ltr>{destination.cardNumber}</Ltr>} />
          {destination.holderName !== null && (
            <p className="muted">{t('miniapp.card_holder', { holder: destination.holderName })}</p>
          )}
          {destination.bankName !== null && (
            <p className="muted">{t('miniapp.card_bank', { bank: destination.bankName })}</p>
          )}
          <Button onClick={() => copy('card', destination.copyCardNumber)}>
            {copied === 'card' ? t('miniapp.copied') : t('miniapp.card_copy')}
          </Button>
        </Card>
      )}
      <Card>
        <Row label={t('miniapp.card_reference')} value={<Ltr>{instruction.reference}</Ltr>} />
        {instruction.expiresAt !== null && (
          <p className="muted">{t('miniapp.card_deadline', { at: dateTime(instruction.expiresAt) })}</p>
        )}
      </Card>
      <Card>
        <label className={busy ? 'btn btn-primary btn-busy' : 'btn btn-primary'}>
          {busy ? t('miniapp.card_receipt_sending') : t('miniapp.card_receipt_pick')}
          <input
            className="visually-hidden"
            type="file"
            accept={MINIAPP_RECEIPT_IMAGE_TYPES.join(',')}
            disabled={busy}
            onChange={(event) => void upload(event)}
          />
        </label>
        <p className="muted">{t('miniapp.card_receipt_hint')}</p>
        {error !== null && <p className="error">{error}</p>}
      </Card>
    </main>
  );
}

/** The file as base64, without the data-URL prefix. */
function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}
