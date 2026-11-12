import { useState, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ResellerMeResponse, ResellerPreferences } from '@nexa/contracts';
import { ApiError } from '../../api/client';
import { errorText } from '../../error-text';
import { formatDate, formatRelative, formatTimestamp } from '../../format';
import { t, type WebKey } from '../../i18n/web.fa';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import {
  Badge,
  Banner,
  Button,
  CopyButton,
  Empty,
  Field,
  Input,
  KV,
  StateSwitch,
  ToggleRow,
  useToast,
} from '../../ui/kit';
import {
  activateTotp,
  disableTotp,
  enrolTotp,
  fetchActivity,
  ME_KEY,
  fetchPreferences,
  fetchSessions,
  revokeAllSessions,
  revokeSession,
  savePreferences,
} from '../api';
import { goTo } from '../route';
import { useInstallState } from '../pwa';
import { RpCard } from '../view';

/** The 409 «link must be fresh» refusal gets its own sentence; everything else is `errorText`. */
export function securityErrorText(error: unknown): string {
  if (
    error instanceof ApiError &&
    error.code === 'reseller_web.second_factor_state' &&
    error.details?.['reason'] === 'FRESH_SIGN_IN_REQUIRED'
  ) {
    return t('web.rp_2fa_fresh');
  }
  return errorText(error);
}

/** The settings screen: account card, notifications, security, active sign-ins, install. */
export function AccountPage({ me }: { me: ResellerMeResponse }) {
  return (
    <div className="rp-grid2">
      <AccountCard me={me} />
      <NotificationsCard />
      <SecurityCard me={me} />
      <SessionsCard />
      <InstallCard />
    </div>
  );
}

function AccountCard({ me }: { me: ResellerMeResponse }) {
  const handle =
    me.customer.username === null ? me.customer.telegramUserId : `@${me.customer.username}`;
  const rows: [ReactNode, ReactNode][] = [
    [t('web.rp_account_name'), me.customer.firstName ?? '—'],
    [
      <span key="t">
        {t('web.rp_account_telegram')}
        <span className="muted small"> • {t('web.rp_account_telegram_hint')}</span>
      </span>,
      <span key="v" dir="ltr">
        {handle}
      </span>,
    ],
    [
      <span key="t">
        {t('web.rp_account_tier')}
        <span className="muted small"> • {t('web.rp_account_tier_hint')}</span>
      </span>,
      <Badge key="v" tone="violet">
        {me.reseller.tierName}
      </Badge>,
    ],
    [t('web.rp_account_since'), formatDate(me.reseller.since)],
  ];
  if (me.botUsername !== null) {
    rows.push([
      t('web.rp_account_bot'),
      <span key="b" dir="ltr">
        @{me.botUsername}
      </span>,
    ]);
  }
  return (
    <RpCard title={t('web.rp_account_title')} hint={t('web.rp_account_hint')}>
      <KV items={rows} />
    </RpCard>
  );
}

const PREFERENCE_ROWS: readonly {
  key: keyof ResellerPreferences;
  title: WebKey;
  hint: WebKey;
}[] = [
  {
    key: 'newDeviceAlert',
    title: 'web.rp_notif_new_device',
    hint: 'web.rp_notif_new_device_hint',
  },
  {
    key: 'expiringDigest',
    title: 'web.rp_notif_expiring',
    hint: 'web.rp_notif_expiring_hint',
  },
  {
    key: 'dailySalesReport',
    title: 'web.rp_notif_sales',
    hint: 'web.rp_notif_sales_hint',
  },
  {
    key: 'ticketReply',
    title: 'web.rp_notif_ticket',
    hint: 'web.rp_notif_ticket_hint',
  },
];

const PREFS_KEY = ['reseller', 'preferences'] as const;

function NotificationsCard() {
  const toast = useToast();
  const client = useQueryClient();
  const query = useQuery({ queryKey: PREFS_KEY, queryFn: fetchPreferences });
  const save = useMutation({
    mutationFn: (patch: Partial<ResellerPreferences>) => savePreferences(patch),
    onSuccess: (next) => {
      client.setQueryData(PREFS_KEY, next);
      toast({ tone: 'ok', message: t('web.rp_notif_saved') });
    },
    onError: (error) => toast({ tone: 'danger', message: errorText(error), error }),
  });
  const prefs = query.data;
  return (
    <RpCard title={t('web.rp_notif_title')} hint={t('web.rp_notif_hint')}>
      <StateSwitch query={query}>
        {prefs !== undefined &&
          PREFERENCE_ROWS.map((row) => (
            <ToggleRow
              key={row.key}
              title={t(row.title)}
              description={t(row.hint)}
              checked={prefs[row.key]}
              disabled={save.isPending}
              onChange={(next) => save.mutate({ [row.key]: next })}
            />
          ))}
      </StateSwitch>
    </RpCard>
  );
}

