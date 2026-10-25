import {
  DATA_COMPACTION_CLASS_TABLES,
  DATA_COMPACTION_CLASSES,
  isNexaError,
  systemJobActor,
  type CorrelationId,
  type TenantContext,
} from '@nexa/contracts';
import { createContainer } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import {
  totalOf,
  type DataCompactionOutcome,
} from './modules/platform/data-compaction/application/data-compaction.service.js';

/**
 * `data-compaction` — the owner's trigger for the data compaction (Round 9 C3).
 *
 *   (no flag) / --dry-run   DEFAULT. Counts what would be removed, per table, at today's
 *                           cutoffs, records the dry run, and removes nothing.
 *   --apply --confirm-rows N
 *                           Removes it, in batches of 5000, each its own transaction. N must
 *                           equal the total the dry run reports NOW: a confirmation for one
 *                           count cannot remove another (it is refused with the new count).
 *   --tenant <slug>         a tenant other than the primary one
 *
 * `--apply` is explicit and wins over `retention.compaction_mode`; the worker follows the
 * setting. Output carries counts and table names only, never a row.
 *
 * Exit codes: 0 done, 1 error, 2 another pass is running, 3 the confirmation did not match,
 * 4 a recovery or a backup is in flight (nothing started).
 */

export interface CompactionArgs {
  readonly apply: boolean;
  readonly confirmRows: number | null;
  readonly tenantSlug: string | null;
}

export class CompactionArgsError extends Error {}

const USAGE = 'Usage: data-compaction [--dry-run | --apply --confirm-rows <n>] [--tenant <slug>]';

export function parseCompactionArgs(argv: readonly string[]): CompactionArgs {
  let apply = false;
  let dryRun = false;
  let confirmRows: number | null = null;
  let tenantSlug: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--apply') {
      apply = true;
      continue;
    }
    if (flag === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (flag !== '--confirm-rows' && flag !== '--tenant') throw new CompactionArgsError(USAGE);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new CompactionArgsError(`${flag} needs a value.`);
    }
    i += 1;
    if (flag === '--tenant') tenantSlug = value;
    else {
      if (!/^[0-9]{1,12}$/u.test(value)) {
        throw new CompactionArgsError('--confirm-rows must be a whole number.');
      }
      confirmRows = Number(value);
    }
  }
  if (apply && dryRun) throw new CompactionArgsError('--apply and --dry-run are exclusive.');
  if (apply && confirmRows === null) {
    throw new CompactionArgsError(
      'Refusing to delete: --apply needs --confirm-rows <n>, the total a dry run reports now.',
    );
  }
  if (!apply && confirmRows !== null) {
    throw new CompactionArgsError('--confirm-rows is only meaningful with --apply.');
  }
  return { apply, confirmRows, tenantSlug };
}

/** The report, one line per class and table: counts only. */
export function reportText(outcome: DataCompactionOutcome): { text: string; exitCode: number } {
  switch (outcome.kind) {
    case 'BLOCKED':
      return { text: `NOT STARTED: ${outcome.reason}. Nothing was removed.\n`, exitCode: 4 };
    case 'BUSY':
      return { text: 'NOT STARTED: another compaction pass is running.\n', exitCode: 2 };
    case 'COUNT_MISMATCH':
      return {
        text:
          `REFUSED: ${String(outcome.eligibleRows)} row(s) are eligible now, not the number confirmed. ` +
          `Nothing was removed. Re-run with --confirm-rows ${String(outcome.eligibleRows)}.\n`,
        exitCode: 3,
      };
    case 'RAN': {
      const { run } = outcome;
      const lines = [
        `${run.mode === 'DRY_RUN' ? 'DRY RUN (nothing removed)' : 'APPLIED'}: run ${run.id}, ` +
          `${run.state}${run.stopReason === null ? '' : ` (${run.stopReason})`}`,
      ];
      for (const cls of DATA_COMPACTION_CLASSES) {
        for (const table of DATA_COMPACTION_CLASS_TABLES[cls]) {
          lines.push(`  ${cls} ${table}: ${String(run.counts[table] ?? 0)}`);
        }
      }
      lines.push(`  total: ${String(totalOf(run.counts))}`);
      return { text: `${lines.join('\n')}\n`, exitCode: 0 };
    }
  }
}

async function main(): Promise<void> {
  const args = parseCompactionArgs(process.argv.slice(2));
  const container = createContainer(loadConfig(), 'worker');
  try {
    const tenant =
      args.tenantSlug === null
        ? await container.tenants.findPrimary()
        : await container.tenants.findBySlug(args.tenantSlug);
    if (tenant === null) throw new CompactionArgsError('No such tenant.');
    const scope: TenantContext = { tenantId: tenant.id, botInstanceId: null };
    const actor = systemJobActor('data-compaction-cli', container.ids.uuid() as CorrelationId);
    const outcome = await container.dataCompaction.run(scope, actor, {
      trigger: 'CLI',
      mode: args.apply ? 'APPLY' : 'DRY_RUN',
      ...(args.confirmRows === null ? {} : { expectRows: args.confirmRows }),
    });
    const report = reportText(outcome);
    process.stdout.write(report.text);
    process.exitCode = report.exitCode;
  } finally {
    await container.shutdown();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    if (isNexaError(error)) console.error(`${error.code}: ${error.message}`);
    else if (error instanceof CompactionArgsError) console.error(error.message);
    else console.error(error);
    process.exitCode = 1;
  });
}
