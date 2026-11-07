import { CAPACITY_DISK_CRITICAL_PERCENT, type HostingCapacityEstimate } from '@nexa/contracts';

/**
 * Phase 6A PR-3: how many more hosted bots this server fits — the creator panel's card.
 *
 * Every number is `docs/capacity/after-guards.md` § "How many bots this server holds":
 *
 * - one API process saturates at ~60 webhook updates/s; within p95 < 1 s WITH the nightly
 *   backup and a broadcast running, it holds about 75 concurrently active customers on the
 *   4 vCPU target (more cores do not raise it: the limit is the one API process, so a
 *   smaller server scales it DOWN and a bigger one does not scale it up);
 * - the owner's own bot is budgeted 25 of them;
 * - a small hosted bot peaks at ~1 concurrent customer, a medium one at 3, a large one at 10;
 * - memory is not the limit there — but a server already below the owner's free-memory
 *   alert floor, or with a disk at the critical 90 %, fits nothing more whatever the CPU says.
 *
 * Every live hosted bot (ACTIVE) is counted as small: that is the conservative reading for
 * the existing ones only if they really are small, and the card says it is an estimate.
 */
export const ESTIMATE_CONCURRENT_BUDGET = 75;
export const ESTIMATE_TARGET_CORES = 4;
export const ESTIMATE_OWNER_RESERVED = 25;
export const ESTIMATE_PER_SMALL_BOT = 1;
export const ESTIMATE_PER_MEDIUM_BOT = 3;
export const ESTIMATE_PER_LARGE_BOT = 10;

export const ESTIMATE_FORMULA =
  'budget = floor(75 × min(1, cores ÷ 4)); headroom = max(0, budget − 25 − live hosted bots × 1); ' +
  'more = headroom ÷ 1 small, ⌊headroom ÷ 3⌋ medium, ⌊headroom ÷ 10⌋ large; 0 while free ' +
  'memory is below the alert floor or a disk is ≥ 90 % (docs/capacity/after-guards.md)';

export function estimateCapacity(input: {
  readonly cores: number;
  readonly liveHostedBots: number;
  readonly availableMemoryBytes: number | null;
  readonly memoryFloorBytes: number;
  readonly diskUsedPercents: readonly number[];
}): HostingCapacityEstimate {
  const cores = Math.max(1, Math.floor(input.cores));
  const budget = Math.floor(
    ESTIMATE_CONCURRENT_BUDGET * Math.min(1, cores / ESTIMATE_TARGET_CORES),
  );
  const used = ESTIMATE_OWNER_RESERVED + input.liveHostedBots * ESTIMATE_PER_SMALL_BOT;
  let headroom = Math.max(0, budget - used);
  let blockedBy: HostingCapacityEstimate['blockedBy'] = null;
  if (input.availableMemoryBytes !== null && input.availableMemoryBytes < input.memoryFloorBytes) {
    blockedBy = 'MEMORY';
  } else if (input.diskUsedPercents.some((used) => used >= CAPACITY_DISK_CRITICAL_PERCENT)) {
    blockedBy = 'DISK';
  }
  if (blockedBy !== null) headroom = 0;
  return {
    formula: ESTIMATE_FORMULA,
    budgetConcurrentCustomers: budget,
    ownerReserved: ESTIMATE_OWNER_RESERVED,
    liveHostedBots: input.liveHostedBots,
    headroom,
    moreSmallBots: Math.floor(headroom / ESTIMATE_PER_SMALL_BOT),
    moreMediumBots: Math.floor(headroom / ESTIMATE_PER_MEDIUM_BOT),
    moreLargeBots: Math.floor(headroom / ESTIMATE_PER_LARGE_BOT),
    blockedBy,
  };
}
