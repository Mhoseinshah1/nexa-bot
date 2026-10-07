#!/usr/bin/env node
/**
 * The reconciliation result table from a rehearsal's summary.json (WP-D5).
 *
 *   node scripts/legacy-rehearsal-reconciliation.mjs SUMMARY.json > reconciliation.md
 *
 * docs/legacy-migration/reconciliation.md defines 23 equations (C1–C3, W1–W8, R1–R3,
 * S1–S5, P1–P4) and ends with a result table a person used to fill by transcribing
 * checks.tsv. This emits that table from the harness's own checks, so nobody transcribes:
 * every equation names the checks that evidence it, and its state is decided here.
 *
 *   HOLDS    every mapped check PASSED in every cycle
 *   FAILS    any mapped check FAILED (the checks that failed are named)
 *   PENDING  none failed, some are PENDING — an owner decision, NOT a pass (G11/G14)
 *   MISSING  a mapped check was never recorded — the equation was not evaluated
 * and an equation with a MANUAL half says so in its notes: the machine half holding is
 * not the equation holding (R3's Web Admin read, P4's panel-UI spot check).
 *
 * The table carries the summary's evidence class in its heading: a synthetic run's table
 * is never a staging column.
 */
import { readFileSync } from 'node:fs';

/** Equation → the harness checks that evidence it, and what only a person can do. */
export const EQUATIONS = [
  ['C1', ['customer_closure', 'report_equation_C1'], null],
  ['C2', ['customers_created_le_imported'], null],
  ['C3', ['report_equation_C3', 'blocked_equals_invalid_ids'], null],
  ['W1', ['wallet_equation_imported_balance', 'report_equation_W1'], null],
  ['W2', ['wallet_moved_only_by_openings'], null],
  ['W3', ['wallet_entries_only_openings'], null],
  ['W4', ['openings_one_per_nonzero_user', 'report_equation_W4'], null],
  ['W5', ['no_duplicate_openings', 'report_equation_W5'], null],
  ['W6', ['opening_reference_matches_customer'], null],
  ['W7', ['opening_links_no_money'], null],
  [
    'W8',
    [
      'fractional_balances_never_imported',
      'legacy_balance_fractional_users',
      'legacy_balance_null_users',
    ],
    null,
  ],
  // Mirza PR4 (owner decision 6): no ledger DEBIT opening; one debt per negative balance.
  ['W9', ['no_debit_openings'], null],
  ['W10', ['legacy_debts_one_per_negative_user', 'legacy_debts_equal_negative_magnitude'], null],
  [
    'R1',
    [
      'unchanged_sale_orders_paid',
      'unchanged_sale_orders_paid_total_minor',
      'unchanged_payments_total',
      'unchanged_wallet_topup_signed_total_minor',
    ],
    null,
  ],
  ['R2', ['adoption_orders_zero_total', 'adoption_orders_shape'], null],
  [
    'R3',
    [
      'revenue_view_standard_unchanged',
      'revenue_view_adoption_zero',
      'wallet_window_openings_only',
    ],
    'manual half: the Web Admin financial report for the import day, read by eye (manual-acceptance.md row R3)',
  ],
  ['S1', ['service_closure_map_plus_invalid_keys', 'report_candidates_equal_source'], null],
  ['S2', ['invoice_keys_outside_evidenced_shape'], null],
  ['S3', ['report_equation_S3'], null],
  ['S4', ['orphans_in_customer_missing'], null],
  [
    'S5',
    ['adopted_equals_eligible', 'adopted_services_appeared', 'one_service_per_adoption'],
    null,
  ],
  ['P1', ['provider_writes_zero'], null],
  ['P2', ['adopted_services_without_operations'], null],
  ['P3', ['report_provider_writes_zero', 'report_equation_P3'], null],
  [
    'P4',
    ['panel_state_unchanged', 'panel_state_walk_reads_only'],
    'manual half: two adopted accounts spot-checked in the RickPanel UI (manual-acceptance.md row P4); sub_updated_at is not machine-read',
  ],
];

