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
  /*
   * The destination money arrives at, as its own pair rather than `settings.*`.
   *
   * Reuse was the first idea and it is wrong in both directions. `settings.edit` is
   * CRITICAL and owner-only, so reusing it would mean a finance operator cannot change
   * the card number customers are transferring to — a catalogue promising something the
   * seeded role cannot do, which is the defect migration 0055 exists to repair. And
   * `settings.view` is held by roles with no financial business, so reusing it would
   * widen who reads the destination at the same time.
   *
   * EDIT is CRITICAL and not HIGH. What it changes is where a customer's money goes, and
   * the blast radius of a wrong value is every transfer made until somebody notices —
   * the same reason `users.wallet.debit` sits there.
   */
  p('payments.accounts.view', 'View the configured manual-transfer accounts', 'LOW'),
  p('payments.accounts.edit', 'Add, edit, enable or disable a manual-transfer account', 'CRITICAL'),
  /*
   * The payment ROUTES, as their own pair rather than reusing the accounts pair.
   *
   * They are adjacent and they are not the same authority. `payments.accounts.edit`
   * changes where money goes; this changes WHETHER a route is offered, to whom, and
   * within what bounds — and the two have different blast radii in different directions.
   * A wrong account number misdirects transfers that are made; a wrong eligibility
   * threshold silently stops them being made at all, which nobody notices because
   * nothing fails.
   *
   * EDIT is HIGH rather than CRITICAL, and that is the one place these differ from the
   * accounts pair. Nothing here can send a customer's money somewhere else: the worst a
   * wrong value does is refuse a payment that should have been accepted, which is
   * recoverable by fixing the value. `payments.accounts.edit` is CRITICAL precisely
   * because its worst case is not.
   */
  p('payments.gateways.view', 'View the configured payment routes', 'LOW'),
  p('payments.gateways.edit', 'Configure, enable, disable or reorder a payment route', 'HIGH'),
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

  // Customer-facing text
  //
  // Separate from `settings.*` because the blast radii are not comparable: a
  // setting changes how the installation behaves for its operators, while a
  // template changes the words sent to every customer of the tenant. Separating
  // them also lets a role edit copy while holding no configuration access at
  // all. See docs/adr/0016-template-defaults-and-overrides.md, which also
  // records how to reverse this if the split turns out not to earn its keep.
  p('templates.view', 'View message templates and their overrides', 'LOW'),
  p('templates.edit', 'Change or revert a message template', 'HIGH'),

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

  // Backup and disaster recovery
  //
  // Four keys, at four risk levels, because the blast radii are not comparable
  // and a single `backup.*` permission would make the most dangerous operation
  // in the product reachable by anybody allowed to look at a list.
  //
  // `backup.download` is CRITICAL and not MEDIUM. The artifact is the whole
  // database — every tenant, every admin hash, every encrypted panel
  // credential — and it is encrypted under a KEK the installation holds, which
  // protects it at rest and not at all from somebody this permission hands it
  // to. Reading the backup LIST is an operational need; walking out with the
  // database is not the same act.
  //
  // `recovery.restore` is CRITICAL and covers the whole destructive chain: it is
  // what a typed confirmation is additionally required on top of, never
  // instead of. It does NOT cover upload-and-verify, which is deliberately
  // reachable with `backup.view` — proving an archive is sound changes nothing
  // about the installation, and an operator who cannot check their backups
  // without holding the power to overwrite production will not check them.
  p('backup.view', 'View backup history and recovery operations', 'LOW'),
  p('backup.run', 'Take a backup now', 'HIGH'),
  p('backup.download', 'Download an encrypted backup archive', 'CRITICAL'),
  p('recovery.restore', 'Restore this installation from a backup', 'CRITICAL'),

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
      'templates.view',
      'templates.edit',
      // Read only, and that is a narrowing rather than a grant. Until Phase 5 an
      // operator COULD change the card number, by editing the template body it was
      // typed into; the destination is data now, and `templates.edit` no longer
      // reaches it. What is left is the question they actually need answered —
      // which account is a customer being told to pay.
      'payments.accounts.view',
      /*
       * Which routes are offered is the other half of the same question an operator
       * fields all day — "why can this customer not pay" — and the answer is usually
       * an eligibility threshold rather than a broken card. Read only: changing who may
       * pay how is Finance's.
       */
      'payments.gateways.view',
      'reports.view',
      'opslog.view',
      // Whether this installation's backups are working is an operational
      // question, and an operator who cannot see the answer is an operator who
      // finds out during a disaster. Viewing is LOW; nothing else here is.
      'backup.view',
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
      // Finance is the role that owns where money arrives. Without the edit key the
      // only account holder able to change a blocked card would be the owner.
      'payments.accounts.view',
      'payments.accounts.edit',
      /*
       * And which routes are offered, on the same argument: Finance owns how money
       * arrives, and a route's amount bounds and eligibility thresholds are that
       * decision as much as the card number is. Without the edit key the only holder
       * able to switch a route off — after a bank blocks an account, say — is the owner.
       */
      'payments.gateways.view',
      'payments.gateways.edit',
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
      'backup.view',
      // Taking a backup is the one safe thing to do before touching anything,
      // and a technical role that cannot do it will touch things anyway.
      // Download and restore stay with the owner.
      'backup.run',
    ],
  },
  {
    key: 'receipt_reviewer',
    name: 'Receipt reviewer',
    /*
     * `payments.view` is here because the decision is made ON a payment.
     *
     * The role held `receipts.view` and `receipts.review` and could not open a single
     * payment: `PaymentService.get` charges `payments.view`, and so does the Web Admin
     * route that renders the detail. So the role named for reviewing receipts could
     * reach neither the approve form (since 4C) nor the reject form (4G) — a permission
     * catalogue promising something the seeded role cannot do, which is the legacy
     * defect this catalogue exists to end.
     *
     * `receipts.view` is not a substitute and was not widened into one. When this was
     * written it had no producer at all — `OQ-4C-03` recorded that no receipt file was
     * stored, archived or displayed anywhere — so the thing a reviewer read was the
     * payment, and granting the LOW read that names it was narrower than teaching the
     * payment read a second permission. 5R gives `receipts.view` its producer: the
     * routes that list one payment's receipts and stream one receipt's bytes charge it,
     * and nothing else does. Both keys still mean exactly what they say, and reading a
     * receipt remains separate from deciding on one.
     *
     * Found by the Codex review of PR #29. Migration 0055 carries it to installations
     * whose roles already exist, because `ensureSystemRoles` writes a seed's
     * permissions only when the role is created.
     */
    permissions: [
      'payments.view',
      'receipts.view',
      'receipts.review',
      // Reconciling a claimed transfer against a bank statement means knowing which
      // account it should have arrived in. The payment's own frozen snapshot answers
      // it for one payment; this answers it for the tenant.
      'payments.accounts.view',
    ],
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

/**
 * Permissions that cannot be held alone, and the permission each one needs.
 *
 * A key here is an ACTION whose holder must also be able to READ the thing the
 * action is performed on. Not a convenience and not a grouping: an action
 * permission without its read is a grant that authorises a request nobody can
 * reach, and the surface that offers it necessarily lies about one of the two.
 *
 * The catalogue has made this mistake once, and the repair it got is why this
 * table exists. The `receipt_reviewer` role held `receipts.review` and could not
 * open a single payment, because the decision is made ON a payment and
 * `payments.view` is what reads one — "a permission catalogue promising something
 * the seeded role cannot do, which is the legacy defect this catalogue exists to
 * end". That was repaired by editing the seed and backfilling it (migration
 * 0055), which repairs exactly the installations whose roles match the seed and
 * no others.
 *
 * The shapes a seed edit CANNOT reach are the ones this table is for: a custom
 * role, a GRANT override handing out the action alone, or a DENY override
 * subtracting the read from a role that has both. Only a rule applied at
 * RESOLUTION sees all three, and the notification lane, the request guard and the
 * Web Admin's rendered chrome all read the resolution.
 *
 * Adding a key here NARROWS what somebody holds; it can never widen it. That
 * direction is the whole design (see `resolveEffectivePermissions`), and it is
 * why this is safe to apply to permission sets that already exist. It also means
 * adding an entry is a real behaviour change for any installation already in the
 * incoherent state, so an entry belongs here only when holding the action without
 * the read is genuinely unusable rather than merely unusual.
 */
export const PERMISSION_REQUIRES: Readonly<Record<string, PermissionKey>> = {
  /*
   * Approving or rejecting a receipt is a decision made ON a payment, and the
   * reviewer needs the customer, the amount, the method and the destination it
   * should have arrived in — the payment detail, which is what `payments.view`
   * reads. `receipts.view` is not a substitute: it reads the FILE, and 5R gave it
   * its own producer precisely so that reading a receipt stayed separate from
   * deciding on one. A projection exposing the payment under the review key would
   * be the payment detail under another name, and a second read model for one
   * concept is the failure this codebase measures.
   */
  'receipts.review': 'payments.view' as PermissionKey,
};

/**
 * Resolution: effective = (role permissions ∪ GRANT overrides) − DENY overrides,
 * then MINUS every dependent permission whose prerequisite did not survive that.
 *
 * DENY always wins, anything not listed is denied, and the dependency pass only
 * ever removes. Those three together are what make this the single place the
 * question is answered: the request guard, the Web Admin's rendered chrome and
 * the notification lane's recipient list all read this function's output, so a
 * permission this drops is one no surface offers, no request accepts and no
 * message advertises. A check added to a role editor instead would bind only the
 * shapes that editor produced — not a DENY override, and not a row already in the
 * table.
 *
 * Dropping rather than refusing is deliberate. This runs on every request; the
 * caller is asking what an actor may do, and there is no answer to that question
 * that is safe to express as an exception. Fail closed, and let the coherence of
 * the GRANT be somebody's problem at the point it is written.
 *
 * One pass, not a fixpoint. `PERMISSION_REQUIRES` is asserted acyclic and only
 * one level deep by a unit test, so a second pass could not remove anything the
 * first did not — and a silent multi-level cascade is a worse thing to own than
 * the assertion.
 */
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
  for (const [dependent, prerequisite] of Object.entries(PERMISSION_REQUIRES)) {
    if (effective.has(dependent as PermissionKey) && !effective.has(prerequisite)) {
      effective.delete(dependent as PermissionKey);
    }
  }
  return effective;
}

/**
 * The permissions in `granted` that `PERMISSION_REQUIRES` would drop, and why.
 *
 * Written for whoever composes a permission set — a future role editor, and the
 * seed-coherence test that stops a seed shipping in this state. It answers the
 * question `resolveEffectivePermissions` deliberately refuses to raise, at the
 * point where raising it is useful: BEFORE the grant is stored, where there is
 * still somebody to tell.
 */
export function incoherentPermissionGrants(
  granted: readonly PermissionKey[],
): readonly { readonly permission: PermissionKey; readonly requires: PermissionKey }[] {
  const held = new Set<PermissionKey>(granted);
  const found: { permission: PermissionKey; requires: PermissionKey }[] = [];
  for (const [dependent, prerequisite] of Object.entries(PERMISSION_REQUIRES)) {
    const permission = dependent as PermissionKey;
    if (held.has(permission) && !held.has(prerequisite)) {
      found.push({ permission, requires: prerequisite });
    }
  }
  return found;
}
