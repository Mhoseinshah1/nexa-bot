import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorContext } from '@nexa/contracts';
import { tenantA } from './harness';
import {
  TG,
  customerNamed,
  customerStatus,
  lastKeyboard,
  pendingWithReceipt,
  receiptFixture,
  rows,
  say,
  tap,
  type ReceiptFixture,
} from './receipt-review-fixture';

/**
 * A customer block is remembered under the surface that asked for it (OQ-WP10F-04).
 *
 * `CustomerService.setStatus` recorded every block's idempotency key under `WEB`, whatever
 * surface the command came from: a Telegram administrator's block claimed to be a Web one,
 * and the same key string from the two surfaces answered for each other. The namespace is now
 * the ACTOR's surface — the value the audit row already records as `source_surface` — so the
 * two records agree by construction.
 */
describe('customer block idempotency is namespaced by the initiating surface', () => {
  let f: ReceiptFixture;
  let telegramOwner: ActorContext;

  beforeAll(async () => {
    f = await receiptFixture();
  }, 120_000);

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    telegramOwner = { ...f.owner, type: 'TELEGRAM_ADMIN', surface: 'TELEGRAM' };
  });

  async function idempotencyRows(key: string): Promise<{ scope_ref: string; key: string }[]> {
    return rows(
      f,
      sql`SELECT scope_ref, key FROM request_idempotency WHERE key = ${key} ORDER BY created_at`,
    );
  }

  async function blockAudits(customerId: string): Promise<{ source_surface: string }[]> {
    return rows(
      f,
      sql`SELECT source_surface FROM audit_logs
           WHERE action = 'customer.block' AND entity_id = ${customerId}
           ORDER BY occurred_at`,
    );
  }

  const webRef = `${tenantA.tenantId}|WEB`;
  const telegramRef = `${tenantA.tenantId}|TELEGRAM`;

  it('a Web block is remembered under WEB and audited as WEB', async () => {
    await f.ctx.container.customers.block(tenantA, f.owner, {
      idempotencyKey: 'web-block-1',
      customerId: f.customer,
      reason: 'از وب',
    });

    expect(await idempotencyRows('web-block-1')).toEqual([
      { scope_ref: webRef, key: 'web-block-1' },
    ]);
    expect(await blockAudits(f.customer)).toEqual([{ source_surface: 'WEB' }]);
  });

  it('a Telegram administrator’s block is remembered under TELEGRAM and audited as TELEGRAM', async () => {
    await f.ctx.container.customers.block(tenantA, telegramOwner, {
      idempotencyKey: 'telegram-block-1',
      customerId: f.customer,
      reason: 'از تلگرام',
    });

    expect(await idempotencyRows('telegram-block-1')).toEqual([
      { scope_ref: telegramRef, key: 'telegram-block-1' },
    ]);
    expect(await blockAudits(f.customer)).toEqual([{ source_surface: 'TELEGRAM' }]);
  });

  it('a block from the receipt message is remembered under TELEGRAM, with the capture’s key', async () => {
    const payment = await pendingWithReceipt(f, 'surface-receipt');
    await tap(f, `xa:${payment}`, TG.owner);
    await tap(f, `xb:${payment}`, TG.owner);
    await say(f, 'رسید جعلی', TG.owner);
    const confirm = lastKeyboard(f).find((b) => b.callback_data?.startsWith('xc:'));
    const captureId = (confirm?.callback_data ?? '').slice('xc:'.length);
    expect((await tap(f, `xc:${captureId}`, TG.owner)).replyKey).toBe(
      'bot.admin.blocked_from_receipt',
    );

    const key = `receipt-block-capture:${captureId}`;
    expect(await idempotencyRows(key)).toEqual([{ scope_ref: telegramRef, key }]);
    expect(await blockAudits(f.customer)).toEqual([{ source_surface: 'TELEGRAM' }]);
  });

  it('a block from the Telegram Customers section is remembered under TELEGRAM, beside the update’s own record', async () => {
    expect((await tap(f, `9:b:${f.customer}`, TG.owner)).replyKey).toBe(
      'bot.admin.customer_status_changed',
    );
    expect((await customerStatus(f, f.customer)).status).toBe('BLOCKED');

    const recorded = await rows<{ scope_ref: string; key: string }>(
      f,
      sql`SELECT scope_ref, key FROM request_idempotency WHERE key LIKE '%:customer-status'`,
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.scope_ref).toBe(telegramRef);
    expect(await blockAudits(f.customer)).toEqual([{ source_surface: 'TELEGRAM' }]);
    // Nothing of it was written as WEB.
    const web = await rows(f, sql`SELECT key FROM request_idempotency WHERE scope_ref = ${webRef}`);
    expect(web).toEqual([]);
  });

  it('a retry on the same surface is a replay: one change, one audit row', async () => {
    const command = { idempotencyKey: 'telegram-retry', customerId: f.customer, reason: 'x' };
    const first = await f.ctx.container.customers.blockWithOutcome(tenantA, telegramOwner, command);
    const second = await f.ctx.container.customers.blockWithOutcome(
      tenantA,
      telegramOwner,
      command,
    );

    expect(first.changed).toBe(true);
    expect(second).toEqual(first);
    expect(await blockAudits(f.customer)).toHaveLength(1);
    expect(await idempotencyRows('telegram-retry')).toHaveLength(1);
  });

  it('the same key string from the other surface is its own command, not a replay of this one', async () => {
    const other = await customerNamed(f, '750931', 'other_surface');

    // A Web operator blocks one customer under a key...
    await f.ctx.container.customers.block(tenantA, f.owner, {
      idempotencyKey: 'shared-key',
      customerId: f.customer,
      reason: null,
    });
    // ...and a Telegram administrator's command that happens to carry the same string blocks
    // ANOTHER customer. Under one `WEB` namespace this was refused as a payload mismatch.
    const telegram = await f.ctx.container.customers.blockWithOutcome(tenantA, telegramOwner, {
      idempotencyKey: 'shared-key',
      customerId: other,
      reason: null,
    });

    expect(telegram).toMatchObject({ changed: true, customer: { id: other, status: 'BLOCKED' } });
    expect((await customerStatus(f, f.customer)).status).toBe('BLOCKED');
    expect((await idempotencyRows('shared-key')).map((row) => row.scope_ref).sort()).toEqual(
      [telegramRef, webRef].sort(),
    );
    expect(await blockAudits(other)).toEqual([{ source_surface: 'TELEGRAM' }]);
  });

  it('within one surface a reused key is still refused rather than applied to another customer', async () => {
    const other = await customerNamed(f, '750932', 'same_surface');
    await f.ctx.container.customers.block(tenantA, telegramOwner, {
      idempotencyKey: 'reused-telegram-key',
      customerId: f.customer,
      reason: null,
    });

    await expect(
      f.ctx.container.customers.block(tenantA, telegramOwner, {
        idempotencyKey: 'reused-telegram-key',
        customerId: other,
        reason: null,
      }),
    ).rejects.toMatchObject({ code: 'platform.idempotency_payload_mismatch' });
    expect((await customerStatus(f, other)).status).toBe('ACTIVE');
  });
});
