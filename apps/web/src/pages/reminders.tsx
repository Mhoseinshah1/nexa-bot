import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PENDING_PAYMENT_REMINDER_MINUTES_MAX,
  PENDING_PAYMENT_REMINDER_MINUTES_MIN,
  USAGE_REMINDER_PERCENT_MAX,
  usageRemainingPercent,
  type FeatureFlagResponse,
  type MoneyWire,
  type ResolvedSettingResponse,
  type SalesCurrencyCode,
  type TemplateViewResponse,
} from '@nexa/contracts';
import {
  fetchFeatureFlags,
  fetchSettings,
  fetchTemplates,
  saveFeatureFlag,
  saveSetting,
} from '../api/client';
import { currencyLabel, formatMoneyText } from '../format';
import { useSubmissionKey } from '../submission-key';
import { t } from '../i18n/web.fa';
import { Badge, Banner, Card, Field, PageHead, StateSwitch, Switch } from '../ui/kit';
import { ErrorReport } from './settings';
import { TemplateCard } from './content';

/**
 * WP-A9: the reminders screen — every automated customer reminder on one page.
 *
 * Four families, each with its switch, its schedule as a human quantity (days, percent
 * REMAINING, an amount, minutes — never a cron expression) and the template it sends,
 * editable in place through the same template card the texts screen uses.
 *
 * Nothing here is a second source of truth. Every value is a registry setting or feature
 * flag read from and written to the SAME endpoints the settings and features screens use,
 * with the version it was read at, so a concurrent edit is a conflict and not a silent
 * overwrite; the server's own guard decides what is valid and its Persian refusal is shown
 * verbatim. The only conversion is presentation: the three usage thresholds are STORED as
 * percent used and shown and typed as percent remaining, through `usageRemainingPercent`.
 *
 * Quiet hours are not offered: the customer notification lane has no send-window concept
 * to configure, and inventing one is outside this package.
 */
