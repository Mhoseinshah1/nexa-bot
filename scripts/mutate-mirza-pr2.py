"""Mirza PR2 — the legacy product review: mutation driver (docs/legacy-product-review-design.md).

Reverts ONE production rule at a time, runs the test that names it, and restores the file.
A mutation that leaves its test green is a rule with no test. Usage:

    python3 scripts/mutate-mirza-pr2.py [ID ...]

The integration mutations (I-*) need PostgreSQL and Redis and TEST_DATABASE_URL/DATABASE_URL
pointing at a database of your own (CLAUDE.md: agents sharing PostgreSQL are serialised).
Contract mutations (C-*) rebuild packages/contracts before and after the run.
"""
import os
import subprocess
import sys

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if subprocess.run(['git', 'diff', '--quiet', '--', 'apps', 'packages', 'scripts']).returncode != 0:
    sys.exit('apps/, packages/ or scripts/ has uncommitted changes; a mutation restore would discard them')

MOD = 'apps/api/src/modules/commerce/legacy-product-review'
FACTS = f'{MOD}/domain/legacy-product-facts.ts'
TRANS = f'{MOD}/domain/review-transitions.ts'
SVC = f'{MOD}/application/legacy-product-review.service.ts'
REPO = f'{MOD}/infrastructure/drizzle-legacy-product-review.repository.ts'
PERMS = 'packages/contracts/src/permissions.ts'
NAV = 'apps/web/src/nav.ts'

T_DOM = ('unit', 'tests/unit/legacy-product-review-domain.test.ts')
T_BOUND = ('unit', 'tests/unit/legacy-products-boundary.test.ts')
T_INT = ('integration', 'tests/integration/legacy-product-review.test.ts')
T_WEB = ('web', 'tests/web/legacy-products.test.tsx')

