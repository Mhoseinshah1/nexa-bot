import type { AppearanceSlot } from '@nexa/contracts';
import type { WebKey } from './i18n/web.fa';

/**
 * The Persian name of each appearance slot — ONE map, read by «🎨 ظاهر ربات» and by the
 * bot-buttons page's slot chooser, so the two screens cannot name a slot differently.
 * The catalogue itself (`APPEARANCE_SLOTS`) is the contract's; this is its chrome.
 */
export const APPEARANCE_SLOT_LABEL: Readonly<Record<AppearanceSlot, WebKey>> = {
  success: 'web.appearance_slot_success',
  error: 'web.appearance_slot_error',
  warning: 'web.appearance_slot_warning',
  info: 'web.appearance_slot_info',
  payment: 'web.appearance_slot_payment',
  wallet: 'web.appearance_slot_wallet',
  purchase: 'web.appearance_slot_purchase',
  service: 'web.appearance_slot_service',
  trial: 'web.appearance_slot_trial',
  referral: 'web.appearance_slot_referral',
  support: 'web.appearance_slot_support',
  ticket: 'web.appearance_slot_ticket',
  renewal: 'web.appearance_slot_renewal',
  traffic: 'web.appearance_slot_traffic',
  time: 'web.appearance_slot_time',
  date: 'web.appearance_slot_date',
  link: 'web.appearance_slot_link',
  user: 'web.appearance_slot_user',
  location: 'web.appearance_slot_location',
  active: 'web.appearance_slot_active',
  inactive: 'web.appearance_slot_inactive',
};
