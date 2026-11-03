import { describe, expect, it } from 'vitest';
import {
  adoptionConcurrency,
  runPerPanel,
} from '../../apps/api/src/modules/platform/legacy-importer/application/adoption-pool';

/**
 * NEXA v096 PR-2 — the apply's adoptions run a few at a time per panel (`adoption-pool.ts`).
 * The cap is the rule: never more than `perPanel` adoptions on one panel at once, never more
 * than `total` overall, results in input order, and a failure stops new work and is thrown
 * only after the running ones settled.
 */

interface Job {
  readonly id: number;
  readonly panel: string;
}

function jobs(panels: readonly string[], each: number): Job[] {
  const out: Job[] = [];
  for (let i = 0; i < each; i += 1) {
    for (const panel of panels) out.push({ id: out.length, panel });
  }
  return out;
}

/** Work that records how many run at once, per panel and overall, and yields a few ticks. */
function meter() {
  const now = new Map<string, number>();
  const peak = new Map<string, number>();
  let all = 0;
  let peakAll = 0;
  const started: number[] = [];
  const work = async (job: Job): Promise<number> => {
    started.push(job.id);
    now.set(job.panel, (now.get(job.panel) ?? 0) + 1);
    peak.set(job.panel, Math.max(peak.get(job.panel) ?? 0, now.get(job.panel) ?? 0));
    all += 1;
    peakAll = Math.max(peakAll, all);
    for (let t = 0; t < 1 + (job.id % 3); t += 1) await new Promise((r) => setTimeout(r, 1));
    now.set(job.panel, (now.get(job.panel) ?? 1) - 1);
    all -= 1;
    return job.id * 10;
  };
  return { work, peak, started, peakAll: () => peakAll };
}

describe('legacy import adoption pool (v096 PR-2)', () => {
  it('never runs more than the per-panel cap on one panel, and uses it', async () => {
    const m = meter();
    const items = jobs(['p1', 'p2'], 20);
    const results = await runPerPanel(items, (j) => j.panel, { perPanel: 4, total: 9 }, m.work);
    expect(results).toEqual(items.map((j) => j.id * 10));
    expect(m.peak.get('p1')).toBe(4);
    expect(m.peak.get('p2')).toBe(4);
    expect(m.peakAll()).toBe(8);
    expect([...m.started].sort((a, b) => a - b)).toEqual(items.map((j) => j.id));
  });

  it('keeps the overall cap below the per-panel caps summed', async () => {
    const m = meter();
    const items = jobs(['p1', 'p2', 'p3'], 10);
    await runPerPanel(items, (j) => j.panel, { perPanel: 4, total: 5 }, m.work);
    expect(m.peakAll()).toBe(5);
    for (const panel of ['p1', 'p2', 'p3']) expect(m.peak.get(panel)).toBeLessThanOrEqual(4);
  });

  it('a cap of 1 is the one-at-a-time loop, in input order', async () => {
    const m = meter();
    const items = jobs(['p1', 'p2'], 6);
    await runPerPanel(items, (j) => j.panel, { perPanel: 1, total: 1 }, m.work);
    expect(m.peakAll()).toBe(1);
    expect(m.started).toEqual(items.map((j) => j.id));
  });

  it('a failure starts nothing new, waits for the running ones, then throws the first error', async () => {
    const items = jobs(['p1'], 30);
    const started: number[] = [];
    let running = 0;
    const run = runPerPanel(
      items,
      (j) => j.panel,
      { perPanel: 4, total: 9 },
      async (job) => {
        started.push(job.id);
        running += 1;
        try {
          await new Promise((r) => setTimeout(r, job.id === 5 ? 1 : 5));
          if (job.id === 5) throw new Error('boom 5');
          if (job.id === 6) throw new Error('boom 6');
          return job.id;
        } finally {
          running -= 1;
        }
      },
    );
    await expect(run).rejects.toThrow('boom 5');
    // Nothing is still running when the error surfaces, and nothing new started after it.
    expect(running).toBe(0);
    expect(started.length).toBeLessThanOrEqual(9);
  });

  it('an empty list resolves at once', async () => {
    await expect(
      runPerPanel(
        [],
        () => 'p',
        { perPanel: 4, total: 9 },
        () => Promise.resolve(1),
      ),
    ).resolves.toEqual([]);
  });

  it('the effective bounds keep a pool connection free and never fall below 1', () => {
    expect(adoptionConcurrency(4, 10)).toEqual({ perPanel: 4, total: 9 });
    expect(adoptionConcurrency(4, 1)).toEqual({ perPanel: 4, total: 1 });
    expect(adoptionConcurrency(0, 2)).toEqual({ perPanel: 1, total: 1 });
  });
});
