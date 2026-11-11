import {
  APPEARANCE_SLOT_FALLBACKS,
  mainMenuButton,
  isCustomMenuRef,
  type AnyExplicitMainMenu,
  type AppearanceSlot,
  type CustomMenuButtonView,
  type MainMenuBuilderItem,
  type MainMenuButtonId,
  type MainMenuButtonStyle,
  type MainMenuRowItem,
} from '@nexa/contracts';
import { t } from '../../i18n/web.fa';
import { templateCopy } from '../../template-copy';
import { Badge } from '../../ui/kit';
import { LayoutDnd } from '../../ui/layout-dnd';
import { configOf, customHiddenNow, hiddenNowByGate, lookOf, poolOf, positionOf } from './model';

/**
 * The label a button shows now: the tenant's rendered text, else the template's Persian name;
 * for a custom button (R10 D2) the owner's own label from the list the server gave.
 */
export function labelOf(
  id: MainMenuRowItem,
  item: MainMenuBuilderItem | undefined,
  custom?: CustomMenuButtonView,
): string {
  if (isCustomMenuRef(id)) return custom?.label ?? t('web.bb_custom_badge');
  if (item !== undefined && item.label !== '') return item.label;
  return templateCopy(mainMenuButton(id).label, '').name;
}

/** `{n}`-style substitution for the builder's sentences. */
export function fill(text: string, values: Readonly<Record<string, string | number>>): string {
  return Object.entries(values).reduce(
    (out, [name, value]) => out.split(`{${name}}`).join(String(value)),
    text,
  );
}

/**
 * The icon marker (restored 2026-10-05). NOT the custom emoji: Nexa never draws a Premium
 * emoji it cannot render honestly. It shows the slot's ordinary fallback inside a dashed
 * outline, and its name says what it is — an icon a bot will carry, before the text, only
 * if that bot is eligible.
 */
export function IconMark({ slot }: { slot: AppearanceSlot }) {
  return (
    <span
      className="bb-icon-mark"
      title={t('web.bb_icon_mark_title')}
      aria-hidden="true"
      data-icon-slot={slot}
    >
      {APPEARANCE_SLOT_FALLBACKS[slot]}
    </span>
  );
}

const STYLE_CLASS: Readonly<Record<MainMenuButtonStyle, string>> = {
  default: 'bb-style-default',
  primary: 'bb-style-primary',
  success: 'bb-style-success',
  danger: 'bb-style-danger',
};

/** One key as a customer's keyboard draws it (read-only previews): text, style and icon slot. */
export interface PreviewKey {
  readonly key: string;
  readonly label: string;
  readonly look: MainMenuButtonStyle;
  readonly iconSlot: AppearanceSlot | null;
}

/** A read-only keyboard: the customer preview, the live keyboard, a revision, a diff. */
export function PreviewKeyboard({
  rows,
  label,
  testId,
}: {
  rows: readonly (readonly PreviewKey[])[];
  label: string;
  testId?: string;
}) {
  return (
    <div
      className="menu-preview"
      aria-label={label}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      {rows.map((row, at) => (
        <div
          key={`${String(at)}:${row.map((one) => one.key).join(':')}`}
          className="menu-preview-row"
        >
          {row.map((one) => (
            <span
              key={one.key}
              className={`menu-preview-key ${STYLE_CLASS[one.look]}`}
              data-key={one.key}
              data-look={one.look}
            >
              {one.iconSlot !== null && <IconMark slot={one.iconSlot} />}
              {one.label}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

interface ChipContext {
  readonly layout: AnyExplicitMainMenu;
  readonly items: ReadonlyMap<MainMenuButtonId, MainMenuBuilderItem>;
  /** R10 D2: the owner's custom buttons by reference, and whether the feature is on. */
  readonly customs: ReadonlyMap<string, CustomMenuButtonView>;
  readonly customMenuEnabled: boolean;
  readonly selected: MainMenuRowItem | null;
  readonly editable: boolean;
  readonly onSelect: (id: MainMenuRowItem) => void;
  /** The layout after a drag, drop or keyboard move: rows only, the free box is what is left. */
  readonly onRows: (rows: readonly (readonly MainMenuRowItem[])[]) => void;
}

/** The registry item behind a row item; a custom button has none. */
function itemOf(context: ChipContext, id: MainMenuRowItem): MainMenuBuilderItem | undefined {
  return isCustomMenuRef(id) ? undefined : context.items.get(id);
}

/** What one button looks like inside the drag-and-drop layout: label, icon, state badges. */
function ChipFace({ id, context }: { id: MainMenuRowItem; context: ChipContext }) {
  const { layout, selected } = context;
  const item = itemOf(context, id);
  const custom = isCustomMenuRef(id) ? context.customs.get(id) : undefined;
  const config = configOf(layout, id);
  const placed = positionOf(layout, id) !== null;
  const hidden =
    placed &&
    config.enabled &&
    (isCustomMenuRef(id)
      ? customHiddenNow(custom, context.customMenuEnabled)
      : hiddenNowByGate(item));
  const classes = [
    'bb-chip',
    STYLE_CLASS[lookOf(config)],
    !config.enabled && 'is-off',
    hidden && 'is-gated',
    selected === id && 'is-selected',
  ].filter(Boolean);
  return (
    <span className={classes.join(' ')} data-chip={id} data-chip-button={id}>
      {config.iconSlot !== null && <IconMark slot={config.iconSlot} />}
      <span className="bb-chip-label">{labelOf(id, item, custom)}</span>
      {isCustomMenuRef(id) && <Badge tone="info">{t('web.bb_custom_badge')}</Badge>}
      {!config.enabled && <Badge tone="neutral">{t('web.bb_state_off')}</Badge>}
      {hidden && <Badge tone="warn">{t('web.bb_hidden_now')}</Badge>}
    </span>
  );
}

/**
 * The editable menu: the kit's `LayoutDnd` over the draft's rows, with the buttons no row names
 * (the «دکمه‌های آزاد» pool) as its free box. A button reorders ONLY by being dragged — onto a
 * button, a row's empty space, the line between rows, «ردیف تازه» or the free box — or from the
 * keyboard (focus it, Enter, arrows). There is no move button anywhere.
 */
export function MenuDndCanvas({ context }: { context: ChipContext }) {
  const { layout, editable } = context;
  const rows = layout.rows as readonly (readonly MainMenuRowItem[])[];
  const free = poolOf(layout, [...context.customs.values()]);
  const labelFor = (id: string) => {
    const row = id as MainMenuRowItem;
    return labelOf(
      row,
      itemOf(context, row),
      isCustomMenuRef(row) ? context.customs.get(row) : undefined,
    );
  };
  return (
    <div className="bb-dnd" data-testid="bb-canvas">
      <LayoutDnd
        className="bb-dnd-layout"
        label={t('web.bb_canvas_label')}
        freeTitle={t('web.kit_dnd_free')}
        layout={{ rows, free }}
        disabled={!editable}
        rtl={typeof document === 'undefined' || document.documentElement.dir !== 'ltr'}
        nameOf={labelFor}
        onSelect={(id) => context.onSelect(id as MainMenuRowItem)}
        renderItem={(id) => <ChipFace id={id as MainMenuRowItem} context={context} />}
        onChange={(next) => context.onRows(next.rows as readonly (readonly MainMenuRowItem[])[])}
      />
    </div>
  );
}

export type { ChipContext };
