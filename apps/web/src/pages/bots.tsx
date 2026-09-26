import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BotCommandMenuState,
  BotDiagnostic,
  BotIdentityCheckOutcome,
  BotInstanceStatus,
  BotInstanceView,
  BotReadinessCause,
  BotReadinessState,
  BotWebhookCheckOutcome,
  BotWebhookSecretState,
} from '@nexa/contracts';
import { ApiError, checkBot, fetchBots, replaceBotToken, setBotStatus } from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { queryState } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Card,
  Copyable,
  Empty,
  Field,
  Ltr,
  PageHead,
  StateSwitch,
  useToast,
  type Tone,
} from '../ui/kit';

/**
 * Bots — this installation's Telegram bot instances (WP13,
 * `docs/wp13-bots-management-audit.md`).
 *
 * **What an operator can do here is exactly what the server can do truthfully.** See the
 * bot's recorded state, stop and start it, replace its token for the SAME bot, and ask
 * Telegram what it holds. Adding a bot, moving it to another tenant and registering a
 * webhook are not here, and a card says why rather than drawing a disabled button — a
 * disabled button means "exists, but you may not", which would be false.
 *
 * **Buttons are drawn from permissions, and that is a courtesy.** The server charges
 * `settings.edit` for stop, start and the live check, and `settings.destructive` for the
 * token, on every request.
 *
 * **The token field is a password input that is never pre-filled and is cleared after
 * every attempt.** There is no masked stand-in for the stored token: a mask can be
 * submitted back as the value, the rule panel credentials already follow.
 */

const STATUS_LABEL: Readonly<Record<BotInstanceStatus, WebKey>> = {
  ACTIVE: 'web.bot_status_active',
  STOPPED: 'web.bot_status_stopped',
  DISABLED: 'web.bot_status_disabled',
};
const STATUS_TONE: Readonly<Record<BotInstanceStatus, Tone>> = {
  ACTIVE: 'ok',
  STOPPED: 'warn',
  DISABLED: 'danger',
};

const READINESS_LABEL: Readonly<Record<BotReadinessState, WebKey>> = {
  REGISTERED: 'web.bot_readiness_registered',
  NOT_REGISTERED: 'web.bot_readiness_not_registered',
  HELD: 'web.bot_readiness_held',
};
const READINESS_TONE: Readonly<Record<BotReadinessState, Tone>> = {
  REGISTERED: 'ok',
  NOT_REGISTERED: 'warn',
  HELD: 'danger',
};

/** One sentence per cause, each naming the remedy — the bootstrap's own rule. */
const CAUSE_TEXT: Readonly<Record<BotReadinessCause, WebKey>> = {
  WEBHOOK_ROUTE_DISABLED: 'web.bot_cause_route_disabled',
  TENANT_INACTIVE: 'web.bot_cause_tenant_inactive',
  BOT_NOT_ACTIVE: 'web.bot_cause_bot_not_active',
  WEBHOOK_NEVER_REGISTERED: 'web.bot_cause_never_registered',
  WEBHOOK_SECRET_CHANGED: 'web.bot_cause_secret_changed',
  WEBHOOK_SECRET_UNKNOWN: 'web.bot_cause_secret_unknown',
};

const SECRET_LABEL: Readonly<Record<BotWebhookSecretState, WebKey>> = {
  MATCHES: 'web.bot_secret_matches',
  DIFFERS: 'web.bot_secret_differs',
  UNKNOWN: 'web.bot_secret_unknown',
  NOT_CONFIGURED: 'web.bot_secret_not_configured',
};

const MENU_LABEL: Readonly<Record<BotCommandMenuState, WebKey>> = {
  CURRENT: 'web.bot_menu_current',
  STALE: 'web.bot_menu_stale',
  UNKNOWN: 'web.bot_menu_unknown',
};

const IDENTITY_LABEL: Readonly<Record<BotIdentityCheckOutcome, WebKey>> = {
  IDENTIFIED: 'web.bot_identity_identified',
  REJECTED: 'web.bot_identity_rejected',
  NOT_TELEGRAM: 'web.bot_identity_not_telegram',
  UNREACHABLE: 'web.bot_identity_unreachable',
};

const WEBHOOK_CHECK_LABEL: Readonly<Record<BotWebhookCheckOutcome, WebKey>> = {
  READ: 'web.bot_webhook_read',
  REJECTED: 'web.bot_webhook_rejected',
  UNREACHABLE: 'web.bot_webhook_unreachable',
  SKIPPED: 'web.bot_webhook_skipped',
};

