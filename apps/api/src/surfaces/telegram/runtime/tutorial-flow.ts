// The connection guide (WP-A10): platforms, a platform's recommended apps, one app's guide.
// The turn handlers read the client-app catalogue; the screens below them are pure.
// Moved verbatim out of bot-runtime.ts, which still re-exports every name it exported.
import {
  type ClientAppPlatform,
  type InlineButtonKey,
  type ConnectionGuidePlatform,
  type TemplateKey,
  type TenantContext,
  CONNECTION_GUIDE_PLATFORMS,
  type BotInstanceId,
} from '@nexa/contracts';
import type { PendingReply } from './replies.js';
import {
  inlineLabel,
  inlineDataLabel,
} from '../../../modules/commerce/messaging/application/inline-buttons.js';
import {
  TUTORIAL_PLATFORM_CALLBACK_PREFIX,
  CLIENT_APP_CALLBACK_PREFIX,
  SERVICE_RESEND_CALLBACK_PREFIX,
  SERVICE_FILES_CALLBACK_PREFIX,
  SERVICES_LIST_PAGE_CALLBACK_PREFIX,
} from './callbacks.js';
import { mainMenuButton } from './keyboards.js';
import { TUTORIAL_CALLBACK_DATA } from '../../../modules/commerce/provisioning/application/delivery.service.js';
import type { ClientAppCatalog } from '../../../modules/control/client-apps/application/client-app-catalog.js';
import type { CustomerButton } from '../../../modules/commerce/messaging/application/ports.js';
import type { CustomerRecord } from '../../../modules/commerce/customers/application/ports.js';
import type { BotRuntime } from '../bot-runtime.js';

/** Each platform's button on the choice screen. `OTHER` has a button and no guide of its own. */
export const PLATFORM_BUTTONS: Readonly<Record<ClientAppPlatform, InlineButtonKey>> = {
  ANDROID: 'apps.platform_android',
  IOS: 'apps.platform_ios',
  WINDOWS: 'apps.platform_windows',
  MACOS: 'apps.platform_macos',
  LINUX: 'apps.platform_linux',
  OTHER: 'apps.platform_other',
};

/** The guide a platform shows when no client app is configured for it — the pre-WP-A10 screen. */
export const TUTORIAL_BODY_KEYS: Readonly<Record<ConnectionGuidePlatform, TemplateKey>> = {
  ANDROID: 'bot.tutorial.android',
  IOS: 'bot.tutorial.ios',
  WINDOWS: 'bot.tutorial.windows',
  MACOS: 'bot.tutorial.macos',
  LINUX: 'bot.tutorial.linux',
};

/**
 * The connection guide's first screen: the platform choice, two to a row. The platforms
 * are decided by the caller — the catalogue adds `OTHER` only when it holds something.
 */
export function tutorialChoice(platforms: readonly ClientAppPlatform[]): PendingReply {
  return {
    key: 'bot.tutorial.choose',
    values: {},
    buttons: [
      ...platforms.map((platform, index) => ({
        ...inlineLabel(PLATFORM_BUTTONS[platform]),
        data: `${TUTORIAL_PLATFORM_CALLBACK_PREFIX}${platform}`,
        row: Math.floor(index / 2),
      })),
      mainMenuButton(),
    ],
    orderId: null,
  };
}

/**
 * One platform's screen (WP-A10).
 *
 * The apps are BUTTONS whose labels are the operator's own data, for the reason the
 * catalogue gives: a template is not a list renderer. With none to show, a platform that
 * has a guide of its own answers it with EXACTLY the pre-WP-A10 screen — same key, same two
 * buttons — so an installation that configures nothing sees no change at all; `OTHER`,
 * which has no guide, says there is nothing here yet.
 */
export function clientAppPlatformScreen(
  platform: ClientAppPlatform,
  apps: readonly { readonly id: string; readonly label: string }[],
): PendingReply {
  if (apps.length === 0) {
    if (platform === 'OTHER') {
      return {
        key: 'bot.apps.platform_empty',
        values: {},
        buttons: [platformsButton(), mainMenuButton()],
        orderId: null,
      };
    }
    return {
      key: TUTORIAL_BODY_KEYS[platform],
      values: {},
      buttons: [
        {
          ...inlineLabel('service.tutorial'),
          data: TUTORIAL_CALLBACK_DATA,
        },
        mainMenuButton(),
      ],
      orderId: null,
    };
  }
  return {
    key: 'bot.apps.platform',
    values: {},
    buttons: [
      ...apps.map((app) => ({
        ...inlineDataLabel('apps.app', { kind: 'TEXT', text: app.label }),
        data: `${CLIENT_APP_CALLBACK_PREFIX}${app.id}`,
      })),
      platformsButton(),
      mainMenuButton(),
    ],
    orderId: null,
  };
}

/**
 * One app's screen (WP-A10): the operator's description and rendered guide, a URL button
 * per link, and the customer's own service actions where they are safe.
 *
 * The service actions are the EXISTING flows, reached by their existing callbacks —
 * `r:<service>` re-sends the delivery card through the redelivery path, `sf:<service>`
 * opens Package E's files — so each is re-decided on its own tap exactly as it is from the
 * service card, and this screen never carries a subscription URL itself. With more than
 * one live service the customer is sent to «سرویس‌های من» to pick one.
 *
 * HF-A10: an entry with a picture sends it FIRST, as a bare photo lead — the referral
 * banner's arrangement, because the guide can outgrow a photo caption (1,024 characters)
 * and the text must never be cut. The lead is decorative: the composer drops a photo
 * Telegram refuses and sends the screen regardless, so the fallback is the emoji-and-text
 * screen an entry without a picture always gets.
 */
