/**
 * Migration P7 — the report every mode emits (program Item 16; `importer.md` §Report).
 *
 * One machine-readable JSON document and its human rendering. Aggregates only: counts,
 * sums, digests, panel UUIDs and legacy panel codes. Never a Telegram id, a username, a
 * phone, a subscription link, a credential or one person's balance — the builders below
 * receive tallies, not rows, so there is nothing of that kind to leak.
 */

export const LEGACY_REPORT_FORMAT = 'nexa-legacy-import-report/v1';

export type LegacyReportMode = 'AUDIT' | 'DRY_RUN' | 'IMPORT' | 'RESUME' | 'RECONCILE' | 'REPORT';

export interface LegacyImportReport {
  readonly format: typeof LEGACY_REPORT_FORMAT;
  readonly mode: LegacyReportMode;
  /** True whenever the source is a fixture. Printed first in the markdown. */
  readonly synthetic: boolean;
  readonly generatedAt: string;
  readonly durationMs: number;
  readonly tenantId: string;
  readonly codeVersion: string | null;
  readonly sections: Readonly<Record<string, unknown>>;
  /** An overall verdict where the mode has one (reconcile, import). */
  readonly verdict: string | null;
  /**
   * `report` mode only: the Item 16 document in the shape of
   * `docs/legacy-migration/final-report.schema.json`; `--format json` prints exactly it.
   */
  readonly final?: unknown;
}

/** JSON with bigints as decimal strings. */
export function reportJson(report: LegacyImportReport): string {
  return `${JSON.stringify(report, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`;
}

/**
 * Text made inert for a Markdown table cell, list item or heading. Report keys and values
 * can come from the legacy source (a `code_panel`), so nothing may add a line, a row, a
 * heading, a link, code, emphasis or HTML. One pass: a control or other invisible
 * character becomes `\u{…}`; a backslash and every character that is syntax anywhere in a
 * line — `` ` * [ ] < > | ~ `` — is backslash-escaped, and so is `_` where it could open or
 * close emphasis (an intraword `_`, as in ADOPTION_ELIGIBLE, is inert in CommonMark). Every
 * line the report writes starts with its own `| `, `- ` or `#… `, so line-start markers in
 * a value (`#`, `-`, `1.`) cannot open a block once newlines are escaped.
 */
export function markdownText(text: string): string {
  return text.replace(/\p{C}|[\\`*[\]<>|~]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, (c) =>
    /\p{C}/u.test(c) ? `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}` : `\\${c}`,
  );
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return markdownText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return markdownText(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renderValue(name: string, value: unknown, depth: number, out: string[]): void {
  const heading = '#'.repeat(Math.min(6, depth + 2));
  name = markdownText(name);
  if (Array.isArray(value)) {
    out.push(`${heading} ${name}`, '');
    if (value.length === 0) {
      out.push('_none_', '');
      return;
    }
    if (value.every(isPlainObject)) {
      const columns = [...new Set(value.flatMap((row) => Object.keys(row)))];
      out.push(
        `| ${columns.map(markdownText).join(' | ')} |`,
        `| ${columns.map(() => '---').join(' | ')} |`,
      );
      for (const row of value) out.push(`| ${columns.map((c) => scalar(row[c])).join(' | ')} |`);
      out.push('');
      return;
    }
    out.push(...value.map((v) => `- ${scalar(v)}`), '');
    return;
  }
  if (isPlainObject(value)) {
    const flat = Object.entries(value).filter(([, v]) => !isPlainObject(v) && !Array.isArray(v));
    const nested = Object.entries(value).filter(([, v]) => isPlainObject(v) || Array.isArray(v));
    out.push(`${heading} ${name}`, '');
    if (flat.length > 0) {
      out.push('| field | value |', '| --- | --- |');
      for (const [k, v] of flat) out.push(`| ${markdownText(k)} | ${scalar(v)} |`);
      out.push('');
    }
    for (const [k, v] of nested) renderValue(k, v, depth + 1, out);
    return;
  }
  out.push(`${heading} ${name}`, '', scalar(value), '');
}

export function reportMarkdown(report: LegacyImportReport): string {
  const out: string[] = [`# Legacy import — ${report.mode}`, ''];
  if (report.synthetic) {
    out.push(
      '> **SYNTHETIC SOURCE — NOT EVIDENCE.** These figures come from a synthetic fixture and',
      '> prove only that the importer code works. They are not Q1–Q7 results, not C1/C3',
      '> results, and not a rehearsal on real data.',
      '',
    );
  }
  out.push(
    '| field | value |',
    '| --- | --- |',
    `| format | ${report.format} |`,
    `| generated at (UTC) | ${report.generatedAt} |`,
    `| duration | ${String(report.durationMs)} ms |`,
    `| tenant | ${report.tenantId} |`,
    `| code version | ${report.codeVersion ?? '—'} |`,
    `| verdict | ${report.verdict ?? '—'} |`,
    '',
  );
  for (const [name, value] of Object.entries(report.sections)) renderValue(name, value, 0, out);
  return `${out.join('\n').replace(/\n{3,}/gu, '\n\n')}\n`;
}
