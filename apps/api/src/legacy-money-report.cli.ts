import { isNexaError, type TenantContext } from '@nexa/contracts';
import { createContainer } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import {
  type MoneyTotal,
  type TenantMoneyReport,
} from './modules/platform/legacy-history/application/money-reconciliation.js';

/**
 * `pnpm legacy-money-report` — the tenant-wide Mirza money reconciliation, READ ONLY.
 *
 * Global totals and counts only — never a customer, an id or a value of one person:
 * the opening credits and legacy debts the migration wrote (and whether they equal the
 * import's own stated totals), customers per reconciliation status and per wallet-history
 * verdict, the archived payments by outcome and purpose, wallet transactions in/out, wheel
 * prizes, referrals, discount uses and service operations, and the ledger's entries by reason.
 *
 * A CLI, not a route: the aggregate scans the whole archive (minutes on a large one), longer
 * than a request may hold a connection. Whoever runs it holds the database credentials. Every
 * statement runs inside one REPEATABLE READ, READ ONLY transaction: it cannot write.
 *
 *   --tenant <slug>      a tenant other than the primary one
 *   --json               print the report as JSON (bigint amounts as decimal strings)
 *   --timeout-ms <n>     statement timeout for this read (default 600000)
 */

export interface ReportArgs {
  readonly tenantSlug: string | null;
  readonly json: boolean;
  readonly timeoutMs: number;
}

export class ReportArgsError extends Error {}

const USAGE = 'Usage: [--tenant <slug>] [--json] [--timeout-ms <n>]';

export function parseReportArgs(argv: readonly string[]): ReportArgs {
  let tenantSlug: string | null = null;
  let json = false;
  let timeoutMs = 600_000;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag !== '--tenant' && flag !== '--timeout-ms') throw new ReportArgsError(USAGE);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--'))
      throw new ReportArgsError(`${flag} needs a value.`);
    index += 1;
    if (flag === '--tenant') tenantSlug = value;
    else {
      if (!/^[0-9]{4,7}$/u.test(value))
        throw new ReportArgsError('--timeout-ms must be 1000..9999999.');
      timeoutMs = Number(value);
    }
  }
  return { tenantSlug, json, timeoutMs };
}

/** JSON with bigint as decimal text. */
export function reportJson(report: TenantMoneyReport): string {
  return JSON.stringify(
    report,
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  );
}

function money(total: MoneyTotal): string {
  const sums =
    total.amounts.map((a) => `${a.amountMinor.toString()} ${a.currency}`).join(' + ') || '0';
  const extra = [
    total.unparsedAmounts > 0 ? `${String(total.unparsedAmounts)} unparsed` : '',
    total.unrecognisedCurrency > 0 ? `${String(total.unrecognisedCurrency)} unknown currency` : '',
  ].filter((part) => part !== '');
  return `${String(total.count)} records, ${sums}${extra.length > 0 ? ` (${extra.join(', ')})` : ''}`;
}

/** The plain-text report: one line per figure, aggregates only. */
/** YES only when proven; UNKNOWN when nothing contradicts it but some opening was not compared. */
function statementWord(value: boolean | null): 'YES' | 'NO' | 'UNKNOWN' {
  return value === null ? 'UNKNOWN' : value ? 'YES' : 'NO';
}

export function reportText(report: TenantMoneyReport): string {
  const lines: string[] = [];
  const o = report.opening;
  lines.push('Mirza money reconciliation (read only; nothing here is added to a balance)');
  lines.push(`opening credits (MIGRATION_OPENING_BALANCE): ${money(o.credits)}`);
  lines.push(
    `legacy debts: ${money(o.debts)}; by state: ${o.debtsByState.map((s) => `${s.state}=${String(s.count)}`).join(', ') || 'none'}`,
  );
  lines.push(
    `opening credits equal the import's stated total: ${String(o.matchesImportStatement)}`,
  );
  lines.push(`debts equal the import's stated total: ${String(o.debtsMatchImportStatement)}`);
  const c = report.snapshotCheck;
  lines.push(
    `wallet-history checks: ${String(c.checked)} customers; opening = snapshot for ${String(c.openingEqualsSnapshot)}, not proven equal for ${String(c.notProvenEqual)}; openings with no check ${String(c.openingsWithoutCheck)}; unlinked checks ${String(c.unlinkedChecks)}`,
  );
  for (const v of report.byVerdict) lines.push(`  verdict ${v.verdict}: ${String(v.customers)}`);
  for (const s of report.byStatus) lines.push(`  status ${s.status}: ${String(s.customers)}`);
  lines.push('payments, SUCCEEDED by purpose:');
  for (const p of report.payments.succeededByPurpose)
    lines.push(`  ${p.purpose}: ${money(p.total)}`);
  lines.push('payments, excluded (not successful):');
  for (const p of report.payments.excludedByOutcome)
    lines.push(`  ${p.outcome}: ${money(p.total)}`);
  const w = report.walletTransactions;
  lines.push(`wallet transactions in: ${money(w.moneyIn)}`);
  lines.push(`wallet transactions out: ${money(w.moneyOut)}`);
  lines.push(
    `wallet transactions no change: ${String(w.noChange)}, unparsed: ${String(w.unparsedAmounts)}`,
  );
  lines.push(
    `wheel: ${String(report.wheel.spins)} spins; prizes won: ${money(report.wheel.prizesWon)}`,
  );
  lines.push(
    `referrals: ${String(report.referrals.records)}; referrer gift paid: ${String(report.referrals.referrerGiftsPaid)}`,
  );
  lines.push(`discount/gift code uses: ${String(report.discountsUsed)}`);
  for (const s of report.serviceOperations)
    lines.push(`service operations ${s.status}: ${money(s.total)}`);
  lines.push(
    `ledger entries by reason: ${report.ledgerReasons.map((r) => `${r.reason}=${String(r.count)}`).join(', ') || 'none'}`,
  );
  lines.push(
    `STATEMENT: every opening credit equals the snapshot Balance: ${statementWord(report.statement.everyOpeningEqualsSnapshot)} (basis ${report.statement.basis})`,
  );
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = parseReportArgs(process.argv.slice(2));
  const container = createContainer(loadConfig(), 'worker');
  try {
    const tenant =
      args.tenantSlug === null
        ? await container.tenants.findPrimary()
        : await container.tenants.findBySlug(args.tenantSlug);
    if (tenant === null) throw new ReportArgsError('No such tenant.');
    const scope: TenantContext = { tenantId: tenant.id, botInstanceId: null };
    const report = await container.legacyMoneyHistory.tenantReport(scope, args.timeoutMs);
    process.stdout.write(args.json ? `${reportJson(report)}\n` : reportText(report));
    if (report.statement.everyOpeningEqualsSnapshot !== true) process.exitCode = 2;
  } finally {
    await container.shutdown();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    if (isNexaError(error)) console.error(`${error.code}: ${error.message}`);
    else if (error instanceof ReportArgsError) console.error(error.message);
    else console.error(error);
    process.exitCode = 1;
  });
}