M = [
    # A read never keeps a decision whose facts moved.
    ('D-01', [(TRANS, "    return isDecided(existing.state)\n      ? { kind: 'SOURCE_CHANGED', prior: existing.state }\n      : { kind: 'FACTS_UPDATED' };", "    return { kind: 'FACTS_UPDATED' };")], T_DOM, 'SOURCE_CHANGED'),
    ('D-02', [(TRANS, "  return isDecided(existing.state)\n    ? { kind: 'SOURCE_CHANGED', prior: existing.state }\n    : { kind: 'MARK_MISSING' };", "  return { kind: 'MARK_MISSING' };")], T_DOM, 'vanished'),
    # Only an approval bound to the current facts of THE approved read exports.
    ('D-03', [(TRANS, "    row.approvedFactsChecksum === row.factsChecksum &&\n", "")], T_DOM, 'only an approval'),
    ('D-04', [(TRANS, "    row.readFingerprint === readFingerprint &&\n", "")], T_DOM, 'only an approval'),
    ('D-05', [(TRANS, "    row.missingSinceReadFingerprint === null &&\n", "")], T_DOM, 'only an approval'),
    # Parsing never guesses.
    ('D-06', [(FACTS, "  if (bytes === 0n) return { note: 'ZERO_MEANING_UNKNOWN' };\n", "")], T_DOM, 'parsing'),
    ('D-07', [(FACTS, "  const code = (raw ?? '').trim();", "  const code = raw ?? '';")], T_DOM, 'review key'),
    ('D-08', [(FACTS, "  if (rows.length > 1) {", "  if (false) {")], T_DOM, 'duplicated'),
    # The draft can never be sold by this flow.
    ('D-09', [(SVC, "    price: null,\n    display: EMPTY_PRODUCT_DISPLAY,", "    price: { amountMinor: 1n as never, currency: 'IRT' },\n    display: EMPTY_PRODUCT_DISPLAY,")], T_DOM, 'draft'),
    ('D-10', [(SVC, "    audience: 'HIDDEN',\n    sortOrder: 0,", "    audience: 'EVERYONE',\n    sortOrder: 0,")], T_BOUND, 'draft none'),
    # Decisions: bound to the facts shown, refused for an absent or duplicated code.
    ('I-01', [(SVC, "  if (row.factsChecksum !== expectedFactsChecksum) {", "  if (false) {")], T_INT, 'approve-existing maps'),
    ('I-02', [(SVC, "  if (row.missingSinceReadFingerprint !== null) {\n    throw errors.conflict(\n      LEGACY_PRODUCT_REVIEW_ERROR_CODES.SOURCE_ABSENT,", "  if (false) {\n    throw errors.conflict(\n      LEGACY_PRODUCT_REVIEW_ERROR_CODES.SOURCE_ABSENT,")], T_INT, 'snapshot B'),
    ('I-03', [(SVC, "  if (row.sourceConflict !== null) {\n    throw errors.conflict(", "  if (false) {\n    throw errors.conflict(")], T_INT, 'duplicated code'),
    # Approve-as-new is refused, and audited, without catalog.edit.
    ('I-04', [(SVC, "      catalogEdit: true,", "      catalogEdit: false,")], T_INT, 'permissions'),
    # Reads charge legacy.products.view, which an observer does not hold.
    ('I-05', [(SVC, "    await this.deps.guard.check(scope, actor, LEGACY_PRODUCTS_VIEW_PERMISSION);\n    const limit", "    await this.deps.guard.check(scope, actor, 'catalog.view');\n    const limit")], T_INT, 'permissions'),
    # Tenant isolation at the repository.
    ('I-06', [(REPO, "      .where(and(eq(legacyProductReviews.tenantId, tenantId), eq(legacyProductReviews.id, id)))\n      .limit(1);\n    const rows = options.forUpdate", "      .where(eq(legacyProductReviews.id, id))\n      .limit(1);\n    const rows = options.forUpdate")], T_INT, 'tenant isolation'),
    # The ingest: absent codes are marked; nothing is written without the products approval.
    ('I-07', [(SVC, "      const absent = await this.deps.repository.absentFrom(scope, read.readSetFingerprint, 200);", "      const absent: LegacyProductReviewRecord[] = [];")], T_INT, 'snapshot B'),
    ('I-08', [(SVC, "        await this.assertScopeActive(scope, tx);\n        await fn(tx, this.deps.clock.now());", "        await fn(tx, this.deps.clock.now());")], T_INT, 'stopped tenant'),
    # The export follows the approved read only.
    ('I-09', [(SVC, "    if (rows.length === 0 || stale.length > 0) {", "    if (rows.length === 0) {")], T_INT, 'snapshot B'),
    # The draft's order refusal rests on INACTIVE, and the review never activates.
    ('I-10', [(SVC, "        const created = await this.deps.products.createWithin(scope, actor, draft, tx);", "        const created = await this.deps.products.createWithin(scope, actor, draft, tx);\n        await tx.tx.execute(sql`UPDATE products SET status = 'ACTIVE' WHERE id = ${created.id}`);"), (SVC, "import type { PermissionGuard }", "import { sql } from 'drizzle-orm';\nimport type { PermissionGuard }")], T_INT, 'approve-as-new'),
    # Codex #231 P1: a code absent from two reads in a row is acknowledged by the later one.
    ('D-11', [(TRANS, "  if (existing.missingSinceReadFingerprint !== null) return { kind: 'STILL_ABSENT' };", "  if (existing.missingSinceReadFingerprint !== null) return { kind: 'NONE' };")], T_DOM, 'LATER read'),
    ('I-11', [(REPO, "          or(\n            isNull(legacyProductReviews.missingSinceReadFingerprint),\n            ne(legacyProductReviews.missingSinceReadFingerprint, readFingerprint),\n          ),", "          isNull(legacyProductReviews.missingSinceReadFingerprint),")], T_INT, 'absent from two reads'),
    # The permission is MEDIUM: a LOW key is handed to every observer.
    ('C-01', [(PERMS, "  p('legacy.products.view', 'View the legacy product review', 'MEDIUM'),", "  p('legacy.products.view', 'View the legacy product review', 'LOW'),")], T_INT, 'permissions'),
    # The nav entry is gated on its own key.
    ('W-01', [(NAV, "    permission: 'legacy.products.view',\n    group: 'web.navgroup_sales',", "    permission: ['catalog.view', 'legacy.products.view'],\n    group: 'web.navgroup_sales',")], T_WEB, 'gated'),
]


def rebuild_contracts():
    subprocess.run(['pnpm', '--filter', '@nexa/contracts', 'build'], capture_output=True, check=True)


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
    contract = any(f.startswith('packages/contracts') for f, _, _ in edits)
    if ok:
        if contract:
            rebuild_contracts()
        ran += 1
        r = subprocess.run(['pnpm', 'exec', 'vitest', 'run', '--project', project, test, '-t', filt],
                           capture_output=True, text=True)
        out = r.stdout + r.stderr
        summ = [line.strip() for line in out.splitlines() if 'Tests ' in line]
        if r.returncode != 0:
            killed += 1
        print(mid, 'KILLED' if r.returncode != 0 else 'SURVIVED', summ, flush=True)
    for f, s in originals.items():
        open(f, 'w').write(s)
    if contract:
        rebuild_contracts()
print(f'{killed} of {ran} killed', flush=True)
