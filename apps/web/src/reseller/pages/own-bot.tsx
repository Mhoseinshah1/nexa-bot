import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ResellerBotBillingState,
  ResellerBotRequestState,
  ResellerBotTimelineEvent,
  ResellerOwnBotResponse,
} from '@nexa/contracts';
import { errorText } from '../../error-text';
import { formatDate, formatMoneyText, formatNumber, formatTimestamp } from '../../format';
import { t, type WebKey } from '../../i18n/web.fa';
import {
  Badge,
  Banner,
  Button,
  Empty,
  Field,
  Input,
  Ltr,
  SecretInput,
  StateSwitch,
  Timeline,
  useToast,
  type Tone,
} from '../../ui/kit';
import {
  ME_KEY,
  OWN_BOT_KEY,
  cancelOwnBot,
  fetchOwnBot,
  newIdempotencyKey,
  payOwnBot,
  submitOwnBot,
} from '../api';
import { RpCard } from '../view';

type Request = ResellerOwnBotResponse['requests'][number];
type Offer = ResellerOwnBotResponse['offer'];

const STATE_LABEL: Readonly<Record<ResellerBotRequestState, WebKey>> = {
  PENDING: 'web.rp_bot_state_pending',
  APPROVED: 'web.rp_bot_state_approved',
  REJECTED: 'web.rp_bot_state_rejected',
  CANCELLED: 'web.rp_bot_state_cancelled',
};
const STATE_TONE: Readonly<Record<ResellerBotRequestState, Tone>> = {
  PENDING: 'warn',
  APPROVED: 'ok',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
};
const BILLING_LABEL: Readonly<Record<ResellerBotBillingState, WebKey>> = {
  NONE: 'web.rp_bot_billing_none',
  PAID: 'web.rp_bot_billing_paid',
  GRACE: 'web.rp_bot_billing_grace',
  STOPPED: 'web.rp_bot_billing_stopped',
};
const BILLING_TONE: Readonly<Record<ResellerBotBillingState, Tone>> = {
  NONE: 'neutral',
  PAID: 'ok',
  GRACE: 'warn',
  STOPPED: 'danger',
};
const EVENT_LABEL: Readonly<Record<ResellerBotTimelineEvent, WebKey>> = {
  SUBMITTED: 'web.rp_bot_event_submitted',
  APPROVED: 'web.rp_bot_event_approved',
  REJECTED: 'web.rp_bot_event_rejected',
  CANCELLED: 'web.rp_bot_event_cancelled',
  BOT_CREATED: 'web.rp_bot_event_bot_created',
  LINK_SENT: 'web.rp_bot_event_link_sent',
  CHARGED: 'web.rp_bot_event_charged',
  STOPPED: 'web.rp_bot_event_stopped',
  RESUMED: 'web.rp_bot_event_resumed',
};
const EVENT_TONE: Partial<Readonly<Record<ResellerBotTimelineEvent, Tone>>> = {
  REJECTED: 'danger',
  STOPPED: 'danger',
  RESUMED: 'ok',
  CHARGED: 'ok',
};

const FEATURES: readonly WebKey[] = [
  'web.rp_bot_feature_menu',
  'web.rp_bot_feature_panel',
  'web.rp_bot_feature_backup',
  'web.rp_bot_feature_support',
];

/** The request the screen is about: one waiting for the owner, or the running subscription. */
export function currentRequest(requests: readonly Request[]): Request | null {
  return requests.find((one) => one.state === 'PENDING' || one.state === 'APPROVED') ?? null;
}

/**
 * «ربات اختصاصی» (PR-6): the offer, the request form, and the request's progress.
 *
 * Everything drawn comes from `GET own-bot`: the fee and the grace days are the owner's setting,
 * the request and its history are the reseller's own rows. The token goes to the API once and is
 * never shown again except masked. Unset fee: «فعلاً ارائه نمی‌شود» and no form at all.
 */
