import { createHash } from 'node:crypto';
import type {
  AdminId,
  SecondFactorMethod,
  SecretCipher,
  SecretContext,
  TenantContext,
} from '@nexa/contracts';
import type { SecondFactorRepository, StoredTotpFactor } from './ports.js';
import { matchTotp } from './totp.js';
import { hashBackupCode, normaliseBackupCode } from './backup-codes.js';

/**
 * Checking one second-factor proof, in ONE place (Phase D2).
 *
 * Sign-in, disabling the factor and regenerating backup codes all ask the same
 * question, and a second copy of it is a second answer — the copy that forgot the
 * replay rule would be the door a captured code walks through. So all three call this,
 * inside their own transaction, with the factor row already locked.
 *
 * It WRITES on success: the accepted TOTP step is recorded (`consumeStep`), or the
 * backup code is spent (`consumeBackupCode`). Both are conditional updates, so of two
 * requests racing with the same code exactly one is accepted. On failure it writes
 * nothing, and the caller's transaction rolling back loses nothing.
 */

export interface ProofInput {
  readonly code?: string | undefined;
  readonly backupCode?: string | undefined;
}

export type ProofVerdict =
  | { readonly accepted: true; readonly method: SecondFactorMethod }
  | {
      readonly accepted: false;
      readonly method: SecondFactorMethod;
      /**
       * For the AUDIT ROW only. The caller must answer every one of these with the same
       * error: telling a guesser a code was right but replayed tells them it was right.
       */
      readonly reason: 'WRONG_CODE' | 'REPLAYED_CODE' | 'UNKNOWN_BACKUP_CODE';
    };

export function totpSecretContext(tenantId: string, factorId: string): SecretContext {
  return { purpose: 'admin.totp_secret', tenantId, entityId: factorId };
}

export async function verifySecondFactorProof(
  deps: { readonly factors: SecondFactorRepository; readonly cipher: SecretCipher },
  scope: TenantContext,
  adminId: AdminId,
  factor: StoredTotpFactor,
  proof: ProofInput,
  now: Date,
  tx: unknown,
): Promise<ProofVerdict> {
  if (proof.code !== undefined) {
    const secret = deps.cipher.decrypt(
      { ciphertext: factor.ciphertext, keyId: factor.keyId },
      totpSecretContext(scope.tenantId, factor.id),
    );
    const step = matchTotp(secret, proof.code, now, factor.lastUsedStep);
    if (step === null) {
      // Distinguished for the audit row: a code that WOULD match, but for a step already
      // used, is a replay — worth an investigator's attention in a way a typo is not.
      const ignoringReplay = matchTotp(secret, proof.code, now, null);
      return {
        accepted: false,
        method: 'TOTP',
        reason: ignoringReplay === null ? 'WRONG_CODE' : 'REPLAYED_CODE',
      };
    }
    // The database decides which of two acceptable requests used the step.
    if (!(await deps.factors.consumeStep(scope, factor.id, step, now, tx))) {
      return { accepted: false, method: 'TOTP', reason: 'REPLAYED_CODE' };
    }
    return { accepted: true, method: 'TOTP' };
  }

  const normalised = proof.backupCode === undefined ? null : normaliseBackupCode(proof.backupCode);
  if (normalised === null) {
    return { accepted: false, method: 'BACKUP_CODE', reason: 'UNKNOWN_BACKUP_CODE' };
  }
  const spent = await deps.factors.consumeBackupCode(
    scope,
    adminId,
    hashBackupCode(scope.tenantId, adminId, normalised),
    now,
    tx,
  );
  return spent
    ? { accepted: true, method: 'BACKUP_CODE' }
    : { accepted: false, method: 'BACKUP_CODE', reason: 'UNKNOWN_BACKUP_CODE' };
}

/**
 * What a login challenge pins: a digest of the password hash the first step verified.
 * Not the hash itself — a second copy of a credential hash in another table is a second
 * place a database read finds one.
 */
export function credentialFingerprint(passwordHash: string): string {
  return createHash('sha256')
    .update(`nexa.login_challenge.v1\n${passwordHash}`, 'utf8')
    .digest('hex');
}
