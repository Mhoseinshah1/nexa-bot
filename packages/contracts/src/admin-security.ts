import { z } from 'zod';
import { AUDIT_RESULTS } from './ports.js';
import { adminChangeReasonSchema } from './identity.js';
import { adminSummarySchema, loginResponseSchema } from './http.js';

/**
 * Admin security (program §17, Phase D2): a second factor for the Web Admin, the
 * administrator's own sessions, and their own sign-in history.
 *
 * ## The second factor
 *
 * TOTP per RFC 6238 with the parameters every mainstream authenticator assumes —
 * HMAC-SHA-1, six digits, thirty-second steps. Choosing anything else (SHA-256, eight
 * digits) is allowed by the RFC and silently ignored by several popular apps, which then
 * display codes the server never accepts: an administrator locked out by a parameter the
 * enrolment screen did not mention. Compatibility is the security property here.
 *
 * The shared secret is stored ENCRYPTED, through the installation's one `SecretCipher`
 * under its own purpose (`admin.totp_secret`). It is shown exactly once, at enrolment,
 * and never again — a lost device is answered by disabling and enrolling again, or by
 * the owner-recovery path, never by reading the secret back.
 *
 * A code is accepted at most ONCE: the factor remembers the last step it accepted and
 * refuses that step and every earlier one. A code read over a shoulder, or replayed from
 * a captured request, buys nothing after the person it belonged to has used it.
 *
 * ## Backup codes
 *
 * Ten one-time codes, generated at activation and on request, displayed once, stored as
 * hashes only. Regenerating INVALIDATES the previous set in the same transaction that
 * writes the new one, so there is never a moment with two valid sets.
 *
 * ## Sign-in
 *
 * A correct password for an account with an active factor does NOT mint a session. It
 * mints a short-lived, single-use login CHALLENGE (an httpOnly cookie, like the session),
 * and only a valid code presented against that challenge mints the session. Every second-
 * factor guess is counted on the SAME credential throttle a password guess is, so a
 * stolen password does not become an unthrottled guessing oracle for six digits.
 */

/** RFC 6238 parameters. Fixed: see the module note on why they are not configurable. */
export const TOTP_PARAMETERS = {
  algorithm: 'SHA1',
  digits: 6,
  periodSeconds: 30,
  /** 160 bits, RFC 4226 §4's recommended shared-secret length. */
  secretBytes: 20,
  /**
   * Steps accepted either side of now. One step is ±30 seconds of clock drift between a
   * phone and the server — the conventional allowance, and the smallest that survives a
   * code typed in the last second of its step.
   */
  skewSteps: 1,
} as const;

/** The issuer an authenticator app shows beside the account. A label, not a secret. */
export const TOTP_ISSUER = 'Nexa';

/** How many backup codes one generation produces. */
export const BACKUP_CODE_COUNT = 10;

/**
 * How long a pending enrolment may wait for its first code. Past this the secret that
 * was displayed is discarded and enrolment starts again, so a QR code left on a screen
 * does not stay activatable indefinitely.
 */
export const TOTP_ENROLMENT_TTL_SECONDS = 900;

/** How long a password-verified login waits for its second factor. */
export const LOGIN_CHALLENGE_TTL_SECONDS = 300;

/**
 * Guesses one challenge allows before it is spent. The credential throttle bounds the
 * account overall; this bounds one challenge, so a captured challenge cookie is worth
 * five guesses and not the throttle's whole allowance.
 */
export const LOGIN_CHALLENGE_MAX_ATTEMPTS = 5;

/** The challenge cookie, in the same two spellings as the session cookie. */
export const SECOND_FACTOR_COOKIE_NAME = 'nexa_admin_2fa';
export const SECOND_FACTOR_COOKIE_NAME_SECURE = `__Host-${SECOND_FACTOR_COOKIE_NAME}` as const;

export const TOTP_FACTOR_STATES = ['DISABLED', 'PENDING', 'ACTIVE'] as const;
export type TotpFactorState = (typeof TOTP_FACTOR_STATES)[number];

