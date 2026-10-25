// Admin-in-bot: customers and product categories. Moved verbatim out of bot-runtime.ts
// (R9 split): each method is a free function taking the runtime first.
import {
  ADMIN_AMOUNT_CAPTURE_TTL_MS,
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  isNexaError,
  telegramUserIdSchema,
  uuidV7Schema,
} from '@nexa/contracts';
import type {
  ActorContext,
  BotInstanceId,
  PermissionKey,
  ProductId,
  TemplateKey,
  TemplateValues,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import { ADMIN_CAPTURE_REASON_MAX_LENGTH } from '@nexa/contracts';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import { CATEGORY_SORT_ORDER_MAX } from '../../../modules/commerce/catalog/application/product-category.service.js';
import type {
  ProductCategoryListing,
  ProductRecord,
} from '../../../modules/commerce/catalog/application/ports.js';
import { encodeKeysetToken, type KeysetToken } from '../keyset-token.js';
import {
  ADMIN_CATEGORIES_CALLBACK_PREFIX,
  ADMIN_CATEGORY_ASSIGN_CALLBACK_PREFIX,
  ADMIN_CATEGORY_CALLBACK_PREFIX,
  ADMIN_CATEGORY_PICK_CALLBACK_PREFIX,
  ADMIN_CATEGORY_PRODUCTS_CALLBACK_PREFIX,
  ADMIN_CUSTOMERS_CALLBACK_PREFIX,
  ADMIN_CUSTOMER_CALLBACK_PREFIX,
  type AdminCategoryCode,
  encodeIdPair,
} from './callbacks.js';
import type { BotRuntimeDeps } from './deps.js';
import { type BotCommand, type BotIntent } from './intents.js';
import { type PendingReply } from './replies.js';
import type { BotRuntime } from '../bot-runtime.js';
import {
  ADMIN_QUEUE_LIMIT,
  CATALOG_EDIT_PERMISSION,
  CUSTOMERS_BLOCK_PERMISSION,
} from './admin-common.js';

/** How many categories one page of the operator list — and of the picker — shows. */
const ADMIN_CATEGORY_PAGE_SIZE = 8;

function adminCustomerLabel(customer: CustomerRecord): string {
  const name = [customer.firstName, customer.lastName].filter((part) => part !== null).join(' ');
  const who =
    customer.username !== null
      ? `@${customer.username}`
      : name !== ''
        ? name
        : customer.telegramUserId;
  return `${who} — ${customer.status}`;
}

/**
 * The detail screen for one customer, shared by the read, the lookup and the write.
 *
 * ONE builder, so the buttons an operator sees after a change are the buttons the new
 * state actually offers — a second copy is how a block leaves a "block" button on the
 * screen, which is the defect `adminAdminReply` was written to avoid and the same one
 * applies here.
 *
 * The status button offered is the OPPOSITE of the status held, and neither is drawn
 * without `users.block`. That is a courtesy: `CustomerService.setStatus` charges the key
 * through the guard and re-checks it inside the writing transaction, so a crafted `9:b:`
 * callback from an administrator who lacks it is refused there and leaves the record.
 *
 * What this screen carries is a person and nothing they bought. No wallet balance, no
 * order, no service, no subscription reference: each is a different permission, and a
 * Telegram message is forwardable — which is the argument ADR-0023 makes about panel
 * credentials and `services.tsx` makes about subscription URLs.
 */
function adminCustomerReply(
  customer: CustomerRecord,
  permissions: ReadonlySet<PermissionKey>,
): PendingReply {
  const buttons: CustomerButton[] = [];
  if (permissions.has(CUSTOMERS_BLOCK_PERMISSION)) {
    const blocked = customer.status === 'BLOCKED';
    buttons.push({
      label: {
        kind: 'TEMPLATE',
        key: blocked ? 'bot.admin.customer_unblock_button' : 'bot.admin.customer_block_button',
      },
      /*
       * The TARGET status, not "flip it".
       *
       * A double tap then writes the same status twice — which `setStatus`'s conditional
       * UPDATE answers as a successful no-op — instead of toggling twice, which is the
       * difference between an idempotent button and one that undoes itself on a slow
       * connection. The same reasoning `4:` and `7:` record.
       */
      data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}${blocked ? 'u' : 'b'}:${customer.id}`,
    });
  }
  buttons.push({
    label: { kind: 'TEMPLATE', key: 'bot.admin.customers_back_button' },
    data: ADMIN_CUSTOMERS_CALLBACK_PREFIX,
  });
  const name = [customer.firstName, customer.lastName].filter((part) => part !== null).join(' ');
  return {
    key: 'bot.admin.customer_detail',
    values: {
      telegramId: customer.telegramUserId,
      username: customer.username === null ? '—' : `@${customer.username}`,
      name: name === '' ? '—' : name,
      status: customer.status,
      /*
       * The operator note, or a dash — never a stale one.
       *
       * `setStatus` clears it on an unblock precisely so a reason cannot outlive the
       * block it explains, and this renders whatever it finds rather than deciding by
       * status: two places deciding when a reason is current is how they disagree.
       */
      reason: customer.blockedReason ?? '—',
      firstSeen: customer.firstSeenAt,
      lastSeen: customer.lastSeenAt,
    },
    buttons,
    orderId: null,
  };
}

/**
 * Whether a refusal means "no such customer" rather than "not you".
 *
 * The section's read paths catch NARROWLY, on these two codes alone, and rethrow
 * everything else — and that distinction is the whole point rather than tidiness. A
 * catch-all was the first version, and it answered an administrator who lacks
 * `users.view` with `bot.admin.customer_gone`: a sentence saying the person does not
 * exist, to somebody who was only refused permission to look. An operator acts on that
 * — they tell the customer there is no account — and the fact they were actually told
 * is about THEMSELVES, not about anybody's data, so there is nothing to protect by
 * blurring it.
 *
 * A denial therefore falls through to `adminTurn`'s single refusal, which is what every
 * other denial on this surface answers with, and `customer_gone` stays the one answer
 * for the four cases that genuinely mean "not here": unknown, malformed, another
 * tenant's, and a lookup that matched nobody.
 *
 * `COMMERCE_REQUEST_INVALID` is in the pair because `CustomerService.customerId`
 * raises it for an id that is not a UUIDv7 — which the callback boundary has already
 * refused, so it is reachable only from a typed command, and is still "no such
 * customer" from where an operator sits.
 */
export function isCustomerMiss(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND ||
    code === COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID
  );
}

/**
 * The categories section's three fixed answers.
 *
 * `CATEGORY_GONE` and `PRODUCT_GONE` are the section's one answer for an id that is
 * unknown or another tenant's — the rule `bot.admin.panel_gone` states — and
 * `CATEGORY_USAGE` repeats the syntax of the three commands rather than opening a prompt
 * for what was missing.
 */
const CATEGORY_GONE: PendingReply = {
  key: 'bot.admin.category_gone',
  values: {},
  buttons: [],
  orderId: null,
};

const PRODUCT_GONE: PendingReply = {
  key: 'bot.admin.product_gone',
  values: {},
  buttons: [],
  orderId: null,
};

const CATEGORY_USAGE: PendingReply = {
  key: 'bot.admin.category_usage',
  values: {},
  buttons: [],
  orderId: null,
};

/**
 * Whether a refusal means "no such category" rather than "not you".
 *
 * NARROW, for the reason `isCustomerMiss` gives: a permission denial answered as
 * `category_gone` tells an operator the category does not exist when they were only
 * refused, and they act on it. `COMMERCE_REQUEST_INVALID` is deliberately NOT here —
 * the service also raises it for a name or emoji it will not store, and for a transition
 * that lost a race, neither of which means the category is gone. Every id that reaches
 * the service from a button has passed `uuidV7Schema` at the boundary already.
 */
function isCategoryMiss(error: unknown): boolean {
  return isNexaError(error) && error.code === COMMERCE_ERROR_CODES.CATEGORY_NOT_FOUND;
}

/** As `isCategoryMiss`, for the product a reassignment names. */
function isProductMiss(error: unknown): boolean {
  return isNexaError(error) && error.code === COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND;
}

/**
 * A category as one button: its emoji and name, then the two flags that decide what a
 * customer sees, then how many products are filed under it.
 *
 * The flags are the frozen vocabulary rather than words, the way a customer's status is
 * on `adminCustomerLabel` — they are what the detail screen and the Web Admin show, so an
 * operator reads the same token in all three places.
 */
function adminCategoryLabel(category: ProductCategoryListing): string {
  const name = category.emoji === null ? category.name : `${category.emoji} ${category.name}`;
  return `${name} · ${category.status} · ${category.visibility} · ${category.productCount}`;
}

/**
 * The detail screen for one category, shared by the read and by every write.
 *
 * ONE builder, the rule `adminCustomerReply` states: the buttons an operator sees after a
 * change are the ones the new state offers. Each flag button carries the TARGET state —
 * the opposite of what the category holds — and up and down are drawn only where the
 * category can move. None of the write buttons is drawn without `catalog.edit`, and the
 * service charges it again whatever is drawn.
 */
function adminCategoryReply(
  category: ProductCategoryListing,
  index: number,
  count: number,
  mayEdit: boolean,
): PendingReply {
  const buttons: CustomerButton[] = [];
  const act = (code: AdminCategoryCode, key: TemplateKey): CustomerButton => ({
    label: { kind: 'TEMPLATE', key },
    data: `${ADMIN_CATEGORY_CALLBACK_PREFIX}${code}:${category.id}`,
  });
  if (mayEdit) {
    buttons.push(
      category.status === 'ACTIVE'
        ? act('d', 'bot.admin.category_deactivate_button')
        : act('a', 'bot.admin.category_activate_button'),
      category.visibility === 'VISIBLE'
        ? act('h', 'bot.admin.category_hide_button')
        : act('s', 'bot.admin.category_show_button'),
    );
    if (index > 0) buttons.push(act('u', 'bot.admin.category_up_button'));
    if (index < count - 1) buttons.push(act('w', 'bot.admin.category_down_button'));
    buttons.push(act('x', 'bot.admin.category_delete_button'));
  }
  buttons.push({
    label: { kind: 'TEMPLATE', key: 'bot.admin.categories_back_button' },
    data: `${ADMIN_CATEGORIES_CALLBACK_PREFIX}${Math.floor(index / ADMIN_CATEGORY_PAGE_SIZE)}`,
  });
  return {
    key: 'bot.admin.category_detail',
    values: {
      id: category.id,
      name: category.name,
      emoji: category.emoji ?? '—',
      status: category.status,
      visibility: category.visibility,
      products: category.productCount,
    },
    buttons,
    orderId: null,
  };
}

/** The customers section's block cancel button (WP10G): `9:x:<captureId>`. */
function customerBlockCancelButton(captureId: string): CustomerButton {
  return {
    label: { kind: 'TEMPLATE', key: 'bot.admin.block_cancel_button' },
    data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}x:${captureId}`,
  };
}

/**
 * The customers section: a page of this tenant's customers, oldest first.
 *
 * ## Why it pages rather than bounding like the queues do
 *
 * `adminServices` is a QUEUE — the ten things needing attention — and drops its
 * `nextCursor` on the floor deliberately, because the eleventh unreconciled service is
 * not a thing an operator scrolls to. A customer list is an INVENTORY: the customer an
 * operator is looking for is as likely to be the four-hundredth as the fourth, so this
 * pages the way `adminPanels` does, through the codec that makes a keyset cursor fit
 * Telegram's 64-byte `callback_data`.
 *
 * ## And why the lookup command exists beside it
 *
 * Paging to the four-hundredth customer is forty taps. The command in the section's
 * own text takes the numeric id from a support conversation straight to the detail
 * screen, and charges `users.search` on top of `users.view` for doing it — a list of
 * a tenant's own customers and a lookup of one specific person are different
 * questions, which is why `CustomerService.list` separates them.
 *
 * ## No counts
 *
 * The rule `bot.admin.panels_section` states: a figure in this message goes stale
 * between the render and the tap. `adminSection` prints `shown of total` because an
 * administrator roster is a bounded hand-made list that is NOT paged, so its bound
 * would otherwise be silent. This one has a next-page button instead, which is the
 * same honesty by a different means.
 */
export async function adminCustomers(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  cursor: KeysetToken | null,
): Promise<PendingReply> {
  const page = await rt.deps.customers.list(scope, actor, {
    limit: ADMIN_QUEUE_LIMIT,
    /*
     * The decoded token, used as this module's cursor.
     *
     * `CustomerCursor.id` is branded `UserId` and a token's is a plain string, so the
     * brand is asserted rather than parsed — deliberately, and for the reason
     * `keyset-cursor.ts` gives about accepting any UUID version: this id only ever
     * feeds a `>` comparison against `(created_at, id)`, never a lookup of a person,
     * and `decodeKeysetToken` has already guaranteed it is thirty-two hex digits in a
     * UUID's shape. Running it through `userIdSchema` would refuse a v4 row an import
     * or a restore created and end that traversal early.
     */
    cursor: cursor === null ? null : { createdAt: cursor.createdAt, id: cursor.id as UserId },
  });
  if (page.items.length === 0) {
    /*
     * Empty is empty, cursor or not.
     *
     * Reachable WITH a cursor: an operator pages forward and the last of the customers
     * was on the previous page. `bot.admin.customers_none` reads correctly in both
     * cases, because it says nobody is here rather than that nobody exists.
     */
    return { key: 'bot.admin.customers_none', values: {}, buttons: [], orderId: null };
  }

  const buttons: CustomerButton[] = page.items.map((customer) => ({
    label: { kind: 'TEXT' as const, text: adminCustomerLabel(customer) },
    data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}v:${customer.id}`,
  }));
  /*
   * The next page, appended only when the cursor ENCODES — the rule `adminPanels` and
   * the customer's own services list both state. A cursor this codec cannot carry
   * would become a button whose tap Telegram rejects, and a list that ends is the
   * safe direction.
   */
  const token = page.nextCursor === null ? null : encodeKeysetToken(page.nextCursor);
  if (token !== null) {
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.customers_more_button' },
      data: `${ADMIN_CUSTOMERS_CALLBACK_PREFIX}${token}`,
    });
  }
  return { key: 'bot.admin.customers_section', values: {}, buttons, orderId: null };
}

/**
 * One customer, by the internal id a row carries.
 *
 * An id that is unknown, malformed or another tenant's gets ONE answer — the rule
 * `bot.admin.panel_gone` states — so nobody holding an id can learn whether it names
 * anybody on this installation. `CustomerService.get` charges `users.view` BEFORE it
 * validates the id, so an administrator without the permission cannot even learn
 * whether an id is well-formed.
 */
export async function adminCustomer(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  customerId: string,
  permissions: ReadonlySet<PermissionKey>,
): Promise<PendingReply> {
  let customer: CustomerRecord;
  try {
    customer = await rt.deps.customers.get(scope, actor, customerId);
  } catch (error) {
    // NARROW. See `isCustomerMiss`: a denial is not a missing person, and saying so
    // is what an operator would act on.
    if (isCustomerMiss(error)) {
      return { key: 'bot.admin.customer_gone', values: {}, buttons: [], orderId: null };
    }
    throw error;
  }
  return adminCustomerReply(customer, permissions);
}

/**
 * The same screen, reached by the numeric Telegram id an operator quotes.
 *
 * Through `list` with its EXACT `telegramUserId` filter, which is the one way this
 * codebase asks that question — `CustomerRepository` says so in the comment where
 * `findByTelegramId` used to be, and two ways to ask one question is how two answers
 * start. The filter is exact rather than a prefix for a reason stated there too: a
 * partial match on a Telegram id is a way to enumerate them.
 *
 * A blank or unmatched argument gets the SYNTAX rather than a prompt for the missing
 * one, because a prompt that outlives its question swallows the next unrelated
 * message (INCIDENT-FIN-001). An id that matches nobody gets `customer_gone`, the
 * same single answer the row path gives.
 */
export async function adminCustomerFind(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  telegramUserId: string,
  permissions: ReadonlySet<PermissionKey>,
): Promise<PendingReply> {
  const needle = telegramUserId.trim();
  /*
   * The shape is checked HERE, against the CONTRACT's own schema, and the permission
   * is NOT.
   *
   * An argument that is not a Telegram id is a typing mistake, not a lookup, and
   * answering it with the syntax costs nothing and tells nobody anything: it is a
   * fact about the message that was sent, not about this installation's customers.
   * Everything that IS a fact about them — whether that id exists — goes through
   * `list`, which charges `users.view` and then `users.search` before it looks.
   *
   * `telegramUserIdSchema` and not a regex written here. This was `/^\d{1,32}$/`,
   * which is looser than the contract in both directions: it accepted a leading zero
   * and up to thirty-two digits, neither of which any Telegram account has. Those
   * reached `list` — which trusts its `CustomerSearch` and validates nothing — spent
   * `users.search` on a value that cannot match, and came back `customer_gone`: the
   * sentence that says the person does not exist, for a string that is not an id at
   * all. One schema means the Telegram lookup and the HTTP one agree about what an
   * id is, which is the same reason `orders.tsx` parses with `uuidV7Schema` rather
   * than its own idea of a uuid.
   */
  if (!telegramUserIdSchema.safeParse(needle).success) {
    return { key: 'bot.admin.customer_usage', values: {}, buttons: [], orderId: null };
  }
  /*
   * NOT wrapped in a catch at all.
   *
   * `list` refuses with a permission denial or it answers; there is no "miss" it can
   * raise, because an id that matches nobody comes back as an empty page. So a
   * denial — an administrator holding `users.view` and not `users.search` — reaches
   * `adminTurn`'s single refusal, which is the same answer every other denial on this
   * surface gets and is not `customer_gone`: that sentence would tell somebody who
   * was refused permission that the person does not exist.
   */
  const page = await rt.deps.customers.list(scope, actor, {
    search: { telegramUserId: needle },
    limit: 1,
  });
  const customer = page.items[0];
  if (customer === undefined) {
    return { key: 'bot.admin.customer_gone', values: {}, buttons: [], orderId: null };
  }
  return adminCustomerReply(customer, permissions);
}

/**
 * Blocks or unblocks one customer, in two steps each (WP10G, closing OQ-WP10F-03).
 *
 * A block is ask → yes (open the reason capture) → the reason, typed → a confirmation
 * restating it → `CustomerService.blockWithOutcome`, through `CustomerBlockCaptureService`:
 * the receipt's Block User mechanics with a customer as the target, so a block cannot be
 * silent and the typed text alone changes nothing. An unblock is ask → confirm →
 * `CustomerService.unblock`. Both services carry every refusal this needs — the permission
 * is charged and re-checked inside the writing transaction, the scope's activity is read
 * there too, the id is validated and lower-cased before the idempotency hash, and the update
 * is CONDITIONAL on the status it expects to find — so this adds none of its own and catches
 * nothing: `adminTurn`'s single refusal answers a denial.
 *
 * Every reply after a write is the detail screen's own builder, so the buttons an operator
 * sees are the ones the state actually offers, and a redelivered update reads as the state it
 * found rather than claiming a second change.
 */
export async function adminCustomerStatusTurn(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  intent: BotIntent,
  targetId: string,
  permissions: ReadonlySet<PermissionKey>,
  input: { readonly idempotencyKey: string; readonly botInstanceId: BotInstanceId },
): Promise<PendingReply | null> {
  const blocks = rt.deps.customerBlocks;
  const reply = (
    key: TemplateKey,
    values: TemplateValues = {},
    buttons: readonly CustomerButton[] = [],
  ): PendingReply => ({ key, values, buttons: [...buttons], orderId: null });
  const detail = async (customerId: string): Promise<PendingReply> => {
    try {
      return adminCustomerReply(await rt.deps.customers.get(scope, actor, customerId), permissions);
    } catch (error) {
      if (isCustomerMiss(error)) return reply('bot.admin.customer_gone');
      throw error;
    }
  };
  const changed = (customer: CustomerRecord): PendingReply => ({
    key: 'bot.admin.customer_status_changed',
    values: { telegramId: customer.telegramUserId, status: customer.status },
    buttons: adminCustomerReply(customer, permissions).buttons,
    orderId: null,
  });
  const backButton = (customerId: string): CustomerButton => ({
    label: { kind: 'TEMPLATE', key: 'bot.admin.block_cancel_button' },
    data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}v:${customerId}`,
    row: 0,
  });

  switch (intent) {
    case 'ADMIN_CUSTOMER_BLOCK': {
      // The ASK writes nothing. Through the capture service so the same permission pair
      // (`users.block`, `users.view`) is charged that the open will charge.
      if (blocks === undefined) return null;
      const asked = await blocks.ask(scope, actor, targetId);
      if (asked.outcome === 'GONE') return reply('bot.admin.customer_gone');
      if (asked.customer.status === 'BLOCKED') return changed(asked.customer);
      return reply('bot.admin.customer_block_ask', { customer: asked.customer.telegramUserId }, [
        {
          label: { kind: 'TEMPLATE', key: 'bot.admin.block_yes_button' },
          data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}o:${targetId}`,
          row: 0,
        },
        backButton(targetId),
      ]);
    }
    case 'ADMIN_CUSTOMER_BLOCK_OPEN': {
      if (blocks === undefined) return null;
      const opened = await blocks.open(scope, actor, {
        idempotencyKey: `${input.idempotencyKey}:customer-block-open`,
        botInstanceId: input.botInstanceId,
        targetId,
      });
      if (opened.outcome === 'GONE') return reply('bot.admin.customer_gone');
      return reply(
        'bot.admin.customer_block_reason_prompt',
        {
          customer: opened.customer.telegramUserId,
          minutes: Math.round(ADMIN_AMOUNT_CAPTURE_TTL_MS / 60_000),
        },
        [customerBlockCancelButton(opened.capture.id)],
      );
    }
    case 'ADMIN_CUSTOMER_BLOCK_CONFIRM': {
      if (blocks === undefined) return null;
      const done = await blocks.confirm(scope, actor, { captureId: targetId });
      if (done.outcome === 'DONE') {
        // Already blocked: the conditional UPDATE did not match, the stored reason stands
        // untouched, and the operator is told the state found rather than a second change.
        if (!done.result.changed) {
          return reply(
            'bot.admin.customer_block_already',
            { customer: done.result.customer.telegramUserId },
            adminCustomerReply(done.result.customer, permissions).buttons,
          );
        }
        return changed(done.result.customer);
      }
      if (done.outcome === 'CLOSED') {
        return reply(
          done.reason === 'CANCELLED'
            ? 'bot.admin.customer_block_cancelled'
            : 'bot.admin.customer_block_expired',
        );
      }
      return reply('bot.admin.customer_gone');
    }
    case 'ADMIN_CUSTOMER_BLOCK_CANCEL': {
      if (blocks === undefined) return null;
      const cancelled = await blocks.cancel(scope, actor, {
        idempotencyKey: `${input.idempotencyKey}:customer-block-cancel`,
        captureId: targetId,
      });
      if (cancelled.outcome === 'CANCELLED') return reply('bot.admin.customer_block_cancelled');
      if (cancelled.outcome === 'GONE') return reply('bot.admin.customer_gone');
      // A CONFIRMED reason is not a block: the block runs after the capture closes, and one
      // refused or interrupted leaves the capture confirmed and the customer untouched. So
      // the customer's own row answers, through the detail screen's builder.
      return detail(cancelled.targetId);
    }
    case 'ADMIN_CUSTOMER_UNBLOCK': {
      // The ASK writes nothing; the read charges `users.view`, as the detail screen does.
      const customer = await rt.deps.customers.get(scope, actor, targetId).catch((error) => {
        if (isCustomerMiss(error)) return null;
        throw error;
      });
      if (customer === null) return reply('bot.admin.customer_gone');
      if (customer.status !== 'BLOCKED') return changed(customer);
      return reply('bot.admin.customer_unblock_ask', { customer: customer.telegramUserId }, [
        {
          label: { kind: 'TEMPLATE', key: 'bot.admin.customer_unblock_confirm_button' },
          data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}n:${targetId}`,
          row: 0,
        },
        backButton(targetId),
      ]);
    }
    case 'ADMIN_CUSTOMER_UNBLOCK_CONFIRM': {
      const updated = await rt.deps.customers.unblock(scope, actor, {
        // Suffixed: the update's own key is `resolveFromUpdate`'s record in the `TELEGRAM`
        // namespace, which is where a Telegram administrator's unblock is remembered too.
        idempotencyKey: `${input.idempotencyKey}:customer-unblock`,
        customerId: targetId,
        reason: null,
      });
      return changed(updated);
    }
    default:
      return null;
  }
}

/**
 * The typed reason of a block from the customers section (WP10G), recorded and restated;
 * nothing is blocked until the confirm. The same shape as `adminBlockReason`, for the same
 * purpose-keyed capture, so at most one of the three reason paths answers a message.
 */
export async function adminCustomerBlockReason(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  text: string,
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly telegramUserId: string;
  },
): Promise<PendingReply | null> {
  const blocks = rt.deps.customerBlocks;
  const admins = rt.deps.telegramAdmins;
  if (blocks === undefined || admins === undefined) return null;
  const identity = await admins.resolve(scope, input.telegramUserId, actor.correlationId);
  if (identity === null) return null;
  try {
    const result = await blocks.submitReason(scope, identity.actor, {
      idempotencyKey: `${input.idempotencyKey}:customer-block-reason`,
      botInstanceId: input.botInstanceId,
      text,
    });
    switch (result.outcome) {
      case 'NO_CAPTURE':
        return null;
      case 'INVALID':
        return {
          key: 'bot.admin.block_reason_invalid',
          values: { max: ADMIN_CAPTURE_REASON_MAX_LENGTH },
          buttons: [],
          orderId: null,
        };
      case 'EXPIRED':
        return {
          key: 'bot.admin.customer_block_expired',
          values: {},
          buttons: [],
          orderId: null,
        };
      case 'GONE':
        return { key: 'bot.admin.customer_gone', values: {}, buttons: [], orderId: null };
      case 'ENTERED':
        return {
          key: 'bot.admin.customer_block_confirm',
          values: { customer: result.customer.telegramUserId, reason: result.reason },
          buttons: [
            {
              label: { kind: 'TEMPLATE', key: 'bot.admin.block_confirm_button' },
              data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}c:${result.capture.id}`,
              row: 0,
            },
            { ...customerBlockCancelButton(result.capture.id), row: 0 },
          ],
          orderId: null,
        };
    }
  } catch {
    return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
  }
}

/**
 * The categories section: one dispatcher, so the switch in `adminTurn` has one arm.
 *
 * Every branch calls `ProductCategoryService` or `ProductService` and nothing else, so
 * this surface decides which buttons to draw and how to word an outcome, and never
 * whether something is allowed. The permission is charged by the service on every call
 * — including the reads — and a denial is left to reach `adminTurn`'s single refusal.
 *
 * The idempotency key is the TURN's, suffixed by the action, the shape `adminPanelAct`
 * uses: a redelivered update is the same command twice and replays.
 */
export async function adminCategoryTurn(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  command: BotCommand,
  permissions: ReadonlySet<PermissionKey>,
  idempotencyKey: string,
): Promise<PendingReply | null> {
  const categories = rt.deps.productCategories;
  if (categories === undefined) return null;
  const mayEdit = permissions.has(CATALOG_EDIT_PERMISSION);
  const id = command.targetId;

  switch (command.intent) {
    case 'ADMIN_CATEGORIES':
      return adminCategoryList(rt, await categories.list(scope, actor), command.page ?? 0, mayEdit);
    case 'ADMIN_CATEGORY':
      return id === null ? null : adminCategoryDetail(rt, scope, actor, id, mayEdit);
    case 'ADMIN_CATEGORY_ACTIVATE':
    case 'ADMIN_CATEGORY_DEACTIVATE':
    case 'ADMIN_CATEGORY_SHOW':
    case 'ADMIN_CATEGORY_HIDE': {
      if (id === null) return null;
      const input = {
        idempotencyKey: `${idempotencyKey}:category-${command.intent.slice('ADMIN_CATEGORY_'.length).toLowerCase()}`,
        categoryId: id,
      };
      try {
        if (command.intent === 'ADMIN_CATEGORY_ACTIVATE')
          await categories.activate(scope, actor, input);
        else if (command.intent === 'ADMIN_CATEGORY_DEACTIVATE')
          await categories.deactivate(scope, actor, input);
        else if (command.intent === 'ADMIN_CATEGORY_SHOW')
          await categories.show(scope, actor, input);
        else await categories.hide(scope, actor, input);
      } catch (error) {
        if (isCategoryMiss(error)) return CATEGORY_GONE;
        throw error;
      }
      // The state it HOLDS now, from the same builder the read uses — so a redelivered
      // tap reads as the state it found, and the button left on the screen is the
      // opposite of the state rather than the one just pressed.
      return adminCategoryDetail(rt, scope, actor, id, mayEdit);
    }
    case 'ADMIN_CATEGORY_UP':
    case 'ADMIN_CATEGORY_DOWN':
      return id === null
        ? null
        : adminCategoryMove(
            rt,
            scope,
            actor,
            id,
            command.intent === 'ADMIN_CATEGORY_UP',
            mayEdit,
            idempotencyKey,
          );
    case 'ADMIN_CATEGORY_DELETE_ASK':
      return id === null ? null : adminCategoryDeleteAsk(rt, scope, actor, id, mayEdit);
    case 'ADMIN_CATEGORY_DELETE':
      return id === null ? null : adminCategoryDelete(rt, scope, actor, id, idempotencyKey);
    case 'ADMIN_CATEGORY_NEW':
      return adminCategoryNew(rt, scope, actor, command.args ?? [], mayEdit, idempotencyKey);
    case 'ADMIN_CATEGORY_RENAME':
    case 'ADMIN_CATEGORY_EMOJI':
      return adminCategoryEdit(
        rt,
        scope,
        actor,
        command.intent === 'ADMIN_CATEGORY_RENAME' ? 'name' : 'emoji',
        command.args ?? [],
        mayEdit,
        idempotencyKey,
      );
    case 'ADMIN_CATEGORY_PRODUCTS':
      return adminCategoryProducts(rt, scope, actor, command.cursor ?? null);
    case 'ADMIN_CATEGORY_PICK':
      return id === null ? null : adminCategoryPick(rt, scope, actor, id, command.page ?? 0);
    case 'ADMIN_CATEGORY_ASSIGN':
      return id === null || command.secondaryId === undefined || command.secondaryId === null
        ? null
        : adminCategoryAssign(rt, scope, actor, id, command.secondaryId, idempotencyKey);
    default:
      return null;
  }
}

/**
 * One page of the operator's category list.
 *
 * EVERY category, in the order customers see them — empty, hidden and inactive ones
 * included, because this is where an operator finds them to fix. Paged in memory from
 * `list`, which returns the whole list the Web Admin's screen draws: an operator's own
 * categories are a hand-made list, and the reorder buttons need its full order anyway.
 *
 * A page past the end — a delete shrank the list since the button was drawn — shows the
 * LAST page rather than an empty one: the list exists, it is just shorter now.
 */
function adminCategoryList(
  rt: BotRuntime,
  list: readonly ProductCategoryListing[],
  requested: number,
  mayEdit: boolean,
): PendingReply {
  if (list.length === 0) {
    return { key: 'bot.admin.categories_none', values: {}, buttons: [], orderId: null };
  }
  const lastPage = Math.floor((list.length - 1) / ADMIN_CATEGORY_PAGE_SIZE);
  const page = Math.min(requested, lastPage);
  const start = page * ADMIN_CATEGORY_PAGE_SIZE;
  const buttons: CustomerButton[] = list
    .slice(start, start + ADMIN_CATEGORY_PAGE_SIZE)
    .map((category) => ({
      label: { kind: 'TEXT' as const, text: adminCategoryLabel(category) },
      data: `${ADMIN_CATEGORY_CALLBACK_PREFIX}v:${category.id}`,
    }));
  if (page > 0) {
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.categories_previous_button' },
      data: `${ADMIN_CATEGORIES_CALLBACK_PREFIX}${page - 1}`,
    });
  }
  if (page < lastPage) {
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.categories_next_button' },
      data: `${ADMIN_CATEGORIES_CALLBACK_PREFIX}${page + 1}`,
    });
  }
  if (mayEdit) {
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.category_products_button' },
      data: ADMIN_CATEGORY_PRODUCTS_CALLBACK_PREFIX,
    });
  }
  return { key: 'bot.admin.categories_section', values: {}, buttons, orderId: null };
}

/**
 * One category, re-read from the list rather than trusted from the callback.
 *
 * From `list` and not `get`, because the screen needs two things `get` does not carry:
 * the product count, which decides whether the delete is possible, and the category's
 * POSITION, which decides whether up and down are drawn. Both are read now, so a stale
 * tap lands on the state that is true rather than on the one the old screen showed.
 */
async function adminCategoryDetail(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  categoryId: string,
  mayEdit: boolean,
): Promise<PendingReply> {
  const list = await requireCategories(rt).list(scope, actor);
  const index = list.findIndex((category) => category.id === categoryId);
  const category = list[index];
  if (category === undefined) return CATEGORY_GONE;
  return adminCategoryReply(category, index, list.length, mayEdit);
}

/**
 * Moves a category one place, by writing the WHOLE order back.
 *
 * The service's reorder takes positions for any subset, and swapping only the two
 * neighbours' `sort_order` values looks simpler — and does nothing at all when they are
 * equal, which the default of every category created without a position is. So the
 * current order is renumbered in steps of ten with the two swapped, and the service
 * refuses the lot if any of them has gone.
 *
 * A redelivered update recomputes the order from the state its first delivery left and
 * sends a DIFFERENT position list under the same key, which the idempotency store
 * refuses as a payload mismatch. That refusal means "this update already ran", so it
 * is answered with the list as it now stands rather than with a refusal for a move
 * that happened.
 */
async function adminCategoryMove(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  categoryId: string,
  up: boolean,
  mayEdit: boolean,
  idempotencyKey: string,
): Promise<PendingReply> {
  const categories = requireCategories(rt);
  const list = await categories.list(scope, actor);
  const index = list.findIndex((category) => category.id === categoryId);
  if (index < 0) return CATEGORY_GONE;
  const target = up ? index - 1 : index + 1;
  if (target < 0 || target >= list.length) {
    // Already at that end: nothing to move, and the list says so.
    return adminCategoryList(rt, list, Math.floor(index / ADMIN_CATEGORY_PAGE_SIZE), mayEdit);
  }
  const order = [...list];
  [order[index], order[target]] = [
    order[target] as ProductCategoryListing,
    order[index] as ProductCategoryListing,
  ];
  let after: readonly ProductCategoryListing[];
  try {
    after = await categories.reorder(scope, actor, {
      idempotencyKey: `${idempotencyKey}:category-move`,
      positions: order.map((category, position) => ({
        id: category.id,
        sortOrder: (position + 1) * 10,
      })),
    });
  } catch (error) {
    if (
      isNexaError(error) &&
      (error.code === PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH ||
        error.code === COMMERCE_ERROR_CODES.CATEGORY_NOT_FOUND)
    ) {
      /*
       * Either this update already ran, or a category in the list was deleted between
       * the read and the write — in which case the service refused the WHOLE reorder
       * and nothing moved. Both are answered with the list as it is now, which is the
       * truth in either case.
       */
      const now = await categories.list(scope, actor);
      const at = now.findIndex((category) => category.id === categoryId);
      return adminCategoryList(
        rt,
        now,
        Math.floor(Math.max(at, 0) / ADMIN_CATEGORY_PAGE_SIZE),
        mayEdit,
      );
    }
    throw error;
  }
  const moved = after.findIndex((category) => category.id === categoryId);
  return adminCategoryList(
    rt,
    after,
    Math.floor(Math.max(moved, 0) / ADMIN_CATEGORY_PAGE_SIZE),
    mayEdit,
  );
}

/**
 * The question before a delete, or the refusal it would get.
 *
 * A category that still holds products is answered with the count and no confirm
 * button: the delete would be refused, and a button whose every press is refused is
 * the "silent success" shape the other way round. The count here is a COURTESY read
 * when the screen is drawn; `ProductCategoryService.remove` counts again under the
 * category's lock and refuses on that number, not this one.
 */
async function adminCategoryDeleteAsk(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  categoryId: string,
  mayEdit: boolean,
): Promise<PendingReply> {
  if (!mayEdit) return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
  const list = await requireCategories(rt).list(scope, actor);
  const category = list.find((candidate) => candidate.id === categoryId);
  if (category === undefined) return CATEGORY_GONE;
  const back: CustomerButton = {
    label: { kind: 'TEMPLATE', key: 'bot.admin.categories_back_button' },
    data: `${ADMIN_CATEGORY_CALLBACK_PREFIX}v:${category.id}`,
  };
  if (category.productCount > 0) {
    return {
      key: 'bot.admin.category_not_empty',
      values: { products: category.productCount },
      buttons: [back],
      orderId: null,
    };
  }
  return {
    key: 'bot.admin.category_delete_ask',
    values: { name: category.name },
    buttons: [
      {
        label: { kind: 'TEMPLATE', key: 'bot.admin.category_delete_confirm_button' },
        data: `${ADMIN_CATEGORY_CALLBACK_PREFIX}X:${category.id}`,
      },
      back,
    ],
    orderId: null,
  };
}

/**
 * Deletes a category — and says how many products stopped it when it cannot.
 *
 * The count in the refusal is the one `remove` took under the category's lock and put on
 * the error, not one read here: a product filed under the category between the ask and
 * the confirm is exactly the case the lock exists for, and this reply names it.
 *
 * The name is read BEFORE the delete, because afterwards there is nothing to read it
 * from. A redelivered confirm finds no row to read, and `remove` replays its first
 * answer; the reply then names nothing rather than inventing a name.
 */
async function adminCategoryDelete(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  categoryId: string,
  idempotencyKey: string,
): Promise<PendingReply> {
  const categories = requireCategories(rt);
  const before = (await categories.list(scope, actor)).find(
    (candidate) => candidate.id === categoryId,
  );
  try {
    await categories.remove(scope, actor, {
      idempotencyKey: `${idempotencyKey}:category-delete`,
      categoryId,
    });
  } catch (error) {
    if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.CATEGORY_NOT_EMPTY) {
      const held = error.details?.['productCount'];
      return {
        key: 'bot.admin.category_not_empty',
        values: { products: typeof held === 'number' ? held : (before?.productCount ?? 0) },
        buttons: [
          {
            label: { kind: 'TEMPLATE', key: 'bot.admin.categories_back_button' },
            data: `${ADMIN_CATEGORY_CALLBACK_PREFIX}v:${categoryId}`,
          },
        ],
        orderId: null,
      };
    }
    if (isCategoryMiss(error)) return CATEGORY_GONE;
    throw error;
  }
  return {
    key: 'bot.admin.category_deleted',
    values: { name: before?.name ?? '—' },
    buttons: [
      {
        label: { kind: 'TEMPLATE', key: 'bot.admin.categories_back_button' },
        data: `${ADMIN_CATEGORIES_CALLBACK_PREFIX}0`,
      },
    ],
    orderId: null,
  };
}

/**
 * `/category_new <name>` — a new category at the END of the list.
 *
 * At the end because that is where an operator looks for the thing they just made, and
 * because putting it anywhere else would reorder what customers already see. It is
 * created ACTIVE and VISIBLE by the service, and an empty category is invisible to
 * customers whatever its flags say, so nothing reaches a customer until a product is
 * filed under it.
 *
 * The position is part of what the idempotency key hashes, and a redelivered update
 * computes it from a list that now includes the category it created — a payload
 * mismatch meaning "this already ran", answered with the list that shows it.
 */
async function adminCategoryNew(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  args: readonly string[],
  mayEdit: boolean,
  idempotencyKey: string,
): Promise<PendingReply> {
  const categories = requireCategories(rt);
  const name = args.join(' ').trim();
  if (name === '') return CATEGORY_USAGE;
  const list = await categories.list(scope, actor);
  const last = list.reduce((max, category) => Math.max(max, category.sortOrder), 0);
  let created;
  try {
    created = await categories.create(scope, actor, {
      idempotencyKey: `${idempotencyKey}:category-new`,
      draft: {
        name,
        description: null,
        emoji: null,
        sortOrder: Math.min(last + 10, CATEGORY_SORT_ORDER_MAX),
      },
    });
  } catch (error) {
    if (isNexaError(error) && error.code === PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH) {
      const now = await categories.list(scope, actor);
      return adminCategoryList(rt, now, Number.MAX_SAFE_INTEGER, mayEdit);
    }
    if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID) {
      return CATEGORY_USAGE;
    }
    // A redelivered create whose category has since been deleted: the service says
    // what it created is gone, which is the section's one answer for that.
    if (isCategoryMiss(error)) return CATEGORY_GONE;
    throw error;
  }
  return adminCategoryDetail(rt, scope, actor, created.id, mayEdit);
}

/**
 * `/category_rename <id> <name>` and `/category_emoji <id> <emoji or ->`.
 *
 * The service's edit replaces name, description and emoji together — the Web Admin's
 * form sends all three — so the current values are read first and only the one this
 * command names is changed. `-` clears the emoji, because absence is a valid state
 * and a command needs a way to say it.
 *
 * A malformed id, an empty name, a name too long for a button or a string that is not
 * an emoji all answer with the syntax: each is a fact about the message that was sent,
 * and the service is what decided it. An id that is well-formed and names nothing here
 * is `category_gone`, the section's one answer for that.
 */
async function adminCategoryEdit(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  field: 'name' | 'emoji',
  args: readonly string[],
  mayEdit: boolean,
  idempotencyKey: string,
): Promise<PendingReply> {
  const categories = requireCategories(rt);
  const [categoryId, ...rest] = args;
  const value = rest.join(' ').trim();
  if (categoryId === undefined || value === '') return CATEGORY_USAGE;
  const current = (await categories.list(scope, actor)).find(
    (candidate) => candidate.id === categoryId.toLowerCase(),
  );
  if (current === undefined) {
    return uuidV7Schema.safeParse(categoryId).success ? CATEGORY_GONE : CATEGORY_USAGE;
  }
  try {
    await categories.update(scope, actor, {
      idempotencyKey: `${idempotencyKey}:category-${field}`,
      categoryId: current.id,
      edit: {
        name: field === 'name' ? value : current.name,
        description: current.description,
        emoji: field === 'emoji' ? (value === '-' ? null : value) : current.emoji,
      },
    });
  } catch (error) {
    if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID) {
      return CATEGORY_USAGE;
    }
    if (isCategoryMiss(error)) return CATEGORY_GONE;
    throw error;
  }
  return adminCategoryDetail(rt, scope, actor, current.id, mayEdit);
}

/**
 * The products an operator can move, each labelled with the category it is in NOW.
 *
 * Every product of this tenant, whatever its status, by `ProductService.list` — the
 * same list the Web Admin's products screen pages — so an uncategorised product, the
 * one no customer can buy, is on it. Keyset-paged by `(created_at, id)`, which no
 * operator action changes, so the next page is stable.
 */
async function adminCategoryProducts(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  cursor: KeysetToken | null,
): Promise<PendingReply> {
  const [page, list] = await Promise.all([
    rt.deps.products.list(scope, actor, {
      limit: ADMIN_QUEUE_LIMIT,
      search: {},
      ...(cursor === null
        ? {}
        : { cursor: { createdAt: cursor.createdAt, id: cursor.id as ProductId } }),
    }),
    requireCategories(rt).list(scope, actor),
  ]);
  if (page.items.length === 0) {
    return { key: 'bot.admin.category_products_none', values: {}, buttons: [], orderId: null };
  }
  const names = new Map(list.map((category) => [category.id as string, category.name]));
  const buttons: CustomerButton[] = page.items.map((product) => ({
    label: {
      kind: 'TEXT' as const,
      text: `${product.title} — ${product.categoryId === null ? '—' : (names.get(product.categoryId) ?? '—')}`,
    },
    data: `${ADMIN_CATEGORY_PICK_CALLBACK_PREFIX}${product.id}.0`,
  }));
  const token = page.nextCursor === null ? null : encodeKeysetToken(page.nextCursor);
  if (token !== null) {
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.category_products_more_button' },
      data: `${ADMIN_CATEGORY_PRODUCTS_CALLBACK_PREFIX}${token}`,
    });
  }
  return { key: 'bot.admin.category_products', values: {}, buttons, orderId: null };
}

/**
 * Which category one product should move to: every category except its current one.
 *
 * Inactive and hidden categories are offered too. Filing a product under one is a real
 * operator choice — staging a category before showing it — and the customer-facing
 * rules decide separately whether anybody can buy it there.
 */
async function adminCategoryPick(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  productId: string,
  requested: number,
): Promise<PendingReply> {
  let product: ProductRecord;
  try {
    product = await rt.deps.products.get(scope, actor, productId);
  } catch (error) {
    if (isProductMiss(error)) return PRODUCT_GONE;
    throw error;
  }
  const list = await requireCategories(rt).list(scope, actor);
  const current = list.find((category) => category.id === product.categoryId);
  const choices = list.filter((category) => category.id !== product.categoryId);
  if (choices.length === 0) {
    return { key: 'bot.admin.category_pick_none', values: {}, buttons: [], orderId: null };
  }
  const lastPage = Math.floor((choices.length - 1) / ADMIN_CATEGORY_PAGE_SIZE);
  const page = Math.min(requested, lastPage);
  const start = page * ADMIN_CATEGORY_PAGE_SIZE;
  const buttons: CustomerButton[] = choices
    .slice(start, start + ADMIN_CATEGORY_PAGE_SIZE)
    .map((category) => ({
      label: { kind: 'TEXT' as const, text: adminCategoryLabel(category) },
      data: `${ADMIN_CATEGORY_ASSIGN_CALLBACK_PREFIX}${encodeIdPair(product.id, category.id)}`,
    }));
  if (page > 0) {
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.categories_previous_button' },
      data: `${ADMIN_CATEGORY_PICK_CALLBACK_PREFIX}${product.id}.${page - 1}`,
    });
  }
  if (page < lastPage) {
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.categories_next_button' },
      data: `${ADMIN_CATEGORY_PICK_CALLBACK_PREFIX}${product.id}.${page + 1}`,
    });
  }
  return {
    key: 'bot.admin.category_pick',
    values: { product: product.title, category: current?.name ?? '—' },
    buttons,
    orderId: null,
  };
}

/**
 * Moves one product into one category, through `ProductCategoryService.reassignProduct`,
 * which locks the destination first so the category it names still exists at commit.
 *
 * The names in the reply are read AFTER the move, so they are the ones that are true
 * now — a rename between the pick and the tap shows the new name, not the button's.
 */
async function adminCategoryAssign(
  rt: BotRuntime,
  scope: TenantContext,
  actor: ActorContext,
  productId: string,
  categoryId: string,
  idempotencyKey: string,
): Promise<PendingReply> {
  const categories = requireCategories(rt);
  try {
    await categories.reassignProduct(scope, actor, {
      idempotencyKey: `${idempotencyKey}:category-assign`,
      productId,
      categoryId,
    });
  } catch (error) {
    if (isProductMiss(error)) return PRODUCT_GONE;
    if (isCategoryMiss(error)) return CATEGORY_GONE;
    throw error;
  }
  const [product, list] = await Promise.all([
    rt.deps.products.get(scope, actor, productId),
    categories.list(scope, actor),
  ]);
  const category = list.find((candidate) => candidate.id === product.categoryId);
  return {
    key: 'bot.admin.category_moved',
    values: { product: product.title, category: category?.name ?? '—' },
    buttons: [
      {
        label: { kind: 'TEMPLATE', key: 'bot.admin.categories_back_button' },
        data: `${ADMIN_CATEGORIES_CALLBACK_PREFIX}0`,
      },
    ],
    orderId: null,
  };
}

/** The categories service, which `adminCategoryTurn` has already proven present. */
function requireCategories(rt: BotRuntime): NonNullable<BotRuntimeDeps['productCategories']> {
  const categories = rt.deps.productCategories;
  if (categories === undefined) throw new Error('The categories section is not configured.');
  return categories;
}
