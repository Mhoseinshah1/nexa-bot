// Admin-in-bot: the bounds, the permission keys and the panel-section gate the admin
// flows share. Moved verbatim out of bot-runtime.ts (R9 split).
import type { PermissionKey } from '@nexa/contracts';
import { CLIENT_APP_VIEW_PERMISSION } from '../../../modules/control/client-apps/application/client-app.service.js';

/**
 * The management panel's prefixes (Phase 5T), deliberately UPPERCASE.
 *
 * Every customer-facing prefix above is a lowercase letter, so no admin prefix can ever
 * become a prefix of one of those — the collision the resend/service pair states as a
 * silent failure, where every tap routes to whichever branch was tested first.
 *
 * `callback_data` is capped at 64 bytes, which is what decides the shape of these: a
 * prefix plus ONE uuid (38 bytes) fits and a prefix plus two does not. So the panel
 * carries a payment or an administrator and never a pair, and nothing here carries a
 * Telegram id — that arrives by command, where there is room for it.
 */
/**
 * How many queue rows one screen shows.
 *
 * A bound on a KEYBOARD, like `TOPUP_PRESETS_MAX`: Telegram refuses a reply_markup past
 * its own limits, and an unbounded queue is a panel that stops working exactly when an
 * installation is busiest. Ten is what the service asks for, applied in SQL against the
 * same predicate — so ten rows are ten decisions still to make.
 */
export const ADMIN_QUEUE_LIMIT = 10;

/*
 * How many roster rows one keyboard carries.
 *
 * Larger than `ADMIN_QUEUE_LIMIT` because these are not work items to be
 * cleared — an operator is looking somebody up, and a roster is people created
 * by hand rather than a customer-sized set. Small enough that the keyboard is
 * well inside Telegram's limit whatever the usernames are. The header prints
 * `shown` against `total`, so reaching this bound is visible rather than silent.
 */
export const ADMIN_ROSTER_LIMIT = 30;

/**
 * What `bot.admin.panel_detail` renders for a panel with no cap.
 *
 * A LITERAL rather than a template key, and that is a deliberate exception worth
 * stating: `cap` is a `STRING` placeholder inside a message the catalogue owns, and a
 * surface may not compose one template out of another. What it may do is pass a value,
 * and the honest value for "unlimited" is a dash — a figure would read as a cap and
 * `0` would read as a full panel, which is the exact inversion a null means.
 */
export const UNCAPPED = '\u2014';

/**
 * The two marks `bot.admin.panel_detail` renders for a username mode.
 *
 * Symbols and not words, for exactly the reason `UNCAPPED` is an em dash: the copy
 * belongs to the catalogue and a surface may pass a VALUE into it but may not compose
 * one message out of another. `ON` is a tick and `OFF` is the same dash the cap uses
 * for "there is none", so the three lines of this block read consistently.
 */
export const MODE_ON = '\u2713';

export const MODE_OFF = UNCAPPED;

/**
 * The two permissions the panel's sections charge, named once.
 *
 * Read through the guard by the services behind each section; these constants only
 * decide which BUTTONS exist, which is not authorization — `docs/conventions.md`:
 * never by not drawing a button.
 */
export const RECEIPTS_VIEW_PERMISSION: PermissionKey = 'receipts.view';

export const ADMINS_VIEW_PERMISSION: PermissionKey = 'admins.view';

/*
 * What the roster's status buttons are DRAWN for, and nothing more.
 * `AdminManagementService.setStatus` charges it through the same guard the Web Admin
 * uses, and re-checks it inside the writing transaction, so a crafted `7:` callback
 * from an administrator who lacks it is refused there and leaves the denial record.
 */
export const ADMINS_EDIT_PERMISSION: PermissionKey = 'admins.edit';

export const RECEIPTS_REVIEW_PERMISSION: PermissionKey = 'receipts.review';

/*
 * The second key the credit-to-wallet disposition charges (Payment File 02 §12). Decides
 * whether its button is DRAWN; `creditToWallet` charges it through the guard.
 */
export const WALLET_CREDIT_PERMISSION: PermissionKey = 'users.wallet.credit';

/*
 * The three the services section reads, and the same rule applies: these decide which
 * BUTTONS exist, which is not authorization. `ServiceAdminService`, `ProvisioningService`
 * and `DeliveryService` each charge their own key through the same guard the Web Admin
 * uses, so a crafted callback from an administrator who lacks one is refused there.
 */
export const SERVICES_VIEW_PERMISSION: PermissionKey = 'services.view';

export const SERVICES_EDIT_PERMISSION: PermissionKey = 'services.edit';

export const SERVICES_TERMINATE_PERMISSION: PermissionKey = 'services.terminate';

