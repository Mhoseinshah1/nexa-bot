import { describe, expect, it } from 'vitest';
import {
  decideCardSwitch,
  type CardSwitchFacts,
  type CardSwitchLimits,
} from '../../apps/api/src/modules/commerce/payments/application/card-switch-policy';
import { CardSwitchService } from '../../apps/api/src/modules/commerce/payments/application/card-switch.service';
import type { PaymentAccountRecord } from '../../apps/api/src/modules/commerce/payments/application/account-ports';

/**
 * R5C-1 item 2 — the limits on «🔄 تغییر شماره کارت», decided without a database. The locked,
 * concurrent half is in `tests/integration/payment-accounts.test.ts`.
 */

function account(id: string): PaymentAccountRecord {
  return {
    id: id as never,
    label: id,
    bankName: 'bank',
    holderName: 'holder',
    cardNumber: '6037991234567890',
    iban: null,
    enabled: true,
    isDefault: false,
    sortOrder: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const [A, B, C] = [account('a'), account('b'), account('c')];
const NOW = new Date('2026-10-21T12:00:00.000Z');
const secondsAgo = (n: number): Date => new Date(NOW.getTime() - n * 1000);
const LIMITS: CardSwitchLimits = { maxSwitches: 2, cooldownSeconds: 60, maxDistinctCards: 2 };

function facts(over: Partial<CardSwitchFacts> = {}): CardSwitchFacts {
  return {
    limits: LIMITS,
    now: NOW,
    switchCount: 0,
    lastSwitchAt: null,
    shownAccountIds: ['a'],
    currentAccountId: 'a',
    enabled: [A, B, C],
    ...over,
  };
}

describe('R5C-1: the card-switch decision', () => {
  it('the first press has no cooldown and shows the next card', () => {
    const decision = decideCardSwitch(facts());
    expect(decision).toMatchObject({ kind: 'SWITCH' });
    expect(decision.kind === 'SWITCH' && decision.next.id).toBe('b');
  });

  describe('cooldown', () => {
    it('a press inside the window is refused with the seconds remaining, rounded UP', () => {
      const base = { switchCount: 1, shownAccountIds: ['a', 'b'], currentAccountId: 'b' };
      expect(decideCardSwitch(facts({ ...base, lastSwitchAt: secondsAgo(20) }))).toEqual({
        kind: 'COOLDOWN',
        retryAfterSeconds: 40,
      });
      // 59.5 s elapsed of 60: 0.5 s remain, which is shown as 1, never 0.
      const justUnder = new Date(NOW.getTime() - 59_500);
      expect(decideCardSwitch(facts({ ...base, lastSwitchAt: justUnder }))).toEqual({
        kind: 'COOLDOWN',
        retryAfterSeconds: 1,
      });
    });

    it('exactly at, and after, the window the press goes through', () => {
      const base = { switchCount: 1, shownAccountIds: ['a', 'b'], currentAccountId: 'b' };
      expect(decideCardSwitch(facts({ ...base, lastSwitchAt: secondsAgo(60) })).kind).toBe(
        'SWITCH',
      );
      expect(decideCardSwitch(facts({ ...base, lastSwitchAt: secondsAgo(500) })).kind).toBe(
        'SWITCH',
      );
    });

    it('zero is no wait', () => {
      const decision = decideCardSwitch(
        facts({
          limits: { ...LIMITS, cooldownSeconds: 0 },
          switchCount: 1,
          lastSwitchAt: secondsAgo(0),
          shownAccountIds: ['a', 'b'],
          currentAccountId: 'b',
        }),
      );
      expect(decision.kind).toBe('SWITCH');
    });
  });

  describe('maximum switches', () => {
    it('refuses once the count reaches the limit, whatever the cooldown says', () => {
      expect(
        decideCardSwitch(
          facts({ switchCount: 2, lastSwitchAt: secondsAgo(1), shownAccountIds: ['a', 'b'] }),
        ),
      ).toEqual({ kind: 'LIMIT' });
      expect(decideCardSwitch(facts({ switchCount: 1, shownAccountIds: ['a', 'b'] })).kind).toBe(
        'SWITCH',
      );
    });

    it('zero switches allowed: the very first press is refused', () => {
      expect(decideCardSwitch(facts({ limits: { ...LIMITS, maxSwitches: 0 } }))).toEqual({
        kind: 'LIMIT',
      });
    });
  });

  describe('maximum distinct cards', () => {
    it('below the cap the whole list rotates; at the cap only a card already shown returns', () => {
      // a shown, b shown, cap 2, current b: C was never shown and stays unseen -> back to A.
      const decision = decideCardSwitch(
        facts({
          switchCount: 1,
          lastSwitchAt: secondsAgo(100),
          shownAccountIds: ['a', 'b'],
          currentAccountId: 'b',
        }),
      );
      expect(decision.kind === 'SWITCH' && decision.next.id).toBe('a');
    });

    it('a cap of 1 means the customer only ever sees the first card: refused as a limit', () => {
      expect(decideCardSwitch(facts({ limits: { ...LIMITS, maxDistinctCards: 1 } }))).toEqual({
        kind: 'LIMIT',
      });
    });

    it('a new card is never shown past the cap', () => {
      const decision = decideCardSwitch(
        facts({
          limits: { ...LIMITS, maxSwitches: 10, maxDistinctCards: 2 },
          switchCount: 3,
          lastSwitchAt: secondsAgo(100),
          shownAccountIds: ['a', 'b'],
          currentAccountId: 'a',
        }),
      );
      expect(decision.kind === 'SWITCH' && decision.next.id).toBe('b');
    });

    it('the first card counts: with a cap of 2 a single other card is the last one', () => {
      // Shown a only, cap 2 -> b is allowed (2 distinct), after which c is not.
      expect(decideCardSwitch(facts()).kind).toBe('SWITCH');
    });
  });

  it('one enabled card is NO_OTHER_CARD, not a limit', () => {
    expect(decideCardSwitch(facts({ enabled: [A] }))).toEqual({ kind: 'NO_OTHER_CARD' });
  });
});

describe('R5C-1: the button is drawn only while a press could succeed', () => {
  const payment = {
    id: 'p1',
    state: 'PENDING',
    method: 'MANUAL_TRANSFER',
    customerSignalledAt: null,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
  };

  function service(
    settings: Record<string, number>,
    history: { switchCount: number; lastSwitchAt: Date | null; shownAccountIds: string[] },
    currentAccountId: string,
  ): CardSwitchService {
    return new CardSwitchService({
      destinations: {
        switchHistory: async () => history,
        switchCount: async () => history.switchCount,
        findByPayment: async () => ({ accountId: currentAccountId }),
      },
      accounts: { list: async () => [A, B, C] },
      receipts: { countForPayment: async () => 0 },
      settings: {
        valueOf: async (_scope: unknown, key: string) => settings[key] as never,
      },
      clock: { now: () => NOW },
    } as never);
  }

  const defaults = {
    'payments.card_switch_limit': 2,
    'payments.card_switch_cooldown_seconds': 60,
    'payments.card_switch_max_distinct_cards': 2,
  };

  it('drawn with switches left', async () => {
    const offer = await service(
      defaults,
      { switchCount: 0, lastSwitchAt: null, shownAccountIds: ['a'] },
      'a',
    ).offer({} as never, payment as never);
    expect(offer).toEqual({ offered: true, sequence: 0 });
  });

  it('still drawn during the cooldown: the wait is temporary', async () => {
    const offer = await service(
      defaults,
      { switchCount: 1, lastSwitchAt: secondsAgo(5), shownAccountIds: ['a', 'b'] },
      'b',
    ).offer({} as never, payment as never);
    expect(offer.offered).toBe(true);
  });

  it('hidden when the next switch would exceed the maximum switches', async () => {
    const offer = await service(
      defaults,
      { switchCount: 2, lastSwitchAt: secondsAgo(500), shownAccountIds: ['a', 'b'] },
      'b',
    ).offer({} as never, payment as never);
    expect(offer).toEqual({ offered: false, sequence: 2 });
  });

  it('hidden when the distinct-card limit leaves nothing to show', async () => {
    const offer = await service(
      { ...defaults, 'payments.card_switch_max_distinct_cards': 1 },
      { switchCount: 0, lastSwitchAt: null, shownAccountIds: ['a'] },
      'a',
    ).offer({} as never, payment as never);
    expect(offer.offered).toBe(false);
  });

  it('hidden when the owner allows no switches at all', async () => {
    const offer = await service(
      { ...defaults, 'payments.card_switch_limit': 0 },
      { switchCount: 0, lastSwitchAt: null, shownAccountIds: ['a'] },
      'a',
    ).offer({} as never, payment as never);
    expect(offer.offered).toBe(false);
  });
});
