import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LATE_CREDIT_WINDOW_HOURS_DEFAULT,
  LATE_CREDIT_WINDOW_HOURS_MAX,
  LATE_CREDIT_WINDOW_HOURS_MIN,
  LATE_CREDIT_WINDOW_SETTING_KEY,
  PAYMENT_GATEWAY_DESCRIPTORS,
  type PaymentGatewayProvider,
  type ResolvedSettingResponse,
} from '@nexa/contracts';
import { fetchSettings, saveSetting } from '../api/client';
import { useSubmissionKey } from '../submission-key';
import { t } from '../i18n/web.fa';
import { Banner, Card, Field, Input, StateSwitch, ToggleRow } from '../ui/kit';
import { errorText } from '../error-text';
import { ErrorRef } from '../ui/technical-details';

/**
 * «پرداخت دیرهنگام را خودکار به کیف پول واریز کن» — R5A item 4, on the page of each gateway
 * that supports it (TonPays, TonPays Telegram).
 *
 * Two registry values, each saved on its own through the ordinary settings write — the
 * version it was read at, an idempotency key, audit — so this card adds no write path of its
 * own: the route's on/off switch (named by the route's descriptor, `lateCreditSetting`), and
 * the one window, in hours, for which a closed payment's open invoice keeps being asked about.
 *
 * Reading takes `settings.view` and writing `settings.edit`, the keys the server charges.
 */
export function LateCreditCard({
  provider,
  maySettingsView,
  maySettingsEdit,
}: {
  provider: PaymentGatewayProvider;
  maySettingsView: boolean;
  maySettingsEdit: boolean;
}) {
  const switchKey = PAYMENT_GATEWAY_DESCRIPTORS[provider].lateCreditSetting;
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    enabled: maySettingsView && switchKey !== null,
  });
  const all = settings.data?.settings ?? [];
  const switchRow = all.find((row) => row.key === switchKey);
  const windowRow = all.find((row) => row.key === LATE_CREDIT_WINDOW_SETTING_KEY);
  const editable = maySettingsEdit && switchRow !== undefined && windowRow !== undefined;

  const hours =
    typeof windowRow?.value === 'number' ? windowRow.value : LATE_CREDIT_WINDOW_HOURS_DEFAULT;
  const [hoursText, setHoursText] = useState(String(hours));
  // Follow the server when it changes under us (another administrator, a reset).
  useEffect(() => setHoursText(String(hours)), [hours]);

  const switchSubmission = useSubmissionKey();
  const windowSubmission = useSubmissionKey();
  const save = useMutation({
    mutationFn: (command: {
      key: string;
      value: boolean | number;
      expectedVersion: number | null;
      idempotencyKey: string;
    }) => saveSetting(command),
    onSuccess: (_result, command) =>
      (command.key === switchKey ? switchSubmission : windowSubmission).settle(),
    onError: (error, command) =>
      (command.key === switchKey ? switchSubmission : windowSubmission).settleOn(error),
    onSettled: () => client.invalidateQueries({ queryKey: ['settings'] }),
  });

  if (switchKey === null || !maySettingsView) return null;

  /*
   * One key per logical attempt (`useSubmissionKey`): a re-press after a lost answer is the
   * same command with the same key, and any other value or version is a new one.
   */
  const write = (row: ResolvedSettingResponse | undefined, value: boolean | number) => {
    if (row === undefined) return;
    const command = { key: row.key, value, expectedVersion: row.version };
    const submission = row.key === switchKey ? switchSubmission : windowSubmission;
    save.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  const parsed = /^[0-9]{1,4}$/u.test(hoursText.trim()) ? Number(hoursText.trim()) : null;
  const valid =
    parsed !== null &&
    parsed >= LATE_CREDIT_WINDOW_HOURS_MIN &&
    parsed <= LATE_CREDIT_WINDOW_HOURS_MAX;

  return (
    <Card title={t('web.late_credit_title')} hint={t('web.late_credit_hint')}>
      <StateSwitch query={settings} denied={false}>
        <div className="stack">
          <ToggleRow
            title={t('web.late_credit_switch')}
            description={t('web.late_credit_switch_hint')}
            checked={switchRow?.value === true}
            disabled={!editable || save.isPending}
            onChange={(next) => write(switchRow, next)}
          />
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid && parsed !== hours) write(windowRow, parsed);
            }}
          >
            <Field
              label={t('web.late_credit_window')}
              hint={t('web.late_credit_window_hint')}
              htmlFor="late-credit-window"
              {...(valid ? {} : { error: t('web.late_credit_window_invalid') })}
            >
              <Input
                id="late-credit-window"
                inputMode="numeric"
                value={hoursText}
                disabled={!editable}
                onChange={(event) => setHoursText(event.target.value)}
              />
            </Field>
            {editable && (
              <div className="btn-group">
                <button
                  type="submit"
                  className="btn primary"
                  disabled={!valid || parsed === hours || save.isPending}
                >
                  {t('web.late_credit_window_save')}
                </button>
              </div>
            )}
          </form>
          {!maySettingsEdit && <p className="muted small">{t('web.late_credit_read_only')}</p>}
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
