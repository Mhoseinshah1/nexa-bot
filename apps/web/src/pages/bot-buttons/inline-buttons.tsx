import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  INLINE_BUTTONS,
  INLINE_BUTTON_GROUPS,
  INLINE_BUTTON_STYLES,
  inlineButtonStyleOf,
  inlineButtonStylesSchema,
  type InlineButtonGroup,
  type InlineButtonKey,
  type InlineButtonStyle,
  type InlineButtonStyles,
  type TemplateViewResponse,
} from '@nexa/contracts';
import { fetchSettings, saveSetting } from '../../api/client';
import { t, type WebKey } from '../../i18n/web.fa';
import { useSubmissionKey } from '../../submission-key';
import {
  Badge,
  Banner,
  Button,
  Card,
  Disclosure,
  StateSwitch,
  useToast,
  useUnsavedChanges,
} from '../../ui/kit';
import { TemplateCard } from '../content';
import { ErrorReport } from '../settings';
import { fill } from './canvas';

/**
 * Owner spec §6: «دکمه‌های شیشه‌ای ربات» — every customer INLINE button, from the registry
 * (`INLINE_BUTTONS`), with its label and its style.
 *
 * Two existing mechanisms, no third: the LABEL is the button's template, edited with the
 * texts screen's own card (versioned, audited, `templates.edit`); the STYLE is the
 * `bot.inline_buttons` setting, saved through the settings endpoint (versioned, audited,
 * `settings.edit`) with the version this page read. Nothing here can change what a button
 * DOES: its route is the bot's code, and the registry key is never shown as a choice.
 *
 * Separate from «متن دکمه‌ها» below it, which is the REPLY keyboard (the main menu), whose
 * labels are its routes.
 */

export const INLINE_BUTTONS_SETTING = 'bot.inline_buttons';

const GROUP_TITLE: Readonly<Record<InlineButtonGroup, WebKey>> = {
  NAVIGATION: 'web.ib_group_navigation',
  WALLET: 'web.ib_group_wallet',
  PURCHASE: 'web.ib_group_purchase',
  PAYMENT: 'web.ib_group_payment',
  SERVICES: 'web.ib_group_services',
  SERVICE_ACTIONS: 'web.ib_group_service_actions',
  SUPPORT: 'web.ib_group_support',
  REFERRAL: 'web.ib_group_referral',
  APPS: 'web.ib_group_apps',
  CHANNELS: 'web.ib_group_channels',
};

/** The four styles Telegram accepts, by their builder names. */
const STYLE_NAME: Readonly<Record<InlineButtonStyle, WebKey>> = {
  default: 'web.bb_style_default',
  primary: 'web.bb_style_primary',
  success: 'web.bb_style_success',
  danger: 'web.bb_style_danger',
};

