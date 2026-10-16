import { isNexaError, systemJobActor, type CorrelationId, type TenantContext } from '@nexa/contracts';
import type { BotInstanceId } from '@nexa/contracts';
import { createContainer } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import {
  CUSTOMER_BOT_LINK_BATCH_DEFAULT,
  CUSTOMER_BOT_LINK_BATCH_MAX,
  type CustomerBotLinkReport,
} from './modules/commerce/customers/application/customer-bot-link.service.js';

/**
 * `customers-link-bot` — OI-1 part 2: link the customers the legacy importer created to
 * the production bot, at cutover. Imported customers have `first_bot_instance_id = NULL`
 * and every customer notification, reminder and broadcast drops a NULL.
 *
 *   --bot <uuid>         the bot instance to link them to (required)
 *   --dry-run            DEFAULT. Prints counts only; writes nothing.
 *   --apply              links them, in batches (needs CUSTOMER_BOT_LINK_CONFIRM below)
 *   --tenant <slug>      a tenant other than the primary one
 *   --batch-size <n>     rows per transaction (default 500, max 5000)
 *
 * This turns reminders and notices ON for every imported customer at once, so it refuses
 * to write unless BOTH `--apply` AND the environment variable
 * `CUSTOMER_FIRST_BOT_BACKFILL_CONFIRM=yes` are given. Only rows with a NULL link and an
 * IMPORTED legacy map entry are touched; a re-run links nothing. Output and audit carry
 * counts and the bot id only — never a customer.
 */

export interface LinkBotArgs {
  readonly botInstanceId: string;
  readonly apply: boolean;
  readonly tenantSlug: string | null;
  readonly batchSize: number;
}

export class LinkBotArgsError extends Error {}

export const LINK_BOT_CONFIRM_ENV = 'CUSTOMER_FIRST_BOT_BACKFILL_CONFIRM';
const USAGE =
  'Usage: customers-link-bot --bot <uuid> [--dry-run | --apply] [--tenant <slug>] [--batch-size <n>]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseLinkBotArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): LinkBotArgs {
  let bot: string | null = null;
  let apply = false;
  let dryRun = false;
  let tenantSlug: string | null = null;
  let batchSize = CUSTOMER_BOT_LINK_BATCH_DEFAULT;
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
    if (flag !== '--bot' && flag !== '--tenant' && flag !== '--batch-size')
      throw new LinkBotArgsError(USAGE);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--'))
      throw new LinkBotArgsError(`${flag} needs a value.`);
    i += 1;
    if (flag === '--bot') bot = value;
    else if (flag === '--tenant') tenantSlug = value;
    else {
      if (!/^[0-9]{1,5}$/u.test(value) || Number(value) < 1 || Number(value) > CUSTOMER_BOT_LINK_BATCH_MAX)
        throw new LinkBotArgsError(`--batch-size must be 1..${String(CUSTOMER_BOT_LINK_BATCH_MAX)}.`);
      batchSize = Number(value);
    }
  }
  if (bot === null) throw new LinkBotArgsError(`--bot <uuid> is required. ${USAGE}`);
  if (!UUID.test(bot)) throw new LinkBotArgsError('--bot must be a bot instance uuid.');
  if (apply && dryRun) throw new LinkBotArgsError('--apply and --dry-run are exclusive.');
  if (apply && env[LINK_BOT_CONFIRM_ENV] !== 'yes')
    throw new LinkBotArgsError(
      `Refusing to write: --apply also needs ${LINK_BOT_CONFIRM_ENV}=yes in the environment.`,
    );
  return { botInstanceId: bot.toLowerCase(), apply, tenantSlug, batchSize };
}

export function reportLine(report: CustomerBotLinkReport): string {
  return report.mode === 'DRY_RUN'
    ? `DRY RUN: ${String(report.eligible)} imported customer(s) with no bot link would be linked to bot ${report.botInstanceId}. Nothing written.\n`
    : `APPLIED: linked ${String(report.linked)} of ${String(report.eligible)} eligible customer(s) to bot ${report.botInstanceId} in ${String(report.batches)} batch(es).\n`;
}

async function main(): Promise<void> {
  const args = parseLinkBotArgs(process.argv.slice(2), process.env);
  const container = createContainer(loadConfig(), 'worker');
  try {
    const tenant =
      args.tenantSlug === null
        ? await container.tenants.findPrimary()
        : await container.tenants.findBySlug(args.tenantSlug);
    if (tenant === null) throw new LinkBotArgsError('No such tenant.');
    const scope: TenantContext = { tenantId: tenant.id, botInstanceId: null };
    const actor = systemJobActor('customers-link-bot', container.ids.uuid() as CorrelationId);
    const bot = args.botInstanceId as BotInstanceId;
    const report = args.apply
      ? await container.customerBotLink.apply(scope, actor, bot, args.batchSize)
      : await container.customerBotLink.dryRun(scope, actor, bot);
    process.stdout.write(reportLine(report));
  } finally {
    await container.shutdown();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    if (isNexaError(error)) console.error(`${error.code}: ${error.message}`);
    else if (error instanceof LinkBotArgsError) console.error(error.message);
    else console.error(error);
    process.exitCode = 1;
  });
}
