import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CLIENT_APP_VIDEO_WEB_CLOCK_SKEW_MS,
  CONTROL_ERROR_CODES,
  type ClientAppInput,
} from '@nexa/contracts';
import { adminActorFor, createAdmin, SEED_IDS, tenantA, tenantB } from './harness';
import {
  BOT_A,
  TG,
  bindNewAdmin,
  receiptFixture,
  rows,
  systemActor,
  type ReceiptFixture,
} from './receipt-review-fixture';

/**
 * UX Batch 01 item 6 — «افزودن ویدیو از تلگرام» from the Web Admin.
 *
 * The web opens the existing `CLIENT_APP_VIDEO` prompt for ONE administrator, ONE bot and
 * ONE app; that administrator sends the video to that bot from their bound Telegram account;
 * the page polls the prompt until it closes. End to end through the real container, the
 * real bot runtime and PostgreSQL.
 */
describe('the Web Admin’s «add video from Telegram» flow', () => {
  let f: ReceiptFixture;
  let appId: string;
  let seq = 0;
  let videoUpdate = 70_000_000;

  beforeAll(async () => {
    f = await receiptFixture();
  }, 120_000);

  afterAll(async () => {
    await f?.close();
  });

  const entry = (): ClientAppInput => ({
    platform: 'ANDROID',
    name: 'برنامهٔ نمونه',
    icon: null,
    description: 'سازگار با لینک اشتراک',
    officialUrl: 'https://downloads.example.com/app.apk',
    alternativeUrl: null,
    helpUrl: null,
    guide: '1. برنامه را نصب کنید',
    deliveryKinds: [],
    protocols: [],
    providerTypes: [],
    sortOrder: 10,
  });

  beforeEach(async () => {
    await f.reset();
    appId = (
      await f.ctx.container.clientApps.create(tenantA, f.owner, {
        ...entry(),
        idempotencyKey: `web-app-${String((seq += 1))}`,
      })
    ).id;
  });

  const web = () => f.ctx.container.clientAppVideoWeb;
  const key = (label: string) => `web-video-${label}-${String((seq += 1))}`;
  const open = (botInstanceId: string = BOT_A, idempotencyKey = key('open')) =>
    web().open(tenantA, f.owner, { idempotencyKey, appId, botInstanceId });

  /** A message to bot A as Telegram delivers one, dated `at` (now by default). */
  function message(
    telegramUserId: string,
    body: Record<string, unknown>,
    options: { readonly at?: Date; readonly updateId?: number } = {},
  ) {
    f.sent = [];
    const id = options.updateId ?? (videoUpdate += 1);
    const at = options.at ?? new Date();
    return f.ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: `web-video-update-${String(id)}`,
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
  const video = (fileUniqueId: string) => ({
    video: {
      file_id: `file-${fileUniqueId}`,
      file_unique_id: fileUniqueId,
      duration: 42,
      width: 1280,
      height: 720,
      mime_type: 'video/mp4',
      file_size: 1_048_576,
    },
  });
  const sendVideo = (
    telegramUserId: string,
    fileUniqueId: string,
    options: { readonly at?: Date; readonly updateId?: number } = {},
  ) => message(telegramUserId, video(fileUniqueId), options);

  const stored = () =>
    rows<{ file_id: string; file_unique_id: string; version: number }>(
      f,
      sql`SELECT file_id, file_unique_id, version FROM client_app_videos
           WHERE client_app_id = ${appId}`,
    );
  const prompts = () =>
    rows<{ close_reason: string | null }>(
      f,
      sql`SELECT close_reason FROM admin_amount_captures
           WHERE purpose = 'CLIENT_APP_VIDEO' ORDER BY opened_at`,
    );
  const audits = () =>
    rows<{ action: string; actor_type: string }>(
      f,
      sql`SELECT action, actor_type FROM audit_logs
           WHERE entity_id = ${appId} AND action LIKE 'client_app.video_%'
             AND result = 'SUCCESS' ORDER BY occurred_at`,
    );
  const codeOf = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return 'NO_ERROR';
  };

  it('create → the bound admin sends the video → the page reads it CONFIRMED with the video, audited', async () => {
    const overview = await web().overview(tenantA, f.owner, appId);
    expect(overview.telegramLinked).toBe(true);
    expect(overview.bots.map((one) => [one.bot.username, one.bot.active, one.video])).toEqual(
      expect.arrayContaining([
        ['acme_store_bot', true, null],
        ['acme_support_bot', false, null],
      ]),
    );
    expect(overview.bots.every((one) => one.bot.chatUrl.startsWith('https://t.me/'))).toBe(true);

    const session = await open();
    expect(session).toMatchObject({
      state: 'OPEN',
      video: null,
      bot: { botInstanceId: BOT_A, chatUrl: 'https://t.me/acme_store_bot' },
    });
    // Short-lived: the prompt's deadline, not an open-ended token.
    expect(session.expiresAt.getTime() - session.openedAt.getTime()).toBe(15 * 60 * 1000);
    expect(await prompts()).toEqual([{ close_reason: null }]);
    expect((await web().read(tenantA, f.owner, appId, session.sessionId)).state).toBe('OPEN');

    expect((await sendVideo(TG.owner, 'uniq-1')).replyKey).toBe('bot.admin.app_video_saved');
    expect(await stored()).toEqual([
      { file_id: 'file-uniq-1', file_unique_id: 'uniq-1', version: 1 },
    ]);
    const done = await web().read(tenantA, f.owner, appId, session.sessionId);
    expect(done.state).toBe('CONFIRMED');
    expect(done.video).toMatchObject({ fileUniqueId: 'uniq-1', durationSeconds: 42 });
    expect(
      (await web().overview(tenantA, f.owner, appId)).bots.find(
        (one) => one.bot.botInstanceId === BOT_A,
      )?.video?.fileUniqueId,
    ).toBe('uniq-1');
    expect(await audits()).toEqual([
      { action: 'client_app.video_session_open', actor_type: 'WEB_ADMIN' },
      { action: 'client_app.video_set', actor_type: 'TELEGRAM_ADMIN' },
    ]);
  });

  it('is single use: a second video, or the same update replayed, stores nothing more', async () => {
    const session = await open();
    await sendVideo(TG.owner, 'uniq-1', { updateId: 71_000_001 });
    // Telegram redelivers the very same update: the remembered answer, nothing new.
    expect((await sendVideo(TG.owner, 'uniq-1', { updateId: 71_000_001 })).replyKey).toBe(
      'bot.admin.app_video_saved',
    );
    // A further video after completion belongs to no prompt.
    expect((await sendVideo(TG.owner, 'uniq-2')).replyKey).toBe('bot.admin.app_video_stale');
    expect(await stored()).toEqual([
      { file_id: 'file-uniq-1', file_unique_id: 'uniq-1', version: 1 },
    ]);
    expect((await audits()).filter((row) => row.action === 'client_app.video_set')).toHaveLength(1);
    // Opening is idempotent: the same key answers the same prompt.
    const idempotencyKey = key('replay');
    const first = await open(BOT_A, idempotencyKey);
    const again = await open(BOT_A, idempotencyKey);
    expect(again.sessionId).toBe(first.sessionId);
    expect(first.sessionId).not.toBe(session.sessionId);
  });

  it('cancel: CANCELLED, audited once, and a later video completes nothing', async () => {
    const session = await open();
    const cancelKey = key('cancel');
    const cancelled = await web().cancel(tenantA, f.owner, {
      idempotencyKey: cancelKey,
      appId,
      sessionId: session.sessionId,
    });
    expect(cancelled.state).toBe('CANCELLED');
    // A replay and a second cancel answer as it is and audit nothing more.
    await web().cancel(tenantA, f.owner, {
      idempotencyKey: cancelKey,
      appId,
      sessionId: session.sessionId,
    });
    expect(
      (
        await web().cancel(tenantA, f.owner, {
          idempotencyKey: key('cancel-again'),
          appId,
          sessionId: session.sessionId,
        })
      ).state,
    ).toBe('CANCELLED');
    expect((await sendVideo(TG.owner, 'uniq-1')).replyKey).toBe('bot.admin.app_video_stale');
    expect(await stored()).toEqual([]);
    expect((await audits()).map((row) => row.action)).toEqual([
      'client_app.video_session_open',
      'client_app.video_session_cancel',
    ]);
  });

  it('timeout: past its deadline the page reads EXPIRED, stamped and audited once; a late video stores nothing', async () => {
    const session = await open();
    await f.ctx.container.database.db.execute(
      sql`UPDATE admin_amount_captures
             SET opened_at = now() - interval '1 hour', expires_at = now() - interval '1 minute'
           WHERE id = ${session.sessionId}`,
    );
    expect((await web().read(tenantA, f.owner, appId, session.sessionId)).state).toBe('EXPIRED');
    expect((await web().read(tenantA, f.owner, appId, session.sessionId)).state).toBe('EXPIRED');
    expect(await prompts()).toEqual([{ close_reason: 'EXPIRED' }]);
    expect((await sendVideo(TG.owner, 'late')).replyKey).toBe('bot.admin.app_video_stale');
    expect(await stored()).toEqual([]);
    expect((await audits()).map((row) => row.action)).toEqual([
      'client_app.video_session_open',
      'client_app.video_session_expired',
    ]);
  });

  it('refuses the wrong sender, the wrong media and a video sent before the button', async () => {
    const session = await open();
    // Another administrator, bound and allowed to edit: it is not THEIR prompt.
    await bindNewAdmin(f, 'second-editor', TG.reviewer, ['client_apps.view', 'client_apps.edit']);
    expect((await sendVideo(TG.reviewer, 'theirs')).replyKey).toBe('bot.admin.app_video_stale');
    // A customer's video is a message the bot does not understand.
    expect((await sendVideo(TG.customer, 'cust')).replyKey).toBe('bot.unknown_command');
    // The right administrator, the wrong media: a clip sent as a file, a photo, a text.
    await message(TG.owner, {
      document: { file_id: 'doc-1', file_unique_id: 'doc-1', mime_type: 'video/mp4' },
    });
    await message(TG.owner, {
      photo: [{ file_id: 'ph-1', file_unique_id: 'ph-1', width: 10, height: 10 }],
    });
    await message(TG.owner, { text: 'این ویدیو است' });
    // A video Telegram dated before the prompt opened, delivered late.
    const before = new Date(Date.now() - CLIENT_APP_VIDEO_WEB_CLOCK_SKEW_MS - 60_000);
    expect((await sendVideo(TG.owner, 'old', { at: before })).replyKey).toBe(
      'bot.admin.app_video_stale',
    );
    expect(await stored()).toEqual([]);
    // None of it touched the prompt: still open, and the right video still completes it.
    expect((await web().read(tenantA, f.owner, appId, session.sessionId)).state).toBe('OPEN');
    expect((await sendVideo(TG.owner, 'right')).replyKey).toBe('bot.admin.app_video_saved');
    expect((await web().read(tenantA, f.owner, appId, session.sessionId)).state).toBe('CONFIRMED');
  });

  it('opens nothing for an administrator with no Telegram binding, or for a stopped bot', async () => {
    const unbound = await createAdmin(f.ctx.container, tenantA, {
      username: 'web-only-owner',
      roleKeys: ['owner'],
    });
    const actor = adminActorFor(unbound);
    expect((await web().overview(tenantA, actor, appId)).telegramLinked).toBe(false);
    expect(
      await codeOf(
        web().open(tenantA, actor, { idempotencyKey: key('unbound'), appId, botInstanceId: BOT_A }),
      ),
    ).toBe(CONTROL_ERROR_CODES.CLIENT_APP_VIDEO_TELEGRAM_UNLINKED);
    expect(await codeOf(open(SEED_IDS.botA2))).toBe(
      CONTROL_ERROR_CODES.CLIENT_APP_VIDEO_BOT_UNAVAILABLE,
    );
    expect(await prompts()).toEqual([]);
  });

  it('charges client_apps.edit to open, and binds a prompt to the administrator who opened it', async () => {
    const viewerId = await bindNewAdmin(f, 'viewer-only', TG.observer, ['client_apps.view']);
    const viewer = { ...f.owner, id: viewerId, label: 'viewer-only' };
    expect(
      await codeOf(
        web().open(tenantA, viewer, { idempotencyKey: key('viewer'), appId, botInstanceId: BOT_A }),
      ),
    ).toBe('platform.permission_denied');
    const session = await open();
    // Another administrator of the same tenant can neither read nor cancel it.
    expect(await codeOf(web().read(tenantA, viewer, appId, session.sessionId))).toBe(
      CONTROL_ERROR_CODES.CLIENT_APP_VIDEO_SESSION_NOT_FOUND,
    );
    const editorId = await bindNewAdmin(f, 'other-editor', TG.third, [
      'client_apps.view',
      'client_apps.edit',
    ]);
    const editor = { ...f.owner, id: editorId, label: 'other-editor' };
    expect(
      await codeOf(
        web().cancel(tenantA, editor, {
          idempotencyKey: key('foreign-cancel'),
          appId,
          sessionId: session.sessionId,
        }),
      ),
    ).toBe(CONTROL_ERROR_CODES.CLIENT_APP_VIDEO_SESSION_NOT_FOUND);
    expect((await web().read(tenantA, f.owner, appId, session.sessionId)).state).toBe('OPEN');
  });

  it('keeps tenants apart: another tenant’s admin reaches neither the bot, the app nor the prompt', async () => {
    const session = await open();
    const ownerB = adminActorFor(
      await createAdmin(f.ctx.container, tenantB, { username: 'owner-b', roleKeys: ['owner'] }),
    );
    const scopeB = tenantB as unknown as typeof tenantA;
    expect(await codeOf(web().overview(scopeB, ownerB, appId))).toBe(
      CONTROL_ERROR_CODES.CLIENT_APP_NOT_FOUND,
    );
    expect(
      await codeOf(
        web().open(scopeB, ownerB, { idempotencyKey: key('b-open'), appId, botInstanceId: BOT_A }),
      ),
    ).toBe(CONTROL_ERROR_CODES.CLIENT_APP_VIDEO_BOT_UNAVAILABLE);
    expect(await codeOf(web().read(scopeB, ownerB, appId, session.sessionId))).toBe(
      CONTROL_ERROR_CODES.CLIENT_APP_VIDEO_SESSION_NOT_FOUND,
    );
    expect(
      await codeOf(
        web().cancel(scopeB, ownerB, {
          idempotencyKey: key('b-cancel'),
          appId,
          sessionId: session.sessionId,
        }),
      ),
    ).toBe(CONTROL_ERROR_CODES.CLIENT_APP_VIDEO_SESSION_NOT_FOUND);
    expect((await web().read(tenantA, f.owner, appId, session.sessionId)).state).toBe('OPEN');
  });
});
