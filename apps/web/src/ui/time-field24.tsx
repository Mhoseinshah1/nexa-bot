import { useId } from 'react';
import { t } from '../i18n/web.fa';

/**
 * A Persian 24-hour time picker (owner decision, web redesign): hours 00–23, minutes in
 * 5-minute steps, Persian digits, and a day-part label («شب») beside it — never the browser's
 * AM/PM picker. The value is the wire's own `HH:MM` string, so a page swaps it in for a
 * `type="time"` input without touching its state, request or validation.
 *
 * Two native `<select>`s: keyboard, screen-reader and touch behaviour come from the browser.
 * A minute the stored value holds that is not on the 5-minute grid (an old schedule) is kept
 * as an extra option so opening the field never silently rewrites it.
 */

const PERSIAN_DIGIT_ZERO = 0x06f0; // U+06F0, the Extended Arabic-Indic zero

export function persianDigits(value: string | number): string {
  return String(value).replace(/\d/g, (d) => String.fromCharCode(PERSIAN_DIGIT_ZERO + Number(d)));
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

export const MINUTE_STEP = 5;

/** The day-part word for an hour 0–23. */
export function dayPartKey(
  hour: number,
):
  | 'web.kit_daypart_dawn'
  | 'web.kit_daypart_morning'
  | 'web.kit_daypart_afternoon'
  | 'web.kit_daypart_evening'
  | 'web.kit_daypart_night' {
  if (hour < 5) return 'web.kit_daypart_dawn';
  if (hour < 12) return 'web.kit_daypart_morning';
  if (hour < 17) return 'web.kit_daypart_afternoon';
  if (hour < 20) return 'web.kit_daypart_evening';
  return 'web.kit_daypart_night';
}

/** `HH:MM` → hour and minute, or null when it is not a valid 24-hour time. */
export function parseTime24(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function TimeField24({
  value,
  onChange,
  label,
  disabled = false,
  id,
}: {
  /** `HH:MM`, or '' when unset. */
  value: string;
  onChange: (next: string) => void;
  /** The field's accessible name. */
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  const auto = useId();
  const base = id ?? auto;
  const parsed = parseTime24(value);
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const minutes = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => i * MINUTE_STEP);
  if (parsed !== null && !minutes.includes(parsed.minute)) {
    minutes.push(parsed.minute);
    minutes.sort((a, b) => a - b);
  }
  const hourValue = parsed === null ? '' : pad2(parsed.hour);
  const minuteValue = parsed === null ? '' : pad2(parsed.minute);
  return (
    <div className="time24" role="group" aria-label={label} dir="ltr">
      <select
        id={`${base}-h`}
        aria-label={`${label} — ${t('web.kit_time_hour')}`}
        disabled={disabled}
        value={hourValue}
        onChange={(event) => {
          const h = event.target.value;
          onChange(`${h}:${minuteValue === '' ? '00' : minuteValue}`);
        }}
      >
        {parsed === null && <option value="">--</option>}
        {hours.map((h) => (
          <option key={h} value={pad2(h)}>
            {persianDigits(pad2(h))}
          </option>
        ))}
      </select>
      <span className="time24-sep" aria-hidden="true">
        :
      </span>
      <select
        id={`${base}-m`}
        aria-label={`${label} — ${t('web.kit_time_minute')}`}
        disabled={disabled}
        value={minuteValue}
        onChange={(event) => {
          const m = event.target.value;
          onChange(`${hourValue === '' ? '00' : hourValue}:${m}`);
        }}
      >
        {parsed === null && <option value="">--</option>}
        {minutes.map((m) => (
          <option key={m} value={pad2(m)}>
            {persianDigits(pad2(m))}
          </option>
        ))}
      </select>
      <span className="time24-part" dir="rtl">
        {parsed === null ? '' : t(dayPartKey(parsed.hour))}
      </span>
    </div>
  );
}
