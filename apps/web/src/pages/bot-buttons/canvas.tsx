import type { KeyboardEvent, ReactNode } from 'react';
import {
  APPEARANCE_SLOT_FALLBACKS,
  mainMenuButton,
  type AppearanceSlot,
  type ExplicitMainMenu,
  type MainMenuBuilderItem,
  type MainMenuButtonId,
  type MainMenuButtonStyle,
} from '@nexa/contracts';
import { t } from '../../i18n/web.fa';
import { templateCopy } from '../../template-copy';
import { Badge } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { dropKey, type PointerDrag } from './dnd';
import { configOf, hiddenNowByGate, lookOf, poolOf, rowLooksCramped } from './model';

/** The label a button shows now: the tenant's rendered text, else the template's Persian name. */
export function labelOf(id: MainMenuButtonId, item: MainMenuBuilderItem | undefined): string {
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
 * The icon marker. NOT the custom emoji: Nexa never draws a Premium emoji it cannot
 * render honestly. It shows the slot's ordinary fallback inside a dashed outline, and its
 * name says what it is — an icon a bot will carry only if that bot is eligible.
 */
export function IconMark({ slot }: { slot: AppearanceSlot }) {
  return (
    <span className="bb-icon-mark" title={t('web.bb_icon_mark_title')} aria-hidden="true">
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

/** One key as a customer's keyboard draws it (read-only previews). */
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
  readonly layout: ExplicitMainMenu;
  readonly items: ReadonlyMap<MainMenuButtonId, MainMenuBuilderItem>;
  readonly selected: MainMenuButtonId | null;
  readonly editable: boolean;
  readonly drag: PointerDrag;
  readonly onSelect: (id: MainMenuButtonId) => void;
  readonly onKey: (id: MainMenuButtonId, event: KeyboardEvent<HTMLButtonElement>) => void;
}

/** One button in the editor: a grip to drag it, and a button that selects it. */
function Chip({
  id,
  context,
  where,
  placed,
}: {
  id: MainMenuButtonId;
  context: ChipContext;
  /** The position sentence, or the pool's. */
  where: string;
  placed: boolean;
}) {
  const { layout, items, selected, editable, drag } = context;
  const item = items.get(id);
  const config = configOf(layout, id);
  const label = labelOf(id, item);
  const hidden = placed && config.enabled && hiddenNowByGate(item);
  const states = [
    where,
    !config.enabled ? t('web.bb_state_off') : null,
    hidden ? t('web.bb_hidden_now') : null,
  ].filter((part): part is string => part !== null);
  const classes = [
    'bb-chip',
    STYLE_CLASS[lookOf(config)],
    !config.enabled && 'is-off',
    hidden && 'is-gated',
    selected === id && 'is-selected',
    drag.source?.kind === 'button' && drag.source.id === id && 'is-dragging',
    drag.overKey === dropKey({ kind: 'chip', id }) && 'is-over',
  ].filter(Boolean);
  return (
    <div
      className={classes.join(' ')}
      {...(placed ? { 'data-drop': 'chip', 'data-id': id } : {})}
      data-chip={id}
    >
      {editable && (
        <span
          className="bb-grip"
          aria-hidden="true"
          title={t('web.bb_drag_hint')}
          {...drag.gripProps({ kind: 'button', id })}
        >
          <Icon name="menu" size={14} />
        </span>
      )}
      <button
        type="button"
        className="bb-chip-main"
        aria-pressed={selected === id}
        aria-label={`${label} — ${states.join(t('web.bb_sep'))}`}
        data-chip-button={id}
        onClick={() => context.onSelect(id)}
        onKeyDown={(event) => context.onKey(id, event)}
      >
        {config.iconSlot !== null && <IconMark slot={config.iconSlot} />}
        <span className="bb-chip-label">{label}</span>
        {!config.enabled && <Badge tone="neutral">{t('web.bb_state_off')}</Badge>}
        {hidden && <Badge tone="warn">{t('web.bb_hidden_now')}</Badge>}
      </button>
    </div>
  );
}

/** The gap before row `at`: a NEW row is made there by a drop. Drawn only during a drag. */
function Gap({ at, drag }: { at: number; drag: PointerDrag }) {
  if (drag.source === null) return null;
  const over = drag.overKey === dropKey({ kind: 'gap', at });
  return (
    <div className={`bb-gap${over ? ' is-over' : ''}`} data-drop="gap" data-at={String(at)}>
      {t('web.bb_drop_new_row')}
    </div>
  );
}

/** The editable keyboard: explicit rows of chips, with drop zones while dragging. */
export function EditableKeyboard({ context }: { context: ChipContext }) {
  const { layout, items, editable, drag } = context;
  const wide = (id: MainMenuButtonId) => items.get(id)?.wide ?? mainMenuButton(id).wide;
  const rows = layout.rows;
  return (
    <div className="bb-keyboard" aria-label={t('web.bb_canvas_label')} role="group">
      {rows.map((row, at) => {
        const over = drag.overKey === dropKey({ kind: 'row', row: at });
        const draggingRow = drag.source?.kind === 'row' && drag.source.row === at;
        const rowName = fill(t('web.bb_row_n'), { n: at + 1 });
        return (
          <div key={`${String(at)}:${row.join(':')}`} className="bb-row-wrap">
            <Gap at={at} drag={drag} />
            <div
              className={`bb-row${over ? ' is-over' : ''}${draggingRow ? ' is-dragging' : ''}`}
              data-drop="row"
              data-row={String(at)}
              data-testid={`bb-row-${String(at)}`}
              role="group"
              aria-label={rowName}
            >
              {editable && (
                <span
                  className="bb-row-grip"
                  aria-hidden="true"
                  title={t('web.bb_drag_row_hint')}
                  {...drag.gripProps({ kind: 'row', row: at })}
                >
                  <Icon name="menu" size={14} />
                </span>
              )}
              {row.map((id, index) => (
                <Chip
                  key={id}
                  id={id}
                  context={context}
                  where={fill(t('web.bb_position'), { row: at + 1, index: index + 1 })}
                  placed
                />
              ))}
              {rowLooksCramped(row, wide) && (
                <span className="bb-row-warn" title={t('web.bb_row_cramped')}>
                  <Icon name="alert" size={14} aria-hidden="true" />
                  <span className="visually-hidden">{t('web.bb_row_cramped')}</span>
                </span>
              )}
            </div>
          </div>
        );
      })}
      <Gap at={rows.length} drag={drag} />
      {editable && rows.length === 0 && <p className="tg-phone-note">{t('web.bb_canvas_empty')}</p>}
    </div>
  );
}

/** The Available pool: every declared button in no row, with its configuration kept. */
export function Pool({ context, children }: { context: ChipContext; children?: ReactNode }) {
  const { layout, drag } = context;
  const pool = poolOf(layout);
  const over = drag.overKey === dropKey({ kind: 'pool' });
  return (
    <section
      className={`bb-pool${over ? ' is-over' : ''}${drag.source !== null ? ' is-target' : ''}`}
      data-drop="pool"
      aria-labelledby="bb-pool-title"
      data-testid="bb-pool"
    >
      <h3 id="bb-pool-title" className="bb-pane-title">
        {t('web.bb_pool_title')}
      </h3>
      <p className="muted small">{t('web.bb_pool_hint')}</p>
      {pool.length === 0 ? (
        <p className="muted small">{t('web.bb_pool_empty')}</p>
      ) : (
        <div className="bb-pool-list">
          {pool.map((id) => (
            <Chip key={id} id={id} context={context} where={t('web.bb_in_pool')} placed={false} />
          ))}
        </div>
      )}
      {children}
    </section>
  );
}

export type { ChipContext };
