import { useId, useState } from 'react';
import {
  APPEARANCE_SLOTS,
  APPEARANCE_SLOT_FALLBACKS,
  MAIN_MENU_BUTTON_STYLES,
  type AppearanceSlot,
  type AppearanceSlotView,
  type ExplicitMainMenu,
  type MainMenuBuilderItem,
  type MainMenuButtonId,
  type MainMenuButtonStyle,
  type MainMenuGate,
  type MainMenuIconEligibility,
} from '@nexa/contracts';
import { APPEARANCE_SLOT_LABEL } from '../../appearance-labels';
import { t, type WebKey } from '../../i18n/web.fa';
import { Badge, Banner, Disclosure, Ltr, Switch } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { fill, labelOf } from './canvas';
import {
  configOf,
  lookOf,
  moveEarlier,
  moveLater,
  moveRow,
  moveToNextRow,
  moveToOwnRow,
  moveToPreviousRow,
  movesFor,
  placeAtRowEnd,
  placeInNewRow,
  positionOf,
  removeToPool,
  setEnabled,
  setIconSlot,
  setStyle,
  startsWithEmoji,
} from './model';

/** The Persian name of each style. Exactly the contract's four; no custom colour exists. */
export const STYLE_LABEL: Readonly<Record<MainMenuButtonStyle, WebKey>> = {
  default: 'web.bb_style_default',
  primary: 'web.bb_style_primary',
  success: 'web.bb_style_success',
  danger: 'web.bb_style_danger',
};

/** Why a gated button may be hidden, by the gate the server names. */
const GATE_NOTE: Readonly<Record<MainMenuGate, WebKey>> = {
  FEATURE: 'web.bot_buttons_needs_referrals',
  TRIAL_OFFER: 'web.bot_buttons_needs_trial_offer',
};
const GATE_CLOSED: Readonly<Record<MainMenuGate, WebKey>> = {
  FEATURE: 'web.bot_buttons_feature_off',
  TRIAL_OFFER: 'web.bot_buttons_trial_not_offered',
};

type Op = (layout: ExplicitMainMenu) => ExplicitMainMenu;

