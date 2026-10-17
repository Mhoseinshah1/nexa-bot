import type { LoginFailureReason } from '@nexa/contracts';
import { t, type WebKey } from './i18n/web.fa';
import { errorCodeLabel } from './ops-code-labels';

/**
 * The machine reasons an audit row can carry (C1): the login failure reasons the identity
 * module records (`LOGIN_FAILURE_REASONS`), the second-factor enrolment's own, and the audit
 * export's row-limit refusal. Any other code reads by `errorCodeLabel` (a contract error code,
 * an operational, delivery or provider code), and a code nothing names is shown as itself.
 */
export const LOGIN_FAILURE_REASON_LABELS: Readonly<Record<LoginFailureReason, WebKey>> = {
  NO_SUCH_ADMIN: 'web.audit_reason_no_such_admin',
  BAD_PASSWORD: 'web.audit_reason_bad_password',
  ADMIN_DISABLED: 'web.audit_reason_admin_disabled',
  TENANT_INACTIVE: 'web.audit_reason_tenant_inactive',
  THROTTLED: 'web.audit_reason_throttled',
  BAD_SECOND_FACTOR: 'web.audit_reason_bad_second_factor',
  CHALLENGE_INVALID: 'web.audit_reason_challenge_invalid',
};

export const AUDIT_REASON_LABELS: Readonly<Record<string, WebKey>> = {
  ...LOGIN_FAILURE_REASON_LABELS,
  OTHER_SESSION: 'web.audit_reason_other_session',
  EXPORT_ROW_LIMIT_EXCEEDED: 'web.audit_reason_export_row_limit_exceeded',
};

/** `THROTTLED`, `auth.rate_limited`, `telegram.rejected.403`: a code, not a sentence. */
export function auditReasonCode(reason: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/u.test(reason) || /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u.test(reason);
}

/** A reason code's Persian name, or `null` when nothing names it (the code is shown). */
export function auditReasonLabel(code: string): string | null {
  const own = Object.prototype.hasOwnProperty.call(AUDIT_REASON_LABELS, code)
    ? AUDIT_REASON_LABELS[code]
    : undefined;
  if (own !== undefined) return t(own);
  const named = errorCodeLabel(code);
  return named === code ? null : named;
}
