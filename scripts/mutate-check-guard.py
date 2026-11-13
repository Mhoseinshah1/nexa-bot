"""Mutation probe for tests/unit/migration-check-values.test.ts.

Writes a scratch migration (0999_scratch_check_drop.sql, registered nowhere: the guard reads
the journal, so the probe adds a temporary journal entry) that redefines a recent CHECK list
without one of its values, runs the guard and expects it to FAIL; then repeats with the
`-- nexa:check-drop` annotation and expects it to PASS. Both files are restored afterwards,
even on failure. Needs a clean apps/ tree. Usage: python3 scripts/mutate-check-guard.py
"""
import json
import os
import re
import subprocess
import sys

W = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if subprocess.run(['git', 'diff', '--quiet', '--', 'apps'], cwd=W).returncode != 0:
    sys.exit('apps/ has uncommitted changes; run this on a clean tree')
D = W + '/apps/api/drizzle/'
JOURNAL = D + 'meta/_journal.json'
TAG = '9999_scratch_check_drop'
SCRATCH = D + TAG + '.sql'
original = open(JOURNAL).read()
entries = json.loads(original)['entries']

# the last migration that defines a CHECK IN list: drop its first value from the constraint
for e in reversed(entries):
    text = open(D + e['tag'] + '.sql').read()
    m = re.search(r'CONSTRAINT "([^"]+)" CHECK \((\w+) IN \(((?:\'[^\']*\'(?:, )?)+)\)', text)
    if m:
        break
else:
    sys.exit('no CHECK IN list found')
name, col, values = m.group(1), m.group(2), re.findall(r"'([^']*)'", m.group(3))
table = re.search(r'ALTER TABLE "([^"]+)" ADD CONSTRAINT "%s"' % re.escape(name), text)
table = table.group(1) if table else 'scratch'
kept = ', '.join("'%s'" % v for v in values[1:])
body = 'ALTER TABLE "%s" DROP CONSTRAINT "%s";\nALTER TABLE "%s" ADD CONSTRAINT "%s" CHECK (%s IN (%s));\n' % (
    table, name, table, name, col, kept)
print('mutating %s: dropping %s' % (name, values[0]))


def run():
    return subprocess.run(
        ['pnpm', 'exec', 'vitest', 'run', '--project', 'unit', 'tests/unit/migration-check-values.test.ts'],
        cwd=W, capture_output=True, text=True).returncode


def register():
    doc = json.loads(original)
    doc['entries'].append({'idx': len(entries), 'version': entries[-1]['version'],
                           'when': entries[-1]['when'] + 1, 'tag': TAG, 'breakpoints': True})
    open(JOURNAL, 'w').write(json.dumps(doc, indent=2) + '\n')


ok = True
try:
    register()
    open(SCRATCH, 'w').write(body)
    dropped = run()
    print('unannotated drop: guard exit=%d (want non-zero)' % dropped)
    ok &= dropped != 0
    open(SCRATCH, 'w').write('-- nexa:check-drop %s %s probe, restored afterwards\n' % (name, values[0]) + body)
    annotated = run()
    print('annotated drop:   guard exit=%d (want 0)' % annotated)
    ok &= annotated == 0
finally:
    open(JOURNAL, 'w').write(original)
    if os.path.exists(SCRATCH):
        os.remove(SCRATCH)
sys.exit(0 if ok else 1)
