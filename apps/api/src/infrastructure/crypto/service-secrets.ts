import { randomBytes, randomUUID } from 'node:crypto';
import type { ServiceSecretSource } from '../../modules/commerce/provisioning/application/ports.js';

/**
 * The two service identities that are capabilities, from the system CSPRNG.
 *
 * Its own binding rather than a method on `IdGenerator`, and the separation is the
 * point. `IdGenerator.uuid()` is UUIDv7 — time-ordered, with most of its bits a
 * timestamp — which is exactly right for a primary key and exactly wrong for a value
 * that fetches a customer's configuration with no authentication. One port offering
 * both is a port whose next caller reaches for the wrong one, and this codebase has
 * already paid once for treating an identifier and a credential as the same kind of
 * thing.
 */
export const serviceSecrets: ServiceSecretSource = {
  hex(bytes: number): string {
    return randomBytes(bytes).toString('hex');
  },
  clientId(): string {
    return randomUUID();
  },
};
