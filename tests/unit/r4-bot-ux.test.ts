import { describe, expect, it, vi } from 'vitest';
import {
  BROADCAST_ACTIONS,
  BROADCAST_ACTION_COMMANDS,
  BROADCAST_BODY_DEFINITION,
  MAIN_MENU_BUTTONS,
  broadcastActionCallbackData,
  money,
  type BroadcastAction,
  type DomainEvent,
  type MainMenuTarget,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  PAY_SWITCH_CARD_CALLBACK_PREFIX,
  blockedReply,
  intentOf,
  withBlockedSupportButton,
} from '../../apps/api/src/surfaces/telegram/bot-runtime';
import { WIZARD_GATES } from '../../apps/api/src/surfaces/telegram/wizard-state';
import { nextReceivingCard } from '../../apps/api/src/modules/commerce/payments/application/card-switch.service';
import type { PaymentAccountRecord } from '../../apps/api/src/modules/commerce/payments/application/account-ports';
import {
  broadcastTelegramButton,
  renderBroadcastBody,
} from '../../apps/api/src/modules/commerce/broadcasts/infrastructure/telegram-broadcast.transport';
import { CustomerFactNoticeConsumer } from '../../apps/api/src/modules/commerce/messaging/application/customer-fact-notice.consumer';
import { TermsAcceptanceService } from '../../apps/api/src/modules/control/terms/application/terms-acceptance.service';

/**
 * Round 4 PR-A — the bot customer experience rules that can be decided without a database.
 * The database halves (the switch row, the list predicate, the backfill UPDATE, the ledger
 * reader) are in `tests/integration/r4-bot-ux.test.ts`.
 */

const PAYMENT = '01900000-0000-7000-8000-0000000000a1';

