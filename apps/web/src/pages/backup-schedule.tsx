import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BACKUP_INTERVAL_MINUTES_MAX,
  BACKUP_INTERVAL_MINUTES_MIN,
  BACKUP_SCHEDULE_SETTING_KEYS,
  type BackupDeliveryDestination,
  type BackupScheduleSource,
  type BackupStatusResponse,
  type ResolvedSettingResponse,
  type PermissionKey,
} from '@nexa/contracts';
import { ApiError, fetchSettings, saveSetting } from '../api/client';
import { useSubmissionKey } from '../submission-key';
import {
  BACKUP_INTERVAL_PRESETS,
  BACKUP_INTERVAL_UNITS,
  intervalMinutes,
  presetMinutes,
  presetOf,
  splitInterval,
  type BackupIntervalChoice,
  type BackupIntervalUnit,
  type IntervalProblem,
} from '../backup-interval';
import { t, type WebKey } from '../i18n/web.fa';
import {
  Badge,
  Banner,
  Disclosure,
  Duration,
  Field,
  Input,
  KV,
  Ltr,
  Pills,
  Select,
  StateSwitch,
  ToggleRow,
} from '../ui/kit';

/**
 * «زمان‌بندی بکاپ خودکار» — spec §13.2.
 *
 * Two registry values on the installation tenant, edited here and nowhere else: whether
 * the worker takes automatic backups, and how long after the last verified one the next
 * is due. Each is saved on its own through the ordinary settings write — the version it
 * was read at, an idempotency key, audit — so this card adds no write path of its own.
 *
 * What it SHOWS comes from the backup status, which is the scheduler's own answer
 * (`BackupSchedulePolicy`): the effective value and whether it is this page's or the
 * installation's default. A value nobody set here reads «پیش‌فرض نصب», and the technical
 * name of that default is kept in a closed disclosure.
 *
 * The interval is a number and a unit, or a preset — never milliseconds.
 */

const PRESET_LABEL: Readonly<Record<BackupIntervalChoice, WebKey>> = {
  '1h': 'web.backup_interval_1h',
  '3h': 'web.backup_interval_3h',
  '6h': 'web.backup_interval_6h',
  '12h': 'web.backup_interval_12h',
  '24h': 'web.backup_interval_24h',
  custom: 'web.backup_interval_custom',
};

const UNIT_LABEL: Readonly<Record<BackupIntervalUnit, WebKey>> = {
  minute: 'web.unit_minutes',
  hour: 'web.unit_hours',
  day: 'web.unit_days',
};

const PROBLEM_LABEL: Readonly<Record<IntervalProblem, WebKey>> = {
  invalid: 'web.backup_interval_invalid',
  too_short: 'web.backup_interval_too_short',
  too_long: 'web.backup_interval_too_long',
};

const SOURCE_LABEL: Readonly<Record<BackupScheduleSource, WebKey>> = {
  SETTING: 'web.backup_source_setting',
  ENVIRONMENT: 'web.backup_source_environment',
};

const DESTINATION_LABEL: Readonly<Record<BackupDeliveryDestination, WebKey>> = {
  OPS_GROUP_TOPIC: 'web.backup_destination_ops_group',
  DEDICATED_CHAT: 'web.backup_destination_dedicated',
  NONE: 'web.backup_destination_none',
};

type ScheduleStatus = Pick<
  BackupStatusResponse,
  'scheduleEnabled' | 'intervalMs' | 'scheduleSource' | 'deliveryDestination'
>;

