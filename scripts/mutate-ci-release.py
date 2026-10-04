"""Falsification for the CI/release hardening: revert one rule at a time, confirm a test goes red,
restore byte-for-byte. Run from anywhere: python3 scripts/mutate-ci-release.py"""
import os
import subprocess
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + '/'
CI = ROOT + '.github/workflows/ci.yml'
GATE = ROOT + 'scripts/release-ci-gate.mjs'
GATESH = ROOT + 'scripts/release-ci-gate.sh'
REL = ROOT + '.github/workflows/release.yml'
M = [
  ('cancel main runs', CI, "cancel-in-progress: ${{ github.event_name == 'pull_request' }}", 'cancel-in-progress: true', 'unit'),
  ('group without sha', CI, "format('{0}-{1}', github.ref, github.sha)", "format('{0}', github.ref)", 'unit'),
  ('push all branches', CI, 'branches: [main]', "branches: ['**']", 'unit'),
  ('aggregate ignores integration', CI, ' && [ "$INTEGRATION" = "success" ]', '', 'unit'),
  ('aggregate not always', CI, "    if: always()\n    needs: [unit, web, integration]", "    needs: [unit, web, integration]", 'unit'),
  ('shard fixed denominator', CI, '/${{ strategy.job-total }}"', '/4"', 'unit'),
  ('accept pull_request', GATE, "['push', 'workflow_dispatch']", "['push', 'workflow_dispatch', 'pull_request']", 'both'),
  ('skip sha compare', GATE, "if (run.head_sha !== sha) return", "if (false) return", 'both'),
  ('skip status check', GATE, "if (run.status !== 'completed') return 'pending';", '', 'both'),
  ('accept cancelled', GATE, "if (run.conclusion !== 'success')", "if (run.conclusion !== 'success' && run.conclusion !== 'cancelled')", 'both'),
  ('skip path check', GATE, "if (run.path !== workflowPath) return", "if (false) return", 'both'),
  ('no paginate', GATESH, 'gh api --paginate \\', 'gh api \\', 'deploy'),
  ('api error ignored', GATESH, "--jq '.workflow_runs[] | tojson' >\"$listing\"; then", "--jq '.workflow_runs[] | tojson' >\"$listing\" || true; then", 'deploy'),
  ('gate from tag checkout', REL, "ref: ${{ github.workflow_sha }}", "ref: refs/tags/${{ github.event.inputs.tag || github.ref_name }}", 'unit'),
]
def run(kind):
    ok = True
    if kind in ('unit', 'both'):
        r = subprocess.run(['pnpm', '-s', 'vitest', 'run', '--project', 'unit', 'tests/unit/ci-workflow.test.ts', 'tests/unit/release-ci-gate.test.ts', 'tests/unit/release-workflow.test.ts'], cwd=ROOT, capture_output=True)
        ok = ok and r.returncode == 0
    if kind in ('deploy', 'both'):
        r = subprocess.run(['bash', 'tests/deploy/release-ci-gate.test.sh'], cwd=ROOT, capture_output=True)
        ok = ok and r.returncode == 0
    return ok
for name, path, old, new, kind in M:
    original = open(path).read()
    assert original.count(old) == 1, (name, original.count(old))
    open(path, 'w').write(original.replace(old, new))
    try:
        green = run(kind)
    finally:
        open(path, 'w').write(original)
    print(('SURVIVED ' if green else 'killed   ') + name, flush=True)
print('baseline green:', run('both'))
