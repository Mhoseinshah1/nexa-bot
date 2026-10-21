import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * R5C-2 B3 — every inline keyboard goes through the shared rich sender.
 *
 * With «دکمه‌های داخل پیام» on, a screen's buttons sit INSIDE its message. That is only true
 * if nothing builds an inline keyboard on its own: the owner found the delivery card's three
 * buttons still below the bubble because that screen was a photo caption. This scan fails when
 * a source file other than the ones below puts a keyboard (or a text/file body that can carry
 * one) on the wire, so a new "direct sendMessage with reply_markup" cannot appear unnoticed.
 *
 * Every file allowed is allowed for a stated reason:
 *
 * - the BUILDERS (`send-message.ts`, `rich-message.ts`): shapes, no decisions;
 * - the shared sender, `TelegramCustomerMessenger`: the one place a customer screen is sent,
 *   rich or ordinary;
 * - the broadcast transport: a TEXT broadcast goes through the same rich blocks when the
 *   switch is on (asserted below); its media and copied messages cannot be rich;
 * - the operations-group transport and the group's test message: operator-facing log lines in
 *   a forum topic, not a customer screen.
 *
 * MUTATION: adding `reply_markup` to any other source file fails the first test; making the
 * broadcast transport send its TEXT body without the rich path fails the second.
 */
const ROOT = join(__dirname, '..', '..', 'apps', 'api', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** Source with its comments removed: a doc comment may MENTION `reply_markup`. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const KEYBOARD_WIRE =
  /reply_markup|inline_keyboard|telegramButtonMarkup|textMessageBody\(|fileMessageBody\(|editMessageBody\(|editCaptionBody\(|richMessageBody\(|editRichMessageBody\(|fileUploadBody\(|mediaGroupUploadBody\(/;

const ALLOWED_KEYBOARD_BUILDERS: Readonly<Record<string, string>> = {
  'infrastructure/telegram/send-message.ts': 'the body builders',
  'infrastructure/telegram/rich-message.ts': 'the rich body builders',
  'modules/commerce/messaging/infrastructure/telegram-customer-messenger.ts':
    'the shared sender of every customer screen',
  'modules/commerce/broadcasts/infrastructure/telegram-broadcast.transport.ts':
    'broadcasts: TEXT through the rich blocks when the switch is on; media and copies cannot be rich',
  'modules/control/notifications/infrastructure/telegram-transport.ts':
    'operations-group log lines (operator-facing, URL buttons in a forum topic)',
  'modules/control/ops-group/infrastructure/telegram-ops-group.ts':
    'the operations group test message (no keyboard)',
};

/**
 * Files that send a FILE (photo, video, document) through the shared sender. A file's caption
 * cannot hold buttons inside the bubble, so these are the media screens; the delivery card —
 * the one the owner found — is NOT among the ones that put its buttons on a caption while the
 * switch is on (`qrThenCard`, tested in delivery-card.test.ts).
 */
const MEDIA_SENDERS: Readonly<Record<string, string>> = {
  'modules/commerce/provisioning/application/delivery.service.ts':
    'delivery card and link views: QR first, then the card as a rich message when the switch is on',
  'modules/commerce/provisioning/application/subscription-file.service.ts':
    'configuration files: the file is the content, no keyboard',
  'modules/commerce/payments/application/receipt-review-push.service.ts':
    "the reviewer's receipt: the image is the evidence and its caption is edited in place",
  'modules/commerce/messaging/application/customer-notification.service.ts':
    'a notification kind that carries a file',
  'modules/control/client-apps/application/delivery-tutorial-sender.ts':
    'the tutorial video: the guide is the caption, no keyboard',
  'surfaces/telegram/bot-runtime.ts': 'a reply that carries media (welcome banner, tutorial video)',
};

const relativePaths = (pattern: RegExp) =>
  sourceFiles(ROOT)
    .filter((path) => pattern.test(code(path)))
    .map((path) => relative(ROOT, path).split('\\').join('/'))
    .sort();

describe('no inline keyboard bypasses the shared sender', () => {
  it('only the builders, the shared sender and the stated exceptions put a keyboard on the wire', () => {
    expect(relativePaths(KEYBOARD_WIRE)).toEqual(Object.keys(ALLOWED_KEYBOARD_BUILDERS).sort());
  });

  it('only the stated media screens send a file', () => {
    expect(relativePaths(/\.sendFile\(/)).toEqual(Object.keys(MEDIA_SENDERS).sort());
  });

  it('the broadcast TEXT body goes through the rich blocks and the tenant’s switch', () => {
    const source = code(
      join(ROOT, 'modules/commerce/broadcasts/infrastructure/telegram-broadcast.transport.ts'),
    );
    expect(source).toContain("method: 'sendRichMessage'");
    expect(source).toContain('richBlocksFromText');
    expect(source).toContain('this.rich');
  });

  it('the delivery card is a rich message with the switch on, not a caption with buttons', () => {
    const source = code(
      join(ROOT, 'modules/commerce/provisioning/application/delivery.service.ts'),
    );
    expect(source).toContain('buttonsInBubble');
    expect(source).toContain('qrThenCard');
  });
});
