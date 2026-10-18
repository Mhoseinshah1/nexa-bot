import { TELEGRAM_CAPTION_MAX } from './message-split.js';
import { clipEntities, type CaptionEntity } from '@nexa/i18n';

/*
 * The closed caption grammar (`parseCaptionMarkup`, its entity types and `clipEntities`)
 * lives in `@nexa/i18n` since Track 3 §2, so the Web Admin's caption preview and the bot
 * share one implementation. Re-exported here so every API caller keeps its import.
 */
export {
  CAPTION_ENTITY_TYPES,
  clipEntities,
  parseCaptionMarkup,
  type CaptionEntity,
  type CaptionEntityType,
  type CaptionMarkup,
} from '@nexa/i18n';

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
