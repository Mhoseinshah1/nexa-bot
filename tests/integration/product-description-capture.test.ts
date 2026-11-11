import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
  PRODUCT_DESCRIPTION_MAX_LENGTH,
  customEmojiMarker,
  money,
  type CapturedEntity,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import { SEED_IDS, tenantA, tenantB } from './harness';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { decorateAppearance } from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';
import {
  BOT_A,
  TG,
  bindNewAdmin,
  customerNamed,
  receiptFixture,
  rows,
  systemActor,
  type ReceiptFixture,
} from './receipt-review-fixture';

/**
 * «ارسال توضیح از تلگرام», end to end through the real container, the real bot runtime and
 * PostgreSQL: the Web Admin opens a ten-minute single-use request, the bound administrator
 * sends or forwards the description to the bot, and the page reads it back with its premium
 * emoji. Nothing is ever written to the product by the capture itself.
 */
const ID_1 = '5368324170671202286';
const ID_2 = '5307996024738395492';
// Persian letters, then an astral emoji BEFORE the custom ones: UTF-16 offsets matter.
const TEXT = 'سلام 👋 این پلن عالی است 😀 با تخفیف 🔥';
const entity = (covered: string, id: string): CapturedEntity => ({
  type: 'custom_emoji',
  offset: TEXT.indexOf(covered),
  length: covered.length,
  custom_emoji_id: id,
});
const ENTITIES = [entity('😀', ID_1), entity('🔥', ID_2)];
const STORED = `سلام 👋 این پلن عالی است ${customEmojiMarker(ID_1, '😀')} با تخفیف ${customEmojiMarker(ID_2, '🔥')}`;

