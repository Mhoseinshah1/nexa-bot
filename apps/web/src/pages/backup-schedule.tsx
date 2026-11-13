import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BACKUP_ARCHIVE_KEEP_ON_HOST_DEFAULT,
  BACKUP_ARCHIVE_KEEP_ON_HOST_SETTING_KEY,
  BACKUP_ARCHIVE_RETENTION_SETTING_KEYS,
  BACKUP_DAILY_TIME_PATTERN,
  BACKUP_INTERVAL_MINUTES_MAX,
  BACKUP_INTERVAL_MINUTES_MIN,
  BACKUP_PART_SIZE_MIB_DEFAULT,
  BACKUP_PART_SIZE_SETTING_KEY,
  BACKUP_SCHEDULE_SETTING_KEYS,
  type BackupDeliveryDestination,
  type BackupScheduleSource,
  type BackupStatusResponse,
  type ResolvedSettingResponse,
  type PermissionKey,
} from '@nexa/contracts';
import { fetchSettings, saveSetting } from '../api/client';
import { useSubmissionKey } from '../submission-key';
import {
  BACKUP_INTERVAL_PRESETS,
  BACKUP_INTERVAL_UNITS,
  intervalMinutes,
  partSizeMib,
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
  Num,
  Pills,
  Select,
  StateSwitch,
  ToggleRow,
} from '../ui/kit';
import { errorText } from '../error-text';
import { ErrorRef } from '../ui/technical-details';
import { TimeField24 } from '../ui/time-field24';
import { ConfirmDialog } from '../ui/confirm-dialog';

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
 *
 * «نگه داشتن نسخه روی سرور» (owner, 2026-11-11) is a third registry value on the same card,
 * `backup.archive_keep_on_host`, saved the same way. Turning it OFF asks first, because from
 * then on a restore needs the file from the Telegram group; turning it on asks nothing. While
 * it is off the archive-retention numbers are drawn greyed, with the one line that says why.
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
  'scheduleEnabled' | 'intervalMs' | 'dailyTime' | 'scheduleSource' | 'deliveryDestination'
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
  const dailyRow = all.find((row) => row.key === BACKUP_SCHEDULE_SETTING_KEYS.dailyTime);
  const keepOnHostRow = all.find((row) => row.key === BACKUP_ARCHIVE_KEEP_ON_HOST_SETTING_KEY);
  const keepCountRow = all.find(
    (row) => row.key === BACKUP_ARCHIVE_RETENTION_SETTING_KEYS.keepCount,
  );
  const keepDaysRow = all.find((row) => row.key === BACKUP_ARCHIVE_RETENTION_SETTING_KEYS.keepDays);
  // The value in force: the registry's default until the row is read.
  const keepOnHost =
    keepOnHostRow === undefined
      ? BACKUP_ARCHIVE_KEEP_ON_HOST_DEFAULT
      : keepOnHostRow.value !== false;
  const [confirmKeepOff, setConfirmKeepOff] = useState(false);
  // NEXA-BACKUP-DELIVERY: the split size, `backup.part_mb` (10–45 MiB).
  const partSizeRow = all.find((row) => row.key === BACKUP_PART_SIZE_SETTING_KEY);
  const partSize =
    partSizeRow === undefined || typeof partSizeRow.value !== 'number'
      ? BACKUP_PART_SIZE_MIB_DEFAULT
      : partSizeRow.value;
  const [partSizeText, setPartSizeText] = useState(String(partSize));
  useEffect(() => setPartSizeText(String(partSize)), [partSize]);
  const partSizeParsed = partSizeMib(partSizeText);
  const partSizeValid = partSizeParsed !== null;
  const partSizeChanged = partSizeParsed !== null && partSizeParsed !== partSize;
  const editable = mayEdit && enabledRow !== undefined && intervalRow !== undefined;
  const [dailyText, setDailyText] = useState(status.dailyTime ?? '');
  useEffect(() => setDailyText(status.dailyTime ?? ''), [status.dailyTime]);
  const dailyTrimmed = dailyText.trim();
  const dailyValid = BACKUP_DAILY_TIME_PATTERN.test(dailyTrimmed);
  const dailyChanged = dailyValid && dailyTrimmed !== status.dailyTime;

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
  // One key per ROW: a success on one setting must not retire the key another holds.
  const enabledKey = useSubmissionKey();
  const intervalKey = useSubmissionKey();
  const dailyKey = useSubmissionKey();
  const keepOnHostKey = useSubmissionKey();
  const partSizeKey = useSubmissionKey();
  const keyFor = (settingKey: string) =>
    settingKey === BACKUP_SCHEDULE_SETTING_KEYS.enabled
      ? enabledKey
      : settingKey === BACKUP_SCHEDULE_SETTING_KEYS.dailyTime
        ? dailyKey
        : settingKey === BACKUP_ARCHIVE_KEEP_ON_HOST_SETTING_KEY
          ? keepOnHostKey
          : settingKey === BACKUP_PART_SIZE_SETTING_KEY
            ? partSizeKey
            : intervalKey;
  const save = useMutation({
    mutationFn: (command: {
      key: string;
      value: boolean | number | string | null;
      expectedVersion: number | null;
      idempotencyKey: string;
    }) => saveSetting(command),
    onSuccess: (_result, command) => keyFor(command.key).settle(),
    onError: (error, command) => keyFor(command.key).settleOn(error),
    onSettled: refresh,
  });

  /*
   * One key per logical attempt (`useSubmissionKey`): a re-press after a lost answer is the
   * same command with the same key, and any other value or version is a new one.
   */
  const write = (
    row: ResolvedSettingResponse | undefined,
    value: boolean | number | string | null,
  ) => {
    if (row === undefined) return;
    const command = { key: row.key, value, expectedVersion: row.version };
    save.mutate({ ...command, idempotencyKey: keyFor(row.key).current(command) });
  };

  const parsed =
    choice === 'custom'
      ? intervalMinutes(customText, custom.unit)
      : ({ ok: true, minutes: presetMinutes(choice) } as const);
  // While a stored daily time is in force the policy reports a 24 h interval, so picking
  // that same interval is still a change: it is how an operator leaves the daily time.
  const dailyInForce = status.scheduleSource.dailyTime === 'SETTING' && status.dailyTime !== null;
  const intervalChanged = parsed.ok && (parsed.minutes !== effectiveMinutes || dailyInForce);

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
            t('web.backup_schedule_daily'),
            <span key="daily">
              {status.dailyTime === null ? (
                t('web.backup_schedule_daily_none')
              ) : (
                <Ltr>{status.dailyTime}</Ltr>
              )}{' '}
              <Badge tone={status.scheduleSource.dailyTime === 'SETTING' ? 'info' : 'neutral'}>
                {t(SOURCE_LABEL[status.scheduleSource.dailyTime])}
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

      <ToggleRow
        title={t('web.backup_keep_on_host')}
        description={t('web.backup_keep_on_host_hint')}
        checked={keepOnHost}
        disabled={!mayEdit || keepOnHostRow === undefined || save.isPending}
        onChange={(next) => {
          // Off is asked first; on is today's behaviour and asks nothing.
          if (next) write(keepOnHostRow, true);
          else setConfirmKeepOff(true);
        }}
      />
      <div
        className={keepOnHost ? 'backup-retention' : 'backup-retention is-off'}
        aria-disabled={keepOnHost ? undefined : true}
        data-testid="backup-retention"
      >
        <KV
          items={[
            [
              t('web.setting_backup_keep_count'),
              keepCountRow === undefined ? (
                '—'
              ) : (
                <Num key="count" value={String(keepCountRow.value)} />
              ),
            ],
            [
              t('web.setting_backup_keep_days'),
              keepDaysRow === undefined ? (
                '—'
              ) : (
                <Num key="days" value={String(keepDaysRow.value)} />
              ),
            ],
          ]}
        />
      </div>
      {!keepOnHost && <p className="muted small">{t('web.backup_keep_on_host_off_retention')}</p>}
      {confirmKeepOff && (
        <ConfirmDialog
          title={t('web.backup_keep_on_host')}
          question={t('web.backup_keep_on_host_confirm')}
          confirmLabel={t('web.backup_keep_on_host_confirm_yes')}
          cancelLabel={t('web.backup_keep_on_host_cancel')}
          onConfirm={() => {
            setConfirmKeepOff(false);
            write(keepOnHostRow, false);
          }}
          onCancel={() => setConfirmKeepOff(false)}
        />
      )}

      {/* NEXA-BACKUP-DELIVERY: the size a large archive is split into for Telegram. */}
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (partSizeChanged) write(partSizeRow, partSizeParsed);
        }}
      >
        <Field
          label={t('web.backup_part_size')}
          hint={t('web.backup_part_size_hint')}
          htmlFor="backup-part-size"
          {...(partSizeText.trim() === '' || partSizeValid
            ? {}
            : { error: t('web.backup_part_size_invalid') })}
        >
          <Input
            id="backup-part-size"
            inputMode="numeric"
            dir="ltr"
            value={partSizeText}
            disabled={!mayEdit || partSizeRow === undefined}
            onChange={(event) => setPartSizeText(event.target.value)}
          />
        </Field>
        {mayEdit && partSizeRow !== undefined && (
          <div className="btn-group">
            <button
              type="submit"
              className="btn primary"
              disabled={!partSizeChanged || save.isPending}
            >
              {t('web.backup_part_size_save')}
            </button>
          </div>
        )}
      </form>

      {editable && dailyRow !== undefined && (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (dailyChanged) write(dailyRow, dailyTrimmed);
          }}
        >
          <Field
            label={t('web.backup_schedule_daily_edit')}
            hint={t('web.backup_schedule_daily_hint')}
            htmlFor="backup-daily-time-h"
            {...(dailyTrimmed === '' || dailyValid
              ? {}
              : { error: t('web.backup_schedule_daily_invalid') })}
          >
            {/* The Persian 24-hour picker, like campaigns, reminders and the ops group: the value
                is still the wire's own HH:MM, so the pattern, the request and the save are as before. */}
            <TimeField24
              id="backup-daily-time"
              label={t('web.backup_schedule_daily_edit')}
              value={dailyText}
              onChange={setDailyText}
            />
          </Field>
          <div className="btn-group">
            <button
              type="submit"
              className="btn primary"
              disabled={!dailyChanged || save.isPending}
            >
              {t('web.backup_schedule_daily_save')}
            </button>
            {status.scheduleSource.dailyTime === 'SETTING' && (
              <button
                type="button"
                className="btn"
                disabled={save.isPending}
                onClick={() => write(dailyRow, null)}
              >
                {t('web.backup_schedule_reset_daily')}
              </button>
            )}
          </div>
        </form>
      )}

      {editable && (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (parsed.ok && intervalChanged) {
              // A stored daily time beats any interval, so choosing an interval clears it.
              if (dailyInForce) write(dailyRow, null);
              write(intervalRow, parsed.minutes);
            }
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
          {errorText(save.error)}
          <ErrorRef error={save.error} />
        </Banner>
      )}

      <Disclosure summary={t('web.settings_technical')} variant="boxed">
        <p className="muted small">{t('web.backup_schedule_technical')}</p>
        <KV
          items={[
            [
              t('web.backup_schedule_auto'),
              <Ltr key="e">BACKUP_SCHEDULE_ENABLED · {BACKUP_SCHEDULE_SETTING_KEYS.enabled}</Ltr>,
            ],
            [
              t('web.backup_schedule_daily'),
              <Ltr key="d">
                BACKUP_DAILY_TIME · {BACKUP_SCHEDULE_SETTING_KEYS.dailyTime} (HH:MM, Asia/Tehran)
              </Ltr>,
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
