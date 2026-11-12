import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PANEL_PAGE_MAX, RESELLER_TRIAL_DAILY_QUOTA_MAX } from '@nexa/contracts';
import { fetchPanels, fetchSettings, saveSetting } from '../api/client';
import { errorText } from '../error-text';
import { t } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import { Banner, Button, Card, Field, Input, Select, StateSwitch } from '../ui/kit';
import { ErrorRef } from '../ui/technical-details';

const QUOTA_KEY = 'reseller.trial_daily_quota';
const PRODUCT_KEY = 'reseller.trial_product';

/**
 * «سرویس تست نماینده» on the resellers page: the two ordinary settings the reseller panel's
 * trial card reads — the daily quota (0–20, 0 is off) and the panel whose trial configuration is
 * issued. Each is saved through the ordinary settings write (version, key, audit), so this card
 * adds no write path of its own. Reading takes `settings.view`, writing `settings.edit`; the
 * panel list needs `panels.view`.
 */
export function ResellerTrialSettingsCard({
  maySettingsView,
  maySettingsEdit,
  mayViewPanels,
}: {
  maySettingsView: boolean;
  maySettingsEdit: boolean;
  mayViewPanels: boolean;
}) {
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    enabled: maySettingsView,
  });
  const panels = useQuery({
    queryKey: ['panels', 'for-reseller-trial'],
    queryFn: () => fetchPanels({ limit: PANEL_PAGE_MAX }),
    enabled: maySettingsView && mayViewPanels,
  });
  const all = settings.data?.settings ?? [];
  const quotaRow = all.find((row) => row.key === QUOTA_KEY);
  const productRow = all.find((row) => row.key === PRODUCT_KEY);
  const editable = maySettingsEdit && quotaRow !== undefined && productRow !== undefined;

  const quota = typeof quotaRow?.value === 'number' ? quotaRow.value : 0;
  const product = typeof productRow?.value === 'string' ? productRow.value : '';
  const [quotaText, setQuotaText] = useState(String(quota));
  useEffect(() => setQuotaText(String(quota)), [quota]);

  const quotaSubmission = useSubmissionKey();
  const productSubmission = useSubmissionKey();
  const save = useMutation({
    mutationFn: (command: {
      key: string;
      value: number | string | null;
      expectedVersion: number | null;
      idempotencyKey: string;
    }) => saveSetting(command),
    onSuccess: (_result, command) =>
      (command.key === QUOTA_KEY ? quotaSubmission : productSubmission).settle(),
    onError: (error, command) =>
      (command.key === QUOTA_KEY ? quotaSubmission : productSubmission).settleOn(error),
    onSettled: () => client.invalidateQueries({ queryKey: ['settings'] }),
  });

  const write = (row: typeof quotaRow, value: number | string | null) => {
    if (row === undefined) return;
    const command = { key: row.key, value, expectedVersion: row.version };
    const submission = row.key === QUOTA_KEY ? quotaSubmission : productSubmission;
    save.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  const parsed = /^[0-9]{1,2}$/u.test(quotaText.trim()) ? Number(quotaText.trim()) : null;
  const valid = parsed !== null && parsed >= 0 && parsed <= RESELLER_TRIAL_DAILY_QUOTA_MAX;

  if (!maySettingsView) return null;
  const panelRows = panels.data?.panels ?? [];
  return (
    <Card title={t('web.rp_trial_settings_title')} hint={t('web.rp_trial_settings_hint')}>
      <StateSwitch query={settings}>
        <div className="stack">
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid && parsed !== quota) write(quotaRow, parsed);
            }}
          >
            <Field
              label={t('web.rp_trial_settings_quota')}
              hint={t('web.rp_trial_settings_quota_hint')}
              htmlFor="reseller-trial-quota"
              {...(valid ? {} : { error: t('web.rp_trial_settings_quota_invalid') })}
            >
              <Input
                id="reseller-trial-quota"
                dir="ltr"
                inputMode="numeric"
                value={quotaText}
                disabled={!editable}
                onChange={(event) => setQuotaText(event.target.value)}
              />
            </Field>
            {editable && (
              <div>
                <Button
                  type="submit"
                  size="sm"
                  variant="primary"
                  disabled={!valid || parsed === quota || save.isPending}
                >
                  {t('web.rp_trial_settings_save')}
                </Button>
              </div>
            )}
          </form>
          {mayViewPanels ? (
            <Field
              label={t('web.rp_trial_settings_product')}
              hint={t('web.rp_trial_settings_product_hint')}
              htmlFor="reseller-trial-product"
            >
              <Select
                id="reseller-trial-product"
                value={product}
                disabled={!editable || save.isPending}
                onChange={(event) =>
                  write(productRow, event.target.value === '' ? null : event.target.value)
                }
              >
                <option value="">{t('web.rp_trial_settings_product_none')}</option>
                {product !== '' && panelRows.every((row) => row.id !== product) && (
                  <option value={product}>{product}</option>
                )}
                {panelRows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <p className="muted small">{t('web.rp_trial_settings_product_denied')}</p>
          )}
          {!maySettingsEdit && (
            <p className="muted small">{t('web.rp_trial_settings_read_only')}</p>
          )}
          {save.error !== null && (
            <Banner tone="danger">
              {errorText(save.error)}
              <ErrorRef error={save.error} />
            </Banner>
          )}
        </div>
      </StateSwitch>
    </Card>
  );
}
