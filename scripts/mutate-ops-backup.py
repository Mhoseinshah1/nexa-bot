"""Mutation driver for spec sections 12-14: the ops log topics, backup delivery into the
operations group's backups topic, the Web Admin schedule and the scheduler's health.

Reverts one rule at a time, runs the named tests, expects them to FAIL, and restores the
file byte for byte from a copy. A mutation of packages/contracts rebuilds the package
before its test and after the restore, because the tests import its dist. The
integration rows need TEST_DATABASE_URL pointing at a database nothing else is using.

Usage: python3 scripts/mutate-ops-backup.py [name-substring ...]
Every row printed KILLED is a rule a test pins; SURVIVED is a rule with no test.
"""
import os
import shutil
import subprocess
import sys

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if 'TEST_DATABASE_URL' not in os.environ:
    sys.exit('TEST_DATABASE_URL is required (a database nothing else is using)')
ENV = dict(os.environ)

SCHED = 'apps/api/src/modules/platform/backup/application/backup-scheduler.ts'
ROUTED = 'apps/api/src/modules/platform/backup/application/routed-backup-delivery.ts'
SERVICE = 'apps/api/src/modules/platform/backup/application/backup.service.ts'
OPS = 'apps/api/src/modules/control/ops-group/application/ops-group.service.ts'
CONTRACT = 'packages/contracts/src/ops-log-group.ts'
TG = 'apps/api/src/modules/platform/backup/infrastructure/telegram-backup-delivery.ts'
TOPIC = 'apps/api/src/modules/control/ops-group/application/backup-topic.ts'
CARD = 'apps/web/src/pages/backup-schedule.tsx'

