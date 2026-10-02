import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ClientAppInput } from '@nexa/contracts';
import { tenantA } from './harness';
import {
  ADMIN_APPS_CALLBACK_DATA,
  ADMIN_APP_CALLBACK_PREFIX,
} from '../../apps/api/src/surfaces/telegram/admin-tutorial-video';
import {
  BOT_A,
  TG,
  lastKeyboard,
  receiptFixture,
  rows,
  systemActor,
  tap,
  type ReceiptFixture,
} from './receipt-review-fixture';

/**
 * Spec §7 — «تنظیم ویدیو»: an administrator sets, replaces, deletes or cancels a client app's
 * tutorial video from the Telegram management panel; the bot stores Telegram's reference
 * (`file_id`, per bot) and an app's screen sends it to a customer by that reference.
 *
 * End to end through the real runtime and container: the panel button, the prompt row, the
 * video message offered to it, the audit, and the stale states that must store nothing.
 */
describe('the tutorial video wizard (spec §7)', () => {
  let f: ReceiptFixture;
  let appId: string;
  let seq = 0;
  let videoUpdate = 50_000_000;

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
        idempotencyKey: `app-${String((seq += 1))}`,
      })
    ).id;
  });

  /** A video message, as Telegram delivers one, newer than every tap so far. */
  function sendVideo(telegramUserId: string, fileUniqueId: string, updateId?: number) {
    f.sent = [];
    const id = updateId ?? (videoUpdate += 1);
    return f.ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: `video-update-${String(id)}-${String(Date.now())}`,
      botInstanceId: BOT_A,
      update: {
        update_id: id,
        message: {
          message_id: id,
          date: 0,
          chat: { id: Number(telegramUserId), type: 'private' },
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'کاربر' },
          video: {
            file_id: `file-${fileUniqueId}`,
            file_unique_id: fileUniqueId,
            duration: 42,
            width: 1280,
            height: 720,
            mime_type: 'video/mp4',
            file_size: 1_048_576,
          },
        },
      },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'کاربر' },
    });
  }

  const app = (code: string) => `${ADMIN_APP_CALLBACK_PREFIX}${code}:${appId}`;
  const callbacks = () => lastKeyboard(f).map((button) => button.callback_data);

  const stored = () =>
    rows<{ file_id: string; file_unique_id: string; bot_instance_id: string; version: number }>(
      f,
      sql`SELECT file_id, file_unique_id, bot_instance_id, version FROM client_app_videos
           WHERE client_app_id = ${appId}`,
    );

  const audits = () =>
    rows<{ action: string; before: unknown; after: unknown }>(
      f,
      sql`SELECT action, before, after FROM audit_logs
           WHERE entity_id = ${appId} AND action LIKE 'client_app.video_%' ORDER BY occurred_at`,
    );

  const prompts = () =>
    rows<{ close_reason: string | null }>(
      f,
      sql`SELECT close_reason FROM admin_amount_captures
           WHERE purpose = 'CLIENT_APP_VIDEO' ORDER BY opened_at`,
    );

  it('set: panel → apps → app → «تنظیم ویدیو» → video stores the file_id for this bot, audited; the customer gets it', async () => {
    await tap(f, 'A:', TG.owner);
    expect(callbacks()).toContain(ADMIN_APPS_CALLBACK_DATA);
    await tap(f, ADMIN_APPS_CALLBACK_DATA, TG.owner);
    expect(callbacks()).toContain(app('v'));
    expect((await tap(f, app('v'), TG.owner)).replyKey).toBe('bot.admin.app_detail_no_video');
    expect(callbacks()).toContain(app('s'));
    expect(callbacks()).not.toContain(app('x'));

    expect((await tap(f, app('s'), TG.owner)).replyKey).toBe('bot.admin.app_video_prompt');
    expect(callbacks()).toEqual([app('c')]);
    expect(await prompts()).toEqual([{ close_reason: null }]);

    expect((await sendVideo(TG.owner, 'uniq-1')).replyKey).toBe('bot.admin.app_video_saved');
    expect(await stored()).toEqual([
      { file_id: 'file-uniq-1', file_unique_id: 'uniq-1', bot_instance_id: BOT_A, version: 1 },
    ]);
    expect(await prompts()).toEqual([{ close_reason: 'CONFIRMED' }]);
    const [audit] = await audits();
    expect(audit).toMatchObject({ action: 'client_app.video_set', before: null });
    // The audit names the video by its stable id, never by the bot-scoped sending handle.
    expect(JSON.stringify(audit?.after)).toContain('uniq-1');
    expect(JSON.stringify(audit?.after)).not.toContain('file-uniq-1');

    // The app's screen: the detail now offers delete, and the customer is sent the video.
    expect((await tap(f, app('v'), TG.owner)).replyKey).toBe('bot.admin.app_detail_video');
    expect(callbacks()).toContain(app('x'));
    await tap(f, `ca:${appId}`, TG.customer);
    const video = f.sent.find((call) => call.method === 'sendVideo');
    expect(video?.body).toMatchObject({ chat_id: TG.customer, video: 'file-uniq-1' });
  });

  it('replace: a second «تنظیم ویدیو» and video replaces the reference (version 2), audited with the before', async () => {
    await tap(f, app('s'), TG.owner);
    await sendVideo(TG.owner, 'uniq-1');
    await tap(f, app('s'), TG.owner);
    expect((await sendVideo(TG.owner, 'uniq-2')).replyKey).toBe('bot.admin.app_video_saved');
    expect(await stored()).toEqual([
      { file_id: 'file-uniq-2', file_unique_id: 'uniq-2', bot_instance_id: BOT_A, version: 2 },
    ]);
    const trail = await audits();
    expect(trail.map((row) => row.action)).toEqual([
      'client_app.video_set',
      'client_app.video_set',
    ]);
    expect(JSON.stringify(trail[1]?.before)).toContain('uniq-1');
  });

  it('delete: ask, then confirm; a second confirm changes nothing and audits nothing', async () => {
    await tap(f, app('s'), TG.owner);
    await sendVideo(TG.owner, 'uniq-1');
    expect((await tap(f, app('x'), TG.owner)).replyKey).toBe('bot.admin.app_video_delete_ask');
    expect(await stored()).toHaveLength(1);
    expect((await tap(f, app('X'), TG.owner)).replyKey).toBe('bot.admin.app_video_deleted');
    expect(await stored()).toEqual([]);
    expect((await tap(f, app('X'), TG.owner)).replyKey).toBe('bot.admin.app_detail_no_video');
    expect((await audits()).map((row) => row.action)).toEqual([
      'client_app.video_set',
      'client_app.video_delete',
    ]);
    // The customer's screen no longer carries a video.
    await tap(f, `ca:${appId}`, TG.customer);
    expect(f.sent.some((call) => call.method === 'sendVideo')).toBe(false);
  });

  it('cancel: the prompt closes CANCELLED and a later video stores nothing; a stale cancel answers and does nothing', async () => {
    await tap(f, app('s'), TG.owner);
    expect((await tap(f, app('c'), TG.owner)).replyKey).toBe('bot.admin.app_video_cancelled');
    expect(await prompts()).toEqual([{ close_reason: 'CANCELLED' }]);
    expect((await sendVideo(TG.owner, 'uniq-1')).replyKey).toBe('bot.admin.app_video_stale');
    expect(await stored()).toEqual([]);
    expect((await tap(f, app('c'), TG.owner)).replyKey).toBe('bot.admin.app_video_stale');
  });

  it('stale wizard state is safe: an expired prompt closes EXPIRED; a video older than the tap, or from anybody else, is never stored', async () => {
    await tap(f, app('s'), TG.owner);
    // A message delivered late, whose update predates the tap, belongs to no prompt.
    expect((await sendVideo(TG.owner, 'old', 1)).replyKey).toBe('bot.admin.app_video_stale');
    // A customer's video is just a message the bot does not understand.
    expect((await sendVideo(TG.customer, 'cust')).replyKey).toBe('bot.unknown_command');
    expect(await stored()).toEqual([]);
    expect(await prompts()).toEqual([{ close_reason: null }]);

    // The deadline passes.
    await f.ctx.container.database.db.execute(
      sql`UPDATE admin_amount_captures
             SET opened_at = now() - interval '1 hour', expires_at = now() - interval '1 minute'
           WHERE purpose = 'CLIENT_APP_VIDEO'`,
    );
    expect((await sendVideo(TG.owner, 'late')).replyKey).toBe('bot.admin.app_video_stale');
    expect(await stored()).toEqual([]);
    expect(await prompts()).toEqual([{ close_reason: 'EXPIRED' }]);
  });

  it('a customer who crafts the admin callbacks reaches nothing: no prompt is opened and no video is deleted', async () => {
    expect((await tap(f, app('s'), TG.customer)).replyKey).toBe('bot.unknown_command');
    expect(await prompts()).toEqual([]);
    await tap(f, app('s'), TG.owner);
    await sendVideo(TG.owner, 'uniq-1');
    expect((await tap(f, app('X'), TG.customer)).replyKey).toBe('bot.unknown_command');
    expect(await stored()).toHaveLength(1);
  });

  it('deleting the app deletes its video and any open prompt for it', async () => {
    await tap(f, app('s'), TG.owner);
    await sendVideo(TG.owner, 'uniq-1');
    await tap(f, app('s'), TG.owner);
    const current = await f.ctx.container.clientApps.listForOperator(tenantA, f.owner);
    await f.ctx.container.clientApps.remove(tenantA, f.owner, {
      idempotencyKey: 'app-delete',
      id: appId,
      expectedVersion: current[0]?.version ?? 1,
    });
    expect(await stored()).toEqual([]);
    expect(await prompts()).toEqual([]);
  });
});