describe('«ارسال توضیح از تلگرام»', () => {
  let f: ReceiptFixture;
  let productId: string;
  let seq = 0;
  let updateSeq = 80_000_000;

  beforeAll(async () => {
    f = await receiptFixture();
  }, 120_000);
  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    const c = f.ctx.container;
    const created = await new DrizzleProductRepository(c.database.db).create(tenantA, {
      id: c.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ویژه',
        description: 'توضیح قدیمی',
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: f.panelA as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 1n, deviceLimit: null },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: c.clock.now(),
    });
    productId = created.id;
  });

  const capture = () => f.ctx.container.productDescriptionCapture;
  const key = (label: string) => `desc-capture-${label}-${String((seq += 1))}`;
  const open = (idempotencyKey = key('open'), actor = f.owner, id = productId) =>
    capture().open(tenantA, actor, { idempotencyKey, productId: id });

  /** A private message to bot A as Telegram delivers one, dated `at` (now by default). */
  function message(
    telegramUserId: string,
    body: Record<string, unknown>,
    options: { readonly at?: Date; readonly updateId?: number } = {},
  ) {
    f.sent = [];
    const id = options.updateId ?? (updateSeq += 1);
    const at = options.at ?? new Date();
    return f.ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: `desc-capture-update-${String(id)}`,
      botInstanceId: BOT_A,
      update: {
        update_id: id,
        message: {
          message_id: id,
          date: Math.floor(at.getTime() / 1000),
          chat: { id: Number(telegramUserId), type: 'private' },
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'کاربر' },
          ...body,
        },
      },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'کاربر' },
    });
  }
  const send = (
    telegramUserId: string,
    options: { readonly at?: Date; readonly updateId?: number } = {},
  ) => message(telegramUserId, { text: TEXT, entities: ENTITIES }, options);

  const requestRows = () =>
    rows<{ close_reason: string | null; captured_text: string | null }>(
      f,
      sql`SELECT close_reason, captured_text FROM product_description_captures ORDER BY opened_at`,
    );
  const productDescription = async () =>
    (
      await rows<{ description: string | null }>(
        f,
        sql`SELECT description FROM products WHERE id = ${productId}`,
      )
    )[0]?.description;
  const audits = () =>
    rows<{ action: string; actor_type: string }>(
      f,
      sql`SELECT action, actor_type FROM audit_logs
           WHERE entity_id = ${productId} AND action LIKE 'product.description_capture%'
             AND result = 'SUCCESS' ORDER BY occurred_at`,
    );
  const expire = (id: string) =>
    f.ctx.container.database.db.execute(
      sql`UPDATE product_description_captures
             SET opened_at = now() - interval '1 hour', expires_at = now() - interval '1 minute'
           WHERE id = ${id}`,
    );
  const codeOf = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return 'NO_ERROR';
  };

  it('round trip: open → the admin sends the text with premium emoji → the page reads the stored form → the same entities come back out', async () => {
    const opened = await open();
    expect(opened.state).toBe('OPEN');
    // Ten minutes, single use, and a link to open the bot's chat.
    expect(opened.expiresAt.getTime() - f.ctx.container.clock.now().getTime()).toBeLessThanOrEqual(
      10 * 60 * 1000,
    );
    expect(opened.bots.map((bot) => bot.chatUrl)).toEqual(['https://t.me/acme_store_bot']);
    expect(opened.description).toBeNull();

    const turn = await send(TG.owner);
    expect(turn.replyKey).toBe('bot.admin.description_capture_done');
    const read = await capture().read(tenantA, f.owner, productId, opened.captureId);
    expect(read.state).toBe('CAPTURED');
    expect(read.description).toBe(STORED);

    // The same entities out on send, and the covered emoji when the bot may not carry them.
    const decorated = decorateAppearance(read.description ?? '', 'PLAIN_TEXT', {
      customEmoji: new Map(),
      eligible: true,
    });
    expect(decorated.text).toBe(TEXT);
    expect(decorated.entities).toEqual(ENTITIES);
    expect(
      decorateAppearance(read.description ?? '', 'PLAIN_TEXT', { customEmoji: new Map() }).text,
    ).toBe(TEXT);

    // No silent save: the product is exactly as it was until the administrator presses Save.
    expect(await productDescription()).toBe('توضیح قدیمی');
    expect(await audits()).toEqual([
      { action: 'product.description_capture_open', actor_type: 'WEB_ADMIN' },
      { action: 'product.description_capture', actor_type: 'TELEGRAM_ADMIN' },
    ]);
  });

  it('a caption (a forwarded photo with words) is captured with its caption entities', async () => {
    const opened = await open();
    const turn = await message(TG.owner, {
      photo: [{ file_id: 'p1', file_unique_id: 'u1', width: 10, height: 10 }],
      caption: TEXT,
      caption_entities: ENTITIES,
    });
    expect(turn.replyKey).toBe('bot.admin.description_capture_done');
    expect((await capture().read(tenantA, f.owner, productId, opened.captureId)).description).toBe(
      STORED,
    );
  });

  it('is single use: a second message, and the same update replayed, change nothing', async () => {
    const opened = await open();
    await send(TG.owner, { updateId: 81_000_001 });
    // Telegram redelivers the very same update: the remembered answer, nothing new.
    expect((await send(TG.owner, { updateId: 81_000_001 })).replyKey).toBe(
      'bot.admin.description_capture_done',
    );
    // A further message belongs to no request and is an ordinary message.
    const second = await message(TG.owner, { text: 'یک پیام دیگر', entities: [] });
    expect(second.replyKey).not.toBe('bot.admin.description_capture_done');
    expect(await requestRows()).toEqual([{ close_reason: 'CAPTURED', captured_text: STORED }]);
    expect((await capture().read(tenantA, f.owner, productId, opened.captureId)).description).toBe(
      STORED,
    );
    expect(
      (await audits()).filter((row) => row.action === 'product.description_capture'),
    ).toHaveLength(1);
    // Opening is idempotent: the same key answers the same request.
    const replay = key('replay');
    expect((await open(replay)).captureId).toBe((await open(replay)).captureId);
  });

  it('expiry: a poll reads EXPIRED and writes nothing; a message after the deadline is answered «expired» once, captures nothing', async () => {
    const opened = await open();
    await expire(opened.captureId);
    expect((await capture().read(tenantA, f.owner, productId, opened.captureId)).state).toBe(
      'EXPIRED',
    );
    expect(await requestRows()).toEqual([{ close_reason: null, captured_text: null }]);
    expect((await send(TG.owner)).replyKey).toBe('bot.admin.description_capture_expired');
    expect(await requestRows()).toEqual([{ close_reason: 'EXPIRED', captured_text: null }]);
    // Closed: the next message is an ordinary one again.
    expect((await send(TG.owner)).replyKey).not.toBe('bot.admin.description_capture_expired');
    expect(await requestRows()).toEqual([{ close_reason: 'EXPIRED', captured_text: null }]);
  });

  it('a non-admin, an unbound account and another tenant’s account change nothing', async () => {
    const opened = await open();
    for (const stranger of [TG.customer, TG.tenantB, '999000111']) {
      expect((await send(stranger)).replyKey).not.toBe('bot.admin.description_capture_done');
    }
    expect(await requestRows()).toEqual([{ close_reason: null, captured_text: null }]);
    // The owner's own message still completes it afterwards.
    expect((await send(TG.owner)).replyKey).toBe('bot.admin.description_capture_done');
    expect((await capture().read(tenantA, f.owner, productId, opened.captureId)).state).toBe(
      'CAPTURED',
    );
  });

  it('a sender who lost catalog.edit is told «not allowed» and the request stays as it was', async () => {
    const editorId = await bindNewAdmin(f, 'editor-desc', TG.reviewer, [
      'catalog.view',
      'catalog.edit',
    ]);
    const editor = (await import('./harness')).adminActorFor(
      (await f.ctx.container.admins.findById(tenantA, editorId)) as never,
    );
    const opened = await open(key('editor'), editor);
    await f.ctx.container.database.db.execute(
      sql`DELETE FROM role_permissions WHERE permission_key = 'catalog.edit'
            AND role_id IN (SELECT role_id FROM admin_roles WHERE admin_id = ${editorId})`,
    );
    expect((await send(TG.reviewer)).replyKey).toBe('bot.admin.description_capture_denied');
    expect(await requestRows()).toEqual([{ close_reason: null, captured_text: null }]);
    expect(opened.state).toBe('OPEN');
  });

  it('a command, a menu tap and a message sent before the button are never a description', async () => {
    await open();
    await message(TG.owner, {
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    });
    await message(
      TG.owner,
      { text: TEXT, entities: ENTITIES },
      { at: new Date(Date.now() - 3_600_000) },
    );
    expect(await requestRows()).toEqual([{ close_reason: null, captured_text: null }]);
  });

  it('an empty or over-long message is refused and leaves the request open', async () => {
    const opened = await open();
    const long = 'ا'.repeat(PRODUCT_DESCRIPTION_MAX_LENGTH + 1);
    expect((await message(TG.owner, { text: long, entities: [] })).replyKey).toBe(
      'bot.admin.description_capture_rejected',
    );
    expect(await requestRows()).toEqual([{ close_reason: null, captured_text: null }]);
    expect((await send(TG.owner)).replyKey).toBe('bot.admin.description_capture_done');
    expect((await capture().read(tenantA, f.owner, productId, opened.captureId)).state).toBe(
      'CAPTURED',
    );
  });

  it('is bound to the administrator, the tenant and the product', async () => {
    const opened = await open();
    const other = await bindNewAdmin(f, 'other-editor', TG.third, ['catalog.view', 'catalog.edit']);
    const otherActor = (await import('./harness')).adminActorFor(
      (await f.ctx.container.admins.findById(tenantA, other)) as never,
    );
    // Another administrator cannot read it, nor can it be read under another product.
    expect(await codeOf(capture().read(tenantA, otherActor, productId, opened.captureId))).toBe(
      COMMERCE_ERROR_CODES.PRODUCT_DESCRIPTION_CAPTURE_NOT_FOUND,
    );
    expect(
      await codeOf(capture().read(tenantA, f.owner, f.ctx.container.ids.uuid(), opened.captureId)),
    ).toBe(COMMERCE_ERROR_CODES.PRODUCT_DESCRIPTION_CAPTURE_NOT_FOUND);
    // Another tenant's scope finds nothing, and cannot open one for this product.
    expect(
      await codeOf(capture().open(tenantB, f.owner, { idempotencyKey: key('x'), productId })),
    ).not.toBe('NO_ERROR');
    // Opening a second request supersedes the first, for the same administrator.
    const second = await open();
    expect((await capture().read(tenantA, f.owner, productId, opened.captureId)).state).toBe(
      'SUPERSEDED',
    );
    expect(second.state).toBe('OPEN');
  });

  it('refuses to open without a bound Telegram account, for an unknown product, and without catalog.edit', async () => {
    const unbound = await bindNewAdmin(f, 'unbound-editor', null, ['catalog.view', 'catalog.edit']);
    const unboundActor = (await import('./harness')).adminActorFor(
      (await f.ctx.container.admins.findById(tenantA, unbound)) as never,
    );
    expect(await codeOf(open(key('unbound'), unboundActor))).toBe(
      COMMERCE_ERROR_CODES.PRODUCT_DESCRIPTION_CAPTURE_TELEGRAM_UNLINKED,
    );
    expect(await codeOf(open(key('nope'), f.owner, f.ctx.container.ids.uuid()))).toBe(
      COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND,
    );
    const viewer = await bindNewAdmin(f, 'viewer-only', TG.observer, ['catalog.view']);
    const viewerActor = (await import('./harness')).adminActorFor(
      (await f.ctx.container.admins.findById(tenantA, viewer)) as never,
    );
    expect(await codeOf(open(key('viewer'), viewerActor))).not.toBe('NO_ERROR');
    expect(await requestRows()).toEqual([]);
  });

  it('a customer’s ordinary text is untouched while nobody has a request open', async () => {
    await customerNamed(f, TG.customer, 'zahra_pay');
    const turn = await message(TG.customer, { text: TEXT, entities: ENTITIES });
    expect(turn.replyKey).not.toBe('bot.admin.description_capture_done');
    expect(await requestRows()).toEqual([]);
  });
});
