import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { errorText } from '../../error-text';
import { formatRelative } from '../../format';
import { t } from '../../i18n/web.fa';
import { TICKET_STATUS_LABELS, TICKET_STATUS_TONES } from '../../ticket-labels';
import { Badge, Button, Empty, Field, Select, StateSwitch, Textarea, useToast } from '../../ui/kit';
import {
  createTicket,
  fetchTicket,
  fetchTicketCategories,
  fetchTickets,
  newIdempotencyKey,
  replyToTicket,
} from '../api';
import { RpCard } from '../view';

const TICKETS_KEY = ['reseller', 'tickets'] as const;

/**
 * «پشتیبانی»: the reseller's tickets through the existing ticket service. A reply written here
 * also reaches the bot's side (the API does that); a ticket is opened with a category and a
 * first message, as in the mini app.
 */
export function SupportPage() {
  const [openId, setOpenId] = useState<string | null>(null);
  return openId === null ? (
    <div className="rp-split">
      <div className="rp-grow">
        <TicketList onOpen={setOpenId} />
      </div>
      <div className="rp-aside">
        <NewTicket onCreated={setOpenId} />
      </div>
    </div>
  ) : (
    <TicketThread id={openId} onBack={() => setOpenId(null)} />
  );
}

function TicketList({ onOpen }: { onOpen: (id: string) => void }) {
  const query = useQuery({ queryKey: TICKETS_KEY, queryFn: fetchTickets });
  const items = query.data?.items ?? [];
  return (
    <RpCard title={t('web.rp_support_title')} hint={t('web.rp_support_hint')}>
      <StateSwitch
        query={query}
        isEmpty={items.length === 0}
        empty={<Empty variant="compact" title={t('web.rp_support_empty')} />}
      >
        <div className="rp-table-wrap">
          <table className="rp-table">
            <thead>
              <tr>
                <th>{t('web.rp_support_col_subject')}</th>
                <th>{t('web.rp_support_col_category')}</th>
                <th>{t('web.rp_support_col_last')}</th>
                <th>{t('web.rp_support_col_status')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((ticket) => (
                <tr key={ticket.id}>
                  <td>
                    <button type="button" className="rp-link-btn" onClick={() => onOpen(ticket.id)}>
                      {ticket.subject ?? t('web.rp_ticket_untitled')}
                    </button>
                  </td>
                  <td>{ticket.categoryTitle}</td>
                  <td className="muted">{formatRelative(ticket.lastMessageAt)}</td>
                  <td>
                    <Badge tone={TICKET_STATUS_TONES[ticket.status]}>
                      {t(TICKET_STATUS_LABELS[ticket.status])}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </StateSwitch>
    </RpCard>
  );
}

function NewTicket({ onCreated }: { onCreated: (id: string) => void }) {
  const toast = useToast();
  const client = useQueryClient();
  const categories = useQuery({
    queryKey: ['reseller', 'ticket-categories'],
    queryFn: fetchTicketCategories,
  });
  const [categoryId, setCategoryId] = useState('');
  const [text, setText] = useState('');
  const key = useRef(newIdempotencyKey());
  const chosen = categoryId || categories.data?.items[0]?.id || '';
  const create = useMutation({
    mutationFn: () => createTicket({ categoryId: chosen, text: text.trim() }, key.current),
    onSuccess: (ticket) => {
      key.current = newIdempotencyKey();
      setText('');
      toast({ tone: 'ok', message: t('web.rp_ticket_sent') });
      void client.invalidateQueries({ queryKey: TICKETS_KEY });
      onCreated(ticket.id);
    },
    onError: (error) => toast({ tone: 'danger', message: errorText(error), error }),
  });
  return (
    <RpCard title={t('web.rp_ticket_new')}>
      <div className="rp-stack">
        <Field label={t('web.rp_ticket_category')} htmlFor="rp-ticket-category">
          <Select
            id="rp-ticket-category"
            value={chosen}
            onChange={(event) => setCategoryId(event.target.value)}
          >
            {categories.data?.items.map((category) => (
              <option key={category.id} value={category.id}>
                {category.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('web.rp_ticket_message')} htmlFor="rp-ticket-text">
          <Textarea
            id="rp-ticket-text"
            value={text}
            placeholder={t('web.rp_ticket_message_ph')}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        <Button
          variant="primary"
          disabled={chosen === '' || text.trim() === '' || create.isPending}
          onClick={() => create.mutate()}
        >
          {t('web.rp_ticket_send')}
        </Button>
      </div>
    </RpCard>
  );
}

const AUTHOR_LABEL = {
  CUSTOMER: 'web.rp_ticket_author_customer',
  SUPPORT: 'web.rp_ticket_author_support',
  AI: 'web.rp_ticket_author_ai',
} as const;

function TicketThread({ id, onBack }: { id: string; onBack: () => void }) {
  const toast = useToast();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['reseller', 'ticket', id], queryFn: () => fetchTicket(id) });
  const [text, setText] = useState('');
  const key = useRef(newIdempotencyKey());
  const reply = useMutation({
    mutationFn: () => replyToTicket(id, text.trim(), key.current),
    onSuccess: (ticket) => {
      key.current = newIdempotencyKey();
      setText('');
      client.setQueryData(['reseller', 'ticket', id], ticket);
      void client.invalidateQueries({ queryKey: TICKETS_KEY });
      toast({ tone: 'ok', message: t('web.rp_ticket_replied') });
    },
    onError: (error) => toast({ tone: 'danger', message: errorText(error), error }),
  });
  const ticket = query.data;
  return (
    <RpCard
      title={ticket?.subject ?? t('web.rp_ticket_untitled')}
      actions={
        <Button size="sm" onClick={onBack}>
          {t('web.rp_ticket_back')}
        </Button>
      }
    >
      <StateSwitch query={query}>
        {ticket !== undefined && (
          <div className="rp-stack">
            <ul className="rp-thread">
              {ticket.messages.map((message, index) => (
                <li key={`${message.createdAt}:${index}`} className={`rp-msg ${message.author}`}>
                  <div className="rp-line rp-between">
                    <b>{t(AUTHOR_LABEL[message.author])}</b>
                    <span className="muted small">{formatRelative(message.createdAt)}</span>
                  </div>
                  {message.text !== null && <p>{message.text}</p>}
                  {message.hasAttachment && (
                    <span className="muted small">{t('web.rp_ticket_attachment')}</span>
                  )}
                </li>
              ))}
            </ul>
            {ticket.status !== 'CLOSED' && (
              <>
                <Field label={t('web.rp_ticket_reply')} htmlFor="rp-ticket-reply">
                  <Textarea
                    id="rp-ticket-reply"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                  />
                </Field>
                <div>
                  <Button
                    variant="primary"
                    disabled={text.trim() === '' || reply.isPending}
                    onClick={() => reply.mutate()}
                  >
                    {t('web.rp_ticket_reply_send')}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </StateSwitch>
    </RpCard>
  );
}
