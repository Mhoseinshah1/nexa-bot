import { describe, expect, it } from 'vitest';
import {
  LEGACY_READ_SET_NAMES,
  LEGACY_ROW_READABLE_TABLE_CLASSES,
  LEGACY_TABLE_CLASSES,
  LEGACY_TABLE_CLASSIFICATION,
  classifyLegacyTable,
  isLegacyTableRowReadable,
  legacyReadSetFingerprintVersion,
} from '@nexa/contracts';
import {
  IMPORT_READ_SET_V1,
  LEGACY_SYNTHETIC_MARKER_TABLE,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';

/**
 * Mirza migration PR1 — the legacy table catalogue (`packages/contracts/src/
 * legacy-inventory.ts`). It classifies only what the repository proves; everything else is
 * UNCLASSIFIED, and UNCLASSIFIED fails closed.
 */

describe('the legacy table catalogue', () => {
  it('is exactly the reviewed set, so a new entry is a deliberate contract change', () => {
    expect(
      Object.fromEntries(
        Object.entries(LEGACY_TABLE_CLASSIFICATION).map(([name, entry]) => [name, entry.class]),
      ),
    ).toEqual({
      user: 'SUPPORTED',
      invoice: 'SUPPORTED',
      product: 'SUPPORTED',
      nexa_synthetic_fixture: 'SUPPORTED',
    });
  });

  it('never lists UNCLASSIFIED: that is what an absent entry means', () => {
    for (const [name, entry] of Object.entries(LEGACY_TABLE_CLASSIFICATION)) {
      expect(LEGACY_TABLE_CLASSES, name).toContain(entry.class);
      expect(entry.class, name).not.toBe('UNCLASSIFIED');
      expect(entry.reason.length, name).toBeGreaterThan(10);
      expect(entry.evidence, name).not.toBe('none');
    }
  });

  it('classifies every v1 import table, and the synthetic marker, as SUPPORTED', () => {
    for (const table of [...IMPORT_READ_SET_V1.tables, LEGACY_SYNTHETIC_MARKER_TABLE]) {
      expect(classifyLegacyTable(table).class, table).toBe('SUPPORTED');
    }
  });

  it('defaults to UNCLASSIFIED — for unknown names, other spellings and prototype keys', () => {
    for (const name of [
      'setting',
      'marzban_panel',
      'Payment_report',
      'User',
      'INVOICE',
      'user ',
      '',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
    ]) {
      expect(classifyLegacyTable(name).class, JSON.stringify(name)).toBe('UNCLASSIFIED');
      expect(isLegacyTableRowReadable(name), JSON.stringify(name)).toBe(false);
    }
  });

  it('lets a read set read rows of SUPPORTED and ARCHIVE tables only', () => {
    expect([...LEGACY_ROW_READABLE_TABLE_CLASSES]).toEqual(['SUPPORTED', 'ARCHIVE']);
    expect(isLegacyTableRowReadable('user')).toBe(true);
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(LEGACY_TABLE_CLASSIFICATION)).toBe(true);
    expect(Object.isFrozen(LEGACY_TABLE_CLASSIFICATION['user'])).toBe(true);
    expect(() => {
      (LEGACY_TABLE_CLASSIFICATION as Record<string, unknown>)['setting'] = {
        class: 'SUPPORTED',
      };
    }).toThrow(TypeError);
    expect(classifyLegacyTable('setting').class).toBe('UNCLASSIFIED');
  });
});

describe('read set names and versions', () => {
  it('names the recorded read sets and builds their version strings', () => {
    expect([...LEGACY_READ_SET_NAMES]).toEqual(['inventory', 'products', 'invoice-archive']);
    expect(legacyReadSetFingerprintVersion('inventory', 1)).toBe('legacy-read-set:inventory:v1');
    expect(legacyReadSetFingerprintVersion('invoice-archive', 2)).toBe(
      'legacy-read-set:invoice-archive:v2',
    );
    for (const [name, version] of [
      ['Inventory', 1],
      ['inventory', 0],
      ['inventory', 1.5],
      ['in ventory', 1],
      ['', 1],
    ] as const) {
      expect(() => legacyReadSetFingerprintVersion(name, version), `${name}:${version}`).toThrow();
    }
  });
});
