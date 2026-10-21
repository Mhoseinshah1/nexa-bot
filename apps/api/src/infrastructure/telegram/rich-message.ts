import {
  telegramButtonMarkup,
  type TelegramButton,
  type TelegramMessageEntity,
} from './send-message.js';

/**
 * R4 PR-F: the bodies of Telegram's RICH messages — `sendRichMessage` and
 * `editMessageText(rich_message)` — built from the same rendered text, entities and labelled
 * buttons the ordinary bodies are built from.
 *
 * Every shape here is the Bot API's own (Bot API 10.3, verified in
 * `docs/r4-telegram-rich-audit.md` §1): `InputRichMessage.blocks` with `is_rtl`,
 * `InputRichBlockParagraph`, `…SectionHeading`, `…Divider`, `…List`, `…Details`, `…Table`
 * (`is_compact`), `InputRichBlockButtons` (1–8 `RichMessageButton`s, one row), and the rich
 * texts `bold`, `italic`, `underline`, `strikethrough`, `spoiler`, `code`, `url`,
 * `custom_emoji` (`alternative_text`) and `date_time`.
 *
 * Deliberately `blocks`, never the `html` / `markdown` fields: the rich-message HTML dialect
 * is documented on a page this build could not read, and a guess about it would be a message
 * that renders wrongly with nothing to say so. Blocks are fully typed by the reference.
 *
 * Pure: no I/O, no clock. A text this cannot convert EXACTLY — an entity or a tag it does
 * not know, a tag that spans lines, a malformed date mark — returns `null`, and the caller
 * sends the ordinary message, unchanged. A conversion that guessed would be a screen that
 * says something other than what the template says.
 */

/** A `RichText`: a string, an array of rich texts, or one typed node. */
export type RichText =
  string | readonly RichText[] | { readonly type: string; readonly [field: string]: unknown };

/** One `InputRichBlock`, on its way to the wire. */
export type RichBlock = Readonly<Record<string, unknown>>;

/** `InputRichBlockButtons.buttons`: "List of 1-8 buttons to send". */
export const RICH_BUTTONS_PER_ROW_MAX = 8;

/**
 * The instant marks `renderTemplateBody({ markInstants })` wraps each date value in:
 * OPEN, the Unix time in decimal, TEXT, the text exactly as rendered, CLOSE. Declared in
 * `@nexa/i18n`; restated here as literals because this layer imports no package code it
 * does not need, and pinned equal by `tests/unit/rich-message-builders.test.ts`.
 */
export const RICH_INSTANT_OPEN = '';
export const RICH_INSTANT_TEXT = '';
export const RICH_INSTANT_CLOSE = '';
const MARK_CHARS = /[-]/u;

