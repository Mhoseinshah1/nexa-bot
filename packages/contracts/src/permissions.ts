/**
 * The permission catalog.
 *
 * Permissions are global and frozen: they are a contract, not tenant data.
 * Roles are tenant-scoped, mutable presets over this catalog — never an enum.
 *
 * The legacy system has four Telegram roles and seven Web roles for the same
 * column, similar names denoting different powers, no way to change a role at
 * all, and no audit of privilege changes. Every one of those follows from
 * modelling a role as an enum instead of as a composition of permissions.
 *
 * Phase 0 ships the catalog and the guard. Enforcement against real admins is
 * Phase 1; there is no authentication yet, by design.
 */

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface PermissionDefinition {
  readonly key: string;
  readonly resource: string;
  readonly action: string;
  readonly description: string;
  readonly riskLevel: RiskLevel;
}

function p(
  key: string,
  description: string,
  riskLevel: RiskLevel = 'MEDIUM',
): PermissionDefinition {
  const [resource = '', ...rest] = key.split('.');
  return { key, resource, action: rest.join('.'), description, riskLevel };
}

/**
 * Keys are `resource.action[.qualifier]`, lowercase, dot-separated.
 *
 * Deliberately separate keys exist where the blast radius differs: crediting a
 * wallet is not the same permission as crediting a large amount, and viewing a
 * report is not the same as viewing personal data inside it.
 */
export const PERMISSIONS = [
  // Users
  p('users.view', 'View customer accounts', 'LOW'),
  p('users.search', 'Search customers', 'LOW'),
  p('users.edit', 'Edit customer attributes'),
  p('users.block', 'Block or unblock a customer', 'HIGH'),
  p('users.tier.change', 'Change a customer tier', 'HIGH'),
  p('users.wallet.credit', 'Credit a customer wallet', 'HIGH'),
  p('users.wallet.credit.large', 'Credit a wallet above the large-amount threshold', 'CRITICAL'),
  p('users.wallet.debit', 'Debit a customer wallet', 'CRITICAL'),
  p('users.wallet.mass', 'Run a mass wallet operation', 'CRITICAL'),

  // Orders
  p('orders.view', 'View orders', 'LOW'),
  p('orders.cancel', 'Cancel an order', 'HIGH'),
  p('orders.manual.create', 'Create a manual order', 'HIGH'),

  // Payments, receipts, refunds — four separate concepts, four separate keys
  p('payments.view', 'View payments', 'LOW'),
  p('payments.retry', 'Retry a payment settlement'),
  p('receipts.view', 'View submitted receipts', 'LOW'),
  p('receipts.review', 'Approve or reject a receipt', 'HIGH'),
  p('refunds.view', 'View refunds', 'LOW'),
  p('refunds.issue', 'Issue a refund', 'CRITICAL'),

  // Services
  p('services.view', 'View provisioned services', 'LOW'),
  p('services.edit', 'Edit a service'),
  p('services.terminate', 'Terminate a service', 'HIGH'),
  p('services.transfer', 'Transfer a service to another customer', 'HIGH'),

  // Catalog
  p('catalog.view', 'View products and categories', 'LOW'),
  p('catalog.edit', 'Create or edit products and categories'),
  p('catalog.pricing.edit', 'Edit pricing rules', 'HIGH'),
  p('catalog.discounts.edit', 'Create or edit discount codes', 'HIGH'),

  // Panels and providers
  p('panels.view', 'View provider panels', 'LOW'),
  p('panels.edit', 'Create or edit provider panels', 'HIGH'),
  p('panels.credentials.rotate', 'Rotate panel credentials', 'CRITICAL'),

  // Resellers
  p('resellers.view', 'View resellers', 'LOW'),
  p('resellers.edit', 'Edit reseller entitlements', 'HIGH'),

  // Settings
  p('settings.view', 'View settings and their resolved values', 'LOW'),
  p('settings.edit', 'Change settings'),
  p('settings.destructive', 'Run destructive maintenance settings', 'CRITICAL'),

  // Administration
  p('admins.view', 'View administrators', 'LOW'),
  p('admins.edit', 'Create, suspend or revoke administrators', 'CRITICAL'),
  p('admins.permissions.edit', 'Grant or deny individual permissions', 'CRITICAL'),

  // Broadcasts
  p('broadcasts.send', 'Send a broadcast to customers', 'HIGH'),

  // Reporting and logs
  p('reports.view', 'View reports', 'LOW'),
  p('reports.pii.view', 'View personal data inside reports', 'HIGH'),
  p('reports.export', 'Export report data'),
  p('audit.view', 'View the audit log', 'LOW'),
  p('opslog.view', 'View operational events', 'LOW'),

  // Platform
  p('tenant.cross_read', 'Read data across tenants', 'CRITICAL'),
  p('maintenance.run', 'Run maintenance operations', 'CRITICAL'),
] as const satisfies readonly PermissionDefinition[];

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map(
  (definition) => definition.key as PermissionKey,
);

