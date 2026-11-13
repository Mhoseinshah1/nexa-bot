import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A migration that redefines a CHECK list must not silently remove values.
 *
 * Drizzle cannot ALTER a CHECK, so changing an `enumCheck()` list is a
 * DROP CONSTRAINT + ADD CONSTRAINT with the whole list restated. Two branches
 * that each add a value, both generated against the same old list, each restate
 * it without the other's value: the later migration then removes a value the
 * earlier one just added, and nothing fails until a row carrying it is written
 * (#470 would have dropped what #469 and #471 had added).
 *
 * For every migration in journal order this reads each `CONSTRAINT "x" CHECK
 * (...)` it (re)defines, takes the set of string literals in the expression (an
 * `IN (...)` list and `= ANY (ARRAY[...])` alike), and compares it with the
 * previous definition of the same constraint. A value that disappears fails,
 * unless the migration carries
 *
 *     -- nexa:check-drop <constraint> <value> <reason>
 *
 * Applied migrations are immutable (nexa-migrations), so the historic drops that
 * predate this guard are listed in HISTORIC_DROPS below, each with its reason.
 */
const folder = join(__dirname, '../../apps/api/drizzle');
const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as {
  entries: { tag: string }[];
};

/** Strip `--` line comments outside string literals is unnecessary: the SQL keeps none inside literals. */
function withoutComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--(?!>).*$/, ''))
    .join('\n');
}

/** The balanced `( ... )` that starts at `open` (index of the `(`), literal-aware. */
function balanced(sql: string, open: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = open; i < sql.length; i += 1) {
    const c = sql[i];
    if (inString) {
      if (c === "'") {
        if (sql[i + 1] === "'") i += 1;
        else inString = false;
      }
    } else if (c === "'") inString = true;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  return null;
}

function literals(expression: string): Set<string> {
  const values = new Set<string>();
  for (const match of expression.matchAll(/'((?:[^']|'')*)'/g)) {
    values.add((match[1] ?? '').replace(/''/g, "'"));
  }
  return values;
}

export interface CheckDefinition {
  constraint: string;
  values: Set<string>;
}

export function checkDefinitions(sql: string): CheckDefinition[] {
  const clean = withoutComments(sql);
  const found: CheckDefinition[] = [];
  for (const match of clean.matchAll(/CONSTRAINT\s+"([^"]+)"\s+CHECK\s*\(/gi)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const body = balanced(clean, open);
    if (body !== null) found.push({ constraint: match[1] ?? '', values: literals(body) });
  }
  return found;
}

function annotations(sql: string): Set<string> {
  const allowed = new Set<string>();
  for (const match of sql.matchAll(/^--\s*nexa:check-drop\s+(\S+)\s+(\S+)\s+(\S.*)$/gm)) {
    allowed.add(`${match[1]}|${match[2]}`);
  }
  return allowed;
}

/**
 * Drops that shipped before this guard existed. Migrations are immutable, so they
 * are recorded here as `<migration tag>|<constraint>|<value>`; each is a
 * deliberate or inherited removal already applied everywhere. A NEW drop is never
 * added here: it carries a `-- nexa:check-drop` comment in its own migration.
 */
