import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS, TICKET_MESSAGE_SENDERS, ticketStatusAfterMessage } from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  ticketAiGate,
  type TicketAiHold,
} from '../../apps/api/src/modules/control/support-ai/domain/ticket-ai-gate';

/**
 * Phase 4 PR-4 — the pure pieces: the gate that decides whether the AI may answer a ticket (the
 * Business chats' resume rule fed by a ticket's facts), the AI sender's effect on a ticket's
 * status, the shipped defaults and the Persian text, and the static isolation between the ticket
 * code and the Business-chat code.
 */

const NOW = new Date('2026-11-01T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

const soft = (over: Partial<TicketAiHold> = {}): TicketAiHold => ({
  state: 'HANDOFF_REQUIRED',
  epoch: 1,
  handoffKind: 'SOFT',
  heldAt: minutesAgo(5),
  ...over,
});

const gate = (input: Partial<Parameters<typeof ticketAiGate>[0]> = {}) =>
  ticketAiGate({
    hold: null,
    lastAdminAt: null,
    previousMessageAt: minutesAgo(1),
    windowMinutes: 30,
    now: NOW,
    ...input,
  });

describe('ticketAiGate — the resume rule on a ticket', () => {
  it('answers a ticket nobody holds, at epoch 0', () => {
    expect(gate()).toEqual({ kind: 'ANSWER', epoch: 0 });
  });

  it('a person’s reply inside the window pauses the AI', () => {
    expect(gate({ lastAdminAt: minutesAgo(10) })).toEqual({
      kind: 'PAUSED',
      why: 'PERSON_REPLIED',
      epoch: 0,
    });
  });

  it('after the window of the person’s silence the AI takes the ticket back, in a new epoch', () => {
    const result = gate({ lastAdminAt: minutesAgo(40), previousMessageAt: minutesAgo(1) });
    expect(result).toMatchObject({ kind: 'RESUME', epoch: 1, trigger: 'HUMAN_SILENT' });
  });

  it('a customer who returns after the window of quiet is a new session', () => {
    const result = gate({ lastAdminAt: minutesAgo(90), previousMessageAt: minutesAgo(60) });
    expect(result).toMatchObject({ kind: 'RESUME', trigger: 'NEW_SESSION' });
  });

  it('a window of 0 means never, for a person’s reply and for a soft handoff', () => {
    expect(gate({ lastAdminAt: minutesAgo(9_999), windowMinutes: 0 }).kind).toBe('PAUSED');
    expect(gate({ hold: soft({ heldAt: minutesAgo(9_999) }), windowMinutes: 0 }).kind).toBe(
      'PAUSED',
    );
  });

  it('a HARD handoff is sticky whatever the window, however long ago, and however long the quiet', () => {
    const hard = soft({ handoffKind: 'HARD', heldAt: minutesAgo(60 * 24 * 30) });
    expect(gate({ hold: hard, previousMessageAt: minutesAgo(60 * 24 * 30) })).toEqual({
      kind: 'PAUSED',
      why: 'HARD_HANDOFF',
      epoch: 1,
    });
    expect(gate({ hold: hard, lastAdminAt: minutesAgo(60 * 24) }).kind).toBe('PAUSED');
  });

  it('a hold with no kind fails closed, as a hard one', () => {
    expect(gate({ hold: soft({ handoffKind: null }) }).kind).toBe('PAUSED');
  });

  it('a SOFT handoff holds for the window from the moment it was recorded, then returns', () => {
    expect(gate({ hold: soft({ heldAt: minutesAgo(5) }) })).toMatchObject({
      kind: 'PAUSED',
      why: 'SOFT_HANDOFF',
    });
    expect(gate({ hold: soft({ heldAt: minutesAgo(45) }) })).toMatchObject({
      kind: 'RESUME',
      epoch: 2,
    });
  });

  it('a person who replied inside a soft handoff’s window extends it', () => {
    expect(gate({ hold: soft({ heldAt: minutesAgo(45) }), lastAdminAt: minutesAgo(10) }).kind).toBe(
      'PAUSED',
    );
  });

  it('after the AI took the ticket back, an older person’s reply no longer pauses it', () => {
    const resumed: TicketAiHold = {
      state: 'AI_ACTIVE',
      epoch: 2,
      handoffKind: null,
      heldAt: minutesAgo(3),
    };
    expect(gate({ hold: resumed, lastAdminAt: minutesAgo(10) })).toEqual({
      kind: 'ANSWER',
      epoch: 2,
    });
    // …but one that came after the resume does.
    expect(gate({ hold: resumed, lastAdminAt: minutesAgo(1) }).kind).toBe('PAUSED');
  });
});

describe('the AI sender', () => {
  it('is a sender of its own, beside the administrator', () => {
    expect(TICKET_MESSAGE_SENDERS).toEqual(['CUSTOMER', 'ADMIN', 'SYSTEM', 'AI']);
  });

  it('never moves a ticket’s status, and a CLOSED ticket refuses it', () => {
    for (const from of ['OPEN', 'WAITING_FOR_SUPPORT', 'WAITING_FOR_CUSTOMER'] as const) {
      expect(ticketStatusAfterMessage(from, 'AI')).toBe(from);
    }
    expect(ticketStatusAfterMessage('CLOSED', 'AI')).toBeNull();
    // An administrator's reply still does move it.
    expect(ticketStatusAfterMessage('OPEN', 'ADMIN')).toBe('WAITING_FOR_CUSTOMER');
  });
});

describe('the shipped defaults and the Persian text', () => {
  it('support.ai.tickets_enabled is a runtime boolean, OFF by default', () => {
    const definition = SETTINGS.find((d) => d.key === 'support.ai.tickets_enabled');
    expect(definition?.defaultValue).toBe(false);
    expect(definition?.schema.safeParse(true).success).toBe(true);
    expect(definition?.schema.safeParse('yes').success).toBe(false);
    expect(definition?.mutability).toBe('RUNTIME');
  });

  it('every new customer-facing text is Persian, from the catalogue, and says it is the AI', () => {
    const keys = [
      'bot.ticket.ai_replied',
      'bot.ticket.line_ai',
      'bot.ticket.ai_open_in_bot',
    ] as const;
    for (const key of keys) {
      const text = (CATALOGUE_FA as Record<string, string>)[key];
      expect(text, key).toMatch(/[؀-ۿ]/u);
    }
    expect((CATALOGUE_FA as Record<string, string>)['bot.ticket.ai_replied']).toContain(
      'هوش مصنوعی',
    );
    expect((CATALOGUE_FA as Record<string, string>)['bot.ticket.line_ai']).toContain('هوش مصنوعی');
  });
});

describe('isolation: the ticket code and the Business-chat code share no table and no lane', () => {
  const root = join(__dirname, '../../apps/api/src/modules');
  const read = (path: string) => readFileSync(join(root, path), 'utf8');

  it('the ticket AI never names a Business table, the Business outbound lane or a conversation', () => {
    const files = [
      'control/support-ai/infrastructure/drizzle-support-ai-ticket.repository.ts',
      'control/support-ai/application/support-ticket-ai.service.ts',
      'control/support-ai/application/support-ticket-ai.trigger.ts',
      'control/support-ai/domain/ticket-ai-gate.ts',
    ];
    for (const file of files) {
      const source = read(file);
      expect(source, file).not.toMatch(
        /business_outbound|businessOutbound|businessConversations\b/u,
      );
      expect(source, file).not.toMatch(
        /businessMessages|enqueueAutoSend|BusinessOutboundRepository/u,
      );
      expect(source, file).not.toMatch(/supportAiJobs\b|support_ai_jobs\b/u);
    }
  });

  it('the Business-chat code never names a ticket AI table', () => {
    const dirs = ['commerce/business-chats', 'control/support-ai/infrastructure'];
    const walk = (dir: string): string[] =>
      readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(`${dir}/${entry.name}`)
          : entry.name.endsWith('.ts')
            ? [`${dir}/${entry.name}`]
            : [],
      );
    for (const file of dirs.flatMap(walk)) {
      if (file.endsWith('drizzle-support-ai-ticket.repository.ts')) continue;
      expect(read(file), file).not.toMatch(/support_ai_ticket|supportAiTicket/u);
    }
  });
});
