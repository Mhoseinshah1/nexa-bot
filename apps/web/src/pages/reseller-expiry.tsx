import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchCustomerReseller, setResellerExpiry } from '../api/client';
import { formatTimestamp } from '../format';
import { t } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import { DateField } from '../ui/date-field';
import { Banner, Card, Field, useToast } from '../ui/kit';
import { ErrorRef } from '../ui/technical-details';
import { fromLocalInput } from './incidents';
import { messageFor } from './settings';

/**
 * Round 11, C2: a reseller's own expiry date, on the reseller's standing (never on a tier —
 * a tier is shared and expiring it would suspend everyone in it).
 *
 * The server decides everything that matters: a date must be in the future, and setting one
 * on a reseller the EXPIRY suspended re-activates them (an administrator's suspension is left
 * alone — the notes below say which of the two this reseller is). Nothing here moves money.
 * The key is held until the server answers, so a retry after a lost response is the same
 * command.
 */
export function ResellerExpiryCard({
  customerId,
  mayEdit,
}: {
  customerId: string;
  mayEdit: boolean;
}) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [draft, setDraft] = useState('');
  const reseller = useQuery({
    queryKey: ['customer-reseller', customerId],
    queryFn: () => fetchCustomerReseller(customerId),
  });
  const row = reseller.data?.reseller;

  const when = fromLocalInput(draft);
  const past = when !== null && new Date(when).getTime() <= Date.now();

  const save = useMutation({
    mutationFn: (expiresAt: string | null) => {
      const idempotencyKey = submission.current({ customerId, expiresAt });
      return setResellerExpiry({ customerId, idempotencyKey, expiresAt });
    },
    onSuccess: (response, expiresAt) => {
      submission.settle();
      queries.setQueryData(['customer-reseller', customerId], response);
      void queries.invalidateQueries({ queryKey: ['resellers'] });
      void queries.invalidateQueries({ queryKey: ['reseller-policy', customerId] });
      void queries.invalidateQueries({ queryKey: ['reseller-history', customerId] });
      setDraft('');
      notify({
        tone: 'ok',
        message: t(
          expiresAt === null ? 'web.reseller_expiry_cleared' : 'web.reseller_expiry_saved',
        ),
      });
    },
    onError: (error) => submission.settleOn(error),
  });

  if (row === undefined) return null;
  return (
    <Card title={t('web.reseller_expiry_title')} hint={t('web.reseller_expiry_hint')}>
      <p>
        {t('web.reseller_expiry_current')}{' '}
        {row.expiresAt === null ? t('web.reseller_expiry_none') : formatTimestamp(row.expiresAt)}
      </p>
      {row.status === 'SUSPENDED' && row.suspendedByExpiry && (
        <Banner tone="warn">{t('web.reseller_expiry_reactivates')}</Banner>
      )}
      {row.status === 'SUSPENDED' && !row.suspendedByExpiry && (
        <Banner tone="info">{t('web.reseller_expiry_manual_suspended')}</Banner>
      )}
      {mayEdit && (
        <>
          <Field label={t('web.reseller_expiry_field')} htmlFor={`reseller-expiry-${customerId}`}>
            <DateField
              id={`reseller-expiry-${customerId}`}
              mode="datetime"
              value={draft}
              onChange={setDraft}
            />
          </Field>
          {past && <Banner tone="warn">{t('web.reseller_expiry_past')}</Banner>}
          <div className="form-actions">
            <button
              type="button"
              className="btn primary sm"
              disabled={when === null || past || save.isPending}
              onClick={() => when !== null && save.mutate(when)}
            >
              {t('web.reseller_expiry_save')}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={row.expiresAt === null || save.isPending}
              onClick={() => save.mutate(null)}
            >
              {t('web.reseller_expiry_clear')}
            </button>
          </div>
          {save.error !== null && (
            <Banner tone="danger">
              {messageFor(save.error)}
              <ErrorRef error={save.error} />
            </Banner>
          )}
        </>
      )}
    </Card>
  );
}
