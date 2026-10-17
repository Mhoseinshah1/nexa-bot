#!/usr/bin/env node
/**
 * Regenerates `tests/support/integration-timings.json`, the table the integration
 * matrix balances its shards by (`tests/support/timed-sequencer.mts`).
 *
 * Input: vitest JSON reports. CI uploads one per shard as the
 * `integration-timings-<n>` artifact; download every shard of one or more runs
 * and pass them all:
 *
 *   node scripts/integration-timings.mjs report-1.json report-2.json ...
 *
 * A file measured in several reports gets the mean. A file in no report keeps
 * the value it already had, so a partial set of reports never drops a file.
 * The table only moves files between shards; it never decides what runs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const TABLE = join(ROOT, 'tests/support/integration-timings.json');

const reports = process.argv.slice(2);
if (reports.length === 0) {
  console.error('usage: node scripts/integration-timings.mjs <vitest-json-report>...');
  process.exit(2);
}

/** @type {Record<string, number[]>} */
const seen = {};
for (const path of reports) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  for (const result of report.testResults ?? []) {
    const file = relative(ROOT, result.name).split('\\').join('/');
    if (!file.startsWith('tests/integration/')) continue;
    const seconds = (result.endTime - result.startTime) / 1000;
    if (Number.isFinite(seconds) && seconds >= 0) (seen[file] ??= []).push(seconds);
  }
}

const table = JSON.parse(readFileSync(TABLE, 'utf8'));
const files = { ...table.files };
for (const [file, values] of Object.entries(seen)) {
  files[file] = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}
table.files = Object.fromEntries(
  Object.keys(files)
    .sort()
    .map((file) => [file, files[file]]),
);
writeFileSync(TABLE, `${JSON.stringify(table, null, 2)}\n`);
console.log(
  `${Object.keys(seen).length} files measured, ${Object.keys(files).length} in the table`,
);
