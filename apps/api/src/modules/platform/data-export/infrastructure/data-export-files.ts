import { createReadStream } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DataExportFiles } from '../application/ports.js';

const NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.\d{1,4}\.zip$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The export files on disk: `<BACKUP_WORK_DIR>/data-exports/<tenantId>/<exportId>.<attempt>.zip`.
 *
 * Every path is BUILT from two validated UUIDs, an integer and a fixed suffix — never from a name a
 * caller gave — so there is no argument that can aim it elsewhere (the construction, not a
 * sanitiser). The backup housekeeping only ever walks UUID-named run directories, so it
 * leaves this directory alone.
 */
export class FilesystemDataExportFiles implements DataExportFiles {
  constructor(private readonly root: string) {}

  pathFor(tenantId: string, exportId: string, attempt: number): { path: string; fileName: string } {
    const fileName = this.nameOf(exportId, attempt);
    return { path: this.pathOf(tenantId, fileName), fileName };
  }

  async list() {
    const out: { tenantId: string; fileName: string; exportId: string }[] = [];
    const tenants = await readdir(join(this.root, 'data-exports')).catch(() => [] as string[]);
    for (const tenantId of tenants) {
      if (!UUID.test(tenantId)) continue;
      const names = await readdir(join(this.root, 'data-exports', tenantId)).catch(
        () => [] as string[],
      );
      const seen = new Set<string>();
      for (const name of names) {
        const fileName = name.endsWith('.part') ? name.slice(0, -'.part'.length) : name;
        const match = NAME.exec(fileName);
        if (match === null || seen.has(fileName)) continue;
        seen.add(fileName);
        out.push({ tenantId, fileName, exportId: match[1]! });
      }
    }
    return out;
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

  private nameOf(exportId: string, attempt: number): string {
    if (!UUID.test(exportId)) throw new Error('an export id is a UUID');
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > 9999)
      throw new Error('an attempt is a small positive integer');
    return `${exportId}.${attempt}.zip`;
  }

  private checked(fileName: string): string {
    if (!NAME.test(fileName)) throw new Error('an export file name is <uuid>.<attempt>.zip');
    return fileName;
  }

  private pathOf(tenantId: string, fileName: string): string {
    if (!UUID.test(tenantId)) throw new Error('a tenant id is a UUID');
    return join(this.root, 'data-exports', tenantId, fileName);
  }
}
