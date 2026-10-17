import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ResellersRepository } from './catalog-ports.js';
import {
  MIRZA_AGENT_TIERS,
  agentIdOfKey,
  recOf,
  resellerFacts,
  resellerSourceDetail,
  textOf,
  type HistoryRow,
  type MirzaAgentTier,
  type Rec,
  type ResellerFacts,
  type ResellerGapReason,
} from './catalog-records.js';
import {
  bump,
  inCatalogTransaction,
  outcome,
  type CatalogStepDeps,
  type CatalogStepOutcome,
} from './catalog-step-support.js';
import type { ExactMatchRow, ExplainedGap, MaterializeContext, MaterializeStep } from './ports.js';

export const RESELLERS_STEP_NAME = 'catalog-resellers';

/** One profile, its facts when it names an owner, and the customer it resolves to. */
interface Candidate {
  readonly profile: HistoryRow;
  readonly facts: ResellerFacts | null;
  readonly customerId: string | null;
}

/**
 * Mirza agents → NEXA `resellers` (ACTIVE), `source = 'MIRZA'`, `source_ref = 'agent:<id>'`.
 *
 * MONEY. This step writes no wallet entry and no ledger row, ever; a reseller's wallet is
 * exactly what the customers phase posted from Mirza's `Balance`. `maxbuyagent` is a LIMIT:
 * it is stored as `imported_purchase_cap_minor`, shown to the owner and read by NOTHING that
 * decides a purchase, a balance or a price. There is no credit line and no debt — the row is
 * written with no own credit limit, under a tier whose limit is zero.
 *
 * PRICES. Mirza's `pricediscount` (a per-user percent off) is applied as the reseller's own
 * percentage override (a `USER_OVERRIDE` step — never a discount) when it is a whole number
 * 1..99. Per-tier custom prices have no proven meaning (`price_semantics: UNKNOWN`): they are
 * kept, reversibly, in `source_detail` and the reseller starts on normal prices.
 *
 * TIERS. `n` and `n2` each become one NEXA tier priced at list. Mirza had no entitlement
 * concept and NEXA denies by default, so a tier created here carries one wildcard grant per
 * dimension — what an ordinary customer can already buy, no more — which the owner narrows on
 * the tier page. A tier that already exists by name is used as it stands and never edited.
 */
export class ResellersMaterializeStep implements MaterializeStep {
  readonly name = RESELLERS_STEP_NAME;

  constructor(
    private readonly repository: ResellersRepository,
    private readonly deps: CatalogStepDeps,
  ) {}

  private async load(ctx: MaterializeContext, tx?: TransactionScope) {
    const [profiles, states, levels] = await Promise.all([
      this.repository.rows(ctx.scope, ctx.packageImportId, 'agent_profile', tx),
      this.repository.rows(ctx.scope, ctx.packageImportId, 'agent_state', tx),
      this.repository.rows(ctx.scope, ctx.packageImportId, 'agent_price_level', tx),
    ]);
    const stateOf = new Map<string, HistoryRow>();
    for (const s of states) {
      const id = agentIdOfKey(s.idempotencyKey);
      if (id !== null) stateOf.set(id, s);
    }
    const levelsOf = new Map<string, Rec[]>();
    for (const l of levels) {
      const owner =
        textOf(recOf(l.payload['owner'])['raw_id']) ?? textOf(l.payload['owner_value_raw']);
      if (owner === null || owner === '') continue;
      const list = levelsOf.get(owner) ?? [];
      list.push(l.payload);
      levelsOf.set(owner, list);
    }
    const bare = profiles.map((profile) => {
      const id = agentIdOfKey(profile.idempotencyKey);
      return {
        profile,
        facts:
          id === null
            ? null
            : resellerFacts(profile, stateOf.get(id) ?? null, levelsOf.get(id) ?? []),
      };
    });
    const unresolved = bare.flatMap((c) =>
      c.facts !== null && c.facts.customerId === null && c.facts.telegramUserId !== null
        ? [c.facts.telegramUserId]
        : [],
    );
    const byTelegram = await this.repository.customersByTelegram(ctx.scope, unresolved, tx);
    const candidates: Candidate[] = bare.map((c) => ({
      ...c,
      customerId:
        c.facts === null
          ? null
          : (c.facts.customerId ??
            (c.facts.telegramUserId === null
              ? null
              : (byTelegram.get(c.facts.telegramUserId) ?? null))),
    }));
    return { candidates, levels, levelsOf };
  }

