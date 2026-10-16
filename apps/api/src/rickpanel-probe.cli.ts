import { isNexaError, type TenantContext } from '@nexa/contracts';
import { createContainer } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import {
  G6_PROBE_DEFAULT_MAX_PAGES,
  G6_PROBE_DEFAULT_MAX_WALL_MS,
  G6_PROBE_DEFAULT_WALKS,
  G6_PROBE_MAX_PAGES_CEILING,
  G6_PROBE_MAX_WALL_MS_CEILING,
  g6ProbeExitCode,
  probePanelG6,
  type G6ProbeReport,
} from './modules/platform/legacy-importer/infrastructure/rickpanel-g6-probe.js';
import { walkOverlap } from './modules/platform/legacy-importer/infrastructure/rickpanel-inventory-source.js';

/**
 * `pnpm rickpanel-probe` — gate G6: a BOUNDED, READ-ONLY probe of one RickPanel's account list
 * (`docs/rickpanel-inventory-acceptance.md` §G6).
 *
 * Why a CLI under `apps/api/src` and not the `pnpm test:acceptance:inventory` harness: G6 is
 * run where the panel and its stored credential already are — the staging installation — from
 * the runtime image, with no checkout, no devDependencies and no password typed into a shell.
 * It reads the panel's STORED credential and goes through the importer's own protected read
 * (`RickpanelInventorySource.withReadSession`): the installation-wide read gate (it queues
 * behind a dry run's read of the same panel, and a dry run behind it), the configured pacing
 * (`RICKPANEL_INVENTORY_REQUEST_INTERVAL_MS`, 1 s by default, at least 250 ms in production),
 * one login, the bounded retry budget and the read-only guard. The probe adds hard caps of its
 * own on list pages and wall time.
 *
 * It sends the token exchange and `GET api/users?offset=&limit=` and NOTHING else; the report
 * counts what reached the wire by kind and the exit code is 4 if anything else was sent or
 * attempted. Output is ONE line of JSON on stdout — numbers and closed codes only, never a
 * name, a row, a token or an address — and one line for a person on stderr.
 *
 *   --panel <id>          the NEXA panel to probe (required)
 *   --tenant <slug>       a tenant other than the primary one
 *   --page-size <n>       rows per page (default RICKPANEL_INVENTORY_PAGE_SIZE)
 *   --walks <2|3>         overlapping walks (default 3)
 *   --max-pages <n>       hard cap on list pages (default 400, at most 5000)
 *   --max-minutes <n>     hard cap on wall time (default 20, at most 90)
 *
 * Exit: 0 G6 holds · 1 G6 fails (see `findings`) · 2 usage · 3 inconclusive (a failure, a
 * cap, no such panel or credential) · 4 something but a read was sent (a defect).
 */

export interface ProbeArgs {
  readonly panelId: string;
  readonly tenantSlug: string | null;
  readonly pageSize: number | null;
  readonly walks: number;
  readonly maxPages: number;
  readonly maxWallMs: number;
}

export class ProbeArgsError extends Error {}

const USAGE =
  'Usage: --panel <id> [--tenant <slug>] [--page-size <n>] [--walks 2|3] [--max-pages <n>] [--max-minutes <n>]';

function count(flag: string, raw: string, min: number, max: number): number {
  if (!/^[0-9]{1,6}$/u.test(raw)) throw new ProbeArgsError(`${flag} must be a whole number.`);
  const value = Number(raw);
  if (value < min || value > max) {
    throw new ProbeArgsError(`${flag} must be between ${String(min)} and ${String(max)}.`);
  }
  return value;
}

