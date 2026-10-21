/**
 * R5C-2 B2 — the table block of a hand-written text (a template in «متن‌ها» or a broadcast).
 *
 * A table is written as consecutive lines that start and end with `|`, the first row being the
 * header and an optional `| --- | --- |` row separating it. The bot sends it as a table block in
 * a rich message («دکمه‌های داخل پیام» on) and as plain `a | b` lines otherwise; this file only
 * (a) inserts a skeleton where the caret is and (b) reads a table back for the preview. The
 * bot's own parser (`apps/api/.../rich-message.ts`) is the one that decides what is sent, and
 * `tests/web/table-text.test.ts` pins the two on the same fixtures.
 */

const PIPE_ROW = /^\s*\|.*\|\s*$/u;
const SEPARATOR_CELL = /^:?-{3,}:?$/u;

/** One piece of a text: ordinary lines, or the table that stood between them. */
export type TextSegment =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'table';
      readonly header: readonly string[];
      readonly rows: readonly (readonly string[])[];
    };

function cellsOf(line: string): string[] {
  const inner = /^\s*\|(.*)\|\s*$/u.exec(line)?.[1] ?? '';
  return inner.split('|').map((cell) => cell.trim());
}

/**
 * The text cut into ordinary runs and tables. A run of pipe rows is a table only with a header
 * and at least one data row of the same width — anything else stays text, as it does in the bot.
 */
export function textSegments(text: string): TextSegment[] {
  const lines = text.split('\n');
  const segments: TextSegment[] = [];
  let plain: string[] = [];
  const flush = () => {
    if (plain.length > 0) segments.push({ kind: 'text', text: plain.join('\n') });
    plain = [];
  };
  let at = 0;
  while (at < lines.length) {
    if (!PIPE_ROW.test(lines[at] as string)) {
      plain.push(lines[at] as string);
      at += 1;
      continue;
    }
    let end = at;
    while (end < lines.length && PIPE_ROW.test(lines[end] as string)) end += 1;
    const run = lines.slice(at, end).map(cellsOf);
    const data = run.filter((cells) => !cells.every((cell) => SEPARATOR_CELL.test(cell)));
    if (data.length >= 2 && new Set(data.map((cells) => cells.length)).size === 1) {
      flush();
      segments.push({ kind: 'table', header: data[0] as string[], rows: data.slice(1) });
    } else {
      plain.push(...lines.slice(at, end));
    }
    at = end;
  }
  flush();
  return segments;
}

/**
 * The text as the bot sends it when it is NOT a rich message: each table as `a | b` rows,
 * the separator dropped, every other line byte for byte. The same reading as the bot's
 * `plainTableText`, which `tests/unit/r5c2-web-table-text.test.ts` runs over the same fixtures.
 */
export function plainTableLines(text: string): string {
  return textSegments(text)
    .map((segment) =>
      segment.kind === 'text'
        ? segment.text
        : [segment.header, ...segment.rows].map((cells) => cells.join(' | ')).join('\n'),
    )
    .join('\n');
}

/**
 * `body` with `skeleton` inserted at the selection, on lines of its own. Null when the result
 * would not fit `max`, so the caller leaves the text alone rather than cutting a table.
 */
export function insertTable(
  body: string,
  start: number,
  end: number,
  skeleton: string,
  max: number,
): { readonly next: string; readonly caret: number } | null {
  const before = body.slice(0, start);
  const after = body.slice(end);
  const lead = before === '' || before.endsWith('\n') ? '' : '\n';
  const tail = after === '' || after.startsWith('\n') ? '' : '\n';
  const next = `${before}${lead}${skeleton}${tail}${after}`;
  if (next.length > max) return null;
  return { next, caret: before.length + lead.length + skeleton.length };
}
