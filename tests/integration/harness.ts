import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { isProviderType } from '@nexa/contracts';
import type {
  ActorContext,
  AdminId,
  CorrelationId,
  ProviderConnectionAdapter,
  ProviderType,
  RoleId,
  TenantContext,
} from '@nexa/contracts';
import { connectionIdentityOf } from '../../apps/api/src/modules/platform/panels/application/panel-eligibility';
import { DrizzlePanelRepository } from '../../apps/api/src/modules/platform/panels/infrastructure/drizzle-panel.repository';
import { providerAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/adapter-registry';
import { createContainer, type Container } from '../../apps/api/src/container';
import { loadConfig } from '../../apps/api/src/infrastructure/config/load-config';
import type { AppConfig } from '../../apps/api/src/infrastructure/config/config.schema';
import { runMigrations } from '../../apps/api/src/infrastructure/persistence/migrate';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import type { Database } from '../../apps/api/src/infrastructure/persistence/database';

/**
 * Integration tests run against a real PostgreSQL and a real Redis.
 *
 * There is no mocked database anywhere in this suite, deliberately: the
 * invariants being tested live IN the database — CHECK constraints, unique
 * partial indexes, append-only triggers, FOR UPDATE SKIP LOCKED semantics — and
 * a mock cannot express any of them.
 *
 * Connection details come from the environment when it supplies them, so the
 * same suite runs against `docker compose up` locally, against natively started
 * services in a cloud session, and against service containers in CI.
 */

export const TEST_KEK = randomBytes(32).toString('base64');

export function testConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'development',
    LOG_LEVEL: 'error',
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgres://nexa:nexa@127.0.0.1:5432/nexa_test',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    SECRETS_KEK: TEST_KEK,
    SECRETS_KEK_ID: 'test-1',
    AUTH_MODE: 'password',
    // Real scrypt, weak parameters. The suite hashes on nearly every test; at
    // production cost it would spend minutes doing nothing else. Production is
    // forbidden this value by the config schema, and a unit test hashes at
    // production strength so the real parameters are still exercised.
    PASSWORD_HASH_PROFILE: 'fast',
    // The suite drives the app directly, with no proxy in front of it. Stated
    // explicitly, because an empty trusted list now means something specific.
    DEPLOYMENT_TOPOLOGY: 'direct',
    OUTBOX_RELAY_ENABLED: 'false',
    OUTBOX_RELAY_POLL_INTERVAL_MS: '50',
    ...overrides,
  });
}

let migrated = false;

export async function migrateOnce(databaseUrl: string): Promise<void> {
  if (migrated) return;
  await runMigrations(databaseUrl);
  migrated = true;
}

/**
 * Truncates every table between tests.
 *
 * `audit_logs`, `processed_messages`, `template_revisions` and
 * `notification_delivery_attempts` refuse DELETE by trigger, which is the point
 * of them — TRUNCATE bypasses row triggers, so the guard stays in force for
 * application code while tests can still reset.
 */
export async function resetDatabase(db: Database): Promise<void> {
  await db.execute(
    `TRUNCATE TABLE
       audit_logs, operational_events, outbox_messages, processed_messages,
       request_idempotency, aggregate_sequences,
       notification_delivery_attempts, notification_released_claims, notifications,
       template_revisions, template_overrides, setting_values, feature_flag_states,
       admin_login_throttle, admin_sessions, admin_permission_overrides,
       admin_roles, role_permissions, roles, admins,
       panel_health, panel_probe_claims, panel_probe_budgets, panel_credentials,
       panel_capacity_reservations, panels,
       bot_instances, tenants,
       backup_runs, recovery_requests,
       -- The Phase 4 tables, listed EXPLICITLY rather than left to CASCADE.
       --
       -- The tenants table is in this list and every one of these references it, so
       -- CASCADE does reach them today. Named anyway: what gets truncated is the one
       -- thing that decides whether a suite sees another test's rows, and a table
       -- whose clearing depends on a foreign key somebody may later make nullable is
       -- a table that silently stops being cleared. CLAUDE.md records 122 false
       -- failures from two suites sharing one database; this is the cheap half of
       -- not repeating it.
       --
       -- No backticks in here: this statement is a plain template literal, so a
       -- backtick in a comment ends it and the parse error lands twenty lines away.
       -- Customer UX completion. Named before the tables they reference.
       customer_text_captures, referral_signup_gifts, support_faqs, support_faq_seeds,
       tenant_media_assets,
       wallet_entries, discount_redemptions, referrals, trial_grants, trial_resets,
       trial_limit_overrides, resellers,
       provisioning_operations, services, payments, orders, discounts, products,
       -- AFTER products, which reference it. Named for the same reason as the rest:
       -- the tenants table above does CASCADE to it today, and a table whose clearing
       -- depends on a foreign key somebody may later make nullable is a table that
       -- silently stops being cleared.
       --
       -- (No backticks. The warning twenty lines up is there because this is a plain
       -- template literal, and the first version of THIS comment ignored it.)
       product_categories,
       customers
     RESTART IDENTITY CASCADE` as never,
  );
}

