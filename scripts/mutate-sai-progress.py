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
TR = 'apps/api/src/modules/control/support-ai/domain/transcript.ts'
HC = 'apps/api/src/modules/control/support-ai/application/support-handoff-context.ts'
AN = 'packages/contracts/src/support-analytics.ts'

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
 ('failures counted one by one, not in rounds', G, "      pending = true;\n", "      pending = true;\n      rounds += 1;\n", [UNIT]),
 ('the run reads past the epoch', G,
  "    if (since !== null && line.sentAt.getTime() < since.getTime()) break;\n", "", [UNIT, INT]),
 ('same message needs 4', G,
  "if (repeats >= SUPPORT_AI_INBOUND_FLOOD.sameMessage)", "if (repeats > SUPPORT_AI_INBOUND_FLOOD.sameMessage)", [UNIT, INT]),
 ('rate: 8 in a minute already a flood', G,
  "return recent.length > SUPPORT_AI_INBOUND_FLOOD.maxInbound", "return recent.length >= SUPPORT_AI_INBOUND_FLOOD.maxInbound", [UNIT]),
 ('rate not bounded by the epoch', G,
  "    since === null ? Number.NEGATIVE_INFINITY : since.getTime(),\n", "    Number.NEGATIVE_INFINITY,\n", [UNIT]),
 ('repeated advice never matches', G,
  "return repeatsEarlierAdvice(decision.replyText, earlier)", "return false && repeatsEarlierAdvice(decision.replyText, earlier)", [UNIT, INT]),
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
  "    (config.autoTopics as readonly string[]).includes(decision.topic) &&\n", "", [UNIT, INT]),
 ('NO_ACTION: a question closes', G, "  if (text === null || QUESTION_MARKS.test(text)) return false;", "  if (text === null) return false;", [UNIT]),
 ('service: NO_ACTION always hands off', A,
  "if (autoNoActionAllowed({ decision, config, flags: context.flags, customerTexts })) {", "if (false) {", [INT]),
 # A10's runner applies the production guards (after the merge with PR #244).
 ('eval: progress guards not applied before the model', EV,
  "  if (prepared.failClosed || prepared.moneyHandoff || prepared.progressHandoff) {",
  "  if (prepared.failClosed || prepared.moneyHandoff) {", [EVAL]),
 ('eval: repeated advice not applied', EV,
  "      guardPassed = verdict.pass && autoRepeatedAdviceGuard(decision, prepared.lines, null).pass;",
  "      guardPassed = verdict.pass;", [EVAL]),
 # Review of PR #246.
 ('CX3: any OWN_ECHO is AI advice (no_progress)', G,
  "    } else if (line.author === 'AI_AUTO') {", "    } else if (line.origin === 'OWN_ECHO') {", [UNIT]),
 ('CX3: any OWN_ECHO is AI advice (repeated_advice)', G,
  "        line.author === 'AI_AUTO' &&", "        line.origin === 'OWN_ECHO' &&", [UNIT]),
 ('m7: every reply is a round, failure or not', G,
  "      if (pending) rounds += 1;", "      rounds += 1;", [UNIT, INT]),
 ('m1: a closing acknowledgement can be a flood', G,
  "  if (key !== '' && !isClosingAcknowledgement(newest.text)) {", "  if (key !== '') {", [UNIT, INT]),
 ('m1: repeats counted over the whole epoch', G,
  "    const repeats = recent.filter(", "    const repeats = inbound.filter(", [UNIT]),
 ('m9: similar is enough (a correction is a repeat)', G,
  "      sameTokens(words, tokenSet(text))", "      true", [UNIT]),
 # EQUIVALENT by construction, kept so a re-run shows it: no question word is closing vocabulary,
 # so `words.every(known)` refuses one too. The check is a second line of defence for a softener
 # added later; the unit cases «کی درست شد», «چطور وصل شد», «why ok» pin the behaviour.
 ('m2: question words ignored (EQUIVALENT)', G,
  "  if (words.some((word) => QUESTION_WORDS.has(word))) return false;\n", "", [UNIT]),
 ('m2: a bare status word closes', G,
  "  return thanked || completed;", "  return thanked || words.some((word) => STATUS_WORDS.has(word));", [UNIT]),
 ('m2: only ASCII and Arabic question marks', G,
  "const QUESTION_MARKS = /[?؟？⁇⁈⁉❓❔]/u;", "const QUESTION_MARKS = /[?؟]/u;", [UNIT]),
 ('CX2: silence not decided again in the transaction', A,
  "      if (!verdict.pass) {\n        return this.handOffChecked(scope, job, verdict, decision, produced, now, tx);",
  "      if (false) {\n        return this.handOffChecked(scope, job, verdict, decision, produced, now, tx);", [INT]),
 ('CX2: the mode not read again', A,
  "      if (config.mode !== 'AUTO_REPLY_SAFE') {\n        return this.finish(scope, job, 'dropped_mode', now, tx, { decision, produced });\n      }\n      const conversation",
  "      const conversation", [INT]),
 ('CX1: a silent close stamps no answer', A,
  "      await this.deps.conversations.touch(scope, conversation.id, { lastAiAt: now, now }, tx);\n", "", [INT]),
 ('CX4: the notice echo is read by the model', TR,
  "  messages = messages.filter((message) => !notices.has(message.telegramMessageId));\n", "", [INT]),
 ('CX5: steps tried counts undelivered attempts', HC, "          deliveredOnly: true,", "          deliveredOnly: false,", [INT]),
 ('M1: context from any epoch', R,
  "          eq(supportAiJobs.controlEpoch, input.epoch),\n          isNotNull(supportAiJobs.decision),\n          gte(",
  "          isNotNull(supportAiJobs.decision),\n          gte(", [INT]),
 ('M1: context past the retention copied', R, "          gte(supportAiJobs.createdAt, retained),\n", "", [INT]),
 ('M1: a copy purged by its own age only', D,
  "          sql`least(${businessConversationEscalations.contextFrom}, ${businessConversationEscalations.createdAt}) < ${cutoff}`,",
  "          sql`${businessConversationEscalations.createdAt} < ${cutoff}`,", [INT]),
 ('m4: the notice ignores the connection', V,
  "    if (connection === null || connection.status !== 'ACTIVE') return;\n    const key = `handoff-notice:",
  "    if (connection === null) return;\n    const key = `handoff-notice:", [INT]),
 ('m4: a blank render is sent', L, "        if (text.trim() === '') {", "        if (false) {", [INT]),
 ('m4: a delivered notice stamps lastHumanAt', L,
  "                  { lastMessageAt: repliedAt, now }", "                  { lastMessageAt: repliedAt, lastHumanAt: repliedAt, now }", [INT]),
 ('m5: an intent-only row not selected for purge', D, "            isNotNull(businessConversationEscalations.intent),\n", "", [INT]),
 ('m6: the deciding intent dropped (the previous one shows)', A,
  "        intent: decision === null || decision.intent.trim() === '' ? null : decision.intent,",
  "        intent: null,", [INT]),
 ('n3: a stale notice still sent', L,
  "        row.origin === 'HANDOFF_NOTICE' &&\n        now.getTime() - row.createdAt.getTime() > SUPPORT_AI_AUTO_STALE_SECONDS * 1000",
  "        row.origin === 'HANDOFF_NOTICE' &&\n        false", [INT]),
 ('m8: an unknown guard outcome is DROPPED', AN,
  "      if (code.startsWith('guard_') || code.startsWith('handoff_')) return 'HANDED_OFF';\n", "", [UNIT]),
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
        if f.startswith('packages/contracts'):
            subprocess.run('pnpm --filter @nexa/contracts build', cwd=ROOT, shell=True, capture_output=True)
        killed = []
        for c in cmds:
            killed += run(c)
        print('==', i, name, flush=True)
        for k in killed:
            print('   ', k, flush=True)
    finally:
        open(path, 'w').write(src)
        if f.startswith('packages/contracts'):
            subprocess.run('pnpm --filter @nexa/contracts build', cwd=ROOT, shell=True, capture_output=True)
