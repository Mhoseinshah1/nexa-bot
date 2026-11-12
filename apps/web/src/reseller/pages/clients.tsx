import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RESELLER_CLIENT_CONTACT_MAX,
  RESELLER_CLIENT_NAME_MAX,
  RESELLER_CLIENT_NOTE_MAX,
  type ResellerClient,
  type ResellerRenewAllQuote,
  type ResellerRenewAllResult,
} from '@nexa/contracts';
import { ApiError } from '../../api/client';
import { errorText } from '../../error-text';
import { formatDate, formatMoneyText, formatNumber } from '../../format';
import { t } from '../../i18n/web.fa';
import { useSubmissionKey } from '../../submission-key';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import {
  Badge,
  Banner,
  Button,
  Empty,
  Field,
  Input,
  StateSwitch,
  Textarea,
  useToast,
  type Tone,
} from '../../ui/kit';
import { Modal } from '../../ui/overlays';
import {
  ME_KEY,
  archiveClient,
  createClient,
  fetchClientServices,
  fetchClients,
  fetchRenewAllQuote,
  renewAll,
  updateClient,
} from '../api';
import { SCREEN_PATHS, goTo } from '../route';
import { Expiry, RpCard, StateBadge, Usage } from '../view';
import { AutoRenewSwitch } from './auto-renew';
import { DASHBOARD_KEY } from './dashboard';
import { CLIENTS_KEY, SERVICES_KEY } from './services';
import { ServiceDrawer } from './service-drawer';

const CLIENT_SERVICES_KEY = ['reseller', 'client-services'] as const;

function initialOf(name: string): string {
  return Array.from(name.trim())[0] ?? '·';
}

/**
 * «مشتری‌ها»: the reseller's own address book. A client is a label on services — it never
 * touches pricing or entitlement. The list (initial, name, contact, service count, what is
 * about to expire), the selected client's services with their auto-renew switches, «+ سرویس
 * برای این مشتری», «تمدید همهٔ سرویس‌های او» with its pre-check, the note, a new client, edit
 * and archive (never delete).
 */