export function OwnBotPage() {
  const query = useQuery({ queryKey: OWN_BOT_KEY, queryFn: fetchOwnBot });
  const data = query.data;
  const current = data === undefined ? null : currentRequest(data.requests);
  const past =
    data === undefined
      ? []
      : data.requests.filter((one) => one.state === 'REJECTED' || one.state === 'CANCELLED');
  return (
    <div className="rp-split rp-stretch">
      <div className="rp-grow">
        <RpCard title={t('web.rp_bot_title')} hint={t('web.rp_bot_hint')}>
          <StateSwitch query={query}>
            {data !== undefined && (
              <div className="rp-stack">
                {!data.offer.offered && current === null ? (
                  <Empty
                    icon="lock"
                    title={t('web.rp_bot_not_offered_title')}
                    hint={t('web.rp_bot_not_offered_hint')}
                  />
                ) : (
                  <>
                    {data.offer.offered && <OfferFigures offer={data.offer} />}
                    {current !== null && <CurrentRequest request={current} />}
                    {current === null && data.offer.canRequest && (
                      <RequestForm graceDays={data.offer.graceDays} />
                    )}
                  </>
                )}
              </div>
            )}
          </StateSwitch>
        </RpCard>
        {current !== null && current.timeline.length > 0 && (
          <RpCard title={t('web.rp_bot_history_title')}>
            <Timeline
              items={current.timeline.map((entry, index) => ({
                key: `${entry.event}:${entry.at}:${String(index)}`,
                at: formatTimestamp(entry.at),
                title: eventText(entry),
                ...(EVENT_TONE[entry.event] === undefined ? {} : { tone: EVENT_TONE[entry.event] }),
              }))}
            />
          </RpCard>
        )}
        {past.length > 0 && <PastRequests requests={past} />}
      </div>
      <div className="rp-aside">
        <RpCard title={t('web.rp_bot_features_title')}>
          <ul className="rp-list">
            {FEATURES.map((feature) => (
              <li key={feature}>{t(feature)}</li>
            ))}
          </ul>
        </RpCard>
      </div>
    </div>
  );
}

function eventText(entry: Request['timeline'][number]): string {
  const label = t(EVENT_LABEL[entry.event]);
  if (entry.event !== 'CHARGED') return label;
  return label
    .replace('{n}', entry.period === null ? '—' : formatNumber(entry.period))
    .replace('{amount}', entry.amount === null ? '—' : formatMoneyText(entry.amount));
}

function OfferFigures({ offer }: { offer: Offer }) {
  return (
    <div className="rp-grid4">
      <div className="rp-mini">
        <small>{t('web.rp_bot_fee_label')}</small>
        <strong>{offer.fee === null ? '—' : formatMoneyText(offer.fee)}</strong>
        <small>{t('web.rp_bot_fee_note')}</small>
      </div>
      <div className="rp-mini">
        <small>{t('web.rp_bot_grace_label')}</small>
        <strong>{t('web.rp_bot_grace_value').replace('{n}', formatNumber(offer.graceDays))}</strong>
        <small>{t('web.rp_bot_grace_note')}</small>
      </div>
    </div>
  );
}

function useOwnBotRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: OWN_BOT_KEY });
    // A charge moves the wallet: the sidebar's balance and the wallet screen re-read.
    void client.invalidateQueries({ queryKey: ME_KEY });
    void client.invalidateQueries({ queryKey: ['reseller', 'wallet'] });
    void client.invalidateQueries({ queryKey: ['reseller', 'wallet-entries'] });
  };
}

