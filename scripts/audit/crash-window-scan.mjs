#!/usr/bin/env node
/**
 * Every "commit, then reach outside" sequence, listed.
 *
 * `docs/phase4j-audit.md` axis 4. An awaited `uow.run` followed within 40 lines
 * by a call to an outbound port is the shape where a crash loses an effect that
 * the committed state says happened.
 *
 * ## What this scan CANNOT see, which is the finding the audit actually made
 *
 * It sees an effect done in the same function as the commit. It does NOT see two
 * transactions separated by a process boundary — `runOnce` terminalises an
 * operation and the NEXT line announces it, in a second transaction, and a crash
 * between them loses the announcement for ever with nothing left owing it.
 *
 * That is recorded here rather than in the audit alone, because the next person
 * to run this scan and see a clean result needs to know what clean means.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const WINDOW = 40;
const COMMIT = /await .*\b(?:uow|unitOfWork)\.run\(/;
const SINK =
  /\b(?:messaging|telegram|notifier|transport|delivery|adapter|provider)\w*\.(?:send|deliver|notify|create|modify|remove|call)/i;

const files = execSync('find apps/api/src -name "*.ts" -not -name "*.d.ts"', { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter((line) => line !== '');

let flagged = 0;
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!COMMIT.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + WINDOW); j += 1) {
      if (COMMIT.test(lines[j])) break;
      if (!SINK.test(lines[j])) continue;
      flagged += 1;
      console.log(`${file}:${j + 1}  reached after the commit at :${i + 1}`);
      break;
    }
  }
}
console.log(`\n${flagged} commit-then-reach-outside sequence(s).`);