/** Removes the instant marks, leaving the date text exactly as rendered. */
export function withoutInstantMarks(text: string): string {
  return text.replace(/\d*/gu, '').replace(//gu, '');
}

/** How a screen's text is arranged, beyond one paragraph per line. */
export interface RichTextLayout {
  /** The first non-empty line is a section heading (a list's title). */
  readonly heading?: boolean;
  /** Everything after the first non-empty line goes inside an expandable details block. */
  readonly collapse?: boolean;
}

export interface RichTextSource {
  /** The rendered, decorated text of ONE message, with any instant marks still in it. */
  readonly text: string;
  readonly html: boolean;
  /** A plain body's decoration entities (`custom_emoji` only); ignored for HTML. */
  readonly entities?: readonly TelegramMessageEntity[];
  /**
   * Whether a custom emoji is drawn as `RichTextCustomEmoji`. False draws its covered emoji
   * as plain text — what a bot without premium emoji, or with «ایموجی پریمیوم» off, sends.
   */
  readonly customEmoji: boolean;
  readonly layout?: RichTextLayout;
}

type Line = RichText[];

/**
 * The text of one message as blocks, or `null` when it cannot be converted exactly.
 *
 * One line is one paragraph, and an empty line separates paragraphs — so every line break
 * the template has is a break the customer sees, with no claim about how a string with a
 * newline inside one paragraph renders. Three rules give the text structure:
 *
 * - a line of three or more dashes, rules or underscores alone is a divider;
 * - consecutive lines that start with `•` are one list, each item without its bullet;
 * - `layout` may make the first line a heading, or fold the rest into a details block.
 */
export function richBlocksFromText(source: RichTextSource): RichBlock[] | null {
  const lines = source.html
    ? htmlLines(source.text, source.customEmoji)
    : plainLines(source.text, source.entities ?? [], source.customEmoji);
  if (lines === null) return null;

  const blocks: RichBlock[] = [];
  let list: RichBlock[] | null = null;
  const closeList = () => {
    if (list !== null) blocks.push({ type: 'list', items: list });
    list = null;
  };
  const tables = tablesIn(lines);
  for (const [at, line] of lines.entries()) {
    const table = tables.get(at);
    if (table !== undefined) {
      closeList();
      // A table is written once, at its first row; its other rows were consumed with it.
      if (table.block !== null) blocks.push(table.block);
      continue;
    }
    const shown = projection(line);
    if (shown.trim() === '') {
      closeList();
      continue;
    }
    if (/^\s*[-‐-―─━_=~]{3,}\s*$/u.test(shown)) {
      closeList();
      blocks.push({ type: 'divider' });
      continue;
    }
    const item = withoutBullet(line);
    if (item !== null) {
      list ??= [];
      list.push({ blocks: [paragraph(item)] });
      continue;
    }
    closeList();
    blocks.push(paragraph(line));
  }
  closeList();
  if (blocks.length === 0) return null;

  const layout = source.layout ?? {};
  if (layout.heading === true && blocks[0]?.type === 'paragraph') {
    blocks[0] = { type: 'heading', text: blocks[0].text, size: 3 };
  }
  if (layout.collapse === true && blocks.length > 1) {
    const [first, ...rest] = blocks;
    const summary = first?.type === 'paragraph' || first?.type === 'heading' ? first.text : null;
    if (summary !== null && summary !== undefined) {
      return [{ type: 'details', summary, blocks: rest }];
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Tables written in a text (R5C-2 B2)
// ---------------------------------------------------------------------------

/**
 * A table the owner writes by hand in a template or a broadcast: consecutive lines that start
 * and end with `|`, cells between pipes. The first row is the header; a row of only dashes
 * (`| --- | --- |`, as in Markdown) is a separator and is dropped. Every row must have the same
 * number of cells, and there must be a header and at least one data row — anything else is
 * ordinary paragraphs, so a stray line with pipes is never turned into a one-cell table.
 */
const PIPE_ROW = /^\s*\|.*\|\s*$/u;
const SEPARATOR_CELL = /^:?-{3,}:?$/u;

/** The cells of one pipe row, trimmed; null when the line is not a pipe row. */
function pipeCells(line: Line): RichText[] | null {
  if (!PIPE_ROW.test(projection(line))) return null;
  const cells: RichText[][] = [[]];
  for (const node of line) {
    if (typeof node !== 'string') {
      (cells[cells.length - 1] as RichText[]).push(node);
      continue;
    }
    node.split('|').forEach((segment, index) => {
      if (index > 0) cells.push([]);
      if (segment !== '') (cells[cells.length - 1] as RichText[]).push(segment);
    });
  }
  // Text before the first pipe and after the last is the row's edge, not a cell.
  const inner = cells.slice(1, -1);
  if (inner.length === 0) return null;
  return inner.map((parts) => trimmedCell(parts));
}

function trimmedCell(parts: RichText[]): RichText {
  const copy = [...parts];
  if (typeof copy[0] === 'string') copy[0] = copy[0].replace(/^\s+/u, '');
  const last = copy.length - 1;
  if (typeof copy[last] === 'string') copy[last] = (copy[last] as string).replace(/\s+$/u, '');
  const kept = copy.filter((part) => part !== '');
  if (kept.length === 0) return '';
  return kept.length === 1 ? (kept[0] as RichText) : kept;
}

function isSeparatorRow(cells: readonly RichText[]): boolean {
  return cells.every((cell) => typeof cell === 'string' && SEPARATOR_CELL.test(cell));
}

/**
 * The tables in `lines`: for the index of each line a table consumed, `block` is the table
 * itself on its FIRST line and null on the rest.
 */
function tablesIn(lines: readonly Line[]): Map<number, { readonly block: RichBlock | null }> {
  const found = new Map<number, { readonly block: RichBlock | null }>();
  let at = 0;
  while (at < lines.length) {
    const first = pipeCells(lines[at] as Line);
    if (first === null) {
      at += 1;
      continue;
    }
    const rows: { readonly index: number; readonly cells: RichText[] }[] = [];
    let end = at;
    while (end < lines.length) {
      const cells = pipeCells(lines[end] as Line);
      if (cells === null) break;
      rows.push({ index: end, cells });
      end += 1;
    }
    const data = rows.filter((row) => !isSeparatorRow(row.cells));
    const header = data[0];
    const widths = new Set(data.map((row) => row.cells.length));
    if (header !== undefined && data.length >= 2 && widths.size === 1) {
      rows.forEach((row, position) => {
        found.set(row.index, {
          block:
            position === 0
              ? richTableBlock({
                  header: header.cells,
                  rows: data.slice(1).map((row) => row.cells),
                  compact: true,
                })
              : null,
        });
      });
    }
    at = end;
  }
  return found;
}

/**
 * A text with its hand-written tables as plain lines, for a message that is NOT rich: the
 * separator row is dropped and each row reads `a | b | c`. Used wherever the rich block is
 * not sent, so a table never reaches a customer as a wall of dashes. Lines that are not pipe
 * rows are returned byte for byte.
 */
export function plainTableText(text: string): string {
  if (!text.includes('|')) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let at = 0;
  while (at < lines.length) {
    if (!PIPE_ROW.test(lines[at] as string)) {
      out.push(lines[at] as string);
      at += 1;
      continue;
    }
    let end = at;
    while (end < lines.length && PIPE_ROW.test(lines[end] as string)) end += 1;
    const run = lines
      .slice(at, end)
      .map((line) =>
        (/^\s*\|(.*)\|\s*$/u.exec(line)?.[1] ?? '').split('|').map((cell) => cell.trim()),
      );
    const data = run.filter((cells) => !cells.every((cell) => SEPARATOR_CELL.test(cell)));
    const isTable = data.length >= 2 && new Set(data.map((cells) => cells.length)).size === 1;
    if (isTable) out.push(...data.map((cells) => cells.join(' | ')));
    else out.push(...lines.slice(at, end));
    at = end;
  }
  return out.join('\n');
}

function paragraph(line: Line): RichBlock {
  return { type: 'paragraph', text: line.length === 1 ? line[0] : line };
}

/** What a line reads as, for the structure rules only. */
function projection(line: Line): string {
  return line.map(shownText).join('');
}

function shownText(node: RichText): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(shownText).join('');
  const typed = node as { readonly type: string; readonly [field: string]: unknown };
  if (typed.type === 'custom_emoji') return String(typed.alternative_text ?? '');
  return shownText((typed.text ?? '') as RichText);
}

/** The line without its leading `•`, or null when it is not a bullet line. */
function withoutBullet(line: Line): Line | null {
  const head = line[0];
  if (typeof head !== 'string') return null;
  const match = /^\s*•\s?/u.exec(head);
  if (match === null) return null;
  const rest = head.slice(match[0].length);
  const tail = line.slice(1);
  const item = rest === '' ? tail : [rest, ...tail];
  return item.length === 0 ? null : item;
}

// ---------------------------------------------------------------------------
// The inline walk shared by both formats
// ---------------------------------------------------------------------------

/** Collects one format's inline nodes into lines, reading the instant marks on the way. */
class LineSink {
  readonly lines: Line[] = [[]];
  private buffer = '';

  /** `frame` answers the open tag's children, or null at the top of a line. */
  constructor(private readonly frame: () => RichText[] | null = () => null) {}

  private target(): RichText[] {
    return this.frame() ?? (this.lines[this.lines.length - 1] as RichText[]);
  }

  /** Appends plain characters; a newline is refused unless `breakable` says the line may end. */
  text(value: string, breakable: () => boolean): boolean {
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index] as string;
      if (char === '\n') {
        if (!breakable()) return false;
        this.flush();
        this.lines.push([]);
        continue;
      }
      if (char === RICH_INSTANT_OPEN) {
        const textAt = value.indexOf(RICH_INSTANT_TEXT, index);
        const closeAt = textAt < 0 ? -1 : value.indexOf(RICH_INSTANT_CLOSE, textAt);
        if (closeAt < 0) return false;
        const digits = value.slice(index + 1, textAt);
        const shown = value.slice(textAt + 1, closeAt);
        if (!/^\d{1,12}$/u.test(digits) || shown === '' || /[\n-]/u.test(shown)) {
          return false;
        }
        this.flush();
        // An empty format: "the underlying text is displayed as-is; however, the user can
        // still receive the underlying date in their local format" (date-time formatting).
        this.target().push({
          type: 'date_time',
          text: shown,
          unix_time: Number(digits),
          date_time_format: '',
        });
        index = closeAt;
        continue;
      }
      if (char === RICH_INSTANT_TEXT || char === RICH_INSTANT_CLOSE) return false;
      this.buffer += char;
    }
    return true;
  }

  node(value: RichText): void {
    this.flush();
    this.target().push(value);
  }

  flush(): void {
    if (this.buffer !== '') this.target().push(this.buffer);
    this.buffer = '';
  }
}

function plainLines(
  text: string,
  entities: readonly TelegramMessageEntity[],
  customEmoji: boolean,
): Line[] | null {
  const sorted = [...entities].sort((a, b) => a.offset - b.offset);
  const sink = new LineSink();
  let at = 0;
  for (const entity of sorted) {
    if (entity.type !== 'custom_emoji' || entity.custom_emoji_id === undefined) return null;
    if (entity.offset < at || entity.length <= 0) return null;
    if (!sink.text(text.slice(at, entity.offset), () => true)) return null;
    const covered = text.slice(entity.offset, entity.offset + entity.length);
    if (covered.length !== entity.length || /[\n-]/u.test(covered)) return null;
    if (customEmoji) {
      sink.node({
        type: 'custom_emoji',
        custom_emoji_id: entity.custom_emoji_id,
        alternative_text: covered,
      });
    } else if (!sink.text(covered, () => false)) return null;
    at = entity.offset + entity.length;
  }
  if (!sink.text(text.slice(at), () => true)) return null;
  sink.flush();
  return sink.lines;
}

// ---------------------------------------------------------------------------
// The Telegram HTML subset
// ---------------------------------------------------------------------------

/** Telegram HTML tags this converts, and the rich text each becomes. */
const SIMPLE_TAGS: Readonly<Record<string, string>> = {
  b: 'bold',
  strong: 'bold',
  i: 'italic',
  em: 'italic',
  u: 'underline',
  ins: 'underline',
  s: 'strikethrough',
  strike: 'strikethrough',
  del: 'strikethrough',
  code: 'code',
  'tg-spoiler': 'spoiler',
};

const NAMED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"' };

interface Frame {
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: RichText[];
}

function decodeEntities(raw: string): string | null {
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string;
    if (char !== '&') {
      out += char;
      continue;
    }
    const match = /^&(?:(lt|gt|amp|quot)|#(\d{1,7})|#x([0-9a-f]{1,6}));/iu.exec(raw.slice(index));
    if (match === null) return null;
    const named = match[1];
    const code =
      match[2] !== undefined
        ? Number(match[2])
        : match[3] !== undefined
          ? parseInt(match[3], 16)
          : null;
    if (named !== undefined) out += NAMED[named.toLowerCase()] as string;
    else if (code !== null && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)) {
      out += String.fromCodePoint(code);
    } else return null;
    index += match[0].length - 1;
  }
  return out;
}