export function RemindersPage({
  mayEdit,
  denied,
  mayViewTemplates,
  mayEditTemplates,
}: {
  mayEdit: boolean;
  denied: boolean;
  mayViewTemplates: boolean;
  mayEditTemplates: boolean;
}) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings, enabled: !denied });
  const flags = useQuery({ queryKey: ['features'], queryFn: fetchFeatureFlags, enabled: !denied });
  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: fetchTemplates,
    enabled: !denied && mayViewTemplates,
  });

  const settingOf = (key: string) => settings.data?.settings.find((one) => one.key === key);
  const flagOf = (key: string) => flags.data?.flags.find((one) => one.key === key);
  const templatesOf = (keys: readonly string[]) =>
    (templates.data?.templates ?? []).filter((one) => keys.includes(one.key));

  const ready = settings.data !== undefined && flags.data !== undefined;
  const early = settingOf('reminders.expiry_early_days');
  const first = settingOf('reminders.expiry_first_days');
  const earlyInert =
    typeof early?.value === 'number' &&
    typeof first?.value === 'number' &&
    early.value > 0 &&
    early.value <= first.value;
  const selling = (settingOf('sales.currency')?.value ?? 'IRT') as SalesCurrencyCode;

  const templateBlock = (keys: readonly string[]) => (
    <TemplateBlock
      templates={templatesOf(keys)}
      mayView={mayViewTemplates}
      mayEdit={mayEditTemplates}
    />
  );

  return (
    <>
      <PageHead title={t('web.reminders_title')} subtitle={t('web.reminders_intro')} />
      <StateSwitch query={settings} denied={denied} isEmpty={false}>
        {ready && (
          <>
            <Card title={t('web.reminders_expiry_title')} hint={t('web.reminders_expiry_hint')}>
              <FlagRow
                flag={flagOf('service_expiry_reminders')}
                label={t('web.reminders_flag_expiry')}
                mayEdit={mayEdit}
              />
              <FlagRow
                flag={flagOf('service_expiry_day_reminder')}
                label={t('web.reminders_flag_expiry_day')}
                hint={t('web.reminders_day_hint')}
                mayEdit={mayEdit}
              />
              <FlagRow
                flag={flagOf('service_expired_notice')}
                label={t('web.reminders_flag_expired')}
                mayEdit={mayEdit}
              />
              <NumberRow
                setting={early}
                label={t('web.reminders_early_days')}
                hint={t('web.reminders_early_days_hint')}
                unit={t('web.reminders_unit_days')}
                min={0}
                max={30}
                mayEdit={mayEdit}
              />
              {earlyInert && <Banner tone="warn">{t('web.reminders_early_inert')}</Banner>}
              <NumberRow
                setting={first}
                label={t('web.reminders_first_days')}
                hint={t('web.reminders_days_hint')}
                unit={t('web.reminders_unit_days')}
                min={1}
                max={30}
                mayEdit={mayEdit}
              />
              <NumberRow
                setting={settingOf('reminders.expiry_second_days')}
                label={t('web.reminders_second_days')}
                hint={t('web.reminders_days_hint')}
                unit={t('web.reminders_unit_days')}
                min={1}
                max={30}
                mayEdit={mayEdit}
              />
              {templateBlock([
                'bot.service.expiry_early',
                'bot.service.expiry_first',
                'bot.service.expiry_second',
                'bot.service.expiry_day',
                'bot.service.expired',
              ])}
            </Card>

            <Card title={t('web.reminders_usage_title')} hint={t('web.reminders_usage_hint')}>
              <FlagRow
                flag={flagOf('service_usage_reminders')}
                label={t('web.reminders_flag_usage')}
                mayEdit={mayEdit}
              />
              {(
                [
                  ['reminders.usage_first_percent', 'web.reminders_usage_first'],
                  ['reminders.usage_second_percent', 'web.reminders_usage_second'],
                  ['reminders.usage_final_percent', 'web.reminders_usage_final'],
                ] as const
              ).map(([settingKey, label]) => (
                <NumberRow
                  key={settingKey}
                  setting={settingOf(settingKey)}
                  label={t(label)}
                  hint={t('web.reminders_usage_values_hint')}
                  unit={t('web.reminders_unit_percent')}
                  min={0}
                  max={USAGE_REMINDER_PERCENT_MAX - 1}
                  // Stored as percent USED; shown and typed as percent REMAINING.
                  toShown={usageRemainingPercent}
                  toStored={usageRemainingPercent}
                  mayEdit={mayEdit}
                />
              ))}
              {templateBlock([
                'bot.service.usage_first',
                'bot.service.usage_second',
                'bot.service.usage_final',
              ])}
            </Card>

            <Card title={t('web.reminders_wallet_title')} hint={t('web.reminders_wallet_hint')}>
              <FlagRow
                flag={flagOf('wallet_low_balance_reminders')}
                label={t('web.reminders_flag_wallet')}
                mayEdit={mayEdit}
              />
              <MoneyRow
                setting={settingOf('wallet.low_balance.threshold')}
                selling={selling}
                mayEdit={mayEdit}
              />
              {templateBlock(['bot.wallet.low_balance'])}
            </Card>

            <Card title={t('web.reminders_pending_title')} hint={t('web.reminders_pending_hint')}>
              <FlagRow
                flag={flagOf('payment_pending_reminders')}
                label={t('web.reminders_flag_pending')}
                mayEdit={mayEdit}
              />
              <NumberRow
                setting={settingOf('reminders.payment_pending_minutes')}
                label={t('web.reminders_pending_minutes')}
                hint={t('web.reminders_pending_minutes_hint')}
                unit={t('web.unit_minutes')}
                min={PENDING_PAYMENT_REMINDER_MINUTES_MIN}
                max={PENDING_PAYMENT_REMINDER_MINUTES_MAX}
                mayEdit={mayEdit}
              />
              {templateBlock(['bot.payment.pending_reminder', 'bot.order.pending_reminder'])}
            </Card>
          </>
        )}
      </StateSwitch>
    </>
  );
}

/** Invalidates everything this screen reads, so the other screens agree with it too. */
function useRefresh(): () => Promise<void> {
  const client = useQueryClient();
  return async () => {
    await client.invalidateQueries({ queryKey: ['settings'] });
    await client.invalidateQueries({ queryKey: ['features'] });
  };
}

/**
 * One switch.
 *
 * Turning a switch OFF asks a plain Persian question first, because it silences a message
 * every customer of the tenant would otherwise receive; turning one ON does not. A flag
 * whose blast radius is tenant-wide still carries the server's confirmation protocol — the
 * flag's own key and a reason — and this screen supplies both itself after the question is
 * answered, with a reason that says where the change came from, so the audit row still
 * records who did what and from which screen.
 */
