import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Round 4, PR-C: the Web Admin prints a record's short code or name, never its uuid. The
 * uuid reaches the page only as the clipboard payload of «کپی شناسه» (`CopyIdButton`,
 * `apps/web/src/ui/record-ref.tsx`), which draws no text.
 *
 * A source scan over every `.tsx` under `apps/web/src`, for the shapes an id has been
 * rendered in on this codebase — each was found on a page before this test existed:
 *
 * - a JSX child that is an id: `<Ltr>{row.orderId}</Ltr>`, `{row.id}`, `{a ?? row.id}`;
 * - an id as the false branch of a ternary drawn as text: `{x ? y : panel.panelId}</Ltr>`;
 * - a TRUNCATED id, which is only ever for display: `row.customerId.slice(0, 8)`;
 * - an id handed to a text prop: `display={row.id…}`;
 * - a column renderer that returns one: `render: (row) => row.firstName ?? row.customerId…`.
 *
 * An attribute value (`href={…}`, `key={…}`, `value={…}`, `id={…}`) is not text and is not
 * matched. `telegramUserId` is the customer's public identity, not a uuid, and is not an id
 * name below.
 */
const WEB_SRC = join(__dirname, '..', '..', 'apps', 'web', 'src');

/** Names a record's uuid travels under on the wire. `id` only after a dot (`row.id`). */
const ID_NAMES = [
  'orderId',
  'serviceId',
  'paymentId',
  'ticketId',
  'customerId',
  'panelId',
  'productId',
  'resellerCustomerId',
  'approvedProductId',
  'refundId',
] as const;

const names = ID_NAMES.join('|');
const slice = String.raw`(?:\.slice\([^)]*\))?`;
const chain = String.raw`(?:(?:[\w$]+[?!]?\.)+(?:id|${names})|\b(?:${names}))\b${slice}`;
const fallbacks = String.raw`(?:[\w$?!.]+\s*\?\?\s*)*`;

export const RENDERED_ID_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`(?<![=\w$])\{\s*${fallbacks}${chain}\s*\}(?=\s*(?:<|$))`),
  new RegExp(String.raw`[?:]\s*${chain}\s*\}\s*<`),
  new RegExp(String.raw`(?:\.(?:id|${names})|\b(?:${names}))\.slice\(`),
  new RegExp(String.raw`\bdisplay=\{\s*${fallbacks}${chain}`),
  new RegExp(String.raw`=>\s*${fallbacks}${chain}\s*,?\s*$`),
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

export function renderedIds(text: string): number[] {
  const hits: number[] = [];
  text.split('\n').forEach((line, index) => {
    const code = line.replace(/\/\/.*$/u, '');
    if (/^\s*(?:\*|\/\*)/u.test(code)) return;
    if (RENDERED_ID_PATTERNS.some((pattern) => pattern.test(code))) hits.push(index + 1);
  });
  return hits;
}

describe('no uuid is rendered on the Web Admin outside «کپی شناسه» (PR-C)', () => {
  it('the scan recognises every shape it is there to refuse', () => {
    const shapes = [
      '<Ltr>{row.orderId}</Ltr>',
      '<Ltr>{row.id}</Ltr>',
      '{row.title ?? <Ltr>{row.productId}</Ltr>}',
      '<Ltr>{codes.length > 0 ? codes.join(", ") : panel.panelId}</Ltr>',
      '<Ltr>{row.customerId.slice(0, 8)}</Ltr>',
      'render: (row) => row.firstName ?? row.username ?? row.customerId.slice(0, 8),',
      '<IdText value={row.id} display={row.id.slice(0, 8)} />',
      '<option value={state.panelId}>{state.panelId}</option>',
      '<Ltr>{customerId}</Ltr>',
      '          {row.orderId}',
    ];
    for (const shape of shapes) expect(renderedIds(shape), shape).toEqual([1]);
  });

  it('and leaves attribute values, links and the copy action alone', () => {
    const fine = [
      '<a href={`/orders/${encodeURIComponent(row.orderId)}`} onClick={onLink}>',
      '<CopyIdButton id={row.id} />',
      '<RecordLink href={recordHref.order(row.orderId)} id={row.orderId} code={row.orderCode} />',
      '<li key={one.id}>',
      '...(cursor ? { before: cursor.at, beforeId: cursor.id } : {}),',
      'export function OrderPlacement({ orderId }: { orderId: string }) {',
      '<Ltr>{row.telegramUserId}</Ltr>',
      '<Ltr>{row.code}</Ltr>',
    ];
    for (const line of fine) expect(renderedIds(line), line).toEqual([]);
  });

  it('no page renders one', () => {
    const offenders = sources(WEB_SRC).flatMap((file) =>
      renderedIds(readFileSync(file, 'utf8')).map((line) => `${relative(WEB_SRC, file)}:${line}`),
    );
    expect(offenders).toEqual([]);
  });
});