/**
 * The seeded category belonging to the tenant a fixture is building for.
 *
 * A product's category must be its OWN tenant's — `products_tenant_category_fk` is a
 * composite key precisely so that it cannot be somebody else's — and the three
 * cross-tenant cases in `orders.test.ts` and `catalog.test.ts` are the ones that
 * noticed: they build a tenant B product, and a fixture hard-coding tenant A's category
 * made them fail on the foreign key rather than on the rule they exist to test.
 *
 * So the fixture asks which tenant it is in, exactly as production would.
 */
export function seededCategoryFor(scope: { readonly tenantId: unknown }): string {
  return scope.tenantId === SEED_IDS.tenantB ? SEED_IDS.categoryB : SEED_IDS.categoryA;
}

export interface TestContext {
  readonly container: Container;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestContext(
  overrides: Partial<NodeJS.ProcessEnv> = {},
): Promise<TestContext> {
  const config = testConfig(overrides);
  await migrateOnce(config.DATABASE_URL);

  const container = createContainer(config, 'worker');

  return {
    container,
    async reset() {
      // In-memory container state has to be reset too, not just the tables.
      // `installationTenantId` is set by `resolveInstallationTenant` at a process
      // boot and by `pointAtInstallation` in the backup CLI, and it outlived
      // `reset()` — so one case that resolved it left the next case's container
      // already pointed at a tenant, and a case asserting the unresolved STARTING
      // state failed depending on file order. Reset here rather than in the cases,
      // because a fixture a case has to remember to clean is one some case will not.
      container.setInstallationTenant(null);
      await resetDatabase(container.database.db);
      await seed(container.database.db, container.cipher);
    },
    async close() {
      await container.shutdown();
    },
  };
}

export { SEED_IDS };

export const tenantA = { tenantId: SEED_IDS.tenantA as never, botInstanceId: null };
export const tenantB = { tenantId: SEED_IDS.tenantB as never, botInstanceId: null };

// ---------------------------------------------------------------------------
// Identity fixtures
// ---------------------------------------------------------------------------

/**
 * Creates an administrator directly, bypassing the management service.
 *
 * Deliberate: a test that needs "an operator exists" should not have to first
 * authenticate an owner and call an endpoint, and the tests that DO exercise
 * the service must not have their subject created by it. Passwords go through
 * the real hasher, so nothing here stores a credential in a way production
 * would not.
 */
export interface SeededAdmin {
  readonly id: AdminId;
  readonly username: string;
  readonly password: string;
}

export async function createAdmin(
  container: Container,
  scope: TenantContext,
  options: {
    username: string;
    password?: string;
    roleKeys?: readonly string[];
    status?: 'ACTIVE' | 'DISABLED';
    displayName?: string;
    telegramUserId?: string | null;
  },
): Promise<SeededAdmin> {
  const password = options.password ?? 'a-perfectly-fine-password';
  const now = container.clock.now();
  const id = container.ids.uuid() as AdminId;

  await container.roles.ensureSystemRoles(scope);
  await container.admins.create(scope, {
    id,
    username: options.username,
    displayName: options.displayName ?? options.username,
    passwordHash: await container.hasher.hash(password),
    telegramUserId: options.telegramUserId ?? null,
    now,
  });

  const roleKeys = options.roleKeys ?? [];
  if (roleKeys.length > 0) {
    const { found, missing } = await container.roles.idsForKeys(scope, roleKeys);
    if (missing.length > 0) throw new Error(`Unknown seed role(s): ${missing.join(', ')}`);
    await container.roles.setAdminRoles(
      scope,
      id,
      roleKeys.map((key) => found.get(key) as RoleId),
      null,
    );
  }

  if (options.status === 'DISABLED') {
    await container.admins.setStatus(scope, id, 'DISABLED', now);
  }

  return { id, username: options.username, password };
}

/** The actor an authenticated administrator acts as in service-level tests. */
export function adminActorFor(admin: SeededAdmin): ActorContext {
  return {
    type: 'WEB_ADMIN',
    id: admin.id,
    label: admin.username,
    surface: 'WEB',
    correlationId: 'test-correlation' as CorrelationId,
  };
}

/**
 * A real provider adapter with some of its behaviour replaced.
 *
 * `Object.assign` onto the REAL instance, never `{ ...providerAdapter(type) }`,
 * and the difference is not stylistic. The adapters are classes, so `supports`,
 * and any other method declared on the class rather than assigned in its
 * constructor, lives on the PROTOTYPE — and object spread copies own enumerable
 * properties only. A spread therefore produced a stand-in that had silently lost
 * every prototype method, and passed for as long as nothing called one.
 *
 * It stopped passing the moment `attemptProbe` asked `supports('HEALTH_CHECK')`:
 * seventy-one monitor cases failed at once, on a production change that was
 * correct. That is the good version of this bug. The bad version is a test that
 * keeps passing while the production path it claims to cover has gone — which is
 * what a spread would do for any future method a test does not happen to
 * exercise.
 *
 * Assigning over a method shadows it with an own property, so an override still
 * wins; everything not named here is the real adapter's own behaviour.
 */
export function adapterWith(
  type: ProviderType,
  overrides: Partial<ProviderConnectionAdapter>,
): ProviderConnectionAdapter {
  return Object.assign(providerAdapter(type), overrides);
}

/**
 * Records a successful connection test against the panel's CURRENT identity,
 * without a socket.
 *
 * `setStatus` refuses `DISABLED -> ACTIVE` unless a recent probe vouches for
 * what the panel is now, which is the Phase 6B rule and the thing most of these
 * suites are not about. A test whose subject is the schedule, the health
 * projection or the operations log should not have to stand up a fake panel to
 * get past it.
 *
 * The identity comes from `connectionIdentityOf` — the PRODUCTION function the
 * prober uses — rather than a string assembled here. A hand-written digest would
 * be a second opinion about what a validation covers, and would go on passing
 * after the real one changed.
 *
 * It writes a HEALTHY row, which is also what a real successful probe writes.
 * Suites that are about the gate itself do not use this: they drive the real
 * probe, or they assert the refusal.
 */
export async function validatePanelConnection(
  container: Container,
  scope: TenantContext,
  panelId: string,
): Promise<void> {
  const repository = new DrizzlePanelRepository(container.database.db);
  const view = await repository.find(scope, panelId);
  if (view === null) throw new Error(`no panel ${panelId} to validate`);
  const identity = connectionIdentityOf({
    providerType: view.panel.providerType,
    baseUrl: view.panel.baseUrl,
    activation: view.panel.activation,
    usernameSetAt: view.credentials.usernameSetAt,
    passwordSetAt: view.credentials.passwordSetAt,
    apiTokenSetAt: view.credentials.apiTokenSetAt,
  });
  await container.uow.run(scope, (tx) =>
    repository.recordHealth(
      scope,
      panelId,
      {
        state: 'HEALTHY',
        checkedAt: container.clock.now(),
        latencyMs: 3,
        failure: null,
        statusCode: 200,
        providerVersion: null,
        lastHealthyAt: container.clock.now(),
      },
      identity,
      tx,
    ),
  );
}

/**
 * The activation each provider needs before a panel of that type may be sold.
 *
 * Built from `PANEL_ACTIVATION_SCHEMAS`'s own shapes rather than hand-written
 * JSON, so a provider whose required configuration changes breaks this map
 * instead of silently producing fixtures that the sale evaluator will refuse.
 * `rickpanel` gets `{}` because it genuinely needs nothing — see
 * `docs/rickpanel-adapter-audit.md`.
 */
const SELLABLE_ACTIVATION: Readonly<Record<ProviderType, unknown>> = {
  marzban: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS_TCP'] } },
  rickpanel: {},
  sanaei: { subscriptionDomain: 'sub.example.test', inboundId: 1 },
};

/**
 * A fixture panel that could actually deliver what it is sold for.
 *
 * ## Why this exists
 *
 * Most suites create a panel with a raw `INSERT INTO panels`, because their
 * subject is an order, a payment or a reminder rather than a panel. Until this
 * hotfix that was harmless: `decideEligibility` asked about status, health and
 * capacity, and a bare row passed all three.
 *
 * It no longer does, and that is the fix. A row with no credentials, no
 * activation and no probe is a panel that cannot create an account — which is
 * exactly the shape of the production panel behind order `01a0c54b`, and the
 * catalogue must now refuse it. A fixture describing such a panel and expecting
 * a sale to succeed is a fixture describing the bug.
 *
 * So this makes the fixture TRUE rather than making the rule lenient: it sets
 * the credential timestamps the provider's shape requires, writes an activation
 * that parses against that provider's own schema, and records a successful
 * connection test bound to the identity all of that produces.
 *
 * It writes CIPHERTEXT placeholders and not real secrets. Nothing here dials a
 * panel: `decideEligibility` reads only the three set-at timestamps, which is
 * the whole point of the repository projection never selecting a ciphertext.
 * A suite that actually connects builds its panel through `PanelService`.
 */
export async function makePanelSellable(
  container: Container,
  scope: TenantContext,
  panelId: string,
): Promise<void> {
  const db = container.database.db;
  const rows = await db.execute<{ provider_type: string }>(
    sql`SELECT provider_type FROM panels WHERE id = ${panelId} AND tenant_id = ${scope.tenantId}`,
  );
  const providerType = rows.rows[0]?.provider_type;
  if (providerType === undefined) throw new Error(`no panel ${panelId} to make sellable`);
  if (!isProviderType(providerType)) {
    throw new Error(`panel ${panelId} names a provider this release does not know`);
  }

  await db.execute(sql`
    UPDATE panels SET activation = ${JSON.stringify(SELLABLE_ACTIVATION[providerType])}::jsonb
    WHERE id = ${panelId} AND tenant_id = ${scope.tenantId}`);

  /*
   * Both timestamps, whatever the provider's shape asks for. Setting only the
   * two `USERNAME_PASSWORD` needs would leave a `TOKEN_OR_USERNAME_PASSWORD`
   * provider satisfied by accident rather than on purpose, and the next provider
   * added would inherit the accident.
   */
  await db.execute(sql`
    INSERT INTO panel_credentials (
      panel_id, tenant_id,
      username_ciphertext, username_key_id, username_set_at,
      password_ciphertext, password_key_id, password_set_at,
      api_token_ciphertext, api_token_key_id, api_token_set_at)
    VALUES (
      ${panelId}, ${scope.tenantId},
      'fixture-not-a-real-ciphertext', 'fixture', now(),
      'fixture-not-a-real-ciphertext', 'fixture', now(),
      'fixture-not-a-real-ciphertext', 'fixture', now())
    ON CONFLICT (panel_id) DO UPDATE SET
      username_set_at = now(), password_set_at = now(), api_token_set_at = now()`);

  // LAST, and it has to be: the identity a probe validates covers the activation
  // and the three timestamps, so a validation recorded before them would be
  // stale the moment they were written — which is the rule this hotfix adds.
  await validatePanelConnection(container, scope, panelId);
}
