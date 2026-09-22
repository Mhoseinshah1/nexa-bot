import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isNexaError,
  money,
  type ActorContext,
  type AdminId,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type PaymentId,
  type PermissionKey,
  type ProductId,
  type UserId,
  type ProductCategoryId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { ProductDraft } from '../../apps/api/src/modules/commerce/catalog/application/ports';
import type { InboundReceiptFile } from '../../apps/api/src/modules/commerce/payments/application/receipt-ports';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  tenantA,
  tenantB,
  type TestContext,
  SEED_IDS,
} from './harness';

/**
 * The Telegram management panel's authority (Phase 5T).
 *
 * Every case here is about ONE claim: a Telegram account holds no permissions of its
 * own. It holds a binding to an administrator, and what that administrator may do is
 * resolved by the same `AdminPermissionResolver` the Web Admin uses — so there is no
 * second role model to disagree with the first.
 *
 * That is the correction Mirza's own panel needs rather than a reproduction of it. Its
 * admin row is `(numeric telegram id, role)` and nothing else, its Telegram vocabulary
 * holds four role names against the web panel's seven for one column, and whether any of
 * it is enforced is `UNK-ADM-001` — NOT_TESTED, because the investigation could not get a
 * session to test it with. The tests below are what that question looks like answered.
 */

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

/**
 * A `TELEGRAM_ADMIN` actor built from an id of the test's choosing.
 *
 * Deliberately available, because it is the shape of the attack: a crafted callback
 * would reach a handler with SOME actor, and the cases below use this to present ids
 * that are a customer's, another tenant's, and a disabled administrator's. Nothing
 * downstream trusts the type — the resolver reads the row.
 */
const telegramAdminActor = (adminId: string, label: string): ActorContext => ({
  type: 'TELEGRAM_ADMIN',
  id: adminId,
  label,
  surface: 'TELEGRAM',
  correlationId: 'test-correlation' as CorrelationId,
});

const CORRELATION = 'telegram-admin-test' as CorrelationId;
const RECEIPTS_REVIEW = 'receipts.review' as PermissionKey;

