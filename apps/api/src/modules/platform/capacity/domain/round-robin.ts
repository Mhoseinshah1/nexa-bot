/**
 * Phase 6A PR-2: background work taken in TURNS across bots, so one long queue cannot
 * starve the others.
 *
 * Each group is one bot's (tenant's) due work, oldest first. A round gives every group with
 * work left `weight` items — the owner's own bot a double turn by default — and rounds
 * repeat until `limit` items are taken or nothing is left. Within a group the order is kept
 * exactly as given, so a lane that promises per-aggregate order (the outbox) keeps it; only
 * the interleaving ACROSS groups is decided here.
 *
 * `rotation` moves which group goes first in each round, so with a batch smaller than one
 * round the same bot is not always the one served: a caller passes a counter it advances on
 * every pass. Groups are ordered by key first, so the plan is deterministic for a given
 * input and rotation.
 *
 * Pure. Never drops an item it was given beyond `limit`, never duplicates one.
 */
export interface TurnGroup<T> {
  readonly key: string;
  /** Items per round; at least 1 (a weight below 1 is read as 1). */
  readonly weight: number;
  readonly items: readonly T[];
}

export function weightedRoundRobin<T>(
  groups: readonly TurnGroup<T>[],
  limit: number,
  rotation = 0,
): T[] {
  const ordered = [...groups]
    .filter((group) => group.items.length > 0)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const taken: T[] = [];
  if (ordered.length === 0 || limit <= 0) return taken;
  const cursors = ordered.map(() => 0);
  const start = ((rotation % ordered.length) + ordered.length) % ordered.length;
  let progressed = true;
  while (taken.length < limit && progressed) {
    progressed = false;
    for (let step = 0; step < ordered.length && taken.length < limit; step += 1) {
      const index = (start + step) % ordered.length;
      const group = ordered[index] as TurnGroup<T>;
      const turn = Math.max(1, Math.floor(group.weight));
      for (let n = 0; n < turn && taken.length < limit; n += 1) {
        const cursor = cursors[index] as number;
        if (cursor >= group.items.length) break;
        taken.push(group.items[cursor] as T);
        cursors[index] = cursor + 1;
        progressed = true;
      }
    }
  }
  return taken;
}

/** Groups items by a key, keeping their order within each group. Pure. */
export function groupInOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  weightOf: (key: string) => number,
): TurnGroup<T>[] {
  const byKey = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = byKey.get(key);
    if (list === undefined) byKey.set(key, [item]);
    else list.push(item);
  }
  return [...byKey.entries()].map(([key, list]) => ({ key, weight: weightOf(key), items: list }));
}
