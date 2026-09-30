import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  botReplacementFailureDetailsSchema,
  type BotCommandMenuState,
  type BotDiagnostic,
  type BotIdentityCheckOutcome,
  type BotInstanceStatus,
  type BotInstanceView,
  type BotLiveProblem,
  type BotReadinessCause,
  type BotReadinessState,
  type BotReplacementFailureDetails,
  type BotWebhookCheckOutcome,
  type BotWebhookCompensation,
  type BotWebhookSecretState,
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
  ConfirmDialog,
  Copyable,
  DetailHead,
  Empty,
  Field,
  Ltr,
  PageHead,
  StateSwitch,
  useToast,
  type Tone,
  Num,
} from '../ui/kit';
import { Icon } from '../ui/icons';

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
 *
 * **A replacement answers with what Telegram was verified to hold (R4).** The server
 * registers the webhook with the new token and reads it back before storing anything, so
 * a success is shown WITH that verification — the URL this installation expects beside
 * the one Telegram reports — and a failure is shown with the stage it stopped at and what
 * was put back at Telegram. Neither needs a separate live check.
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
  'bot.webhook_route_unavailable': 'web.bot_error_webhook_route_unavailable',
  'bot.webhook_origin_unknown': 'web.bot_error_webhook_origin_unknown',
  'bot.token_replacement_in_progress': 'web.bot_error_replacement_in_progress',
  'bot.webhook_refused': 'web.bot_error_webhook_refused',
  'bot.webhook_setup_failed': 'web.bot_error_webhook_setup_failed',
  'bot.webhook_verification_failed': 'web.bot_error_webhook_verification_failed',
  'bot.token_activation_failed': 'web.bot_error_token_activation_failed',
};

/** What was put back at Telegram after a replacement that did not complete (R4). */
const COMPENSATION_TEXT: Readonly<Record<BotWebhookCompensation, WebKey>> = {
  NOT_NEEDED: 'web.bot_compensation_not_needed',
  RESTORED: 'web.bot_compensation_restored',
  HELD: 'web.bot_compensation_held',
  SUPERSEDED: 'web.bot_compensation_superseded',
  FAILED: 'web.bot_compensation_failed',
};

/** Everything in the way of receiving updates, each with its remedy (R4). */
const PROBLEM_TEXT: Readonly<Record<BotLiveProblem, WebKey>> = {
  WEBHOOK_ROUTE_DISABLED: 'web.bot_problem_route_disabled',
  TENANT_INACTIVE: 'web.bot_problem_tenant_inactive',
  BOT_NOT_ACTIVE: 'web.bot_problem_bot_not_active',
  TOKEN_NOT_ACCEPTED: 'web.bot_problem_token_not_accepted',
  DIFFERENT_BOT: 'web.bot_problem_different_bot',
  WEBHOOK_UNREADABLE: 'web.bot_problem_webhook_unreadable',
  WEBHOOK_EXPECTED_UNKNOWN: 'web.bot_problem_webhook_expected_unknown',
  WEBHOOK_NOT_SET: 'web.bot_problem_webhook_not_set',
  WEBHOOK_ELSEWHERE: 'web.bot_problem_webhook_elsewhere',
  WEBHOOK_UPDATES_NARROWED: 'web.bot_problem_webhook_updates_narrowed',
  WEBHOOK_SECRET_NOT_CURRENT: 'web.bot_problem_webhook_secret_not_current',
};

/**
 * The structured half of a replacement that stopped after Telegram was asked to change
 * (R4), or null for any other error. Parsed, not trusted: a shape this build does not
 * know is shown as the plain message alone.
 */
function replacementFailureOf(error: unknown): BotReplacementFailureDetails | null {
  if (!(error instanceof ApiError) || error.details === undefined) return null;
  const parsed = botReplacementFailureDetailsSchema.safeParse(error.details);
  return parsed.success ? parsed.data : null;
}

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
          <BotSection
            key={bot.id}
            bot={bot}
            mayOperate={mayOperate}
            mayReplaceToken={mayReplaceToken}
          />
        ))}
      </StateSwitch>

      <Card title={t('web.bots_add_title')} tone="muted">
        <p className="muted small">{t('web.bots_add_body')}</p>
      </Card>
    </>
  );
}

