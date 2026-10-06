"""Hotfix 2026-10-06 mutation driver: automatic clarifying questions.

Each mutation replaces ONE exact string, runs the named suite, and restores the file byte for
byte. Integration runs need TEST_DATABASE_URL/DATABASE_URL pointing at a dedicated database.
Usage: python3 scripts/mutate-clarifying.py [index ...]
Results: docs/support-agent/tb7-falsification.md (hotfix section).
"""
import subprocess, sys, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
G = 'apps/api/src/modules/control/support-ai/domain/auto-reply-guards.ts'
R = 'apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai-job.repository.ts'
S = 'apps/api/src/modules/control/support-ai/application/support-ai-config.service.ts'
A = 'apps/api/src/modules/control/support-ai/application/support-auto-reply.service.ts'
C = 'packages/contracts/src/support-ai.ts'
W = 'apps/web/src/pages/support-ai.tsx'

M = [
 ('guard: only REPLY again', G,
  "if (decision.decision !== 'REPLY' && decision.decision !== 'ASK_CLARIFYING_QUESTION') {",
  "if (decision.decision !== 'REPLY') {", 'int'),
 ('allowlist skipped for ASK', G,
  "if (!(config.autoTopics as readonly string[]).includes(decision.topic)) {",
  "if (decision.decision === 'REPLY' && !(config.autoTopics as readonly string[]).includes(decision.topic)) {", 'int'),
 ('hard topic skipped for ASK', G,
  "if ((SUPPORT_AI_HANDOFF_TOPICS as readonly string[]).includes(decision.topic)) {",
  "if (decision.decision === 'REPLY' && (SUPPORT_AI_HANDOFF_TOPICS as readonly string[]).includes(decision.topic)) {", 'int'),
 ('confidence skipped for ASK', G,
  "if (CONFIDENCE_RANK[decision.confidence] < CONFIDENCE_RANK[config.autoMinConfidence]) {",
  "if (decision.decision === 'REPLY' && CONFIDENCE_RANK[decision.confidence] < CONFIDENCE_RANK[config.autoMinConfidence]) {", 'unit'),
 ('empty question allowed', G,
  "    reply === '' ||\n",
  "    (reply === '' && decision.decision === 'REPLY') ||\n", 'unit'),
 ('grounding skipped for ASK', G,
  "    decision.factRefs.some((ref) => !input.knownAliases.has(ref)) ||",
  "    (decision.decision === 'REPLY' && decision.factRefs.some((ref) => !input.knownAliases.has(ref))) ||", 'int'),
 ('knowledge refs unchecked', G,
  "    decision.knowledgeRefs.some((ref) => !input.knownKnowledgeAliases.has(ref))",
  "    false", 'int'),
 ('identity skipped for ASK', G,
  "    !flags.identityLinked &&\n",
  "    decision.decision === 'REPLY' && !flags.identityLinked &&\n", 'int'),
 ('account review skipped for ASK', G,
  "if (flags.hasUnderReviewPayment || flags.hasUnreconciledService) {",
  "if (decision.decision === 'REPLY' && (flags.hasUnderReviewPayment || flags.hasUnreconciledService)) {", 'unit'),
 ('limit off by one (>)', G,
  "input.clarifyingStreak >= config.maxConsecutiveClarifyingQuestions",
  "input.clarifyingStreak > config.maxConsecutiveClarifyingQuestions", 'int'),
 ('streak never counts', G,
  "if (row.decision === 'ASK_CLARIFYING_QUESTION') streak += 1;",
  "if (row.decision === 'ASK_CLARIFYING_QUESTION') streak += 0;", 'int'),
 ('REPLY does not reset', G,
  "else if (row.decision === 'REPLY') break;",
  "else if (row.decision === 'REPLY') continue;", 'int'),
 ('epoch filter removed', R,
  "          eq(businessOutboundMessages.controlEpoch, input.epoch),\n",
  "", 'int'),
 ('FAILED/SUPERSEDED counted', R,
  "inArray(businessOutboundMessages.state, ['PENDING', 'DELIVERED', 'UNCONFIRMED'])",
  "inArray(businessOutboundMessages.state, ['PENDING', 'DELIVERED', 'UNCONFIRMED', 'FAILED', 'SUPERSEDED'])", 'int'),
 ('join by conversation, not by the sent row (double count)', R,
  "          eq(supportAiJobs.sentOutboundId, businessOutboundMessages.id),",
  "          eq(supportAiJobs.conversationId, businessOutboundMessages.conversationId),", 'int'),
 ('recheck in tx ignores the streak', A,
  "            clarifyingStreak: await this.deps.jobs.clarifyingStreak(\n              scope,\n              { conversationId: job.conversationId, epoch: job.controlEpoch ?? -1 },\n              tx,\n            ),",
  "            clarifyingStreak: 0,", 'int'),
 ('sent_clarifying not recorded', A,
  "decision.decision === 'ASK_CLARIFYING_QUESTION' ? 'sent_clarifying' : 'sent';",
  "decision.decision === 'ASK_CLARIFYING_QUESTION' ? 'sent' : 'sent';", 'int'),
 ('widening not charged', S,
  "              next.maxConsecutiveClarifyingQuestions > prev.maxConsecutiveClarifyingQuestions ||\n",
  "", 'int'),
 ('default 3 instead of 2', C,
  "maxConsecutiveClarifyingQuestions: { min: 1, max: 10, default: 2 },",
  "maxConsecutiveClarifyingQuestions: { min: 1, max: 10, default: 3 },", 'unit+int'),
 ('web: no widening warning', W,
  "    (draft.mode === 'AUTO_REPLY_SAFE' &&\n      toNumber(draft.maxConsecutiveClarifyingQuestions) >\n        response.config.maxConsecutiveClarifyingQuestions);",
  "    false;", 'web'),
 # Review of PR #228.
 ('N1: PENDING rows not counted', R,
  "inArray(businessOutboundMessages.state, ['PENDING', 'DELIVERED', 'UNCONFIRMED'])",
  "inArray(businessOutboundMessages.state, ['DELIVERED', 'UNCONFIRMED'])", 'int'),
 ('N4: an absent limit saved as the default', S,
  "            command.config.maxConsecutiveClarifyingQuestions ??\n            before.config.maxConsecutiveClarifyingQuestions,",
  "            command.config.maxConsecutiveClarifyingQuestions ?? 2,", 'int'),
 ('N7: invisible-only text not treated as empty', G,
  "    reply.replace(INVISIBLE_MARKS, '').trim() === '' ||",
  "    reply === '' ||", 'unit'),
]

env = dict(os.environ)

def run(cmd):
    p = subprocess.run(cmd, cwd=ROOT, env=env, shell=True, capture_output=True, text=True, timeout=1200)
    out = p.stdout + p.stderr
    fails = [l.strip() for l in out.splitlines() if l.strip().startswith('×')]
    summary = [l.strip() for l in out.splitlines() if l.strip().startswith('Tests ')]
    return p.returncode, fails, summary

only = sys.argv[1:]
results = []
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
            cmds.append("pnpm exec vitest run --project integration tests/integration/support-auto-reply.test.ts")
        if kind == 'web':
            cmds.append('pnpm exec vitest run --project web tests/web/support-ai-clarifying.test.tsx')
        killed = []
        for c in cmds:
            code, fails, summary = run(c)
            killed += fails
            killed += summary
        results.append((name, killed))
        print('==', name, flush=True)
        for k in killed:
            print('   ', k, flush=True)
    finally:
        open(path, 'w').write(src)
        if f == C:
            subprocess.run('pnpm --filter @nexa/contracts build', cwd=ROOT, shell=True, capture_output=True)
