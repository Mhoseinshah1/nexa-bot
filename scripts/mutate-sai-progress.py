"""Roadmap A3–A6 mutation driver: progress guards, the handoff notice, the handoff's context,
the silent NO_ACTION.

Each mutation replaces ONE exact string, runs the named suites, and restores the file byte for
byte (also on an interrupt). Integration runs need TEST_DATABASE_URL/DATABASE_URL pointing at a
dedicated database. Usage: python3 scripts/mutate-sai-progress.py [index ...]
Results: docs/support-agent/tb7-falsification.md (roadmap A3–A6 section).
"""
import subprocess, sys, os, signal

# A killed run must still restore the file it mutated: SIGTERM unwinds through `finally`.
signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
G = 'apps/api/src/modules/control/support-ai/domain/auto-reply-guards.ts'
A = 'apps/api/src/modules/control/support-ai/application/support-auto-reply.service.ts'
R = 'apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai-job.repository.ts'
C = 'packages/contracts/src/business-chats.ts'
V = 'apps/api/src/modules/commerce/business-chats/application/business-conversation.service.ts'
L = 'apps/api/src/modules/commerce/business-chats/application/business-outbound.service.ts'
E = 'apps/api/src/modules/commerce/business-chats/application/business-escalation.service.ts'
D = 'apps/api/src/modules/commerce/business-chats/infrastructure/drizzle-business-conversation.repository.ts'
T = 'apps/api/src/modules/commerce/tickets/application/ticket.service.ts'
EV = 'apps/api/src/modules/control/support-ai/eval/runner.ts'

UNIT = 'pnpm exec vitest run --project unit tests/unit/support-progress-guards.test.ts'
INT = 'pnpm exec vitest run --project integration tests/integration/support-auto-reply.test.ts -t "roadmap A3"'
TB2 = 'pnpm exec vitest run --project integration tests/integration/business-conversations.test.ts'
EVAL = 'pnpm exec vitest run --project unit tests/unit/support-ai-eval.test.ts'

