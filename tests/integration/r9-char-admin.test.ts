import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_IDS } from './harness';
import { makePin, viewOf, type View } from './r9-char-support';
import {
  TG,
  bindNewAdmin,
  lastReply,
  paymentState,
  pendingWithReceipt,
  receiptFixture,
  rows,
  say,
  signalledTransfer,
  tap,
  type ReceiptFixture,
} from './receipt-review-fixture';

/**
 * Characterization of the administrator's Telegram surface (Round 9, Phase B), for the
 * handlers of `bot-runtime.ts` that no other test reaches through `BotRuntime.handle`:
 *
 *   - the receipts queue (`B:`)                       -> ADMIN_RECEIPTS
 *   - the administrator section (`F:`, `6:`, `7:`, `G:`)
 *                                                     -> ADMIN_SECTION, ADMIN_ADMIN,
 *                                                        ADMIN_ADMIN_STATUS, ADMIN_REVOKE
 *   - `/link` and `/role`                             -> ADMIN_LINK, ADMIN_ROLE
 *   - a panel's username policy (`3:`, `4:`, `5:`, `/panel_prefix`, `/panel_template`)
 *                                                     -> ADMIN_USERNAME, _TOGGLE, _STRATEGY,
 *                                                        _PREFIX, _TEMPLATE
 *   - the reminder chooser (`1:`)                     -> ADMIN_REMINDER_EDIT
 *   - the refund-request cancel (`qd:`)               -> ADMIN_REFUND_REQUEST_CANCEL
 *   - a category's activate button (`kb:a:`)          -> ADMIN_CATEGORY_ACTIVATE
 *
 * Each case pins what the code answers TODAY - intent, template key, rendered text, and the
 * buttons with their callback data in order - including refusals that read oddly. The split
 * must not change any of it. (Round 10 B2 changed one: a `/panel_prefix` or `/panel_template`
 * without its panel number or value answers the syntax, `bot.admin.panel_username_usage`,
 * where it had answered `bot.admin.panel_gone`.) The expected views are the table at the bottom of the file.
 */

const OWNER = TG.owner;
/** An administrator who holds `panels.view` and nothing that edits. */
const PANEL_VIEWER = '750881';
/** A well-formed panel id that names no panel of this tenant. */
const UNKNOWN_PANEL = '00000000-0000-4000-8000-00000000a0a0';
/** An administrator who holds `admins.view` only. */
const ADMINS_VIEWER = '750882';
/** An administrator who holds `admins.view` and `admins.edit`. */
const ADMINS_EDITOR = '750884';
/** The Telegram account `/link` binds. */
const LINKED = '750777';

const pin = makePin(expectedViews(), (actual, expected, label) =>
  expect(actual, label).toEqual(expected),
);

