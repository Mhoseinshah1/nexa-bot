// Admin-in-bot: services, panels, the username policy and the reminder settings.
// Moved verbatim out of bot-runtime.ts (R9 split): each method is a free function
// taking the runtime first.
import {
  COMMERCE_ERROR_CODES,
  PANEL_ERROR_CODES,
  providerDescriptor,
  providerUsernameLookupSchema,
  uuidV7Schema,
} from '@nexa/contracts';
import type {
  ActorContext,
  PermissionKey,
  ServiceActionAvailability,
  ServiceOperatorAction,
  ServiceReminderThresholds,
  TemplateKey,
  TenantContext,
} from '@nexa/contracts';
import { previewUsername, validateUsernamePolicy } from '@nexa/contracts';
import type { PanelUsernamePolicy } from '../../../modules/platform/panels/application/ports.js';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import type { ServiceRecord } from '../../../modules/commerce/provisioning/application/ports.js';
import type { OperatorServiceOperation } from '../../../modules/commerce/provisioning/application/provisioning.service.js';
import type {
  ServiceAdminService,
  ServiceOperationHistory,
} from '../../../modules/commerce/provisioning/application/service-admin.service.js';
import { encodeKeysetToken, type KeysetToken } from '../keyset-token.js';
import { readHealth } from '../../../modules/platform/panels/application/panel-health-view.js';
import {
  ADMIN_CUSTOMER_CALLBACK_PREFIX,
  ADMIN_PANELS_PAGE_CALLBACK_PREFIX,
  ADMIN_PANEL_ARCHIVE_ASK_CALLBACK_PREFIX,
  ADMIN_PANEL_ARCHIVE_CALLBACK_PREFIX,
  ADMIN_PANEL_DETAIL_CALLBACK_PREFIX,
  ADMIN_PANEL_DISABLE_CALLBACK_PREFIX,
  ADMIN_PANEL_ENABLE_CALLBACK_PREFIX,
  ADMIN_PANEL_TEST_CALLBACK_PREFIX,
  ADMIN_REMINDER_EDIT_CALLBACK_PREFIX,
  ADMIN_REMINDER_SET_CALLBACK_PREFIX,
  ADMIN_SERVICES_BROWSE_CALLBACK_DATA,
  ADMIN_SERVICES_BROWSE_PAGE_CALLBACK_PREFIX,
  ADMIN_SERVICES_CALLBACK_PREFIX,
  ADMIN_SERVICE_CALLBACK_PREFIX,
  ADMIN_SERVICE_RECONCILE_CALLBACK_PREFIX,
  ADMIN_SERVICE_RESEND_CALLBACK_PREFIX,
  ADMIN_SERVICE_RESUME_CALLBACK_PREFIX,
  ADMIN_SERVICE_RETRY_CALLBACK_PREFIX,
  ADMIN_SERVICE_ROTATE_ASK_CALLBACK_PREFIX,
  ADMIN_SERVICE_ROTATE_CALLBACK_PREFIX,
  ADMIN_SERVICE_SUSPEND_CALLBACK_PREFIX,
  ADMIN_SERVICE_SYNC_CALLBACK_PREFIX,
  ADMIN_SERVICE_TERMINATE_ASK_CALLBACK_PREFIX,
  ADMIN_SERVICE_TERMINATE_CALLBACK_PREFIX,
  ADMIN_USERNAME_CALLBACK_PREFIX,
  ADMIN_USERNAME_STRATEGY_CALLBACK_PREFIX,
  ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX,
  REMINDER_SETTING_CODES,
  type ReminderSettingCode,
  type UsernameStrategyCode,
  rotationStamp,
} from './callbacks.js';
import { type BotIntent } from './intents.js';
import { refusal } from './refusals.js';
import { type PendingReply } from './replies.js';
import type { BotRuntime } from '../bot-runtime.js';
import {
  ADMIN_QUEUE_LIMIT,
  CUSTOMERS_VIEW_PERMISSION,
  MODE_OFF,
  MODE_ON,
  PANELS_EDIT_PERMISSION,
  SERVICES_EDIT_PERMISSION,
  SERVICES_TERMINATE_PERMISSION,
  SERVICES_VIEW_PERMISSION,
  UNCAPPED,
} from './admin-common.js';
import { isCustomerMiss } from './admin-customers-flow.js';

const USERNAME_STRATEGY_BUTTONS: readonly (readonly [UsernameStrategyCode, TemplateKey])[] = [
  ['r', 'bot.admin.username_strategy_random'],
  ['p', 'bot.admin.username_strategy_prefix_random'],
  ['t', 'bot.admin.username_strategy_telegram_id_random'],
];

/** The button label for each code's chooser. One template per setting, so each names itself. */
const REMINDER_SETTING_BUTTONS = {
  ef: 'bot.admin.reminder_expiry_first_button',
  es: 'bot.admin.reminder_expiry_second_button',
  uf: 'bot.admin.reminder_usage_first_button',
  us: 'bot.admin.reminder_usage_second_button',
  un: 'bot.admin.reminder_usage_final_button',
} as const satisfies Record<ReminderSettingCode, TemplateKey>;

/**
 * The values a tap may choose, per family.
 *
 * A SMALL MENU OF SCALARS, which is CBR-011's shape (B) and the one Mirza uses for the
 * settings that are not free text. Every entry is inside the contract's own bounds, so
 * a tap cannot propose a value the schema would reject — the schema still checks, and
 * the combination guard still checks, but an operator never meets a refusal they could
 * not have avoided.
 */
const REMINDER_DAY_OPTIONS = [1, 2, 3, 5, 7, 10, 14, 30] as const;

const REMINDER_PERCENT_OPTIONS = [50, 60, 70, 75, 80, 85, 90, 95, 100] as const;

function reminderOptionsFor(code: ReminderSettingCode): readonly number[] {
  return code === 'ef' || code === 'es' ? REMINDER_DAY_OPTIONS : REMINDER_PERCENT_OPTIONS;
}

/** The order the section draws its five buttons in: expiry first, then usage. */
const REMINDER_SETTING_CODE_ORDER = [
  'ef',
  'es',
  'uf',
  'us',
  'un',
] as const satisfies readonly ReminderSettingCode[];

/** The value a code currently names, so the chooser can print it before replacing it. */
function reminderValueOf(config: ServiceReminderThresholds, code: ReminderSettingCode): number {
  switch (code) {
    case 'ef':
      return config.expiryFirstDays;
    case 'es':
      return config.expirySecondDays;
    case 'uf':
      return config.usageFirstPercent;
    case 'us':
      return config.usageSecondPercent;
    case 'un':
      return config.usageFinalPercent;
  }
}

/**
 * A switch, as the section prints it.
 *
 * A SYMBOL and not a word, and that is the whole reason this compiles: `check:i18n`
 * refuses hard-coded customer-facing strings in a surface, and «روشن»/«خاموش» here was
 * exactly that — a translatable sentence fragment living outside the catalogue. An
 * earlier revision of this function had them with a comment explaining why it was
 * acceptable; the comment was wrong and the check said so.
 *
 * The pair is also the vocabulary an operator already reads: Mirza's capability list
 * marks every toggle ✅ or ❌ (CBR-009), so this says the same thing the same way.
 */
function onOff(enabled: boolean): string {
  return enabled ? '\u2705' : '\u274c';
}

/**
 * Each services-section prefix and the intent it parses to, in ONE place.
 *
 * Read by the boundary and by nothing else. Written as a table so the prefix and the
 * intent are chosen together: nine separate branches would be nine chances to point one
 * at the wrong intent, and the row that would matter is the last, where a mis-wiring
 * would turn the asking callback into the destructive one.
 */
