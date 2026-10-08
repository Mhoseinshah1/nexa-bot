"""Mirza PR5 — service adoption outcomes and the operator's review (owner decision 8):
mutation driver.

Reverts ONE production rule at a time, runs the test that names it, and restores the file.
A mutation that leaves its test green is a rule with no test. Usage:

    python3 scripts/mutate-mirza-pr5.py [ID ...]

Integration mutations (I-*, S-*) need PostgreSQL, Redis and the loopback fake RickPanels,
with TEST_DATABASE_URL/DATABASE_URL pointing at a database of YOUR OWN (CLAUDE.md: agents
sharing PostgreSQL are serialised). S-* mutations drop a trigger of that database for one
run and recreate it afterwards.
"""
import os
import subprocess
import sys

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git', 'diff', '--quiet', '--', 'apps', 'packages', 'scripts']).returncode != 0:
    sys.exit('apps/, packages/ or scripts/ has uncommitted changes; a mutation restore would discard them')

MOD = 'apps/api/src/modules'
MATCH = f'{MOD}/platform/legacy-import/application/legacy-service-matching.ts'
PLAN = f'{MOD}/platform/legacy-importer/application/plan.ts'
IMP = f'{MOD}/platform/legacy-importer/application/legacy-importer.service.ts'
OUT = f'{MOD}/platform/legacy-importer/application/service-outcomes.ts'
P6 = f'{MOD}/commerce/legacy-adoption/application/legacy-adoption.service.ts'
RULES = f'{MOD}/platform/legacy-service-review/domain/candidate-rules.ts'
SVC = f'{MOD}/platform/legacy-service-review/application/legacy-service-review.service.ts'
REPO = f'{MOD}/platform/legacy-service-review/infrastructure/drizzle-legacy-service-candidate.repository.ts'
PMR = f'{MOD}/platform/legacy-importer/application/product-map-review.ts'
IREPO = f'{MOD}/platform/legacy-importer/infrastructure/drizzle-legacy-importer.repository.ts'

T_MATCH = ('unit', 'tests/unit/legacy-service-matching.test.ts')
T_RULES = ('unit', 'tests/unit/legacy-service-review-rules.test.ts')
T_INT = ('integration', 'tests/integration/legacy-service-review.test.ts')
T_IMP = ('integration', 'tests/integration/legacy-importer.test.ts')
T_PMR = ('unit', 'tests/unit/legacy-product-map-review.test.ts')

NO_PANEL_SEARCH = [
    (MATCH, "  if (row.codePanel === null) return { kind: 'NO_PANEL' };\n\n", ""),
    (MATCH, "  if (!policy.missingPanels.has(row.codePanel)) {",
     "  if (row.codePanel !== null && !policy.missingPanels.has(row.codePanel)) {"),
]

