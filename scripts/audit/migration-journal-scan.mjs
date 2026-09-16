#!/usr/bin/env node
/**
 * The migration journal against the migration files, and the destructive ones.
 *
 * `docs/phase4j-audit.md` axis 8. `pnpm db:check` catches schema DRIFT — a
 * schema file that has moved ahead of its migrations. It does not check that the
 * journal and the directory agree, and a journal entry with no file is an
 * installation that upgrades to a version it cannot reach.
 *
 * The destructive listing is the other half: this repository's migration rule is
 * expand/contract across two releases, and a `DROP COLUMN` is how that rule gets
 * broken quietly. One file is expected to match — `0002_drop_callback_refs.sql`,
 * the worked example `.claude/skills/nexa-migrations` cites.
 */
import { readFileSync, readdirSync } from 'node:fs';

const DIR = 'apps/api/drizzle';
const journal = JSON.parse(readFileSync(`${DIR}/meta/_journal.json`, 'utf8'));
const onDisk = new Set(
  readdirSync(DIR)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => name.slice(0, -4)),
);
const inJournal = new Set(journal.entries.map((entry) => entry.tag));

const orphanFiles = [...onDisk].filter((tag) => !inJournal.has(tag)).sort();
const orphanEntries = [...inJournal].filter((tag) => !onDisk.has(tag)).sort();
const whens = journal.entries.map((entry) => entry.when);
const idxs = journal.entries.map((entry) => entry.idx);

console.log(`migrations on disk: ${onDisk.size}`);
console.log(`journal entries:    ${journal.entries.length}`);
console.log(`sql not in journal: ${orphanFiles.length === 0 ? 'none' : orphanFiles.join(', ')}`);
console.log(
  `journal not on disk: ${orphanEntries.length === 0 ? 'none' : orphanEntries.join(', ')}`,
);
console.log(
  `when monotonic:     ${JSON.stringify(whens) === JSON.stringify([...whens].sort((a, b) => a - b))}`,
);
console.log(
  `idx contiguous:     ${JSON.stringify(idxs) === JSON.stringify(idxs.map((_, i) => i))}`,
);

const destructive = [...onDisk]
  .sort()
  .filter((tag) => /DROP COLUMN|DROP TABLE/i.test(readFileSync(`${DIR}/${tag}.sql`, 'utf8')));
console.log(
  `\ndestructive migrations: ${destructive.length === 0 ? 'none' : destructive.join(', ')}`,
);
