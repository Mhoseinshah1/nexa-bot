/**
 * The context a stored secret is bound to.
 *
 * Every v2 ciphertext authenticates these three values as AEAD associated
 * data. They are not stored beside the ciphertext — they are RECOMPUTED from
 * the caller's arguments at decrypt time, and that recomputation is the whole
 * defence: a ciphertext copied into another row, another tenant or another
 * column recomputes a different context and fails authentication.
 *
 * v1 had none of this. A bot token encrypted for one row decrypted perfectly
 * well in another, so anyone able to write a ciphertext column could transplant
 * a credential between rows. That is `BLOCKER-SECRETS-V2` in
 * `docs/open-questions.md`.
 */

/**
 * What a secret is FOR. A closed catalogue, because it is authenticated data:
 * a free-form purpose is a value an attacker could choose.
 *
 * One purpose names exactly one table and column, so the entity type and the
 * field name are implied by it and are not encoded separately. Adding one is a
 * contract change and its own commit — and it must have a producer. A purpose
 * with nothing writing it is the empty-table mistake this repository already
 * refuses.
 *
 * Only `bot_instance.token` exists, because only `bot_instances.token_ciphertext`
 * exists. Provider, panel and gateway credentials belong to Phase 3 and are not
 * declared here in advance.
 */
export const SECRET_PURPOSES = ['bot_instance.token'] as const;
export type SecretPurpose = (typeof SECRET_PURPOSES)[number];

/**
 * `tenantId` is required. A system-scoped secret is not supported: encoding an
 * absent tenant as an empty string would collide with a future explicit
 * "no tenant" encoding, and an ambiguous authenticated field is not an
 * authenticated field. If one is ever needed it gets its own purpose and its
 * own sentinel, never a blank.
 *
 * `entityId` is the primary key of the row that owns the secret.
 */
export interface SecretContext {
  readonly purpose: SecretPurpose;
  readonly tenantId: string;
  readonly entityId: string;
}
