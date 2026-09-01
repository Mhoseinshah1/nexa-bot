#!/usr/bin/env node
/**
 * Imports the distilled reverse-engineering corpus into `docs/research/`,
 * redacting identifiers before they enter version control.
 *
 * The corpus documents a third party's live production deployment. Its findings
 * are the evidence this rewrite is built on; its identifiers are not, and there
 * is no reason for them to live in this repository forever.
 *
 * The redaction map is explicit rather than heuristic, so a reviewer can see
 * exactly what was removed and why. A generic scan runs afterwards as a safety
 * net and fails the import if anything secret-shaped survives.
 *
 * Usage: node scripts/sanitize-research.mjs <extracted-corpus-dir>
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';

const SOURCE = process.argv[2];
const DEST = 'docs/research';

if (!SOURCE) {
  console.error('Usage: node scripts/sanitize-research.mjs <extracted-corpus-dir>');
  process.exit(1);
}

/** The distilled subset: findings, rules, unknowns and registers — not raw captures. */
const KEEP = [
  /(^|\/)MASTER\.md$/,
  /(^|\/)business-rules\.md$/,
  /(^|\/)unknowns\.md$/,
  /(^|\/)incidents\.md$/,
  /(^|\/)source-bugs\.md$/,
  /(^|\/)entities-relations\.md$/,
  /(^|\/)entities-states\.md$/,
  /rebuild-recommendation/,
  /crossmap/,
];

/**
 * Explicit redactions. Each entry says what the value is, so the decision is
 * reviewable rather than a regex someone has to reverse-engineer later.
 */
const REDACTIONS = [
  // Telegram numeric user ids of the accounts the investigation drove.
  [/\b5973087728\b/g, '[TELEGRAM_USER_ID_REDACTED]', 'test account Telegram id'],
  [/\b7666446375\b/g, '[TELEGRAM_USER_ID_REDACTED]', 'test account Telegram id'],
  // A customer id observed in the vendor web admin.
  [/\b1000046178\b/g, '[WEB_USER_ID_REDACTED]', 'customer id from the web admin'],
  // The live bot the investigation ran against, and the support account that
  // shares its brand (`zedproxy_support`).
  [/@?ZEDPROXY_BOT/gi, '[BOT_USERNAME_REDACTED]', 'live bot username'],
  [/@?zedproxy[a-z0-9_]*/gi, '[TELEGRAM_ACCOUNT_REDACTED]', 'related Telegram account'],
  // A provider panel host belonging to the deployment, and the panel label that
  // embeds the same name (e.g. `TEST_MARZBAN_RICKPANEL`).
  [/\brickpanel\.io\b/gi, '[PANEL_HOST_REDACTED]', 'provider panel host'],
  [/RICKPANEL/g, '[PANEL_NAME_REDACTED]', 'provider panel label'],
  [/\brickpanel\b/gi, '[PANEL_NAME_REDACTED]', 'provider panel label'],
  // The vendor's hosted admin endpoint for this deployment.
  [/https?:\/\/app\.mirzabot\.com/gi, '[VENDOR_ADMIN_HOST_REDACTED]', 'vendor admin endpoint'],
  [/\bapp\.mirzabot\.com\b/gi, '[VENDOR_ADMIN_HOST_REDACTED]', 'vendor admin endpoint'],
  // A panel administrator account name.
  [/\bzproxy\b/gi, '[ADMIN_USERNAME_REDACTED]', 'panel admin account name'],
];

/** Anything matching these after redaction fails the import. */
const FORBIDDEN = [
  [/[0-9]{8,10}:AA[A-Za-z0-9_-]{20,}/, 'a Telegram bot token'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'an email address'],
  [/\b(?!0\.0\.0\.0|127\.0\.0\.1)([0-9]{1,3}\.){3}[0-9]{1,3}\b/, 'an IP address'],
  [/\b[0-9]{4}[- ][0-9]{4}[- ][0-9]{4}[- ][0-9]{4}\b/, 'a payment card number'],
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const counts = new Map();
let files = 0;

for (const file of walk(SOURCE)) {
  const rel = relative(SOURCE, file);
  if (!KEEP.some((pattern) => pattern.test(rel))) continue;

  let text = readFileSync(file, 'utf8');

  for (const [pattern, replacement, label] of REDACTIONS) {
    const matches = text.match(pattern);
    if (matches) {
      counts.set(label, (counts.get(label) ?? 0) + matches.length);
      text = text.replace(pattern, replacement);
    }
  }

  for (const [pattern, description] of FORBIDDEN) {
    const found = text.match(pattern);
    if (found) {
      console.error(`FAIL  ${rel} still contains ${description}: ${found[0]}`);
      process.exit(1);
    }
  }

  const target = join(DEST, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  files += 1;
}

console.log(`Imported ${files} files into ${DEST}/`);
for (const [label, count] of [...counts].sort()) {
  console.log(`  redacted ${String(count).padStart(3)} × ${label}`);
}
console.log(`  ${basename(DEST)}/README.md explains how to read this corpus.`);
