import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostedArchiveFiles } from '../application/hosted-backup.ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Phase 6B PR-2: hosted archives on disk, `BACKUP_WORK_DIR/hosted/<tenantId>/<runId>/archive.7z`
 * (the tenant archive engine's workspace, ADR-0039 § 7). Paths are DERIVED from two validated
 * uuids — nothing a request carries reaches a path component.
 */
export class FilesystemHostedArchiveFiles implements HostedArchiveFiles {
  constructor(private readonly root: string) {}

  async archive(
    hostedTenantId: string,
    runId: string,
  ): Promise<{ path: string; bytes: number } | null> {
    const directory = this.directory(hostedTenantId, runId);
    if (directory === null) return null;
    const path = join(directory, 'archive.7z');
    try {
      const stats = await stat(path);
      return stats.isFile() ? { path, bytes: stats.size } : null;
    } catch {
      // Absent is an answer: retention removed it, or an operator did.
      return null;
    }
  }

  async remove(hostedTenantId: string, runId: string): Promise<boolean> {
    const directory = this.directory(hostedTenantId, runId);
    if (directory === null) return false;
    try {
      await rm(directory, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  private directory(hostedTenantId: string, runId: string): string | null {
    if (!UUID.test(hostedTenantId) || !UUID.test(runId)) return null;
    return join(this.root, 'hosted', hostedTenantId, runId);
  }
}
