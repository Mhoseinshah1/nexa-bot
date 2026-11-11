/**
 * The pure parts of `pnpm web:demo-diff` (demo-diff.mjs): the in-page signature extractor,
 * text normalisation, the demo/app diff, the KEEP allow-list and the text report. Importing
 * this module starts nothing, so it can also filter an existing report (`--filter-kit`).
 */

/** Item lists compared per route (each is a set of normalised strings). */
export const LIST_FIELDS = [
  'h1',
  'crumbs',
  'tabs',
  'heads',
  'th',
  'buttons',
  'chips',
  'labels',
  'errors',
  'empty',
];
/** Scalar counts compared per route. */
export const COUNT_FIELDS = ['tables', 'dialogs'];

/**
 * Runs in the page (both sides). Everything is read from `<main>` (or the body when the demo
 * has none) and only what is rendered: a collapsed section's labels do not count.
 */
export const SIG_JS = `(() => {
  const vis = (e) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const main = document.querySelector('main') || document.body;
  const T = (sel, root = main) =>
    [...root.querySelectorAll(sel)]
      .filter(vis)
      .map((e) => e.textContent.replace(/\\s+/g, ' ').trim())
      .filter(Boolean);
  const content = document.querySelector('.content');
  const inner = content ? content.scrollHeight : 0;
  return {
    h1: T('h1'),
    crumbs: T('nav[aria-label] a, .crumbs a, [class*=crumb] a'),
    tabs: T('[role=tab]'),
    heads: T('h2,h3,h4').slice(0, 200),
    th: T('th'),
    buttons: T('button, a.btn').slice(0, 400),
    chips: T('[class*=chip]').slice(0, 200),
    labels: T('label').slice(0, 300),
    errors: T('[role=alert], .error, [class*=error-card]').slice(0, 20),
    empty: T('[class*=empty]').slice(0, 20),
    tables: main.querySelectorAll('table').length,
    dialogs: document.querySelectorAll('[role=dialog]').length,
    height: Math.max(document.documentElement.scrollHeight, inner),
  };
})()`;

/** Digits (Persian, Arabic-Indic, Latin) become '#', ZWNJ and bidi marks go, whitespace folds. */
export function norm(text) {
  return String(text)
    .replace(/\u200c|\u200d|[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\u00a0\s]+/g, ' ')
    .replace(/[0-9\u06f0-\u06f9\u0660-\u0669]+/g, '#')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .trim();
}

export function normaliseSig(raw) {
  if (raw === undefined || raw.fail !== undefined) return raw;
  const out = { tables: raw.tables, dialogs: raw.dialogs, height: raw.height };
  for (const field of LIST_FIELDS) out[field] = [...new Set((raw[field] ?? []).map(norm))];
  return out;
}

/** The differences between two normalised signatures: `{field, side, text}` rows. */
export function diffSigs(demo, app) {
  const rows = [];
  for (const field of LIST_FIELDS) {
    const d = new Set(demo[field]);
    const a = new Set(app[field]);
    const onlyDemo = demo[field].filter((x) => !a.has(x));
    const onlyApp = app[field].filter((x) => !d.has(x));
    // Several items of one side are one line, as in the owner's report.
    if (onlyDemo.length > 0) rows.push({ field, side: 'ONLY-DEMO', items: onlyDemo });
    if (onlyApp.length > 0) rows.push({ field, side: 'ONLY-APP', items: onlyApp });
  }
  for (const field of COUNT_FIELDS) {
    if (demo[field] !== app[field])
      rows.push({ field, side: 'COUNT', items: [`demo=${demo[field]} app=${app[field]}`] });
  }
  return rows;
}

