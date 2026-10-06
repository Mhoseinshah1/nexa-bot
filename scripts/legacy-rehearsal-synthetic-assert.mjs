#!/usr/bin/env node
/**
 * The synthetic rehearsal's verdict, asserted (WP-D6).
 *
 *   node scripts/legacy-rehearsal-synthetic-assert.mjs SUMMARY.json
 *
 * A synthetic run of the harness on tests/fixtures/legacy/ is green only when NO check
 * failed and the PENDING checks are EXACTLY the fixture's deliberate owner-decision cases,
 * in every cycle — one more PENDING is as much a regression as one FAIL, because PENDING is
 * how a new undecided population first shows up. Prints one line and exits 0, or names
 * every difference and exits 1.
 */
import { readFileSync } from 'node:fs';

/**
 * The fixture's deliberate owner-decision cases (tests/fixtures/legacy/synthetic-legacy.ts):
 * one live invoice whose key is outside the evidenced shape (S2, OQ-P4-01), one user id that
 * is not a Telegram id (C3), and one fractional Toman balance (W8).
 */
export const EXPECTED_PENDING = [
  'invoice_keys_outside_evidenced_shape',
  'legacy_balance_fractional_users',
  'report_equation_C3',
];

export function assertSynthetic(summary) {
  const problems = [];
  if (summary.evidenceClass !== 'synthetic' || summary.notEvidence !== true) {
    problems.push(`not a synthetic summary (evidenceClass ${summary.evidenceClass})`);
  }
  if (summary.checksFailed !== 0) {
    const failed = (summary.checks ?? []).filter((c) => c.result === 'FAIL');
    problems.push(
      `checksFailed ${summary.checksFailed}: ${failed.map((c) => `c${c.cycle} ${c.check} (expected ${c.expected}, got ${c.actual})`).join('; ')}`,
    );
  }
  const cycles = Number(summary.cycles);
  if (!Number.isInteger(cycles) || cycles < 1) problems.push(`cycles ${summary.cycles}`);
  const want = [];
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    for (const check of EXPECTED_PENDING) want.push(`${cycle}:${check}`);
  }
  const got = (summary.checks ?? [])
    .filter((c) => c.result === 'PENDING')
    .map((c) => `${c.cycle}:${c.check}`);
  const extra = got.filter((k) => !want.includes(k));
  const missing = want.filter((k) => !got.includes(k));
  if (extra.length > 0) problems.push(`unexpected PENDING: ${extra.join(', ')}`);
  if (missing.length > 0) problems.push(`expected PENDING not recorded: ${missing.join(', ')}`);
  if (got.length !== new Set(got).size) problems.push('a PENDING check recorded twice');
  const decisions = (summary.pendingDecisions ?? []).map((d) => `${d.cycle}:${d.check}`);
  if (decisions.sort().join() !== [...got].sort().join()) {
    problems.push('pendingDecisions does not list exactly the PENDING checks');
  }
  if ((summary.pendingDecisions ?? []).some((d) => d.decision !== null)) {
    problems.push(
      'a synthetic pendingDecisions entry carries a decision; only the owner records one',
    );
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (file === undefined) {
    process.stderr.write('usage: legacy-rehearsal-synthetic-assert.mjs SUMMARY.json\n');
    process.exit(64);
  }
  const summary = JSON.parse(readFileSync(file, 'utf8'));
  const problems = assertSynthetic(summary);
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`SYNTHETIC REHEARSAL REGRESSED: ${p}\n`);
    process.exit(1);
  }
  const passed = summary.checks.filter((c) => c.result === 'PASS').length;
  process.stdout.write(
    `synthetic rehearsal as expected: ${passed} PASS, 0 FAIL, ${summary.checksPending} PENDING (exactly the fixture's owner-decision cases) over ${summary.cycles} cycle(s) — NOT evidence\n`,
  );
}