describe('the administrator surface of the Telegram bot, as it answers today', () => {
  let f: ReceiptFixture;

  beforeAll(async () => {
    f = await receiptFixture();
  }, 120_000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    await f.reset();
  });

  /** The turn's result and what Telegram last received, as one comparable view. */
  const viewed = async (
    turn: Promise<{ readonly intent: string; readonly replyKey: string | null }>,
  ): Promise<View> => viewOf(await turn, lastReply(f));
  const press = (data: string, from: string = OWNER) => viewed(tap(f, data, from));
  const send = (text: string, from: string = OWNER) => viewed(say(f, text, from));
  const unknownId = () => f.ctx.container.ids.uuid();
  const adminRow = async (adminId: string) =>
    (
      await f.ctx.container.database.db.execute(
        sql`SELECT status, telegram_user_id FROM admins WHERE id = ${adminId}`,
      )
    ).rows[0] as { status: string; telegram_user_id: string | null };

  // =========================================================================
  // The panel itself, and the receipts queue
  // =========================================================================

  it('opens the panel with one button per section the administrator may enter, in a fixed order', async () => {
    pin('panel.owner', await send('/admin'));
    await bindNewAdmin(f, 'panel-viewer', PANEL_VIEWER, ['panels.view']);
    pin('panel.panels_only', await send('/admin', PANEL_VIEWER));
  });

  it('answers the receipts queue: nothing waiting, a list of references, and a refusal without the permission', async () => {
    pin('receipts.empty', await press('B:'));
    await pendingWithReceipt(f, 'r9-queue');
    const listed = await press('B:');
    // The reference is random per payment; its position and the amount are the contract.
    expect(listed.buttons.flat()[0]?.[0]).toMatch(/^[A-Z0-9]{8} — 250,000 تومان$/);
    pin('receipts.list', {
      ...listed,
      buttons: listed.buttons.map((row) =>
        row.map(([label, data]) => [label.replace(/^[A-Z0-9]{8}/, '<ref>'), data] as const),
      ),
    });
    await bindNewAdmin(f, 'panel-viewer', PANEL_VIEWER, ['panels.view']);
    pin('receipts.denied', await press('B:', PANEL_VIEWER));
  });

  // =========================================================================
  // The administrator section
  // =========================================================================

  it('lists every administrator as «username — STATUS» buttons that open their detail', async () => {
    pin('section.owner_only', await press('F:'));
    await bindNewAdmin(f, 'rev-one', TG.reviewer, ['receipts.view']);
    pin('section.two_admins', await press('F:'));
  });

  it('shows one administrator: the controls offered depend on who is looking and who is looked at', async () => {
    const reviewer = await bindNewAdmin(f, 'rev-one', TG.reviewer, ['receipts.view']);
    pin('admin.detail_other', await press(`6:${reviewer}`));
    // Nothing to disable about yourself: the button is not drawn (the service refuses it too).
    pin('admin.detail_self', await press(`6:${f.ownerId}`));
    pin('admin.detail_unknown', await press(`6:${unknownId()}`));
    // Not a uuid at all: the boundary answers, the handler is never reached.
    pin('admin.detail_malformed', await press('6:not-a-uuid'));
    const viewer = await bindNewAdmin(f, 'admins-viewer', ADMINS_VIEWER, ['admins.view']);
    // A viewer sees the same facts and none of the controls.
    pin('admin.detail_viewer_sees_no_controls', await press(`6:${reviewer}`, ADMINS_VIEWER));
    expect(viewer).toBeDefined();
  });

  it('disables and re-enables an administrator, naming the status it now holds, and refuses the rest', async () => {
    const reviewer = await bindNewAdmin(f, 'rev-one', TG.reviewer, ['receipts.view']);
    pin('status.disable', await press(`7:d:${reviewer}`));
    expect((await adminRow(reviewer)).status).toBe('DISABLED');
    // A repeat reads as the state it found.
    pin('status.disable_again', await press(`7:d:${reviewer}`));
    pin('status.enable', await press(`7:a:${reviewer}`));
    expect((await adminRow(reviewer)).status).toBe('ACTIVE');
    // Self-modification, an unknown id and a missing permission all answer the one refusal.
    pin('status.self_refused', await press(`7:d:${f.ownerId}`));
    pin('status.unknown_refused', await press(`7:d:${unknownId()}`));
    await bindNewAdmin(f, 'admins-viewer', ADMINS_VIEWER, ['admins.view']);
    pin('status.no_permission_refused', await press(`7:d:${f.ownerId}`, ADMINS_VIEWER));
    // A code that is neither `a` nor `d` never becomes an intent.
    pin('status.bad_code', await press(`7:x:${reviewer}`));
  });

  it('revokes Telegram access from the button beside a row, leaving the administrator in place', async () => {
    const reviewer = await bindNewAdmin(f, 'rev-one', TG.reviewer, ['receipts.view']);
    pin('revoke.done', await press(`G:${reviewer}`));
    const after = await adminRow(reviewer);
    expect(after.telegram_user_id).toBeNull();
    expect(after.status).toBe('ACTIVE');
    pin('revoke.unknown_refused', await press(`G:${unknownId()}`));
    await bindNewAdmin(f, 'admins-viewer', ADMINS_VIEWER, ['admins.view']);
    pin('revoke.no_permission_refused', await press(`G:${f.ownerId}`, ADMINS_VIEWER));
    // The editor may do all three.
    const target = await bindNewAdmin(f, 'target', LINKED, ['receipts.view']);
    await bindNewAdmin(f, 'admins-editor', ADMINS_EDITOR, ['admins.view', 'admins.edit']);
    pin('detail.editor_sees_controls', await press(`6:${target}`, ADMINS_EDITOR));
    pin('revoke.editor', await press(`G:${target}`, ADMINS_EDITOR));
  });

  it('answers a customer who sends an administrator callback with the stale-button reply', async () => {
    pin('section.customer', await press('F:', TG.customer));
  });

  // =========================================================================
  // /link and /role
  // =========================================================================

  it('links an existing administrator to a Telegram account with /link, and says how when it is misused', async () => {
    const plain = await bindNewAdmin(f, 'plain-two', null, ['receipts.view']);
    pin('link.done', await send(`/link ${LINKED} plain-two`));
    expect((await adminRow(plain)).telegram_user_id).toBe(LINKED);
    pin('link.usage', await send(`/link ${LINKED}`));
    pin('link.unknown_username_refused', await send(`/link 750778 nobody-here`));
    await bindNewAdmin(f, 'admins-viewer', ADMINS_VIEWER, ['admins.view']);
    pin('link.no_permission_refused', await send(`/link 750779 plain-two`, ADMINS_VIEWER));
  });

  it('sets an administrator to one Nexa role preset with /role', async () => {
    const plain = await bindNewAdmin(f, 'plain-two', null, ['receipts.view']);
    pin('role.done', await send('/role plain-two support'));
    const roles = (
      await f.ctx.container.database.db.execute(
        sql`SELECT r.key FROM admin_roles ar JOIN roles r ON r.id = ar.role_id
             WHERE ar.admin_id = ${plain} ORDER BY r.key`,
      )
    ).rows.map((row) => (row as { key: string }).key);
    expect(roles).toEqual(['support']);
    pin('role.usage', await send('/role plain-two'));
    pin('role.unknown_role_refused', await send('/role plain-two nosuchrole'));
    await bindNewAdmin(f, 'admins-viewer', ADMINS_VIEWER, ['admins.view']);
    pin('role.no_permission_refused', await send('/role plain-two owner', ADMINS_VIEWER));
  });

  // =========================================================================
  // A panel's username policy
  // =========================================================================

  it('shows the policy with its current value, preview and, with panels.edit, the toggles and presets', async () => {
    pin('username.section', await press(`3:${f.panelA}`));
    pin('username.unknown_panel', await press(`3:${unknownId()}`));
    await bindNewAdmin(f, 'panel-viewer', PANEL_VIEWER, ['panels.view']);
    pin('username.viewer_has_no_buttons', await press(`3:${f.panelA}`, PANEL_VIEWER));
  });

  it('toggles the two customer choices to a target value and refuses turning both off', async () => {
    pin('toggle.custom_off', await press(`4:c:0:${f.panelA}`));
    pin('toggle.automatic_off_refused', await press(`4:a:0:${f.panelA}`));
    pin('toggle.custom_on', await press(`4:c:1:${f.panelA}`));
    // A double tap writes the same policy twice.
    pin('toggle.custom_on_again', await press(`4:c:1:${f.panelA}`));
  });

  it('selects an automatic preset by tap, filling the default prefix only for the prefix preset', async () => {
    pin('strategy.random', await press(`5:r:${f.panelA}`));
    pin('strategy.prefix_random', await press(`5:p:${f.panelA}`));
    pin('strategy.telegram_id', await press(`5:t:${f.panelA}`));
  });

  it('writes a prefix or a template by command, which also selects the preset', async () => {
    pin('prefix.set', await send(`/panel_prefix ${f.panelA} abc`));
    pin('prefix.missing_value', await send(`/panel_prefix ${f.panelA}`));
    pin('prefix.missing_panel', await send('/panel_prefix'));
    pin('template.missing_value', await send(`/panel_template ${f.panelA}`));
    pin('prefix.unknown_panel', await send(`/panel_prefix ${UNKNOWN_PANEL} abc`));
    pin('template.set', await send(`/panel_template ${f.panelA} bot_{random6}`));
    pin('template.invalid', await send(`/panel_template ${f.panelA} !!`));
    // After a template, tapping the prefix preset clears the template and restores `nx`.
    pin('template.then_prefix_preset', await press(`5:p:${f.panelA}`));
  });

  it('refuses every write to the policy from an administrator without panels.edit', async () => {
    await bindNewAdmin(f, 'panel-viewer', PANEL_VIEWER, ['panels.view']);
    pin('username.viewer_toggle_refused', await press(`4:c:0:${f.panelA}`, PANEL_VIEWER));
    pin('username.viewer_strategy_refused', await press(`5:r:${f.panelA}`, PANEL_VIEWER));
    pin(
      'username.viewer_prefix_refused',
      await send(`/panel_prefix ${f.panelA} zzz`, PANEL_VIEWER),
    );
    // The refusal changed nothing.
    const stored = (
      await f.ctx.container.database.db.execute(
        sql`SELECT username_strategy FROM panels WHERE id = ${f.panelA}`,
      )
    ).rows[0] as { username_strategy: string } | undefined;
    expect(stored?.username_strategy).toBe('PREFIX_RANDOM');
  });

  // =========================================================================
  // Reminders, refund-request cancel, category activate
  // =========================================================================

  it('offers the allowed values for each of the five reminder settings, with the current one printed', async () => {
    pin('reminders.section', await press('0:'));
    for (const code of ['ef', 'es', 'uf', 'us', 'un']) {
      pin(`reminders.edit_${code}`, await press(`1:${code}`));
    }
    pin('reminders.edit_unknown_code', await press('1:zz'));
    await bindNewAdmin(f, 'panel-viewer', PANEL_VIEWER, ['panels.view']);
    pin('reminders.edit_denied', await press('1:ef', PANEL_VIEWER));
  });

  it('answers a cancel for a refund-request decision that is not waiting as closed', async () => {
    pin('refund_cancel.unknown', await press(`qd:${unknownId()}`));
    pin('refund_cancel.malformed', await press('qd:nope'));
  });

  it('activates a category from its detail screen and redraws it with the opposite button', async () => {
    const category = f.ctx.container.ids.uuid();
    await f.ctx.container.database.db.execute(sql`
      INSERT INTO product_categories (id, tenant_id, name, status, visibility, sort_order)
      VALUES (${category}, ${SEED_IDS.tenantA}, 'x', 'INACTIVE', 'VISIBLE', 5)`);
    pin('category.inactive_detail', await press(`kb:v:${category}`));
    pin('category.activate', await press(`kb:a:${category}`));
    pin('category.activate_again', await press(`kb:a:${category}`));
    pin('category.activate_unknown', await press(`kb:a:${unknownId()}`));
    pin('category.deactivate', await press(`kb:d:${category}`));
  });

  // =========================================================================
  // The approve button's own receipt requirement (`adminApprove`)
  // =========================================================================

  it('approves from the review button only a transfer that carries a receipt, whatever the review read said', async () => {
    /*
     * `adminApprove` asks `confirmManualTransfer` for `requireReceipt: true`: the settling
     * transaction itself refuses a transfer with no stored receipt. The review read
     * already answers null for one, so the requirement is the second line, and this case
     * removes the first: the read is made to answer an item for a signalled transfer that
     * has no receipt filed. The approval must still move nothing.
     *
     * MUTATION: `requireReceipt: true` -> `false` in `adminApprove` confirms the payment
     * and answers `bot.admin.approved`, and this case fails.
     */
    const payment = await signalledTransfer(f, 'r9-no-receipt');
    const receipts = f.ctx.container.receipts;
    const reviewItem = vi.spyOn(receipts, 'reviewItem').mockImplementation(async () => {
      const [row] = await rows<{ customer_id: string }>(
        f,
        sql`SELECT customer_id FROM payments WHERE id = ${payment}`,
      );
      expect(row, 'the signalled transfer').toBeDefined();
      return {
        payment: { id: payment, state: 'PENDING', method: 'MANUAL_TRANSFER' },
        customer: null,
        receipts: [],
        caption: {},
      } as unknown as Awaited<ReturnType<typeof receipts.reviewItem>>;
    });
    try {
      const turn = await tap(f, `D:${payment}`, OWNER);
      expect(reviewItem).toHaveBeenCalled();
      expect(turn.intent).toBe('ADMIN_APPROVE');
      expect(turn.replyKey).not.toBe('bot.admin.approved');
      expect(await paymentState(f, payment)).toBe('PENDING');
    } finally {
      reviewItem.mockRestore();
    }
  });
});

