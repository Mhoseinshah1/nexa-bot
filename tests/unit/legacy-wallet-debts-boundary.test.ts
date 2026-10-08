import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Mirza migration PR4 — owner decision 6 (2026-10-07): a negative legacy balance is a
 * legacy DEBT held for review, and it is NEVER collected. "Never collected" is a property
 * of who can READ the debt: a balance, a purchase, a top-up, a refund, a clawback or a
 * settlement that could see it could net it off. So the table and its module are reachable
 * from exactly these files, and the debt module reaches no money path. A new reader is a
 * deliberate change to this list, with a reason, in the same commit.
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
  // The debt module itself: the owner's review, which moves no money.
  'apps/api/src/modules/commerce/legacy-wallet-debts/application/legacy-wallet-debt.service.ts',
  'apps/api/src/modules/commerce/legacy-wallet-debts/application/ports.ts',
  'apps/api/src/modules/commerce/legacy-wallet-debts/infrastructure/drizzle-legacy-wallet-debt.repository.ts',
  // The ONE writer: the migration-only opening balance records a debt instead of a DEBIT.
  'apps/api/src/modules/commerce/wallet/application/migration-opening-balance.service.ts',
  // The importer's read-only plan and reconciliation aggregates.
  'apps/api/src/modules/platform/legacy-importer/infrastructure/drizzle-legacy-importer.repository.ts',
  // Mirza PR6: the final report v2's duplicate counter (the most debts one customer holds),
  // one read-only aggregate. It reads no amount and writes nothing.
  'apps/api/src/modules/platform/legacy-cutover/infrastructure/drizzle-legacy-cutover.repository.ts',
  // The Web Admin's list and decisions (through the review service only).
  'apps/api/src/surfaces/web/legacy-debts.controller.ts',
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

  it('the debt module imports no wallet, ledger, payment, order, pricing, refund or provider code', () => {
    const files = sources('apps/api/src/modules/commerce/legacy-wallet-debts');
    expect(files.length).toBeGreaterThanOrEqual(3);
    const money =
      /from '[^']*(?:\/wallet\/|\/payments\/|\/orders\/|\/pricing\/|\/refunds?\/|\/commercial\/|\/provisioning\/|\/providers\/|\/resellers\/|\/referrals\/)/u;
    const offenders = files.filter((file) => money.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
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

  it('the opening-balance service writes a negative balance as a debt and never as a DEBIT', () => {
    const text = readFileSync(
      'apps/api/src/modules/commerce/wallet/application/migration-opening-balance.service.ts',
      'utf8',
    );
    // The only `append` is the positive path's CREDIT; the negative path returns before it.
    const negative = text.indexOf(
      'if (command.legacyBalanceMinor < 0n) {\n          return this.holdNegative(',
    );
    const append = text.indexOf('this.deps.repository.append(');
    expect(negative).toBeGreaterThan(0);
    expect(append).toBeGreaterThan(negative);
    expect(text.match(/this\.deps\.repository\.append\(/gu)).toHaveLength(1);
  });
});
