// Admin-in-bot: the management panel's turn, its text capture, its section screen and
// the administrators' roster. Moved verbatim out of bot-runtime.ts (R9 split): each
// method is a free function taking the runtime first; BotRuntime keeps a forwarder for
// the ones the router calls.
import type { ActorContext, BotInstanceId, PermissionKey, TenantContext } from '@nexa/contracts';
import { DEFAULT_USERNAME_PREFIX } from '@nexa/contracts';
import { mayBePushedRefundRequests } from '../../../modules/commerce/payments/application/service-refund-push.consumer.js';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import {
  adminTutorialTurn,
  maySeeTutorials,
  messageSentAt,
  tutorialsPanelButton,
} from '../admin-tutorial-video.js';
import {
  ADMIN_ADMIN_CALLBACK_PREFIX,
  ADMIN_ADMIN_STATUS_CALLBACK_PREFIX,
  ADMIN_CATEGORIES_CALLBACK_PREFIX,
  ADMIN_CUSTOMERS_CALLBACK_PREFIX,
  ADMIN_PANELS_CALLBACK_PREFIX,
  ADMIN_RECEIPTS_CALLBACK_PREFIX,
  ADMIN_REMINDERS_CALLBACK_PREFIX,
  ADMIN_REVOKE_CALLBACK_PREFIX,
  ADMIN_SECTION_CALLBACK_PREFIX,
  ADMIN_SERVICES_CALLBACK_PREFIX,
  ADMIN_STATUS_CODES,
  type AdminStatusCode,
  type ReminderSettingCode,
  USERNAME_STRATEGY_CODES,
  USERNAME_TOGGLE_FIELDS,
  type UsernameStrategyCode,
  type UsernameToggleField,
} from './callbacks.js';
import type { AdminRosterEntry } from './deps.js';
import { updateIdOf } from './intent-of.js';
import { type BotCommand, type BotIntent } from './intents.js';
import { type PendingReply } from './replies.js';
import type { BotRuntime } from '../bot-runtime.js';
import {
  adminApprove,
  adminBlockReason,
  adminBlockTurn,
  adminCreditAmount,
  adminCreditCancel,
  adminCreditConfirm,
  adminCreditOpen,
  adminReceipt,
  adminReceipts,
  adminRefundRequestText,
  adminRefundRequestTurn,
  adminRejectReason,
  adminRejectTurn,
} from './admin-review-flow.js';
import {
  ADMIN_SERVICE_ROTATE_ASK,
  ADMIN_SERVICE_TERMINATE_ASK,
  adminPanelAct,
  adminPanelArchiveAsk,
  adminPanelDetail,
  adminPanels,
  adminReminderEdit,
  adminReminderSet,
  adminReminders,
  adminService,
  adminServiceAct,
  adminServiceAsk,
  adminServiceRotateConfirm,
  adminServices,
  adminServicesBrowse,
  adminUsername,
  adminUsernameWrite,
} from './admin-services-flow.js';
import {
  adminCategoryTurn,
  adminCustomer,
  adminCustomerBlockReason,
  adminCustomerFind,
  adminCustomerStatusTurn,
  adminCustomers,
} from './admin-customers-flow.js';
import {
  ADMINS_EDIT_PERMISSION,
  ADMINS_VIEW_PERMISSION,
  ADMIN_ROSTER_LIMIT,
  CATALOG_VIEW_PERMISSION,
  CUSTOMERS_VIEW_PERMISSION,
  PANELS_VIEW_PERMISSION,
  RECEIPTS_VIEW_PERMISSION,
  SERVICES_VIEW_PERMISSION,
  SETTINGS_VIEW_PERMISSION,
  hasAnyPanelSection,
} from './admin-common.js';

/**
 * The four administrator callbacks' intents: the buttons of a review card that is PUSHED,
 * to administrators chosen by `mayBePushedRefundRequests`, not reached through a panel
 * section. So `adminTurn` admits them on that same predicate rather than on
 * `hasAnyPanelSection` (Codex review of #83, round 9).
 */
const ADMIN_REFUND_REQUEST_INTENTS: ReadonlySet<BotIntent> = new Set<BotIntent>([
  'ADMIN_REFUND_REQUEST_APPROVE',
  'ADMIN_REFUND_REQUEST_REJECT',
  'ADMIN_REFUND_REQUEST_CONFIRM',
  'ADMIN_REFUND_REQUEST_CANCEL',
]);