/*
 * The two the panels section reads, and the same rule again: these decide which BUTTONS
 * exist, never what is allowed. `PanelService.list` and `.get` charge `panels.view`;
 * `.testConnection` and `.setStatus` charge `panels.edit`, through the same guard the
 * Web Admin uses. There is deliberately no third key here, because this surface never
 * touches a credential: `panels.credentials.rotate` has no button in Telegram at all.
 */
export const PANELS_VIEW_PERMISSION: PermissionKey = 'panels.view';

/*
 * ONE key for both halves of the reminders section, because there is only one.
 *
 * The section prints five SETTINGS and three FLAGS, and this used to gate it on
 * `settings.view` AND `features.view` — a pair that reads sensibly and cannot be
 * satisfied: `features.view` is in no catalogue. `PERMISSIONS` does not define it, so
 * no role can be granted it, so the button was drawn for nobody, including the owner.
 *
 * The real answer is that flags are not separately permissioned in this product:
 * `FeatureFlagsService` charges `settings.view` for a read and `settings.edit` for a
 * write, deliberately and in terms. So does this.
 */
export const SETTINGS_VIEW_PERMISSION: PermissionKey = 'settings.view';

export const PANELS_EDIT_PERMISSION: PermissionKey = 'panels.edit';

/*
 * The two the customers section reads, and the same rule a fourth time: these decide
 * which BUTTONS exist, never what is allowed. `CustomerService.list` and `.get` charge
 * `users.view`; `.list` charges `users.search` ON TOP of it when the search names a
 * Telegram id, which is why the lookup command is a different question from the list;
 * `.block` and `.unblock` charge `users.block` and re-check it inside the writing
 * transaction. A crafted `9:` callback from an administrator holding none of them is
 * refused there and leaves the denial record.
 *
 * `users.edit` is deliberately absent. It is declared, it is seeded to `operator`, and
 * nothing charges it — see the comment above it in `packages/contracts/src/permissions.ts`
 * for why that is the product's answer rather than an unfinished feature. Drawing an
 * edit button here would be the first thing to make it a lie.
 */
export const CUSTOMERS_VIEW_PERMISSION: PermissionKey = 'users.view';

export const CUSTOMERS_BLOCK_PERMISSION: PermissionKey = 'users.block';

/*
 * The categories section's two, and the same rule a fifth time: they decide which
 * BUTTONS exist. `ProductCategoryService.list` charges `catalog.view`; every write charges
 * `catalog.edit` through the guard and again inside its transaction, so a crafted `kb:`
 * callback from an administrator who holds only the first is refused there and leaves the
 * denial record.
 */
export const CATALOG_VIEW_PERMISSION: PermissionKey = 'catalog.view';

export const CATALOG_EDIT_PERMISSION: PermissionKey = 'catalog.edit';

/**
 * The key each section of the management panel is ADVERTISED by, in one list.
 *
 * Two readers: `adminTurn`, which answers as a customer when an administrator holds
 * none of them, and `isAdmin`, which decides whether `/start` draws the panel row at
 * all. The comment on `isAdmin` already said these two must agree — "the keyboard must
 * not promise a panel the turn would refuse, and it must not withhold one from an
 * administrator who has a section" — and they had stopped agreeing: the reminders
 * section was added with `settings.view` and only one of the two lists learned about
 * it, so an administrator whose only section was the reminders got no panel row and no
 * way to reach one from the keyboard. That is precisely the "missing arm" the comment
 * names, hand-maintained in two places.
 *
 * So there is one list and both read it, the way `ADMIN_INTENTS` is derived rather than
 * listed. Adding a section means adding one entry here, and it cannot half-land.
 *
 * `users.block`, `panels.edit`, `services.edit` and the rest are deliberately absent:
 * this list is what OPENS a section, never what may be done inside one.
 */
const PANEL_SECTION_PERMISSIONS: readonly PermissionKey[] = [
  RECEIPTS_VIEW_PERMISSION,
  ADMINS_VIEW_PERMISSION,
  SERVICES_VIEW_PERMISSION,
  PANELS_VIEW_PERMISSION,
  SETTINGS_VIEW_PERMISSION,
  CUSTOMERS_VIEW_PERMISSION,
  CATALOG_VIEW_PERMISSION,
  // Spec §7: the client apps section («تنظیم ویدیو»).
  CLIENT_APP_VIEW_PERMISSION,
];

/** Whether these permissions open any section of the panel. */
export function hasAnyPanelSection(permissions: ReadonlySet<PermissionKey>): boolean {
  return PANEL_SECTION_PERMISSIONS.some((key) => permissions.has(key));
}
