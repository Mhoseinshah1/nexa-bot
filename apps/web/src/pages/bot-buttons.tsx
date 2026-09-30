import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BOT_COMMANDS,
  MENU_APPEARANCE_SLOTS,
  mainMenuButton,
  mainMenuLayoutSchema,
  packMainMenuRows,
  resolveMainMenuLayout,
  mainMenuEntryOf,
  type BotCommandCheck,
  type BotCommandSyncResult,
  type BotCommandSyncState,
  type BotCommandSyncView,
  type BotMenuConfigResponse,
  type MainMenuGate,
  type MainMenuItemView,
  type MainMenuLayoutEntry,
  type MenuAppearanceSlot,
} from '@nexa/contracts';
import {
  checkBotMenu,
  fetchBotMenu,
  fetchTemplates,
  saveSetting,
  syncBotMenu,
} from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import { templateCopy } from '../template-copy';
import { Badge, Banner, Card, Ltr, PageHead, StateSwitch, Switch, type Tone } from '../ui/kit';
import { TemplateCard } from './content';
import { ErrorReport } from './settings';

const SETTING_KEY = 'bot.main_menu';

/** The sentence under a gated button, by the gate the server names. */
const GATE_NOTES: Readonly<Record<MainMenuGate, WebKey>> = {
  FEATURE: 'web.bot_buttons_needs_referrals',
  TRIAL_OFFER: 'web.bot_buttons_needs_trial_offer',
};
const GATE_CLOSED: Readonly<Record<MainMenuGate, WebKey>> = {
  FEATURE: 'web.bot_buttons_feature_off',
  TRIAL_OFFER: 'web.bot_buttons_trial_not_offered',
};

/** The Persian name of each appearance slot. The catalogue itself belongs to the appearance section. */
const SLOT_LABELS: Readonly<Record<MenuAppearanceSlot, WebKey>> = {
  success: 'web.appearance_slot_success',
  error: 'web.appearance_slot_error',
  warning: 'web.appearance_slot_warning',
  info: 'web.appearance_slot_info',
  payment: 'web.appearance_slot_payment',
  wallet: 'web.appearance_slot_wallet',
  purchase: 'web.appearance_slot_purchase',
  service: 'web.appearance_slot_service',
  trial: 'web.appearance_slot_trial',
  referral: 'web.appearance_slot_referral',
  support: 'web.appearance_slot_support',
  renewal: 'web.appearance_slot_renewal',
  traffic: 'web.appearance_slot_traffic',
  time: 'web.appearance_slot_time',
  link: 'web.appearance_slot_link',
  active: 'web.appearance_slot_active',
  inactive: 'web.appearance_slot_inactive',
};

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
 * R1 + round P: «دکمه‌های ربات» — the customer main menu and the Telegram command menu, as
 * an operator manages both.
 *
 * Everything shown is read from ONE endpoint (`/bot-menu`), which answers each item with
 * the keyboard's own decision about it — enabled, its gate and whether that gate is open
 * now — so the table and the preview say what the bot says. What is WRITTEN goes where
 * it already lives: the arrangement (order, on/off, appearance slot) is the registry
 * setting `bot.main_menu`, saved whole with the version it was read at; the labels and
 * the command descriptions are the `bot.menu.*` and `bot.command.*` texts, edited with
 * the texts screen's own card. This page holds no second copy of anything.
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
  const menu = useQuery({ queryKey: ['bot-menu'], queryFn: fetchBotMenu, enabled: !denied });
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

  return (
    <>
      <PageHead title={t('web.bot_buttons_title')} subtitle={t('web.bot_buttons_intro')} />
      <StateSwitch query={menu} denied={denied} isEmpty={false}>
        {menu.data !== undefined && (
          <>
            <LayoutCard
              // Re-seeded from the server whenever the stored value moves on.
              key={String(menu.data.layout.version ?? 0)}
              config={menu.data}
              mayEdit={mayEdit}
            />
            <CommandsCard config={menu.data} />
            <SyncCard bots={menu.data.bots} mayEdit={mayEdit} />
          </>
        )}
      </StateSwitch>
      <Card title={t('web.bot_buttons_labels_title')} hint={t('web.bot_buttons_labels_hint')}>
        {!mayViewTemplates ? (
          <Banner tone="info">{t('web.bot_buttons_labels_denied')}</Banner>
        ) : (
          <StateSwitch query={templates}>
            {(menu.data?.layout.items ?? []).map((item) => {
              const button = mainMenuButton(item.id);
              const template = menuTemplates.find((one) => one.key === button.label);
              if (template === undefined) return null;
              return (
                <details key={button.id}>
                  <summary>{labelOf(item)}</summary>
                  {duplicated(item, menu.data?.layout.items ?? []) && (
                    <Banner tone="warn">{t('web.bot_buttons_label_duplicate')}</Banner>
                  )}
                  <TemplateCard template={template} mayEdit={mayEditTemplates} />
                </details>
              );
            })}
            <h3 className="small">{t('web.bot_buttons_command_texts_title')}</h3>
            <p className="muted small">{t('web.bot_buttons_command_texts_hint')}</p>
            {BOT_COMMANDS.map((entry) => {
              const template = commandTemplates.find((one) => one.key === entry.description);
              if (template === undefined) return null;
              return (
                <details key={entry.command}>
                  <summary>
                    <Ltr>/{entry.command}</Ltr> — {template.body}
                  </summary>
                  <TemplateCard template={template} mayEdit={mayEditTemplates} />
                </details>
              );
            })}
          </StateSwitch>
        )}
      </Card>
    </>
  );
}

