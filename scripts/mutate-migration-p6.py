"""Migration P6 / Item 8 mutation driver (docs/migration-p6-service-adoption.md, "Mutation").

Reverts one rule at a time, runs the test file that names it, prints which cases failed,
and restores the file from its in-memory original. Needs a clean apps/ tree and
TEST_DATABASE_URL (and DATABASE_URL) pointing at a database no other suite is using: the
integration suite truncates between tests.
Usage: python3 scripts/mutate-migration-p6.py [S1-... ...]
"""
import os
import subprocess
import sys

W = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if subprocess.run(['git', 'diff', '--quiet', '--', 'apps', 'packages'], cwd=W).returncode != 0:
    sys.exit('apps/ or packages/ has uncommitted changes; run this on a clean tree')
env = dict(os.environ)
if 'TEST_DATABASE_URL' not in env:
    sys.exit('set TEST_DATABASE_URL (and DATABASE_URL) to a database of your own')

PROV = W + '/apps/api/src/modules/commerce/provisioning/'
RS = PROV + 'application/service-reminder.service.ts'
RR = PROV + 'infrastructure/drizzle-service-reminder.repository.ts'

SEED_IT = ('integration', 'tests/integration/reminder-burst-seed.test.ts')
SEED_UNIT = ('unit', 'tests/unit/reminder-burst-seed.test.ts')

# name -> (file, original, mutant, (project, test file))
M = {
    'S1-only-the-due-expiry-kind': (
        RS,
        'due === null ? [] : EXPIRY_REMINDER_KINDS.slice(0, EXPIRY_REMINDER_KINDS.indexOf(due) + 1);',
        'due === null ? [] : [due];',
        SEED_IT,
    ),
    'S2-no-usage-kinds': (
        RS,
        'const usage = candidate.usageMeasured',
        'const usage = false',
        SEED_IT,
    ),
    # Equivalent against the database (services_usage_synced_check makes an unmeasured
    # figure zero), so it is killed by the pure unit test.
    'S3-ignore-usage-measured': (
        RS,
        'const usage = candidate.usageMeasured',
        'const usage = true',
        SEED_UNIT,
    ),
    'S4-day-start-in-utc': (
        RR,
        "             CASE WHEN s.expires_at IS NULL THEN NULL ELSE LEAST(\n"
        "               date_trunc('day', s.expires_at AT TIME ZONE t.display_timezone)\n"
        "                 AT TIME ZONE t.display_timezone,",
        "             CASE WHEN s.expires_at IS NULL THEN NULL ELSE LEAST(\n"
        "               date_trunc('day', s.expires_at AT TIME ZONE 'UTC')\n"
        "                 AT TIME ZONE 'UTC',",
        SEED_IT,
    ),
    'S5-no-tenant-filter': (
        RR,
        'WHERE s.tenant_id = ${tenantId} AND s.id = ${serviceId}',
        'WHERE s.id = ${serviceId}',
        SEED_IT,
    ),
    'S6-no-scope-activity-read': (
        RS,
        '  ): Promise<ServiceReminderSeed> {\n'
        '    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {',
        '  ): Promise<ServiceReminderSeed> {\n'
        '    if (false && !(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {',
        SEED_IT,
    ),
}

selected = sys.argv[1:] or list(M)
for name in selected:
    path, original, mutant, (project, test) = M[name]
    with open(path, encoding='utf-8') as f:
        source = f.read()
    if source.count(original) != 1:
        print(f'{name}: TARGET NOT UNIQUE ({source.count(original)})', flush=True)
        continue
    with open(path, 'w', encoding='utf-8') as f:
        f.write(source.replace(original, mutant))
    try:
        run = subprocess.run(
            ['pnpm', 'vitest', 'run', '--project', project, test, '--hookTimeout', '600000'],
            cwd=W, env=env, capture_output=True, text=True,
        )
        out = run.stdout + run.stderr
        failed = [line.strip() for line in out.splitlines() if line.strip().startswith('×')]
        print(f"{name}: {'KILLED' if run.returncode else 'SURVIVED'}", flush=True)
        for line in failed:
            print('    ' + line, flush=True)
    finally:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(source)
