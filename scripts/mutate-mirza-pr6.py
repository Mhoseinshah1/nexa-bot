"""Mirza PR6 — the cutover approval, the gated import, SOURCE_SUPERSEDED, the final report v2
and the cutover gate: mutation driver.

Reverts ONE production rule at a time, runs the test that names it, and restores the file.
A mutation that leaves its test green is a rule with no test. Usage:

    python3 scripts/mutate-mirza-pr6.py [ID ...]
    python3 scripts/mutate-mirza-pr6.py --anchors     # only check every anchor is unique

Integration mutations (I-*, S-*) need PostgreSQL and Redis, with TEST_DATABASE_URL and
DATABASE_URL pointing at a database of YOUR OWN (CLAUDE.md: agents sharing PostgreSQL are
serialised). S-* mutations drop a trigger of that database for one run and recreate it.
C-* mutations edit packages/contracts, which the tests read from its dist: the driver rebuilds
it after the edit and again after the restore.
"""
import os
import subprocess
import sys

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ANCHORS_ONLY = '--anchors' in sys.argv
if not ANCHORS_ONLY and subprocess.run(
    ['git', 'diff', '--quiet', '--', 'apps', 'packages', 'scripts']
).returncode != 0:
    sys.exit('apps/, packages/ or scripts/ has uncommitted changes; a mutation restore would discard them')

MOD = 'apps/api/src/modules/platform'
RULES = f'{MOD}/legacy-cutover/domain/cutover-rules.ts'
SVC = f'{MOD}/legacy-cutover/application/legacy-cutover.service.ts'
REPO = f'{MOD}/legacy-cutover/infrastructure/drizzle-legacy-cutover.repository.ts'
V2 = f'{MOD}/legacy-importer/application/final-report-v2.ts'
IMP = f'{MOD}/legacy-importer/application/legacy-importer.service.ts'
GATE = 'apps/api/src/legacy-import-cutover.ts'
CLI = 'apps/api/src/legacy-import.cli.ts'
WEB = 'apps/web/src/pages/legacy-cutover.tsx'
CONTRACT = 'packages/contracts/src/legacy-cutover.ts'

T_RULES = ('unit', 'tests/unit/legacy-cutover-rules.test.ts')
T_V2 = ('unit', 'tests/unit/legacy-final-report-v2.test.ts')
T_GATE = ('unit', 'tests/unit/legacy-cutover-gate.test.ts')
T_INT = ('integration', 'tests/integration/legacy-cutover.test.ts')
T_WEB = ('web', 'tests/web/legacy-cutover.test.tsx')