function routeMatches(pattern, route) {
  if (pattern === '*' || pattern === route) return true;
  if (!pattern.includes('*')) return false;
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${re}$`).test(route);
}

function textMatches(match, item) {
  const regex = /^\/(.+)\/([a-z]*)$/s.exec(match);
  if (regex !== null) return new RegExp(regex[1], regex[2]).test(item);
  return norm(match) === item;
}

/**
 * Splits each route's difference rows into what remains and what a KEEP entry suppresses.
 * An entry is `{route, field, side, match, reason}`: `route` is `*`, a path, or a glob
 * (`/hosting*` also covers `/hosting#tab:…`); `field` and `side` may be `*`; `match` is the
 * exact (normalised) text or `/regex/flags`. Only the matched ITEM is dropped, never a row's
 * other items. `hits[i]` counts what entry i suppressed, so an entry that no longer matches
 * anything is visible in the report.
 */
export function applyKeep(diffs, keep) {
  const hits = keep.map(() => 0);
  const remaining = {};
  const suppressed = {};
  for (const [route, rows] of Object.entries(diffs)) {
    remaining[route] = [];
    suppressed[route] = 0;
    for (const row of rows) {
      const left = [];
      for (const item of row.items) {
        const at = keep.findIndex(
          (k) =>
            routeMatches(k.route, route) &&
            (k.field === '*' || k.field === row.field) &&
            (k.side === '*' || k.side === row.side) &&
            textMatches(k.match, item),
        );
        if (at >= 0) {
          hits[at] += 1;
          suppressed[route] += 1;
        } else left.push(item);
      }
      if (left.length > 0) remaining[route].push({ ...row, items: left });
    }
  }
  return { remaining, suppressed, hits };
}

export function validateKeep(keep) {
  if (!Array.isArray(keep)) throw new Error('The KEEP file must be a JSON array.');
  for (const [i, k] of keep.entries()) {
    for (const key of ['route', 'field', 'side', 'match', 'reason']) {
      if (typeof k[key] !== 'string' || k[key] === '')
        throw new Error(`KEEP entry ${i} has no ${key}.`);
    }
    if (!['ONLY-DEMO', 'ONLY-APP', 'COUNT', '*'].includes(k.side))
      throw new Error(`KEEP entry ${i}: side is ONLY-DEMO, ONLY-APP, COUNT or *.`);
  }
  return keep;
}

const quote = (items) => `[${items.map((x) => `'${x}'`).join(', ')}]`;

/** The text report: one block per route, `(OK)` when nothing remains, totals at the end. */
export function formatReport({ header, order, diffs, applied, keep, failed = {} }) {
  const lines = [...header, ''];
  let before = 0;
  let after = 0;
  let suppressedTotal = 0;
  for (const route of order) {
    const rows = applied.remaining[route] ?? [];
    const count = rows.reduce((n, r) => n + r.items.length, 0);
    before += (diffs[route] ?? []).reduce((n, r) => n + r.items.length, 0);
    after += count;
    suppressedTotal += applied.suppressed[route] ?? 0;
    const note = applied.suppressed[route]
      ? `, ${applied.suppressed[route]} suppressed by KEEP`
      : '';
    if (failed[route] !== undefined) {
      lines.push(`## ${route} (FAILED: ${failed[route]})`);
      continue;
    }
    lines.push(`## ${route} ${count === 0 ? `(OK${note})` : `(${count}${note})`}`);
    for (const row of rows) {
      lines.push(
        row.side === 'COUNT'
          ? `  ${row.field}: ${row.items[0]}`
          : `  ${row.field} ${row.side}: ${quote(row.items)}`,
      );
    }
  }
  lines.push('', '## KEEP entries that suppressed nothing');
  const unused = keep.filter((_, i) => applied.hits[i] === 0);
  if (unused.length === 0) lines.push('  (none)');
  for (const k of unused) lines.push(`  ${k.route} ${k.field} ${k.side} ${k.match}`);
  lines.push(
    '',
    `TOTAL differences before KEEP: ${before}`,
    `TOTAL suppressed by KEEP: ${suppressedTotal}`,
    `TOTAL remaining differences: ${after}`,
    `Routes with remaining differences: ${order.filter((r) => (applied.remaining[r] ?? []).length > 0).length} of ${order.length}`,
  );
  return { text: `${lines.join('\n')}\n`, before, after, suppressed: suppressedTotal };
}

/**
 * Reads the owner's kit report (`## route (n)` blocks of `  field ONLY-DEMO: [python list]`
 * and `  tables: demo=N app=M`) into the same `{route: rows}` shape, normalised like a run.
 */
export function parseKitReport(text) {
  const diffs = {};
  const order = [];
  let route;
  for (const line of text.split('\n')) {
    const head = /^## (\S.*?) (\(\d+\)|\(OK\))$/.exec(line);
    if (head !== null) {
      route = head[1];
      order.push(route);
      diffs[route] = [];
      continue;
    }
    if (route === undefined) continue;
    const list = /^ {2}(\w+) (ONLY-DEMO|ONLY-APP): \[(.*)\]$/.exec(line);
    if (list !== null) {
      const items = [...list[3].matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) =>
        norm(
          (m[1] ?? m[2])
            .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/\\(['"\\])/g, '$1'),
        ),
      );
      diffs[route].push({ field: list[1], side: list[2], items });
      continue;
    }
    const count = /^ {2}(tables|drawers|dialogs): (demo=\d+ app=\d+)$/.exec(line);
    if (count !== null)
      diffs[route].push({
        field: count[1] === 'drawers' ? 'dialogs' : count[1],
        side: 'COUNT',
        items: [count[2]],
      });
  }
  return { diffs, order };
}
