import {
  errors,
  IDENTITY_ERROR_CODES,
  type ActorContext,
  type SecretPurpose,
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
