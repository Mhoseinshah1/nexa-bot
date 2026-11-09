/**
 * Web-only chrome.
 *
 * Anything a customer could ever see lives in `@nexa/i18n` and is shared with
 * the Telegram surface. This file holds strings that only the admin SPA can
 * render — page titles, table headers, status labels — under the `web.*`
 * namespace, and is checked by the same missing-key script.
 */

import { WEB_FA_COMMON } from './web.fa/common';
import { WEB_FA_CUSTOMERS } from './web.fa/customers';
import { WEB_FA_PAYMENTS_1 } from './web.fa/payments-1';
import { WEB_FA_PAYMENTS_2 } from './web.fa/payments-2';
import { WEB_FA_GATEWAYS } from './web.fa/gateways';
import { WEB_FA_SUPPORT } from './web.fa/support';
import { WEB_FA_SUPPORT_AI } from './web.fa/support-ai';
import { WEB_FA_PRODUCTS } from './web.fa/products';
import { WEB_FA_SERVICES } from './web.fa/services';
import { WEB_FA_MARKETING } from './web.fa/marketing';
import { WEB_FA_RESELLERS } from './web.fa/resellers';
import { WEB_FA_BOT_1 } from './web.fa/bot-1';
import { WEB_FA_BOT_2 } from './web.fa/bot-2';
import { WEB_FA_PANELS } from './web.fa/panels';
import { WEB_FA_SETTINGS } from './web.fa/settings';
import { WEB_FA_SYSTEM } from './web.fa/system';
import { WEB_FA_ACCESS } from './web.fa/access';
import { WEB_FA_AUDIT_REPORTS } from './web.fa/audit-reports';
import { WEB_FA_LEGACY } from './web.fa/legacy';
import { WEB_FA_ERRORS } from './web.fa/errors';
import { WEB_FA_HOSTING } from './web.fa/hosting';
import { WEB_FA_HOSTING_BACKUP } from './web.fa/hosting-backup';
import { WEB_FA_REDESIGN_KIT } from './web.fa/redesign-kit';

/*
 * The catalogue is split by page group under `./web.fa/`; this object merges the
 * slices. No key appears in two slices (`pnpm check:i18n` reads them all).
 */
export const WEB_FA = {
  ...WEB_FA_COMMON,
  ...WEB_FA_CUSTOMERS,
  ...WEB_FA_PAYMENTS_1,
  ...WEB_FA_PAYMENTS_2,
  ...WEB_FA_GATEWAYS,
  ...WEB_FA_SUPPORT,
  ...WEB_FA_SUPPORT_AI,
  ...WEB_FA_PRODUCTS,
  ...WEB_FA_SERVICES,
  ...WEB_FA_MARKETING,
  ...WEB_FA_RESELLERS,
  ...WEB_FA_BOT_1,
  ...WEB_FA_BOT_2,
  ...WEB_FA_PANELS,
  ...WEB_FA_SETTINGS,
  ...WEB_FA_SYSTEM,
  ...WEB_FA_ACCESS,
  ...WEB_FA_AUDIT_REPORTS,
  ...WEB_FA_LEGACY,
  ...WEB_FA_ERRORS,
  ...WEB_FA_HOSTING,
  ...WEB_FA_HOSTING_BACKUP,
  ...WEB_FA_REDESIGN_KIT,
} as const;

export type WebKey = keyof typeof WEB_FA;

export function t(key: WebKey): string {
  return WEB_FA[key];
}