const PERMISSION_BY_KEY = new Map<string, PermissionDefinition>(
  PERMISSIONS.map((definition) => [definition.key, definition]),
);

export function permissionDefinition(key: PermissionKey): PermissionDefinition {
  const found = PERMISSION_BY_KEY.get(key);
  if (!found) {
    throw new Error(`Unknown permission key: ${key}. Permissions are a frozen contract.`);
  }
  return found;
}

export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_BY_KEY.has(value);
}

/**
 * Seeded role presets.
 *
 * These reproduce the operational shape the legacy Web Admin exposed, so day-one
 * operation feels familiar, while the model underneath is a composition of
 * permissions that can actually be edited, suspended and audited.
 */
export interface RoleSeed {
  readonly key: string;
  readonly name: string;
  readonly permissions: readonly PermissionKey[];
}

const ALL: readonly PermissionKey[] = PERMISSION_KEYS;
const READ_ONLY = PERMISSIONS.filter((d) => d.riskLevel === 'LOW').map(
  (d) => d.key as PermissionKey,
);

export const ROLE_SEEDS: readonly RoleSeed[] = [
  { key: 'owner', name: 'Owner', permissions: ALL },
  {
    key: 'operator',
    name: 'Operator',
    permissions: [
      'users.view',
      'users.search',
      'users.edit',
      'users.block',
      'orders.view',
      'services.view',
      'services.edit',
      'catalog.view',
      'panels.view',
      'settings.view',
      'reports.view',
      'opslog.view',
    ],
  },
  {
    key: 'finance',
    name: 'Finance',
    permissions: [
      'users.view',
      'users.search',
      'users.wallet.credit',
      'orders.view',
      'payments.view',
      'payments.retry',
      'receipts.view',
      'receipts.review',
      'refunds.view',
      'refunds.issue',
      'reports.view',
      'reports.export',
      'audit.view',
    ],
  },
  {
    key: 'support',
    name: 'Support',
    permissions: [
      'users.view',
      'users.search',
      'orders.view',
      'services.view',
      'services.edit',
      'receipts.view',
      'reports.view',
    ],
  },
  {
    key: 'sales',
    name: 'Sales',
    permissions: [
      'users.view',
      'users.search',
      'orders.view',
      'orders.manual.create',
      'catalog.view',
      'catalog.discounts.edit',
      'reports.view',
    ],
  },
  {
    key: 'technical',
    name: 'Technical',
    permissions: [
      'panels.view',
      'panels.edit',
      'services.view',
      'services.edit',
      'settings.view',
      'opslog.view',
    ],
  },
  {
    key: 'receipt_reviewer',
    name: 'Receipt reviewer',
    permissions: ['receipts.view', 'receipts.review'],
  },
  { key: 'observer', name: 'Observer', permissions: READ_ONLY },
];

/**
 * What background work may do.
 *
 * Jobs used to bypass the permission guard entirely, on the reasoning that they
 * are "our own code". That reasoning does not survive contact with a surface
 * that can construct a `SYSTEM_JOB` actor — and one did. Deny-by-default now
 * applies to every actor type without exception; jobs simply hold an explicit,
 * narrow, auditable set.
 *
 * Adding a key here is a contract change. It should be rare, and it should be
 * obvious in a diff that background work gained a new power.
 */
export const SYSTEM_JOB_PERMISSIONS = [
  'maintenance.run',
] as const satisfies readonly PermissionKey[];

/**
 * Resolution: effective = (role permissions ∪ GRANT overrides) − DENY overrides.
 * DENY always wins, and anything not listed is denied.
 */
export const PERMISSION_OVERRIDE_EFFECTS = ['GRANT', 'DENY'] as const;
export type PermissionOverrideEffect = (typeof PERMISSION_OVERRIDE_EFFECTS)[number];

export interface PermissionOverride {
  readonly permissionKey: PermissionKey;
  readonly effect: PermissionOverrideEffect;
  readonly reason: string;
  readonly expiresAt: Date | null;
}

export function resolveEffectivePermissions(
  rolePermissions: readonly PermissionKey[],
  overrides: readonly PermissionOverride[],
  now: Date,
): ReadonlySet<PermissionKey> {
  const active = overrides.filter(
    (o) => o.expiresAt === null || o.expiresAt.getTime() > now.getTime(),
  );
  const effective = new Set<PermissionKey>(rolePermissions);
  for (const override of active) {
    if (override.effect === 'GRANT') effective.add(override.permissionKey);
  }
  for (const override of active) {
    if (override.effect === 'DENY') effective.delete(override.permissionKey);
  }
  return effective;
}
