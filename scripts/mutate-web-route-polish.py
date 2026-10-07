"""Web route polish (roadmap B1-B4, B7) mutation driver (docs/web-redesign/route-audit.md).

Reverts one rule at a time, runs the named web test, and restores the file from the copy it
read. A mutant is KILLED only when a named test FAILED.
Usage: python3 scripts/mutate-web-route-polish.py [WRP-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

W='apps/web/src/'
REC=W+'pages/recovery.tsx'
BSC=W+'pages/backup-schedule.tsx'
T_REC='tests/web/recovery.test.tsx'
T_MC='tests/web/mutation-consistency.test.tsx'
FOC=W+'ui/focusable.ts'
OVL=W+'ui/overlays.tsx'
T_KIT='tests/web/kit.test.tsx'
SUB=W+'submission-key.ts'
INC=W+'pages/incidents.tsx'
T_SUB='tests/web/submission-key.test.tsx'
T_INC='tests/web/incidents.test.tsx'
RTR=W+'router.ts'
APP=W+'app.tsx'
T_RTR='tests/web/router.test.tsx'
RKT=W+'pages/recovery-kit.tsx'
T_SHELL='tests/web/shell-recovery.test.tsx'
LS=W+'ui/list-search.tsx'
ORD=W+'pages/orders.tsx'
REF=W+'pages/referrals.tsx'
T_LP='tests/web/list-polish.test.tsx'
T_RB='tests/web/referral-banner.test.tsx'

M=[
 # --- B3: one idempotency key per logical attempt -------------------------------------------
 ('WRP-01',[(REC,"idempotencyKey: runNowKey.current('run-now')","idempotencyKey: crypto.randomUUID()")],T_REC,'automatic retry of a 5xx'),
 ('WRP-02',[(REC,"onError: (error) => runNowKey.settleOn(error),","onError: () => runNowKey.settle(),")],T_REC,'presses again after an unanswered'),
 ('WRP-03',[(REC,"    onSuccess: () => {\n      runNowKey.settle();","    onSuccess: () => {\n")],T_REC,'once one has succeeded'),
 ('WRP-04',[(BSC,"save.mutate({ ...command, idempotencyKey: keyFor(row.key).current(command) });","save.mutate({ ...command, idempotencyKey: newIdempotencyKey() });")],T_MC,'never from newIdempotencyKey'),
 ('WRP-05',[(BSC,"    }) => saveSetting(command),","    }) => saveSetting({ ...command, idempotencyKey: newIdempotencyKey() }),")],T_MC,'never minted inside a mutationFn'),
 # --- B7: focus traps stack, and only reachable controls count --------------------------------
 ('WRP-06',[(FOC,"for (const entry of traps) if (top === undefined || entry.rank > top.rank) top = entry;","for (const entry of traps) top = entry;\n  void top;\n  return traps.some((entry) => entry.token === token);")],T_KIT,'innermost trap answer Escape'),
 ('WRP-07',[(FOC,"for (const entry of traps) if (top === undefined || entry.rank > top.rank) top = entry;","for (const entry of traps) top = entry;\n  void top;\n  return traps.some((entry) => entry.token === token);")],T_KIT,'keeps Tab inside the innermost'),
 ('WRP-08',[(FOC,"element.closest('[hidden], [inert], fieldset[disabled]')","element.closest('[hidden], fieldset[disabled]')")],T_KIT,'inert tail'),
 ('WRP-09',[(FOC,"    if (details.open) continue;","    if (!details.open) continue;")],T_KIT,'skipping hidden and collapsed'),
 ('WRP-10',[(OVL,"if (!isTopTrap(token) || event.defaultPrevented) return;","if (!isTopTrap(token)) return;")],T_KIT,'inside a menu in a dialog'),
 # --- B3: a 409 refreshes the stale row ------------------------------------------------------
 ('WRP-11',[(SUB,"if (error instanceof ApiError && error.status === 409) handlers?.onConflict?.();","if (error instanceof ApiError && error.status >= 400) handlers?.onConflict?.();")],T_SUB,'on a 409, and on nothing else'),
 ('WRP-12',[(SUB,"if (error instanceof ApiError && error.status === 409) handlers?.onConflict?.();","")],T_INC,'re-reads the incident on a version conflict'),
 ('WRP-13',[(INC,"      if (conflicted) await refresh(queries, incident.id);","")],T_INC,'re-reads the incident on a version conflict'),
 # --- B4: the breadcrumb returns to the list as it was left ----------------------------------
 ('WRP-14',[(APP,"href: entry ? rememberedHref(entry.path) : '/'","href: entry ? entry.path : '/'")],T_RTR,'carries the filters'),
 ('WRP-15',[(RTR,"  snapshot = read();\n  remember(snapshot);\n  emit();","  snapshot = read();\n  emit();")],T_RTR,'breadcrumb back to a list'),
 # --- review of #235 -------------------------------------------------------------------------
 # B1: the edit form sends the version its fields came from, and a 409 refills it.
 ('WRP-16',[(INC,"expectedVersion: draft.basedOn ?? incident.version","expectedVersion: incident.version")],T_INC,'filled from, not one re-read since'),
 ('WRP-17',[(INC,"      setDraft({ form: initialForm(fresh.incident), basedOn: fresh.incident.version });","      setDraft((previous) => ({ ...previous, basedOn: fresh.incident.version }));")],T_INC,'never resends its stale fields'),
 # B2: no cursor, and nothing across a session boundary.
 ('WRP-18',[(RTR,"const NOT_REMEMBERED: ReadonlySet<string> = new Set(['cursor']);","const NOT_REMEMBERED: ReadonlySet<string> = new Set([]);")],T_RTR,'never its cursor'),
 ('WRP-19',[(APP,"      forgetRememberedQueries();\n      client.setQueryData(['session'], null);","      client.setQueryData(['session'], null);")],T_SHELL,'forgets the remembered list searches on sign-out'),
 ('WRP-20',[(RTR,"  lastQueries.clear();","")],T_RTR,'session boundary'),
 # Codex: CSS-hidden controls do not count; N1: rank by render order.
 ('WRP-21',[(FOC,"  return rendered(element, root);","  return true;")],T_KIT,'hidden by CSS'),
 ('WRP-22',[(OVL,"  if (active && !rank.current.active) rank.current = { active: true, value: nextTrapRank() };","  if (active && !rank.current.active) rank.current = { active: true, value: -nextTrapRank() };")],T_KIT,'same commit'),
 # Codex: the import key follows the File object; N2: a held run key expires.
 ('WRP-23',[(RKT,"idempotencyKey: importKey.current({ file: tokenOf(input.file) }),","idempotencyKey: importKey.current({\n          name: input.file.name,\n          size: input.file.size,\n          lastModified: input.file.lastModified,\n        }),")],T_REC,'import key for the same file'),
 ('WRP-24',[(SUB,"        options.heldForMs !== undefined &&","        options.heldForMs === -1 &&")],T_SUB,'expire after heldForMs'),
 # --- list polish (RP) ---------------------------------------------------------------------
 ('WRP-25',[(LS,"onClick={() => void query.refetch()}","onClick={() => undefined}")],T_LP,'reads them again on request'),
 ('WRP-26',[(LS,"if (hidden || query.dataUpdatedAt === 0) return null;","if (query.dataUpdatedAt === 0) return null;")],T_LP,'withdrawn once the list is refused'),
 ('WRP-27',[(LS,"[...keys, 'cursor'].map","[...keys].map")],T_LP,'cursor together'),
 ('WRP-28',[(ORD,"          // Typing or pasting searches by itself, debounced, as on /users (roadmap B4).\n          autoApply\n","")],T_LP,'applies itself'),
 ('WRP-29',[(REF,"onClick={() => setConfirmingClear(true)}","onClick={() => clear.mutate()}")],T_RB,'after asking'),
]

def run_one(mid,edits,test,filt):
  originals={}
  try:
    for f,a,b in edits:
      cur=open(f,encoding='utf-8').read()
      originals.setdefault(f,cur)
      if cur.count(a)!=1:
        print(mid,'ANCHOR MISSING in',f,cur.count(a),flush=True); return None
      open(f,'w',encoding='utf-8').write(cur.replace(a,b))
    r=subprocess.run(['pnpm','exec','vitest','run','--project','web',test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    ran_any=any('passed' in l or 'failed' in l for l in summ)
    dead=r.returncode!=0 and ran_any and len(failed)>0
    print(mid,'KILLED' if dead else 'SURVIVED',summ,failed[:2],flush=True)
    return dead
  finally:
    # Always restored: on a kill, a survivor, an exception, or Ctrl-C mid-run.
    for f,s in originals.items(): open(f,'w',encoding='utf-8').write(s)

only=sys.argv[1:]
killed=0; ran=0
for mid,edits,test,filt in M:
  if only and mid not in only: continue
  result=run_one(mid,edits,test,filt)
  if result is None: continue
  ran+=1
  if result: killed+=1
print(f'{killed} of {ran} killed',flush=True)