function attributesOf(raw: string): Record<string, string> | null {
  const attributes: Record<string, string> = {};
  let rest = raw.trim();
  while (rest !== '') {
    const match = /^([a-z][a-z0-9-]*)\s*=\s*"([^"]*)"\s*/iu.exec(rest);
    if (match === null) return null;
    const value = decodeEntities(match[2] as string);
    if (value === null) return null;
    attributes[(match[1] as string).toLowerCase()] = value;
    rest = rest.slice(match[0].length);
  }
  return attributes;
}

function contentOf(children: readonly RichText[]): RichText {
  return children.length === 1 ? (children[0] as RichText) : [...children];
}

/** One closed tag as a rich text, or null for one this does not convert. */
function nodeOf(frame: Frame, customEmoji: boolean): RichText | readonly RichText[] | null {
  const simple = SIMPLE_TAGS[frame.tag];
  if (simple !== undefined) return { type: simple, text: contentOf(frame.children) };
  if (frame.tag === 'span' && frame.attributes.class === 'tg-spoiler') {
    return { type: 'spoiler', text: contentOf(frame.children) };
  }
  if (frame.tag === 'a') {
    const url = frame.attributes.href;
    if (url === undefined || !/^(?:https?|tg):/iu.test(url)) return null;
    return { type: 'url', text: contentOf(frame.children), url };
  }
  if (frame.tag === 'tg-emoji') {
    const id = frame.attributes['emoji-id'];
    const alternative = frame.children.every((child) => typeof child === 'string')
      ? frame.children.join('')
      : null;
    if (id === undefined || alternative === null || alternative === '') return null;
    return customEmoji
      ? { type: 'custom_emoji', custom_emoji_id: id, alternative_text: alternative }
      : [alternative];
  }
  return null;
}

