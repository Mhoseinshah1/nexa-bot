import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_PREFIX,
  BACKUP_SCHEDULE_SETTING_KEYS,
  CONTROL_ROUTES,
  settingDefinition,
  type BackupStatusResponse,
  type SettingKey,
} from '@nexa/contracts';
import { BackupScheduleCard } from '../../apps/web/src/pages/backup-schedule';
import { intervalMinutes, presetOf, splitInterval } from '../../apps/web/src/backup-interval';
import { SETTINGS_MANAGED_ELSEWHERE } from '../../apps/web/src/settings-presentation';
import { renderPage, stubApi } from './harness';

/**
 * Spec §13.2 — the automatic backup schedule on the backup page.
 *
 * What an operator is SHOWN and what is WRITTEN: a switch and an interval as a number
 * with a unit or a preset, never milliseconds; each saved through the ordinary settings
 * write with the version it was read at; and the installation default named as such.
 */

const EDIT = ['backup.view', 'settings.view', 'settings.edit'];

function settingRow(key: string, value: unknown, version: number | null) {
  const definition = settingDefinition(key as SettingKey);
  return {
    key,
    value,
    source: version === null ? 'DEFAULT' : 'TENANT',
    version,
    updatedAt: version === null ? null : '2026-09-09T02:00:00.000Z',
    updatedByAdminId: null,
    description: definition.description,
    zeroMeaning: definition.zeroMeaning,
    mutability: definition.mutability,
    classification: definition.classification,
    configures: definition.configures,
    consumer: definition.consumer,
    storedValueInvalid: false,
  };
}

const STATUS: Pick<
  BackupStatusResponse,
  'scheduleEnabled' | 'intervalMs' | 'scheduleSource' | 'deliveryDestination'
> = {
  scheduleEnabled: false,
  intervalMs: 24 * 3_600_000,
  scheduleSource: { enabled: 'ENVIRONMENT', interval: 'ENVIRONMENT' },
  deliveryDestination: 'OPS_GROUP_TOPIC',
};

