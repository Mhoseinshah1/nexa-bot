import {
  COMMERCE_ERROR_CODES,
  isNexaError,
  systemJobActor,
  type CorrelationId,
  type TenantContext,
} from '@nexa/contracts';
import { createContainer } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import type {
  PruneCandidate,
  PruneListing,
} from './modules/commerce/customers/application/customer-prune.service.js';

/**
 * `botctl customers prune-empty [--apply]` — remove the customers nothing refers to.
 *
 * A CLI and never an endpoint, like the other operator recovery tools: deleting a customer
 * has no caller to authorize over HTTP, and nothing else in the system deletes one.
 *
 *   list   [--count] [--tenant <slug>]            the DEFAULT. Prints the customers that have
 *                                                 no dependent row anywhere. Changes nothing.
 *   apply  --expect-count <n> --typed <text> [--tenant <slug>]
 *                                                 deletes them, in one transaction, only the
 *                                                 ones that are STILL empty, at most <n>.
 *
 * `botctl` takes the backup and reads the typed confirmation from the terminal; this CLI
 * checks the confirmation again, so running it by hand cannot skip it. The typed text is the
 * word «حذف» or the count (Persian or ASCII digits). It is not a secret, so it is an argument.
 *
 * All output is Persian: an operator reads it at a terminal. Exit 0 only when the command
 * did what it said.
 */

export type PruneCommand =
  | { readonly kind: 'list'; readonly countOnly: boolean; readonly tenantSlug: string | null }
  | {
      readonly kind: 'apply';
      readonly expectedCount: number;
      readonly typed: string;
      readonly tenantSlug: string | null;
    };

export class PruneArgsError extends Error {}

export const PRUNE_CONFIRM_WORD = 'حذف';
const USAGE =
  'شکل درست: list [--count] [--tenant <slug>] | apply --expect-count <n> --typed <متن> [--tenant <slug>]';

/** Persian and Arabic-Indic digits to ASCII, so «۱۲» and «12» are the same answer. */
export function asciiDigits(text: string): string {
  return text
    .replace(/[۰-۹]/gu, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/gu, (d) => String(d.charCodeAt(0) - 0x0660));
}

/**
 * The typed confirmation is right when it is the word, or exactly the number of customers
 * about to be deleted. A bare «y» or «بله» is not enough for a deletion that cannot be undone.
 */
export function confirmationAccepted(typed: string, count: number): boolean {
  const text = asciiDigits(typed.trim());
  return text === PRUNE_CONFIRM_WORD || (count > 0 && text === String(count));
}

export function parsePruneArgs(argv: readonly string[]): PruneCommand {
  const [first, ...rest] = argv;
  const kind = first === undefined || first.startsWith('--') ? 'list' : first;
  const flags = first === undefined || first.startsWith('--') ? argv : rest;
  if (kind !== 'list' && kind !== 'apply') throw new PruneArgsError(USAGE);
  const known =
    kind === 'list' ? ['--count', '--tenant'] : ['--expect-count', '--typed', '--tenant'];
  const values = new Map<string, string>();
  let countOnly = false;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!;
    if (!known.includes(flag)) throw new PruneArgsError(USAGE);
    if (flag === '--count') {
      countOnly = true;
      continue;
    }
    const value = flags[index + 1];
    if (value === undefined || (value.startsWith('--') && flag !== '--typed')) {
      throw new PruneArgsError(`${flag} به یک مقدار نیاز دارد.`);
    }
    values.set(flag, value);
    index += 1;
  }
  const tenantSlug = values.get('--tenant') ?? null;
  if (kind === 'list') return { kind, countOnly, tenantSlug };
  const rawCount = values.get('--expect-count');
  const typed = values.get('--typed');
  if (rawCount === undefined || typed === undefined) {
    throw new PruneArgsError(
      '--expect-count و --typed الزامی‌اند؛ این دستور را با «botctl customers prune-empty --apply» اجرا کنید.',
    );
  }
  if (!/^[0-9]{1,9}$/u.test(rawCount)) {
    throw new PruneArgsError('--expect-count باید یک عدد صحیح باشد.');
  }
  return { kind, expectedCount: Number(rawCount), typed, tenantSlug };
}