function RequestForm({ graceDays }: { graceDays: number }) {
  const toast = useToast();
  const refresh = useOwnBotRefresh();
  const [token, setToken] = useState('');
  const [domain, setDomain] = useState('');
  const key = useRef(newIdempotencyKey());
  const submit = useMutation({
    mutationFn: () =>
      submitOwnBot(
        { botToken: token.trim(), domain: domain.trim() === '' ? null : domain.trim() },
        key.current,
      ),
    onSuccess: () => {
      key.current = newIdempotencyKey();
      // The token leaves the page's memory once it is saved; only its masked form comes back.
      setToken('');
      setDomain('');
      toast({ tone: 'ok', message: t('web.rp_bot_submitted') });
      refresh();
    },
    onError: (error) => toast({ tone: 'danger', message: errorText(error), error }),
  });
  return (
    <div className="rp-stack">
      <Field
        label={t('web.rp_bot_token_label')}
        hint={t('web.rp_bot_token_hint')}
        htmlFor="rp-bot-token"
      >
        <SecretInput
          id="rp-bot-token"
          value={token}
          placeholder={t('web.rp_bot_token_ph')}
          onChange={(event) => setToken(event.target.value)}
        />
      </Field>
      <Field
        label={t('web.rp_bot_domain_label')}
        hint={t('web.rp_bot_domain_hint')}
        htmlFor="rp-bot-domain"
      >
        <Input
          id="rp-bot-domain"
          dir="ltr"
          value={domain}
          placeholder={t('web.rp_bot_domain_ph')}
          onChange={(event) => setDomain(event.target.value)}
        />
      </Field>
      <Banner tone="info">{t('web.rp_bot_terms').replace('{n}', formatNumber(graceDays))}</Banner>
      <div>
        <Button
          variant="primary"
          disabled={token.trim() === '' || submit.isPending}
          onClick={() => submit.mutate()}
        >
          {t('web.rp_bot_submit')}
        </Button>
      </div>
    </div>
  );
}

type StepState = 'done' | 'waiting' | 'next';
const STEP_BADGE: Readonly<Record<StepState, { label: WebKey; tone: Tone }>> = {
  done: { label: 'web.rp_bot_step_done', tone: 'ok' },
  waiting: { label: 'web.rp_bot_step_waiting', tone: 'warn' },
  next: { label: 'web.rp_bot_step_next', tone: 'neutral' },
};

/** The demo's four steps, each read from what the request's history says happened. */
export function requestSteps(request: Request): { key: string; state: StepState }[] {
  const has = (event: ResellerBotTimelineEvent) =>
    request.timeline.some((entry) => entry.event === event);
  const approved = request.state === 'APPROVED' || has('APPROVED');
  const built = request.hostedBot.linked || has('BOT_CREATED');
  const linked = has('LINK_SENT');
  const order: [string, boolean][] = [
    ['sent', true],
    ['approve', approved],
    ['build', built],
    ['link', linked],
  ];
  let waitingGiven = false;
  return order.map(([key, done]) => {
    if (done) return { key, state: 'done' };
    if (!waitingGiven) {
      waitingGiven = true;
      return { key, state: 'waiting' };
    }
    return { key, state: 'next' };
  });
}

const STEP_TEXT: Readonly<Record<string, { title: WebKey; note?: WebKey }>> = {
  sent: { title: 'web.rp_bot_step_sent' },
  approve: { title: 'web.rp_bot_step_approve', note: 'web.rp_bot_step_approve_note' },
  build: { title: 'web.rp_bot_step_build', note: 'web.rp_bot_step_build_note' },
  link: { title: 'web.rp_bot_step_link', note: 'web.rp_bot_step_link_note' },
};

