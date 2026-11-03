/**
 * NEXA v096 PR-2 — the apply's adoptions, run a few at a time per panel.
 *
 * Measured (`tests/perf/legacy-migration-scale.test.ts`, PR-2 body): `apply.services.adopt` was
 * most of the apply, and it reads NO panel — every adoption's runtime facts come from the
 * inventory the apply already read once (`adoptEligible`). Its cost is one short transaction per
 * eligible invoice (guard, scope activity, invoice lock, panel row lock, the service rows, the
 * map row, audit, outbox, the idempotency row), all of it round trips run one after another.
 *
 * So the adoptions themselves overlap, never more than `perPanel` at once on one panel and never
 * more than `total` at once overall. Each one is still exactly the transaction it was — its own
 * idempotency key, its own invoice advisory lock taken first, its own panel row lock — so
 * nothing about what is written, or about a resume, changes: a crash leaves each adoption either
 * committed or not, as before, and a resume re-decides the uncommitted ones under their locks.
 *
 * The panel's row lock (`lockPanel`, FOR UPDATE) still serialises the write half of adoptions on
 * the same panel; the cap only lets the read half of the next ones run meanwhile. `perPanel` is
 * the owner-only setting `legacy_import.adoption_concurrency_per_panel` (default 4); `total`
 * keeps a connection free in the role's pool (`DATABASE_POOL_MAX - 1`, at least 1), so a step
 * that takes a second connection inside its transaction can never starve the pool.
 */

export interface AdoptionConcurrency {
  /** At most this many adoptions on one panel at once (>= 1). */
  readonly perPanel: number;
  /** At most this many adoptions at once, whatever their panel (>= 1). */
  readonly total: number;
}

/** One at a time: the importer's behaviour before PR-2, and a caller that wires no setting. */
export const SEQUENTIAL_ADOPTION: AdoptionConcurrency = { perPanel: 1, total: 1 };

/** The effective bounds from the setting and the role's pool size; never below 1. */
export function adoptionConcurrency(perPanelSetting: number, poolMax: number): AdoptionConcurrency {
  const perPanel = Math.max(1, Math.floor(perPanelSetting));
  return { perPanel, total: Math.max(1, Math.floor(poolMax) - 1) };
}

/**
 * Runs `work` over `items`, at most `cap.perPanel` per `panelOf` key and `cap.total` overall,
 * starting them in the given order (an item whose panel is at its cap waits; a later item of
 * another panel may start before it). Results come back in the input order.
 *
 * The first failure stops anything new from starting; the ones already running are awaited
 * (each is a transaction that commits or rolls back on its own) and then that first error is
 * thrown — the same "stopped part way" a crash leaves, which a resume already handles.
 */
export async function runPerPanel<T, R>(
  items: readonly T[],
  panelOf: (item: T) => string,
  cap: AdoptionConcurrency,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const perPanel = Math.max(1, Math.floor(cap.perPanel));
  const total = Math.max(1, Math.floor(cap.total));
  const results = new Array<R>(items.length);
  const running = new Map<string, number>();
  // One queue per panel, each in input order; the next item started is the earliest queued one
  // whose panel has room. Panels are few, so the pick is cheap however many items wait.
  const queues = new Map<string, { readonly indexes: number[]; next: number }>();
  items.forEach((item, index) => {
    const panel = panelOf(item);
    const queue = queues.get(panel);
    if (queue === undefined) queues.set(panel, { indexes: [index], next: 0 });
    else queue.indexes.push(index);
  });
  let remaining = items.length;
  let active = 0;
  let failure: { error: unknown } | null = null;

  return new Promise<R[]>((resolve, reject) => {
    const settle = (): void => {
      if (active > 0) return;
      if (failure !== null) reject(failure.error);
      else if (remaining === 0) resolve(results);
    };
    const pump = (): void => {
      while (failure === null && active < total) {
        let panel: string | null = null;
        let index = Number.POSITIVE_INFINITY;
        for (const [key, queue] of queues) {
          const head = queue.indexes[queue.next];
          if (head === undefined || (running.get(key) ?? 0) >= perPanel) continue;
          if (head < index) {
            index = head;
            panel = key;
          }
        }
        if (panel === null) break;
        const chosen: string = panel;
        const queue = queues.get(chosen) as { readonly indexes: number[]; next: number };
        queue.next += 1;
        remaining -= 1;
        const at = index;
        const item = items[at] as T;
        running.set(chosen, (running.get(chosen) ?? 0) + 1);
        active += 1;
        void Promise.resolve()
          .then(() => work(item))
          .then(
            (result) => {
              results[at] = result;
            },
            (error: unknown) => {
              failure ??= { error };
            },
          )
          .finally(() => {
            running.set(chosen, (running.get(chosen) ?? 1) - 1);
            active -= 1;
            pump();
            settle();
          });
      }
      settle();
    };
    pump();
  });
}
