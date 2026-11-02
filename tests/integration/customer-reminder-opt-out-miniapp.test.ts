import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  miniAppPath,
  miniAppRemindersSchema,
  type ActorContext,
  type BotInstanceId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  testConfig,
  type TestContext,
} from './harness';

/**
 * Round 11, B6 — the mini app's half of the customer's reminder switch, over real HTTP.
 *
 * The endpoint adds no business logic: it calls the same `CustomerService.setRemindersOptOut`
 * the bot's button calls. What only this layer can show: the setting belongs to the SESSION's
 * customer and to nobody a body names; a session for another customer cannot move it; the
 * choice is not offered (and a write is refused, storing nothing) while the installation has
 * the `customer_reminder_opt_out` flag off; and the change is audited under the mini app's own
 * surface.
 */

const BOT_A1 = SEED_IDS.botA1 as BotInstanceId;
const TOKEN_A1 = '000000:seed-token-acme-1';
const ROUTE = `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.reminders)}`;

function initDataFor(user: { id: number; first_name: string }): string {
  const fields: Record<string, string> = {
    query_id: `q-${String(user.id)}-${String(Math.random()).slice(2, 10)}`,
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const check = Object.keys(fields)
    .sort()
    .map((field) => `${field}=${fields[field]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN_A1).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe('the mini app reminder switch (R11 B6)', () => {
  let ctx: TestContext;
  let api: ApiApp;
  let telegram: Server;
  let owner: ActorContext;
  let keySeq = 0;
  const distDir = mkdtempSync(join(tmpdir(), 'nexa-miniapp-rem-'));

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const key = () => `mini-rem-${String((keySeq += 1)).padStart(6, '0')}-abcdef`;

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>mini</title>');
    const env = {
      MINIAPP_DIST_DIR: distDir,
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    };
    ctx = await createTestContext(env);
    api = await createApiApp(testConfig(env));
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await ctx?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
    rmSync(distDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    api.container.setInstallationTenant(tenantA.tenantId);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'rem-owner', roleKeys: ['owner'] }),
    );
    await setFlag('mini_app', true);
  });

  async function setFlag(flag: string, enabled: boolean) {
    const current = await ctx.container.featureFlagResolver.resolve(tenantA, flag as never);
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: flag as never,
      enabled,
      expectedVersion: current.version,
      idempotencyKey: key(),
      reason: 'mini-app reminder test',
    });
  }

  async function sessionFor(telegramUserId: number): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.session, { botInstanceId: BOT_A1 })}`,
      payload: { initData: initDataFor({ id: telegramUserId, first_name: 'مشتری' }) },
    });
    expect(response.statusCode, response.body).toBe(201);
    return (JSON.parse(response.body) as { token: string }).token;
  }

  const read = (token: string) =>
    inject({ method: 'GET', url: ROUTE, headers: { authorization: `Bearer ${token}` } });
  const write = (token: string, payload: unknown, idempotencyKey = key()) =>
    inject({
      method: 'POST',
      url: ROUTE,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
      payload,
    });

  const storedOptOut = async (telegramUserId: number): Promise<Date | null> => {
    const result = await ctx.container.database.db.execute(
      sql`SELECT reminders_opt_out_at AS at FROM customers
           WHERE tenant_id = ${tenantA.tenantId} AND telegram_user_id = ${String(telegramUserId)}`,
    );
    return (result.rows[0] as { at: Date | null } | undefined)?.at ?? null;
  };

  it('is not offered while the flag is off: the read says so, a write is refused and stores nothing', async () => {
    const token = await sessionFor(970001);
    const state = miniAppRemindersSchema.parse(JSON.parse((await read(token)).body));
    expect(state).toEqual({ offered: false, enabled: true });

    const refused = await write(token, { enabled: false });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(JSON.parse(refused.body).error.code).toBe('miniapp.route_unavailable');
    expect(await storedOptOut(970001)).toBeNull();
  });

  it('switches the session’s own customer off and on, and nobody else', async () => {
    await setFlag('customer_reminder_opt_out', true);
    const mine = await sessionFor(970001);
    const theirs = await sessionFor(970002);

    expect(miniAppRemindersSchema.parse(JSON.parse((await read(mine)).body))).toEqual({
      offered: true,
      enabled: true,
    });

    // A body that tries to name another customer is not read: the strict contract names only
    // the wanted state, and whose setting it is comes from the session.
    const customerTwo = (
      await ctx.container.database.db.execute(
        sql`SELECT id FROM customers WHERE telegram_user_id = '970002'`,
      )
    ).rows[0] as { id: string };
    const off = await write(mine, { enabled: false, customerId: customerTwo.id });
    expect(off.statusCode, off.body).toBe(201);
    expect(miniAppRemindersSchema.parse(JSON.parse(off.body))).toEqual({
      offered: true,
      enabled: false,
    });
    expect(await storedOptOut(970001)).not.toBeNull();
    expect(await storedOptOut(970002)).toBeNull();

    // The other customer's session sees its own state and cannot move mine.
    expect(miniAppRemindersSchema.parse(JSON.parse((await read(theirs)).body)).enabled).toBe(true);
    expect(miniAppRemindersSchema.parse(JSON.parse((await read(mine)).body)).enabled).toBe(false);
    const stillOff = await write(theirs, { enabled: true });
    expect(stillOff.statusCode).toBe(201);
    expect(await storedOptOut(970001)).not.toBeNull();

    const on = await write(mine, { enabled: true });
    expect(miniAppRemindersSchema.parse(JSON.parse(on.body)).enabled).toBe(true);
    expect(await storedOptOut(970001)).toBeNull();
  });

  it('is idempotent and audited under the mini app’s surface', async () => {
    await setFlag('customer_reminder_opt_out', true);
    const token = await sessionFor(970001);
    const first = await write(token, { enabled: false }, 'same-key-000000-abcdef');
    const replay = await write(token, { enabled: false }, 'same-key-000000-abcdef');
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    const again = await write(token, { enabled: false });
    expect(again.statusCode).toBe(201);

    const events = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'CustomerReminderOptOutChanged'`,
    );
    expect((events.rows[0] as { n: number }).n).toBe(1);
    const audits = await ctx.container.database.db.execute(
      sql`SELECT source_surface FROM audit_logs WHERE action = 'customer.reminders_opt_out'`,
    );
    expect(audits.rows.length).toBeGreaterThan(0);
    expect(
      audits.rows.every((row) => (row as { source_surface: string }).source_surface === 'MINI_APP'),
    ).toBe(true);
  });

  it('needs a session, and a malformed body is refused without a write', async () => {
    await setFlag('customer_reminder_opt_out', true);
    expect((await inject({ method: 'GET', url: ROUTE })).statusCode).toBe(401);
    const token = await sessionFor(970001);
    const bad = await write(token, { enabled: 'no' });
    expect(bad.statusCode).toBe(400);
    expect(await storedOptOut(970001)).toBeNull();
    const missingKey = await inject({
      method: 'POST',
      url: ROUTE,
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: false },
    });
    expect(missingKey.statusCode).toBe(400);
    expect(await storedOptOut(970001)).toBeNull();
  });
});
