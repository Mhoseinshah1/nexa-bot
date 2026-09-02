import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FeatureFlagResponse } from '@nexa/contracts';
import { fetchFeatureFlags, saveFeatureFlag } from '../api/client';
import { useSubmissionKey } from '../submission-key';
import { t } from '../i18n/web.fa';
import { ErrorReport, messageFor } from './settings';

/**
 * The feature-flag screen.
 *
 * Each flag is drawn with the settings it governs, and a setting whose flag is
 * off is labelled inert. In the legacy system the balance-warning flag and its
 * threshold sit on different screens, the flag is off, and nothing on either
 * screen says that the value therefore does nothing (CBR-007, GSR-008).
 *
 * A flag whose blast radius is TENANT_WIDE is drawn differently from one that is
 * not, and asks for the flag's own key to be typed plus a reason. The legacy
 * capability screen renders the whole-bot kill switch identically to the dice
 * toggle and takes one press (CBR-009).
 */
export function FeaturesPage({ mayEdit }: { mayEdit: boolean }) {
  const flags = useQuery({ queryKey: ['features'], queryFn: fetchFeatureFlags });

  return (
    <section>
      <h2>{t('web.features_title')}</h2>
      <p className="notice">{t('web.features_intro')}</p>

      {flags.isPending && <p>{t('web.loading')}</p>}
      {flags.isError && <p className="error">{messageFor(flags.error)}</p>}

      {flags.data?.flags.map((flag) => (
        <FlagCard key={flag.key} flag={flag} mayEdit={mayEdit} />
      ))}
    </section>
  );
}

function FlagCard({ flag, mayEdit }: { flag: FeatureFlagResponse; mayEdit: boolean }) {
  const client = useQueryClient();
  const wide = flag.blastRadius === 'TENANT_WIDE';
  const [confirmKey, setConfirmKey] = useState('');
  const [reason, setReason] = useState('');

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['features'] });
    await client.invalidateQueries({ queryKey: ['settings'] });
  };

  const submission = useSubmissionKey();

  const toggle = useMutation({
    // Minted once per submission and passed as a variable, so a retry carries
    // the key the first attempt used.
    mutationFn: (idempotencyKey: string) =>
      saveFeatureFlag({
        key: flag.key,
        enabled: !flag.enabled,
        expectedVersion: flag.version,
        idempotencyKey,
        ...(wide ? { confirmKey, reason } : {}),
      }),
    onSuccess: async () => {
      submission.settle();
      setConfirmKey('');
      setReason('');
      await refresh();
    },
    // A conflict means the cached row is stale; refreshing is what makes a
    // second attempt able to succeed.
    onError: (error: unknown) => {
      submission.settleOn(error);
      void refresh();
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    toggle.mutate(submission.current());
  };

  return (
    <form className={wide ? 'card wide' : 'card'} onSubmit={onSubmit}>
      <h3>
        <code>{flag.key}</code>
        <span className={flag.enabled ? 'up' : 'down'}>
          {flag.enabled ? t('web.enabled') : t('web.disabled')}
        </span>
        {wide && <span className="tag danger">{t('web.tenant_wide')}</span>}
      </h3>
      <p>{flag.description}</p>

      {flag.reason && (
        <p className="meta">
          {t('web.confirm_reason')}: {flag.reason}
        </p>
      )}

      {flag.configuration.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{t('web.key')}</th>
              <th>{t('web.value')}</th>
              <th>{t('web.source')}</th>
            </tr>
          </thead>
          <tbody>
            {flag.configuration.map((setting) => (
              <tr key={setting.key} className={setting.inert ? 'inert' : undefined}>
                <td>
                  <code>{setting.key}</code>
                  {setting.inert && <p className="notice">{t('web.inert')}</p>}
                  {setting.storedValueInvalid && (
                    <p className="error">{t('web.stored_value_invalid')}</p>
                  )}
                </td>
                <td>{displayValue(setting.value)}</td>
                <td>
                  {setting.source === 'TENANT' ? t('web.source_tenant') : t('web.source_default')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {mayEdit && wide && (
        <>
          <p className="notice">{t('web.confirm_required')}</p>
          <label htmlFor={`confirm-${flag.key}`}>{t('web.confirm_key')}</label>
          <input
            id={`confirm-${flag.key}`}
            value={confirmKey}
            onChange={(event) => setConfirmKey(event.target.value)}
            placeholder={flag.key}
          />
          <label htmlFor={`reason-${flag.key}`}>{t('web.confirm_reason')}</label>
          <input
            id={`reason-${flag.key}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </>
      )}

      {mayEdit && (
        <button type="submit" disabled={toggle.isPending}>
          {toggle.isPending ? t('web.saving') : flag.enabled ? t('web.disable') : t('web.enable')}
        </button>
      )}
      {toggle.isError && <ErrorReport error={toggle.error} />}
    </form>
  );
}

/**
 * A setting value as a table cell.
 *
 * `String(null)` is the four characters "null", which reads as a stored value
 * rather than as an absent one — the same class of confusion as a screen that
 * shows a default as though somebody had chosen it. An em dash says "nothing
 * here" and cannot be mistaken for content.
 */
function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
