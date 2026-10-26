// R10 D2: the answer to a tap on an owner-defined main-menu button.
import type { BotInstanceId, TenantContext } from '@nexa/contracts';
import { inlineLabel } from '../../../modules/commerce/messaging/application/inline-buttons.js';
import type { BotRuntime } from '../bot-runtime.js';
import { mainMenuButton } from './keyboards.js';
import type { PendingReply } from './replies.js';

/** The reply for a button that cannot be answered now: one sentence and the way back. */
function unavailable(): PendingReply {
  return {
    key: 'bot.custom_button.unavailable',
    values: {},
    buttons: [mainMenuButton()],
    orderId: null,
  };
}

/**
 * A tap on an owner-defined main-menu button.
 *
 * The route that brought the customer here granted nothing: `forTap` decides again, from
 * state, for the SENDING bot — the feature is on, the button exists and is not archived, it is
 * shown on this bot and the published layout places it with its switch on. Whatever it says
 * no to is `bot.custom_button.unavailable` (a keyboard drawn before the change is still in
 * the chat). A tap reads and sends; it writes no order, ledger, wallet or notification row.
 *
 * - LINK: a message with ONE inline URL button holding the stored, normalised https address
 *   (a reply keyboard cannot open a URL itself).
 * - TEXT: the operator's text, as plain text.
 * - PHOTO / DOCUMENT: the stored bytes as a multipart upload, with the caption when there is
 *   one (`PendingReply.mediaBytes`).
 *
 * Gates (membership, terms, captcha) are not exempted: this runs inside `guardedAct` like
 * every customer intent.
 */
export async function customButtonTap(
  rt: BotRuntime,
  scope: TenantContext,
  botInstanceId: BotInstanceId,
  buttonId: string,
): Promise<PendingReply> {
  if (rt.deps.customMenuButtons === undefined) return unavailable();
  const tap = await rt.deps.customMenuButtons.forTap(scope, buttonId, botInstanceId);
  switch (tap.outcome) {
    case 'UNAVAILABLE':
      return unavailable();
    case 'TEXT':
      return {
        key: 'bot.custom_button.text',
        values: { text: tap.text },
        buttons: [],
        orderId: null,
      };
    case 'LINK':
      return {
        key: 'bot.custom_button.link',
        values: tap.note === null ? {} : { text: tap.note },
        buttons: [{ ...inlineLabel('custom.link_open'), url: tap.url }],
        orderId: null,
      };
    case 'MEDIA': {
      const caption = tap.caption;
      const captioned = caption !== null;
      return {
        key: captioned ? 'bot.custom_button.caption' : 'bot.custom_button.unavailable',
        values: captioned ? { caption } : {},
        buttons: [],
        orderId: null,
        mediaBytes: {
          kind: tap.kind,
          bytes: tap.bytes,
          mimeType: tap.mimeType as 'image/png' | 'image/jpeg' | 'application/pdf' | 'text/plain',
          fileName: tap.fileName,
          captioned,
        },
      };
    }
  }
}
