import { t } from '../../i18n/web.fa';
import { TelegramPhone } from '../telegram-phone';
import { PreviewKeyboard, type PreviewKey } from './canvas';
import type { ReactNode } from 'react';

/**
 * Demo parity: the menu preview sits under the editable layout, so the operator sees the
 * keyboard a customer gets while arranging it (it is the same `customerRows` the «مشتری» mode
 * shows; nothing new is read or decided here).
 */
export function MenuPreview({
  title,
  rows,
}: {
  title: ReactNode;
  rows: readonly (readonly PreviewKey[])[];
}) {
  return (
    <section className="bb-menu-preview" aria-labelledby="bb-menu-preview-title">
      <h4 id="bb-menu-preview-title" className="bb-pane-title">
        {t('web.bb_menu_preview_title')}
      </h4>
      <TelegramPhone
        title={title}
        keyboard={
          <PreviewKeyboard
            rows={rows}
            label={t('web.bb_menu_preview_title')}
            testId="bb-menu-preview"
          />
        }
      >
        <p className="tg-phone-note">{t('web.bb_mode_customer_note')}</p>
        {rows.length === 0 && <p className="tg-phone-note">{t('web.bot_buttons_preview_empty')}</p>}
      </TelegramPhone>
    </section>
  );
}
