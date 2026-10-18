import {
  MATERIALIZE_PAGE,
  applyPlanned,
  at,
  gap,
  matchPlanned,
  mirzaIdOf,
  mirzaInstant,
  sourceRefOf,
  text,
  write,
  type HistoryRecord,
  type MaterializeDeps,
  type Planned,
  type PlannedRepository,
  type PlannedStep,
  type PlannedWrite,
} from './materialize-support.js';
import type {
  ExactMatchRow,
  MaterializeContext,
  MaterializeStep,
  MaterializeStepOutcome,
} from './ports.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { TenantContext } from '@nexa/contracts';

/**
 * Mirza `reagent_report` into `referrals` (plan §3, §5-2): who invited whom, and when.
 *
 * A referral is an ATTRIBUTION, and an attribution pays nobody. The row is written with
 * `rewarded_at` and `reward_entry_id` both NULL (the pair CHECK allows nothing else without
 * a ledger entry, and there is none): the invitation gift Mirza paid is already inside
 * `user.Balance`, and a commission is a NEXA promise made at an order's confirmation. What
 * keeps a `MIRZA` referral from being paid now is not this step but a filter in the services
 * that could — `referral-signup-gift` (`openSides`, `lockReferralsOf`) and the commission
 * promise — each tested to fail without it.
 *
 * The trigger is `ON_SIGNUP`: Mirza's table records the sign-up attribution. A referee who
 * already has a referral (one attribution per referee, for ever) is not given a second.
 */

export const REFERRAL_HISTORY_STEP = 'referral-history';
export const REFERRAL_SOURCE_REF_PREFIX = 'referral';

export interface ReferralWrite extends PlannedWrite {
  readonly referrerId: string;
  readonly refereeId: string;
  readonly createdAt: Date;
}

export const referralFingerprint = (r: {
  readonly referrerId: string;
  readonly refereeId: string;
  readonly createdAt: Date;
}): string => [r.referrerId, r.refereeId, r.createdAt.toISOString()].join('|');

export interface ReferralHistoryRepository extends PlannedRepository<ReferralWrite> {
  /** Referee -> the `source_ref` of the referral they already have (null for a NEXA one). */
  existingByReferee(
    scope: TenantContext,
    refereeIds: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, string | null>>;
}

const telegramId = (record: HistoryRecord, side: 'referrer' | 'referee'): string | null =>
  text(at(record.payload, side, 'telegram_user_id'));

export class ReferralHistoryStep implements MaterializeStep {
  readonly name = REFERRAL_HISTORY_STEP;
  private readonly step: PlannedStep<ReferralWrite>;
  private readonly winners = new WeakMap<
    MaterializeContext,
    Promise<ReadonlyMap<string, string>>
  >();

  constructor(
    private readonly deps: MaterializeDeps,
    repository: ReferralHistoryRepository,
  ) {
    this.step = {
      name: REFERRAL_HISTORY_STEP,
      recordType: 'referral',
      repository,
      plan: async (records, ctx, tx) => {
        const customers = await deps.records.customersByLegacyUser(
          ctx.scope,
          records.flatMap((r) =>
            [telegramId(r, 'referrer'), telegramId(r, 'referee')].flatMap((id) =>
              id === null ? [] : [id],
            ),
          ),
          tx,
        );
        const existing = await repository.existingByReferee(ctx.scope, [...customers.values()], tx);
        const winners = await this.winnersOf(ctx);
        return records.map((record) => planReferral(record, customers, existing, winners));
      },
    };
  }

  /**
   * Of several Mirza rows for one referee (one attribution per referee, for ever), the one
   * that is carried: the earliest valid one, ties broken by Mirza id. Decided over the whole
   * table before any row is planned, so the result never depends on the order records are
   * read or on which page they fall in.
   */
  private winnersOf(ctx: MaterializeContext): Promise<ReadonlyMap<string, string>> {
    let cached = this.winners.get(ctx);
    if (cached === undefined) {
      cached = this.chooseWinners(ctx);
      this.winners.set(ctx, cached);
    }
    return cached;
  }

