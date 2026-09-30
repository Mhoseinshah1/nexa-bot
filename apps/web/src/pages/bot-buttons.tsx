import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_MAIN_MENU_LAYOUT,
  mainMenuButton,
  mainMenuLayoutSchema,
  packMainMenuRows,
  resolveMainMenuLayout,
  type BotMenuButton,
  type FeatureFlagResponse,
  type MainMenuLayoutEntry,
  type ResolvedSettingResponse,
  type TemplateViewResponse,
} from '@nexa/contracts';
import {
  fetchFeatureFlags,
  fetchSettings,
  fetchTemplates,
  fetchTrialPanels,
  saveSetting,
} from '../api/client';
import { t, type WebKey } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import { templateCopy } from '../template-copy';
import { Badge, Banner, Card, PageHead, StateSwitch, Switch } from '../ui/kit';
import { TemplateCard } from './content';
import { ErrorReport } from './settings';

const SETTING_KEY = 'bot.main_menu';

/** The sentence under a feature-gated button, keyed by the contract's own flag union. */
const FEATURE_NOTES: Readonly<Record<NonNullable<BotMenuButton['feature']>, WebKey>> = {
  referrals: 'web.bot_buttons_needs_referrals',
};

/**
 * R1: «دکمه‌های ربات» — the customer main menu, as an operator manages it.
 *
 * Three things, each stored where it already lives and read back from there, so this page
 * holds no second copy of anything:
 *
 * - the ORDER and the ON/OFF of each button: the registry setting `bot.main_menu`, saved
 *   whole with the version it was read at (a colleague's change in between is a conflict,
 *   not an overwrite) and validated by the server against `mainMenuLayoutSchema`;
 * - the LABEL of each button: its `bot.menu.*` template, edited with the texts screen's own
 *   card — the bot draws the keyboard from the tenant's text AND routes a tap by it;
 * - whether a feature-gated button can appear at all: its feature flag, shown here and
 *   switched on the Features page — or, for the trial button (F5), whether any panel
 *   offers a trial now, from the Trials overview and switched on each panel's own tab.
 *
 * The preview packs the draft with the contract's own layout rule (`packMainMenuRows`), so
 * it is the keyboard the bot will draw, not a picture of one.
 */
