import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLATFORM_ERROR_CODES } from '@nexa/contracts';
import type {
  OpsConnectCodeResponse,
  OpsGroupTestResponse,
  OpsLogGroupHealth,
  OpsLogGroupProblem,
  OpsLogGroupResponse,
  OpsLogGroupView,
  OpsLogTopicCategory,
  OpsLogTopicState,
} from '@nexa/contracts';
import {
  ApiError,
  fetchOpsGroup,
  fetchSettings,
  issueOpsConnectCode,
  opsGroupAction,
  requeueOpsGroup,
  saveSetting,
  testOpsGroup,
} from '../api/client';
import { formatTimestamp } from '../format';
import { pollUnlessFinalWhile } from '../polling';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Card,
  Copyable,
  Field,
  Num,
  PageHead,
  StateSwitch,
  useToast,
  type Tone,
} from '../ui/kit';

/**
 * «گروه گزارش‌های مدیریتی» (WP-A4): the Telegram group Nexa posts its operations log to.
 *
 * The operator never types a chat id or a topic id. They pick a bot, press one button,
 * and either open the deep link — Telegram adds the bot to a group they choose, asks for
 * the admin rights, and posts the one-time code there — or type the command shown. Nexa
 * reads the group's identity from that authenticated update, checks the bot's rights,
 * and creates the topics it owns.
 *
 * **Buttons are drawn from permissions, and that is a courtesy.** The server charges
 * `settings.view` for the read and `settings.edit` for every action, on every request.
 *
 * The manual chat id is kept under «پیشرفته» for an installation that cannot connect a
 * group, and is used only while no group is connected.
 */

const HEALTH_LABEL: Readonly<Record<OpsLogGroupHealth, WebKey>> = {
  UNVERIFIED: 'web.opsgroup_health_unverified',
  HEALTHY: 'web.opsgroup_health_healthy',
  PROBLEM: 'web.opsgroup_health_problem',
};
const HEALTH_TONE: Readonly<Record<OpsLogGroupHealth, Tone>> = {
  UNVERIFIED: 'warn',
  HEALTHY: 'ok',
  PROBLEM: 'danger',
};

/** Each problem as its remedy, in the operator's words. */
const PROBLEM_TEXT: Readonly<Record<OpsLogGroupProblem, WebKey>> = {
  NOT_FORUM: 'web.opsgroup_problem_not_forum',
  BOT_NOT_ADMIN: 'web.opsgroup_problem_bot_not_admin',
  CANNOT_SEND: 'web.opsgroup_problem_cannot_send',
  CANNOT_MANAGE_TOPICS: 'web.opsgroup_problem_cannot_manage_topics',
  BOT_REMOVED: 'web.opsgroup_problem_bot_removed',
  CHAT_UNREACHABLE: 'web.opsgroup_problem_chat_unreachable',
  BOT_INACTIVE: 'web.opsgroup_problem_bot_inactive',
  TOPIC_CREATE_FAILED: 'web.opsgroup_problem_topic_create_failed',
};

const TOPIC_NAME: Readonly<Record<OpsLogTopicCategory, WebKey>> = {
  SYSTEM: 'web.opsgroup_topic_system',
  PAYMENTS: 'web.opsgroup_topic_payments',
};
const TOPIC_STATE: Readonly<Record<OpsLogTopicState, WebKey>> = {
  PENDING: 'web.opsgroup_topic_pending',
  READY: 'web.opsgroup_topic_ready',
  MISSING: 'web.opsgroup_topic_missing',
};
const TOPIC_TONE: Readonly<Record<OpsLogTopicState, Tone>> = {
  PENDING: 'warn',
  READY: 'ok',
  MISSING: 'danger',
};

/** The keys the advanced manual fallback edits. Hidden from the normal settings page. */
const MANUAL_KEYS: readonly {
  readonly key: string;
  readonly label: WebKey;
  readonly numeric: boolean;
}[] = [
  { key: 'ops.notifications.telegram_chat_id', label: 'web.opsgroup_manual_chat', numeric: false },
  { key: 'ops.notifications.telegram_topic_id', label: 'web.opsgroup_manual_topic', numeric: true },
  {
    key: 'ops.notifications.payments_topic_id',
    label: 'web.opsgroup_manual_payments_topic',
    numeric: true,
  },
];

function opsMessageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'ops_group.not_connected') return t('web.opsgroup_error_not_connected');
    if (error.code === 'ops_group.bot_not_available') return t('web.opsgroup_error_bot');
  }
  return messageFor(error);
}

/**
 * Whether the panel is about to change on its own, and so polls every 3 s: a connection
 * code is out, or a CONNECTED group has not been checked yet. A tenant with no group at
 * all reports `UNVERIFIED` by default and must not keep the fast lane for ever (Codex
 * review #2 of PR #99); everything else polls at 15 s.
 */