/**
 * The management panel's turn (Phase 5T), or `null` when this is not an administrator.
 *
 * `null` rather than a refusal, because the caller then falls through to the ordinary
 * unsupported-input reply — the SAME answer any unrecognised string gets. That is the
 * whole of the "a customer cannot open the admin menu by crafting callback data"
 * property: the callback parses, this method resolves no administrator behind the
 * Telegram id that sent it, and the customer learns nothing about what exists.
 *
 * The administrator's OWN actor is what every call below carries — `TELEGRAM_ADMIN`
 * with their administrator id — so the audit row names the person and not the bot, and
 * the guard resolves their real permissions. The turn's `SYSTEM_JOB` actor stops here.
 */
export async function adminTurn(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  command: BotCommand,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly update: unknown;
    readonly telegramUserId: string;
  },
): Promise<PendingReply | null> {
  const admins = rt.deps.telegramAdmins;
  if (admins === undefined) return null;

  const identity = await admins.resolve(scope, input.telegramUserId, actor.correlationId);
  if (identity === null) return null;

  const { actor: adminActor, permissions } = identity;
  // An administrator who holds neither of the panel's permissions has no panel, and
  // is answered exactly as a customer is. Nothing is hidden from them that they could
  // otherwise have done: both sections charge these keys server-side as well.
  const mayReview = permissions.has(RECEIPTS_VIEW_PERMISSION);
  const maySeeAdmins = permissions.has(ADMINS_VIEW_PERMISSION);
  const maySeeServices = permissions.has(SERVICES_VIEW_PERMISSION);
  const maySeePanels = permissions.has(PANELS_VIEW_PERMISSION);
  /*
   * The reminder section needs BOTH read permissions, because it prints both halves:
   * the five settings and the three switches. Drawing it for an administrator who
   * holds only one would produce a screen that denies itself on arrival.
   */
  const maySeeReminders = permissions.has(SETTINGS_VIEW_PERMISSION);
  const maySeeCustomers = permissions.has(CUSTOMERS_VIEW_PERMISSION);
  const maySeeCategories =
    permissions.has(CATALOG_VIEW_PERMISSION) && rt.deps.productCategories !== undefined;
  /*
   * A refund request's card is pushed to whoever holds the two decision permissions,
   * panel or no panel (Codex review of #83, round 9). Its taps are admitted on the SAME
   * predicate the push chose them by: gated on a panel section, a reviewer holding only
   * `refunds.issue` and `services.terminate` was sent a card whose every button answered
   * as if they were a customer. The decision service checks both permissions again.
   */
  const mayDecideRefundRequest =
    ADMIN_REFUND_REQUEST_INTENTS.has(command.intent) && mayBePushedRefundRequests(permissions);
  if (!hasAnyPanelSection(permissions) && !mayDecideRefundRequest) return null;

  try {
    switch (command.intent) {
      case 'ADMIN_PANEL':
        return {
          key: 'bot.admin.panel',
          values: {},
          buttons: [
            ...(mayReview
              ? [
                  {
                    label: {
                      kind: 'TEMPLATE' as const,
                      key: 'bot.admin.receipts_button' as const,
                    },
                    data: ADMIN_RECEIPTS_CALLBACK_PREFIX,
                  },
                ]
              : []),
            ...(maySeeServices
              ? [
                  {
                    label: {
                      kind: 'TEMPLATE' as const,
                      key: 'bot.admin.services_button' as const,
                    },
                    data: ADMIN_SERVICES_CALLBACK_PREFIX,
                  },
                ]
              : []),
            ...(maySeePanels
              ? [
                  {
                    label: {
                      kind: 'TEMPLATE' as const,
                      key: 'bot.admin.panels_button' as const,
                    },
                    data: ADMIN_PANELS_CALLBACK_PREFIX,
                  },
                ]
              : []),
            ...(maySeeReminders
              ? [
                  {
                    label: {
                      kind: 'TEMPLATE' as const,
                      key: 'bot.admin.reminders_button' as const,
                    },
                    data: ADMIN_REMINDERS_CALLBACK_PREFIX,
                  },
                ]
              : []),
            ...(maySeeCustomers
              ? [
                  {
                    label: {
                      kind: 'TEMPLATE' as const,
                      key: 'bot.admin.customers_button' as const,
                    },
                    data: ADMIN_CUSTOMERS_CALLBACK_PREFIX,
                  },
                ]
              : []),
            ...(maySeeCategories
              ? [
                  {
                    label: {
                      kind: 'TEMPLATE' as const,
                      key: 'bot.admin.categories_button' as const,
                    },
                    data: `${ADMIN_CATEGORIES_CALLBACK_PREFIX}0`,
                  },
                ]
              : []),
            ...(maySeeAdmins
              ? [
                  {
                    label: {
                      kind: 'TEMPLATE' as const,
                      key: 'bot.admin.section_button' as const,
                    },
                    data: ADMIN_SECTION_CALLBACK_PREFIX,
                  },
                ]
              : []),
            // Spec §7: the client apps section, where a tutorial video is set.
            ...(rt.deps.clientAppVideos !== undefined && maySeeTutorials(permissions)
              ? [tutorialsPanelButton()]
              : []),
          ],
          orderId: null,
        };
      case 'ADMIN_RECEIPTS':
        return await adminReceipts(rt, scope, adminActor);
      case 'ADMIN_RECEIPT':
        return command.targetId === null
          ? null
          : await adminReceipt(rt, scope, adminActor, command.targetId, permissions);
      case 'ADMIN_APPROVE':
        return command.targetId === null
          ? null
          : await adminApprove(rt, scope, adminActor, command.targetId, input.idempotencyKey);
      case 'ADMIN_REJECT':
      case 'ADMIN_REJECT_CONFIRM':
      case 'ADMIN_REJECT_CANCEL':
        return command.targetId === null
          ? null
          : await adminRejectTurn(
              rt,
              scope,
              adminActor,
              command.intent,
              command.targetId,
              input,
              permissions,
            );
      case 'ADMIN_CREDIT':
        return command.targetId === null
          ? null
          : await adminCreditOpen(
              rt,
              scope,
              adminActor,
              command.targetId,
              input.botInstanceId,
              input.idempotencyKey,
            );
      case 'ADMIN_REFUND_REQUEST_APPROVE':
      case 'ADMIN_REFUND_REQUEST_REJECT':
      case 'ADMIN_REFUND_REQUEST_CONFIRM':
      case 'ADMIN_REFUND_REQUEST_CANCEL':
        return command.targetId === null
          ? null
          : await adminRefundRequestTurn(
              rt,
              scope,
              adminActor,
              command.intent,
              command.targetId,
              input.botInstanceId,
              updateIdOf(input.update),
            );
      case 'ADMIN_CREDIT_CONFIRM':
        return command.targetId === null
          ? null
          : await adminCreditConfirm(rt, scope, adminActor, command.targetId);
      case 'ADMIN_CREDIT_CANCEL':
        return command.targetId === null
          ? null
          : await adminCreditCancel(rt, scope, adminActor, command.targetId, input.idempotencyKey);
      case 'ADMIN_BLOCK_ASK':
      case 'ADMIN_BLOCK_OPEN':
      case 'ADMIN_BLOCK_CONFIRM':
      case 'ADMIN_BLOCK_CANCEL':
        return command.targetId === null
          ? null
          : await adminBlockTurn(rt, scope, adminActor, command.intent, command.targetId, input);
      case 'ADMIN_SERVICES':
        return await adminServices(rt, scope, adminActor, permissions);
      case 'ADMIN_SERVICES_BROWSE':
        return await adminServicesBrowse(rt, scope, adminActor, null);
      case 'ADMIN_SERVICES_BROWSE_PAGE':
        /*
         * The cursor is decoded at the boundary, so an unparseable one never reaches
         * here. `null` cannot happen and is handled anyway: the first page is the
         * safe reading of "no position", the same note `ADMIN_PANELS_PAGE` carries.
         */
        return await adminServicesBrowse(rt, scope, adminActor, command.cursor ?? null);
      case 'ADMIN_SERVICE': {
        /*
         * Reached two ways: a queue button carrying a uuid the boundary validated, and
         * `/service <id>` typed by hand, which it did not — the boundary splits a
         * command's words and cannot know which of them is meant to be an id.
         *
         * Neither is re-validated HERE, and the empty string stands in for a bare
         * `/service`. That is the result of a mutation rather than an omission: this
         * handler validated the typed id and refused an absent one, and BOTH checks
         * survived being reverted, because `ServiceAdminService.get` runs every id
         * through `serviceIdOrNotFound` and `SERVICE_NOT_FOUND` is what the catch
         * below already renders as `bot.admin.service_gone`.
         *
         * A guard that survives its own mutation is a rule in name only, and the
         * danger is not the dead code — it is the next reader taking it for the one
         * holding the line and removing the one that is. So the answer has ONE place
         * it is decided, which is also where the permission is charged first, so an
         * administrator without `services.view` cannot learn whether an id is even
         * well-formed.
         *
         * WP3 gave the typed form a SECOND accepted shape — the name on the panel,
         * which is the only handle a customer's message ever contains — so the one
         * place is now `resolveAdminService`, and the syntax answer it produces is
         * still reached only after the permission.
         */
        const typed = command.targetId ?? (command.args ?? [])[0] ?? '';
        return await adminService(rt, scope, adminActor, typed, permissions);
      }
      case 'ADMIN_SERVICE_TERMINATE_ASK':
        return command.targetId === null
          ? null
          : await adminServiceAsk(
              rt,
              scope,
              adminActor,
              command.targetId,
              permissions,
              ADMIN_SERVICE_TERMINATE_ASK,
            );
      case 'ADMIN_SERVICE_ROTATE_ASK':
        return command.targetId === null
          ? null
          : await adminServiceAsk(
              rt,
              scope,
              adminActor,
              command.targetId,
              permissions,
              ADMIN_SERVICE_ROTATE_ASK,
            );
      // Its own case, ABOVE the stacked ones below: a case placed inside that stack
      // would catch every intent stacked above it.
      case 'ADMIN_SERVICE_ROTATE':
        return command.targetId === null
          ? null
          : await adminServiceRotateConfirm(
              rt,
              scope,
              adminActor,
              command.targetId,
              (command.args ?? [])[0] ?? '',
              input.idempotencyKey,
            );
      case 'ADMIN_SERVICE_SYNC':
      case 'ADMIN_SERVICE_RESEND':
      case 'ADMIN_SERVICE_RETRY':
      case 'ADMIN_SERVICE_RECONCILE':
      case 'ADMIN_SERVICE_SUSPEND':
      case 'ADMIN_SERVICE_RESUME':
      case 'ADMIN_SERVICE_TERMINATE':
        return command.targetId === null
          ? null
          : await adminServiceAct(
              rt,
              scope,
              adminActor,
              command.intent,
              command.targetId,
              input.idempotencyKey,
            );
      case 'ADMIN_PANELS':
        return await adminPanels(rt, scope, adminActor, null);
      case 'ADMIN_REMINDERS':
        return await adminReminders(rt, scope, adminActor);
      case 'ADMIN_REMINDER_EDIT':
        /*
         * The cast is safe because the BOUNDARY validated it: `callbackCommand`
         * refuses any code not in `REMINDER_SETTING_CODES` before an intent is
         * produced, so `targetId` here is one of the five or the intent is
         * UNSUPPORTED. The same shape the UUID paths use.
         */
        return command.targetId === null
          ? null
          : await adminReminderEdit(rt, scope, adminActor, command.targetId as ReminderSettingCode);
      case 'ADMIN_REMINDER_SET': {
        const chosen = command.args?.[0];
        if (command.targetId === null || chosen === undefined) return null;
        return await adminReminderSet(
          rt,
          scope,
          adminActor,
          command.targetId as ReminderSettingCode,
          Number(chosen),
          input.idempotencyKey,
        );
      }
      case 'ADMIN_PANELS_PAGE':
        /*
         * The cursor is decoded at the boundary, so an unparseable one never reaches
         * here — it is UNSUPPORTED, the same answer every other unreadable callback
         * gets. `null` cannot happen and is handled anyway: the first page is the
         * safe reading of "no position", and throwing on a shape the boundary
         * guarantees would be a crash for a case that cannot occur.
         */
        return await adminPanels(rt, scope, adminActor, command.cursor ?? null);
      case 'ADMIN_PANEL_DETAIL':
        return command.targetId === null
          ? null
          : await adminPanelDetail(rt, scope, adminActor, command.targetId, permissions);
      case 'ADMIN_PANEL_ARCHIVE_ASK':
        return command.targetId === null
          ? null
          : await adminPanelArchiveAsk(rt, scope, adminActor, command.targetId, permissions);
      case 'ADMIN_PANEL_TEST':
      case 'ADMIN_PANEL_ENABLE':
      case 'ADMIN_PANEL_DISABLE':
      case 'ADMIN_PANEL_ARCHIVE':
        return command.targetId === null
          ? null
          : await adminPanelAct(
              rt,
              scope,
              adminActor,
              command.intent,
              command.targetId,
              input.idempotencyKey,
            );
      case 'ADMIN_USERNAME':
        return command.targetId === null
          ? null
          : await adminUsername(rt, scope, adminActor, command.targetId, permissions);
      case 'ADMIN_USERNAME_TOGGLE': {
        /*
         * The casts are safe because the BOUNDARY validated them: `callbackCommand`
         * refuses any field outside `USERNAME_TOGGLE_FIELDS` and any value that is
         * not `0` or `1` before an intent is produced. The same shape the reminder
         * codes use.
         */
        const field = command.args?.[0];
        const value = command.args?.[1];
        if (command.targetId === null || field === undefined || value === undefined) return null;
        return await adminUsernameWrite(
          rt,
          scope,
          adminActor,
          command.targetId,
          permissions,
          (policy) => ({
            ...policy,
            [USERNAME_TOGGLE_FIELDS[field as UsernameToggleField]]: value === '1',
          }),
          input.idempotencyKey,
        );
      }
      case 'ADMIN_USERNAME_STRATEGY': {
        const code = command.args?.[0];
        if (command.targetId === null || code === undefined) return null;
        const strategy = USERNAME_STRATEGY_CODES[code as UsernameStrategyCode];
        return await adminUsernameWrite(
          rt,
          scope,
          adminActor,
          command.targetId,
          permissions,
          (policy) => ({
            ...policy,
            strategy,
            /*
             * A preset that needs a prefix and has none gets the default one rather
             * than a refusal. `nx` is what an unconfigured panel already uses, so
             * the tap does exactly what the button says; the operator changes it
             * with `/panel_prefix` afterwards if they want a different one.
             */
            prefix:
              strategy === 'PREFIX_RANDOM' ? (policy.prefix ?? DEFAULT_USERNAME_PREFIX) : null,
            template: null,
          }),
          input.idempotencyKey,
        );
      }
      case 'ADMIN_USERNAME_PREFIX':
      case 'ADMIN_USERNAME_TEMPLATE': {
        const [panelId, ...rest] = command.args ?? [];
        const written = rest.join(' ');
        if (panelId === undefined || written === '') {
          return { key: 'bot.admin.panel_gone', values: {}, buttons: [], orderId: null };
        }
        const wantsTemplate = command.intent === 'ADMIN_USERNAME_TEMPLATE';
        return await adminUsernameWrite(
          rt,
          scope,
          adminActor,
          panelId,
          permissions,
          (policy) => ({
            ...policy,
            /*
             * The command selects the preset as well as supplying its value, and it
             * has to: `panels_username_template_check` is a biconditional, so a
             * template without `CUSTOM_TEMPLATE` beside it is not a storable row.
             * Saying "use this template here" in one message is also what an
             * operator means by sending it.
             */
            strategy: wantsTemplate ? 'CUSTOM_TEMPLATE' : 'PREFIX_RANDOM',
            prefix: wantsTemplate ? null : written,
            template: wantsTemplate ? written : null,
          }),
          input.idempotencyKey,
        );
      }
      case 'ADMIN_CUSTOMERS':
        return await adminCustomers(rt, scope, adminActor, null);
      case 'ADMIN_CUSTOMERS_PAGE':
        /*
         * The cursor is decoded at the boundary, so an unparseable one never reaches
         * here — the same shape `ADMIN_PANELS_PAGE` has.
         */
        return await adminCustomers(rt, scope, adminActor, command.cursor ?? null);
      case 'ADMIN_CUSTOMER':
        return command.targetId === null
          ? null
          : await adminCustomer(rt, scope, adminActor, command.targetId, permissions);
      case 'ADMIN_CUSTOMER_FIND':
        return await adminCustomerFind(
          rt,
          scope,
          adminActor,
          (command.args ?? [])[0] ?? '',
          permissions,
        );
      case 'ADMIN_CUSTOMER_BLOCK':
      case 'ADMIN_CUSTOMER_BLOCK_OPEN':
      case 'ADMIN_CUSTOMER_BLOCK_CONFIRM':
      case 'ADMIN_CUSTOMER_BLOCK_CANCEL':
      case 'ADMIN_CUSTOMER_UNBLOCK':
      case 'ADMIN_CUSTOMER_UNBLOCK_CONFIRM':
        return command.targetId === null
          ? null
          : await adminCustomerStatusTurn(
              rt,
              scope,
              adminActor,
              command.intent,
              command.targetId,
              permissions,
              input,
            );
      case 'ADMIN_CATEGORIES':
      case 'ADMIN_CATEGORY':
      case 'ADMIN_CATEGORY_ACTIVATE':
      case 'ADMIN_CATEGORY_DEACTIVATE':
      case 'ADMIN_CATEGORY_SHOW':
      case 'ADMIN_CATEGORY_HIDE':
      case 'ADMIN_CATEGORY_UP':
      case 'ADMIN_CATEGORY_DOWN':
      case 'ADMIN_CATEGORY_DELETE_ASK':
      case 'ADMIN_CATEGORY_DELETE':
      case 'ADMIN_CATEGORY_NEW':
      case 'ADMIN_CATEGORY_RENAME':
      case 'ADMIN_CATEGORY_EMOJI':
      case 'ADMIN_CATEGORY_PRODUCTS':
      case 'ADMIN_CATEGORY_PICK':
      case 'ADMIN_CATEGORY_ASSIGN':
        return await adminCategoryTurn(
          rt,
          scope,
          adminActor,
          command,
          permissions,
          input.idempotencyKey,
        );
      case 'ADMIN_APPS':
      case 'ADMIN_APP':
      case 'ADMIN_APP_VIDEO_SET':
      case 'ADMIN_APP_VIDEO_DELETE_ASK':
      case 'ADMIN_APP_VIDEO_DELETE':
      case 'ADMIN_APP_VIDEO_CANCEL':
      case 'ADMIN_APP_VIDEO_UPLOAD': {
        // Spec §7: the client apps section; the service charges every permission.
        const videos = rt.deps.clientAppVideos;
        if (videos === undefined) return null;
        const numericUpdate = updateIdOf(input.update);
        return await adminTutorialTurn(
          videos,
          scope,
          adminActor,
          { intent: command.intent, targetId: command.targetId, video: command.video ?? null },
          {
            idempotencyKey: input.idempotencyKey,
            botInstanceId: input.botInstanceId,
            adminId: identity.admin.id,
            updateId: numericUpdate === undefined ? null : BigInt(numericUpdate),
            sentAt: messageSentAt((input.update as { message?: unknown } | null)?.message),
            permissions,
          },
        );
      }
      case 'ADMIN_SECTION':
        return await adminSection(rt, scope, adminActor);
      case 'ADMIN_ADMIN':
        return command.targetId === null
          ? null
          : await adminAdmin(rt, scope, adminActor, command.targetId, permissions);
      case 'ADMIN_ADMIN_STATUS': {
        /*
         * The cast is safe because the BOUNDARY validated it: `callbackCommand` is
         * only reached for a code in `ADMIN_STATUS_CODES`, so this is one of the two
         * or the intent is UNSUPPORTED. The same shape the reminder codes use.
         */
        const code = command.args?.[0];
        if (command.targetId === null || code === undefined) return null;
        return await adminAdminStatus(
          rt,
          scope,
          adminActor,
          command.targetId,
          ADMIN_STATUS_CODES[code as AdminStatusCode],
          permissions,
          input.idempotencyKey,
        );
      }
      case 'ADMIN_REVOKE':
        return command.targetId === null
          ? null
          : await adminRevokeAccess(rt, scope, adminActor, command.targetId);
      case 'ADMIN_LINK':
        return await adminLink(rt, scope, adminActor, command.args ?? []);
      case 'ADMIN_ROLE':
        return await adminRole(rt, scope, adminActor, command.args ?? [], input.idempotencyKey);
      default:
        return null;
    }
  } catch {
    /*
     * ONE refusal for everything, and the distinctions are deliberately not rendered.
     *
     * A permission denial, an unknown administrator, a Telegram account already bound
     * and an attempted escalation are four different facts, all of them recorded — the
     * guard writes an operational event, the services write audit rows, and both carry
     * the error code. What a reply must not do is tell whoever holds that chat WHICH
     * of the four they hit, because the answer is a fact about other administrators.
     */
    return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
  }
}

