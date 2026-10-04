"""Migration P1 (H5) mutation driver (docs/migration-p1-usage-sync.md, "Mutation").

Reverts one rule at a time, runs tests/integration/usage-sync-priority.test.ts, prints
which cases failed, and restores the file from its in-memory original. Needs a clean
apps/ tree and TEST_DATABASE_URL (and DATABASE_URL) pointing at a database no other suite
is using: the integration suite truncates between tests.
Usage: python3 scripts/mutate-migration-p1.py [M1-... ...]
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
OP = PROV + 'infrastructure/drizzle-operation.repository.ts'
SV = PROV + 'infrastructure/drizzle-service.repository.ts'
PR = PROV + 'application/provisioner.service.ts'
PS = PROV + 'application/provisioning.service.ts'

M = {
    'M1-require-provider-user-id': (
        SV,
        "          sql`NOT EXISTS (\n            SELECT 1 FROM ${provisioningOperations} AS sync",
        "          isNotNull(services.providerUserId),\n          sql`NOT EXISTS (\n"
        "            SELECT 1 FROM ${provisioningOperations} AS sync",
    ),
    'M2-no-background-claim-key': (
        OP,
        "        asc(provisioningOperations.background),\n"
        "        sql`${provisioningOperations.nextAttemptAt} ASC NULLS FIRST`,",
        "        sql`${provisioningOperations.nextAttemptAt} ASC NULLS FIRST`,",
    ),
    'M3-background-reserve-zero': (
        PR,
        'const reserve = operation.background ? this.deps.backgroundBudgetReserve : 0;',
        'const reserve = 0;',
    ),
    'M4-no-promotion': (
        PS,
        'if (open !== null && scheduled === null) return open;',
        'if (open !== null) return open;',
    ),
    'M5-no-cadence-exclusion': (
        SV,
        "AND (sync.state IN ('PLANNED', 'IN_FLIGHT') OR sync.created_at > ${staleBefore})",
        "AND (sync.state IN ('PLANNED', 'IN_FLIGHT'))",
    ),
    'M6-no-queue-cap': (
        PR,
        'if (room <= 0) return;\n'
        '      const stale = await this.deps.services.listUsageSyncDue(scope, staleBefore, room, tx);',
        'const stale = await this.deps.services.listUsageSyncDue(\n'
        '        scope, staleBefore, USAGE_SYNC_PLAN_LIMIT, tx);',
    ),
    'M7-planner-not-background': (PR, '            background: true,\n', ''),
    # Codex review of #172.
    'M8-cadence-from-created-at': (
        SV,
        'OR GREATEST(sync.created_at, sync.updated_at,\n'
        '                                COALESCE(sync.completed_at, sync.created_at)) > ${staleBefore})',
        'OR sync.created_at > ${staleBefore})',
    ),
    'M9-promotion-keeps-sweep-id': (
        OP,
        '.set({ background: false, requestedByCustomerId, operationId, updatedAt: now })',
        '.set({ background: false, requestedByCustomerId, updatedAt: now })',
    ),
    'M10-no-operator-replay': (
        PS,
        "    if (origin.requestedBy === 'OPERATOR') {\n"
        '      const replay = await this.deps.operations.findByOperationId(scope, operationId, tx);\n'
        '      if (replay !== null) return replay;\n'
        '    }\n',
        '',
    ),
    'M11-lost-race-returns-scheduled': (
        PS,
        '      if (promoted !== null) {\n'
        '        return this.recordRequest(scope, actor, service, type, origin, promoted, now, tx);\n'
        '      }\n',
        '      if (promoted === null) return scheduled;\n'
        '      return this.recordRequest(scope, actor, service, type, origin, promoted, now, tx);\n',
    ),
}

for name in sys.argv[1:] or list(M):
    path, old, new = M[name]
    src = open(path).read()
    assert src.count(old) == 1, (name, src.count(old))
    open(path, 'w').write(src.replace(old, new))
    try:
        out = subprocess.run(
            ['pnpm', 'vitest', 'run', '--project', 'integration',
             'tests/integration/usage-sync-priority.test.ts',
             '--hookTimeout', '600000', '--testTimeout', '300000'],
            cwd=W, env=env, capture_output=True, text=True, timeout=1200,
        ).stdout
    finally:
        open(path, 'w').write(src)
    print(name, [line.strip() for line in out.splitlines() if 'Tests ' in line], flush=True)
    for line in out.splitlines():
        if line.strip().startswith('×'):
            print('   ', line.strip()[:150], flush=True)
