import { describe, expect, it } from 'vitest';
import type { SupportContextBuild } from '../../apps/api/src/modules/commerce/support-context/application/support-context.builder';
import { TbSupportContextSource } from '../../apps/api/src/modules/control/support-ai/infrastructure/support-context-source';

/** TB5 — the Assist view of the TB3 context: labels for the operator, never a row id. */
describe('TbSupportContextSource', () => {
  const payload = {
    services: [{ alias: 'S1', label: 'user123' }],
    orders: [{ alias: 'O1', title: 'سرویس یک‌ماهه' }],
    payments: [
      { alias: 'P1', method: 'CARD_TRANSFER', amount: { amountMinor: '150000', currency: 'IRR' } },
    ],
    knowledge: [{ alias: 'K1', source: 'KNOWLEDGE', question: 'سرویس وصل نمی‌شود', answer: 'a' }],
    flags: { identityLinked: false },
  };
  const build = {
    payload,
    references: {
      services: new Map([['S1', 'svc-row-id']]),
      orders: new Map([['O1', 'order-row-id']]),
      payments: new Map([['P1', 'payment-row-id']]),
    },
  } as unknown as SupportContextBuild;
  const source = new TbSupportContextSource({ build: async () => build });
  const scope = { tenantId: 't', botInstanceId: null } as never;

  it('labels every alias the payload carries, and never with a row id', async () => {
    const result = await source.build(scope, 'c');
    expect([...result.aliases.entries()]).toEqual([
      ['S1', 'user123'],
      ['O1', 'سرویس یک‌ماهه'],
      ['P1', 'CARD_TRANSFER 150000 IRR'],
    ]);
    // Knowledge is labelled apart: it is no fact a fact ref (or the grounding guard) may name.
    expect([...(result.knowledgeAliases ?? new Map()).entries()]).toEqual([
      ['K1', 'سرویس وصل نمی‌شود'],
    ]);
    expect(result.aliases.has('K1')).toBe(false);
    expect(result.json).not.toMatch(/row-id/u);
    expect([...result.aliases.values()].join(' ')).not.toMatch(/row-id/u);
  });

  it('reports linkage from the payload, not from the caller', async () => {
    expect((await source.build(scope, 'c')).linked).toBe(false);
  });

  it('refuses a system scope', async () => {
    await expect(source.build({ kind: 'SYSTEM', reason: 'x' } as never, null)).rejects.toThrow();
  });
});