/** The closures reconciliation.md states outside the 23 numbered equations. */
export const CLOSURES = [
  ['trial grants = 0 (§5)', ['no_trial_grants']],
  ['no customer message (§4)', ['no_customer_messages', 'reminder_seed_sent_no_messages']],
  ['panel map complete (G10)', ['panel_map_complete']],
];

/** One row's state from the summary's checks (cycle 0 checks count for every cycle). */
export function decide(checks, names) {
  const rows = checks.filter((c) => names.includes(c.check));
  const missing = names.filter((n) => !rows.some((c) => c.check === n));
  const failed = rows.filter((c) => c.result === 'FAIL');
  const pending = rows.filter((c) => c.result === 'PENDING');
  const unknown = rows.filter((c) => !['PASS', 'FAIL', 'PENDING'].includes(c.result));
  if (failed.length > 0 || unknown.length > 0) {
    return {
      state: 'FAILS',
      detail: [...failed, ...unknown].map((c) => `c${c.cycle} ${c.check}: ${c.actual}`).join('; '),
    };
  }
  if (missing.length > 0)
    return { state: 'MISSING', detail: `not recorded: ${missing.join(', ')}` };
  if (pending.length > 0) {
    return {
      state: 'PENDING',
      detail: pending.map((c) => `c${c.cycle} ${c.check}: ${c.actual}`).join('; '),
    };
  }
  const cycles = [...new Set(rows.map((c) => c.cycle))].sort((a, b) => a - b);
  return { state: 'HOLDS', detail: `cycles ${cycles.join(',')}` };
}

const cell = (text) => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ');

export function render(summary) {
  const checks = summary.checks ?? [];
  const lines = [
    `# Reconciliation result — ${summary.evidenceClass} run`,
    '',
    summary.evidenceClass === 'synthetic'
      ? '**SYNTHETIC: proves the code and the harness only. This is NOT the staging column of reconciliation.md and never legacy evidence.**'
      : `Evidence class: ${summary.evidenceClass}. Verdict: ${summary.verdict}.`,
    '',
    `Legacy dump sha256 \`${summary.legacyDumpSha256 ?? 'absent'}\`; cycles ${summary.cycles ?? '?'}; checks failed ${summary.checksFailed ?? '?'}, pending ${summary.checksPending ?? '?'}.`,
    '',
    '| equation | state | harness checks | detail | manual half |',
    '| -------- | ----- | -------------- | ------ | ----------- |',
  ];
  /** @type {Record<string, string>} */
  const states = {};
  for (const [id, names, manual] of EQUATIONS) {
    const { state, detail } = decide(checks, names);
    states[id] = state;
    lines.push(
      `| ${id} | ${state} | ${names.map((n) => `\`${n}\``).join(', ')} | ${cell(detail)} | ${cell(manual === null ? '—' : `NOT RUN — ${manual}`)} |`,
    );
  }
  lines.push(
    '',
    '| closure | state | harness checks | detail |',
    '| ------- | ----- | -------------- | ------ |',
  );
  for (const [name, names] of CLOSURES) {
    const { state, detail } = decide(checks, names);
    states[name] = state;
    lines.push(
      `| ${name} | ${state} | ${names.map((n) => `\`${n}\``).join(', ')} | ${cell(detail)} |`,
    );
  }
  lines.push(
    '',
    'An equation is exact or it fails: PENDING is an owner decision recorded by name in the readiness record, never a pass, and a manual half NOT RUN keeps the equation open.',
    '',
  );
  return { markdown: lines.join('\n'), states };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (file === undefined) {
    process.stderr.write('usage: legacy-rehearsal-reconciliation.mjs SUMMARY.json\n');
    process.exit(64);
  }
  process.stdout.write(render(JSON.parse(readFileSync(file, 'utf8'))).markdown);
}
