import {
  CLIENT_APP_VIDEO_CAPTURE_TTL_MS,
  uuidV7Schema,
  type ActorContext,
  type BotInstanceId,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import type { CustomerButton } from '../../modules/commerce/messaging/application/ports.js';
import {
  CLIENT_APP_EDIT_PERMISSION,
  CLIENT_APP_VIEW_PERMISSION,
} from '../../modules/control/client-apps/application/client-app.service.js';
import type {
  ClientAppVideoService,
  InboundTutorialVideo,
} from '../../modules/control/client-apps/application/client-app-video.service.js';
import type { ClientAppRecord } from '../../modules/control/client-apps/application/ports.js';

/**
 * Spec §7 — the management panel's client apps section and its «تنظیم ویدیو» wizard
 * (`docs/package-h-tutorials-marketing-stars.md`). Kept out of `bot-runtime.ts` on purpose: the runtime only
 * routes the intents here, and this file decides which buttons to draw and how to word an
 * outcome — never whether something is allowed. `ClientAppVideoService` charges the
 * permission on every call, reads included, and a denial reaches `adminTurn`'s one refusal.
 *
 * Callbacks — two letters, like `ka:`/`kb:`, and distinct from `v:` at the second byte:
 *
 * - `va:` the section (the list of apps).
 * - `vb:<code>:<uuid>` one app: `v` view, `s` «تنظیم ویدیو» (opens the prompt), `x` ask
 *   to delete, `X` delete — each naming the APP; and `c` cancel, naming the PROMPT (its
 *   `admin_amount_captures` id), so a stale cancel cannot close a newer prompt. 41 bytes.
 *
 * The video itself arrives as an ordinary VIDEO MESSAGE (`ADMIN_APP_VIDEO_UPLOAD`) and is
 * offered to the service, which stores it only when THIS administrator's prompt on THIS bot is
 * open, unexpired and older than the message. Nothing about the wizard lives in memory.
 */
export const ADMIN_APPS_CALLBACK_DATA = 'va:';
export const ADMIN_APP_CALLBACK_PREFIX = 'vb:';

export const ADMIN_TUTORIAL_INTENTS = [
  'ADMIN_APPS',
  'ADMIN_APP',
  'ADMIN_APP_VIDEO_SET',
  'ADMIN_APP_VIDEO_DELETE_ASK',
  'ADMIN_APP_VIDEO_DELETE',
  'ADMIN_APP_VIDEO_CANCEL',
  'ADMIN_APP_VIDEO_UPLOAD',
] as const;
export type AdminTutorialIntent = (typeof ADMIN_TUTORIAL_INTENTS)[number];

const APP_CODES = {
  v: 'ADMIN_APP',
  s: 'ADMIN_APP_VIDEO_SET',
  x: 'ADMIN_APP_VIDEO_DELETE_ASK',
  X: 'ADMIN_APP_VIDEO_DELETE',
  c: 'ADMIN_APP_VIDEO_CANCEL',
} as const satisfies Record<string, AdminTutorialIntent>;
type AppCode = keyof typeof APP_CODES;

/** The callback's command, `{ intent: 'UNSUPPORTED' }` when malformed, null when not ours. */
export function adminTutorialCallback(data: string): {
  readonly intent: AdminTutorialIntent | 'UNSUPPORTED';
  readonly targetId: string | null;
} | null {
  if (data === ADMIN_APPS_CALLBACK_DATA) return { intent: 'ADMIN_APPS', targetId: null };
  if (!data.startsWith(ADMIN_APP_CALLBACK_PREFIX)) return null;
  const [code, appId, ...rest] = data.slice(ADMIN_APP_CALLBACK_PREFIX.length).split(':');
  if (code === undefined || !Object.hasOwn(APP_CODES, code) || appId === undefined) {
    return { intent: 'UNSUPPORTED', targetId: null };
  }
  const parsed = uuidV7Schema.safeParse(appId);
  if (rest.length > 0 || !parsed.success) return { intent: 'UNSUPPORTED', targetId: null };
  return { intent: APP_CODES[code as AppCode], targetId: parsed.data };
}

/**
 * The video in a message, or null when there is not one. Only Telegram's `video` — a clip
 * sent as a document is a file, and a GIF (`animation`) is not a tutorial. Read through the
 * passthrough fields, nothing trusted: the service bounds every identifier again.
 */
export function tutorialVideoOf(message: unknown): InboundTutorialVideo | null {
  if (typeof message !== 'object' || message === null) return null;
  const video = (message as Record<string, unknown>)['video'];
  if (typeof video !== 'object' || video === null) return null;
  const fields = video as Record<string, unknown>;
  const fileId = fields['file_id'];
  const fileUniqueId = fields['file_unique_id'];
  if (typeof fileId !== 'string' || typeof fileUniqueId !== 'string') return null;
  const duration = fields['duration'];
  const size = fields['file_size'];
  return {
    fileId,
    fileUniqueId,
    mimeType: typeof fields['mime_type'] === 'string' ? fields['mime_type'] : null,
    durationSeconds:
      typeof duration === 'number' && Number.isSafeInteger(duration) && duration >= 0
        ? duration
        : null,
    fileSize:
      typeof size === 'number' && Number.isSafeInteger(size) && size > 0 ? BigInt(size) : null,
  };
}

/**
 * UX Batch 01 item 6: the instant Telegram stamped a message with (`date`, Unix seconds), or
 * null when it carries none. Read for a prompt the Web Admin opened.
 */
export function messageSentAt(message: unknown): Date | null {
  if (typeof message !== 'object' || message === null) return null;
  const date = (message as Record<string, unknown>)['date'];
  return typeof date === 'number' && Number.isSafeInteger(date) && date > 0
    ? new Date(date * 1000)
    : null;
}

/** Whether the section is drawn on the panel for these permissions. */
export function maySeeTutorials(permissions: ReadonlySet<PermissionKey>): boolean {
  return permissions.has(CLIENT_APP_VIEW_PERMISSION);
}

/** The panel's button that opens the section. */
export function tutorialsPanelButton(): CustomerButton {
  return {
    label: { kind: 'TEMPLATE', key: 'bot.admin.apps_button' },
    data: ADMIN_APPS_CALLBACK_DATA,
  };
}

/** What a turn of this section answers — the runtime's `PendingReply` subset it needs. */
export interface TutorialReply {
  readonly key: TutorialKey;
  readonly values: Readonly<Record<string, string | number>>;
  readonly buttons: readonly CustomerButton[];
  readonly orderId: null;
  readonly edit?: boolean;
}

type TutorialKey =
  | 'bot.admin.apps_section'
  | 'bot.admin.apps_empty'
  | 'bot.admin.app_detail_video'
  | 'bot.admin.app_detail_no_video'
  | 'bot.admin.app_video_delete_ask'
  | 'bot.admin.app_video_prompt'
  | 'bot.admin.app_video_saved'
  | 'bot.admin.app_video_deleted'
  | 'bot.admin.app_video_cancelled'
  | 'bot.admin.app_video_stale'
  | 'bot.admin.app_not_found';

function replyOf(
  key: TutorialKey,
  values: Readonly<Record<string, string | number>>,
  buttons: readonly CustomerButton[],
  edit: boolean,
): TutorialReply {
  return { key, values, buttons, orderId: null, ...(edit ? { edit: true } : {}) };
}

/** The app as the panel names it: its icon, when the operator set one, and its name. */
export function appTitle(app: Pick<ClientAppRecord, 'icon' | 'name'>): string {
  return app.icon === null ? app.name : `${app.icon} ${app.name}`;
}

const appButton = (code: AppCode, appId: string, key: Parameters<typeof templateButton>[0]) =>
  templateButton(key, `${ADMIN_APP_CALLBACK_PREFIX}${code}:${appId}`);

function templateButton(
  key:
    | 'bot.admin.app_video_set_button'
    | 'bot.admin.app_video_delete_button'
    | 'bot.admin.app_video_delete_confirm_button'
    | 'bot.admin.app_video_cancel_button'
    | 'bot.admin.app_back_button'
    | 'bot.admin.apps_back_button',
  data: string,
): CustomerButton {
  return { label: { kind: 'TEMPLATE', key }, data };
}

const backToApps = () => templateButton('bot.admin.apps_back_button', ADMIN_APPS_CALLBACK_DATA);

/**
 * One turn of the section. `edit` is whether the turn came from a tap — a screen is then
 * redrawn in place on the message tapped (spec §1.2); the reply to a VIDEO is a new message.
 */
export async function adminTutorialTurn(
  service: Pick<
    ClientAppVideoService,
    'listForAdmin' | 'detailForAdmin' | 'beginCapture' | 'cancelCapture' | 'receiveVideo' | 'remove'
  >,
  scope: TenantContext,
  actor: ActorContext,
  command: {
    readonly intent: AdminTutorialIntent;
    readonly targetId: string | null;
    readonly video?: InboundTutorialVideo | null;
  },
  input: {
    readonly idempotencyKey: string;
    readonly botInstanceId: BotInstanceId;
    readonly adminId: string;
    readonly updateId: bigint | null;
    /** The video message's own date (`messageSentAt`), for a web-opened prompt. */
    readonly sentAt?: Date | null;
    readonly permissions: ReadonlySet<PermissionKey>;
  },
): Promise<TutorialReply | null> {
  const mayEdit = input.permissions.has(CLIENT_APP_EDIT_PERMISSION);
  const tapped = command.intent !== 'ADMIN_APP_VIDEO_UPLOAD';
  const detail = async (appId: string) => {
    const found = await service.detailForAdmin(scope, actor, appId, input.botInstanceId);
    if (found === null) {
      return replyOf('bot.admin.app_not_found', {}, [backToApps()], tapped);
    }
    const buttons: CustomerButton[] = [];
    if (mayEdit) {
      buttons.push(appButton('s', found.app.id, 'bot.admin.app_video_set_button'));
      if (found.video !== null) {
        buttons.push(appButton('x', found.app.id, 'bot.admin.app_video_delete_button'));
      }
    }
    buttons.push(backToApps());
    return replyOf(
      found.video === null ? 'bot.admin.app_detail_no_video' : 'bot.admin.app_detail_video',
      { app: appTitle(found.app) },
      buttons,
      tapped,
    );
  };

  switch (command.intent) {
    case 'ADMIN_APPS': {
      const items = await service.listForAdmin(scope, actor, input.botInstanceId);
      if (items.length === 0) return replyOf('bot.admin.apps_empty', {}, [], true);
      return replyOf(
        'bot.admin.apps_section',
        {},
        items.map(({ app }) => ({
          label: { kind: 'TEXT' as const, text: appTitle(app) },
          data: `${ADMIN_APP_CALLBACK_PREFIX}v:${app.id}`,
        })),
        true,
      );
    }
    case 'ADMIN_APP':
      return command.targetId === null ? null : detail(command.targetId);
    case 'ADMIN_APP_VIDEO_SET': {
      if (command.targetId === null) return null;
      const opened = await service.beginCapture(scope, actor, {
        idempotencyKey: `${input.idempotencyKey}:app-video-prompt`,
        appId: command.targetId,
        botInstanceId: input.botInstanceId,
        adminId: input.adminId,
        openedUpdateId: input.updateId,
      });
      return replyOf(
        'bot.admin.app_video_prompt',
        // The window the capture row was opened with, never a number written into the text.
        {
          app: appTitle(opened.app),
          minutes: Math.floor(CLIENT_APP_VIDEO_CAPTURE_TTL_MS / 60_000),
        },
        // The cancel names the PROMPT, never the app: a stale cancel cannot close a newer one.
        [appButton('c', opened.captureId, 'bot.admin.app_video_cancel_button')],
        true,
      );
    }
    case 'ADMIN_APP_VIDEO_CANCEL': {
      if (command.targetId === null) return null;
      const result = await service.cancelCapture(scope, actor, {
        captureId: command.targetId,
        botInstanceId: input.botInstanceId,
        adminId: input.adminId,
      });
      return replyOf(
        result.cancelled ? 'bot.admin.app_video_cancelled' : 'bot.admin.app_video_stale',
        {},
        [
          result.appId === null
            ? backToApps()
            : appButton('v', result.appId, 'bot.admin.app_back_button'),
        ],
        true,
      );
    }
    case 'ADMIN_APP_VIDEO_DELETE_ASK': {
      if (command.targetId === null) return null;
      const found = await service.detailForAdmin(
        scope,
        actor,
        command.targetId,
        input.botInstanceId,
      );
      if (found === null) return replyOf('bot.admin.app_not_found', {}, [backToApps()], true);
      if (found.video === null) return detail(found.app.id);
      return replyOf(
        'bot.admin.app_video_delete_ask',
        { app: appTitle(found.app) },
        [
          appButton('X', found.app.id, 'bot.admin.app_video_delete_confirm_button'),
          appButton('v', found.app.id, 'bot.admin.app_back_button'),
        ],
        true,
      );
    }
    case 'ADMIN_APP_VIDEO_DELETE': {
      if (command.targetId === null) return null;
      const result = await service.remove(scope, actor, {
        idempotencyKey: `${input.idempotencyKey}:app-video-delete`,
        appId: command.targetId,
        botInstanceId: input.botInstanceId,
      });
      // A second tap of the confirm finds nothing to delete: the app's screen, as it is.
      if (!result.removed) return detail(result.app.id);
      return replyOf(
        'bot.admin.app_video_deleted',
        { app: appTitle(result.app) },
        [appButton('v', result.app.id, 'bot.admin.app_back_button'), backToApps()],
        true,
      );
    }
    case 'ADMIN_APP_VIDEO_UPLOAD': {
      if (command.video == null) return null;
      const receipt = await service.receiveVideo(scope, actor, {
        idempotencyKey: `${input.idempotencyKey}:app-video`,
        botInstanceId: input.botInstanceId,
        adminId: input.adminId,
        updateId: input.updateId,
        sentAt: input.sentAt ?? null,
        video: command.video,
      });
      if (receipt.outcome !== 'STORED') {
        return replyOf('bot.admin.app_video_stale', {}, [backToApps()], false);
      }
      return replyOf(
        'bot.admin.app_video_saved',
        { app: appTitle(receipt.app) },
        [appButton('v', receipt.app.id, 'bot.admin.app_back_button'), backToApps()],
        false,
      );
    }
  }
}
