import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_COMPACTION_DROP_TYPES, LEGACY_HISTORY_RECORD_TYPES } from '@nexa/contracts';
import {
  compactionDropTypes,
  compactionKeptTypes,
  LEGACY_COMPACTION_READ_MAP,
} from '../../apps/api/src/modules/platform/legacy-compaction/application/read-map';

/**
 * Round 4 PR-E (E1): the compaction's READ MAP, held to the source.
 *
 * A compaction deletes rows for ever (after the archive backup). The rule is that it never
 * deletes a type anything reads BY TYPE, and this test is that rule: it reads every source
 * file of the API and the Web Admin and fails when a dropped type is named in any of them
 * other than the type catalogue itself — so a new reader of, say, `panel_target` turns this
 * red before a compaction can delete what it reads.
 */

const ROOT = join(__dirname, '..', '..');
const MODULES = join(ROOT, 'apps', 'api', 'src', 'modules', 'platform');
const SOURCES = [join(ROOT, 'apps', 'api', 'src'), join(ROOT, 'apps', 'web', 'src')];

/** The files allowed to NAME every type: the catalogue and the read map itself. */
const CATALOGUE = new Set([
  'apps/api/src/modules/platform/legacy-history/application/record-map.ts',
  'apps/api/src/modules/platform/legacy-compaction/application/read-map.ts',
]);

function files(directory: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

const quoted = (type: string) => new RegExp(`['"\`]${type}['"\`]`);

describe('the legacy compaction read map (E1)', () => {
  it('covers every record type exactly once', () => {
    expect(Object.keys(LEGACY_COMPACTION_READ_MAP).sort()).toEqual(
      [...LEGACY_HISTORY_RECORD_TYPES].sort(),
    );
  });

  it('drops only types with no reader, and keeps every type with one', () => {
    expect(compactionDropTypes()).toEqual([...LEGACY_COMPACTION_DROP_TYPES]);
    for (const type of LEGACY_COMPACTION_DROP_TYPES) {
      expect(LEGACY_COMPACTION_READ_MAP[type], type).toEqual([]);
    }
    const kept = new Set(compactionKeptTypes());
    for (const [type, readers] of Object.entries(LEGACY_COMPACTION_READ_MAP)) {
      if (readers.length > 0) expect(kept.has(type as never), type).toBe(true);
    }
  });

  it('keeps every type the owner listed that the read map found READ', () => {
    for (const type of [
      'service_ownership',
      'wallet_history_check',
      'wallet_difference',
      'product_mapping_proposal',
      'panel_registry',
      'category_catalogue',
      'agent_state',
    ] as const) {
      expect(compactionKeptTypes(), type).toContain(type);
      expect(LEGACY_COMPACTION_READ_MAP[type].length, type).toBeGreaterThan(0);
    }
  });

  it('names a real reader file for every read type, and that file names the type', () => {
    for (const [type, readers] of Object.entries(LEGACY_COMPACTION_READ_MAP)) {
      for (const reader of readers) {
        const text = readFileSync(join(MODULES, reader), 'utf8');
        expect(quoted(type).test(text), `${reader} reads ${type}`).toBe(true);
      }
    }
  });

  it('finds NO source file outside the catalogue that names a dropped type', () => {
    const offenders: string[] = [];
    for (const path of SOURCES.flatMap(files)) {
      const name = relative(ROOT, path);
      if (CATALOGUE.has(name)) continue;
      const text = readFileSync(path, 'utf8');
      for (const type of compactionDropTypes()) {
        if (quoted(type).test(text)) offenders.push(`${name} names ${type}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
