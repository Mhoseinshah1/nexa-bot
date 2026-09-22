import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SERVICE_REMINDER_DEFAULTS,
  type ActorContext,
  type AdminId,
  type BotInstanceId,
  type CorrelationId,
} from '@nexa/contracts';
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
 * The reminder thresholds are the TENANT'S, and both surfaces agree about them.
 *
 * The owner's correction to Phase 6C: Mirza's reminder crons were configurable, so
 * three days and eighty percent are settings rather than constants. CBR-003 and CBR-011
 * fix the shape — «a capability is a flag PLUS a configuration record», and the six
 * cron screens each take a single scalar — and CBR-013 with BC-SB-003 fix the defect to
 * avoid: seven of twelve legacy settings screens never print the value they replace, so
 * «an admin cannot read the current configuration without overwriting it».
 *
 * What this file proves, in four groups:
 *
 *   1. **The combination is validated, atomically.** A value that would put the two
 *      expiry warnings in the wrong order, or the three usage thresholds out of
 *      ascending order, is REFUSED and nothing is stored — and the refusal names which
 *      number is wrong rather than saying "invalid input" (BC-SB-004).
 *   2. **Disabling preserves, re-enabling restores.** A flag and a setting are
 *      different rows, so turning a family off cannot reset its numbers. That is true
 *      by construction and is asserted anyway, because "by construction" is what every
 *      silently-reverted rule was before it was reverted.
 *   3. **The worker obeys the tenant, not the code.** A changed threshold changes which
 *      reminder fires; a disabled family fires nothing; and the two tenants do not see
 *      each other's configuration.
 *   4. **Both surfaces, one path.** The Telegram section reads through the same
 *      services the Web Admin does, is gated on the same two permissions, and its write
 *      is refused by the same guard.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const GIGABYTE = 1_073_741_824n;
const ALLOWANCE = 50n * GIGABYTE;