export function Inspector({
  layout,
  id,
  item,
  editable,
  iconEligibility,
  appearanceSlots,
  mayViewTemplates,
  onMove,
  onChange,
  onEditLabel,
}: {
  layout: ExplicitMainMenu;
  id: MainMenuButtonId | null;
  item: MainMenuBuilderItem | undefined;
  editable: boolean;
  /** Which bots may carry the icon (their appearance test answered `SENT`) — the server's. */
  iconEligibility: readonly MainMenuIconEligibility[];
  /** The tenant's appearance slots, when readable — which slots carry a custom emoji. */
  appearanceSlots: readonly AppearanceSlotView[] | null;
  mayViewTemplates: boolean;
  /** A placement change: announced with the button's new position. */
  onMove: (id: MainMenuButtonId, op: Op) => void;
  /** A configuration change: announced with what changed. */
  onChange: (op: Op, announcement: string) => void;
  onEditLabel: (id: MainMenuButtonId) => void;
}) {
  const base = useId();
  const [targetRow, setTargetRow] = useState<string>('new');
  if (id === null) {
    return (
      <section className="bb-inspector" aria-labelledby={`${base}-title`}>
        <h3 id={`${base}-title`} className="bb-pane-title">
          {t('web.bb_inspector_title')}
        </h3>
        <p className="muted small">{t('web.bb_inspector_empty')}</p>
      </section>
    );
  }
  const config = configOf(layout, id);
  const label = labelOf(id, item);
  const at = positionOf(layout, id);
  const moves = movesFor(layout, id);
  const rowCount = layout.rows.length;
  const chosenRow = targetRow === 'new' || Number(targetRow) < rowCount ? targetRow : 'new';
  const eligibleBots = iconEligibility.filter((bot) => bot.eligible);
  const slotView =
    config.iconSlot === null
      ? undefined
      : appearanceSlots?.find((slot) => slot.slot === config.iconSlot);
  const moveButton = (
    key: WebKey,
    icon: 'arrowUp' | 'arrowDown' | 'chevronRight' | 'chevronLeft' | 'plus',
    enabled: boolean,
    op: Op,
  ) => (
    <button
      type="button"
      className="btn sm"
      disabled={!editable || !enabled}
      onClick={() => onMove(id, op)}
      data-move={key}
    >
      <Icon name={icon} />
      {t(key)}
    </button>
  );

  return (
    <section className="bb-inspector" aria-labelledby={`${base}-title`} data-testid="bb-inspector">
      <h3 id={`${base}-title`} className="bb-pane-title">
        {label}
      </h3>
      <dl className="kv bb-kv">
        <dt>{t('web.bot_buttons_target')}</dt>
        <dd>
          <Badge tone="neutral" title={t('web.bot_buttons_target_hint')}>
            <Ltr>/{item?.target ?? id}</Ltr>
          </Badge>
        </dd>
        <dt>{t('web.bb_where')}</dt>
        <dd data-testid="bb-where">
          {at === null
            ? t('web.bb_in_pool')
            : fill(t('web.bb_position'), { row: at.row + 1, index: at.index + 1 })}
        </dd>
      </dl>
      <p className="muted small">{t('web.bot_buttons_target_hint')}</p>

      <fieldset className="bb-fieldset" disabled={!editable}>
        <legend>{t('web.bb_place_title')}</legend>
        {at !== null && (
          <>
            <div className="bb-move-grid" role="group" aria-label={t('web.bb_move_in_row')}>
              {moveButton('web.bb_move_earlier', 'chevronRight', moves.earlier, (l) =>
                moveEarlier(l, id),
              )}
              {moveButton('web.bb_move_later', 'chevronLeft', moves.later, (l) => moveLater(l, id))}
              {moveButton('web.bb_move_prev_row', 'arrowUp', moves.previousRow, (l) =>
                moveToPreviousRow(l, id),
              )}
              {moveButton('web.bb_move_next_row', 'arrowDown', moves.nextRow, (l) =>
                moveToNextRow(l, id),
              )}
              {moveButton('web.bb_move_own_row', 'plus', moves.ownRow, (l) => moveToOwnRow(l, id))}
            </div>
            <div className="bb-move-grid" role="group" aria-label={t('web.bb_row_moves')}>
              {moveButton('web.bb_row_up', 'arrowUp', moves.rowUp, (l) =>
                moveRow(l, at.row, at.row - 1),
              )}
              {moveButton('web.bb_row_down', 'arrowDown', moves.rowDown, (l) =>
                moveRow(l, at.row, at.row + 2),
              )}
            </div>
          </>
        )}
        <div className="bb-to-row">
          <label htmlFor={`${base}-row`}>
            {at === null ? t('web.bb_place_into') : t('web.bb_move_into')}
          </label>
          <select
            id={`${base}-row`}
            className="input sm"
            value={chosenRow}
            onChange={(event) => setTargetRow(event.target.value)}
          >
            {layout.rows.map((_, row) => (
              <option key={row} value={String(row)}>
                {fill(t('web.bb_row_n'), { n: row + 1 })}
              </option>
            ))}
            <option value="new">{t('web.bb_new_row_end')}</option>
          </select>
          <button
            type="button"
            className="btn sm"
            disabled={!editable}
            data-move="web.bb_place_go"
            onClick={() =>
              onMove(id, (l) =>
                chosenRow === 'new'
                  ? placeInNewRow(l, id, l.rows.length)
                  : placeAtRowEnd(l, id, Number(chosenRow)),
              )
            }
          >
            {at === null ? t('web.bb_place_add') : t('web.bb_place_move')}
          </button>
        </div>
        {at !== null && (
          <button
            type="button"
            className="btn sm danger"
            disabled={!editable}
            data-move="web.bb_remove"
            onClick={() => onMove(id, (l) => removeToPool(l, id))}
          >
            <Icon name="archive" />
            {t('web.bb_remove')}
          </button>
        )}
        <p className="muted small">{t('web.bb_keyboard_hint')}</p>
      </fieldset>

      <div className="bb-field">
        <div className="bb-switch-row">
          <span>{t('web.bb_enabled')}</span>
          <Switch
            checked={config.enabled}
            label={`${t('web.bb_enabled')}: ${label}`}
            disabled={!editable}
            onChange={(next) =>
              onChange(
                (l) => setEnabled(l, id, next),
                fill(t(next ? 'web.bb_announce_on' : 'web.bb_announce_off'), { label }),
              )
            }
          />
        </div>
        <p className="muted small">{t('web.bb_enabled_hint')}</p>
      </div>

      <fieldset className="bb-fieldset" disabled={!editable}>
        <legend>{t('web.bb_style_title')}</legend>
        <div className="bb-styles">
          {MAIN_MENU_BUTTON_STYLES.map((style) => (
            <label key={style} className={`radio bb-style-option bb-style-${style}`}>
              <input
                type="radio"
                name={`${base}-style`}
                value={style}
                checked={lookOf(config) === style}
                onChange={() =>
                  onChange(
                    (l) => setStyle(l, id, style),
                    fill(t('web.bb_announce_style'), { label, look: t(STYLE_LABEL[style]) }),
                  )
                }
              />
              <span className="bb-style-swatch" aria-hidden="true" />
              <span>{t(STYLE_LABEL[style])}</span>
            </label>
          ))}
        </div>
        <p className="muted small">{t('web.bb_style_hint')}</p>
      </fieldset>

      {/* Restored by the owner's 2026-10-05 master prompt (Item 3): optional; no icon is the
          default (`web.bb_icon_none`), and removing it is choosing no icon again. */}
      <div className="bb-field" data-testid="bb-icon">
        <label htmlFor={`${base}-icon`}>{t('web.bb_icon_title')}</label>
        <span className="muted small">{t('web.bb_optional')}</span>
        <select
          id={`${base}-icon`}
          className="input sm"
          value={config.iconSlot ?? ''}
          disabled={!editable}
          onChange={(event) => {
            const value = event.target.value;
            const slot = value === '' ? null : (value as AppearanceSlot);
            onChange(
              (l) => setIconSlot(l, id, slot),
              fill(t('web.bb_announce_icon'), {
                label,
                icon: slot === null ? t('web.bb_icon_none') : t(APPEARANCE_SLOT_LABEL[slot]),
              }),
            );
          }}
        >
          <option value="">{t('web.bb_icon_none')}</option>
          {APPEARANCE_SLOTS.map((slot) => (
            <option key={slot} value={slot}>
              {APPEARANCE_SLOT_FALLBACKS[slot]} {t(APPEARANCE_SLOT_LABEL[slot])}
            </option>
          ))}
        </select>
        <p className="muted small">{t('web.bb_icon_hint')}</p>
        {config.iconSlot !== null && startsWithEmoji(label) && (
          <Banner tone="warn">
            <span data-testid="bb-icon-doubled">{t('web.bb_icon_label_has_emoji')}</span>
          </Banner>
        )}
        {config.iconSlot !== null && slotView !== undefined && (
          <p className="muted small" data-testid="bb-icon-slot-state">
            {t(
              slotView.customEmojiId !== null && slotView.enabled
                ? 'web.bb_icon_slot_configured'
                : 'web.bb_icon_slot_unconfigured',
            )}
          </p>
        )}
        <div className="bb-eligibility" data-testid="bb-eligibility">
          <p className="small">{t('web.bb_icon_eligibility')}</p>
          {iconEligibility.length === 0 ? (
            <p className="muted small">{t('web.bot_buttons_no_bots')}</p>
          ) : (
            <ul>
              {iconEligibility.map((bot) => (
                <li key={bot.botInstanceId}>
                  <Ltr>@{bot.username}</Ltr>{' '}
                  <Badge tone={bot.eligible ? 'ok' : 'neutral'}>
                    {t(bot.eligible ? 'web.bb_icon_eligible' : 'web.bb_icon_not_eligible')}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          {config.iconSlot !== null && eligibleBots.length === 0 && (
            <Banner tone="info">{t('web.bb_icon_no_eligible_bot')}</Banner>
          )}
        </div>
      </div>

      {item?.gate !== null && item?.gate !== undefined && (
        <div className="bb-field" data-testid="bb-gate">
          <p className="small strong">{t('web.bb_gate_title')}</p>
          <p className="muted small">{t(GATE_NOTE[item.gate])}</p>
          {item.gateOpen === true ? (
            <Badge tone="ok">{t('web.bb_gate_open')}</Badge>
          ) : (
            <Banner tone="warn">
              {t('web.bb_hidden_now_because')} {t(GATE_CLOSED[item.gate])}
            </Banner>
          )}
        </div>
      )}

      <div className="bb-field" data-testid="bb-label">
        <p className="small strong">{t('web.bb_label_title')}</p>
        <p>{label}</p>
        {item?.labelOverridden === true && (
          <p className="muted small">
            {t('web.bot_buttons_label_default')} {item.defaultLabel}
          </p>
        )}
        {item?.duplicateLabel === true && (
          <Banner tone="warn">{t('web.bot_buttons_label_duplicate')}</Banner>
        )}
        {item?.slashLabel === true && <Banner tone="warn">{t('web.bb_label_slash')}</Banner>}
        <p className="muted small">{t('web.bb_label_note')}</p>
        {mayViewTemplates ? (
          <button type="button" className="btn sm" onClick={() => onEditLabel(id)}>
            <Icon name="edit" />
            {t('web.bb_label_edit')}
          </button>
        ) : (
          <p className="muted small">{t('web.bot_buttons_labels_denied')}</p>
        )}
      </div>

      <Disclosure summary={t('web.bb_advanced')} size="sm">
        <p className="muted small">
          {t('web.bb_button_id')} <Ltr>{id}</Ltr>
        </p>
      </Disclosure>
    </section>
  );
}
