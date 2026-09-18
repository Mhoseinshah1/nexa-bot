import { PAYMENT_GATEWAY_PROVIDERS, type SecretCipher } from '@nexa/contracts';
import { AesGcmSecretCipher } from '../crypto/secret-cipher.js';
import { resolveKeyring } from '../crypto/resolve-keyring.js';
import { loadConfig } from '../config/load-config.js';
import { acceptsV1 } from '../config/config.schema.js';
import { createDatabase, type Database } from './database.js';
import { botInstances, paymentAccounts, paymentGateways, tenants } from './schema.js';

/**
 * Deterministic seed data.
 *
 * TWO tenants, each with two bot instances. Two is the important number: a
 * cross-tenant isolation test with one tenant seeded proves nothing, because
 * every query trivially returns only that tenant's rows.
 *
 * Ids are fixed so tests can assert against them and so local development and
 * CI see the same database.
 */

export const SEED_IDS = {
  tenantA: '01900000-0000-7000-8000-000000000001',
  tenantB: '01900000-0000-7000-8000-000000000002',
  tenantBReseller: '01900000-0000-7000-8000-000000000003',
  botA1: '01900000-0000-7000-8000-00000000a001',
  botA2: '01900000-0000-7000-8000-00000000a002',
  botB1: '01900000-0000-7000-8000-00000000b001',
  paymentAccountA: '01900000-0000-7000-8000-0000000000a1',
  paymentAccountB: '01900000-0000-7000-8000-0000000000b1',
} as const;

/**
 * Takes the cipher rather than key material.
 *
 * The seed has no business knowing how keys are configured, and once a keyring
 * replaced the single KEK the alternative was passing a keyring through ten
 * call sites that only ever wanted "encrypt this".
 */