M = [
    # Owner decision 8: no panel is never searched. The mutation restores the pre-PR5 code
    # exactly (a NULL code searched across every production panel), in the matcher and end
    # to end with the real P6 (svc_nullmatch would be adopted onto its one holder).
    ('U-01', NO_PANEL_SEARCH, T_MATCH, 'no panel'),
    ('I-01', NO_PANEL_SEARCH, T_INT, 'exactly ONE outcome'),
    # Ambiguous ownership: two owners on one account adopt neither.
    ('I-02', [(PLAN, "    if (account === null || (owners.get(account)?.size ?? 0) < 2) return s;",
               "    return s;")], T_INT, 'ambiguous ownership'),
    # A keep is honoured by the importer (before P6) and by P6 itself (under the invoice lock).
    ('I-03', [(IMP, "      if (keptAsHistory.has(invoice.idInvoice)) {\n        tallies.services.adoption.KEPT_AS_HISTORY",
               "      if (false) {\n        tallies.services.adoption.KEPT_AS_HISTORY")], T_INT, 'ambiguous ownership'),
    ('I-04', [(P6, "    if (await this.deps.store.keptAsHistory(scope, command.legacyInvoiceKey, tx)) {",
               "    if (false) {")], T_INT, 'alongside a running import'),
    # The approval gate: synthetic on production, the bound row, the mapped panel.
    ('U-02', [(OUT, "  if (approval.synthetic && context.productionLikeTarget) {", "  if (false) {")], T_RULES, 'synthetic approval'),
    ('I-05', [(OUT, "  if (approval.synthetic && context.productionLikeTarget) {", "  if (false) {")], T_INT, 'SYNTHETIC approval'),
    ('U-03', [(OUT, "  if (invoice.checksum !== approval.approvedChecksum) {", "  if (false) {")], T_RULES, 'bound to the very row'),
    ('I-06', [(OUT, "  if (invoice.checksum !== approval.approvedChecksum) {", "  if (false) {")], T_INT, 'checks fail at execution'),
    ('U-04', [(OUT, "  if (!mappedPanelIds(context.mapping).has(panelId)) {", "  if (false) {")], T_RULES, 'bound to the very row'),
    ('U-05', [(OUT, "  if (mappedTo !== undefined && mappedTo !== panelId) {", "  if (false) {")], T_RULES, 'bound to the very row'),
    # An adopted invoice stays adopted (precedence), and "adopted" is what the map says.
    ('U-06', [(OUT, "    priorMap.status === 'IMPORTED' &&", "    false &&")], T_RULES, 'stays ALREADY_ADOPTED'),
    ('I-07', [(OUT, "    priorMap.status === 'IMPORTED' &&", "    false &&")], T_INT, 'rerun keeps one row'),
    ('I-08', [(IMP, "        if (mapped === null) {\n          return [", "        if (false) {\n          return [")], T_IMP, 'every eligible candidate reaches the adoption port'),
    # The request: a mapped holder panel only; never overriding the map; adoptable outcomes only.
    ('U-07', [(RULES, "    if (!adoptPanelsOf(candidate.evidence).includes(panelId)) {", "    if (false) {")], T_RULES, 'owner decision 8'),
    ('I-09', [(RULES, "    if (!adoptPanelsOf(candidate.evidence).includes(panelId)) {", "    if (false) {")], T_INT, 'explicit ADOPT'),
    ('U-08', [(RULES, "  if (panelId !== undefined && panelId !== mapped) {", "  if (false) {")], T_RULES, 'never overridden'),
    ('U-09', [(RULES, "  if (!(LEGACY_SERVICE_ADOPTABLE_OUTCOMES as readonly string[]).includes(candidate.outcome)) {",
               "  if (false) {")], T_RULES, 'only an outcome a person can clear'),
    # Review states across runs; versions.
    ('U-10', [(RULES, "      return existing.outcome === outcome ? 'ACKNOWLEDGED' : 'OPEN';", "      return 'ACKNOWLEDGED';")], T_RULES, 'acknowledgement of other facts'),
    ('U-11', [(RULES, "    existing.evidenceHash !== next.evidenceHash ||\n", "")], T_RULES, 'new version only'),
    # The service: version binding, scope activity, view permission, the invoice lock, the map.
    ('I-10', [(SVC, "        if (before.version !== spec.expectedVersion) {", "        if (false) {")], T_INT, 'explicit ADOPT'),
    ('I-11', [(SVC, "        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {", "        if (false) {")], T_INT, 'stopped tenant'),
    ('I-12', [(SVC, "    await this.deps.guard.check(scope, actor, LEGACY_SERVICES_VIEW_PERMISSION);\n    const limit",
               "    const limit")], T_INT, 'permission-gated'),
    ('I-13', [(SVC, "        await this.deps.repository.lockInvoice(scope, located.invoiceKey, tx);\n", "")], T_INT, 'invoice lock P6 takes first'),
    ('I-14', [(SVC, "        if (mapped?.status === 'IMPORTED') throw notInState('ADOPTED');\n", "")], T_INT, 'after P6 adopted'),
    ('I-15', [(REPO, "      .where(and(eq(t.tenantId, tenantId), eq(t.id, id)))\n      .limit(1);",
               "      .where(eq(t.id, id))\n      .limit(1);")], T_INT, 'keeps tenants apart'),
    # A replay returns the stored original response, never the row as it stands now.
    ('I-18', [(SVC, "    if (found !== null) return reviveCandidate(found.result);",
               "    if (found !== null) {\n      const now = await this.deps.repository.findById(scope, id);\n      if (now !== null) return now;\n    }")], T_INT, 'explicit ADOPT'),
    # The claim: a person's reopen in between wins.
    ('I-16', [(IMP, "        if (claimed === null) {\n          tallies.services.approvals.claimLost += 1;\n          continue;\n        }\n", "")], T_INT, 'reopening an approval mid-run'),
    # Codex #234: no claim outlives its run; a withdrawn refusal is not a refusal.
    ('I-20', [(IMP, "      const refusal: LegacyServiceApprovalRefusal =",
               "      if (o?.outcome === 'ADOPTION_ELIGIBLE') continue;\n      const refusal: LegacyServiceApprovalRefusal =")], T_INT, 'map does not confirm'),
    ('I-21', [(IMP, "        if (await this.releaseClaim(scope, actor, runId, approval, 'ADOPTION_NOT_WIRED')) {",
               "        if (false) {")], T_INT, 'claim no run can execute'),
    ('I-22', [(IMP, "if (await this.settleApproval(scope, actor, runId, approval, { refusal: gate.refusal })) {",
               "if ((await this.settleApproval(scope, actor, runId, approval, { refusal: gate.refusal })) || true) {")], T_INT, 'withdrew mid-run'),
    # The section: the closure, and its reconcile check.
    ('U-12', [(OUT, "        decidedByAnotherRun === 0 &&\n", "")], T_RULES, 'the closure'),
    ('U-13', [(IMP, "    usersWallets.holds &&\n    serviceOutcomes.invariant.holds\n", "    usersWallets.holds\n")], T_RULES, 'report verdict'),
    ('I-17', [(IMP, "        serviceOutcomes.invariant.holds,", "        true,")], T_INT, 'exactly ONE outcome'),
    # aud5 F2 / OQ-LSR-01: a named panel is for an EMPTY code only — offer, request and gate.
    ('F2-01', [(RULES, "  if (evidence.panelCodeClass !== 'EMPTY') return [];\n", "")], T_RULES, 'aud5 F2'),
    ('F2-02', [(RULES, "    if (candidate.evidence.panelCodeClass !== 'EMPTY') {", "    if (false) {")], T_RULES, 'aud5 F2'),
    ('F2-03', [(OUT, "    if (mappedTo === undefined) return { kind: 'REFUSE', refusal: 'PANEL_UNMAPPED' };\n", "")], T_RULES, 'bound to the very row'),
    ('F2-04', [(OUT, "    if (mappedTo === undefined) return { kind: 'REFUSE', refusal: 'PANEL_UNMAPPED' };\n", "")], T_INT, 'aud5 F2'),
    ('F2-05', [(RULES, "  if (evidence.panelCodeClass !== 'EMPTY') return [];\n", ""),
               (RULES, "    if (candidate.evidence.panelCodeClass !== 'EMPTY') {", "    if (false) {")], T_INT, 'aud5 F2'),
    # aud5 F5 = aud6 F1: the import's mapping.products against the approved product review.
    ('C-01', [(IMP, "    if (options.forApply === true && mapping.products.size > 0) {", "    if (false) {")], T_IMP, 'aud6 F1'),
    ('C-02', [(IMP, "      forApply: true,\n", "      forApply: false,\n")], T_IMP, 'aud6 F1'),
    ('C-03', [(PMR, "            : row.approvedProductId !== productId", "            : false")], T_PMR, 'refuses another target'),
    ('C-04', [(PMR, "            : row.approvedProductId !== productId", "            : false")], T_IMP, 'aud6 F1'),
    ('C-05', [(PMR, "          : !isExportable(row, productsReadFingerprint)", "          : false")], T_PMR, 'refuses another target'),
    ('C-06', [(PMR, "          : !isExportable(row, productsReadFingerprint)", "          : false")], T_IMP, 'aud6 F1'),
    ('C-07', [(IREPO, "         AND source_fingerprint = ${sourceFingerprint}\n       ORDER BY recorded_at DESC", "       ORDER BY recorded_at DESC")], T_IMP, 'aud6 F1'),
    ('C-08', [(PMR, "        : row === undefined\n          ? 'NO_REVIEW_ROW'", "        : row === undefined\n          ? 'NOT_EXPORTABLE'")], T_PMR, 'refuses another target'),
]