function expectedViews(): Record<string, View> {
  return {
    'panel.owner': {
      intent: 'ADMIN_PANEL',
      key: 'bot.admin.panel',
      text: 'پنل مدیریت. بخش مورد نظر را انتخاب کنید:',
      buttons: [
        [['💵 رسید های تایید نشده', 'B:']],
        [['🧰 سرویس\u200cها', 'H:']],
        [['🛰 پنل\u200cها', 'R:']],
        [['یادآورهای سرویس', '0:']],
        [['👤 مشتری\u200cها', '8:']],
        [['🗂 دسته\u200cبندی\u200cها', 'ka:0']],
        [['👨\u200d🔧 بخش ادمین', 'F:']],
        [['📱 برنامه\u200cها و ویدیوی آموزشی', 'va:']],
      ],
    },
    'panel.panels_only': {
      intent: 'ADMIN_PANEL',
      key: 'bot.admin.panel',
      text: 'پنل مدیریت. بخش مورد نظر را انتخاب کنید:',
      buttons: [[['🛰 پنل\u200cها', 'R:']]],
    },
    'receipts.empty': {
      intent: 'ADMIN_RECEIPTS',
      key: 'bot.admin.receipts_none',
      text: 'در حال حاضر هیچ پرداختی در انتظار بررسی نیست.',
      buttons: [],
    },
    'receipts.list': {
      intent: 'ADMIN_RECEIPTS',
      key: 'bot.admin.receipts_list',
      text: 'پرداخت\u200cهای در انتظار بررسی:',
      buttons: [[['<ref> — 250,000 تومان', 'C:<id>']]],
    },
    'receipts.denied': {
      intent: 'ADMIN_RECEIPTS',
      key: 'bot.admin.refused',
      text: 'این درخواست انجام نشد. دسترسی یا اطلاعات وارد\u200cشده اجازهٔ این کار را نمی\u200cدهد.',
      buttons: [],
    },
    'section.owner_only': {
      intent: 'ADMIN_SECTION',
      key: 'bot.admin.section',
      text: 'فهرست ادمین\u200cهای این نصب (1 از 1). برای دیدن جزئیات و تغییر وضعیت، روی نام هرکدام بزنید.\n\nبرای دادن دسترسی تلگرام به یک ادمین موجود:\n/link <شناسهٔ عددی تلگرام> <نام کاربری ادمین>\n\nبرای تعیین نقش یک ادمین:\n/role <نام کاربری ادمین> <کلید نقش>',
      buttons: [[['owner-receipts — ACTIVE', '6:<id>']]],
    },
    'section.two_admins': {
      intent: 'ADMIN_SECTION',
      key: 'bot.admin.section',
      text: 'فهرست ادمین\u200cهای این نصب (2 از 2). برای دیدن جزئیات و تغییر وضعیت، روی نام هرکدام بزنید.\n\nبرای دادن دسترسی تلگرام به یک ادمین موجود:\n/link <شناسهٔ عددی تلگرام> <نام کاربری ادمین>\n\nبرای تعیین نقش یک ادمین:\n/role <نام کاربری ادمین> <کلید نقش>',
      buttons: [[['owner-receipts — ACTIVE', '6:<id>']], [['rev-one — ACTIVE', '6:<id>']]],
    },
    'admin.detail_other': {
      intent: 'ADMIN_ADMIN',
      key: 'bot.admin.admin_detail',
      text: 'نام کاربری: rev-one\nنام نمایشی: rev-one\nوضعیت: ACTIVE\nنقش\u200cها: custom_rev_one\nتلگرام: 750002',
      buttons: [
        [['غیرفعال کردن', '7:d:<id>']],
        [['قطع دسترسی تلگرام', 'G:<id>']],
        [['بازگشت به فهرست ادمین\u200cها', 'F:']],
      ],
    },
    'admin.detail_self': {
      intent: 'ADMIN_ADMIN',
      key: 'bot.admin.admin_detail',
      text: 'نام کاربری: owner-receipts\nنام نمایشی: owner-receipts\nوضعیت: ACTIVE\nنقش\u200cها: owner\nتلگرام: 750001',
      buttons: [[['بازگشت به فهرست ادمین\u200cها', 'F:']]],
    },
    'admin.detail_unknown': {
      intent: 'ADMIN_ADMIN',
      key: 'bot.admin.admin_gone',
      text: 'چنین ادمینی یافت نشد.',
      buttons: [],
    },
    'admin.detail_malformed': {
      intent: 'UNSUPPORTED',
      key: 'bot.callback.stale',
      text: 'ℹ️ این دکمه دیگر فعال نیست. برای ادامه، دکمهٔ زیر را بزنید.',
      buttons: [[['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'admin.detail_viewer_sees_no_controls': {
      intent: 'ADMIN_ADMIN',
      key: 'bot.admin.admin_detail',
      text: 'نام کاربری: rev-one\nنام نمایشی: rev-one\nوضعیت: ACTIVE\nنقش\u200cها: custom_rev_one\nتلگرام: 750002',
      buttons: [[['بازگشت به فهرست ادمین\u200cها', 'F:']]],
    },
    'status.disable': {
      intent: 'ADMIN_ADMIN_STATUS',
      key: 'bot.admin.admin_status_changed',
      text: 'وضعیت rev-one اکنون DISABLED است.',
      buttons: [
        [['فعال کردن', '7:a:<id>']],
        [['قطع دسترسی تلگرام', 'G:<id>']],
        [['بازگشت به فهرست ادمین\u200cها', 'F:']],
      ],
    },
    'status.disable_again': {
      intent: 'ADMIN_ADMIN_STATUS',
      key: 'bot.admin.admin_status_changed',
      text: 'وضعیت rev-one اکنون DISABLED است.',
      buttons: [
        [['فعال کردن', '7:a:<id>']],
        [['قطع دسترسی تلگرام', 'G:<id>']],
        [['بازگشت به فهرست ادمین\u200cها', 'F:']],
      ],
    },
    'status.enable': {
      intent: 'ADMIN_ADMIN_STATUS',
      key: 'bot.admin.admin_status_changed',
      text: 'وضعیت rev-one اکنون ACTIVE است.',
      buttons: [
        [['غیرفعال کردن', '7:d:<id>']],
        [['قطع دسترسی تلگرام', 'G:<id>']],
        [['بازگشت به فهرست ادمین\u200cها', 'F:']],
      ],
    },
    'status.self_refused': {
      intent: 'ADMIN_ADMIN_STATUS',
      key: 'bot.admin.refused',
      text: 'این درخواست انجام نشد. دسترسی یا اطلاعات وارد\u200cشده اجازهٔ این کار را نمی\u200cدهد.',
      buttons: [],
    },
    'status.unknown_refused': {
      intent: 'ADMIN_ADMIN_STATUS',
      key: 'bot.admin.refused',
      text: 'این درخواست انجام نشد. دسترسی یا اطلاعات وارد\u200cشده اجازهٔ این کار را نمی\u200cدهد.',
      buttons: [],
    },
    'status.no_permission_refused': {
      intent: 'ADMIN_ADMIN_STATUS',
      key: 'bot.admin.refused',
      text: 'این درخواست انجام نشد. دسترسی یا اطلاعات وارد\u200cشده اجازهٔ این کار را نمی\u200cدهد.',
      buttons: [],
    },
    'status.bad_code': {
      intent: 'UNSUPPORTED',
      key: 'bot.callback.stale',
      text: 'ℹ️ این دکمه دیگر فعال نیست. برای ادامه، دکمهٔ زیر را بزنید.',
      buttons: [[['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'revoke.done': {
      intent: 'ADMIN_REVOKE',
      key: 'bot.admin.revoked',
      text: 'دسترسی تلگرام rev-one حذف شد.',
      buttons: [],
    },
    'revoke.unknown_refused': {
      intent: 'ADMIN_REVOKE',
      key: 'bot.admin.refused',
      text: 'این درخواست انجام نشد. دسترسی یا اطلاعات وارد\u200cشده اجازهٔ این کار را نمی\u200cدهد.',
      buttons: [],
    },
    'revoke.no_permission_refused': {
      intent: 'ADMIN_REVOKE',
      key: 'bot.admin.refused',
      text: 'این درخواست انجام نشد. دسترسی یا اطلاعات وارد\u200cشده اجازهٔ این کار را نمی\u200cدهد.',
      buttons: [],
    },
    'detail.editor_sees_controls': {
      intent: 'ADMIN_ADMIN',
      key: 'bot.admin.admin_detail',
      text: 'نام کاربری: target\nنام نمایشی: target\nوضعیت: ACTIVE\nنقش\u200cها: custom_target\nتلگرام: 750777',
      buttons: [
        [['غیرفعال کردن', '7:d:<id>']],
        [['قطع دسترسی تلگرام', 'G:<id>']],
        [['بازگشت به فهرست ادمین\u200cها', 'F:']],
      ],
    },
    'revoke.editor': {
      intent: 'ADMIN_REVOKE',
      key: 'bot.admin.revoked',
      text: 'دسترسی تلگرام target حذف شد.',
      buttons: [],
    },
    'section.customer': {
      intent: 'ADMIN_SECTION',
      key: 'bot.callback.stale',
      text: 'ℹ️ این دکمه دیگر فعال نیست. برای ادامه، دکمهٔ زیر را بزنید.',
      buttons: [[['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'link.done': {
      intent: 'ADMIN_LINK',
      key: 'bot.admin.linked',
      text: 'دسترسی تلگرام برای plain-two ثبت شد.',
      buttons: [],
    },
    'link.usage': {
      intent: 'ADMIN_LINK',
      key: 'bot.admin.usage',
      text: 'دستور ناقص یا نامعتبر است.\n\n/link <شناسهٔ عددی تلگرام> <نام کاربری ادمین>\n/role <نام کاربری ادمین> <کلید نقش>',
      buttons: [],
    },
    'link.unknown_username_refused': {
      intent: 'ADMIN_LINK',
      key: 'bot.admin.refused',
      text: 'این درخواست انجام نشد. دسترسی یا اطلاعات وارد\u200cشده اجازهٔ این کار را نمی\u200cدهد.',
      buttons: [],
    },
    'link.no_permission_refused': {
      intent: 'ADMIN_LINK',
      key: 'bot.admin.refused',
      text: 'این درخواست انجام نشد. دسترسی یا اطلاعات وارد\u200cشده اجازهٔ این کار را نمی\u200cدهد.',
      buttons: [],
    },
    'role.done': {
      intent: 'ADMIN_ROLE',
      key: 'bot.admin.roles_set',
      text: 'نقش\u200cهای plain-two به support تغییر یافت.',
      buttons: [],
    },
    'role.usage': {
      intent: 'ADMIN_ROLE',
      key: 'bot.admin.usage',
      text: 'دستور ناقص یا نامعتبر است.\n\n/link <شناسهٔ عددی تلگرام> <نام کاربری ادمین>\n/role <نام کاربری ادمین> <کلید نقش>',
      buttons: [],
    },
    'role.unknown_role_refused': {
      intent: 'ADMIN_ROLE',
      key: 'bot.admin.refused',
      text: 'این درخواست انجام نشد. دسترسی یا اطلاعات وارد\u200cشده اجازهٔ این کار را نمی\u200cدهد.',
      buttons: [],
    },
    'role.no_permission_refused': {
      intent: 'ADMIN_ROLE',
      key: 'bot.admin.refused',
      text: 'این درخواست انجام نشد. دسترسی یا اطلاعات وارد\u200cشده اجازهٔ این کار را نمی\u200cدهد.',
      buttons: [],
    },
    'username.section': {
      intent: 'ADMIN_USERNAME',
      key: 'bot.admin.username_section',
      text: 'یوزرنیم سرویس\u200cهای پنل <b>A</b>\n\nانتخاب دلخواه توسط مشتری: ✓\nانتخاب خودکار: ✓\nروش خودکار:\n— تصادفی ۱۲ نویسه\u200cای\n✓ پیشوند + تصادفی\n— شناسهٔ تلگرام + تصادفی\n— الگوی دلخواه\nپیشوند: <code>nx</code>\nالگو: <code>—</code>\nنمونهٔ خروجی: <code>nxa3f91c4fa2</code>\n\nهر یوزرنیم جدید بین ۴ تا ۲۰ نویسه و فقط از حروف کوچک انگلیسی، رقم، خط تیره و زیرخط ساخته می\u200cشود.\nبرای تغییر پیشوند: <code>/panel_prefix &lt;شمارهٔ پنل&gt; &lt;پیشوند&gt;</code>\nبرای تغییر الگو: <code>/panel_template &lt;شمارهٔ پنل&gt; &lt;الگو&gt;</code>',
      buttons: [
        [['انتخاب دلخواه', '4:c:0:<id>']],
        [['انتخاب خودکار', '4:a:0:<id>']],
        [['تصادفی ۱۲ نویسه\u200cای', '5:r:<id>']],
        [['پیشوند + تصادفی', '5:p:<id>']],
        [['شناسهٔ تلگرام + تصادفی', '5:t:<id>']],
      ],
    },
    'username.unknown_panel': {
      intent: 'ADMIN_USERNAME',
      key: 'bot.admin.panel_gone',
      text: 'این پنل پیدا نشد.',
      buttons: [],
    },
    'username.viewer_has_no_buttons': {
      intent: 'ADMIN_USERNAME',
      key: 'bot.admin.username_section',
      text: 'یوزرنیم سرویس\u200cهای پنل <b>A</b>\n\nانتخاب دلخواه توسط مشتری: ✓\nانتخاب خودکار: ✓\nروش خودکار:\n— تصادفی ۱۲ نویسه\u200cای\n✓ پیشوند + تصادفی\n— شناسهٔ تلگرام + تصادفی\n— الگوی دلخواه\nپیشوند: <code>nx</code>\nالگو: <code>—</code>\nنمونهٔ خروجی: <code>nxa3f91c4fa2</code>\n\nهر یوزرنیم جدید بین ۴ تا ۲۰ نویسه و فقط از حروف کوچک انگلیسی، رقم، خط تیره و زیرخط ساخته می\u200cشود.\nبرای تغییر پیشوند: <code>/panel_prefix &lt;شمارهٔ پنل&gt; &lt;پیشوند&gt;</code>\nبرای تغییر الگو: <code>/panel_template &lt;شمارهٔ پنل&gt; &lt;الگو&gt;</code>',
      buttons: [],
    },
    'toggle.custom_off': {
      intent: 'ADMIN_USERNAME_TOGGLE',
      key: 'bot.admin.username_section',
      text: 'یوزرنیم سرویس\u200cهای پنل <b>A</b>\n\nانتخاب دلخواه توسط مشتری: —\nانتخاب خودکار: ✓\nروش خودکار:\n— تصادفی ۱۲ نویسه\u200cای\n✓ پیشوند + تصادفی\n— شناسهٔ تلگرام + تصادفی\n— الگوی دلخواه\nپیشوند: <code>nx</code>\nالگو: <code>—</code>\nنمونهٔ خروجی: <code>nxa3f91c4fa2</code>\n\nهر یوزرنیم جدید بین ۴ تا ۲۰ نویسه و فقط از حروف کوچک انگلیسی، رقم، خط تیره و زیرخط ساخته می\u200cشود.\nبرای تغییر پیشوند: <code>/panel_prefix &lt;شمارهٔ پنل&gt; &lt;پیشوند&gt;</code>\nبرای تغییر الگو: <code>/panel_template &lt;شمارهٔ پنل&gt; &lt;الگو&gt;</code>',
      buttons: [
        [['انتخاب دلخواه', '4:c:1:<id>']],
        [['انتخاب خودکار', '4:a:0:<id>']],
        [['تصادفی ۱۲ نویسه\u200cای', '5:r:<id>']],
        [['پیشوند + تصادفی', '5:p:<id>']],
        [['شناسهٔ تلگرام + تصادفی', '5:t:<id>']],
      ],
    },
    'toggle.automatic_off_refused': {
      intent: 'ADMIN_USERNAME_TOGGLE',
      key: 'bot.admin.username_refused',
      text: 'ذخیره نشد: حداقل یکی از دو روش انتخاب یوزرنیم باید فعال باشد.',
      buttons: [],
    },
    'toggle.custom_on': {
      intent: 'ADMIN_USERNAME_TOGGLE',
      key: 'bot.admin.username_section',
      text: 'یوزرنیم سرویس\u200cهای پنل <b>A</b>\n\nانتخاب دلخواه توسط مشتری: ✓\nانتخاب خودکار: ✓\nروش خودکار:\n— تصادفی ۱۲ نویسه\u200cای\n✓ پیشوند + تصادفی\n— شناسهٔ تلگرام + تصادفی\n— الگوی دلخواه\nپیشوند: <code>nx</code>\nالگو: <code>—</code>\nنمونهٔ خروجی: <code>nxa3f91c4fa2</code>\n\nهر یوزرنیم جدید بین ۴ تا ۲۰ نویسه و فقط از حروف کوچک انگلیسی، رقم، خط تیره و زیرخط ساخته می\u200cشود.\nبرای تغییر پیشوند: <code>/panel_prefix &lt;شمارهٔ پنل&gt; &lt;پیشوند&gt;</code>\nبرای تغییر الگو: <code>/panel_template &lt;شمارهٔ پنل&gt; &lt;الگو&gt;</code>',
      buttons: [
        [['انتخاب دلخواه', '4:c:0:<id>']],
        [['انتخاب خودکار', '4:a:0:<id>']],
        [['تصادفی ۱۲ نویسه\u200cای', '5:r:<id>']],
        [['پیشوند + تصادفی', '5:p:<id>']],
        [['شناسهٔ تلگرام + تصادفی', '5:t:<id>']],
      ],
    },
    'toggle.custom_on_again': {
      intent: 'ADMIN_USERNAME_TOGGLE',
      key: 'bot.admin.username_section',
      text: 'یوزرنیم سرویس\u200cهای پنل <b>A</b>\n\nانتخاب دلخواه توسط مشتری: ✓\nانتخاب خودکار: ✓\nروش خودکار:\n— تصادفی ۱۲ نویسه\u200cای\n✓ پیشوند + تصادفی\n— شناسهٔ تلگرام + تصادفی\n— الگوی دلخواه\nپیشوند: <code>nx</code>\nالگو: <code>—</code>\nنمونهٔ خروجی: <code>nxa3f91c4fa2</code>\n\nهر یوزرنیم جدید بین ۴ تا ۲۰ نویسه و فقط از حروف کوچک انگلیسی، رقم، خط تیره و زیرخط ساخته می\u200cشود.\nبرای تغییر پیشوند: <code>/panel_prefix &lt;شمارهٔ پنل&gt; &lt;پیشوند&gt;</code>\nبرای تغییر الگو: <code>/panel_template &lt;شمارهٔ پنل&gt; &lt;الگو&gt;</code>',
      buttons: [
        [['انتخاب دلخواه', '4:c:0:<id>']],
        [['انتخاب خودکار', '4:a:0:<id>']],
        [['تصادفی ۱۲ نویسه\u200cای', '5:r:<id>']],
        [['پیشوند + تصادفی', '5:p:<id>']],
        [['شناسهٔ تلگرام + تصادفی', '5:t:<id>']],
      ],
    },
    'strategy.random': {
      intent: 'ADMIN_USERNAME_STRATEGY',
      key: 'bot.admin.username_section',
      text: 'یوزرنیم سرویس\u200cهای پنل <b>A</b>\n\nانتخاب دلخواه توسط مشتری: ✓\nانتخاب خودکار: ✓\nروش خودکار:\n✓ تصادفی ۱۲ نویسه\u200cای\n— پیشوند + تصادفی\n— شناسهٔ تلگرام + تصادفی\n— الگوی دلخواه\nپیشوند: <code>—</code>\nالگو: <code>—</code>\nنمونهٔ خروجی: <code>a3f91c4fa2bc</code>\n\nهر یوزرنیم جدید بین ۴ تا ۲۰ نویسه و فقط از حروف کوچک انگلیسی، رقم، خط تیره و زیرخط ساخته می\u200cشود.\nبرای تغییر پیشوند: <code>/panel_prefix &lt;شمارهٔ پنل&gt; &lt;پیشوند&gt;</code>\nبرای تغییر الگو: <code>/panel_template &lt;شمارهٔ پنل&gt; &lt;الگو&gt;</code>',
      buttons: [
        [['انتخاب دلخواه', '4:c:0:<id>']],
        [['انتخاب خودکار', '4:a:0:<id>']],
        [['تصادفی ۱۲ نویسه\u200cای', '5:r:<id>']],
        [['پیشوند + تصادفی', '5:p:<id>']],
        [['شناسهٔ تلگرام + تصادفی', '5:t:<id>']],
      ],
    },
    'strategy.prefix_random': {
      intent: 'ADMIN_USERNAME_STRATEGY',
      key: 'bot.admin.username_section',
      text: 'یوزرنیم سرویس\u200cهای پنل <b>A</b>\n\nانتخاب دلخواه توسط مشتری: ✓\nانتخاب خودکار: ✓\nروش خودکار:\n— تصادفی ۱۲ نویسه\u200cای\n✓ پیشوند + تصادفی\n— شناسهٔ تلگرام + تصادفی\n— الگوی دلخواه\nپیشوند: <code>nx</code>\nالگو: <code>—</code>\nنمونهٔ خروجی: <code>nxa3f91c4fa2</code>\n\nهر یوزرنیم جدید بین ۴ تا ۲۰ نویسه و فقط از حروف کوچک انگلیسی، رقم، خط تیره و زیرخط ساخته می\u200cشود.\nبرای تغییر پیشوند: <code>/panel_prefix &lt;شمارهٔ پنل&gt; &lt;پیشوند&gt;</code>\nبرای تغییر الگو: <code>/panel_template &lt;شمارهٔ پنل&gt; &lt;الگو&gt;</code>',
      buttons: [
        [['انتخاب دلخواه', '4:c:0:<id>']],
        [['انتخاب خودکار', '4:a:0:<id>']],
        [['تصادفی ۱۲ نویسه\u200cای', '5:r:<id>']],
        [['پیشوند + تصادفی', '5:p:<id>']],
        [['شناسهٔ تلگرام + تصادفی', '5:t:<id>']],
      ],
    },
    'strategy.telegram_id': {
      intent: 'ADMIN_USERNAME_STRATEGY',
      key: 'bot.admin.username_section',
      text: 'یوزرنیم سرویس\u200cهای پنل <b>A</b>\n\nانتخاب دلخواه توسط مشتری: ✓\nانتخاب خودکار: ✓\nروش خودکار:\n— تصادفی ۱۲ نویسه\u200cای\n— پیشوند + تصادفی\n✓ شناسهٔ تلگرام + تصادفی\n— الگوی دلخواه\nپیشوند: <code>—</code>\nالگو: <code>—</code>\nنمونهٔ خروجی: <code>5973087728_a3f91c</code>\n\nهر یوزرنیم جدید بین ۴ تا ۲۰ نویسه و فقط از حروف کوچک انگلیسی، رقم، خط تیره و زیرخط ساخته می\u200cشود.\nبرای تغییر پیشوند: <code>/panel_prefix &lt;شمارهٔ پنل&gt; &lt;پیشوند&gt;</code>\nبرای تغییر الگو: <code>/panel_template &lt;شمارهٔ پنل&gt; &lt;الگو&gt;</code>',
      buttons: [
        [['انتخاب دلخواه', '4:c:0:<id>']],
        [['انتخاب خودکار', '4:a:0:<id>']],
        [['تصادفی ۱۲ نویسه\u200cای', '5:r:<id>']],
        [['پیشوند + تصادفی', '5:p:<id>']],
        [['شناسهٔ تلگرام + تصادفی', '5:t:<id>']],
      ],
    },
    'prefix.set': {
      intent: 'ADMIN_USERNAME_PREFIX',
      key: 'bot.admin.username_section',
      text: 'یوزرنیم سرویس\u200cهای پنل <b>A</b>\n\nانتخاب دلخواه توسط مشتری: ✓\nانتخاب خودکار: ✓\nروش خودکار:\n— تصادفی ۱۲ نویسه\u200cای\n✓ پیشوند + تصادفی\n— شناسهٔ تلگرام + تصادفی\n— الگوی دلخواه\nپیشوند: <code>abc</code>\nالگو: <code>—</code>\nنمونهٔ خروجی: <code>abca3f91c4fa2</code>\n\nهر یوزرنیم جدید بین ۴ تا ۲۰ نویسه و فقط از حروف کوچک انگلیسی، رقم، خط تیره و زیرخط ساخته می\u200cشود.\nبرای تغییر پیشوند: <code>/panel_prefix &lt;شمارهٔ پنل&gt; &lt;پیشوند&gt;</code>\nبرای تغییر الگو: <code>/panel_template &lt;شمارهٔ پنل&gt; &lt;الگو&gt;</code>',
      buttons: [
        [['انتخاب دلخواه', '4:c:0:<id>']],
        [['انتخاب خودکار', '4:a:0:<id>']],
        [['تصادفی ۱۲ نویسه\u200cای', '5:r:<id>']],
        [['پیشوند + تصادفی', '5:p:<id>']],
        [['شناسهٔ تلگرام + تصادفی', '5:t:<id>']],
      ],
    },
    'prefix.missing_value': {
      intent: 'ADMIN_USERNAME_PREFIX',
      key: 'bot.admin.panel_username_usage',
      text: 'دستور ناقص یا نامعتبر است.\n\n/panel_prefix <شمارهٔ پنل> <پیشوند>\n/panel_template <شمارهٔ پنل> <الگو>',
      buttons: [],
    },
    'prefix.missing_panel': {
      intent: 'ADMIN_USERNAME_PREFIX',
      key: 'bot.admin.panel_username_usage',
      text: 'دستور ناقص یا نامعتبر است.\n\n/panel_prefix <شمارهٔ پنل> <پیشوند>\n/panel_template <شمارهٔ پنل> <الگو>',
      buttons: [],
    },
    'template.missing_value': {
      intent: 'ADMIN_USERNAME_TEMPLATE',
      key: 'bot.admin.panel_username_usage',
      text: 'دستور ناقص یا نامعتبر است.\n\n/panel_prefix <شمارهٔ پنل> <پیشوند>\n/panel_template <شمارهٔ پنل> <الگو>',
      buttons: [],
    },
    'prefix.unknown_panel': {
      intent: 'ADMIN_USERNAME_PREFIX',
      key: 'bot.admin.panel_gone',
      text: 'این پنل پیدا نشد.',
      buttons: [],
    },
    'template.set': {
      intent: 'ADMIN_USERNAME_TEMPLATE',
      key: 'bot.admin.username_section',
      text: 'یوزرنیم سرویس\u200cهای پنل <b>A</b>\n\nانتخاب دلخواه توسط مشتری: ✓\nانتخاب خودکار: ✓\nروش خودکار:\n— تصادفی ۱۲ نویسه\u200cای\n— پیشوند + تصادفی\n— شناسهٔ تلگرام + تصادفی\n✓ الگوی دلخواه\nپیشوند: <code>—</code>\nالگو: <code>bot_{random6}</code>\nنمونهٔ خروجی: <code>bot_a3f91c</code>\n\nهر یوزرنیم جدید بین ۴ تا ۲۰ نویسه و فقط از حروف کوچک انگلیسی، رقم، خط تیره و زیرخط ساخته می\u200cشود.\nبرای تغییر پیشوند: <code>/panel_prefix &lt;شمارهٔ پنل&gt; &lt;پیشوند&gt;</code>\nبرای تغییر الگو: <code>/panel_template &lt;شمارهٔ پنل&gt; &lt;الگو&gt;</code>',
      buttons: [
        [['انتخاب دلخواه', '4:c:0:<id>']],
        [['انتخاب خودکار', '4:a:0:<id>']],
        [['تصادفی ۱۲ نویسه\u200cای', '5:r:<id>']],
        [['پیشوند + تصادفی', '5:p:<id>']],
        [['شناسهٔ تلگرام + تصادفی', '5:t:<id>']],
      ],
    },
    'template.invalid': {
      intent: 'ADMIN_USERNAME_TEMPLATE',
      key: 'bot.admin.username_refused',
      text: 'ذخیره نشد: الگو باید فقط از نگهدارنده\u200cهای مجاز و حروف کوچک انگلیسی، رقم، خط تیره و زیرخط ساخته شود، دست\u200cکم یک نگهدارندهٔ یکتاکننده داشته باشد و خروجی آن همیشه بین 4 تا 20 نویسه بماند.',
      buttons: [],
    },
    'template.then_prefix_preset': {
      intent: 'ADMIN_USERNAME_STRATEGY',
      key: 'bot.admin.username_section',
      text: 'یوزرنیم سرویس\u200cهای پنل <b>A</b>\n\nانتخاب دلخواه توسط مشتری: ✓\nانتخاب خودکار: ✓\nروش خودکار:\n— تصادفی ۱۲ نویسه\u200cای\n✓ پیشوند + تصادفی\n— شناسهٔ تلگرام + تصادفی\n— الگوی دلخواه\nپیشوند: <code>nx</code>\nالگو: <code>—</code>\nنمونهٔ خروجی: <code>nxa3f91c4fa2</code>\n\nهر یوزرنیم جدید بین ۴ تا ۲۰ نویسه و فقط از حروف کوچک انگلیسی، رقم، خط تیره و زیرخط ساخته می\u200cشود.\nبرای تغییر پیشوند: <code>/panel_prefix &lt;شمارهٔ پنل&gt; &lt;پیشوند&gt;</code>\nبرای تغییر الگو: <code>/panel_template &lt;شمارهٔ پنل&gt; &lt;الگو&gt;</code>',
      buttons: [
        [['انتخاب دلخواه', '4:c:0:<id>']],
        [['انتخاب خودکار', '4:a:0:<id>']],
        [['تصادفی ۱۲ نویسه\u200cای', '5:r:<id>']],
        [['پیشوند + تصادفی', '5:p:<id>']],
        [['شناسهٔ تلگرام + تصادفی', '5:t:<id>']],
      ],
    },
    'username.viewer_toggle_refused': {
      intent: 'ADMIN_USERNAME_TOGGLE',
      key: 'bot.admin.refused',
      text: 'این درخواست انجام نشد. دسترسی یا اطلاعات وارد\u200cشده اجازهٔ این کار را نمی\u200cدهد.',
      buttons: [],
    },
    'username.viewer_strategy_refused': {
      intent: 'ADMIN_USERNAME_STRATEGY',
      key: 'bot.admin.refused',
      text: 'این درخواست انجام نشد. دسترسی یا اطلاعات وارد\u200cشده اجازهٔ این کار را نمی\u200cدهد.',
      buttons: [],
    },
    'username.viewer_prefix_refused': {
      intent: 'ADMIN_USERNAME_PREFIX',
      key: 'bot.admin.refused',
      text: 'این درخواست انجام نشد. دسترسی یا اطلاعات وارد\u200cشده اجازهٔ این کار را نمی\u200cدهد.',
      buttons: [],
    },
    'reminders.section': {
      intent: 'ADMIN_REMINDERS',
      key: 'bot.admin.reminders_section',
      text: 'تنظیمات یادآور سرویس\u200cها\n\nیادآور پیش از انقضا: ✅\n  • یادآور اول: 3 روز پیش از پایان\n  • یادآور دوم: 1 روز پیش از پایان\nاعلام پایان اعتبار: ✅\n\nیادآور مصرف حجم: ✅\n  • آستانه اول: 80٪\n  • آستانه دوم: 90٪\n  • آستانه پایانی: 95٪\n\nبرای تغییر هر مقدار، دکمهٔ آن را بزنید. روشن و خاموش کردن خودِ یادآورها از پنل وب انجام می\u200cشود، چون دامنهٔ اثر آن کل مشتریان است و به تأیید نوشتاری و ثبت دلیل نیاز دارد.',
      buttons: [
        [['یادآور اول انقضا', '1:ef']],
        [['یادآور دوم انقضا', '1:es']],
        [['آستانه اول مصرف', '1:uf']],
        [['آستانه دوم مصرف', '1:us']],
        [['آستانه پایانی مصرف', '1:un']],
      ],
    },
    'reminders.edit_ef': {
      intent: 'ADMIN_REMINDER_EDIT',
      key: 'bot.admin.reminder_choose',
      text: 'تنظیم: <code>reminders.expiry_first_days</code>\nمقدار فعلی: 3\n\nمقدار تازه را انتخاب کنید.',
      buttons: [
        [['1', '2:ef:1']],
        [['2', '2:ef:2']],
        [['3', '2:ef:3']],
        [['5', '2:ef:5']],
        [['7', '2:ef:7']],
        [['10', '2:ef:10']],
        [['14', '2:ef:14']],
        [['30', '2:ef:30']],
      ],
    },
    'reminders.edit_es': {
      intent: 'ADMIN_REMINDER_EDIT',
      key: 'bot.admin.reminder_choose',
      text: 'تنظیم: <code>reminders.expiry_second_days</code>\nمقدار فعلی: 1\n\nمقدار تازه را انتخاب کنید.',
      buttons: [
        [['1', '2:es:1']],
        [['2', '2:es:2']],
        [['3', '2:es:3']],
        [['5', '2:es:5']],
        [['7', '2:es:7']],
        [['10', '2:es:10']],
        [['14', '2:es:14']],
        [['30', '2:es:30']],
      ],
    },
    'reminders.edit_uf': {
      intent: 'ADMIN_REMINDER_EDIT',
      key: 'bot.admin.reminder_choose',
      text: 'تنظیم: <code>reminders.usage_first_percent</code>\nمقدار فعلی: 80\n\nمقدار تازه را انتخاب کنید.',
      buttons: [
        [['50', '2:uf:50']],
        [['60', '2:uf:60']],
        [['70', '2:uf:70']],
        [['75', '2:uf:75']],
        [['80', '2:uf:80']],
        [['85', '2:uf:85']],
        [['90', '2:uf:90']],
        [['95', '2:uf:95']],
        [['100', '2:uf:100']],
      ],
    },
    'reminders.edit_us': {
      intent: 'ADMIN_REMINDER_EDIT',
      key: 'bot.admin.reminder_choose',
      text: 'تنظیم: <code>reminders.usage_second_percent</code>\nمقدار فعلی: 90\n\nمقدار تازه را انتخاب کنید.',
      buttons: [
        [['50', '2:us:50']],
        [['60', '2:us:60']],
        [['70', '2:us:70']],
        [['75', '2:us:75']],
        [['80', '2:us:80']],
        [['85', '2:us:85']],
        [['90', '2:us:90']],
        [['95', '2:us:95']],
        [['100', '2:us:100']],
      ],
    },
    'reminders.edit_un': {
      intent: 'ADMIN_REMINDER_EDIT',
      key: 'bot.admin.reminder_choose',
      text: 'تنظیم: <code>reminders.usage_final_percent</code>\nمقدار فعلی: 95\n\nمقدار تازه را انتخاب کنید.',
      buttons: [
        [['50', '2:un:50']],
        [['60', '2:un:60']],
        [['70', '2:un:70']],
        [['75', '2:un:75']],
        [['80', '2:un:80']],
        [['85', '2:un:85']],
        [['90', '2:un:90']],
        [['95', '2:un:95']],
        [['100', '2:un:100']],
      ],
    },
    'reminders.edit_unknown_code': {
      intent: 'UNSUPPORTED',
      key: 'bot.callback.stale',
      text: 'ℹ️ این دکمه دیگر فعال نیست. برای ادامه، دکمهٔ زیر را بزنید.',
      buttons: [[['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'reminders.edit_denied': {
      intent: 'ADMIN_REMINDER_EDIT',
      key: 'bot.admin.refused',
      text: 'این درخواست انجام نشد. دسترسی یا اطلاعات وارد\u200cشده اجازهٔ این کار را نمی\u200cدهد.',
      buttons: [],
    },
    'refund_cancel.unknown': {
      intent: 'ADMIN_REFUND_REQUEST_CANCEL',
      key: 'bot.admin.refund_request_closed',
      text: 'این درخواست دیگر در انتظار بررسی نیست و تصمیم آن قبلاً ثبت شده است. چیزی تغییر نکرد.',
      buttons: [],
    },
    'refund_cancel.malformed': {
      intent: 'UNSUPPORTED',
      key: 'bot.callback.stale',
      text: 'ℹ️ این دکمه دیگر فعال نیست. برای ادامه، دکمهٔ زیر را بزنید.',
      buttons: [[['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'category.inactive_detail': {
      intent: 'ADMIN_CATEGORY',
      key: 'bot.admin.category_detail',
      text: 'دسته: — x\nوضعیت: INACTIVE\nنمایش: VISIBLE\nتعداد محصولات: 0\nشناسه: <id>\n\nبرای تغییر نام یا ایموجی:\n/category_rename <شناسهٔ دسته> <نام تازه>\n/category_emoji <شناسهٔ دسته> <ایموجی یا ->',
      buttons: [
        [['✅ فعال کردن', 'kb:a:<id>']],
        [['🙈 پنهان کردن', 'kb:h:<id>']],
        [['⬆️ بالاتر', 'kb:u:<id>']],
        [['🗑 حذف دسته', 'kb:x:<id>']],
        [['بازگشت به دسته\u200cبندی\u200cها', 'ka:0']],
      ],
    },
    'category.activate': {
      intent: 'ADMIN_CATEGORY_ACTIVATE',
      key: 'bot.admin.category_detail',
      text: 'دسته: — x\nوضعیت: ACTIVE\nنمایش: VISIBLE\nتعداد محصولات: 0\nشناسه: <id>\n\nبرای تغییر نام یا ایموجی:\n/category_rename <شناسهٔ دسته> <نام تازه>\n/category_emoji <شناسهٔ دسته> <ایموجی یا ->',
      buttons: [
        [['⏸ غیرفعال کردن', 'kb:d:<id>']],
        [['🙈 پنهان کردن', 'kb:h:<id>']],
        [['⬆️ بالاتر', 'kb:u:<id>']],
        [['🗑 حذف دسته', 'kb:x:<id>']],
        [['بازگشت به دسته\u200cبندی\u200cها', 'ka:0']],
      ],
    },
    'category.activate_again': {
      intent: 'ADMIN_CATEGORY_ACTIVATE',
      key: 'bot.admin.category_detail',
      text: 'دسته: — x\nوضعیت: ACTIVE\nنمایش: VISIBLE\nتعداد محصولات: 0\nشناسه: <id>\n\nبرای تغییر نام یا ایموجی:\n/category_rename <شناسهٔ دسته> <نام تازه>\n/category_emoji <شناسهٔ دسته> <ایموجی یا ->',
      buttons: [
        [['⏸ غیرفعال کردن', 'kb:d:<id>']],
        [['🙈 پنهان کردن', 'kb:h:<id>']],
        [['⬆️ بالاتر', 'kb:u:<id>']],
        [['🗑 حذف دسته', 'kb:x:<id>']],
        [['بازگشت به دسته\u200cبندی\u200cها', 'ka:0']],
      ],
    },
    'category.activate_unknown': {
      intent: 'ADMIN_CATEGORY_ACTIVATE',
      key: 'bot.admin.category_gone',
      text: 'چنین دسته\u200cای یافت نشد.',
      buttons: [],
    },
    'category.deactivate': {
      intent: 'ADMIN_CATEGORY_DEACTIVATE',
      key: 'bot.admin.category_detail',
      text: 'دسته: — x\nوضعیت: INACTIVE\nنمایش: VISIBLE\nتعداد محصولات: 0\nشناسه: <id>\n\nبرای تغییر نام یا ایموجی:\n/category_rename <شناسهٔ دسته> <نام تازه>\n/category_emoji <شناسهٔ دسته> <ایموجی یا ->',
      buttons: [
        [['✅ فعال کردن', 'kb:a:<id>']],
        [['🙈 پنهان کردن', 'kb:h:<id>']],
        [['⬆️ بالاتر', 'kb:u:<id>']],
        [['🗑 حذف دسته', 'kb:x:<id>']],
        [['بازگشت به دسته\u200cبندی\u200cها', 'ka:0']],
      ],
    },
  };
}
