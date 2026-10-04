import {
  LEGACY_REVIEW_RESOLUTION_CODES,
  LEGACY_REVIEW_STATES,
  isLegacyImportSourceTable,
  isLegacyReviewReasonCode,
  type ActorContext,
  type LegacyReviewReasonCode,
  type LegacyReviewResolutionCode,
  type LegacyReviewState,
  type TenantContext,
} from '@nexa/contracts';
import type { LegacyReviewQueueService } from './modules/platform/legacy-import/application/legacy-review-queue.service.js';

/**
 * `legacy-import review counts|list|resolve|reopen` — the operator's terminal onto the
 * Manual Review Queue (Item 9, `LegacyReviewQueueService`, `maintenance.run`).
 *
 * TERMINAL ONLY. `list` prints legacy keys, and a `user` row's key IS a Telegram id
 * (program §23: never in shared logs, reports or run summaries). So this subcommand has no
 * `--out` and no `--format`: both are refused, it writes to stdout and nowhere else, and
 * nothing it prints enters a report, an audit row or an event — the queue service audits
 * by the row's uuid. Paste a `list` page into a ticket and you have leaked identities; the
 * usage text says so.
 *
 * Each `resolve` / `reopen` invocation takes a FRESH idempotency key: two invocations are
 * two decisions (resolve, reopen, resolve again), and the key only protects one invocation
 * from a retried request.
 */

export class ReviewUsageError extends Error {}

export const REVIEW_ACTIONS = ['counts', 'list', 'resolve', 'reopen'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export const REVIEW_USAGE = [
  'usage: legacy-import review ACTION --tenant TENANT --target TARGET [options]',
  '',
  '  counts  [--run RUN_ID]                                  aggregates by reason and state',
  '  list    [--table user|invoice] [--reason R] [--state OPEN|RESOLVED|DISMISSED]',
  '          [--run RUN_ID] [--after TABLE:ID] [--limit 1..500]   one page of rows',
  '  resolve --table T --legacy-id ID --expected-reason R --resolution CODE',
  '  reopen  --table T --legacy-id ID',
  '',
  "  TERMINAL ONLY: list prints legacy ids, and a user row's id is a Telegram id.",
  '  Never paste a page into a ticket, a chat or a report. --out and --format are refused.',
  `  resolution codes: ${LEGACY_REVIEW_RESOLUTION_CODES.join(', ')}`,
].join('\n');

export type ReviewArgs =
  | {
      readonly action: 'counts';
      readonly tenant: string;
      readonly target: string;
      readonly runId: string | null;
      readonly allowProductionTarget: boolean;
    }
  | {
      readonly action: 'list';
      readonly tenant: string;
      readonly target: string;
      readonly allowProductionTarget: boolean;
      readonly table: string | null;
      readonly reason: LegacyReviewReasonCode | null;
      readonly state: LegacyReviewState | null;
      readonly runId: string | null;
      readonly after: { readonly legacyTable: string; readonly legacyId: string } | null;
      readonly limit: number;
    }
  | {
      readonly action: 'resolve';
      readonly tenant: string;
      readonly target: string;
      readonly allowProductionTarget: boolean;
      readonly table: string;
      readonly legacyId: string;
      readonly expectedReason: LegacyReviewReasonCode;
      readonly resolution: LegacyReviewResolutionCode;
    }
  | {
      readonly action: 'reopen';
      readonly tenant: string;
      readonly target: string;
      readonly allowProductionTarget: boolean;
      readonly table: string;
      readonly legacyId: string;
    };

const VALUE_FLAGS: Readonly<Record<ReviewAction, readonly string[]>> = {
  counts: ['--tenant', '--target', '--run'],
  list: ['--tenant', '--target', '--table', '--reason', '--state', '--run', '--after', '--limit'],
  resolve: ['--tenant', '--target', '--table', '--legacy-id', '--expected-reason', '--resolution'],
  reopen: ['--tenant', '--target', '--table', '--legacy-id'],
};

/** `argv` is everything after `review`. Pure, so every refusal is a unit test. */
export function parseReviewArgs(argv: readonly string[]): ReviewArgs {
  const action = argv[0];
  if (action === undefined || !(REVIEW_ACTIONS as readonly string[]).includes(action)) {
    throw new ReviewUsageError(REVIEW_USAGE);
  }
  const allowed = new Set(VALUE_FLAGS[action as ReviewAction]);
  const values = new Map<string, string>();
  let allowProductionTarget = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--out' || arg === '--format') {
      throw new ReviewUsageError(
        `${arg} is refused: review output is for the operator's terminal only (it can carry Telegram ids).`,
      );
    }
    if (arg === '--allow-production-target') {
      allowProductionTarget = true;
      continue;
    }
    if (!allowed.has(arg))
      throw new ReviewUsageError(
        `Unknown argument ${arg} for review ${action}.\n\n${REVIEW_USAGE}`,
      );
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--'))
      throw new ReviewUsageError(`${arg} needs a value.`);
    if (values.has(arg)) throw new ReviewUsageError(`${arg} is given twice.`);
    values.set(arg, next);
    i += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined)
      throw new ReviewUsageError(`${flag} is required for review ${action}. There is no default.`);
    return value;
  };
  const tenant = required('--tenant');
  const target = required('--target');
  const table = (flag = '--table'): string => {
    const value = required(flag);
    if (!isLegacyImportSourceTable(value))
      throw new ReviewUsageError(`${flag} must be user or invoice.`);
    return value;
  };
  const reason = (value: string | undefined): LegacyReviewReasonCode | null => {
    if (value === undefined) return null;
    if (!isLegacyReviewReasonCode(value))
      throw new ReviewUsageError(`${value} is not a review reason.`);
    return value;
  };
  const base = { tenant, target, allowProductionTarget };
  switch (action as ReviewAction) {
    case 'counts':
      return { action: 'counts', ...base, runId: values.get('--run') ?? null };
    case 'list': {
      const state = values.get('--state') ?? null;
      if (state !== null && !(LEGACY_REVIEW_STATES as readonly string[]).includes(state)) {
        throw new ReviewUsageError('--state must be OPEN, RESOLVED or DISMISSED.');
      }
      const rawLimit = values.get('--limit');
      const limit = rawLimit === undefined ? 50 : Number.parseInt(rawLimit, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new ReviewUsageError('--limit must be between 1 and 500.');
      }
      const rawAfter = values.get('--after');
      let after: { legacyTable: string; legacyId: string } | null = null;
      if (rawAfter !== undefined) {
        const at = rawAfter.indexOf(':');
        const legacyTable = rawAfter.slice(0, at);
        if (at <= 0 || !isLegacyImportSourceTable(legacyTable)) {
          throw new ReviewUsageError('--after is TABLE:ID, as the previous page printed it.');
        }
        after = { legacyTable, legacyId: rawAfter.slice(at + 1) };
      }
      const rawTable = values.get('--table');
      if (rawTable !== undefined && !isLegacyImportSourceTable(rawTable)) {
        throw new ReviewUsageError('--table must be user or invoice.');
      }
      return {
        action: 'list',
        ...base,
        table: rawTable ?? null,
        reason: reason(values.get('--reason')),
        state: state as LegacyReviewState | null,
        runId: values.get('--run') ?? null,
        after,
        limit,
      };
    }
    case 'resolve': {
      const resolution = required('--resolution');
      if (!(LEGACY_REVIEW_RESOLUTION_CODES as readonly string[]).includes(resolution)) {
        throw new ReviewUsageError(
          `--resolution must be one of ${LEGACY_REVIEW_RESOLUTION_CODES.join(', ')}.`,
        );
      }
      const expected = reason(required('--expected-reason'));
      return {
        action: 'resolve',
        ...base,
        table: table(),
        legacyId: required('--legacy-id'),
        expectedReason: expected as LegacyReviewReasonCode,
        resolution: resolution as LegacyReviewResolutionCode,
      };
    }
    case 'reopen':
      return { action: 'reopen', ...base, table: table(), legacyId: required('--legacy-id') };
  }
}