MUTATIONS = [
    ('no immediate tick on start', SCHED, '    void this.tick();\n  }', '  }',
     'unit', ['tests/unit/backup-pipeline.test.ts']),
    ('no startup grace', SCHED, '    this.progress.begin(this.deps.clock.now().getTime());\n', '',
     'unit', ['tests/unit/backup-pipeline.test.ts']),
    ('no in-process tick guard', SCHED, '    if (this.ticking) return;\n', '',
     'unit', ['tests/unit/backup-pipeline.test.ts']),
    ('in-flight run judged by elapsed time, not heartbeat', SCHED,
     'Math.max(this.runStartedAt, this.deps.runHeartbeatAt() ?? 0)', 'this.runStartedAt',
     'unit', ['tests/unit/backup-pipeline.test.ts']),
    ('in-flight run always fresh', SCHED,
     'return nowMs - beat <= this.deps.runStaleAfterMs;', 'return true;',
     'unit', ['tests/unit/backup-pipeline.test.ts']),
    ('service lease not exposed during a run', SERVICE,
     '    this.leaseRefreshedAt = startedAt.getTime();\n', '',
     'unit', ['tests/unit/backup-pipeline.test.ts']),
    ('throwing route not caught (Codex 1)', ROUTED,
     '      route = await this.deps.opsGroup.route(scope, null);\n    } catch (error) {\n',
     '      route = await this.deps.opsGroup.route(scope, null);\n    } catch (error) {\n      throw error;\n',
     'unit', ['tests/unit/backup-routed-delivery.test.ts']),
    ('unusable group still routed (Codex 2)', ROUTED,
     "    if (standing.kind === 'UNUSABLE') return this.fallback(standing);\n", '',
     'unit', ['tests/unit/backup-routed-delivery.test.ts']),
    ('PROBLEM health ignored by the adapter (Codex 2)', TOPIC,
     "    if (binding.health === 'PROBLEM') {", '    if (false) {',
     'integration', ['tests/integration/ops-log-group.test.ts']),
    ('describe ignores standing (Codex 3)', ROUTED,
     "    if (standing?.kind === 'USABLE') return 'OPS_GROUP_TOPIC';",
     "    if (standing !== null && standing.kind !== 'NOT_CONNECTED') return 'OPS_GROUP_TOPIC';",
     'unit', ['tests/unit/backup-routed-delivery.test.ts']),
    ('settings read failure hidden (Codex 4)', CARD,
     '      {mayView && !settings.isSuccess && <StateSwitch query={settings}>{null}</StateSwitch>}\n', '',
     'web', ['tests/web/backup-schedule.test.tsx']),
    ('schedule switch ignored', SCHED, '      if (!schedule.enabled) {', '      if (false) {',
     'unit', ['tests/unit/backup-pipeline.test.ts']),
    ('schedule interval ignored', SCHED,
     'last.getTime() + schedule.intervalMs', 'last.getTime() + 24 * 3_600_000',
     'unit', ['tests/unit/backup-pipeline.test.ts']),
    ('dedicated chat before the group', ROUTED,
     "    if (standing.kind === 'NOT_CONNECTED') return this.fallback(null);",
     "    if (this.deps.dedicated.configured || standing.kind === 'NOT_CONNECTED') return this.fallback(null);",
     'unit', ['tests/unit/backup-routed-delivery.test.ts']),
    ('resend after any failure', ROUTED,
     "attempt.state === 'FAILED_DEFINITIVE' && attempt.topicMissing === true",
     "attempt.state !== 'SUCCEEDED'", 'unit', ['tests/unit/backup-routed-delivery.test.ts']),
    ('no resend after deleted topic', ROUTED,
     "attempt.state === 'FAILED_DEFINITIVE' && attempt.topicMissing === true", 'false',
     'unit', ['tests/unit/backup-routed-delivery.test.ts']),
    ('resolution throw fails the run', SERVICE,
     '      resolution = await this.resolveDelivery();\n    } catch (error) {',
     '      resolution = await this.resolveDelivery();\n    } catch (error) {\n      throw error;',
     'unit', ['tests/unit/backup-pipeline.test.ts']),
    ('channel throw fails the run', SERVICE,
     "      return {\n        state: 'OUTCOME_UNKNOWN',\n        detail: `The delivery did not complete:",
     "      throw error;\n      return {\n        state: 'OUTCOME_UNKNOWN',\n        detail: `The delivery did not complete:",
     'unit', ['tests/unit/backup-pipeline.test.ts']),
    ('topicMissing on a direct chat', TG,
     '        this.options.messageThreadId !== undefined &&\n        this.options.messageThreadId !== null &&\n', '',
     'unit', ['tests/unit/backup-delivery.test.ts']),
    ('refund routed to services', CONTRACT,
     "  { prefix: 'order.refunded_undeliverable', category: 'PAYMENTS' },\n", '',
     'unit', ['tests/unit/ops-log-group.test.ts']),
    ('backups not routed', CONTRACT, "  { prefix: 'backup.', category: 'BACKUPS' },\n", '',
     'unit', ['tests/unit/ops-log-group.test.ts']),
    ('healthy group owes nothing', OPS,
     '      const owed = await this.provisionOwed(scope, actor, group);',
     "      const owed = 'NONE' as 'NONE' | 'CREATED' | 'FAILED';",
     'integration', ['tests/integration/ops-log-group.test.ts']),
    ('refused owed topic retried every pass', OPS,
     "        await this.deps.repository.markHealthyForRecheck(scope, { now: this.deps.clock.now() });\n        return 'FAILED';\n      }\n      if (ensured.kind === 'READY' && ensured.created) created = true;",
     "        return 'FAILED';\n      }\n      if (ensured.kind === 'READY' && ensured.created) created = true;",
     'integration', ['tests/integration/ops-log-group.test.ts']),
]

only = sys.argv[1:]
results = []
for name, path, old, new, project, tests in MUTATIONS:
    if only and not any(o in name for o in only):
        continue
    src = open(path).read()
    assert src.count(old) == 1, f'{name}: anchor found {src.count(old)} times'
    shutil.copy(path, path + '.orig')
    try:
        open(path, 'w').write(src.replace(old, new))
        if path.startswith('packages/contracts'):
            subprocess.run(['pnpm', '--filter', '@nexa/contracts', 'build'], capture_output=True)
        proc = subprocess.run(['pnpm', 'vitest', 'run', '--project', project, *tests],
                              capture_output=True, text=True, env=ENV)
        failed = proc.returncode != 0
        results.append((name, 'KILLED' if failed else 'SURVIVED'))
    finally:
        shutil.move(path + '.orig', path)
        if path.startswith('packages/contracts'):
            subprocess.run(['pnpm', '--filter', '@nexa/contracts', 'build'], capture_output=True)
    print(results[-1], flush=True)

print('\n'.join(f'{state:9} {name}' for name, state in results))