/** The Persian name of each registry button: where the customer meets it. */
export const INLINE_BUTTON_NAME: Readonly<Record<InlineButtonKey, WebKey>> = {
  main_menu: 'web.ib_button_main_menu',
  'list.close': 'web.ib_button_list_close',
  'wallet.open': 'web.ib_button_wallet_open',
  'wallet.topup': 'web.ib_button_wallet_topup',
  'wallet.topup_amount': 'web.ib_button_wallet_topup_amount',
  'catalog.open': 'web.ib_button_catalog_open',
  'catalog.category': 'web.ib_button_catalog_category',
  'catalog.product': 'web.ib_button_catalog_product',
  'catalog.previous_page': 'web.ib_button_catalog_previous_page',
  'catalog.next_page': 'web.ib_button_catalog_next_page',
  'catalog.back_to_categories': 'web.ib_button_catalog_back_to_categories',
  'catalog.custom_service': 'web.ib_button_catalog_custom_service',
  'custom_service.location': 'web.ib_button_custom_service_location',
  'trial.panel': 'web.ib_button_trial_panel',
  'username.custom': 'web.ib_button_username_custom',
  'username.automatic': 'web.ib_button_username_automatic',
  'discount.enter': 'web.ib_button_discount_enter',
  'discount.remove': 'web.ib_button_discount_remove',
  'order.cancel': 'web.ib_button_order_cancel',
  'order.cancel_confirm': 'web.ib_button_order_cancel_confirm',
  'payment.wallet': 'web.ib_button_payment_wallet',
  'payment.methods': 'web.ib_button_payment_methods',
  'payment.route': 'web.ib_button_payment_route',
  'payment.route_gift': 'web.ib_button_payment_route_gift',
  'payment.copy_card': 'web.ib_button_payment_copy_card',
  'payment.copy_amount': 'web.ib_button_payment_copy_amount',
  'payment.sent': 'web.ib_button_payment_sent',
  'payment.cancel': 'web.ib_button_payment_cancel',
  'payment.cancel_confirm': 'web.ib_button_payment_cancel_confirm',
  'payment.gateway_pay': 'web.ib_button_payment_gateway_pay',
  'payment.gateway_check': 'web.ib_button_payment_gateway_check',
  'payment.gateway_card_check': 'web.ib_button_payment_gateway_card_check',
  'payment.gateway_receipt': 'web.ib_button_payment_gateway_receipt',
  'payment.gateway_change_card': 'web.ib_button_payment_gateway_change_card',
  'services.item': 'web.ib_button_services_item',
  'services.search_label': 'web.ib_button_services_search_label',
  'services.search': 'web.ib_button_services_search',
  'services.previous_page': 'web.ib_button_services_previous_page',
  'services.page': 'web.ib_button_services_page',
  'services.next_page': 'web.ib_button_services_next_page',
  'services.back_to_menu': 'web.ib_button_services_back_to_menu',
  'service.back_to_list': 'web.ib_button_service_back_to_list',
  'service.back_to_card': 'web.ib_button_service_back_to_card',
  'service.renewed_details': 'web.ib_button_service_renewed_details',
  'service.transfer_details': 'web.ib_button_service_transfer_details',
  'service.tutorial': 'web.ib_button_service_tutorial',
  'service.connected': 'web.ib_button_service_connected',
  'service.problem': 'web.ib_button_service_problem',
  'service.refresh': 'web.ib_button_service_refresh',
  'service.files': 'web.ib_button_service_files',
  'service.link': 'web.ib_button_service_link',
  'service.rotate': 'web.ib_button_service_rotate',
  'service.rotate_confirm': 'web.ib_button_service_rotate_confirm',
  'service.note': 'web.ib_button_service_note',
  'service.renew': 'web.ib_button_service_renew',
  'service.renew_option': 'web.ib_button_service_renew_option',
  'service.add_traffic': 'web.ib_button_service_add_traffic',
  'service.addon_option': 'web.ib_button_service_addon_option',
  'service.add_devices': 'web.ib_button_service_add_devices',
  'service.devices_option': 'web.ib_button_service_devices_option',
  'service.change_location': 'web.ib_button_service_change_location',
  'service.location_option': 'web.ib_button_service_location_option',
  'service.location_option_free': 'web.ib_button_service_location_option_free',
  'service.location_confirm': 'web.ib_button_service_location_confirm',
  'service.suspend': 'web.ib_button_service_suspend',
  'service.resume': 'web.ib_button_service_resume',
  'service.refund_request': 'web.ib_button_service_refund_request',
  'service.refund_request_confirm': 'web.ib_button_service_refund_request_confirm',
  'service.transfer': 'web.ib_button_service_transfer',
  'service.transfer_confirm': 'web.ib_button_service_transfer_confirm',
  'support.tickets': 'web.ib_button_support_tickets',
  'support.contact': 'web.ib_button_support_contact',
  'tickets.item': 'web.ib_button_tickets_item',
  'tickets.new': 'web.ib_button_tickets_new',
  'tickets.category': 'web.ib_button_tickets_category',
  'tickets.view': 'web.ib_button_tickets_view',
  'tickets.reply': 'web.ib_button_tickets_reply',
  'tickets.close': 'web.ib_button_tickets_close',
  'tickets.close_confirm': 'web.ib_button_tickets_close_confirm',
  'tickets.back': 'web.ib_button_tickets_back',
  'marketing.opt_out': 'web.ib_button_marketing_opt_out',
  'marketing.opt_in': 'web.ib_button_marketing_opt_in',
  'referral.share': 'web.ib_button_referral_share',
  'referral.gift': 'web.ib_button_referral_gift',
  'apps.platform_android': 'web.ib_button_apps_platform_android',
  'apps.platform_ios': 'web.ib_button_apps_platform_ios',
  'apps.platform_windows': 'web.ib_button_apps_platform_windows',
  'apps.platform_macos': 'web.ib_button_apps_platform_macos',
  'apps.platform_linux': 'web.ib_button_apps_platform_linux',
  'apps.platform_other': 'web.ib_button_apps_platform_other',
  'apps.app': 'web.ib_button_apps_app',
  'apps.download': 'web.ib_button_apps_download',
  'apps.alternative': 'web.ib_button_apps_alternative',
  'apps.help': 'web.ib_button_apps_help',
  'apps.services': 'web.ib_button_apps_services',
  'apps.back': 'web.ib_button_apps_back',
  'apps.platforms': 'web.ib_button_apps_platforms',
  'channels.join_public': 'web.ib_button_channels_join_public',
  'channels.join_private': 'web.ib_button_channels_join_private',
  'channels.check': 'web.ib_button_channels_check',
};

