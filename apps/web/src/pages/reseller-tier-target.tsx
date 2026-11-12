import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CURRENCY_EXPONENT,
  SALES_CURRENCY_CODES,
  type CurrencyCode,
  type ResellerTierTarget,
} from '@nexa/contracts';
import { fetchResellerTierTarget, saveResellerTierTarget } from '../api/client';
import { errorText } from '../error-text';
import { currencyLabel } from '../format';
import { t } from '../i18n/web.fa';
import { parseAmount } from '../reseller/money-input';
import { useSubmissionKey } from '../submission-key';
import { Banner, Button, Field, Input, Select, StateSwitch, useToast } from '../ui/kit';
import { ErrorRef } from '../ui/technical-details';

type Kind = 'NONE' | 'COUNT' | 'AMOUNT';

/** A stored amount back to what a person types: minor units scaled by the currency's exponent. */
function amountText(minor: string, currency: CurrencyCode): string {
  const exponent = CURRENCY_EXPONENT[currency];
  if (exponent === 0) return minor;
  const padded = minor.padStart(exponent + 1, '0');
  const whole = padded.slice(0, padded.length - exponent);
  const fraction = padded.slice(padded.length - exponent).replace(/0+$/u, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/**
 * «هدف سطح بعد»: the monthly goal a tier shows on the reseller panel's «پیشرفت تا سطح بعد»
 * card — a count of services or a sales amount. Display only: nothing changes a reseller's tier
 * because of it. Saved on its own endpoint (`resellers.edit`, a key, audited).
 */
export function TierTargetEditor({ tierId }: { tierId: string }) {
  const toast = useToast();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['reseller-tier-target', tierId],
    queryFn: () => fetchResellerTierTarget(tierId),
  });
  const stored = query.data?.target ?? null;
  const [kind, setKind] = useState<Kind>('NONE');
  const [value, setValue] = useState('');
  const [currency, setCurrency] = useState<CurrencyCode>(SALES_CURRENCY_CODES[0] ?? 'IRT');
  useEffect(() => {
    if (query.data === undefined) return;
    const target = query.data.target;
    setKind(target === null ? 'NONE' : target.kind);
    if (target?.kind === 'COUNT') setValue(String(target.count));
    else if (target?.kind === 'AMOUNT') {
      setValue(amountText(target.amount.amountMinor, target.amount.currency));
      setCurrency(target.amount.currency);
    } else setValue('');
  }, [query.data]);

  const count = /^[0-9]{1,7}$/u.test(value.trim()) ? Number(value.trim()) : null;
  const amount = kind === 'AMOUNT' ? parseAmount(value, currency) : null;
  const target: ResellerTierTarget | null | undefined =
    kind === 'NONE'
      ? null
      : kind === 'COUNT'
        ? count !== null && count >= 1 && count <= 1_000_000
          ? { kind: 'COUNT', count }
          : undefined
        : amount === null
          ? undefined
          : { kind: 'AMOUNT', amount };

  const submission = useSubmissionKey();
  const save = useMutation({
    mutationFn: () => {
      if (target === undefined) throw new Error('unreachable: guarded by the save button');
      return saveResellerTierTarget(tierId, {
        target,
        idempotencyKey: submission.current({ tierId, target }),
      });
    },
    onError: (error) => submission.settleOn(error),
    onSuccess: () => {
      submission.settle();
      toast({ tone: 'ok', message: t('web.rp_admin_target_saved') });
      void client.invalidateQueries({ queryKey: ['reseller-tier-target', tierId] });
    },
  });
  const unchanged = JSON.stringify(target ?? null) === JSON.stringify(stored);

  return (
    <section className="stack" aria-label={t('web.rp_admin_target_title')}>
      <h3>{t('web.rp_admin_target_title')}</h3>
      <p className="muted small">{t('web.rp_admin_target_hint')}</p>
      <StateSwitch query={query}>
        <Field label={t('web.rp_admin_target_kind')} htmlFor={`tier-target-kind-${tierId}`}>
          <Select
            id={`tier-target-kind-${tierId}`}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as Kind);
              setValue('');
            }}
          >
            <option value="NONE">{t('web.rp_admin_target_none')}</option>
            <option value="COUNT">{t('web.rp_admin_target_count')}</option>
            <option value="AMOUNT">{t('web.rp_admin_target_amount')}</option>
          </Select>
        </Field>
        {kind !== 'NONE' && (
          <Field label={t('web.rp_admin_target_value')} htmlFor={`tier-target-value-${tierId}`}>
            <Input
              id={`tier-target-value-${tierId}`}
              dir="ltr"
              inputMode={kind === 'COUNT' ? 'numeric' : 'decimal'}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
        )}
        {kind === 'AMOUNT' && (
          <Field
            label={t('web.rp_admin_target_currency')}
            htmlFor={`tier-target-currency-${tierId}`}
          >
            <Select
              id={`tier-target-currency-${tierId}`}
              value={currency}
              onChange={(event) => setCurrency(event.target.value as CurrencyCode)}
            >
              {SALES_CURRENCY_CODES.map((code) => (
                <option key={code} value={code}>
                  {currencyLabel(code)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div>
          <Button
            size="sm"
            disabled={target === undefined || unchanged || save.isPending}
            onClick={() => save.mutate()}
          >
            {t('web.rp_admin_target_save')}
          </Button>
        </div>
        {save.error !== null && (
          <Banner tone="danger">
            {errorText(save.error)}
            <ErrorRef error={save.error} />
          </Banner>
        )}
      </StateSwitch>
    </section>
  );
}
