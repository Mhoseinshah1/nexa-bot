import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECRET_COLUMNS } from '../../apps/api/src/infrastructure/crypto/secret-registry';
import { SECRET_PURPOSES } from '@nexa/contracts';

/**
 * The registry is the coverage claim, so it is checked rather than trusted.
 *
 * `secrets status`, `secrets rewrap` and `secrets retire-check` all walk
 * `SECRET_COLUMNS`. A ciphertext column missing from it is invisible to all
 * three — it would never be re-encrypted, never appear in a version count, and,
 * worst, retirement would report that nothing depends on a key while that
 * column still did. "Remember to add it" is not a mechanism.
 *
 * Read from the schema SOURCE rather than from the imported Drizzle objects.
 * Enumerating a Drizzle table's columns at runtime means reaching through its
 * internal symbols, and a check that breaks quietly when a library rearranges
 * its internals is a check that stops running without saying so. The physical
 * column names are right there in the file.
 */
describe('the secret column registry', () => {
  const schemaPath = join(__dirname, '../../apps/api/src/infrastructure/persistence/schema.ts');
  const schema = readFileSync(schemaPath, 'utf8');

  /** Every `text('..._ciphertext')` the schema declares. */
  const declaredCiphertextColumns = (source: string): string[] => [
    ...new Set([...source.matchAll(/'([a-z0-9_]+_ciphertext)'/g)].map((match) => match[1]!)),
  ];

  it('covers every ciphertext column in the schema', () => {
    const declared = declaredCiphertextColumns(schema).sort();
    const registered = SECRET_COLUMNS.map((column) => column.ciphertextColumn).sort();
    expect(declared.length, 'the schema declares no ciphertext column at all').toBeGreaterThan(0);
    expect(registered).toEqual(declared);
  });

  it('fails when an unregistered ciphertext column is introduced', () => {
    // The falsification, run in-process against the same extractor the real
    // check uses. Without it this file asserts that today's one entry matches
    // today's one column, and would keep passing on the day somebody adds a
    // second column and forgets the registry.
    const withAnother = `${schema}\n  gatewaySecret: text('gateway_secret_ciphertext').notNull(),\n`;
    const declared = declaredCiphertextColumns(withAnother).sort();
    const registered = SECRET_COLUMNS.map((column) => column.ciphertextColumn).sort();
    expect(declared).not.toEqual(registered);
    expect(declared).toContain('gateway_secret_ciphertext');
  });

  it('names one purpose per column, and only purposes the contract declares', () => {
    // The purpose is authenticated data, so the mapping has to be exact.
    const purposes = SECRET_COLUMNS.map((column) => column.purpose);
    expect(new Set(purposes).size).toBe(purposes.length);
    for (const purpose of purposes) expect(SECRET_PURPOSES).toContain(purpose);
  });

  it('declares no purpose that nothing stores', () => {
    // A purpose with no producer is a name that reads as permission — the same
    // rule the error-code check enforces in `check-boundaries.sh`.
    const registered = new Set(SECRET_COLUMNS.map((column) => column.purpose));
    for (const purpose of SECRET_PURPOSES) {
      expect(registered, `${purpose} is declared but nothing stores it`).toContain(purpose);
    }
  });
});