/** A name is third-party text: no control or bidi-override characters reach the terminal. */
function printable(text: string): string {
  return text.replace(/[\p{Cc}‪-‮⁦-⁩]/gu, ' ').trim();
}

export function candidateLine(c: PruneCandidate): string {
  return [c.id, c.telegramUserId, printable(c.displayName), c.createdAt.toISOString()].join('\t');
}

export function listingText(listing: PruneListing): string {
  const n = listing.candidates.length;
  const lines: string[] = [];
  if (n === 0) {
    lines.push('هیچ مشتریِ بدون وابستگی‌ای وجود ندارد؛ چیزی برای حذف نیست.');
  } else {
    lines.push(`مشتریان بدون هیچ وابستگی: ${String(n)} مورد`);
    lines.push('شناسه\tشناسهٔ تلگرام\tنام\tتاریخ ثبت (UTC)');
    for (const candidate of listing.candidates) lines.push(candidateLine(candidate));
  }
  lines.push(
    `بررسی شد: ${String(listing.dependentTables)} جدول که به مشتری ارجاع می‌دهند (سفارش، پرداخت، سرویس، کیف پول، تیکت، ارجاع، کارت هدیه و …).`,
  );
  if (listing.keptForStanding > 0) {
    lines.push(
      `${String(listing.keptForStanding)} مشتریِ دیگر هم وابستگی ندارند ولی مسدودند، از واردات آمده‌اند یا شماره تلفن/تخفیف شخصی دارند؛ حذف نمی‌شوند.`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const command = parsePruneArgs(process.argv.slice(2));
  // Before the container exists, so a wrong confirmation never opens a database connection.
  if (command.kind === 'apply' && !confirmationAccepted(command.typed, command.expectedCount)) {
    throw new PruneArgsError(
      `تأیید نادرست بود؛ چیزی حذف نشد. باید «${PRUNE_CONFIRM_WORD}» یا تعداد (${String(command.expectedCount)}) را تایپ کنید.`,
    );
  }
  const container = createContainer(loadConfig(), 'worker');
  try {
    const tenant =
      command.tenantSlug === null
        ? await container.tenants.findPrimary()
        : await container.tenants.findBySlug(command.tenantSlug);
    if (tenant === null) throw new PruneArgsError('چنین tenantی وجود ندارد.');
    const scope: TenantContext = { tenantId: tenant.id, botInstanceId: null };
    const actor = systemJobActor('customers-prune', container.ids.uuid() as CorrelationId);
    if (command.kind === 'list') {
      const listing = await container.customerPrune.list(scope, actor);
      process.stdout.write(
        command.countOnly
          ? `${String(listing.candidates.length)}\n`
          : `${listingText(listing)}\nاین فقط یک فهرست است؛ چیزی حذف نشد. برای حذف: botctl customers prune-empty --apply\n`,
      );
      return;
    }
    const result = await container.customerPrune.apply(scope, actor, {
      expectedCount: command.expectedCount,
    });
    console.warn(
      result.deleted === 0
        ? 'مشتری‌ای برای حذف نمانده بود (یا همه وابستگی پیدا کرده بودند)؛ چیزی حذف نشد.'
        : `${String(result.deleted)} مشتریِ بدون وابستگی حذف شد (از ${String(command.expectedCount)} موردِ تأییدشده). یک ردیف ممیزی ثبت شد.`,
    );
  } finally {
    await container.shutdown();
  }
}

/** The operator-facing reason, never a stack and never a query. */
export function describeFailure(error: unknown): string {
  if (error instanceof PruneArgsError) return error.message;
  if (isNexaError(error)) {
    if (error.code === COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID) {
      return 'حذف انجام نشد و چیزی تغییر نکرد (مشتری تازه‌ای خالی شده، نصب متوقف است یا ورودی نادرست بود). فهرست را دوباره بگیرید.';
    }
    return `ناموفق: ${error.code}`;
  }
  return 'خطای پایگاه داده یا سیستم؛ چیزی حذف نشد. «botctl logs api» را ببینید.';
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    console.error(describeFailure(error));
    if (process.env['NEXA_DEBUG_CLI'] === '1') console.error(error);
    process.exitCode = 1;
  });
}
