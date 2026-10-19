import type { CustomerStatus, CustomerSummaryResponse } from '@nexa/contracts';
import { t, type WebKey } from '../i18n/web.fa';
import { Badge, type Tone } from '../ui/kit';

/**
 * The small pieces the customer LIST and the Customer 360 page both draw, in one place so
 * the two cannot give two answers to what a status looks like.
 */

const STATUS_LABELS: Readonly<Record<CustomerStatus, WebKey>> = {
  ACTIVE: 'web.user_status_active',
  BLOCKED: 'web.user_status_blocked',
};

const STATUS_TONES: Readonly<Record<CustomerStatus, Tone>> = {
  ACTIVE: 'ok',
  BLOCKED: 'danger',
};

export function StatusBadge({ status }: { status: CustomerStatus }) {
  return (
    <Badge tone={STATUS_TONES[status]} dot>
      {t(STATUS_LABELS[status])}
    </Badge>
  );
}

/** The display name, from the two parts Telegram gives, or nothing at all. */
export function displayName(row: CustomerSummaryResponse): string | null {
  const joined = [row.firstName, row.lastName]
    .filter((part) => part !== null)
    .join(' ')
    .trim();
  return joined === '' ? null : joined;
}

export function Dash() {
  return <span className="faint">—</span>;
}

/** The first letter of a display name, for the avatar tile beside it. Decorative. */
export function initialOf(name: string): string {
  return Array.from(name.trim())[0] ?? '';
}

/**
 * The avatar tile's tint (the demo's `avc`): one of six soft tones chosen by the name's
 * characters, so one customer always draws the same colour. Decorative, like the letter.
 */
export function avatarTint(name: string): string {
  const sum = Array.from(name).reduce((total, char) => total + (char.codePointAt(0) ?? 0), 0);
  return `av${sum % 6}`;
}
