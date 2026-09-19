import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPermissionKey, ROLE_SEEDS } from '@nexa/contracts';
import BASELINE_PAIRS from '../fixtures/role-seed-pairs-at-identity-release.json';

/**
 * Every permission a seeded role gained after the identity release must have a
 * backfill migration.
 *
 * This is the defect class, not one defect. `ensureSystemRoles` is
 * CREATION-ONLY by design — reasserting a seed on every boot would silently
 * restore a permission an operator withdrew — so a permission ADDED to a seed
 * reaches an installation that already has that role only through a migration.
 * Nothing enforced that. Phase 2 remembered (0011). The disaster-recovery
 * release did not, and the result was an installation where `/recovery`
 * rendered and every card in it answered access denied, while a fresh install
 * of the same image was correct.
 *
 * So the rule gets a test rather than a comment. The arithmetic:
 *
 *   seeds now  ⊆  seeds at the identity release  ∪  every backfill migration
 *
 * which is exactly the claim "an installation created at any release ends up
 * holding the current seed". An install created at release R holds seed(R),
 * which contains the baseline, and every backfill written after R still runs
 * against it; the ones written before R were already in seed(R). Add a
 * permission to a seed with no backfill and the left side grows while the right
 * does not, and this fails naming the pair.
 *
 * The reverse direction is checked too: a backfill may not grant a pair the
 * frozen contract does not assign. That is the privilege-amplification side —
 * a migration is not a licence to widen a role past `ROLE_SEEDS`.
 *
 * RETIREMENT is part of the same arithmetic and is replayed here rather than
 * excepted. A permission the catalogue drops leaves rows behind that name a key
 * nothing declares, so the release that drops it also DELETEs them (0085 is the
 * worked example). Without replaying those deletes this file would read the
 * standing INSERT in an earlier migration and report a widening that no
 * installation actually holds — and the obvious repair, editing the old
 * migration, is the one thing forward-only forbids.
 *
 * NOTE for a release that adds a brand-new seeded role: its pairs need no
 * backfill to be correct (the role does not exist yet, so `ensureSystemRoles`
 * creates it complete), but list them in the backfill anyway. Against a role
 * that does not exist the insert is a no-op, and it keeps this invariant exact
 * instead of needing an exception.
 */

/**
 * The pairs an installation created at the identity release received.
 *
 * A frozen historical fact, not a mirror of the current contract — a baseline
 * derived from today's `ROLE_SEEDS` would grow with it and the test would
 * always pass. Reproduce it with:
 *
 *   git show 'dcf12be^:packages/contracts/src/permissions.ts'
 *
 * and enumerate `ROLE_SEEDS`; `dcf12be` is the commit that first added a
 * permission to an existing seed. It is 107 pairs and it does not change.
 */
const baseline = new Set<string>(BASELINE_PAIRS);

const MIGRATIONS_DIR = join(__dirname, '../../apps/api/drizzle');

interface Backfill {
  readonly file: string;
  readonly pairs: readonly string[];
  /** Permission keys this migration DELETES from `role_permissions`, if any. */
  readonly retired: readonly string[];
}

/**
 * The pairs every migration backfills into `role_permissions`.
 *
 * Read from the migration files rather than retyped, because a list kept beside
 * them is a list that drifts from them. The shape recognised is the one both
 * backfills use — a `VALUES` list of `('role_key', 'permission.key')` tuples
 * inside the statement — and a file that writes `role_permissions` in a shape
 * this does not recognise yields nothing, which FAILS the coverage assertion
 * below rather than quietly shrinking it.
 */
