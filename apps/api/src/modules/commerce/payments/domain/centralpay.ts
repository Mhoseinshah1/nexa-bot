import {
  CENTRALPAY_INTEGER_MAX,
  CENTRALPAY_INTEGER_MIN,
  CENTRALPAY_REFERENCE_ID_MAX_LENGTH,
  type CentralPayStatus,
  type GatewayApprovalVerdict,
} from '@nexa/contracts';

/**
 * The CentralPay rules that decide anything, as pure functions
 * (`docs/centralpay-gateway-audit.md` §5). `tests/unit/centralpay-adapter.test.ts` pins each.
 */

/** Random bytes one integer draw takes: 48 bits, so the modulo bias is negligible. */
export const CENTRALPAY_INTEGER_RANDOM_BYTES = 6;

/**
 * A ten-digit integer inside the contract's range, from caller-supplied random bytes, as
 * decimal text. Used for a per-attempt `orderId` and a customer's stable `userId`. Not
 * derived from any Nexa id, so it discloses nothing and cannot be steered.
 */
export function centralpayInteger(random: Uint8Array): string {
  if (random.length < CENTRALPAY_INTEGER_RANDOM_BYTES) {
    throw new Error(`centralpayInteger needs ${CENTRALPAY_INTEGER_RANDOM_BYTES} random bytes`);
  }
  let value = 0n;
  for (let index = 0; index < CENTRALPAY_INTEGER_RANDOM_BYTES; index += 1) {
    value = (value << 8n) | BigInt(random[index] ?? 0);
  }
  const span = CENTRALPAY_INTEGER_MAX - CENTRALPAY_INTEGER_MIN + 1n;
  return (CENTRALPAY_INTEGER_MIN + (value % span)).toString();
}

/** Whether `text` is an integer this installation could have sent (ten digits, in range). */
export function isCentralPayInteger(text: string): boolean {
  if (!/^[0-9]{10}$/u.test(text)) return false;
  const value = BigInt(text);
  return value >= CENTRALPAY_INTEGER_MIN && value <= CENTRALPAY_INTEGER_MAX;
}

/**
 * A provider integer read EXACTLY, or null: a JSON number that is a non-negative safe
 * integer, or a string of 1–15 decimal digits. `1500.0`, `1.5e3`, `"1,500"`, a sign, a
 * float or anything else is not an integer Nexa can compare, and is null — which is never
 * read as a match.
 */
export function providerInteger(value: unknown): bigint | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string' && /^[0-9]{1,15}$/u.test(value)) return BigInt(value);
  return null;
}

/**
 * A provider `referenceId` as text, or null: a non-empty string of printable ASCII, or a
 * non-negative safe integer, bounded. It becomes the attempt's write-once charge id.
 */
export function providerReference(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text.length > CENTRALPAY_REFERENCE_ID_MAX_LENGTH) return null;
  return /^[\x21-\x7E]+$/u.test(text) ? text : null;
}

/** What one verify answer says, reduced to what a verdict reads. Never the card number. */
export interface CentralPayVerification {
  /** `success === true` exactly — not a truthy string, not `1`. */
  readonly success: boolean;
  /** The raw `data.amount`, judged only through `providerInteger`. */
  readonly amount: unknown;
  /** The raw `data.userId`. */
  readonly userId: unknown;
  /** The raw `data.referenceId`. */
  readonly referenceId: unknown;
}

/** Why a verified answer is NOT an approval. Recorded on the audit row and the condition. */
export type CentralPayMismatchReason =
  'PROVIDER_AMOUNT_MISMATCH' | 'PROVIDER_USER_MISMATCH' | 'PROVIDER_REFERENCE_MISSING';

export interface CentralPayJudgement {
  readonly status: CentralPayStatus;
  readonly verdict: GatewayApprovalVerdict;
  readonly reference: string | null;
  readonly mismatchReason: CentralPayMismatchReason | null;
}

/**
 * What one verify answer MEANS for Nexa (`docs/centralpay-gateway-audit.md` §5.4).
 *
 * - Not `success: true` is OPEN: the guide documents no failure vocabulary, so nothing
 *   readable is ever a definitive "no" — the attempt closes at its own deadline.
 * - `success: true` approves ONLY when the Toman amount is exactly `expectedToman`, the
 *   `userId` is exactly the customer's number Nexa sent, and a `referenceId` is present.
 * - `success: true` with anything else is MISMATCH: the provider says money arrived for
 *   this order, but not the money, the customer or the evidence Nexa asked for. Never
 *   settled, never failed: the payment goes to UNKNOWN for an operator.
 */
export function centralpayVerdict(
  verification: CentralPayVerification,
  expected: { readonly toman: bigint; readonly userId: string | null },
): CentralPayJudgement {
  if (!verification.success) {
    return { status: 'unverified', verdict: 'OPEN', reference: null, mismatchReason: null };
  }
  const reference = providerReference(verification.referenceId);
  const mismatch = (reason: CentralPayMismatchReason): CentralPayJudgement => ({
    status: 'verified',
    verdict: 'MISMATCH',
    reference,
    mismatchReason: reason,
  });
  const amount = providerInteger(verification.amount);
  if (amount === null || amount !== expected.toman) return mismatch('PROVIDER_AMOUNT_MISMATCH');
  const userId = providerInteger(verification.userId);
  if (expected.userId === null || userId === null || userId.toString() !== expected.userId) {
    return mismatch('PROVIDER_USER_MISMATCH');
  }
  if (reference === null) return mismatch('PROVIDER_REFERENCE_MISSING');
  return { status: 'verified', verdict: 'APPROVED', reference, mismatchReason: null };
}

/**
 * The return URL CentralPay sends the browser back to: the GENERATED base (origin, return
 * prefix, provider, tenant) with this attempt's `orderId` as the one query parameter —
 * the guide's own instruction, since the return is a GET carrying no order data.
 */
export function centralpayReturnUrl(base: string, orderId: string): string {
  const url = new URL(base);
  url.search = new URLSearchParams({ orderId }).toString();
  return url.toString();
}