const HISTORIC_DROPS: Record<string, string> = {
  '0094_username_contract|service_username_reservations_mode_check|RANDOM':
    '0094 folds the RANDOM reservation mode into AUTOMATIC and backfills the rows first; its header explains the order',
  '0084_drop_paid_unfulfilled|notifications_kind_check|ORDER_PAID_UNFULFILLED':
    '0084 removes the PAID_UNFULFILLED order outcome (and its notification kind) on purpose; its header explains the forward-only removal',
  '0084_drop_paid_unfulfilled|orders_state_check|PAID_UNFULFILLED':
    '0084 removes the PAID_UNFULFILLED order outcome (and its notification kind) on purpose; its header explains the forward-only removal',
  '0084_drop_paid_unfulfilled|orders_settled_at_check|PAID_UNFULFILLED':
    '0084 removes the PAID_UNFULFILLED order outcome (and its notification kind) on purpose; its header explains the forward-only removal',
  '0093_reminder_slots_and_snapshot|customer_notifications_kind_check|SERVICE_EXPIRING_3D':
    '0093 replaces the unreleased reminder kinds with slot-based ones on purpose and discards the unreleased service_reminders rows; its header explains why',
  '0093_reminder_slots_and_snapshot|customer_notifications_kind_check|SERVICE_EXPIRING_1D':
    '0093 replaces the unreleased reminder kinds with slot-based ones on purpose and discards the unreleased service_reminders rows; its header explains why',
  '0093_reminder_slots_and_snapshot|customer_notifications_kind_check|SERVICE_USAGE_80':
    '0093 replaces the unreleased reminder kinds with slot-based ones on purpose and discards the unreleased service_reminders rows; its header explains why',
  '0093_reminder_slots_and_snapshot|customer_notifications_kind_check|SERVICE_USAGE_95':
    '0093 replaces the unreleased reminder kinds with slot-based ones on purpose and discards the unreleased service_reminders rows; its header explains why',
  '0093_reminder_slots_and_snapshot|customer_notifications_kind_check|SERVICE_USAGE_100':
    '0093 replaces the unreleased reminder kinds with slot-based ones on purpose and discards the unreleased service_reminders rows; its header explains why',
  '0093_reminder_slots_and_snapshot|service_reminders_kind_check|EXPIRING_3D':
    '0093 replaces the unreleased reminder kinds with slot-based ones on purpose and discards the unreleased service_reminders rows; its header explains why',
  '0093_reminder_slots_and_snapshot|service_reminders_kind_check|EXPIRING_1D':
    '0093 replaces the unreleased reminder kinds with slot-based ones on purpose and discards the unreleased service_reminders rows; its header explains why',
  '0093_reminder_slots_and_snapshot|service_reminders_kind_check|USAGE_80':
    '0093 replaces the unreleased reminder kinds with slot-based ones on purpose and discards the unreleased service_reminders rows; its header explains why',
  '0093_reminder_slots_and_snapshot|service_reminders_kind_check|USAGE_95':
    '0093 replaces the unreleased reminder kinds with slot-based ones on purpose and discards the unreleased service_reminders rows; its header explains why',
  '0093_reminder_slots_and_snapshot|service_reminders_kind_check|USAGE_100':
    '0093 replaces the unreleased reminder kinds with slot-based ones on purpose and discards the unreleased service_reminders rows; its header explains why',
};

export function findDrops(): string[] {
  const previous = new Map<string, Set<string>>();
  const drops: string[] = [];
  for (const { tag } of journal.entries) {
    const sql = readFileSync(join(folder, `${tag}.sql`), 'utf8');
    const allowed = annotations(sql);
    // a renamed constraint carries its history with it
    for (const rename of withoutComments(sql).matchAll(
      /RENAME\s+CONSTRAINT\s+"([^"]+)"\s+TO\s+"([^"]+)"/gi,
    )) {
      const old = previous.get(rename[1] ?? '');
      if (old) previous.set(rename[2] ?? '', old);
    }
    for (const def of checkDefinitions(sql)) {
      const before = previous.get(def.constraint);
      if (before) {
        for (const value of before) {
          if (!def.values.has(value) && !allowed.has(`${def.constraint}|${value}`)) {
            drops.push(`${tag}|${def.constraint}|${value}`);
          }
        }
      }
      previous.set(def.constraint, def.values);
    }
  }
  return drops;
}

describe('CHECK lists across migrations', () => {
  it('parses IN lists and ANY(ARRAY[...]) forms, balanced and literal-aware', () => {
    const defs = checkDefinitions(
      `CREATE TABLE t (a text, CONSTRAINT "t_a_check" CHECK (a IN ('X', 'it''s)', 'Y')));\n` +
        `ALTER TABLE t ADD CONSTRAINT "t_b_check" CHECK (b = ANY (ARRAY['P','Q']::text[])) NOT VALID;\n` +
        `-- CONSTRAINT "ghost" CHECK (c IN ('Z'))\n`,
    );
    expect(defs.map((d) => [d.constraint, [...d.values].sort()])).toEqual([
      ['t_a_check', ['X', 'Y', "it's)"].sort()],
      ['t_b_check', ['P', 'Q']],
    ]);
  });

  it('never removes a value a previous definition allowed, unless annotated', () => {
    const unexpected = findDrops().filter((drop) => !(drop in HISTORIC_DROPS));
    expect(
      unexpected,
      'a migration removed a CHECK value. If intended, add `-- nexa:check-drop <constraint> <value> <reason>` to that migration.',
    ).toEqual([]);
  });

  it('keeps no stale allowlist entry', () => {
    const real = new Set(findDrops());
    expect(Object.keys(HISTORIC_DROPS).filter((key) => !real.has(key))).toEqual([]);
  });

  it('gives every historic drop a reason', () => {
    for (const reason of Object.values(HISTORIC_DROPS)) expect(reason.length).toBeGreaterThan(15);
  });
});
