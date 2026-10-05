import {
  TICKET_VIEW_MESSAGE_EXCERPT,
  type TemplateKey,
  type TenantContext,
  type TicketStatus,
  type TicketSystemEvent,
} from '@nexa/contracts';
import type { TemplateResolver } from '../../../control/templates/application/template-resolver.js';
import type { TicketMessageRecord } from './ports.js';

const STATUS_KEYS: Readonly<Record<TicketStatus, TemplateKey>> = {
  OPEN: 'bot.ticket.status_open',
  WAITING_FOR_CUSTOMER: 'bot.ticket.status_waiting_for_customer',
  WAITING_FOR_SUPPORT: 'bot.ticket.status_waiting_for_support',
  CLOSED: 'bot.ticket.status_closed',
};

const SYSTEM_KEYS: Readonly<Record<TicketSystemEvent, TemplateKey>> = {
  CLOSED_BY_CUSTOMER: 'bot.ticket.line_closed_by_customer',
  CLOSED_BY_SUPPORT: 'bot.ticket.line_closed_by_support',
  REOPENED_BY_SUPPORT: 'bot.ticket.line_reopened',
  ESCALATED_FROM_BUSINESS_CHAT: 'bot.ticket.line_escalated',
};

/**
 * The ticket screens the bot sends that are COMPOSED from several templates (WP-A7): a
 * ticket's status label, and its conversation — one rendered line per message. The surface
 * cannot render a sub-line itself (`check-boundaries.sh` keeps the template resolver out of
 * the surfaces), so this application service renders the pieces, the `CustomerScreenComposer`
 * shape. Nothing here decides a fact and nothing is persisted.
 *
 * Every message is bounded (`TICKET_VIEW_MESSAGE_EXCERPT`) and the caller passes at most
 * `TICKET_VIEW_MESSAGE_COUNT` of them, so the conversation always fits one Telegram message.
 * The full text of every message is in the ticket, and support's replies arrive whole.
 */
export class TicketScreenComposer {
  constructor(private readonly templates: Pick<TemplateResolver, 'render'>) {}

  statusLabel(scope: TenantContext, status: TicketStatus): Promise<string> {
    return this.templates.render(scope, STATUS_KEYS[status], {});
  }

  async conversation(
    scope: TenantContext,
    messages: readonly TicketMessageRecord[],
    messageCount: number,
    /** HF-A7: the messages that carry a file from support, marked like a customer's file. */
    filed: ReadonlySet<string> = new Set(),
  ): Promise<{ readonly conversation: string; readonly olderLine: string | null }> {
    const hasFile = (message: TicketMessageRecord) =>
      message.attachment !== null || filed.has(message.id);
    const marker = messages.some(hasFile)
      ? await this.templates.render(scope, 'bot.ticket.attachment_marker', {})
      : '';
    const lines: string[] = [];
    for (const message of messages) {
      if (message.senderType === 'SYSTEM') {
        if (message.systemEvent === null) continue;
        lines.push(
          await this.templates.render(scope, SYSTEM_KEYS[message.systemEvent], {
            at: message.createdAt,
          }),
        );
        continue;
      }
      const text = [hasFile(message) ? marker : null, excerpt(message.body)]
        .filter((part): part is string => part !== null && part !== '')
        .join('\n');
      lines.push(
        await this.templates.render(
          scope,
          message.senderType === 'ADMIN' ? 'bot.ticket.line_support' : 'bot.ticket.line_customer',
          { at: message.createdAt, text },
        ),
      );
    }
    const older = messageCount - messages.length;
    return {
      conversation: lines.join('\n\n'),
      olderLine:
        older > 0
          ? await this.templates.render(scope, 'bot.ticket.view_older', { count: older })
          : null,
    };
  }
}

/** One message's text for the view, bounded in code points, or null. */
function excerpt(body: string | null): string | null {
  if (body === null) return null;
  const points = Array.from(body);
  return points.length <= TICKET_VIEW_MESSAGE_EXCERPT
    ? body
    : `${points.slice(0, TICKET_VIEW_MESSAGE_EXCERPT - 1).join('')}…`;
}