function readBackfills(): Backfill[] {
  const found: Backfill[] = [];
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const retired = [
      ...sql.matchAll(
        /DELETE\s+FROM\s+"role_permissions"\s+WHERE\s+"permission_key"\s*=\s*'([a-z][a-z0-9_.]*)'/g,
      ),
    ].map((m) => m[1] as string);
    const start = sql.indexOf('INSERT INTO "role_permissions"');
    if (start < 0) {
      if (retired.length > 0) found.push({ file, pairs: [], retired });
      continue;
    }
    const end = sql.indexOf(';', start);
    const statement = sql.slice(start, end < 0 ? undefined : end);
    const pairs = [
      ...statement.matchAll(/\(\s*'([a-z][a-z0-9_]*)'\s*,\s*'([a-z][a-z0-9_.]*)'\s*\)/g),
    ].map((m) => `${m[1]}:${m[2]}`);
    found.push({ file, pairs, retired });
  }
  return found;
}

const backfills = readBackfills();

/**
 * What an existing installation ends up holding, replayed in migration order.
 *
 * A REPLAY and not a union, because order is the whole content of a retirement:
 * 0082 inserts `orders.fulfil` and 0085 deletes it, so the standing set has
 * neither. Reading them as a set would report a permission every installation
 * has already lost.
 */
const backfilled = new Set<string>();
for (const { pairs, retired } of backfills) {
  for (const pair of pairs) backfilled.add(pair);
  for (const key of retired) {
    for (const pair of [...backfilled]) {
      if (pair.endsWith(`:${key}`)) backfilled.delete(pair);
    }
  }
}

const seeded = new Set(
  ROLE_SEEDS.flatMap((role) => role.permissions.map((key) => `${role.key}:${key}`)),
);

describe('role seed backfill coverage', () => {
  it('parsed a backfill out of every migration that writes role_permissions', () => {
    // The parser failing open is the one way this whole file could be green and
    // meaningless, so it is asserted directly rather than assumed.
    expect(backfills.length).toBeGreaterThanOrEqual(2);
    for (const { file, pairs, retired } of backfills) {
      expect(
        pairs.length + retired.length,
        `${file} writes role_permissions but yielded neither a pair nor a retirement`,
      ).toBeGreaterThan(0);
    }
    // At least one retirement is parsed, so a regex that silently stopped
    // matching would fail here rather than quietly restoring a retired pair.
    expect(backfills.flatMap((b) => b.retired)).toContain('orders.fulfil');
    expect(backfilled.size).toBeGreaterThanOrEqual(13);
  });

  it('names only real roles and real permissions', () => {
    const roleKeys = new Set(ROLE_SEEDS.map((role) => role.key));
    for (const pair of backfilled) {
      const [roleKey = '', permissionKey = ''] = pair.split(':');
      expect(roleKeys.has(roleKey), `${pair} names no seeded role`).toBe(true);
      expect(isPermissionKey(permissionKey), `${pair} names no catalogued permission`).toBe(true);
    }
  });

  it('covers every permission a seeded role gained after the identity release', () => {
    const uncovered = [...seeded].filter((p) => !baseline.has(p) && !backfilled.has(p)).sort();
    expect(
      uncovered,
      'These (role:permission) pairs are in ROLE_SEEDS but reach no existing installation. ' +
        'ensureSystemRoles is creation-only, so each needs a line in a backfill migration.',
    ).toEqual([]);
  });

  it('never backfills a pair the frozen contract does not assign', () => {
    const amplifying = [...backfilled].filter((p) => !seeded.has(p)).sort();
    expect(
      amplifying,
      'A backfill migration grants a role a permission ROLE_SEEDS does not give it.',
    ).toEqual([]);
  });

  it('accounts for the disaster-recovery release exactly', () => {
    // Named rather than derived: the eight pairs this hotfix exists for. A
    // derived expectation here would be the same computation as the code under
    // test, and would agree with it however wrong both were.
    const dr = [...backfilled].filter((p) => /:(backup\.|recovery\.)/.test(p)).sort();
    expect(dr).toEqual([
      'observer:backup.view',
      'operator:backup.view',
      'owner:backup.download',
      'owner:backup.run',
      'owner:backup.view',
      'owner:recovery.restore',
      'technical:backup.run',
      'technical:backup.view',
    ]);
  });
});
