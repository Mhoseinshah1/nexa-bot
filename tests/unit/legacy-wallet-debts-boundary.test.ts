import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Mirza migration PR4 — owner decision 6 (2026-10-07): a negative legacy balance is a
 * legacy DEBT held for review, and it is NEVER collected. "Never collected" is a property
 * of who can READ the debt: a balance, a purchase, a top-up, a refund, a clawback or a
 * settlement that could see it could net it off. So the table and its module are reachable
 * from exactly these files, and the debt module reaches no money path. A new reader is a
 * deliberate change to this list, with a reason, in the same commit.
 *
 * Owner decision 2026-10-17 superseded decision 6 for the one-time import: a negative
 * balance is now a DEBIT opening, and NOTHING writes the table any more. What is left of it
 * is read-only, so a table a previous rehearsal filled is still reported (U6), never acted on.
 */

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/u.test(name) ? [path] : [];
  });
}

const MENTION =
  /legacy_wallet_debts|legacyWalletDebts|legacy-wallet-debts|LegacyWalletDebt|LEGACY_WALLET_DEBT/u;

const ALLOWED = new Set([
  // The table's definition and the composition root.
  'apps/api/src/infrastructure/persistence/schema.ts',
  'apps/api/src/container.ts',
  // The importer's read-only plan and reconciliation aggregates.
  'apps/api/src/modules/platform/legacy-importer/infrastructure/drizzle-legacy-importer.repository.ts',
  // Mirza PR6: the final report v2's duplicate counter (the most debts one customer holds),
  // one read-only aggregate. It reads no amount and writes nothing.
  'apps/api/src/modules/platform/legacy-cutover/infrastructure/drizzle-legacy-cutover.repository.ts',
  // Mirza `.nxpkg` importer: Customer 360's history card counts a customer's debt rows
  // (`walletDebtCount`, under `legacy.debts.view`). A row count only: no amount, no write.
  'apps/api/src/modules/platform/legacy-history/infrastructure/drizzle-legacy-history.repository.ts',
  // Mirza `.nxpkg` importer: «سوابق مالی میرزا» sets the customer's debt (amount, currency,
  // state) beside the opening credit to reconcile both with the snapshot Balance, and counts
  // them tenant-wide. Inside a READ ONLY transaction: it can write nothing, and no money path
  // reads it (only the history card's read service and the report CLI).
  'apps/api/src/modules/platform/legacy-history/infrastructure/drizzle-legacy-money-history.reader.ts',
  // Mirza `.nxpkg` importer: the fresh-target guard (design §6) counts the tenant's debt rows
  // to refuse a non-empty target. A row count only: no amount, no write, no customer.
  'apps/api/src/modules/platform/legacy-importer/infrastructure/nxpkg-fresh-target.ts',
  // R9 C6: the cutover's read-only reconciliation (`cutover-reconcile`, a restored copy only)
  // counts the tenant's debt rows to report them beside the balances. A row count only: no
  // amount, no write, and it refuses a production database by name.
  'apps/api/src/modules/platform/legacy-cutover/infrastructure/pg-cutover-reconciliation.reader.ts',
]);

describe('the legacy wallet debt boundary (never collected)', () => {
  it('is named by no file outside the allowlist — no balance, payment, order or pricing path reads it', () => {
    const files = sources('apps/api/src');
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter((file) => MENTION.test(readFileSync(file, 'utf8')))
      .map((file) => file.split('\\').join('/'))
      .filter((file) => !ALLOWED.has(file));
    expect(offenders).toEqual([]);
  });

  it('the owner’s separate debt review is gone (owner decision 2026-10-17)', () => {
    expect(existsSync('apps/api/src/modules/commerce/legacy-wallet-debts')).toBe(false);
    expect(existsSync('apps/api/src/surfaces/web/legacy-debts.controller.ts')).toBe(false);
  });

  it('the wallet balance and every ordinary wallet movement never mention a debt', () => {
    for (const file of [
      'apps/api/src/modules/commerce/wallet/domain/balance.ts',
      'apps/api/src/modules/commerce/wallet/application/wallet.service.ts',
      'apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository.ts',
    ]) {
      expect(MENTION.test(readFileSync(file, 'utf8')), file).toBe(false);
    }
  });

  it('the opening-balance service writes no legacy debt: a negative balance is its DEBIT', () => {
    const text = readFileSync(
      'apps/api/src/modules/commerce/wallet/application/migration-opening-balance.service.ts',
      'utf8',
    );
    expect(MENTION.test(text)).toBe(false);
    // One write path for both signs: the direction is the sign of the legacy balance.
    expect(text.match(/this\.deps\.repository\.append\(/gu)).toHaveLength(1);
    expect(text).toContain("command.legacyBalanceMinor < 0n ? 'DEBIT' : 'CREDIT'");
  });

  it('nothing writes the legacy-debt table any more (no INSERT anywhere in the API)', () => {
    const offenders = sources('apps/api/src').filter((file) =>
      /INSERT INTO\s+"?legacy_wallet_debts|insert\(legacyWalletDebts\)/u.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
