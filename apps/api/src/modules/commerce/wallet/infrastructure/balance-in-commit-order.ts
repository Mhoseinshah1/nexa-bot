import { sql } from 'drizzle-orm';

/**
 * `(p1, p2, …)` for an `IN`, one bound parameter per element. Never called with an empty
 * list: `IN ()` is not SQL, so every caller answers that case first.
 */
export const idList = (values: readonly string[]): ReturnType<typeof sql> =>
  sql`(${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;

/**
 * ONE statement answering "what did the wallet hold the instant these entries committed" —
 * the single reader behind the operations log (`balanceAround`), the refund message
 * (`refundedForOrder`) and the administrative-adjustment message (`adminAdjustmentFor`).
 *
 * The ORDER the balance is summed in is the whole rule (independent money review of #301,
 * and Round 5A item 3 for the two customer-message readers that had kept the old one).
 * `created_at` is not it: every writer stamps its entry from the clock BEFORE it takes the
 * customer lock (`WalletService.adjust`, `settleFromWallet`), and an operator's credit takes
 * no customer lock at all, so a debit that waited for the lock while a credit committed
 * carries the EARLIER stamp — summed by `created_at`, a 100 000 → 0 debit read 0 → -100 000.
 *
 * Commit order is recorded already, under a lock every writer takes: each entry's
 * `WalletEntryRecorded` event is written in the entry's own transaction, and its
 * per-aggregate `sequence` comes from the `('Wallet', customer)` row of `aggregate_sequences`,
 * whose row lock is held until that transaction commits. So for one customer a higher
 * sequence is a later commit, and the sum of every entry whose event sequence is at most the
 * group's last is the balance the instant the group committed. An entry with no event is
 * placed by `(created_at, id)` against the last.
 *
 * Yields one row: `found` (some named entry exists), `after` (balance at the group's last
 * commit) and `own` (the signed sum of the named entries, so `before = after - own`), the
 * two figures as text because `SUM` over bigint is numeric.
 */
export function balanceInCommitOrder(input: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly currency: string;
  readonly entryIds: readonly string[];
}): ReturnType<typeof sql> {
  const { tenantId, customerId, currency, entryIds } = input;
  return sql`WITH ev AS (
            SELECT m.payload ->> 'entryId' AS entry_id, min(m.sequence) AS seq
              FROM outbox_messages m
             WHERE m.tenant_id = ${tenantId} AND m.aggregate_type = 'Wallet'
               AND m.aggregate_id = ${customerId} AND m.event_type = 'WalletEntryRecorded'
             GROUP BY 1
          ), e AS (
            SELECT w.id, w.created_at, ev.seq,
                   CASE w.direction WHEN 'CREDIT' THEN w.amount ELSE -w.amount END AS signed
              FROM wallet_entries w
              LEFT JOIN ev ON ev.entry_id = w.id::text
             WHERE w.tenant_id = ${tenantId} AND w.customer_id = ${customerId}
               AND w.currency = ${currency}
          ), last AS (
            SELECT e.seq, e.created_at, e.id FROM e
             WHERE e.id::text IN ${idList(entryIds)}
             ORDER BY e.seq DESC NULLS LAST, e.created_at DESC, e.id DESC
             LIMIT 1
          )
          SELECT EXISTS (SELECT 1 FROM last) AS found,
                 (SELECT COALESCE(SUM(e.signed), 0) FROM e, last
                   WHERE CASE WHEN e.seq IS NOT NULL AND last.seq IS NOT NULL
                              THEN e.seq <= last.seq
                              ELSE (e.created_at, e.id) <= (last.created_at, last.id) END
                 )::text AS after,
                 (SELECT COALESCE(SUM(e.signed), 0) FROM e
                   WHERE e.id::text IN ${idList(entryIds)})::text AS own`;
}
