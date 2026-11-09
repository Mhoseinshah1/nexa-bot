import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DataExportFiles } from '../application/ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The export files on disk: `<BACKUP_WORK_DIR>/data-exports/<tenantId>/<exportId>.zip`.
 *
 * Every path is BUILT from two validated UUIDs and a fixed suffix — never from a name a
 * caller gave — so there is no argument that can aim it elsewhere (the construction, not a
 * sanitiser). The backup housekeeping only ever walks UUID-named run directories, so it
 * leaves this directory alone.
 */
export class FilesystemDataExportFiles implements DataExportFiles {
  constructor(private readonly root: string) {}

  pathFor(tenantId: string, exportId: string): { path: string; fileName: string } {
    const fileName = this.nameOf(exportId);
    return { path: this.pathOf(tenantId, fileName), fileName };
  }

  async open(tenantId: string, fileName: string) {
    const path = this.pathOf(tenantId, this.checked(fileName));
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile()) return null;
    return { stream: createReadStream(path), bytes: info.size };
  }

  async remove(tenantId: string, fileName: string): Promise<void> {
    const path = this.pathOf(tenantId, this.checked(fileName));
    await rm(path, { force: true });
    await rm(`${path}.part`, { force: true });
  }

  private nameOf(exportId: string): string {
    if (!UUID.test(exportId)) throw new Error('an export id is a UUID');
    return `${exportId}.zip`;
  }

  private checked(fileName: string): string {
    if (!/^[0-9a-f-]{36}\.zip$/.test(fileName))
      throw new Error('an export file name is <uuid>.zip');
    return fileName;
  }

  private pathOf(tenantId: string, fileName: string): string {
    if (!UUID.test(tenantId)) throw new Error('a tenant id is a UUID');
    return join(this.root, 'data-exports', tenantId, fileName);
  }
}
