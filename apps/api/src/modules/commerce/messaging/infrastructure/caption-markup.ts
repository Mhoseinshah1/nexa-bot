import { TELEGRAM_CAPTION_MAX } from '../application/message-split.js';
import {
  clipEntities,
  formatDateOnly,
  parseCaptionMarkup,
  renderConnectionFileCaption,
} from '@nexa/i18n';
import type { CaptionEntity, CaptionText } from '../application/caption-markup.js';

/*
 * The closed caption grammar (`parseCaptionMarkup`, `clipEntities`) and the connection-file
 * caption renderer live in `@nexa/i18n` (Track 3 §2), so the Web Admin's caption preview and
 * the bot share one implementation. An application file may not import the catalogue
 * package (`check-boundaries.sh`); it names what it needs as the `CaptionText` port, and
 * this adapter — bound in `container.ts` — is the implementation.
 */
export { clipEntities, parseCaptionMarkup } from '@nexa/i18n';

/** The `CaptionText` port, over `@nexa/i18n`. */
export const I18N_CAPTION_TEXT: CaptionText = {
  parse: (raw) => parseCaptionMarkup(raw),
  renderConnectionFileCaption: (body, values, presentation) =>
    renderConnectionFileCaption(body, values, presentation),
  jalaliDate: (date, timezone) => formatDateOnly(date, { timezone, calendar: 'jalali' }),
};

/**
 * A rendered caption and its entities, within Telegram's caption bound.
 *
 * `value` is the provider text the entities are relative to, and `rendered` the tenant's
 * template with that text inside it. The entities are placed only when the value occurs in
 * the rendered caption EXACTLY ONCE — then that occurrence is the substituted one, whatever
 * else the operator wrote around it; otherwise they are dropped and the text goes plain,
 * which is never wrong, only unformatted.
 *
 * Over the bound, the caption is cut with a visible ellipsis (never inside a surrogate
 * pair) and every entity is clipped to what is left — Telegram refuses an entity that runs
 * past the text.
 */
export function placeCaptionEntities(
  rendered: string,
  value: string,
  entities: readonly CaptionEntity[],
): { readonly caption: string; readonly entities: readonly CaptionEntity[] } {
  let placed: CaptionEntity[] = [];
  if (entities.length > 0 && value.length > 0) {
    const first = rendered.indexOf(value);
    const unique = first !== -1 && rendered.indexOf(value, first + 1) === -1;
    if (unique) {
      placed = entities.map((entity) => ({ ...entity, offset: entity.offset + first }));
    }
  }
  if (rendered.length <= TELEGRAM_CAPTION_MAX) return { caption: rendered, entities: placed };
  let cut = TELEGRAM_CAPTION_MAX - 1;
  const last = rendered.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return { caption: `${rendered.slice(0, cut)}…`, entities: clipEntities(placed, 0, cut) };
}