/** The server's refusals, each told as its remedy. Anything else falls through. */
const BOT_ERROR_TEXT: Readonly<Record<string, WebKey>> = {
  'bot.not_found': 'web.bot_error_not_found',
  'bot.status_not_managed': 'web.bot_error_status_not_managed',
  'bot.not_active': 'web.bot_error_not_active',
  'bot.token_malformed': 'web.bot_error_token_malformed',
  'bot.token_different_bot': 'web.bot_error_token_different_bot',
  'bot.identity_unknown': 'web.bot_error_identity_unknown',
  'bot.token_rejected': 'web.bot_error_token_rejected',
  'bot.telegram_unreachable': 'web.bot_error_telegram_unreachable',
  'bot.telegram_api_invalid': 'web.bot_error_telegram_api_invalid',
};

export function botMessageFor(error: unknown): string {
  if (error instanceof ApiError) {
    const key = BOT_ERROR_TEXT[error.code];
    if (key !== undefined) return t(key);
  }
  return messageFor(error);
}

export function BotsPage({
  denied,
  mayOperate,
  mayReplaceToken,
}: {
  denied: boolean;
  mayOperate: boolean;
  mayReplaceToken: boolean;
}) {
  const bots = useQuery({ queryKey: ['bots'], queryFn: () => fetchBots(), enabled: !denied });
  const rows = bots.data?.bots ?? [];

  return (
    <>
      <PageHead title={t('web.nav_bots')} subtitle={t('web.bots_subtitle')} maturity="now" />

      <StateSwitch
        query={bots}
        denied={denied}
        isEmpty={queryState(bots) === 'ready' && rows.length === 0}
        empty={<Empty title={t('web.bots_empty')} hint={t('web.bots_empty_hint')} />}
      >
        {rows.map((bot) => (
          <BotCard
            key={bot.id}
            bot={bot}
            mayOperate={mayOperate}
            mayReplaceToken={mayReplaceToken}
          />
        ))}
      </StateSwitch>

      <Card title={t('web.bots_add_title')}>
        <p className="muted small">{t('web.bots_add_body')}</p>
      </Card>
    </>
  );
}

