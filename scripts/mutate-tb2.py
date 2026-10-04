"""TB2 (conversations, human takeover, outbound lane) mutation driver
(docs/support-agent/tb2-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file with `git checkout`.
A mutation of `packages/contracts` rebuilds it before its test and again after the restore.
Needs a clean tree and the integration database (`bash scripts/dev-services.sh`).
Usage: python3 scripts/mutate-tb2.py [TB2-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

BC='packages/contracts/src/business-chats.ts'
SVC='apps/api/src/modules/commerce/business-chats/application/business-conversation.service.ts'
LANE='apps/api/src/modules/commerce/business-chats/application/business-outbound.service.ts'
REPO='apps/api/src/modules/commerce/business-chats/infrastructure/drizzle-business-conversation.repository.ts'
T_I=('integration','tests/integration/business-conversations.test.ts')

M=[
 ('TB2-01',[(BC,"  if (input.rowEpoch !== input.conversationEpoch) return false;\n","")],T_I,'R6'),
 ('TB2-02',[(BC,"  if (input.origin === 'AUTO') return input.conversationState === 'AI_ACTIVE';\n","")],T_I,'R1'),
 ('TB2-03',[(SVC,"            bumpEpoch: true,\n            takeoverReason: null,","            bumpEpoch: false,\n            takeoverReason: null,")],T_I,'R5'),
 ('TB2-04',[(SVC,"{ from: NOT_HUMAN, to: 'HUMAN_ACTIVE', bumpEpoch: true, takeoverReason: reason, now }","{ from: NOT_HUMAN, to: 'HUMAN_ACTIVE', bumpEpoch: false, takeoverReason: reason, now }")],T_I,'types by hand takes the conversation'),
 ('TB2-05',[(SVC,"const NOT_HUMAN: readonly BusinessConversationState[] = ['AI_ACTIVE', 'HANDOFF_REQUIRED', 'PAUSED'];","const NOT_HUMAN: readonly BusinessConversationState[] = ['AI_ACTIVE', 'HANDOFF_REQUIRED', 'PAUSED', 'HUMAN_ACTIVE'];"),(SVC,"    if (conversation.state === 'HUMAN_ACTIVE') return null;\n","")],T_I,'does not supersede the first'),
 ('TB2-06',[(SVC,"    const knownOwnMessage = await this.deps.outbound.isOwnMessage(scope, {","    const knownOwnMessage = false && await this.deps.outbound.isOwnMessage(scope, {")],T_I,'echo is recognised as ours'),
 ('TB2-07',[(LANE,"          if (row.origin === 'AUTO') {\n            await this.deps.control.handOff(\n              scope,\n              row.conversationId,\n              'SEND_OUTCOME_UNKNOWN',","          if (row.origin === 'NEVER') {\n            await this.deps.control.handOff(\n              scope,\n              row.conversationId,\n              'SEND_OUTCOME_UNKNOWN',")],T_I,'never resent, and hands'),
 ('TB2-08',[(REPO,"and(eq(customers.tenantId, tenantId), eq(customers.telegramUserId, telegramUserId))","eq(customers.telegramUserId, telegramUserId)")],T_I,'links the customer only by exact id'),
 ('TB2-09',[(SVC,"        const held = (await this.humanSignal(scope, conversation, reason, now, tx)) ?? conversation;","        const held = conversation;")],T_I,'operator’s send takes the conversation over'),
]

def build(pkg):
  subprocess.run(['pnpm','--filter',pkg,'build'],capture_output=True,check=True)

def rebuild(files):
  if any(f.startswith('packages/contracts') for f in files):
    build('@nexa/contracts'); build('@nexa/i18n')

only=sys.argv[1:]
for mid,edits,(project,test),filt in M:
  if only and mid not in only: continue
  files=set(); ok=True
  for f,a,b in edits:
    s=open(f).read()
    if s.count(a)!=1:
      print(mid,'ANCHOR MISSING in',f,s.count(a),flush=True); ok=False; break
    open(f,'w').write(s.replace(a,b)); files.add(f)
  if ok:
    rebuild(files)
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,failed[:3],flush=True)
  for f in files: subprocess.run(['git','checkout','--',f])
  rebuild(files)