M = [
    # --- the one evaluator (decideCutoverImport) ------------------------------------------
    ('U-01', [(RULES, '  if (missing.length > 0) return { ok: false, missing };', '')], T_RULES, 'missing value is refused'),
    ('U-02', [(RULES, '  return LEGACY_CUTOVER_BINDING_FIELDS.every((field) => approval[field] === binding[field]);',
               "  return LEGACY_CUTOVER_BINDING_FIELDS.every((field) => field === 'finalDumpSha256' || approval[field] === binding[field]);")],
     T_RULES, 'changed value voids'),
    ('U-03', [(RULES, '(a) => !a.revoked && bindingMatches(a, binding)', '(a) => bindingMatches(a, binding)')], T_RULES, 'missing or revoked'),
    ('U-04', [(RULES, '  if (input.productionLikeTarget && approval.synthetic) return false;\n', '')], T_RULES, 'synthetic approval never opens'),
    ('U-05', [(RULES, '  return approval.synthetic === input.snapshotSynthetic;', '  return true;')], T_RULES, 'synthetic approval never opens'),
    ('U-06', [(RULES, '    (source) => !reruns.some((a) => a.priorSourceFingerprint === source),',
               '    (source) => false && !reruns.some((a) => a.priorSourceFingerprint === source),')], T_RULES, 'SOURCE_SUPERSEDED'),
    ('U-07', [(RULES, "  const reruns = live.filter(", "  const reruns = input.approvals.filter(")], T_RULES, 'SOURCE_SUPERSEDED'),
    ('U-08', [(IMP, '  if (input.productionLikeTarget !== true) return null;', '  return null;')], T_RULES, 'fail closed'),
    # --- the final report v2 --------------------------------------------------------------
    ('V-01', [(V2, "      holds: v1('C1') && u('U1'),", "      holds: v1('C1'),")], T_V2, 'USERS_ACCOUNTED'),
    ('V-02', [(V2, "      holds: a('A1') && a('A2') && a('A3'),", "      holds: a('A2') && a('A3'),")], T_V2, 'INVOICES_ACCOUNTED'),
    ('V-03', [(V2, "      holds: p('PR1') && p('PR2') && p('PR3'),", "      holds: p('PR1') && p('PR3'),")], T_V2, 'PRODUCTS_ACCOUNTED'),
    ('V-04', [(V2, "        v1('W1') && v1('W4') && v1('W5') &&", "        v1('W4') && v1('W5') &&")], T_V2, 'WALLETS_RECONCILED'),
    ('V-05', [(V2, "      holds: serviceOutcomes.invariant.holds && v1('S3'),", "      holds: v1('S3'),")], T_V2, 'SERVICES_ONE_OUTCOME'),
    ('V-06', [(V2, '        serviceOutcomes.archivedHistory.notLinkedToArchive === 0 &&', '        true &&')], T_V2, 'UNRESOLVED_RETAINED'),
    ('V-07', [(V2, '        d.archiveRepeatedRevisions === 0,', '        true,')], T_V2, 'RERUN_NO_DUPLICATES'),
    ('V-08', [(V2, '    core: core.reconciliation.every((r) => r.holds),', '    core: true,')], T_V2, 'section core'),
    ('V-09', [(V2, "    check('I2', 'no table is UNCLASSIFIED (Area E)', '0', str(byClass.UNCLASSIFIED)),",
               "    check('I2', 'no table is UNCLASSIFIED (Area E)', '0', '0'),"),
              (V2, "    check('I3', 'the inventory is COMPLETE', 'COMPLETE', inventory.verdict),",
               "    check('I3', 'the inventory is COMPLETE', 'COMPLETE', 'COMPLETE'),")], T_V2, 'UNCLASSIFIED table'),
    ('V-10', [(V2, '    String(unconfirmed),', "    '0',")], T_V2, 'ADOPTION_UNCONFIRMED'),
    ('V-11', [(V2, "      outcome === null ? 'none' : 'recorded',", "      'recorded',")], T_V2, 'never recorded'),
    ('V-12', [(V2, '      str(unacknowledged.length),', "      '0',")], T_V2, 'superseded unacknowledged'),
    ('V-13', [(V2, '      holds: failedSections.length === 0 && failedInvariants.length === 0,',
               '      holds: failedInvariants.length === 0,')], T_V2, 'section'),
    # --- the gate ---------------------------------------------------------------------------
    ('G-01', [(GATE, '    if (!outcome.holds) failedStep = step;\n', '')], T_GATE, 'stops the gate there'),
    ('G-02', [(GATE, '    facts.activePanelsNotDrained === 0 &&', '    true &&')], T_GATE, 'every panel drained'),
    ('G-03', [(GATE, '  if (input.checkerSha256 !== LEGACY_FREEZE_CHECKER_SHA256) {', '  if (false) {')], T_GATE, 'stand-in checker'),
    ('G-04', [(GATE, " || !/^EQUAL: /mu.test(input.run.stdout)", '')], T_GATE, 'stand-in checker'),
    ('G-05', [(GATE, '  if (input.frozenSha256 !== input.expectedFreezeProofSha256) {', '  if (false) {')], T_GATE, 'real checker'),
    # --- the service, the importer and the CLI, end to end ----------------------------------
    ('I-01', [(SVC, '          if (run === null) {\n            throw errors.conflict(\n              LEGACY_CUTOVER_ERROR_CODES.READ_SET_NOT_RECORDED,',
               '          if (false) {\n            throw errors.conflict(\n              LEGACY_CUTOVER_ERROR_CODES.READ_SET_NOT_RECORDED,')], T_INT, 'RECORDED read sets'),
    ('I-02', [(SVC, '    // which a revocation may have changed since.\n    if (found !== null) return reviveApproval(found.result);',
               '    // which a revocation may have changed since.\n    if (found !== null) {\n      const now = await this.deps.repository.findApproval(scope, found.result.id);\n      if (now !== null) return now;\n    }')],
     T_INT, 'RECORDED read sets'),
    ('I-03', [(SVC, '        if (same !== undefined) {', '        if (false) {')], T_INT, 'RECORDED read sets'),
    ('I-04', [(SVC, '        if (before.revocation !== null) {', '        if (false) {')], T_INT, 'RECORDED read sets'),
    ('I-05', [(SVC, '        await this.assertScopeActive(scope, tx);\n        await this.deps.repository.lockTenantApprovals(scope, tx);\n        const binding',
               '        await this.deps.repository.lockTenantApprovals(scope, tx);\n        const binding')], T_INT, 'owner-only'),
    ('I-06', [(SVC, '          if (!prior) {', '          if (false) {')], T_INT, 'RECORDED read sets'),
    ('I-07', [(IMP, '      await this.deps.uow.run(scope, (tx) => this.requireCutover(input, gate, tx));\n', ''),
              (IMP, '      const cutover = gate === null ? null : await this.requireCutover(input, gate, tx);',
               '      const cutover = null as Extract<CutoverDecision, { ok: true }> | null;')], T_INT, 'gated import refuses'),
    ('I-08', [(IMP, '      expectation.sourceFingerprint !== input.snapshot.fingerprint\n', '      false\n')], T_INT, 'gated import refuses'),
    ('I-09', [(IMP, '      { applyOutcome: applyOutcomeRecord(tallies, attention) },\n', '')], T_INT, 'report v2 validates'),
    ('I-10', [(CLI, '    assertFreshMatches(\n      await freshCutoverFingerprints(importer, connector, snapshot.fingerprint, readContext),\n      expectation,\n    );', '    void [\n      await freshCutoverFingerprints(importer, connector, snapshot.fingerprint, readContext),\n      expectation,\n    ];')], T_INT, 'UNCLASSIFIED table blocks'),
    ('I-11', [(REPO, '        and(eq(a.tenantId, tenantId), page.after === undefined ? undefined : gt(a.id, page.after)),',
               '        page.after === undefined ? undefined : gt(a.id, page.after),')], T_INT, 'owner-only'),
    ('I-12', [(SVC, '      await recordMutationDenial(\n        this.mutationDeps(),\n        scope,\n        actor,\n        LEGACY_CUTOVER_APPROVE_PERMISSION,',
               '      void recordMutationDenial;\n      await Promise.resolve(\n        this.mutationDeps(),\n        scope,\n        actor,\n        LEGACY_CUTOVER_APPROVE_PERMISSION,')], T_INT, 'owner-only'),
    ('I-13', [(IMP, '    const holds = reportHolds(final, usersWallets, serviceOutcomes) && finalV2.verdict.holds;',
               '    const holds = reportHolds(final, usersWallets, serviceOutcomes);')], T_INT, 'report v2 validates'),
    ('I-14', [(SVC, '      if (run === null) {\n        return {\n          ok: false,', '      if (false) {\n        return {\n          ok: false,')], T_INT, 're-checks the approval'),
    # --- the web page --------------------------------------------------------------------
    ('W-01', [(WEB, 'const HEX = /^[0-9a-f]{64}$/u;', 'const HEX = /^.{1,64}$/u;')], T_WEB, 'exact SHA-256'),
    ('W-02', [(WEB, '(HEX.test(prior) && prior !== values.sourceFingerprint)', 'HEX.test(prior)')], T_WEB, 'prior source other'),
]