M = [
 ('«نشد» not failure feedback', G, "  /(?<!\\p{L})نشد(?:ه|ش)?(?!\\p{L})/u,\n", "", [UNIT, INT]),
 ('no_progress at 4, not 3', G,
  "return failureFeedbackRun(lines, since) >= SUPPORT_AI_NO_PROGRESS_LIMIT",
  "return failureFeedbackRun(lines, since) > SUPPORT_AI_NO_PROGRESS_LIMIT", [UNIT, INT]),
 ('another message does not end the run', G,
  "      if (!isFailureFeedback(line.text)) break;\n", "      if (!isFailureFeedback(line.text)) continue;\n", [UNIT, INT]),
 ('failures before any reply counted', G, "      afterReply += 1;\n", "      afterReply += 1;\n      counted += 1;\n", [UNIT]),
 ('the run reads past the epoch', G,
  "    if (since !== null && line.sentAt.getTime() < since.getTime()) break;\n", "", [UNIT, INT]),
 ('same message needs 4', G,
  "if (repeats >= SUPPORT_AI_INBOUND_FLOOD.sameMessage)", "if (repeats > SUPPORT_AI_INBOUND_FLOOD.sameMessage)", [UNIT, INT]),
 ('rate: 8 in a minute already a flood', G,
  "return recent > SUPPORT_AI_INBOUND_FLOOD.maxInbound", "return recent >= SUPPORT_AI_INBOUND_FLOOD.maxInbound", [UNIT]),
 ('rate not bounded by the epoch', G,
  "    since === null ? Number.NEGATIVE_INFINITY : since.getTime(),\n", "    Number.NEGATIVE_INFINITY,\n", [UNIT]),
 ('repeated advice never matches', G,
  "return adviceSimilarity(reply, earlier) >= SUPPORT_AI_REPEAT_SIMILARITY", "return adviceSimilarity(reply, earlier) > 1", [UNIT, INT]),
 ('greetings not exempt', G, "  if (decision.topic === 'GREETING') return PASS;\n", "", [UNIT, INT]),
 ('service: no_progress not applied', A,
  "if (!progress.pass) return this.handOff(scope, job, progress, null, null);", "void progress;", [INT]),
 ('service: flood not applied', A,
  "if (!flood.pass) return this.handOff(scope, job, flood, null, null);", "void flood;", [INT]),
 ('service: repeated advice not applied', A,
  "if (!repeated.pass) return this.handOff(scope, job, repeated, decision, produced, images);", "void repeated;", [INT]),
 ('notice never enqueued', V, "    await this.enqueueHandoffNotice(scope, moved, now, tx);\n", "", [INT, TB2]),
 ('notice sendable in any state', C,
  "  if (input.origin === 'HANDOFF_NOTICE') return input.conversationState === 'HANDOFF_REQUIRED';\n", "", [UNIT, INT]),
 ('mode OFF does not silence the notice', L,
  "const automatic = row.origin === 'AUTO' || row.origin === 'HANDOFF_NOTICE';", "const automatic = row.origin === 'AUTO';", [INT]),
 ('escalation ignores the recorded context', E,
  "        summary: input.detail.summary ?? context.summary,", "        summary: input.detail.summary,", [INT]),
 ('steps tried not recorded', E, "        stepsTried: context.stepsTried,", "        stepsTried: null,", [INT]),
 ('ticket gate leaks the topic', T, "            topic: null,\n", "", [INT]),
 ('intent not purged', D, "      .set({ summary: null, intent: null, textPurgedAt: now })", "      .set({ summary: null, textPurgedAt: now })", [INT]),
 ('NO_ACTION: any closing line is enough', G,
  "    input.customerTexts.every((text) => isClosingAcknowledgement(text))", "    input.customerTexts.some((text) => isClosingAcknowledgement(text))", [UNIT, INT]),
 ('NO_ACTION: allowlist skipped', G,
  "  if (!(config.autoTopics as readonly string[]).includes(decision.topic)) return false;\n", "", [UNIT, INT]),
 ('NO_ACTION: a question closes', G, "  if (text === null || /[?؟]/u.test(text)) return false;", "  if (text === null) return false;", [UNIT]),
 ('service: NO_ACTION always hands off', A,
  "if (autoNoActionAllowed({ decision, config, flags: context.flags, customerTexts })) {", "if (false) {", [INT]),
 # A10's runner applies the production guards (after the merge with PR #244).
 ('eval: progress guards not applied before the model', EV,
  "  if (prepared.failClosed || prepared.moneyHandoff || prepared.progressHandoff) {",
  "  if (prepared.failClosed || prepared.moneyHandoff) {", [EVAL]),
 ('eval: repeated advice not applied', EV,
  "      guardPassed = verdict.pass && autoRepeatedAdviceGuard(decision, prepared.lines, null).pass;",
  "      guardPassed = verdict.pass;", [EVAL]),
]

env = dict(os.environ)

def run(cmd):
    p = subprocess.run(cmd, cwd=ROOT, env=env, shell=True, capture_output=True, text=True, timeout=3600)
    out = p.stdout + p.stderr
    return [l.strip() for l in out.splitlines() if l.strip().startswith('×') or l.strip().startswith('Tests ')]

only = sys.argv[1:]
for i, (name, f, old, new, cmds) in enumerate(M):
    if only and str(i) not in only:
        continue
    path = os.path.join(ROOT, f)
    src = open(path).read()
    assert src.count(old) == 1, (name, src.count(old))
    open(path, 'w').write(src.replace(old, new))
    try:
        if f == C:
            subprocess.run('pnpm --filter @nexa/contracts build', cwd=ROOT, shell=True, capture_output=True)
        killed = []
        for c in cmds:
            killed += run(c)
        print('==', i, name, flush=True)
        for k in killed:
            print('   ', k, flush=True)
    finally:
        open(path, 'w').write(src)
        if f == C:
            subprocess.run('pnpm --filter @nexa/contracts build', cwd=ROOT, shell=True, capture_output=True)