export function ClientsPage() {
  const clients = useQuery({ queryKey: [...CLIENTS_KEY, 'active'], queryFn: () => fetchClients() });
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<'new' | 'edit' | null>(null);
  const items = clients.data?.items ?? [];
  const current = items.find((one) => one.id === selected) ?? items[0];

  return (
    <div className="rp-split rp-stretch">
      <div className="rp-clients-list">
        <RpCard
          title={t('web.rp_cl_title')}
          hint={t('web.rp_cl_count').replace('{n}', formatNumber(items.length))}
          actions={
            <Button size="sm" variant="primary" onClick={() => setForm('new')}>
              {t('web.rp_cl_new')}
            </Button>
          }
        >
          {form === 'new' && (
            <ClientForm
              onDone={(made) => {
                setForm(null);
                if (made !== null) setSelected(made.id);
              }}
            />
          )}
          <StateSwitch
            query={clients}
            isEmpty={items.length === 0}
            empty={<Empty variant="compact" title={t('web.rp_cl_empty')} />}
          >
            <ul className="rp-client-rows" aria-label={t('web.rp_cl_list_label')}>
              {items.map((one) => (
                <li key={one.id}>
                  <button
                    type="button"
                    className={`rp-client${one.id === current?.id ? ' on' : ''}`}
                    aria-pressed={one.id === current?.id}
                    onClick={() => {
                      setSelected(one.id);
                      setForm(null);
                    }}
                  >
                    <span className="rp-client-id">
                      <span className="rp-initial" aria-hidden="true">
                        {initialOf(one.name)}
                      </span>
                      <span>
                        <b>{one.name}</b>
                        <span className="muted small">{one.contact ?? '—'}</span>
                      </span>
                    </span>
                    <span className="rp-client-meta">
                      <Badge tone="neutral">
                        {t('web.rp_cl_services_n').replace('{n}', formatNumber(one.serviceCount))}
                      </Badge>
                      <span className={one.expiringCount > 0 ? 'warn small' : 'muted small'}>
                        {one.expiringCount > 0
                          ? t('web.rp_cl_expiring').replace('{n}', formatNumber(one.expiringCount))
                          : t('web.rp_cl_all_ok')}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </StateSwitch>
        </RpCard>
      </div>
      <div className="rp-clients-detail">
        {current === undefined ? (
          <RpCard>
            <Empty variant="compact" title={t('web.rp_cl_pick')} />
          </RpCard>
        ) : (
          <ClientDetail
            key={current.id}
            client={current}
            editing={form === 'edit'}
            onEdit={() => setForm('edit')}
            onEditDone={() => setForm(null)}
            onArchived={() => setSelected(null)}
          />
        )}
      </div>
    </div>
  );
}

// --- Create and edit ---------------------------------------------------------------------------

function ClientForm({
  existing,
  onDone,
}: {
  existing?: ResellerClient;
  onDone: (saved: ResellerClient | null) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(existing?.name ?? '');
  const [contact, setContact] = useState(existing?.contact ?? '');
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        contact: contact.trim() === '' ? null : contact.trim(),
        note: existing?.note ?? null,
      };
      return existing === undefined ? createClient(body) : updateClient(existing.id, body);
    },
    onSuccess: (saved) => {
      toast({ tone: 'ok', message: t('web.rp_cl_saved') });
      void queryClient.invalidateQueries({ queryKey: [...CLIENTS_KEY] });
      void queryClient.invalidateQueries({ queryKey: [...SERVICES_KEY] });
      onDone(saved);
    },
    onError: (error) => toast({ tone: 'danger', message: errorText(error), error }),
  });
  return (
    <div className="rp-client-form rp-stack">
      <div className="rp-form-grid">
        <Field label={t('web.rp_cl_name')} htmlFor="rp-cl-name" required>
          <Input
            id="rp-cl-name"
            value={name}
            maxLength={RESELLER_CLIENT_NAME_MAX}
            placeholder={t('web.rp_cl_name_ph')}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label={t('web.rp_cl_contact')} htmlFor="rp-cl-contact">
          <Input
            id="rp-cl-contact"
            dir="ltr"
            value={contact}
            maxLength={RESELLER_CLIENT_CONTACT_MAX}
            onChange={(event) => setContact(event.target.value)}
          />
        </Field>
      </div>
      <div className="rp-line">
        <Button
          size="sm"
          variant="primary"
          disabled={name.trim() === '' || save.isPending}
          onClick={() => save.mutate()}
        >
          {t('web.rp_cl_save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onDone(null)}>
          {t('web.rp_cl_cancel')}
        </Button>
      </div>
    </div>
  );
}

// --- One client --------------------------------------------------------------------------------

function ClientDetail({
  client,
  editing,
  onEdit,
  onEditDone,
  onArchived,
}: {
  client: ResellerClient;
  editing: boolean;
  onEdit: () => void;
  onEditDone: () => void;
  onArchived: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const services = useQuery({
    queryKey: [...CLIENT_SERVICES_KEY, client.id],
    queryFn: () => fetchClientServices(client.id),
  });
  const [renewing, setRenewing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState(client.note ?? '');

  const archive = useMutation({
    mutationFn: () => archiveClient(client.id),
    onSuccess: () => {
      setArchiving(false);
      toast({ tone: 'ok', message: t('web.rp_cl_archived') });
      void queryClient.invalidateQueries({ queryKey: [...CLIENTS_KEY] });
      onArchived();
    },
    onError: (error) => {
      setArchiving(false);
      toast({ tone: 'danger', message: errorText(error), error });
    },
  });
  const saveNote = useMutation({
    mutationFn: () =>
      updateClient(client.id, {
        name: client.name,
        contact: client.contact,
        note: note.trim() === '' ? null : note.trim(),
      }),
    onSuccess: () => {
      toast({ tone: 'ok', message: t('web.rp_cl_saved') });
      void queryClient.invalidateQueries({ queryKey: [...CLIENTS_KEY] });
    },
    onError: (error) => toast({ tone: 'danger', message: errorText(error), error }),
  });

  const rows = services.data?.items ?? [];
  return (
    <RpCard
      title={client.name}
      hint={[client.contact, t('web.rp_cl_since').replace('{at}', formatDate(client.createdAt))]
        .filter((part): part is string => part !== null)
        .join(' • ')}
      actions={
        <div className="rp-line">
          <Button
            size="sm"
            onClick={() => goTo(`${SCREEN_PATHS.buy}?client=${encodeURIComponent(client.id)}`)}
          >
            {t('web.rp_cl_buy')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={rows.length === 0}
            onClick={() => setRenewing(true)}
          >
            {t('web.rp_cl_renew_all')}
          </Button>
        </div>
      }
    >
      {editing && <ClientForm existing={client} onDone={() => onEditDone()} />}
      <StateSwitch
        query={services}
        isEmpty={rows.length === 0}
        empty={<Empty variant="compact" title={t('web.rp_cl_services_empty')} />}
      >
        <div className="rp-table-wrap">
          <table className="rp-table">
            <thead>
              <tr>
                <th>{t('web.rp_col_user')}</th>
                <th>{t('web.rp_col_product')}</th>
                <th>{t('web.rp_col_usage')}</th>
                <th>{t('web.rp_col_expiry')}</th>
                <th>{t('web.rp_col_status')}</th>
                <th>{t('web.rp_col_ar')}</th>
                <th>
                  <span className="visually-hidden">{t('web.rp_col_manage')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td dir="ltr" className="rp-mono">
                    {row.username}
                  </td>
                  <td>{row.product ?? '—'}</td>
                  <td>
                    <Usage row={row} />
                  </td>
                  <td>
                    <Expiry row={row} />
                  </td>
                  <td>
                    <StateBadge value={row.state} />
                  </td>
                  <td>
                    <AutoRenewSwitch
                      serviceId={row.id}
                      username={row.username}
                      initial={row.autoRenew}
                    />
                  </td>
                  <td className="rp-end">
                    <Button size="sm" onClick={() => setOpenId(row.id)}>
                      {t('web.rp_manage')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </StateSwitch>
      <div className="rp-stack rp-gap">
        <Field label={t('web.rp_cl_note')} htmlFor="rp-cl-note">
          <Textarea
            id="rp-cl-note"
            value={note}
            maxLength={RESELLER_CLIENT_NOTE_MAX}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        <div className="rp-line">
          <Button
            size="sm"
            disabled={note.trim() === (client.note ?? '') || saveNote.isPending}
            onClick={() => saveNote.mutate()}
          >
            {t('web.rp_cl_save')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            {t('web.rp_cl_edit')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setArchiving(true)}>
            {t('web.rp_cl_archive')}
          </Button>
        </div>
      </div>
      {archiving && (
        <ConfirmDialog
          title={t('web.rp_cl_archive')}
          question={t('web.rp_cl_archive_question')}
          confirmLabel={t('web.rp_cl_archive_confirm')}
          cancelLabel={t('web.rp_cl_cancel')}
          onConfirm={() => archive.mutate()}
          onCancel={() => setArchiving(false)}
        />
      )}
      {renewing && <RenewAllDialog client={client} onClose={() => setRenewing(false)} />}
      {openId !== null && <ServiceDrawer serviceId={openId} onClose={() => setOpenId(null)} />}
    </RpCard>
  );
}

// --- «تمدید همهٔ سرویس‌های او» -----------------------------------------------------------------

const RENEW_TONE: Readonly<Record<string, Tone>> = {
  RENEWED: 'ok',
  FAILED: 'danger',
  SKIPPED: 'neutral',
};
const RENEW_LABEL = {
  RENEWED: 'web.rp_cl_renew_renewed',
  FAILED: 'web.rp_cl_renew_failed',
  SKIPPED: 'web.rp_cl_renew_skipped',
} as const;

function skippedText(reason: string): string {
  return reason === 'PLAN_REQUIRED'
    ? t('web.rp_cl_renew_skipped_plan')
    : t('web.rp_cl_renew_skipped_other');
}

/**
 * The pre-check (each ACTIVE service, its price or why it is left out, the total against the
 * balance) and then the renewal: each service once through the normal renewal, the per-service
 * result drawn after. A short wallet replaces «تمدید» with «شارژ کیف پول» — no credit.
 */
function RenewAllDialog({ client, onClose }: { client: ResellerClient; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const quote = useQuery({
    queryKey: ['reseller', 'renew-all', client.id],
    queryFn: () => fetchRenewAllQuote(client.id),
    gcTime: 0,
  });
  const submission = useSubmissionKey();
  const [result, setResult] = useState<ResellerRenewAllResult | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () => renewAll(client.id, submission.current(client.id)),
    onSuccess: (done) => {
      submission.settle();
      setResult(done);
      for (const key of [ME_KEY, DASHBOARD_KEY, SERVICES_KEY, CLIENT_SERVICES_KEY, CLIENTS_KEY]) {
        void queryClient.invalidateQueries({ queryKey: [...key] });
      }
    },
    onError: (error) => {
      submission.settleOn(error);
      if (error instanceof ApiError && error.code === 'commerce.wallet_insufficient_funds') {
        setRefused(errorText(error));
        void quote.refetch();
        return;
      }
      toast({ tone: 'danger', message: errorText(error), error });
    },
  });

  const data: ResellerRenewAllQuote | undefined = quote.data;
  const usernames = new Map(data?.items.map((item) => [item.serviceId, item.username]));
  const renewable = data?.items.filter((item) => item.skipped === null) ?? [];
  return (
    <Modal
      open
      onClose={onClose}
      title={t('web.rp_cl_renew_title').replace('{name}', client.name)}
      size="lg"
      foot={
        result !== null ? (
          <Button variant="primary" onClick={onClose}>
            {t('web.rp_cl_renew_close')}
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>{t('web.rp_cl_cancel')}</Button>
            {data !== undefined && renewable.length > 0 && !data.sufficient && (
              <Button variant="primary" onClick={() => goTo(SCREEN_PATHS.wallet)}>
                {t('web.rp_buy_charge')}
              </Button>
            )}
            {data !== undefined && renewable.length > 0 && data.sufficient && (
              <Button variant="primary" disabled={run.isPending} onClick={() => run.mutate()}>
                {t('web.rp_cl_renew_confirm').replace('{n}', formatNumber(renewable.length))}
              </Button>
            )}
          </>
        )
      }
    >
      {result !== null ? (
        <div className="rp-table-wrap">
          <table className="rp-table" aria-label={t('web.rp_cl_renew_result')}>
            <tbody>
              {result.items.map((item) => (
                <tr key={item.serviceId}>
                  <td dir="ltr" className="rp-mono">
                    {usernames.get(item.serviceId) ?? item.serviceId}
                  </td>
                  <td>
                    <Badge tone={RENEW_TONE[item.status] ?? 'neutral'} dot>
                      {t(RENEW_LABEL[item.status])}
                    </Badge>
                  </td>
                  <td className="muted small">
                    {item.status === 'FAILED' ? itemFailureText(item.reason) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <StateSwitch
          query={quote}
          isEmpty={data !== undefined && data.items.length === 0}
          empty={<Empty variant="compact" title={t('web.rp_cl_renew_none')} />}
        >
          {data !== undefined && (
            <div className="rp-stack">
              <p className="muted">
                {t('web.rp_cl_renew_summary')
                  .replace('{count}', formatNumber(data.count))
                  .replace('{total}', formatMoneyText(data.total))
                  .replace('{balance}', formatMoneyText(data.balance))}
              </p>
              <div className="rp-table-wrap">
                <table className="rp-table">
                  <tbody>
                    {data.items.map((item) => (
                      <tr key={item.serviceId}>
                        <td dir="ltr" className="rp-mono">
                          {item.username}
                        </td>
                        <td>
                          {item.skipped !== null ? (
                            <span className="muted small">{skippedText(item.skipped)}</span>
                          ) : item.price !== null ? (
                            formatMoneyText(item.price)
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {renewable.length === 0 && <p className="muted">{t('web.rp_cl_renew_none')}</p>}
              {renewable.length > 0 && !data.sufficient && (
                <Banner tone="warn">
                  {t('web.rp_cl_renew_short').replace(
                    '{amount}',
                    data.shortfall === null ? '—' : formatMoneyText(data.shortfall),
                  )}
                </Banner>
              )}
              {refused !== null && <Banner tone="danger">{refused}</Banner>}
            </div>
          )}
        </StateSwitch>
      )}
    </Modal>
  );
}

function itemFailureText(reason: string | null): string {
  return reason === null ? '' : errorText(new ApiError(409, reason, reason));
}