/**
 * The operation each acting intent plans, and the button that offers it.
 *
 * `ADMIN_SERVICE_RESEND` and `ADMIN_SERVICE_RETRY` are absent from the operation map on
 * purpose: a resend plans none, and a retry goes through `retryProvisioning`, which has
 * its own refusal for the case that matters — an UNRECONCILED service is reconciled
 * rather than given a second provider account.
 */
const ADMIN_SERVICE_OPERATIONS: Readonly<Partial<Record<BotIntent, OperatorServiceOperation>>> = {
  ADMIN_SERVICE_SYNC: 'SYNC_USAGE',
  ADMIN_SERVICE_RECONCILE: 'RECONCILE',
  ADMIN_SERVICE_SUSPEND: 'SUSPEND',
  ADMIN_SERVICE_RESUME: 'RESUME',
  ADMIN_SERVICE_TERMINATE: 'TERMINATE',
  ADMIN_SERVICE_ROTATE: 'ROTATE_SUBSCRIPTION',
};

/**
 * Each action's button: which verdict offers it, which permission allows it, and where
 * it points.
 *
 * TERMINATE points at the ASKING prefix. That is the row this table exists to make
 * visible, because a destructive callback drawn on a detail screen is a one-tap
 * deletion, and the difference between the two prefixes is one letter.
 */