function BotCard({
  bot,
  mayOperate,
  mayReplaceToken,
}: {
  bot: BotInstanceView;
  mayOperate: boolean;
  mayReplaceToken: boolean;
}) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [token, setToken] = useState('');
  const [diagnostic, setDiagnostic] = useState<BotDiagnostic | null>(null);

  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['bots'] });
  };

  const status = useMutation({
    mutationFn: (next: 'ACTIVE' | 'STOPPED') =>
      setBotStatus({
        id: bot.id,
        status: next,
        idempotencyKey: submission.current({ bot: bot.id, status: next }),
      }),
    onSuccess: (result) => {
      submission.settle();
      setConfirmingStop(false);
      notify({
        tone: 'ok',
        message: t(
          !result.changed
            ? 'web.bot_no_change'
            : result.bot.status === 'STOPPED'
              ? 'web.bot_stopped_done'
              : 'web.bot_started_done',
        ),
      });
      refresh();
    },
    onError: (error) => submission.settleOn(error),
  });

  const replace = useMutation({
    mutationFn: (value: string) =>
      replaceBotToken({
        id: bot.id,
        token: value,
        // Keyed by the bot alone: a fingerprint of the token would put a value derived
        // from it into memory the page keeps, for no gain — the server does not hash it
        // either.
        idempotencyKey: submission.current({ bot: bot.id, replaceToken: true }),
      }),
    onSuccess: (result) => {
      submission.settle();
      notify({
        tone: 'ok',
        message: t(result.changed ? 'web.bot_token_done' : 'web.bot_token_same'),
      });
      refresh();
    },
    onError: (error) => submission.settleOn(error),
    // Cleared whatever the answer: the value must not sit in the page after it was sent.
    onSettled: () => setToken(''),
  });

  const check = useMutation({
    mutationFn: () => checkBot(bot.id),
    onSuccess: (result) => setDiagnostic(result.diagnostic),
  });

  const busy = status.isPending || replace.isPending || check.isPending;
  const failure = status.error ?? replace.error ?? check.error;

  return (
    <Card
      title={`@${bot.username}`}
      actions={
        <>
          <Badge tone={STATUS_TONE[bot.status]}>{t(STATUS_LABEL[bot.status])}</Badge>{' '}
          <Badge tone={READINESS_TONE[bot.readiness.state]}>
            {t(READINESS_LABEL[bot.readiness.state])}
          </Badge>
        </>
      }
    >
      <dl className="kv">
        <dt>{t('web.bot_tenant')}</dt>
        <dd>
          {bot.tenant.displayName} <Ltr>{bot.tenant.slug}</Ltr>
          <span className="muted small"> — {t('web.bot_tenant_fixed')}</span>
        </dd>
        <dt>{t('web.bot_telegram_id')}</dt>
        <dd>
          {bot.telegramBotId === null ? (
            t('web.bot_telegram_id_unknown')
          ) : (
            <Ltr>{bot.telegramBotId}</Ltr>
          )}
        </dd>
        <dt>{t('web.bot_webhook')}</dt>
        <dd>
          {bot.webhook.registeredAt === null ? (
            t('web.bot_webhook_never')
          ) : (
            <>
              {formatTimestamp(bot.webhook.registeredAt)}{' '}
              {bot.webhook.url !== null && <Ltr>{bot.webhook.url}</Ltr>}
            </>
          )}
        </dd>
        <dt>{t('web.bot_secret')}</dt>
        <dd>{t(SECRET_LABEL[bot.webhook.secret])}</dd>
        <dt>{t('web.bot_menu')}</dt>
        <dd>{t(MENU_LABEL[bot.commandMenu])}</dd>
        <dt>{t('web.bot_id')}</dt>
        <dd>
          <Copyable value={bot.id} />
        </dd>
      </dl>

      {bot.readiness.causes.length > 0 && (
        <ul className="bot-causes" data-testid={`bot-causes-${bot.id}`}>
          {bot.readiness.causes.map((cause) => (
            <li key={cause}>{t(CAUSE_TEXT[cause])}</li>
          ))}
        </ul>
      )}

      {mayOperate && (
        <div className="toolbar">
          {bot.status === 'ACTIVE' && !confirmingStop && (
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => setConfirmingStop(true)}
            >
              {t('web.bot_stop')}
            </button>
          )}
          {bot.status === 'STOPPED' && (
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => status.mutate('ACTIVE')}
            >
              {t('web.bot_start')}
            </button>
          )}
          {bot.status === 'ACTIVE' && (
            <button type="button" className="btn sm" disabled={busy} onClick={() => check.mutate()}>
              {t('web.bot_check')}
            </button>
          )}
        </div>
      )}

      {confirmingStop && (
        <Banner tone="warn" title={t('web.bot_stop_confirm_title')}>
          <p>{t('web.bot_stop_confirm_body')}</p>
          <div className="toolbar">
            <button
              type="button"
              className="btn danger sm"
              disabled={busy}
              onClick={() => status.mutate('STOPPED')}
            >
              {t('web.bot_stop_confirm')}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => setConfirmingStop(false)}
            >
              {t('web.bot_cancel')}
            </button>
          </div>
        </Banner>
      )}

      {diagnostic !== null && <DiagnosticView diagnostic={diagnostic} />}

      {mayReplaceToken && (
        <div className="bot-token">
          <Field
            label={t('web.bot_token_label')}
            htmlFor={`bot-token-${bot.id}`}
            hint={t('web.bot_token_hint')}
          >
            <input
              id={`bot-token-${bot.id}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              maxLength={256}
              onChange={(event) => setToken(event.target.value)}
            />
          </Field>
          <div className="toolbar">
            <button
              type="button"
              className="btn primary sm"
              disabled={busy || token.trim() === ''}
              onClick={() => replace.mutate(token.trim())}
            >
              {t('web.bot_token_submit')}
            </button>
          </div>
        </div>
      )}

      {failure != null && <Banner tone="danger">{botMessageFor(failure)}</Banner>}
    </Card>
  );
}

function DiagnosticView({ diagnostic }: { diagnostic: BotDiagnostic }) {
  const { identity, webhook } = diagnostic;
  return (
    <div className="bot-diagnostic" role="status" data-testid="bot-diagnostic">
      <p className="small">
        <strong>{t('web.bot_check_title')}</strong> {formatTimestamp(diagnostic.checkedAt)}
      </p>
      <ul>
        <li>{t(IDENTITY_LABEL[identity.outcome])}</li>
        {identity.idMatches === false && <li>{t('web.bot_check_id_mismatch')}</li>}
        {identity.usernameMatches === false && identity.username !== null && (
          <li>
            {t('web.bot_check_username_mismatch')} <Ltr>@{identity.username}</Ltr>
          </li>
        )}
        <li>{t(WEBHOOK_CHECK_LABEL[webhook.outcome])}</li>
        {webhook.outcome === 'READ' && (
          <>
            <li>
              {t('web.bot_check_url')}{' '}
              {webhook.url === null ? t('web.bot_check_none') : <Ltr>{webhook.url}</Ltr>}
              {webhook.urlMatchesRecorded === false && (
                <>
                  {' '}
                  <Badge tone="danger">{t('web.bot_check_url_mismatch')}</Badge>
                </>
              )}
              {webhook.urlMatchesRecorded === true && (
                <>
                  {' '}
                  <Badge tone="ok">{t('web.bot_check_url_matches')}</Badge>
                </>
              )}
            </li>
            <li>
              {t('web.bot_check_pending')} <Ltr>{String(webhook.pendingUpdateCount ?? '—')}</Ltr>
            </li>
            <li>
              {t('web.bot_check_last_error')}{' '}
              {webhook.lastErrorAt === null ? (
                t('web.bot_check_none')
              ) : (
                <>
                  {formatTimestamp(webhook.lastErrorAt)}{' '}
                  {webhook.lastErrorMessage !== null && <Ltr>{webhook.lastErrorMessage}</Ltr>}
                </>
              )}
            </li>
          </>
        )}
      </ul>
    </div>
  );
}
