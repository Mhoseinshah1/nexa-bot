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

/**
 * Every check that must PASS in EVERY cycle of the synthetic run, by name. A check that
 * silently stops being recorded — a stage skipped, a rename — fails the gate as surely as a
 * FAIL does; a count floor would let one disappear behind a new one.
 */
export const EXPECTED_PASS_EVERY_CYCLE = [
  'adopted_equals_eligible',
  'adopted_services_appeared',
  'adopted_services_link_stored',
  'adopted_services_without_operations',
  'adoption_orders_shape',
  'adoption_orders_zero_total',
  'apply_fingerprint_equals_audit',
  'apply_run_completed',
  'apply_verdict',
  'blocked_equals_invalid_ids',
  'customer_closure',
  'customers_created_le_imported',
  'dry_run_no_business_mutation',
  'fractional_balances_never_imported',
  'interrupted_import_stopped_writing',
  'interrupted_run_left_running',
  'legacy_debts_equal_negative_magnitude',
  'legacy_debts_one_per_negative_user',
  'legacy_balance_null_users',
  'link_never_in_artifacts',
  'link_never_in_audit_outbox_events',
  'no_customer_messages',
  'no_debit_openings',
  'no_duplicate_openings',
  'no_run_left_running',
  'no_trial_grants',
  'one_apply_run_resumed',
  'one_service_per_adoption',
  'opening_links_no_money',
  'opening_reference_matches_customer',
  'openings_one_per_nonzero_user',
  'orphans_in_customer_missing',
  'panel_map_complete',
  'panel_state_unchanged',
  'panel_state_walk_reads_only',
  'provider_writes_zero',
  'reminder_seed_sent_no_messages',
  'report_candidates_equal_source',
  'report_equation_C1',
  'report_equation_P3',
  'report_equation_S3',
  'report_equation_W1',
  'report_equation_W4',
  'report_equation_W5',
  'report_evidence_class',
  'report_provider_writes_zero',
  'report_resumes_counted',
  'report_run_is_this_run',
  'report_schema_valid',
  'revenue_view_adoption_zero',
  'revenue_view_standard_unchanged',
  'rollback_displaced_exists',
  'rollback_displaced_preserved',
  'rollback_restores_pre_import',
  'rollback_restores_pre_import_exact',
  'service_closure_map_plus_invalid_keys',
  'source_fingerprint_stable',
  'unchanged_payments_total',
  'unchanged_sale_orders_paid',
  'unchanged_sale_orders_paid_total_minor',
  'unchanged_wallet_topup_signed_total_minor',
  'wallet_entries_only_openings',
  'wallet_equation_imported_balance',
  'wallet_moved_only_by_openings',
  'wallet_window_openings_only',
];

/** Cycle 2 (and later) also proves the repeat. */
export const EXPECTED_PASS_LATER_CYCLES = ['repeat_reproduces_cycle_1'];

/** Recorded once, as cycle 0: what the fake panels received on the wire. */
export const EXPECTED_PASS_CYCLE_0 = ['wire_provider_reads_seen', 'wire_provider_writes_zero'];

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
  const passed = new Set(
    (summary.checks ?? []).filter((c) => c.result === 'PASS').map((c) => `${c.cycle}:${c.check}`),
  );
  const wantPass = EXPECTED_PASS_CYCLE_0.map((n) => `0:${n}`);
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    for (const n of EXPECTED_PASS_EVERY_CYCLE) wantPass.push(`${cycle}:${n}`);
    if (cycle > 1) for (const n of EXPECTED_PASS_LATER_CYCLES) wantPass.push(`${cycle}:${n}`);
  }
  const notPassed = wantPass.filter((k) => !passed.has(k));
  if (notPassed.length > 0) problems.push(`expected PASS not recorded: ${notPassed.join(', ')}`);
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
