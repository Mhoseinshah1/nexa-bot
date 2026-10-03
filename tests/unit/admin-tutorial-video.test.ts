import { describe, expect, it } from 'vitest';
import { fileMessageBody } from '../../apps/api/src/infrastructure/telegram/send-message';
import { intentOf } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import {
  ADMIN_APPS_CALLBACK_DATA,
  ADMIN_APP_CALLBACK_PREFIX,
  adminTutorialCallback,
  tutorialVideoOf,
} from '../../apps/api/src/surfaces/telegram/admin-tutorial-video';

const APP = '01928c4e-7c1a-7b3e-8a2b-1234567890ab';

/** Spec §7: the boundary of the «تنظیم ویدیو» wizard — what a callback or a message can carry. */
describe('the tutorial video wizard boundary (spec §7)', () => {
  it('parses the section and each app code, and refuses anything malformed', () => {
    expect(adminTutorialCallback(ADMIN_APPS_CALLBACK_DATA)).toEqual({
      intent: 'ADMIN_APPS',
      targetId: null,
    });
    const cases = [
      ['v', 'ADMIN_APP'],
      ['s', 'ADMIN_APP_VIDEO_SET'],
      ['x', 'ADMIN_APP_VIDEO_DELETE_ASK'],
      ['X', 'ADMIN_APP_VIDEO_DELETE'],
      ['c', 'ADMIN_APP_VIDEO_CANCEL'],
    ] as const;
    for (const [code, intent] of cases) {
      const data = `${ADMIN_APP_CALLBACK_PREFIX}${code}:${APP}`;
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(adminTutorialCallback(data)).toEqual({ intent, targetId: APP });
    }
    for (const bad of [
      `${ADMIN_APP_CALLBACK_PREFIX}q:${APP}`,
      `${ADMIN_APP_CALLBACK_PREFIX}s:not-a-uuid`,
      `${ADMIN_APP_CALLBACK_PREFIX}s:${APP}:extra`,
      `${ADMIN_APP_CALLBACK_PREFIX}s`,
      `${ADMIN_APP_CALLBACK_PREFIX}toString:${APP}`,
    ]) {
      expect(adminTutorialCallback(bad)).toEqual({ intent: 'UNSUPPORTED', targetId: null });
    }
    // Not ours: the existing `v:` route and anything else fall through.
    expect(adminTutorialCallback(`v:${APP}`)).toBeNull();
  });

  it('routes a video message to the wizard, and only Telegram’s `video` field', () => {
    const message = {
      message_id: 7,
      video: {
        file_id: 'BAACAgIAAxk',
        file_unique_id: 'AgADxyz',
        duration: 31,
        mime_type: 'video/mp4',
        file_size: 2048,
      },
    };
    expect(tutorialVideoOf(message)).toEqual({
      fileId: 'BAACAgIAAxk',
      fileUniqueId: 'AgADxyz',
      mimeType: 'video/mp4',
      durationSeconds: 31,
      fileSize: 2048n,
    });
    expect(intentOf({ message }).intent).toBe('ADMIN_APP_VIDEO_UPLOAD');
    // An animation, a document or a broken video is not a tutorial video.
    expect(tutorialVideoOf({ animation: message.video })).toBeNull();
    expect(tutorialVideoOf({ video: { file_id: 'x' } })).toBeNull();
    expect(
      tutorialVideoOf({ video: { ...message.video, duration: -1, file_size: 0 } }),
    ).toMatchObject({ durationSeconds: null, fileSize: null });
  });

  it('sends a stored video by its file_id with sendVideo’s field', () => {
    expect(fileMessageBody({ chatId: '42', kind: 'VIDEO', fileId: 'BAAC' })).toEqual({
      chat_id: '42',
      video: 'BAAC',
    });
  });
});
