#!/usr/bin/env node
/**
 * Every transactional service method that takes no idempotency key, listed.
 *
 * `docs/phase4j-audit.md` axis 2, and the axis where the LIST is the wrong
 * answer on its own. This codebase holds two rules, not one:
 *
 * - every COMMAND takes an idempotency key;
 * - every CLAIM is a conditional write naming the state it was read from.
 *
 * A sweep uses the second and correctly has no key. So a reviewer who treats
 * this output as a defect list files one false finding per background lane —
 * which is why the audit classifies every row rather than counting them.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const METHOD = /^ {2}(?:async |public async )([a-zA-Z][a-zA-Z0-9]*)\(/;

const files = execSync('find apps/api/src/modules -name "*.service.ts"', { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter((line) => line !== '');

let flagged = 0;
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = METHOD.exec(lines[i]);
    if (match === null) continue;
    let end = lines.length - 1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^ {2}\}/.test(lines[j])) {
        end = j;
        break;
      }
    }
    const body = lines.slice(i, end + 1).join('\n');
    if (!/uow\.run|unitOfWork\.run/.test(body)) continue;
    if (/idempotencyKey/.test(body)) continue;
    flagged += 1;
    console.log(`${file}:${i + 1}  ${match[1]}`);
  }
}
console.log(`\n${flagged} transactional method(s) with no idempotency key.`);