export function clientAppScreen(
  detail: Awaited<ReturnType<ClientAppCatalog['appFor']>>,
): PendingReply {
  if (detail === null) {
    return {
      key: 'bot.apps.not_found',
      values: {},
      buttons: [platformsButton(), mainMenuButton()],
      orderId: null,
    };
  }
  const buttons: CustomerButton[] = [];
  if (detail.officialUrl !== null) {
    buttons.push({
      ...inlineLabel('apps.download'),
      url: detail.officialUrl,
    });
  }
  if (detail.alternativeUrl !== null) {
    buttons.push({
      ...inlineLabel('apps.alternative'),
      url: detail.alternativeUrl,
    });
  }
  if (detail.helpUrl !== null) {
    buttons.push({ ...inlineLabel('apps.help'), url: detail.helpUrl });
  }
  if (detail.service !== null) {
    if (detail.service.link) {
      buttons.push({
        ...inlineLabel('service.link'),
        data: `${SERVICE_RESEND_CALLBACK_PREFIX}${detail.service.id}`,
      });
    }
    if (detail.service.files) {
      buttons.push({
        ...inlineLabel('service.files'),
        data: `${SERVICE_FILES_CALLBACK_PREFIX}${detail.service.id}`,
      });
    }
  } else if (detail.manyServices) {
    buttons.push({
      ...inlineLabel('apps.services'),
      data: `${SERVICES_LIST_PAGE_CALLBACK_PREFIX}1`,
    });
  }
  buttons.push(
    {
      ...inlineLabel('apps.back'),
      data: `${TUTORIAL_PLATFORM_CALLBACK_PREFIX}${detail.platform}`,
    },
    mainMenuButton(),
  );
  return {
    key: detail.filesNote ? 'bot.apps.detail_files' : 'bot.apps.detail',
    values: { app: detail.title, description: detail.description, guide: detail.guide },
    buttons,
    orderId: null,
    ...(detail.image === null
      ? {}
      : {
          lead: [
            {
              kind: 'PHOTO_BYTES' as const,
              bytes: detail.image.bytes,
              mimeType: detail.image.mimeType,
              fileName: detail.image.mimeType === 'image/png' ? 'app.png' : 'app.jpg',
            },
          ],
        }),
  };
}

export function platformsButton(): CustomerButton {
  return {
    ...inlineLabel('apps.platforms'),
    data: TUTORIAL_CALLBACK_DATA,
  };
}

/**
 * The connection guide's first screen: the platforms (WP-A10).
 *
 * The five with a guide of their own always, and «🧩 سایر» only while the tenant files
 * an app there that this customer may see — decided by the catalogue, per tap.
 */
export async function tutorialChoiceReply(
  rt: BotRuntime,
  scope: TenantContext,
  customer: CustomerRecord,
): Promise<PendingReply> {
  const platforms =
    rt.deps.clientApps === undefined
      ? CONNECTION_GUIDE_PLATFORMS
      : await rt.deps.clientApps.platformsFor(scope, customer.id);
  return tutorialChoice(platforms);
}

/**
 * One platform: its recommended apps as buttons, or — when the tenant configured none
 * this customer may see — the platform's own `bot.tutorial.<platform>` guide, which is
 * exactly the screen a `to:<platform>` button opened before WP-A10.
 */
export async function tutorialPlatform(
  rt: BotRuntime,
  scope: TenantContext,
  customer: CustomerRecord,
  platform: ClientAppPlatform,
): Promise<PendingReply> {
  const apps =
    rt.deps.clientApps === undefined
      ? []
      : await rt.deps.clientApps.appsFor(scope, customer.id, platform);
  return clientAppPlatformScreen(platform, apps);
}

/** One app: its guide, its download links, and the customer's own service actions. */
export async function clientApp(
  rt: BotRuntime,
  scope: TenantContext,
  customer: CustomerRecord,
  appId: string,
  botInstanceId: BotInstanceId,
): Promise<PendingReply> {
  const detail =
    rt.deps.clientApps === undefined
      ? null
      : await rt.deps.clientApps.appFor(scope, customer.id, appId);
  const screen = clientAppScreen(detail);
  /*
   * Spec §7: the app's tutorial video, when an administrator set one through THIS bot — a
   * `file_id` is valid only for the bot that received it. Sent by reference, nothing
   * downloaded.
   *
   * A4 (delta a): the video IS the screen's message — the guide its caption, the buttons on
   * it — when the rendered guide fits a caption whole (`ReplyMedia.captionWhole`). Longer,
   * the video goes bare and the guide follows as today's text. A video Telegram refuses is
   * dropped and the guide still goes out as text, with its buttons.
   */
  const video =
    detail === null || rt.deps.clientAppVideos === undefined
      ? null
      : await rt.deps.clientAppVideos.videoFor(scope, appId, botInstanceId);
  if (video === null) return screen;
  return {
    ...screen,
    media: { botInstanceId, kind: 'VIDEO', fileId: video.fileId, captionWhole: true },
  };
}
