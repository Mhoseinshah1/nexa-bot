import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CUSTOM_EMOJI_ID_PATTERN,
  INLINE_BUTTONS,
  INLINE_BUTTON_GROUPS,
  INLINE_BUTTON_STYLES,
  inlineButtonIconOf,
  inlineButtonIconsSchema,
  inlineButtonStyleOf,
  inlineButtonStylesSchema,
  type InlineButtonGroup,
  type InlineButtonIcons,
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
 *
 * Phase 2 Item 3: each button also takes an OPTIONAL premium ICON — a Telegram custom emoji
 * id, the `bot.inline_button_icons` setting (its own key, same endpoint, same version rule).
 * Telegram draws it before the text and only from a bot whose appearance test succeeded; the
 * preview shows a dashed marker, never a fake of the custom emoji. Empty is "no icon".
 */

export const INLINE_BUTTONS_SETTING = 'bot.inline_buttons';

/** The icons' write failed; `stylesSaved` says whether the styles' write of the SAME click landed. */
class InlineSaveError extends Error {
  constructor(
    override readonly cause: unknown,
    readonly stylesSaved: boolean,
  ) {
    super(cause instanceof Error ? cause.message : 'icons not saved');
  }
}
export const INLINE_BUTTON_ICONS_SETTING = 'bot.inline_button_icons';

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
  TERMS: 'web.ib_group_terms',
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
  'payment.nowpayments_open': 'web.ib_button_payment_nowpayments_open',
  'payment.centralpay_open': 'web.ib_button_payment_centralpay_open',
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
  'service.suspend_confirm': 'web.ib_button_service_suspend_confirm',
  'service.resume_confirm': 'web.ib_button_service_resume_confirm',
  'service.toggle_cancel': 'web.ib_button_service_toggle_cancel',
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
  'terms.accept': 'web.ib_button_terms_accept',
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

/**
 * The stored icons, canonical: registry order, and only the buttons with a non-empty id. What
 * the operator typed is trimmed; validity is the contract's (`CUSTOM_EMOJI_ID_PATTERN`) and
 * decided by `invalidIcons`, never silently dropped here.
 */
export function canonicalIcons(icons: InlineButtonIcons): InlineButtonIcons {
  const out: Partial<Record<InlineButtonKey, string>> = {};
  for (const entry of INLINE_BUTTONS) {
    const typed = icons[entry.key];
    const icon = typed === undefined ? undefined : asciiDigits(typed).trim();
    if (icon !== undefined && icon !== '') out[entry.key] = icon;
  }
  return out;
}

/**
 * Persian (۰-۹) and Arabic-Indic (٠-٩) digits as ASCII — what a Persian keyboard types for an
 * id. Telegram's id is ASCII digits; anything else is left as it is for `invalidIcons` to name.
 */
export function asciiDigits(text: string): string {
  return text
    .replace(/[\u06F0-\u06F9]/gu, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660));
}

/** The buttons whose typed icon is not a custom emoji id: the save is refused until fixed. */
export function invalidIcons(icons: InlineButtonIcons): InlineButtonKey[] {
  return Object.entries(canonicalIcons(icons))
    .filter(([, icon]) => !CUSTOM_EMOJI_ID_PATTERN.test(icon))
    .map(([key]) => key as InlineButtonKey);
}