function BotSection({
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
      // A live check describes the bot as it was when checked; after a change it would
      // go on answering for a state that no longer exists.
      if (result.changed) setDiagnostic(null);
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
      // Results obtained with the previous credential say nothing about the new one; the
      // verification the replacement itself made replaces them (R4). A replay of an answer
      // stored before that field existed has none, and shows none rather than an old one.
      setDiagnostic(result.verification);
      notify({
        tone: 'ok',
        message: t(result.changed ? 'web.bot_token_done' : 'web.bot_token_same'),
      });
      // Round P: the command-menu sync is a SEPARATE result. A menu that could not be
      // registered is a warning the lane retries; the replacement above still succeeded.
      if (result.commandSync?.outcome === 'SYNCED') {
        notify({ tone: 'ok', message: t('web.bot_token_menu_synced') });
      } else if (result.commandSync?.outcome === 'FAILED') {
        notify({ tone: 'warn', message: t('web.bot_token_menu_sync_failed') });
      }
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

  /*
   * The head's actions, drawn from permissions (a courtesy — the server charges
   * `settings.edit` on every request). Stop asks first, through the kit's
   * dialog: stopping takes the bot off Telegram for every customer at once.
   */
  const actions = mayOperate ? (
    <>
      {bot.status === 'ACTIVE' && (
        <button type="button" className="btn" disabled={busy} onClick={() => check.mutate()}>
          <Icon name="activity" />
          {t('web.bot_check')}
        </button>
      )}
      {bot.status === 'STOPPED' && (
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={() => status.mutate('ACTIVE')}
        >
          <Icon name="play" />
          {t('web.bot_start')}
        </button>
      )}
      {bot.status === 'ACTIVE' && (
        <button
          type="button"
          className="btn danger"
          disabled={busy}
          onClick={() => setConfirmingStop(true)}
        >
          <Icon name="pause" />
          {t('web.bot_stop')}
        </button>
      )}
    </>
  ) : undefined;

  return (
    <section className="bot-block stack" aria-label={`@${bot.username}`}>
      <DetailHead
        title={<Ltr mono={false}>@{bot.username}</Ltr>}
        badge={
          <span className="bot-head-badges">
            <Badge tone={STATUS_TONE[bot.status]} dot>
              {t(STATUS_LABEL[bot.status])}
            </Badge>
            <Badge tone={READINESS_TONE[bot.readiness.state]} dot>
              {t(READINESS_LABEL[bot.readiness.state])}
            </Badge>
          </span>
        }
        meta={
          <span className="bot-head-meta">
            {bot.tenant.displayName} <Ltr>{bot.tenant.slug}</Ltr>
          </span>
        }
        {...(actions === undefined ? {} : { actions })}
        stats={[
          {
            label: t('web.bot_webhook'),
            value:
              bot.webhook.registeredAt === null ? (
                <span className="warn">{t('web.bot_webhook_never')}</span>
              ) : (
                <span className="small">{formatTimestamp(bot.webhook.registeredAt)}</span>
              ),
          },
          {
            label: t('web.bot_secret'),
            value: (
              <span className={bot.webhook.secret === 'MATCHES' ? 'ok' : 'warn'}>
                {t(SECRET_LABEL[bot.webhook.secret])}
              </span>
            ),
          },
          {
            label: t('web.bot_menu'),
            value: (
              <span className={bot.commandMenu === 'CURRENT' ? 'ok' : 'warn'}>
                {t(MENU_LABEL[bot.commandMenu])}
              </span>
            ),
          },
          {
            label: t('web.bot_telegram_id'),
            value:
              bot.telegramBotId === null ? (
                <span className="faint">{t('web.bot_telegram_id_unknown')}</span>
              ) : (
                <Ltr>{bot.telegramBotId}</Ltr>
              ),
          },
        ]}
      />

      {bot.readiness.causes.length > 0 && (
        <Banner tone={bot.readiness.state === 'HELD' ? 'danger' : 'warn'} role="status">
          <ul className="bot-causes" data-testid={`bot-causes-${bot.id}`}>
            {bot.readiness.causes.map((cause) => (
              <li key={cause}>{t(CAUSE_TEXT[cause])}</li>
            ))}
          </ul>
        </Banner>
      )}

      {failure != null && (
        <Banner tone="danger">
          <p>{botMessageFor(failure)}</p>
          <ReplacementFailureView details={replacementFailureOf(failure)} />
        </Banner>
      )}

      <div className="two-col">
        <div className="stack">
          <Card title={t('web.bot_details_title')}>
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
          </Card>

          {diagnostic !== null && (
            <Card title={t('web.bot_check_card')}>
              <DiagnosticView diagnostic={diagnostic} />
            </Card>
          )}
        </div>

        <div className="stack">
          {mayReplaceToken && (
            <Card title={t('web.bot_token_card')} hint={t('web.bot_token_card_hint')}>
              <div className="bot-token stack-sm">
                <Field
                  label={t('web.bot_token_label')}
                  htmlFor={`bot-token-${bot.id}`}
                  hint={t('web.bot_token_hint')}
                >
                  <input
                    id={`bot-token-${bot.id}`}
                    className="input ltr mono"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={token}
                    maxLength={256}
                    onChange={(event) => setToken(event.target.value)}
                  />
                </Field>
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busy || token.trim() === ''}
                    onClick={() => replace.mutate(token.trim())}
                  >
                    <Icon name="key" />
                    {t('web.bot_token_submit')}
                  </button>
                </div>
              </div>
            </Card>
          )}
          {!mayOperate && !mayReplaceToken && (
            <Card tone="muted">
              <p className="muted small">{t('web.bot_read_only')}</p>
            </Card>
          )}
        </div>
      </div>

      {confirmingStop && (
        <ConfirmDialog
          title={t('web.bot_stop_confirm_title')}
          question={t('web.bot_stop_confirm_body')}
          confirmLabel={t('web.bot_stop_confirm')}
          cancelLabel={t('web.bot_cancel')}
          onConfirm={() => {
            setConfirmingStop(false);
            status.mutate('STOPPED');
          }}
          onCancel={() => setConfirmingStop(false)}
        />
      )}
    </section>
  );
}

