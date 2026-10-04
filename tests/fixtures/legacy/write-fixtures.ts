/**
 * Regenerates the committed SYNTHETIC fixture files from `synthetic-legacy.ts`:
 *
 *     pnpm --filter @nexa/api exec tsx ../../tests/fixtures/legacy/write-fixtures.ts
 *
 * `tests/unit/legacy-importer-fixture.test.ts` fails when a committed file differs from
 * what this writes, so the JSON a rehearsal loads and the rows the tests assert on are
 * one dataset.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSyntheticLegacyDataset, syntheticLegacySql } from './synthetic-legacy';

const here = dirname(fileURLToPath(import.meta.url));
const dataset = buildSyntheticLegacyDataset();
writeFileSync(join(here, 'synthetic-legacy.json'), `${JSON.stringify(dataset, null, 2)}\n`);
writeFileSync(join(here, 'synthetic-legacy.sql'), syntheticLegacySql(dataset));