/**
 * An administrator's plain message, offered to their ONE open prompt: the credit's amount
 * capture, or Block User's reason capture. The two cannot both be open — one partial unique
 * index covers both purposes — so at most one of them answers; `null` for everything else,
 * and the message then routes exactly as it did before either existed.
 */
export async function adminCaptureText(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  text: string,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly telegramUserId: string;
    readonly update?: unknown;
  },
): Promise<PendingReply | null> {
  const amount = await adminCreditAmount(rt, scope, actor, text, input);
  if (amount !== null) return amount;
  const refundDecision = await adminRefundRequestText(rt, scope, actor, text, input);
  if (refundDecision !== null) return refundDecision;
  const blockReason = await adminBlockReason(rt, scope, actor, text, input);
  if (blockReason !== null) return blockReason;
  const customerBlockReason = await adminCustomerBlockReason(rt, scope, actor, text, input);
  if (customerBlockReason !== null) return customerBlockReason;
  return adminRejectReason(rt, scope, actor, text, input);
}

/**
 * The administrator section: who holds Telegram access, and the two commands.
 *
 * The rows are buttons that REVOKE, which is the one thing the research found its
 * own section could do besides list and create — and the label is the administrator's
 * username plus their Telegram id, because identity here is the numeric id and a
 * reviewer needs to see which account they are removing.
 */
