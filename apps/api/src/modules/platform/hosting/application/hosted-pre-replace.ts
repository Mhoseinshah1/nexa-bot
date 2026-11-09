import {
  NexaError,
  TENANT_ARCHIVE_ERROR_CODES,
  type SecretCipher,
  type TenantContext,
} from '@nexa/contracts';
import type { TenantArchiveService } from '../../backup/application/tenant-archive.service.js';
import type { HostedBackupPolicyStore } from './hosted-backup.ports.js';

/**
 * Phase 6B (ADR-0039 § 4, step 2): the PRE_REPLACE archive — a hosted bot's CURRENT rows,
 * archived with ITS backup password through the unmodified tenant pipeline (trigger
 * `PRE_REPLACE`, kept under `hosted/<tenant>/` like any other of its archives), inside the
 * replace's own admitted heavy job. Anything short of a verified success stops the replace
 * before a row is touched (`tenant_archive.pre_replace_failed`): a bot with no password, a
 * password that does not open, a run that failed or did not verify.
 */
export function hostedPreReplaceArchive(deps: {
  readonly policies: Pick<HostedBackupPolicyStore, 'find'>;
  readonly cipher: SecretCipher;
  readonly archives: Pick<TenantArchiveService, 'runInsideAdmittedJob'>;
  readonly installationTenantId: () => string;
}): (hostedTenantId: string) => Promise<string> {
  const failed = (message: string): NexaError =>
    new NexaError({
      kind: 'PRECONDITION_FAILED',
      code: TENANT_ARCHIVE_ERROR_CODES.PRE_REPLACE_FAILED,
      message,
    });
  return async (hostedTenantId) => {
    const installationTenantId = deps.installationTenantId();
    const policy = await deps.policies.find(
      { tenantId: installationTenantId, botInstanceId: null } as TenantContext,
      hostedTenantId,
    );
    if (policy?.passwordCiphertext == null || policy.passwordKeyId == null) {
      throw failed(
        'The hosted bot has no backup password, so its current rows cannot be archived first.',
      );
    }
    let password: string;
    try {
      password = deps.cipher.decrypt(
        { ciphertext: policy.passwordCiphertext, keyId: policy.passwordKeyId },
        {
          purpose: 'hosting.archive_password',
          tenantId: installationTenantId,
          entityId: policy.id,
        },
      );
    } catch {
      throw failed('The hosted bot’s backup password does not open on this server.');
    }
    const outcome = await deps.archives.runInsideAdmittedJob({
      tenantId: hostedTenantId,
      trigger: 'PRE_REPLACE',
      password,
    });
    if (
      outcome.kind !== 'COMPLETED' ||
      outcome.run.state !== 'SUCCEEDED' ||
      outcome.run.verifiedAt === null
    ) {
      throw failed('The archive of the rows to be replaced did not verify.');
    }
    return outcome.run.id;
  };
}