function htmlLines(text: string, customEmoji: boolean): Line[] | null {
  const stack: Frame[] = [];
  const sink = new LineSink(() =>
    stack.length > 0 ? (stack[stack.length - 1] as Frame).children : null,
  );
  const breakable = () => stack.length === 0;
  let at = 0;
  while (at < text.length) {
    const lt = text.indexOf('<', at);
    const chunk = text.slice(at, lt < 0 ? text.length : lt);
    if (chunk !== '') {
      const decoded = decodeEntities(chunk);
      if (decoded === null || !sink.text(decoded, breakable)) return null;
    }
    if (lt < 0) break;
    const match = /^<(\/?)([a-z][a-z0-9-]*)(\s[^<>]*)?>/iu.exec(text.slice(lt));
    if (match === null) return null;
    const closing = match[1] === '/';
    const tag = (match[2] as string).toLowerCase();
    if (closing) {
      // The frame's own text first: it belongs inside the tag being closed.
      sink.flush();
      const frame = stack.pop();
      if (frame === undefined || frame.tag !== tag || match[3] !== undefined) return null;
      const node = nodeOf(frame, customEmoji);
      if (node === null) return null;
      if (Array.isArray(node)) {
        for (const part of node) sink.node(part as RichText);
      } else sink.node(node as RichText);
    } else {
      const attributes = attributesOf(match[3] ?? '');
      if (attributes === null) return null;
      sink.flush();
      stack.push({ tag, attributes, children: [] });
    }
    at = lt + match[0].length;
  }
  if (stack.length > 0) return null;
  sink.flush();
  return MARK_CHARS.test(JSON.stringify(sink.lines)) ? null : sink.lines;
}