async function adminSection(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
): Promise<PendingReply> {
  const roster = await rt.deps.telegramAdmins?.listAll(scope, actor);
  if (roster === undefined || roster.length === 0) {
    return { key: 'bot.admin.admins_none', values: {}, buttons: [], orderId: null };
  }
  /*
   * BOUNDED, and the bound is printed rather than applied silently.
   *
   * A Telegram inline keyboard has a size limit, and `create` enforces no
   * ceiling on how many administrators a tenant may hold — so mapping an
   * unbounded roster into one keyboard eventually fails the whole send, and
   * the section stops working at exactly the size where an operator most
   * needs it. Every other list on this surface bounds itself for the same
   * reason.
   *
   * What is NOT acceptable is the quiet version: a truncated roster reads
   * exactly like a complete one, and an operator who cannot find somebody
   * concludes they are not an administrator. The header carries both counts,
   * so a bound that was reached says so.
   */
  const page = roster.slice(0, ADMIN_ROSTER_LIMIT);
  return {
    key: 'bot.admin.section',
    values: { shown: page.length, total: roster.length },
    /*
     * EVERY administrator, not only the Telegram-bound ones.
     *
     * Until WP1 this listed `listBound`, which put the operator's most urgent reason
     * to open this surface out of reach: the administrator you need to disable from a
     * phone is under no obligation to have a Telegram binding, and one who had none
     * simply did not appear. `listBound` still exists and still answers a different
     * question — who can be REACHED here — which is what the receipt lane needs.
     *
     * The row carries the username and the status and nothing else. A row is a
     * button label, so it is as forwardable as the detail screen and gets the same
     * treatment: no numeric Telegram id, which belongs on the screen where the
     * revoke button that acts on it is.
     */
    buttons: page.map((entry) => ({
      label: {
        kind: 'TEXT' as const,
        text: `${entry.admin.username} — ${entry.admin.status}`,
      },
      data: `${ADMIN_ADMIN_CALLBACK_PREFIX}${entry.admin.id}`,
    })),
    orderId: null,
  };
}