/**
 * Where a replacement stopped and what was put back (R4): the compensation, the URL this
 * installation expected beside the one Telegram reported, and Telegram's own reason for
 * a refusal. Nothing here is secret — the server sends a foreign URL cut to its origin.
 */
function ReplacementFailureView({ details }: { details: BotReplacementFailureDetails | null }) {
  if (details === null) return null;
  return (
    <ul className="small" data-testid="bot-replacement-failure">
      <li>{t(COMPENSATION_TEXT[details.compensation])}</li>
      {details.expectedUrl !== null && (
        <li>
          {t('web.bot_failure_expected')} <Ltr>{details.expectedUrl}</Ltr>
        </li>
      )}
      {details.stage === 'VERIFY_WEBHOOK' && (
        <li>
          {t('web.bot_failure_actual')}{' '}
          {details.actualUrl === null ? t('web.bot_check_none') : <Ltr>{details.actualUrl}</Ltr>}
        </li>
      )}
      {details.telegramReason !== null && (
        <li>
          {t('web.bot_failure_telegram_reason')} <Ltr>{details.telegramReason}</Ltr>
        </li>
      )}
    </ul>
  );
}

function DiagnosticView({ diagnostic }: { diagnostic: BotDiagnostic }) {
  const { identity, webhook, verdict } = diagnostic;
  return (
    <div className="bot-diagnostic" role="status" data-testid="bot-diagnostic">
      <p className="small">
        <strong>{t('web.bot_check_title')}</strong> {formatTimestamp(diagnostic.checkedAt)}
      </p>
      <p data-testid="bot-verdict">
        <Badge tone={verdict.readyToReceive ? 'ok' : 'danger'}>
          {t(verdict.readyToReceive ? 'web.bot_verdict_ready' : 'web.bot_verdict_not_ready')}
        </Badge>
      </p>
      {verdict.problems.length > 0 && (
        <ul className="bot-causes">
          {verdict.problems.map((problem) => (
            <li key={problem}>{t(PROBLEM_TEXT[problem])}</li>
          ))}
        </ul>
      )}
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
              {t('web.bot_check_expected')}{' '}
              {webhook.expectedUrl === null ? (
                t('web.bot_check_expected_unknown')
              ) : (
                <Ltr>{webhook.expectedUrl}</Ltr>
              )}
            </li>
            <li>
              {t('web.bot_check_url')}{' '}
              {webhook.url === null ? t('web.bot_check_none') : <Ltr>{webhook.url}</Ltr>}
              {/* The exact comparison when the expected URL is known; the recorded one
                  otherwise, which is all an installation with no recorded origin has. */}
              {webhook.matchesExpected === true && (
                <>
                  {' '}
                  <Badge tone="ok">{t('web.bot_check_url_exact')}</Badge>
                </>
              )}
              {webhook.matchesExpected === false && (
                <>
                  {' '}
                  <Badge tone="danger">{t('web.bot_check_url_not_exact')}</Badge>
                </>
              )}
              {webhook.matchesExpected === null && webhook.urlMatchesRecorded === false && (
                <>
                  {' '}
                  <Badge tone="danger">{t('web.bot_check_url_mismatch')}</Badge>
                </>
              )}
              {webhook.matchesExpected === null && webhook.urlMatchesRecorded === true && (
                <>
                  {' '}
                  <Badge tone="ok">{t('web.bot_check_url_matches')}</Badge>
                </>
              )}
            </li>
            <li>
              {t('web.bot_check_pending')} <Num value={webhook.pendingUpdateCount ?? '—'} />
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
