import type { TicketStatus } from '@nexa/contracts';
import type { WebKey } from './i18n/web.fa';
import type { Tone } from './ui/kit';

/*
 * How a ticket's status is WORDED and COLOURED, wherever a ticket is drawn (review N8,
 * PR #240): the tickets pages and Customer 360's support card read this one module.
 */

export const TICKET_STATUS_LABELS: Readonly<Record<TicketStatus, WebKey>> = {
  OPEN: 'web.ticket_status_open',
  WAITING_FOR_CUSTOMER: 'web.ticket_status_waiting_for_customer',
  WAITING_FOR_SUPPORT: 'web.ticket_status_waiting_for_support',
  CLOSED: 'web.ticket_status_closed',
};

export const TICKET_STATUS_TONES: Readonly<Record<TicketStatus, Tone>> = {
  OPEN: 'warn',
  WAITING_FOR_CUSTOMER: 'info',
  WAITING_FOR_SUPPORT: 'danger',
  CLOSED: 'neutral',
};