  async apply(ctx: MaterializeContext): Promise<CatalogStepOutcome> {
    return inCatalogTransaction(this.deps, ctx, async (tx) => {
      const { candidates } = await this.load(ctx, tx);
      const skipped: Record<string, number> = {};
      const notes: Record<string, number> = {};
      const eligible: Eligible[] = [];
      for (const c of candidates) {
        const gap = gapOf(c);
        if (gap !== null) bump(skipped, gap);
        else eligible.push(c as Eligible);
      }
      const refs = eligible.map((c) => c.facts.sourceRef);
      const existing = await this.repository.resellersBySourceRef(ctx.scope, refs, tx);
      const alreadyReseller = await this.repository.resellerCustomers(
        ctx.scope,
        eligible.map((c) => c.customerId),
        tx,
      );
      let alreadyPresent = 0;
      let diverged = 0;
      const fresh: typeof eligible = [];
      for (const c of eligible) {
        const there = existing.get(c.facts.sourceRef);
        if (there !== undefined) {
          if (there.customerId === c.customerId) alreadyPresent += 1;
          else diverged += 1;
        } else if (alreadyReseller.has(c.customerId)) {
          bump(skipped, 'CUSTOMER_ALREADY_RESELLER' satisfies ResellerGapReason);
        } else fresh.push(c);
      }

      const tierIds = new Map<MirzaAgentTier, string>();
      for (const tier of new Set(fresh.map((c) => c.facts.tier))) {
        tierIds.set(
          tier,
          await this.repository.ensureTier(
            ctx.scope,
            tier,
            MIRZA_AGENT_TIERS[tier],
            { tierId: this.deps.ids.uuid() },
            ctx.now,
            tx,
          ),
        );
      }
      const written = await this.repository.insertResellers(
        ctx.scope,
        fresh.map((c) => ({
          id: this.deps.ids.uuid(),
          sourceRef: c.facts.sourceRef,
          customerId: c.customerId,
          tierId: tierIds.get(c.facts.tier) as string,
          percent: c.facts.appliedPercent,
          capMinor: c.facts.capMinor,
          detail: resellerSourceDetail(c.facts),
        })),
        ctx.now,
        tx,
      );
      for (const c of fresh) {
        if (!written.has(c.facts.sourceRef)) {
          alreadyPresent += 1;
          continue;
        }
        if (c.facts.appliedPercent !== null) bump(notes, 'PERCENT_OVERRIDE_APPLIED');
        if (c.facts.capMinor !== null) bump(notes, 'PURCHASE_CAP_STORED_NOT_APPLIED');
        if (c.facts.priceLevels.length > 0) bump(notes, 'TIER_PRICES_KEPT_NOT_APPLIED');
      }
      return outcome(
        this.name,
        { written: written.size, alreadyPresent, diverged },
        skipped,
        notes,
      );
    });
  }

  async match(ctx: MaterializeContext): Promise<readonly ExactMatchRow[]> {
    const { candidates, levels, levelsOf } = await this.load(ctx);
    const refs = await this.repository.mirzaResellerRefs(ctx.scope);
    const totals = await this.repository.mirzaResellerTotals(ctx.scope);
    const resellerCustomers = await this.repository.resellerCustomers(
      ctx.scope,
      candidates.flatMap((c) => (c.customerId === null ? [] : [c.customerId])),
    );

    const gaps = new Map<string, { rows: number; sum: bigint }>();
    const add = (reason: string, cap: bigint) => {
      const g = gaps.get(reason) ?? { rows: 0, sum: 0n };
      gaps.set(reason, { rows: g.rows + 1, sum: g.sum + cap });
    };
    let mirzaCap = 0n;
    const carried = new Set<string>();
    for (const c of candidates) {
      const cap = c.facts?.capMinor ?? 0n;
      mirzaCap += cap;
      const gap = gapOf(c);
      if (gap !== null) add(gap, cap);
      else if (c.facts !== null && refs.has(c.facts.sourceRef)) carried.add(c.facts.agentId);
      else if (c.customerId !== null && resellerCustomers.has(c.customerId)) {
        add('CUSTOMER_ALREADY_RESELLER', cap);
      }
      // anything else is carried by nobody and explained by nothing: the row will not hold
    }

    // Price levels: carried when their owner is a reseller NEXA holds, kept in its source_detail.
    const levelGaps = new Map<string, number>();
    for (const [owner, list] of levelsOf) {
      if (!carried.has(owner))
        levelGaps.set(
          'OWNER_NOT_AN_IMPORTED_RESELLER',
          (levelGaps.get('OWNER_NOT_AN_IMPORTED_RESELLER') ?? 0) + list.length,
        );
    }
    const ownerless = levels.length - [...levelsOf.values()].reduce((a, l) => a + l.length, 0);
    if (ownerless > 0) levelGaps.set('NO_OWNER', ownerless);

    const explained: ExplainedGap[] = [...gaps].map(([reason, g]) => ({
      reason,
      rows: g.rows,
      sumMinor: g.sum,
    }));
    return [
      {
        mirzaTable: 'agent',
        nexaTable: 'resellers',
        mirzaRows: candidates.length,
        nexaRows: totals.rows,
        // The sum is the purchase CAP: shown beside the rows so it is visibly not a balance.
        mirzaSumMinor: mirzaCap,
        nexaSumMinor: totals.sumMinor,
        explained,
      },
      {
        mirzaTable: 'custom_service_tier_prices',
        nexaTable: 'resellers.source_detail',
        mirzaRows: levels.length,
        nexaRows: totals.levels,
        mirzaSumMinor: null,
        nexaSumMinor: null,
        explained: [...levelGaps].map(([reason, rows]) => ({ reason, rows, sumMinor: null })),
      },
    ];
  }
}

/** A candidate that passed every gap test: an owner, an agent tier and a customer. */
type Eligible = Candidate & {
  readonly facts: ResellerFacts & { readonly tier: MirzaAgentTier };
  readonly customerId: string;
};

function gapOf(c: Candidate): ResellerGapReason | null {
  if (c.facts === null) return 'NO_OWNER';
  if (c.facts.tier === null) return 'NOT_AN_AGENT_TIER';
  if (c.customerId === null) return 'CUSTOMER_NOT_IMPORTED';
  return null;
}
