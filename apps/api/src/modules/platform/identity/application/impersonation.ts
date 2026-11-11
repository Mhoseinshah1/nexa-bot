import {
  errors,
  IDENTITY_ERROR_CODES,
  type ActorContext,
  type SecretPurpose,
  type TenantContext,
} from '@nexa/contracts';

/**
 * Phase 6B «ورود به پنل» (D5, ADR-0039 § 9 refinement 3): what an ENTERED session — the
 * installation owner acting inside a hosted tenant as its HOST principal — may never do,
 * whatever permission it holds.
 *
 * A permission cannot say it: the bot token is sealed under `settings.edit`, a gateway key under
 * `payments.gateways.edit`, and the owner keeps those keys to run the bot. So every writer that
 * seals a NEW secret value calls `refuseImpersonatedSecretWrite` itself, naming its purpose,
 * before it seals anything. `tests/unit/impersonation-secret-writers.test.ts` walks
 * `SECRET_COLUMNS` and fails when a purpose has no writer that refuses, so a future secret
 * column cannot be added without deciding this.
 */
export function refuseImpersonatedSecretWrite(actor: ActorContext, purpose: SecretPurpose): void {
  if (actor.impersonation === undefined) return;
  throw errors.permissionDenied(
    IDENTITY_ERROR_CODES.IMPERSONATION_FORBIDDEN,
    'An entered session cannot set or change this bot’s secrets or credentials.',
    { purpose },
  );
}

/**
 * The same refusal for an account's own security (password, second factor, its sessions): the
 * HOST principal has no password and no factor, and an entered session is not the place to
 * give it one.
 */
export function refuseImpersonatedAccountChange(actor: ActorContext, action: string): void {
  if (actor.impersonation === undefined) return;
  throw errors.permissionDenied(
    IDENTITY_ERROR_CODES.IMPERSONATION_FORBIDDEN,
    'An entered session cannot change account security.',
    { action },
  );
}

/**
 * The same refusal for a HOST action that has its own fresh-code door in «میزبانی‌ها» (the bulk
 * data export): the hosted owner's own door for it is not open to an entered session.
 */
export function refuseImpersonatedHostAction(actor: ActorContext, action: string): void {
  if (actor.impersonation === undefined) return;
  throw errors.permissionDenied(
    IDENTITY_ERROR_CODES.IMPERSONATION_FORBIDDEN,
    'An entered session cannot use this action; it is the host’s, behind a fresh code.',
    { action },
  );
}

/**
 * PR-N N3: what an export's audit row adds when an ENTERED session takes it. The owner keeps
 * the exports (`gift_cards.export`, plaintext codes; `audit.export`) inside «ورود به پنل», and
 * the audit writer already puts their row in HIS log with the hosted tenant as
 * `acted_in_tenant_id` (nothing in the hosted tenant's). His audit page and its CSV do not show
 * that column, so the row also names the hosted bot here, in `after`. Ids only. A session that
 * is not entered gets nothing: its row stays exactly what it was.
 */
export function enteredExportTrace(
  scope: TenantContext,
  actor: ActorContext,
): { readonly hostedTenantId?: string } {
  return actor.impersonation === undefined ? {} : { hostedTenantId: scope.tenantId };
}
