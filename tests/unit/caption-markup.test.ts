import { describe, expect, it } from 'vitest';
import {
  parseCaptionMarkup,
  placeCaptionEntities,
} from '../../apps/api/src/modules/commerce/messaging/application/caption-markup';
import {
  planMediaBatches,
  TELEGRAM_MEDIA_GROUP_MAX,
} from '../../apps/api/src/modules/commerce/messaging/application/media-group';

/**
 * Round N (F2): a provider's caption is read by a closed grammar into text and Telegram
 * entities — never handed to Telegram's HTML parser — and the files are cut into the fewest
 * albums Telegram accepts, in order.
 */
describe('parseCaptionMarkup', () => {
  it('turns <code> into a code entity and never leaves a raw tag in the text', () => {
    const parsed = parseCaptionMarkup('<code>user1</code>\nLimit: 50 GB\nExpires: 2026-10-29');
    expect(parsed.text).toBe('user1\nLimit: 50 GB\nExpires: 2026-10-29');
    expect(parsed.entities).toEqual([{ type: 'code', offset: 0, length: 5 }]);
  });

  it('keeps every formatting tag Telegram knows, nested, in UTF-16 offsets', () => {
    const parsed = parseCaptionMarkup('📄 <b>Config <i>v2</i></b> <s>old</s> <u>x</u>');
    expect(parsed.text).toBe('📄 Config v2 old x');
    // The emoji is two UTF-16 code units: offsets count them, as Telegram does.
    expect(parsed.entities).toEqual([
      { type: 'bold', offset: 3, length: 9 },
      { type: 'italic', offset: 10, length: 2 },
      { type: 'strikethrough', offset: 13, length: 3 },
      { type: 'underline', offset: 17, length: 1 },
    ]);
  });

  it('reads anything that is not a known tag as text, and decodes only the HTML entities', () => {
    const parsed = parseCaptionMarkup('a < b &amp; c &lt;d&gt; <3 &nbsp; &#1583;');
    expect(parsed.text).toBe('a < b & c <d> <3 &nbsp; د');
    expect(parsed.entities).toEqual([]);
  });

  it('drops a link and its href but keeps the text; drops attributes it does not trust', () => {
    const parsed = parseCaptionMarkup(
      '<a href="https://evil.example">guide</a> <b class="x">y</b>',
    );
    expect(parsed.text).toBe('guide y');
    expect(parsed.entities).toEqual([]);
  });

  it('closes an unclosed tag at the end, ignores a stray closing tag, nests nothing in code', () => {
    expect(parseCaptionMarkup('</b>free <b>bold').entities).toEqual([
      { type: 'bold', offset: 5, length: 4 },
    ]);
    const code = parseCaptionMarkup('<code>a<b>b</b>c</code>');
    expect(code.text).toBe('abc');
    expect(code.entities).toEqual([{ type: 'code', offset: 0, length: 3 }]);
  });

  it('trims the caption and moves the entities with it; markup alone is empty', () => {
    const parsed = parseCaptionMarkup('  \n<code> x </code>\n ');
    expect(parsed.text).toBe('x');
    expect(parsed.entities).toEqual([{ type: 'code', offset: 0, length: 1 }]);
    expect(parseCaptionMarkup('<b></b>')).toEqual({ text: '', entities: [] });
  });
});

describe('placeCaptionEntities', () => {
  const entities = [{ type: 'code' as const, offset: 0, length: 5 }];

  it('places the entities on the value where the rendered caption holds it once', () => {
    expect(placeCaptionEntities('📁 user1 rest', 'user1 rest', entities)).toEqual({
      caption: '📁 user1 rest',
      entities: [{ type: 'code', offset: 3, length: 5 }],
    });
  });

  it('drops them — the text goes plain — when the value appears twice or not at all', () => {
    expect(placeCaptionEntities('user1 / user1', 'user1', entities).entities).toEqual([]);
    expect(placeCaptionEntities('something else', 'user1', entities).entities).toEqual([]);
  });

  it('cuts a caption over 1024 with an ellipsis and clips every entity to what is left', () => {
    const value = `${'x'.repeat(1020)}ABCDEFGH`;
    const placed = placeCaptionEntities(value, value, [
      { type: 'bold', offset: 1018, length: 8 },
      { type: 'code', offset: 1025, length: 3 },
    ]);
    expect(placed.caption).toHaveLength(1024);
    expect(placed.caption.endsWith('…')).toBe(true);
    expect(placed.entities).toEqual([{ type: 'bold', offset: 1018, length: 5 }]);
  });
});

describe('planMediaBatches', () => {
  const docs = (n: number) => Array.from({ length: n }, () => 'DOCUMENT' as const);

  it('sends one file alone and two to ten as one album, in order', () => {
    expect(planMediaBatches(docs(1))).toEqual([[0]]);
    expect(planMediaBatches(docs(2))).toEqual([[0, 1]]);
    expect(planMediaBatches(docs(TELEGRAM_MEDIA_GROUP_MAX))).toEqual([
      Array.from({ length: 10 }, (_, i) => i),
    ]);
  });

  it('uses the fewest albums and never leaves one with a single file', () => {
    expect(planMediaBatches(docs(11)).map((batch) => batch.length)).toEqual([6, 5]);
    expect(planMediaBatches(docs(20)).map((batch) => batch.length)).toEqual([10, 10]);
    expect(planMediaBatches(docs(21)).map((batch) => batch.length)).toEqual([7, 7, 7]);
    expect(planMediaBatches(docs(11)).flat()).toEqual(Array.from({ length: 11 }, (_, i) => i));
  });

  it('never puts a photo in a documents album, and keeps the order contiguous', () => {
    expect(planMediaBatches(['DOCUMENT', 'DOCUMENT', 'PHOTO', 'DOCUMENT', 'DOCUMENT'])).toEqual([
      [0, 1],
      [2],
      [3, 4],
    ]);
  });
});
