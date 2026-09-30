import type { ReactNode } from 'react';

/**
 * A phone-shaped frame around what a customer will see in Telegram: the chat's
 * title bar, the message area, and the reply keyboard docked beneath it.
 *
 * Presentation only. It renders what the caller gives it — the bot-buttons page
 * its keyboard, the client-apps page its message as TEXT — and invents nothing:
 * no sample greeting, no fake time, no read receipts, because a preview that
 * shows something the bot will not send is a preview of a different bot.
 *
 * Colours come from the theme tokens, so the frame follows light and dark with
 * the rest of the admin; no `style` attribute anywhere (CSP `style-src 'self'`).
 */
export function TelegramPhone({
  title,
  children,
  keyboard,
}: {
  /** The chat's name in the title bar — the bot's @username when there is one. */
  title: ReactNode;
  /** The message area. */
  children?: ReactNode;
  /** The reply keyboard docked under the messages. */
  keyboard?: ReactNode;
}) {
  return (
    <div className="tg-phone">
      <div className="tg-phone-top">
        <span className="tg-phone-avatar" aria-hidden="true" />
        <span className="tg-phone-title">{title}</span>
      </div>
      <div className="tg-phone-body">{children}</div>
      {keyboard !== undefined && <div className="tg-phone-keyboard">{keyboard}</div>}
    </div>
  );
}