// ---------------------------------------------------------------------------
// Buttons, tables and the two bodies
// ---------------------------------------------------------------------------

/**
 * The labelled buttons as rich `buttons` blocks, and the rows that stay an ordinary inline
 * keyboard under the message.
 *
 * Rows are grouped exactly as `telegramButtonMarkup` groups them — it is called here, so the
 * route of every button (`callback_data`, `url`, `copy_text`) and its style are the same
 * bytes in both modes. A row goes inside the message when every button in it is a kind a
 * `RichMessageButton` holds and it has at most eight; otherwise the WHOLE row stays an
 * inline keyboard, never split and never dropped. A button with a premium icon is such a
 * row: `RichMessageButton` has no `icon_custom_emoji_id`, and the icon is kept rather than
 * silently lost.
 */
export function richButtonLayout(buttons: readonly TelegramButton[]): {
  readonly blocks: RichBlock[];
  readonly inline: Record<string, unknown>[][];
} {
  const blocks: RichBlock[] = [];
  const inline: Record<string, unknown>[][] = [];
  for (const row of telegramButtonMarkup(buttons)) {
    if (row.length <= RICH_BUTTONS_PER_ROW_MAX && row.every(fitsInBlock)) {
      blocks.push({ type: 'buttons', buttons: row.map(richButtonOf) });
    } else {
      inline.push(row);
    }
  }
  return { blocks, inline };
}

