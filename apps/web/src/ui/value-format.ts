import { CURRENCY_CODES, type MoneyWire } from '@nexa/contracts';
import { t, type WebKey } from '../i18n/web.fa';
import { formatMoneyText, formatNumber } from '../format';

/**
 * The one way a stored value (a setting, a feature's configuration, a recorded field) is
 * shown to a person. Never `JSON.stringify`: `{"amountMinor":"0","currency":"IRT"}` is the
 * wire, not something an operator should read.
 *
 *   absent / empty → «تعیین نشده»      boolean → «روشن» / «خاموش»
 *   money object   → the money format  `{days: 3}`, `{hours: 2}`… → «3 روز» / «2 ساعت»
 *   array          → a readable list   any other object → one «label: value» line per field
 *
 * Pure text, so a table cell, a title attribute and a test all read the same words.
 * Request bodies and keys do not come through here; they stay JSON.
 */

const DURATION_FIELDS: readonly (readonly [string, WebKey])[] = [
  ['days', 'web.unit_days'],
  ['hours', 'web.unit_hours'],
  ['minutes', 'web.unit_minutes'],
  ['seconds', 'web.unit_seconds'],
];

/** Labels for the field names of the known object shapes; any other key is shown as it is. */
const FIELD_LABELS: Readonly<Record<string, WebKey>> = {
  handle: 'web.value_field_handle',
  chatId: 'web.value_field_chat_id',
  mandatory: 'web.value_field_mandatory',
  joinUrl: 'web.channel_join_url',
  amountMinor: 'web.value_field_amount',
  currency: 'web.value_field_currency',
};

/** Where a value comes from decides its unit; a bare number has none of its own. */
export interface ValueHint {
  /** The unit word of a plain number (a setting's `integer` control). */
  readonly unit?: WebKey;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMoney(value: unknown): value is MoneyWire {
  return (
    isRecord(value) &&
    typeof value.amountMinor === 'string' &&
    /^-?\d+$/u.test(value.amountMinor) &&
    typeof value.currency === 'string' &&
    (CURRENCY_CODES as readonly string[]).includes(value.currency)
  );
}

function durationOf(value: Record<string, unknown>): string | null {
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  const hit = DURATION_FIELDS.find(([field]) => field === keys[0]);
  const amount = hit === undefined ? undefined : value[hit[0]];
  if (hit === undefined || typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  return `${formatNumber(amount)} ${t(hit[1])}`;
}

export function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (isRecord(value) && Object.keys(value).length === 0)
  );
}

/** A value as one or more lines of Persian text: one line for a scalar, one per field of an object. */
export function valueLines(value: unknown, hint: ValueHint = {}): readonly string[] {
  if (isEmptyValue(value)) return [t('web.feature_setting_unset')];
  if (typeof value === 'boolean') return [value ? t('web.enabled') : t('web.disabled')];
  if (typeof value === 'number' || typeof value === 'bigint') {
    const figure = typeof value === 'number' ? formatNumber(value) : formatNumber(Number(value));
    return [hint.unit === undefined ? figure : `${figure} ${t(hint.unit)}`];
  }
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    const items = value.map((item) => valueLines(item, hint).join(t('web.list_separator')));
    return [items.join(t('web.list_separator'))];
  }
  if (isMoney(value)) return [formatMoneyText(value)];
  if (isRecord(value)) {
    const duration = durationOf(value);
    if (duration !== null) return [duration];
    return Object.entries(value).flatMap(([key, inner]) => {
      const labelKey = FIELD_LABELS[key];
      const label = labelKey === undefined ? key : t(labelKey);
      const lines = valueLines(inner, hint);
      return lines.map((line) => `${label}: ${line}`);
    });
  }
  return [String(value)];
}

/** `valueLines` joined for a place that holds one line of text. */
export function formatValueText(value: unknown, hint: ValueHint = {}): string {
  return valueLines(value, hint).join(t('web.value_lines_separator'));
}
