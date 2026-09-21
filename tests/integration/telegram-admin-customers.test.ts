import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_MENU_BUTTON,
  type ActorContext,
  type AdminId,
  type BotInstanceId,
  type CorrelationId,
  type UserId,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * The Telegram management panel's customers section — WP2.
 *
 * Against real everything, the way the panels and services sections are tested: a real
 * PostgreSQL, the real `CustomerService` with its real guard, a real socket standing in
 * for Telegram, and the real bot runtime parsing real callback data.
 *
 * Four questions this file is about, and they are the four that make a section about a
 * PERSON different from one about a panel or a service:
 *
 *   1. **What may never appear in a chat.** An admin message lives in somebody's
 *      Telegram for ever and is forwardable. A customer's wallet balance, their orders,
 *      their services and any subscription reference are all out — each is a different
 *      permission, and this section holds none of them.
 *   2. **Two permissions, not one.** `users.view` opens the section and lists;
 *      `users.search` is charged ON TOP for the lookup by Telegram id, because a list
 *      of a tenant's customers and a lookup of one specific person are different
 *      questions; `users.block` draws and performs the two writes. Every case that
 *      asserts a control is absent is paired with one that sends the callback anyway.
 *   3. **One answer for every miss.** Unknown, malformed, another tenant's and
 *      not-matched all answer `bot.admin.customer_gone`, so nobody holding an id can
 *      use this surface to discover whether it names anybody here.
 *   4. **The writes are idempotent and conditional.** The button carries the TARGET
 *      status rather than "flip it", so a double tap writes the same status twice
 *      instead of undoing itself on a slow connection.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;

/** Every callback prefix the section owns, spelled out rather than imported. */
const PREFIX = {
  /** The section, and — with a token — a page of it. */
  customers: '8:',
  /** One customer. `9:<code>:<uuid>`, where the code is `v`, `b` or `u`. */
  view: '9:v:',
  block: '9:b:',
  unblock: '9:u:',
} as const;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

