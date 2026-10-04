import { decideLegacyTrial } from '../../../commerce/trials/application/legacy-trial-eligibility.js';
import { LEGACY_EVIDENCE_QUERIES } from './sql-evidence.js';
import { EvidenceUnsupported, type LegacyCell, type LegacySourceSession } from './source-port.js';
import type { LegacySnapshot } from './source-snapshot.js';
import type { LegacyPlan } from './plan.js';

/**
 * Item 1 — the SQL evidence runner (`docs/legacy-migration/importer.md` §Evidence).
 *
 * Runs Q1–Q7, Q1b, Q1c and Q2b from the runbook, verbatim, inside the SAME read-only
 * snapshot the importer then reads its rows from, and emits aggregate rows only. Every
 * cell is bounded (64 characters, control characters escaped): the runbook allows Q1b's
 * panel codes and Q1c's refused spellings to be listed, and nothing else in these queries
 * names a row.
 *
 * Then it cross-checks the evidence against the importer's own decisions over the same
 * snapshot — Q2b against `decideLegacyTrial`, Q1b's MAPPABLE rows against the distinct
 * productless shapes, Q6 and Q7 against the importer's counts. A disagreement is reported,
 * never resolved: it means the runbook and the code read the archive differently, and a
 * person decides which is right.
 */

export interface EvidenceQueryResult {
  readonly id: string;
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly LegacyCell[])[];
  readonly error: string | null;
}

export type LegacyEvidence =
  | { readonly available: false; readonly reason: 'SOURCE_ENGINE_NOT_SQL' }
  | {
      readonly available: true;
      readonly results: readonly EvidenceQueryResult[];
    };

const CELL_MAX = 64;

export function boundedCell(value: LegacyCell): LegacyCell {
  if (value === null) return null;
  const escaped = value.replace(
    /\p{Cc}/gu,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
  return escaped.length > CELL_MAX ? `${escaped.slice(0, CELL_MAX)}…` : escaped;
}

export async function runLegacyEvidence(session: LegacySourceSession): Promise<LegacyEvidence> {
  const results: EvidenceQueryResult[] = [];
  for (const query of LEGACY_EVIDENCE_QUERIES) {
    try {
      const rows = await session.aggregate(query.sql);
      const columns = rows[0] === undefined ? [] : Object.keys(rows[0]);
      results.push({
        id: query.id,
        title: query.title,
        columns,
        rows: rows.map((row) => columns.map((c) => boundedCell(row[c] ?? null))),
        error: null,
      });
    } catch (error) {
      if (error instanceof EvidenceUnsupported) {
        return { available: false, reason: 'SOURCE_ENGINE_NOT_SQL' };
      }
      // A failed query is recorded by its CODE (an engine error code), never its text,
      // which can quote the statement and the data it choked on.
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'QUERY_FAILED';
      results.push({ id: query.id, title: query.title, columns: [], rows: [], error: code });
    }
  }
  return { available: true, results };
}

export interface EvidenceCrossCheck {
  readonly id: string;
  readonly what: string;
  readonly evidence: string | null;
  readonly importer: string;
  readonly agree: boolean | null;
}

function resultOf(evidence: LegacyEvidence, id: string): EvidenceQueryResult | null {
  if (!evidence.available) return null;
  const result = evidence.results.find((r) => r.id === id);
  return result === undefined || result.error !== null ? null : result;
}

function cell(result: EvidenceQueryResult, row: readonly LegacyCell[], column: string): LegacyCell {
  const index = result.columns.indexOf(column);
  return index === -1 ? null : (row[index] ?? null);
}

export function crossCheckEvidence(
  evidence: LegacyEvidence,
  snapshot: LegacySnapshot,
  plan: LegacyPlan,
): readonly EvidenceCrossCheck[] {
  const checks: EvidenceCrossCheck[] = [];
  const userIds = new Set(snapshot.users.map((u) => u.id));
  const realLive = snapshot.liveInvoices.filter((i) => i.isTest?.trim() === '0');

  const q7 = resultOf(evidence, 'Q7');
  const orphans = realLive.filter((i) => i.idUser === null || !userIds.has(i.idUser)).length;
  const q7Value = q7 === null ? null : (q7.rows[0]?.[0] ?? null);
  checks.push({
    id: 'Q7',
    what: 'orphan real live invoices',
    evidence: q7Value,
    importer: String(orphans),
    agree: q7Value === null ? null : q7Value === String(orphans),
  });

  const q6 = resultOf(evidence, 'Q6');
  const missingPanelReal = realLive.filter(
    (i) => i.codePanel === null || i.codePanel === '',
  ).length;
  const q6Row = q6?.rows.find((r) => q6 !== null && cell(q6, r, 'is_test') === '0');
  const q6Value =
    q6 === null ? null : q6Row === undefined ? '0' : (cell(q6, q6Row, 'COUNT(*)') ?? null);
  checks.push({
    id: 'Q6',
    what: 'real live invoices with no code_panel',
    evidence: q6Value,
    importer: String(missingPanelReal),
    agree: q6Value === null ? null : q6Value === String(missingPanelReal),
  });

  const q1b = resultOf(evidence, 'Q1b');
  const mappableRows =
    q1b === null ? null : q1b.rows.filter((r) => cell(q1b, r, 'outcome') === 'MAPPABLE').length;
  checks.push({
    id: 'Q1b',
    what: 'distinct MAPPABLE productless shapes (hidden products per tenant)',
    evidence: mappableRows === null ? null : String(mappableRows),
    importer: String(plan.tallies.products.q1bDistinctMappable),
    agree:
      mappableRows === null ? null : mappableRows === plan.tallies.products.q1bDistinctMappable,
  });

  const q2b = resultOf(evidence, 'Q2b');
  const branches = new Map<string, number>();
  for (const u of snapshot.users) {
    const decision = decideLegacyTrial(
      { limitUsertest: u.limitUsertest, hadTrial: snapshot.trialUsers.has(u.id) },
      null,
    ).decision;
    branches.set(decision, (branches.get(decision) ?? 0) + 1);
  }
  const importerQ2b = [...branches.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([d, n]) => `${d}=${String(n)}`)
    .join(' ');
  const evidenceQ2b =
    q2b === null
      ? null
      : q2b.rows
          .map((r) => [cell(q2b, r, 'decision') ?? '', cell(q2b, r, 'n') ?? ''] as const)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([d, n]) => `${d}=${n}`)
          .join(' ');
  checks.push({
    id: 'Q2b',
    what: 'trial branches over every legacy user (decideLegacyTrial, no override)',
    evidence: evidenceQ2b,
    importer: importerQ2b,
    agree: evidenceQ2b === null ? null : evidenceQ2b === importerQ2b,
  });
  return checks;
}