/** The label a button shows now: the tenant's text, else the template's Persian name. */
function labelOf(item: MainMenuItemView): string {
  const button = mainMenuButton(item.id);
  return item.label !== '' ? item.label : templateCopy(button.label, '').name;
}

/** Whether another button shows the same text — the bot could then reach only one of them. */
function duplicated(item: MainMenuItemView, items: readonly MainMenuItemView[]): boolean {
  if (item.label === '') return false;
  return items.some((other) => other.id !== item.id && other.label === item.label);
}

/** The stored entries as the server resolved them, so the draft starts from the truth. */
function entriesOf(items: readonly MainMenuItemView[]): readonly MainMenuLayoutEntry[] {
  return items.map((item) =>
    mainMenuEntryOf({
      button: item.id,
      enabled: item.enabled,
      target: item.target,
      appearanceSlot: item.appearanceSlot,
      appearanceSlotOverridden: item.appearanceSlot !== item.defaultAppearanceSlot,
    }),
  );
}

function LayoutCard({ config, mayEdit }: { config: BotMenuConfigResponse; mayEdit: boolean }) {
  const client = useQueryClient();
  const submission = useSubmissionKey();
  const items = config.layout.items;
  const byId = new Map(items.map((item) => [item.id, item]));
  const [draft, setDraft] = useState<readonly MainMenuLayoutEntry[]>(() => entriesOf(items));

  const save = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      value: readonly MainMenuLayoutEntry[];
      expectedVersion: number | null;
    }) => saveSetting({ key: SETTING_KEY, ...command }),
    onSuccess: async () => {
      submission.settle();
      await Promise.all([
        client.invalidateQueries({ queryKey: ['bot-menu'] }),
        client.invalidateQueries({ queryKey: ['settings'] }),
      ]);
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
    },
  });

  const valid = mainMenuLayoutSchema.safeParse(draft).success;
  const dirty = JSON.stringify(draft) !== JSON.stringify(entriesOf(items));
  const editable = mayEdit && !save.isPending;

  const move = (index: number, by: -1 | 1) => {
    const target = index + by;
    if (target < 0 || target >= draft.length) return;
    const next = [...draft];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(target, 0, moved);
    setDraft(next);
  };
  const toggle = (index: number, enabled: boolean) =>
    setDraft(draft.map((entry, at) => (at === index ? { ...entry, enabled } : entry)));
  const chooseSlot = (index: number, slot: MenuAppearanceSlot) =>
    setDraft(
      draft.map((entry, at) => {
        if (at !== index) return entry;
        const defaultSlot = mainMenuButton(entry.button).appearanceSlot;
        return { ...entry, appearanceSlot: slot === defaultSlot ? null : slot };
      }),
    );

  const onSave = () => {
    if (!valid) return;
    const command = { value: draft, expectedVersion: config.layout.version };
    save.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  // The preview is the keyboard the bot draws from THIS draft: the server's answer about
  // each gate (read for switched-off items too), applied to the draft's switches. A gated
  // item is drawn only when its gate is KNOWN open; unknown is not open (Codex #6).
  const preview = packMainMenuRows(
    resolveMainMenuLayout(draft)
      .filter((entry) => entry.enabled)
      .map((entry) => byId.get(entry.button))
      .filter(
        (item): item is MainMenuItemView =>
          item !== undefined && (item.gate === null || item.gateOpen === true),
      )
      .map((item) => ({ id: item.id, wide: item.wide, label: labelOf(item) })),
  );

  return (
    <>
      <Card title={t('web.bot_buttons_order_title')} hint={t('web.bot_buttons_order_hint')}>
        {config.layout.storedValueInvalid && (
          <Banner tone="danger">{t('web.bot_buttons_stored_invalid')}</Banner>
        )}
        <div className="tbl-wrap">
          <table className="tbl">
            <caption className="visually-hidden">{t('web.bot_buttons_order_title')}</caption>
            <thead>
              <tr>
                <th>{t('web.bot_buttons_position')}</th>
                <th>{t('web.bot_buttons_button')}</th>
                <th>{t('web.bot_buttons_target')}</th>
                <th>{t('web.bot_buttons_slot')}</th>
                <th>{t('web.bot_buttons_shown')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {resolveMainMenuLayout(draft).map((entry, index) => {
                const item = byId.get(entry.button);
                if (item === undefined) return null;
                const label = labelOf(item);
                const slotSelect = `bot-buttons-slot-${item.id}`;
                return (
                  <tr key={item.id} data-button={item.id}>
                    <td>{String(index + 1)}</td>
                    <td>
                      <span className="strong">{label}</span>
                      {item.labelOverridden && (
                        <p className="muted small">
                          {t('web.bot_buttons_label_default')} {item.defaultLabel}
                        </p>
                      )}
                      {item.gate !== null && (
                        <p className="muted small">
                          {t(GATE_NOTES[item.gate])}{' '}
                          {item.gateOpen === false && (
                            <Badge tone="warn">{t(GATE_CLOSED[item.gate])}</Badge>
                          )}
                        </p>
                      )}
                    </td>
                    <td>
                      <Badge tone="neutral" title={t('web.bot_buttons_target_hint')}>
                        <Ltr>/{item.target}</Ltr>
                      </Badge>
                    </td>
                    <td>
                      <label className="visually-hidden" htmlFor={slotSelect}>
                        {`${t('web.bot_buttons_slot')}: ${label}`}
                      </label>
                      <select
                        id={slotSelect}
                        className="input sm"
                        value={entry.appearanceSlot}
                        disabled={!editable}
                        onChange={(event) =>
                          chooseSlot(index, event.target.value as MenuAppearanceSlot)
                        }
                      >
                        {MENU_APPEARANCE_SLOTS.map((slot) => (
                          <option key={slot} value={slot}>
                            {t(SLOT_LABELS[slot])}
                            {slot === item.defaultAppearanceSlot
                              ? ` (${t('web.bot_buttons_slot_default')})`
                              : ''}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <Switch
                        checked={entry.enabled}
                        label={`${t('web.bot_buttons_shown')}: ${label}`}
                        disabled={!editable}
                        onChange={(next) => toggle(index, next)}
                      />
                    </td>
                    <td>
                      {mayEdit && (
                        <div className="btn-group">
                          <button
                            type="button"
                            className="btn sm"
                            aria-label={`${t('web.bot_buttons_move_up')}: ${label}`}
                            disabled={!editable || index === 0}
                            onClick={() => move(index, -1)}
                          >
                            {t('web.bot_buttons_move_up')}
                          </button>
                          <button
                            type="button"
                            className="btn sm"
                            aria-label={`${t('web.bot_buttons_move_down')}: ${label}`}
                            disabled={!editable || index === draft.length - 1}
                            onClick={() => move(index, 1)}
                          >
                            {t('web.bot_buttons_move_down')}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted small">{t('web.bot_buttons_slot_hint')}</p>
        {!valid && <Banner tone="danger">{t('web.bot_buttons_one_required')}</Banner>}
        {dirty && valid && <p className="muted small">{t('web.bot_buttons_unsaved')}</p>}
        {mayEdit && (
          <div className="row">
            <button
              type="button"
              className="btn primary sm"
              disabled={!editable || !valid || !dirty}
              onClick={onSave}
            >
              {save.isPending ? t('web.saving') : t('web.save')}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={!editable}
              onClick={() =>
                setDraft(
                  items.map((item) => ({
                    button: item.id,
                    enabled: true,
                    target: item.target,
                    appearanceSlot: null,
                  })),
                )
              }
            >
              {t('web.bot_buttons_restore_default')}
            </button>
          </div>
        )}
        {save.isError && <ErrorReport error={save.error} />}
        {save.isSuccess && (
          <Banner tone={save.data.changed ? 'ok' : 'info'}>
            {save.data.changed ? t('web.saved') : t('web.unchanged')}
          </Banner>
        )}
      </Card>
      <Card title={t('web.bot_buttons_preview_title')} hint={t('web.bot_buttons_preview_hint')}>
        {preview.length === 0 ? (
          <p className="muted small">{t('web.bot_buttons_preview_empty')}</p>
        ) : (
          <div className="menu-preview" aria-label={t('web.bot_buttons_preview_title')}>
            {preview.map((row) => (
              <div key={row.map((button) => button.id).join(':')} className="menu-preview-row">
                {row.map((button) => (
                  <span key={button.id} className="menu-preview-key">
                    {button.label}
                  </span>
                ))}
              </div>
            ))}
          </div>
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
        <table className="tbl" data-testid="bot-commands">
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
                <td>{entry.description}</td>
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
