#!/usr/bin/env node
/**
 * Every repository statement that does not name a tenant, listed.
 *
 * `docs/phase4j-audit.md` axis 1. This does NOT decide anything: it produces the
 * list a reviewer classifies, and the audit records the classification. The
 * distinction matters because the scan CANNOT be precise — a Drizzle statement
 * builds its predicate into a `conditions` array above the call, so a window
 * that big enough to catch every filter is also big enough to catch the next
 * statement's.
 *
 * So it is deliberately noisy in the safe direction: it over-reports, the audit
 * reads each row, and a row that is genuinely unfiltered cannot hide in the
 * noise because the noise is enumerated too.
 *
 * Exit status is always 0. This is an instrument, not a gate — a gate would need
 * a suppression list, and a suppression list is where a real finding goes to
 * live quietly.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const WINDOW = 30;
const STATEMENT = /\b(?:select\(|selectDistinct\(|insert\(|update\(|delete\()/;

const files = execSync('find apps/api/src -name "*repository*.ts"', { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter((line) => line !== '');

let flagged = 0;
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!STATEMENT.test(lines[i])) continue;
    const chunk = [];
    for (let j = i; j < Math.min(lines.length, i + WINDOW); j += 1) {
      chunk.push(lines[j]);
      if (/;\s*$/.test(lines[j])) break;
    }
    if (/tenantId|tenant_id/.test(chunk.join('\n'))) continue;
    flagged += 1;
    console.log(`${file}:${i + 1}  ${lines[i].trim().slice(0, 100)}`);
  }
}
console.log(`\n${flagged} statement(s) flagged across ${files.length} repositories.`);
