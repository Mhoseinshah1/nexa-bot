import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CONTROL_ERROR_CODES,
  PENDING_PAYMENT_REMINDER_MINUTES_MAX,
  PENDING_PAYMENT_REMINDER_MINUTES_MIN,
  QUIET_HOURS_TIME_PATTERN,
  USAGE_REMINDER_PERCENT_MAX,
  quietHoursMinuteOfDay,
  usageRemainingPercent,
  type FeatureFlagResponse,
  type MoneyWire,
  type ResolvedSettingResponse,
  type SalesCurrencyCode,
  type TemplateViewResponse,
} from '@nexa/contracts';
import {
  ApiError,
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
import { featurePresentation } from './features-catalogue';
import { ConfirmDialog, confirmDialogOpen } from '../ui/confirm-dialog';

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
 * Quiet hours (HF-A9) are the last card: a switch and the window's start and end, in the
 * tenant's own time. They hold every reminder on this page — never a reply or a payment
 * outcome — and the server decides what they apply to; this card only edits the flag and
 * its two settings, like every other card here.
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

            <Card title={t('web.reminders_quiet_title')} hint={t('web.reminders_quiet_hint')}>
              <FlagRow
                flag={flagOf('reminder_quiet_hours')}
                label={t('web.reminders_flag_quiet')}
                mayEdit={mayEdit}
              />
              <TimeRow
                setting={settingOf('reminders.quiet_hours_start')}
                label={t('web.reminders_quiet_start')}
                mayEdit={mayEdit}
              />
              <TimeRow
                setting={settingOf('reminders.quiet_hours_end')}
                label={t('web.reminders_quiet_end')}
                mayEdit={mayEdit}
              />
              <QuietWindowNote
                start={settingOf('reminders.quiet_hours_start')?.value}
                end={settingOf('reminders.quiet_hours_end')?.value}
              />
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
 * One switch, with the Features page's own rule and dialog (WP-A2).
 *
 * The write carries the flag and the version it was drawn from and nothing else: no
 * confirmation key and no reason, which WP-A2 retired from every toggle, and never a
 * reason this screen made up — the audit row records who, when and what on its own.
 * Turning a switch OFF asks the same plain question the Features page asks, for exactly
 * the flags it asks it for (`FEATURE_PRESENTATION[key].disableEffect`), so the two screens
 * cannot disagree about which switch-offs deserve one. Turning one ON asks nothing.
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
  const switchSlot = useRef<HTMLSpanElement>(null);
  const toggle = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      enabled: boolean;
      expectedVersion: number | null;
    }) => saveFeatureFlag({ key: flag?.key ?? '', ...command }),
    onSuccess: async () => {
      submission.settle();
      await refresh();
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      void refresh();
    },
  });
  const cancel = useCallback(() => setAsking(false), []);
  const returnFocus = useCallback(
    () => switchSlot.current?.querySelector<HTMLElement>('[role="switch"]') ?? null,
    [],
  );
  if (flag === undefined) return null;

  // The Features page's rule, including its conservative answer for a key it does not know.
  const presentation = featurePresentation(flag.key);
  const disableEffect =
    presentation === undefined ? 'web.feature_unknown_off_effect' : presentation.disableEffect;

  const send = (enabled: boolean) => {
    const command = { enabled, expectedVersion: flag.version };
    toggle.mutate({ ...command, idempotencyKey: submission.current(command) });
  };
  const onSwitch = (next: boolean) => {
    if (confirmDialogOpen()) return;
    if (!next && disableEffect !== null) {
      setAsking(true);
      return;
    }
    send(next);
  };

  return (
    <div className="field">
      <div className="row">
        <span ref={switchSlot} className="switch-slot">
          <Switch
            checked={flag.enabled}
            label={label}
            disabled={!mayEdit || toggle.isPending || asking}
            onChange={onSwitch}
          />
        </span>
        <span>{label}</span>{' '}
        <Badge tone={flag.enabled ? 'ok' : 'neutral'}>
          {flag.enabled ? t('web.enabled') : t('web.disabled')}
        </Badge>
      </div>
      {hint !== undefined && <p className="muted small">{hint}</p>}
      {asking && disableEffect !== null && (
        <ConfirmDialog
          title={label}
          question={t('web.feature_confirm_disable')}
          detail={t(disableEffect)}
          confirmLabel={t('web.feature_confirm_disable_yes')}
          cancelLabel={t('web.feature_confirm_cancel')}
          onConfirm={() => {
            setAsking(false);
            send(false);
          }}
          onCancel={cancel}
          returnFocusTo={returnFocus}
        />
      )}
      {toggle.isError && <ErrorReport error={toggle.error} />}
    </div>
  );
}