/**
 * One administrator, and the two writes this surface may make about them.
 *
 * The roster is re-read rather than a per-administrator repository method being
 * added, and the reason is the rule rather than convenience: `management.list` is
 * the one projection that charges `admins.view`, scopes to the tenant and resolves
 * role keys, and a second read path would be a second answer to "what may be shown".
 * An administrator roster is people an operator created by hand, so the cost is a
 * bounded scan, not a table.
 *
 * An id that is unknown, another tenant's or malformed gets ONE answer — the rule
 * `bot.admin.panel_gone` states — so nobody holding an id can learn whether it names
 * anything.
 */
async function adminAdmin(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  adminId: string,
  permissions: ReadonlySet<PermissionKey>,
): Promise<PendingReply> {
  const roster = (await rt.deps.telegramAdmins?.listAll(scope, actor)) ?? [];
  const found = roster.find((entry) => entry.admin.id === adminId);
  if (found === undefined) {
    return { key: 'bot.admin.admin_gone', values: {}, buttons: [], orderId: null };
  }
  return adminAdminReply(rt, found, actor, permissions);
}

/**
 * Activates or disables one administrator.
 *
 * `setStatus` carries every refusal this needs — the caller may not act on
 * themselves, the last remaining owner survives, an actor cannot restore more
 * privilege than they hold, the tenant is locked and the permission is re-checked
 * inside the writing transaction — so this adds none of its own and catches nothing:
 * `adminTurn`'s single refusal is what answers a denial, and which denial it was
 * belongs to the audit row.
 *
 * The reply names the STATUS the administrator now holds rather than the button that
 * was pressed. A redelivered update therefore reads as the state it found instead of
 * claiming a second change, which is the same property the target-valued callback
 * gives the tap itself.
 */