function SecurityCard({ me }: { me: ResellerMeResponse }) {
  const toast = useToast();
  const client = useQueryClient();
  const [mode, setMode] = useState<'idle' | 'enrol' | 'disable'>('idle');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const refreshMe = () => client.invalidateQueries({ queryKey: ME_KEY });
  const enrol = useMutation({
    mutationFn: enrolTotp,
    onSuccess: () => {
      setMode('enrol');
      setCode('');
      setProblem(null);
    },
    onError: (error) => setProblem(securityErrorText(error)),
  });
  const activate = useMutation({
    mutationFn: () => activateTotp(code),
    onSuccess: () => {
      setMode('idle');
      setCode('');
      toast({ tone: 'ok', message: t('web.rp_2fa_enabled') });
      void refreshMe();
      void client.invalidateQueries({ queryKey: ['reseller', 'sessions'] });
    },
    onError: (error) => setProblem(securityErrorText(error)),
  });
  const disable = useMutation({
    mutationFn: () => disableTotp(code),
    onSuccess: () => {
      setMode('idle');
      setCode('');
      toast({ tone: 'ok', message: t('web.rp_2fa_disabled') });
      void refreshMe();
    },
    onError: (error) => setProblem(securityErrorText(error)),
  });

  const cancel = () => {
    setMode('idle');
    setCode('');
    setProblem(null);
  };
  const secret = enrol.data;
  const qr =
    secret?.qrPngDataUrl !== null && secret?.qrPngDataUrl?.startsWith('data:image/png;base64,')
      ? secret.qrPngDataUrl
      : null;

  return (
    <RpCard title={t('web.rp_sec_title')} hint={t('web.rp_sec_hint')}>
      <div className="rp-stack">
        <div className="toggle-row">
          <div className="txt">
            <b>{t('web.rp_2fa_row')}</b>
            <span>{t('web.rp_2fa_row_hint')}</span>
          </div>
          <div className="rp-line">
            <Badge tone={me.secondFactor ? 'ok' : 'neutral'}>
              {me.secondFactor ? t('web.rp_2fa_on') : t('web.rp_2fa_off')}
            </Badge>
            {mode === 'idle' && (
              <Button
                size="sm"
                disabled={enrol.isPending}
                onClick={() => {
                  setProblem(null);
                  if (me.secondFactor) setMode('disable');
                  else enrol.mutate();
                }}
              >
                {me.secondFactor ? t('web.rp_2fa_disable') : t('web.rp_2fa_enable')}
              </Button>
            )}
          </div>
        </div>
        {mode === 'enrol' && secret !== undefined && (
          <div className="rp-mini rp-stack">
            <p className="small">{t('web.rp_2fa_enrol_hint')}</p>
            {qr !== null && (
              <img className="rp-qr" src={qr} alt={t('web.rp_qr_alt')} width={180} height={180} />
            )}
            <div className="rp-link">
              <span dir="ltr" className="rp-mono" aria-label={t('web.rp_2fa_secret')}>
                {secret.secret}
              </span>
              <CopyButton value={secret.secret} />
            </div>
            <CodeField value={code} onChange={setCode} />
            <div className="rp-line">
              <Button
                variant="primary"
                size="sm"
                disabled={code.length !== 6 || activate.isPending}
                onClick={() => activate.mutate()}
              >
                {t('web.rp_2fa_confirm')}
              </Button>
              <Button size="sm" onClick={cancel}>
                {t('web.rp_2fa_cancel')}
              </Button>
            </div>
          </div>
        )}
        {mode === 'disable' && (
          <div className="rp-mini rp-stack">
            <p className="small">{t('web.rp_2fa_disable_hint')}</p>
            <CodeField value={code} onChange={setCode} />
            <div className="rp-line">
              <Button
                variant="danger-solid"
                size="sm"
                disabled={code.length !== 6 || disable.isPending}
                onClick={() => disable.mutate()}
              >
                {t('web.rp_2fa_disable_confirm')}
              </Button>
              <Button size="sm" onClick={cancel}>
                {t('web.rp_2fa_cancel')}
              </Button>
            </div>
          </div>
        )}
        {problem !== null && <Banner tone="danger">{problem}</Banner>}
        <ActivityList />
      </div>
    </RpCard>
  );
}

function CodeField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <Field label={t('web.rp_2fa_label')} htmlFor="rp-totp-code">
      <Input
        id="rp-totp-code"
        dir="ltr"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\D/gu, '').slice(0, 6))}
      />
    </Field>
  );
}

const ACTIVITY_LABEL: Readonly<Record<string, WebKey>> = {
  'reseller_web.login': 'web.rp_act_login',
  'reseller_web.login_refused': 'web.rp_act_login_refused',
  'reseller_web.second_factor': 'web.rp_act_second_factor',
  'reseller_web.logout': 'web.rp_act_logout',
  'reseller_web.session_revoked': 'web.rp_act_session_revoked',
  'reseller_web.sessions_revoked_all': 'web.rp_act_sessions_revoked_all',
  'reseller_web.force_logout': 'web.rp_act_force_logout',
  'reseller_web.totp_enable': 'web.rp_act_totp_enable',
  'reseller_web.totp_disable': 'web.rp_act_totp_disable',
  'reseller_web.preferences': 'web.rp_act_preferences',
  'reseller_web.files_fetched': 'web.rp_act_files_fetched',
  'reseller_web.files_sent': 'web.rp_act_files_sent',
  'reseller_web.connection_sent': 'web.rp_act_connection_sent',
  'order.confirm': 'web.rp_act_order_confirm',
  'payment.wallet_settle': 'web.rp_act_wallet_settle',
  'payment.topup_request': 'web.rp_act_topup_request',
  'service.auto_renew_on': 'web.rp_act_auto_renew_on',
  'service.auto_renew_off': 'web.rp_act_auto_renew_off',
  'service.auto_renew_run': 'web.rp_act_auto_renew_run',
  'service.customer_note': 'web.rp_act_customer_note',
};