/** Runs one review action and writes its result to `write` — the terminal, never a file. */
export async function runReview(
  queue: Pick<LegacyReviewQueueService, 'counts' | 'list' | 'resolve' | 'reopen'>,
  args: ReviewArgs,
  scope: TenantContext,
  actor: ActorContext,
  freshKey: () => string,
  write: (line: string) => void,
): Promise<void> {
  switch (args.action) {
    case 'counts': {
      const counts = await queue.counts(
        scope,
        actor,
        args.runId === null ? {} : { runId: args.runId },
      );
      write(
        `review rows ${String(counts.rowCount)}  open ${String(counts.byState.OPEN)}  resolved ${String(counts.byState.RESOLVED)}  dismissed ${String(counts.byState.DISMISSED)}`,
      );
      for (const r of counts.byReason) {
        write(
          `${r.legacyTable}\t${r.reasonCode}\topen ${String(r.open)}\tresolved ${String(r.resolved)}\tdismissed ${String(r.dismissed)}`,
        );
      }
      return;
    }
    case 'list': {
      const page = await queue.list(scope, actor, {
        ...(args.table === null ? {} : { legacyTable: args.table }),
        ...(args.reason === null ? {} : { reasonCode: args.reason }),
        ...(args.state === null ? {} : { reviewState: args.state }),
        ...(args.runId === null ? {} : { runId: args.runId }),
        ...(args.after === null ? {} : { after: args.after }),
        limit: args.limit,
      });
      write('table\tlegacy_id\treason\tstate\tresolution\tattempts\tupdated_at');
      for (const item of page.items) {
        write(
          [
            item.legacyTable,
            item.legacyId,
            item.reasonCode,
            item.reviewState,
            item.resolutionCode ?? '-',
            String(item.attempts),
            item.updatedAt.toISOString(),
          ].join('\t'),
        );
      }
      write(
        page.next === null
          ? '(last page)'
          : `next page: --after ${page.next.legacyTable}:${page.next.legacyId}`,
      );
      return;
    }
    case 'resolve': {
      const outcome = await queue.resolve(scope, actor, {
        legacyTable: args.table,
        legacyId: args.legacyId,
        expectedReasonCode: args.expectedReason,
        resolutionCode: args.resolution,
        idempotencyKey: freshKey(),
      });
      write(
        `${outcome.kind}: ${outcome.item.legacyTable} row is ${outcome.item.reviewState} (${outcome.item.resolutionCode ?? '-'})`,
      );
      return;
    }
    case 'reopen': {
      const outcome = await queue.reopen(scope, actor, {
        legacyTable: args.table,
        legacyId: args.legacyId,
        idempotencyKey: freshKey(),
      });
      write(`${outcome.kind}: ${outcome.item.legacyTable} row is ${outcome.item.reviewState}`);
      return;
    }
  }
}