/** The stored value, canonical: only the buttons whose style is not their default. */
export function canonicalStyles(styles: InlineButtonStyles): InlineButtonStyles {
  const out: Partial<Record<InlineButtonKey, InlineButtonStyle>> = {};
  for (const entry of INLINE_BUTTONS) {
    const style = styles[entry.key];
    if (style !== undefined && style !== entry.defaultStyle) out[entry.key] = style;
  }
  return out;
}

function sameStyles(a: InlineButtonStyles, b: InlineButtonStyles): boolean {
  return JSON.stringify(canonicalStyles(a)) === JSON.stringify(canonicalStyles(b));
}

export function InlineButtonsSection({
  mayEdit,
  denied,
  mayViewTemplates,
  mayEditTemplates,
  templates,
  onLabelChanged,
}: {
  /** `settings.edit`: the styles. */
  mayEdit: boolean;
  /** No `settings.view`: the section is not drawn at all. */
  denied: boolean;
  mayViewTemplates: boolean;
  mayEditTemplates: boolean;
  /** The page's own template read; this section asks for nothing a second time. */
  templates: readonly TemplateViewResponse[] | undefined;
  onLabelChanged: () => Promise<unknown> | void;
}) {
  const client = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings, enabled: !denied });
  const setting = settings.data?.settings.find((one) => one.key === INLINE_BUTTONS_SETTING);
  const stored = useMemo<InlineButtonStyles>(() => {
    const parsed = inlineButtonStylesSchema.safeParse(setting?.value ?? {});
    return parsed.success ? parsed.data : {};
  }, [setting?.value]);
  /*
   * The draft carries the VERSION it was edited from (Codex 4170910503). A refetch after a
   * local edit advances `setting.version` while the draft is still the older copy; saving
   * with the fresh version would send stale values under a version that says they are
   * current, and silently revert another administrator's change. So a save always states
   * the draft's own basis, a conflict is the server's answer, and fresh values are adopted
   * only when the operator asks for them.
   */
  const [draft, setDraft] = useState<{
    readonly styles: InlineButtonStyles;
    readonly basisVersion: number | null;
  } | null>(null);
  const [filter, setFilter] = useState('');
  const current = draft?.styles ?? stored;
  /*
   * A stored value this release cannot read (Codex 4170910512) is shown as the defaults, and
   * the row must still be repairable: Save writes what is on screen (the defaults, or the
   * operator's edit) over it, and Reset is offered even with nothing overridden.
   */
  const invalid = setting?.storedValueInvalid === true;
  const unsaved = draft !== null && (invalid || !sameStyles(draft.styles, stored));
  const changedElsewhere =
    draft !== null && setting !== undefined && setting.version !== draft.basisVersion;
  const overridden = Object.keys(canonicalStyles(current)).length;
  const basisVersion = setting?.version ?? null;
  const edit = (styles: InlineButtonStyles) =>
    setDraft((before) => ({ styles, basisVersion: before?.basisVersion ?? basisVersion }));
  // Codex 4170910519: a leave (sidebar, back, reload, close) asks before dropping an edit.
  useUnsavedChanges(mayEdit && unsaved);

  const save = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      value: InlineButtonStyles;
      expectedVersion: number | null;
    }) => saveSetting({ key: INLINE_BUTTONS_SETTING, ...command }),
    onSuccess: async (result) => {
      submission.settle();
      setDraft(null);
      notify({
        tone: result.changed ? 'ok' : 'info',
        message: t(result.changed ? 'web.ib_saved' : 'web.ib_unchanged'),
      });
      await client.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      notify({ tone: 'danger', message: t('web.ib_failed') });
      void client.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const templateOf = (key: string | null) =>
    key === null ? undefined : templates?.find((one) => one.key === key);
  const needle = filter.trim();
  const matches = (entry: (typeof INLINE_BUTTONS)[number]) => {
    if (needle === '') return true;
    const label = templateOf(entry.label)?.body ?? '';
    return t(INLINE_BUTTON_NAME[entry.key]).includes(needle) || label.includes(needle);
  };

  return (
    <Card title={t('web.ib_title')} hint={t('web.ib_hint')} id="inline-buttons">
      <StateSwitch query={settings} denied={denied} isEmpty={false}>
        {setting?.storedValueInvalid === true && (
          <Banner tone="warn">{t('web.ib_stored_invalid')}</Banner>
        )}
        {!mayEdit && <Banner tone="info">{t('web.ib_denied_edit')}</Banner>}
        {!mayViewTemplates && <Banner tone="info">{t('web.ib_labels_denied')}</Banner>}
        <div className="ib-toolbar">
          <label className="ib-filter">
            <span className="visually-hidden">{t('web.ib_filter')}</span>
            <input
              type="search"
              className="input sm"
              value={filter}
              placeholder={t('web.ib_filter_placeholder')}
              aria-label={t('web.ib_filter')}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <span className="muted small" data-testid="ib-overridden">
            {fill(t('web.ib_changed_count'), { n: overridden })}
          </span>
        </div>
        {INLINE_BUTTON_GROUPS.map((group) => {
          const entries = INLINE_BUTTONS.filter((entry) => entry.group === group && matches(entry));
          if (entries.length === 0) return null;
          return (
            <section key={group} className="ib-group" aria-label={t(GROUP_TITLE[group])}>
              <h3 className="small">{t(GROUP_TITLE[group])}</h3>
              <ul className="ib-list">
                {entries.map((entry) => {
                  const style = inlineButtonStyleOf(entry.key, current);
                  const template = templateOf(entry.label);
                  const name = t(INLINE_BUTTON_NAME[entry.key]);
                  return (
                    <li key={entry.key} className="ib-row" data-inline-button={entry.key}>
                      <div className="ib-head">
                        <span className="ib-name">{name}</span>
                        {entry.action !== 'CALLBACK' && (
                          <Badge tone="neutral">
                            {t(entry.action === 'URL' ? 'web.ib_link' : 'web.ib_copy')}
                          </Badge>
                        )}
                        <span
                          className={`menu-preview-key ib-preview bb-style-${style}`}
                          data-testid="ib-preview"
                        >
                          {template?.body ?? name}
                        </span>
                      </div>
                      <label className="ib-style">
                        <span className="muted small">{t('web.ib_style')}</span>
                        <select
                          className="input sm"
                          value={style}
                          disabled={!mayEdit || save.isPending}
                          aria-label={`${t('web.ib_style')} — ${name}`}
                          onChange={(event) =>
                            edit({
                              ...current,
                              [entry.key]: event.target.value as InlineButtonStyle,
                            })
                          }
                        >
                          {INLINE_BUTTON_STYLES.map((option) => (
                            <option key={option} value={option}>
                              {t(STYLE_NAME[option])}
                            </option>
                          ))}
                        </select>
                      </label>
                      {entry.label === null ? (
                        <p className="muted small ib-note">{t('web.ib_data_label')}</p>
                      ) : (
                        mayViewTemplates &&
                        template !== undefined && (
                          <LabelEditor
                            template={template}
                            shared={entry.label.startsWith('bot.menu.')}
                            mayEdit={mayEditTemplates}
                            onChanged={onLabelChanged}
                          />
                        )
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {INLINE_BUTTONS.every((entry) => !matches(entry)) && (
          <p className="muted">{t('web.ib_none_found')}</p>
        )}
        {save.isError && <ErrorReport error={save.error} />}
        {mayEdit && changedElsewhere && (
          <Banner tone="warn">
            {t('web.ib_changed_elsewhere')}{' '}
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              {t('web.ib_reload')}
            </Button>
          </Banner>
        )}
        {mayEdit && (
          <div className="ib-actions">
            {unsaved && <span className="muted small">{t('web.ib_unsaved')}</span>}
            <Button
              variant="ghost"
              size="sm"
              disabled={save.isPending || (overridden === 0 && !invalid)}
              onClick={() => edit({})}
            >
              {t('web.ib_reset')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!(unsaved || invalid) || save.isPending || setting === undefined}
              onClick={() => {
                // Snapshotted at the click, so a retry cannot carry a later edit; the version
                // is the one the DRAFT was edited from, never a later read's.
                const command = {
                  value: canonicalStyles(current),
                  expectedVersion: draft === null ? basisVersion : draft.basisVersion,
                };
                save.mutate({ ...command, idempotencyKey: submission.current(command) });
              }}
            >
              {t('web.ib_save')}
            </Button>
          </div>
        )}
      </StateSwitch>
    </Card>
  );
}

/**
 * One button's label card, mounted only once its disclosure is opened: a hundred template
 * cards (each with its own form state) on one screen would make the whole page slow for a
 * change somebody makes to one label at a time.
 */
function LabelEditor({
  template,
  shared,
  mayEdit,
  onChanged,
}: {
  template: TemplateViewResponse;
  shared: boolean;
  mayEdit: boolean;
  onChanged: () => Promise<unknown> | void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Disclosure summary={t('web.ib_edit_label')} size="sm" onToggle={setOpen}>
      {open && (
        <>
          {shared && <Banner tone="warn">{t('web.ib_shared_label')}</Banner>}
          <TemplateCard template={template} mayEdit={mayEdit} onChanged={onChanged} />
        </>
      )}
    </Disclosure>
  );
}
