"""Mirza PR4 — users and wallets (owner decision 6): mutation driver.

Reverts ONE production rule at a time, runs the test that names it, and restores the file.
A mutation that leaves its test green is a rule with no test. Usage:

    python3 scripts/mutate-mirza-pr4.py [ID ...]

Integration (I-*, W-*, D-*) and database (S-*) mutations need PostgreSQL and Redis, and
TEST_DATABASE_URL/DATABASE_URL pointing at a database of YOUR OWN (CLAUDE.md: agents sharing
PostgreSQL are serialised). S-* mutations drop a trigger of that database for one run and
recreate it afterwards.
"""
import os
import subprocess
import sys

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git', 'diff', '--quiet', '--', 'apps', 'packages', 'scripts']).returncode != 0:
    sys.exit('apps/, packages/ or scripts/ has uncommitted changes; a mutation restore would discard them')

OPEN = 'apps/api/src/modules/commerce/wallet/application/migration-opening-balance.service.ts'
DEBT = 'apps/api/src/modules/commerce/legacy-wallet-debts'
SVC = f'{DEBT}/application/legacy-wallet-debt.service.ts'
REPO = f'{DEBT}/infrastructure/drizzle-legacy-wallet-debt.repository.ts'
IMP = 'apps/api/src/modules/platform/legacy-importer/application'
PLAN = f'{IMP}/plan.ts'
UW = f'{IMP}/users-wallets-reconciliation.ts'
SERVICE = f'{IMP}/legacy-importer.service.ts'
FINAL = f'{IMP}/final-report.ts'

T_OPEN = ('integration', 'tests/integration/migration-opening-balance.test.ts')
T_DEBTS = ('integration', 'tests/integration/legacy-wallet-debts.test.ts')
T_IMP = ('integration', 'tests/integration/legacy-importer.test.ts')
T_BOUND = ('unit', 'tests/unit/legacy-wallet-debts-boundary.test.ts')
T_UW = ('unit', 'tests/unit/legacy-users-wallets.test.ts')
T_DEC = ('unit', 'tests/unit/legacy-importer-decisions.test.ts')

NEG = "        if (command.legacyBalanceMinor < 0n) {\n          return this.holdNegative("
M = [
    # Owner decision 6: a negative balance never reaches the ledger (it would be a DEBIT).
    ('W-01', [(OPEN, NEG, NEG.replace('command.legacyBalanceMinor < 0n', 'false'))], T_OPEN, 'NEGATIVE legacy balance for review'),
    ('W-02', [(OPEN, NEG, NEG.replace('command.legacyBalanceMinor < 0n', 'false'))], T_BOUND, 'never as a DEBIT'),
    # ... and so a top-up is never netted against it.
    ('W-03', [(OPEN, NEG, NEG.replace('command.legacyBalanceMinor < 0n', 'false'))], T_OPEN, 'never nets a legacy debt'),
    # A DEBIT the old code wrote is never doubled by a debt.
    ('W-04', [(OPEN, "    if (input.existing !== null) {\n      return {\n        kind: 'PRIOR_DEBIT_OPENING',",
               "    if (false) {\n      return {\n        kind: 'PRIOR_DEBIT_OPENING',")], T_IMP, 'ledger DEBIT opening left'),
    # The same debt: amount, and evidence class (PR3's lesson).
    ('W-05', [(OPEN, "    debt.amountMinor === magnitude &&\n", "")], T_DEBTS, 'rerun records no second debt'),
    ('W-06', [(OPEN, "    debt.synthetic === provenance.synthetic;", "    true;")], T_DEBTS, 'SYNTHETIC source'),
    # A recorded debt, then a non-negative figure: a changed figure, refused.
    ('W-07', [(OPEN, "        if (debt !== null) throw payloadMismatch();\n", "")], T_DEBTS, 'rerun records no second debt'),
    # The plan: a debt then a positive figure is a CONFLICT, never a POST.
    ('P-01', [(PLAN, "  if (existingDebt !== undefined) return 'CONFLICT';\n", "")], T_DEC, 'legacy debt, never a ledger entry'),
    # Duplicate source ids create nothing.
    ('P-02', [(PLAN, "  const duplicates = duplicateSourceIds(snapshot.users);", "  const duplicates = new Map<string, string>();")], T_IMP, 'duplicate source user ids'),
    # The section: a changed row is SOURCE_CHANGED, never imported-as-is.
    ('U-01', [(UW, "  if (map?.status === 'IMPORTED' && map.checksum !== row.checksum) return 'SOURCE_CHANGED';\n", "")], T_IMP, 'newer snapshot'),
    ('U-02', [(UW, "      holds: input.openingTotals.negative === 0,", "      holds: true,")], T_UW, 'fails U6'),
    ('U-03', [(UW, "      holds: input.synthetic || input.debtTotals.synthetic === 0,", "      holds: true,")], T_UW, 'U8'),
    ('U-04', [(UW, "    carried.absentOpenings.count += 1;\n", "")], T_IMP, 'newer snapshot'),
    ('U-05', [(UW, "        ownerReview[cls].push(map.ref);\n", "")], T_IMP, 'newer snapshot'),
    # Reconcile: the debts equation; the v1 report: openings against positives only.
    ('R-01', [(SERVICE, "        -tallies.wallet.negative.sumMinor,\n        debts.sumMinor,", "        0n,\n        debts.sumMinor,")], T_IMP, 'import applies every phase'),
    ('R-02', [(FINAL, "  const nonZero = plan.wallet.positive.count;", "  const nonZero = plan.wallet.positive.count + plan.wallet.negative.count;")], T_IMP, 'import applies every phase'),
    ('R-03', [(SERVICE, "    priorDebitOpening: tallies.openings.PRIOR_DEBIT_OPENING,\n", "")], T_IMP, 'ledger DEBIT opening left'),
    # The owner's review: view permission, version binding, scope activity, tenancy.
    ('D-01', [(SVC, "    await this.deps.guard.check(scope, actor, LEGACY_DEBTS_VIEW_PERMISSION);\n    const limit", "    const limit")], T_DEBTS, 'permission-gated'),
    ('D-02', [(SVC, "        if (before.version !== spec.expectedVersion) {", "        if (false) {")], T_DEBTS, 'stale version'),
    ('D-03', [(SVC, "        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {", "        if (false) {")], T_DEBTS, 'stopped accepting'),
    ('D-04', [(REPO, "      .where(and(eq(legacyWalletDebts.tenantId, tenantId), where))", "      .where(where)")], T_DEBTS, 'keeps tenants apart'),
]

FACTS_TRIGGER = ('CREATE TRIGGER legacy_wallet_debts_facts_immutable BEFORE UPDATE ON legacy_wallet_debts '
                 'FOR EACH ROW EXECUTE FUNCTION nexa_legacy_wallet_debt_facts_immutable()')
S = [
    ('S-01', 'DROP TRIGGER legacy_wallet_debts_facts_immutable ON legacy_wallet_debts', FACTS_TRIGGER,
     T_DEBTS, 'immutable'),
    ('S-02', 'DROP TRIGGER legacy_wallet_debts_no_delete ON legacy_wallet_debts',
     'CREATE TRIGGER legacy_wallet_debts_no_delete BEFORE DELETE ON legacy_wallet_debts '
     'FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation()', T_DEBTS, 'immutable'),
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
