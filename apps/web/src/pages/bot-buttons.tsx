import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BOT_COMMANDS,
  mainMenuButton,
  type BotCommandCheck,
  type BotCommandSyncResult,
  type BotCommandSyncState,
  type BotCommandSyncView,
  type BotMenuConfigResponse,
  type MainMenuButtonId,
} from '@nexa/contracts';
import {
  checkBotMenu,
  fetchBotMenu,
  fetchBotMenuBuilder,
  fetchTemplates,
  syncBotMenu,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import { Disclosure, Badge, Banner, Card, Ltr, PageHead, StateSwitch, type Tone } from '../ui/kit';
import { TemplateCard } from './content';
import { ErrorReport } from './settings';
import { BUILDER_QUERY_KEY, MenuBuilder } from './bot-buttons/builder';
import { labelOf } from './bot-buttons/canvas';
import { InlineButtonsSection } from './bot-buttons/inline-buttons';

const SYNC_STATE_LABEL: Readonly<Record<BotCommandSyncState, WebKey>> = {
  CURRENT: 'web.bot_menu_state_current',
  PENDING: 'web.bot_menu_state_pending',
  FAILING: 'web.bot_menu_state_failing',
  STALE: 'web.bot_menu_state_stale',
  UNKNOWN: 'web.bot_menu_state_unknown',
  STOPPED: 'web.bot_menu_state_stopped',
};
const SYNC_STATE_TONE: Readonly<Record<BotCommandSyncState, Tone>> = {
  CURRENT: 'ok',
  PENDING: 'info',
  FAILING: 'warn',
  STALE: 'warn',
  UNKNOWN: 'neutral',
  STOPPED: 'neutral',
};
const SYNC_RESULT_LABEL: Readonly<Record<BotCommandSyncResult['outcome'], WebKey>> = {
  SYNCED: 'web.bot_buttons_sync_result_synced',
  FAILED: 'web.bot_buttons_sync_result_failed',
  SKIPPED: 'web.bot_buttons_sync_result_skipped',
};

/** A transport code, as a Persian sentence. The code itself is shown beside it. */
export function syncErrorHint(code: string): WebKey {
  if (code === 'telegram.unreachable' || code.startsWith('telegram.server_error')) {
    return 'web.bot_buttons_error_unreachable';
  }
  if (code === 'telegram.rate_limited') return 'web.bot_buttons_error_rate_limited';
  if (code === 'telegram.rejected.401') return 'web.bot_buttons_error_rejected_token';
  if (code.startsWith('telegram.rejected.')) return 'web.bot_buttons_error_rejected_list';
  return 'web.bot_buttons_error_other';
}

/**
 * R1 + round P + round T: «دکمه‌های ربات» — the customer main menu and the Telegram command
 * menu, as an operator manages both.
 *
 * The main menu is edited in the BUILDER (round T, `bot-buttons/builder.tsx`): explicit
 * rows, a style and an icon slot per button, around a draft that changes nothing a
 * customer sees until it is published. It reads `GET /bot-menu/builder`, which answers each
 * registry button with the server's own gate answer; the page decides no gate.
 *
 * The command menu and each bot's sync state still come from `GET /bot-menu`. The labels
 * and the command descriptions are the `bot.menu.*` and `bot.command.*` texts, edited with
 * the texts screen's own card — live, outside the draft. This page holds no second copy of
 * anything.
 *
 * A button's TARGET is shown and never edited: each button opens exactly the command it
 * is declared for, and the schema refuses anything else, so two buttons cannot do one
 * thing and no button can carry an arbitrary payload.
 */
export function BotButtonsPage({
  mayEdit,
  denied,
  mayViewTemplates,
  mayEditTemplates,
}: {
  mayEdit: boolean;
  denied: boolean;
  mayViewTemplates: boolean;
  mayEditTemplates: boolean;
}) {
  const client = useQueryClient();
  const builder = useQuery({
    queryKey: BUILDER_QUERY_KEY,
    queryFn: fetchBotMenuBuilder,
    enabled: !denied,
  });
  const menu = useQuery({ queryKey: ['bot-menu'], queryFn: fetchBotMenu, enabled: !denied });
  // A label saved through a card changes the builder's labels and warnings, the command
  // list, the digest and every bot's state: both read models are re-read (Codex #7).
  const refreshMenu = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['bot-menu'] }),
      client.invalidateQueries({ queryKey: BUILDER_QUERY_KEY }),
    ]);
  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: fetchTemplates,
    enabled: !denied && mayViewTemplates,
  });
  const menuTemplates = (templates.data?.templates ?? []).filter((one) =>
    one.key.startsWith('bot.menu.'),
  );
  const commandTemplates = (templates.data?.templates ?? []).filter((one) =>
    one.key.startsWith('bot.command.'),
  );
  const items = builder.data?.items ?? [];

  /** The Inspector's «edit the label»: open that button's text card below and go to it. */
  const editLabel = (id: MainMenuButtonId) => {
    const host = document.getElementById(`bot-buttons-label-${id}`);
    const details = host?.querySelector('details');
    if (details === null || details === undefined) return;
    details.open = true;
    details.scrollIntoView?.({ block: 'start' });
    details.querySelector('summary')?.focus();
  };

  return (
    <>
      <PageHead title={t('web.bot_buttons_title')} subtitle={t('web.bot_buttons_intro')} />
      <StateSwitch query={builder} denied={denied} isEmpty={false}>
        {builder.data !== undefined && (
          <MenuBuilder
            view={builder.data}
            mayEdit={mayEdit}
            mayViewTemplates={mayViewTemplates}
            onEditLabel={editLabel}
            refetch={() => builder.refetch()}
          />
        )}
      </StateSwitch>
      <StateSwitch query={menu} denied={denied} isEmpty={false}>
        {menu.data !== undefined && (
          <div className="grid-2">
            <CommandsCard config={menu.data} />
            <SyncCard bots={menu.data.bots} mayEdit={mayEdit} />
          </div>
        )}
      </StateSwitch>
      {/* Owner spec §6: the inline (glass) buttons, between the command menu and the texts. */}
      <InlineButtonsSection
        mayEdit={mayEdit}
        denied={denied}
        mayViewTemplates={mayViewTemplates}
        mayEditTemplates={mayEditTemplates}
        templates={templates.data?.templates}
        onLabelChanged={() => client.invalidateQueries({ queryKey: ['templates'] })}
      />
      <Card title={t('web.bot_buttons_labels_title')} hint={t('web.bot_buttons_labels_hint')}>
        {!mayViewTemplates ? (
          <Banner tone="info">{t('web.bot_buttons_labels_denied')}</Banner>
        ) : (
          <StateSwitch query={templates}>
            {items.map((item) => {
              const button = mainMenuButton(item.id);
              const template = menuTemplates.find((one) => one.key === button.label);
              if (template === undefined) return null;
              return (
                <div key={button.id} id={`bot-buttons-label-${button.id}`}>
                  <Disclosure summary={labelOf(item.id, item)}>
                    {item.duplicateLabel && (
                      <Banner tone="warn">{t('web.bot_buttons_label_duplicate')}</Banner>
                    )}
                    {item.slashLabel && <Banner tone="warn">{t('web.bb_label_slash')}</Banner>}
                    <TemplateCard
                      template={template}
                      mayEdit={mayEditTemplates}
                      onChanged={refreshMenu}
                    />
                  </Disclosure>
                </div>
              );
            })}
            <h3 className="small">{t('web.bot_buttons_command_texts_title')}</h3>
            <p className="muted small">{t('web.bot_buttons_command_texts_hint')}</p>
            {BOT_COMMANDS.map((entry) => {
              const template = commandTemplates.find((one) => one.key === entry.description);
              if (template === undefined) return null;
              return (
                <Disclosure
                  key={entry.command}
                  summary={
                    <span>
                      <Ltr>/{entry.command}</Ltr> — {template.body}
                    </span>
                  }
                >
                  <TemplateCard
                    template={template}
                    mayEdit={mayEditTemplates}
                    onChanged={refreshMenu}
                  />
                </Disclosure>
              );
            })}
          </StateSwitch>
        )}
      </Card>
    </>
  );
}

