import type { InlineButtonStyle } from '@nexa/contracts';
import { t } from '../../i18n/web.fa';
import { TelegramPhone } from '../telegram-phone';

/** One button of the preview, as the section's table already draws it. */
export interface RichPreviewButton {
  readonly key: string;
  readonly label: string;
  readonly style: InlineButtonStyle;
  /** A premium icon is set for it (and its id is valid). */
  readonly icon: boolean;
}

/**
 * R4 PR-F (F8): where the inline buttons sit, under the tenant's own switches.
 *
 * - «دکمه‌های داخل پیام» off: under the message, an ordinary inline keyboard — today.
 * - on: inside the message bubble (a rich message's buttons block). A button with a premium
 *   icon stays UNDER the message while «ایموجی پریمیوم» is on, exactly as the bot sends it:
 *   a button inside a rich message has no icon field, so the bot keeps that row an inline
 *   keyboard rather than drop the icon. With «ایموجی پریمیوم» off no button carries an icon.
 *
 * It draws the buttons the table above shows — their real labels and styles — and a
 * description of the layout, never a sample customer message: a preview that showed text the
 * bot does not send would be a preview of a different bot. `null` switches (not readable)
 * draw today's layout and say the switches are unknown.
 */
export function RichModePreview({
  rich,
  premium,
  buttons,
}: {
  rich: boolean | null;
  premium: boolean | null;
  buttons: readonly RichPreviewButton[];
}) {
  const inside = rich === true;
  const drawIcons = inside ? premium === true : true;
  const inBubble = inside ? buttons.filter((one) => !(drawIcons && one.icon)) : [];
  const below = inside ? buttons.filter((one) => drawIcons && one.icon) : buttons;
  const key = (one: RichPreviewButton) => (
    <span
      key={one.key}
      className={`menu-preview-key ib-preview bb-style-${one.style}`}
      data-testid="ib-rich-preview-key"
    >
      {drawIcons && one.icon && (
        <span className="bb-icon-mark" title={t('web.ib_icon_mark_title')} aria-hidden="true">
          ✦
        </span>
      )}
      {one.label}
    </span>
  );
  return (
    <section className="ib-rich-preview" aria-labelledby="ib-rich-preview-title">
      <h4 id="ib-rich-preview-title" className="bb-pane-title">
        {t('web.ib_rich_preview_title')}
      </h4>
      <p className="muted small" data-testid="ib-rich-preview-mode">
        {t(
          rich === null
            ? 'web.ib_rich_preview_unknown'
            : rich
              ? premium === true
                ? 'web.ib_rich_preview_on_premium'
                : 'web.ib_rich_preview_on'
              : 'web.ib_rich_preview_off',
        )}
      </p>
      <TelegramPhone title={t('web.ib_rich_preview_chat')}>
        <div className="bot-preview" data-testid="ib-rich-preview-bubble" data-rich={inside}>
          <p className="tg-phone-note">{t('web.ib_rich_preview_note')}</p>
          {inBubble.length > 0 && (
            <div className="tg-phone-inline in-bubble" data-testid="ib-rich-preview-inside">
              {inBubble.map(key)}
            </div>
          )}
        </div>
        {below.length > 0 && (
          <div className="tg-phone-inline" data-testid="ib-rich-preview-below">
            {below.map(key)}
          </div>
        )}
      </TelegramPhone>
    </section>
  );
}
