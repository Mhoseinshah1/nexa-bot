import { useCallback, useState } from 'react';
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
  type TemplateViewResponse,
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
import {
  Badge,
  Banner,
  Card,
  Ltr,
  PageHead,
  StateSwitch,
  TabPanel,
  useUnsavedChanges,
  type Tone,
} from '../ui/kit';
import { DirtyScope, useDirtySet } from './ops-b-layout';
import { DotTabs, KeptSheet } from './editor-layout';
import { TemplateCard } from './content';
import { ErrorReport } from './settings';
import { BUILDER_QUERY_KEY, MenuBuilder } from './bot-buttons/builder';
import { labelOf } from './bot-buttons/canvas';
import { InlineButtonsSection } from './bot-buttons/inline-buttons';
import { ServiceCardLayoutSection } from './bot-buttons/service-card-layout';

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
type BotButtonsTab = 'layout' | 'inline' | 'service' | 'labels' | 'commands';

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

  const [tab, setTab] = useState<BotButtonsTab>('layout');
  /** The text whose editor sheet is open: a main-menu button's label, or a command's. */
  const [openText, setOpenText] = useState<string | null>(null);
  const closeText = useCallback(() => setOpenText(null), []);
  const { dirty, report } = useDirtySet();
  /*
   * The builder and the glass buttons guard their own drafts with their own question; the
   * text cards report here, and leaving the page with one of them unsaved asks too.
   */
  const textKeys = [...dirty].filter(
    (key) => key !== 'builder' && key !== 'inline' && key !== 'service-card',
  );
  useUnsavedChanges(mayEditTemplates && textKeys.length > 0);

  /**
   * The Inspector's «edit the label»: that button's text opens in a side sheet over the
   * builder — no jump to another section, and the builder's selection stays as it was.
   */
  const editLabel = (id: MainMenuButtonId) => setOpenText(mainMenuButton(id).label);

  const labelRows = items.flatMap((item) => {
    const button = mainMenuButton(item.id);
    const template = menuTemplates.find((one) => one.key === button.label);
    return template === undefined ? [] : [{ item, button, template }];
  });
  const commandRows = BOT_COMMANDS.flatMap((entry) => {
    const template = commandTemplates.find((one) => one.key === entry.description);
    return template === undefined ? [] : [{ entry, template }];
  });
  const sourceBadge = (template: TemplateViewResponse) => (
    <>
      <Badge tone={template.source === 'DEFAULT' ? 'neutral' : 'info'}>
        {t(template.source === 'DEFAULT' ? 'web.source_default' : 'web.template_customised')}
      </Badge>
      {dirty.has(template.key) && (
        <Badge tone="warn" dot>
          {t('web.ob_unsaved_row')}
        </Badge>
      )}
    </>
  );

  return (
    <DirtyScope report={report}>
      <PageHead title={t('web.bot_buttons_title')} subtitle={t('web.bot_buttons_intro')} />
      <DotTabs
        value={tab}
        onChange={setTab}
        panelId="bot-buttons-panel"
        items={[
          {
            id: 'layout',
            label: t('web.bx_bb_tab_layout'),
            dot: dirty.has('builder') ? 'warn' : null,
          },
          { id: 'inline', label: t('web.ib_title'), dot: dirty.has('inline') ? 'warn' : null },
          {
            id: 'service',
            label: t('web.scl_title'),
            dot: dirty.has('service-card') ? 'warn' : null,
          },
          {
            id: 'labels',
            label: t('web.bot_buttons_labels_title'),
            dot: textKeys.length > 0 ? 'warn' : null,
          },
          { id: 'commands', label: t('web.bot_buttons_commands_title') },
        ]}
      />
      {/*
       * Every tab stays MOUNTED and only the chosen one is shown: the builder and the glass
       * buttons each hold a draft, and a tab switch must not drop it.
       */}
      <TabPanel id="bot-buttons-panel" labelledBy={`bot-buttons-panel-tab-${tab}`}>
        <div hidden={tab !== 'layout'}>
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
        </div>
        <div hidden={tab !== 'inline'}>
          <InlineButtonsSection
            mayEdit={mayEdit}
            denied={denied}
            mayViewTemplates={mayViewTemplates}
            mayEditTemplates={mayEditTemplates}
            templates={templates.data?.templates}
            // Codex 4170910525: a glass label can be a main-menu template (`bot.menu.services`),
            // so a label save re-reads both menu read models, as the texts cards do.
            onLabelChanged={refreshMenu}
          />
        </div>
        <div hidden={tab !== 'service'}>
          <ServiceCardLayoutSection
            mayEdit={mayEdit}
            denied={denied}
            mayViewTemplates={mayViewTemplates}
            mayEditTemplates={mayEditTemplates}
            templates={templates.data?.templates}
            onLabelChanged={refreshMenu}
          />
        </div>
        <div hidden={tab !== 'labels'}>
          {!mayViewTemplates ? (
            <Banner tone="info">{t('web.bot_buttons_labels_denied')}</Banner>
          ) : (
            <StateSwitch query={templates}>
              <div className="bx-pair">
                <Card
                  title={t('web.bot_buttons_labels_title')}
                  hint={t('web.bot_buttons_labels_hint')}
                >
                  <div className="tbl-wrap">
                    <table className="tbl dense bx-rows" data-testid="bot-buttons-labels">
                      <caption className="visually-hidden">
                        {t('web.bot_buttons_labels_title')}
                      </caption>
                      <tbody>
                        {labelRows.map(({ item, button, template }) => (
                          <tr key={button.id} id={`bot-buttons-label-${button.id}`}>
                            <td>
                              <button
                                type="button"
                                className="bx-rowlink"
                                aria-haspopup="dialog"
                                onClick={() => setOpenText(template.key)}
                              >
                                <span className="menu-preview-key">{labelOf(item.id, item)}</span>
                              </button>
                            </td>
                            <td>
                              <Ltr>{template.key}</Ltr>
                            </td>
                            <td>
                              <span className="bx-badges">
                                {sourceBadge(template)}
                                {item.duplicateLabel && (
                                  <Badge tone="warn">{t('web.bx_bb_duplicate')}</Badge>
                                )}
                                {item.slashLabel && <Badge tone="warn">/</Badge>}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
                <Card
                  title={t('web.bot_buttons_command_texts_title')}
                  hint={t('web.bot_buttons_command_texts_hint')}
                >
                  <div className="tbl-wrap">
                    <table className="tbl dense bx-rows" data-testid="bot-buttons-command-texts">
                      <caption className="visually-hidden">
                        {t('web.bot_buttons_command_texts_title')}
                      </caption>
                      <thead>
                        <tr>
                          <th>{t('web.bot_buttons_command')}</th>
                          <th>{t('web.bot_buttons_command_description')}</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {commandRows.map(({ entry, template }) => (
                          <tr key={entry.command}>
                            <td>
                              <button
                                type="button"
                                className="bx-rowlink"
                                aria-haspopup="dialog"
                                aria-label={`/${entry.command}`}
                                onClick={() => setOpenText(template.key)}
                              >
                                <Ltr>/{entry.command}</Ltr>
                              </button>
                            </td>
                            <td className="wrap">{template.body}</td>
                            <td>
                              <span className="bx-badges">{sourceBadge(template)}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </div>
            </StateSwitch>
          )}
        </div>
        <div hidden={tab !== 'commands'}>
          <StateSwitch query={menu} denied={denied} isEmpty={false}>
            {menu.data !== undefined && (
              <div className="grid-2">
                <CommandsCard config={menu.data} />
                <SyncCard bots={menu.data.bots} mayEdit={mayEdit} />
              </div>
            )}
          </StateSwitch>
        </div>
      </TabPanel>

      {/*
       * Each text's editor is a sheet that is hidden, never unmounted: a template card keeps
       * its own draft, which closing the sheet must not discard.
       */}
      {mayViewTemplates &&
        labelRows.map(({ item, button, template }) => (
          <KeptSheet
            key={template.key}
            open={openText === template.key}
            onClose={closeText}
            title={labelOf(item.id, item)}
            hint={<Ltr>{template.key}</Ltr>}
            wide
          >
            {item.duplicateLabel && (
              <Banner tone="warn">{t('web.bot_buttons_label_duplicate')}</Banner>
            )}
            {item.slashLabel && <Banner tone="warn">{t('web.bb_label_slash')}</Banner>}
            <TemplateCard
              key={button.id}
              template={template}
              mayEdit={mayEditTemplates}
              onChanged={refreshMenu}
            />
          </KeptSheet>
        ))}
      {mayViewTemplates &&
        commandRows.map(({ entry, template }) => (
          <KeptSheet
            key={template.key}
            open={openText === template.key}
            onClose={closeText}
            title={<Ltr>/{entry.command}</Ltr>}
            hint={template.body}
            wide
          >
            <TemplateCard template={template} mayEdit={mayEditTemplates} onChanged={refreshMenu} />
          </KeptSheet>
        ))}
    </DirtyScope>
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
