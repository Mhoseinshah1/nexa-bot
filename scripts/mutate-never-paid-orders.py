"""Never-paid Mirza orders: mutation driver (owner instruction 2026-10-18).

Reverts one rule at a time, runs the named tests, and restores the mutated file with
`git checkout`. NP-15 is a DATABASE mutation: it drops the 0253 `nexa_orders_history_frozen`
trigger, runs the lanes test, and recreates the trigger exactly as 0253 does.

Run it in a WORKTREE of its own (CLAUDE.md, reviewing with agents), with a clean tree and the
integration environment exported (TEST_DATABASE_URL / DATABASE_URL pointing at a database
nothing else is using, REDIS_URL, SECRETS_KEK, SECRETS_KEK_ID). One subprocess at a time.
Every line printed must read KILLED; SURVIVED means a rule has no test.

Usage: python3 scripts/mutate-never-paid-orders.py [NP-01 NP-15 ...]
"""
import os
import subprocess
import sys

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

S = 'apps/api/src/modules/platform/legacy-materialize/'
R = S + 'application/ended-services.rules.ts'
T = S + 'application/terminated-services.step.ts'
D = S + 'infrastructure/drizzle-ended-services.repository.ts'
U = 'tests/unit/ended-services-rules.test.ts'
NP = 'tests/integration/legacy-never-paid-orders.test.ts'
LN = 'tests/integration/legacy-never-paid-orders-lanes.test.ts'

TRIGGER_DROP = 'DROP TRIGGER nexa_orders_history_frozen ON orders'
TRIGGER_CREATE = """CREATE TRIGGER nexa_orders_history_frozen
  BEFORE UPDATE OF state, subtotal_amount, discount_amount, total_amount, settled_at,
                   cancelled_at, refunded_at ON orders
  FOR EACH ROW
  WHEN (OLD.origin = 'LEGACY_HISTORY' AND (
          NEW.state IS DISTINCT FROM OLD.state
       OR NEW.subtotal_amount IS DISTINCT FROM OLD.subtotal_amount
       OR NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
       OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
       OR NEW.settled_at IS DISTINCT FROM OLD.settled_at
       OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.refunded_at IS DISTINCT FROM OLD.refunded_at))
  EXECUTE FUNCTION nexa_orders_history_frozen()"""

MUTATIONS = [
 ('NP-01 Unsuccessful->EXPIRED',R,"if (status === 'Unsuccessful') return 'CANCELLED';","if (status === 'Unsuccessful') return 'EXPIRED';",[('unit',U),('int',NP)]),
 ('NP-02 NULL unmapped',R,"if (status === null) return 'EXPIRED';","if (status === null) return null;",[('unit',U),('int',NP)]),
 ('NP-03 never-paid back to a gap',R,"    return { kind: 'NEVER_PAID', state };","    return { kind: 'GAP', reason: 'NEVER_PAID' };",[('unit',U),('int',NP)]),
 ('NP-04 ref collides with invoice:',R,"return `${NEVER_PAID_REF_PREFIX}${invoiceKey}`;","return `invoice:${invoiceKey}`;",[('unit',U),('int',NP)]),
 ('NP-05 counts drop never-paid rows',D,"AND (source_ref LIKE 'invoice:%' OR source_ref LIKE 'invoice-never-paid:%'))\n          AS orders,","AND source_ref LIKE 'invoice:%')\n          AS orders,",[('int',NP)]),
 ('NP-06 paid money includes unpaid',D,"AND origin = 'LEGACY_HISTORY' AND state = 'PAID'","AND origin = 'LEGACY_HISTORY'",[('int',NP)]),
 ('NP-07 bucket not named',T,"orderGap(NEVER_PAID_AMOUNT_BUCKET, 0, price);","orderGap(NEVER_PAID_AMOUNT_BUCKET, 0, 0n);",[('int',NP)]),
 ('NP-08 key check dropped',T,"if (!row.keyShapeEvidenced) return gap('NEVER_PAID_KEY_INVALID');","",[('int',NP)]),
 ('NP-09 owner check -> other reason',T,"if (customerId === undefined) return gap('NEVER_PAID_OWNER_NOT_IMPORTED');","if (customerId === undefined) return gap('NEVER_PAID_NO_PANEL');",[('int',NP)]),
 ('NP-10 diverged ignores customer',T,"    existing.orderState === insert.state &&\n    existing.orderCustomerId === insert.customerId &&","    existing.orderState === insert.state &&",[('unit',U),('int',NP)]),
 ('NP-11 diverged ignores a service beside it',T,"    existing.serviceId === null &&\n","",[('unit',U)]),
 ('NP-12 ended check ignores PAID',T,"    existing.orderState === 'PAID' &&\n","",[('unit',U)]),
 ('NP-13 never-paid written as a service-less PAID order',D,"(${input.orderId}, ${tenantId}, ${input.customerId}, ${input.state}, 'NEW_SERVICE',","(${input.orderId}, ${tenantId}, ${input.customerId}, 'PAID', 'NEW_SERVICE',",[('int',NP)]),
 ('NP-14 created_at = import time always',T,"      createdAt: originalDate(row, ctx),","      createdAt: ctx.now,",[('int',NP)]),
]


def run_test(kind, path):
    if kind == 'unit':
        cmd = ['npx', 'vitest', 'run', '--project', 'unit', path]
    else:
        cmd = ['pnpm', 'test:integration', path]
    return subprocess.run(cmd, capture_output=True, text=True).returncode != 0


def psql(statement):
    url = os.environ['TEST_DATABASE_URL']
    subprocess.run(['psql', url, '-v', 'ON_ERROR_STOP=1', '-c', statement], check=True,
                   capture_output=True)


def main():
    only = set(sys.argv[1:])
    if subprocess.run(['git', 'diff', '--quiet']).returncode != 0:
        sys.exit('the tree is not clean')
    survived = 0
    for name, path, before, after, tests in MUTATIONS:
        if only and name.split()[0] not in only:
            continue
        text = open(path).read()
        if text.count(before) != 1:
            print(name, 'ANCHOR NOT FOUND EXACTLY ONCE')
            survived += 1
            continue
        open(path, 'w').write(text.replace(before, after))
        try:
            results = [(t, run_test(kind, t)) for kind, t in tests]
        finally:
            subprocess.run(['git', 'checkout', '--', path], check=True)
        survived += sum(1 for _, killed in results if not killed)
        print(name, ' '.join(f"{t.split('/')[-1]}:{'KILLED' if k else 'SURVIVED'}"
                             for t, k in results), flush=True)
    name = 'NP-15 the 0253 history-order trigger dropped'
    if not only or 'NP-15' in only:
        psql(TRIGGER_DROP)
        try:
            killed = run_test('int', LN)
        finally:
            psql(TRIGGER_CREATE)
        survived += 0 if killed else 1
        print(name, f"{LN.split('/')[-1]}:{'KILLED' if killed else 'SURVIVED'}", flush=True)
    sys.exit(1 if survived else 0)


if __name__ == '__main__':
    main()