describe('the customers section of the Telegram management panel', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let owner: ActorContext;
  let ownerAId: AdminId;
  let customerId: UserId;
  let updateSeq = 0;

  /* The Telegram accounts every case draws from. */
  const TG = {
    /** `owner`: every permission, including `users.search` and `users.block`. */
    owner: '720001',
    /** A custom role, built per case — no seeded role holds these keys in isolation. */
    limited: '720002',
    /** `sales`: holds no admin section at all. */
    sales: '720003',
    /** An ordinary customer. No administrator row anywhere. */
    customer: '921921',
  } as const;

  /** The customer every case acts on, and their numeric id. */
  const SUBJECT = '555100200';

  beforeAll(async () => {
    sent = [];
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = { unparseable: raw };
        }
        sent.push({ url: request.url ?? '', body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');

    ctx = await createTestContext({
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    sent = [];

    const seededOwner = await createAdmin(ctx.container, tenantA, {
      username: 'owner-tg-customers',
      roleKeys: ['owner'],
    });
    ownerAId = seededOwner.id as AdminId;
    owner = adminActorFor(seededOwner);
    await bind(ownerAId, TG.owner);

    customerId = await makeCustomer(tenantA, SUBJECT, { username: 'ali_tehran' });
  });

  // =========================================================================
  // Who sees the section at all
  // =========================================================================

  it('draws the Customers button for an administrator who holds users.view', async () => {
    await bindNewAdmin('customers-viewer', TG.limited, { permissions: ['users.view'] });

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate('/admin', TG.limited),
    );

    expect(result.replyKey).toBe('bot.admin.panel');
    expect(lastMessage(), 'the Customers button is drawn').toContain(PREFIX.customers);
  });

  it('draws no Customers button for an administrator whose role does not hold users.view', async () => {
    /*
     * `receipt_reviewer` HAS a section — receipts — so the panel opens. What it must
     * not carry is a button whose every press would record a denial. Without this
     * negative half, a gate that always returned true would pass the case above.
     */
    await bindNewAdmin('reviewer-no-customers', TG.limited, { roleKeys: ['receipt_reviewer'] });

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate('/admin', TG.limited),
    );

    expect(result.replyKey).toBe('bot.admin.panel');
    expect(lastMessage(), 'a section they cannot enter was offered').not.toContain(
      PREFIX.customers,
    );
  });

  it('opens the panel for an administrator whose ONLY section is Customers', async () => {
    /*
     * The arm of `isAdmin` and of `adminTurn`'s gate that has to agree with the other:
     * the keyboard must not promise a panel the turn would refuse, and must not
     * withhold one from an administrator who has a section. Those two lists were
     * hand-kept copies and had already diverged over the reminders section, which is
     * why `PANEL_SECTION_PERMISSIONS` is now one list — and this case is what would
     * have caught it.
     */
    await bindNewAdmin('customers-only-menu', TG.limited, { permissions: ['users.view'] });

    await runtime().handle(tenantA, systemActor('bot'), adminUpdate('/start', TG.limited));
    const markup = lastBody()?.['reply_markup'] as { keyboard?: { text: string }[][] } | undefined;
    const labels = (markup?.keyboard ?? []).flat().map((button) => button.text);
    expect(labels, 'the admin row was withheld').toContain(CATALOGUE_FA[ADMIN_MENU_BUTTON.label]);

    const opened = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate('/admin', TG.limited),
    );
    expect(opened.replyKey).toBe('bot.admin.panel');
  });

  it('answers an ordinary customer who sends any customers callback as unknown input', async () => {
    /*
     * The crafted-callback case, end to end through the real runtime, for EVERY prefix
     * the section owns — including the two that write. `telegramAdmins.resolve` answers
     * null for a customer, so the turn never reaches `adminTurn` and the reply is the
     * ordinary fallback: the customer learns nothing about what exists. A registry entry
     * pointed at the wrong guard would show up on exactly one prefix, which is why the
     * loop covers all of them.
     */
    for (const prefix of Object.values(PREFIX)) {
      sent = [];
      const data = prefix === PREFIX.customers ? prefix : `${prefix}${customerId}`;
      const result = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(data, TG.customer),
      );
      expect(result.replyKey, `${prefix} answered an administrator's reply`).toBe(
        'bot.unknown_command',
      );
    }
    /* And the customer is untouched by any of them. */
    expect((await ctx.container.customers.get(tenantA, owner, customerId)).status).toBe('ACTIVE');
  });

  it('answers an administrator with no users permission with the refusal, never customer_gone', async () => {
    /*
     * A hand-made role holding `receipts.view` alone: they HAVE a section, so the
     * panel opens, and they hold no `users.*` at all. `adminTurn` reaches the handler
     * and `CustomerService.get` refuses before any row is read — and the answer is the
     * panel's single refusal rather than `customer_gone`, which would confirm the id
     * names somebody.
     *
     * Not `sales`, which was the first attempt: every seeded role except
     * `receipt_reviewer` and `backup_operator` holds `users.view`, so a case built on
     * one of them proves the opposite of what it says.
     */
    await bindNewAdmin('receipts-only-customers', TG.sales, { permissions: ['receipts.view'] });

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.view}${customerId}`, TG.sales),
    );
    expect(result.replyKey).toBe('bot.admin.refused');
  });

  // =========================================================================
  // The list, and its paging
  // =========================================================================

  it('lists the tenant’s customers, one button each', async () => {
    const result = await open(PREFIX.customers, TG.owner);

    expect(result.replyKey).toBe('bot.admin.customers_section');
    expect(lastMessage()).toContain(`${PREFIX.view}${customerId}`);
    /* The row label. `@username` when there is one. */
    expect(lastMessage()).toContain('ali_tehran');
  });

  it('never lists another tenant’s customer', async () => {
    /*
     * The isolation case, and it has to be a LIST rather than a lookup: a list is the
     * path with no id to get wrong, so a missing tenant predicate shows up here and
     * nowhere else.
     */
    const theirs = await makeCustomer(tenantB, '555999888', { username: 'other_tenant' });

    const result = await open(PREFIX.customers, TG.owner);

    expect(result.replyKey).toBe('bot.admin.customers_section');
    expect(lastMessage(), 'another tenant’s customer was listed').not.toContain(theirs);
    expect(lastMessage()).not.toContain('other_tenant');
  });

  it('says there is nobody rather than drawing an empty page past the end', async () => {
    /*
     * The empty branch is reached with a CURSOR, not without one.
     *
     * An administrator sending an update IS a Telegram account, and every turn resolves
     * one into a customer row before the panel is reached — so a tenant whose customer
     * table this test emptied has exactly one customer again by the time the section
     * renders. That is not a flaw in the section: it is what `resolveFromUpdate` is
     * for, and it means the reachable empty case is the one the docblock on
     * `adminCustomers` names — an operator pages forward and the last of them was on
     * the previous page.
     *
     * The cursor is built from a real row's position by taking the token the section
     * itself minted for a one-customer tenant... which it does not mint, because there
     * is no next page. So it is built here from a far-future instant instead, which is
     * the same shape and lands past every row.
     */
    const token = `${(Date.now() * 1000 + 86_400_000_000).toString(36)}.${'f'.repeat(32)}`;

    const result = await open(`${PREFIX.customers}${token}`, TG.owner);

    expect(result.replyKey).toBe('bot.admin.customers_none');
  });

  it('offers a further page only when the server says there is one, and that page works', async () => {
    /*
     * Eleven customers against a ten-row screen, so the page button is drawn — and then
     * FOLLOWED, because a cursor that encodes and does not decode is a button that
     * answers `bot.unsupported`, which is a list that silently ends at ten.
     */
    for (let index = 0; index < 10; index += 1) {
      await makeCustomer(tenantA, `5559${String(index).padStart(5, '0')}`, {
        username: `paged_${String(index)}`,
      });
    }

    const first = await open(PREFIX.customers, TG.owner);
    expect(first.replyKey).toBe('bot.admin.customers_section');
    const token = pageTokenFrom(lastBody());
    expect(token, 'no next-page button was drawn for eleven customers').not.toBeNull();

    const second = await open(`${PREFIX.customers}${token ?? ''}`, TG.owner);
    expect(second.replyKey, 'the cursor this section minted did not decode').toBe(
      'bot.admin.customers_section',
    );
    /* And it is a DIFFERENT page: the first customer is not on it. */
    expect(lastMessage()).not.toContain(`${PREFIX.view}${customerId}`);
  });

  it('answers a forged page cursor as unreadable input rather than a query error', async () => {
    /*
     * `bot.unknown_command` is what an UNSUPPORTED intent renders as — the same answer
     * any unreadable input gets. What matters is that it is an ANSWER: a token that
     * reached the `::timestamptz` cast would be a 500 on a callback anybody can craft.
     */
    const result = await open(`${PREFIX.customers}not-a-cursor`, TG.owner);
    expect(result.replyKey).toBe('bot.unknown_command');
  });

  // =========================================================================
  // One customer
  // =========================================================================

  it('shows one customer, and carries nothing they bought', async () => {
    const result = await open(`${PREFIX.view}${customerId}`, TG.owner);

    expect(result.replyKey).toBe('bot.admin.customer_detail');
    const message = lastMessage();
    expect(message).toContain(SUBJECT);
    expect(message).toContain('ali_tehran');
    /*
     * The four things a customer detail could plausibly grow and must not: a wallet
     * balance, an order, a service and a subscription. Each is a different permission,
     * and this message is forwardable for ever. Asserted against the Persian labels the
     * OTHER sections use, so wiring one of them in here fails this case.
     */
    for (const forbidden of ['موجودی', 'سفارش', 'سرویس', 'subscription', 'http']) {
      expect(message, `the detail carried ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('gives one answer for an unknown id, a malformed one and another tenant’s', async () => {
    const theirs = await makeCustomer(tenantB, '555777666', {});
    const cases = [
      ['unknown', '019210ab-cdef-7012-8345-6789abcdef99'],
      ['another tenant’s', theirs],
    ] as const;

    for (const [label, id] of cases) {
      const result = await open(`${PREFIX.view}${id}`, TG.owner);
      expect(result.replyKey, `${label} did not answer customer_gone`).toBe(
        'bot.admin.customer_gone',
      );
    }

    /*
     * A malformed id is refused at the BOUNDARY, before any intent exists, so it
     * answers `bot.unsupported` rather than `customer_gone`. That is a fact about the
     * callback's shape and not about this installation's customers, which is why the
     * two answers may differ here and must not differ above.
     */
    const malformed = await open(`${PREFIX.view}not-a-uuid`, TG.owner);
    expect(malformed.replyKey).toBe('bot.unknown_command');
  });

  it('finds a customer by the numeric Telegram id an operator quotes', async () => {
    sent = [];
    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate(`/customer ${SUBJECT}`, TG.owner),
    );

    expect(result.replyKey).toBe('bot.admin.customer_detail');
    expect(lastMessage()).toContain('ali_tehran');
  });

  it('answers the lookup with the syntax for anything that is not a Telegram id', async () => {
    /*
     * The shape is checked against `telegramUserIdSchema`, the CONTRACT's own, and the
     * last three rows are why that matters rather than a regex written here.
     *
     * A Codex round on this PR found the first version — `/^\d{1,32}$/` — accepting a
     * leading zero and up to thirty-two digits, neither of which any Telegram account
     * has. Those reached `list`, which trusts its `CustomerSearch` and validates
     * nothing, spent `users.search` on a value that cannot match, and came back
     * `bot.admin.customer_gone`: the sentence saying the person does not exist, for a
     * string that is not an identifier at all.
     */
    for (const text of [
      '/customer',
      '/customer nobody',
      '/customer 0123456789',
      `/customer ${'1'.repeat(25)}`,
      '/customer 555-100-200',
    ]) {
      sent = [];
      const result = await runtime().handle(
        tenantA,
        systemActor('bot'),
        adminUpdate(text, TG.owner),
      );
      expect(result.replyKey, text).toBe('bot.admin.customer_usage');
    }
  });

  it('gives the same one answer for a Telegram id that matches nobody', async () => {
    sent = [];
    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate('/customer 999000111', TG.owner),
    );
    expect(result.replyKey).toBe('bot.admin.customer_gone');
  });

  it('never finds another tenant’s customer by their Telegram id', async () => {
    await makeCustomer(tenantB, '555444333', { username: 'theirs' });

    sent = [];
    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate('/customer 555444333', TG.owner),
    );
    expect(result.replyKey).toBe('bot.admin.customer_gone');
  });

  it('refuses the lookup for an administrator who may view but may not search', async () => {
    /*
     * `users.search` is charged ON TOP of `users.view`, and the two are separate keys
     * because a list of a tenant's customers and a lookup of one specific person are
     * different questions. The refusal is the panel's single one — never
     * `customer_gone`, which would tell an administrator lacking the key that the id
     * names nobody.
     */
    await bindNewAdmin('viewer-no-search', TG.limited, { permissions: ['users.view'] });

    sent = [];
    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate(`/customer ${SUBJECT}`, TG.limited),
    );
    expect(result.replyKey).toBe('bot.admin.refused');

    /* And the list, which charges only `users.view`, still works for them. */
    const listed = await open(PREFIX.customers, TG.limited);
    expect(listed.replyKey).toBe('bot.admin.customers_section');
  });

  // =========================================================================
  // The two writes
  // =========================================================================

  it('draws no status button for an administrator who may view and not block', async () => {
    await bindNewAdmin('viewer-no-block', TG.limited, {
      permissions: ['users.view', 'users.search'],
    });

    const result = await open(`${PREFIX.view}${customerId}`, TG.limited);

    expect(result.replyKey).toBe('bot.admin.customer_detail');
    expect(lastMessage(), 'a control whose press records a denial was drawn').not.toContain(
      PREFIX.block,
    );
  });

  it('refuses the block callback from that same administrator, and changes nothing', async () => {
    /*
     * The other half of the case above, which is the half that counts: not drawing a
     * button is never authorization. The service charges `users.block` through the
     * guard and re-checks it inside the writing transaction.
     */
    await bindNewAdmin('viewer-no-block-2', TG.limited, {
      permissions: ['users.view', 'users.search'],
    });

    const result = await open(`${PREFIX.block}${customerId}`, TG.limited);

    expect(result.replyKey).toBe('bot.admin.refused');
    expect((await ctx.container.customers.get(tenantA, owner, customerId)).status).toBe('ACTIVE');
  });

  it('blocks a customer, and the reply offers the unblock rather than the block again', async () => {
    const result = await open(`${PREFIX.block}${customerId}`, TG.owner);

    expect(result.replyKey).toBe('bot.admin.customer_status_changed');
    const after = await ctx.container.customers.get(tenantA, owner, customerId);
    expect(after.status).toBe('BLOCKED');
    expect(after.blockedReason, 'the block recorded no operator note').not.toBeNull();

    /* ONE builder for the read and the write, so the new state's buttons are drawn. */
    expect(lastMessage()).toContain(`${PREFIX.unblock}${customerId}`);
    expect(lastMessage()).not.toContain(`${PREFIX.block}${customerId}`);
  });

  it('unblocks, and clears the reason so a stale one cannot read as current', async () => {
    await open(`${PREFIX.block}${customerId}`, TG.owner);
    const result = await open(`${PREFIX.unblock}${customerId}`, TG.owner);

    expect(result.replyKey).toBe('bot.admin.customer_status_changed');
    const after = await ctx.container.customers.get(tenantA, owner, customerId);
    expect(after.status).toBe('ACTIVE');
    expect(after.blockedReason).toBeNull();
    expect(after.blockedAt).toBeNull();
  });

  it('a second tap on the same button is a no-op, not a toggle back', async () => {
    /*
     * The callback carries the TARGET status rather than "flip it", which is the whole
     * reason it is spelled `9:b:` and not `9:t:`. A redelivered update — Telegram
     * retries, and a slow connection invites a second tap — writes BLOCKED twice, which
     * the conditional UPDATE answers as a successful no-op. A toggle would have
     * unblocked somebody the operator had just blocked.
     *
     * Two DIFFERENT updates, so the idempotency store is not what makes this pass:
     * each carries its own key, and the property being tested is the callback's shape.
     */
    await open(`${PREFIX.block}${customerId}`, TG.owner);
    const second = await open(`${PREFIX.block}${customerId}`, TG.owner);

    expect(second.replyKey).toBe('bot.admin.customer_status_changed');
    expect((await ctx.container.customers.get(tenantA, owner, customerId)).status).toBe('BLOCKED');
  });

  it('never blocks another tenant’s customer', async () => {
    const theirs = await makeCustomer(tenantB, '555222111', {});

    const result = await open(`${PREFIX.block}${theirs}`, TG.owner);

    /*
     * The panel's single refusal, not `customer_gone`.
     *
     * The two writes have no catch of their own, deliberately: `setStatus` carries
     * every refusal they need and nothing they could usefully say back. So a write
     * against an id that is not this tenant's answers the same way every other denied
     * write does, and a reader comparing it against the READ's `customer_gone` learns
     * nothing either way — both are "no" for every id they do not own.
     */
    expect(result.replyKey).toBe('bot.admin.refused');
    /*
     * Read back in RAW SQL, deliberately.
     *
     * Reading through the service would need an actor of tenant B, and the thing being
     * checked is the row — that no write landed on it. A raw read cannot be satisfied
     * by the same tenant predicate that was supposed to prevent the write.
     */
    const rows = await ctx.container.database.db.execute(
      sql`SELECT status FROM customers WHERE id = ${theirs}`,
    );
    expect((rows.rows[0] as { status: string } | undefined)?.status).toBe('ACTIVE');
  });

  it('writes an audit row naming the administrator who blocked', async () => {
    await open(`${PREFIX.block}${customerId}`, TG.owner);

    const rows = await ctx.container.database.db.execute(sql`
      SELECT actor_id, actor_type, action, result, source_surface FROM audit_logs
      WHERE tenant_id = ${tenantA.tenantId} AND entity_id = ${customerId}
      ORDER BY occurred_at DESC LIMIT 1`);
    const row = rows.rows[0] as Record<string, unknown> | undefined;
    expect(row, 'the block left no audit row').toBeDefined();
    expect(row?.['actor_id'], 'the row does not name the administrator').toBe(ownerAId);
    expect(row?.['actor_type']).toBe('TELEGRAM_ADMIN');
    expect(row?.['source_surface']).toBe('TELEGRAM');
    expect(row?.['result']).toBe('SUCCESS');
  });

  // =========================================================================
  // Helpers
  // =========================================================================

  const runtime = () => ctx.container.botRuntime;
  const messages = () => sent.filter((one) => one.url.includes('/sendMessage'));
  const lastBody = () => messages()[messages().length - 1]?.body;
  const lastMessage = () => JSON.stringify(messages()[messages().length - 1] ?? {});

  /** One tap, with the outbound record cleared first so `lastMessage` is this turn's. */
  const open = async (data: string, telegramUserId: string) => {
    sent = [];
    return runtime().handle(tenantA, systemActor('bot'), tapUpdate(data, telegramUserId));
  };

  const bind = (adminId: AdminId, telegramUserId: string) =>
    ctx.container.adminManagement.setTelegramBinding(tenantA, owner, adminId, {
      telegramUserId,
      reason: 'test binding',
    });

  /** The next-page token out of the drawn keyboard, or null when no button carries one. */
  function pageTokenFrom(body: Record<string, unknown> | undefined): string | null {
    const markup = body?.['reply_markup'] as
      { inline_keyboard?: { callback_data?: string }[][] } | undefined;
    for (const row of markup?.inline_keyboard ?? []) {
      for (const button of row) {
        const data = button.callback_data ?? '';
        if (data.startsWith(PREFIX.customers) && data.length > PREFIX.customers.length) {
          return data.slice(PREFIX.customers.length);
        }
      }
    }
    return null;
  }

  /** A customer, through the same path a first `/start` takes. */
  async function makeCustomer(
    scope: typeof tenantA,
    telegramUserId: string,
    profile: { readonly username?: string },
  ): Promise<UserId> {
    const { customer } = await ctx.container.customers.resolveFromUpdate(
      scope,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: {
          id: Number(telegramUserId),
          first_name: 'کاربر',
          ...(profile.username === undefined ? {} : { username: profile.username }),
        },
        botInstanceId: scope === tenantA ? BOT_A : BOT_B,
      },
    );
    return customer.id;
  }

  /**
   * An administrator with either a seeded role or a hand-made one, bound to a chat.
   *
   * The `permissions` form exists for the cases about ONE key: no seeded role holds
   * `users.view` without `users.search` or without `users.block`, so a case that
   * borrowed one would be testing a different question.
   */
  async function bindNewAdmin(
    username: string,
    telegramUserId: string,
    grant: { roleKeys?: string[]; permissions?: string[] },
  ): Promise<AdminId> {
    const admin = await createAdmin(ctx.container, tenantA, {
      username,
      ...(grant.roleKeys === undefined ? {} : { roleKeys: grant.roleKeys }),
    });
    if (grant.permissions !== undefined) {
      const roleId = ctx.container.ids.uuid();
      await ctx.container.database.db.execute(sql`
        INSERT INTO roles (id, tenant_id, key, name, is_system)
        VALUES (${roleId}, ${tenantA.tenantId}, ${`custom_${username.replaceAll('-', '_')}`}, ${username}, false)`);
      for (const permission of grant.permissions) {
        await ctx.container.database.db.execute(sql`
          INSERT INTO role_permissions (tenant_id, role_id, permission_key)
          VALUES (${tenantA.tenantId}, ${roleId}, ${permission})`);
      }
      await ctx.container.database.db.execute(sql`
        INSERT INTO admin_roles (tenant_id, admin_id, role_id)
        VALUES (${tenantA.tenantId}, ${admin.id}, ${roleId})`);
    }
    await bind(admin.id as AdminId, telegramUserId);
    return admin.id as AdminId;
  }

  const baseUpdate = (payload: Record<string, unknown>, telegramUserId: string) => {
    updateSeq += 1;
    return {
      idempotencyKey: `bot-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: { update_id: updateSeq, ...payload },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'کاربر' },
    };
  };

  const adminUpdate = (text: string, telegramUserId: string) =>
    baseUpdate(
      {
        message: {
          message_id: updateSeq,
          date: 0,
          chat: { id: Number(telegramUserId), type: 'private' },
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'کاربر' },
          text,
        },
      },
      telegramUserId,
    );

  const tapUpdate = (data: string, telegramUserId: string) =>
    baseUpdate(
      {
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'کاربر' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: Number(telegramUserId), type: 'private' },
            from: { id: 999_999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId,
    );
});