S = [
    ('S-01', 'DROP TRIGGER legacy_service_candidates_guard ON legacy_service_candidates',
     'CREATE TRIGGER legacy_service_candidates_guard BEFORE UPDATE ON legacy_service_candidates '
     'FOR EACH ROW EXECUTE FUNCTION nexa_legacy_service_candidate_guard()',
     T_INT, 'rerun keeps one row'),
    ('S-02', 'DROP TRIGGER legacy_service_candidates_no_delete ON legacy_service_candidates',
     'CREATE TRIGGER legacy_service_candidates_no_delete BEFORE DELETE ON legacy_service_candidates '
     'FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation()', T_INT, 'rerun keeps one row'),
]


def run_test(project, test, filt):
    r = subprocess.run(['pnpm', 'exec', 'vitest', 'run', '--project', project, test, '-t', filt],
                       capture_output=True, text=True)
    out = r.stdout + r.stderr
    return r.returncode, [line.strip() for line in out.splitlines() if 'Tests ' in line]


def psql(statement):
    url = os.environ.get('TEST_DATABASE_URL') or sys.exit('TEST_DATABASE_URL is required for S-*')
    subprocess.run(['psql', url, '-v', 'ON_ERROR_STOP=1', '-qc', statement], check=True)


only = sys.argv[1:]
killed = 0
ran = 0
for mid, edits, (project, test), filt in M:
    if only and mid not in only:
        continue
    originals = {}
    ok = True
    for f, a, b in edits:
        cur = open(f).read()
        originals.setdefault(f, cur)
        if cur.count(a) != 1:
            print(mid, 'ANCHOR MISSING in', f, cur.count(a), flush=True)
            ok = False
            break
        open(f, 'w').write(cur.replace(a, b))
    if ok:
        ran += 1
        code, summ = run_test(project, test, filt)
        if code != 0:
            killed += 1
        print(mid, 'KILLED' if code != 0 else 'SURVIVED', summ, flush=True)
    for f, s in originals.items():
        open(f, 'w').write(s)

for mid, broken, restore, (project, test), filt in S:
    if only and mid not in only:
        continue
    psql(broken)
    try:
        ran += 1
        code, summ = run_test(project, test, filt)
        if code != 0:
            killed += 1
        print(mid, 'KILLED' if code != 0 else 'SURVIVED', summ, flush=True)
    finally:
        psql(restore)
print(f'{killed} of {ran} killed', flush=True)