/**
 * The version a setting's write is based on, and how it follows a conflict.
 *
 * Held apart from the query's version for the settings screen's reason: a write must state
 * the version the operator's draft was based on, so a concurrent change comes back as a
 * `VERSION_CONFLICT` instead of being overwritten unseen. After that conflict the refreshed
 * row's version is ADOPTED — the operator has now been told, and a retry is a deliberate
 * write over the new row — while the draft they typed is left exactly as it is. Without
 * this every retry resubmitted the stale version and conflicted again (Codex review #2 of
 * PR #100).
 */
function useVersionBasis(current: number | null | undefined): {
  readonly basis: number | null;
  readonly adopt: (version: number | null) => void;
  readonly followConflict: (error: unknown) => void;
} {
  const [basis, setBasis] = useState<number | null>(current ?? null);
  const [adopting, setAdopting] = useState(false);
  useEffect(() => {
    if (adopting && current !== undefined && current !== basis) {
      setBasis(current);
      setAdopting(false);
    }
  }, [adopting, current, basis]);
  return {
    basis,
    adopt: setBasis,
    followConflict: (error: unknown) => {
      if (error instanceof ApiError && error.code === CONTROL_ERROR_CODES.VERSION_CONFLICT) {
        setAdopting(true);
      }
    },
  };
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
  const { basis, adopt, followConflict } = useVersionBasis(setting?.version);
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
      adopt(result.setting.version);
      await refresh();
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      followConflict(error);
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
 * One quiet-hours boundary, as a 24-hour time (HF-A9).
 *
 * The browser's time field hands back `HH:MM`, which is exactly what the registry stores, so
 * there is no conversion; a value the contract's own pattern refuses is not sent, and the
 * server's schema and guard decide the rest — a start equal to the end comes back as the
 * guard's Persian refusal, shown verbatim.
 */
function TimeRow({
  setting,
  label,
  mayEdit,
}: {
  setting: ResolvedSettingResponse | undefined;
  label: string;
  mayEdit: boolean;
}) {
  const [draft, setDraft] = useState(typeof setting?.value === 'string' ? setting.value : '');
  const { basis, adopt, followConflict } = useVersionBasis(setting?.version);
  const refresh = useRefresh();
  const submission = useSubmissionKey();
  const save = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      value: string;
      expectedVersion: number | null;
    }) => saveSetting({ key: setting?.key ?? '', ...command }),
    onSuccess: async (result) => {
      submission.settle();
      adopt(result.setting.version);
      await refresh();
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      followConflict(error);
      void refresh();
    },
  });
  if (setting === undefined) return null;
  const id = `reminder-${setting.key}`;
  const valid = QUIET_HOURS_TIME_PATTERN.test(draft);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    const command = { value: draft, expectedVersion: basis };
    save.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  return (
    <form onSubmit={onSubmit}>
      <Field label={label} hint={t('web.reminders_quiet_time_hint')} htmlFor={id}>
        <div className="input-group">
          <input
            id={id}
            className="input ltr mono"
            type="time"
            step={60}
            value={draft}
            disabled={!mayEdit}
            onChange={(event) => setDraft(event.target.value)}
          />
          {mayEdit && (
            <button type="submit" className="btn primary sm" disabled={!valid || save.isPending}>
              {save.isPending ? t('web.saving') : t('web.save')}
            </button>
          )}
        </div>
      </Field>
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
 * What the saved window means, in words: overnight when the end is earlier than the start,
 * and inert when the two are the same (which the server refuses to store, so this appears
 * only for a value that reached the database some other way).
 */
function QuietWindowNote({ start, end }: { start: unknown; end: unknown }) {
  const from = typeof start === 'string' ? quietHoursMinuteOfDay(start) : null;
  const to = typeof end === 'string' ? quietHoursMinuteOfDay(end) : null;
  if (from === null || to === null) return null;
  if (from === to) return <Banner tone="warn">{t('web.reminders_quiet_same')}</Banner>;
  if (from > to) return <p className="muted small">{t('web.reminders_quiet_overnight')}</p>;
  return null;
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
  const { basis, adopt, followConflict } = useVersionBasis(setting?.version);
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
      adopt(result.setting.version);
      await refresh();
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      followConflict(error);
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
