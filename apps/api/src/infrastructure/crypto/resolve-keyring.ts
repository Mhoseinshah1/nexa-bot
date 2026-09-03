import { NexaError, PLATFORM_ERROR_CODES } from '@nexa/contracts';
import { parseKeyring, type KeyringInput, type SecretKeyring } from './keyring.js';

/**
 * The keyring for an already-validated config.
 *
 * The config schema has run `parseKeyring` and refused to boot if it failed, so
 * reaching the throw here means the schema and this call disagreed — which is a
 * bug, not an operator mistake, and is worth saying so rather than silently
 * carrying on with a half-built keyring.
 *
 * Separate from `parseKeyring` so that the schema can depend on the parser
 * without depending on `NexaError`, and so this file has exactly one reason to
 * exist: turning a validated config into the object the cipher needs.
 */
export function resolveKeyring(config: KeyringInput): SecretKeyring {
  const result = parseKeyring(config);
  if (!result.ok) {
    throw new NexaError({
      kind: 'CONFIGURATION',
      code: PLATFORM_ERROR_CODES.CONFIG_INVALID,
      message: `The secret keyring is not usable: ${result.problems.join('; ')}`,
    });
  }
  return result.keyring;
}
