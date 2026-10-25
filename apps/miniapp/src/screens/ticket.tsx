import { useState, type FormEvent } from 'react';
import {
  MINIAPP_ROUTES,
  TICKET_MESSAGE_MAX_LENGTH,
  miniAppTicketCategoriesResponseSchema,
  miniAppTicketDetailSchema,
  type MiniAppTicketDetail,
} from '@nexa/contracts';
import { useApp } from '../app.js';
import { ApiError } from '../api.js';
import { t, type MiniAppKey } from '../i18n/t.js';
import { dateTime } from '../format.js';
import { Button, Card, Loading, errorText, useLoad } from '../ui.js';
import { statusBadge } from './support.js';

const TICKET_ERRORS: Readonly<Record<string, MiniAppKey>> = {
  'ticket.closed': 'miniapp.ticket_closed',
  'ticket.open_limit': 'miniapp.ticket_open_limit',
  'ticket.message_limit': 'miniapp.ticket_message_limit',
  'ticket.message_invalid': 'miniapp.ticket_invalid',
  'ticket.category_not_found': 'miniapp.ticket_category_gone',
};

function ticketErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const key = TICKET_ERRORS[error.code];
    if (key !== undefined) return t(key);
  }
  return errorText(error);
}

/** The new-ticket form: a category and the first message, as the bot's ticket flow asks for them. */
export function NewTicket() {
  const { api, replace } = useApp();
  const { loaded, reload } = useLoad(
    () => api.get(MINIAPP_ROUTES.ticketCategories, {}, miniAppTicketCategoriesResponseSchema),
    [api],
  );
  const [categoryId, setCategoryId] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const opened = await api.post(MINIAPP_ROUTES.tickets, {}, miniAppTicketDetailSchema, {
        categoryId,
        text,
      });
      replace({ name: 'ticket', ticketId: opened.id });
    } catch (failure) {
      setError(ticketErrorText(failure));
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <h1 className="title">{t('miniapp.ticket_new_title')}</h1>
      <Loading loaded={loaded} reload={reload}>
        {(result) =>
          result.items.length === 0 ? (
            <p className="muted">{t('miniapp.ticket_category_none')}</p>
          ) : (
            <Card>
              <form className="compose" onSubmit={(event) => void submit(event)}>
                <label className="field">
                  {t('miniapp.ticket_category')}
                  <select
                    value={categoryId}
                    onChange={(event) => setCategoryId(event.target.value)}
                    required
                  >
                    <option value="" disabled />
                    {result.items.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  {t('miniapp.ticket_text')}
                  <textarea
                    value={text}
                    maxLength={TICKET_MESSAGE_MAX_LENGTH}
                    placeholder={t('miniapp.ticket_text_placeholder')}
                    onChange={(event) => setText(event.target.value)}
                    required
                  />
                </label>
                {error !== null && <p className="error">{error}</p>}
                <Button
                  type="submit"
                  primary
                  disabled={busy || categoryId === '' || text.trim() === ''}
                >
                  {t('miniapp.ticket_submit')}
                </Button>
              </form>
            </Card>
          )
        }
      </Loading>
    </main>
  );
}

/** One ticket: its conversation and, while it is open, the reply box. */
export function Ticket({ ticketId }: { ticketId: string }) {
  const { api } = useApp();
  const { loaded, reload } = useLoad(
    () => api.get(MINIAPP_ROUTES.ticket, { ticketId }, miniAppTicketDetailSchema),
    [api, ticketId],
  );
  return (
    <main className="page">
      <Loading loaded={loaded} reload={reload}>
        {(ticket) => <Conversation initial={ticket} />}
      </Loading>
    </main>
  );
}

function Conversation({ initial }: { initial: MiniAppTicketDetail }) {
  const { api, replace } = useApp();
  const [ticket, setTicket] = useState(initial);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await api.post(
        MINIAPP_ROUTES.ticketReplies,
        { ticketId: ticket.id },
        miniAppTicketDetailSchema,
        { text },
      );
      setTicket(updated);
      setText('');
    } catch (failure) {
      setError(ticketErrorText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1 className="title">
          {ticket.subject ?? t('miniapp.support_ticket_untitled', { code: ticket.code ?? '' })}
        </h1>
        {statusBadge(ticket.status)}
      </div>
      <p className="muted">
        {[ticket.code, ticket.categoryTitle].filter((part) => part !== null).join(' · ')}
      </p>
      <Card>
        <div className="thread">
          {ticket.messages.map((message) => (
            <div
              key={`${message.createdAt}:${message.author}`}
              className={
                message.author === 'CUSTOMER' ? 'bubble bubble-mine' : 'bubble bubble-theirs'
              }
            >
              <small>
                {t(`miniapp.ticket_author_${message.author}`)} · {dateTime(message.createdAt)}
              </small>
              {message.text}
              {message.hasAttachment && <small>{t('miniapp.ticket_attachment')}</small>}
            </div>
          ))}
        </div>
      </Card>
      {ticket.status === 'CLOSED' ? (
        <>
          <p className="muted">{t('miniapp.ticket_closed')}</p>
          <Button primary onClick={() => replace({ name: 'ticket-new' })}>
            {t('miniapp.support_new_ticket')}
          </Button>
        </>
      ) : (
        <form className="compose" onSubmit={(event) => void send(event)}>
          <label className="visually-hidden" htmlFor="ticket-reply">
            {t('miniapp.ticket_reply_label')}
          </label>
          <textarea
            id="ticket-reply"
            value={text}
            maxLength={TICKET_MESSAGE_MAX_LENGTH}
            placeholder={t('miniapp.ticket_reply_placeholder')}
            onChange={(event) => setText(event.target.value)}
          />
          {error !== null && <p className="error">{error}</p>}
          <Button type="submit" primary disabled={busy || text.trim() === ''}>
            {t('miniapp.ticket_reply_send')}
          </Button>
        </form>
      )}
    </>
  );
}
