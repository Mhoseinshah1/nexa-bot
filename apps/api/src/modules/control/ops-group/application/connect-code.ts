import { createHash, randomInt } from 'node:crypto';
import { OPS_CONNECT_CODE_ALPHABET, OPS_CONNECT_CODE_LENGTH } from '@nexa/contracts';

/**
 * A fresh one-time connection code, drawn uniformly from the contract's alphabet with the
 * platform CSPRNG (`randomInt` rejects rather than biases).
 */
export function newOpsConnectCode(): string {
  let code = '';
  for (let index = 0; index < OPS_CONNECT_CODE_LENGTH; index += 1) {
    code += OPS_CONNECT_CODE_ALPHABET[randomInt(OPS_CONNECT_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * What is stored for a code: its SHA-256, never the code.
 *
 * A code is a short-lived bearer credential for "bind a chat to this tenant", so a read of
 * the table must not hand one out. A plain digest is enough — the code has ~59 bits and
 * lives ten minutes, so there is nothing to gain from a slow hash — and it is what makes
 * the lookup an index probe.
 */
export function hashOpsConnectCode(normalisedCode: string): string {
  return createHash('sha256').update(`ops-connect:${normalisedCode}`).digest('hex');
}