/** Parsed strictly: an unknown flag, a missing value or a value past a ceiling is refused. */
export function parseProbeArgs(argv: readonly string[]): ProbeArgs {
  const known = new Set([
    '--panel',
    '--tenant',
    '--page-size',
    '--walks',
    '--max-pages',
    '--max-minutes',
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    if (!known.has(flag)) {
      throw new ProbeArgsError(
        `Unknown argument (${String(index + 1)} of ${String(argv.length)}). ${USAGE}`,
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ProbeArgsError(`${flag} needs a value.`);
    }
    if (values.has(flag)) throw new ProbeArgsError(`${flag} given twice.`);
    values.set(flag, value);
    index += 1;
  }
  const panelId = values.get('--panel');
  if (panelId === undefined || !/^[0-9A-Za-z-]{1,64}$/u.test(panelId)) {
    throw new ProbeArgsError(`--panel <id> is required. ${USAGE}`);
  }
  const raw = (flag: string) => values.get(flag);
  const pageSize = raw('--page-size');
  const walks = raw('--walks');
  const maxPages = raw('--max-pages');
  const maxMinutes = raw('--max-minutes');
  return {
    panelId,
    tenantSlug: values.get('--tenant') ?? null,
    pageSize: pageSize === undefined ? null : count('--page-size', pageSize, 1, 200),
    walks: walks === undefined ? G6_PROBE_DEFAULT_WALKS : count('--walks', walks, 2, 3),
    maxPages:
      maxPages === undefined
        ? G6_PROBE_DEFAULT_MAX_PAGES
        : count('--max-pages', maxPages, 1, G6_PROBE_MAX_PAGES_CEILING),
    maxWallMs:
      maxMinutes === undefined
        ? G6_PROBE_DEFAULT_MAX_WALL_MS
        : count('--max-minutes', maxMinutes, 1, G6_PROBE_MAX_WALL_MS_CEILING / 60_000) * 60_000,
  };
}

/** The one line a person reads on stderr: the verdict, the findings, what it cost. */
export function probeSummaryLine(report: G6ProbeReport): string {
  return (
    `G6 ${report.verdict}` +
    (report.findings.length > 0 ? ` — ${report.findings.join(', ')}` : '') +
    ` (${String(report.wire.login)} login, ${String(report.wire.listPage)} list pages, ` +
    `${String(Math.round(report.load.durationMs / 1000))} s` +
    (report.budget.stoppedBy === null ? '' : `, stopped by ${report.budget.stoppedBy} cap`) +
    (report.readOnly ? '' : ', NOT READ-ONLY') +
    ')'
  );
}

async function main(): Promise<number> {
  const args = parseProbeArgs(process.argv.slice(2));
  const config = loadConfig();
  const container = createContainer(config, 'worker');
  try {
    const tenant =
      args.tenantSlug === null
        ? await container.tenants.findPrimary()
        : await container.tenants.findBySlug(args.tenantSlug);
    if (tenant === null) {
      throw new ProbeArgsError(
        args.tenantSlug === null
          ? 'No primary tenant exists.'
          : `No tenant with slug "${args.tenantSlug}".`,
      );
    }
    const scope: TenantContext = { tenantId: tenant.id, botInstanceId: null };
    const result = await probePanelG6(
      container.rickpanelInventorySource(),
      scope,
      args.panelId,
      {
        pageSize: args.pageSize ?? config.RICKPANEL_INVENTORY_PAGE_SIZE,
        walks: args.walks,
        maxPages: args.maxPages,
        maxWallMs: args.maxWallMs,
      },
      walkOverlap,
    );
    if (!result.ok) {
      process.stdout.write(`${JSON.stringify({ probe: 'G6', failure: result.failure })}\n`);
      console.error(`G6 not run: ${result.failure}`);
      return 3;
    }
    process.stdout.write(`${JSON.stringify(result.report)}\n`);
    console.error(probeSummaryLine(result.report));
    return g6ProbeExitCode(result.report);
  } finally {
    await container.shutdown();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      if (error instanceof ProbeArgsError) {
        console.error(error.message);
        process.exitCode = 2;
        return;
      }
      if (isNexaError(error)) console.error(`${error.code}: ${error.message}`);
      else console.error(error instanceof Error ? error.message : 'the probe failed');
      process.exitCode = 3;
    },
  );
}