/** Every callback this section owns, spelled out rather than imported. */
const PREFIX = {
  section: '0:',
  edit: '1:',
  set: '2:',
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

describe('the reminder thresholds are configuration, not constants', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let owner: ActorContext;
  let panelA: string;
  let customerA: string;
  let updateSeq = 0;
  let n = 0;
  const key = (): string => `reminder-cfg-${(n += 1)}`;

  /** The Telegram accounts each case draws from. */
  const TG = {
    /** `owner`: every permission, including both edits. */
    owner: '720001',
    /** Both READ permissions and neither edit. */
    reader: '720002',

    /*
     * No permission that opens ANY section of the panel.
     *
     * It was `sales` until WP2, when the customers section made `users.view` a
     * section key and `sales` therefore an administrator with a panel. The case
     * reading this builds a role holding `reports.view` alone instead.
     */
    stranger: '720004',
  } as const;

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
    const seeded = await createAdmin(ctx.container, tenantA, {
      username: 'owner-reminders',
      roleKeys: ['owner'],
    });
    owner = adminActorFor(seeded);
    await bind(seeded.id as AdminId, TG.owner);

    panelA = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    customerA = await customer(tenantA, '921001');
  });

  // =========================================================================
  // 1. The combination, validated atomically
  // =========================================================================

  it('starts every tenant on the documented defaults', async () => {
    expect(await config()).toEqual(SERVICE_REMINDER_DEFAULTS);
  });

  it('refuses an expiry pair in the wrong order, and stores nothing', async () => {
    /*
     * One is the floor and the first threshold must be further out than the second, so
     * setting the FIRST to one day is the collision. The refusal names the rule; a
     * `⭕️ ورودی نا معتبر` would not (BC-SB-004).
     */
    const refusal = await setSetting('reminders.expiry_first_days', 1);
    expect(refusal).toMatch(/یادآور اول/);
    expect((await config()).expiryFirstDays, 'nothing was stored').toBe(3);
  });

  it('refuses usage thresholds that are not strictly increasing', async () => {
    const refusal = await setSetting('reminders.usage_second_percent', 80);
    expect(refusal).toMatch(/صعودی/);
    expect((await config()).usageSecondPercent).toBe(95);
  });

  it('allows a multi-step change to pass through a valid intermediate', async () => {
    /*
     * 3/1 to 10/5 is two writes and the combination is judged on each. The route
     * through 10/1 is valid, so both steps are accepted — and the point is the one the
     * guard's docblock makes: there is no window in which the worker could read a
     * combination the guard would have rejected, because a step that would produce one
     * is refused rather than stored and corrected afterwards.
     */
    expect(await setSetting('reminders.expiry_first_days', 10)).toBeNull();
    expect(await setSetting('reminders.expiry_second_days', 5)).toBeNull();
    const after = await config();
    expect([after.expiryFirstDays, after.expirySecondDays]).toEqual([10, 5]);
  });

  it('refuses a value outside the contract bounds before the combination is asked', async () => {
    await expect(
      ctx.container.settingsService.set(tenantA, owner, {
        idempotencyKey: key(),
        key: 'reminders.usage_first_percent',
        value: 0,
        expectedVersion: null,
      }),
    ).rejects.toThrow();
    expect((await config()).usageFirstPercent).toBe(80);
  });

  // =========================================================================
  // 2. Disabling preserves, re-enabling restores
  // =========================================================================

  it('keeps a family’s configured values across disabling and re-enabling it', async () => {
    expect(await setSetting('reminders.usage_first_percent', 60)).toBeNull();
    expect(await setSetting('reminders.usage_second_percent', 70)).toBeNull();

    await setFlag('service_usage_reminders', false);
    expect((await config()).usageEnabled).toBe(false);
    /*
     * The values SURVIVE, because a flag and a setting are different rows and nothing
     * but an administrator writes the second. Asserted rather than assumed: this is the
     * requirement that would be silently broken by any future "reset to defaults when
     * turning off" convenience.
     */
    expect((await config()).usageFirstPercent).toBe(60);
    expect((await config()).usageSecondPercent).toBe(70);

    await setFlag('service_usage_reminders', true);
    const restored = await config();
    expect([restored.usageFirstPercent, restored.usageSecondPercent]).toEqual([60, 70]);
    expect(restored.usageEnabled).toBe(true);
  });

  // =========================================================================
  // 3. The worker obeys the tenant
  // =========================================================================

  it('fires at the tenant’s threshold and not at the default', async () => {
    /*
     * Ten days out is nothing under the default three, and the FIRST warning under a
     * configured fourteen. The same service, the same clock, a different answer —
     * which is the whole correction in one assertion.
     */
    const id = await service({ expiresInDays: 10 });
    expect(await sweep()).toEqual({ expiry: 0, usage: 0 });

    expect(await setSetting('reminders.expiry_first_days', 14)).toBeNull();
    expect(await sweep()).toEqual({ expiry: 1, usage: 0 });
    expect(await reminderKinds(id)).toEqual(['EXPIRY_FIRST']);
    expect(await notificationKinds()).toEqual(['SERVICE_EXPIRY_FIRST']);
  });

  it('fires at a changed usage threshold and not at the default', async () => {
    const id = await service({ expiresInDays: 30, usedBytes: (ALLOWANCE * 60n) / 100n });
    expect(await sweep()).toEqual({ expiry: 0, usage: 0 });

    expect(await setSetting('reminders.usage_first_percent', 50)).toBeNull();
    expect(await sweep()).toEqual({ expiry: 0, usage: 1 });
    expect(await reminderKinds(id)).toEqual(['USAGE_FIRST']);
  });

  it('says nothing at all while a family is disabled', async () => {
    await service({ expiresInDays: 2, usedBytes: ALLOWANCE });
    await setFlag('service_expiry_reminders', false);
    await setFlag('service_expired_notice', false);
    await setFlag('service_usage_reminders', false);

    expect(await sweep()).toEqual({ expiry: 0, usage: 0 });
    expect(await notificationKinds()).toEqual([]);
  });

  it('still sends the expired notice when only the advance warnings are off', async () => {
    /*
     * The two flags are independent, and the window NARROWS when the advance warnings
     * are off: a service three days out is not a candidate for anything, so the pass
     * does not hand itself two hundred rows it must then skip.
     */
    const soon = await service({ expiresInDays: 2 });
    const past = await service({ expiresInDays: -1, state: 'EXPIRED' });
    await setFlag('service_expiry_reminders', false);

    expect(await sweep()).toEqual({ expiry: 1, usage: 0 });
    expect(await reminderKinds(soon)).toEqual([]);
    expect(await notificationKinds()).toEqual(['SERVICE_EXPIRED']);
    /* The two it passed through are recorded, so re-enabling cannot back-fill them. */
    expect(await reminderKinds(past)).toEqual(['EXPIRED', 'EXPIRY_FIRST', 'EXPIRY_SECOND']);
  });

  it('records a suppressed kind so re-enabling does not back-fill it', async () => {
    const id = await service({ expiresInDays: -1, state: 'EXPIRED' });
    await setFlag('service_expired_notice', false);

    expect(await sweep()).toEqual({ expiry: 0, usage: 0 });
    expect(await reminderKinds(id), 'recorded, not skipped').toEqual([
      'EXPIRED',
      'EXPIRY_FIRST',
      'EXPIRY_SECOND',
    ]);

    await setFlag('service_expired_notice', true);
    expect(await sweep(), 'no flood of back-dated notices').toEqual({ expiry: 0, usage: 0 });
    expect(await notificationKinds()).toEqual([]);
  });

  it('does not let one tenant’s configuration reach another', async () => {
    expect(await setSetting('reminders.expiry_first_days', 14)).toBeNull();

    const foreignOwner = adminActorFor(
      await createAdmin(ctx.container, tenantB, {
        username: 'owner-reminders-b',
        roleKeys: ['owner'],
      }),
    );
    const theirs = await ctx.container.settingsService.get(
      tenantB,
      foreignOwner,
      'reminders.expiry_first_days',
    );
    expect(theirs.value, 'tenant B is still on the default').toBe(3);
  });

  // =========================================================================
  // 4. Both surfaces, one path
  // =========================================================================

  it('prints every current value in the Telegram section before anything is editable', async () => {
    expect(await setSetting('reminders.expiry_first_days', 7)).toBeNull();
    await setFlag('service_usage_reminders', false);

    const result = await open(PREFIX.section, TG.owner);
    expect(result.replyKey).toBe('bot.admin.reminders_section');
    const text = lastMessage();
    /* The CURE for BC-SB-003: the value is printed, not asked for. */
    expect(text).toContain('7');
    expect(text).toContain('95');
    expect(text).toContain('❌');
    /* And a chooser for each of the five. */
    for (const code of ['ef', 'es', 'uf', 'us', 'un']) {
      expect(text, `a chooser for ${code}`).toContain(`${PREFIX.edit}${code}`);
    }
  });

  it('writes a threshold from a tap, through the same service the Web Admin uses', async () => {
    const result = await open(`${PREFIX.set}uf:70`, TG.owner);
    expect(result.replyKey).toBe('bot.admin.reminder_saved');
    expect((await config()).usageFirstPercent).toBe(70);
  });

  it('renders the guard’s own reason when a tap would break the order', async () => {
    const result = await open(`${PREFIX.set}us:80`, TG.owner);
    expect(result.replyKey).toBe('bot.admin.reminder_refused');
    expect(lastMessage()).toContain('صعودی');
    expect((await config()).usageSecondPercent, 'nothing was stored').toBe(95);
  });

  it('refuses a crafted setting code and a crafted value at the boundary', async () => {
    /*
     * All three are UNSUPPORTED at the PARSER, before any intent exists — a crafted
     * code is not a settings key assembled downstream and a crafted value is not a
     * number passed to the guard. `bot.unknown_command` is what an UNSUPPORTED
     * callback renders, which is the same answer every unreadable callback in this
     * surface gets, and deliberately says nothing about which of them it was.
     */
    const badCode = await open(`${PREFIX.edit}zz`, TG.owner);
    expect(badCode.replyKey).toBe('bot.unknown_command');
    const badValue = await open(`${PREFIX.set}uf:abc`, TG.owner);
    expect(badValue.replyKey).toBe('bot.unknown_command');
    const outOfRange = await open(`${PREFIX.set}uf:999`, TG.owner);
    expect(outOfRange.replyKey).toBe('bot.unknown_command');
    expect((await config()).usageFirstPercent, 'nothing reached a write').toBe(80);
  });

  it('draws the section for an administrator holding the read permission', async () => {
    /*
     * ONE permission, `settings.view`, and it covers both halves of the section.
     *
     * This asked for `settings.view` AND `features.view` — which reads sensibly and is
     * unsatisfiable: `features.view` is in no catalogue, so no role can hold it, so the
     * button was drawn for NOBODY. Feature flags are not separately permissioned in
     * this product: `FeatureFlagsService` charges `settings.view` to read and
     * `settings.edit` to write, in terms, and this surface now says the same.
     */
    await bindNewAdmin('reminder-reader', TG.reader, { permissions: ['settings.view'] });
    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate('/admin', TG.reader),
    );
    expect(result.replyKey).toBe('bot.admin.panel');
    expect(lastMessage()).toContain(PREFIX.section);
  });

  it('refuses the write to a reader who may not edit', async () => {
    /*
     * The half that the button cannot be. `settings.view` draws the section and reads
     * every value; `settings.edit` is what a tap on a threshold needs, and the guard —
     * not the keyboard — is what refuses one without it.
     */
    await bindNewAdmin('reminder-reader-2', TG.reader, { permissions: ['settings.view'] });
    const refused = await open(`${PREFIX.set}uf:70`, TG.reader);
    expect(refused.replyKey).toBe('bot.admin.refused');
    expect((await config()).usageFirstPercent, 'unchanged').toBe(80);
  });

  it('shows an administrator with no settings permission no section at all', async () => {
    /*
     * A hand-made role holding `reports.view` alone — NOT `sales`, which was the
     * fixture until WP2 and stopped being one.
     *
     * This case needs an administrator with NO section of the panel at all, so
     * `adminTurn` returns null and the tap below is answered exactly as a stranger's
     * would be. `sales` was that until the customers section shipped: it holds
     * `users.view`, so it now HAS a section and its panel opens — correctly, and a
     * different case from this one. `reports.view` opens nothing in Telegram (WP5 gave `catalog.view` the categories
     * section, so it stopped being this fixture the way `sales` did).
     */
    await bindNewAdmin('reminder-stranger', TG.stranger, { permissions: ['reports.view'] });
    const menu = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate('/admin', TG.stranger),
    );
    expect(JSON.stringify(menu)).not.toContain(PREFIX.section);
    /*
     * And the tap gets nothing, because not drawing a button is never the control.
     *
     * `bot.unknown_command`, not a denial: an administrator with no section is not an
     * administrator as far as this surface is concerned, so a management callback from
     * them is answered exactly as a stranger's would be. Saying "refused" instead would
     * confirm that the section exists, which is a fact about other administrators.
     */
    const tapped = await open(PREFIX.section, TG.stranger);
    expect(tapped.replyKey).toBe('bot.unknown_command');
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  const runtime = () => ctx.container.botRuntime;
  const messages = () => sent.filter((one) => one.url.includes('/sendMessage'));
  const lastMessage = () => JSON.stringify(messages()[messages().length - 1] ?? {});

  const open = async (data: string, telegramUserId: string) => {
    sent = [];
    return runtime().handle(tenantA, systemActor('bot'), tapUpdate(data, telegramUserId));
  };

  const bind = (adminId: AdminId, telegramUserId: string) =>
    ctx.container.adminManagement.setTelegramBinding(tenantA, owner, adminId, {
      telegramUserId,
      reason: 'test binding',
    });

  const config = () => ctx.container.reminderConfig.read(tenantA, owner);

  const sweep = () => ctx.container.serviceReminderSweep.runOnce(tenantA);

  /**
   * Writes one threshold and returns the refusal, or `null` when it was accepted.
   *
   * The version is READ first rather than passed as `null`, and that is not a
   * convenience: `null` means "there is no tenant override", so it is right exactly
   * once per key. A second write with `null` is a stale-write conflict, which is the
   * guard doing its job — these tests are about what the thresholds DO, so they carry
   * the current version the way a surface that has just rendered the value does.
   * The stale-write guard has its own case below, where the staleness is deliberate.
   */
  async function setSetting(settingKey: string, value: number): Promise<string | null> {
    try {
      const before = await ctx.container.settingsService.get(tenantA, owner, settingKey);
      await ctx.container.settingsService.set(tenantA, owner, {
        idempotencyKey: key(),
        key: settingKey,
        value,
        expectedVersion: before.version,
      });
      return null;
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** The same, for a flag. See `setSetting` on why the version is read and not `null`. */
  async function setFlag(flagKey: string, enabled: boolean): Promise<unknown> {
    const before = (await ctx.container.featureFlags.list(tenantA, owner)).find(
      (flag) => flag.key === flagKey,
    );
    if (before === undefined) throw new Error(`no such feature flag: ${flagKey}`);
    return ctx.container.featureFlags.set(tenantA, owner, {
      idempotencyKey: key(),
      key: flagKey,
      enabled,
      expectedVersion: before.version,
      confirmKey: flagKey,
      reason: 'test toggle of a tenant-wide reminder switch',
    });
  }

  async function customer(
    scope: typeof tenantA | typeof tenantB,
    telegramUserId: string,
  ): Promise<string> {
    const { customer: record } = await ctx.container.customers.resolveFromUpdate(
      scope,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'زهرا' },
        botInstanceId: BOT_A,
      },
    );
    return record.id;
  }

  /**
   * A live service, written directly.
   *
   * Direct SQL for the reason `service-reminders.test.ts` gives: these cases need a
   * service in a particular STATE, and a provisioning run reaches none of them.
   */
  async function service(options: {
    readonly expiresInDays: number;
    readonly state?: string;
    readonly usedBytes?: bigint;
  }): Promise<string> {
    const orderId = ctx.container.ids.uuid();
    const productId = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO products (id, tenant_id, title, description, audience, sort_order, panel_id,
                            duration_days, traffic_bytes, device_limit, price_amount,
                            price_currency, status)
      VALUES (${productId}, ${tenantA.tenantId}, 'پلن', 'یک ماهه', 'EVERYONE', 10, ${panelA},
              30, ${ALLOWANCE}, 2, 250000, 'IRT', 'ACTIVE')`);
    /*
     * The order's own column names, which are NOT the product's. `line_*` is the
     * SNAPSHOT of what was bought and `total_amount`/`currency` the money — the shape
     * `telegram-payment-flow.test.ts` writes, copied rather than reinvented.
     */
    await ctx.container.database.db.execute(sql`
      INSERT INTO orders (id, tenant_id, customer_id, state, product_id, panel_id, purpose,
                          line_title, line_duration_days, line_traffic_bytes,
                          line_device_limit, line_unit_price_amount, line_quantity,
                          subtotal_amount, discount_amount, total_amount, currency, quote,
                          confirmed_at, settled_at)
      VALUES (${orderId}, ${tenantA.tenantId}, ${customerA}, 'PAID', ${productId}, ${panelA},
              'NEW_SERVICE', 'پلن', 30, ${ALLOWANCE}, 2, 250000, 1, 250000, 0, 250000, 'IRT',
              '{"trace":[]}'::jsonb, now(), now())`);
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                            provider_username, subscription_ref, provider_client_id,
                            traffic_limit_bytes, traffic_used_bytes, usage_synced_at,
                            state, provisioned_at, terminated_at, expires_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customerA}, ${orderId}, ${panelA}, ${productId},
              ${'u' + Math.random().toString(16).slice(2, 12)},
              ${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)},
              ${ctx.container.ids.uuid()},
              ${ALLOWANCE}, ${options.usedBytes ?? 0n}, now(),
              ${options.state ?? 'ACTIVE'}, now(), NULL,
              now() + make_interval(secs => ${options.expiresInDays * 86_400}))`);
    return id;
  }

  async function reminderKinds(serviceId: string): Promise<readonly string[]> {
    const result = await ctx.container.database.db.execute(sql`
      SELECT kind FROM service_reminders WHERE service_id = ${serviceId} ORDER BY kind ASC`);
    return (result.rows as unknown as Record<string, string>[]).map((row) => row.kind as string);
  }

  async function notificationKinds(): Promise<readonly string[]> {
    const result = await ctx.container.database.db.execute(sql`
      SELECT kind FROM customer_notifications ORDER BY created_at ASC, kind ASC`);
    return (result.rows as unknown as Record<string, string>[]).map((row) => row.kind as string);
  }

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
