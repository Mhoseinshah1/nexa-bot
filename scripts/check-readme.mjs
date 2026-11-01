#!/usr/bin/env node
/**
 * The READMEs promise commands an operator will copy and paste. This check
 * keeps those promises true:
 *
 *   1. Every `botctl ...` command in README.md and README.fa.md names a
 *      subcommand, and uses only flags, that `botctl --help` documents. The
 *      help text is read from the `usage()` heredoc in deploy/bin/botctl, so
 *      nothing has to be installed.
 *   2. The install one-liner (latest and pinned form) in both READMEs is
 *      byte-identical to ONE_LINER below, and to the one in
 *      docs/deployment.md when that document carries it.
 *
 * Run: node scripts/check-readme.mjs  (pnpm check:readme)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// The installer one-liner, exactly. docs/deployment.md is reconciled to this.
export const ONE_LINER =
  'curl -fsSL --remote-name-all https://github.com/Mhoseinshah1/nexa-bot/releases/latest/download/install.sh{,.sha256} && sha256sum -c install.sh.sha256 && sudo bash install.sh';
export const PINNED_LINER = ONE_LINER.replace(
  'releases/latest/download',
  'releases/download/vX.Y.Z',
);

const READMES = ['README.md', 'README.fa.md'];
const failures = [];
const fail = (m) => failures.push(m);

// --- botctl help -----------------------------------------------------------
const botctl = read('deploy/bin/botctl');
const heredoc = /usage\(\) \{\n\s*cat <<'USAGE'\n([\s\S]*?)\nUSAGE\n/.exec(botctl);
if (!heredoc) throw new Error('cannot find the usage() heredoc in deploy/bin/botctl');
const help = heredoc[1];

const helpFlags = new Set(help.match(/--[a-z][a-z0-9-]*/g) ?? []);
// A command path is the leading words of a help line, up to the first
// placeholder (UPPERCASE), option, bracket or parenthesis.
const paths = [];
for (const line of help.split('\n')) {
  const m = /^\s+botctl\s+(.*)$/.exec(line);
  if (!m) continue;
  const words = [];
  for (const w of m[1].split(/\s{2,}/)[0].split(/\s+/)) {
    if (!/^[a-z][a-z-]*$/.test(w)) break;
    words.push(w);
  }
  if (words.length) paths.push(words);
}
const isKnown = (tokens) => paths.some((p) => p.every((w, i) => tokens[i] === w));

function commandsIn(text) {
  const found = [];
  const push = (raw) => {
    const at = raw.search(/\bbotctl\b/);
    if (at < 0) return;
    const rest = raw.slice(at + 'botctl'.length).split('#')[0];
    found.push(rest.trim());
  };
  // Fenced blocks: one command per line.
  for (const block of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    for (const line of block[1].split('\n')) if (/\bbotctl\b/.test(line)) push(line);
  }
  // Inline code, outside the fences.
  const unfenced = text.replace(/```[^\n]*\n[\s\S]*?```/g, '');
  for (const m of unfenced.matchAll(/`([^`\n]*\bbotctl\b[^`\n]*)`/g)) push(m[1]);
  return found;
}

for (const file of READMES) {
  const text = read(file);
  const cmds = commandsIn(text);
  if (cmds.length === 0) fail(`${file}: no botctl command found`);
  for (const cmd of cmds) {
    const tokens = cmd.split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || ['--help', '-h'].includes(tokens[0])) continue;
    if (!isKnown(tokens)) {
      // Prose like "`botctl` is installed" has no tokens; anything else must match.
      fail(`${file}: "botctl ${cmd}" is not a subcommand in botctl --help`);
      continue;
    }
    for (const t of tokens) {
      if (t.startsWith('--') && !helpFlags.has(t.replace(/=.*/, ''))) {
        fail(`${file}: flag ${t} in "botctl ${cmd}" is not in botctl --help`);
      }
    }
  }

  // --- install one-liner ---------------------------------------------------
  // The Persian README is deliberately simpler: it carries the latest form only.
  const required = [['one-liner', ONE_LINER]];
  if (file === 'README.md') required.push(['pinned one-liner', PINNED_LINER]);
  for (const [name, expected] of required) {
    const lines = text.split('\n').filter((l) => l.startsWith('curl -fsSL --remote-name-all '));
    if (!lines.includes(expected))
      fail(`${file}: ${name} is missing or differs from scripts/check-readme.mjs`);
  }
}

// docs/deployment.md carries it only once the installer change has landed.
const deployment = read('docs/deployment.md');
const deployLines = deployment.split('\n').filter((l) => l.startsWith('curl -fsSL --remote-name-all '));
for (const l of deployLines) {
  if (l !== ONE_LINER && l !== PINNED_LINER) {
    fail(`docs/deployment.md: install one-liner differs from the READMEs: ${l}`);
  }
}
const note = deployLines.length
  ? ''
  : ' (docs/deployment.md has no one-liner yet; compared to the script constant)';

if (failures.length) {
  console.error(`check:readme FAILED\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`check:readme ok: ${READMES.join(', ')}${note}`);
