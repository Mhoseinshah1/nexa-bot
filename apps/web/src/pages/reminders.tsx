import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
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
import { currencyLabel, formatMoneyText, formatNumber } from '../format';
import { useSubmissionKey } from '../submission-key';
import { t } from '../i18n/web.fa';
import {
  Disclosure,
  Badge,
  Banner,
  Card,
  Num,
  PageHead,
  StateSwitch,
  Switch,
  useToast,
  useUnsavedChanges,
} from '../ui/kit';
import { DirtyScope, SectionNav, UnsavedCount, useDirtySet, useReportDirty } from './ops-b-layout';
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
/** The messages each family sends, and the settings the usage family edits. */
const EXPIRY_TEMPLATES = [
  'bot.service.expiry_early',
  'bot.service.expiry_first',
  'bot.service.expiry_second',
  'bot.service.expiry_day',
  'bot.service.expired',
] as const;
const USAGE_TEMPLATES = [
  'bot.service.usage_first',
  'bot.service.usage_second',
  'bot.service.usage_final',
] as const;
const WALLET_TEMPLATES = ['bot.wallet.low_balance'] as const;
const PENDING_TEMPLATES = ['bot.payment.pending_reminder', 'bot.order.pending_reminder'] as const;
const USAGE_ROWS = [
  ['reminders.usage_first_percent', 'web.reminders_usage_first'],
  ['reminders.usage_second_percent', 'web.reminders_usage_second'],
  ['reminders.usage_final_percent', 'web.reminders_usage_final'],
] as const;
const USAGE_SETTINGS = USAGE_ROWS.map(([key]) => key);

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

  const { dirty, report } = useDirtySet();
  useUnsavedChanges(dirty.size > 0);
  const unsavedIn = (keys: readonly string[]) => keys.some((key) => dirty.has(key));

  return (
    <>
      <PageHead
        title={t('web.reminders_title')}
        subtitle={t('web.reminders_intro')}
        badge={<UnsavedCount count={dirty.size} />}
      />
      <StateSwitch query={settings} denied={denied} isEmpty={false}>
        {ready && (
          <DirtyScope report={report}>
            <div className="ob-sectioned">
              <SectionNav
                label={t('web.ob_sections')}
                items={[
                  {
                    id: 'reminders-expiry',
                    label: t('web.reminders_expiry_title'),
                    unsaved: unsavedIn([
                      'reminders.expiry_early_days',
                      'reminders.expiry_first_days',
                      'reminders.expiry_second_days',
                      ...EXPIRY_TEMPLATES,
                    ]),
                  },
                  {
                    id: 'reminders-usage',
                    label: t('web.reminders_usage_title'),
                    unsaved: unsavedIn([...USAGE_SETTINGS, ...USAGE_TEMPLATES]),
                  },
                  {
                    id: 'reminders-wallet',
                    label: t('web.reminders_wallet_title'),
                    unsaved: unsavedIn(['wallet.low_balance.threshold', ...WALLET_TEMPLATES]),
                  },
                  {
                    id: 'reminders-pending',
                    label: t('web.reminders_pending_title'),
                    unsaved: unsavedIn(['reminders.payment_pending_minutes', ...PENDING_TEMPLATES]),
                  },
                  {
                    id: 'reminders-quiet',
                    label: t('web.reminders_quiet_title'),
                    unsaved: unsavedIn([
                      'reminders.quiet_hours_start',
                      'reminders.quiet_hours_end',
                    ]),
                  },
                ]}
              />
              <div className="stack">
                <Card
                  id="reminders-expiry"
                  title={t('web.reminders_expiry_title')}
                  hint={t('web.reminders_expiry_hint')}
                  tight
                >
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
                  {earlyInert && (
                    <div className="rem-note">
                      <Banner tone="warn">{t('web.reminders_early_inert')}</Banner>
                    </div>
                  )}
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
                  {templateBlock(EXPIRY_TEMPLATES)}
                </Card>

                <Card
                  id="reminders-usage"
                  title={t('web.reminders_usage_title')}
                  hint={t('web.reminders_usage_hint')}
                  tight
                >
                  <FlagRow
                    flag={flagOf('service_usage_reminders')}
                    label={t('web.reminders_flag_usage')}
                    mayEdit={mayEdit}
                  />
                  {USAGE_ROWS.map(([settingKey, label]) => (
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
                  {templateBlock(USAGE_TEMPLATES)}
                </Card>

                <Card
                  id="reminders-wallet"
                  title={t('web.reminders_wallet_title')}
                  hint={t('web.reminders_wallet_hint')}
                  tight
                >
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
                  {templateBlock(WALLET_TEMPLATES)}
                </Card>

                <Card
                  id="reminders-pending"
                  title={t('web.reminders_pending_title')}
                  hint={t('web.reminders_pending_hint')}
                  tight
                >
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
                  {templateBlock(PENDING_TEMPLATES)}
                </Card>

                <Card
                  id="reminders-quiet"
                  title={t('web.reminders_quiet_title')}
                  hint={t('web.reminders_quiet_hint')}
                  tight
                >
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
              </div>
            </div>
          </DirtyScope>
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
    <div className="rem-flag">
      <div className="rem-flag-main">
        <div className="rem-flag-text">
          <span className="strong">{label}</span>
          {hint !== undefined && <span className="muted small">{hint}</span>}
        </div>
        <Badge tone={flag.enabled ? 'ok' : 'neutral'} dot>
          {flag.enabled ? t('web.enabled') : t('web.disabled')}
        </Badge>
        <span ref={switchSlot} className="switch-slot">
          <Switch
            checked={flag.enabled}
            label={label}
            disabled={!mayEdit || toggle.isPending || asking}
            onChange={onSwitch}
          />
        </span>
      </div>
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
 * The toasts a row's write ends with, named by the row. The inline banner under the row
 * stays the record; the toast is the acknowledgement an operator sees wherever they are.
 */
function useSaveToasts(label: string): {
  readonly saved: (changed: boolean) => void;
  readonly failed: () => void;
} {
  const notify = useToast();
  return {
    saved: (changed) =>
      notify({
        tone: changed ? 'ok' : 'info',
        message: `${t(changed ? 'web.ob_toast_saved' : 'web.ob_toast_unchanged')} — ${label}`,
      }),
    failed: () => notify({ tone: 'danger', message: `${t('web.ob_toast_failed')} — ${label}` }),
  };
}

/**
 * One editable row: the label and its helper on the start side, the field, its inline
 * problem and its own Save on the end side. The outcome banners run across beneath.
 */
function RowShell({
  id,
  label,
  hint,
  problem,
  field,
  unsaved,
  onDiscard,
  mayEdit,
  canSave,
  saving,
  onSubmit,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  /** Why the typed value cannot be saved, said under the field; null when it can. */
  problem: string | null;
  field: ReactNode;
  unsaved: boolean;
  onDiscard: () => void;
  mayEdit: boolean;
  canSave: boolean;
  saving: boolean;
  onSubmit: (event: FormEvent) => void;
  children?: ReactNode;
}) {
  return (
    <form className="set-row" onSubmit={onSubmit}>
      <div className="set-row-main">
        <div className="set-row-text">
          <label className="set-row-label" htmlFor={id}>
            {label}
          </label>
          <p className="muted small">{hint}</p>
        </div>
        <div className="set-row-control">
          {field}
          {problem !== null && (
            <span className="danger small" role="alert">
              {problem}
            </span>
          )}
          {mayEdit && (
            <div className="set-row-actions">
              {unsaved && (
                <>
                  <Badge tone="warn" dot>
                    {t('web.ob_unsaved_row')}
                  </Badge>
                  <button type="button" className="btn ghost sm" onClick={onDiscard}>
                    {t('web.discard')}
                  </button>
                </>
              )}
              <button
                type="submit"
                className={unsaved ? 'btn primary sm' : 'btn sm'}
                disabled={!canSave || saving}
              >
                {saving ? t('web.saving') : t('web.save')}
              </button>
            </div>
          )}
        </div>
      </div>
      {children}
    </form>
  );
}

/** The range a whole-number row accepts, in words. */
function rangeText(min: number, max: number): string {
  return `${t('web.settings_range_from')} ${formatNumber(min)} ${t('web.settings_range_to')} ${formatNumber(max)}`;
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
  const stored = shown === null ? '' : String(shown);
  const [draft, setDraft] = useState(stored);
  const { basis, adopt, followConflict } = useVersionBasis(setting?.version);
  const refresh = useRefresh();
  const submission = useSubmissionKey();
  const toasts = useSaveToasts(label);
  const save = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      value: number;
      expectedVersion: number | null;
    }) => saveSetting({ key: setting?.key ?? '', ...command }),
    onSuccess: async (result) => {
      submission.settle();
      adopt(result.setting.version);
      toasts.saved(result.changed);
      await refresh();
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      followConflict(error);
      toasts.failed();
      void refresh();
    },
  });
  const unsaved = setting !== undefined && draft !== stored;
  useReportDirty(setting?.key ?? '', unsaved);
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
    <RowShell
      id={id}
      label={label}
      hint={hint}
      // Said only once something was typed: an empty field is a prompt, not a mistake.
      problem={!valid && draft.trim() !== '' ? rangeText(min, max) : null}
      unsaved={unsaved}
      onDiscard={() => setDraft(stored)}
      mayEdit={mayEdit}
      canSave={valid}
      saving={save.isPending}
      onSubmit={onSubmit}
      field={
        <div className="input-group">
          <input
            id={id}
            className="input"
            dir="ltr"
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            value={draft}
            disabled={!mayEdit}
            aria-invalid={!valid && draft.trim() !== ''}
            onChange={(event) => setDraft(event.target.value)}
          />
          <span className="addon">{unit}</span>
        </div>
      }
    >
      {/* A stored value the registry no longer accepts (a bound was tightened): the
          default is in force, and saving a value repairs it. */}
      {setting.storedValueInvalid && <Banner tone="danger">{t('web.stored_value_invalid')}</Banner>}
      {save.isError && <ErrorReport error={save.error} />}
      {save.isSuccess && (
        <Banner tone={save.data.changed ? 'ok' : 'info'}>
          {save.data.changed ? t('web.saved') : t('web.unchanged')}
        </Banner>
      )}
    </RowShell>
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
  const stored = typeof setting?.value === 'string' ? setting.value : '';
  const [draft, setDraft] = useState(stored);
  const { basis, adopt, followConflict } = useVersionBasis(setting?.version);
  const refresh = useRefresh();
  const submission = useSubmissionKey();
  const toasts = useSaveToasts(label);
  const save = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      value: string;
      expectedVersion: number | null;
    }) => saveSetting({ key: setting?.key ?? '', ...command }),
    onSuccess: async (result) => {
      submission.settle();
      adopt(result.setting.version);
      toasts.saved(result.changed);
      await refresh();
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      followConflict(error);
      toasts.failed();
      void refresh();
    },
  });
  const unsaved = setting !== undefined && draft !== stored;
  useReportDirty(setting?.key ?? '', unsaved);
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
    <RowShell
      id={id}
      label={label}
      hint={t('web.reminders_quiet_time_hint')}
      problem={!valid && draft !== '' ? t('web.reminders_quiet_time_hint') : null}
      unsaved={unsaved}
      onDiscard={() => setDraft(stored)}
      mayEdit={mayEdit}
      canSave={valid}
      saving={save.isPending}
      onSubmit={onSubmit}
      field={
        <input
          id={id}
          className="input ltr mono rem-time"
          type="time"
          step={60}
          value={draft}
          disabled={!mayEdit}
          onChange={(event) => setDraft(event.target.value)}
        />
      }
    >
      {setting.storedValueInvalid && <Banner tone="danger">{t('web.stored_value_invalid')}</Banner>}
      {save.isError && <ErrorReport error={save.error} />}
      {save.isSuccess && (
        <Banner tone={save.data.changed ? 'ok' : 'info'}>
          {save.data.changed ? t('web.saved') : t('web.unchanged')}
        </Banner>
      )}
    </RowShell>
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
  if (from === to) {
    return (
      <div className="rem-note">
        <Banner tone="warn">{t('web.reminders_quiet_same')}</Banner>
      </div>
    );
  }
  if (from > to) {
    return (
      <div className="rem-note">
        <p className="muted small">{t('web.reminders_quiet_overnight')}</p>
      </div>
    );
  }
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
  const label = t('web.reminders_wallet_threshold');
  const toasts = useSaveToasts(label);
  const save = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      value: MoneyWire;
      expectedVersion: number | null;
    }) => saveSetting({ key: setting?.key ?? '', ...command }),
    onSuccess: async (result) => {
      submission.settle();
      adopt(result.setting.version);
      toasts.saved(result.changed);
      await refresh();
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      followConflict(error);
      toasts.failed();
      void refresh();
    },
  });
  const unsaved = setting !== undefined && draft !== stored.amountMinor;
  useReportDirty(setting?.key ?? '', unsaved);
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
    <RowShell
      id="reminder-wallet-threshold"
      label={label}
      hint={t('web.reminders_wallet_threshold_hint')}
      problem={!valid && draft.trim() !== '' ? t('web.reminders_wallet_threshold_invalid') : null}
      unsaved={unsaved}
      onDiscard={() => setDraft(stored.amountMinor)}
      mayEdit={mayEdit}
      canSave={valid}
      saving={save.isPending}
      onSubmit={onSubmit}
      field={
        <>
          <div className="input-group">
            <input
              id="reminder-wallet-threshold"
              className="input"
              dir="ltr"
              inputMode="numeric"
              value={draft}
              disabled={!mayEdit}
              aria-invalid={!valid && draft.trim() !== ''}
              onChange={(event) => setDraft(event.target.value)}
            />
            <span className="addon">{currencyLabel(selling)}</span>
          </div>
          {stored.amountMinor !== '0' && <p className="muted small">{formatMoneyText(stored)}</p>}
        </>
      }
    >
      {mismatch && <Banner tone="warn">{t('web.reminders_wallet_currency_mismatch')}</Banner>}
      {save.isError && <ErrorReport error={save.error} />}
      {save.isSuccess && (
        <Banner tone={save.data.changed ? 'ok' : 'info'}>
          {save.data.changed ? t('web.saved') : t('web.unchanged')}
        </Banner>
      )}
    </RowShell>
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
    <Disclosure
      className="rem-templates"
      summary={
        <>
          {t('web.reminders_templates')}
          {mayView && (
            <span className="muted small">
              (<Num value={templates.length} />)
            </span>
          )}
        </>
      }
    >
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
    </Disclosure>
  );
}
