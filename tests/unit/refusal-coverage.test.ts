import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMERCE_ERROR_CODES } from '@nexa/contracts';
import { REFUSAL_REPLIES } from '../../apps/api/src/surfaces/telegram/bot-runtime';

/**
 * Every error code a CUSTOMER-reachable service can throw is answered, or exempt by name.
 *
 * ## The hole this closes
 *
 * `bot-runtime.ts` states the rule three times, at length: an unmapped code makes
 * `refusal` RETHROW, the webhook swallows it because a non-200 makes Telegram redeliver
 * for ever, and the customer is answered with silence while the transaction has already
 * rolled back. That is F5R-12.
 *
 * Nothing enforced it. The existing coverage test proves every MAPPED key renders with
 * the values the surface sends — a different property, and one that says nothing about a
 * code with no entry at all. So the rule was maintained by hand across five phases, and
 * the 5F flow pass found FOUR codes that had slipped: the destination-unconfigured
 * refusal the service's own comment predicted would land here, the stopped-installation
 * refusal, a customer-row refusal, and the insufficient-funds fall-through.
 *
 * ## How it decides what must be mapped
 *
 * By reading the SOURCE of the services a customer-initiated command actually reaches
 * and collecting every `COMMERCE_ERROR_CODES.X` they name. That is deliberately cruder
 * than tracing call graphs, and cruder in the safe direction: it over-collects, so an
 * operator-only code has to be exempted BY NAME with a reason rather than being missed.
 * A new code added to any of these files fails this test until somebody decides which
 * it is.
 */

/** The services a customer-initiated Telegram command reaches. */
const CUSTOMER_FACING_SOURCES = [
  'apps/api/src/modules/commerce/payments/application/payment.service.ts',
  'apps/api/src/modules/commerce/payments/application/payment-gateway.service.ts',
  'apps/api/src/modules/commerce/payments/application/receipt.service.ts',
  'apps/api/src/modules/commerce/orders/application/order.service.ts',
  /*
   * The reseller standing every order and commercial path asks (WP9-B). Its two refusals
   * reach a customer from `createDraft`, `confirm` and the commercial actions, and both
   * were unmapped when this list did not name the file — the PR #69 review found them.
   */
  'apps/api/src/modules/commerce/resellers/application/reseller.service.ts',
] as const;

/**
 * Codes those files name that NO customer command can reach, each with the reason.
 *
 * A reason rather than a bare list, because the next person to add one has to be able to
 * check whether it is still true. Every entry here says which caller throws it, and
 * every entry is a claim that can be falsified by finding a bot path that reaches it.
 */
const OPERATOR_ONLY: Readonly<Record<string, string>> = {
  PAYMENT_GATEWAY_NOT_FOUND:
    'thrown only by configure/setStatus/explain, which charge payments.gateways.* and ' +
    'are reachable from the Web Admin alone. The customer path calls offer(), which ' +
    'answers PAYMENT_GATEWAY_UNAVAILABLE instead.',
  RECEIPT_NOT_FOUND:
    'thrown only when an OPERATOR opens a receipt that is not there. A customer submits ' +
    'receipts and never addresses one by id.',
};

function codesNamedIn(path: string): ReadonlySet<string> {
  const source = readFileSync(path, 'utf8');
  const found = new Set<string>();
  for (const match of source.matchAll(/COMMERCE_ERROR_CODES\.([A-Z_]+)/gu)) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
  return found;
}

describe('refusal coverage', () => {
  const mapped = new Set(Object.keys(REFUSAL_REPLIES));

  it('answers every code a customer-facing service can throw', () => {
    const unanswered: string[] = [];
    for (const path of CUSTOMER_FACING_SOURCES) {
      for (const name of codesNamedIn(path)) {
        const code = (COMMERCE_ERROR_CODES as Readonly<Record<string, string>>)[name];
        if (code === undefined) continue;
        if (mapped.has(code)) continue;
        if (name in OPERATOR_ONLY) continue;
        unanswered.push(`${name} (${code}) thrown in ${path}`);
      }
    }
    expect(
      unanswered,
      'these codes reach a customer with no reply mapped: `refusal` rethrows, the ' +
        'webhook swallows it, and the customer is told nothing. Map them in ' +
        'REFUSAL_REPLIES, or add them to OPERATOR_ONLY with the reason no customer ' +
        'command can reach them.',
    ).toStrictEqual([]);
  });

  it('keeps the four codes the 5F pass found mapped', () => {
    /*
     * Named individually, so a future edit that drops one fails HERE with its name
     * rather than only in the sweep above. Each was a real silence.
     */
    for (const code of [
      COMMERCE_ERROR_CODES.PAYMENT_DESTINATION_UNCONFIGURED,
      COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
      COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND,
      COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS,
    ]) {
      expect(mapped.has(code), `${code} must have a customer reply`).toBe(true);
    }
  });

  it('does not exempt a code that is in fact mapped', () => {
    // An exemption that is also mapped is a stale claim, and a reader would trust the
    // wrong one. The sweep skips exemptions first, so this keeps the two lists disjoint.
    for (const name of Object.keys(OPERATOR_ONLY)) {
      const code = (COMMERCE_ERROR_CODES as Readonly<Record<string, string>>)[name];
      if (code === undefined) continue;
      expect(mapped.has(code), `${name} is both mapped and exempt`).toBe(false);
    }
  });
});
