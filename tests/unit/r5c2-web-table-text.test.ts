import { describe, expect, it } from 'vitest';
import { insertTable, textSegments } from '../../apps/web/src/table-text';
import {
  plainTableText,
  richBlocksFromText,
} from '../../apps/api/src/infrastructure/telegram/rich-message';

/**
 * R5C-2 B2 — the Web Admin's reading of a hand-written table (the broadcast preview and the
 * insert button) agrees with the bot's. The bot's parser decides what is SENT; if the preview
 * called something a table that the bot sends as lines, the owner would be shown a message
 * that is not the one that goes out. Both are run over the same fixtures.
 *
 * MUTATION: loosening the preview's width rule (accepting ragged rows) fails the agreement
 * test; dropping the separator filter fails the first test.
 */
const FIXTURES: readonly [string, string][] = [
  ['a header and a row', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
  ['no separator', '| a | b |\n| 1 | 2 |'],
  ['text around', 'قبل\n| a | b |\n| 1 | 2 |\nبعد'],
  ['a lone pipe line', '| a | b |'],
  ['ragged rows', '| a | b |\n| 1 |'],
  ['pipes in a sentence', 'الف | ب'],
  ['two tables', '| a | b |\n| 1 | 2 |\n\n| c | d |\n| 3 | 4 |'],
];

describe('the preview reads a table the way the bot does', () => {
  it.each(FIXTURES)('%s', (_name, text) => {
    const botTables = (richBlocksFromText({ text, html: false, customEmoji: false }) ?? []).filter(
      (block) => block['type'] === 'table',
    ).length;
    const previewTables = textSegments(text).filter((segment) => segment.kind === 'table').length;
    expect(previewTables).toBe(botTables);
  });

  it('cuts the header, the separator and the rows apart', () => {
    expect(textSegments('قبل\n| a | b |\n| --- | :---: |\n| 1 | 2 |\nبعد')).toEqual([
      { kind: 'text', text: 'قبل' },
      { kind: 'table', header: ['a', 'b'], rows: [['1', '2']] },
      { kind: 'text', text: 'بعد' },
    ]);
  });

  it('the plain fallback is exactly what the bot sends without rich messages', () => {
    const text = 'قبل\n| a | b |\n| --- | --- |\n| 1 | 2 |';
    expect(plainTableText(text)).toBe('قبل\na | b\n1 | 2');
  });
});

describe('inserting a table block', () => {
  const SKELETON = '| x | y |\n| --- | --- |\n| 1 | 2 |';

  it('puts the skeleton on lines of its own, wherever the caret is', () => {
    expect(insertTable('', 0, 0, SKELETON, 100)).toEqual({
      next: SKELETON,
      caret: SKELETON.length,
    });
    expect(insertTable('سلام', 4, 4, SKELETON, 100)?.next).toBe(`سلام\n${SKELETON}`);
    expect(insertTable('الف\nب', 3, 3, SKELETON, 100)?.next).toBe(`الف\n${SKELETON}\nب`);
    // A selection is replaced.
    expect(insertTable('الف XX ب', 4, 6, SKELETON, 100)?.next).toBe(`الف \n${SKELETON}\n ب`);
  });

  it('leaves the text alone rather than cutting a table past the limit', () => {
    expect(insertTable('x'.repeat(10), 10, 10, SKELETON, 20)).toBeNull();
  });
});
