import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FeatureFlagResponse } from '@nexa/contracts';
import { fetchFeatureFlags, saveFeatureFlag } from '../api/client';
import { useSubmissionKey } from '../submission-key';
import { t } from '../i18n/web.fa';
import { ErrorReport } from './settings';
import { Badge, Banner, Card, DataTable, Ltr, PageHead, StateSwitch } from '../ui/kit';

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
export function FeaturesPage({ mayEdit, denied }: { mayEdit: boolean; denied: boolean }) {
  const flags = useQuery({ queryKey: ['features'], queryFn: fetchFeatureFlags, enabled: !denied });
  const rows = flags.data?.flags ?? [];

  return (
    <>
      <PageHead title={t('web.features_title')} subtitle={t('web.features_intro')} maturity="now" />
      <StateSwitch query={flags} denied={denied} isEmpty={rows.length === 0}>
        {rows.map((flag) => (
          <FlagCard key={flag.key} flag={flag} mayEdit={mayEdit} />
        ))}
      </StateSwitch>
    </>
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
    // The WHOLE command travels as the variable; see the note in
    // `settings.tsx`. Reading `confirmKey` and `reason` out of the closure
    // would let a retry carry the original key with a later reason.
    mutationFn: (
      command: {
        idempotencyKey: string;
        enabled: boolean;
        expectedVersion: number | null;
      } & Partial<{ confirmKey: string; reason: string }>,
    ) => saveFeatureFlag({ key: flag.key, ...command }),
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
    // Snapshotted at the click, so a retry cannot see a later edit.
    const command = {
      enabled: !flag.enabled,
      expectedVersion: flag.version,
      ...(wide ? { confirmKey, reason } : {}),
    };
    toggle.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  return (
    <Card
      title={flag.key}
      actions={
        <>
          <Badge tone={flag.enabled ? 'ok' : 'neutral'}>
            {flag.enabled ? t('web.enabled') : t('web.disabled')}
          </Badge>
          {wide && <Badge tone="danger">{t('web.tenant_wide')}</Badge>}
        </>
      }
    >
      <form onSubmit={onSubmit}>
        <p className="muted small">{flag.description}</p>

        {flag.reason !== null && flag.reason !== '' && (
          <p className="faint small">
            {t('web.confirm_reason')}: <span className="plain">{flag.reason}</span>
          </p>
        )}

        {flag.configuration.length > 0 && (
          <DataTable
            caption={t('web.features_title')}
            rows={flag.configuration}
            rowKey={(setting) => setting.key}
            columns={[
              {
                key: 'key',
                header: t('web.key'),
                render: (setting) => (
                  <div className={setting.inert ? 'inert' : undefined}>
                    <Ltr>{setting.key}</Ltr>
                    {setting.inert && <p className="muted small">{t('web.inert')}</p>}
                    {setting.storedValueInvalid && (
                      <p className="danger small">{t('web.stored_value_invalid')}</p>
                    )}
                  </div>
                ),
              },
              {
                key: 'value',
                header: t('web.value'),
                render: (setting) => <Ltr>{displayValue(setting.value)}</Ltr>,
              },
              {
                key: 'source',
                header: t('web.source'),
                render: (setting) =>
                  setting.source === 'TENANT' ? t('web.source_tenant') : t('web.source_default'),
              },
            ]}
          />
        )}

        {mayEdit && wide && (
          <>
            <Banner tone="warn">{t('web.confirm_required')}</Banner>
            <label htmlFor={`confirm-${flag.key}`}>{t('web.confirm_key')}</label>
            <input
              id={`confirm-${flag.key}`}
              className="input ltr mono"
              value={confirmKey}
              onChange={(event) => setConfirmKey(event.target.value)}
              placeholder={flag.key}
            />
            <label htmlFor={`reason-${flag.key}`}>{t('web.confirm_reason')}</label>
            <input
              id={`reason-${flag.key}`}
              className="input"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </>
        )}

        {mayEdit && (
          <button type="submit" className="btn primary" disabled={toggle.isPending}>
            {toggle.isPending ? t('web.saving') : flag.enabled ? t('web.disable') : t('web.enable')}
          </button>
        )}
        {toggle.isError && <ErrorReport error={toggle.error} />}
      </form>
    </Card>
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
