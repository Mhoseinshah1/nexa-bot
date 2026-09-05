import { describe, expect, it } from 'vitest';
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