/** What a second-factor proof was. Recorded in the audit row; never the value. */
export const SECOND_FACTOR_METHODS = ['TOTP', 'BACKUP_CODE'] as const;
export type SecondFactorMethod = (typeof SECOND_FACTOR_METHODS)[number];

export const totpCodeSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^[0-9]{6}$/));

/** A backup code as typed: separators and case are forgiven server-side. */
export const backupCodeSchema = z.string().trim().min(8).max(64);

/**
 * One proof of the second factor: a current TOTP code OR an unused backup code, never
 * both and never neither. Two fields rather than one, so the server never has to guess
 * which kind of string it was given.
 */
export const secondFactorProofSchema = z
  .object({
    code: totpCodeSchema.optional(),
    backupCode: backupCodeSchema.optional(),
  })
  .refine((value) => (value.code === undefined) !== (value.backupCode === undefined), {
    message: 'Provide exactly one of code or backupCode.',
  });
export type SecondFactorProof = z.infer<typeof secondFactorProofSchema>;

/** The login response when a second factor is still owed. No session, no token. */
export const secondFactorChallengeResponseSchema = z.object({
  secondFactorRequired: z.literal(true),
  expiresAt: z.string(),
});
export type SecondFactorChallengeResponse = z.infer<typeof secondFactorChallengeResponseSchema>;

/** What `POST /auth/login` can answer with. */
export const loginOutcomeResponseSchema = z.union([
  secondFactorChallengeResponseSchema,
  loginResponseSchema,
]);
export type LoginOutcomeResponse = z.infer<typeof loginOutcomeResponseSchema>;

const nullableTimestamp = z.string().nullable();

export const accountSecurityResponseSchema = z.object({
  totp: z.object({
    state: z.enum(TOTP_FACTOR_STATES),
    activatedAt: nullableTimestamp,
  }),
  backupCodes: z.object({
    /** Unused codes of the current generation. Zero when the factor is off. */
    remaining: z.number().int().nonnegative(),
    generatedAt: nullableTimestamp,
  }),
});
export type AccountSecurityResponse = z.infer<typeof accountSecurityResponseSchema>;

/** Enrolment starts with the password: a stolen session must not be able to enrol. */
export const totpEnrolRequestSchema = z.object({ password: z.string().min(1).max(1024) });

/**
 * The secret, exactly once. `qrPngDataUrl` is the same `otpauth://` URI as a PNG; it is
 * null only when the URI cannot be encoded, and the manual secret always works.
 */
export const totpEnrolResponseSchema = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
  qrPngDataUrl: z.string().nullable(),
  expiresAt: z.string(),
  parameters: z.object({
    algorithm: z.literal(TOTP_PARAMETERS.algorithm),
    digits: z.literal(TOTP_PARAMETERS.digits),
    periodSeconds: z.literal(TOTP_PARAMETERS.periodSeconds),
  }),
});
export type TotpEnrolResponse = z.infer<typeof totpEnrolResponseSchema>;

export const totpActivateRequestSchema = z.object({ code: totpCodeSchema });

/** A fresh set of backup codes, displayed once. */
export const backupCodesResponseSchema = z.object({
  backupCodes: z.array(z.string()).length(BACKUP_CODE_COUNT),
});
export type BackupCodesResponse = z.infer<typeof backupCodesResponseSchema>;

/**
 * Disabling, and regenerating backup codes, each need BOTH the password and a second
 * factor: either alone is what somebody holding half of the account would have.
 */
export const reauthenticateWithSecondFactorSchema = z
  .object({
    password: z.string().min(1).max(1024),
    code: totpCodeSchema.optional(),
    backupCode: backupCodeSchema.optional(),
  })
  .refine((value) => (value.code === undefined) !== (value.backupCode === undefined), {
    message: 'Provide exactly one of code or backupCode.',
  });
export type ReauthenticateWithSecondFactor = z.infer<typeof reauthenticateWithSecondFactorSchema>;

