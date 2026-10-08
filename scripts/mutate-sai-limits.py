"""Roadmap A1/A2 mutation driver: the session reply budget, the hourly limit, the clarifying default.

Each mutation replaces ONE exact string, runs the named suites, and restores the file byte for
byte. Integration runs need TEST_DATABASE_URL/DATABASE_URL pointing at a dedicated database.
Usage: python3 scripts/mutate-sai-limits.py [index ...]
Results: docs/support-agent/tb7-falsification.md (roadmap A1/A2 section).
"""
import subprocess, sys, os, signal

# A killed run must still restore the file it mutated: SIGTERM unwinds through `finally`.
signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
G = 'apps/api/src/modules/control/support-ai/domain/auto-reply-guards.ts'
R = 'apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai-job.repository.ts'
S = 'apps/api/src/modules/control/support-ai/application/support-ai-config.service.ts'
A = 'apps/api/src/modules/control/support-ai/application/support-auto-reply.service.ts'
C = 'packages/contracts/src/support-ai.ts'
W = 'apps/web/src/pages/support-ai.tsx'

INT_FILE = 'tests/integration/support-auto-reply.test.ts'
INT_FILTER = '-t "roadmap A1|hotfix|loop guard|per window|stops when|nit:|N1:|N3:|rolling deploy"'

M = [
 ('budget off by one (>)', G,
  "if (input.sessionReplies >= input.sessionReplyBudget) return fail('consecutive', 'LOOP_GUARD');",
  "if (input.sessionReplies > input.sessionReplyBudget) return fail('consecutive', 'LOOP_GUARD');", 'unit+int'),
 ('GREETING counted in the session', R,
  "        AND epoch_rows.free IS NOT TRUE\n",
  "", 'int'),
 ('no inactivity reset', R,
  "      WHERE (session.started IS NULL OR epoch_rows.created_at >= session.started)\n",
  "      WHERE true\n", 'int'),
 ('`now` not activity', R,
  "        UNION ALL\n        SELECT ${input.now.toISOString()}::timestamptz\n",
  "", 'int'),
 ('session not bound to the epoch', R,
  "          AND ${o.controlEpoch} = ${input.epoch}\n",
  "", 'int'),
 ('unknown topic treated as GREETING', R,
  "        AND epoch_rows.free IS NOT TRUE\n",
  "        AND epoch_rows.free IS NOT FALSE\n", 'int'),
 ('hourly limit a constant 30', A,
  "      maxPerWindow: config.maxAutoRepliesPerHour,",
  "      maxPerWindow: 30,", 'int'),
 ('session budget a constant 20', A,
  "      sessionReplyBudget: config.sessionReplyBudget,",
  "      sessionReplyBudget: 20,", 'int'),
 ('widening the budget not charged', S,
  "            (next.sessionReplyBudget > prev.sessionReplyBudget ||\n",
  "            (false ||\n", 'int'),
 ('widening the hourly limit not charged', S,
  "              next.maxAutoRepliesPerHour > prev.maxAutoRepliesPerHour ||\n",
  "", 'int'),
 ('an absent budget saved as the default', S,
  "command.config.sessionReplyBudget ?? before.config.sessionReplyBudget,",
  "command.config.sessionReplyBudget ?? 20,", 'int'),
 ('A2: a GREETING reply resets the streak', G,
  "else if (row.decision === 'REPLY' && row.topic !== 'GREETING') break;",
  "else if (row.decision === 'REPLY') break;", 'unit+int'),
 ('A2: default back to 2', C,
  "maxConsecutiveClarifyingQuestions: { min: 1, max: 10, default: 3 },",
  "maxConsecutiveClarifyingQuestions: { min: 1, max: 10, default: 2 },", 'unit+int'),
 ('A1: default budget 4', C,
  "sessionReplyBudget: { min: 5, max: 40, default: 20 },",
  "sessionReplyBudget: { min: 5, max: 40, default: 4 },", 'unit+int'),
 ('web: no widening warning for the budget', W,
  "        toNumber(draft.sessionReplyBudget) >\n          (response.config.sessionReplyBudget ?? Number.POSITIVE_INFINITY) ||\n",
  "", 'web'),
 ('web: no widening warning for the hour', W,
  "        toNumber(draft.maxAutoRepliesPerHour) >\n          (response.config.maxAutoRepliesPerHour ?? Number.POSITIVE_INFINITY)));",
  "        false));", 'web'),
 # Review of PR #241.
 ('N1: greetings read by the streak query (then the bounded read loses the questions)', R,
  "          sql`${supportAiJobs.topic} IS DISTINCT FROM 'GREETING'`,\n",
  "", 'int'),
 ('N3: a greeting is free at any length', R,
  "            AND char_length(${o.body}) <= ${SUPPORT_AI_FREE_GREETING_MAX_CHARS}) AS free",
  ") AS free", 'int'),
 # (A first version only dropped `IS NOT NULL`: equivalent, since char_length(NULL) is NULL and
 # a NULL `free` counts. This one makes a purged body read as length 0.)
 ('N3: a purged greeting is free', R,
  "          (${j.topic} = 'GREETING' AND ${o.body} IS NOT NULL\n            AND char_length(${o.body})",
  "          (${j.topic} = 'GREETING'\n            AND coalesce(char_length(${o.body}), 0)", 'int'),
 ('rolling deploy: the retired limit not projected', S,
  "        maxConsecutiveReplies:\n          stored.retiredMaxConsecutiveReplies ?? SUPPORT_AI_RETIRED_MAX_CONSECUTIVE_REPLIES_DEFAULT,\n",
  "", 'int'),
 ('N5: an absent limit sent as NaN', W,
  "  return draft.absent.includes(field) && draft[field].trim() === ''",
  "  return false", 'web'),
]

env = dict(os.environ)

def run(cmd):
    p = subprocess.run(cmd, cwd=ROOT, env=env, shell=True, capture_output=True, text=True, timeout=1800)
    out = p.stdout + p.stderr
    fails = [l.strip() for l in out.splitlines() if l.strip().startswith('×')]
    summary = [l.strip() for l in out.splitlines() if l.strip().startswith('Tests ')]
    return p.returncode, fails, summary

only = sys.argv[1:]
for i, (name, f, old, new, kind) in enumerate(M):
    if only and str(i) not in only:
        continue
    path = os.path.join(ROOT, f)
    src = open(path).read()
    assert src.count(old) == 1, (name, src.count(old))
    open(path, 'w').write(src.replace(old, new))
    try:
        if f == C:
            subprocess.run('pnpm --filter @nexa/contracts build', cwd=ROOT, shell=True, capture_output=True)
        cmds = []
        if 'unit' in kind:
            cmds.append('pnpm exec vitest run --project unit tests/unit/support-auto-reply-guards.test.ts')
        if 'int' in kind:
            cmds.append(f'pnpm exec vitest run --project integration {INT_FILE} {INT_FILTER}')
        if kind == 'web':
            cmds.append('pnpm exec vitest run --project web tests/web/support-ai-limits.test.tsx')
        killed = []
        for c in cmds:
            code, fails, summary = run(c)
            killed += fails + summary
        print('==', i, name, flush=True)
        for k in killed:
            print('   ', k, flush=True)
    finally:
        open(path, 'w').write(src)
        if f == C:
            subprocess.run('pnpm --filter @nexa/contracts build', cwd=ROOT, shell=True, capture_output=True)
