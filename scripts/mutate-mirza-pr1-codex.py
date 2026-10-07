"""Mirza PR1, Codex review fixes: mutation driver for the freeze-proof checker and the read
set's verify-before-deliver rule (docs/legacy-migration/importer.md §Read sets, §Tests).

Reverts one rule at a time, runs the named unit test, and restores the file it read.
No database is needed. Usage: python3 scripts/mutate-mirza-pr1-codex.py [RS-01 ...]
"""
import subprocess, sys, os
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git','diff','--quiet','--','apps','scripts','docs']).returncode != 0:
  sys.exit('apps/, scripts/ or docs/ has uncommitted changes; a mutation restore would discard them')

RS='apps/api/src/modules/platform/legacy-importer/application/read-set.ts'
VERIFY='scripts/legacy-freeze-checksum-verify.sh'
SQL='scripts/legacy-freeze-checksum.sql'
CUT='docs/legacy-migration/cutover-runbook.md'
RB='docs/legacy-migration/rollback-runbook.md'
T_RS=('unit','tests/unit/legacy-read-set.test.ts')
T_INV=('unit','tests/unit/legacy-inventory.test.ts')

M=[
 # The read set: no row reaches onBatch before the approved fingerprint is matched.
 ('RS-01',[(RS,"  if (options.onBatch !== undefined && expected === undefined) {","  if (false) {")],T_RS,'delivering rows without the approved'),
 ('RS-02',[(RS,"  if (expected !== undefined) refuseUnexpected(definition, verified.fingerprint, expected);\n","")],T_RS,'a mismatch is refused after the digest-only pass'),
 ('RS-03',[(RS,"  const verified = await scanReadSet(session, definition, batchSize, undefined);","  const verified = await scanReadSet(session, definition, batchSize, options.onBatch);")],T_RS,'a mismatch is refused after the digest-only pass'),
 ('RS-04',[(RS,"  if (delivered.fingerprint !== verified.fingerprint) {","  if (false) {")],T_RS,'a delivery pass that reads other rows'),
 ('RS-05',[(RS,"  if (expected !== undefined && !LEGACY_SHA256_PATTERN.test(expected)) {","  if (false) {")],T_RS,'a malformed approved value'),
 # The freeze checker: a failed client's file is never evidence.
 ('FZ-01',[(VERIFY,"      if (rows != expected) refuse(rows \" checksum lines, but base_tables is \" expected)\n","")],T_INV,'refuses what a failed client leaves behind'),
 ('FZ-02',[(VERIFY,"  if [[ ! -s \"$file\" ]]; then","  if false; then"),(VERIFY,"      if (NR < 3) refuse(\"it ends before the Table/Checksum header\")\n","")],T_INV,'refuses what a failed client leaves behind'),
 ('FZ-03',[(VERIFY,"      if (sum !~ /^[0-9]+$/) refuse(","      if (0) refuse(")],T_INV,'refuses what a failed client leaves behind'),
 ('FZ-04',[(VERIFY,"      if (table in seen) refuse(","      if (0) refuse(")],T_INV,'refuses what a failed client leaves behind'),
 ('FZ-05',[(VERIFY,"if [[ \"$first\" != \"$second\" ]]; then","if false; then")],T_INV,'refuses two well-formed runs that differ'),
 ('FZ-06',[(VERIFY,"      if ($0 !~ /^[1-9][0-9]*$/) refuse(","      if (0) refuse(")],T_INV,'refuses what a failed client leaves behind'),
 ('FZ-07',[(SQL,"SELECT COUNT(*) AS base_tables\n  FROM information_schema.TABLES\n WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE';\n","")],T_INV,'legacy-freeze-checksum.sql'),
 # The runbooks: the client's own status, and the comparison only through the checker.
 ('DOC-01',[(CUT,"tee freeze-checksum-step7.tsv; echo \"exit ${PIPESTATUS[0]}\"","tee freeze-checksum-step7.tsv")],T_INV,'the runbooks capture'),
 ('DOC-02',[(CUT,"bash <checkout>/scripts/legacy-freeze-checksum-verify.sh freeze-checksum-step7.tsv freeze-checksum-step9.tsv; echo \"verify exit $?\"","diff freeze-checksum-step7.tsv freeze-checksum-step9.tsv")],T_INV,'the runbooks capture'),
 ('DOC-03',[(RB,"tee freeze-checksum-R5.tsv; echo \"exit ${PIPESTATUS[0]}\"","tee freeze-checksum-R5.tsv")],T_INV,'the runbooks capture'),
]

only=sys.argv[1:]
killed=0; ran=0
for mid,edits,(project,test),filt in M:
  if only and mid not in only: continue
  originals={}; ok=True
  for f,a,b in edits:
    s=originals.get(f) or open(f).read()
    originals.setdefault(f,s)
    cur=open(f).read()
    if cur.count(a)!=1:
      print(mid,'ANCHOR MISSING in',f,cur.count(a),flush=True); ok=False; break
    open(f,'w').write(cur.replace(a,b))
  if ok:
    ran+=1
    r=subprocess.run(['pnpm','exec','vitest','run','--project',project,test,'-t',filt],capture_output=True,text=True)
    out=r.stdout+r.stderr
    summ=[l.strip() for l in out.splitlines() if 'Tests ' in l]
    if r.returncode!=0: killed+=1
    print(mid,'KILLED' if r.returncode!=0 else 'SURVIVED',summ,flush=True)
  for f,s in originals.items(): open(f,'w').write(s)
print(f'{killed} of {ran} killed',flush=True)
