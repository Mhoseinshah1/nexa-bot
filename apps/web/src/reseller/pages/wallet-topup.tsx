import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MINIAPP_RECEIPT_MAX_BYTES, type MoneyWire } from '@nexa/contracts';
import { errorText } from '../../error-text';
import { currencyLabel, formatMoneyText, formatNumber } from '../../format';
import { t } from '../../i18n/web.fa';
import {
  Badge,
  Banner,
  Button,
  CopyButton,
  Field,
  Input,
  StateSwitch,
  useToast,
} from '../../ui/kit';
import {
  fetchWallet,
  markTransferSent,
  newIdempotencyKey,
  quoteTopup,
  startTopup,
  uploadReceipt,
} from '../api';
import { parseAmount } from '../money-input';
import { RpCard } from '../view';

export const WALLET_KEY = ['reseller', 'wallet'] as const;

type TopupOutcome = Awaited<ReturnType<typeof startTopup>>;
type Quote = Awaited<ReturnType<typeof quoteTopup>>;

/** Reads a chosen receipt image as base64 (no `data:` prefix), refusing one over the limit. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const text = String(reader.result);
      resolve(text.slice(text.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * «شارژ کیف پول»: an amount, then the tenant's enabled methods (the quote answers with them and
 * the bot's own fees — this form has no fee logic), then the method's own next step: a gateway
 * page, or the card-to-card instruction with its receipt upload.
 */
export function TopupCard() {
  const wallet = useQuery({ queryKey: WALLET_KEY, queryFn: fetchWallet });
  const toast = useToast();
  const [custom, setCustom] = useState('');
  const [amount, setAmount] = useState<MoneyWire | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<TopupOutcome | null>(null);
  const topupKey = useRef(newIdempotencyKey());

  const currency = wallet.data?.balance.currency ?? null;
  const pickAmount = (next: MoneyWire | null) => {
    setAmount(next);
    setQuote(null);
    setProvider(null);
    setOutcome(null);
    topupKey.current = newIdempotencyKey();
  };

  const ask = useMutation({
    mutationFn: (value: MoneyWire) => quoteTopup(value),
    onSuccess: setQuote,
    onError: (error) => toast({ tone: 'danger', message: errorText(error), error }),
  });
  const start = useMutation({
    mutationFn: () => {
      if (amount === null || provider === null) throw new Error('No method chosen.');
      return startTopup(amount, provider, topupKey.current);
    },
    onSuccess: setOutcome,
    onError: (error) => toast({ tone: 'danger', message: errorText(error), error }),
  });

  const data = wallet.data;
  return (
    <RpCard
      title={t('web.rp_topup_title')}
      hint={
        data === undefined
          ? undefined
          : t('web.rp_topup_current').replace('{amount}', formatMoneyText(data.balance))
      }
    >
      <StateSwitch query={wallet}>
        {data !== undefined && currency !== null && (
          <div className="rp-stack">
            <Field label={t('web.rp_topup_amount')}>
              <div className="rp-chips" role="group" aria-label={t('web.rp_topup_amount')}>
                {data.presets.map((preset) => (
                  <button
                    key={preset.amountMinor}
                    type="button"
                    className={`rp-chip${amount?.amountMinor === preset.amountMinor ? ' on' : ''}`}
                    aria-pressed={amount?.amountMinor === preset.amountMinor}
                    onClick={() => {
                      setCustom('');
                      pickAmount(preset);
                    }}
                  >
                    {formatMoneyText(preset)}
                  </button>
                ))}
              </div>
            </Field>
            <Field
              label={t('web.rp_topup_custom')}
              htmlFor="rp-topup-custom"
              hint={t('web.rp_topup_custom_hint').replace('{unit}', currencyLabel(currency))}
            >
              <Input
                id="rp-topup-custom"
                dir="ltr"
                inputMode="decimal"
                value={custom}
                onChange={(event) => {
                  setCustom(event.target.value);
                  pickAmount(parseAmount(event.target.value, currency));
                }}
              />
            </Field>
            <div>
              <Button
                variant="primary"
                disabled={amount === null || ask.isPending}
                onClick={() => amount !== null && ask.mutate(amount)}
              >
                {t('web.rp_topup_continue')}
              </Button>
            </div>
            {quote?.outcome === 'BELOW_MINIMUM' && (
              <Banner tone="warn">
                {t('web.rp_topup_below_min').replace('{amount}', formatMoneyText(quote.minimum))}
              </Banner>
            )}
            {quote?.outcome === 'ABOVE_MAXIMUM' && (
              <Banner tone="warn">
                {t('web.rp_topup_above_max').replace('{amount}', formatMoneyText(quote.maximum))}
              </Banner>
            )}
            {quote?.outcome === 'ROUTES' && (
              <Methods
                quote={quote}
                provider={provider}
                onPick={(next) => {
                  setProvider(next);
                  setOutcome(null);
                  topupKey.current = newIdempotencyKey();
                }}
                busy={start.isPending}
                onPay={() => start.mutate()}
              />
            )}
            {outcome !== null && <TopupResult outcome={outcome} />}
          </div>
        )}
      </StateSwitch>
    </RpCard>
  );
}