/** The command menu Telegram is given: the customer scope, as this tenant words it. */
function CommandsCard({ config }: { config: BotMenuConfigResponse }) {
  return (
    <Card title={t('web.bot_buttons_commands_title')} hint={t('web.bot_buttons_commands_hint')}>
      <div className="tbl-wrap">
        <table className="tbl dense" data-testid="bot-commands">
          <caption className="visually-hidden">{t('web.bot_buttons_commands_title')}</caption>
          <thead>
            <tr>
              <th>{t('web.bot_buttons_command')}</th>
              <th>{t('web.bot_buttons_command_description')}</th>
            </tr>
          </thead>
          <tbody>
            {config.commands.entries.map((entry) => (
              <tr key={entry.command} data-command={entry.command}>
                <td>
                  <Ltr>/{entry.command}</Ltr>
                </td>
                <td className="wrap">{entry.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        {t('web.bot_buttons_commands_hash')} <Ltr>{config.commands.hash}</Ltr>
      </p>
    </Card>
  );
}

/** Where each bot's command menu stands, and the two actions on it. */
function SyncCard({ bots, mayEdit }: { bots: readonly BotCommandSyncView[]; mayEdit: boolean }) {
  const client = useQueryClient();
  const submission = useSubmissionKey();
  const [selectedId, setSelectedId] = useState<string | null>(
    () => (bots.find((bot) => bot.botStatus === 'ACTIVE') ?? bots[0])?.botInstanceId ?? null,
  );
  const selected = bots.find((bot) => bot.botInstanceId === selectedId) ?? bots[0] ?? null;
  const [checks, setChecks] = useState<readonly BotCommandCheck[] | null>(null);

  const refresh = () => client.invalidateQueries({ queryKey: ['bot-menu'] });
  const sync = useMutation({
    mutationFn: (botInstanceId: string) =>
      syncBotMenu({ botInstanceId, idempotencyKey: submission.current({ sync: botInstanceId }) }),
    onSuccess: async () => {
      submission.settle();
      setChecks(null);
      await refresh();
    },
    onError: (error: unknown) => submission.settleOn(error),
  });
  const check = useMutation({
    mutationFn: (botInstanceId: string) => checkBotMenu({ botInstanceId }),
    onSuccess: (result) => setChecks(result.checks),
  });
  const busy = sync.isPending || check.isPending;

  if (selected === null) {
    return (
      <Card title={t('web.bot_buttons_sync_title')} hint={t('web.bot_buttons_sync_hint')}>
        <p className="muted small">{t('web.bot_buttons_no_bots')}</p>
      </Card>
    );
  }
  const never = t('web.bot_buttons_sync_never');
  const results = sync.data?.results.filter((one) => one.botInstanceId === selected.botInstanceId);
  const ownChecks = checks?.filter((one) => one.botInstanceId === selected.botInstanceId);

  return (
    <Card
      title={t('web.bot_buttons_sync_title')}
      hint={t('web.bot_buttons_sync_hint')}
      actions={
        <Badge tone={SYNC_STATE_TONE[selected.state]}>{t(SYNC_STATE_LABEL[selected.state])}</Badge>
      }
    >
      {bots.length > 1 && (
        <div className="row">
          <label htmlFor="bot-buttons-sync-bot">{t('web.bot_buttons_sync_bot')}</label>
          <select
            id="bot-buttons-sync-bot"
            className="input sm"
            value={selected.botInstanceId}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setChecks(null);
            }}
          >
            {bots.map((bot) => (
              <option key={bot.botInstanceId} value={bot.botInstanceId}>
                @{bot.username}
              </option>
            ))}
          </select>
        </div>
      )}
      <dl className="kv" data-testid="bot-menu-sync">
        <dt>{t('web.bot_buttons_sync_bot')}</dt>
        <dd>
          <Ltr>@{selected.username}</Ltr>
        </dd>
        <dt>{t('web.bot_buttons_sync_version')}</dt>
        <dd>
          {String(selected.desiredVersion)} <Ltr>{selected.desiredHash}</Ltr>
        </dd>
        <dt>{t('web.bot_buttons_sync_last_success')}</dt>
        <dd>{selected.lastSyncedAt === null ? never : formatTimestamp(selected.lastSyncedAt)}</dd>
        <dt>{t('web.bot_buttons_sync_last_attempt')}</dt>
        <dd>
          {selected.lastAttemptedAt === null ? never : formatTimestamp(selected.lastAttemptedAt)}
        </dd>
        <dt>{t('web.bot_buttons_sync_last_error')}</dt>
        <dd>
          {selected.lastErrorCode === null ? (
            t('web.bot_buttons_sync_none')
          ) : (
            <>
              {t(syncErrorHint(selected.lastErrorCode))} <Ltr>{selected.lastErrorCode}</Ltr>
            </>
          )}
        </dd>
        {selected.attempts > 0 && (
          <>
            <dt>{t('web.bot_buttons_sync_attempts')}</dt>
            <dd>{String(selected.attempts)}</dd>
          </>
        )}
        {selected.nextAttemptAt !== null && (
          <>
            <dt>{t('web.bot_buttons_sync_next_attempt')}</dt>
            <dd>{formatTimestamp(selected.nextAttemptAt)}</dd>
          </>
        )}
      </dl>
      {selected.state === 'STOPPED' && (
        <p className="muted small">{t('web.bot_buttons_sync_stopped_hint')}</p>
      )}
      {selected.state === 'STALE' && (
        <p className="muted small">{t('web.bot_buttons_sync_stale_hint')}</p>
      )}
      {selected.state === 'FAILING' && (
        <p className="muted small">{t('web.bot_buttons_sync_failing_hint')}</p>
      )}
      {mayEdit && selected.botStatus === 'ACTIVE' && (
        <div className="row">
          <button
            type="button"
            className="btn primary sm"
            disabled={busy}
            onClick={() => sync.mutate(selected.botInstanceId)}
          >
            {t('web.bot_buttons_sync_now')}
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={() => check.mutate(selected.botInstanceId)}
          >
            {t('web.bot_buttons_check_now')}
          </button>
        </div>
      )}
      {(sync.isError || check.isError) && <ErrorReport error={sync.error ?? check.error} />}
      {results?.map((result) => (
        <Banner
          key={result.botInstanceId}
          tone={result.outcome === 'SYNCED' ? 'ok' : result.outcome === 'FAILED' ? 'warn' : 'info'}
        >
          {t(SYNC_RESULT_LABEL[result.outcome])}
          {result.errorCode !== null && (
            <>
              {' '}
              {t(syncErrorHint(result.errorCode))} <Ltr>{result.errorCode}</Ltr>
            </>
          )}
        </Banner>
      ))}
      {ownChecks?.map((one) => (
        <CheckView key={one.botInstanceId} check={one} />
      ))}
    </Card>
  );
}

function CheckView({ check }: { check: BotCommandCheck }) {
  if (check.outcome !== 'READ') {
    const key: WebKey =
      check.outcome === 'REJECTED'
        ? 'web.bot_buttons_check_rejected'
        : check.outcome === 'UNREACHABLE'
          ? 'web.bot_buttons_check_unreachable'
          : 'web.bot_buttons_check_skipped';
    return <Banner tone="warn">{t(key)}</Banner>;
  }
  return (
    <div data-testid="bot-menu-check">
      <Banner tone={check.matches === true ? 'ok' : 'warn'}>
        {t(
          check.matches === true
            ? 'web.bot_buttons_check_read_match'
            : 'web.bot_buttons_check_read_mismatch',
        )}
      </Banner>
      {check.registered !== null && (
        <>
          <p className="muted small">{t('web.bot_buttons_check_registered')}</p>
          <ul>
            {check.registered.map((entry) => (
              <li key={entry.command}>
                <Ltr>/{entry.command}</Ltr> — {entry.description}
              </li>
            ))}
            {check.registered.length === 0 && <li>{t('web.bot_buttons_sync_none')}</li>}
          </ul>
        </>
      )}
    </div>
  );
}
