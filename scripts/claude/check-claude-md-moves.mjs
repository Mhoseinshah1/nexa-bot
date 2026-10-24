#!/usr/bin/env node
/**
 * Nothing the old CLAUDE.md said may be lost when it is slimmed.
 *
 * Content moves verbatim to docs/project-status.md and some rules are copied
 * into .claude/skills/<name>/SKILL.md. This check extracts every markdown
 * heading and every bold span from the OLD CLAUDE.md and requires each to be
 * found somewhere in the corpus: the new CLAUDE.md, docs/project-status.md and
 * every skill (SKILL.md and references/*.md).
 *
 * Usage: check-claude-md-moves.mjs [--base <git-ref>] [--root <dir>] [--old <file>]
 *
 * The default base is PINNED to 54518005, the last commit before slimming.
 * After the slimming PR merges, `origin/main` would already hold the slim file
 * and the check would compare the slim file with itself and pass vacuously.
 *
 * Matching is on whitespace-collapsed text, so a bold span wrapped over a line
 * break in the old file still matches when it sits on one line in the new one
 * (and the reverse). Bold markup is kept when text moves verbatim, so a bold
 * span must be found as `**text**`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_BASE = '54518005';

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

function parseArgs(argv) {
  const out = { base: DEFAULT_BASE, root: process.cwd(), old: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base' || a === '--root' || a === '--old') {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/** Headings, and paragraphs (text joined by spaces so wrapped bold survives). */
export function extract(markdown) {
  const headings = [];
  const paragraphs = [];
  let current = [];
  let fence = false;
  const flush = () => {
    if (current.length) paragraphs.push(current.join(' '));
    current = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const t = collapse(h[1]);
      if (t) headings.push(t);
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    // a new list item starts a new block; wrapped continuation lines do not
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) flush();
    current.push(line.replace(/^\s*>\s?/, '').trim());
  }
  flush();
  const bold = [];
  for (const p of paragraphs) {
    for (const m of p.matchAll(/\*\*(.+?)\*\*/g)) {
      const t = collapse(m[1]);
      if (t) bold.push(t);
    }
  }
  return { headings, bold };
}

function walk(dir, accept, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, accept, acc);
    else if (accept(p)) acc.push(p);
  }
  return acc;
}

function corpusFiles(root) {
  const files = [join(root, 'CLAUDE.md'), join(root, 'docs/project-status.md')];
  const skills = join(root, '.claude/skills');
  files.push(
    ...walk(skills, (p) => /[\\/]SKILL\.md$/.test(p) || /[\\/]references[\\/][^\\/]+\.md$/.test(p)),
  );
  return files.filter((f) => existsSync(f));
}

function buildCorpus(files) {
  const parts = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    parts.push(collapse(text));
    // markdown line wraps joined, quote markers dropped
    parts.push(collapse(text.replace(/^\s*>\s?/gm, '')));
  }
  return parts.join('\n');
}

export function check(oldText, corpus) {
  const { headings, bold } = extract(oldText);
  const missing = [];
  for (const h of headings) if (!corpus.includes(h)) missing.push(`MISSING heading: ${h}`);
  for (const b of bold) if (!corpus.includes(`**${b}**`)) missing.push(`MISSING bold: ${b}`);
  return { headings: headings.length, bold: bold.length, missing };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`claude-md-moves: ${e.message}`);
    return 2;
  }
  const root = resolve(args.root);
  let oldText;
  try {
    oldText = args.old
      ? readFileSync(resolve(args.old), 'utf8')
      : execFileSync('git', ['-C', root, 'show', `${args.base}:CLAUDE.md`], {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        });
  } catch (e) {
    console.error(`claude-md-moves: cannot read old CLAUDE.md: ${e.message.split('\n')[0]}`);
    return 2;
  }
  const r = check(oldText, buildCorpus(corpusFiles(root)));
  if (r.missing.length) {
    for (const m of r.missing) console.error(m);
    console.error(`claude-md-moves: FAIL (${r.missing.length} missing)`);
    return 1;
  }
  console.log(`claude-md-moves: OK (${r.headings} headings, ${r.bold} bold spans checked)`);
  return 0;
}

process.exitCode = main();