function Methods({
  quote,
  provider,
  onPick,
  busy,
  onPay,
}: {
  quote: Extract<Quote, { outcome: 'ROUTES' }>;
  provider: string | null;
  onPick: (provider: string) => void;
  busy: boolean;
  onPay: () => void;
}) {
  if (quote.routes.length === 0) return <Banner tone="info">{t('web.rp_topup_no_routes')}</Banner>;
  return (
    <div className="rp-stack">
      <b>{t('web.rp_topup_methods')}</b>
      <div className="rp-options" role="radiogroup" aria-label={t('web.rp_topup_methods')}>
        {quote.routes.map((route) => (
          <button
            key={route.provider}
            type="button"
            role="radio"
            aria-checked={provider === route.provider}
            disabled={route.paysInChat}
            className={`rp-option${provider === route.provider ? ' on' : ''}`}
            onClick={() => onPick(route.provider)}
          >
            <span>
              <b>{route.name}</b>
              {route.paysInChat && <span className="muted small">{t('web.rp_topup_in_chat')}</span>}
            </span>
            {route.giftPercent > 0 && (
              <Badge tone="ok">
                {t('web.rp_topup_gift').replace('{n}', formatNumber(route.giftPercent))}
              </Badge>
            )}
          </button>
        ))}
      </div>
      <div>
        <Button variant="primary" disabled={provider === null || busy} onClick={onPay}>
          {t('web.rp_topup_pay')}
        </Button>
      </div>
    </div>
  );
}

function TopupResult({ outcome }: { outcome: TopupOutcome }) {
  if (outcome.kind === 'GATEWAY') {
    const { attempt } = outcome;
    if (attempt.paysInChat) return <Banner tone="info">{t('web.rp_topup_gateway_chat')}</Banner>;
    if (attempt.invoiceReady && attempt.payUrl !== null) {
      return (
        <div className="rp-stack">
          <Banner tone="ok">{t('web.rp_topup_gateway_ready')}</Banner>
          <a
            className="btn primary"
            href={attempt.payUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('web.rp_topup_gateway_open')}
          </a>
        </div>
      );
    }
    return <Banner tone="info">{t('web.rp_topup_gateway_waiting')}</Banner>;
  }
  return <CardInstruction instruction={outcome.instruction} />;
}

function CardInstruction({
  instruction,
}: {
  instruction: Extract<TopupOutcome, { kind: 'CARD_TO_CARD' }>['instruction'];
}) {
  const toast = useToast();
  const client = useQueryClient();
  const [receiptWindow, setReceiptWindow] = useState<number | null | undefined>(undefined);
  const [filed, setFiled] = useState(false);
  const [tooBig, setTooBig] = useState(false);
  const file = useRef<File | null>(null);
  const keys = useRef({ sent: newIdempotencyKey(), receipt: newIdempotencyKey() });

  const sent = useMutation({
    mutationFn: () => markTransferSent(instruction.paymentId, keys.current.sent),
    onSuccess: (answer) => setReceiptWindow(answer.receiptWindowMinutes),
    onError: (error) => toast({ tone: 'danger', message: errorText(error), error }),
  });
  const receipt = useMutation({
    mutationFn: async () => {
      const chosen = file.current;
      if (chosen === null) throw new Error('No receipt chosen.');
      return uploadReceipt(
        instruction.paymentId,
        { imageBase64: await readBase64(chosen), mimeType: chosen.type || 'image/jpeg' },
        keys.current.receipt,
      );
    },
    onSuccess: () => {
      setFiled(true);
      void client.invalidateQueries({ queryKey: ['reseller', 'wallet'] });
    },
    onError: (error) => toast({ tone: 'danger', message: errorText(error), error }),
  });

  const destination = instruction.destination;
  return (
    <div className="rp-mini rp-stack" aria-label={t('web.rp_card_title')}>
      <b>{t('web.rp_card_title')}</b>
      <dl className="rp-kv">
        <dt>{t('web.rp_card_amount')}</dt>
        <dd>
          <span dir="ltr">{formatMoneyText(instruction.amount)}</span>
          <CopyButton value={instruction.copyAmount} />
        </dd>
        {destination !== null && (
          <>
            <dt>{t('web.rp_card_number')}</dt>
            <dd>
              <span dir="ltr" className="rp-mono">
                {destination.cardNumber}
              </span>
              <CopyButton value={destination.copyCardNumber} />
            </dd>
            {destination.holderName !== null && (
              <>
                <dt>{t('web.rp_card_holder')}</dt>
                <dd>{destination.holderName}</dd>
              </>
            )}
            {destination.bankName !== null && (
              <>
                <dt>{t('web.rp_card_bank')}</dt>
                <dd>{destination.bankName}</dd>
              </>
            )}
          </>
        )}
        <dt>{t('web.rp_card_reference')}</dt>
        <dd>
          <span dir="ltr" className="rp-mono">
            {instruction.reference}
          </span>
          <CopyButton value={instruction.reference} />
        </dd>
      </dl>
      {receiptWindow === undefined ? (
        <div>
          <Button variant="primary" disabled={sent.isPending} onClick={() => sent.mutate()}>
            {t('web.rp_card_sent')}
          </Button>
        </div>
      ) : (
        <>
          <Banner tone="ok">{t('web.rp_card_sent_done')}</Banner>
          {receiptWindow !== null && (
            <p className="muted small">
              {t('web.rp_card_receipt_window').replace('{n}', formatNumber(receiptWindow))}
            </p>
          )}
          {filed ? (
            <Banner tone="ok">{t('web.rp_card_receipt_done')}</Banner>
          ) : (
            <div className="rp-stack">
              <Field label={t('web.rp_card_receipt_label')} htmlFor="rp-receipt">
                <input
                  id="rp-receipt"
                  className="input"
                  type="file"
                  accept="image/*"
                  onChange={(event) => {
                    const chosen = event.target.files?.[0] ?? null;
                    const big = chosen !== null && chosen.size > MINIAPP_RECEIPT_MAX_BYTES;
                    setTooBig(big);
                    file.current = big ? null : chosen;
                  }}
                />
              </Field>
              {tooBig && <Banner tone="warn">{t('web.rp_card_receipt_big')}</Banner>}
              <div>
                <Button disabled={receipt.isPending} onClick={() => receipt.mutate()}>
                  {t('web.rp_card_receipt_send')}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
