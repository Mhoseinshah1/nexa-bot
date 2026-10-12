import {
  UNLIMITED_TRAFFIC_BYTES,
  type AppearanceSlot,
  type InlineButtonStyle,
  type ServiceState,
  type TemplateKey,
} from '@nexa/contracts';

/**
 * Batch 01 item 3 — the status a customer is SHOWN for one service in «سرویس‌های من», and
 * its colour. Derived, never stored and never chosen by hand: the same three facts the
 * card already prints (the state, the expiry, the usage) decide it, at the moment the
 * screen is drawn, so a list or card drawn after a refresh or a usage sync shows the new
 * colour with nothing else to update.
 *
 * Why derived rather than the state alone: `ACTIVE` is what the provisioner last wrote,
 * and the expiry sweep and the usage sync that turn a lapsed or used-up service into
 * `EXPIRED` run on a schedule. Between the deadline and that run the row still says
 * `ACTIVE`, and a green «فعال» over a service that has stopped working is the lie the
 * owner reported. So a passed deadline or a used-up allowance is RED whatever the state
 * says — judged only from facts the row holds:
 *
 *  - by time: `expiresAt` is set and `expiresAt <= now` (half-open: the deadline instant
 *    itself is already past, as everywhere else in this codebase);
 *  - by volume: the usage has been READ (`usageSyncedAt` set — an unread usage is unknown,
 *    never zero and never full), the allowance is finite (`UNLIMITED_TRAFFIC_BYTES` is
 *    0n) and `used >= limit`.
 *
 * The ONE table (the card, the list and the search results all read it):
 *
 * | State               | Facts                         | Shown        | Marker            | Button  |
 * | ------------------- | ----------------------------- | ------------ | ----------------- | ------- |
 * | ACTIVE              | in window, allowance left     | ACTIVE       | `{icon:active}`   | success |
 * | ACTIVE / SUSPENDED  | deadline passed               | EXPIRED      | `{icon:inactive}` | danger  |
 * | ACTIVE / SUSPENDED  | in window, allowance used up  | EXHAUSTED    | `{icon:inactive}` | danger  |
 * | EXPIRED             | allowance used up, in window  | EXHAUSTED    | `{icon:inactive}` | danger  |
 * | EXPIRED             | anything else                 | EXPIRED      | `{icon:inactive}` | danger  |
 * | SUSPENDED           | in window, allowance left     | SUSPENDED    | `{icon:inactive}` | danger  |
 * | PENDING_PROVISION   | any                           | PENDING      | `{icon:time}`     | (tenant)|
 * | UNRECONCILED        | any                           | UNRECONCILED | `{icon:warning}`  | (tenant)|
 * | TERMINATED          | any                           | TERMINATED   | `{icon:error}`    | (tenant)|
 *
 * SUSPENDED is red because the domain's meaning is "switched off — it does not connect"
 * (by the customer's own disable, an operator or policy); it was already drawn with the
 * `inactive` slot before this table existed. Time beats volume when both are true: renewal
 * is what fixes a lapsed service, and the deadline is the fact the customer acts on.
 * The three non-serving, non-final states are not given a colour Telegram does not have:
 * their button keeps the tenant's own style for `services.item`.
 */
export const SERVICE_DISPLAY_STATUSES = [
  'ACTIVE',
  'EXPIRED',
  'EXHAUSTED',
  'SUSPENDED',
  'PENDING',
  'UNRECONCILED',
  'TERMINATED',
] as const;
export type ServiceDisplayStatus = (typeof SERVICE_DISPLAY_STATUSES)[number];

export interface ServiceStatusFacts {
  readonly state: ServiceState;
  readonly expiresAt: Date | null;
  readonly trafficLimitBytes: bigint;
  readonly trafficUsedBytes: bigint;
  /** Null: usage was never read, so it is unknown — never treated as used up. */
  readonly usageSyncedAt: Date | null;
  /** From the `Clock` port, by the caller. */
  readonly now: Date;
}

/** Whether the service's window has closed: a deadline at or before `now`. */
export function isPastDeadline(facts: Pick<ServiceStatusFacts, 'expiresAt' | 'now'>): boolean {
  return facts.expiresAt !== null && facts.expiresAt.getTime() <= facts.now.getTime();
}

/** Whether a READ usage has reached a FINITE allowance. */
export function isAllowanceUsedUp(
  facts: Pick<ServiceStatusFacts, 'trafficLimitBytes' | 'trafficUsedBytes' | 'usageSyncedAt'>,
): boolean {
  return (
    facts.usageSyncedAt !== null &&
    facts.trafficLimitBytes !== UNLIMITED_TRAFFIC_BYTES &&
    facts.trafficUsedBytes >= facts.trafficLimitBytes
  );
}

export function serviceDisplayStatus(facts: ServiceStatusFacts): ServiceDisplayStatus {
  switch (facts.state) {
    case 'TERMINATED':
      return 'TERMINATED';
    case 'UNRECONCILED':
      return 'UNRECONCILED';
    case 'PENDING_PROVISION':
      return 'PENDING';
    case 'EXPIRED':
      return !isPastDeadline(facts) && isAllowanceUsedUp(facts) ? 'EXHAUSTED' : 'EXPIRED';
    case 'ACTIVE':
    case 'SUSPENDED':
      if (isPastDeadline(facts)) return 'EXPIRED';
      if (isAllowanceUsedUp(facts)) return 'EXHAUSTED';
      return facts.state;
  }
}

export interface ServiceStatusPresentation {
  /** The Appearance slot the status is marked with, on the card and on the list button. */
  readonly slot: AppearanceSlot;
  /**
   * The list button's style. Null: no colour is DERIVED for this status, and the button
   * keeps the tenant's `bot.inline_buttons` style for `services.item`.
   */
  readonly buttonStyle: Exclude<InlineButtonStyle, 'default'> | null;
  /** The card's status line (its body starts with the same slot's marker). */
  readonly label: TemplateKey;
}

/*
 * Batch 2026-10-10 (brief C3, C5.7): the three statuses that do not serve keep ONE colour —
 * the owner's acceptance rows make all three red — but each has its own MARKER, so the
 * difference is not carried by colour alone: time ran out (`date`), volume ran out
 * (`traffic`), switched off (`inactive`). All three are slots `APPEARANCE_SLOTS` already
 * declared, so no contract changes and a tenant's custom emoji for each still applies.
 */
export const SERVICE_STATUS_PRESENTATION: Readonly<
  Record<ServiceDisplayStatus, ServiceStatusPresentation>
> = {
  ACTIVE: { slot: 'active', buttonStyle: 'success', label: 'bot.service.state_active' },
  EXPIRED: { slot: 'date', buttonStyle: 'danger', label: 'bot.service.state_expired' },
  EXHAUSTED: { slot: 'traffic', buttonStyle: 'danger', label: 'bot.service.state_exhausted' },
  SUSPENDED: { slot: 'inactive', buttonStyle: 'danger', label: 'bot.service.state_suspended' },
  PENDING: { slot: 'time', buttonStyle: null, label: 'bot.service.state_pending_provision' },
  UNRECONCILED: { slot: 'warning', buttonStyle: null, label: 'bot.service.state_unreconciled' },
  TERMINATED: { slot: 'error', buttonStyle: null, label: 'bot.service.state_terminated' },
};