export async function seed(db: Database, cipher: SecretCipher): Promise<void> {
  const encrypted = (token: string, tenantId: string, entityId: string) => {
    const secret = cipher.encrypt(token, {
      purpose: 'bot_instance.token',
      tenantId,
      entityId,
    });
    return { tokenCiphertext: secret.ciphertext, tokenKeyId: secret.keyId };
  };

  await db
    .insert(tenants)
    .values([
      {
        id: SEED_IDS.tenantA,
        kind: 'PRIMARY',
        parentTenantId: null,
        slug: 'acme',
        displayName: 'Acme Store',
        status: 'ACTIVE',
        locale: 'fa',
        displayTimezone: 'Asia/Tehran',
        calendar: 'jalali',
        currency: 'IRT',
      },
      {
        id: SEED_IDS.tenantB,
        // A RESELLER_BOT, not a second PRIMARY.
        //
        // An installation has exactly one primary tenant — it IS the
        // installation — and `tenants_single_primary_key` now enforces that.
        // Seeding two modelled a shape production cannot have, and the
        // isolation tests below are stronger for using the shape it does: a
        // reseller must not see the primary's rows, which is the boundary that
        // actually ships.
        kind: 'RESELLER_BOT',
        parentTenantId: SEED_IDS.tenantA,
        slug: 'globex',
        displayName: 'Globex Store',
        status: 'ACTIVE',
        locale: 'fa',
        displayTimezone: 'Asia/Tehran',
        calendar: 'jalali',
        currency: 'IRT',
      },
      // A reseller sales bot is its own tenant with a parent. Modelling it now
      // is what stops "is this setting per-bot or deployment-wide?" from
      // becoming unanswerable later.
      {
        id: SEED_IDS.tenantBReseller,
        kind: 'RESELLER_BOT',
        parentTenantId: SEED_IDS.tenantB,
        slug: 'globex-reseller-1',
        displayName: 'Globex Reseller One',
        status: 'ACTIVE',
        locale: 'fa',
        displayTimezone: 'Asia/Tehran',
        calendar: 'jalali',
        currency: 'IRT',
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(botInstances)
    .values([
      {
        id: SEED_IDS.botA1,
        tenantId: SEED_IDS.tenantA,
        username: 'acme_store_bot',
        status: 'ACTIVE',
        ...encrypted('000000:seed-token-acme-1', SEED_IDS.tenantA, SEED_IDS.botA1),
      },
      {
        id: SEED_IDS.botA2,
        tenantId: SEED_IDS.tenantA,
        username: 'acme_support_bot',
        status: 'STOPPED',
        ...encrypted('000000:seed-token-acme-2', SEED_IDS.tenantA, SEED_IDS.botA2),
      },
      {
        id: SEED_IDS.botB1,
        tenantId: SEED_IDS.tenantB,
        username: 'globex_store_bot',
        status: 'ACTIVE',
        ...encrypted('000000:seed-token-globex-1', SEED_IDS.tenantB, SEED_IDS.botB1),
      },
    ])
    .onConflictDoNothing();

  /*
   * One manual-transfer destination per tenant, enabled and default.
   *
   * Seeded because 5A makes a destination a PRECONDITION of an out-of-band payment: the
   * service refuses with `PAYMENT_DESTINATION_UNCONFIGURED` when a tenant has none, so a
   * seed without one leaves every manual-transfer path in the product unreachable in
   * development and in the integration suite.
   *
   * Both card numbers and Shebas are FABRICATED and satisfy their own check digits —
   * Luhn for the card, mod-97 for the Sheba — which is what lets the seed exercise the
   * real validation rather than a version of it with the checks turned off. Neither
   * addresses an account that exists anywhere.
   *
   * TWO tenants, because a cross-tenant test with one seeded destination proves nothing.
   */
  await db
    .insert(paymentAccounts)
    .values([
      {
        id: SEED_IDS.paymentAccountA,
        tenantId: SEED_IDS.tenantA,
        label: 'Acme Melli',
        bankName: 'بانک ملی ایران',
        holderName: 'Acme Store',
        cardNumber: '6037991234567893',
        iban: 'IR429600000001003242000012',
        enabled: true,
        isDefault: true,
        sortOrder: 0,
      },
      {
        id: SEED_IDS.paymentAccountB,
        tenantId: SEED_IDS.tenantB,
        label: 'Globex Saderat',
        bankName: 'بانک صادرات ایران',
        holderName: 'Globex Ltd',
        cardNumber: '6037991234567992',
        iban: null,
        enabled: true,
        isDefault: true,
        sortOrder: 0,
      },
    ])
    .onConflictDoNothing();

  /*
   * One payment ROUTE per tenant, exactly as provisioning writes it (Phase 5C).
   *
   * Seeded for the same reason the destination above is: 5C makes an ACTIVE, eligible
   * route a PRECONDITION of a wallet top-up, so a seed without one leaves that whole
   * path unreachable in development and refuses it in the integration suite.
   *
   * The ZERO row, and every field of it matters. `status` ACTIVE because the route is
   * how these tenants take money; no display name, because NULL means the product's own
   * name and a seed inventing customer-facing copy is the thing the migration's own
   * comment refuses; no bounds and no thresholds, because "no additional condition" is
   * what makes the seeded tenants exercise the ordinary path rather than a gated one.
   * A case that wants a gate sets it and says so.
   *
   * Written from `PAYMENT_GATEWAY_PROVIDERS` rather than listed, so a route added to the
   * catalogue is seeded without anybody remembering to come back here.
   *
   * TWO tenants, because a cross-tenant test with one seeded route proves nothing.
   */
  await db
    .insert(paymentGateways)
    .values(
      [SEED_IDS.tenantA, SEED_IDS.tenantB].flatMap((tenantId) =>
        PAYMENT_GATEWAY_PROVIDERS.map((provider) => ({
          tenantId,
          provider,
          status: 'ACTIVE' as const,
          // The seed writes no `sales.currency`, so the registry default is what these
          // bounds mean — the same answer 0078 gives an upgraded tenant with no row.
          boundsCurrency: 'IRT' as const,
        })),
      ),
    )
    .onConflictDoNothing();
}

async function main(): Promise<void> {
  const config = loadConfig();
  const handle = createDatabase(config.DATABASE_URL, 1);
  try {
    const keyring = resolveKeyring(config);
    await seed(handle.db, new AesGcmSecretCipher(keyring, acceptsV1(config, keyring)));
    console.warn('Seed applied.');
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