const ADMIN_SERVICE_BUTTONS: readonly {
  readonly action: ServiceOperatorAction;
  readonly key: TemplateKey;
  readonly prefix: string;
  readonly permission: PermissionKey;
}[] = [
  {
    action: 'SYNC_USAGE',
    key: 'bot.admin.service_sync_button',
    prefix: ADMIN_SERVICE_SYNC_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
  {
    action: 'RESEND_CONFIG',
    key: 'bot.admin.service_resend_button',
    prefix: ADMIN_SERVICE_RESEND_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
  {
    action: 'RETRY_PROVISION',
    key: 'bot.admin.service_retry_button',
    prefix: ADMIN_SERVICE_RETRY_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
  {
    action: 'RECONCILE',
    key: 'bot.admin.service_reconcile_button',
    prefix: ADMIN_SERVICE_RECONCILE_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
  {
    action: 'SUSPEND',
    key: 'bot.admin.service_suspend_button',
    prefix: ADMIN_SERVICE_SUSPEND_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
  {
    action: 'RESUME',
    key: 'bot.admin.service_resume_button',
    prefix: ADMIN_SERVICE_RESUME_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
  {
    action: 'TERMINATE',
    key: 'bot.admin.service_terminate_button',
    prefix: ADMIN_SERVICE_TERMINATE_ASK_CALLBACK_PREFIX,
    permission: SERVICES_TERMINATE_PERMISSION,
  },
  // The ASKING prefix, for the reason TERMINATE's row gives.
  {
    action: 'ROTATE_LINK',
    key: 'bot.admin.service_rotate_link_button',
    prefix: ADMIN_SERVICE_ROTATE_ASK_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
];

/** What one ask-then-act screen needs: the verdict it re-reads and where it points. */
interface AdminServiceAsk {
  readonly action: ServiceOperatorAction;
  readonly permission: PermissionKey;
  readonly key: TemplateKey;
  readonly confirmKey: TemplateKey;
  /** The confirming callback for this service, as the confirmation screen draws it. */
  readonly confirmData: (service: {
    readonly id: string;
    readonly subscriptionUrl: string | null;
  }) => string;
}

export const ADMIN_SERVICE_TERMINATE_ASK: AdminServiceAsk = {
  action: 'TERMINATE',
  permission: SERVICES_TERMINATE_PERMISSION,
  key: 'bot.admin.service_terminate_ask',
  confirmKey: 'bot.admin.service_terminate_confirm_button',
  confirmData: (service) => `${ADMIN_SERVICE_TERMINATE_CALLBACK_PREFIX}${service.id}`,
};

export const ADMIN_SERVICE_ROTATE_ASK: AdminServiceAsk = {
  action: 'ROTATE_LINK',
  permission: SERVICES_EDIT_PERMISSION,
  key: 'bot.admin.service_rotate_link_ask',
  confirmKey: 'bot.admin.service_rotate_link_confirm_button',
  confirmData: (service) =>
    `${ADMIN_SERVICE_ROTATE_CALLBACK_PREFIX}${service.id}.${rotationStamp(service.subscriptionUrl)}`,
};

/**
 * The buttons one service's detail draws, for one administrator.
 *
 * TWO conditions, and both are necessary. The VERDICT says the service allows the action
 * right now — the state, the provider's capabilities, the panel's configuration, and
 * whether one of that type is already open — and comes from the same evaluator the write
 * paths agree with. The PERMISSION says this administrator may ask for it. Drawing a
 * button that fails either is drawing a control whose every press records a denial,
 * which is the noise the alerts page exists to keep clear.
 *
 * Neither is authorization. Every action re-checks its permission and all its conditions
 * inside its own request; `docs/conventions.md` names the rule this must not be read as
 * satisfying — never by not drawing a button.
 */
function adminServiceButtons(
  serviceId: string,
  actions: readonly ServiceActionAvailability[],
  permissions: ReadonlySet<PermissionKey>,
): CustomerButton[] {
  const available = new Set(
    actions.filter((entry) => entry.available).map((entry) => entry.action),
  );
  return ADMIN_SERVICE_BUTTONS.filter(
    (button) => available.has(button.action) && permissions.has(button.permission),
  ).map((button) => ({
    label: { kind: 'TEMPLATE' as const, key: button.key },
    data: `${button.prefix}${serviceId}`,
  }));
}

/**
 * What a customer's row says, in the order an operator recognises them.
 *
 * `@username` when there is one, else the name Telegram reported, else the numeric id.
 * A customer may have none of the first two, so the id is the fallback rather than a
 * dash: a row reading `— ACTIVE` names nobody, and a keyboard of them is unusable.
 *
 * The numeric id is NOT withheld here the way an administrator's is. The reason that
 * roster withholds it is that a forwardable message naming where an administrator signs
 * in from is most of the way to finding them; a customer's Telegram id is the handle the
 * support conversation already quoted, it is on the Web Admin list, and this surface
 * exists so an operator can act on it from a phone.
 *
 * The status rides along, because the one thing an operator scanning this list is
 * looking for is who is blocked.
 */
/**
 * How many rows the name lookup reads before deciding the name is not unique.
 *
 * Small on purpose. The question the probe answers is "is this name unique HERE", not
 * "how many services carry it": one extra row settles it, and the rest of the bound is
 * headroom so the disambiguation screen can actually list what it found rather than
 * saying "more than one" and stopping. A name on more matches than this is not a
 * support lookup any more, and the browse list is where that conversation belongs.
 */
const AMBIGUOUS_MATCH_PROBE = 5;

/**
 * What the name lookup found, as four cases rather than a nullable row.
 *
 * `NONE` and `SYNTAX` are different sentences — "no such service" and "that is not a
 * service name" — and `MANY` is the one the Codex review of this branch added: a name
 * unique per PANEL is not unique per tenant, so answering with one arbitrary row is how
 * a terminate lands on the wrong customer's account.
 */
type AdminServiceLookup =
  | { readonly kind: 'SYNTAX' }
  | { readonly kind: 'NONE' }
  | { readonly kind: 'MANY'; readonly matches: readonly ServiceRecord[] }
  | { readonly kind: 'ONE'; readonly found: Awaited<ReturnType<ServiceAdminService['detail']>> };

/**
 * One ambiguous match, labelled by what tells it apart from the others.
 *
 * NOT the username: every match carries the same one, which is why this screen exists.
 * NOT the panel's name either, however useful that would be — reading a panel charges
 * `panels.view`, and an administrator holding `services.view` alone would get a denial
 * per match rather than a list.
 *
 * So: the lifecycle state and the day the service was created, both off the row already
 * in hand. Neither is a credential, and between them they separate "the one I sold last
 * week" from "the one that has been terminated since spring". The detail behind the
 * button is what confirms it, because that names the panel and the customer.
 */
function adminServiceMatchLabel(service: ServiceRecord): string {
  return `${service.state} — ${service.createdAt.toISOString().slice(0, 10)}`;
}

/**
 * Whether a refusal is about the SERVICE rather than about the administrator.
 *
 * The four service refusals are things a person can act on — the state moved, the
 * provider cannot do it, the panel needs fixing, one of that type is already under way —
 * and they earn the sentence that says so. Everything else, a permission denial above
 * all, falls through to the panel's single refusal, which tells whoever holds that chat
 * nothing about what exists.
 */
function isServiceRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED ||
    code === COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE ||
    code === COMMERCE_ERROR_CODES.SERVICE_UNRECONCILED ||
    code === COMMERCE_ERROR_CODES.SERVICE_NOT_DELIVERABLE ||
    code === COMMERCE_ERROR_CODES.ORDER_STATE_INVALID
  );
}

/**
 * Whether a refusal is about the PANEL rather than about the administrator.
 *
 * `PANEL_NOT_VALIDATED` earns its own answer, because it is the one refusal on this
 * screen an administrator can resolve without leaving it: the Test button is right
 * there. The rest — a status that moved, credentials that do not satisfy the
 * provider's shape, a spent probe budget, a lost race — are one sentence pointing at
 * the Web Admin, for the reason `isServiceRefusal` gives. A permission denial is in
 * neither set and falls through to the panel's single refusal, which tells whoever
 * holds that chat nothing about what exists.
 */
function isPanelRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === PANEL_ERROR_CODES.PANEL_ARCHIVED ||
    code === PANEL_ERROR_CODES.PANEL_CREDENTIALS_MISSING ||
    code === PANEL_ERROR_CODES.PANEL_CREDENTIAL_UNSUPPORTED ||
    code === PANEL_ERROR_CODES.PANEL_PROBE_LIMITED ||
    code === PANEL_ERROR_CODES.PANEL_CONFIGURATION_CHANGED ||
    code === PANEL_ERROR_CODES.PANEL_NAME_TAKEN
  );
}

/**
 * The services queue: what needs an administrator, and nothing else.
 *
 * TWO searches, and the choice of which two is the whole design. `UNRECONCILED` is a
 * service whose create was lost — nothing resolves it on its own, and 4D made it a
 * dead end deliberately so that nobody asks a panel for a second account. A `FAILED`
 * delivery is a customer who paid and has no link, after the automatic lane gave up
 * at its attempt ceiling. Every other state either settles itself or belongs to the
 * customer, and a queue that listed them would be a list of things not to do.
 *
 * Bounded by `ADMIN_QUEUE_LIMIT` per search and NOT paged, for the reason that
 * constant gives: this is a keyboard, Telegram refuses an oversized one, and ten rows
 * are ten decisions. An installation with more than ten of either has a bigger
 * question than the eleventh row, and the Web Admin pages properly.
 */
export async function adminServices(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  permissions: ReadonlySet<PermissionKey>,
): Promise<PendingReply> {
  const [unreconciled, undelivered] = await Promise.all([
    rt.deps.serviceAdmin.list(scope, actor, {
      limit: ADMIN_QUEUE_LIMIT,
      search: { state: 'UNRECONCILED' },
    }),
    rt.deps.serviceAdmin.list(scope, actor, {
      limit: ADMIN_QUEUE_LIMIT,
      search: { deliveryState: 'FAILED' },
    }),
  ]);

  /*
   * De-duplicated by id: a service can be BOTH unreconciled and undelivered, and two
   * buttons for one service is a list that looks longer than the work is.
   */
  const seen = new Set<string>();
  const buttons: CustomerButton[] = [];
  for (const service of [...unreconciled.items, ...undelivered.items]) {
    if (seen.has(service.id)) continue;
    seen.add(service.id);
    buttons.push({
      /*
       * The provider username, which is the handle an operator types into the panel
       * and is NOT a credential. Not the subscription ref and not the client id —
       * both are bearer capabilities, and this message stays in the chat for ever.
       */
      label: { kind: 'TEXT' as const, text: service.providerUsername },
      data: `${ADMIN_SERVICE_CALLBACK_PREFIX}${service.id}`,
    });
  }
  /*
   * The browse button, appended to BOTH answers — including the empty queue.
   *
   * An empty queue is the normal, healthy state, and until WP3 it was also a dead
   * end: "nothing needs attention" with no way from there to the service a customer
   * is asking about. `docs/wp3-service-audit.md` is blunt about what that cost —
   * service management was the most built of the three and the least reachable.
   *
   * Drawn behind `services.view`, which is also what the section itself is behind, so
   * in practice it is always drawn here; the check is written out anyway because a
   * button is advertising and never permission — `list` charges the key again.
   */
  const withBrowse = permissions.has(SERVICES_VIEW_PERMISSION)
    ? [
        ...buttons,
        {
          label: { kind: 'TEMPLATE' as const, key: 'bot.admin.services_browse_button' as const },
          data: ADMIN_SERVICES_BROWSE_CALLBACK_DATA,
        },
      ]
    : buttons;
  if (buttons.length === 0) {
    return {
      key: 'bot.admin.services_none',
      values: {},
      buttons: withBrowse,
      orderId: null,
    };
  }
  return { key: 'bot.admin.services_section', values: {}, buttons: withBrowse, orderId: null };
}

/**
 * The inventory: one button per service, newest first, and a page button when there
 * is more.
 *
 * Beside the queue above rather than instead of it, and the difference is what each
 * list IS — the note `adminPanels` carries about a fleet applies here word for word.
 * A queue of ten is ten decisions and an eleventh is a bigger question than the row;
 * an inventory has to be able to reach the four-hundredth service, because that is
 * where the customer who just wrote in happens to be.
 *
 * No filter on state and no filter on delivery: a TERMINATED service is exactly what
 * "my account stopped working" often means, and a list that hid it would be fast at
 * answering everything except the question people actually ask.
 *
 * `list` charges `services.view` itself, so an administrator who reached this through
 * a crafted callback without it is refused there rather than here.
 */
export async function adminServicesBrowse(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  cursor: KeysetToken | null,
): Promise<PendingReply> {
  const page = await rt.deps.serviceAdmin.list(scope, actor, {
    limit: ADMIN_QUEUE_LIMIT,
    ...(cursor === null ? {} : { cursor }),
    search: {},
  });

  const buttons: CustomerButton[] = page.items.map((service) => ({
    /*
     * The provider username, which is the handle an operator types into the panel and
     * is NOT a credential — the same rule the queue above states. Not the
     * subscription ref and not the client id: both are bearer capabilities and this
     * message stays in that chat for ever.
     */
    label: { kind: 'TEXT' as const, text: service.providerUsername },
    data: `${ADMIN_SERVICE_CALLBACK_PREFIX}${service.id}`,
  }));
  if (buttons.length === 0) {
    return { key: 'bot.admin.services_browse_none', values: {}, buttons: [], orderId: null };
  }

  /*
   * The next page, appended only when the cursor ENCODES — the rule the panels
   * section and the customer's own services list both state: a cursor this codec
   * cannot carry would become a button whose `callback_data` is a bare prefix, and
   * the honest answer to that is the same as having no further page.
   */
  const token = page.nextCursor === null ? null : encodeKeysetToken(page.nextCursor);
  if (token !== null) {
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.services_more_button' },
      data: `${ADMIN_SERVICES_BROWSE_PAGE_CALLBACK_PREFIX}${token}`,
    });
  }
  return { key: 'bot.admin.services_browse', values: {}, buttons, orderId: null };
}

// -------------------------------------------------------------------------
// The panels section (Phase 6B)
// -------------------------------------------------------------------------

/**
 * The fleet: one button per live panel, newest first, and a page button when there
 * is more.
 *
 * PAGED rather than bounded-and-truncated, which is the opposite of what the services
 * queue does, and the difference is what each list IS. The services section is a
 * QUEUE of work — ten rows are ten decisions and an eleventh is a bigger question than
 * the row. A fleet is an inventory: every panel is a legitimate destination, and an
 * installation with twenty of them must be able to reach the twentieth. So this
 * carries the repository's own keyset cursor, through the codec that makes it fit
 * Telegram's 64 bytes.
 *
 * `LIVE` and not `ALL`: an archived panel has no action on this surface — restoring
 * one may need a new name, and a name is not typed into a chat here — so listing them
 * would be a list of buttons that can only report what cannot be done.
 *
 * `list` charges `panels.view` itself, so an administrator who reached this through a
 * crafted callback without it is refused there rather than here.
 */
/**
 * Every reminder setting and switch, printed before anything is editable.
 *
 * The whole point of the screen, and the cure for the defect CBR-013 and BC-SB-003
 * name: seven of twelve legacy settings screens never show the value they are about
 * to replace, so "an admin cannot read the current configuration without overwriting
 * it". Here the read is a read.
 *
 * `reminderConfig.read` charges `settings.view` itself — the one key both the
 * settings and the flags are read under. The
 * button that led here was drawn behind the same pair, and this is checked ANYWAY:
 * not drawing a button is never the control, because a callback can be replayed from
 * an old message after a role change.
 */
export async function adminReminders(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
): Promise<PendingReply> {
  const config = await rt.deps.reminderConfig.read(scope, actor);
  return {
    key: 'bot.admin.reminders_section',
    values: {
      expiry: onOff(config.expiryEnabled),
      expired: onOff(config.expiredNoticeEnabled),
      usage: onOff(config.usageEnabled),
      firstDays: config.expiryFirstDays,
      secondDays: config.expirySecondDays,
      firstPercent: config.usageFirstPercent,
      secondPercent: config.usageSecondPercent,
      finalPercent: config.usageFinalPercent,
    },
    buttons: REMINDER_SETTING_CODE_ORDER.map((code) => ({
      label: { kind: 'TEMPLATE' as const, key: REMINDER_SETTING_BUTTONS[code] },
      data: `${ADMIN_REMINDER_EDIT_CALLBACK_PREFIX}${code}`,
    })),
    orderId: null,
  };
}

/** One setting, its current value, and the values a tap may replace it with. */
export async function adminReminderEdit(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  code: ReminderSettingCode,
): Promise<PendingReply> {
  const config = await rt.deps.reminderConfig.read(scope, actor);
  return {
    key: 'bot.admin.reminder_choose',
    values: {
      setting: REMINDER_SETTING_CODES[code],
      current: reminderValueOf(config, code),
    },
    /*
     * The options are plain TEXT labels, because a number is data and not a sentence.
     * `check:i18n` forbids hard-coded customer-facing STRINGS in a surface; rendering
     * `String(85)` is neither hard-coded nor a string a translator would touch.
     */
    buttons: reminderOptionsFor(code).map((option) => ({
      label: { kind: 'TEXT' as const, text: String(option) },
      data: `${ADMIN_REMINDER_SET_CALLBACK_PREFIX}${code}:${String(option)}`,
    })),
    orderId: null,
  };
}

/**
 * Writes one threshold, or says why the combination was refused.
 *
 * The write goes through `SettingsService.set`, which is the SAME path the Web Admin
 * uses: the same permission, the same audit row, the same idempotency record and the
 * same `ReminderThresholdsGuard`. This surface adds no rule of its own, which is what
 * makes the two surfaces impossible to drift apart.
 *
 * A refusal is rendered, not thrown. `refuseReminderThresholds` produces Persian
 * prose naming which of the five is wrong; letting it reach the generic error handler
 * would replace that with a shrug, which is the legacy `⭕️ ورودی نا معتبر` this whole
 * section is written against.
 */
export async function adminReminderSet(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  code: ReminderSettingCode,
  value: number,
  idempotencyKey: string,
): Promise<PendingReply> {
  const key = REMINDER_SETTING_CODES[code];
  /*
   * SUFFIXED, and the suffix is load-bearing — the same note `draft` carries.
   *
   * The update's bare key is already consumed by the turn that resolved this
   * account, so presenting it again with a different payload is
   * `platform.idempotency_payload_mismatch`. That throws, `adminTurn` catches
   * everything as `bot.admin.refused`, and the operator sees a generic denial for a
   * write that was never refused by any permission. Every other admin write on this
   * surface suffixes; this one did not.
   */
  const result = await rt.deps.reminderConfig.write(
    scope,
    actor,
    key,
    value,
    `${idempotencyKey}:reminder-${code}`,
  );
  if (!result.ok) {
    return {
      key: 'bot.admin.reminder_refused',
      values: { reason: result.reason },
      buttons: [],
      orderId: null,
    };
  }
  return {
    key: 'bot.admin.reminder_saved',
    values: { setting: key, value },
    buttons: [],
    orderId: null,
  };
}

export async function adminPanels(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  cursor: KeysetToken | null,
): Promise<PendingReply> {
  const page = await rt.deps.panelAdmin.list(scope, actor, {
    limit: ADMIN_QUEUE_LIMIT,
    archived: 'LIVE',
    cursor,
  });

  const buttons: CustomerButton[] = page.panels.map((view) => ({
    /*
     * The NAME the operator gave it, and nothing else. Not the base URL: an address
     * is most of what somebody needs to go looking, and this message stays in that
     * chat for ever and is forwardable.
     */
    label: { kind: 'TEXT' as const, text: view.panel.name },
    data: `${ADMIN_PANEL_DETAIL_CALLBACK_PREFIX}${view.panel.id}`,
  }));
  if (buttons.length === 0) {
    return { key: 'bot.admin.panels_none', values: {}, buttons: [], orderId: null };
  }

  /*
   * The next page, appended only when the cursor ENCODES — the rule the customer's
   * own services list states: a cursor this codec cannot carry would become a button
   * whose `callback_data` is a bare prefix, and the honest answer to that is the same
   * as having no further page.
   */
  const token = page.nextCursor === null ? null : encodeKeysetToken(page.nextCursor);
  if (token !== null) {
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.panels_more_button' },
      data: `${ADMIN_PANELS_PAGE_CALLBACK_PREFIX}${token}`,
    });
  }
  return { key: 'bot.admin.panels_section', values: {}, buttons, orderId: null };
}