const ROUTE_FIELDS = ['callback_data', 'url', 'copy_text'] as const;

function fitsInBlock(cell: Record<string, unknown>): boolean {
  if ('icon_custom_emoji_id' in cell) return false;
  const known = new Set<string>(['text', 'style', ...ROUTE_FIELDS]);
  if (Object.keys(cell).some((key) => !known.has(key))) return false;
  return ROUTE_FIELDS.filter((field) => field in cell).length === 1;
}

function richButtonOf(cell: Record<string, unknown>): Record<string, unknown> {
  const button: Record<string, unknown> = { text: cell.text };
  if (cell.style !== undefined) button.style = cell.style;
  for (const field of ROUTE_FIELDS) {
    if (field in cell) button[field] = cell[field];
  }
  return button;
}

/** A table's input: one header row and the data rows, every cell already rendered. */
export interface RichTableInput {
  readonly header: readonly RichText[];
  readonly rows: readonly (readonly RichText[])[];
  /** `is_compact`: "Pass True if table cells must have smaller indents" — phone-first screens. */
  readonly compact: boolean;
}

export function richTableBlock(input: RichTableInput): RichBlock {
  const cell = (text: RichText, header: boolean) => ({
    text,
    ...(header ? { is_header: true } : {}),
    align: 'center',
    valign: 'middle',
  });
  return {
    type: 'table',
    cells: [
      input.header.map((text) => cell(text, true)),
      ...input.rows.map((row) => row.map((text) => cell(text, false))),
    ],
    is_bordered: true,
    is_striped: true,
    ...(input.compact ? { is_compact: true } : {}),
  };
}

/**
 * `sendRichMessage`'s body. `is_rtl`: this installation's customer text is Persian. The
 * inline keyboard is present only for rows that stayed out of the message, and is omitted
 * entirely when there are none, for the reason `textMessageBody` gives.
 */
export function richMessageBody(input: {
  readonly chatId: string;
  readonly blocks: readonly RichBlock[];
  readonly inlineRows: readonly Record<string, unknown>[][];
  readonly replyToMessageId?: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    chat_id: input.chatId,
    rich_message: { blocks: input.blocks, is_rtl: true },
  };
  if (input.replyToMessageId !== undefined) {
    body.reply_parameters = {
      message_id: input.replyToMessageId,
      allow_sending_without_reply: true,
    };
  }
  if (input.inlineRows.length > 0) body.reply_markup = { inline_keyboard: input.inlineRows };
  return body;
}

/**
 * `editMessageText`'s body with `rich_message` instead of `text`. The inline keyboard is
 * ALWAYS sent, even empty, for the reason `editMessageBody` gives: leaving it out keeps the
 * old keyboard under a message that no longer offers it.
 */
export function editRichMessageBody(input: {
  readonly chatId: string;
  readonly messageId: number;
  readonly blocks: readonly RichBlock[];
  readonly inlineRows: readonly Record<string, unknown>[][];
}): Record<string, unknown> {
  return {
    chat_id: input.chatId,
    message_id: input.messageId,
    rich_message: { blocks: input.blocks, is_rtl: true },
    reply_markup: { inline_keyboard: input.inlineRows },
  };
}
