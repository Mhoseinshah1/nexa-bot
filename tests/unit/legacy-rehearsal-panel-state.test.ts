import { describe, expect, it } from 'vitest';
import type { LegacyInventoryRead } from '../../apps/api/src/modules/platform/legacy-importer/application/ports';
import {
  PANEL_STATE_SCHEMA,
  comparePanelStates,
  panelState,
  type PanelStateSnapshot,
} from '../support/legacy-rehearsal-panel-state';

/**
 * WP-D4 — equation P4's comparator: a panel's admin-controlled account facts before and
 * after the import. Pure; the walk itself is exercised by the importer integration suite.
 */
const KEY = Buffer.alloc(32, 7);
const GIB = 1024n ** 3n;

type Runtime = Extract<LegacyInventoryRead, { complete: true }>['runtime'];

function read(
  accounts: Record<
    string,
    Partial<{
      total: bigint | null;
      used: bigint;
      expires: Date | null;
      state: string;
      link: string | null;
    }>
  >,
): LegacyInventoryRead {
  const runtime = new Map() as Map<string, unknown>;
  for (const [name, a] of Object.entries(accounts)) {
    runtime.set(name, {
      state: a.state ?? 'active',
      usage: {
        usedBytes: a.used ?? 0n,
        totalBytes: a.total === undefined ? 30n * GIB : a.total,
        expiresAt: a.expires === undefined ? new Date('2027-01-01T00:00:00Z') : a.expires,
      },
      subscriptionUrl: a.link === undefined ? `https://sub.example/${name}/token-1` : a.link,
    });
  }
  return {
    ok: true,
    complete: true,
    index: { panelId: 'p', usernames: new Map() },
    accounts: runtime.size,
    states: {},
    runtime: runtime as Runtime,
    observedAt: new Date('2026-10-06T00:00:00Z'),
  } as LegacyInventoryRead;
}

const snap = (...reads: [string, LegacyInventoryRead][]): PanelStateSnapshot => ({
  schema: PANEL_STATE_SCHEMA,
  panels: reads.map(([id, r]) => panelState(id, r, KEY)),
  requests: { reads: 1, refusedWrites: 0 },
});

const BASE = { alice: {}, bob: {}, carol: {} };

describe('panel_state_unchanged (P4)', () => {
  it('is unchanged when only what a live panel moves by itself moved: usage and state', () => {
    const before = snap(['A', read(BASE)]);
    const after = snap([
      'A',
      read({ alice: { used: 5n * GIB, state: 'limited' }, bob: {}, carol: {} }),
    ]);
    expect(comparePanelStates(before, after)).toBe('unchanged');
    expect(before.panels[0]?.runtimeHash).not.toBe(after.panels[0]?.runtimeHash);
  });

  it.each([
    ['a data limit', { alice: { total: 60n * GIB }, bob: {}, carol: {} }],
    ['an expiry', { alice: { expires: new Date('2027-02-01T00:00:00Z') }, bob: {}, carol: {} }],
    [
      'a rotated subscription token',
      { alice: { link: 'https://sub.example/alice/token-2' }, bob: {}, carol: {} },
    ],
  ] as const)('notices %s changed on one account, and counts it', (_what, accounts) => {
    expect(comparePanelStates(snap(['A', read(BASE)]), snap(['A', read(accounts)]))).toBe(
      'changed: A: accounts 3->3, added 0, removed 0, changed 1',
    );
  });

  it('counts an account created and one deleted', () => {
    expect(
      comparePanelStates(
        snap(['A', read(BASE)]),
        snap(['A', read({ alice: {}, bob: {}, dave: {} })]),
      ),
    ).toBe('changed: A: accounts 3->3, added 1, removed 1, changed 0');
  });

  it('reads a username case-insensitively, as the matcher does', () => {
    expect(
      comparePanelStates(
        snap(['A', read(BASE)]),
        snap([
          'A',
          read({ Alice: { link: 'https://sub.example/alice/token-1' }, bob: {}, carol: {} }),
        ]),
      ),
    ).toBe('unchanged');
  });

  it('never passes on an incomplete walk, a missing panel or nothing walked', () => {
    const incomplete: LegacyInventoryRead = { ok: true, complete: false, reason: 'NOT_A_PAGE' };
    expect(comparePanelStates(snap(['A', read(BASE)]), snap(['A', incomplete]))).toMatch(
      /^changed: A: inventory incomplete/u,
    );
    expect(
      comparePanelStates(snap(['A', read(BASE)], ['B', read(BASE)]), snap(['A', read(BASE)])),
    ).toBe('changed: B: not walked afterwards');
    expect(comparePanelStates(snap(), snap())).toBe('changed: no panel was walked');
  });

  it('writes no username, link or usage figure', () => {
    const text = JSON.stringify(snap(['A', read({ alice_legacy: { used: 123456789n } })]));
    expect(text).not.toMatch(/alice|sub\.example|token-1|123456789/u);
  });
});