/**
 * One panel: what it is, what its last probe said, how full it is, and the actions
 * this administrator may take on it.
 *
 * The health three — the state, when it was checked, and whether that is stale — come
 * from `readHealth`, the SAME projection the Web Admin's response builder calls, so
 * the two surfaces cannot come to disagree about whether a disabled panel reads as
 * `DISABLED`. The occupancy comes from the capacity projection the service attaches,
 * for the same reason.
 *
 * What it does NOT carry: the base URL, any credential, any masked stand-in for one,
 * and the provider's response body. The failure is the KIND from the frozen taxonomy,
 * because a provider's own error text can carry a hostname, a path or a token
 * fragment — and the Web Admin is where a probe is read in full.
 */
export async function adminPanelDetail(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  panelId: string,
  permissions: ReadonlySet<PermissionKey>,
): Promise<PendingReply> {
  let view;
  try {
    view = await rt.deps.panelAdmin.get(scope, actor, panelId);
  } catch {
    /*
     * Unknown, another tenant's, or malformed — ONE answer for all three, the rule
     * `bot.admin.service_gone` states: telling them apart would let anybody holding a
     * panel id learn whether it exists.
     */
    return { key: 'bot.admin.panel_gone', values: {}, buttons: [], orderId: null };
  }

  const reading = readHealth(view.panel, view.health, rt.deps.clock.now());
  const mayEdit = permissions.has(PANELS_EDIT_PERMISSION);
  const buttons: CustomerButton[] = [];
  if (mayEdit) {
    /*
     * Test is offered for a panel that is not archived, which is the same condition
     * `testConnection` enforces: it refuses an ARCHIVED panel, so a button for one
     * could only ever record a refusal.
     */
    if (view.panel.status !== 'ARCHIVED') {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.panel_test_button' },
        data: `${ADMIN_PANEL_TEST_CALLBACK_PREFIX}${view.panel.id}`,
      });
    }
    if (view.panel.status === 'DISABLED') {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.panel_enable_button' },
        data: `${ADMIN_PANEL_ENABLE_CALLBACK_PREFIX}${view.panel.id}`,
      });
    }
    if (view.panel.status === 'ACTIVE') {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.panel_disable_button' },
        data: `${ADMIN_PANEL_DISABLE_CALLBACK_PREFIX}${view.panel.id}`,
      });
    }
    if (view.panel.status !== 'ARCHIVED') {
      buttons.push({
        /*
         * The ASKING prefix. `W:` opens the question and `X:` archives, and the two
         * differ by one character in a table — which is why that table exists and why
         * the archiving row is its last one.
         */
        label: { kind: 'TEMPLATE', key: 'bot.admin.panel_archive_button' },
        data: `${ADMIN_PANEL_ARCHIVE_ASK_CALLBACK_PREFIX}${view.panel.id}`,
      });
    }
    /*
     * Offered for an ARCHIVED panel too, and deliberately: `update` refuses one, so
     * the button records a refusal rather than working — but the SECTION behind it
     * is also where the policy is read, and an operator should be able to see what
     * an archived panel was configured to do.
     */
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.username_button' },
      data: `${ADMIN_USERNAME_CALLBACK_PREFIX}${view.panel.id}`,
    });
  }

  return {
    key: 'bot.admin.panel_detail',
    values: {
      name: view.panel.name,
      /*
       * The descriptor's canonical name, with the stored type as the fallback the
       * Web Admin's own projection uses. `providerDescriptor` is nullable because a
       * stored row could in principle name a type this build has no adapter for —
       * which panel creation refuses, so the fallback is a belt rather than a case.
       */
      provider:
        providerDescriptor(view.panel.providerType)?.canonicalName ?? view.panel.providerType,
      status: view.panel.status,
      health: reading.state,
      ...(reading.checkedAt === null ? {} : { checkedAt: reading.checkedAt }),
      ...(reading.failure === null ? {} : { failure: reading.failure }),
      services: view.capacity.services,
      reservations: view.capacity.reservations,
      /*
       * A STRING, and `bot.admin.panel_detail` says why: "no cap" is one of this
       * field's values, and rendering that as 0 would read as a full panel — the
       * exact inversion a null cap means.
       */
      cap: view.capacity.maxServices === null ? UNCAPPED : String(view.capacity.maxServices),
      /*
       * The policy, and it is configuration rather than a secret.
       *
       * An administrator reading the template is the only way to answer "why is this
       * customer's account called that" — the question a support conversation starts
       * from. The base URL and the credentials stay out of this message for the
       * reasons the docblock gives; a list of placeholder tokens is neither of those.
       *
       * The DASH for a null prefix or template is the same value the cap uses for
       * "there is none", and means the same thing here: this preset takes no
       * configuration, so there is nothing to read.
       */
      usernameCustom: view.panel.usernamePolicy.allowCustom ? MODE_ON : MODE_OFF,
      usernameAutomatic: view.panel.usernamePolicy.allowAutomatic ? MODE_ON : MODE_OFF,
      usernamePrefix: view.panel.usernamePolicy.prefix ?? UNCAPPED,
      usernameTemplate: view.panel.usernamePolicy.template ?? UNCAPPED,
    },
    buttons,
    orderId: null,
  };
}

