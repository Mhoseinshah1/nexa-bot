/**
 * The personal and free-text fields of an archived Mirza history record, set to null for a
 * reader without `legacy.invoices.pii.view` — the same rule the legacy invoice archive and
 * the legacy service review apply (their personal cells arrive NULL, `piiRedacted`).
 *
 * Applied by key at ANY depth, so a Telegram id inside `ownership_evidence[]` is caught as
 * well as the top-level one. The raw source columns (`fields`, `fields_raw`) are a fork's
 * unproven columns and may hold anything, so every value in them is redacted. What remains
 * are codes, states, amounts, references and provenance.
 */

/** Keys whose value is a Telegram id, a panel or Telegram username, or free text. */
const PERSONAL_KEYS: ReadonlySet<string> = new Set([
  // Telegram ids (a person)
  'telegram_user_id',
  'final_owner_telegram_user_id',
  'source_user_id',
  'raw_id',
  'owner_value_raw',
  'handler_admin_telegram_id',
  // usernames
  'username',
  'service_username',
  'panel_account_username',
  'sold_to_panel_username',
  // free text a person wrote, or a value that identifies a payment
  'customer_text',
  'description',
  'reason',
  'admin_note',
  'text',
  'message',
  'detail',
  'subject',
  'title',
  'label',
  'tracking',
  'receipt_trace',
]);

/** Raw source-column maps: every value in them is redacted. */
const RAW_COLUMN_KEYS: ReadonlySet<string> = new Set(['fields', 'fields_raw']);

/**
 * Objects that name a person; their `raw` is the unparsed Telegram id
 * (`owner: {raw, telegram_user_id, …}` on service operations and cancellations).
 */
const PERSON_OBJECT_KEYS: ReadonlySet<string> = new Set([
  'owner',
  'customer',
  'requester',
  'referrer',
  'referee',
  'current_owner_candidate',
  'original_owner',
]);

export interface RedactedPayload {
  readonly payload: Record<string, unknown>;
  /** Dotted paths, `[]` for any array element, sorted and de-duplicated. */
  readonly redacted: readonly string[];
}

export function redactHistoryPayload(payload: Record<string, unknown>): RedactedPayload {
  const paths = new Set<string>();
  const out = redactObject(payload, '', null, paths);
  return { payload: out, redacted: [...paths].sort() };
}

function redactValue(
  value: unknown,
  path: string,
  parentKey: string | null,
  paths: Set<string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, `${path}[]`, parentKey, paths));
  }
  if (value !== null && typeof value === 'object') {
    return redactObject(value as Record<string, unknown>, path, parentKey, paths);
  }
  return value;
}

function redactObject(
  value: Record<string, unknown>,
  path: string,
  parentKey: string | null,
  paths: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    const personal =
      PERSONAL_KEYS.has(key) ||
      (key === 'raw' && parentKey !== null && PERSON_OBJECT_KEYS.has(parentKey));
    if (personal && child !== null) {
      out[key] = null;
      paths.add(childPath);
    } else if (RAW_COLUMN_KEYS.has(key) && child !== null && typeof child === 'object') {
      out[key] = Object.fromEntries(
        Object.keys(child as Record<string, unknown>).map((column) => [column, null]),
      );
      paths.add(`${childPath}.*`);
    } else {
      out[key] = redactValue(child, childPath, key, paths);
    }
  }
  return out;
}