async function adminAdminStatus(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  adminId: string,
  status: 'ACTIVE' | 'DISABLED',
  permissions: ReadonlySet<PermissionKey>,
  idempotencyKey: string,
): Promise<PendingReply> {
  const admins = rt.deps.telegramAdmins;
  if (admins === undefined) {
    return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
  }
  const updated = await admins.setStatus(
    scope,
    actor,
    adminId,
    status,
    'Status changed from the Telegram management panel.',
    idempotencyKey,
  );
  return {
    key: 'bot.admin.admin_status_changed',
    values: { username: updated.admin.username, status: updated.admin.status },
    buttons: adminAdminReply(rt, updated, actor, permissions).buttons,
    orderId: null,
  };
}

/**
 * The detail screen for one administrator, shared by the read and the write.
 *
 * ONE builder, so the buttons an operator sees after a change are the buttons the
 * new state actually offers — a second copy is how a disable leaves an "disable"
 * button on the screen.
 *
 * The status button offered is the OPPOSITE of the current status, and it is not
 * drawn at all for the caller themselves: `setStatus` refuses self-modification
 * outright, so a button there could only ever record a refusal. That is a courtesy,
 * not the enforcement — the service refuses it whether or not the button exists.
 */
function adminAdminReply(
  rt: BotRuntime,
  entry: AdminRosterEntry,
  actor: ActorContext,
  permissions: ReadonlySet<PermissionKey>,
): PendingReply {
  const isSelf = actor.id === entry.admin.id;
  const mayEdit = permissions.has(ADMINS_EDIT_PERMISSION);
  const buttons: CustomerButton[] = [];
  if (mayEdit && !isSelf) {
    const next = entry.admin.status === 'ACTIVE' ? 'd' : 'a';
    buttons.push({
      label: {
        kind: 'TEMPLATE',
        key:
          entry.admin.status === 'ACTIVE'
            ? 'bot.admin.admin_disable_button'
            : 'bot.admin.admin_enable_button',
      },
      data: `${ADMIN_ADMIN_STATUS_CALLBACK_PREFIX}${next}:${entry.admin.id}`,
    });
    if (entry.admin.telegramUserId !== null) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.revoke_button' },
        data: `${ADMIN_REVOKE_CALLBACK_PREFIX}${entry.admin.id}`,
      });
    }
  }
  buttons.push({
    label: { kind: 'TEMPLATE', key: 'bot.admin.admins_back_button' },
    data: ADMIN_SECTION_CALLBACK_PREFIX,
  });
  return {
    key: 'bot.admin.admin_detail',
    values: {
      username: entry.admin.username,
      displayName: entry.admin.displayName,
      status: entry.admin.status,
      roles: entry.roleKeys.join(', '),
      telegram: entry.admin.telegramUserId ?? '—',
    },
    buttons,
    orderId: null,
  };
}