export function opsGroupPollsFast(view: OpsLogGroupView): boolean {
  return (
    view.pendingCodeExpiresAt !== null ||
    (view.connection === 'CONNECTED' && view.health === 'UNVERIFIED')
  );
}

/**
 * `settleOn`, except for `platform.idempotency_in_flight` (Codex review #2 of PR #99).
 * That 409 means the FIRST press is still running under this key, so the key is kept: the
 * next press asks for that press's answer instead of minting a new key and repeating the
 * whole action — for a test, a second set of messages in every topic.
 */
function settleUnlessInFlight(
  submission: { settleOn: (error: unknown) => void },
  error: unknown,
): void {
  if (error instanceof ApiError && error.code === PLATFORM_ERROR_CODES.IDEMPOTENCY_IN_FLIGHT)
    return;
  submission.settleOn(error);
}

export function OpsGroupPage({ denied, mayManage }: { denied: boolean; mayManage: boolean }) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [code, setCode] = useState<OpsConnectCodeResponse | null>(null);
  const [botId, setBotId] = useState<string>('');
  const [testResult, setTestResult] = useState<OpsGroupTestResponse['results'] | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const status = useQuery({
    queryKey: ['ops-group'],
    queryFn: () => fetchOpsGroup(),
    enabled: !denied,
    // While a code is out, or the worker has not checked the group yet, the answer is
    // about to change without anybody pressing anything.
    refetchInterval: pollUnlessFinalWhile<OpsLogGroupResponse>(
      3_000,
      (data) => opsGroupPollsFast(data.opsGroup),
      15_000,
    ),
  });
  const view = status.data?.opsGroup;

  const settle = async () => {
    submission.settle();
    await queries.invalidateQueries({ queryKey: ['ops-group'] });
  };

  const connect = useMutation({
    mutationFn: (bot: string) =>
      issueOpsConnectCode({
        botInstanceId: bot,
        idempotencyKey: submission.current({ command: 'ops-group.connect', bot }),
      }),
    onSuccess: async (issued) => {
      setCode(issued);
      await settle();
    },
    onError: (error) => settleUnlessInFlight(submission, error),
  });

  const act = useMutation({
    mutationFn: (action: 'verify' | 'reconnect' | 'disconnect') =>
      opsGroupAction(action, submission.current({ command: `ops-group.${action}` })),
    onSuccess: async (_result, action) => {
      setConfirmingDisconnect(false);
      notify({
        tone: 'ok',
        message: t(
          action === 'disconnect'
            ? 'web.opsgroup_disconnected_done'
            : action === 'reconnect'
              ? 'web.opsgroup_reconnected_done'
              : 'web.opsgroup_verified_done',
        ),
      });
      await settle();
    },
    onError: (error) => settleUnlessInFlight(submission, error),
  });

  const test = useMutation({
    mutationFn: () => testOpsGroup(submission.current({ command: 'ops-group.test' })),
    onSuccess: async (result) => {
      setTestResult(result.results);
      await settle();
    },
    onError: (error) => settleUnlessInFlight(submission, error),
  });

  const requeue = useMutation({
    mutationFn: () => requeueOpsGroup(submission.current({ command: 'ops-group.requeue' })),
    onSuccess: async (result) => {
      notify({
        tone: 'ok',
        message: `${t('web.opsgroup_requeued_done')} ${String(result.requeued)}`,
      });
      await settle();
    },
    onError: (error) => settleUnlessInFlight(submission, error),
  });

  const busy = connect.isPending || act.isPending || test.isPending || requeue.isPending;
  const failure = connect.error ?? act.error ?? test.error ?? requeue.error;
  const connected = view?.connection === 'CONNECTED';
  const chosenBot = botId !== '' ? botId : (view?.bots[0]?.id ?? '');

  return (
    <>
      <PageHead
        title={t('web.opsgroup_title')}
        subtitle={t('web.opsgroup_subtitle')}
        maturity="now"
      />

      <StateSwitch query={status} denied={denied} isEmpty={false}>
        {view !== undefined && (
          <>
            {!view.laneEnabled && <Banner tone="warn">{t('web.opsgroup_lane_off')}</Banner>}

            <Card
              title={t('web.opsgroup_connection')}
              actions={
                <Badge tone={connected ? 'ok' : 'danger'}>
                  {t(connected ? 'web.opsgroup_connected' : 'web.opsgroup_disconnected')}
                </Badge>
              }
            >
              <ConnectionFacts view={view} />

              {view.problems.length > 0 && (
                <Banner tone="danger" title={t('web.opsgroup_problems_title')}>
                  <ul className="bot-causes" data-testid="ops-group-problems">
                    {view.problems.map((problem) => (
                      <li key={problem}>{t(PROBLEM_TEXT[problem])}</li>
                    ))}
                  </ul>
                </Banner>
              )}

              {mayManage && (
                <div className="toolbar">
                  {connected && (
                    <>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busy}
                        onClick={() => act.mutate('verify')}
                      >
                        {t('web.opsgroup_verify')}
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busy}
                        onClick={() => test.mutate()}
                      >
                        {t('web.opsgroup_test')}
                      </button>
                    </>
                  )}
                  {view.group !== null && (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy}
                      onClick={() => act.mutate('reconnect')}
                    >
                      {t('web.opsgroup_reconnect')}
                    </button>
                  )}
                  {connected && !confirmingDisconnect && (
                    <button
                      type="button"
                      className="btn danger sm"
                      disabled={busy}
                      onClick={() => setConfirmingDisconnect(true)}
                    >
                      {t('web.opsgroup_disconnect')}
                    </button>
                  )}
                </div>
              )}

              {confirmingDisconnect && (
                <Banner tone="warn" title={t('web.opsgroup_disconnect_confirm_title')}>
                  <p>{t('web.opsgroup_disconnect_confirm_body')}</p>
                  <div className="toolbar">
                    <button
                      type="button"
                      className="btn danger sm"
                      disabled={busy}
                      onClick={() => act.mutate('disconnect')}
                    >
                      {t('web.opsgroup_disconnect')}
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy}
                      onClick={() => setConfirmingDisconnect(false)}
                    >
                      {t('web.bot_cancel')}
                    </button>
                  </div>
                </Banner>
              )}

              {testResult !== null && (
                <ul className="small" role="status" data-testid="ops-group-test">
                  {testResult.map((result) => (
                    <li key={result.category}>
                      {t(TOPIC_NAME[result.category])}:{' '}
                      {t(
                        result.outcome === 'SENT'
                          ? 'web.opsgroup_test_sent'
                          : 'web.opsgroup_test_failed',
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {failure != null && <Banner tone="danger">{opsMessageFor(failure)}</Banner>}
            </Card>

            <Card title={t('web.opsgroup_topics')} hint={t('web.opsgroup_topics_hint')}>
              <dl className="kv">
                {view.topics.map((topic) => (
                  <div key={topic.category} data-testid={`ops-topic-${topic.category}`}>
                    <dt>{t(TOPIC_NAME[topic.category])}</dt>
                    <dd>
                      <Badge tone={TOPIC_TONE[topic.state]}>{t(TOPIC_STATE[topic.state])}</Badge>{' '}
                      {topic.lastDeliveredAt !== null && (
                        <span className="muted small">
                          {t('web.opsgroup_last_delivery')} {formatTimestamp(topic.lastDeliveredAt)}
                        </span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>

            <Card title={t('web.opsgroup_queue')}>
              <dl className="kv">
                <dt>{t('web.opsgroup_queue_pending')}</dt>
                <dd>
                  <Num value={view.queue.pending} />
                </dd>
                <dt>{t('web.opsgroup_queue_preserved')}</dt>
                <dd>
                  <Num value={view.queue.preserved} />
                </dd>
              </dl>
              <p className="muted small">{t('web.opsgroup_queue_hint')}</p>
              {mayManage && connected && view.queue.preserved > 0 && (
                <div className="toolbar">
                  <button
                    type="button"
                    className="btn primary sm"
                    disabled={busy}
                    onClick={() => requeue.mutate()}
                  >
                    {t('web.opsgroup_requeue')}
                  </button>
                </div>
              )}
            </Card>

            {mayManage && (
              <Card title={t('web.opsgroup_connect_title')} hint={t('web.opsgroup_connect_hint')}>
                <ol className="small">
                  <li>{t('web.opsgroup_step_group')}</li>
                  <li>{t('web.opsgroup_step_admin')}</li>
                  <li>{t('web.opsgroup_step_code')}</li>
                </ol>
                {view.bots.length === 0 ? (
                  <Banner tone="warn">{t('web.opsgroup_no_bot')}</Banner>
                ) : (
                  <>
                    {view.bots.length > 1 && (
                      <Field label={t('web.opsgroup_bot')} htmlFor="ops-group-bot">
                        <select
                          id="ops-group-bot"
                          value={chosenBot}
                          onChange={(event) => setBotId(event.target.value)}
                        >
                          {view.bots.map((bot) => (
                            <option key={bot.id} value={bot.id}>
                              @{bot.username}
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}
                    <div className="toolbar">
                      <button
                        type="button"
                        className="btn primary sm"
                        disabled={busy || chosenBot === ''}
                        onClick={() => connect.mutate(chosenBot)}
                      >
                        {t('web.opsgroup_connect')}
                      </button>
                    </div>
                  </>
                )}
                {code !== null && (
                  <div className="ops-group-code" data-testid="ops-group-code">
                    <p>
                      <a
                        className="btn primary sm"
                        href={code.deepLink}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t('web.opsgroup_open_link')}
                      </a>
                    </p>
                    <p className="small">{t('web.opsgroup_or_command')}</p>
                    <Copyable value={code.command} />
                    <p className="muted small">
                      {t('web.opsgroup_code_expires')} {formatTimestamp(code.expiresAt)}
                    </p>
                  </div>
                )}
              </Card>
            )}

            {mayManage && <ManualFallback inUse={view.manual.inUse} />}
          </>
        )}
      </StateSwitch>
    </>
  );
}

function ConnectionFacts({ view }: { view: OpsLogGroupView }) {
  return (
    <dl className="kv">
      <dt>{t('web.opsgroup_group_name')}</dt>
      <dd>
        {view.group === null ? t('web.opsgroup_none') : view.group.title || t('web.opsgroup_none')}
      </dd>
      <dt>{t('web.opsgroup_bot')}</dt>
      <dd>
        {view.group === null || view.group.bot.username === ''
          ? t('web.opsgroup_none')
          : `@${view.group.bot.username}`}
      </dd>
      <dt>{t('web.opsgroup_health')}</dt>
      <dd>
        <Badge tone={HEALTH_TONE[view.health]}>{t(HEALTH_LABEL[view.health])}</Badge>
        {view.checkedAt !== null && (
          <span className="muted small">
            {' '}
            {t('web.opsgroup_checked_at')} {formatTimestamp(view.checkedAt)}
          </span>
        )}
      </dd>
      <dt>{t('web.opsgroup_last_delivery')}</dt>
      <dd>
        {view.lastDeliveredAt === null
          ? t('web.opsgroup_none')
          : formatTimestamp(view.lastDeliveredAt)}
      </dd>
    </dl>
  );
}

/**
 * «پیشرفته»: the manual destination, for an installation that cannot connect a group.
 *
 * The same three registry keys the settings page used to show, written through the same
 * settings endpoint with the version each was read at. Used only while no group is
 * connected; the panel says so rather than letting two destinations look equal.
 */
function ManualFallback({ inUse }: { inUse: boolean }) {
  const [open, setOpen] = useState(false);
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings, enabled: open });
  return (
    <details
      className="card"
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary>{t('web.opsgroup_advanced')}</summary>
      <p className="muted small">{t('web.opsgroup_advanced_hint')}</p>
      {inUse && <Banner tone="info">{t('web.opsgroup_manual_in_use')}</Banner>}
      {open && (
        <StateSwitch query={settings} denied={false} isEmpty={false}>
          {MANUAL_KEYS.map((entry) => {
            const row = settings.data?.settings.find((setting) => setting.key === entry.key);
            return row === undefined ? null : (
              <ManualRow
                key={`${entry.key}:${String(row.version)}`}
                entry={entry}
                value={row.value}
                version={row.version}
              />
            );
          })}
        </StateSwitch>
      )}
    </details>
  );
}

function ManualRow({
  entry,
  value,
  version,
}: {
  entry: (typeof MANUAL_KEYS)[number];
  value: unknown;
  version: number | null;
}) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [draft, setDraft] = useState(value === null || value === undefined ? '' : String(value));
  const save = useMutation({
    mutationFn: () => {
      const trimmed = draft.trim();
      const next = entry.numeric ? (trimmed === '' ? null : Number(trimmed)) : trimmed;
      return saveSetting({
        key: entry.key,
        value: next,
        expectedVersion: version,
        idempotencyKey: submission.current({ key: entry.key, value: next }),
      });
    },
    onSuccess: async () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.opsgroup_manual_saved') });
      await queries.invalidateQueries({ queryKey: ['settings'] });
      await queries.invalidateQueries({ queryKey: ['ops-group'] });
    },
    onError: (error) => submission.settleOn(error),
  });
  const id = `ops-manual-${entry.key}`;
  return (
    <div className="field-row">
      <Field label={t(entry.label)} htmlFor={id}>
        <input
          id={id}
          dir="ltr"
          inputMode="numeric"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </Field>
      <button
        type="button"
        className="btn sm"
        disabled={save.isPending}
        onClick={() => save.mutate()}
      >
        {t('web.save')}
      </button>
      {save.error != null && <Banner tone="danger">{messageFor(save.error)}</Banner>}
    </div>
  );
}
