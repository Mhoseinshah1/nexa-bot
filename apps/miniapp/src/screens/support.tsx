import { useState } from 'react';
import {
  MINIAPP_ROUTES,
  miniAppSupportResponseSchema,
  miniAppTicketCategoriesResponseSchema,
  miniAppTicketsResponseSchema,
  type TicketStatus,
} from '@nexa/contracts';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { dateTime } from '../format.js';
import { openExternal, openTelegram } from '../telegram.js';
import { Button, Card, Loading, useLoad } from '../ui.js';

/**
 * پشتیبانی: the customer's tickets (opened through THIS bot), the operator's FAQ, and the
 * way to open a new ticket. Text only: a ticket's files are Telegram files scoped to the bot,
 * so the design's attach button is not drawn and a message that has one says it is in the bot.
 * The FAQ is whatever the operator wrote; none is invented.
 */
export function Support() {
  const { api, navigate } = useApp();
  const [tab, setTab] = useState<'tickets' | 'faq'>('tickets');
  const categories = useLoad(
    () => api.get(MINIAPP_ROUTES.ticketCategories, {}, miniAppTicketCategoriesResponseSchema),
    [api],
  );
  const canOpen = categories.loaded.state === 'ready' && categories.loaded.data.items.length > 0;
  return (
    <main className="page">
      <div className="page-head">
        <h1 className="title">{t('miniapp.support_title')}</h1>
        {canOpen && (
          <Button primary onClick={() => navigate({ name: 'ticket-new' })}>
            {t('miniapp.support_new_ticket')}
          </Button>
        )}
      </div>
      <div className="segments" role="tablist">
        {(['tickets', 'faq'] as const).map((which) => (
          <button
            key={which}
            type="button"
            role="tab"
            aria-selected={tab === which}
            className={tab === which ? 'segment segment-on' : 'segment'}
            onClick={() => setTab(which)}
          >
            {which === 'tickets' ? t('miniapp.support_tab_tickets') : t('miniapp.support_tab_faq')}
          </button>
        ))}
      </div>
      {tab === 'tickets' ? <Tickets /> : <Faq />}
    </main>
  );
}

export function statusBadge(status: TicketStatus) {
  return (
    <span className={status === 'WAITING_FOR_SUPPORT' ? 'badge badge-warn' : 'badge'}>
      {t(`miniapp.ticket_status_${status}`)}
    </span>
  );
}

function Tickets() {
  const { api, navigate } = useApp();
  const { loaded, reload } = useLoad(
    () => api.get(MINIAPP_ROUTES.tickets, {}, miniAppTicketsResponseSchema),
    [api],
  );
  return (
    <Loading loaded={loaded} reload={reload}>
      {(result) =>
        result.items.length === 0 ? (
          <p className="muted">{t('miniapp.support_no_tickets')}</p>
        ) : (
          <Card>
            <ul className="tickets">
              {result.items.map((ticket) => (
                <li key={ticket.id}>
                  <button
                    type="button"
                    className="ticket-row"
                    onClick={() => navigate({ name: 'ticket', ticketId: ticket.id })}
                  >
                    <span className="card-head">
                      <strong>
                        {ticket.subject ??
                          t('miniapp.support_ticket_untitled', { code: ticket.code ?? '' })}
                      </strong>
                      {statusBadge(ticket.status)}
                    </span>
                    <small>
                      {[ticket.code, ticket.categoryTitle, dateTime(ticket.lastMessageAt)]
                        .filter((part) => part !== null && part !== '')
                        .join(' · ')}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )
      }
    </Loading>
  );
}

function Faq() {
  const { api } = useApp();
  const { loaded, reload } = useLoad(
    () => api.get(MINIAPP_ROUTES.support, {}, miniAppSupportResponseSchema),
    [api],
  );
  return (
    <Loading loaded={loaded} reload={reload}>
      {(support) => (
        <>
          {support.faqs.length === 0 ? (
            <p className="muted">{t('miniapp.support_no_faq')}</p>
          ) : (
            <Card className="faq">
              {support.faqs.map((faq) => (
                <details key={faq.question}>
                  <summary>{faq.question}</summary>
                  <p>{faq.answer}</p>
                </details>
              ))}
            </Card>
          )}
          {support.supportUrl !== null && (
            <Button
              onClick={() => {
                const url = support.supportUrl as string;
                if (/^https:\/\/t\.me\//u.test(url)) openTelegram(url);
                else openExternal(url);
              }}
            >
              {t('miniapp.support_contact')}
            </Button>
          )}
        </>
      )}
    </Loading>
  );
}
