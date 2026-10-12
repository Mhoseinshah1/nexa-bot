import { describe, expect, it } from 'vitest';
import {
  isNexaError,
  PLATFORM_ERROR_CODES,
  systemContext,
  type TenantContext,
} from '@nexa/contracts';
import {
  assertInstallationWritable,
  legacyMigrationQuiesceId,
  runAsLegacyMigration,
  type InstallationWriteGate,
} from '../../apps/api/src/infrastructure/persistence/write-gate';

/**
 * Phase 7 — the Mirza `.nxpkg` import's installation-wide write freeze, at the gate every
 * durable write passes (`DrizzleUnitOfWork.run`; the relay asks the same gate and idles).
 * The integration suite (`legacy-migration-nxpkg.test.ts`, the restore-page case) proves it against
 * PostgreSQL; this pins the exemption rule itself: the import's OWN writer, and nothing else.
 */

const IMPORT = '019600ab-cdef-7012-8345-6789abcd0aaa';
const OTHER = '019600ab-cdef-7012-8345-6789abcd0bbb';
const tenant = {
  tenantId: '019600ab-cdef-7012-8345-6789abcd0001',
  botInstanceId: null,
} as unknown as TenantContext;
const gate = (id: string | null): InstallationWriteGate => ({ quiescedBy: async () => id });

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (isNexaError(error)) return error.code;
    throw error;
  }
}

describe('the legacy migration write freeze', () => {
  it('refuses a normal write while an import is APPLYING, with the restore’s own code', async () => {
    const frozen = gate(legacyMigrationQuiesceId(IMPORT));
    expect(await codeOf(assertInstallationWritable(frozen, tenant, {}))).toBe(
      PLATFORM_ERROR_CODES.RECOVERY_QUIESCED,
    );
  });

  it('lets the import’s OWN writer through, and only it', async () => {
    const frozen = gate(legacyMigrationQuiesceId(IMPORT));
    expect(
      await codeOf(
        runAsLegacyMigration(IMPORT, () => assertInstallationWritable(frozen, tenant, {})),
      ),
    ).toBeNull();
    // Another import's writer is not this import's.
    expect(
      await codeOf(
        runAsLegacyMigration(OTHER, () => assertInstallationWritable(frozen, tenant, {})),
      ),
    ).toBe(PLATFORM_ERROR_CODES.RECOVERY_QUIESCED);
    // The context ends with the call: a write after it is refused again.
    await runAsLegacyMigration(IMPORT, async () => undefined);
    expect(await codeOf(assertInstallationWritable(frozen, tenant, {}))).toBe(
      PLATFORM_ERROR_CODES.RECOVERY_QUIESCED,
    );
  });

  it('never lets an import’s writer through a RECOVERY’s quiesce', async () => {
    const recovery = gate('019600ab-cdef-7012-8345-6789abcd0ccc');
    expect(
      await codeOf(
        runAsLegacyMigration(IMPORT, () => assertInstallationWritable(recovery, tenant, {})),
      ),
    ).toBe(PLATFORM_ERROR_CODES.RECOVERY_QUIESCED);
    // The recovery lane itself is unchanged.
    expect(
      await codeOf(assertInstallationWritable(recovery, systemContext('recovery'), {})),
    ).toBeNull();
  });

  it('writes freely when nothing holds the installation', async () => {
    expect(await codeOf(assertInstallationWritable(gate(null), tenant, {}))).toBeNull();
  });
});