function FlagRow({
  flag,
  label,
  hint,
  mayEdit,
}: {
  flag: FeatureFlagResponse | undefined;
  label: string;
  hint?: string;
  mayEdit: boolean;
}) {
  const refresh = useRefresh();
  const submission = useSubmissionKey();
  const [asking, setAsking] = useState(false);
  const toggle = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      enabled: boolean;
      expectedVersion: number | null;
      confirmKey?: string;
      reason?: string;
    }) => saveFeatureFlag({ key: flag?.key ?? '', ...command }),
    onSuccess: async () => {
      submission.settle();
      setAsking(false);
      await refresh();
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      void refresh();
    },
  });
  if (flag === undefined) return null;

  const send = (enabled: boolean) => {
    const command = {
      enabled,
      expectedVersion: flag.version,
      ...(flag.blastRadius === 'TENANT_WIDE'
        ? { confirmKey: flag.key, reason: t('web.reminders_toggle_reason') }
        : {}),
    };
    toggle.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  return (
    <div className="field">
      <div className="row">
        <Switch
          checked={flag.enabled}
          label={label}
          disabled={!mayEdit || toggle.isPending}
          onChange={(next) => (next ? send(true) : setAsking(true))}
        />
        <span>{label}</span>{' '}
        <Badge tone={flag.enabled ? 'ok' : 'neutral'}>
          {flag.enabled ? t('web.enabled') : t('web.disabled')}
        </Badge>
      </div>
      {hint !== undefined && <p className="muted small">{hint}</p>}
      {asking && (
        <Banner tone="warn">
          {t('web.reminders_turn_off_confirm')}{' '}
          <button type="button" className="btn danger sm" onClick={() => send(false)}>
            {t('web.reminders_turn_off_yes')}
          </button>{' '}
          <button type="button" className="btn ghost sm" onClick={() => setAsking(false)}>
            {t('web.reminders_cancel')}
          </button>
        </Banner>
      )}
      {toggle.isError && <ErrorReport error={toggle.error} />}
    </div>
  );
}

/**
 * One whole-number setting, as the quantity an operator thinks in.
 *
 * `toShown` and `toStored` are the presentation conversion and nothing else; the server's
 * schema and guard decide validity, and a refusal is shown in its own words.
 */
function NumberRow({
  setting,
  label,
  hint,
  unit,
  min,
  max,
  toShown = (value: number) => value,
  toStored = (value: number) => value,
  mayEdit,
}: {
  setting: ResolvedSettingResponse | undefined;
  label: string;
  hint: string;
  unit: string;
  min: number;
  max: number;
  toShown?: (stored: number) => number;
  toStored?: (shown: number) => number;
  mayEdit: boolean;
}) {
  const shown = typeof setting?.value === 'number' ? toShown(setting.value) : null;
  const [draft, setDraft] = useState(shown === null ? '' : String(shown));
  const [basis, setBasis] = useState(setting?.version ?? null);
  const refresh = useRefresh();
  const submission = useSubmissionKey();
  const save = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      value: number;
      expectedVersion: number | null;
    }) => saveSetting({ key: setting?.key ?? '', ...command }),
    onSuccess: async (result) => {
      submission.settle();
      setBasis(result.setting.version);
      await refresh();
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      void refresh();
    },
  });
  if (setting === undefined) return null;
  const id = `reminder-${setting.key}`;
  const parsed = Number(draft);
  const valid = draft.trim() !== '' && Number.isInteger(parsed) && parsed >= min && parsed <= max;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const command = { value: toStored(parsed), expectedVersion: basis };
    save.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  return (
    <form onSubmit={onSubmit}>
      <Field label={label} hint={hint} htmlFor={id}>
        <div className="input-group">
          <input
            id={id}
            className="input ltr mono"
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            value={draft}
            disabled={!mayEdit}
            onChange={(event) => setDraft(event.target.value)}
          />
          <span className="muted">{unit}</span>
          {mayEdit && (
            <button type="submit" className="btn primary sm" disabled={!valid || save.isPending}>
              {save.isPending ? t('web.saving') : t('web.save')}
            </button>
          )}
        </div>
      </Field>
      {/* A stored value the registry no longer accepts (a bound was tightened): the
          default is in force, and saving a value repairs it. */}
      {setting.storedValueInvalid && <Banner tone="danger">{t('web.stored_value_invalid')}</Banner>}
      {save.isError && <ErrorReport error={save.error} />}
      {save.isSuccess && (
        <Banner tone={save.data.changed ? 'ok' : 'info'}>
          {save.data.changed ? t('web.saved') : t('web.unchanged')}
        </Banner>
      )}
    </form>
  );
}

