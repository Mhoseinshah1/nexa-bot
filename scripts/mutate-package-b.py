"""Package B (mandatory channel membership) mutation driver (docs/package-b-falsification.md).

Reverts one rule at a time, runs the named tests, and restores the file with `git checkout`.
A mutation of `packages/contracts` rebuilds the package first, because the tests import its
`dist`, and rebuilds it again after the restore. Needs TEST_DATABASE_URL pointing at a
database nothing else is using, Redis on REDIS_URL, and a clean tree.
Usage: python3 scripts/mutate-package-b.py [B-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if 'TEST_DATABASE_URL' not in os.environ:
  sys.exit('TEST_DATABASE_URL is required')
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

CT='packages/contracts/src/settings.ts'
SVC='apps/api/src/modules/commerce/customers/application/channel-membership.service.ts'
RD='apps/api/src/modules/commerce/customers/infrastructure/telegram-chat-member.reader.ts'
BR='apps/api/src/surfaces/telegram/bot-runtime.ts'

T_I=('integration','tests/integration/channel-membership.test.ts')
T_U=('unit','tests/unit/channel-membership.test.ts')

# (id, [(file, before, after)], test, name filter)
M=[
 # --- membership truth (B2) --------------------------------------------------------------
 ('B-01',[(SVC,"return member.isMember === true ? { kind: 'MEMBER' } : { kind: 'NOT_MEMBER' };","return { kind: 'MEMBER' };")],T_U,'restricted as a member only'),
 ('B-02',[(SVC,"    case 'left':\n    case 'kicked':\n      return { kind: 'NOT_MEMBER' };","    case 'left':\n      return { kind: 'NOT_MEMBER' };\n    case 'kicked':\n      return { kind: 'MEMBER' };")],T_U,'left and kicked'),
 ('B-03',[(RD,"if (outcome.outcome !== 'SUCCEEDED') return { kind: 'UNKNOWN', code: outcome.errorCode };","if (outcome.outcome !== 'SUCCEEDED') return { kind: 'NOT_MEMBER' };")],T_U,'every failed call as unknown'),
 # --- the service (B1, B5, B6) -----------------------------------------------------------
 ('B-04',[(SVC,".filter((channel) => channel.mandatory);",";")],T_U,'never asks about an optional one'),
 ('B-05',[(SVC,"answers[index]?.kind === 'NOT_MEMBER'","answers[index]?.kind !== 'MEMBER'")],T_U,'fails open'),
 ('B-06',[(SVC,"    const last = this.unavailableRecordedAt.get(key);\n    if (last !== undefined && nowMs - last < CHANNEL_MEMBERSHIP_RECORD_INTERVAL_MS) return;\n","    const last = this.unavailableRecordedAt.get(key);\n")],T_U,'records the condition once a minute'),
 ('B-07',[(SVC,"    if (this.unavailableRecordedAt.has(key)) {\n      this.unavailableRecordedAt.delete(key);\n      await this.recordRecovery(scope, botInstanceId, channel);\n      return;\n    }\n","")],T_U,'recovers the condition on the next answer'),
 ('B-08',[(SVC,"    const last = this.outageLookedForAt.get(key);\n    if (last !== undefined && nowMs - last < CHANNEL_MEMBERSHIP_RECORD_INTERVAL_MS) return;\n","    const last = this.outageLookedForAt.get(key);\n")],T_U,'another process recorded'),
 ('B-09',[(SVC,"        ? CHANNEL_MEMBER_CACHE_MS\n","        ? CHANNEL_NOT_MEMBER_CACHE_MS\n")],T_U,'keeps a member about a minute'),
 ('B-10',[(SVC,"(!input.fresh || cached.answer.kind === 'MEMBER')","true")],T_U,'asks again for the check button'),
 ('B-11',[(SVC,"(!input.fresh || cached.answer.kind === 'MEMBER')","!input.fresh")],T_U,'asks again for the check button'),
 ('B-12',[(SVC,"const key = `${scope.tenantId}:${input.botInstanceId}:${identity}:${input.telegramUserId}`;","const key = `${scope.tenantId}:${identity}:${input.telegramUserId}`;")],T_U,'never serves one bot'),
 ('B-13',[(SVC,"const key = `${scope.tenantId}:${input.botInstanceId}:${identity}:${input.telegramUserId}`;","const key = `${input.botInstanceId}:${identity}:${input.telegramUserId}`;")],T_U,'never serves one bot'),
 # --- the setting (audit §2.1) -----------------------------------------------------------
 ('B-14',[(CT,"      !channel.mandatory || channel.handle !== undefined || channel.joinUrl !== undefined,","      true,")],T_U,'required channel a customer could not open'),
 ('B-15',[(CT,"return channel.chatId ?? (channel.handle as string);","return channel.handle ?? (channel.chatId as string);")],T_I,'asks about it by id'),
 ('B-16',[(CT,"/^https:\\/\\/t\\.me\\/[A-Za-z0-9_+\\-/]{1,200}$/","/^https:\\/\\/.+$/")],T_U,'not Telegram'),
 # --- the guard (B3, B4) -----------------------------------------------------------------
 ('B-17',[(BR,"        : await this.guardedAct(scope, actor, command, customer, arrival, input);","        : await this.act(scope, actor, command, customer, arrival, input);")],T_I,'missing one of two required channels'),
 ('B-18',[(BR,"new Set<BotIntent>(['SUPPORT', 'HELP'])","new Set<BotIntent>([])")],T_I,'lets support through'),
 ('B-19',[(BR,"      missing.length === 0 ||\n      (await this.deps.telegramAdmins?.resolve(scope, input.telegramUserId, actor.correlationId)) !=\n        null\n","      missing.length === 0\n")],T_I,'bound administrator'),
 ('B-20',[(BR,"      ? { intent: 'MAIN_MENU', targetId: null, callbackQueryId: command.callbackQueryId }\n      : command;","      ? command\n      : command;")],T_I,'answers the check button with the main menu'),
 ('B-21',[(BR,"      fresh: checking,\n","      fresh: false,\n")],T_I,'answers the check button with the main menu'),
]

def build_contracts():
  subprocess.run(['pnpm','--filter','@nexa/contracts','build'],capture_output=True,check=True)

only=sys.argv[1:]
for mid,edits,(project,test),filt in M:
  if only and mid not in only: continue
  files=set(); ok=True
  for f,a,b in edits:
    s=open(f).read()
    if s.count(a)!=1:
      print(mid,'ANCHOR MISSING in',f,s.count(a),flush=True); ok=False; break
    open(f,'w').write(s.replace(a,b)); files.add(f)
  contracts=any(f.startswith('packages/contracts') for f in files)
  if ok:
    if contracts: build_contracts()
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,failed[:3],flush=True)
  for f in files: subprocess.run(['git','checkout','--',f])
  if contracts: build_contracts()