  private async chooseWinners(ctx: MaterializeContext): Promise<ReadonlyMap<string, string>> {
    const best = new Map<string, { readonly rank: string; readonly ref: string }>();
    let after: string | null = null;
    for (;;) {
      const page: readonly HistoryRecord[] = await this.deps.records.page(
        ctx.scope,
        ctx.packageImportId,
        'referral',
        after,
        MATERIALIZE_PAGE,
      );
      const customers = await this.deps.records.customersByLegacyUser(
        ctx.scope,
        page.flatMap((r) =>
          [telegramId(r, 'referrer'), telegramId(r, 'referee')].flatMap((id) =>
            id === null ? [] : [id],
          ),
        ),
      );
      for (const record of page) {
        const parties = partiesOf(record, customers);
        if (parties === null) continue;
        const ref = referralRefOf(record);
        if (ref === null) continue;
        const rank = `${String(parties.createdAt.getTime()).padStart(16, '0')}|${ref.padStart(40, '0')}`;
        const current = best.get(parties.refereeId);
        if (current === undefined || rank < current.rank)
          best.set(parties.refereeId, { rank, ref });
      }
      if (page.length < MATERIALIZE_PAGE) break;
      after = (page[page.length - 1] as HistoryRecord).id;
    }
    return new Map([...best].map(([referee, { ref }]) => [referee, ref]));
  }

  apply(ctx: MaterializeContext): Promise<MaterializeStepOutcome> {
    return applyPlanned(this.deps, this.step, ctx);
  }

  async match(ctx: MaterializeContext): Promise<readonly ExactMatchRow[]> {
    return [
      await matchPlanned(this.deps, this.step, ctx, {
        mirzaTable: 'reagent_report',
        nexaTable: 'referrals',
        hasAmount: false,
      }),
    ];
  }
}

function referralRefOf(record: HistoryRecord): string | null {
  const id = mirzaIdOf(record);
  return id === null ? null : sourceRefOf(REFERRAL_SOURCE_REF_PREFIX, id);
}

/** Both parties imported and distinct, and a readable time: what makes a row carriable at all. */
function partiesOf(
  record: HistoryRecord,
  customers: ReadonlyMap<string, string>,
): { readonly referrerId: string; readonly refereeId: string; readonly createdAt: Date } | null {
  const referrerTg = telegramId(record, 'referrer');
  const refereeTg = telegramId(record, 'referee');
  const referrerId = referrerTg === null ? null : (customers.get(referrerTg) ?? null);
  const refereeId = refereeTg === null ? null : (customers.get(refereeTg) ?? null);
  if (referrerId === null || refereeId === null || referrerId === refereeId) return null;
  const createdAt = mirzaInstant(record.payload['attributed_at']);
  return createdAt === null ? null : { referrerId, refereeId, createdAt };
}

export function planReferral(
  record: HistoryRecord,
  customers: ReadonlyMap<string, string>,
  existingByReferee: ReadonlyMap<string, string | null>,
  winnerByReferee: ReadonlyMap<string, string>,
): Planned<ReferralWrite> {
  const sourceRef = referralRefOf(record);
  if (sourceRef === null) return gap('SOURCE_ID_UNUSABLE');
  const referrerTg = telegramId(record, 'referrer');
  const refereeTg = telegramId(record, 'referee');
  const referrerId = referrerTg === null ? null : (customers.get(referrerTg) ?? null);
  const refereeId = refereeTg === null ? null : (customers.get(refereeTg) ?? null);
  if (referrerId === null || refereeId === null) return gap('REFERRAL_PARTY_MISSING');
  if (referrerId === refereeId) return gap('REFERRAL_SELF');
  const createdAt = mirzaInstant(record.payload['attributed_at']);
  if (createdAt === null) return gap('UNPARSEABLE_TIME');
  const taken = existingByReferee.get(refereeId);
  if (taken !== undefined && taken !== sourceRef) return gap('REFEREE_ALREADY_REFERRED');
  if (winnerByReferee.get(refereeId) !== sourceRef) return gap('REFEREE_ALREADY_REFERRED');
  const fields = { referrerId, refereeId, createdAt };
  return write<ReferralWrite>({ sourceRef, fingerprint: referralFingerprint(fields), ...fields });
}