function CurrentRequest({ request }: { request: Request }) {
  const toast = useToast();
  const refresh = useOwnBotRefresh();
  const cancelKey = useRef(newIdempotencyKey());
  const payKey = useRef(newIdempotencyKey());
  const cancel = useMutation({
    mutationFn: () => cancelOwnBot(request.id, cancelKey.current),
    onSuccess: () => {
      cancelKey.current = newIdempotencyKey();
      toast({ tone: 'ok', message: t('web.rp_bot_cancelled') });
      refresh();
    },
    onError: (error) => toast({ tone: 'danger', message: errorText(error), error }),
  });
  const pay = useMutation({
    mutationFn: () => payOwnBot(request.id, payKey.current),
    onSuccess: () => {
      payKey.current = newIdempotencyKey();
      toast({ tone: 'ok', message: t('web.rp_bot_paid') });
      refresh();
    },
    onError: (error) => toast({ tone: 'danger', message: errorText(error), error }),
  });
  const billing = request.billing;
  const steps = requestSteps(request);
  const building = steps.some((step) => step.state !== 'done');
  return (
    <section
      className="rp-stack"
      aria-label={t('web.rp_bot_request_title').replace('{number}', request.number)}
    >
      <div className="rp-line rp-between">
        <b>{t('web.rp_bot_request_title').replace('{number}', request.number)}</b>
        <span className="rp-line">
          <Badge tone={STATE_TONE[request.state]} dot>
            {t(STATE_LABEL[request.state])}
          </Badge>
          {billing.state !== 'NONE' && (
            <Badge tone={BILLING_TONE[billing.state]}>{t(BILLING_LABEL[billing.state])}</Badge>
          )}
        </span>
      </div>
      <dl className="rp-kv">
        <dt>{t('web.rp_bot_username')}</dt>
        <dd>
          <Ltr>{`@${request.botUsername}`}</Ltr>
        </dd>
        <dt>{t('web.rp_bot_token_masked')}</dt>
        <dd>
          <Ltr>{request.tokenMasked}</Ltr>
        </dd>
        <dt>{t('web.rp_bot_domain')}</dt>
        <dd>
          {request.domain === null ? (
            <span className="muted">{t('web.rp_bot_no_domain')}</span>
          ) : (
            <Ltr>{request.domain}</Ltr>
          )}
        </dd>
        <dt>{t('web.rp_bot_monthly')}</dt>
        <dd>{formatMoneyText(request.fee)}</dd>
      </dl>
      {building && (
        <ul className="rp-list" aria-label={t('web.rp_bot_steps_label')}>
          {steps.map((step) => {
            const text = STEP_TEXT[step.key];
            const badge = STEP_BADGE[step.state];
            if (text === undefined) return null;
            return (
              <li key={step.key}>
                <div>
                  <b>{t(text.title)}</b>
                  {step.key === 'sent' ? (
                    <span className="muted small">{formatTimestamp(request.createdAt)}</span>
                  ) : (
                    text.note !== undefined && <span className="muted small">{t(text.note)}</span>
                  )}
                </div>
                <Badge tone={badge.tone}>{t(badge.label)}</Badge>
              </li>
            );
          })}
        </ul>
      )}
      {request.state === 'APPROVED' && billing.paidThrough !== null && billing.state === 'PAID' && (
        <span className="muted small">
          {t('web.rp_bot_paid_through').replace('{date}', formatDate(billing.paidThrough))}
        </span>
      )}
      {billing.state === 'GRACE' && (
        <Banner tone="warn">
          {t('web.rp_bot_grace_banner')}
          {billing.stopsAt !== null && (
            <> {t('web.rp_bot_stops_at').replace('{date}', formatTimestamp(billing.stopsAt))}</>
          )}
        </Banner>
      )}
      {billing.state === 'STOPPED' && (
        <Banner
          tone="danger"
          action={
            <Button variant="primary" disabled={pay.isPending} onClick={() => pay.mutate()}>
              {t('web.rp_bot_pay')}
            </Button>
          }
        >
          {t('web.rp_bot_stopped_banner')}
        </Banner>
      )}
      {request.state === 'PENDING' && (
        <div>
          <Button disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            {t('web.rp_bot_cancel')}
          </Button>
        </div>
      )}
    </section>
  );
}

function PastRequests({ requests }: { requests: readonly Request[] }) {
  return (
    <RpCard title={t('web.rp_bot_past_title')}>
      <ul className="rp-list">
        {requests.map((request) => (
          <li key={request.id}>
            <div>
              <b>{t('web.rp_bot_request_title').replace('{number}', request.number)}</b>
              <span className="muted small">
                <Ltr>{`@${request.botUsername}`}</Ltr> {formatTimestamp(request.createdAt)}
              </span>
              {request.rejectReason !== null && (
                <span className="small">
                  {t('web.rp_bot_reject_reason').replace('{reason}', request.rejectReason)}
                </span>
              )}
            </div>
            <Badge tone={STATE_TONE[request.state]}>{t(STATE_LABEL[request.state])}</Badge>
          </li>
        ))}
      </ul>
    </RpCard>
  );
}
