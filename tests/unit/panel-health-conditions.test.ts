import { describe, expect, it } from 'vitest';
import { PANEL_HEALTH_STATES } from '@nexa/contracts';
import { PANEL_FAILURE_KINDS_FOR_TEST } from './support/panel-failure-kinds';
import { conditionOf } from '../../apps/api/src/modules/platform/panels/application/panel-monitor.service';

/**
 * The operator-facing condition a health row announces.
 *
 * Two properties, and the second is the one that has been broken twice.
 *
 * 1. The SENTENCE must describe what happened. `PROVIDER_ERROR` was announced
 *    as "answered with something this provider does not produce" — a sentence
 *    written for a malformed body — which sends an operator to look for a
 *    broken integration when the panel has simply reported its own 500.
 * 2. The CODE is the ops log's dedupe and recovery key. Two kinds whose remedy
 *    differs must not share one, or a panel that moves from the first to the
 *    second increments a row that is already open and announces nothing at all.
 */
describe('the condition a failing panel announces', () => {
  const conditions = PANEL_FAILURE_KINDS_FOR_TEST.map((kind) => ({
    kind,
    condition: conditionOf('UNREACHABLE', kind),
  }));

  it('gives every failure kind a condition', () => {
    for (const { kind, condition } of conditions) {
      expect(condition, kind).not.toBeNull();
      expect(condition!.summary.length, kind).toBeGreaterThan(10);
    }
  });

  it('never describes a provider’s own failure as a malformed answer', () => {
    const providerError = conditions.find((c) => c.kind === 'PROVIDER_ERROR')!.condition!;
    expect(providerError.summary).not.toMatch(/does not produce|malformed/i);
    expect(providerError.code).toBe('panel.health.provider_error');

    const malformed = conditions.find((c) => c.kind === 'MALFORMED_RESPONSE')!.condition!;
    expect(malformed.summary).toMatch(/does not produce/);
    // Different codes, because the remedy differs: one is "the panel is
    // broken", the other is "this adapter and this panel disagree".
    expect(malformed.code).not.toBe(providerError.code);
  });

  it('shares a code only where the remedy is the same', () => {
    const codeOf = (kind: string) => conditions.find((c) => c.kind === kind)!.condition!.code;
    // The one deliberate sharing: both mean "look at the host and the network".
    expect(codeOf('TIMEOUT')).toBe(codeOf('UNREACHABLE'));

    // Everything else is distinct. Grouped by code, no group may contain two
    // kinds unless it is the pair above — asserted structurally so that a NEW
    // kind folded into an existing code fails here.
    const groups = new Map<string, string[]>();
    for (const { kind, condition } of conditions) {
      groups.set(condition!.code, [...(groups.get(condition!.code) ?? []), kind]);
    }
    for (const [code, kinds] of groups) {
      if (kinds.length === 1) continue;
      expect(new Set(kinds), `${code} is shared by kinds with different remedies`).toEqual(
        new Set(['UNREACHABLE', 'TIMEOUT']),
      );
    }
  });

  it('reports DEGRADED as its own condition, whatever the failure', () => {
    // DEGRADED means the panel authenticated and could not report its status.
    // It is not a failure kind at all, and it must not borrow one's sentence.
    const degraded = conditionOf('DEGRADED', null)!;
    expect(degraded.severity).toBe('WARN');
    expect(degraded.summary).toMatch(/authenticated/);
    expect(conditionOf('HEALTHY', null)).toBeNull();
  });
});

describe('the set of condition codes is fixed deliberately', () => {
  it('is exactly these eleven, and changing one is an upgrade', () => {
    // `operational_events` dedupes and recovers by code, and the append-only
    // guard forbids rewriting `code` on a row that already exists — so a code
    // this function stops producing strands every row still open under it,
    // unresolvable. Splitting `panel.health.provider_error` into three was
    // safe only because no released application had ever written one.
    //
    // This test exists so that the next such change cannot be made without
    // reading that, and so the reader who changes it has to say what happens
    // to the rows already open.
    const codes = new Set<string>();
    for (const state of PANEL_HEALTH_STATES) {
      codes.add(conditionOf(state, null)?.code ?? 'none');
      for (const failure of PANEL_FAILURE_KINDS_FOR_TEST) {
        codes.add(conditionOf(state, failure)?.code ?? 'none');
      }
    }
    codes.delete('none');
    expect([...codes].sort()).toEqual([
      'panel.health.auth_failed',
      'panel.health.auth_interaction_required',
      'panel.health.degraded',
      'panel.health.malformed_response',
      'panel.health.provider_error',
      /*
       * Eleven now, not ten. `PROVIDER_REFUSED` joined the failure taxonomy for
       * the CREATE path — a panel answering a rule of its own — and no probe
       * produces it, so this code is currently unreachable in practice.
       *
       * It is listed anyway because `conditionOf` is exhaustive with no
       * catch-all: an unlisted kind would not fall through to a generic
       * condition, it would fail to compile. The code is NEW rather than a
       * split of `provider_error`, which is what keeps every row already open
       * under that code resolvable — a rename would strand them for ever.
       */
      'panel.health.provider_refused',
      'panel.health.rate_limited',
      'panel.health.target_blocked',
      'panel.health.tls_failed',
      'panel.health.unreachable',
      'panel.health.unsupported_capability',
    ]);
  });
});