export function BackupScheduleCard({
  status,
  permissions,
}: {
  status: ScheduleStatus;
  permissions: readonly PermissionKey[];
}) {
  const client = useQueryClient();
  const mayView = permissions.includes('settings.view');
  const mayEdit = mayView && permissions.includes('settings.edit');
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings, enabled: mayView });
  const all = settings.data?.settings ?? [];
  const enabledRow = all.find((row) => row.key === BACKUP_SCHEDULE_SETTING_KEYS.enabled);
  const intervalRow = all.find((row) => row.key === BACKUP_SCHEDULE_SETTING_KEYS.intervalMinutes);
  const editable = mayEdit && enabledRow !== undefined && intervalRow !== undefined;

  const effectiveMinutes = Math.round(status.intervalMs / 60_000);
  const [choice, setChoice] = useState<BackupIntervalChoice>(presetOf(effectiveMinutes));
  const [custom, setCustom] = useState(() => splitInterval(effectiveMinutes));
  const [customText, setCustomText] = useState(String(custom.value));
  // Follow the server when it changes under us (another administrator, a reset).
  useEffect(() => {
    setChoice(presetOf(effectiveMinutes));
    const split = splitInterval(effectiveMinutes);
    setCustom(split);
    setCustomText(String(split.value));
  }, [effectiveMinutes]);

  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['settings'] }),
      client.invalidateQueries({ queryKey: ['backup-status'] }),
    ]);
  };

  // The whole command is the mutation's variable, so a retry carries its own key and
  // its own payload (the settings page's reasoning, `settings.tsx`).
  const submission = useSubmissionKey();
  const save = useMutation({
    mutationFn: (command: {
      key: string;
      value: boolean | number | null;
      expectedVersion: number | null;
      idempotencyKey: string;
    }) => saveSetting(command),
    onSuccess: () => submission.settle(),
    onError: (error) => submission.settleOn(error),
    onSettled: refresh,
  });

  /*
   * One key per logical attempt (`useSubmissionKey`): a re-press after a lost answer is the
   * same command with the same key, and any other value or version is a new one.
   */
  const write = (row: ResolvedSettingResponse | undefined, value: boolean | number | null) => {
    if (row === undefined) return;
    const command = { key: row.key, value, expectedVersion: row.version };
    save.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  const parsed =
    choice === 'custom'
      ? intervalMinutes(customText, custom.unit)
      : ({ ok: true, minutes: presetMinutes(choice) } as const);
  const intervalChanged = parsed.ok && parsed.minutes !== effectiveMinutes;

  return (
    <div className="stack">
      <ToggleRow
        title={t('web.backup_schedule_auto')}
        description={
          <>
            {t('web.backup_schedule_auto_hint')}{' '}
            <Badge tone={status.scheduleSource.enabled === 'SETTING' ? 'info' : 'neutral'}>
              {t(SOURCE_LABEL[status.scheduleSource.enabled])}
            </Badge>
          </>
        }
        checked={status.scheduleEnabled}
        disabled={!editable || save.isPending}
        onChange={(next) => write(enabledRow, next)}
      />

      <KV
        items={[
          [
            t('web.backup_schedule_interval'),
            <span key="interval">
              <Duration ms={status.intervalMs} />{' '}
              <Badge tone={status.scheduleSource.interval === 'SETTING' ? 'info' : 'neutral'}>
                {t(SOURCE_LABEL[status.scheduleSource.interval])}
              </Badge>
            </span>,
          ],
          [
            t('web.backup_destination'),
            <Badge key="destination" tone={status.deliveryDestination === 'NONE' ? 'warn' : 'ok'}>
              {t(DESTINATION_LABEL[status.deliveryDestination])}
            </Badge>,
          ],
        ]}
      />
      {status.deliveryDestination === 'NONE' && (
        <Banner tone="warn">{t('web.backup_destination_none_hint')}</Banner>
      )}

      {editable && (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (parsed.ok && intervalChanged) write(intervalRow, parsed.minutes);
          }}
        >
          <Field
            label={t('web.backup_schedule_interval_edit')}
            hint={t('web.backup_interval_bounds')}
          >
            <Pills<BackupIntervalChoice>
              value={choice}
              onChange={setChoice}
              items={[...BACKUP_INTERVAL_PRESETS.map((preset) => preset.id), 'custom' as const].map(
                (id) => ({ id, label: t(PRESET_LABEL[id]) }),
              )}
            />
          </Field>
          {choice === 'custom' && (
            <div className="field-row">
              <Field
                label={t('web.backup_interval_value')}
                htmlFor="backup-interval-value"
                {...(parsed.ok ? {} : { error: t(PROBLEM_LABEL[parsed.problem]) })}
              >
                <Input
                  id="backup-interval-value"
                  inputMode="numeric"
                  value={customText}
                  onChange={(event) => setCustomText(event.target.value)}
                />
              </Field>
              <Field label={t('web.backup_interval_unit')} htmlFor="backup-interval-unit">
                <Select
                  id="backup-interval-unit"
                  value={custom.unit}
                  onChange={(event) =>
                    setCustom({ ...custom, unit: event.target.value as BackupIntervalUnit })
                  }
                >
                  {BACKUP_INTERVAL_UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {t(UNIT_LABEL[unit])}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
          <div className="btn-group">
            <button
              type="submit"
              className="btn primary"
              disabled={!parsed.ok || !intervalChanged || save.isPending}
            >
              {t('web.backup_interval_save')}
            </button>
            {(status.scheduleSource.enabled === 'SETTING' ||
              status.scheduleSource.interval === 'SETTING') && (
              <button
                type="button"
                className="btn"
                disabled={save.isPending}
                onClick={() => {
                  // Back to the installation's default, one value at a time: each is its
                  // own versioned write, exactly as each is its own setting.
                  if (status.scheduleSource.enabled === 'SETTING') write(enabledRow, null);
                  else write(intervalRow, null);
                }}
              >
                {t(
                  status.scheduleSource.enabled === 'SETTING'
                    ? 'web.backup_schedule_reset_enabled'
                    : 'web.backup_schedule_reset_interval',
                )}
              </button>
            )}
          </div>
        </form>
      )}
      {/*
        The editor needs the two rows' versions. While they load, or when the read failed,
        say so — with the retry every other settings consumer offers — rather than leave a
        switch that is merely disabled with no reason (Codex review of PR #142).
      */}
      {mayView && !settings.isSuccess && <StateSwitch query={settings}>{null}</StateSwitch>}
      {!mayEdit && <p className="muted small">{t('web.backup_schedule_read_only')}</p>}
      {save.isSuccess && <Banner tone="ok">{t('web.backup_schedule_saved')}</Banner>}
      {save.error !== null && (
        <Banner tone="danger">
          {save.error instanceof ApiError ? save.error.message : t('web.error')}
        </Banner>
      )}

      <Disclosure summary={t('web.settings_technical')}>
        <p className="muted small">{t('web.backup_schedule_technical')}</p>
        <KV
          items={[
            [
              t('web.backup_schedule_auto'),
              <Ltr key="e">BACKUP_SCHEDULE_ENABLED · {BACKUP_SCHEDULE_SETTING_KEYS.enabled}</Ltr>,
            ],
            [
              t('web.backup_schedule_interval'),
              <Ltr key="i">
                BACKUP_INTERVAL_MS · {BACKUP_SCHEDULE_SETTING_KEYS.intervalMinutes} (
                {BACKUP_INTERVAL_MINUTES_MIN}–{BACKUP_INTERVAL_MINUTES_MAX})
              </Ltr>,
            ],
          ]}
        />
      </Disclosure>
    </div>
  );
}