function sameIcons(a: InlineButtonIcons, b: InlineButtonIcons): boolean {
  return JSON.stringify(canonicalIcons(a)) === JSON.stringify(canonicalIcons(b));
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
  // One key per setting, each fingerprinted by ITS command: a retry after one write landed
  // and the other did not replays exactly the write that is still owed (review N1 of #215).
  const submission = useSubmissionKey();
  const iconSubmission = useSubmissionKey();
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings, enabled: !denied });
  const setting = settings.data?.settings.find((one) => one.key === INLINE_BUTTONS_SETTING);
  const iconSetting = settings.data?.settings.find(
    (one) => one.key === INLINE_BUTTON_ICONS_SETTING,
  );
  const stored = useMemo<InlineButtonStyles>(() => {
    const parsed = inlineButtonStylesSchema.safeParse(setting?.value ?? {});
    return parsed.success ? parsed.data : {};
  }, [setting?.value]);
  const storedIcons = useMemo<InlineButtonIcons>(() => {
    const parsed = inlineButtonIconsSchema.safeParse(iconSetting?.value ?? {});
    return parsed.success ? parsed.data : {};
  }, [iconSetting?.value]);
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
    readonly icons: InlineButtonIcons;
    readonly basisVersion: number | null;
    readonly iconsBasisVersion: number | null;
  } | null>(null);
  const [filter, setFilter] = useState('');
  const current = draft?.styles ?? stored;
  const currentIcons = draft?.icons ?? storedIcons;
  const badIcons = invalidIcons(currentIcons);
  /*
   * A stored value this release cannot read (Codex 4170910512) is shown as the defaults, and
   * the row must still be repairable: Save writes what is on screen (the defaults, or the
   * operator's edit) over it, and Reset is offered even with nothing overridden.
   */
  const invalid = setting?.storedValueInvalid === true;
  const iconsInvalid = iconSetting?.storedValueInvalid === true;
  const stylesUnsaved = draft !== null && (invalid || !sameStyles(draft.styles, stored));
  const iconsUnsaved = draft !== null && (iconsInvalid || !sameIcons(draft.icons, storedIcons));
  const unsaved = stylesUnsaved || iconsUnsaved;
  const changedElsewhere =
    draft !== null &&
    ((setting !== undefined && setting.version !== draft.basisVersion) ||
      (iconSetting !== undefined && iconSetting.version !== draft.iconsBasisVersion));
  const overridden = Object.keys(canonicalStyles(current)).length;
  const iconCount = Object.keys(canonicalIcons(currentIcons)).length;
  const basisVersion = setting?.version ?? null;
  const iconsBasisVersion = iconSetting?.version ?? null;
  const editBoth = (styles: InlineButtonStyles, icons: InlineButtonIcons) =>
    setDraft((before) => ({
      styles,
      icons,
      basisVersion: before === null ? basisVersion : before.basisVersion,
      iconsBasisVersion: before === null ? iconsBasisVersion : before.iconsBasisVersion,
    }));
  const edit = (styles: InlineButtonStyles) => editBoth(styles, currentIcons);
  const editIcon = (key: InlineButtonKey, icon: string) => {
    const next: Partial<Record<InlineButtonKey, string>> = { ...currentIcons };
    const typed = asciiDigits(icon);
    if (typed === '') delete next[key];
    else next[key] = typed;
    editBoth(current, next);
  };
  // Codex 4170910519: a leave (sidebar, back, reload, close) asks before dropping an edit.
  useUnsavedChanges(mayEdit && unsaved);

  /*
   * Two settings, two writes, each with its OWN version and its OWN idempotency key. Only
   * what changed is written: an edit of a style alone is still ONE settings write, exactly as
   * before Item 3. When the styles land and the icons do not, the draft adopts the styles'
   * new version at once — so the next click sends only the icons, and no "changed elsewhere"
   * is claimed for a change this page made — and the operator is told exactly that.
   */
  const save = useMutation({
    mutationFn: async (command: {
      styles: {
        value: InlineButtonStyles;
        expectedVersion: number | null;
        idempotencyKey: string;
      } | null;
      icons: {
        value: InlineButtonIcons;
        expectedVersion: number | null;
        idempotencyKey: string;
      } | null;
    }) => {
      let changed = false;
      let stylesSaved = false;
      if (command.styles !== null) {
        const result = await saveSetting({ key: INLINE_BUTTONS_SETTING, ...command.styles });
        submission.settle();
        stylesSaved = true;
        changed ||= result.changed;
        setDraft((before) =>
          before === null ? before : { ...before, basisVersion: result.setting.version },
        );
      }
      if (command.icons !== null) {
        try {
          const result = await saveSetting({ key: INLINE_BUTTON_ICONS_SETTING, ...command.icons });
          changed ||= result.changed;
        } catch (error) {
          throw new InlineSaveError(error, stylesSaved);
        }
      }
      return { changed };
    },
    onSuccess: async (result) => {
      submission.settle();
      iconSubmission.settle();
      setDraft(null);
      notify({
        tone: result.changed ? 'ok' : 'info',
        message: t(result.changed ? 'web.ib_saved' : 'web.ib_unchanged'),
      });
      await client.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error: unknown) => {
      if (error instanceof InlineSaveError) {
        iconSubmission.settleOn(error.cause);
        notify({
          tone: 'danger',
          message: t(error.stylesSaved ? 'web.ib_icons_failed_styles_saved' : 'web.ib_failed'),
        });
      } else {
        submission.settleOn(error);
        notify({ tone: 'danger', message: t('web.ib_failed') });
      }
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
        {iconsInvalid && <Banner tone="warn">{t('web.ib_icons_stored_invalid')}</Banner>}
        <p className="muted small" data-testid="ib-icon-limits">
          {t('web.ib_icon_limits')}
        </p>
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
          <span className="muted small" data-testid="ib-icon-count">
            {fill(t('web.ib_icon_count'), { n: iconCount })}
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
                  const typedIcon = currentIcons[entry.key] ?? '';
                  const icon = inlineButtonIconOf(entry.key, canonicalIcons(currentIcons));
                  const iconBad = badIcons.includes(entry.key);
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
                          {icon !== null && !iconBad && (
                            <span
                              className="bb-icon-mark"
                              title={t('web.ib_icon_mark_title')}
                              aria-hidden="true"
                              data-testid="ib-icon-mark"
                            >
                              ✦
                            </span>
                          )}
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
                      <div className="ib-icon" data-testid="ib-icon">
                        <label className="muted small" htmlFor={`ib-icon-${entry.key}`}>
                          {t('web.ib_icon')}{' '}
                          <span className="muted small">{t('web.bb_optional')}</span>
                        </label>
                        <input
                          id={`ib-icon-${entry.key}`}
                          type="text"
                          inputMode="numeric"
                          dir="ltr"
                          autoComplete="off"
                          spellCheck={false}
                          maxLength={64}
                          className="input sm mono"
                          value={typedIcon}
                          placeholder={t('web.ib_icon_placeholder')}
                          disabled={!mayEdit || save.isPending}
                          aria-invalid={iconBad}
                          aria-label={`${t('web.ib_icon')} — ${name}`}
                          onChange={(event) => editIcon(entry.key, event.target.value)}
                        />
                        {typedIcon !== '' && mayEdit && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={save.isPending}
                            aria-label={`${t('web.ib_icon_remove')} — ${name}`}
                            onClick={() => editIcon(entry.key, '')}
                          >
                            {t('web.ib_icon_remove')}
                          </Button>
                        )}
                        {typedIcon === '' && (
                          <span className="muted small">{t('web.ib_icon_none')}</span>
                        )}
                        {iconBad && (
                          <span className="small ib-icon-error" role="alert">
                            {t('web.ib_icon_invalid')}
                          </span>
                        )}
                      </div>
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
              disabled={
                save.isPending || (overridden === 0 && iconCount === 0 && !invalid && !iconsInvalid)
              }
              onClick={() => editBoth({}, {})}
            >
              {t('web.ib_reset')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={
                !(unsaved || invalid || iconsInvalid) ||
                badIcons.length > 0 ||
                save.isPending ||
                setting === undefined
              }
              onClick={() => {
                // Snapshotted at the click, so a retry cannot carry a later edit; each version
                // is the one the DRAFT was edited from, never a later read's.
                const styles =
                  stylesUnsaved || invalid
                    ? {
                        value: canonicalStyles(current),
                        expectedVersion: draft === null ? basisVersion : draft.basisVersion,
                      }
                    : null;
                const icons =
                  iconsUnsaved || iconsInvalid
                    ? {
                        value: canonicalIcons(currentIcons),
                        expectedVersion:
                          draft === null ? iconsBasisVersion : draft.iconsBasisVersion,
                      }
                    : null;
                save.mutate({
                  styles:
                    styles === null
                      ? null
                      : { ...styles, idempotencyKey: submission.current(styles) },
                  icons:
                    icons === null
                      ? null
                      : { ...icons, idempotencyKey: iconSubmission.current(icons) },
                });
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
