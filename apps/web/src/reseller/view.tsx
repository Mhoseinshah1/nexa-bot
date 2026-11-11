import type { ReactNode } from 'react';
import type { ResellerServiceRow, ServiceState } from '@nexa/contracts';
import type { MoneyWire } from '@nexa/contracts';
import { formatDate, formatMoneyText, formatNumber, formatTrafficGbText } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { Badge, Progress, type Tone } from '../ui/kit';

/** Small shared views of the panel: a service's state, usage and expiry, and a card frame. */

const STATE_LABEL: Readonly<Record<ServiceState, WebKey>> = {
  PENDING_PROVISION: 'web.rp_state_pending_provision',
  ACTIVE: 'web.rp_state_active',
  SUSPENDED: 'web.rp_state_suspended',
  EXPIRED: 'web.rp_state_expired',
  TERMINATED: 'web.rp_state_terminated',
  UNRECONCILED: 'web.rp_state_unreconciled',
};

const STATE_TONE: Readonly<Record<ServiceState, Tone>> = {
  PENDING_PROVISION: 'neutral',
  ACTIVE: 'ok',
  SUSPENDED: 'warn',
  EXPIRED: 'danger',
  TERMINATED: 'neutral',
  UNRECONCILED: 'warn',
};

export function StateBadge({ state }: { state: ServiceState }) {
  return (
    <Badge tone={STATE_TONE[state]} dot>
      {t(STATE_LABEL[state])}
    </Badge>
  );
}

/** Zero is the wire's «no limit»: the figure is drawn as a word, never as 0. */
export function isUnlimited(row: Pick<ResellerServiceRow, 'trafficLimitBytes'>): boolean {
  return BigInt(row.trafficLimitBytes) === 0n;
}

export function usageText(row: ResellerServiceRow): string {
  const used = `${formatTrafficGbText(BigInt(row.trafficUsedBytes))} ${t('web.unit_gib')}`;
  const limit = isUnlimited(row)
    ? t('web.rp_unlimited')
    : `${formatTrafficGbText(BigInt(row.trafficLimitBytes))} ${t('web.unit_gib')}`;
  return t('web.rp_used_of').replace('{used}', used).replace('{limit}', limit);
}

/** The usage bar and its text. An unlimited service has no bar: there is nothing to fill. */
export function Usage({ row }: { row: ResellerServiceRow }) {
  return (
    <div className="rp-usage">
      {!isUnlimited(row) && (
        <Progress
          value={BigInt(row.trafficUsedBytes)}
          max={BigInt(row.trafficLimitBytes)}
          label={t('web.rp_col_usage')}
        />
      )}
      <span className="muted small">{usageText(row)}</span>
    </div>
  );
}

const DAY_MS = 86_400_000;

/** Days left or «expired», and the Jalali date beside it as the title. */
export function Expiry({
  row,
  nowMs = Date.now(),
}: {
  row: Pick<ResellerServiceRow, 'expiresAt' | 'expiring'>;
  nowMs?: number;
}) {
  if (row.expiresAt === null) return <span className="muted">—</span>;
  const left = Date.parse(row.expiresAt) - nowMs;
  const date = formatDate(row.expiresAt);
  if (left <= 0) {
    return (
      <span className="danger" title={date}>
        {t('web.rp_expired_on')} <span className="muted small">{date}</span>
      </span>
    );
  }
  const days = Math.ceil(left / DAY_MS);
  return (
    <span className={row.expiring ? 'warn' : undefined} title={date}>
      {t('web.rp_days_left').replace('{n}', formatNumber(days))}{' '}
      <span className="muted small">{date}</span>
    </span>
  );
}

export function RpCard({
  title,
  hint,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rp-card${className === undefined ? '' : ` ${className}`}`}>
      {(title !== undefined || actions !== undefined) && (
        <header className="rp-card-head">
          <div>
            {title !== undefined && <h2>{title}</h2>}
            {hint !== undefined && <p className="muted small">{hint}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * A ledger amount with its sign in front, isolated left to right (U+2066..U+2069) so the sign
 * stays beside its digits inside a right-to-left row: «+250,000 unit», never the unit first.
 */
export function signedAmountText(direction: 'CREDIT' | 'DEBIT', money: MoneyWire): string {
  return `\u2066${direction === 'CREDIT' ? '+' : '\u2212'}${formatMoneyText(money)}\u2069`;
}
