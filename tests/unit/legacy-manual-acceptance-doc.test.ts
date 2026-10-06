import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_REVIEW_REASON_CODES } from '@nexa/contracts';

/**
 * WP-D7 — a doc-lint over docs/legacy-migration/manual-acceptance.md's recording table, so
 * a PASS can never be written without its evidence and no unrun step reads as done.
 */
const DOC = readFileSync(
  join(__dirname, '../../docs/legacy-migration/manual-acceptance.md'),
  'utf8',
);

const STATUS = /^(PASS|FAIL|NOT RUN|POPULATION 0|N\/A \(.+\))$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const NA = /^n\/a \(.+\)$/iu;

function table(markdown: string, heading: string, firstColumn: string) {
  const lines = markdown.slice(markdown.indexOf(heading)).split('\n');
  const cells = (l: string) =>
    l
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
  const header = lines.findIndex(
    (l) => l.startsWith('|') && l.split('|')[1]?.trim() === firstColumn,
  );
  if (header === -1) throw new Error(`no table starting with "${firstColumn}" under ${heading}`);
  const names = cells(lines[header] as string);
  const rows: Record<string, string>[] = [];
  // The table ends at its first non-table line: the next table is another table.
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    const values = cells(line);
    rows.push(Object.fromEntries(names.map((n, i) => [n, values[i] ?? ''])));
  }
  return { names, rows };
}

/** Every problem with one recording row; empty when it is acceptable. */
export function rowProblems(row: Record<string, string>): string[] {
  const problems: string[] = [];
  const result = row['result'] ?? '';
  const id = row['sample'] ?? '?';
  if (!STATUS.test(result)) problems.push(`${id}: result "${result}" is not in the vocabulary`);
  const filled = (v: string | undefined) => v !== undefined && v !== '' && v !== '—';
  if (result === 'PASS') {
    for (const column of [
      'seed',
      'source ref (category only)',
      'map decision',
      'customer',
      'balance',
      'service',
      'panel / runtime read',
      'Web Admin',
    ]) {
      if (!filled(row[column])) problems.push(`${id}: PASS without ${column}`);
    }
    for (const column of ['NEXA customer uuid', 'NEXA service uuid']) {
      const v = row[column] ?? '';
      if (!UUID.test(v) && !NA.test(v))
        problems.push(`${id}: PASS without ${column} (a uuid or n/a (why))`);
    }
    if (!filled(row['Telegram'])) problems.push(`${id}: PASS without Telegram (or n/a (why))`);
  }
  if (result === 'POPULATION 0' && !filled(row['notes (no PII)'])) {
    problems.push(`${id}: POPULATION 0 without the snapshot metric in notes`);
  }
  if (result === 'FAIL' && !filled(row['notes (no PII)'])) {
    problems.push(`${id}: FAIL without naming the place in notes`);
  }
  return problems;
}

describe('manual-acceptance.md § Recording', () => {
  const matrix = table(DOC, '## The sample matrix', '#');
  const recording = table(DOC, '## Recording', 'sample');

  it('has every column the PO asks to record', () => {
    expect(recording.names).toEqual([
      'sample',
      'seed',
      'source ref (category only)',
      'NEXA customer uuid',
      'NEXA service uuid',
      'map decision',
      'customer',
      'balance',
      'service',
      'panel / runtime read',
      'Web Admin',
      'Telegram',
      'result',
      'notes (no PII)',
    ]);
  });

  it('lists every sample of the matrix, F1 once per closed manual-review reason, and the two manual halves', () => {
    const ids = recording.rows.map((r) => r['sample']);
    const matrixIds = matrix.rows.map((r) => r['#']).filter((id) => id !== 'F1');
    for (const id of matrixIds) expect(ids, id).toContain(id);
    const f1 = ids.filter((id) => id?.startsWith('F1 · ')).map((id) => id?.slice(5));
    expect(f1).toEqual([...LEGACY_REVIEW_REASON_CODES]);
    expect(ids).toContain('R3');
    expect(ids).toContain('P4');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('holds no row that breaks the rules — and today every row is NOT RUN', () => {
    expect(recording.rows.flatMap(rowProblems)).toEqual([]);
    expect(new Set(recording.rows.map((r) => r['result']))).toEqual(new Set(['NOT RUN']));
  });

  it('says the gate it blocks is G15, not G14', () => {
    expect(DOC).toContain('blocks the production gate (G15)');
    expect(DOC).not.toMatch(/production gate \(G14\)/u);
  });
});

describe('the recording rules', () => {
  const base = {
    sample: 'B1',
    seed: 's1',
    'source ref (category only)': 'user, positive balance',
    'NEXA customer uuid': '01a10500-0000-7000-8000-000000000001',
    'NEXA service uuid': 'n/a (no service in a wallet sample)',
    'map decision': 'user IMPORTED',
    customer: 'ok',
    balance: 'opening = Balance',
    service: 'n/a',
    'panel / runtime read': 'n/a (no service)',
    'Web Admin': 'ok',
    Telegram: 'n/a (uncontrolled account)',
    result: 'PASS',
    'notes (no PII)': '',
  };

  it('accepts a PASS with its evidence', () => {
    expect(rowProblems(base)).toEqual([]);
  });

  it('refuses a PASS with any evidence field missing', () => {
    expect(rowProblems({ ...base, seed: '—' })).toEqual(['B1: PASS without seed']);
    expect(rowProblems({ ...base, 'Web Admin': '' })).toEqual(['B1: PASS without Web Admin']);
    expect(rowProblems({ ...base, 'NEXA customer uuid': 'alice' })).toEqual([
      'B1: PASS without NEXA customer uuid (a uuid or n/a (why))',
    ]);
  });

  it('refuses a status outside the vocabulary, a bare N/A, and an unexplained POPULATION 0', () => {
    expect(rowProblems({ ...base, result: 'OK' })).toEqual([
      'B1: result "OK" is not in the vocabulary',
    ]);
    expect(rowProblems({ ...base, result: 'N/A' })).toEqual([
      'B1: result "N/A" is not in the vocabulary',
    ]);
    expect(rowProblems({ ...base, result: 'N/A (no financial report that day)' })).toEqual([]);
    expect(rowProblems({ ...base, result: 'POPULATION 0', 'notes (no PII)': '—' })).toEqual([
      'B1: POPULATION 0 without the snapshot metric in notes',
    ]);
  });
});

describe('rollback-runbook.md § Recording the lane (WP-D8, G13 part b)', () => {
  const RUNBOOK = readFileSync(
    join(__dirname, '../../docs/legacy-migration/rollback-runbook.md'),
    'utf8',
  );
  const lane = table(RUNBOOK, '### Recording the lane', 'step');

  it('records the request id, every stage duration, the displaced database and the R4 diff', () => {
    const what = lane.rows.map((r) => r['what is recorded']).join('\n');
    for (const needle of [
      'recovery request id',
      'stage durations',
      'pre-restore backup id',
      'nexa_pre_restore_<id>',
      '`diff`',
      'PRE_IMPORT_BACKUP_ID',
    ]) {
      expect(what, needle).toContain(needle);
    }
  });

  it('marks a step PASS only with its value, and today none has run', () => {
    for (const row of lane.rows) {
      expect(['PASS', 'FAIL', 'NOT RUN']).toContain(row['result']);
      if (row['result'] === 'PASS') expect(row['value'], row['step']).not.toMatch(/^(—|)$/u);
    }
    expect(new Set(lane.rows.map((r) => r['result']))).toEqual(new Set(['NOT RUN']));
  });
});
