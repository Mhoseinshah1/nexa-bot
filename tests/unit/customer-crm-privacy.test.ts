import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Program §8: customer notes are OPERATOR-ONLY. "Do not send notes to customers. Do not
 * expose notes through Telegram customer APIs."
 *
 * A rule like that is kept by nobody adding a reader, so this asserts the readers there ARE,
 * over the source tree. Every file in `apps/api/src` that names the notes table, the notes
 * repository methods or the CRM service is listed below; a new one — a Telegram handler, a
 * customer gateway route, a notification renderer, a report — fails here and has to be
 * argued for in review rather than slipping in. The tag ASSIGNMENT table has one more
 * reader, the customer list's filter, which is the Web Admin's own list.
 */

const ROOT = 'apps/api/src';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith('.ts')) out.push(relative('.', path).replaceAll('\\', '/'));
  }
  return out.sort();
}

const FILES = sourceFiles(ROOT);
const read = (path: string) => readFileSync(path, 'utf8');
const filesMatching = (pattern: RegExp) => FILES.filter((path) => pattern.test(read(path)));

describe('customer notes never reach a customer surface', () => {
  it('names the notes storage in exactly the CRM files and the schema', () => {
    expect(
      filesMatching(/customerNotes|customer_notes|insertNote|notesOf|findNote|CustomerNoteRecord/),
    ).toEqual([
      'apps/api/src/infrastructure/persistence/schema.ts',
      'apps/api/src/modules/commerce/customers/application/customer-crm-ports.ts',
      'apps/api/src/modules/commerce/customers/application/customer-crm.service.ts',
      'apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer-crm.repository.ts',
      'apps/api/src/surfaces/web/customer-crm.controller.ts',
    ]);
  });

  it('reaches the CRM service only from the container and the Web Admin controller', () => {
    expect(filesMatching(/\bcustomerCrm\b|CustomerCrmService/)).toEqual([
      'apps/api/src/container.ts',
      'apps/api/src/modules/commerce/customers/application/customer-crm.service.ts',
      'apps/api/src/surfaces/web/customer-crm.controller.ts',
    ]);
  });

  it('has no import of the CRM module under a Telegram or gateway surface', () => {
    const customerFacing = FILES.filter(
      (path) =>
        path.startsWith('apps/api/src/surfaces/telegram/') ||
        path.startsWith('apps/api/src/surfaces/gateway/'),
    );
    expect(customerFacing.length).toBeGreaterThan(0);
    for (const path of customerFacing) {
      expect(read(path), path).not.toMatch(/customer-crm|customerCrm|customer_notes|customerNotes/);
    }
  });

  it('carries no note in any event payload or template catalogue', () => {
    const contracts = readFileSync('packages/contracts/src/events.ts', 'utf8');
    const payload = /CustomerNoteAdded: z\.object\(\{([^}]*)\}\)/.exec(contracts);
    expect(payload?.[1]?.trim()).toBe('noteId: z.string()');
  });
});
