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
 * Panel credentials are three purposes rather than one `panel.secret`, and the
 * distinction is cryptographic rather than tidy. All three live on one row, so
 * tenant and entity are identical across them and the PURPOSE is the only thing
 * separating their associated data. Collapse them and a password ciphertext
 * moved into the username column decrypts perfectly well — which is exactly the
 * transplant the v2 envelope exists to refuse.
 *
 * `payment_gateway.api_key` is an external payment gateway's API key (WP11A,
 * TonPays), one per `(tenant, provider)` in `payment_gateway_credentials`. Declared
 * in the commit that brings its producer, never before: a purpose with nothing
 * writing it is the empty-table mistake `tests/unit/secret-registry.test.ts` refuses.
 *
 * `payment_gateway.webhook_secret` is the second secret of a route whose provider SIGNS
 * its webhooks (NOWPayments' IPN secret, `docs/nowpayments-gateway-audit.md`), on the
 * same `payment_gateway_credentials` row as the key. Its own purpose for the reason the
 * panel credentials have three: the key's ciphertext moved into this column must not
 * decrypt as the secret.
 *
 * `payment_gateway.verify_key` is the second key of a route whose provider authorises its
 * INQUIRY with a separate credential (CentralPay's verify key, `docs/centralpay-gateway-
 * audit.md`), on the same row, under its own purpose for the same reason.
 *
 * `payment_gateway.refund_card` is the card number and holder a customer typed for a REFUND
 * of an overpayment (Round 6, `gateway_provider_requests`), sealed only between the tap and the
 * gateway worker's send stamp, which wipes it. The entity is the request row's own id, so a
 * sealed card moved onto another request — or another tenant's — fails authentication. After the
 * stamp the only stored form is the masked one. Declared in the commit that brings its producer.
 *
 * `admin.totp_secret` is an administrator's RFC 6238 shared secret (Phase D2,
 * `admin_totp_factors`). The entity is the factor row's own id, so a secret moved onto
 * another administrator's row — or kept across a disable and a re-enrolment, which
 * mints a new row — recomputes a different context and fails authentication.
 */
/*
 * `support_ai_provider.api_key` is a tenant's key for one AI provider (TB4, ADR-0034 §8), on
 * its `support_ai_provider_credentials` row; the entity is that row's id, so a key moved onto
 * another provider's row — or another tenant's — fails authentication.
 *
 * `legacy_migration.package_key` is the key (or passphrase) of one uploaded Mirza `.nxpkg`
 * package, on its `legacy_nxpkg_imports` row (`docs/legacy-migration/nxpkg-importer.md` §0.6);
 * the entity is that row's id, and the column is set to NULL when the import is terminal.
 *
 * `backup.archive_password` is the owner-set password that seals a 7-Zip backup archive
 * (Round 4 PR-E, E4), on its `backup_archive_passwords` row; the entity is that row's id.
 * Never returned by any response once stored.
 *
 * `gift_card.batch_export` is the plaintext codes of one gift card batch (R10 D4), sealed at the
 * batch's creation on its `gift_card_batches` row so the operator can download them for 24 hours;
 * the entity is the batch row's id, so an export moved onto another batch — or another tenant's —
 * fails authentication. The worker purges it (both columns NULL) once the window passes, after
 * which the codes exist only as hashes.
 */
export const SECRET_PURPOSES = [
  'bot_instance.token',
  'panel.username',
  'panel.password',
  'panel.api_token',
  'payment_gateway.api_key',
  'payment_gateway.webhook_secret',
  'payment_gateway.verify_key',
  'payment_gateway.refund_card',
  'admin.totp_secret',
  'support_ai_provider.api_key',
  'legacy_migration.package_key',
  'backup.archive_password',
  'gift_card.batch_export',
] as const;
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
