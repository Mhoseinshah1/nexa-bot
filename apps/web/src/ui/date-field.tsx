import { t } from '../i18n/web.fa';

/**
 * The Jalali date / date-time / time field (W1.1) — replaces every native `type="date"`,
 * `type="datetime-local"` and `type="time"` input in the admin.
 *
 * VALUE CONTRACT (unchanged from the native inputs it replaces — the server receives exactly
 * what it received before): `YYYY-MM-DD` for `date`, `YYYY-MM-DDTHH:MM` for `datetime`,
 * `HH:MM` for `time`, and `''` for "no value". Only display and picking are Jalali.
 *
 * PHASE-0 INTERFACE STUB — agent A replaces the body with the real button + calendar popover.
 * Pages code against the props; tests drive it ONLY through `setDateField` in
 * `tests/web/ui-helpers.ts`, which agent A keeps working against the real component.
 */
export type DateFieldMode = 'date' | 'datetime' | 'time';

export interface DateFieldProps {
  /** The trigger's DOM id, so a `<Field htmlFor>` label names it. */
  id?: string;
  mode?: DateFieldMode;
  value: string;
  onChange: (value: string) => void;
  /** Same format as `value`. */
  min?: string;
  max?: string;
  disabled?: boolean;
  required?: boolean;
  /** Accessible name when no `<label htmlFor>` points at `id`. */
  label?: string;
  describedBy?: string;
  invalid?: boolean;
  /** Draws the compact (toolbar) size. */
  size?: 'md' | 'sm';
}

export function DateField({
  id,
  mode = 'date',
  value,
  onChange,
  min,
  max,
  disabled = false,
  required = false,
  label,
  describedBy,
  invalid = false,
  size = 'md',
}: DateFieldProps) {
  return (
    <input
      className={size === 'sm' ? 'input sm' : 'input'}
      data-date-field={mode}
      dir="ltr"
      placeholder={t('web.date_pick')}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      required={required}
      {...(id === undefined ? {} : { id })}
      {...(min === undefined ? {} : { 'data-min': min })}
      {...(max === undefined ? {} : { 'data-max': max })}
      {...(label === undefined ? {} : { 'aria-label': label })}
      {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
      {...(invalid ? { 'aria-invalid': true } : {})}
    />
  );
}
