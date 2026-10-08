"""A9/A10 (Support AI vision and evaluation) mutation driver
(docs/support-agent/sai-vision-eval-falsification.md).

Reverts one rule at a time, runs the named test, and restores the file with `git checkout`.
A mutant is KILLED only when the named test fails; the driver prints the first failing
assertion, so a mutant that dies by a crash is visible as such. The integration mutant needs the
database (`bash scripts/dev-services.sh`); point TEST_DATABASE_URL and DATABASE_URL at a database
of your own if another suite is running.
Usage: python3 scripts/mutate-sai-vision-eval.py [SAI-V01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','packages']).returncode != 0:
  sys.exit('apps/ or packages/ has uncommitted changes; a mutation restore would discard them')

OPENAI='apps/api/src/infrastructure/ai/openai-adapter.ts'
CHAIN='apps/api/src/modules/control/support-ai/application/support-ai-chain.ts'
VISION='apps/api/src/modules/control/support-ai/domain/vision.ts'
ARGS='apps/api/src/modules/control/support-ai/eval/live-args.ts'
RUNNER='apps/api/src/modules/control/support-ai/eval/runner.ts'
RELEVANCE='apps/api/src/modules/commerce/support-context/domain/knowledge-relevance.ts'
V=('unit','tests/unit/support-ai-vision.test.ts')
E=('unit','tests/unit/support-ai-eval.test.ts')
Q=('unit','tests/unit/support-knowledge-query.test.ts')
I=('integration','tests/integration/support-vision.test.ts')

M=[
 # --- A9: vision ---
 ('SAI-V01',[(OPENAI,"                  detail: 'high',","                  detail: 'low',")],V,'OpenAI: an image_url'),
 ('SAI-V02',[(CHAIN,"    if (total + bytes > SUPPORT_AI_VISION_MAX_TOTAL_BYTES) {","    if (total + bytes > Number.MAX_SAFE_INTEGER) {")],V,'the images together stay within the total'),
 ('SAI-V03',[(CHAIN,"  const over = Math.max(0, fits.length - SUPPORT_AI_VISION_MAX_IMAGES);","  const over = Math.max(0, fits.length - 2);")],V,'images in one request, the most recent'),
 ('SAI-V04',[(VISION,"    if (index >= SUPPORT_AI_VISION_MAX_IMAGES) skipped.set(image.id, 'OVER_LIMIT');","    if (index >= 2) skipped.set(image.id, 'OVER_LIMIT');")],V,'the four most recent customer images'),
 ('SAI-V05',[(VISION,"    if (index >= SUPPORT_AI_VISION_MAX_IMAGES) skipped.set(image.id, 'OVER_LIMIT');","    if (index >= 2) skipped.set(image.id, 'OVER_LIMIT');")],I,'at most the four most recent images'),
 # --- A10: evaluation ---
 ('SAI-E01',[(ARGS,"  if (env.CI !== undefined && env.CI !== '') return 'refused under CI: a live run is a paid call';\n","")],E,'every condition is required'),
 ('SAI-E02',[(ARGS,"  if ((env.SUPPORT_AI_EVAL_API_KEY ?? '') === '') {","  if (false) {")],E,'every condition is required'),
 ('SAI-E03',[(ARGS,"  if (!args.live) return 'not requested (--live)';\n","")],E,'every condition is required'),
 ('SAI-E04',[(RUNNER,"      const leaked = [...EVAL_NEVER_SAY, ...(expect.mustNotSay ?? [])].filter((text) =>\n        written.includes(text),\n      );","      const leaked = [...EVAL_NEVER_SAY, ...(expect.mustNotSay ?? [])].filter(\n        (text) => written.length < 0 && written.includes(text),\n      );")],E,'a leak of the canary'),
 ('SAI-E05',[(RUNNER,"  if (prepared.failClosed || prepared.moneyHandoff) {","  if (prepared.moneyHandoff) {")],E,'ask no model at all'),
 ('SAI-E06',[(RUNNER,"        decision.factRefs.every((ref) => prepared.factAliases.has(ref)) &&","        decision.factRefs.every(() => true) &&")],E,'an invented citation'),
 ('SAI-E07',[(RUNNER,"  if (expect.guard !== 'EITHER') {","  if (expect.guard === ('NEVER' as string)) {")],E,'a person must answer'),
 ('SAI-E08',[(RUNNER,"      (checks.retrieval ?? true) && first === expect.topKnowledge,","      (checks.retrieval ?? true) && first.length >= 0,")],E,'a wrong first article'),
 ('SAI-E09',[(RUNNER,"    const missing = expect.knowledge.filter((title) => !titles.has(title));","    const missing = expect.knowledge.filter(() => false);")],E,'a wrong first article'),
 ('SAI-E10',[(RELEVANCE,"  'وقت',\n","")],Q,'a greeting matches nothing'),
 ('SAI-E11',[(RELEVANCE,"  'وقت',\n  'وقتی',\n","")],E,'every scenario passes every check'),
]

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
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    failed=[l.strip() for l in out.splitlines() if '×' in l]
    asserts=[l.strip() for l in out.splitlines() if 'AssertionError' in l or 'Error:' in l]
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,failed[:2],asserts[:1],flush=True)
  for f in files: subprocess.run(['git','checkout','--',f])