function account(id: string, enabled = true): PaymentAccountRecord {
  return {
    id: id as never,
    label: id,
    bankName: 'bank',
    holderName: 'holder',
    cardNumber: '6037991234567890',
    iban: null,
    enabled,
    isDefault: false,
    sortOrder: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe('A1: «🔄 تغییر شماره کارت» — the rotation', () => {
  const [a, b, c] = [account('a'), account('b'), account('c')];

  it('rotates through the enabled cards in render order, skipping the one shown, wrapping', () => {
    expect(nextReceivingCard([a, b, c], 'a')?.id).toBe('b');
    expect(nextReceivingCard([a, b, c], 'b')?.id).toBe('c');
    expect(nextReceivingCard([a, b, c], 'c')?.id).toBe('a');
    // Two cards alternate.
    expect(nextReceivingCard([a, b], 'a')?.id).toBe('b');
    expect(nextReceivingCard([a, b], 'b')?.id).toBe('a');
  });

  it('one enabled card: there is nothing to switch to (the button is hidden)', () => {
    expect(nextReceivingCard([a], 'a')).toBeNull();
    expect(nextReceivingCard([], 'a')).toBeNull();
  });

  it('a card shown and since disabled: the rotation restarts at the first enabled card', () => {
    expect(nextReceivingCard([b, c], 'a')?.id).toBe('b');
  });

  it('the tap carries the payment and the sequence, and is gated to the invoice screen', () => {
    const tap = intentOf({
      callback_query: { id: 'q', data: `${PAY_SWITCH_CARD_CALLBACK_PREFIX}${PAYMENT}.3` },
    });
    expect(tap).toMatchObject({ intent: 'PAY_SWITCH_CARD', targetId: PAYMENT, secondaryId: '3' });
    for (const bad of [`${PAYMENT}`, `${PAYMENT}.x`, `nope.1`, `${PAYMENT}.1.2`]) {
      expect(
        intentOf({ callback_query: { id: 'q', data: `${PAY_SWITCH_CARD_CALLBACK_PREFIX}${bad}` } })
          .intent,
      ).toBe('UNSUPPORTED');
    }
    // Answered by editing the same invoice: honoured only while the message shows it.
    expect(WIZARD_GATES.get('PAY_SWITCH_CARD')?.from).toEqual(['INVOICE']);
  });
});

describe('A5: the blocked reply carries a URL button to support', () => {
  const spam = {
    blockedReason: 'ارسال بیش از حد پیام در بازه کوتاه (اسپم)',
    blockedReasonShown: true,
  };
  const manual = { blockedReason: 'تخلف', blockedReasonShown: true };

  it('spam and manual blocks both get «📞 ارتباط با پشتیبانی» as a LINK, never a callback', () => {
    for (const customer of [spam, manual]) {
      const reply = withBlockedSupportButton(blockedReply(customer), 'https://t.me/support');
      expect(reply.buttons).toHaveLength(1);
      expect(reply.buttons[0]).toMatchObject({ url: 'https://t.me/support' });
      expect(reply.buttons[0]).not.toHaveProperty('data');
      expect(reply.key).toBe(blockedReply(customer).key);
    }
  });

  it('no support link configured: no button', () => {
    expect(withBlockedSupportButton(blockedReply(manual), null).buttons).toEqual([]);
  });
});

describe('A5: the customer-fact consumer', () => {
  function harness(flagOn = true) {
    const notify = vi.fn(async (..._args: unknown[]) => true);
    const consumer = new CustomerFactNoticeConsumer({
      notifier: { notify },
      flags: { isEnabled: vi.fn(async () => flagOn) },
      clock: { now: () => new Date('2026-10-19T00:00:00Z') },
    });
    return { consumer, notify };
  }
  const entryEvent = (reason: string): DomainEvent =>
    ({
      eventId: '01900000-0000-7000-8000-0000000000e1',
      eventType: 'WalletEntryRecorded',
      tenantId: '01900000-0000-7000-8000-000000000001',
      aggregateType: 'Wallet',
      aggregateId: '01900000-0000-7000-8000-0000000000c1',
      payload: {
        reason,
        entryId: '01900000-0000-7000-8000-0000000000f1',
        customerId: '01900000-0000-7000-8000-0000000000c1',
      },
    }) as unknown as DomainEvent;

  it('an administrator credit and debit are told, naming the ledger entry', async () => {
    const h = harness();
    await h.consumer.handle(entryEvent('ADMIN_CREDIT'), {} as never);
    await h.consumer.handle(entryEvent('ADMIN_DEBIT'), {} as never);
    expect(h.notify.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      ['WALLET_ADMIN_CREDITED', '01900000-0000-7000-8000-0000000000f1'],
      ['WALLET_ADMIN_DEBITED', '01900000-0000-7000-8000-0000000000f1'],
    ]);
  });

  it('NEVER for an imported opening balance, or any other ledger reason', async () => {
    const h = harness();
    for (const reason of [
      'MIGRATION_OPENING_BALANCE',
      'MASS_CREDIT',
      'TOPUP',
      'REFUND',
      'PURCHASE',
      'CORRECTION',
      'ACCOUNT_TRANSFER_IN',
    ]) {
      await h.consumer.handle(entryEvent(reason), {} as never);
    }
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('the owner toggle off: consumed, nothing queued', async () => {
    const h = harness(false);
    await h.consumer.handle(entryEvent('ADMIN_CREDIT'), {} as never);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('an unblock is told once per unblock event', async () => {
    const h = harness();
    await h.consumer.handle(
      {
        eventId: '01900000-0000-7000-8000-0000000000e9',
        eventType: 'CustomerUnblocked',
        tenantId: '01900000-0000-7000-8000-000000000001',
        aggregateType: 'Customer',
        aggregateId: '01900000-0000-7000-8000-0000000000c1',
        payload: { reason: null },
      } as unknown as DomainEvent,
      {} as never,
    );
    expect(h.notify.mock.calls[0]?.[1]).toBe('01900000-0000-7000-8000-0000000000c1');
    expect(h.notify.mock.calls[0]?.[2]).toBe('ACCOUNT_UNBLOCKED');
    expect(h.notify.mock.calls[0]?.[3]).toBe('01900000-0000-7000-8000-0000000000e9');
  });
});

describe('A4: accept the rules once, never again', () => {
  const current = { id: 'v2', versionNumber: 2, publishedAt: new Date(0), status: 'PUBLISHED' };
  function gate(facts: {
    acceptedCurrent?: boolean;
    acceptedOlder?: boolean;
    legacy?: boolean;
    reprompt?: boolean;
    exemption?: 'IMPORTED' | 'PREDATES_RULES';
  }) {
    return new TermsAcceptanceService({
      repository: {
        current: async () => current,
        hasAccepted: async () => facts.acceptedCurrent === true,
        lastAcceptance: async () =>
          facts.acceptedOlder === true
            ? { termsVersionId: 'v1', versionNumber: 1, acceptedAt: new Date(0) }
            : null,
        legacyAcceptedAt: async () => (facts.legacy === true ? new Date(0) : null),
        exemption: async () => facts.exemption ?? null,
      } as never,
      flags: {
        isEnabled: async (_scope: unknown, key: string) =>
          key === 'terms_enforcement' ? true : facts.reprompt === true,
      } as never,
    } as never);
  }
  const scope = { tenantId: 't', botInstanceId: null } as never;

  it('an imported customer who accepted the previous bot’s rules is not prompted', async () => {
    expect(await gate({ legacy: true }).requirement(scope, 'c')).toBeNull();
  });

  it('a newer published version (the rules edited) does not prompt one who accepted before', async () => {
    expect(await gate({ acceptedOlder: true }).requirement(scope, 'c')).toBeNull();
  });

  it('a customer who never accepted anything is asked, once', async () => {
    expect((await gate({}).requirement(scope, 'c'))?.id).toBe('v2');
  });

  it('R5C-1: an imported or pre-enforcement customer is not asked; requirement and standing agree', async () => {
    for (const exemption of ['IMPORTED', 'PREDATES_RULES'] as const) {
      const service = gate({ exemption });
      expect(await service.requirement(scope, 'c'), exemption).toBeNull();
      expect((await service.standing(scope, 'c')).reacceptanceRequired, exemption).toBe(false);
    }
    const asked = gate({});
    expect((await asked.requirement(scope, 'c'))?.id).toBe('v2');
    expect((await asked.standing(scope, 'c')).reacceptanceRequired).toBe(true);
  });

  it('the owner toggle ON brings the re-prompt back, for both', async () => {
    expect((await gate({ acceptedOlder: true, reprompt: true }).requirement(scope, 'c'))?.id).toBe(
      'v2',
    );
    expect((await gate({ legacy: true, reprompt: true }).requirement(scope, 'c'))?.id).toBe('v2');
    expect(
      await gate({ acceptedCurrent: true, reprompt: true }).requirement(scope, 'c'),
    ).toBeNull();
  });
});

describe('A6: broadcast parity', () => {
  it('every placeholder renders from the recipient’s own facts', () => {
    const today = new Date('2026-10-19T08:00:00Z');
    const body = BROADCAST_BODY_DEFINITION.placeholders
      .map((p) => `${p.token}=[{${p.token}}]`)
      .join('\n');
    const text = renderBroadcastBody(
      body,
      {
        firstName: 'سارا',
        username: 'sara_u',
        walletBalance: money(150_000n, 'IRT'),
        telegramId: '123456789',
        phone: '989121234567',
        servicesTotal: 4,
        servicesActive: 2,
        today,
      },
      { timezone: 'Asia/Tehran', calendar: 'jalali' },
    );
    expect(text).not.toMatch(/\{[A-Za-z]+\}/u);
    expect(text).toContain('firstName=[سارا]');
    expect(text).toContain('username=[sara_u]');
    expect(text).toContain('telegramId=[123456789]');
    expect(text).toContain('phone=[989121234567]');
    expect(text).toMatch(/servicesTotal=\[(4|۴)\]/u);
    expect(text).toMatch(/servicesActive=\[(2|۲)\]/u);
    // The Jalali date: 1405/07/27 in Tehran.
    expect(text).toMatch(/today=\[[^\]]*(۱۴۰۵|1405)[^\]]*\]/u);
    expect(text).toMatch(/walletBalance=\[[^\]]+\]/u);
  });

  it('{phone} with no number renders empty, never the line dropped and never a guess', () => {
    const text = renderBroadcastBody('تلفن: {phone}.', {
      firstName: null,
      username: null,
      walletBalance: null,
      phone: null,
    });
    expect(text).toBe('تلفن: .');
  });

  it('each in-bot action button routes to the SAME handler as its main-menu entry', () => {
    const menu = new Map(
      MAIN_MENU_BUTTONS.map((button) => [CATALOGUE_FA[button.label], `/${button.command}`]),
    );
    const menuLabelOf = (command: string): string | null => {
      const button = MAIN_MENU_BUTTONS.find((b) => `/${b.command}` === command);
      return button === undefined ? null : CATALOGUE_FA[button.label];
    };
    for (const action of BROADCAST_ACTIONS) {
      const tapped = intentOf({
        callback_query: { id: 'q', data: broadcastActionCallbackData(action) },
      });
      const command = BROADCAST_ACTION_COMMANDS[action];
      const typed = intentOf({ message: { text: command } });
      expect({ ...tapped, callbackQueryId: null }, action).toEqual(typed);
      expect(tapped.intent, action).not.toBe('UNSUPPORTED');
      const label = menuLabelOf(command);
      if (label !== null) {
        // The keyboard button itself, tapped as text, is the same command.
        expect(intentOf({ message: { text: label } }, menu), action).toEqual(typed);
      }
    }
    // Every main-menu entry the owner listed is reachable from a broadcast.
    const targets: readonly MainMenuTarget[] = [
      'catalog',
      'services',
      'wallet',
      'help',
      'trial',
      'referral',
      'apps',
    ];
    const commands = new Set(Object.values(BROADCAST_ACTION_COMMANDS));
    for (const target of targets) expect(commands.has(`/${target}`), target).toBe(true);
  });

  it('an unknown action code is refused at the boundary', () => {
    expect(intentOf({ callback_query: { id: 'q', data: 'bc:ADMIN' } }).intent).toBe('UNSUPPORTED');
  });

  it('a broadcast keyboard mixes links and in-bot callbacks within Telegram’s 64-byte bound', () => {
    expect(broadcastTelegramButton({ label: 'سایت', url: 'https://example.com' })).toEqual({
      text: 'سایت',
      url: 'https://example.com',
    });
    for (const action of BROADCAST_ACTIONS as readonly BroadcastAction[]) {
      const cell = broadcastTelegramButton({ label: 'x', action });
      expect(cell).toEqual({ text: 'x', data: broadcastActionCallbackData(action) });
      expect(
        new TextEncoder().encode(broadcastActionCallbackData(action)).length,
      ).toBeLessThanOrEqual(64);
    }
  });
});
