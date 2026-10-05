"""A4 delta a (tutorial video and guide in one message) mutation driver
(docs/pre-support/a4a-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file from the copy it read.
Integration mutants need the database (`bash scripts/dev-services.sh`); point
TEST_DATABASE_URL at a database of your own if another suite is running.
Usage: python3 scripts/mutate-a4a.py [A4A-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

RT='apps/api/src/surfaces/telegram/bot-runtime.ts'
T_I=('integration','tests/integration/client-app-video.test.ts')

M=[
 # The app screen sends its video AS the reply, whole-or-nothing.
 ('A4A-01',[(RT,"      media: { botInstanceId, kind: 'VIDEO', fileId: video.fileId, captionWhole: true },","      media: { botInstanceId, kind: 'VIDEO', fileId: video.fileId },")],T_I,'never a cut caption'),
 ('A4A-02',[(RT,"    if (video === null) return screen;","    if (video === null || true) return screen;")],T_I,'exactly ONE sendVideo'),
 # The runtime passes captionWhole through to the messenger, which measures the rendered caption.
 ('A4A-03',[(RT,"              ...(reply.media.captionWhole === true ? { captionWhole: true as const } : {}),\n","")],T_I,'RENDERED caption is over 1024'),
 # Over the bound: the file bare, then the text.
 ('A4A-04',[(RT,"      sent.reason === 'CAPTION_OVER_BOUND'\n    ) {","      sent.reason === 'CAPTION_OVER_BOUND' &&\n      false\n    ) {")],T_I,'never a cut caption'),
 ('A4A-05',[(RT,"      sent.reason === 'CAPTION_OVER_BOUND'\n    ) {","      true\n    ) {")],T_I,'refuses the video'),
 # A refused video: the guide still goes as text.
 ('A4A-06',[(RT,"    if (reply.media !== undefined && sent.outcome === 'REFUSED') sent = await asText();","")],T_I,'refuses the video'),
 # The buttons ride on the captioned video.
 ('A4A-07',[(RT,"              ...(reply.media.captionWhole === true ? { captionWhole: true as const } : {}),\n              ...(reply.buttons.length === 0 ? {} : { buttons: reply.buttons }),","              ...(reply.media.captionWhole === true ? { captionWhole: true as const } : {}),")],T_I,'buttons on it'),
]

only=sys.argv[1:]
killed=0; ran=0
for mid,edits,(project,test),filt in M:
  if only and mid not in only: continue
  originals={}; ok=True
  for f,a,b in edits:
    s=originals.get(f) or open(f,encoding='utf-8').read()
    originals.setdefault(f,s)
    cur=open(f,encoding='utf-8').read()
    if cur.count(a)!=1:
      print(mid,'ANCHOR MISSING in',f,cur.count(a),flush=True); ok=False; break
    open(f,'w',encoding='utf-8').write(cur.replace(a,b))
  if ok:
    ran+=1
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    ran_any=any('passed' in l or 'failed' in l for l in summ)
    if r.returncode!=0 and ran_any: killed+=1
    print(mid,'KILLED' if (r.returncode!=0 and ran_any) else 'SURVIVED',summ,failed[:2],flush=True)
  for f,s in originals.items(): open(f,'w',encoding='utf-8').write(s)
print(f'{killed} of {ran} killed',flush=True)