# Contract mutations: the tests read packages/contracts from dist, so each is rebuilt.
C = [
    ('C-01', [(CONTRACT, "['COMPLETED', 'ABORTED', 'FAILED'] as const", "['COMPLETED', 'ABORTED'] as const")], T_RULES, 'SOURCE_SUPERSEDED'),
    ('C-02', [(CONTRACT, '        ? r.priorSourceFingerprint !== null && r.priorSourceFingerprint !== r.sourceFingerprint',
               '        ? r.priorSourceFingerprint !== null')], T_RULES, 'prior source other than this one'),
]

S = [
    ('S-01', 'DROP TRIGGER legacy_cutover_approvals_no_update ON legacy_cutover_approvals',
     'CREATE TRIGGER legacy_cutover_approvals_no_update BEFORE UPDATE ON legacy_cutover_approvals '
     'FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation()', T_INT, 'append-only'),
    ('S-02', 'DROP TRIGGER legacy_cutover_approval_revocations_no_delete ON legacy_cutover_approval_revocations',
     'CREATE TRIGGER legacy_cutover_approval_revocations_no_delete BEFORE DELETE ON legacy_cutover_approval_revocations '
     'FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation()', T_INT, 'append-only'),
]


def run_test(project, test, filt):
    r = subprocess.run(['pnpm', 'exec', 'vitest', 'run', '--project', project, test, '-t', filt],
                       capture_output=True, text=True)
    out = r.stdout + r.stderr
    return r.returncode, [line.strip() for line in out.splitlines() if 'Tests ' in line]


def psql(statement):
    url = os.environ.get('TEST_DATABASE_URL') or sys.exit('TEST_DATABASE_URL is required for S-*')
    subprocess.run(['psql', url, '-v', 'ON_ERROR_STOP=1', '-qc', statement], check=True)


def build_contracts():
    subprocess.run(['pnpm', '--filter', '@nexa/contracts', 'build'], check=True, capture_output=True)


only = [a for a in sys.argv[1:] if not a.startswith('--')]
killed = 0
ran = 0
missing_anchor = 0
for mid, edits, (project, test), filt in M + C:
    if only and mid not in only:
        continue
    originals = {}
    ok = True
    for f, a, b in edits:
        cur = open(f).read()
        originals.setdefault(f, cur)
        if cur.count(a) != 1:
            print(mid, 'ANCHOR MISSING in', f, cur.count(a), flush=True)
            missing_anchor += 1
            ok = False
            break
        if not ANCHORS_ONLY:
            open(f, 'w').write(cur.replace(a, b))
    if ok and not ANCHORS_ONLY:
        contract = any(f == CONTRACT for f, _, _ in edits)
        try:
            if contract:
                build_contracts()
            ran += 1
            code, summ = run_test(project, test, filt)
            if code != 0:
                killed += 1
            print(mid, 'KILLED' if code != 0 else 'SURVIVED', summ, flush=True)
        finally:
            for f, s in originals.items():
                open(f, 'w').write(s)
            if contract:
                build_contracts()
    else:
        for f, s in originals.items():
            open(f, 'w').write(s)

if not ANCHORS_ONLY:
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

if ANCHORS_ONLY:
    print(f'anchors: {missing_anchor} missing')
    sys.exit(1 if missing_anchor else 0)
print(f'{killed} of {ran} mutations killed', flush=True)
sys.exit(0 if killed == ran else 1)