/** Removes one administrator's Telegram access, by the button beside their row. */
async function adminRevokeAccess(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  targetId: string,
): Promise<PendingReply> {
  const admins = rt.deps.telegramAdmins;
  if (admins === undefined) {
    return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
  }
  const revoked = await admins.revoke(
    scope,
    actor,
    targetId,
    'Telegram access revoked from the management panel.',
  );
  return {
    key: 'bot.admin.revoked',
    values: { username: revoked.username },
    buttons: [],
    orderId: null,
  };
}

/**
 * `/link <telegram id> <username>` — gives an existing administrator Telegram access.
 *
 * TWO arguments in one message, which is what makes this a command rather than a
 * prompt: nothing is remembered between updates, so there is no window in which an
 * ordinary message can be swallowed as an answer (INCIDENT-FIN-001).
 *
 * It cannot create an administrator, and that is stated in the reply rather than
 * worked around: a Telegram-only administrator would need a row with no usable
 * password hash, and this identity model has no such shape.
 */
async function adminLink(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  args: readonly string[],
): Promise<PendingReply> {
  const admins = rt.deps.telegramAdmins;
  const telegramUserId = args[0];
  const username = args[1];
  if (admins === undefined || telegramUserId === undefined || username === undefined) {
    return { key: 'bot.admin.usage', values: {}, buttons: [], orderId: null };
  }
  const linked = await admins.link(scope, actor, {
    telegramUserId,
    username,
    reason: 'Telegram access granted from the management panel.',
  });
  return {
    key: 'bot.admin.linked',
    values: { username: linked.username },
    buttons: [],
    orderId: null,
  };
}

