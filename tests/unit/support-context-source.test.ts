import { describe, expect, it } from 'vitest';
import type { SupportContextBuild } from '../../apps/api/src/modules/commerce/support-context/application/support-context.builder';
import {
  TbSupportContextSource,
  paymentLabel,
} from '../../apps/api/src/modules/control/support-ai/infrastructure/support-context-source';

/** TB5 — the Assist view of the TB3 context: labels for the operator, never a row id. */
describe('TbSupportContextSource', () => {
  const payload = {
    services: [{ alias: 'S1', label: 'user123' }],
    orders: [{ alias: 'O1', title: 'سرویس یک‌ماهه' }],
    payments: [
      {
        alias: 'P1',
        method: 'MANUAL_TRANSFER',
        routeLabelKey: 'bot.payment.route_name_manual_transfer',
        amount: { amountMinor: '150000', currency: 'IRR' },
      },
    ],
    knowledge: [{ alias: 'K1', source: 'KNOWLEDGE', question: 'سرویس وصل نمی‌شود', answer: 'a' }],
    flags: { identityLinked: false },
  };
  const build = {
    payload,
    knowledgeAvailable: 7,
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
      ['P1', 'کارت به کارت 150,000 ریال'],
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

  it('D2: reports the knowledge sent and the candidates, and passes the query on', async () => {
    let asked: unknown = null;
    const counting = new TbSupportContextSource({
      build: async (_scope, _customer, options) => {
        asked = options;
        return build;
      },
    });
    const result = await counting.build(scope, 'c', { query: 'وصل نمیشه' });
    expect(result.knowledge).toEqual({ sent: 1, available: 7 });
    expect(asked).toEqual({ query: 'وصل نمیشه' });
  });

  it('L2: a payment reads in Persian, in major units, never as an enum and minor units', () => {
    expect(
      paymentLabel({
        method: 'WALLET',
        routeLabelKey: null,
        amount: { amountMinor: '2500000', currency: 'IRT' },
      }),
    ).toBe('کیف پول 2,500,000 تومان');
    expect(
      paymentLabel({
        method: 'GATEWAY',
        routeLabelKey: 'bot.payment.route_name_tonpays',
        amount: { amountMinor: '1250', currency: 'USD' },
      }),
    ).toBe('درگاه پرداخت تون پی وبسایت 12.50 دلار');
    // A route with no name of its own falls back to the method's.
    expect(
      paymentLabel({
        method: 'GATEWAY',
        routeLabelKey: null,
        amount: { amountMinor: '1000', currency: 'IRT' },
      }),
    ).toBe('درگاه پرداخت 1,000 تومان');
  });

  it('refuses a system scope', async () => {
    await expect(source.build({ kind: 'SYSTEM', reason: 'x' } as never, null)).rejects.toThrow();
  });
});
