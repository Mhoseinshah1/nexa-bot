import { describe, expect, it } from 'vitest';
import {
  plainTableText,
  richBlocksFromText,
} from '../../apps/api/src/infrastructure/telegram/rich-message';

/**
 * R5C-2 B2 — a table the owner writes by hand in a template or a broadcast:
 *
 *     | سرویس | حجم | قیمت |
 *     | --- | --- | --- |
 *     | طلایی | ۵۰ | ۲۵۰ |
 *
 * is a `table` block in a rich message and plain `a | b | c` lines everywhere else.
 * MUTATION: dropping `tablesIn` from `richBlocksFromText` fails the rich tests; dropping the
 * separator filter in `plainTableText` fails the fallback test.
 */
const TABLE = ['| سرویس | حجم | قیمت |', '| --- | :---: | --- |', '| طلایی | ۵۰ | ۲۵۰ |'].join(
  '\n',
);

const rich = (text: string, html = false) =>
  richBlocksFromText({ text, html, customEmoji: false }) as Record<string, unknown>[];

describe('a hand-written table is a rich table block', () => {
  it('turns pipe rows into one table: header first, separator dropped', () => {
    const blocks = rich(`قیمت‌ها:\n${TABLE}\nپایان`);
    expect(blocks.map((block) => block['type'])).toEqual(['paragraph', 'table', 'paragraph']);
    const table = blocks[1] as {
      cells: { text: unknown; is_header?: boolean }[][];
      is_compact: boolean;
    };
    expect(table.is_compact).toBe(true);
    expect(table.cells.map((row) => row.map((cell) => cell.text))).toEqual([
      ['سرویس', 'حجم', 'قیمت'],
      ['طلایی', '۵۰', '۲۵۰'],
    ]);
    expect(table.cells[0]?.every((cell) => cell.is_header === true)).toBe(true);
    expect(table.cells[1]?.some((cell) => cell.is_header === true)).toBe(false);
  });

  it('works in an HTML template too, keeping a cell’s formatting', () => {
    const blocks = rich('| <b>نام</b> | قیمت |\n| الف | ۱ |', true);
    const table = blocks[0] as { type: string; cells: { text: unknown }[][] };
    expect(table.type).toBe('table');
    expect(table.cells[0]?.[0]?.text).toEqual({ type: 'bold', text: 'نام' });
    expect(table.cells[1]?.[1]?.text).toBe('۱');
  });

  it('leaves a lone pipe line, or rows of different widths, as ordinary paragraphs', () => {
    expect(rich('| فقط یک خط |').map((block) => block['type'])).toEqual(['paragraph']);
    expect(rich('| الف | ب |').map((block) => block['type'])).toEqual(['paragraph']);
    expect(rich('| الف | ب |\n| ج |').map((block) => block['type'])).toEqual([
      'paragraph',
      'paragraph',
    ]);
    // Pipes in the middle of a sentence are text.
    expect(rich('الف | ب').map((block) => block['type'])).toEqual(['paragraph']);
  });

  it('a text with no table converts exactly as it did', () => {
    const blocks = rich('سلام\n• یک\n• دو');
    expect(blocks.map((block) => block['type'])).toEqual(['paragraph', 'list']);
  });
});

describe('without rich messages the table reads as plain lines', () => {
  it('drops the separator and the edge pipes, one row per line', () => {
    expect(plainTableText(`قیمت‌ها:\n${TABLE}\nپایان`)).toBe(
      'قیمت‌ها:\nسرویس | حجم | قیمت\nطلایی | ۵۰ | ۲۵۰\nپایان',
    );
  });

  it('returns a text with no table byte for byte, including lone pipe lines', () => {
    for (const text of ['سلام', 'الف | ب', '| فقط یک خط |', '| الف | ب |\n| ج |', '']) {
      expect(plainTableText(text), text).toBe(text);
    }
  });
});