/**
 * `/role <username> <role key>` — sets an administrator's roles to one Nexa preset.
 *
 * Nexa's roles, not a second enum. The four labels the Mirza research observed are
 * expressible as presets that already exist (`owner`, `sales`, `support`,
 * `receipt_reviewer`), and `setRoles` carries the escalation rule, the last-owner
 * protection and the audit row that a Telegram-side enum would not.
 *
 * ONE role, because a keyboard-free command that took a list would be a list a
 * reviewer cannot see; the Web Admin is where a multi-role composition is edited.
 */
async function adminRole(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  args: readonly string[],
  idempotencyKey: string,
): Promise<PendingReply> {
  const admins = rt.deps.telegramAdmins;
  const username = args[0];
  const roleKey = args[1];
  if (admins === undefined || username === undefined || roleKey === undefined) {
    return { key: 'bot.admin.usage', values: {}, buttons: [], orderId: null };
  }
  const result = await admins.setRoles(scope, actor, {
    username,
    roleKeys: [roleKey],
    reason: 'Roles set from the Telegram management panel.',
    // The update's own key, as the payment decisions pass theirs: a redelivered
    // command is answered from the store, never run twice.
    idempotencyKey,
  });
  return {
    key: 'bot.admin.roles_set',
    values: { username: result.admin.username, roles: result.roleKeys.join(', ') },
    buttons: [],
    orderId: null,
  };
}
