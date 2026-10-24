import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-claude-md-moves.mjs');

const OLD = `# Title

## Rules

**First rule is important.** Body text.

- **Second rule that wraps
  across a line** and more.
`;

function run(files) {
  const dir = mkdtempSync(join(tmpdir(), 'cmm-'));
  try {
    writeFileSync(join(dir, 'OLD.md'), OLD);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    const r = spawnSync(process.execPath, [SCRIPT, '--root', dir, '--old', join(dir, 'OLD.md')], {
      encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FULL = `# Title\n\n## Rules\n\n**First rule is important.** Body.\n\n- **Second rule that wraps across a line** and more.\n`;

test('all present -> 0', () => {
  const r = run({ 'CLAUDE.md': FULL });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /claude-md-moves: OK \(2 headings, 2 bold spans checked\)/);
});

test('heading missing -> 1 naming it', () => {
  const r = run({ 'CLAUDE.md': FULL.replace('## Rules', '') });
  assert.equal(r.code, 1);
  assert.match(r.err, /MISSING heading: Rules/);
});

test('bold wrapped across lines in old, one line in new -> OK', () => {
  const r = run({ 'CLAUDE.md': '# Title\n## Rules\n', 'docs/project-status.md': FULL });
  assert.equal(r.code, 0, r.err);
});

test('bold present only in a SKILL.md or references -> OK', () => {
  const r = run({
    'CLAUDE.md': '# Title\n## Rules\n',
    '.claude/skills/x/SKILL.md': '**First rule is important.**\n',
    '.claude/skills/x/references/r.md': '**Second rule that wraps across\na line**\n',
  });
  assert.equal(r.code, 0, r.err);
});

test('bold missing -> 1 naming it', () => {
  const r = run({
    'CLAUDE.md': FULL.replace('**First rule is important.**', 'First rule is important.'),
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /MISSING bold: First rule is important\./);
});
