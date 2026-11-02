import { useEffect, useState } from 'react';
import type { GlobalSearchHit, GlobalSearchKind } from '@nexa/contracts';
import { WEB_FA, t, type WebKey } from './i18n/web.fa';

/**
 * Helpers for the top-bar search over customers, orders and services (R11 A1). The server decides
 * which kinds the operator may read and returns only those; nothing here guesses a permission.
 */

/** A one-character query would match half the tenant; the search starts at two. */
export const GLOBAL_SEARCH_MIN_CHARS = 2;
/** The wait after the last keystroke, so typing does not send a request per letter. */
export const GLOBAL_SEARCH_DEBOUNCE_MS = 300;

const GROUP_KEYS: Readonly<Record<GlobalSearchKind, WebKey>> = {
  CUSTOMER: 'web.search_group_customer',
  ORDER: 'web.search_group_order',
  SERVICE: 'web.search_group_service',
  PAYMENT: 'web.search_group_payment',
  TICKET: 'web.search_group_ticket',
};

export function searchGroupLabel(kind: GlobalSearchKind): string {
  return t(GROUP_KEYS[kind]);
}

const SEARCH_HIT_BASE: Readonly<Record<GlobalSearchKind, string>> = {
  CUSTOMER: '/users',
  ORDER: '/orders',
  SERVICE: '/services',
  PAYMENT: '/payments',
  TICKET: '/tickets',
};

/** Where a hit opens: the detail page of its own kind. */
export function searchHitPath(kind: GlobalSearchKind, id: string): string {
  const base = SEARCH_HIT_BASE[kind];
  return `${base}/${encodeURIComponent(id)}`;
}

const STATE_PREFIX: Readonly<Record<GlobalSearchKind, string>> = {
  CUSTOMER: 'web.user_status_',
  ORDER: 'web.order_state_',
  SERVICE: 'web.service_state_',
  PAYMENT: 'web.payment_state_',
  TICKET: 'web.ticket_status_',
};

/** The Persian name of a hit's state, from the catalogue the lists already use; null if none. */
export function searchHitStateLabel(kind: GlobalSearchKind, hit: GlobalSearchHit): string | null {
  if (hit.state === null) return null;
  const key = `${STATE_PREFIX[kind]}${hit.state.toLowerCase()}`;
  return key in WEB_FA ? t(key as WebKey) : null;
}

/** `value`, but only after it has been still for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}
