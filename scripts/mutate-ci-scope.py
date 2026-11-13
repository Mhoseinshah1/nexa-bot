"""Falsification for path-scoped CI (scripts/ci-scope.sh, scripts/ci-aggregate.sh, the
wiring in ci.yml and the nightly report): revert one rule at a time, confirm a test in
tests/unit/ci-workflow.test.ts goes red, restore byte-for-byte.

Run from anywhere: python3 scripts/mutate-ci-scope.py
Prints `killed` or `SURVIVED` per mutation, then whether the unmutated tree is green."""
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + '/'
SCOPE = ROOT + 'scripts/ci-scope.sh'
AGG = ROOT + 'scripts/ci-aggregate.sh'
REPORT = ROOT + 'scripts/ci-nightly-report.sh'
CI = ROOT + '.github/workflows/ci.yml'
NIGHTLY = ROOT + '.github/workflows/nightly.yml'

SKIP_RULE = (
    '  if [ "$result" = "skipped" ] && [ "$event" = "pull_request" ] && [ "$changes" = "success" ] &&\n'
    '    [ "$full" = "false" ] && [ "$scope" = "false" ]; then'
)

M = [
    # The fail-safe rule.
    ('unknown path is not full', SCOPE, '[ "$matched" = "true" ] || full=true', 'true'),
    ('fail-safe paths are not full', SCOPE, '      full=true\n      matched=true', '      matched=true'),
    ('a package.json is not fail-safe', SCOPE,
     '| package.json | */package.json | \\\n      .github/*', '| package.json | \\\n      .github/*'),
    ('push/dispatch/nightly not full', SCOPE,
     'if [ "$event" != "pull_request" ]; then\n    full=true', 'if false; then\n    full=true'),
    ('empty or blank diff is not full', SCOPE, '[ "$classified" -gt 0 ] || everything', 'true'),
    ('PR runs both legacy engines', SCOPE,
     'local engines="[$ENGINE_MYSQL]"', 'local engines="[$ENGINE_MARIADB,$ENGINE_MYSQL]"'),
    ('audit on every full PR', SCOPE, '  if [ "$full" = "true" ]; then\n    web=true',
     '  if [ "$full" = "true" ]; then\n    audit=true web=true'),
    ('caddy routes skip integration', SCOPE, 'deploy/caddy/*) add integration web ;;',
     'deploy/caddy/*) add web ;;'),
    ('template copy skips integration', SCOPE, 'apps/web/src/i18n/templates.fa*) add integration ;;',
     'apps/web/src/i18n/templates.fa*) add web ;;'),
    # The aggregate rule.
    ('aggregate accepts any skip', AGG, SKIP_RULE, '  if [ "$result" = "skipped" ]; then'),
    ('aggregate ignores the scope', AGG, SKIP_RULE,
     SKIP_RULE.replace(' && [ "$scope" = "false" ]', '')),
    ('aggregate ignores the event', AGG, SKIP_RULE,
     SKIP_RULE.replace(' && [ "$event" = "pull_request" ]', '')),
    ('aggregate ignores full', AGG, SKIP_RULE, SKIP_RULE.replace('[ "$full" = "false" ] && ', '')),
    ('aggregate accepts cancelled', AGG, '  if [ "$result" = "success" ]; then',
     '  if [ "$result" = "success" ] || [ "$result" = "cancelled" ]; then'),
    ('aggregate drops a job', AGG, ' DEPLOY DEPLOY_UPDATE)', ' DEPLOY)'),
    # The wiring.
    ('update smoke gated by another output', CI,
     "    name: Deployment update and rollback smoke\n    needs: changes\n"
     "    if: needs.changes.outputs.full == 'true' || needs.changes.outputs.deploy == 'true'",
     "    name: Deployment update and rollback smoke\n    needs: changes\n"
     "    if: needs.changes.outputs.full == 'true' || needs.changes.outputs.integration == 'true'"),
    ('aggregate scope env mismatched', CI,
     'DEPLOY_UPDATE_SCOPE: ${{ needs.changes.outputs.deploy }}',
     'DEPLOY_UPDATE_SCOPE: ${{ needs.changes.outputs.integration }}'),
    ('audit gated by full', CI, "    if: needs.changes.outputs.audit == 'true'",
     "    if: needs.changes.outputs.full == 'true' || needs.changes.outputs.audit == 'true'"),
    ('legacy matrix static', CI, '        engine: ${{ fromJSON(needs.changes.outputs.legacy_engines) }}',
     '        engine: [mysql-8.0]'),
    # The nightly.
    ('nightly copies instead of calling ci.yml', NIGHTLY, '    uses: ./.github/workflows/ci.yml',
     '    uses: ./.github/workflows/exhaustive.yml'),
    ('issues: write for every job', NIGHTLY, 'permissions:\n  contents: read\n\nenv:',
     'permissions:\n  contents: read\n  issues: write\n\nenv:'),
    ('report matches a title prefix', REPORT, '.title == \\"${TITLE}\\")',
     '(.title | startswith(\\"${TITLE}\\")))'),
    ('report counts pull requests', REPORT, '.pull_request == null and ', ''),
]


def green():
    r = subprocess.run(
        ['pnpm', '-s', 'vitest', 'run', '--project', 'unit', 'tests/unit/ci-workflow.test.ts'],
        cwd=ROOT, capture_output=True)
    return r.returncode == 0


survived = 0
for name, path, old, new in M:
    original = open(path).read()
    assert original.count(old) == 1, (name, original.count(old))
    open(path, 'w').write(original.replace(old, new))
    try:
        ok = green()
    finally:
        open(path, 'w').write(original)
    survived += ok
    print(('SURVIVED ' if ok else 'killed   ') + name, flush=True)
print('baseline green:', green())
raise SystemExit(1 if survived else 0)