/**
 * A panel's username policy, read back in full before anything is edited.
 *
 * Everything the operator can change is on this one screen WITH its current value —
 * the two customer choices, the selected preset, the prefix, the template, and a
 * preview rendered from synthetic values. That is the answer to the legacy
 * write-only settings screen, where the only way to read a price was to overwrite
 * it: nothing here has to be guessed at by changing it.
 *
 * The preview costs nothing and reserves nothing. `previewUsername` renders from
 * `USERNAME_PREVIEW_VALUES`, so looking at this screen cannot consume randomness a
 * customer would have got or take a name out of the namespace.
 */
export async function adminUsername(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  panelId: string,
  permissions: ReadonlySet<PermissionKey>,
): Promise<PendingReply> {
  let view;
  try {
    view = await rt.deps.panelAdmin.get(scope, actor, panelId);
  } catch {
    return { key: 'bot.admin.panel_gone', values: {}, buttons: [], orderId: null };
  }
  return usernameSection(
    rt,
    view.panel.id,
    view.panel.name,
    view.panel.usernamePolicy,
    permissions,
  );
}

/**
 * The section, rendered from a policy. Shared by the read and by every write.
 *
 * A write re-renders through this rather than telling the operator it succeeded and
 * leaving them to go and look: the screen they are left on shows what is stored NOW,
 * which is the only way a save can be checked without a second round trip.
 */
function usernameSection(
  rt: BotRuntime,
  panelId: string,
  panelName: string,
  policy: PanelUsernamePolicy,
  permissions: ReadonlySet<PermissionKey>,
): PendingReply {
  const buttons: CustomerButton[] = [];
  /*
   * Drawn only with `panels.edit`, and that is presentation and not enforcement:
   * `PanelService.update` charges the same permission through the same guard, so a
   * crafted callback from an administrator without it is refused there and the
   * refusal is recorded. Not drawing a button is never the check — `CLAUDE.md`.
   */
  if (permissions.has(PANELS_EDIT_PERMISSION)) {
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.username_custom_button' },
      data: `${ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX}c:${policy.allowCustom ? '0' : '1'}:${panelId}`,
    });
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.username_automatic_button' },
      data: `${ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX}a:${policy.allowAutomatic ? '0' : '1'}:${panelId}`,
    });
    for (const [code, key] of USERNAME_STRATEGY_BUTTONS) {
      buttons.push({
        label: { kind: 'TEMPLATE', key },
        data: `${ADMIN_USERNAME_STRATEGY_CALLBACK_PREFIX}${code}:${panelId}`,
      });
    }
  }
  return {
    key: 'bot.admin.username_section',
    values: {
      panel: panelName,
      custom: policy.allowCustom ? MODE_ON : MODE_OFF,
      automatic: policy.allowAutomatic ? MODE_ON : MODE_OFF,
      random: policy.strategy === 'RANDOM' ? MODE_ON : MODE_OFF,
      prefixRandom: policy.strategy === 'PREFIX_RANDOM' ? MODE_ON : MODE_OFF,
      telegramIdRandom: policy.strategy === 'TELEGRAM_ID_RANDOM' ? MODE_ON : MODE_OFF,
      customTemplate: policy.strategy === 'CUSTOM_TEMPLATE' ? MODE_ON : MODE_OFF,
      prefix: policy.prefix ?? UNCAPPED,
      template: policy.template ?? UNCAPPED,
      preview: previewUsername(policy) ?? UNCAPPED,
    },
    buttons,
    orderId: null,
  };
}

