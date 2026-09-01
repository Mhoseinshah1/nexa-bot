#!/usr/bin/env node
/**
 * Missing-key check.
 *
 * Fails when a registered template key has no Persian string, when a template
 * uses a placeholder token it did not declare, or when a surface hard-codes a
 * customer-facing string instead of using a key.
 *
 * The legacy system has no i18n layer at all: the Persian caption IS the
 * identifier, so renaming a button renames its key, and there is no way to tell
 * a missing string from an empty one.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { auditCatalogue } from '@nexa/i18n';

let failed = false;

function fail(message, detail = []) {
  console.error(`FAIL  ${message}`);
  for (const line of detail) console.error(`      ${line}`);
  failed = true;
}

// --- catalogue completeness -------------------------------------------------
const audit = auditCatalogue('fa');

if (audit.missing.length > 0) {
  fail('Template keys with no Persian string', audit.missing);
} else {
  console.log('ok    every registered template key has a Persian string');
}

if (audit.undeclaredTokens.length > 0) {
  fail(
    'Templates use placeholder tokens they do not declare',
    audit.undeclaredTokens.map((t) => `${t.key}: {${t.token}}`),
  );
} else {
  console.log('ok    every placeholder token is declared');
}

// --- no hard-coded customer-facing strings in surfaces ----------------------
// Persian text in a handler means a string that cannot be edited, translated,
// or even found.
const PERSIAN = /[؀-ۿ]/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

const offenders = [];
for (const file of walk('apps/api/src/surfaces')) {
  const source = readFileSync(file, 'utf8');
  source.split('\n').forEach((line, index) => {
    // Comments explaining the legacy behaviour may quote Persian; code may not.
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
    if (PERSIAN.test(line)) offenders.push(`${file}:${index + 1}: ${trimmed}`);
  });
}

if (offenders.length > 0) {
  fail('Hard-coded Persian strings in a surface', offenders);
} else {
  console.log('ok    no hard-coded customer-facing strings in surfaces');
}

console.log();
if (failed) {
  console.error('i18n checks failed.');
  process.exit(1);
}
console.log('All i18n checks passed.');