describe('the Telegram management panel', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let botA: BotInstanceId;
  let panelA: string;
  let customerA: UserId;
  let ownerA: ActorContext;
  let ownerAId: AdminId;
  let ownerB: ActorContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    products = new DrizzleProductRepository(ctx.container.database.db);
    botA = (await firstBot(tenantA.tenantId)) as BotInstanceId;
    panelA = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    /*
     * Made GENUINELY sellable, not left as a bare row.
     *
     * A panel with no credentials, no activation and no probe cannot create an
     * account, and since this hotfix `decideEligibility` refuses to take money
     * for one. A fixture that expects a sale therefore has to describe a panel
     * that could deliver it; `makePanelSellable` writes the three things a sale
     * now requires, using the production identity function so it cannot drift.
     */
    await makePanelSellable(ctx.container, tenantA, panelA);
    customerA = await customerWithTelegramId('920500');

    const seededOwnerA = await createAdmin(ctx.container, tenantA, {
      username: 'owner-tg-a',
      roleKeys: ['owner'],
    });
    ownerAId = seededOwnerA.id as AdminId;
    ownerA = adminActorFor(seededOwnerA);
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-tg-b', roleKeys: ['owner'] }),
    );
  });

  // -------------------------------------------------------------------------
  // Identity: the binding, and everything it is not
  // -------------------------------------------------------------------------

  it('resolves a bound administrator to their own permissions, and nobody else to any', async () => {
    const reviewer = await createAdmin(ctx.container, tenantA, {
      username: 'reviewer-tg',
      roleKeys: ['receipt_reviewer'],
    });
    await bind(reviewer.id as AdminId, '700100');

    const resolved = await ctx.container.telegramAdmins.resolve(tenantA, '700100', CORRELATION);
    expect(resolved?.admin.id).toBe(reviewer.id);
    expect(resolved?.actor.type).toBe('TELEGRAM_ADMIN');
    // Their REAL permissions, from their role. Not a Telegram-side role name.
    expect(resolved?.permissions.has(RECEIPTS_REVIEW)).toBe(true);

    /*
     * The crafted-callback proof, at the layer that decides it.
     *
     * `customerA`'s Telegram id is a real account of this installation, and an admin
     * callback from it parses exactly as an administrator's would. It resolves to
     * nothing, so the surface answers the ordinary unsupported-input reply and the
     * customer learns nothing about what exists.
     */
    expect(await ctx.container.telegramAdmins.resolve(tenantA, '920500', CORRELATION)).toBeNull();
    expect(await ctx.container.telegramAdmins.resolve(tenantA, '999999', CORRELATION)).toBeNull();
  });

  it('stops resolving the moment the administrator is disabled, mid-conversation', async () => {
    const reviewer = await createAdmin(ctx.container, tenantA, {
      username: 'reviewer-disabled',
      roleKeys: ['receipt_reviewer'],
    });
    await bind(reviewer.id as AdminId, '700200');
    expect(
      await ctx.container.telegramAdmins.resolve(tenantA, '700200', CORRELATION),
    ).not.toBeNull();

    await ctx.container.adminManagement.setStatus(tenantA, ownerA, reviewer.id as AdminId, {
      status: 'DISABLED',
      reason: 'left the company',
    });

    /*
     * The old inline buttons are now dead, and nothing had to be invalidated.
     *
     * There is no cached authority and no session behind a binding: `resolve` reads the
     * row on every turn, and the resolver grants a non-ACTIVE administrator nothing. A
     * message from last week in that chat still has its buttons, and every one of them
     * now answers as a customer's would.
     */
    expect(await ctx.container.telegramAdmins.resolve(tenantA, '700200', CORRELATION)).toBeNull();
  });

  it('stops resolving when the binding is revoked, leaving the account and its roles', async () => {
    const reviewer = await createAdmin(ctx.container, tenantA, {
      username: 'reviewer-revoked',
      roleKeys: ['receipt_reviewer'],
    });
    await bind(reviewer.id as AdminId, '700300');

    await ctx.container.telegramAdmins.revoke(
      tenantA,
      ownerA,
      reviewer.id as AdminId,
      'no longer needs Telegram',
    );

    expect(await ctx.container.telegramAdmins.resolve(tenantA, '700300', CORRELATION)).toBeNull();
    // The administrator is untouched: still ACTIVE, still holding their role, still
    // able to sign in to the Web Admin. Only the channel is gone.
    const row = await adminRow(reviewer.id);
    expect(row.status).toBe('ACTIVE');
    expect(row.telegram_user_id).toBeNull();
    expect(await ctx.container.admins.roleKeysFor(tenantA, reviewer.id as AdminId)).toEqual([
      'receipt_reviewer',
    ]);
  });

  it('binds by numeric id, so a Telegram username is never identity', async () => {
    const reviewer = await createAdmin(ctx.container, tenantA, {
      username: 'reviewer-numeric',
      roleKeys: ['receipt_reviewer'],
    });
    await bind(reviewer.id as AdminId, '700400');

    /*
     * A customer renames themselves to the administrator's username, twice over: the
     * Telegram `username` on their own row, and the administrator's Nexa username. The
     * binding is a numeric id, so neither changes anything.
     */
    await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('rename'), {
      idempotencyKey: 'rename-1',
      telegramUserId: '920500',
      from: { id: 920_500, username: 'reviewer-numeric', first_name: 'Not the reviewer' },
      botInstanceId: botA,
    });

    expect(await ctx.container.telegramAdmins.resolve(tenantA, '920500', CORRELATION)).toBeNull();
    const still = await ctx.container.telegramAdmins.resolve(tenantA, '700400', CORRELATION);
    expect(still?.admin.id).toBe(reviewer.id);
  });

  // -------------------------------------------------------------------------
  // Tenancy
  // -------------------------------------------------------------------------

  it('cannot resolve or act across tenants', async () => {
    const reviewerB = await createAdmin(ctx.container, tenantB, {
      username: 'reviewer-b',
      roleKeys: ['receipt_reviewer'],
    });
    await ctx.container.telegramAdmins.link(tenantB, ownerB, {
      username: 'reviewer-b',
      telegramUserId: '700500',
      reason: 'tenant B reviewer',
    });

    // The same numeric id, resolved in tenant A: nothing. The binding is tenant-scoped
    // and `admins_tenant_telegram_key` is what lets two tenants hold the same id.
    expect(await ctx.container.telegramAdmins.resolve(tenantA, '700500', CORRELATION)).toBeNull();
    expect(
      (await ctx.container.telegramAdmins.resolve(tenantB, '700500', CORRELATION))?.admin.id,
    ).toBe(reviewerB.id);

    /*
     * And the sharper case: tenant B's administrator, with their REAL administrator id,
     * presenting tenant A's scope. Every read behind the panel is tenant-scoped, so the
     * payment simply does not exist for them.
     */
    const payment = await pendingWithReceipt('cross');
    const actorB = telegramAdminActor(reviewerB.id, 'reviewer-b');
    expect(
      await codeOf(ctx.container.receipts.reviewItem(tenantA, actorB, payment as PaymentId)),
    ).toBe('platform.permission_denied');
    expect(await paymentState(payment)).toBe('PENDING');
  });

  // -------------------------------------------------------------------------
  // Permissions: the panel decides nothing
  // -------------------------------------------------------------------------

  it('refuses an administrator without receipts.review, whatever the panel drew', async () => {
    const support = await createAdmin(ctx.container, tenantA, {
      username: 'support-tg',
      roleKeys: ['support'],
    });
    await bind(support.id as AdminId, '700600');
    const identity = await ctx.container.telegramAdmins.resolve(tenantA, '700600', CORRELATION);
    // `support` holds `receipts.view`, so the panel and the queue are legitimately
    // theirs — which is what makes the refusal below about the DECISION and not about
    // whether a button was drawn.
    expect(identity?.permissions.has('receipts.view' as PermissionKey)).toBe(true);
    expect(identity?.permissions.has(RECEIPTS_REVIEW)).toBe(false);

    const payment = await pendingWithReceipt('support');
    const actor = identity?.actor as ActorContext;

    expect(
      await codeOf(
        ctx.container.payments.confirmManualTransfer(tenantA, actor, payment, {
          idempotencyKey: 'support-approve',
          note: 'Approved in the Telegram management panel.',
        }),
      ),
    ).toBe('platform.permission_denied');
    expect(
      await codeOf(
        ctx.container.payments.rejectManualTransfer(tenantA, actor, payment, {
          idempotencyKey: 'support-reject',
          note: 'Rejected in the Telegram management panel.',
        }),
      ),
    ).toBe('platform.permission_denied');

    expect(await paymentState(payment)).toBe('PENDING');
    expect(await walletRowCount(customerA)).toBe(0);
  });

  it('refuses a fabricated administrator id outright', async () => {
    /*
     * The other half of the crafted-callback proof. Even if a handler were reached with
     * a `TELEGRAM_ADMIN` actor — the shape a modified client cannot produce but a future
     * bug could — the id names no administrator, so the resolver grants nothing.
     */
    const payment = await pendingWithReceipt('fabricated');
    const actor = telegramAdminActor(ctx.container.ids.uuid(), 'nobody');
    expect(
      await codeOf(
        ctx.container.payments.confirmManualTransfer(tenantA, actor, payment, {
          idempotencyKey: 'fabricated-approve',
          note: 'Approved in the Telegram management panel.',
        }),
      ),
    ).toBe('platform.permission_denied');
    expect(await paymentState(payment)).toBe('PENDING');
  });

  // -------------------------------------------------------------------------
  // Decisions: the same application path the Web Admin uses
  // -------------------------------------------------------------------------

  it('approves through the shared path, once, however many times the button is tapped', async () => {
    const reviewer = await boundReviewer('reviewer-approve', '700700');
    const payment = await pendingWithReceipt('approve');

    const first = await ctx.container.payments.confirmManualTransfer(tenantA, reviewer, payment, {
      idempotencyKey: 'tap-1:admin-approve',
      note: 'Approved in the Telegram management panel.',
    });
    expect(first.payment.state).toBe('CONFIRMED');
    // The decision is recorded against the ADMINISTRATOR, not the bot: the actor is
    // theirs, so `confirmed_by_admin_id` names a person.
    expect(await confirmedBy(payment)).toBe(reviewer.id);

    // The SAME tap, redelivered by Telegram: one key, so it replays.
    const replay = await ctx.container.payments.confirmManualTransfer(tenantA, reviewer, payment, {
      idempotencyKey: 'tap-1:admin-approve',
      note: 'Approved in the Telegram management panel.',
    });
    expect(replay.payment.state).toBe('CONFIRMED');

    // A SECOND tap, with its own key: answered with the payment as it stands, and it
    // settles nothing twice — the conditional UPDATE is what makes that true.
    const second = await ctx.container.payments.confirmManualTransfer(tenantA, reviewer, payment, {
      idempotencyKey: 'tap-2:admin-approve',
      note: 'Approved in the Telegram management panel.',
    });
    expect(second.payment.state).toBe('CONFIRMED');
    expect(await confirmedAtCount(payment)).toBe(1);
  });

  it('rejects through the shared path, and a second tap changes nothing', async () => {
    const reviewer = await boundReviewer('reviewer-reject', '700800');
    const payment = await pendingWithReceipt('reject');

    const rejected = await ctx.container.payments.rejectManualTransfer(tenantA, reviewer, payment, {
      idempotencyKey: 'tap-1:admin-reject',
      note: 'Rejected in the Telegram management panel.',
    });
    expect(rejected.state).toBe('FAILED');

    const again = await codeOf(
      ctx.container.payments.rejectManualTransfer(tenantA, reviewer, payment, {
        idempotencyKey: 'tap-2:admin-reject',
        note: 'Rejected in the Telegram management panel.',
      }),
    );
    // Either answered as already-resolved or refused by name; what must NOT happen is a
    // second transition, a second notification or a credit.
    expect(again === null || again === 'commerce.payment_state_invalid').toBe(true);
    expect(await paymentState(payment)).toBe('FAILED');
    expect(await walletRowCount(customerA)).toBe(0);
  });

  it('tells a stale button the truth instead of acting on it', async () => {
    const reviewer = await boundReviewer('reviewer-stale', '700900');
    const payment = await pendingWithReceipt('stale');

    // Somebody else decides it first — the Web Admin, an hour ago.
    await ctx.container.payments.rejectManualTransfer(tenantA, ownerA, payment, {
      idempotencyKey: 'web-reject',
      note: 'not received',
    });

    /*
     * The reviewer's message is still in the chat with its two buttons. `reviewItem`
     * answers null, which is what the surface renders as `bot.admin.receipt_gone` —
     * rather than a refusal about a payment, or worse, a decision.
     */
    expect(
      await ctx.container.receipts.reviewItem(tenantA, reviewer, payment as PaymentId),
    ).toBeNull();
    // And it has left the queue, which is the same fact from the other side.
    const queue = await ctx.container.receipts.reviewQueue(tenantA, reviewer, 10);
    expect(queue.map((item) => item.payment.id)).not.toContain(payment);
  });

  // -------------------------------------------------------------------------
  // The queue
  // -------------------------------------------------------------------------

  it('queues only pending manual transfers that actually hold a receipt', async () => {
    const reviewer = await boundReviewer('reviewer-queue', '701000');

    const withReceipt = await pendingWithReceipt('q-with');
    const withoutReceipt = await pendingPayment('q-without');

    const queue = await ctx.container.receipts.reviewQueue(tenantA, reviewer, 10);
    const ids = queue.map((item) => item.payment.id);
    expect(ids).toContain(withReceipt);
    expect(ids).not.toContain(withoutReceipt);

    const item = queue.find((one) => one.payment.id === withReceipt);
    expect(item?.held).toBe(1);
    // The facts a reviewer reconciles with: the reference the customer quoted, the
    // amount, and who owes it.
    expect(item?.payment.reference).toBeTruthy();
    expect(item?.customer?.telegramUserId).toBe('920500');
  });

  // -------------------------------------------------------------------------
  // Managing who has access
  // -------------------------------------------------------------------------

  it('refuses to bind a Telegram account to authority the actor does not hold', async () => {
    /*
     * The escalation this method exists to refuse, and the one `UNK-ADM-005` asks about.
     *
     * A `user_manager` role holding `admins.edit` could otherwise bind THEIR OWN
     * Telegram account to the owner and act as the owner from a chat — with a permission
     * every one of Mirza's four production admins holds.
     */
    await ctx.container.database.db.execute(sql`
      INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'binder', 'Binder', false)`);
    const roleId = await roleIdFor('binder');
    for (const permission of ['admins.view', 'admins.edit']) {
      await ctx.container.database.db.execute(sql`
        INSERT INTO role_permissions (tenant_id, role_id, permission_key)
        VALUES (${tenantA.tenantId}, ${roleId}, ${permission})`);
    }
    const binder = await createAdmin(ctx.container, tenantA, {
      username: 'binder-tg',
      roleKeys: ['binder'],
    });

    const refused = await codeOf(
      ctx.container.telegramAdmins.link(tenantA, adminActorFor(binder), {
        username: 'owner-tg-a',
        telegramUserId: '701100',
        reason: 'giving myself the owner',
      }),
    );
    expect(refused).not.toBeNull();
    expect((await adminRow(ownerAId)).telegram_user_id).toBeNull();
  });

  it('links and revokes through the audited path, by username and numeric id', async () => {
    const reviewer = await createAdmin(ctx.container, tenantA, {
      username: 'reviewer-link',
      roleKeys: ['receipt_reviewer'],
    });

    await ctx.container.telegramAdmins.link(tenantA, ownerA, {
      username: 'reviewer-link',
      telegramUserId: '701200',
      reason: 'new reviewer on Telegram',
    });
    expect((await adminRow(reviewer.id)).telegram_user_id).toBe('701200');

    // The same account cannot be bound to a second administrator: the check is on the
    // locked connection and the partial unique index is behind it.
    const other = await createAdmin(ctx.container, tenantA, {
      username: 'reviewer-other',
      roleKeys: ['receipt_reviewer'],
    });
    expect(
      await codeOf(
        ctx.container.telegramAdmins.link(tenantA, ownerA, {
          username: 'reviewer-other',
          telegramUserId: '701200',
          reason: 'two people, one chat',
        }),
      ),
    ).toBe('admin.telegram_id_taken');
    expect((await adminRow(other.id)).telegram_user_id).toBeNull();

    // Both acts are audited, which is the requirement: a binding is a grant of
    // authority through a new channel.
    await ctx.container.telegramAdmins.revoke(
      tenantA,
      ownerA,
      reviewer.id as AdminId,
      'access removed',
    );
    const actions = await auditActions('admin.telegram_binding');
    expect(actions.length).toBeGreaterThanOrEqual(2);
    expect(actions.every((row) => row.entity_type === 'Admin')).toBe(true);
  });

  it('lists only the administrators that hold Telegram access, and charges admins.view', async () => {
    const reviewer = await createAdmin(ctx.container, tenantA, {
      username: 'reviewer-listed',
      roleKeys: ['receipt_reviewer'],
    });
    await bind(reviewer.id as AdminId, '701300');

    const bound = await ctx.container.telegramAdmins.listBound(tenantA, ownerA);
    expect(bound.map((admin) => admin.username)).toEqual(['reviewer-listed']);

    // A customer-shaped actor holds nothing, and the list is a read of who may act.
    expect(
      await codeOf(
        ctx.container.telegramAdmins.listBound(
          tenantA,
          telegramAdminActor(ctx.container.ids.uuid(), 'nobody'),
        ),
      ),
    ).toBe('platform.permission_denied');
  });

  // -------------------------------------------------------------------------
  // WP1: the roster, and the one write this surface may make about it
  // -------------------------------------------------------------------------

  it('lists EVERY administrator on the roster, bound or not, and charges admins.view', async () => {
    /*
     * The distinction that made this section worth building. `listBound` answers "who
     * can be reached in Telegram"; an operator reaching for a phone is usually reaching
     * for the administrator they need to STOP, and that person is under no obligation
     * to hold a binding. Before WP1 they simply did not appear.
     */
    const bound = await createAdmin(ctx.container, tenantA, {
      username: 'roster-bound',
      roleKeys: ['support'],
    });
    await bind(bound.id as AdminId, '702100');
    await createAdmin(ctx.container, tenantA, {
      username: 'roster-unbound',
      roleKeys: ['support'],
    });

    const roster = await ctx.container.telegramAdmins.listAll(tenantA, ownerA);
    expect(roster.map((entry) => entry.admin.username).sort()).toEqual([
      'owner-tg-a',
      'roster-bound',
      'roster-unbound',
    ]);
    // The projection the detail screen reads from: roles resolved, status carried.
    const unbound = roster.find((entry) => entry.admin.username === 'roster-unbound');
    expect(unbound?.roleKeys).toEqual(['support']);
    expect(unbound?.admin.status).toBe('ACTIVE');
    expect(unbound?.admin.telegramUserId).toBeNull();

    expect(
      await codeOf(
        ctx.container.telegramAdmins.listAll(
          tenantA,
          telegramAdminActor(ctx.container.ids.uuid(), 'nobody'),
        ),
      ),
    ).toBe('platform.permission_denied');
  });

  it('never shows one tenant its neighbour on the roster', async () => {
    await createAdmin(ctx.container, tenantB, {
      username: 'roster-other-tenant',
      roleKeys: ['support'],
    });
    const roster = await ctx.container.telegramAdmins.listAll(tenantA, ownerA);
    expect(roster.some((entry) => entry.admin.username === 'roster-other-tenant')).toBe(false);

    // And the reverse read cannot reach tenant A's, whichever id it names.
    const across = await ctx.container.telegramAdmins.listAll(tenantB, ownerB);
    expect(across.some((entry) => entry.admin.username === 'owner-tg-a')).toBe(false);
  });

  it('disables and re-enables an administrator through the same guarded path as the Web Admin', async () => {
    const target = await createAdmin(ctx.container, tenantA, {
      username: 'roster-target',
      roleKeys: ['support'],
    });

    const disabled = await ctx.container.telegramAdmins.setStatus(
      tenantA,
      ownerA,
      target.id as AdminId,
      'DISABLED',
      'from telegram',
      'tg-status-1',
    );
    expect(disabled.admin.status).toBe('DISABLED');

    // A REPLAY, which a redelivered Telegram update is: the SAME key, answered
    // from the store rather than run a second time.
    const replayed = await ctx.container.telegramAdmins.setStatus(
      tenantA,
      ownerA,
      target.id as AdminId,
      'DISABLED',
      'from telegram',
      'tg-status-1',
    );
    expect(replayed.admin.status).toBe('DISABLED');

    const enabled = await ctx.container.telegramAdmins.setStatus(
      tenantA,
      ownerA,
      target.id as AdminId,
      'ACTIVE',
      'from telegram',
      'tg-status-3',
    );
    expect(enabled.admin.status).toBe('ACTIVE');
    // Roles survived the round trip: disabling empties AUTHORITY, not assignment.
    expect(enabled.roleKeys).toEqual(['support']);

    const actions = await auditActions('admin.status_change');
    expect(actions.length).toBeGreaterThanOrEqual(2);
  });

  it('answers a redelivered status tap from the store instead of overwriting a newer decision', async () => {
    /*
     * The interleaving the update key exists for, and the one the no-op path
     * cannot cover.
     *
     * A no-op answers a replay that arrives while nothing else has happened.
     * This is the other case: the tap committed, its reply was lost, ANOTHER
     * operator made the opposite decision, and Telegram then redelivered the
     * original update. Without the key there is no longer a no-op to find, so
     * the old command runs again — disabling the administrator a second time,
     * revoking their sessions again, and silently undoing a decision nobody
     * asked it to touch, from a tap nobody made twice.
     */
    const target = await createAdmin(ctx.container, tenantA, {
      username: 'roster-redelivered',
      roleKeys: ['support'],
    });
    const update = 'telegram-update-77';

    await ctx.container.telegramAdmins.setStatus(
      tenantA,
      ownerA,
      target.id as AdminId,
      'DISABLED',
      'from telegram',
      update,
    );

    // A second operator, through the Web Admin, reverses it.
    await ctx.container.adminManagement.setStatus(tenantA, ownerA, target.id as AdminId, {
      status: 'ACTIVE',
      reason: 'reinstated by somebody else',
    });
    expect((await ctx.container.admins.findById(tenantA, target.id as AdminId))?.status).toBe(
      'ACTIVE',
    );

    // Telegram redelivers the ORIGINAL update. It must write nothing.
    await ctx.container.telegramAdmins.setStatus(
      tenantA,
      ownerA,
      target.id as AdminId,
      'DISABLED',
      'from telegram',
      update,
    );

    expect(
      (await ctx.container.admins.findById(tenantA, target.id as AdminId))?.status,
      'a redelivered tap overwrote a newer decision',
    ).toBe('ACTIVE');
  });

  it('refuses the three things a roster tap must never be able to do', async () => {
    const target = await createAdmin(ctx.container, tenantA, {
      username: 'roster-protected',
      roleKeys: ['support'],
    });
    const bystander = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'roster-bystander',
        roleKeys: ['receipt_reviewer'],
      }),
    );

    // 1. An administrator cannot disable THEMSELVES, whatever they hold.
    expect(
      await codeOf(
        ctx.container.telegramAdmins.setStatus(
          tenantA,
          ownerA,
          ownerAId,
          'DISABLED',
          'from telegram',
          'tg-status-4',
        ),
      ),
    ).toBe('admin.self_modification_denied');

    // 2. An administrator without `admins.edit` is refused by the SERVICE, not by the
    //    absence of a button — a crafted callback reaches the same guard.
    expect(
      await codeOf(
        ctx.container.telegramAdmins.setStatus(
          tenantA,
          bystander,
          target.id as AdminId,
          'DISABLED',
          'from telegram',
          'tg-status-5',
        ),
      ),
    ).toBe('platform.permission_denied');

    // 3. Another tenant's administrator is not found, whoever asks.
    expect(
      await codeOf(
        ctx.container.telegramAdmins.setStatus(
          tenantB,
          ownerB,
          target.id as AdminId,
          'DISABLED',
          'from telegram',
          'tg-status-6',
        ),
      ),
    ).toBe('admin.not_found');
  });

  it('will not let Telegram disable the last owner', async () => {
    /*
     * The one rule that cannot be shown with an owner acting, because an owner
     * disabling the last owner is always themselves and self-modification refuses
     * first. So the actor is a privileged NON-owner, built the way `rbac.test.ts`
     * builds one: roles plus two explicit permission overrides.
     *
     * The point of repeating it on this surface is not the rule, which is charged by
     * `setStatus`. It is that the surface REACHES `setStatus`: a later refactor that
     * inlined a repository write here would pass every other case in this file and
     * fail this one.
     */
    const manager = await createAdmin(ctx.container, tenantA, {
      username: 'roster-manager',
      roleKeys: ['operator', 'support'],
    });
    await ctx.container.database.db.execute(sql`
      INSERT INTO admin_permission_overrides (tenant_id, admin_id, permission_key, effect, reason)
      VALUES
        (${tenantA.tenantId}, ${manager.id}, 'admins.edit', 'GRANT', 'Administers the roster.'),
        (${tenantA.tenantId}, ${manager.id}, 'admins.permissions.edit', 'GRANT', 'Administers privileges.')`);
    const managerActor = adminActorFor(manager);

    // Two owners: disabling one is allowed, and this is what makes the next line the
    // LAST owner rather than merely an owner.
    const second = await createAdmin(ctx.container, tenantA, {
      username: 'roster-second-owner',
      roleKeys: ['owner'],
    });
    await ctx.container.telegramAdmins.setStatus(
      tenantA,
      managerActor,
      second.id as AdminId,
      'DISABLED',
      'from telegram',
      'tg-status-7',
    );

    expect(
      await codeOf(
        ctx.container.telegramAdmins.setStatus(
          tenantA,
          managerActor,
          ownerAId,
          'DISABLED',
          'from telegram',
          'tg-status-8',
        ),
      ),
    ).toBe('admin.last_owner_protected');

    // And still active, not merely reported as such.
    expect((await ctx.container.admins.findById(tenantA, ownerAId))?.status).toBe('ACTIVE');
  });

  it('names as reviewers only the administrators who are bound AND may decide', async () => {
    const reviewer = await createAdmin(ctx.container, tenantA, {
      username: 'reviewer-notified',
      roleKeys: ['receipt_reviewer'],
    });
    await bind(reviewer.id as AdminId, '701400');
    const support = await createAdmin(ctx.container, tenantA, {
      username: 'support-notified',
      roleKeys: ['support'],
    });
    await bind(support.id as AdminId, '701500');
    // Bound to nobody: holds the permission and has no chat to be told in.
    await createAdmin(ctx.container, tenantA, {
      username: 'reviewer-unbound',
      roleKeys: ['receipt_reviewer'],
    });

    const reviewers = await ctx.container.telegramAdmins.reviewers(
      tenantA,
      RECEIPTS_REVIEW,
      CORRELATION,
    );
    expect(reviewers.map((one) => one.admin.username)).toEqual(['reviewer-notified']);

    // And a role change is reflected on the next receipt rather than at some refresh.
    await ctx.container.adminManagement.setRoles(tenantA, ownerA, support.id as AdminId, {
      roleKeys: ['receipt_reviewer'],
      reason: 'promoted to reviewer',
    });
    const after = await ctx.container.telegramAdmins.reviewers(
      tenantA,
      RECEIPTS_REVIEW,
      CORRELATION,
    );
    expect(after.map((one) => one.admin.username).sort()).toEqual([
      'reviewer-notified',
      'support-notified',
    ]);
  });

  it('queues a reviewer notice on a default installation, where ops notifications are off', async () => {
    /*
     * `ops_notifications` is `defaultEnabled: false` and its own description says why —
     * "a destination has to be configured and tested first". A reviewer-addressed
     * message did not come from that destination and must not wait on it: gated on the
     * flag, a default installation with correctly bound reviewers queued NOTHING, which
     * is the product promising a notification it never sends.
     */
    expect(await ctx.container.featureFlagResolver.isEnabled(tenantA, 'ops_notifications')).toBe(
      false,
    );

    const addressed = await ctx.container.notifications.queue(tenantA, {
      kind: 'RECEIPT_AWAITING_REVIEW',
      dedupeKey: `receipt.awaiting:${ctx.container.ids.uuid()}`,
      templateKey: 'bot.admin.receipt_awaiting',
      values: { reference: 'NX-TEST', total: money(250_000n, 'IRT') },
      destination: { transport: 'TELEGRAM', chatId: '701600', topicId: null },
    });
    expect(addressed.created).toBe(true);
    expect(addressed.intent?.destination).toEqual({
      transport: 'TELEGRAM',
      chatId: '701600',
      topicId: null,
    });

    // And the operations lane is still gated, which is the half the flag is for.
    const operational = await ctx.container.notifications.queue(tenantA, {
      kind: 'OPERATIONS_TEST',
      dedupeKey: `ops.test:${ctx.container.ids.uuid()}`,
      templateKey: 'bot.admin.receipt_awaiting',
      values: { reference: 'NX-TEST', total: money(250_000n, 'IRT') },
    });
    expect(operational.created).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  it('answers a redelivered /role command from the store instead of running it again', async () => {
    const target = await createAdmin(ctx.container, tenantA, {
      username: 'alice-tg',
      roleKeys: ['support'],
    });
    const command = {
      username: 'alice-tg',
      roleKeys: ['receipt_reviewer'],
      reason: 'Roles set from the Telegram management panel.',
      idempotencyKey: 'update-77',
    };

    const first = await ctx.container.telegramAdmins.setRoles(tenantA, ownerA, command);
    expect(first.roleKeys).toEqual(['receipt_reviewer']);

    // A decision taken in the Web Admin in between.
    await ctx.container.adminManagement.setRoles(tenantA, ownerA, target.id as AdminId, {
      roleKeys: ['finance'],
      reason: 'changed on the web',
    });

    /*
     * Telegram redelivers the ORIGINAL update — same key, same command. It used to run
     * again and put `receipt_reviewer` back, silently undoing the web decision: a
     * second durable effect from one update. Now it is answered with the first run's
     * outcome and writes nothing.
     */
    const replay = await ctx.container.telegramAdmins.setRoles(tenantA, ownerA, command);
    expect(replay.roleKeys).toEqual(['receipt_reviewer']);
    expect(await ctx.container.admins.roleKeysFor(tenantA, target.id as AdminId)).toEqual([
      'finance',
    ]);
  });

  async function boundReviewer(username: string, telegramUserId: string): Promise<ActorContext> {
    const admin = await createAdmin(ctx.container, tenantA, {
      username,
      roleKeys: ['receipt_reviewer'],
    });
    await bind(admin.id as AdminId, telegramUserId);
    const identity = await ctx.container.telegramAdmins.resolve(
      tenantA,
      telegramUserId,
      CORRELATION,
    );
    if (identity === null) throw new Error(`${username} did not resolve`);
    return identity.actor;
  }

  const bind = (adminId: AdminId, telegramUserId: string) =>
    ctx.container.adminManagement.setTelegramBinding(tenantA, ownerA, adminId, {
      telegramUserId,
      reason: 'test binding',
    });

  async function codeOf(running: Promise<unknown>): Promise<string | null> {
    try {
      await running;
      return null;
    } catch (error) {
      return isNexaError(error) ? error.code : `unexpected: ${String(error)}`;
    }
  }

  async function firstBot(tenantId: string): Promise<string> {
    const rows = await ctx.container.database.db.execute<{ id: string }>(
      sql`SELECT id FROM bot_instances WHERE tenant_id = ${tenantId} ORDER BY created_at LIMIT 1`,
    );
    const id = rows.rows[0]?.id;
    if (id === undefined) throw new Error('the seed has no bot instance');
    return id;
  }

  async function customerWithTelegramId(telegramUserId: string): Promise<UserId> {
    const { customer } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'زهرا' },
        botInstanceId: botA,
      },
    );
    return customer.id;
  }

  /** A pending manual transfer for `customerA`, with no receipt on it yet. */
  async function pendingPayment(key: string): Promise<string> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: 'یک ماهه',
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelA as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(250_000n, 'IRT'),
      } satisfies ProductDraft,
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const order = await ctx.container.orders.createDraft(tenantA, systemActor(`${key}-d`), {
      idempotencyKey: `${key}-draft`,
      customerId: customerA,
      productId: created.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(`${key}-c`), {
      idempotencyKey: `${key}-confirm`,
      customerId: customerA,
      orderId: order.id,
    });
    const issued = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor(`${key}-p`),
      customerA,
      { idempotencyKey: `${key}-pay`, orderId: confirmed.id },
    );
    return issued.payment.id;
  }

  /** The same, with the window opened and one photo filed against it. */
  async function pendingWithReceipt(key: string): Promise<string> {
    const paymentId = await pendingPayment(key);
    await ctx.container.payments.signalTransferSent(tenantA, systemActor(`${key}-s`), customerA, {
      idempotencyKey: `${key}-signal`,
      paymentId: paymentId as PaymentId,
      botInstanceId: botA,
    });
    const file: InboundReceiptFile = {
      kind: 'PHOTO',
      fileId: `file-${key}`,
      fileUniqueId: `unique-${key}`,
      mimeType: 'image/jpeg',
      fileSize: 102_400n,
      fileName: null,
      telegramMessageId: 42n,
    };
    await ctx.container.receipts.submit(tenantA, systemActor(`${key}-f`), customerA, {
      idempotencyKey: `${key}-file`,
      botInstanceId: botA,
      file,
    });
    return paymentId;
  }

  async function paymentState(paymentId: string): Promise<string> {
    const rows = await ctx.container.database.db.execute<{ state: string }>(
      sql`SELECT state FROM payments WHERE id = ${paymentId}`,
    );
    return rows.rows[0]?.state ?? 'MISSING';
  }

  async function confirmedBy(paymentId: string): Promise<string | null> {
    const rows = await ctx.container.database.db.execute<{ confirmed_by_admin_id: string | null }>(
      sql`SELECT confirmed_by_admin_id FROM payments WHERE id = ${paymentId}`,
    );
    return rows.rows[0]?.confirmed_by_admin_id ?? null;
  }

  async function confirmedAtCount(paymentId: string): Promise<number> {
    const rows = await ctx.container.database.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM payments
           WHERE id = ${paymentId} AND confirmed_at IS NOT NULL`,
    );
    return Number(rows.rows[0]?.count ?? 0);
  }

  async function walletRowCount(customerId: UserId): Promise<number> {
    const rows = await ctx.container.database.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM wallet_entries WHERE customer_id = ${customerId}`,
    );
    return Number(rows.rows[0]?.count ?? 0);
  }

  async function adminRow(
    adminId: string,
  ): Promise<{ status: string; telegram_user_id: string | null }> {
    const rows = await ctx.container.database.db.execute<{
      status: string;
      telegram_user_id: string | null;
    }>(sql`SELECT status, telegram_user_id FROM admins WHERE id = ${adminId}`);
    const row = rows.rows[0];
    if (row === undefined) throw new Error('no such administrator');
    return row;
  }

  async function roleIdFor(key: string): Promise<string> {
    const rows = await ctx.container.database.db.execute<{ id: string }>(
      sql`SELECT id FROM roles WHERE tenant_id = ${tenantA.tenantId} AND key = ${key}`,
    );
    const id = rows.rows[0]?.id;
    if (id === undefined) throw new Error(`no role ${key}`);
    return id;
  }

  async function auditActions(action: string): Promise<{ entity_type: string }[]> {
    const rows = await ctx.container.database.db.execute<{ entity_type: string }>(
      sql`SELECT entity_type FROM audit_logs WHERE action = ${action} AND result = 'SUCCESS'`,
    );
    return [...rows.rows];
  }
});