/**
 * Read the stored policy, apply ONE change to it, and write the whole thing back.
 *
 * Whole-policy rather than a field, because `PanelService.update` replaces the
 * policy as a unit and three CHECK constraints are about combinations of its
 * columns — a partial write is what reaches a state none of them individually
 * forbids. The edit is expressed as a function of what is stored, so the caller
 * never has to assemble a policy it did not read.
 *
 * Every tap carries the TARGET value rather than "flip it", so a double tap writes
 * the same policy twice. The turn's idempotency key makes the second one a replay
 * on top of that, and the service takes the panel's row lock: three mechanisms, and
 * the only one that would survive two administrators editing at once is the lock.
 * Last write wins between two people, which is what an absolute value means; what
 * cannot happen is one person's slow connection undoing their own change.
 *
 * A refusal is rendered with the shared evaluator's own words and NOTHING is
 * written — the service refuses the whole update, so the operator is looking at the
 * policy that is still stored.
 */
export async function adminUsernameWrite(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  panelId: string,
  permissions: ReadonlySet<PermissionKey>,
  edit: (policy: PanelUsernamePolicy) => PanelUsernamePolicy,
  idempotencyKey: string,
): Promise<PendingReply> {
  let before;
  try {
    before = await rt.deps.panelAdmin.get(scope, actor, panelId);
  } catch {
    return { key: 'bot.admin.panel_gone', values: {}, buttons: [], orderId: null };
  }
  const wanted = edit(before.panel.usernamePolicy);
  try {
    const after = await rt.deps.panelAdmin.update(scope, actor, panelId, {
      idempotencyKey: `${idempotencyKey}:panel-username`,
      usernamePolicy: wanted,
    });
    return usernameSection(
      rt,
      after.panel.id,
      after.panel.name,
      after.panel.usernamePolicy,
      permissions,
    );
  } catch (error) {
    /*
     * The evaluator's own Persian, not a sentence composed here.
     *
     * `validateUsernamePolicy` is the one place that decides whether a policy is
     * storable, and it carries the words for each refusal. Writing them again on
     * this surface would be the second opinion that goes stale — and the Web Admin
     * renders the same function's `reason`, so the two surfaces cannot disagree
     * about why something was refused.
     */
    const reason = validateUsernamePolicy(wanted).reason;
    if (reason !== null) {
      return {
        key: 'bot.admin.username_refused',
        values: { reason },
        buttons: [],
        orderId: null,
      };
    }
    return refusal(error);
  }
}

/**
 * The confirmation screen for archiving, and the count it is decided against.
 *
 * Re-reads the panel rather than trusting the callback, for the two reasons the
 * services terminate-ask gives: the permission is charged again by `get`, and the
 * count on this screen is the one that is true NOW rather than when the list was
 * drawn. A stale tap lands on a panel that has since been archived and is answered
 * `bot.admin.panel_gone` by the status check below rather than by a button that
 * cannot work.
 */
export async function adminPanelArchiveAsk(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  panelId: string,
  permissions: ReadonlySet<PermissionKey>,
): Promise<PendingReply> {
  if (!permissions.has(PANELS_EDIT_PERMISSION)) {
    return { key: 'bot.admin.panel_unavailable', values: {}, buttons: [], orderId: null };
  }
  let view;
  try {
    view = await rt.deps.panelAdmin.get(scope, actor, panelId);
  } catch {
    return { key: 'bot.admin.panel_gone', values: {}, buttons: [], orderId: null };
  }
  if (view.panel.status === 'ARCHIVED') {
    return { key: 'bot.admin.panel_unavailable', values: {}, buttons: [], orderId: null };
  }
  return {
    key: 'bot.admin.panel_archive_ask',
    values: { services: view.capacity.services },
    buttons: [
      {
        label: { kind: 'TEMPLATE', key: 'bot.admin.panel_archive_confirm_button' },
        data: `${ADMIN_PANEL_ARCHIVE_CALLBACK_PREFIX}${view.panel.id}`,
      },
    ],
    orderId: null,
  };
}

/**
 * The four actions: test, enable, disable, archive.
 *
 * Every one of them goes through `PanelService`, which charges `panels.edit` through
 * the same guard the Web Admin uses and writes the same audit row — so a crafted
 * callback from an administrator without that key is refused there, and the refusal is
 * recorded rather than silently swallowed. This surface decides which buttons to draw
 * and nothing about what is allowed.
 *
 * The idempotency key is the TURN's, suffixed by the action. A double tap is the same
 * command twice, which is what makes the second one a replay rather than a second
 * write — and for the test that is the difference between one probe of somebody's
 * panel and two.
 */
export async function adminPanelAct(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  intent: BotIntent,
  panelId: string,
  idempotencyKey: string,
): Promise<PendingReply> {
  try {
    if (intent === 'ADMIN_PANEL_TEST') {
      const result = await rt.deps.panelAdmin.testConnection(scope, actor, panelId, {
        idempotencyKey: `${idempotencyKey}:panel-test`,
      });
      /*
       * `probed: false` means the stored health came back WITHOUT a new probe — a
       * replay under the same key, or a probe of this configuration recently enough
       * that repeating it would be a way to hammer somebody's provider. Reporting
       * that as "tested" is the legacy "✅ updated" for a write that did nothing.
       */
      return {
        key: result.probed ? 'bot.admin.panel_tested' : 'bot.admin.panel_test_replayed',
        values: {},
        buttons: [],
        orderId: null,
      };
    }

    const status =
      intent === 'ADMIN_PANEL_ENABLE'
        ? 'ACTIVE'
        : intent === 'ADMIN_PANEL_DISABLE'
          ? 'DISABLED'
          : 'ARCHIVED';
    await rt.deps.panelAdmin.setStatus(scope, actor, panelId, {
      status,
      idempotencyKey: `${idempotencyKey}:panel-${status.toLowerCase()}`,
    });
    return {
      key:
        status === 'ACTIVE'
          ? 'bot.admin.panel_enabled'
          : status === 'DISABLED'
            ? 'bot.admin.panel_disabled'
            : 'bot.admin.panel_archived',
      values: {},
      buttons: [],
      orderId: null,
    };
  } catch (error) {
    /*
     * The one refusal this screen can resolve gets its own sentence, because the
     * remedy is the Test button an administrator is already looking at. Every other
     * panel refusal is one sentence pointing at the Web Admin, and a permission
     * denial is neither — it falls through to `act`'s own handling, which tells
     * whoever holds that chat nothing about what exists.
     */
    if ((error as { code?: unknown } | null)?.code === PANEL_ERROR_CODES.PANEL_NOT_VALIDATED) {
      return { key: 'bot.admin.panel_not_validated', values: {}, buttons: [], orderId: null };
    }
    if (isPanelRefusal(error)) {
      return { key: 'bot.admin.panel_unavailable', values: {}, buttons: [], orderId: null };
    }
    throw error;
  }
}

/**
 * One service, and the actions this administrator may actually take on it.
 *
 * The verdicts come from `ServiceAdminService.detail` — the SAME evaluator the Web
 * Admin renders and the write paths agree with — so this surface decides nothing about
 * availability. What it adds is the second filter: a verdict says the SERVICE allows
 * an action, and the permission says this administrator may ask for it. A button drawn
 * without both is a button whose every tap records a denial.
 *
 * `detail` charges `services.view` itself, so an administrator who reached this
 * through a crafted callback without it is refused there rather than here.
 */