function routes(
  versions: { enabled: number | null; interval: number | null } = {
    enabled: null,
    interval: null,
  },
) {
  return [
    {
      url: `${API_PREFIX}${CONTROL_ROUTES.settings}`,
      body: {
        settings: [
          settingRow(BACKUP_SCHEDULE_SETTING_KEYS.enabled, null, versions.enabled),
          settingRow(BACKUP_SCHEDULE_SETTING_KEYS.intervalMinutes, null, versions.interval),
        ],
      },
    },
    {
      url: `${API_PREFIX}${CONTROL_ROUTES.setting(BACKUP_SCHEDULE_SETTING_KEYS.intervalMinutes)}`,
      body: {
        setting: settingRow(BACKUP_SCHEDULE_SETTING_KEYS.intervalMinutes, 180, 1),
        changed: true,
      },
    },
    {
      url: `${API_PREFIX}${CONTROL_ROUTES.setting(BACKUP_SCHEDULE_SETTING_KEYS.enabled)}`,
      body: { setting: settingRow(BACKUP_SCHEDULE_SETTING_KEYS.enabled, true, 1), changed: true },
    },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the backup schedule card', () => {
  it('shows the effective schedule in words, its source, and where backups go — never milliseconds', async () => {
    stubApi(routes());
    const { container } = renderPage(<BackupScheduleCard status={STATUS} permissions={EDIT} />);
    await screen.findByRole('button', { name: 'هر ۶ ساعت' });
    const text = container.textContent ?? '';
    expect(text).toContain('پیش‌فرض نصب');
    expect(text).toContain('تاپیک «💾 بکاپ‌ها» در گروه گزارش‌های مدیریتی');
    // The owner's presets, by name.
    for (const label of ['هر ۱ ساعت', 'هر ۳ ساعت', 'هر ۶ ساعت', 'هر ۱۲ ساعت', 'هر ۲۴ ساعت']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(text).not.toContain('86400000');
    expect(text).not.toMatch(/\bms\b/);
    // The current interval is the 24-hour preset, already selected.
    expect(screen.getByRole('button', { name: 'هر ۲۴ ساعت' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('saves a preset as whole minutes, with the version it read and a fresh key', async () => {
    const api = stubApi(routes());
    renderPage(<BackupScheduleCard status={STATUS} permissions={EDIT} />);
    fireEvent.click(await screen.findByRole('button', { name: 'هر ۳ ساعت' }));
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره‌ی فاصله' }));
    await waitFor(() => expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    const write = api.calls.find((call) => call.method === 'POST');
    expect(write?.url).toContain(encodeURIComponent(BACKUP_SCHEDULE_SETTING_KEYS.intervalMinutes));
    expect(write?.body).toMatchObject({ value: 180, expectedVersion: null });
    expect(
      String((write?.body as { idempotencyKey: string }).idempotencyKey).length,
    ).toBeGreaterThan(7);
  });

  it('turns the schedule on through the same settings write', async () => {
    const api = stubApi(routes({ enabled: 4, interval: null }));
    renderPage(<BackupScheduleCard status={STATUS} permissions={EDIT} />);
    const toggle = await screen.findByRole('switch', { name: 'بکاپ خودکار' });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    await waitFor(() => expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    const write = api.calls.find((call) => call.method === 'POST');
    expect(write?.url).toContain(encodeURIComponent(BACKUP_SCHEDULE_SETTING_KEYS.enabled));
    expect(write?.body).toMatchObject({ value: true, expectedVersion: 4 });
  });

  it('takes a custom value and unit, and refuses one outside the bounds before sending it', async () => {
    const api = stubApi(routes());
    renderPage(<BackupScheduleCard status={STATUS} permissions={EDIT} />);
    fireEvent.click(await screen.findByRole('button', { name: 'سفارشی' }));
    const value = screen.getByLabelText('مقدار');
    const unit = screen.getByLabelText('واحد');
    fireEvent.change(unit, { target: { value: 'minute' } });
    fireEvent.change(value, { target: { value: '5' } });
    expect(await screen.findByText('فاصله نمی‌تواند کمتر از ۱۵ دقیقه باشد.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ذخیره‌ی فاصله' })).toBeDisabled();

    fireEvent.change(unit, { target: { value: 'day' } });
    fireEvent.change(value, { target: { value: '۲' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره‌ی فاصله' }));
    await waitFor(() => expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    expect(api.calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      value: 2 * 24 * 60,
    });
  });

  it('offers nothing to change to an actor without settings.edit', async () => {
    stubApi(routes());
    renderPage(
      <BackupScheduleCard status={STATUS} permissions={['backup.view', 'settings.view']} />,
    );
    const toggle = await screen.findByRole('switch', { name: 'بکاپ خودکار' });
    expect(toggle).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'ذخیره‌ی فاصله' })).toBeNull();
    expect(
      screen.getByText('برای تغییر زمان‌بندی، دسترسی ویرایش تنظیمات لازم است.'),
    ).toBeInTheDocument();
  });

  it('says plainly when the archive goes nowhere', async () => {
    stubApi(routes());
    const { container } = renderPage(
      <BackupScheduleCard status={{ ...STATUS, deliveryDestination: 'NONE' }} permissions={EDIT} />,
    );
    await screen.findByRole('switch', { name: 'بکاپ خودکار' });
    expect(container.textContent).toContain('فقط روی سرور نگه داشته می‌شود');
  });

  it('is drawn on the backup page, not the generic settings page', () => {
    expect(SETTINGS_MANAGED_ELSEWHERE).toContain(BACKUP_SCHEDULE_SETTING_KEYS.enabled);
    expect(SETTINGS_MANAGED_ELSEWHERE).toContain(BACKUP_SCHEDULE_SETTING_KEYS.intervalMinutes);
  });
});

describe('the interval editor’s arithmetic', () => {
  it('reads a stored interval back as its largest whole unit and its preset', () => {
    expect(splitInterval(1440)).toEqual({ value: 1, unit: 'day' });
    expect(splitInterval(180)).toEqual({ value: 3, unit: 'hour' });
    expect(splitInterval(90)).toEqual({ value: 90, unit: 'minute' });
    expect(presetOf(360)).toBe('6h');
    expect(presetOf(90)).toBe('custom');
  });

  it('keeps the registry bounds: fifteen minutes to thirty days', () => {
    expect(intervalMinutes('15', 'minute')).toEqual({ ok: true, minutes: 15 });
    expect(intervalMinutes('14', 'minute')).toEqual({ ok: false, problem: 'too_short' });
    expect(intervalMinutes('30', 'day')).toEqual({ ok: true, minutes: 43_200 });
    expect(intervalMinutes('31', 'day')).toEqual({ ok: false, problem: 'too_long' });
    expect(intervalMinutes('1.5', 'hour')).toEqual({ ok: false, problem: 'invalid' });
    expect(intervalMinutes('۳', 'hour')).toEqual({ ok: true, minutes: 180 });
  });
});