export const okResponseSchema = z.object({ ok: z.literal(true) });

/** Revoking one of one's own sessions. `false` when it had already ended. */
export const revokeOwnSessionResponseSchema = z.object({
  revoked: z.boolean(),
  /** True when the session revoked was the one making the request. */
  current: z.boolean(),
});
export type RevokeOwnSessionResponse = z.infer<typeof revokeOwnSessionResponseSchema>;

export const revokeOtherSessionsResponseSchema = z.object({
  revoked: z.number().int().nonnegative(),
});
export type RevokeOtherSessionsResponse = z.infer<typeof revokeOtherSessionsResponseSchema>;

/**
 * The audit actions an administrator's own security history shows. A closed list: the
 * reader filters on it in SQL, and a surface labels each one.
 */
export const SECURITY_EVENT_ACTIONS = [
  'auth.login',
  'auth.login_challenge',
  'auth.second_factor',
  'auth.logout',
  'auth.session_revoke',
  'auth.sessions_revoke_others',
  'admin.password_change',
  'admin.password_reset',
  'admin.sessions_revoked',
  'admin.totp_enrol',
  'admin.totp_enable',
  'admin.totp_disable',
  'admin.totp_reset',
  'admin.backup_codes_regenerate',
] as const;
export type SecurityEventAction = (typeof SECURITY_EVENT_ACTIONS)[number];

/**
 * One row of the history. The IP and user agent are the account holder's OWN — shown to
 * them so they can recognise a sign-in that was not theirs — and nothing else from the
 * row: no `before`/`after` beyond the two machine words below.
 */
export const securityEventSchema = z.object({
  id: z.string(),
  action: z.enum(SECURITY_EVENT_ACTIONS),
  result: z.enum(AUDIT_RESULTS),
  occurredAt: z.string(),
  /** Who did it, when it was not the account holder (an operator, the recovery CLI). */
  actorLabel: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** A machine reason code from the row (`BAD_PASSWORD`, `REPLAYED`…), when it has one. */
  reason: z.string().nullable(),
  method: z.enum(SECOND_FACTOR_METHODS).nullable(),
});
export type SecurityEvent = z.infer<typeof securityEventSchema>;

export const securityEventListResponseSchema = z.object({ events: z.array(securityEventSchema) });
export type SecurityEventListResponse = z.infer<typeof securityEventListResponseSchema>;

/**
 * An operator removing ANOTHER administrator's second factor — the in-product answer to
 * "they lost their phone". Bound exactly like an operator password reset: `admins.edit`,
 * not oneself, no more privilege than the actor holds, and an owner target needs
 * `admins.permissions.edit`. Every session of the target ends.
 */
export const resetAdminSecondFactorRequestSchema = z.object({ reason: adminChangeReasonSchema });
export const resetAdminSecondFactorResponseSchema = z.object({
  admin: adminSummarySchema,
  /** False when the target had no factor; the call still ends their sessions. */
  hadSecondFactor: z.boolean(),
  sessionsRevoked: z.number().int().nonnegative(),
});
export type ResetAdminSecondFactorResponse = z.infer<typeof resetAdminSecondFactorResponseSchema>;

/** Routes, relative to `API_PREFIX`. */
export const ACCOUNT_SECURITY_ROUTES = {
  loginSecondFactor: '/auth/login/second-factor',
  overview: '/auth/security',
  totpEnrol: '/auth/security/totp/enrol',
  totpActivate: '/auth/security/totp/activate',
  totpDisable: '/auth/security/totp/disable',
  backupCodesRegenerate: '/auth/security/backup-codes/regenerate',
  events: '/auth/security/events',
  sessions: '/auth/sessions',
  revokeSession: (id: string) => `/auth/sessions/${encodeURIComponent(id)}/revoke`,
  revokeOtherSessions: '/auth/sessions/revoke-others',
  adminSecondFactorReset: (id: string) => `/admins/${encodeURIComponent(id)}/second-factor/reset`,
} as const;