export async function adminService(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  needle: string,
  permissions: ReadonlySet<PermissionKey>,
): Promise<PendingReply> {
  /*
   * The PERMISSION decides first, before the shape of the string is even considered.
   *
   * Without this, `/service <garbage>` from an administrator who holds no
   * `services.view` would be answered with the syntax — which is a small thing to
   * learn, and it is learned from a screen that is not theirs. The rule this path
   * already stated is that one place decides the answer and the permission is
   * charged before anything about the id is revealed; WP3 added a second shape to
   * the argument, so it had to be stated here rather than left to the guard inside
   * `detail`. `detail` and `list` still charge the key themselves: this is what is
   * ADVERTISED, never what is allowed.
   */
  if (!permissions.has(SERVICES_VIEW_PERMISSION)) {
    return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
  }
  const resolved = await resolveAdminService(rt, scope, actor, needle);
  if (resolved.kind === 'SYNTAX') {
    return { key: 'bot.admin.service_usage', values: {}, buttons: [], orderId: null };
  }
  if (resolved.kind === 'MANY') {
    /*
     * One button per match, and NO action on this screen.
     *
     * Each button opens the ordinary detail, which names the panel and the customer
     * — the two facts that tell the operator which of these is theirs. Putting the
     * seven action buttons here instead would be offering a destructive verb against
     * a row nobody has identified yet.
     */
    return {
      key: 'bot.admin.service_ambiguous',
      values: {},
      buttons: resolved.matches.map((match) => ({
        label: { kind: 'TEXT' as const, text: adminServiceMatchLabel(match) },
        data: `${ADMIN_SERVICE_CALLBACK_PREFIX}${match.id}`,
      })),
      orderId: null,
    };
  }
  if (resolved.kind === 'NONE') {
    /*
     * Unknown, another tenant's, or a name nobody here holds — ONE answer for all
     * three, which is the rule `bot.service.not_found` states on the customer side.
     * Telling them apart would let anybody holding a service id, or guessing a name,
     * learn whether it exists.
     */
    return { key: 'bot.admin.service_gone', values: {}, buttons: [], orderId: null };
  }

  const { service, actions } = resolved.found;
  const [history, title, customer] = await Promise.all([
    /*
     * `null` for a history that could not be READ, never an empty one.
     *
     * The first version caught the failure into `{ operations: [], limit: 0 }` and
     * rendered `0`, which tells the operator that this service has had nothing
     * attempted on it — the opposite of the truth when the read failed, and exactly
     * the kind of confident wrong answer this whole package is about. Found by the
     * Codex review of this branch.
     */
    rt.deps.serviceAdmin
      .operations(scope, actor, service.id)
      .catch(() => null as ServiceOperationHistory | null),
    rt.deps.purchaseTitle(scope, service.orderId),
    adminServiceCustomer(rt, scope, actor, service.customerId, permissions),
  ]);
  const latest = history?.operations[0];

  return {
    key: 'bot.admin.service',
    values: {
      /*
       * WHO, by the identity a support conversation quotes — never the internal
       * uuid, which was what this field carried until WP3 while the contract
       * described it as "the numeric identity this installation holds". A uuid names
       * the right person to nobody, cannot be typed into any command here, and is a
       * customer identifier handed to an administrator who may not be allowed to
       * read customers at all. `-` when they are not: the screen says nothing rather
       * than something useless.
       */
      customer: customer?.telegramUserId ?? '-',
      username: service.providerUsername,
      panel: service.panelId,
      product: title ?? service.productId ?? '-',
      state: service.state,
      delivery: service.deliveryState,
      usedTrafficBytes: service.trafficUsedBytes,
      totalTrafficBytes: service.trafficLimitBytes,
      ...(service.usageSyncedAt === null ? {} : { syncedAt: service.usageSyncedAt }),
      ...(service.expiresAt === null ? {} : { expiresAt: service.expiresAt }),
      /*
       * The latest operation AND its outcome, which is what tells a planned action
       * apart from a completed one. Both words come from the frozen vocabularies, so
       * an administrator reading this message and the Web Admin screen sees the same
       * token for the same fact.
       */
      operation: latest === undefined ? '-' : `${latest.type} ${latest.state}`,
      /*
       * The bound, stated rather than implied, in THREE cases and not two.
       *
       * A plain count when the whole history was read, and the bound with a `+` when
       * it was not: the reader asks for one row beyond its bound to know which, so
       * this never means "exactly the bound" when there is more, and never claims
       * more when the history happens to be exactly that long. An exact count past
       * the bound would mean walking every operation the service ever had to render
       * one figure.
       *
       * And `-` when the history could not be read AT ALL. That is the third case,
       * and collapsing it into `0` was this screen's own version of the defect the
       * package exists to fix: "nothing has been attempted on this service" is a
       * diagnosis, and the read having failed is the absence of one.
       */
      history:
        history === null
          ? '-'
          : history.hasMore
            ? `${history.limit}+`
            : String(history.operations.length),
    },
    buttons: [
      ...adminServiceButtons(service.id, actions, permissions),
      /*
       * The person, one tap away, and only for an administrator who may read them.
       *
       * `9:v:<customerId>` is the customers section's own detail callback, so this is
       * a link into a screen that already exists rather than a second rendering of a
       * customer — and that screen charges `users.view` again when it is tapped. Not
       * drawn without the key, because a button whose every tap records a denial is
       * an invitation to produce denials.
       */
      ...(customer === null
        ? []
        : [
            {
              label: {
                kind: 'TEMPLATE' as const,
                key: 'bot.admin.service_customer_button' as const,
              },
              data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}v:${customer.id}`,
            },
          ]),
      {
        label: { kind: 'TEMPLATE' as const, key: 'bot.admin.services_back_button' as const },
        data: ADMIN_SERVICES_CALLBACK_PREFIX,
      },
    ],
    orderId: null,
  };
}

/**
 * One service, from EITHER the internal id or the name on the panel.
 *
 * The two are told apart by shape, not by trying one and falling back: a uuid is
 * never a provider username and a provider username is never a uuid, so a string
 * that parses as neither is a syntax answer rather than a lookup that finds nothing.
 * `SYNTAX` and `null` are different sentences for a reason — "that is not a service
 * name" and "no such service" are different facts, and only the second is about what
 * this installation holds.
 *
 * The username path goes through `list` with its EXACT filter, which is the one way
 * this codebase asks that question. `limit: 1` because the answer is at most one row
 * per tenant: `services_panel_provider_username_key` makes the name unique per panel,
 * and two panels of one tenant pointing at different machines may legitimately hold
 * the same name — in which case the newest wins, which is the row a support
 * conversation is almost always about. Stated rather than hidden: the list ordering
 * is newest-first and that is what decides it.
 */
async function resolveAdminService(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  needle: string,
): Promise<AdminServiceLookup> {
  const raw = needle.trim();
  if (raw === '') return { kind: 'SYNTAX' };
  if (uuidV7Schema.safeParse(raw).success) {
    try {
      return { kind: 'ONE', found: await rt.deps.serviceAdmin.detail(scope, actor, raw) };
    } catch {
      return { kind: 'NONE' };
    }
  }
  const parsed = providerUsernameLookupSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'SYNTAX' };
  /*
   * MORE than one row, deliberately, and this is the Codex round's P1.
   *
   * `services_panel_provider_username_key` is unique per PANEL, not per tenant —
   * `schema.ts` says so where the namespace is explained — and two panels of one
   * tenant may point at different machines, so one name legitimately names two
   * accounts. The first version asked for `limit: 1` and took the newest, with a
   * docblock calling it "the row a support conversation is almost always about".
   * That is a guess wearing a rule's clothes, and the screen it produced carried
   * SUSPEND and TERMINATE: the wrong customer's service under a right answer's
   * heading.
   *
   * So the bound is `AMBIGUOUS_MATCH_PROBE` and anything past one is handed back for
   * the operator to choose. The probe is small because the question is only "is this
   * unique", not "how many are there" — a name on more matches than fit one keyboard
   * is a different conversation, and the browse list is where it happens.
   */
  const page = await rt.deps.serviceAdmin.list(scope, actor, {
    limit: AMBIGUOUS_MATCH_PROBE,
    search: { providerUsername: parsed.data },
  });
  const first = page.items[0];
  if (first === undefined) return { kind: 'NONE' };
  if (page.items.length > 1) return { kind: 'MANY', matches: page.items };
  try {
    return { kind: 'ONE', found: await rt.deps.serviceAdmin.detail(scope, actor, first.id) };
  } catch {
    return { kind: 'NONE' };
  }
}

/**
 * The customer behind a service, or nothing.
 *
 * `null` for two different reasons, deliberately collapsed: this administrator may
 * not read customers, or the row could not be read. Both produce the same screen —
 * no identity and no link — because the alternative is a service screen that fails
 * entirely over a permission the service itself does not need.
 *
 * The read is skipped, not caught, when the key is absent: `customers.get` charges
 * `users.view` through the guard and a denial is an operational event, so asking
 * anyway would manufacture a denial per service screen an operator opens.
 */
async function adminServiceCustomer(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customerId: string,
  permissions: ReadonlySet<PermissionKey>,
): Promise<CustomerRecord | null> {
  if (!permissions.has(CUSTOMERS_VIEW_PERMISSION)) return null;
  try {
    return await rt.deps.customers.get(scope, actor, customerId);
  } catch (error) {
    // NARROW, the rule `isCustomerMiss` states: anything else is a real failure and
    // must not be quietly rendered as "this service has no customer".
    if (isCustomerMiss(error)) return null;
    throw error;
  }
}

/**
 * A confirmation screen, and the only place its confirming callback is produced.
 *
 * Phase 6A, and the first ask-then-act flow the admin panel has. Terminate deletes the
 * account on somebody's panel while the customer keeps the order they paid for, so it
 * costs two taps — the same rule the customer half has held since 4E, and the reason
 * `service-management.test.ts` asserts the destructive prefix appears on no list and
 * no detail screen. A link rotation costs two taps too: it replaces the link the
 * customer is using. `AdminServiceAsk` names what differs between the two, so the
 * checks below cannot drift apart.
 *
 * The permission is checked again here: an administrator who reached the asking
 * callback without the action's permission is not shown a button they cannot press.
 */
export async function adminServiceAsk(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  serviceId: string,
  permissions: ReadonlySet<PermissionKey>,
  ask: AdminServiceAsk,
): Promise<PendingReply> {
  if (!permissions.has(ask.permission)) {
    return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
  }
  let found;
  try {
    found = await rt.deps.serviceAdmin.detail(scope, actor, serviceId);
  } catch {
    return { key: 'bot.admin.service_gone', values: {}, buttons: [], orderId: null };
  }
  /*
   * The verdict is read AGAIN, on the confirmation screen.
   *
   * An action that became illegal between the detail and this tap — the service was
   * ended by somebody else, or its panel was disabled — must not be offered a second
   * button. The write path refuses it anyway; this is the screen not promising what
   * the tap would refuse.
   */
  const verdict = found.actions.find((entry) => entry.action === ask.action);
  if (verdict === undefined || !verdict.available) {
    return { key: 'bot.admin.service_unavailable', values: {}, buttons: [], orderId: null };
  }
  return {
    key: ask.key,
    values: {},
    buttons: [
      {
        label: { kind: 'TEMPLATE' as const, key: ask.confirmKey },
        data: ask.confirmData(found.service),
      },
    ],
    orderId: null,
  };
}

/**
 * The rotation's confirmation: acted on only while the link it was asked about is
 * still the service's link.
 *
 * A rotation leaves the service `ACTIVE`, so without the stamp the old confirmation
 * would stay pressable for ever and each press would replace the customer's link
 * again — one tap, which is what asking first exists to prevent. A press before the
 * first rotation has finished finds the stamp unchanged and reaches
 * `requestFromOperator`, whose open-operation return answers it with the rotation
 * already planned. A press after it finds a different link and is refused.
 *
 * The read goes through `serviceAdmin.detail`, which charges `services.view`; the
 * write charges `services.edit` in `requestFromOperator`, as every action does.
 */
export async function adminServiceRotateConfirm(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  serviceId: string,
  stamp: string,
  idempotencyKey: string,
): Promise<PendingReply> {
  let found;
  try {
    found = await rt.deps.serviceAdmin.detail(scope, actor, serviceId);
  } catch (error) {
    if (isServiceRefusal(error)) {
      return { key: 'bot.admin.service_unavailable', values: {}, buttons: [], orderId: null };
    }
    throw error;
  }
  if (rotationStamp(found.service.subscriptionUrl) !== stamp) {
    return { key: 'bot.admin.service_unavailable', values: {}, buttons: [], orderId: null };
  }
  return adminServiceAct(rt, scope, actor, 'ADMIN_SERVICE_ROTATE', serviceId, idempotencyKey);
}

/**
 * One action, through the SAME application method the Web Admin's button calls.
 *
 * `requestFromOperator`, `retryProvisioning` and `resendForOperator` — no parallel
 * service logic, no second audit row, no second notification. Everything that makes an
 * action safe lives in there: the permission, the legal-state check, the panel's
 * operability, the scope-activity read inside the transaction, the open-operation
 * return that makes a double tap idempotent, and the audit row naming this
 * administrator.
 *
 * The reply distinguishes the two honest outcomes and nothing else. An operation comes
 * back PLANNED, so the answer is that the request was recorded — not that it was done,
 * which is the legacy "updated" for a write whose effect has not happened. A resend
 * plans no operation and says it was sent. Anything the write path refuses is one
 * sentence: which of the four refusals it was belongs to the operational log and the
 * audit row, and an administrator's next step is the Web Admin either way.
 */
export async function adminServiceAct(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  intent: BotIntent,
  serviceId: string,
  idempotencyKey: string,
): Promise<PendingReply> {
  const key = `${idempotencyKey}:${intent.toLowerCase()}`;
  try {
    if (intent === 'ADMIN_SERVICE_RESEND') {
      await rt.deps.delivery.resendForOperator(scope, actor, serviceId);
      return { key: 'bot.admin.service_resent', values: {}, buttons: [], orderId: null };
    }
    if (intent === 'ADMIN_SERVICE_RETRY') {
      await rt.deps.services.retryProvisioning(scope, actor, serviceId, {
        idempotencyKey: key,
      });
      return { key: 'bot.admin.service_planned', values: {}, buttons: [], orderId: null };
    }
    const operation = ADMIN_SERVICE_OPERATIONS[intent];
    /*
     * Unreachable while the dispatch and this table name the same intents, and
     * answered rather than asserted: a non-null assertion here would turn a future
     * edit that adds an intent to one and not the other into a runtime throw, on a
     * button an administrator pressed to fix somebody's service.
     */
    if (operation === undefined) {
      return { key: 'bot.admin.service_unavailable', values: {}, buttons: [], orderId: null };
    }
    await rt.deps.services.requestFromOperator(scope, actor, serviceId, operation, {
      idempotencyKey: key,
    });
    return { key: 'bot.admin.service_planned', values: {}, buttons: [], orderId: null };
  } catch (error) {
    /*
     * A refusal about the SERVICE is answered differently from a refusal about the
     * ADMINISTRATOR, and the difference is deliberate. A stale button — the state
     * moved, the panel was disabled, an operation of that type is already open — is
     * something the person can act on, so it says the action is not possible now. A
     * permission denial falls through to `adminTurn`'s single refusal, which tells
     * whoever holds the chat nothing about what exists.
     */
    if (isServiceRefusal(error)) {
      return { key: 'bot.admin.service_unavailable', values: {}, buttons: [], orderId: null };
    }
    throw error;
  }
}