export function BotButtonsPage({
  mayEdit,
  denied,
  mayViewTemplates,
  mayEditTemplates,
  mayViewPanels = false,
}: {
  mayEdit: boolean;
  denied: boolean;
  mayViewTemplates: boolean;
  mayEditTemplates: boolean;
  /** F5: `panels.view`, which the trial overview — "does any panel offer a trial" — needs. */
  mayViewPanels?: boolean;
}) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings, enabled: !denied });
  const flags = useQuery({ queryKey: ['features'], queryFn: fetchFeatureFlags, enabled: !denied });
  const trialPanels = useQuery({
    queryKey: ['trial-panels'],
    queryFn: fetchTrialPanels,
    enabled: !denied && mayViewPanels,
  });
  /*
   * Whether the trial button would be drawn now: known only from a successful read of the
   * overview, which asks the evaluator the bot asks. Unknown (no permission, not loaded,
   * refused) says nothing rather than guessing either way.
   */
  const trialOffered =
    trialPanels.data === undefined
      ? null
      : trialPanels.data.panels.some((panel) => panel.offeredNow);
  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: fetchTemplates,
    enabled: !denied && mayViewTemplates,
  });
  const setting = settings.data?.settings.find((one) => one.key === SETTING_KEY);
  const menuTemplates = (templates.data?.templates ?? []).filter((one) =>
    one.key.startsWith('bot.menu.'),
  );

  return (
    <>
      <PageHead title={t('web.bot_buttons_title')} subtitle={t('web.bot_buttons_intro')} />
      <StateSwitch query={settings} denied={denied} isEmpty={false}>
        {setting !== undefined && (
          <LayoutCard
            // Re-seeded from the server whenever the stored value moves on.
            key={String(setting.version ?? 0)}
            setting={setting}
            flags={flags.data?.flags ?? []}
            trialOffered={trialOffered}
            labels={menuTemplates}
            mayEdit={mayEdit}
          />
        )}
      </StateSwitch>
      <Card title={t('web.bot_buttons_labels_title')} hint={t('web.bot_buttons_labels_hint')}>
        {!mayViewTemplates ? (
          <Banner tone="info">{t('web.bot_buttons_labels_denied')}</Banner>
        ) : (
          <StateSwitch query={templates}>
            {DEFAULT_MAIN_MENU_LAYOUT.map((entry) => {
              const button = mainMenuButton(entry.button);
              const template = menuTemplates.find((one) => one.key === button.label);
              if (template === undefined) return null;
              return (
                <details key={button.id}>
                  <summary>{labelOf(button, menuTemplates)}</summary>
                  {duplicated(button, menuTemplates) && (
                    <Banner tone="warn">{t('web.bot_buttons_label_duplicate')}</Banner>
                  )}
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
function labelOf(button: BotMenuButton, labels: readonly TemplateViewResponse[]): string {
  const template = labels.find((one) => one.key === button.label);
  return template?.body ?? templateCopy(button.label, '').name;
}

/** Whether another button shows the same text — the bot could then reach only one of them. */
function duplicated(button: BotMenuButton, labels: readonly TemplateViewResponse[]): boolean {
  const mine = labels.find((one) => one.key === button.label)?.body.trim();
  if (mine === undefined || mine === '') return false;
  return labels.some(
    (other) =>
      other.key !== button.label &&
      other.key !== 'bot.menu.admin' &&
      other.key !== 'bot.menu.main_button' &&
      other.body.trim() === mine,
  );
}

function storedLayout(setting: ResolvedSettingResponse): readonly MainMenuLayoutEntry[] {
  const parsed = mainMenuLayoutSchema.safeParse(setting.value);
  return resolveMainMenuLayout(parsed.success ? parsed.data : DEFAULT_MAIN_MENU_LAYOUT);
}

function LayoutCard({
  setting,
  flags,
  trialOffered,
  labels,
  mayEdit,
}: {
  setting: ResolvedSettingResponse;
  flags: readonly FeatureFlagResponse[];
  /** Whether any panel offers a trial now; null when the page cannot know. */
  trialOffered: boolean | null;
  labels: readonly TemplateViewResponse[];
  mayEdit: boolean;
}) {
  const client = useQueryClient();
  const submission = useSubmissionKey();
  const [draft, setDraft] = useState<readonly MainMenuLayoutEntry[]>(() => storedLayout(setting));
  const flagOn = (button: BotMenuButton) =>
    button.feature === null || flags.find((flag) => flag.key === button.feature)?.enabled === true;
  // The preview leaves the trial button out only when the page KNOWS no panel offers one.
  const shown = (button: BotMenuButton) =>
    flagOn(button) && !(button.needsTrialOffer && trialOffered === false);

  const save = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      value: readonly MainMenuLayoutEntry[];
      expectedVersion: number | null;
    }) => saveSetting({ key: SETTING_KEY, ...command }),
    onSuccess: async () => {
      submission.settle();
      await client.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
    },
  });

  const valid = mainMenuLayoutSchema.safeParse(draft).success;
  const dirty = JSON.stringify(draft) !== JSON.stringify(storedLayout(setting));
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

  const onSave = () => {
    if (!valid) return;
    const command = { value: draft, expectedVersion: setting.version };
    save.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  const preview = packMainMenuRows(
    draft
      .filter((entry) => entry.enabled)
      .map((entry) => mainMenuButton(entry.button))
      .filter(shown),
  );

  return (
    <>
      <Card title={t('web.bot_buttons_order_title')} hint={t('web.bot_buttons_order_hint')}>
        {setting.storedValueInvalid && (
          <Banner tone="danger">{t('web.bot_buttons_stored_invalid')}</Banner>
        )}
        <div className="tbl-wrap">
          <table className="tbl">
            <caption className="visually-hidden">{t('web.bot_buttons_order_title')}</caption>
            <thead>
              <tr>
                <th>{t('web.bot_buttons_position')}</th>
                <th>{t('web.bot_buttons_button')}</th>
                <th>{t('web.bot_buttons_shown')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {draft.map((entry, index) => {
                const button = mainMenuButton(entry.button);
                const label = labelOf(button, labels);
                return (
                  <tr key={button.id} data-button={button.id}>
                    <td>{String(index + 1)}</td>
                    <td>
                      <span className="strong">{label}</span>
                      {button.feature !== null && (
                        <p className="muted small">
                          {t(FEATURE_NOTES[button.feature])}{' '}
                          {!flagOn(button) && (
                            <Badge tone="warn">{t('web.bot_buttons_feature_off')}</Badge>
                          )}
                        </p>
                      )}
                      {button.needsTrialOffer && (
                        <p className="muted small">
                          {t('web.bot_buttons_needs_trial_offer')}{' '}
                          {trialOffered === false && (
                            <Badge tone="warn">{t('web.bot_buttons_trial_not_offered')}</Badge>
                          )}
                        </p>
                      )}
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
              onClick={() => setDraft(resolveMainMenuLayout(DEFAULT_MAIN_MENU_LAYOUT))}
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
                    {labelOf(button, labels)}
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