/**
 * The wallet threshold, as an amount in the currency the installation sells in.
 *
 * The currency is not chosen here: a threshold in any other currency names no wallet the
 * product credits, so the field always saves in `sales.currency`. A stored value in another
 * currency — the sales currency changed after it was set — is said to be inert.
 */
function MoneyRow({
  setting,
  selling,
  mayEdit,
}: {
  setting: ResolvedSettingResponse | undefined;
  selling: SalesCurrencyCode;
  mayEdit: boolean;
}) {
  const stored = asMoney(setting?.value);
  const [draft, setDraft] = useState(stored.amountMinor);
  const [basis, setBasis] = useState(setting?.version ?? null);
  const refresh = useRefresh();
  const submission = useSubmissionKey();
  const save = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      value: MoneyWire;
      expectedVersion: number | null;
    }) => saveSetting({ key: setting?.key ?? '', ...command }),
    onSuccess: async (result) => {
      submission.settle();
      setBasis(result.setting.version);
      await refresh();
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      void refresh();
    },
  });
  if (setting === undefined) return null;
  const valid = /^\d{1,19}$/.test(draft.trim());
  const mismatch = stored.amountMinor !== '0' && stored.currency !== selling;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const command = {
      value: { amountMinor: draft.trim().replace(/^0+(?=\d)/, ''), currency: selling },
      expectedVersion: basis,
    };
    save.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  return (
    <form onSubmit={onSubmit}>
      <Field
        label={t('web.reminders_wallet_threshold')}
        hint={t('web.reminders_wallet_threshold_hint')}
        htmlFor="reminder-wallet-threshold"
      >
        <div className="input-group">
          <input
            id="reminder-wallet-threshold"
            className="input ltr mono"
            inputMode="numeric"
            value={draft}
            disabled={!mayEdit}
            onChange={(event) => setDraft(event.target.value)}
          />
          <span className="muted">{currencyLabel(selling)}</span>
          {mayEdit && (
            <button type="submit" className="btn primary sm" disabled={!valid || save.isPending}>
              {save.isPending ? t('web.saving') : t('web.save')}
            </button>
          )}
        </div>
      </Field>
      {stored.amountMinor !== '0' && <p className="muted small">{formatMoneyText(stored)}</p>}
      {mismatch && <Banner tone="warn">{t('web.reminders_wallet_currency_mismatch')}</Banner>}
      {save.isError && <ErrorReport error={save.error} />}
      {save.isSuccess && (
        <Banner tone={save.data.changed ? 'ok' : 'info'}>
          {save.data.changed ? t('web.saved') : t('web.unchanged')}
        </Banner>
      )}
    </form>
  );
}

/** A stored money value, or zero in Toman when the stored value is not one. */
function asMoney(value: unknown): MoneyWire {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record['amountMinor'] === 'string' && typeof record['currency'] === 'string') {
      return { amountMinor: record['amountMinor'], currency: record['currency'] } as MoneyWire;
    }
  }
  return { amountMinor: '0', currency: 'IRT' };
}

/**
 * The messages a family sends, each editable in place with the texts screen's own card —
 * the same validation, preview, history and revert, so this is integration rather than a
 * second editor.
 */
function TemplateBlock({
  templates,
  mayView,
  mayEdit,
}: {
  templates: readonly TemplateViewResponse[];
  mayView: boolean;
  mayEdit: boolean;
}) {
  return (
    <details>
      <summary>{t('web.reminders_templates')}</summary>
      {!mayView ? (
        <p className="muted small">{t('web.reminders_templates_denied')}</p>
      ) : (
        <>
          <p className="muted small">{t('web.reminders_templates_hint')}</p>
          {templates.map((template) => (
            <TemplateCard key={template.key} template={template} mayEdit={mayEdit} />
          ))}
        </>
      )}
    </details>
  );
}