/** Recent activity: the reseller's own audit rows, newest first, a page at a time. */
function ActivityList() {
  const query = useInfiniteQuery({
    queryKey: ['reseller', 'activity'],
    queryFn: ({ pageParam }) => fetchActivity(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="rp-stack">
      <h3>{t('web.rp_activity_title')}</h3>
      <StateSwitch
        query={query}
        isEmpty={items.length === 0}
        empty={<Empty variant="compact" title={t('web.rp_activity_empty')} />}
      >
        <ul className="rp-list">
          {items.map((entry) => (
            <li key={entry.id}>
              <div>
                <b>
                  {Object.hasOwn(ACTIVITY_LABEL, entry.action)
                    ? t(ACTIVITY_LABEL[entry.action] as WebKey)
                    : t('web.rp_activity_other')}
                </b>
                {entry.result !== 'SUCCESS' && (
                  <span className="danger small"> {t('web.rp_activity_failed')}</span>
                )}
              </div>
              <span className="muted small" title={formatTimestamp(entry.at)}>
                {formatRelative(entry.at)}
              </span>
            </li>
          ))}
        </ul>
        {query.hasNextPage && (
          <div className="rp-more">
            <Button
              size="sm"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t('web.rp_activity_more')}
            </Button>
          </div>
        )}
      </StateSwitch>
    </div>
  );
}

const SESSIONS_KEY = ['reseller', 'sessions'] as const;

function SessionsCard() {
  const toast = useToast();
  const client = useQueryClient();
  const query = useQuery({ queryKey: SESSIONS_KEY, queryFn: fetchSessions });
  const [confirmAll, setConfirmAll] = useState(false);
  const revoke = useMutation({
    mutationFn: (id: string) => revokeSession(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: SESSIONS_KEY }),
    onError: (error) => toast({ tone: 'danger', message: errorText(error), error }),
  });
  const revokeAll = useMutation({
    mutationFn: revokeAllSessions,
    onSettled: () => {
      client.clear();
      goTo('/r/login', { replace: true });
    },
  });
  return (
    <RpCard
      title={t('web.rp_sessions_title')}
      hint={t('web.rp_sessions_hint')}
      actions={
        <Button size="sm" onClick={() => setConfirmAll(true)}>
          {t('web.rp_sessions_all')}
        </Button>
      }
    >
      <StateSwitch query={query}>
        {query.data?.items.map((session) => (
          <div key={session.id} className="toggle-row">
            <div className="txt">
              <b>{session.device}</b>
              <span>
                {session.network !== null && <span dir="ltr">{session.network} • </span>}
                {t('web.rp_session_last').replace('{at}', formatRelative(session.lastSeenAt))}
              </span>
              <span>
                {t('web.rp_session_since').replace('{at}', formatTimestamp(session.createdAt))}
              </span>
            </div>
            {session.current ? (
              <Badge tone="ok">{t('web.rp_session_current')}</Badge>
            ) : (
              <Button
                size="sm"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(session.id)}
              >
                {t('web.rp_session_signout')}
              </Button>
            )}
          </div>
        ))}
      </StateSwitch>
      {confirmAll && (
        <ConfirmDialog
          title={t('web.rp_sessions_all')}
          question={t('web.rp_sessions_all_question')}
          confirmLabel={t('web.rp_sessions_all_confirm')}
          cancelLabel={t('web.rp_sessions_all_cancel')}
          onCancel={() => setConfirmAll(false)}
          onConfirm={() => {
            setConfirmAll(false);
            revokeAll.mutate();
          }}
        />
      )}
    </RpCard>
  );
}

/** The install card: the browser's install prompt where there is one, else the iPhone steps. */
function InstallCard() {
  const install = useInstallState();
  return (
    <RpCard title={t('web.rp_pwa_title')} hint={t('web.rp_pwa_hint')}>
      <div className="rp-stack">
        {install.installed || install.standalone ? (
          <Banner tone="ok">{t('web.rp_pwa_installed')}</Banner>
        ) : install.canPrompt ? (
          <div>
            <Button variant="primary" size="sm" onClick={() => void install.install()}>
              {t('web.rp_pwa_install')}
            </Button>
          </div>
        ) : (
          <p className="muted small">{t('web.rp_pwa_ios')}</p>
        )}
      </div>
    </RpCard>
  );
}
